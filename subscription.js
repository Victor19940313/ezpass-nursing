// subscription.js — 訂閱狀態判斷 + 狀態徽章 UI (里程碑 1c-1)
// v510
//
// 對外 API:
//   Subscription.getStatus(cb)   → cb({ ok, reason, days_left, plan, user })
//   Subscription.canSee()        → boolean (async, wraps getStatus)
//   Subscription.renderBadge()   → 手動觸發重畫 badge
//   Subscription.onChange(cb)    → 訂閱狀態變化時 callback
//
// Reason:
//   not_logged_in       - 沒 Google 登入
//   trial               - 試用中 (days_left)
//   paid                - 訂閱中 (days_left, plan)
//   trial_expired       - 試用過期 (該催訂閱)
//   subscription_expired- 訂閱過期
//
// UI:
//   加 <span id="sub-badge"></span> 到 header 位置，這邊 auto render

(function () {
  // v573b: Firebase SDK 載不到 (離線、gstatic 被擋) 也不能整個放棄 —
  //        以前這裡直接 return,離線開 SW 快取的頁就完全沒有訂閱鎖。
  //        現在沒有 SDK 就只靠本機快取判斷:快取說到期 → 鎖;沒快取 → 蓋「確認中」等連線。
  const hasFb = typeof firebase !== "undefined" && !!firebase.database;
  // 多站共用版:站台還沒設定 Firebase (site.json 的 firebase.apiKey 仍是 YOUR_API_KEY) → 本地預覽不鎖、不蓋「確認中」
  const siteUnconfigured = !!(window.SITE && window.SITE.firebase && window.SITE.firebase.apiKey === "YOUR_API_KEY");

  const TRIAL_DAYS = 7;
  const STATUS_CACHE_KEY = "sub_status_cache"; // v538: {uid, reason, ts, until}
  const db = hasFb ? firebase.database() : null;
  let cachedStatus = null;
  const changeCbs = [];

  // v573: 用 Firebase 伺服器時間算到期,使用者把手機時鐘往回調也沒用
  //       (.info/serverTimeOffset = 伺服器時間 - 本機時間,SDK 會持續校正)
  let _srvOffset = 0;
  let _offsetResolve = null;
  const _offsetReady = new Promise((r) => (_offsetResolve = r));
  try {
    if (db)
      db.ref(".info/serverTimeOffset").on("value", (s) => {
        const v = s.val();
        if (typeof v === "number" && isFinite(v)) _srvOffset = v;
        if (_offsetResolve) {
          _offsetResolve();
          _offsetResolve = null;
        }
      });
  } catch (e) {}
  function serverNow() {
    return Date.now() + _srvOffset;
  }

  // v553: 只讀 profile + subscription 兩個小欄位 (萬人審計 #4: 以前整個 users/{uid} 幾 MB 抓下來只為看到期日)
  // v651: 訂閱集中化 — 牙醫以外的站,訂閱紀錄不在自己的 Firebase,
  //   拿自己的 ID token 去問中間層 (Worker 用 email 到牙醫 DB / KV 找),回傳形狀跟下面 Firebase 讀到的一樣。
  const CENTRAL_WORKER = "https://island-watch.seat-watch.workers.dev";
  const CENTRAL_SITE =
    window.SITE && window.SITE.id && window.SITE.id !== "dental"
      ? window.SITE.id
      : "";
  async function loadCentral(user) {
    const idToken = await user.getIdToken();
    const r = await fetch(CENTRAL_WORKER + "/api/sub/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: CENTRAL_SITE, idToken: idToken }),
    });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || "central " + r.status);
    if (typeof j.server_now === "number")
      _srvOffset = j.server_now - Date.now(); // 以中間層的時間為準
    return { profile: j.profile || {}, subscription: j.subscription || null };
  }
  async function loadUserData(uid, user) {
    if (CENTRAL_SITE && user) return loadCentral(user);
    if (!db) throw new Error("offline");
    // v573b: 第一次先等伺服器時間差回來 (最多 1.5 秒),不然時鐘被撥過的裝置第一次會算錯
    await Promise.race([_offsetReady, new Promise((r) => setTimeout(r, 1500))]);
    const [p, sub] = await Promise.all([
      db.ref("users/" + uid + "/profile").once("value"),
      db.ref("users/" + uid + "/subscription").once("value"),
    ]);
    return { profile: p.val() || {}, subscription: sub.val() || null };
  }

  function computeStatus(user, userData) {
    if (!user || !user.uid) return { ok: false, reason: "not_logged_in" };
    const now = serverNow();
    const profile = (userData && userData.profile) || {};
    const sub = (userData && userData.subscription) || null;

    // 有訂閱
    if (sub && sub.expires_at && now < sub.expires_at) {
      return {
        ok: true,
        reason: "paid",
        plan: sub.plan,
        days_left: Math.ceil((sub.expires_at - now) / 86400_000),
        expires_at: sub.expires_at,
        user,
      };
    }

    // 訂閱過期
    if (sub && sub.expires_at && now >= sub.expires_at) {
      return {
        ok: false,
        reason: "subscription_expired",
        expires_at: sub.expires_at,
        user,
      };
    }

    // 試用期
    const trialStart = profile.trial_started_at || profile.created_ts;
    if (trialStart) {
      const trialEnd = trialStart + TRIAL_DAYS * 86400_000;
      if (now < trialEnd) {
        return {
          ok: true,
          reason: "trial",
          days_left: Math.ceil((trialEnd - now) / 86400_000),
          trial_end: trialEnd,
          user,
        };
      }
      return { ok: false, reason: "trial_expired", trial_end: trialEnd, user };
    }

    // 從未試用 (剛登入還沒寫 trial_started_at)
    return { ok: true, reason: "trial", days_left: TRIAL_DAYS, user };
  }

  async function getStatus(cb) {
    const user = window.Auth ? window.Auth.getUser() : null;
    if (!user) {
      const s = { ok: false, reason: "not_logged_in" };
      cachedStatus = s;
      try {
        localStorage.removeItem(STATUS_CACHE_KEY);
      } catch (e) {}
      if (cb) cb(s);
      return s;
    }
    try {
      const data = await loadUserData(user.uid, user);
      const s = computeStatus(user, data);
      cachedStatus = s;
      // v538: 記住這個 uid 的狀態，下次進站 0 秒先套用 (過期的人不會有空窗可以點進去)
      try {
        // v573: 連到期時刻一起記,樂觀放行時也要看它,離線/斷網不會多用到一分鐘
        localStorage.setItem(
          STATUS_CACHE_KEY,
          JSON.stringify({
            uid: user.uid,
            reason: s.reason,
            ts: Date.now(),
            until: s.expires_at || s.trial_end || 0,
          }),
        );
      } catch (e) {}
      if (cb) cb(s);
      return s;
    } catch (e) {
      const s = { ok: false, reason: "error", err: e.message };
      // v573: 查不到 (斷網/Firebase 掛) → 若手上只有樂觀放行,30 秒後再查一次,不能一直放行
      if (!cachedStatus || cachedStatus._optimistic) {
        setTimeout(refreshAndRender, 30000);
      }
      if (cb) cb(s);
      return s;
    }
  }

  async function canSee() {
    const s = await getStatus();
    return s.ok === true;
  }

  function renderBadge() {
    const el = document.getElementById("sub-badge");
    if (!el || !cachedStatus) return;
    const s = cachedStatus;
    if (s.reason === "not_logged_in" || s.reason === "error") {
      el.innerHTML = "";
      return;
    }
    if (s.reason === "trial") {
      const cls = s.days_left <= 2 ? "sub-b-warn" : "sub-b-trial";
      el.innerHTML = `<span class="sub-b ${cls}" title="試用中，還剩 ${s.days_left} 天"><span>試用</span><b>剩 ${s.days_left} 天</b><a href="/subscribe.html" class="sub-b-btn">訂閱</a></span>`;
    } else if (s.reason === "paid") {
      const cls = s.days_left <= 5 ? "sub-b-warn" : "sub-b-paid";
      const planName =
        { monthly: "月", quarterly: "季", semi: "半年" }[s.plan] ||
        (String(s.plan || "").startsWith("redeem") ? "序號" : s.plan);
      el.innerHTML =
        s.plan === "lifetime"
          ? `<span class="sub-b sub-b-paid" title="終身會員"><span>✨終身會員</span></span>`
          : `<span class="sub-b ${cls}" title="會員剩 ${s.days_left} 天"><span>✨會員</span><b>剩 ${s.days_left} 天</b></span>`;
    } else if (s.reason === "trial_expired") {
      el.innerHTML = `<span class="sub-b sub-b-expired"><span>試用結束</span><a href="/subscribe.html" class="sub-b-btn">訂閱解鎖</a></span>`;
    } else if (s.reason === "subscription_expired") {
      el.innerHTML = `<span class="sub-b sub-b-expired"><span>已過期</span><a href="/subscribe.html" class="sub-b-btn">續訂</a></span>`;
    }
  }

  function applyBodyClass() {
    if (!cachedStatus) return;
    const locked =
      cachedStatus.ok === false &&
      (cachedStatus.reason === "trial_expired" ||
        cachedStatus.reason === "subscription_expired");
    document.body.classList.toggle("sub-locked", locked);
  }

  function isLocked() {
    if (!cachedStatus) return false;
    return (
      cachedStatus.ok === false &&
      (cachedStatus.reason === "trial_expired" ||
        cachedStatus.reason === "subscription_expired")
    );
  }

  // v537: 全鎖 (方案 A) — 過期就蓋全螢幕 overlay,什麼都不能用
  //   白名單 (不鎖，過期的人要能去訂閱/兌換/回報): 首頁、訂閱、獎勵、回饋、裝置
  //   其他頁 (練習本、筆記本、口訣、牙三四五六、故事、遊戲) 一律鎖
  //   資料不動: 只是蓋一層,users/{uid} 的筆記/標記/紀錄都在，付費後拿掉 overlay 即恢復
  const UNLOCKED_PAGES = [
    "/",
    "/index.html",
    "/subscribe.html",
    "/rewards.html",
    "/feedback.html",
    "/devices.html",
  ];
  function isUnlockedPage() {
    // v542: 只做「完全相等」比對。v537 用 endsWith("/index.html") 會把 /exam/index.html、
    //       /ya3/index.html 全部誤判成首頁而不鎖 → 全鎖從沒在練習本/筆記生效過。
    //       白名單只有根目錄那幾頁，子目錄的 index.html 一律要鎖。
    const p = location.pathname.replace(/\/+$/, "") || "/";
    return UNLOCKED_PAGES.some((u) => p === u || p === u.replace(/\/$/, ""));
  }

  // v568: 這些頁沒登入也要擋 (口訣與重點分享區的分享連結只有試用/會員能開) — HUA 指定
  const REQUIRE_LOGIN_PAGES = ["/mnemonics.html"];
  function requiresLogin() {
    const p = location.pathname.replace(/\/+$/, "") || "/";
    return REQUIRE_LOGIN_PAGES.some((u) => p === u || p.endsWith(u));
  }
  function renderBlockOverlay() {
    const id = "sub-block-overlay";
    let el = document.getElementById(id);
    if (siteUnconfigured) {
      if (el) el.remove();
      return;
    }
    if (isUnlockedPage()) {
      if (el) el.remove();
      return;
    }
    // v568: 沒登入 + 這頁要登入 → 蓋「請先登入」
    if (
      cachedStatus &&
      cachedStatus.reason === "not_logged_in" &&
      requiresLogin()
    ) {
      if (el && el.dataset.mode === "needlogin") return;
      if (el) el.remove();
      const depth0 = (location.pathname.match(/\//g) || []).length - 1;
      const base0 = depth0 > 0 ? "../".repeat(depth0) : "./";
      el = document.createElement("div");
      el.id = id;
      el.dataset.mode = "needlogin";
      el.innerHTML = `
      <div class="sbo-card">
        <div class="sbo-emoji">🔐</div>
        <h2>請先登入</h2>
        <p>口訣與重點分享區只開放給<b>試用中或訂閱中</b>的會員。用 Google 登入後就能看，新帳號有 7 天免費試用。</p>
        <a href="${base0}index.html" class="sbo-btn">回首頁登入</a>
      </div>`;
      document.body.appendChild(el);
      return;
    }
    // v544: 狀態還沒回來 (cachedStatus null) → 先蓋「確認中」，不留空窗
    //       (not_logged_in / trial / paid 都不是 null,不會誤蓋)
    if (cachedStatus === null) {
      if (el && el.dataset.mode === "loading") return;
      if (el) el.remove();
      el = document.createElement("div");
      el.id = id;
      el.dataset.mode = "loading";
      el.innerHTML = `<div class="sbo-card" style="max-width:320px"><div class="sbo-emoji">⏳</div><p style="margin:0">確認訂閱狀態中…</p></div>`;
      document.body.appendChild(el);
      return;
    }
    const locked = isLocked();
    if (!locked) {
      if (el) el.remove();
      return;
    }
    if (el && el.dataset.mode === "locked") return;
    if (el) el.remove();
    const s = cachedStatus || {};
    const isTrial = s.reason === "trial_expired";
    const title = isTrial ? "免費試用已結束" : "訂閱已到期";
    const desc = isTrial
      ? "7 天試用期滿，訂閱後即可繼續使用全部功能。"
      : "續訂後即可繼續使用全部功能。";
    // 首頁相對路徑: 從子目錄 (exam/、ya3/) 要回上一層
    const depth = (location.pathname.match(/\//g) || []).length - 1;
    const base = depth > 0 ? "../".repeat(depth) : "./";
    el = document.createElement("div");
    el.id = id;
    el.dataset.mode = "locked";
    el.innerHTML = `
      <div class="sbo-card">
        <div class="sbo-emoji">🔒</div>
        <h2>${title}</h2>
        <p>${desc}<br><b>妳的筆記本、標記題、做題紀錄都保留著</b>,開通後原樣恢復。</p>
        <a href="${base}subscribe.html" class="sbo-btn">前往訂閱</a>
        <p class="sbo-sub"><a href="${base}rewards.html">有兌換序號?</a> · <a href="${base}index.html">回首頁</a></p>
      </div>`;
    document.body.appendChild(el);
  }

  // 首頁: 過期時把練習本 / 筆記本 / 口訣入口卡標 🔒 並導去訂閱
  function markHomeCards() {
    if (!isUnlockedPage()) return;
    const locked = isLocked();
    document
      .querySelectorAll(
        'a.card[href^="exam/"], a.card[href="mnemonics.html"], a.card[href^="ya"]',
      )
      .forEach((a) => {
        const nameEl = a.querySelector(".name");
        if (!nameEl) return;
        let tag = nameEl.querySelector(".sub-lock-tag");
        // v538: click 一律攔，不只 locked 時才綁 —
        //   狀態還沒回來 (cachedStatus null) → 先擋住，等回來再決定放行或導去訂閱
        //   這樣 Firebase 1-3 秒的空窗期也點不進去
        if (!a.dataset.subLockBound) {
          a.dataset.subLockBound = "1";
          a.addEventListener("click", (e) => {
            if (cachedStatus && !isLocked()) return; // 已確認沒鎖 → 放行
            e.preventDefault();
            if (isLocked()) {
              location.href = "subscribe.html";
              return;
            }
            // 還沒回來: 顯示提示，等狀態回來再走
            showWaitToast();
            const target = a.getAttribute("href");
            const once = (s) => {
              const i = changeCbs.indexOf(once);
              if (i >= 0) changeCbs.splice(i, 1);
              hideWaitToast();
              if (s && s.ok) location.href = target;
              else if (isLocked()) location.href = "subscribe.html";
            };
            changeCbs.push(once);
          });
        }
        if (locked) {
          if (!tag) {
            tag = document.createElement("span");
            tag.className = "sub-lock-tag";
            tag.textContent = "🔒 需訂閱";
            nameEl.appendChild(tag);
          }
          a.classList.add("sub-card-locked");
        } else {
          if (tag) tag.remove();
          a.classList.remove("sub-card-locked");
        }
      });
  }

  function showWaitToast() {
    if (siteUnconfigured) return;
    let t = document.getElementById("sub-wait-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "sub-wait-toast";
      t.textContent = "⏳ 確認訂閱狀態中…";
      document.body.appendChild(t);
    }
    t.classList.add("show");
  }
  function hideWaitToast() {
    const t = document.getElementById("sub-wait-toast");
    if (t) t.classList.remove("show");
  }

  async function refreshAndRender() {
    await getStatus();
    renderBadge();
    applyBodyClass();
    renderBlockOverlay();
    markHomeCards();
    changeCbs.forEach((cb) => {
      try {
        cb(cachedStatus);
      } catch (e) {}
    });
    scheduleExpiry();
  }

  // v558: 頁面一直開著，到期那一刻自動重查一次並蓋鎖 (HUA: 剩兩天的人一直在考試頁)
  //   ─ 只設一個 setTimeout,到期前零 CPU、零流量;到期時只多讀一次 profile+subscription 兩小欄位
  //   ─ 手機切到背景計時器可能被暫停 → 切回來 (visibilitychange) 若已過到期時刻就補查
  let _expiryTimer = null;
  let _expiryAt = 0;
  const MAX_TIMER = 2147483000; // setTimeout 上限 ~24.8 天，超過就先排到上限再接力
  function scheduleExpiry(untilOverride) {
    if (_expiryTimer) {
      clearTimeout(_expiryTimer);
      _expiryTimer = null;
    }
    let until = untilOverride || 0;
    if (!until && cachedStatus && cachedStatus.ok) {
      until = cachedStatus.expires_at || cachedStatus.trial_end || 0;
    }
    _expiryAt = until;
    if (!until) return;
    const ms = until - serverNow() + 1500; // 多 1.5 秒，確保重查時已經過期
    if (ms <= 0) {
      // v573: 已經過了到期時刻卻還是放行狀態 (例如樂觀快取) → 立刻重查
      if (cachedStatus && cachedStatus.ok) setTimeout(refreshAndRender, 0);
      return;
    }
    _expiryTimer = setTimeout(
      () => {
        _expiryTimer = null;
        if (serverNow() < until) return scheduleExpiry(until); // 接力 (超過 24 天的情況)
        refreshAndRender();
      },
      Math.min(ms, MAX_TIMER),
    );
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (
      _expiryAt &&
      serverNow() >= _expiryAt &&
      cachedStatus &&
      cachedStatus.ok
    )
      refreshAndRender();
  });

  window.Subscription = {
    getStatus: getStatus,
    canSee: canSee,
    isLocked: isLocked,
    renderBadge: renderBadge,
    refresh: refreshAndRender,
    onChange: function (cb) {
      if (typeof cb === "function") changeCbs.push(cb);
    },
    _scheduleForTest: scheduleExpiry, // 只給回測用
    _serverNow: serverNow, // v573 回測用
    _cache: function () {
      return cachedStatus;
    },
  };

  // v538: 樂觀鎖 — DOM ready 就先讀上次快取，過期的人 0 秒先鎖住,
  //       等 Firebase 真值回來再由 refreshAndRender 覆蓋 (已續訂就自動解鎖)
  function applyOptimisticLock() {
    // v544: 不管有沒有快取,DOM ready 先做兩件事:
    //   1. 首頁入口卡先綁 click 攔截 (v538 只在有快取時才綁 → 沒快取的空窗期能點進去)
    //   2. 鎖定頁在狀態未知時先蓋「確認中」overlay (沒快取的空窗期能用)
    markHomeCards();
    renderBlockOverlay();
    try {
      const raw = localStorage.getItem(STATUS_CACHE_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      const curUid = localStorage.getItem("dental_cur_user");
      if (!c || !c.uid || c.uid !== curUid) return;
      if (c.reason === "trial_expired" || c.reason === "subscription_expired") {
        cachedStatus = { ok: false, reason: c.reason, _optimistic: true };
        applyBodyClass();
        renderBlockOverlay();
        markHomeCards();
        return;
      }
      // v555: 最近 3 天內確認過是會員/試用中 → 先放行 (不蓋「確認中」、點卡片不等),
      //       Firebase 真值回來若已過期,refreshAndRender 會再蓋鎖。HUA: 「不要一直頻繁出現確認訂閱狀態」
      const FRESH_MS = 3 * 86400_000;
      // v573: 快取裡的到期時刻已過 → 不放行,直接先鎖 (等 Firebase 真值,已續訂會解鎖)
      if (c.until && Date.now() >= c.until) {
        cachedStatus = {
          ok: false,
          reason:
            c.reason === "trial" ? "trial_expired" : "subscription_expired",
          _optimistic: true,
        };
        applyBodyClass();
        renderBlockOverlay();
        markHomeCards();
        return;
      }
      if (
        (c.reason === "paid" || c.reason === "trial") &&
        c.ts &&
        Date.now() - c.ts < FRESH_MS
      ) {
        cachedStatus = { ok: true, reason: c.reason, _optimistic: true };
        applyBodyClass();
        renderBlockOverlay();
        markHomeCards();
        // 樂觀放行也要排到期鬧鐘 (真值回來會重排)
        if (c.until) scheduleExpiry(c.until);
      }
    } catch (e) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyOptimisticLock);
  } else {
    applyOptimisticLock();
  }

  // Subscribe Auth changes → auto refresh
  function subscribe() {
    if (window.Auth && window.Auth.onChange) {
      window.Auth.onChange(function () {
        setTimeout(refreshAndRender, 500); // 等 profile 寫入 firebase
      });
    } else {
      setTimeout(subscribe, 300);
    }
  }
  subscribe();

  // CSS
  const css = `
.sub-b { display: inline-flex; align-items: center; gap: .35rem; padding: .18rem .45rem .18rem .55rem; border-radius: 999px; font-size: .75rem; font-weight: 600; border: 1px solid transparent; white-space: nowrap; }
.sub-b span { line-height: 1; }
.sub-b b { font-weight: 700; }
.sub-b-trial { background: #e0f2fe; color: #0369a1; border-color: #bae6fd; }
.sub-b-paid { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #92400e; border-color: #fbbf24; }
.sub-b-warn { background: #fef3c7; color: #92400e; border-color: #fbbf24; }
.sub-b-expired { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
.sub-b-btn { display: inline-block; margin-left: .3rem; padding: .1rem .5rem; background: #dc2626; color: #fff !important; border-radius: 999px; font-size: .7rem; text-decoration: none !important; font-weight: 700; }
.sub-b-btn:hover { background: #b91c1c; }
.sub-b-paid .sub-b-btn { background: #7c2d12; }

/* v512: 詳解 gate — 試用/訂閱過期時鎖詳解 */
body.sub-locked details.gemini-expl > div,
body.sub-locked details.nb-expl > div,
body.sub-locked details.expl-block > div {
  position: relative;
  overflow: hidden;
  min-height: 80px;
  max-height: 200px;
}
body.sub-locked details.gemini-expl > div > *,
body.sub-locked details.nb-expl > div > *,
body.sub-locked details.expl-block > div > * {
  filter: blur(5px);
  user-select: none;
  pointer-events: none;
}
body.sub-locked details.gemini-expl > div::after,
body.sub-locked details.nb-expl > div::after,
body.sub-locked details.expl-block > div::after {
  content: "🔒 訂閱後看完整詳解 (試用已結束)";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255,255,255,.4) 0%, rgba(255,255,255,.96) 40%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: .95rem;
  font-weight: 700;
  color: #7c3aed;
  z-index: 10;
  padding: 1rem;
  text-align: center;
}
/* v537: 全鎖 overlay */
#sub-block-overlay {
  position: fixed; inset: 0; z-index: 99998;
  background: rgba(30, 20, 10, .78); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
#sub-block-overlay .sbo-card {
  background: #fff; border-radius: 14px; padding: 2rem 1.5rem; max-width: 440px;
  text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.4);
}
#sub-block-overlay .sbo-emoji { font-size: 3rem; margin-bottom: .5rem; }
#sub-block-overlay h2 { font-size: 1.3rem; color: #dc2626; margin-bottom: .8rem; }
#sub-block-overlay p { color: #4b5563; line-height: 1.7; margin-bottom: 1rem; font-size: .93rem; }
#sub-block-overlay p b { color: #16a34a; }
#sub-block-overlay .sbo-btn {
  display: inline-block; padding: .8rem 1.6rem;
  background: linear-gradient(135deg, #7c3aed, #6d28d9); color: #fff !important;
  border-radius: 999px; text-decoration: none !important; font-weight: 700; font-size: .95rem;
  margin: .5rem 0 1rem;
}
#sub-block-overlay .sbo-sub { font-size: .78rem; color: #9ca3af; margin: 0; }
#sub-block-overlay .sbo-sub a { color: #7c3aed; text-decoration: underline; }
/* v538: 等待狀態 toast */
#sub-wait-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: #1f2937; color: #fff; padding: .7rem 1.3rem; border-radius: 999px;
  font-size: .88rem; font-weight: 600; z-index: 99997; opacity: 0; pointer-events: none;
  transition: opacity .2s; box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
#sub-wait-toast.show { opacity: 1; }
/* 首頁入口卡 🔒 標記 */
.sub-lock-tag {
  display: inline-block; margin-left: .45rem; padding: .12rem .5rem;
  background: #fee2e2; color: #991b1b; border-radius: 999px;
  font-size: .68rem; font-weight: 700; vertical-align: middle;
}
a.card.sub-card-locked { opacity: .7; filter: grayscale(.35); }

body.sub-locked .sub-unlock-btn {
  display: inline-block;
  margin: .5rem auto;
  padding: .6rem 1.2rem;
  background: #7c3aed;
  color: #fff !important;
  border-radius: 999px;
  text-decoration: none !important;
  font-weight: 700;
  font-size: .9rem;
}
`;
  if (!document.getElementById("sub-css")) {
    const s = document.createElement("style");
    s.id = "sub-css";
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
