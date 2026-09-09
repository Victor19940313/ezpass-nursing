// device-guard.js — 3 台裝置限制 (里程碑 1c-5)
// v516
//
// 目的: 防同一個 Google 帳號被分享多人共用
// 邏輯:
//   1. 每台裝置 localStorage 存一個 device_id (首次自動產)
//   2. 登入後寫 users/{uid}/devices/{device_id} = { label, first_seen, last_seen, ua }
//   3. 讀所有 devices, 按 last_seen desc 排序，前 MAX 個算 active
//   4. 若當前 device_id 不在前 MAX → 顯示 overlay 擋住，引導去 devices.html 踢舊裝置
//
// 對外 API:
//   DeviceGuard.getDeviceId()          → 當前裝置 id
//   DeviceGuard.detectLabel()          → 例 "Windows · Chrome"
//   DeviceGuard.registerAndCheck()     → 註冊+檢查，回 { ok, devices, current, max }
//   DeviceGuard.removeDevice(deviceId) → 踢掉指定 device_id
//   DeviceGuard.isBlocked()            → 當前是否被擋
//   DeviceGuard.getStatus()            → 最近一次 status
//   DeviceGuard.onChange(cb)           → status 變更 callback

(function () {
  if (typeof firebase === "undefined" || !firebase.database) return;

  const MAX = 3;
  const DEVICE_ID_KEY = "dental_device_id";
  const db = () => firebase.database();
  let currentStatus = { ok: true, devices: [], current: null, max: MAX };
  const changeCbs = [];

  function uuid() {
    return (
      "dev-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function detectLabel() {
    const ua = navigator.userAgent || "";
    let os = "未知裝置";
    if (/iPhone/.test(ua)) os = "iPhone";
    else if (/iPad/.test(ua)) os = "iPad";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Linux/.test(ua)) os = "Linux";

    let br = "";
    if (/Edg\//.test(ua)) br = "Edge";
    else if (/OPR\/|Opera/.test(ua)) br = "Opera";
    else if (/Chrome\//.test(ua)) br = "Chrome";
    else if (/Firefox\//.test(ua)) br = "Firefox";
    else if (/Safari\//.test(ua)) br = "Safari";

    return os + (br ? " · " + br : "");
  }

  async function registerAndCheck() {
    const user = window.Auth ? window.Auth.getUser() : null;
    if (!user || !user.uid) {
      currentStatus = { ok: true, no_user: true, max: MAX };
      applyBodyClass();
      return currentStatus;
    }
    const did = getDeviceId();
    const label = detectLabel();
    const now = Date.now();
    const ua = (navigator.userAgent || "").slice(0, 200);

    try {
      const ref = db().ref("users/" + user.uid + "/devices/" + did);
      const snap = await ref.once("value");
      if (snap.exists()) {
        await ref.update({ last_seen: now, ua });
      } else {
        await ref.set({ first_seen: now, last_seen: now, label, ua });
      }

      const all = await db()
        .ref("users/" + user.uid + "/devices")
        .once("value");
      const devices = [];
      all.forEach((c) => {
        const v = c.val() || {};
        v._id = c.key;
        devices.push(v);
      });
      devices.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));

      const activeIds = devices.slice(0, MAX).map((d) => d._id);
      const ok = activeIds.includes(did);
      currentStatus = { ok, devices, current: did, max: MAX };
    } catch (e) {
      currentStatus = { ok: true, error: e.message, max: MAX };
    }

    changeCbs.forEach((cb) => {
      try {
        cb(currentStatus);
      } catch (e) {}
    });
    applyBodyClass();
    renderBlockOverlay();
    return currentStatus;
  }

  function applyBodyClass() {
    if (!document.body) return;
    document.body.classList.toggle(
      "device-blocked",
      currentStatus.ok === false,
    );
  }

  function renderBlockOverlay() {
    let el = document.getElementById("device-block-overlay");
    if (currentStatus.ok !== false) {
      if (el) el.remove();
      return;
    }
    if (el) return; // already showing
    el = document.createElement("div");
    el.id = "device-block-overlay";
    el.innerHTML = `
      <div class="dbo-card">
        <div class="dbo-emoji">🔒</div>
        <h2>已達 3 台裝置上限</h2>
        <p>妳的訂閱最多可在 3 台裝置使用，目前這台被暫時擋下。<br>
        請去<b>裝置管理</b>踢掉一台舊裝置，再重新整理這頁即可解鎖。</p>
        <a href="/devices.html" class="dbo-btn">前往裝置管理</a>
        <p class="dbo-sub">當前裝置: <b>${detectLabel()}</b></p>
      </div>
    `;
    document.body.appendChild(el);
  }

  async function removeDevice(deviceId) {
    const user = window.Auth ? window.Auth.getUser() : null;
    if (!user) throw new Error("未登入");
    await db()
      .ref("users/" + user.uid + "/devices/" + deviceId)
      .remove();
    return registerAndCheck();
  }

  window.DeviceGuard = {
    MAX,
    getDeviceId,
    detectLabel,
    registerAndCheck,
    removeDevice,
    isBlocked: () => currentStatus.ok === false,
    getStatus: () => currentStatus,
    onChange: (cb) => {
      if (typeof cb === "function") changeCbs.push(cb);
    },
  };

  // 自動註冊: 等 Auth ready + 使用者登入
  function subscribe() {
    if (window.Auth && window.Auth.onChange) {
      window.Auth.onChange((u) => {
        if (u) setTimeout(registerAndCheck, 800);
      });
    } else {
      setTimeout(subscribe, 300);
    }
  }
  subscribe();

  // 心跳: 每 15 分鐘 upsert last_seen (避免長時間開著被判過期)
  setInterval(
    () => {
      if (window.Auth && window.Auth.getUser()) registerAndCheck();
    },
    15 * 60 * 1000, // v553: 5 → 15 分鐘 (萬人審計 #15)
  );

  // CSS
  const css = `
#device-block-overlay {
  position: fixed;
  inset: 0;
  background: rgba(30, 20, 10, 0.75);
  backdrop-filter: blur(6px);
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
#device-block-overlay .dbo-card {
  background: #fff;
  border-radius: 14px;
  padding: 2rem 1.5rem;
  max-width: 420px;
  text-align: center;
  box-shadow: 0 20px 60px rgba(0,0,0,.4);
}
#device-block-overlay .dbo-emoji { font-size: 3rem; margin-bottom: .5rem; }
#device-block-overlay h2 { font-size: 1.3rem; color: #dc2626; margin-bottom: .8rem; }
#device-block-overlay p { color: #4b5563; line-height: 1.7; margin-bottom: 1rem; font-size: .93rem; }
#device-block-overlay .dbo-btn {
  display: inline-block;
  padding: .8rem 1.6rem;
  background: linear-gradient(135deg, #7c3aed, #6d28d9);
  color: #fff !important;
  border-radius: 999px;
  text-decoration: none !important;
  font-weight: 700;
  font-size: .95rem;
  margin: .5rem 0 1rem;
}
#device-block-overlay .dbo-sub { font-size: .75rem; color: #9ca3af; margin: 0; }
body.device-blocked { overflow: hidden; }
`;
  if (!document.getElementById("device-guard-css")) {
    const s = document.createElement("style");
    s.id = "device-guard-css";
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
