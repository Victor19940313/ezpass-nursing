// visitor-log.js — 訪客追蹤 + 爬蟲偵測 (v487)
// 每次頁面載入寫一筆到 Firebase traffic_log
// Fire-and-forget: 完全不阻塞、失敗不影響網站
(function () {
  if (typeof firebase === "undefined" || !firebase.database) return;
  // 多站共用版:本地開發 (localhost) 不寫 traffic_log,免得本地牙醫版把測試流量寫進線上資料庫
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;

  var BOT_PATTERNS =
    /bot|crawler|spider|scraper|GPTBot|ChatGPT|Claude|anthropic|Perplexity|Bytespider|CCBot|Amazonbot|SemrushBot|AhrefsBot|MJ12bot|DotBot|Diffbot|python-requests|python-urllib|libwww-perl|curl\/|wget\/|Java\/|Go-http|okhttp\/|node-fetch|axios\/|Headless|PhantomJS|Selenium|puppeteer|playwright/i;

  try {
    var db = firebase.database();
    var ua = navigator.userAgent || "";
    var isBot = false;
    var reasons = [];

    if (BOT_PATTERNS.test(ua)) {
      isBot = true;
      reasons.push("ua");
    }
    if (navigator.webdriver === true) {
      isBot = true;
      reasons.push("webdriver");
    }
    if (!ua) {
      isBot = true;
      reasons.push("empty_ua");
    }
    if (/HeadlessChrome/i.test(ua)) {
      isBot = true;
      reasons.push("headless");
    }
    // Chrome/Edge 應該有 window.chrome, 沒有 → 疑似假裝
    if (!window.chrome && /Chrome|Chromium|Edg/i.test(ua)) {
      isBot = true;
      reasons.push("no_chrome_obj");
    }

    // 找已登入 uid (若有)
    var uid = null;
    try {
      var cur = localStorage.getItem("dental_cur_user");
      if (cur) uid = cur;
      else {
        var users = JSON.parse(localStorage.getItem("dental_users") || "[]");
        uid = (users[0] && users[0].id) || null;
      }
    } catch (e) {}

    var payload = {
      ts: firebase.database.ServerValue.TIMESTAMP,
      ua: ua.slice(0, 300),
      url: (location.pathname + location.search).slice(0, 200),
      ref: (document.referrer || "").slice(0, 200),
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "").slice(0, 50),
      lang: (navigator.language || "").slice(0, 20),
      screen: (screen.width || 0) + "x" + (screen.height || 0),
      is_bot: isBot,
      bot_reason: reasons.join(","),
      uid: uid,
    };

    // Push 拿到 key, 之後補 IP
    var ref = db.ref("traffic_log").push();
    ref.set(payload).catch(function () {});

    // 抓 IP (async, 慢 100-300ms 不阻塞)
    fetch("https://api.ipify.org?format=json", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d && d.ip)
          ref
            .child("ip")
            .set(d.ip)
            .catch(function () {});
      })
      .catch(function () {});
  } catch (e) {
    // 不能影響網站, 完全 swallow
  }
})();
