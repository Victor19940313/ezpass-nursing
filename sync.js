/**
 * DentalSync — Firebase 跨裝置同步模組
 * 同名使用者 = 自動同步，last-write-wins
 * 相容新舊路徑：新版寫 users/{id}/，舊版寫 users/{id}/data/
 */
(function () {
  "use strict";

  // 多站共用版:Firebase 設定來自 site-config.js (window.SITE.firebase);apiKey 為 YOUR_API_KEY 時同步停用
  var FIREBASE_CONFIG = (window.SITE && window.SITE.firebase) || { apiKey: "YOUR_API_KEY" };

  var SYNC_KEYS = [
    "wrongbook_state",
    "daily_log",
    "wrongbook_lastpos",
    "notebook",
    "notebook_pending",
    "gemini_api_key",
    "gemini_api_keys",
    "github_token",
    "github_repo",
    "examHistory",
    "exam_reviewed",
    "nb_theme",
    "nb_theme_sat",
    "nb_theme_opa",
    "nb_theme_gstr",
    "nb_toc_mono",
    "nb_bg_style",
    "nb_font_style",
    "opt_marks", // v429:選項劃線/螢光筆痕跡(跨裝置同步)
  ];
  // v373:gemini_model 拿掉不跨 device sync
  // 原因:HUA 改 lite 馬上被別台 device IDB 內的 3.5 push 蓋回來，改設定改不掉
  // 改成本機獨立，每台 device 自己選 model
  // notebook chapter race:章節數會在多台 device IDB 之間飄，因為 sync 是 last-write-wins 沒章節級 merge

  var _db = null;
  var _userId = null;
  var _listeners = [];
  var _initialized = false;
  var _syncing = false;

  function isConfigured() {
    return (
      FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" && !!FIREBASE_CONFIG.databaseURL
    );
  }

  function userRef() {
    return _db.ref("users/" + _userId);
  }
  function userDataRef() {
    return _db.ref("users/" + _userId + "/data");
  }

  function isSyncKey(key) {
    if (!_userId) return false;
    return SYNC_KEYS.some(function (sk) {
      return key === _userId + "_" + sk;
    });
  }

  // ══════════════════════════════════════════
  // v371: stale-device 防呆 — 如果本地章節數遠少於歷史見過的最多，拒絕 push
  // 起因:HUA 某台 device IDB 只剩 108 章卻 _ts 比 remote 大,startup 時 push 蓋掉 remote 200 章
  function _countNotebookChapters(nbStr) {
    if (!nbStr || typeof nbStr !== "string") return -1;
    try {
      var obj = JSON.parse(nbStr);
      if (typeof obj === "string") obj = JSON.parse(obj); // 處理雙層 stringify
      if (obj && Array.isArray(obj.chapters)) return obj.chapters.length;
      return -1;
    } catch (e) {
      return -1;
    }
  }
  function _recordNbMax(nbStr) {
    if (!_userId) return;
    var n = _countNotebookChapters(nbStr);
    if (n < 0) return;
    try {
      var key = _userId + "__nb_max_chapters";
      var seen = parseInt(localStorage.getItem(key) || "0", 10);
      if (n > seen) localStorage.setItem(key, String(n));
    } catch (e) {}
  }
  // v374:push notebook 前先跟雲端做 chapter-level union merge,杜絕「device 互相覆蓋章節」
  // 邏輯:
  //   - 把雲端 chapters 跟本機 chapters 用 chapter.id 合併
  //   - 兩邊都有 → 取 updatedAt 較新的
  //   - 雲端有本機沒 → 保留(別台加的章節不會被本機覆蓋掉)
  //   - 本機有雲端沒 → 加入(本機加的)
  //   - history 簡單以本機為主(history merge 太複雜暫不做)
  function _parseNbStr(s) {
    if (!s) return null;
    var v = s;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch (e) {
        return null;
      }
    }
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch (e) {
        return null;
      }
    }
    if (typeof v !== "object" || v === null) return null;
    return v;
  }
  function _mergeNotebookForPush(localNbStr) {
    if (!localNbStr || typeof localNbStr !== "string")
      return Promise.resolve(localNbStr);
    return userDataRef()
      .child("notebook")
      .once("value")
      .then(function (snap) {
        var remoteVal = snap.val();
        if (!remoteVal) return localNbStr;
        var local = _parseNbStr(localNbStr);
        var remote = _parseNbStr(remoteVal);
        if (!local || !Array.isArray(local.chapters)) return localNbStr;
        if (!remote || !Array.isArray(remote.chapters)) return localNbStr;
        var byId = {};
        remote.chapters.forEach(function (c) {
          if (c && c.id) byId[c.id] = c;
        });
        var localOnly = 0,
          localNewer = 0,
          sameOrOlder = 0;
        local.chapters.forEach(function (lc) {
          if (!lc || !lc.id) return;
          var rc = byId[lc.id];
          if (!rc) {
            byId[lc.id] = lc;
            localOnly++;
            return;
          }
          var lu = lc.updatedAt || 0;
          var ru = rc.updatedAt || 0;
          if (lu >= ru) {
            byId[lc.id] = lc;
            if (lu > ru) localNewer++;
            else sameOrOlder++;
          }
        });
        var ids = Object.keys(byId);
        // 保持 local order 為主 (local 章節順序對使用者有意義), 雲端獨有的接在後面
        var localIdSet = {};
        local.chapters.forEach(function (c) {
          if (c && c.id) localIdSet[c.id] = 1;
        });
        var merged = [];
        local.chapters.forEach(function (c) {
          if (c && c.id && byId[c.id]) {
            merged.push(byId[c.id]);
            delete byId[c.id];
          }
        });
        // 剩下的(雲端獨有)
        Object.keys(byId).forEach(function (id) {
          merged.push(byId[id]);
        });
        var mergedNb = {
          chapters: merged,
          history: local.history || remote.history || [],
        };
        if (local.byId) mergedNb.byId = local.byId;
        else if (remote.byId) mergedNb.byId = remote.byId;
        console.log(
          "[Sync] 🔀 v374 push-merge: local=" +
            local.chapters.length +
            " / remote=" +
            remote.chapters.length +
            " / merged=" +
            merged.length +
            "  (+" +
            localOnly +
            " 本機獨有, " +
            localNewer +
            " 本機較新, " +
            sameOrOlder +
            " 同步)",
        );
        return JSON.stringify(mergedNb);
      })
      .catch(function (e) {
        console.warn(
          "[Sync] mergeNotebookForPush failed, push as-is",
          e && e.message,
        );
        return localNbStr;
      });
  }
  function _safetyAllowNotebookPush(payloadNotebook) {
    if (!_userId) return true;
    var localCount = _countNotebookChapters(payloadNotebook);
    if (localCount < 0) return true; // 解不開，放行
    var seen = 0;
    try {
      seen = parseInt(
        localStorage.getItem(_userId + "__nb_max_chapters") || "0",
        10,
      );
    } catch (e) {}
    if (seen <= 0) return true;
    // 章節數明顯掉超過 30% → 視為 stale device 誤判，擋住 push
    // (HUA 案例:108/200=54% 還是擋掉; 真的要刪一堆章節請用「強制推送」forcePushToCloud 略過此檢查)
    if (localCount < seen * 0.7) {
      console.error(
        "[Sync] 🛡 BLOCKED push: local notebook only has " +
          localCount +
          " chapters but historical max was " +
          seen +
          " — refusing to overwrite remote (stale-device guard)",
      );
      try {
        // 留一個 marker,方便 debug
        localStorage.setItem(
          _userId + "__nb_push_blocked_at",
          String(Date.now()),
        );
        localStorage.setItem(
          _userId + "__nb_push_blocked_info",
          "local=" + localCount + " max=" + seen,
        );
      } catch (e) {}
      return false;
    }
    return true;
  }
  // ══════════════════════════════════════════

  /** Push to BOTH new path and old data/ path for backward compat */
  /** v283: notebook 改從 IDB 讀(localStorage 撞 quota 後 stale)
   *  v285: examHistory 也改從 IDB 讀(同樣理由，避免跨裝置同步遺失試卷紀錄) */
  // v601: 推雲端前確認「現在登入的人」= 這個模組初始化時的人;不一致 (同瀏覽器換帳號、舊分頁) 就不推
  function identityMismatch(where) {
    try {
      if (_userId && localStorage.getItem(_userId + "__wipe_pending")) {
        console.warn("[Sync] 清除中,略過 " + where);
        return true;
      }
      var nowId = localStorage.getItem("dental_cur_user");
      if (nowId && _userId && nowId !== _userId) {
        console.warn("[Sync] 身份不一致,略過 " + where + ":", _userId, "→", nowId);
        return true;
      }
    } catch (e) {}
    return false;
  }
  function pushToFirebase(force) {
    if (!_db || !_userId) return Promise.resolve();
    if (identityMismatch("pushAll")) return Promise.resolve();
    var payload = { _ts: Date.now() };
    var oldPayload = {};
    var IDB_KEYS = ["notebook", "examHistory", "wrongbook_state"];
    // 先把可以從 localStorage 拿的都拿了
    SYNC_KEYS.forEach(function (sk) {
      if (IDB_KEYS.indexOf(sk) >= 0) return; // 這些走 IDB,稍後處理
      var val = localStorage.getItem(_userId + "_" + sk);
      if (val !== null) {
        payload[sk] = val;
        oldPayload[sk] = val;
      }
    });
    // notebook 從 IDB 拿
    var notebookPromise = (function () {
      if (
        window._notebookIdbBridge &&
        window._notebookIdbBridge.getNotebookPayload
      ) {
        return window._notebookIdbBridge
          .getNotebookPayload()
          .then(function (idbVal) {
            if (idbVal) {
              payload.notebook = idbVal;
              oldPayload.notebook = idbVal;
            } else {
              var lsVal = localStorage.getItem(_userId + "_notebook");
              if (lsVal !== null) {
                payload.notebook = lsVal;
                oldPayload.notebook = lsVal;
              }
            }
          })
          .catch(function () {
            var lsVal = localStorage.getItem(_userId + "_notebook");
            if (lsVal !== null) {
              payload.notebook = lsVal;
              oldPayload.notebook = lsVal;
            }
          });
      }
      var lsVal = localStorage.getItem(_userId + "_notebook");
      if (lsVal !== null) {
        payload.notebook = lsVal;
        oldPayload.notebook = lsVal;
      }
      return Promise.resolve();
    })();
    // examHistory 從 IDB 拿(v285)
    var examHistPromise = (function () {
      if (
        window._examHistoryIdbBridge &&
        window._examHistoryIdbBridge.getExamHistoryPayload
      ) {
        return window._examHistoryIdbBridge
          .getExamHistoryPayload()
          .then(function (idbVal) {
            if (idbVal) {
              payload.examHistory = idbVal;
              oldPayload.examHistory = idbVal;
            } else {
              var lsVal = localStorage.getItem(_userId + "_examHistory");
              if (lsVal !== null) {
                payload.examHistory = lsVal;
                oldPayload.examHistory = lsVal;
              }
            }
          })
          .catch(function () {
            var lsVal = localStorage.getItem(_userId + "_examHistory");
            if (lsVal !== null) {
              payload.examHistory = lsVal;
              oldPayload.examHistory = lsVal;
            }
          });
      }
      var lsVal = localStorage.getItem(_userId + "_examHistory");
      if (lsVal !== null) {
        payload.examHistory = lsVal;
        oldPayload.examHistory = lsVal;
      }
      return Promise.resolve();
    })();
    // wrongbook_state 從 IDB 拿(v286)
    var wrongbookPromise = (function () {
      if (
        window._wrongbookIdbBridge &&
        window._wrongbookIdbBridge.getWrongbookPayload
      ) {
        return window._wrongbookIdbBridge
          .getWrongbookPayload()
          .then(function (idbVal) {
            if (idbVal) {
              payload.wrongbook_state = idbVal;
              oldPayload.wrongbook_state = idbVal;
            } else {
              var lsVal = localStorage.getItem(_userId + "_wrongbook_state");
              if (lsVal !== null) {
                payload.wrongbook_state = lsVal;
                oldPayload.wrongbook_state = lsVal;
              }
            }
          })
          .catch(function () {
            var lsVal = localStorage.getItem(_userId + "_wrongbook_state");
            if (lsVal !== null) {
              payload.wrongbook_state = lsVal;
              oldPayload.wrongbook_state = lsVal;
            }
          });
      }
      var lsVal = localStorage.getItem(_userId + "_wrongbook_state");
      if (lsVal !== null) {
        payload.wrongbook_state = lsVal;
        oldPayload.wrongbook_state = lsVal;
      }
      return Promise.resolve();
    })();
    _syncing = true;
    return Promise.all([notebookPromise, examHistPromise, wrongbookPromise])
      .then(function () {
        // v371: stale-device guard — 章節數暴跌就拒絕 push (force=true 略過，給「強制推送」用)
        if (
          !force &&
          payload.notebook !== undefined &&
          !_safetyAllowNotebookPush(payload.notebook)
        ) {
          delete payload.notebook;
          delete oldPayload.notebook;
          return Promise.all([
            userRef().update(payload),
            userDataRef().update(oldPayload),
          ]);
        }
        // v374: notebook 走 chapter-level union merge 後再 push, 避免 device 互相覆蓋章節
        if (payload.notebook !== undefined) {
          return _mergeNotebookForPush(payload.notebook).then(
            function (merged) {
              payload.notebook = merged;
              oldPayload.notebook = merged;
              _recordNbMax(merged); // 更新本機歷史最大值
              return Promise.all([
                userRef().update(payload),
                userDataRef().update(oldPayload),
              ]);
            },
          );
        }
        return Promise.all([
          userRef().update(payload),
          userDataRef().update(oldPayload),
        ]);
      })
      .catch(function (err) {
        console.error("[Sync] push error:", err);
      })
      .finally(function () {
        _syncing = false;
      });
  }

  /** Read from both paths, pick whichever has data */
  function readRemote() {
    return userRef()
      .once("value")
      .then(function (snap) {
        var root = snap.val() || {};
        var result = {};
        // Try new path first (root level)
        SYNC_KEYS.forEach(function (sk) {
          if (root[sk] !== undefined && root[sk] !== null) {
            result[sk] = root[sk];
          } else if (
            root.data &&
            root.data[sk] !== undefined &&
            root.data[sk] !== null
          ) {
            // Fall back to old data/ path
            result[sk] = root.data[sk];
          }
        });
        result._ts = root._ts || 0;
        result._meta = root._meta || null; // v602: 讓 syncOnLoad 看得到 wipe_ts
        return result;
      });
  }

  /** On startup: compare timestamps, newer wins */
  // v601: 遠端清除 — 後台在 users/{uid}/_meta/wipe_ts 放一個時間,本機若還沒依這個時間清過,
  //       就把這個 uid 的本機資料 (localStorage + IDB) 全部清掉再重新載入,避免舊副本被推回雲端。
  //       用途:HUA 兩個帳號互相污染後,把 B 帳號清乾淨。
  var IDB_NAME = "dental_notebooks_v1";
  var IDB_STORE = "notebooks";
  function wipeLocalForUser(uid) {
    var keys = SYNC_KEYS.slice();
    keys.forEach(function (sk) {
      try {
        localStorage.removeItem(uid + "_" + sk);
      } catch (e) {}
    });
    try {
      localStorage.removeItem(uid + "__ts");
    } catch (e) {}
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = function () {
          var db = req.result;
          try {
            var tx = db.transaction(IDB_STORE, "readwrite");
            var st = tx.objectStore(IDB_STORE);
            ["notebook", "examHistory", "wrongbook_state", "notebook_pending", "wrongbook_lastpos", "opt_marks"].forEach(function (sk) {
              try {
                st.delete(uid + "_" + sk);
              } catch (e) {}
            });
            tx.oncomplete = function () {
              db.close();
              resolve(true);
            };
            tx.onerror = function () {
              db.close();
              resolve(false);
            };
          } catch (e) {
            resolve(false);
          }
        };
        req.onerror = function () {
          resolve(false);
        };
      } catch (e) {
        resolve(false);
      }
    });
  }
  function syncOnLoad() {
    if (!_db || !_userId) return Promise.resolve();
    _syncing = true;
    return readRemote()
      .then(function (remote) {
        // v601: 先看有沒有遠端清除標記
        try {
          var wipeTs = remote && remote._meta && remote._meta.wipe_ts ? remote._meta.wipe_ts : 0;
          var wipedAt = parseInt(localStorage.getItem(_userId + "__wiped") || "0");
          if (wipeTs && wipeTs > wipedAt) {
            console.warn("[Sync] 遠端要求清除本機舊資料", _userId, wipeTs);
            localStorage.setItem(_userId + "__wiped", String(wipeTs));
            localStorage.setItem(_userId + "__wipe_pending", String(wipeTs)); // v603: 重新載入後 skin.js 會再清一次
            var uidToWipe = _userId;
            return wipeLocalForUser(uidToWipe).then(function () {
              _syncing = false;
              window._syncWiped = true;
              if (!window._syncNoReload) location.reload();
              return { _wiped: true };
            });
          }
        } catch (e) {}
        var remoteTs = remote._ts || 0;
        var localTs = parseInt(localStorage.getItem(_userId + "__ts") || "0");

        if (remoteTs > localTs) {
          SYNC_KEYS.forEach(function (sk) {
            if (remote[sk] !== undefined) {
              // 🛡 v283/v285:notebook 跟 examHistory 改寫進 IDB(localStorage 可能撞 quota),其他維持
              if (
                sk === "notebook" &&
                window._notebookIdbBridge &&
                window._notebookIdbBridge.applyRemoteNotebook
              ) {
                // v375: bridge 自己做 chapter-level merge 並寫 IDB / localStorage,sync.js 不再覆蓋
                window._notebookIdbBridge.applyRemoteNotebook(remote[sk]);
                _recordNbMax(remote[sk]); // v371 stale-device guard
              } else if (
                sk === "examHistory" &&
                window._examHistoryIdbBridge &&
                window._examHistoryIdbBridge.applyRemoteExamHistory
              ) {
                // v385: bridge 自己會 merge 後寫 IDB+localStorage,sync.js 不再覆蓋成 raw remote
                window._examHistoryIdbBridge.applyRemoteExamHistory(remote[sk]);
              } else if (
                sk === "wrongbook_state" &&
                window._wrongbookIdbBridge &&
                window._wrongbookIdbBridge.applyRemoteWrongbook
              ) {
                window._wrongbookIdbBridge.applyRemoteWrongbook(remote[sk]);
                try {
                  localStorage.setItem(_userId + "_" + sk, remote[sk]);
                } catch (e) {}
              } else {
                try {
                  localStorage.setItem(_userId + "_" + sk, remote[sk]);
                } catch (e) {}
              }
            }
          });
          localStorage.setItem(_userId + "__ts", String(remoteTs));
          // v395:PULL 結束後也排程一次 push — 保證本機獨有的紀錄(bridge 合併後存在)會推回雲端
          //       不能直接 push(_syncing 還是 true),用 setTimeout 等 syncOnLoad 完成
          setTimeout(function () {
            if (!_syncing) {
              pushToFirebase()
                .then(function () {
                  localStorage.setItem(_userId + "__ts", String(Date.now()));
                })
                .catch(function (e) {
                  console.warn("[sync] PULL-then-PUSH failed", e);
                });
            }
          }, 1500);
        } else {
          return pushToFirebase().then(function () {
            localStorage.setItem(_userId + "__ts", String(Date.now()));
          });
        }
      })
      .catch(function (err) {
        console.error("[Sync] syncOnLoad error:", err);
      })
      .finally(function () {
        _syncing = false;
      });
  }

  /** Listen for changes on BOTH paths */
  function startListening() {
    stopListening();
    if (!_db || !_userId) return;

    function handleUpdate(snap) {
      if (_syncing) return;
      var val = snap.val();
      if (!val || typeof val !== "object") return;

      // Check if this is a root-level update (has _ts) or data/ update
      var hasData = false;
      var source = val;
      var remoteTs = val._ts || 0;

      // If no _ts, it's from old data/ path — treat as new
      if (!remoteTs) remoteTs = Date.now();

      var localTs = parseInt(localStorage.getItem(_userId + "__ts") || "0");
      if (remoteTs <= localTs) return;

      _syncing = true;
      SYNC_KEYS.forEach(function (sk) {
        if (source[sk] !== undefined && source[sk] !== null) {
          // 🛡 v283/v285:notebook 跟 examHistory 走 IDB,其他維持 localStorage
          if (
            sk === "notebook" &&
            window._notebookIdbBridge &&
            window._notebookIdbBridge.applyRemoteNotebook
          ) {
            // v375: bridge 自己做 chapter-level merge 並寫 IDB / localStorage,sync.js 不再覆蓋
            window._notebookIdbBridge.applyRemoteNotebook(source[sk]);
            _recordNbMax(source[sk]); // v371 stale-device guard
          } else if (
            sk === "examHistory" &&
            window._examHistoryIdbBridge &&
            window._examHistoryIdbBridge.applyRemoteExamHistory
          ) {
            // v385: bridge 自己會 merge 後寫 IDB+localStorage,sync.js 不再覆蓋成 raw remote
            window._examHistoryIdbBridge.applyRemoteExamHistory(source[sk]);
          } else if (
            sk === "wrongbook_state" &&
            window._wrongbookIdbBridge &&
            window._wrongbookIdbBridge.applyRemoteWrongbook
          ) {
            window._wrongbookIdbBridge.applyRemoteWrongbook(source[sk]);
            try {
              localStorage.setItem(_userId + "_" + sk, source[sk]);
            } catch (e) {}
          } else {
            try {
              localStorage.setItem(_userId + "_" + sk, source[sk]);
            } catch (e) {}
          }
        }
      });
      localStorage.setItem(_userId + "__ts", String(remoteTs));
      _syncing = false;
    }

    // Listen on root (new path)
    var firstRoot = true;
    var unsubRoot = userRef().on("value", function (snap) {
      if (firstRoot) {
        firstRoot = false;
        return;
      }
      handleUpdate(snap);
    });
    _listeners.push(function () {
      userRef().off("value", unsubRoot);
    });

    // Also listen on data/ (old path from phone)
    var firstData = true;
    var unsubData = userDataRef().on("value", function (snap) {
      if (firstData) {
        firstData = false;
        return;
      }
      if (_syncing) return;
      var val = snap.val();
      if (!val || typeof val !== "object") return;
      // Old path doesn't have _ts, always apply if changed
      _syncing = true;
      var changed = false;
      SYNC_KEYS.forEach(function (sk) {
        if (val[sk] !== undefined && val[sk] !== null) {
          var cur = localStorage.getItem(_userId + "_" + sk);
          if (cur !== val[sk]) {
            // 🛡 v283/v285:notebook 跟 examHistory 走 IDB,其他維持 localStorage
            if (
              sk === "notebook" &&
              window._notebookIdbBridge &&
              window._notebookIdbBridge.applyRemoteNotebook
            ) {
              window._notebookIdbBridge.applyRemoteNotebook(val[sk]);
              try {
                localStorage.setItem(_userId + "_" + sk, val[sk]);
              } catch (e) {}
              _recordNbMax(val[sk]); // v371 stale-device guard
            } else if (
              sk === "examHistory" &&
              window._examHistoryIdbBridge &&
              window._examHistoryIdbBridge.applyRemoteExamHistory
            ) {
              window._examHistoryIdbBridge.applyRemoteExamHistory(val[sk]);
              try {
                localStorage.setItem(_userId + "_" + sk, val[sk]);
              } catch (e) {}
            } else if (
              sk === "wrongbook_state" &&
              window._wrongbookIdbBridge &&
              window._wrongbookIdbBridge.applyRemoteWrongbook
            ) {
              window._wrongbookIdbBridge.applyRemoteWrongbook(val[sk]);
              try {
                localStorage.setItem(_userId + "_" + sk, val[sk]);
              } catch (e) {}
            } else {
              try {
                localStorage.setItem(_userId + "_" + sk, val[sk]);
              } catch (e) {}
            }
            changed = true;
          }
        }
      });
      if (changed) {
        localStorage.setItem(_userId + "__ts", String(Date.now()));
      }
      _syncing = false;
    });
    _listeners.push(function () {
      userDataRef().off("value", unsubData);
    });
  }

  function stopListening() {
    _listeners.forEach(function (fn) {
      fn();
    });
    _listeners = [];
  }

  function onLocalChange(e) {
    if (_syncing || !_db || !_userId) return;
    if (!e.key || !isSyncKey(e.key)) return;
    localStorage.setItem(_userId + "__ts", String(Date.now()));
    pushToFirebase();
  }

  /** Auto-push: check every 3 seconds if local data changed, push if so */
  var _lastPushed = "";
  function startAutoSync() {
    setInterval(function () {
      if (!_db || !_userId || _syncing) return;
      var cur = localStorage.getItem(_userId + "_wrongbook_state") || "";
      if (cur && cur !== _lastPushed) {
        _lastPushed = cur;
        pushToFirebase();
      }
    }, 3000);
  }

  // ══════════════════════════════════════════

  /** Force pull: overwrite local with cloud data, no timestamp check */
  function forcePullFromCloud() {
    if (!_db || !_userId) return Promise.reject(new Error("尚未連線"));
    _syncing = true;
    return readRemote()
      .then(function (remote) {
        var applied = 0;
        SYNC_KEYS.forEach(function (sk) {
          if (remote[sk] !== undefined) {
            localStorage.setItem(_userId + "_" + sk, remote[sk]);
            if (sk === "notebook") _recordNbMax(remote[sk]); // v371 stale-device guard
            applied++;
          }
        });
        localStorage.setItem(
          _userId + "__ts",
          String(remote._ts || Date.now()),
        );
        return applied;
      })
      .finally(function () {
        _syncing = false;
      });
  }

  /** Force push: overwrite cloud with local data (略過 stale-device safety net) */
  function forcePushToCloud() {
    if (!_db || !_userId) return Promise.reject(new Error("尚未連線"));
    var now = Date.now();
    localStorage.setItem(_userId + "__ts", String(now));
    return pushToFirebase(true).then(function () {
      return now;
    });
  }

  /** Read remote without applying — for diff display */
  function getRemoteSnapshot() {
    if (!_db || !_userId) return Promise.reject(new Error("尚未連線"));
    return readRemote();
  }

  /** Count flagged + status entries from a wrongbook_state JSON string */
  function countMarks(stateStr) {
    if (!stateStr) return { flagged: 0, marked: 0, total: 0 };
    try {
      var obj = JSON.parse(stateStr);
      var flagged = 0,
        marked = 0,
        total = 0;
      Object.keys(obj).forEach(function (id) {
        var s = obj[id] || {};
        total++;
        if (s.flagged) flagged++;
        if (s.status && s.status !== "none") marked++;
      });
      return { flagged: flagged, marked: marked, total: total };
    } catch (e) {
      return { flagged: 0, marked: 0, total: 0 };
    }
  }

  var DentalSync = {
    init: function () {
      if (_initialized) return Promise.resolve();
      _initialized = true;
      if (!isConfigured()) return Promise.resolve();

      try {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        _db = firebase.database();

        var origSetItem = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
          origSetItem(key, value);
          if (isSyncKey(key) && !_syncing) {
            onLocalChange({ key: key, newValue: value });
          }
        };

        _userId = localStorage.getItem("dental_cur_user");
        // v540: 只接受 Google uid 格式 (20+ 英數)。舊暱稱 (hua/hua_hsu) 一律不啟動 sync,
        //       等 auth.js 校正完呼叫 switchUser(uid) 再啟動 — 這樣直開練習本也不會用暱稱寫 Firebase
        if (_userId && !/^[A-Za-z0-9]{20,}$/.test(_userId)) {
          console.warn("[Sync] 舊暱稱 id,不啟動 sync,等 Google uid:", _userId);
          _userId = null;
        }
        if (_userId) {
          _lastPushed =
            localStorage.getItem(_userId + "_wrongbook_state") || "";
          startAutoSync();
          return syncOnLoad().then(function () {
            startListening();
          });
        }
      } catch (err) {
        console.error("[Sync] init error:", err);
      }
      return Promise.resolve();
    },

    switchUser: function (userId) {
      stopListening();
      // v540: 同 init,只接受 Google uid
      if (userId && !/^[A-Za-z0-9]{20,}$/.test(userId)) {
        console.warn("[Sync] switchUser 拒絕舊暱稱 id:", userId);
        _userId = null;
        return Promise.resolve();
      }
      _userId = userId;
      if (_db && _userId) {
        return syncOnLoad().then(function () {
          startListening();
        });
      }
      return Promise.resolve();
    },

    pushAll: pushToFirebase,
    // v413:輕量單 key 推送 — 標記變動只推 wrongbook_state,不要每次都把 examHistory + notebook 全部一起推
    pushOne: function (sk, payload) {
      if (!_db || !_userId) return Promise.resolve();
      if (identityMismatch("pushOne " + sk)) return Promise.resolve();
      var update = {};
      update[sk] = payload;
      update._ts = Date.now();
      var oldUpdate = {};
      oldUpdate[sk] = payload;
      _syncing = true;
      return Promise.all([
        userRef().update(update),
        userDataRef().update(oldUpdate),
      ])
        .catch(function (err) {
          console.error("[Sync] pushOne " + sk + " error:", err);
        })
        .finally(function () {
          _syncing = false;
        });
    },

    forcePull: forcePullFromCloud,
    forcePush: forcePushToCloud,
    getRemoteSnapshot: getRemoteSnapshot,
    countMarks: countMarks,
    getUserId: function () {
      return _userId;
    },

    /** PIN 鎖:讀寫 users/{id}/auth/pin_hash */
    getPinHash: function (userId) {
      if (!_db) return Promise.reject(new Error("尚未連線"));
      return _db
        .ref("users/" + userId + "/auth/pin_hash")
        .once("value")
        .then(function (snap) {
          return snap.val();
        });
    },
    setPinHash: function (userId, hash) {
      if (!_db) return Promise.reject(new Error("尚未連線"));
      return _db.ref("users/" + userId + "/auth/pin_hash").set(hash);
    },

    getStatus: function () {
      return {
        connected: !!(_db && _userId),
        userId: _userId,
        configured: isConfigured(),
      };
    },

    renderUI: function (containerSelector) {
      var container =
        typeof containerSelector === "string"
          ? document.querySelector(containerSelector)
          : containerSelector;
      if (!container) return;
      var status = this.getStatus();
      var ver =
        typeof window !== "undefined" && window.APP_VERSION
          ? '<span class="sync-btn" style="color:#7c3aed;border-color:#ddd6fe;background:#faf5ff" title="目前版本">' +
            window.APP_VERSION +
            "</span>"
          : "";
      if (status.connected) {
        container.innerHTML =
          '<span class="sync-btn" style="color:#16a34a;border-color:#bbf7d0">🟢 同步中</span>' +
          ver;
      } else {
        container.innerHTML = ver;
      }
    },
  };

  window.DentalSync = DentalSync;
})();
