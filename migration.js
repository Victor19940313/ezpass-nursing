// migration.js — 舊 nickname 資料 → Google uid migration (里程碑 1b)
// v499
//
// 流程:
//   1. 使用者 Google 登入完成
//   2. auth.js onChange callback 觸發 Migration.check(user)
//   3. 檢查 email 是否在 AUTO_MIGRATE_MAP → 有 = auto migrate (無感)
//   4. 若無 → 檢查 localStorage 是否有舊 dental_users → 有 = 彈窗讓使用者選
//   5. 執行 migration = copy Firebase users/{nickname}/* → users/{google_uid}/*
//   6. 標記完成 (localStorage flag + Firebase migrated_from)
//   7. 不刪舊資料 (safe, 未來可 rollback)

(function () {
  if (typeof firebase === "undefined" || !firebase.database) {
    console.warn("[Migration] firebase 未載入");
    return;
  }

  // 預設綁定: Google email → 舊 nickname (免彈窗自動搬)
  // v521: 修正大小寫,Firebase 實際 key 是小寫 hua / shirley
  const AUTO_MIGRATE_MAP = {
    "wing2004piten@gmail.com": "hua",
    "wen84224@gmail.com": "shirley",
  };

  const db = firebase.database();
  const LS_FLAG = "migrated_ts";
  const LS_DEFER = "migrate_deferred_ts";
  const DEFER_DAYS = 7;

  // 統計舊 nickname 的資料量
  async function getSummary(nickname) {
    const snap = await db
      .ref("users/" + encodeURIComponent(nickname))
      .once("value");
    const d = snap.val();
    if (!d) return null;
    let chapters = 0,
      wrongbook = 0,
      exams = 0;
    try {
      const nb = JSON.parse(d.notebook || d.data?.notebook || "{}");
      chapters = (nb.chapters || []).length;
    } catch (e) {}
    try {
      const wb = JSON.parse(
        d.wrongbook_state || d.data?.wrongbook_state || "{}",
      );
      wrongbook = Object.keys(wb).length;
    } catch (e) {}
    try {
      const eh = JSON.parse(d.examHistory || d.data?.examHistory || "[]");
      exams = Array.isArray(eh) ? eh.length : 0;
    } catch (e) {}
    return {
      nickname,
      chapters,
      wrongbook,
      exams,
      hasData: chapters + wrongbook + exams > 0,
    };
  }

  // 實際搬資料
  async function performMigration(nickname, googleUid) {
    try {
      const srcRef = db.ref("users/" + encodeURIComponent(nickname));
      const dstRef = db.ref("users/" + googleUid);
      const snap = await srcRef.once("value");
      const srcData = snap.val();
      if (!srcData) {
        console.warn("[Migration] 舊資料為空:", nickname);
        return { ok: false, reason: "empty" };
      }
      // v558: 以前是 dstRef.set(merged) → 把 dst 整個節點蓋掉,連 subscription/devices 都被清掉
      //       (2026-09-03 HUA 手機登入重跑 migration,終身會員被清成試用)。
      //       現在: 只補 dst「沒有」的 key,用 update;profile/subscription/devices/_meta 一律不碰。
      const dstSnap = await dstRef.once("value");
      const dstData = dstSnap.val() || {};
      const NEVER_TOUCH = new Set([
        "profile", "subscription", "devices", "_meta",
        "_migrated_to", "_migrated_ts", "auth",
      ]);
      const patch = {};
      let added = 0;
      Object.keys(srcData).forEach((k) => {
        if (NEVER_TOUCH.has(k)) return;
        if (dstData[k] !== undefined && dstData[k] !== null) return; // dst 已有 → 保留 dst
        patch[k] = srcData[k];
        added++;
      });
      patch["profile/migrated_from"] = nickname;
      patch["profile/migrated_ts"] = Date.now();
      await dstRef.update(patch);
      console.log("[Migration] v558 只補缺的 key:", added, "個");
      // 標記舊資料
      await srcRef.child("_migrated_to").set(googleUid);
      await srcRef.child("_migrated_ts").set(Date.now());
      // localStorage flag
      try {
        localStorage.setItem(LS_FLAG, String(Date.now()));
        localStorage.setItem("migrated_nickname", nickname);
        localStorage.setItem("migrated_google_uid", googleUid);
      } catch (e) {}
      return { ok: true, nickname, googleUid };
    } catch (e) {
      console.error("[Migration] 失敗:", e);
      return { ok: false, reason: e.message };
    }
  }

  // 主流程: 登入後呼叫
  async function check(googleUser) {
    if (!googleUser || !googleUser.uid) return;
    const email = (googleUser.email || "").toLowerCase();

    // v558: 以 Firebase 的 profile.migrated_from 為準 — 搬過就永遠不再搬 (換手機/清快取也一樣)。
    //       v521 的「dst 沒 notebook 就強制重搬」拿掉:那條讓 HUA 換裝置登入時整個帳號被舊資料蓋掉。
    try {
      const mf = await db
        .ref("users/" + googleUser.uid + "/profile/migrated_from")
        .once("value");
      if (mf.exists()) {
        window.Migration._lastDecision = "already-migrated(firebase)";
        try {
          if (!localStorage.getItem(LS_FLAG))
            localStorage.setItem(LS_FLAG, String(Date.now()));
          if (!localStorage.getItem("migrated_nickname"))
            localStorage.setItem("migrated_nickname", String(mf.val()));
        } catch (e) {}
      }
    } catch (e) {}

    // 已 migrate 過 → 依然 dispatch event 讓 UI (index.html) auto selectUser
    if (localStorage.getItem(LS_FLAG)) {
      const nick = localStorage.getItem("migrated_nickname");
      if (nick) {
        window.dispatchEvent(
          new CustomEvent("dental-migration-done", {
            detail: {
              nickname: nick,
              googleUid: googleUser.uid,
              alreadyMigrated: true,
            },
          }),
        );
      } else {
        // 沒 nickname 記錄 (可能之前是 new user) → 用 email map 找一次
        const nickFromMap =
          AUTO_MIGRATE_MAP[(googleUser.email || "").toLowerCase()];
        if (nickFromMap) {
          window.dispatchEvent(
            new CustomEvent("dental-migration-done", {
              detail: {
                nickname: nickFromMap,
                googleUid: googleUser.uid,
                alreadyMigrated: true,
              },
            }),
          );
        }
      }
      return;
    }
    // 使用者 defer 過 7 天內, 不再問
    const defer = parseInt(localStorage.getItem(LS_DEFER) || "0");
    if (defer && Date.now() - defer < DEFER_DAYS * 86400_000) return;

    const uid = googleUser.uid;

    // 1. Auto-migrate: email 在預設 map
    const autoNickname = AUTO_MIGRATE_MAP[email];
    if (autoNickname) {
      const summary = await getSummary(autoNickname);
      if (summary && summary.hasData) {
        console.log("[Migration] Auto migrate:", email, "→", autoNickname);
        const r = await performMigration(autoNickname, uid);
        if (r.ok) {
          showToast(
            `已把「${autoNickname}」的資料綁到你的 Google 帳號 (章節 ${summary.chapters}、錯題 ${summary.wrongbook})`,
          );
          window.dispatchEvent(
            new CustomEvent("dental-migration-done", {
              detail: { nickname: autoNickname, googleUid: uid },
            }),
          );
        }
      } else {
        // 沒舊資料, mark migrated 免下次再檢查
        localStorage.setItem(LS_FLAG, String(Date.now()));
        // 也 emit event 讓 index.html 知道可以 skip select-nickname 直接進主頁 (若使用者 Google 登入但沒舊 data)
        window.dispatchEvent(
          new CustomEvent("dental-migration-done", {
            detail: { nickname: null, googleUid: uid, newUser: true },
          }),
        );
      }
      return;
    }

    // 2. 非 auto: 一律當新使用者,不再彈窗詢問合併
    //    (v521 起 HUA 決定只留 wing2004piten@gmail.com + wen84224@gmail.com,
    //     其他舊 nickname 通通不合併)
    localStorage.setItem(LS_FLAG, String(Date.now()));
    window.dispatchEvent(
      new CustomEvent("dental-migration-done", {
        detail: { nickname: null, googleUid: uid, newUser: true },
      }),
    );
  }

  function showToast(msg) {
    let t = document.getElementById("mig-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "mig-toast";
      t.className = "mig-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 5000);
  }

  function showModal(summaries, googleUid) {
    const modal = document.createElement("div");
    modal.className = "mig-modal";
    modal.innerHTML = `
      <div class="mig-backdrop"></div>
      <div class="mig-panel">
        <h3>合併你以前的資料?</h3>
        <p class="mig-desc">偵測到這個裝置有 ${summaries.length} 位使用者的資料。要把哪個合併到你的 Google 帳號?</p>
        <div class="mig-list">
          ${summaries
            .map(
              (s, i) => `
            <label class="mig-item">
              <input type="radio" name="mig-pick" value="${escapeAttr(s.nickname)}" ${i === 0 ? "checked" : ""}>
              <div>
                <div class="mig-name">${escapeHtml(s.nickname)}</div>
                <div class="mig-stats">📒 ${s.chapters} 章節 · ❌ ${s.wrongbook} 錯題 · 📝 ${s.exams} 試卷</div>
              </div>
            </label>`,
            )
            .join("")}
          <label class="mig-item mig-none">
            <input type="radio" name="mig-pick" value="__none__">
            <div><div class="mig-name">都不合併 (我是新的使用者)</div></div>
          </label>
        </div>
        <div class="mig-actions">
          <button class="mig-btn mig-btn-cancel" data-act="defer">稍後再說</button>
          <button class="mig-btn mig-btn-ok" data-act="ok">確認合併</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add("show"), 10);

    modal.querySelector('[data-act="defer"]').onclick = () => {
      localStorage.setItem(LS_DEFER, String(Date.now()));
      modal.remove();
    };
    modal.querySelector('[data-act="ok"]').onclick = async () => {
      const picked = modal.querySelector(
        'input[name="mig-pick"]:checked',
      )?.value;
      if (!picked) return;
      if (picked === "__none__") {
        localStorage.setItem("migrated_ts", String(Date.now()));
        modal.remove();
        return;
      }
      const okBtn = modal.querySelector('[data-act="ok"]');
      okBtn.disabled = true;
      okBtn.textContent = "合併中...";
      const r = await performMigration(picked, googleUid);
      modal.remove();
      if (r.ok) {
        showToast(`已把「${picked}」的資料合併到 Google 帳號`);
      } else {
        alert("合併失敗: " + (r.reason || "未知錯誤"));
      }
    };
  }

  function escapeHtml(s) {
    return String(s || "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // CSS
  const css = `
.mig-modal { position: fixed; inset: 0; z-index: 10000; opacity: 0; transition: opacity .2s; pointer-events: none; }
.mig-modal.show { opacity: 1; pointer-events: auto; }
.mig-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.mig-panel { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #fff; border-radius: 14px; padding: 1.5rem; width: 92%; max-width: 480px; max-height: 88vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
.mig-panel h3 { margin: 0 0 .5rem; font-size: 1.15rem; color: #1f2937; }
.mig-desc { color: #6b7280; font-size: .88rem; margin-bottom: 1rem; line-height: 1.5; }
.mig-list { display: flex; flex-direction: column; gap: .5rem; margin-bottom: 1.2rem; }
.mig-item { display: flex; align-items: center; gap: .8rem; padding: .8rem .9rem; border: 1.5px solid #e5e7eb; border-radius: 10px; cursor: pointer; transition: all .15s; }
.mig-item:hover { border-color: #a78bfa; background: #faf5ff; }
.mig-item input:checked ~ div { color: #6d28d9; }
.mig-item input:checked + div .mig-name { color: #6d28d9; font-weight: 700; }
.mig-item:has(input:checked) { border-color: #7c3aed; background: #faf5ff; }
.mig-name { font-weight: 600; color: #1f2937; font-size: .95rem; }
.mig-stats { font-size: .78rem; color: #6b7280; margin-top: .2rem; }
.mig-none .mig-name { color: #9ca3af; font-weight: 400; font-size: .85rem; }
.mig-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.mig-btn { padding: .55rem 1.2rem; border-radius: 8px; font-size: .9rem; font-weight: 600; cursor: pointer; border: none; }
.mig-btn-cancel { background: #f3f4f6; color: #4b5563; }
.mig-btn-cancel:hover { background: #e5e7eb; }
.mig-btn-ok { background: #7c3aed; color: #fff; }
.mig-btn-ok:hover { background: #6d28d9; }
.mig-btn-ok:disabled { opacity: .5; cursor: wait; }
.mig-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff; padding: .8rem 1.4rem; border-radius: 8px; font-size: .9rem; opacity: 0; transition: opacity .2s; z-index: 10001; box-shadow: 0 4px 12px rgba(0,0,0,.2); pointer-events: none; max-width: 90%; text-align: center; }
.mig-toast.show { opacity: 1; }
`;
  if (!document.getElementById("mig-css")) {
    const s = document.createElement("style");
    s.id = "mig-css";
    s.textContent = css;
    document.head.appendChild(s);
  }

  window.Migration = {
    check: check,
    _getSummary: getSummary,
    _perform: performMigration,
  };

  // 自動 subscribe Auth 登入 → 觸發 check
  function subscribe() {
    if (window.Auth && window.Auth.onChange) {
      window.Auth.onChange(function (user) {
        if (user) check(user);
      });
    } else {
      setTimeout(subscribe, 300);
    }
  }
  subscribe();
})();
