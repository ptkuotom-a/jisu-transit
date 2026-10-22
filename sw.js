// 極速通勤 Service Worker：介面檔一律先走網路（略過 HTTP 快取），離線才用快取；即時資料不攔截
const VERSION = "jisu-v2.40.0";
const SHELL = [
  "./", "./index.html", "./data.js", "./config.js", "./manifest.webmanifest",
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
  const nav = req.mode === "navigate";
  e.respondWith(
    fetch(nav ? "./index.html" : req, { cache: "no-store" })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(nav ? "./index.html" : req, copy)); }
        return res;
      })
      .catch(() => caches.match(nav ? "./index.html" : req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
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
