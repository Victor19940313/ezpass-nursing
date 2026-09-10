// keysync.js — 個人設定跨站共用 (v664, 2026-09-10)
//
// HUA:「同一個帳號在某一個網站設定好 API 或 GitHub token 後,全網站都要有紀錄,
//       不然他們要一直重複設定」
//
// 只同步這幾個東西:Gemini 金鑰、GitHub token 與 repo。
// 走中間層 (Worker) 用「信箱」認人,所以牙醫站設定好,護理師站登入同一個信箱就有了。
// 筆記、作答紀錄不走這裡 (量大,各站本來就有自己的同步)。
(function () {
  var CENTRAL = "https://island-watch.seat-watch.workers.dev";
  var KEYS = [
    "gemini_api_keys",
    "gemini_api_key",
    "gemini_paid_key",
    "github_token",
    "github_repo",
  ];
  var TS_KEY = "prefs_synced_ts";
  var POLL_MS = 45000;
  var site = (window.SITE && window.SITE.id) || "dental";
  var timer = null;
  var lastPushed = "";

  function uid() {
    try {
      return localStorage.getItem("dental_cur_user") || "";
    } catch (e) {
      return "";
    }
  }
  function lsGet(k) {
    try {
      return localStorage.getItem(uid() + "_" + k) || "";
    } catch (e) {
      return "";
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(uid() + "_" + k, v);
    } catch (e) {}
  }
  // v666: 形狀檢查 — 放錯格子的值 (Gemini 金鑰跑到 GitHub token) 不要同步出去,
  //   不然一台裝置貼錯,每一站都會看到那串怪東西。
  function sane(name, v) {
    v = (v || "").trim();
    if (!v) return false;
    var isGemini = /^AIza[\w-]{10,}$/.test(v);
    var isGithub = /^(ghp_|github_pat_|gho_|ghs_)/.test(v) || /^[0-9a-f]{40}$/.test(v);
    if (name === "github_token") return !isGemini;
    if (name === "gemini_api_key" || name === "gemini_paid_key") return !isGithub;
    return true;
  }
  function localPrefs() {
    var o = {};
    KEYS.forEach(function (k) {
      var v = lsGet(k);
      if (v && sane(k, v)) o[k] = v;
    });
    return o;
  }
  function localTs() {
    try {
      return +(localStorage.getItem(uid() + "_" + TS_KEY) || 0);
    } catch (e) {
      return 0;
    }
  }
  function setLocalTs(ts) {
    try {
      localStorage.setItem(uid() + "_" + TS_KEY, String(ts || Date.now()));
    } catch (e) {}
  }

  async function call(body) {
    var u = window.Auth && window.Auth.getUser && window.Auth.getUser();
    if (!u || !u.getIdToken) return null;
    var idToken = await u.getIdToken();
    var r = await fetch(CENTRAL + "/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        Object.assign({ site: site, idToken: idToken }, body),
      ),
    });
    var j = await r.json();
    return j && j.ok ? j : null;
  }

  // 拉:雲端比較新 → 蓋掉本機;本機有、雲端沒有 → 等一下推上去
  async function pull() {
    var j = await call({});
    if (!j) return;
    var remote = j.prefs || {};
    var applied = [];
    KEYS.forEach(function (k) {
      if (!remote[k] || !sane(k, remote[k])) return;
      var cur = lsGet(k);
      if (cur === remote[k]) return;
      // 雲端比較新,或本機根本沒有 → 用雲端的
      if (!cur || (j.ts || 0) > localTs()) {
        lsSet(k, remote[k]);
        applied.push(k);
      }
    });
    if (j.ts) setLocalTs(j.ts);
    if (applied.length) {
      console.log("[keysync] 從別站帶回設定:", applied.join(", "));
      lastPushed = JSON.stringify(localPrefs());
    }
  }

  // 推:本機的設定跟上次推的不一樣就送上去 (沒改就不打,KV 寫入額度省著用)
  async function push() {
    var cur = localPrefs();
    if (!Object.keys(cur).length) return;
    var sig = JSON.stringify(cur);
    if (sig === lastPushed) return;
    var j = await call({ prefs: cur });
    if (!j) return;
    lastPushed = sig;
    if (j.ts) setLocalTs(j.ts);
  }

  async function tick() {
    try {
      await push();
    } catch (e) {}
  }

  function start() {
    if (timer) return;
    // 先拉再推:拉完之後本機如果還有雲端沒有的東西 (例如剛在這一站設定好),就推上去
    pull()
      .then(push)
      .catch(function () {});
    timer = setInterval(tick, POLL_MS);
    // 換分頁回來也對一次 (在別台裝置改過金鑰的情況)
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) tick();
    });
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function hook() {
    if (!window.Auth || !window.Auth.onChange) {
      setTimeout(hook, 300);
      return;
    }
    window.Auth.onChange(function (user) {
      if (user) start();
      else stop();
    });
  }
  hook();

  window.KeySync = { pull: pull, push: push, _keys: KEYS };
})();
