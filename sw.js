// 極速通勤 Service Worker：快取優先（同源 GET 有快取直回，換版靠 VERSION）；即時資料不攔截
// build 2.50.0
const VERSION = "jisu-v2.50.1";
const SHELL = [
  "./", "./index.html", "./data.js", "./busdirect.js", "./s2stime.js", "./config.js", "./manifest.webmanifest",
  "./data/pda-thb-map.json",
  "./icons/logo.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  ...["01_emu500","02_emu3000","03_e500","04_hsr_700t","05_taroko","06_emu900","07_puyuma"].map(n => `./icons/train/${n}.svg`),
];

self.addEventListener("install", e => {
  // cache:"reload" 避免把 GitHub Pages 的 HTTP 快取（max-age=600）舊檔存進新版快取
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data === "version" && e.source) e.source.postMessage({ version: VERSION });
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return; // TDX 等外部請求不攔截
  if (url.pathname.endsWith("/sw.js")) return; // sw.js 本身不攔截

  const nav = req.mode === "navigate";
  const targetReq = nav ? "./index.html" : req;

  // v2.49.26：快取優先（同源 GET 快取有就直接回，不等網路；快取沒有才走網路並存進快取）
  e.respondWith((async () => {
    const cached = nav
      ? (await caches.match("./index.html"))
      : (await caches.match(targetReq, { ignoreSearch: true }));
    if (cached) return cached;

    try {
      const res = await fetch(targetReq, { cache: "no-store" });
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(VERSION).then(c => c.put(targetReq, copy)).catch(() => {}));   // Opus：等快取寫完，SW 才不會先被停掉
      }
      return res;
    } catch (err) {
      if (nav) {
        const indexCached = await caches.match("./index.html");
        if (indexCached) return indexCached;
      }
      throw err;
    }
  })());
});

// ---------- 推播（下車提醒） ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "極速通勤", {
    body: d.body || "下車提醒", tag: d.tag || "jisu", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: d.url || "./" },
  }));
});

// v2.30.0：通知帶 ?station=系統:代碼（Siri 捷徑）→ App 已開著就切到前景並請它打開車站頁；沒開就用深層連結開啟
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope);
  const station = target.searchParams.get("station");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c) {
      const w = await c.focus().catch(() => c) || c;
      if (station) w.postMessage({ type: "openStation", station });
      return w;
    }
    return self.clients.openWindow(target.href);
  }));
});
