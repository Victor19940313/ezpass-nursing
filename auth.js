// auth.js — Google 登入系統 (里程碑 1a: 基礎版，不動舊使用者)
// v497: 首次加 Google Auth. 純加功能，舊匿名使用者不受影響
//
// 用法:
//   1. HTML 內加 <span id="auth-widget"></span> 位置放登入 button
//   2. include 順序: firebase-app-compat → firebase-database-compat → firebase-auth-compat → auth.js
//
// 對外 API:
//   window.Auth.signIn()      → 開 Google popup 登入
//   window.Auth.signOut()     → 登出
//   window.Auth.getUser()     → 拿目前登入的 user (未登入回 null)
//   window.Auth.onChange(cb)  → 訂閱登入狀態變化 (cb 收 user or null)

(function () {
  if (typeof firebase === "undefined" || !firebase.auth) {
    console.warn("[Auth] firebase.auth 未載入，跳過");
    return;
  }

  // v498: 自己 initializeApp (幂等), 不依賴 sync.js 的執行順序
  // 之前 auth.js 在 sync.js.init() 前就跑 → firebase.auth() 因 App 沒 init 而 throw
  if (!firebase.apps.length) {
    firebase.initializeApp(window.SITE.firebase); // 多站共用版:設定來自 site-config.js
  }

  const auth = firebase.auth();
  const db = firebase.database();
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  let currentUser = null;
  // v539: 「登入狀態已確定」旗標 — Firebase 第一次回呼 (不管有沒有 user) 才算確定
  //   各頁在 isReady() 為 false 時不要顯示「請先登入」，避免已登入者看到閃一下
  let authReady = false;
  let _readyResolve;
  const readyPromise = new Promise(function (r) {
    _readyResolve = r;
  });
  const changeCallbacks = [];

  // 儲存/更新使用者 profile 到 Firebase users/{uid}/profile
  async function upsertUserProfile(user) {
    if (!user || !user.uid) return;
    try {
      const ref = db.ref("users/" + user.uid + "/profile");
      const now = Date.now();
      const snap = await ref.once("value");
      const existing = snap.val() || {};
      const payload = {
        email: user.email || "",
        name: user.displayName || "",
        avatar: user.photoURL || "",
        provider:
          user.providerData &&
          user.providerData[0] &&
          user.providerData[0].providerId === "password"
            ? "email"
            : "google",
        last_login_ts: now,
      };
      if (!existing.created_ts) {
        payload.created_ts = now;
        payload.trial_started_at = now; // 首次登入自動起算 7 天試用
      }
      await ref.update(payload);
      // v553: email → uid 索引 (萬人審計 #6: Worker 找推薦人以前要掃全部使用者)
      //   key = email 小寫,'.' 換 ',',其他 Firebase 不准的字換 '_'
      if (user.email) {
        const key = String(user.email)
          .trim()
          .toLowerCase()
          .replace(/\./g, ",")
          .replace(/[#$\[\]\/]/g, "_");
        if (key) {
          db.ref("users/__email_index/" + key)
            .set(user.uid)
            .catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[Auth] upsertUserProfile failed:", e.message);
    }
  }

  // 監聽登入狀態
  auth.onAuthStateChanged(async function (user) {
    // 過濾: 只認 Google provider (匿名的照舊，不影響)
    if (user && user.providerData && user.providerData.length > 0) {
      // v651: Google 或「Email 收登入連結」(providerId = password) 都算登入
      const isGoogle = user.providerData.some(function (p) {
        return p.providerId === "google.com" || p.providerId === "password";
      });
      if (isGoogle) {
        currentUser = user;
        await upsertUserProfile(user);
      } else {
        // 匿名 or 其他 provider - 不當作登入 (照舊當訪客)
        currentUser = null;
      }
    } else {
      currentUser = null;
    }
    if (!authReady) {
      authReady = true;
      _readyResolve(currentUser);
    }
    // v540: 身份校正搬到這裡 (每頁都載 auth.js) — 不管從哪頁進 (書籤直開練習本、手機捷徑),
    //   dental_cur_user 都必須 = Google uid。v534 只放在首頁，直開練習本會用舊暱稱寫 Firebase (hua_hsu 復活)
    if (currentUser) applyIdentity(currentUser);
    renderWidget();
    changeCallbacks.forEach(function (cb) {
      try {
        cb(currentUser);
      } catch (e) {}
    });
  });
  // v604: 身份校正抽成函式 (回測用 Auth._applyIdentityForTest)
  function applyIdentity(currentUser) {
    if (currentUser) {
      try {
        const want = currentUser.uid;
        const prevUid = localStorage.getItem("dental_cur_user");
        if (prevUid !== want) {
          const EMAIL_DISPLAY = {
            "wing2004piten@gmail.com": "HUA",
            "wen84224@gmail.com": "Shirley",
          };
          const email = (currentUser.email || "").toLowerCase();
          const name =
            EMAIL_DISPLAY[email] ||
            currentUser.displayName ||
            email.split("@")[0] ||
            "user";
          let list = [];
          try {
            list = JSON.parse(localStorage.getItem("dental_users") || "[]");
          } catch (e) {}
          list = list.filter(
            (x) => /^[A-Za-z0-9]{20,}$/.test(x.id) && x.id !== want,
          );
          list.push({ id: want, name: name, color: "#7c3aed" });
          localStorage.setItem("dental_users", JSON.stringify(list));
          localStorage.setItem("dental_cur_user", want);
          // v601: 同一個瀏覽器從 A 帳號換到 B 帳號 → 整頁重新載入,讓每個模組用 B 的身份重新初始化。
          //       以前就地 switchUser,練習本記憶體裡還是 A 的筆記/紀錄,下一次 push 就寫進 B 的雲端 (HUA 兩個帳號互相看到對方資料)
          const wasRealUser = prevUid && /^[A-Za-z0-9]{20,}$/.test(prevUid);
          // v604: 頁面不是首頁 (練習本 / 口訣區 / 牙三…) 而且是「載入後才登入」→ 頁面已用 "default" 命名空間初始化
          //       (登出後直接開練習本再登入就是這樣),也要重新載入;不然 API key / 標記都讀到 default_* 那份 (HUA 用 evonne 帳號看到自己的 key)
          const onHomePage = /^\/(index\.html)?$/.test(location.pathname);
          let reloaded = false;
          if (wasRealUser || !onHomePage) {
            try {
              const guard = "auth_switch_reload_" + want;
              if (!sessionStorage.getItem(guard)) {
                sessionStorage.setItem(guard, "1");
                reloaded = true;
                location.reload();
              }
            } catch (e) {}
          }
          if (!reloaded && window.DentalSync && window.DentalSync.switchUser)
            window.DentalSync.switchUser(want);
        } else {
          try {
            sessionStorage.removeItem("auth_switch_reload_" + want);
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  // v577: 手機登入卡在空白的 firebaseapp.com 頁 (HUA 朋友回報)
  //   原因:手機上 signInWithPopup 開的新分頁登完 Google 後,回不到原分頁 (被 in-app 瀏覽器 /
  //   Samsung / 第三方 cookie 限制擋掉),就停在空白的 __/auth/handler。
  //   作法:Android / 一般手機瀏覽器改走 signInWithRedirect (同一個分頁來回,不靠彈窗);
  //        iOS Safari 留 popup (Safari 的 ITP 反而會擋 redirect);popup 失敗一律退回 redirect;
  //        LINE / FB / IG 內建瀏覽器 Google 根本不給登,直接引導用外部瀏覽器開 (LINE 可用 openExternalBrowser=1)。
  const UA = navigator.userAgent || "";
  const IN_APP =
    /Line\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger|Twitter/i.test(
      UA,
    );
  const IS_IOS =
    /iPhone|iPad|iPod/i.test(UA) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
  const IS_ANDROID = /Android/i.test(UA);
  const IS_MOBILE = IS_IOS || IS_ANDROID;
  function loginMethod() {
    if (IN_APP) return "inapp";
    if (IS_ANDROID) return "redirect";
    if (IS_IOS) return "popup";
    return "popup";
  }
  function openExternal() {
    const url = location.href.split("#")[0];
    if (/Line\//i.test(UA)) {
      location.href =
        url + (url.includes("?") ? "&" : "?") + "openExternalBrowser=1";
      return;
    }
    try {
      navigator.clipboard && navigator.clipboard.writeText(url);
    } catch (e) {}
    alert(
      "這個 App 內建的瀏覽器不能用 Google 登入。\n\n請點右上角「⋯」選「用瀏覽器開啟」(或複製網址貼到 Chrome / Safari),再登入一次。\n\n網址已幫你複製好了。",
    );
  }
  async function signIn() {
    const method = loginMethod();
    if (method === "inapp") {
      openExternal();
      return;
    }
    if (method === "redirect") {
      try {
        sessionStorage.setItem("auth_redirect_pending", "1");
      } catch (e) {}
      try {
        await auth.signInWithRedirect(provider);
      } catch (e) {
        alert("登入失敗: " + (e.message || e.code));
      }
      return;
    }
    try {
      await auth.signInWithPopup(provider);
    } catch (e) {
      if (
        e.code === "auth/popup-closed-by-user" ||
        e.code === "auth/cancelled-popup-request"
      )
        return;
      // popup 被擋 / 這個環境不支援 → 退回 redirect
      if (
        e.code === "auth/popup-blocked" ||
        e.code === "auth/operation-not-supported-in-this-environment" ||
        e.code === "auth/web-storage-unsupported" ||
        IS_MOBILE
      ) {
        try {
          sessionStorage.setItem("auth_redirect_pending", "1");
        } catch (e2) {}
        try {
          await auth.signInWithRedirect(provider);
          return;
        } catch (e3) {
          alert("登入失敗: " + (e3.message || e3.code));
          return;
        }
      }
      alert("登入失敗: " + (e.message || e.code));
    }
  }
  // redirect 回來:把結果收下 (成功會走 onAuthStateChanged),失敗要讓人看到原因
  try {
    auth
      .getRedirectResult()
      .then(function () {
        try {
          sessionStorage.removeItem("auth_redirect_pending");
        } catch (e) {}
      })
      .catch(function (e) {
        try {
          sessionStorage.removeItem("auth_redirect_pending");
        } catch (e2) {}
        if (e && e.code && e.code !== "auth/no-auth-event")
          alert(
            "登入失敗: " +
              (e.message || e.code) +
              "\n\n請再試一次;若一直失敗,換用 Chrome 或 Safari 開啟。",
          );
      });
  } catch (e) {}

  // v651: 「用 Email 收登入連結」— 任何信箱都能登 (HUA: 不只 Gmail)。
  //   寄信是 Firebase 做的;點信裡的連結回到這個網址,下面 handleEmailLink 會把人登進來。
  const EMAIL_KEY = "auth_email_for_link";
  function emailLinkTarget() {
    // 回到「這個站」的主頁 (必須是 Firebase 授權網域);帶 emailLink=1 讓落地時認得出
    return location.origin + "/index.html?emailLink=1";
  }
  async function signInWithEmail(email) {
    email = String(email || "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error("信箱格式不對");
    await auth.sendSignInLinkToEmail(email, {
      url: emailLinkTarget(),
      handleCodeInApp: true,
    });
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch (e) {}
    return true;
  }
  async function handleEmailLink() {
    try {
      if (!auth.isSignInWithEmailLink(location.href)) return false;
    } catch (e) {
      return false;
    }
    let email = "";
    try {
      email = localStorage.getItem(EMAIL_KEY) || "";
    } catch (e) {}
    if (!email)
      email = (window.prompt("請輸入你收登入信的信箱,確認是本人:") || "")
        .trim()
        .toLowerCase();
    if (!email) return false;
    try {
      await auth.signInWithEmailLink(email, location.href);
      try {
        localStorage.removeItem(EMAIL_KEY);
      } catch (e) {}
      // 把網址上的 oobCode 等參數清掉,重新整理不會再登一次
      try {
        history.replaceState(null, "", location.pathname);
      } catch (e) {}
      return true;
    } catch (e) {
      alert(
        "登入連結失效或信箱不符: " +
          (e.message || e.code) +
          "\n\n請回到登入頁再寄一次。",
      );
      return false;
    }
  }
  // 小表單:放在登入畫面 (index.html 的 #email-login) 或入口網站
  function renderEmailForm(container) {
    const el =
      typeof container === "string"
        ? document.getElementById(container)
        : container;
    if (!el) return;
    el.innerHTML =
      '<div class="auth-e-wrap">' +
      '<div class="auth-e-title">或用 Email 登入（任何信箱都可以）</div>' +
      '<div class="auth-e-row"><input class="auth-e-input" type="email" inputmode="email" autocomplete="email" placeholder="輸入你的信箱" />' +
      '<button class="auth-e-btn" type="button">寄登入連結</button></div>' +
      '<div class="auth-e-msg"></div></div>';
    const input = el.querySelector(".auth-e-input");
    const btn = el.querySelector(".auth-e-btn");
    const msg = el.querySelector(".auth-e-msg");
    async function go() {
      btn.disabled = true;
      msg.style.color = "#6b7280";
      msg.textContent = "寄送中…";
      try {
        await signInWithEmail(input.value);
        msg.style.color = "#16a34a";
        msg.innerHTML =
          "✅ 已寄到 <b>" +
          escapeHtml(input.value.trim()) +
          "</b>，打開信裡的連結就會登入（沒收到請看垃圾郵件）。";
      } catch (e) {
        msg.style.color = "#b91c1c";
        msg.textContent = "❌ " + (e.message || e.code);
        btn.disabled = false;
      }
    }
    btn.addEventListener("click", go);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") go();
    });
  }
  handleEmailLink();

  async function signOutFn() {
    // v598: 登出後回首頁 (HUA: 用到一半按登出,頁面不會跳轉)
    const depth = (location.pathname.match(/\//g) || []).length - 1;
    const base = depth > 0 ? "../".repeat(depth) : "./";
    const onHome = /^\/(index\.html)?$/.test(location.pathname); // 只有根目錄首頁才算 (v599 修:原本 /exam/index.html 也被當首頁)
    try {
      await auth.signOut();
      // v532: 清 nickname/curUser 避免下次登入其他帳號時被舊值污染
      try {
        localStorage.removeItem("dental_cur_user");
        localStorage.removeItem("migrated_nickname");
        localStorage.removeItem("migrated_google_uid");
      } catch (e) {}
    } catch (e) {
      console.warn("[Auth] signOut failed:", e.message);
    }
    if (!onHome) location.href = base + "index.html";
    else location.reload();
  }

  function renderWidget() {
    const el = document.getElementById("auth-widget");
    if (!el) return;
    if (currentUser) {
      const avatar = currentUser.photoURL || "";
      const name = currentUser.displayName || currentUser.email || "";
      el.innerHTML =
        '<div class="auth-w-loggedin" onclick="Auth._toggleMenu(this)">' +
        (avatar
          ? '<img class="auth-w-avatar" src="' +
            escapeAttr(avatar) +
            '" alt="">'
          : '<span class="auth-w-avatar-placeholder">👤</span>') +
        '<span class="auth-w-name">' +
        escapeHtml(name) +
        "</span>" +
        '<span class="auth-w-caret">▾</span>' +
        '<div class="auth-w-menu">' +
        '<div class="auth-w-menu-email">' +
        escapeHtml(currentUser.email || "") +
        "</div>" +
        '<button class="auth-w-menu-btn" onclick="event.stopPropagation();Auth.signOut()">登出</button>' +
        "</div>" +
        "</div>";
    } else {
      el.innerHTML =
        '<button class="auth-w-signin" onclick="Auth.signIn()" title="用 Google 帳號登入，資料跨裝置同步">' +
        '<svg width="16" height="16" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:6px"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34 6.5 29.3 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.4-.3-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34 6.5 29.3 4.5 24 4.5 16.3 4.5 9.6 8.8 6.3 14.7z"/><path fill="#4CAF50" d="M24 43.5c5.2 0 9.9-2 13.4-5.2l-6.2-5.1c-2 1.5-4.5 2.3-7.2 2.3-5.2 0-9.6-3.3-11.3-8l-6.6 5.1C9.5 39 16.2 43.5 24 43.5z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.2 5.1c-.4.4 6.6-4.8 6.6-14.8 0-1.2-.1-2.4-.4-3.5z"/></svg>' +
        "<span>Google 登入</span>" +
        "</button>";
    }
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // export
  window.Auth = {
    signIn: signIn,
    signInWithEmail: signInWithEmail, // v651
    renderEmailForm: renderEmailForm, // v651
    signOut: signOutFn,
    getUser: function () {
      return currentUser;
    },
    onChange: function (cb) {
      if (typeof cb !== "function") return;
      changeCallbacks.push(cb);
      // v539: 若狀態已確定，晚註冊的 listener 立刻補呼一次 (不然永遠等不到第一次)
      if (authReady) {
        try {
          cb(currentUser);
        } catch (e) {}
      }
    },
    isReady: function () {
      return authReady;
    },
    _loginMethod: loginMethod, // v577 回測用
    _applyIdentityForTest: applyIdentity, // v604 回測用
    ready: readyPromise, // await Auth.ready → 拿到 user 或 null,但「確定了」
    _toggleMenu: function (el) {
      if (el && el.classList) el.classList.toggle("open");
    },
  };

  // 點外面關 menu
  document.addEventListener("click", function (e) {
    const openMenus = document.querySelectorAll(".auth-w-loggedin.open");
    openMenus.forEach(function (m) {
      if (!m.contains(e.target)) m.classList.remove("open");
    });
  });

  // CSS inject
  const css = `
.auth-w-signin { display: inline-flex; align-items: center; gap: 0; background: #fff; border: 1px solid #dadce0; border-radius: 999px; padding: .35rem .9rem .35rem .55rem; cursor: pointer; font-size: .85rem; color: #3c4043; font-weight: 600; transition: box-shadow .15s, background .15s; }
.auth-w-signin:hover { background: #f8f9fa; box-shadow: 0 1px 3px rgba(60,64,67,.2); }
.auth-w-loggedin { display: inline-flex; align-items: center; gap: .4rem; cursor: pointer; background: #fff; border: 1px solid #e5e7eb; border-radius: 999px; padding: .2rem .7rem .2rem .25rem; position: relative; font-size: .85rem; }
.auth-w-loggedin:hover { background: #f9fafb; }
.auth-w-avatar { width: 26px; height: 26px; border-radius: 50%; }
.auth-w-avatar-placeholder { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; background: #ede9fe; border-radius: 50%; font-size: .9rem; }
.auth-w-name { font-weight: 600; color: #1f2937; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auth-w-caret { font-size: .7rem; color: #6b7280; }
.auth-w-menu { display: none; position: absolute; top: calc(100% + 4px); right: 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.1); min-width: 200px; z-index: 9999; padding: .5rem; }
.auth-w-loggedin.open .auth-w-menu { display: block; }
.auth-w-menu-email { font-size: .78rem; color: #6b7280; padding: .4rem .5rem; border-bottom: 1px solid #f3f4f6; margin-bottom: .3rem; word-break: break-all; }
.auth-w-menu-btn { display: block; width: 100%; padding: .5rem; background: none; border: none; text-align: left; cursor: pointer; font-size: .85rem; color: #dc2626; border-radius: 4px; }
.auth-w-menu-btn:hover { background: #fef2f2; }
.auth-e-wrap { max-width: 360px; margin: 1rem auto 0; text-align: center; }
.auth-e-title { font-size: .8rem; color: #6b7280; margin-bottom: .4rem; }
.auth-e-row { display: flex; gap: .4rem; }
.auth-e-input { flex: 1; min-width: 0; padding: .5rem .7rem; border: 1.5px solid #e5e7eb; border-radius: 999px; font-size: .9rem; font-family: inherit; }
.auth-e-input:focus { outline: none; border-color: #7c3aed; }
.auth-e-btn { padding: .5rem .9rem; border: 0; border-radius: 999px; background: #7c3aed; color: #fff; font-weight: 800; font-size: .85rem; cursor: pointer; white-space: nowrap; font-family: inherit; }
.auth-e-btn:disabled { opacity: .6; cursor: default; }
.auth-e-msg { font-size: .8rem; margin-top: .45rem; min-height: 1.2em; line-height: 1.5; }
`;
  if (!document.getElementById("auth-css")) {
    const s = document.createElement("style");
    s.id = "auth-css";
    s.textContent = css;
    document.head.appendChild(s);
  }

  // 初次 render (auth state 還沒回 → 顯示登入 button)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderWidget);
  } else {
    renderWidget();
  }
})();
