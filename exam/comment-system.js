/**
 * 每題留言區系統 (v476)
 * ────────────────────────────────────
 * 完整版:TipTap 富文字 + 圖片上傳(壓縮) + 按讚/倒讚 + 排序 + 匿名 + 隱藏
 * 資料存 Firebase RTDB question_comments/{qid}/{cid}
 * 圖片存 GitHub repo Victor19940313/2nd-dental-exam question-comment-images/
 * 詳見: 03_維護包/13 留言區系統設計.md
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────
  // 常數
  // ─────────────────────────────────────────
  const FB_ROOT_COMMENTS = "question_comments";
  const FB_ROOT_COUNTS = "comment_counts";
  const FB_USER_HIDDEN = "hidden_comments";
  const FB_USER_BOOKMARKS = "comment_bookmarks"; // v479: 珍藏別人的留言
  const FB_USER_QUOTA = "daily_upload_count";

  const IMG_REPO = "Victor19940313/2nd-dental-exam";
  const IMG_DIR = "question-comment-images";
  const IMG_MAX_WIDTH = 1600;
  const IMG_QUALITY = 0.82;
  const IMG_MAX_PER_COMMENT = 3;
  const IMG_DAILY_QUOTA = 20;
  const IMG_HARD_MAX_MB = 2;

  const COMMENT_MAX_LEN = 5000;
  const RATE_LIMIT_WINDOW_SEC = 60;
  const RATE_LIMIT_MAX_POSTS = 3;

  const HIDDEN_GUEST_KEY = "guest_hidden_comments_v1";

  // ─────────────────────────────────────────
  // Firebase helpers (等現有 sync 系統把 firebase 初始化好)
  // ─────────────────────────────────────────
  function fbReady() {
    return typeof firebase !== "undefined" && firebase.database;
  }
  // v575: 讚的規則 (HUA 拍板):只有付費會員能按、不能按自己、每天 3 個 (口訣區 + 留言共用 users/{uid}/like_log)
  const LIKE_DAILY_MAX = 3;
  const ADMIN_UIDS = ["BMtTkADnLOQCHocZ5dxoqoLpZCl1"]; // HUA — 可以按「⭐ 精選詳解」
  const FB_LEDGER = "users/__reward_ledger"; // Worker 每小時掃這裡發序號 (線上 rules 只開放 users/ 底下寫)
  const FB_FEATURED = "users/__qc_featured"; // {qid}/{cid} = {ts, by, author_uid} — 留言本體的 rules 只讓作者改,精選旗標另存
  function adminUid() {
    try {
      const u = window.Auth && window.Auth.getUser && window.Auth.getUser();
      return u && ADMIN_UIDS.includes(u.uid) ? u.uid : null;
    } catch (e) {
      return null;
    }
  }
  function isPaidMember() {
    try {
      const c = window.Subscription && window.Subscription._cache();
      return !!(c && c.ok && c.reason === "paid");
    } catch (e) {
      return false;
    }
  }
  function isAdminUser(uid) {
    return ADMIN_UIDS.includes(uid || "");
  }
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fbDb() {
    return firebase.database();
  }
  async function ensureAuth() {
    if (!fbReady()) throw new Error("Firebase 未載入");
    if (!firebase.auth) throw new Error("Firebase Auth 未載入");
    const u = firebase.auth().currentUser;
    if (u) return u;
    const r = await firebase.auth().signInAnonymously();
    return r.user;
  }
  function getMyDisplayName(isAnonymous) {
    if (isAnonymous) {
      const u = firebase.auth().currentUser;
      const uid = (u && u.uid) || "guest";
      return "匿名 " + uid.slice(-4);
    }
    // 屬名: 從 localStorage dental_users 對照 dental_cur_user 拿 name
    try {
      const curId = localStorage.getItem("dental_cur_user");
      if (curId) {
        const users = JSON.parse(localStorage.getItem("dental_users") || "[]");
        const me = users.find((u) => u.id === curId);
        if (me && me.name) return me.name;
        // fallback: 用 id 本身當名 (e.g. "hua" → "HUA")
        return curId.toUpperCase();
      }
    } catch (e) {}
    // 舊 fallback (mnemonics 系統)
    if (typeof CUR_USER !== "undefined" && CUR_USER && CUR_USER.name)
      return CUR_USER.name;
    if (typeof DentalSync !== "undefined" && DentalSync.getUserName)
      return DentalSync.getUserName() || "使用者";
    return "使用者";
  }

  // ─────────────────────────────────────────
  // 圖片壓縮 (客戶端 canvas)
  // ─────────────────────────────────────────
  async function compressImageBlob(fileOrBlob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale =
            img.width > IMG_MAX_WIDTH ? IMG_MAX_WIDTH / img.width : 1;
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff"; // 移除透明背景 (JPG 不支援)
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              if (!blob) return reject(new Error("壓縮失敗"));
              resolve({
                blob,
                width: w,
                height: h,
                originalSize: fileOrBlob.size,
              });
            },
            "image/jpeg",
            IMG_QUALITY,
          );
        };
        img.onerror = () => reject(new Error("讀圖失敗"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("檔案讀取失敗"));
      reader.readAsDataURL(fileOrBlob);
    });
  }

  // ─────────────────────────────────────────
  // GitHub 圖片上傳 (跟現有 mnemonics 同 token / 同架構)
  // ─────────────────────────────────────────
  async function getGithubToken() {
    // 讀 GitHub Token — 跟 exam page + mnemonics 用相同的 key
    // 1) exam page 本身有 window.getGithubToken() (最準)
    if (typeof window.getGithubToken === "function") {
      try {
        const t = window.getGithubToken();
        if (t) return t;
      } catch (e) {}
    }
    // 2) fallback: {curUserId}_github_token (exam page 格式, 如 "hua_github_token")
    try {
      const uid = localStorage.getItem("dental_cur_user") || "default";
      const t1 = localStorage.getItem(uid + "_github_token");
      if (t1) return t1;
    } catch (e) {}
    // 3) fallback: mnemonics 的舊 key
    try {
      const t2 = localStorage.getItem("github_token");
      if (t2) return t2;
    } catch (e) {}
    return null;
  }
  async function uploadImageToGithub(blob, qid) {
    const token = await getGithubToken();
    if (!token) throw new Error("沒有 GitHub Token, 請去筆記本 → 設定貼上");
    const ym = new Date().toISOString().slice(0, 7); // "2026-08"
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const path = `${IMG_DIR}/${ym}/${qid}-${ts}-${rand}.jpg`;
    const b64 = await blobToBase64(blob);
    const res = await fetch(
      `https://api.github.com/repos/${IMG_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `[q-comment] upload ${qid} ${ts}`,
          content: b64,
        }),
      },
    );
    if (!res.ok) throw new Error("GitHub 上傳失敗 " + res.status);
    return `https://raw.githubusercontent.com/${IMG_REPO}/main/${path}`;
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => {
        const b64 = String(r.result).split(",")[1];
        resolve(b64);
      };
      r.onerror = () => reject(new Error("blob 讀取失敗"));
      r.readAsDataURL(blob);
    });
  }
  async function checkAndIncQuota() {
    const u = await ensureAuth();
    const today = new Date().toISOString().slice(0, 10);
    const ref = fbDb().ref(`users/${u.uid}/${FB_USER_QUOTA}/${today}`);
    const snap = await ref.once("value");
    const used = snap.val() || 0;
    if (used >= IMG_DAILY_QUOTA)
      throw new Error(
        `已達今日上傳配額 ${IMG_DAILY_QUOTA} 張, 明天再試或用文字補充`,
      );
    await ref.set(used + 1);
  }
  async function handleImageUpload(fileOrBlob, qid) {
    await checkAndIncQuota();
    const compressed = await compressImageBlob(fileOrBlob);
    if (compressed.blob.size > IMG_HARD_MAX_MB * 1024 * 1024) {
      if (
        !confirm(
          `壓縮後仍有 ${(compressed.blob.size / 1024 / 1024).toFixed(1)} MB, 要繼續嗎?`,
        )
      )
        throw new Error("使用者取消");
    }
    const url = await uploadImageToGithub(compressed.blob, qid);
    return { url, ...compressed };
  }
  // Export helper (內部用 + 外部可用)
  window._compressImage = compressImageBlob;
  window._uploadCommentImage = handleImageUpload;

  // ─────────────────────────────────────────
  // 隱藏清單 (登入者 → Firebase, 訪客 → localStorage)
  // ─────────────────────────────────────────
  const _hiddenCache = { set: new Set(), loaded: false, uid: null };
  async function loadHiddenSet() {
    const u = firebase.auth().currentUser;
    if (u) {
      if (_hiddenCache.loaded && _hiddenCache.uid === u.uid)
        return _hiddenCache.set;
      const snap = await fbDb()
        .ref(`users/${u.uid}/${FB_USER_HIDDEN}`)
        .once("value");
      const obj = snap.val() || {};
      _hiddenCache.set = new Set(Object.keys(obj));
      _hiddenCache.uid = u.uid;
      _hiddenCache.loaded = true;
      return _hiddenCache.set;
    }
    // guest → localStorage
    try {
      const raw = localStorage.getItem(HIDDEN_GUEST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      _hiddenCache.set = new Set(arr);
      _hiddenCache.loaded = true;
      _hiddenCache.uid = null;
      return _hiddenCache.set;
    } catch (e) {
      return new Set();
    }
  }
  async function hideComment(cid) {
    _hiddenCache.set.add(cid);
    const u = firebase.auth().currentUser;
    if (u) {
      await fbDb().ref(`users/${u.uid}/${FB_USER_HIDDEN}/${cid}`).set(true);
    } else {
      localStorage.setItem(
        HIDDEN_GUEST_KEY,
        JSON.stringify(Array.from(_hiddenCache.set)),
      );
    }
  }
  async function unhideComment(cid) {
    _hiddenCache.set.delete(cid);
    const u = firebase.auth().currentUser;
    if (u) {
      await fbDb().ref(`users/${u.uid}/${FB_USER_HIDDEN}/${cid}`).remove();
    } else {
      localStorage.setItem(
        HIDDEN_GUEST_KEY,
        JSON.stringify(Array.from(_hiddenCache.set)),
      );
    }
  }

  // ─────────────────────────────────────────
  // 珍藏清單 (v479) — 收藏別人的留言, 之後可從「我的討論」開回
  // ─────────────────────────────────────────
  const _bookmarkCache = { set: new Set(), meta: {}, loaded: false, uid: null };
  async function loadBookmarkSet() {
    const u = await ensureAuth();
    if (_bookmarkCache.loaded && _bookmarkCache.uid === u.uid)
      return _bookmarkCache;
    const snap = await fbDb()
      .ref(`users/${u.uid}/${FB_USER_BOOKMARKS}`)
      .once("value");
    const obj = snap.val() || {};
    _bookmarkCache.set = new Set(Object.keys(obj));
    _bookmarkCache.meta = obj; // {cid: {qid, ts}}
    _bookmarkCache.uid = u.uid;
    _bookmarkCache.loaded = true;
    return _bookmarkCache;
  }
  async function bookmarkComment(qid, cid) {
    const u = await ensureAuth();
    _bookmarkCache.set.add(cid);
    const record = { qid, ts: Date.now() };
    _bookmarkCache.meta[cid] = record;
    await fbDb().ref(`users/${u.uid}/${FB_USER_BOOKMARKS}/${cid}`).set(record);
  }
  async function unbookmarkComment(cid) {
    const u = await ensureAuth();
    _bookmarkCache.set.delete(cid);
    delete _bookmarkCache.meta[cid];
    await fbDb().ref(`users/${u.uid}/${FB_USER_BOOKMARKS}/${cid}`).remove();
  }
  // 抓所有「我發的」留言 (用 dental_cur_user + firebase uid 雙比對)
  async function fetchMyComments(qidsToScan) {
    const u = await ensureAuth();
    const myLocal = getCurrentLocalUser();
    // 掃全部 question_comments 太慢 (7040 題)
    // 策略: 走 comment_counts 拿有留言的題,一題一題抓
    const cntSnap = await fbDb().ref(FB_ROOT_COUNTS).once("value");
    const counts = cntSnap.val() || {};
    const qids = Object.keys(counts).filter((k) => counts[k] > 0);
    const results = [];
    for (const qid of qids) {
      const s = await fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}`).once("value");
      const obj = s.val() || {};
      for (const [cid, c] of Object.entries(obj)) {
        if (
          c.author_uid === u.uid &&
          (!c.author_local_user || c.author_local_user === myLocal)
        )
          results.push({ qid, cid, ...c });
      }
    }
    // 由新到舊
    results.sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
    return results;
  }
  // 抓所有珍藏的留言 (根據 bookmark meta 直接抓)
  async function fetchBookmarkedComments() {
    const bm = await loadBookmarkSet();
    const results = [];
    for (const cid of bm.set) {
      const meta = bm.meta[cid];
      if (!meta || !meta.qid) continue;
      const s = await fbDb()
        .ref(`${FB_ROOT_COMMENTS}/${meta.qid}/${cid}`)
        .once("value");
      const c = s.val();
      if (c) results.push({ qid: meta.qid, cid, bookmarked_ts: meta.ts, ...c });
    }
    // 由新到舊 (按珍藏時間)
    results.sort((a, b) => (b.bookmarked_ts || 0) - (a.bookmarked_ts || 0));
    return results;
  }

  // ─────────────────────────────────────────
  // 留言 CRUD + Vote
  // ─────────────────────────────────────────
  async function fetchComments(qid) {
    const snap = await fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}`).once("value");
    const obj = snap.val() || {};
    return Object.entries(obj).map(([cid, v]) => ({ cid, ...v }));
  }
  async function fetchCount(qid) {
    const snap = await fbDb().ref(`${FB_ROOT_COUNTS}/${qid}`).once("value");
    return snap.val() || 0;
  }
  function getCurrentLocalUser() {
    try {
      return localStorage.getItem("dental_cur_user") || "default";
    } catch (e) {
      return "default";
    }
  }
  async function postComment(qid, htmlContent, isAnonymous) {
    const u = await ensureAuth();
    if (!htmlContent || htmlContent.length > COMMENT_MAX_LEN)
      throw new Error(`留言字數超過上限 ${COMMENT_MAX_LEN}`);
    if (!checkRateLimit(u.uid))
      throw new Error("你發文太快了, 60 秒內最多 3 則");
    const now = Date.now();
    const name = getMyDisplayName(isAnonymous);
    const record = {
      author_uid: u.uid,
      author_local_user: getCurrentLocalUser(), // v478: 同瀏覽器切帳號時區分作者
      author_name: name,
      is_anonymous: !!isAnonymous,
      content_html: htmlContent,
      images: extractImgUrls(htmlContent),
      created_ts: now,
      updated_ts: now,
      score: 0,
      likes_by: {},
      dislikes_by: {},
    };
    const ref = fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}`).push();
    await ref.set(record);
    // 更新 count
    try {
      await fbDb()
        .ref(`${FB_ROOT_COUNTS}/${qid}`)
        .transaction((v) => (v || 0) + 1);
    } catch (e) {}
    recordRateLimit(u.uid);
    return { cid: ref.key, ...record };
  }
  async function assertOwnership(qid, cid) {
    const u = await ensureAuth();
    const snap = await fbDb()
      .ref(`${FB_ROOT_COMMENTS}/${qid}/${cid}`)
      .once("value");
    const c = snap.val();
    if (!c) throw new Error("留言不存在或已被刪除");
    const myLocal = getCurrentLocalUser();
    if (c.author_uid !== u.uid) throw new Error("這不是妳的留言,不能改");
    if (c.author_local_user && myLocal && c.author_local_user !== myLocal)
      throw new Error(
        `這是「${c.author_local_user}」的留言,妳現在是「${myLocal}」,不能改`,
      );
    return { u, c };
  }
  async function updateComment(qid, cid, htmlContent) {
    await assertOwnership(qid, cid);
    await fbDb()
      .ref(`${FB_ROOT_COMMENTS}/${qid}/${cid}`)
      .update({
        content_html: htmlContent,
        images: extractImgUrls(htmlContent),
        updated_ts: Date.now(),
      });
  }
  async function deleteComment(qid, cid) {
    await assertOwnership(qid, cid);
    await fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}/${cid}`).remove();
    try {
      await fbDb()
        .ref(`${FB_ROOT_COUNTS}/${qid}`)
        .transaction((v) => Math.max(0, (v || 1) - 1));
    } catch (e) {}
  }
  async function toggleVote(qid, cid, wantLike) {
    const u = await ensureAuth();
    const uid = u.uid;
    const base = fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}/${cid}`);
    // 讀當下狀態再決定操作
    const snap = await base.once("value");
    const c = snap.val();
    if (!c) return null;
    const likedNow = !!(c.likes_by && c.likes_by[uid]);
    const dislikedNow = !!(c.dislikes_by && c.dislikes_by[uid]);
    let dScore = 0;
    const updates = {};
    // v575: 讚 = 獎勵用,規則嚴一點;倒讚照舊 (登入即可)
    let ledger = null; // {authorUid, delta}
    if (wantLike) {
      if (c.author_uid === uid) throw new Error("不能給自己的留言按讚");
      if (likedNow) {
        // 撤讚 (額度不退)
        updates[`likes_by/${uid}`] = null;
        dScore = -1;
        ledger = { authorUid: c.author_uid, delta: -1 };
      } else {
        if (!isPaidMember()) throw new Error("付費會員才能按讚 (試用可以珍藏、留言)");
        const used = (await fbDb().ref(`users/${uid}/like_log/${todayKey()}`).once("value")).val() || 0;
        if (used >= LIKE_DAILY_MAX) throw new Error(`今天的 ${LIKE_DAILY_MAX} 個讚用完了 (口訣區和留言共用),明天再來`);
        updates[`likes_by/${uid}`] = true;
        dScore = dislikedNow ? 2 : 1; // 從倒讚 → 讚 = +2
        if (dislikedNow) updates[`dislikes_by/${uid}`] = null;
        ledger = { authorUid: c.author_uid, delta: 1, spend: true };
      }
    } else {
      if (dislikedNow) {
        updates[`dislikes_by/${uid}`] = null;
        dScore = 1;
      } else {
        updates[`dislikes_by/${uid}`] = true;
        dScore = likedNow ? -2 : -1;
        if (likedNow) updates[`likes_by/${uid}`] = null;
      }
    }
    await base.update(updates);
    await base.child("score").transaction((v) => (v || 0) + dScore);
    // v575: 獎勵帳本 (作者累積有效讚) + 今日額度
    if (ledger && ledger.authorUid && !c.is_anonymous_reward_excluded) {
      try {
        const inc = firebase.database.ServerValue.increment;
        const up = {};
        up[`${FB_LEDGER}/comments/${ledger.authorUid}/${cid}/n`] = inc(ledger.delta);
        up[`${FB_LEDGER}/comments/${ledger.authorUid}/${cid}/qid`] = qid;
        up[`${FB_LEDGER}/comments/${ledger.authorUid}/${cid}/ts`] = Date.now();
        if (ledger.spend) up[`users/${uid}/like_log/${todayKey()}`] = inc(1);
        await fbDb().ref().update(up);
      } catch (e) {
        console.warn("[qc ledger]", e);
      }
    }
    // 回傳新狀態給 UI
    const after = await base.once("value");
    return after.val();
  }
  // v575: HUA 精選詳解 — 釘在最上面,作者得 3 天序號 (Worker 發,每人每月最多 3 則)
  async function toggleFeatured(qid, cid) {
    const admin = adminUid();
    if (!admin) throw new Error("只有管理者能精選");
    const base = fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}/${cid}`);
    const c = (await base.once("value")).val();
    if (!c) throw new Error("留言不存在");
    const cur = (await fbDb().ref(`${FB_FEATURED}/${qid}/${cid}`).once("value")).val();
    const up = {};
    if (cur) {
      up[`${FB_FEATURED}/${qid}/${cid}`] = null;
      up[`${FB_LEDGER}/featured/${c.author_uid}/${cid}`] = null;
    } else {
      const ts = Date.now();
      up[`${FB_FEATURED}/${qid}/${cid}`] = { ts, by: admin, author_uid: c.author_uid };
      up[`${FB_LEDGER}/featured/${c.author_uid}/${cid}`] = { qid, ts };
    }
    await fbDb().ref().update(up);
    return !cur;
  }
  // 把精選旗標合併進留言清單 (一題一次讀)
  async function mergeFeatured(qid, list) {
    try {
      const f = (await fbDb().ref(`${FB_FEATURED}/${qid}`).once("value")).val() || {};
      list.forEach((c) => {
        c.featured = f[c.cid] ? f[c.cid].ts || true : null;
      });
    } catch (e) {}
    return list;
  }
  function extractImgUrls(html) {
    if (!html) return [];
    const urls = [];
    const re = /<img[^>]+src="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) urls.push(m[1]);
    return urls;
  }

  // 客戶端 rate limit (存 memory + localStorage 混合)
  const _postTimes = {};
  function checkRateLimit(uid) {
    const now = Date.now();
    const arr = _postTimes[uid] || [];
    const recent = arr.filter((t) => now - t < RATE_LIMIT_WINDOW_SEC * 1000);
    _postTimes[uid] = recent;
    return recent.length < RATE_LIMIT_MAX_POSTS;
  }
  function recordRateLimit(uid) {
    if (!_postTimes[uid]) _postTimes[uid] = [];
    _postTimes[uid].push(Date.now());
  }

  // ─────────────────────────────────────────
  // 排序 (score desc, 同分 created_ts desc)
  // ─────────────────────────────────────────
  function sortComments(list) {
    return list.slice().sort((a, b) => {
      // v575: 精選詳解永遠在最上面
      if (!!a.featured !== !!b.featured) return a.featured ? -1 : 1;
      const sa = a.score || 0;
      const sb = b.score || 0;
      if (sa !== sb) return sb - sa;
      return (b.created_ts || 0) - (a.created_ts || 0);
    });
  }

  // ─────────────────────────────────────────
  // Sanitize HTML (基本擋 script/iframe/on* handler)
  // ─────────────────────────────────────────
  // v581: 留言裡的口訣區連結 (mnemonics.html#n=&s=&c=) → 「🧠 口訣」小卡,標題從公開索引補上
  const MN_LINK_RE = /https?:\/\/[^\s"'<>]*mnemonics\.html#[^\s"'<>]*c=[^\s"'<>]+/g;
  const _mnTitleCache = {};
  function mnPill(url) {
    const h = url.slice(url.indexOf("#") + 1);
    const params = {};
    h.split("&").forEach((kv) => {
      const [k, v] = kv.split("=");
      if (k) params[k] = decodeURIComponent(v || "");
    });
    const ns = params.n || params.ns || "", subj = params.s || params.subj || "", ch = params.c || params.ch || "";
    const key = ns + "__" + ch;
    const title = _mnTitleCache[key];
    const SUBJ = SITE.SMAP;
    return `<a class="qc-mn-pill" data-mnkey="${escapeHtml(key)}" data-subj="${escapeHtml(subj)}" href="${escapeHtml(url)}" target="_blank" rel="noopener">🧠 ${SUBJ[subj] || ""}口訣${title ? "：" + escapeHtml(title) : ""}</a>`;
  }
  function linkifyMnemonic(html) {
    if (!html || html.indexOf("mnemonics.html#") < 0) return html;
    // 先處理已經是 <a> 的 (編輯器插入連結),再處理純文字網址
    let out = html.replace(/<a\b[^>]*href="([^"]*mnemonics\.html#[^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (m, href) => mnPill(href));
    out = out.replace(/(^|[^"'=>])(https?:\/\/[^\s"'<>]*mnemonics\.html#[^\s"'<>]*)/g, (m, pre, url) => pre + mnPill(url));
    return out;
  }
  // 小卡標題補齊 (讀公開索引,一題一次)
  async function fillMnTitles(root) {
    const pills = [...(root || document).querySelectorAll(".qc-mn-pill[data-mnkey]")].filter((a) => !/：/.test(a.textContent));
    if (!pills.length || !fbReady()) return;
    const need = {};
    pills.forEach((a) => { (need[a.dataset.subj] = need[a.dataset.subj] || new Set()).add(a.dataset.mnkey); });
    for (const subj of Object.keys(need)) {
      if (!/^ya[3-6]$/.test(subj)) continue;
      try {
        const snap = await fbDb().ref("users/__mnemonics/pub/" + subj).once("value");
        const idx = snap.val() || {};
        need[subj].forEach((key) => { if (idx[key] && idx[key].title) _mnTitleCache[key] = idx[key].title; });
      } catch (e) {}
    }
    pills.forEach((a) => {
      const t = _mnTitleCache[a.dataset.mnkey];
      if (t) a.textContent = a.textContent.replace(/口訣.*$/, "口訣：" + t);
      else a.textContent = a.textContent.replace(/口訣$/, "口訣 (未公開或已收回)");
    });
  }
  function sanitizeHtml(html) {
    if (!html) return "";
    let s = String(html);
    // 移除 script tag
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    // 移除 iframe
    s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
    // 移除 on* attribute (onclick / onerror etc)
    s = s.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "");
    s = s.replace(/\s+on\w+\s*=\s*'[^']*'/gi, "");
    // 移除 javascript: URL
    s = s.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
    s = s.replace(/href\s*=\s*'javascript:[^']*'/gi, 'href="#"');
    return s;
  }

  // ─────────────────────────────────────────
  // UI Rendering
  // ─────────────────────────────────────────
  function fmtTs(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return "剛剛";
    if (diff < 3600 * 1000) return Math.floor(diff / 60 / 1000) + " 分鐘前";
    if (diff < 86400 * 1000) return Math.floor(diff / 3600 / 1000) + " 小時前";
    if (diff < 30 * 86400 * 1000)
      return Math.floor(diff / 86400 / 1000) + " 天前";
    return d.toLocaleDateString();
  }
  function escapeHtml(s) {
    if (!s) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // v482: 舊留言 author_name 存成「使用者」的 fallback — 用 author_local_user 補
  function _displayAuthorName(c) {
    const raw = (c.author_name || "").trim();
    if (raw && raw !== "使用者") return raw;
    if (c.author_local_user) return String(c.author_local_user).toUpperCase();
    return "使用者";
  }
  function commentItemHtml(c, myUid, isHidden, myLocalUser, bookmarkSet) {
    if (isHidden) {
      return `<div class="qc-item qc-hidden" data-cid="${c.cid}">
        <div class="qc-hidden-meta">
          🙈 已隱藏 <button onclick="QuestionComments.unhide('${c.cid}', this)" class="qc-btn-mini">顯示</button>
        </div>
      </div>`;
    }
    // v478: 同瀏覽器切帳號時, Firebase anon uid 相同但 local user 不同 → 不算 mine
    const localUserMatch =
      !c.author_local_user || // 舊留言沒 local_user → 只看 uid
      !myLocalUser ||
      c.author_local_user === myLocalUser;
    const isMine = myUid && c.author_uid === myUid && localUserMatch;
    const editedTag =
      c.updated_ts && c.updated_ts > c.created_ts
        ? `<span class="qc-edited-tag">(已編輯)</span>`
        : "";
    const myLike = c.likes_by && c.likes_by[myUid];
    const myDislike = c.dislikes_by && c.dislikes_by[myUid];
    const likeCnt = Object.keys(c.likes_by || {}).length;
    const dislikeCnt = Object.keys(c.dislikes_by || {}).length;
    const clean = linkifyMnemonic(sanitizeHtml(c.content_html || ""));
    const featuredTag = c.featured ? '<span class="qc-featured-tag">⭐ 精選詳解</span>' : "";
    const likeTitle = isMine ? "不能給自己按讚" : isPaidMember() ? "每天 3 個讚 (口訣區與留言共用)" : "付費會員才能按讚";
    const adminBtn = adminUid() && !isMine ? `<button class="qc-btn-mini qc-feat-btn ${c.featured ? "qc-featured-on" : ""}" onclick="QuestionComments.feature('${c.qid_ref}','${c.cid}',this)">${c.featured ? "⭐ 取消精選" : "⭐ 精選"}</button>` : "";
    return `<div class="qc-item ${c.featured ? "qc-featured" : ""}" data-cid="${c.cid}" data-mine="${isMine ? 1 : 0}">
      <div class="qc-meta">
        <span class="qc-who ${c.is_anonymous ? "qc-anon" : ""}">${escapeHtml(_displayAuthorName(c))}</span>
        <span class="qc-time">${fmtTs(c.created_ts)}</span>
        ${editedTag}
        ${featuredTag}
        ${isMine ? '<span class="qc-mine-tag">我的</span>' : ""}
      </div>
      <div class="qc-body">${clean}</div>
      <div class="qc-actions">
        <button class="qc-vote ${myLike ? "qc-active" : ""}" title="${likeTitle}" ${isMine ? "disabled" : ""} onclick="QuestionComments.vote('${c.qid_ref}','${c.cid}',true,this)">👍 <span>${likeCnt}</span></button>${adminBtn}
        <button class="qc-vote ${myDislike ? "qc-active-neg" : ""}" onclick="QuestionComments.vote('${c.qid_ref}','${c.cid}',false,this)">👎 <span>${dislikeCnt}</span></button>
        ${isMine ? `<button class="qc-btn-mini" onclick="QuestionComments.edit('${c.qid_ref}','${c.cid}')">🖊 編輯</button>` : ""}
        ${isMine ? `<button class="qc-btn-mini qc-del" onclick="QuestionComments.remove('${c.qid_ref}','${c.cid}')">🗑 刪</button>` : ""}
        ${!isMine ? `<button class="qc-btn-mini qc-bookmark ${bookmarkSet && bookmarkSet.has(c.cid) ? "qc-bookmarked" : ""}" onclick="QuestionComments.toggleBookmark('${c.qid_ref}','${c.cid}', this)">${bookmarkSet && bookmarkSet.has(c.cid) ? "⭐ 已珍藏" : "🔖 珍藏"}</button>` : ""}
        ${!isMine ? `<button class="qc-btn-mini" onclick="QuestionComments.hide('${c.cid}', this)">🙈 隱藏</button>` : ""}
      </div>
    </div>`;
  }

  function renderCommentSection(
    qid,
    container,
    comments,
    hiddenSet,
    bookmarkSet,
  ) {
    const u = firebase.auth().currentUser;
    const myUid = u ? u.uid : null;
    const myLocalUser = getCurrentLocalUser();
    const total = comments.length;
    const visible = comments.filter((c) => !hiddenSet.has(c.cid));
    const hiddenCount = total - visible.length;
    const sorted = sortComments(visible);
    for (const c of sorted) c.qid_ref = qid;

    const editorId = "qc-editor-" + qid;
    const anonId = "qc-anon-" + qid;

    // 富工具列: B I U | 文字色 螢光筆 字級 | 段落 | 列表 引用 | 連結 圖片
    const editorHtml = `<div class="qc-editor-wrap">
      <div class="qc-editor-header">✍️ 寫留言</div>
      <div class="qc-editor-toolbar">
        <button onclick="QuestionComments.tbCmd('bold')" title="粗體 Ctrl+B" class="qc-tb"><b>B</b></button>
        <button onclick="QuestionComments.tbCmd('italic')" title="斜體 Ctrl+I" class="qc-tb"><i>I</i></button>
        <button onclick="QuestionComments.tbCmd('underline')" title="底線 Ctrl+U" class="qc-tb"><u>U</u></button>
        <span class="qc-sep"></span>
        <div class="qc-color-menu qc-tb-group" title="文字顏色">
          <button class="qc-tb qc-color-toggle" onclick="QuestionComments.toggleColorMenu(this)"><span style="color:#ef4444;font-weight:900">A</span>▾</button>
          <div class="qc-color-pop">
            <button onclick="QuestionComments.setColor('#000000')" style="background:#000000" title="黑"></button>
            <button onclick="QuestionComments.setColor('#ef4444')" style="background:#ef4444" title="紅"></button>
            <button onclick="QuestionComments.setColor('#f97316')" style="background:#f97316" title="橘"></button>
            <button onclick="QuestionComments.setColor('#eab308')" style="background:#eab308" title="黃"></button>
            <button onclick="QuestionComments.setColor('#16a34a')" style="background:#16a34a" title="綠"></button>
            <button onclick="QuestionComments.setColor('#0ea5e9')" style="background:#0ea5e9" title="藍"></button>
            <button onclick="QuestionComments.setColor('#7c3aed')" style="background:#7c3aed" title="紫"></button>
            <button onclick="QuestionComments.setColor('#6b7280')" style="background:#6b7280" title="灰"></button>
          </div>
        </div>
        <div class="qc-color-menu qc-tb-group" title="螢光筆">
          <button class="qc-tb qc-color-toggle" onclick="QuestionComments.toggleColorMenu(this)"><span style="background:#fde68a;padding:0 3px">🖍</span>▾</button>
          <div class="qc-color-pop">
            <button onclick="QuestionComments.setHighlight('transparent')" style="background:white;border:1px dashed #d1d5db" title="無底"></button>
            <button onclick="QuestionComments.setHighlight('#fef3c7')" style="background:#fef3c7" title="黃"></button>
            <button onclick="QuestionComments.setHighlight('#dcfce7')" style="background:#dcfce7" title="綠"></button>
            <button onclick="QuestionComments.setHighlight('#dbeafe')" style="background:#dbeafe" title="藍"></button>
            <button onclick="QuestionComments.setHighlight('#fce7f3')" style="background:#fce7f3" title="粉"></button>
            <button onclick="QuestionComments.setHighlight('#ede9fe')" style="background:#ede9fe" title="紫"></button>
          </div>
        </div>
        <button onclick="QuestionComments.setSize('small')" title="小字" class="qc-tb qc-size-sm">A</button>
        <button onclick="QuestionComments.setSize('normal')" title="一般" class="qc-tb qc-size-md">A</button>
        <button onclick="QuestionComments.setSize('large')" title="大字" class="qc-tb qc-size-lg">A</button>
        <span class="qc-sep"></span>
        <button onclick="QuestionComments.setHeading()" title="標題" class="qc-tb">H</button>
        <button onclick="QuestionComments.tbCmd('formatBlock', 'blockquote')" title="引用" class="qc-tb">❝</button>
        <button onclick="QuestionComments.tbCmd('insertUnorderedList')" title="項目符號" class="qc-tb">•</button>
        <button onclick="QuestionComments.tbCmd('insertOrderedList')" title="編號列表" class="qc-tb">1.</button>
        <span class="qc-sep"></span>
        <button onclick="QuestionComments.insertLink()" title="連結" class="qc-tb">🔗</button>
        <button onclick="QuestionComments.pickImage('${qid}')" title="貼圖" class="qc-tb">🖼</button>
        <button onclick="QuestionComments.tbCmd('removeFormat')" title="清除格式" class="qc-tb">✕</button>
        <label class="qc-anon-toggle"><input type="checkbox" id="${anonId}"> 匿名</label>
        <button class="qc-post-btn" onclick="QuestionComments.post('${qid}')">發表</button>
      </div>
      <div class="qc-editor" id="${editorId}" contenteditable="true" placeholder="寫下你的解答/心得..."></div>
    </div>`;

    // 順序: 隱藏摘要 → 留言列表 → 編輯區 (在最底下)
    let html = "";
    if (hiddenCount > 0) {
      html += `<div class="qc-hidden-summary">${hiddenCount} 則已隱藏 <button onclick="QuestionComments.showHiddenInSection('${qid}', this)" class="qc-btn-mini">顯示</button></div>`;
    }
    html += `<div class="qc-list">`;
    if (sorted.length === 0)
      html += `<div class="qc-empty">還沒有留言, 你可以第一個發言</div>`;
    else
      for (const c of sorted)
        html += commentItemHtml(c, myUid, false, myLocalUser, bookmarkSet);
    html += `</div>`;
    html += editorHtml;
    container.innerHTML = html;
    fillMnTitles(container); // v581
  }

  // ─────────────────────────────────────────
  // 展開 / 收合
  // ─────────────────────────────────────────
  async function toggleSection(qid, wrapEl) {
    const body = wrapEl.querySelector(".qc-body-pane");
    if (wrapEl.classList.contains("qc-expanded")) {
      wrapEl.classList.remove("qc-expanded");
      return;
    }
    wrapEl.classList.add("qc-expanded");
    body.innerHTML = '<div class="qc-loading">⏳ 載入中...</div>';
    try {
      await ensureAuth();
      const [comments, hiddenSet, bm] = await Promise.all([
        fetchComments(qid),
        loadHiddenSet(),
        loadBookmarkSet(),
      ]);
      await mergeFeatured(qid, comments);
      renderCommentSection(qid, body, comments, hiddenSet, bm.set);
      // 聽 realtime 變化 (只有第一次展開才綁)
      // v674 (萬人審計 #12):以前用 on("value") — 只要有人留一則新的,
      //   Firebase 會把「整串留言」重送給每一個正在看這題的人。
      //   熱門題 200 則留言 × 幾千人在看 = 一則留言噴掉幾百 MB。
      //   改成 child_added / child_changed / child_removed:只送「變動的那一則」。
      const live = new Map();
      (comments || []).forEach((c) => live.set(c.cid, c));
      //   留言 id 是 Firebase push 產生的 (本身就照時間排),所以直接 limitToLast 就好,
      //   不用 orderByChild — 那個要額外建索引,沒建的話反而會整包下載再自己排。
      const ref = fbDb().ref(`${FB_ROOT_COMMENTS}/${qid}`).limitToLast(200);
      ref.off();
      let repaintTimer = null;
      const repaint = () => {
        // 短時間內連續變動 (例如別人連按幾次讚) 只重畫一次
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = setTimeout(async () => {
          const list = Array.from(live.values());
          const hs = await loadHiddenSet();
          const bm2 = await loadBookmarkSet();
          await mergeFeatured(qid, list);
          renderCommentSection(qid, body, list, hs, bm2.set);
        }, 180);
      };
      ref.on("child_added", (snap) => {
        if (live.has(snap.key)) return; // 一開始就抓過的不用再畫一次
        live.set(snap.key, { cid: snap.key, ...(snap.val() || {}) });
        repaint();
      });
      ref.on("child_changed", (snap) => {
        live.set(snap.key, { cid: snap.key, ...(snap.val() || {}) });
        repaint();
      });
      ref.on("child_removed", (snap) => {
        live.delete(snap.key);
        repaint();
      });
      // v575: 精選旗標變了也重畫
      const fref = fbDb().ref(`${FB_FEATURED}/${qid}`);
      fref.off();
      fref.on("value", async () => {
        const list = await fetchComments(qid);
        await mergeFeatured(qid, list);
        const hs = await loadHiddenSet();
        const bm2 = await loadBookmarkSet();
        renderCommentSection(qid, body, list, hs, bm2.set);
      });
    } catch (e) {
      body.innerHTML = `<div class="qc-error">載入失敗: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ─────────────────────────────────────────
  // 對外 API (掛 window.QuestionComments)
  // ─────────────────────────────────────────
  window.QuestionComments = {
    // Renders 摺疊條 (由 exam/index.html 呼叫)
    renderCollapsed: function (qid) {
      return `<div class="qc-wrap" id="qc-${qid}" data-qid="${qid}">
        <button class="qc-toggle" onclick="QuestionComments.toggle('${qid}', this.parentElement)">
          <span class="qc-toggle-icon">▼</span> 💬 留言 <span class="qc-count" id="qc-count-${qid}">…</span>
        </button>
        <div class="qc-body-pane"></div>
      </div>`;
    },
    // 展開 + 抓 count 更新
    toggle: async function (qid, wrapEl) {
      await toggleSection(qid, wrapEl);
      // 更新 count badge
      try {
        const cnt = await fetchCount(qid);
        const badge = document.getElementById("qc-count-" + qid);
        if (badge) badge.textContent = "(" + cnt + ")";
      } catch (e) {}
    },
    // 頁面第一次 render 題目時可批次抓 counts (可選 optimization)
    prefetchCounts: async function (qids) {
      if (!fbReady()) return;
      for (const qid of qids) {
        try {
          const cnt = await fetchCount(qid);
          const badge = document.getElementById("qc-count-" + qid);
          if (badge) badge.textContent = cnt > 0 ? "(" + cnt + ")" : "(0)";
        } catch (e) {}
      }
    },
    // Toolbar 命令 (支援第二參數如 formatBlock)
    tbCmd: function (cmd, arg) {
      document.execCommand(cmd, false, arg || null);
    },
    insertLink: function () {
      const url = prompt("貼上連結 URL:");
      if (url && /^https?:\/\//.test(url))
        document.execCommand("createLink", false, url);
    },
    // 文字顏色
    setColor: function (color) {
      document.execCommand("foreColor", false, color);
      // 關閉 popup
      document
        .querySelectorAll(".qc-color-menu.qc-open")
        .forEach((el) => el.classList.remove("qc-open"));
    },
    // 螢光筆 (背景色)
    setHighlight: function (color) {
      // hiliteColor 在 Firefox 是這個, Chrome 是 backColor - 兩個都試
      const cmd = document.queryCommandSupported("hiliteColor")
        ? "hiliteColor"
        : "backColor";
      try {
        document.execCommand("styleWithCSS", false, true);
      } catch (e) {}
      document.execCommand(
        cmd,
        false,
        color === "transparent" ? "inherit" : color,
      );
      document
        .querySelectorAll(".qc-color-menu.qc-open")
        .forEach((el) => el.classList.remove("qc-open"));
    },
    // 字級 (用 execCommand fontSize + CSS class)
    setSize: function (size) {
      // execCommand fontSize 只支援 1-7, 我們用 span 包 CSS class 才好看
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return; // 沒選字就跳過
      const span = document.createElement("span");
      if (size === "small") span.style.fontSize = "0.85rem";
      else if (size === "large") span.style.fontSize = "1.15rem";
      else span.style.fontSize = "1rem";
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
        sel.removeAllRanges();
      } catch (e) {}
    },
    // 標題 (h3, 循環切換 h3 ↔ 一般段落)
    setHeading: function () {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const node = sel.anchorNode;
      let parent = node && (node.nodeType === 3 ? node.parentNode : node);
      // 檢查有沒有已經在 h3 內
      let inH3 = false;
      while (
        parent &&
        parent.classList &&
        !parent.classList.contains("qc-editor")
      ) {
        if (parent.tagName === "H3") {
          inH3 = true;
          break;
        }
        parent = parent.parentNode;
      }
      document.execCommand("formatBlock", false, inH3 ? "p" : "h3");
    },
    // 顏色選單 popup toggle
    toggleColorMenu: function (btn) {
      const menu = btn.parentElement;
      const wasOpen = menu.classList.contains("qc-open");
      // 關掉所有其他 popup
      document
        .querySelectorAll(".qc-color-menu.qc-open")
        .forEach((el) => el.classList.remove("qc-open"));
      if (!wasOpen) menu.classList.add("qc-open");
    },
    // 圖片選取 (檔案 or 貼上)
    pickImage: function (qid) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        try {
          const editor = document.getElementById("qc-editor-" + qid);
          if (!editor) return;
          editor.contentEditable = "false";
          editor.setAttribute("data-uploading", "1");
          const r = await handleImageUpload(f, qid);
          editor.contentEditable = "true";
          editor.removeAttribute("data-uploading");
          editor.focus();
          document.execCommand(
            "insertHTML",
            false,
            `<img src="${r.url}" alt="">`,
          );
        } catch (e) {
          const editor = document.getElementById("qc-editor-" + qid);
          if (editor) {
            editor.contentEditable = "true";
            editor.removeAttribute("data-uploading");
          }
          alert("上傳失敗: " + e.message);
        }
      };
      input.click();
    },
    // 發表
    post: async function (qid) {
      const editor = document.getElementById("qc-editor-" + qid);
      const anon = document.getElementById("qc-anon-" + qid);
      if (!editor) return;
      const html = editor.innerHTML.trim();
      const text = (editor.textContent || "").trim();
      if (!text && !html.includes("<img")) {
        alert("留言不能是空的");
        return;
      }
      try {
        await postComment(qid, html, !!(anon && anon.checked));
        editor.innerHTML = "";
        if (anon) anon.checked = false;
        // 更新 badge
        const badge = document.getElementById("qc-count-" + qid);
        if (badge) {
          const cur =
            parseInt((badge.textContent || "").replace(/\D/g, "")) || 0;
          badge.textContent = "(" + (cur + 1) + ")";
        }
      } catch (e) {
        alert("發表失敗: " + e.message);
      }
    },
    // 投票
    vote: async function (qid, cid, wantLike, btn) {
      if (btn) btn.disabled = true;
      try {
        await toggleVote(qid, cid, wantLike);
      } catch (e) {
        // v575: 規則性的擋 (付費才能讚 / 額度用完 / 自己) 用 toast 口氣,不用 alert 嚇人
        if (typeof showToast === "function") showToast(e.message);
        else alert(e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    },
    // v575: HUA 精選
    feature: async function (qid, cid, btn) {
      if (btn) btn.disabled = true;
      try {
        const on = await toggleFeatured(qid, cid);
        if (typeof showToast === "function") showToast(on ? "⭐ 已精選,作者會收到 3 天序號" : "已取消精選");
      } catch (e) {
        alert("精選失敗: " + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    },
    _isPaid: isPaidMember,
    _postRaw: postComment, // 測試用
    _deleteRaw: deleteComment, // 測試用
    // 珍藏 / 取消珍藏 toggle
    toggleBookmark: async function (qid, cid, btn) {
      try {
        const bm = await loadBookmarkSet();
        if (bm.set.has(cid)) {
          await unbookmarkComment(cid);
          if (btn) {
            btn.textContent = "🔖 珍藏";
            btn.classList.remove("qc-bookmarked");
          }
        } else {
          await bookmarkComment(qid, cid);
          if (btn) {
            btn.textContent = "⭐ 已珍藏";
            btn.classList.add("qc-bookmarked");
          }
        }
      } catch (e) {
        alert("珍藏失敗: " + e.message);
      }
    },
    // 開「我的討論」modal
    openMyDiscussions: async function () {
      openMyDiscussionsModal();
    },
    // 隱藏
    hide: async function (cid, btn) {
      try {
        await hideComment(cid);
        // 從畫面移除該 item (簡單版: 找到 parent 移掉)
        const item = btn.closest(".qc-item");
        if (item) item.style.display = "none";
      } catch (e) {
        alert("隱藏失敗: " + e.message);
      }
    },
    unhide: async function (cid, btn) {
      try {
        await unhideComment(cid);
        // Re-render 該區
        const wrap = btn.closest(".qc-wrap");
        if (wrap) {
          const qid = wrap.getAttribute("data-qid");
          if (qid) await toggleSection(qid, wrap); // 收
          if (qid) await toggleSection(qid, wrap); // 開
        }
      } catch (e) {
        alert("復原失敗: " + e.message);
      }
    },
    showHiddenInSection: async function (qid, btn) {
      // 一次顯示所有被隱藏的 → 清該 qid 的所有 hide (慎重: 提示)
      if (!confirm("要顯示所有被你隱藏的留言?(下次可以再一則一則隱藏)")) return;
      const comments = await fetchComments(qid);
      for (const c of comments) {
        if (_hiddenCache.set.has(c.cid)) await unhideComment(c.cid);
      }
      const wrap = document.getElementById("qc-" + qid);
      if (wrap) {
        wrap.classList.remove("qc-expanded");
        await toggleSection(qid, wrap);
      }
    },
    // 編輯: 塞舊內容進 editor, 改「發表」為「更新」
    edit: async function (qid, cid) {
      const list = await fetchComments(qid);
      const c = list.find((x) => x.cid === cid);
      if (!c) return;
      const editor = document.getElementById("qc-editor-" + qid);
      const postBtn = editor.parentElement.querySelector(".qc-post-btn");
      if (!editor || !postBtn) return;
      editor.innerHTML = c.content_html || "";
      editor.focus();
      postBtn.textContent = "更新";
      postBtn.setAttribute(
        "onclick",
        `QuestionComments.saveEdit('${qid}','${cid}')`,
      );
    },
    saveEdit: async function (qid, cid) {
      const editor = document.getElementById("qc-editor-" + qid);
      if (!editor) return;
      const html = editor.innerHTML.trim();
      try {
        await updateComment(qid, cid, html);
        editor.innerHTML = "";
        const btn = editor.parentElement.querySelector(".qc-post-btn");
        if (btn) {
          btn.textContent = "發表";
          btn.setAttribute("onclick", `QuestionComments.post('${qid}')`);
        }
      } catch (e) {
        alert("更新失敗: " + e.message);
      }
    },
    // 刪除
    remove: async function (qid, cid) {
      if (!confirm("刪除這則留言?")) return;
      try {
        await deleteComment(qid, cid);
        const badge = document.getElementById("qc-count-" + qid);
        if (badge) {
          const cur =
            parseInt((badge.textContent || "").replace(/\D/g, "")) || 1;
          badge.textContent = "(" + Math.max(0, cur - 1) + ")";
        }
      } catch (e) {
        alert("刪除失敗: " + e.message);
      }
    },
    // 對外 helper (測試/debug)
    _internal: {
      sortComments,
      sanitizeHtml,
      compressImageBlob,
      fetchComments,
      loadHiddenSet,
    },
  };

  // ─────────────────────────────────────────
  // ─────────────────────────────────────────
  // 我的討論 Modal — 「我發的」+「珍藏的」2 tabs
  // ─────────────────────────────────────────
  function _fmtQid(qid) {
    // ya3-115-2-4 → 「牙三 115-2 第 4 題」
    const m = qid.match(/^([a-z]+\d*)-(\d+)-(\d+)-(\d+)$/);
    if (!m) return qid;
    const subj =
      SITE.SMAP[m[1]] || m[1];
    return `${subj} ${m[2]}-${m[3]} 第 ${m[4]} 題`;
  }
  function _mdItemHtml(c, showBookmarkedTs) {
    const clean = sanitizeHtml(c.content_html || "");
    return `<div class="qc-md-item">
      <div class="qc-md-head">
        <span class="qc-md-qtag" onclick="QuestionComments.jumpToQuestion('${c.qid}')">📄 ${_fmtQid(c.qid)}</span>
        <span class="qc-md-when">${showBookmarkedTs ? "🔖 " + fmtTs(c.bookmarked_ts) : fmtTs(c.created_ts)}</span>
      </div>
      <div class="qc-md-who">${escapeHtml(_displayAuthorName(c))}${c.is_anonymous ? " (匿名)" : ""}</div>
      <div class="qc-md-body">${clean}</div>
    </div>`;
  }
  async function openMyDiscussionsModal() {
    // 建 modal DOM (若不存在)
    let modal = document.getElementById("qc-md-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "qc-md-modal";
      modal.className = "qc-md-modal";
      modal.innerHTML = `<div class="qc-md-backdrop" onclick="QuestionComments._closeMd()"></div>
        <div class="qc-md-panel">
          <div class="qc-md-header">
            <div class="qc-md-tabs">
              <button class="qc-md-tab qc-active" data-tab="mine" onclick="QuestionComments._switchMdTab('mine')">💬 我發的</button>
              <button class="qc-md-tab" data-tab="bookmarks" onclick="QuestionComments._switchMdTab('bookmarks')">🔖 珍藏的</button>
            </div>
            <button class="qc-md-close" onclick="QuestionComments._closeMd()">✕</button>
          </div>
          <div class="qc-md-body-pane" id="qc-md-body"></div>
        </div>`;
      document.body.appendChild(modal);
    }
    // v494: exam/index.html 的 closeAllOverlays() 會對 id 結尾 -modal 的 element 設 inline style.display="none"
    //       這個 inline style 會蓋掉 CSS class rule (.qc-md-modal.qc-md-open { display: flex })
    //       導致「開過→點題號→回來按我的討論」再按就開不了
    //       解法: 加 class 之前先清 inline display, 讓 CSS class rule 生效
    modal.style.removeProperty("display");
    modal.classList.add("qc-md-open");
    // 預設載入「我發的」
    _renderMdTab("mine");
  }
  // v481: 按科目分組
  const SUBJ_ORDER = [...SITE.SUBJ_CODES, "other"];
  const SUBJ_LABEL = { ...SITE.SEMOJI_NAME, other: "📦 其他" };
  function _subjOfQid(qid) {
    const m = String(qid).match(/^([a-z]+\d*)-/);
    return m && SITE.SMAP[m[1]] ? m[1] : "other";
  }
  function _renderMdListBySubject(list, showBookmarkedTs) {
    if (list.length === 0) return "";
    // v493: 改用「上方科目 tab」— 一次只看一科, 不再垂直堆疊
    const groups = {};
    for (const c of list) {
      const s = _subjOfQid(c.qid);
      (groups[s] || (groups[s] = [])).push(c);
    }
    const available = SUBJ_ORDER.filter(
      (s) => groups[s] && groups[s].length > 0,
    );
    if (available.length === 0) return "";
    // 上方科目 tab bar
    let tabs = '<div class="qc-md-subj-tabs">';
    for (const s of available) {
      tabs += `<button class="qc-md-subj-tab" data-subj="${s}" onclick="QuestionComments._switchMdSubj('${s}')">${SUBJ_LABEL[s] || s} <span class="qc-md-subj-tab-count">${groups[s].length}</span></button>`;
    }
    tabs += "</div>";
    // 每個科目一個 pane, 只顯示 active 那個
    let panes = '<div class="qc-md-subj-panes">';
    for (const s of available) {
      panes += `<div class="qc-md-subj-pane" data-subj="${s}">${groups[s].map((c) => _mdItemHtml(c, showBookmarkedTs)).join("")}</div>`;
    }
    panes += "</div>";
    // 預設 activate 第一個 subj (下次 microtask 執行, 等 DOM insert 完)
    setTimeout(() => {
      const first = available[0];
      if (window.QuestionComments && window.QuestionComments._switchMdSubj) {
        window.QuestionComments._switchMdSubj(first);
      }
    }, 0);
    return tabs + panes;
  }
  async function _renderMdTab(tab) {
    const body = document.getElementById("qc-md-body");
    if (!body) return;
    body.innerHTML =
      '<div class="qc-loading">⏳ 載入中...(掃全部有留言的題,略慢)</div>';
    try {
      const list =
        tab === "mine"
          ? await fetchMyComments()
          : await fetchBookmarkedComments();
      if (list.length === 0) {
        body.innerHTML = `<div class="qc-empty">${tab === "mine" ? "你還沒有發表過留言" : "你還沒有珍藏任何留言"}</div>`;
        return;
      }
      body.innerHTML = _renderMdListBySubject(list, tab !== "mine");
    } catch (e) {
      body.innerHTML = `<div class="qc-error">載入失敗: ${escapeHtml(e.message)}</div>`;
    }
  }
  // 補進 API (在 QuestionComments 物件已建好之後掛)
  function _installMdHelpers() {
    if (!window.QuestionComments) return;
    window.QuestionComments._switchMdTab = function (tab) {
      document
        .querySelectorAll(".qc-md-tab")
        .forEach((el) =>
          el.classList.toggle("qc-active", el.getAttribute("data-tab") === tab),
        );
      _renderMdTab(tab);
    };
    window.QuestionComments._closeMd = function () {
      const m = document.getElementById("qc-md-modal");
      if (m) m.classList.remove("qc-md-open");
    };
    // v481: 展開/收合科目群組 (v493 已不用, 保留 backward compat)
    window.QuestionComments._toggleMdGroup = function (headerEl) {
      const group = headerEl.parentElement;
      if (!group) return;
      group.classList.toggle("qc-md-collapsed");
    };
    // v493: 切換科目 tab (一次只顯示一科)
    window.QuestionComments._switchMdSubj = function (subj) {
      document.querySelectorAll(".qc-md-subj-tab").forEach((el) => {
        el.classList.toggle("qc-active", el.getAttribute("data-subj") === subj);
      });
      document.querySelectorAll(".qc-md-subj-pane").forEach((el) => {
        el.classList.toggle("qc-active", el.getAttribute("data-subj") === subj);
      });
      // 切 tab 順便把 body 捲回頂
      const body = document.getElementById("qc-md-body");
      if (body) body.scrollTop = 0;
    };
    window.QuestionComments.jumpToQuestion = function (qid) {
      // 關 modal + 觸發網站內建的 jumpToQ (exam page 定義在 index.html)
      window.QuestionComments._closeMd();
      // v481: 修跳轉 — 實際的 function 是 `jumpToQ` 不是 `jumpToQuestion`
      const fn =
        window.jumpToQ || window.gotoQuestionById || window.jumpToQuestion;
      if (typeof fn === "function") {
        try {
          fn(qid);
        } catch (e) {
          console.warn("[QC] jump failed:", e);
        }
      } else {
        location.hash = "q-" + qid;
        alert("找不到跳題函式 (window.jumpToQ), 已更新 URL hash: " + qid);
      }
    };
  }

  // CSS 注入
  // ─────────────────────────────────────────
  const CSS = `
.qc-wrap { margin-top: .8rem; border-top: 1px solid #e5e7eb; padding-top: .5rem; }
.qc-toggle { background: none; border: none; padding: .5rem .7rem; cursor: pointer; font-size: .9rem; color: #6b7280; font-weight: 600; display: flex; align-items: center; gap: .4rem; border-radius: 8px; }
.qc-toggle:hover { background: #f3f4f6; color: #111827; }
.qc-toggle-icon { transition: transform .2s; display: inline-block; }
.qc-wrap.qc-expanded .qc-toggle-icon { transform: rotate(180deg); }
.qc-count { color: #9ca3af; font-weight: 500; }
.qc-body-pane { display: none; padding: .6rem 0 .3rem; }
.qc-wrap.qc-expanded .qc-body-pane { display: block; }

.qc-loading, .qc-error, .qc-empty { padding: 1rem; text-align: center; color: #6b7280; font-size: .88rem; }
.qc-error { color: #b91c1c; background: #fef2f2; border-radius: 8px; }

/* 編輯區 */
.qc-editor-wrap { background: #fafaf5; border: 1.5px solid #e5e7eb; border-radius: 10px; padding: .6rem; margin-top: 1rem; }
.qc-editor-header { font-weight: 700; color: #4b5563; font-size: .9rem; margin-bottom: .4rem; padding: 0 .2rem; display: flex; align-items: center; gap: .3rem; }
.qc-editor { min-height: 5rem; padding: .6rem .8rem; background: white; border: 1px solid #e5e7eb; border-radius: 6px; font-size: .9rem; line-height: 1.6; outline: none; }
.qc-editor:empty::before { content: attr(placeholder); color: #9ca3af; }
.qc-editor img { max-width: 100%; border-radius: 6px; margin: .3rem 0; }
.qc-editor h3 { font-size: 1.15rem; font-weight: 700; color: #6b21a8; margin: .5rem 0 .3rem; }
.qc-editor blockquote { border-left: 3px solid #fbbf24; background: #fef3c7; padding: .4rem .7rem; margin: .5rem 0; border-radius: 4px; color: #78350f; }
.qc-editor ul, .qc-editor ol { margin: .3rem 0 .3rem 1.5rem; }
.qc-editor a { color: #7c3aed; text-decoration: underline; }
.qc-editor[data-uploading="1"] { opacity: .5; pointer-events: none; }

.qc-editor-toolbar { display: flex; align-items: center; gap: .3rem; margin-bottom: .5rem; flex-wrap: wrap; padding: .3rem; background: #f9fafb; border-radius: 8px; }
.qc-editor-toolbar .qc-tb { background: white; border: 1px solid #d1d5db; border-radius: 5px; padding: .2rem .5rem; font-size: .85rem; cursor: pointer; color: #374151; min-width: 1.9rem; height: 1.9rem; display: inline-flex; align-items: center; justify-content: center; }
.qc-editor-toolbar .qc-tb:hover { background: #f3f4f6; border-color: #9ca3af; }
.qc-editor-toolbar .qc-tb:active { background: #e5e7eb; }
.qc-editor-toolbar .qc-sep { width: 1px; height: 1.3rem; background: #e5e7eb; margin: 0 .1rem; }
.qc-editor-toolbar .qc-size-sm { font-size: .7rem; }
.qc-editor-toolbar .qc-size-md { font-size: .9rem; }
.qc-editor-toolbar .qc-size-lg { font-size: 1.05rem; font-weight: 700; }

/* 顏色選單 popup */
.qc-color-menu { position: relative; display: inline-block; }
.qc-color-menu .qc-color-toggle { padding: .2rem .35rem; }
.qc-color-menu .qc-color-pop { display: none; position: absolute; top: calc(100% + 3px); left: 0; background: white; border: 1px solid #d1d5db; border-radius: 6px; padding: .3rem; box-shadow: 0 4px 12px rgba(0,0,0,.1); z-index: 100; gap: .25rem; flex-wrap: wrap; width: 8rem; }
.qc-color-menu.qc-open .qc-color-pop { display: flex; }
.qc-color-menu .qc-color-pop button { width: 1.4rem; height: 1.4rem; min-width: unset; padding: 0; border: 1px solid #d1d5db; border-radius: 3px; cursor: pointer; }
.qc-color-menu .qc-color-pop button:hover { transform: scale(1.15); border-color: #6b7280; }

.qc-editor-toolbar .qc-post-btn { background: #7c3aed; color: white; border-color: #7c3aed; font-weight: 700; padding: .35rem 1rem; margin-left: auto; min-width: 3.5rem; }
.qc-editor-toolbar .qc-post-btn:hover { background: #6d28d9; }
.qc-anon-toggle { font-size: .82rem; color: #6b7280; cursor: pointer; display: flex; align-items: center; gap: .3rem; padding: 0 .3rem; }

/* 留言列表 */
.qc-hidden-summary { padding: .4rem .8rem; background: #f9fafb; border-radius: 6px; font-size: .82rem; color: #6b7280; margin-bottom: .6rem; text-align: center; }
.qc-list { display: flex; flex-direction: column; gap: .6rem; }
.qc-item { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: .7rem .9rem; }
.qc-item[data-mine="1"] { border-color: #c4b5fd; background: #faf7ff; }
.qc-meta { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: #6b7280; margin-bottom: .35rem; flex-wrap: wrap; }
.qc-who { font-weight: 700; color: #7c3aed; }
.qc-who.qc-anon { color: #6b7280; font-weight: 600; }
.qc-mn-pill { display: inline-flex; align-items: center; gap: .25rem; background: #fdf2f8; color: #9d174d; border: 1px solid #f9a8d4; border-radius: 999px; padding: .12rem .6rem; font-size: .8rem; font-weight: 700; text-decoration: none !important; margin: .1rem 0; max-width: 100%; }
.qc-mn-pill:hover { background: #fce7f3; }
.qc-mine-tag { background: #ede9fe; color: #6d28d9; padding: .05rem .4rem; border-radius: 999px; font-size: .68rem; font-weight: 700; }
.qc-featured-tag { background: #fef3c7; color: #92400e; padding: .05rem .45rem; border-radius: 999px; font-size: .68rem; font-weight: 800; }
.qc-item.qc-featured { border-color: #f59e0b; background: linear-gradient(180deg, #fffbeb, #fff); }
.qc-feat-btn { border-color: #f59e0b !important; color: #b45309 !important; }
.qc-feat-btn.qc-featured-on { background: #f59e0b !important; color: #fff !important; }
.qc-vote:disabled { opacity: .5; cursor: not-allowed; }
.qc-edited-tag { color: #9ca3af; font-size: .72rem; }
.qc-body { font-size: .9rem; line-height: 1.65; color: #1f2937; word-break: break-word; }
.qc-body img { max-width: 100%; border-radius: 6px; margin: .4rem 0; cursor: pointer; }
.qc-body a { color: #7c3aed; text-decoration: underline; word-break: break-all; }
.qc-actions { display: flex; align-items: center; gap: .4rem; margin-top: .5rem; flex-wrap: wrap; }
.qc-vote { background: white; border: 1px solid #e5e7eb; border-radius: 999px; padding: .2rem .7rem; font-size: .78rem; cursor: pointer; color: #374151; }
.qc-vote:hover { background: #f3f4f6; }
.qc-vote.qc-active { background: #dbeafe; border-color: #93c5fd; color: #1e40af; }
.qc-vote.qc-active-neg { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }
.qc-btn-mini { background: transparent; border: none; color: #6b7280; font-size: .78rem; cursor: pointer; padding: .2rem .5rem; }
.qc-btn-mini:hover { color: #111827; background: #f3f4f6; border-radius: 4px; }
.qc-btn-mini.qc-del:hover { color: #b91c1c; }

.qc-item.qc-hidden { padding: .35rem .8rem; background: #fafafa; border-style: dashed; }
.qc-hidden-meta { font-size: .78rem; color: #9ca3af; display: flex; align-items: center; gap: .5rem; }

/* 珍藏按鈕 */
.qc-btn-mini.qc-bookmark { color: #a16207; }
.qc-btn-mini.qc-bookmark:hover { background: #fef3c7; color: #78350f; }
.qc-btn-mini.qc-bookmark.qc-bookmarked { color: #78350f; background: #fef3c7; font-weight: 700; }

/* 我的討論 Modal */
.qc-md-modal { display: none; position: fixed; inset: 0; z-index: 9999; }
.qc-md-modal.qc-md-open { display: flex; align-items: center; justify-content: center; }
.qc-md-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.qc-md-panel { position: relative; background: white; border-radius: 14px; width: 92%; max-width: 720px; max-height: 88vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.25); overflow: hidden; }
.qc-md-header { display: flex; align-items: center; padding: .8rem 1rem; border-bottom: 1px solid #e5e7eb; background: #fafafa; gap: .8rem; }
.qc-md-tabs { display: flex; gap: .3rem; flex: 1; }
.qc-md-tab { background: transparent; border: none; padding: .5rem .9rem; font-size: .92rem; cursor: pointer; color: #6b7280; border-radius: 8px; font-weight: 600; }
.qc-md-tab:hover { background: #f3f4f6; color: #111827; }
.qc-md-tab.qc-active { background: #ede9fe; color: #6d28d9; font-weight: 700; }
.qc-md-close { background: transparent; border: none; font-size: 1.3rem; cursor: pointer; color: #6b7280; padding: 0 .5rem; }
.qc-md-close:hover { color: #ef4444; }
.qc-md-body-pane { flex: 1; overflow-y: auto; padding: .8rem 1rem; display: flex; flex-direction: column; gap: .7rem; }
/* 科目群組 (v481) */
.qc-md-subj-group { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; margin-bottom: .3rem; }
.qc-md-subj-header { display: flex; align-items: center; gap: .5rem; padding: .55rem .8rem; background: #f9fafb; cursor: pointer; user-select: none; font-weight: 700; }
.qc-md-subj-header:hover { background: #f3f4f6; }
.qc-md-subj-name { flex: 1; font-size: .95rem; }
.qc-md-subj-count { background: white; padding: .1rem .55rem; border-radius: 999px; font-size: .75rem; font-weight: 700; color: #4b5563; }
.qc-md-subj-toggle { font-size: .8rem; transition: transform .2s; }
.qc-md-subj-group.qc-md-collapsed .qc-md-subj-toggle { transform: rotate(-90deg); }
.qc-md-subj-body { padding: .6rem .7rem; display: flex; flex-direction: column; gap: .5rem; background: white; }
.qc-md-subj-group.qc-md-collapsed .qc-md-subj-body { display: none; }
/* v493: 科目子分頁 (上方 tab) — 取代舊的垂直堆疊 */
.qc-md-subj-tabs { display: flex; gap: .35rem; padding: .55rem .8rem; border-bottom: 1px solid #e5e7eb; background: #fafafa; overflow-x: auto; -webkit-overflow-scrolling: touch; flex-shrink: 0; position: sticky; top: -.8rem; margin: -.8rem -1rem .6rem -1rem; z-index: 3; }
.qc-md-subj-tab { background: #fff; border: 1px solid #e5e7eb; border-radius: 999px; padding: .35rem .8rem; font-size: .84rem; cursor: pointer; white-space: nowrap; color: #4b5563; font-weight: 600; display: inline-flex; align-items: center; gap: .35rem; }
.qc-md-subj-tab:hover { background: #f3f4f6; color: #111827; }
.qc-md-subj-tab.qc-active { background: #7c3aed; border-color: #6d28d9; color: #fff; }
.qc-md-subj-tab-count { background: rgba(0,0,0,.08); padding: 0 .45rem; border-radius: 999px; font-size: .72rem; font-weight: 700; }
.qc-md-subj-tab.qc-active .qc-md-subj-tab-count { background: rgba(255,255,255,.25); }
.qc-md-subj-panes { display: flex; flex-direction: column; gap: .7rem; }
.qc-md-subj-pane { display: none; flex-direction: column; gap: .7rem; }
.qc-md-subj-pane.qc-active { display: flex; }

.qc-md-item { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: .7rem .9rem; }
.qc-md-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .3rem; flex-wrap: wrap; gap: .4rem; }
.qc-md-qtag { display: inline-block; background: #ede9fe; color: #5b21b6; padding: .15rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 700; cursor: pointer; }
.qc-md-qtag:hover { background: #ddd6fe; }
.qc-md-when { font-size: .75rem; color: #6b7280; }
.qc-md-who { font-size: .78rem; color: #7c3aed; font-weight: 700; margin-bottom: .3rem; }
.qc-md-body { font-size: .88rem; color: #1f2937; line-height: 1.6; }
.qc-md-body img { max-width: 100%; border-radius: 6px; }

@media (max-width: 640px) {
  .qc-editor-toolbar { gap: .3rem; }
  .qc-editor-toolbar button { padding: .25rem .5rem; font-size: .78rem; }
  .qc-item { padding: .6rem .7rem; }
  .qc-md-panel { width: 96%; max-height: 92vh; }
  .qc-md-tab { padding: .4rem .5rem; font-size: .85rem; }
}
`;
  function injectCss() {
    if (document.getElementById("qc-styles")) return;
    const s = document.createElement("style");
    s.id = "qc-styles";
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectCss);
  } else {
    injectCss();
  }

  // 點外面關閉顏色選單 popup
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".qc-color-menu")) {
      document
        .querySelectorAll(".qc-color-menu.qc-open")
        .forEach((el) => el.classList.remove("qc-open"));
    }
  });

  // 貼上圖片 (paste) handler — 掛在 document, 只處理 focus 在 qc-editor 內的 paste
  document.addEventListener("paste", async function (e) {
    const active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains("qc-editor"))
      return;
    const items = (e.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        const blob = it.getAsFile();
        if (!blob) continue;
        const qid = active.id.replace("qc-editor-", "");
        try {
          active.setAttribute("data-uploading", "1");
          const r = await handleImageUpload(blob, qid);
          active.removeAttribute("data-uploading");
          document.execCommand(
            "insertHTML",
            false,
            `<img src="${r.url}" alt="">`,
          );
        } catch (err) {
          active.removeAttribute("data-uploading");
          alert("圖片上傳失敗: " + err.message);
        }
        break;
      }
    }
  });

  _installMdHelpers();
  console.log("[QuestionComments] loaded v479");
})();
