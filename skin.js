// v603: 遠端清除 — 上一次載入 sync.js 發現 users/{uid}/_meta/wipe_ts 比本機新,會設 {uid}__wipe_pending 再重新載入;
//       這裡在任何程式讀資料之前 (skin.js 是最早載入的共用檔) 同步把該 uid 的本機資料再清一次,避免舊副本復活。
(function earlyWipe() {
  try {
    var uid = localStorage.getItem("dental_cur_user");
    if (!uid) return;
    var pend = localStorage.getItem(uid + "__wipe_pending");
    if (!pend) return;
    var KEYS = [
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
      "opt_marks",
      "_ts",
    ];
    KEYS.forEach(function (k) {
      try {
        localStorage.removeItem(uid + "_" + k);
      } catch (e) {}
    });
    localStorage.setItem(uid + "__wiped", pend);
    window._syncWipePending = pend;
    try {
      var req = indexedDB.open("dental_notebooks_v1", 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("notebooks"))
          db.createObjectStore("notebooks");
      };
      req.onsuccess = function () {
        var db = req.result;
        try {
          var tx = db.transaction("notebooks", "readwrite");
          var st = tx.objectStore("notebooks");
          [
            "notebook",
            "examHistory",
            "wrongbook_state",
            "notebook_pending",
            "wrongbook_lastpos",
            "opt_marks",
          ].forEach(function (k) {
            try {
              st.delete(uid + "_" + k);
            } catch (e) {}
          });
          tx.oncomplete = function () {
            db.close();
            try {
              localStorage.removeItem(uid + "__wipe_pending");
            } catch (e) {}
            window._syncWipePending = null;
          };
          tx.onerror = function () {
            db.close();
          };
        } catch (e) {}
      };
    } catch (e) {}
  } catch (e) {}
})();
// ═══════════════════════════════════════════════════════════════
//  skin.js — 全站「風格」切換 (v550)
//  ─ 使用者在左下角 🎨 下拉選單選一種風格，存 localStorage.dental_skin (裝置層級，不分帳號)
//  ─ 套用方式: <html data-skin="kawaii">,樣式全部在 skin.css 用 html[data-skin=…] 覆蓋
//  ─ 沒選 (classic) 時 data-skin 不存在 → skin.css 完全不生效，網站跟原本一模一樣
//  ─ 跟練習本/口訣與重點分享區原有的「配色」(body.theme-xxx, {uid}_nb_theme) 是兩層，互不影響
//  載入位置: <head> 內、version.js 之後 (同步載，避免先閃原本樣式)
// ═══════════════════════════════════════════════════════════════
(function () {
  var KEY = "dental_skin";
  var SKINS = [
    { id: "classic", name: "經典（原本）", em: "🦷", fonts: "" },
    { id: "kawaii", name: "可愛風", em: "🎀", fonts: "Baloo+2:wght@600;800" },
    { id: "toon", name: "動畫電影風", em: "🎈", fonts: "Fredoka:wght@600;700" },
    {
      id: "notebook",
      name: "手繪筆記本",
      em: "✏️",
      fonts: "LXGW+WenKai+TC:wght@400;700",
    },
    { id: "stationery", name: "韓系奶油", em: "🧸", fonts: "Gowun+Dodum" },
    { id: "clinic", name: "診所清爽", em: "🩺", fonts: "" },
    { id: "night", name: "夜讀暗色", em: "🌙", fonts: "" },
    {
      id: "watercolor",
      name: "水彩暈染",
      em: "🎨",
      fonts: "Noto+Serif+TC:wght@600;900",
    },
  ];
  var byId = {};
  SKINS.forEach(function (s) {
    byId[s.id] = s;
  });

  // v551: 每個帳號各自記。key = dental_skin:{uid};沒登入用 dental_skin (裝置層級)
  function uid() {
    try {
      var u = localStorage.getItem("dental_cur_user");
      return u && /^[A-Za-z0-9]{20,}$/.test(u) ? u : "";
    } catch (e) {
      return "";
    }
  }
  function storageKey() {
    var u = uid();
    return u ? KEY + ":" + u : KEY;
  }
  function read() {
    try {
      var v = localStorage.getItem(storageKey());
      if (!v && uid()) v = localStorage.getItem(KEY); // 剛登入第一次: 沿用裝置的
      return v && byId[v] ? v : "classic";
    } catch (e) {
      return "classic";
    }
  }
  // 存到雲端 users/{uid}/profile/skin (小欄位),換裝置登入也跟著
  function saveRemote(id) {
    try {
      var u = uid();
      if (!u || !window.firebase || !firebase.apps || !firebase.apps.length)
        return;
      var user = firebase.auth && firebase.auth().currentUser;
      if (!user || user.uid !== u) return;
      firebase
        .database()
        .ref("users/" + u + "/profile/skin")
        .set(id)
        .catch(function () {});
    } catch (e) {}
  }
  function loadRemote() {
    try {
      var u = uid();
      if (!u || !window.firebase || !firebase.apps || !firebase.apps.length)
        return;
      firebase
        .database()
        .ref("users/" + u + "/profile/skin")
        .once("value")
        .then(function (snap) {
          var v = snap.val();
          if (v && byId[v] && v !== read()) {
            apply(v, false);
            try {
              localStorage.setItem(storageKey(), v);
            } catch (e) {}
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  function ensureFont(id) {
    var s = byId[id];
    if (!s || !s.fonts) return;
    var lid = "skin-font-" + id;
    if (document.getElementById(lid)) return;
    var l = document.createElement("link");
    l.id = lid;
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=" + s.fonts + "&display=swap";
    (document.head || document.documentElement).appendChild(l);
  }

  function ensureDeco(id) {
    // 水彩: 三團暈染 / 動畫: 一朵雲。其他風格不放裝飾。
    var old = document.getElementById("skin-deco");
    if (old) old.remove();
    if (!document.body) return;
    var html = "";
    if (id === "watercolor")
      html =
        '<i class="sk-blob sk-b1"></i><i class="sk-blob sk-b2"></i><i class="sk-blob sk-b3"></i>';
    else if (id === "toon") html = '<i class="sk-cloud"></i>';
    if (!html) return;
    var d = document.createElement("div");
    d.id = "skin-deco";
    d.setAttribute("aria-hidden", "true");
    d.innerHTML = html;
    document.body.appendChild(d);
  }

  // v560: 首頁 hero 插圖 (只有首頁有 #hero-art),每種風格一張,SVG 直接畫，不載外部圖
  // v641: 改成「每個國考站一張」— 牙醫=牙齒、護理師=護士帽、醫師=聽診器。
  //   站別由 site-config.js 的 window.SITE.heroArt 指定 (tooth / nurseCap / stethoscope),沒有就用牙齒。
  //   全部是自己畫的 SVG (無外部檔、無授權問題),FILL/STROKE/CHEEK 會依風格換色。
  var SHAPES = {
    tooth:
      '<svg viewBox="0 0 120 120"><path d="M32 18c14-10 42-10 56 0 14 10 12 34 4 56-4 12-8 34-16 34s-8-22-16-22-8 22-16 22-12-22-16-34C20 52 18 28 32 18z" fill="FILL" stroke="STROKE" stroke-width="3.5" stroke-linejoin="round"/><circle cx="46" cy="52" r="3.5" fill="STROKE"/><circle cx="74" cy="52" r="3.5" fill="STROKE"/><path d="M52 64q8 7 16 0" fill="none" stroke="STROKE" stroke-width="3" stroke-linecap="round"/><circle cx="38" cy="62" r="5" fill="CHEEK" opacity=".9"/><circle cx="82" cy="62" r="5" fill="CHEEK" opacity=".9"/></svg>',
    nurseCap:
      '<svg viewBox="0 0 120 120"><path d="M27 88 L35 31 Q60 21 85 31 L93 88 Q60 95 27 88 Z" fill="FILL" stroke="STROKE" stroke-width="3.5" stroke-linejoin="round"/><path d="M56.5 33 H63.5 V40.5 H71 V47.5 H63.5 V55 H56.5 V47.5 H49 V40.5 H56.5 Z" fill="#e2565f"/><circle cx="49" cy="68" r="3.5" fill="STROKE"/><circle cx="71" cy="68" r="3.5" fill="STROKE"/><path d="M54 77q6 6 12 0" fill="none" stroke="STROKE" stroke-width="3" stroke-linecap="round"/><circle cx="39" cy="75" r="5" fill="CHEEK" opacity=".9"/><circle cx="81" cy="75" r="5" fill="CHEEK" opacity=".9"/></svg>',
    stethoscope:
      '<svg viewBox="0 0 120 120"><path d="M26 26 C22 54 30 68 44 70" fill="none" stroke="STROKE" stroke-width="6.5" stroke-linecap="round"/><path d="M58 26 C62 54 54 68 44 70" fill="none" stroke="STROKE" stroke-width="6.5" stroke-linecap="round"/><path d="M44 70 C44 86 56 94 68 90" fill="none" stroke="STROKE" stroke-width="6.5" stroke-linecap="round"/><circle cx="26" cy="23" r="5.5" fill="STROKE"/><circle cx="58" cy="23" r="5.5" fill="STROKE"/><circle cx="80" cy="84" r="25" fill="FILL" stroke="STROKE" stroke-width="3.5"/><circle cx="72" cy="80" r="3.4" fill="STROKE"/><circle cx="88" cy="80" r="3.4" fill="STROKE"/><path d="M74 90q6 6 12 0" fill="none" stroke="STROKE" stroke-width="3" stroke-linecap="round"/><circle cx="65" cy="88" r="4.6" fill="CHEEK" opacity=".9"/><circle cx="95" cy="88" r="4.6" fill="CHEEK" opacity=".9"/></svg>',
  };
  // 每種風格的配色 (底色 / 線條 / 腮紅)
  var PALETTE = {
    kawaii: ["#fff", "#4a3b4b", "#ffb3c6"],
    toon: ["#fff", "#1c63b8", "#ffc63a"],
    clinic: ["#fff", "#1b7fc4", "#bfe3f2"],
    stationery: ["#fff", "#a67c6d", "#f3c9b8"],
    watercolor: ["#fff", "#c48a9b", "#f9c5d1"],
  };
  // 手帳風不畫吉祥物,畫一張便條紙
  var NOTE_ART =
    '<svg viewBox="0 0 120 120"><g transform="rotate(6 60 60)"><rect x="18" y="22" width="84" height="80" fill="#fff3a3"/><rect x="40" y="12" width="40" height="16" fill="rgba(200,220,240,.8)" transform="rotate(-6 60 20)"/><text x="60" y="56" text-anchor="middle" font-family="LXGW WenKai TC, Noto Sans TC, sans-serif" font-size="17" fill="#5b4a00">今天也要</text><text x="60" y="82" text-anchor="middle" font-family="LXGW WenKai TC, Noto Sans TC, sans-serif" font-size="17" fill="#5b4a00">念一點！</text></g></svg>';
  function siteShape() {
    try {
      var k = window.SITE && window.SITE.heroArt;
      if (k && SHAPES[k]) return SHAPES[k];
    } catch (e) {}
    return SHAPES.tooth;
  }
  function ensureArt(id) {
    var el = document.getElementById("hero-art");
    if (!el) return;
    if (id === "notebook") {
      el.innerHTML = NOTE_ART;
      return;
    }
    var p = PALETTE[id];
    el.innerHTML = p
      ? siteShape()
          .replace(/FILL/g, p[0])
          .replace(/STROKE/g, p[1])
          .replace(/CHEEK/g, p[2])
      : "";
  }

  function apply(id, save) {
    if (!byId[id]) id = "classic";
    if (id === "classic") document.documentElement.removeAttribute("data-skin");
    else {
      document.documentElement.setAttribute("data-skin", id);
      ensureFont(id);
    }
    if (save) {
      try {
        localStorage.setItem(storageKey(), id);
        localStorage.setItem(KEY, id); // 裝置預設也更新 (未登入/新帳號第一次用)
      } catch (e) {}
      saveRemote(id);
    }
    ensureDeco(id);
    ensureArt(id);
    var cur = document.getElementById("skin-picker-cur");
    if (cur) cur.textContent = byId[id].em;
    document.querySelectorAll("#skin-menu button").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.skin === id ? "true" : "false");
    });
  }

  // v615: 不再放浮動的 🎨 鈕 (HUA: 沒人會一直換風格,收進選單);改成 Skin.open() 從各頁的選單叫出置中面板
  function buildPicker() {
    if (document.getElementById("skin-picker")) return;
    var id = read();
    var wrap = document.createElement("div");
    wrap.id = "skin-picker";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div id="skin-menu" role="listbox"><div class="sk-menu-title">網站風格 <button type="button" class="sk-close" aria-label="關閉">✕</button></div>' +
      SKINS.map(function (s) {
        return (
          '<button type="button" role="option" data-skin="' +
          s.id +
          '" aria-checked="' +
          (s.id === id ? "true" : "false") +
          '"><span class="sk-em">' +
          s.em +
          "</span>" +
          s.name +
          "</button>"
        );
      }).join("") +
      "</div>";
    document.body.appendChild(wrap);
    var menu = document.getElementById("skin-menu");
    function close() {
      wrap.hidden = true;
    }
    menu.addEventListener("click", function (e) {
      if (e.target.closest(".sk-close")) return close();
      var b = e.target.closest("button[data-skin]");
      if (!b) return;
      apply(b.dataset.skin, true);
      close();
    });
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
  }
  function openPicker() {
    buildPicker();
    var wrap = document.getElementById("skin-picker");
    if (wrap) wrap.hidden = false;
  }

  // v651: 跨網域帶風格 — 入口網站 (ezpass-exam.com) 和各站是不同網域,localStorage 不共用,
  //   連結帶 ?skin=xxx 過來就先存起來套上 (HUA: 在主頁選了風格,按首頁卻變回預設)。
  //   登入後另外還有雲端 users/{uid}/profile/skin 同步,這裡是沒登入 / 剛跳過來那一瞬間也要一致。
  try {
    var qs = new URLSearchParams(location.search);
    var qSkin = qs.get("skin");
    if (qSkin && byId[qSkin]) {
      try {
        localStorage.setItem(KEY, qSkin);
        localStorage.setItem(storageKey(), qSkin);
      } catch (e) {}
      qs.delete("skin");
      var rest = qs.toString();
      history.replaceState(
        null,
        "",
        location.pathname + (rest ? "?" + rest : "") + location.hash,
      );
    }
  } catch (e) {}
  // 1. 先套 data-skin (head 階段，避免閃)
  apply(read(), false);
  // 2. body 好了再放選單 + 裝飾
  function onReady() {
    buildPicker();
    ensureDeco(read());
    ensureArt(read());
    // 登入狀態確定後: 換帳號要重讀該帳號的風格 + 拉雲端
    var hooked = false;
    function hookAuth() {
      if (hooked || !window.Auth || !window.Auth.onChange) return false;
      hooked = true;
      window.Auth.onChange(function () {
        apply(read(), false);
        loadRemote();
      });
      return true;
    }
    if (!hookAuth()) {
      var tries = 0;
      var t = setInterval(function () {
        if (hookAuth() || ++tries > 40) clearInterval(t);
      }, 250);
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", onReady);
  else onReady();
  // 3. 別的分頁改了 → 跟著換
  window.addEventListener("storage", function (e) {
    if (e.key && e.key.indexOf(KEY) === 0) apply(read(), false);
  });

  window.Skin = { apply: apply, current: read, list: SKINS, open: openPicker };
})();
