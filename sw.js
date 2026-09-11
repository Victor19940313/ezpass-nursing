// 護理師站已經搬到 ezpass-exam.com/nursing/ (2026-09-11 一站式改版)。
// 這支 Service Worker 的唯一任務:把自己和舊快取全部清掉,讓已經裝過的裝置
// 不會被離線快取困在舊站。清完會叫所有分頁重新整理 → 吃到新的轉址頁。
self.addEventListener("install", function (e) {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(
    (async function () {
      try {
        const names = await caches.keys();
        await Promise.all(names.map(function (n) { return caches.delete(n); }));
      } catch (err) {}
      try { await self.registration.unregister(); } catch (err) {}
      const cs = await self.clients.matchAll({ type: "window" });
      cs.forEach(function (c) { try { c.navigate(c.url); } catch (err) {} });
    })()
  );
});
// 不攔任何請求,一律走網路
