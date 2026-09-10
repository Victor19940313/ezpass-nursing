// v609: 版本號直接寫死在這裡 (deploy.sh 會從 version.js 同步),不再 importScripts('./version.js')
//   原因:瀏覽器檢查 SW 更新時,importScripts 的檔案會走 HTTP 快取 (Cloudflare 給 4 小時),
//   拿到舊的 version.js 就會把「舊版」當成新版裝進來 → 使用者按更新 → 又檢查到新版 → 無限「立即更新」
const APP_VERSION = "v658";
self.APP_VERSION = APP_VERSION;
const SITE_ID = 'nursing'; // build.py 填入 (dental / nursing …)
const CACHE_NAME = SITE_ID + '-all-' + self.APP_VERSION + '-persist-isClassPractice-through-reload';
const PRECACHE = [
  './',
  './index.html',
  './mnemonics.html',
  './themes.css',
  './skin.css',
  './skin.js',
  './update.js',
  './tour.js',
  './topics.js',
  './subscription.js',
  './auth.js',
  './version.js',
  './site-config.js',
  './site.js',
  './sync.js',
  './exam/index.html',
  // './exam/questions-data.js' ← v554: 不 precache,由頁面第一次 fetch 放進快取 (避免 install + 頁面同時各抓 41 MB)
  './exam/compare.html',
  './exam/numbers.html',
  './exam/flashcards.html',
  './exam/duplicates.html',
];

// v609: 拒裝舊版 — 如果已經有更新的快取 (dental-all-vNNN, NNN 比我大) 代表這個 sw.js 是 CDN 給的舊檔,
//   直接讓 install 失敗,瀏覽器會保留現在的新版;之後再檢查時拿到正確檔就會正常裝
function verNum(str) { const m = new RegExp(SITE_ID + '-all-v(\\d+)').exec(str || ''); return m ? parseInt(m[1], 10) : 0; }
async function refuseIfStale() {
  const mine = parseInt((/^v(\d+)$/.exec(APP_VERSION) || [])[1] || '0', 10);
  const keys = await caches.keys();
  const newest = Math.max(0, ...keys.map(verNum));
  if (mine && newest > mine) throw new Error('SW stale: ' + APP_VERSION + ' < v' + newest + ' (refuse install)');
}

self.addEventListener('install', e => {
  // Precache individually — don't let one 404 block the whole install
  e.waitUntil(
    refuseIfStale().then(() => caches.open(CACHE_NAME)).then(cache =>
      Promise.all(PRECACHE.map(url =>
        cache.add(url).catch(() => console.warn('SW precache skip:', url))
      ))
    )
  );
  // v607: 不再自動 skipWaiting — 等使用者按「立即更新」(update.js 送 SKIP_WAITING) 或所有分頁關掉
});

// Allow pages to force-activate a waiting SW
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// v657: 題庫切成一科一檔 (q-ya3.js …)。版本換了就把「每一個」題庫檔從舊快取搬過來,
//   之後 fetch 各自用 ETag 背景確認 → 只有真的改過的那一科會重抓。
function isQuestionBank(url) {
  return /\/q-[a-z0-9]+\.js(\?|$)/.test(url) || url.includes('questions-data.js');
}
async function carryOverQuestionBank() {
  try {
    const keys = await caches.keys();
    const newCache = await caches.open(CACHE_NAME);
    const have = new Set((await newCache.keys()).filter(r => isQuestionBank(r.url)).map(r => r.url));
    for (const k of keys) {
      if (k === CACHE_NAME) continue;
      const old = await caches.open(k);
      for (const r of (await old.keys()).filter(x => isQuestionBank(x.url))) {
        if (have.has(r.url)) continue;
        const res = await old.match(r);
        if (res) { await newCache.put(r, res); have.add(r.url); }
      }
    }
  } catch (err) { console.warn('SW carryOver fail', err); }
}

self.addEventListener('activate', e => {
  e.waitUntil(
    carryOverQuestionBank().then(() => caches.keys()).then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() => {
      // 🛡 v308:新版啟動後通知所有開啟的分頁,讓他們秀「新版本已就緒」toast
      self.clients.matchAll({ includeUncontrolled: true }).then(cs => {
        cs.forEach(c => c.postMessage({ type: 'NEW_VERSION_READY', cache: CACHE_NAME }));
      });
    })
  );
});

// Data files that update frequently → network first, fall back to cache
const NETWORK_FIRST = [
];

function isDataFile(url) {
  return NETWORK_FIRST.some(f => url.includes(f));
}

self.addEventListener('fetch', e => {
  // 只處理 http/https,跳過 chrome-extension:// / file:// 等不支援 cache 的 scheme
  if (!e.request.url.startsWith('http')) return;
  if (e.request.url.includes('supabase')) return;
  if (e.request.url.includes('firebase') || e.request.url.includes('firebaseio')) return;
  // v618: AI API (Gemini / GitHub 圖床 等 POST) 一律不經過 SW — 以前 POST 也被 stale-while-revalidate 包住,
  //       網路一斷 catch 會回 index.html 給 Gemini 呼叫 → 「AI 回傳格式無法解析」;而且多一層轉手
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('generativelanguage.googleapis.com') ||
      e.request.url.includes('api.github.com') ||
      e.request.url.includes('workers.dev')) return;
  // 第三方 CDN(TipTap ESM、gstatic 等)直接交給瀏覽器,不過 SW
  // 否則 fetch 失敗時 fallback 到 index.html 會回 HTML,導致 ESM 模組載入失敗
  if (e.request.url.includes('esm.sh') ||
      e.request.url.includes('unpkg.com') ||
      e.request.url.includes('cdn.jsdelivr.net') ||
      e.request.url.includes('gstatic.com')) return;
  // v318:口訣區從 GitHub 拉資料,SW 不要攔(避免快取出髒資料,Safari Tahoe ITP 也可能讓快取錯亂)
  if (e.request.url.includes('raw.githubusercontent.com') ||
      e.request.url.includes('api.github.com')) return;

  // v553: 41 MB 題庫改 cache-first — 有快取就直接回,不再每次開頁重抓 (萬人審計 #1)
  //        新版本 = 新 CACHE_NAME,install 時會重新 precache,所以更新還是會拿到
  if (isQuestionBank(e.request.url)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) {
          // v554: 有快取立刻回;背景用 ETag 問伺服器有沒有變 (沒變回 304 = 幾乎零流量;變了才換)
          const etag = cached.headers.get('etag');
          const headers = etag ? { 'If-None-Match': etag } : {};
          fetch(e.request, { headers, cache: 'no-cache' }).then(res => {
            if (res.status === 200 && res.ok) {
              caches.open(CACHE_NAME).then(cache => cache.put(e.request, res));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  if (isDataFile(e.request.url)) {
    // Network first for data files (題庫、各科 data 要拿最新)
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // 🚀 v308:靜態檔(HTML / CSS / JS) 改用 stale-while-revalidate
  //         立刻回 cache → 同時背景拉新版更新 cache → 下次更新
  //         好處:第二次以後打開幾乎瞬間;網路慢也不會卡
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || caches.match('./index.html'));
      // 有 cache 就立刻回(fast path),沒 cache 才等網路
      return cached || fetchPromise;
    })
  );
});
