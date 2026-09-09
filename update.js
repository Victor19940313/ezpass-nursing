// update.js — v607: 網站有新版本時「問使用者要不要更新」,不再自動重新載入
//   以前:新 Service Worker 裝好 → skipWaiting → controllerchange → 整頁 reload (寫題目寫到一半被踢回首頁)
//   現在:新版裝好 → 底部浮出「✨ 網站有新版本」+「立即更新」「稍後」;按更新才啟用新版並重新載入;
//         按稍後這個分頁 1 小時內不再問,關掉所有分頁再開就自然是新版。
(function () {
  if (!("serviceWorker" in navigator)) return;
  var SNOOZE_KEY = "upd_snooze_until";
  var _shown = false;

  function snoozed() {
    try {
      return Date.now() < parseInt(localStorage.getItem(SNOOZE_KEY) || "0");
    } catch (e) {
      return false;
    }
  }

  function css() {
    if (document.getElementById("upd-css")) return;
    var s = document.createElement("style");
    s.id = "upd-css";
    s.textContent =
      "#upd-banner{position:fixed;left:50%;bottom:1.1rem;transform:translateX(-50%);z-index:99990;background:#1f2937;color:#fff;border-radius:999px;padding:.55rem .6rem .55rem 1rem;display:flex;gap:.5rem;align-items:center;font-size:.88rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.28);max-width:calc(100vw - 2rem);white-space:nowrap}" +
      "#upd-banner button{font:inherit;font-size:.82rem;font-weight:800;border:0;border-radius:999px;padding:.35rem .8rem;cursor:pointer}" +
      "#upd-banner .upd-now{background:#a78bfa;color:#1f1b2e}#upd-banner .upd-later{background:transparent;color:#cbd5e1}" +
      "@media(max-width:480px){#upd-banner{bottom:5.2rem;font-size:.82rem}}";
    document.head.appendChild(s);
  }

  function showPrompt(reg) {
    if (_shown || snoozed() || document.getElementById("upd-banner")) return;
    _shown = true;
    css();
    var b = document.createElement("div");
    b.id = "upd-banner";
    b.innerHTML =
      '<span>✨ 網站有新版本</span><button class="upd-now" type="button">立即更新</button><button class="upd-later" type="button">稍後</button>';
    document.documentElement.appendChild(b);
    b.querySelector(".upd-now").onclick = function () {
      b.innerHTML = "<span>⏳ 更新中…</span>";
      var reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      var w = reg.waiting || reg.installing;
      if (w) w.postMessage({ type: "SKIP_WAITING" });
      // 保險:5 秒還沒切換就直接重載 (新版 SW 可能已經是 controller)
      setTimeout(function () {
        if (!reloaded) {
          reloaded = true;
          location.reload();
        }
      }, 5000);
    };
    b.querySelector(".upd-later").onclick = function () {
      try {
        localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60 * 60 * 1000));
      } catch (e) {}
      b.remove();
    };
  }

  function watch(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showPrompt(reg);
    reg.addEventListener("updatefound", function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", function () {
        if (nw.state === "installed" && navigator.serviceWorker.controller)
          showPrompt(reg);
      });
    });
  }

  // 各頁自己 register;這裡等 registration 出現再掛監聽
  var tries = 0;
  (function poll() {
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (reg) return watch(reg);
      if (++tries < 40) setTimeout(poll, 500);
    });
  })();

  window.UpdatePrompt = {
    _show: function () {
      navigator.serviceWorker.getRegistration().then(function (r) {
        if (r) {
          _shown = false;
          showPrompt(r);
        }
      });
    },
  };
})();
