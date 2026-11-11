// 極速通勤 Service Worker：介面檔一律先走網路（略過 HTTP 快取），離線才用快取；即時資料不攔截
// build 2.47.2b
const VERSION = "jisu-v2.49.24";
const SHELL = [
  "./", "./index.html", "./data.js", "./busdirect.js", "./config.js", "./manifest.webmanifest",
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
  const nav = req.mode === "navigate";
  const targetReq = nav ? "./index.html" : req;

  // v2.49.24 開機加速：網路超過 2.5 秒沒回應就先用快取（網路之後回來仍更新快取）
  e.respondWith((async () => {
    let timer;
    let putDone = Promise.resolve();
    const netPromise = fetch(targetReq, { cache: "no-store" }).then(res => {
      if (res.ok) {
        const copy = res.clone();
        putDone = caches.open(VERSION).then(c => c.put(targetReq, copy)).catch(() => {});
      }
      return res;
    });
    e.waitUntil(netPromise.then(() => putDone, () => {}));   // Opus：先回快取後，網路回來仍會寫進快取

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("SW_TIMEOUT")), 2500);
    });

    try {
      const res = await Promise.race([netPromise, timeoutPromise]);
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const cached = await caches.match(targetReq, { ignoreSearch: true });
      if (cached) return cached;
      if (nav) {
        const indexCached = await caches.match("./index.html");
        if (indexCached) return indexCached;
      }
      // 快取也沒有，等網路返回（或拋錯）
      return await netPromise;
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
