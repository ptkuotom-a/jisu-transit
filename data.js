// 極速通勤 PWA — TDX 資料層（公車 + YouBike）
// 所有 TDX 請求都經過自己的 Cloudflare Worker 代理，金鑰只存在 Worker 的 Secrets。
(() => {
const BASE = "https://tdx.transportdata.tw/api";
const RAIL_KEY = "jisu_rail_stations", EXIT_KEY = "jisu_rail_exits", PROXY_KEY = "jisu_proxy", STATE_KEY = "jisu_state", DEST_KEY = "jisu_route_dest";
const enc = encodeURIComponent;

const UID_CITY = {
  TPE: "Taipei", NWT: "NewTaipei", KEE: "Keelung", TAO: "Taoyuan",
  HSZ: "Hsinchu", HSQ: "HsinchuCounty", MIA: "MiaoliCounty",
  TXG: "Taichung", CHA: "ChanghuaCounty", NAN: "NantouCounty",
  YUN: "YunlinCounty", CYI: "Chiayi", CYQ: "ChiayiCounty",
  TNN: "Tainan", KHH: "Kaohsiung", PIF: "PingtungCounty",
  ILA: "YilanCounty", HUA: "HualienCounty", TTT: "TaitungCounty",
  PEN: "PenghuCounty", KIN: "KinmenCounty", LIE: "LienchiangCounty",
};
const BIKE_TYPE = { 1: "YouBike 1.0", 2: "YouBike 2.0", 3: "T-Bike", 4: "P-Bike", 5: "K-Bike" };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 代理伺服器（金鑰放在 Cloudflare Worker，前端不碰金鑰） ----------
const TDX_ORIGIN = "https://tdx.transportdata.tw";
function getProxy() {
  const saved = localStorage.getItem(PROXY_KEY);
  const url = (saved || (window.JISU_CONFIG && window.JISU_CONFIG.proxy) || "").trim();
  return /^https:\/\//.test(url) && !url.includes("YOUR-SUBDOMAIN") ? url.replace(/\/+$/, "") : "";
}

const r_ok = c => c >= 200 && c < 300;

// ---------- GET（經代理；429稍等重試） ----------
// profile "main" 用第一組金鑰，"route" 用第二組，"rail"（軌道）用第三組（Worker 端沒設會退回第一組）
// 遇到429時 Worker 會先換另一組金鑰重試；仍然限流就丟出 RATE_MSG
const RATE_MSG = "查詢太頻繁，請稍後再試";
const isRate = e => !!(e && (e.rate || String(e.message || e).includes(RATE_MSG)));
async function tdx(profile, url) {
  const proxy = getProxy();
  if (!proxy) throw new Error("NO_PROXY");
  const target = proxy + url.slice(TDX_ORIGIN.length) + "&__k=" + (profile === "rail" ? 3 : profile === "route" ? 2 : 1);
  let last = "";
  for (let i = 0; i < 3; i++) {
    let code = 0, res;
    try {
      const r = await fetch(target);
      code = r.status; res = await r.json();
    } catch (e) { res = { message: String(e) }; }
    if (Array.isArray(res)) return res;
    if (res && typeof res === "object" && r_ok(code) && !res.message && !res.Message) {
      const arr = Object.values(res).find(Array.isArray);   // v3 API 回傳 {Stations:[...]}這類容器
      if (arr) return arr;
    }
    last = `(${code}) ` + JSON.stringify(res).slice(0, 120);
    if (code === 429 || code === 0 || code >= 500) { await sleep(1000 + i * 800); continue; }
    break;
  }
  if (last.startsWith("(429)")) { const e = new Error(RATE_MSG); e.rate = true; throw e; }
  throw new Error("資料讀取失敗 " + last);
}

// ---------- 工具 ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, t = d => d * Math.PI / 180;
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
const nearbyQ = (lat, lon, r) => "?%24spatialFilter=" + enc(`nearby(${lat},${lon},${r})`);
function routeKind(uid) {
  const code = (uid || "").slice(0, 3);
  if (code === "THB") return { kind: "intercity", path: "InterCity" };
  const city = UID_CITY[code];
  return city ? { kind: "city", city, path: `City/${city}` } : null;
}
const clampR = r => Math.max(100, Math.min(1000, Number(r) || 300));

// ---------- 定位 ----------
let lastLoc = null;
function getPos(high, timeout) {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej,
    { enableHighAccuracy: high, timeout, maximumAge: high ? 10000 : 30000 }));
}
async function locate() {
  if (!navigator.geolocation) { if (lastLoc) return lastLoc; throw new Error("這個瀏覽器不支援定位"); }
  let p;
  try { p = await getPos(true, 7000); }                 // 先用 GPS 精確定位
  catch (e) {
    if (e && e.code === 1) { if (lastLoc) return lastLoc; throw new Error("沒有定位權限：到 iPhone 設定 › 隱私權與安全性 › 定位服務 › Safari 網站，改成「使用 App 期間」並開啟「精確位置」"); }
    try { p = await getPos(false, 10000); }              // 室內收不到 GPS 時退回快速定位
    catch (e2) { if (lastLoc) return lastLoc; throw new Error("無法取得定位，請稍後再試"); }
  }
  lastLoc = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) };
  return lastLoc;
}

// ---------- 終點站快取（沿用原腳本格式） ----------
function readDestCache() {
  try { const c = JSON.parse(localStorage.getItem(DEST_KEY)); if (c && c.routes) return c; } catch (e) {}
  return { routes: {} };
}
// 永久保存（v2.12.6）；沒有的先從已下載的全台路線清單（busidx）找，找不到才查 TDX
async function loadRouteDest(profile, uids) {
  const cache = readDestCache(), now = Date.now();
  let missing = [...new Set(uids)].filter(u => u && !cache.routes[u]);
  if (missing.length) {
    try {
      const idx = idxMem || await IDB.get("busidx");
      if (idx && idx.cities) missing = missing.filter(u => {
        const k = routeKind(u), l = k && idx.cities[k.kind === "intercity" ? "InterCity" : k.city];
        const r = l && l.find(x => x[0] === u);
        if (r) cache.routes[u] = { time: now, dep: r[2] || null, dest: r[3] || null };
        return !r;
      });
    } catch (e) {}
  }
  if (missing.length) {
    const groups = {};
    for (const u of missing) { const k = routeKind(u); if (k) (groups[k.path] = groups[k.path] || []).push(u); }
    for (const [path, list] of Object.entries(groups)) {
      for (let i = 0; i < list.length; i += 20) {
        const chunk = list.slice(i, i + 20);
        const url = `${BASE}/basic/v2/Bus/Route/${path}?%24select=${enc("RouteUID,DepartureStopNameZh,DestinationStopNameZh")}` +
          `&%24filter=${enc(chunk.map(u => `RouteUID eq '${u}'`).join(" or "))}&%24top=100&%24format=JSON`;
        try {
          for (const r of await tdx(profile, url)) {
            if (r.RouteUID) cache.routes[r.RouteUID] = { time: now, dep: r.DepartureStopNameZh || null, dest: r.DestinationStopNameZh || null };
          }
        } catch (e) {}
      }
    }
  }
  if (uids.some(u => u && cache.routes[u] && cache.routes[u].time === now)) { try { localStorage.setItem(DEST_KEY, JSON.stringify(cache)); } catch (e) {} }
  return cache.routes;
}
const destOf = (uid, dirNum, map) => { const r = map[uid]; return r ? (dirNum === 1 ? r.dep : r.dest) || null : null; };

// ---------- 省額度：短期記憶、永久的站牌／站點／站序快取 ----------
// memoTdx：同一網址在 ms 毫秒內重用上次結果（YouBike 車位90秒、高鐵座位60秒）
const memoMap = new Map();
async function memoTdx(profile, url, ms) {
  const h = memoMap.get(url); if (h && Date.now() - h.t < ms) return h.v;
  const v = await tdx(profile, url); memoMap.set(url, { t: Date.now(), v });
  if (memoMap.size > 60) memoMap.delete(memoMap.keys().next().value);
  return v;
}
// ---------- 大型快取：IndexedDB（v2.12.4起；不設筆數上限，只有空間真的滿了才刪最久沒用的） ----------
// kv：geo|格子、sor|路線、place|縣市、busidx；meta：每筆的最近使用時間 u 與大約大小 n（淘汰時只讀 meta，不讀大資料）
// 小東西（設定、收藏、登入、Worker 網址）仍在 localStorage
const DAY_MS = 86400000;
const FRESH = "&__fresh=1";   // 請 Worker 略過共用快取重抓（Worker 端同一網址每天最多一次）
const IDB = (() => {
  const mem = new Map(); let dbp = null;
  const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("abort")); });
  const isQuota = e => e && (e.name === "QuotaExceededError" || /quota/i.test(String(e.message || e)));
  const sizeOf = v => { try { return JSON.stringify(v).length; } catch (e) { return 0; } };
  async function migrate(db) {   // 舊版存在 localStorage 的大型快取搬過來一次，搬完刪掉
    if (localStorage.getItem("jisu_idb_mig") === "1") return;
    const jobs = [];
    const take = (lsKey, toRecs) => { try { const v = JSON.parse(localStorage.getItem(lsKey)); if (v) jobs.push([lsKey, toRecs(v)]); } catch (e) {} };
    take("jisu_geo", c => Object.entries(c).map(([k, e]) => ["geo|" + k, { t: e.t, d: e.d }, e.u || e.t]));
    take("jisu_sor", c => Object.entries(c).map(([k, e]) => ["sor|" + k, { t: e.t, d: e.d }, e.u || e.t]));
    take("jisu_bus_idx", c => [["busidx", c, c.time]]);
    for (const k of Object.keys(localStorage)) if (k.startsWith("jisu_place_")) take(k, c => [["place|" + k.slice(11), c, c.u || c.t]]);
    for (const [lsKey, recs] of jobs) {
      try {
        const t = db.transaction(["kv", "meta"], "readwrite");
        for (const [k, v, u] of recs) { t.objectStore("kv").put(v, k); t.objectStore("meta").put({ u: u || Date.now(), n: sizeOf(v) }, k); }
        await done(t); localStorage.removeItem(lsKey);
      } catch (e) {}
    }
    if (!Object.keys(localStorage).some(k => k === "jisu_geo" || k === "jisu_sor" || k === "jisu_bus_idx" || k.startsWith("jisu_place_"))) localStorage.setItem("jisu_idb_mig", "1");
  }
  const open = () => dbp || (dbp = new Promise(res => {
    try {
      if (!self.indexedDB) return res(null);
      const r = indexedDB.open("jisu", 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv"); if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta"); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch (e) { res(null); }
  }).then(async db => {
    if (db) { await migrate(db).catch(() => {}); try { navigator.storage && navigator.storage.persist && navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {}); } catch (e) {} }
    return db;
  }));
  async function evict(keep, need) {   // 空間滿了：從最久沒用的開始刪，至少騰出 need 的兩倍（最少刪5筆）
    const db = await open(); if (!db) return 0;
    const t = db.transaction(["meta"], "readonly"), st = t.objectStore("meta");
    const [keys, vals] = await Promise.all([rq(st.getAllKeys()), rq(st.getAll())]);
    const list = keys.map((k, i) => ({ k, u: (vals[i] || {}).u || 0, n: (vals[i] || {}).n || 0 })).filter(x => x.k !== keep).sort((a, b) => a.u - b.u);
    let freed = 0, cnt = 0; const del = [];
    for (const x of list) { if (cnt >= 5 && freed >= need * 2) break; del.push(x.k); freed += x.n; cnt++; }
    if (!del.length) return 0;
    const t2 = db.transaction(["kv", "meta"], "readwrite");
    for (const k of del) { t2.objectStore("kv").delete(k); t2.objectStore("meta").delete(k); }
    await done(t2); return del.length;
  }
  return {
    async get(k) {
      const db = await open(); if (!db) return mem.get(k) || null;
      try {
        const t = db.transaction(["kv", "meta"], "readonly");
        const [v, m] = await Promise.all([rq(t.objectStore("kv").get(k)), rq(t.objectStore("meta").get(k))]);
        if (v != null && (!m || Date.now() - (m.u || 0) > DAY_MS)) {   // 最近使用時間每天最多記一次
          try { const t2 = db.transaction(["meta"], "readwrite"); t2.objectStore("meta").put({ u: Date.now(), n: (m && m.n) || sizeOf(v) }, k); } catch (e) {}
        }
        return v == null ? null : v;
      } catch (e) { return mem.get(k) || null; }
    },
    async set(k, v) {
      const db = await open(); if (!db) { mem.set(k, v); return; }
      const n = sizeOf(v);
      for (let i = 0; i < 4; i++) {
        try {
          const t = db.transaction(["kv", "meta"], "readwrite");
          t.objectStore("kv").put(v, k); t.objectStore("meta").put({ u: Date.now(), n }, k);
          await done(t); return;
        } catch (e) {
          if (!isQuota(e) || !(await evict(k, n).catch(() => 0))) { mem.set(k, v); return; }
        }
      }
      mem.set(k, v);
    },
    open,
  };
})();
IDB.open();
const stopPack = s => [s.StopUID || "", (s.StopName && s.StopName.Zh_tw) || "", s.StopPosition ? s.StopPosition.PositionLat : null, s.StopPosition ? s.StopPosition.PositionLon : null, s.StationID || "", s.Bearing || ""];
const stopUnpack = a => ({ StopUID: a[0] || null, StopName: { Zh_tw: a[1] }, StopPosition: a[2] == null ? null : { PositionLat: a[2], PositionLon: a[3] }, StationID: a[4] || null, Bearing: a[5] || null });
const bikePack = s => [s.StationUID, (s.StationName && s.StationName.Zh_tw) || "", (s.StationAddress && s.StationAddress.Zh_tw) || "", s.BikesCapacity ?? null, s.ServiceType ?? null, s.StationPosition ? s.StationPosition.PositionLat : null, s.StationPosition ? s.StationPosition.PositionLon : null];
const bikeUnpack = a => ({ StationUID: a[0], StationName: { Zh_tw: a[1] }, StationAddress: { Zh_tw: a[2] || null }, BikesCapacity: a[3], ServiceType: a[4], StationPosition: a[5] == null ? null : { PositionLat: a[5], PositionLon: a[6] } });
// 取得格子裡的靜態清單；即時資料出現清單裡沒有的代號、且快取超過一天，就重抓一次（站牌異動時自動修正）
async function geoList(kind, key, url, profile, pack, unpack, liveUIDs) {
  const c = await IDB.get("geo|" + key);
  const fresh = async heal => { const l = await tdx(profile, url + (heal ? FRESH : "")); IDB.set("geo|" + key, { t: Date.now(), d: l.map(pack) }).catch(() => {}); return l; };
  if (!c) return fresh(false);
  const list = c.d.map(unpack);
  if (liveUIDs && Date.now() - c.t > DAY_MS) {
    const have = new Set(list.map(x => x.StopUID || x.StationUID));
    if ((await liveUIDs).some(u => u && !have.has(u))) return fresh(true).catch(() => list);
  }
  return list;
}

// ---------- 附近：公車 + YouBike + 收藏 ----------
const BEAR_TXT = { N: "向北", S: "向南", E: "向東", W: "向西", NE: "向東北", NW: "向西北", SE: "向東南", SW: "向西南" };
async function nearby({ settings = {}, favs = { bus: [], bike: [] } }) {
  const loc = await locate();
  // 查詢座標取到小數第3位（約100公尺格子），半徑多加100公尺補足，之後再用實際位置過濾 → 同一格的請求可共用快取
  const lat = loc.latitude.toFixed(3), lon = loc.longitude.toFixed(3);
  const busR = clampR(settings.busR || 300), bikeR = clampR(settings.bikeR || 500);
  const qBus = Math.min(busR + 100, 1000), qStop = Math.min(busR + 200, 1000), qBike = Math.min(bikeR + 100, 1000);

  const etaP = tdx("main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat, lon, qBus)}&%24top=600&%24format=JSON`);
  const busP = Promise.all([etaP, geoList("stop", `s|${lat},${lon},${qStop}`, `${BASE}/advanced/v2/Bus/Stop/NearBy${nearbyQ(lat, lon, qStop)}&%24top=600&%24format=JSON`,
    "main", stopPack, stopUnpack, etaP.then(l => l.map(e => e.StopUID)).catch(() => []))]);
  const avP = memoTdx("route", `${BASE}/advanced/v2/Bike/Availability/NearBy${nearbyQ(lat, lon, qBike)}&%24top=200&%24format=JSON`, 90000);
  const bikeP = Promise.all([geoList("bike", `b|${lat},${lon},${qBike}`, `${BASE}/advanced/v2/Bike/Station/NearBy${nearbyQ(lat, lon, qBike)}&%24top=200&%24format=JSON`,
    "route", bikePack, bikeUnpack, avP.then(l => l.map(a => a.StationUID)).catch(() => [])), avP]);
  const favP = liveFavs(favs).catch(() => ({ bus: {}, bike: {} }));
  const railP = Promise.all([loadRailStations(), loadRailExits().catch(() => ({}))])
    .then(([st, ex]) => nearestRail(st, loc.latitude, loc.longitude,
      { walkKm: settings.railWalk || 1.5, systems: settings.railSys || null, far: settings.railFar !== 0 }, ex));

  const [busR_, bikeR_, favLive, railR_] = await Promise.allSettled([busP, bikeP, favP, railP]);
  if (busR_.status === "rejected" && bikeR_.status === "rejected") throw busR_.reason;
  try {   // 全市搜尋名單的自動補救（只比對、不額外呼叫；發現新站才重抓）
    placeHeal(busR_.status === "fulfilled" ? busR_.value[0].map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw })) : [],
      bikeR_.status === "fulfilled" ? bikeR_.value[1].map(a => a.StationUID) : []);
    if (busR_.status === "fulfilled") busHeal(busR_.value[0].map(e => e.RouteUID));          // 全台路線清單沒有的 RouteUID
    if (railR_.status === "fulfilled") exitHeal(railR_.value);                               // 附近捷運站沒有出口資料
  } catch (e) {}

  // 公車：依站名分組
  let busStops = [];
  if (busR_.status === "fulfilled") {
    const [eta, stops] = busR_.value;
    const byUID = {}, byName = {};
    for (const s of stops) {
      const p = s.StopPosition; if (!p) continue;
      const d = haversine(loc.latitude, loc.longitude, p.PositionLat, p.PositionLon);
      const v = { d, lat: p.PositionLat, lon: p.PositionLon, sid: s.StationID || null, bear: s.Bearing || null };
      if (s.StopUID && (!byUID[s.StopUID] || d < byUID[s.StopUID].d)) byUID[s.StopUID] = v;
      const n = s.StopName && s.StopName.Zh_tw;
      if (n && (!byName[n] || d < byName[n].d)) byName[n] = v;
    }
    // 同名站牌依實際位置分開（相距 > 20公尺視為不同站牌），之後依距離標「同向／對向」
    const groups = {}, list = [];
    for (const it of eta) {
      const name = (it.StopName && it.StopName.Zh_tw) || "未知站牌";
      const pos = byUID[it.StopUID] || byName[name] || null;
      if (pos && pos.d > busR) continue;                    // 查詢範圍比設定大一點，超出設定距離的不列
      const arr = groups[name] = groups[name] || [];
      // 同一 StationID 一定同一站；不同 StationID 只有在20公尺內且行車方位（Bearing）相同時才合併（兩側站牌可能只差10公尺）
      const same = x => x.lat !== null && ((pos.sid && x.sids.has(pos.sid)) ||
        (haversine(x.lat, x.lon, pos.lat, pos.lon) <= 20 && (!pos.bear || !x.bear || x.bear === pos.bear)));
      let g = pos ? arr.find(same) : arr.find(x => x.lat === null);
      if (g && pos && pos.sid) g.sids.add(pos.sid);
      if (!g) {
        g = { name, dist: pos ? pos.d : null, lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, bear: pos ? pos.bear : null, sids: new Set(pos && pos.sid ? [pos.sid] : []), routes: {} };
        arr.push(g); list.push(g);
      } else if (pos && pos.d < g.dist) { g.dist = pos.d; g.lat = pos.lat; g.lon = pos.lon; }
      const dirNum = it.Direction === 1 ? 1 : 0;
      const sec = typeof it.EstimateTime === "number" ? it.EstimateTime : null;
      const r = {
        route: (it.RouteName && it.RouteName.Zh_tw) || "?", routeUID: it.RouteUID || null, dirNum,
        stopUID: it.StopUID || null, sec, status: it.StopStatus ?? 0, next: it.NextBusTime || null,
      };
      const key = `${r.routeUID}|${dirNum}`;
      const old = g.routes[key];
      if (!old || (sec !== null && (old.sec === null || sec < old.sec))) g.routes[key] = r;
    }
    let destMap = {};
    try { destMap = await loadRouteDest("main", eta.map(e => e.RouteUID)); } catch (e) {}
    for (const arr of Object.values(groups)) {
      const located = arr.filter(g => g.dist !== null);   // 沒有座標的不標同向／對向
      if (located.length < 2) continue;
      located.sort((a, b) => a.dist - b.dist);
      located.forEach((g, i) => { g.side = i === 0 ? "同向" : "對向"; });
    }
    busStops = list.map(g => {
      const routes = Object.values(g.routes);
      for (const r of routes) r.dest = destOf(r.routeUID, r.dirNum, destMap);
      const { sids, ...rest } = g;
      return { ...rest, bearTxt: BEAR_TXT[g.bear] || null, routes };
    }).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  }

  // YouBike
  let bikes = [], bikeError = null;
  if (bikeR_.status === "fulfilled") {
    const [st, av] = bikeR_.value;
    const am = {}; for (const a of av) if (a.StationUID) am[a.StationUID] = a;
    for (const s of st) {
      const p = s.StationPosition; if (!p) continue;
      if (haversine(loc.latitude, loc.longitude, p.PositionLat, p.PositionLon) > bikeR) continue;
      const a = am[s.StationUID] || {};
      const det = a.AvailableRentBikesDetail || null;
      bikes.push({
        uid: s.StationUID,
        name: ((s.StationName && s.StationName.Zh_tw) || "未知站點").replace(/^YouBike[12]\.0_/, ""),
        address: (s.StationAddress && s.StationAddress.Zh_tw) || null,
        capacity: s.BikesCapacity ?? null, type: BIKE_TYPE[s.ServiceType] || null,
        dist: haversine(loc.latitude, loc.longitude, p.PositionLat, p.PositionLon),
        lat: p.PositionLat, lon: p.PositionLon,
        rent: typeof a.AvailableRentBikes === "number" ? a.AvailableRentBikes : null,
        ret: typeof a.AvailableReturnBikes === "number" ? a.AvailableReturnBikes : null,
        general: det ? det.GeneralBikes ?? null : null, electric: det ? det.ElectricBikes ?? null : null,
        status: typeof a.ServiceStatus === "number" ? a.ServiceStatus : null,
        update: a.SrcUpdateTime || a.UpdateTime || null,
      });
    }
    bikes.sort((x, y) => x.dist - y.dist);
  } else bikeError = String(bikeR_.reason && bikeR_.reason.message || bikeR_.reason).slice(0, 120);

  return {
    lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy || null, busStops, bikes, bikeError,
    rail: railR_.status === "fulfilled" ? railR_.value : [],
    railError: railR_.status === "rejected" ? String(railR_.reason.message || railR_.reason).slice(0, 120) : null,
    busError: busR_.status === "rejected" ? String(busR_.reason.message || busR_.reason).slice(0, 120) : null,
    favs: favLive.status === "fulfilled" ? favLive.value : { bus: {}, bike: {} },
  };
}

// ---------- 收藏的即時資料（不受目前位置限制） ----------
async function liveFavs(favs) {
  const out = { bus: {}, bike: {} };
  const jobs = [];
  // 公車：依城市分組，用 $filter 一次查多筆
  const bg = {};
  for (const f of (favs.bus || []).slice(0, 30)) { const k = routeKind(f.routeUID); if (k) (bg[k.path] = bg[k.path] || []).push(f); }
  for (const [path, list] of Object.entries(bg)) {
    for (let i = 0; i < list.length; i += 10) {
      const chunk = list.slice(i, i + 10);
      const filter = chunk.map(f => `(RouteUID eq '${f.routeUID}' and StopUID eq '${f.stopUID}' and Direction eq ${f.dirNum})`).join(" or ");
      jobs.push(tdx("main", `${BASE}/basic/v2/Bus/EstimatedTimeOfArrival/${path}?%24filter=${enc(filter)}&%24top=100&%24format=JSON`).then(list => {
        for (const t of list) {
          const key = `${t.RouteUID}|${t.Direction === 1 ? 1 : 0}|${t.StopUID}`;
          const sec = typeof t.EstimateTime === "number" ? t.EstimateTime : null;
          const old = out.bus[key];
          if (!old || (sec !== null && (old.sec === null || sec < old.sec))) out.bus[key] = { sec, status: t.StopStatus ?? 0, next: t.NextBusTime || null };
        }
      }).catch(() => {}));
    }
  }
  // YouBike：依城市分組
  const kg = {};
  for (const f of (favs.bike || []).slice(0, 30)) { const c = UID_CITY[(f.uid || "").slice(0, 3)]; if (c) (kg[c] = kg[c] || []).push(f.uid); }
  for (const [city, uids] of Object.entries(kg)) {
    const filter = uids.map(u => `StationUID eq '${u}'`).join(" or ");
    jobs.push(memoTdx("route", `${BASE}/basic/v2/Bike/Availability/City/${city}?%24filter=${enc(filter)}&%24top=50&%24format=JSON`, 90000).then(list => {
      try { placeHeal([], list.map(a => a.StationUID)); } catch (e) {}
      for (const a of list) {
        const det = a.AvailableRentBikesDetail || null;
        out.bike[a.StationUID] = {
          rent: a.AvailableRentBikes ?? null, ret: a.AvailableReturnBikes ?? null,
          general: det ? det.GeneralBikes ?? null : null, electric: det ? det.ElectricBikes ?? null : null,
          status: typeof a.ServiceStatus === "number" ? a.ServiceStatus : null, update: a.SrcUpdateTime || null,
        };
      }
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  return out;
}

// ---------- 路線頁：沿途站牌 + 預估 + 公車位置 ----------
const sorPack = l => l.map(r => ({ RouteUID: r.RouteUID, Direction: r.Direction, Stops: (r.Stops || []).map(x => ({ StopUID: x.StopUID, StopName: { Zh_tw: x.StopName && x.StopName.Zh_tw }, StopSequence: x.StopSequence, ...(x.StopPosition && x.StopPosition.PositionLat ? { P: [+x.StopPosition.PositionLat.toFixed(5), +x.StopPosition.PositionLon.toFixed(5)] } : {}) })) }));
async function routeView({ routeUID, route, dirNum = 0, stopUID, stopName }) {
  const k = routeKind(routeUID);
  if (!k) throw new Error("缺少路線識別資訊");
  const name = enc(route);
  const u = api => `${BASE}/basic/v2/Bus/${api}/${k.path}/${name}?%24top=600&%24format=JSON`;
  // 站序永久保存（IndexedDB sor|路線）；預估資料出現站序裡沒有的站、且快取超過一天，或找不到這條路線，就重抓
  const sorKey = `${k.path}|${route}`, sc = await IDB.get("sor|" + sorKey);
  const sorFresh = async heal => { const l = await tdx("route", u("StopOfRoute") + (heal ? FRESH : "")); IDB.set("sor|" + sorKey, { t: Date.now(), d: sorPack(l) }).catch(() => {}); return l; };
  let [sor, etas, near] = await Promise.all([
    sc ? sc.d : sorFresh(false),
    tdx("route", u("EstimatedTimeOfArrival")),
    tdx("route", u("RealTimeNearStop")).catch(() => []),
  ]);
  if (sc) {
    const have = new Set(); for (const r of sor) if (r.RouteUID === routeUID) for (const x of r.Stops || []) have.add(x.StopUID);
    const stale = !have.size || (Date.now() - sc.t > DAY_MS && etas.some(t => t.RouteUID === routeUID && t.StopUID && !have.has(t.StopUID)));
    if (stale) sor = await sorFresh(true).catch(() => sor);
  }
  try { placeHeal(etas.map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw }))); } catch (e) {}
  const mine = sor.filter(r => r.RouteUID === routeUID);
  const dirs = [...new Set((mine.length ? mine : sor).map(r => r.Direction === 1 ? 1 : 0))].sort();
  let cand = mine.filter(r => (r.Direction === 1 ? 1 : 0) === dirNum);
  if (!cand.length) cand = sor.filter(r => (r.Direction === 1 ? 1 : 0) === dirNum);
  if (!cand.length) cand = sor;
  cand.sort((a, b) => (b.Stops || []).length - (a.Stops || []).length);
  const stops = ((cand[0] && cand[0].Stops) || []).slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0));
  if (!stops.length) throw new Error("查無此路線的站序資料");

  const em = {};
  for (const t of etas) {
    if (t.RouteUID !== routeUID || (t.Direction === 1 ? 1 : 0) !== dirNum || !t.StopUID) continue;
    const sec = typeof t.EstimateTime === "number" ? t.EstimateTime : null;
    const c = em[t.StopUID];
    if (!c || (sec !== null && (c.sec === null || sec < c.sec))) em[t.StopUID] = { sec, status: t.StopStatus ?? 0, next: t.NextBusTime || null };
  }
  const busAt = {};
  for (const b of near) {
    if (b.RouteUID && b.RouteUID !== routeUID) continue;
    if ((b.Direction === 1 ? 1 : 0) !== dirNum) continue;
    if (b.StopUID) busAt[b.StopUID] = b.PlateNumb || true;
  }
  let destMap = {};
  try { destMap = await loadRouteDest("route", [routeUID]); } catch (e) {}
  busHeal([routeUID]);

  return {
    routeUID, route, dirs: dirs.length ? dirs : [dirNum],
    dest: { 0: destOf(routeUID, 0, destMap), 1: destOf(routeUID, 1, destMap) },
    stops: stops.map(s => {
      const nm = (s.StopName && s.StopName.Zh_tw) || "?";
      const e = em[s.StopUID] || { sec: null, status: null };
      return {
        seq: s.StopSequence, name: nm, uid: s.StopUID, ...e,
        bus: !!busAt[s.StopUID], plate: typeof busAt[s.StopUID] === "string" ? busAt[s.StopUID] : null,
        here: (stopUID && s.StopUID === stopUID) || (!!stopName && nm === stopName),
      };
    }),
  };
}

// ---------- 軌道（台鐵、高鐵、捷運、輕軌） ----------
// get(profile, url) 需回傳陣列（v3的物件容器要先拆成陣列）
const RAIL_BASE = "https://tdx.transportdata.tw/api/basic";
const RAIL_SYSTEMS = [
  { key: "TRA",    label: "台鐵",     kind: "tra",  url: `${RAIL_BASE}/v3/Rail/TRA/Station?%24top=1000&%24format=JSON` },
  { key: "THSR",   label: "高鐵",     kind: "thsr", url: `${RAIL_BASE}/v2/Rail/THSR/Station?%24top=100&%24format=JSON` },
  { key: "TRTC",   label: "北捷",     kind: "metro" },
  { key: "NTDLRT", label: "淡海輕軌", kind: "metro" },
  { key: "NTALRT", label: "安坑輕軌", kind: "metro" },
  { key: "TYMC",   label: "桃捷",     kind: "metro" },
  { key: "TMRT",   label: "中捷",     kind: "metro" },
  { key: "KRTC",   label: "高捷",     kind: "metro" },
  { key: "KLRT",   label: "高雄輕軌", kind: "metro" },
  { key: "NTMC",   label: "新北捷運", kind: "metro", optional: true },
].map(s => s.kind === "metro" ? { ...s, url: `${RAIL_BASE}/v2/Rail/Metro/Station/${s.key}?%24top=1000&%24format=JSON` } : s);
// 車站、出口、路線站序、站間時間：永久保存（v2.12.6），只有遇到清單沒有的站才重抓（railHeal／exitHeal）

const zh = o => (o && typeof o === "object") ? (o.Zh_tw ?? null) : (typeof o === "string" ? o : null);
const hm = s => (typeof s === "string" && /^\d{2}:\d{2}/.test(s)) ? s.slice(0, 5) : null;
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortType = s => (s || "").replace(/\(.*?\)|（.*?）/g, "").trim();
const lineOf = (op, id) => { if (op === "TRA" || op === "THSR") return null; const m = String(id || "").match(/^[A-Z]+/); return m ? m[0] : null; };

function mapRailStations(list, sys) {
  return list.map(s => {
    const p = s.StationPosition || {};
    const addr = typeof s.StationAddress === "string" ? s.StationAddress : zh(s.StationAddress);
    return { op: sys.key, sys: sys.label, kind: sys.kind, id: s.StationID, name: zh(s.StationName) || "?", lat: p.PositionLat, lon: p.PositionLon, addr: addr || null };
  }).filter(s => s.id && typeof s.lat === "number" && typeof s.lon === "number");
}

// 找附近車站：
// 1. 步行範圍內的車站依距離排序，不分系統（同系統最多3站、總共最多8站）
// 2. 範圍內沒有車站 → 顯示最近的2站（fallback）
// 3. 選擇性附上「最近的台鐵、高鐵站」（far），即使不在步行範圍
// 距離以「最近的出口」計算（有出口座標的系統），大站會比用車站中心點準很多
// opts: { walkKm, systems: ["TRA",...] 或 null 代表全部, far: true/false }
// exits: { "TRTC|BL12": [{ name, lat, lon }], ... }
function nearestRail(stations, lat, lon, opts = {}, exits = {}) {
  const walkM = Math.max(200, Math.min(5000, (Number(opts.walkKm) || 1.5) * 1000));
  const allow = Array.isArray(opts.systems) && opts.systems.length ? new Set(opts.systems) : null;
  const groups = {};
  for (const s of stations) {
    if (allow && !allow.has(s.op)) continue;
    let d = haversine(lat, lon, s.lat, s.lon), exit = null;
    for (const x of (exits[s.op + "|" + s.id] || [])) {
      const dx = haversine(lat, lon, x.lat, x.lon);
      if (!exit || dx < exit.d) exit = { name: x.name, lat: x.lat, lon: x.lon, d: dx };
    }
    if (exit) d = Math.min(d, exit.d);
    const k = s.op + "|" + s.name;
    const l = lineOf(s.op, s.id);
    const g = groups[k];
    if (!g) {
      groups[k] = { ...s, ids: [s.id], dist: d, lines: l ? [l] : [], exit: exit ? exit.name : null,
        navLat: exit ? exit.lat : s.lat, navLon: exit ? exit.lon : s.lon };
    } else {
      g.ids.push(s.id);
      if (l && !g.lines.includes(l)) g.lines.push(l);
      if (d < g.dist) Object.assign(g, { dist: d, exit: exit ? exit.name : g.exit, navLat: exit ? exit.lat : s.lat, navLon: exit ? exit.lon : s.lon });
    }
  }
  // 北捷與環狀線轉乘站（板橋 BL07／Y16等）合併成一張卡
  const trtcBy = {};
  for (const g of Object.values(groups)) if (g.op === "TRTC") for (const i of g.ids) trtcBy[i] = g;
  for (const [k, g] of Object.entries(groups)) {
    if (g.op !== "NTMC") continue;
    const t = g.ids.map(i => trtcBy[TRTC_XFER[i]]).find(Boolean);
    if (!t || t.name !== g.name) continue;
    for (const i of g.ids) if (!t.ids.includes(i)) t.ids.push(i);
    for (const l of g.lines) if (!t.lines.includes(l)) t.lines.push(l);
    if (!/新北捷運/.test(t.sys)) t.sys = t.sys + "・新北捷運";
    if (g.dist < t.dist) Object.assign(t, { dist: g.dist, exit: g.exit, navLat: g.navLat, navLon: g.navLon });
    delete groups[k];
  }
  const all = Object.values(groups).sort((a, b) => a.dist - b.dist);
  if (opts.all) return all;
  const count = {}, near = [];
  for (const s of all) {
    if (s.dist > walkM || near.length >= 8) break;
    count[s.op] = (count[s.op] || 0) + 1;
    if (count[s.op] <= 3) near.push(s);
  }
  let out = near;
  if (!near.length) out = all.slice(0, 2).map(s => ({ ...s, fallback: true }));
  if (opts.far) {
    for (const op of ["TRA", "THSR"]) {
      if (allow && !allow.has(op)) continue;
      if (out.some(s => s.op === op)) continue;
      const n = all.find(s => s.op === op);
      if (n && n.dist <= 40000) out.push({ ...n, far: true });
    }
  }
  return out;
}

// 捷運出口座標（TDX Metro StationExit），用來算「到最近出口」的距離
function mapExits(list, op) {
  const out = {};
  for (const x of list) {
    const p = x.ExitPosition || {};
    if (!x.StationID || typeof p.PositionLat !== "number") continue;
    const name = zh(x.ExitName) || x.ExitID || "出口";
    (out[op + "|" + x.StationID] = out[op + "|" + x.StationID] || []).push({ name, lat: p.PositionLat, lon: p.PositionLon });
  }
  return out;
}

const SEAT = { Available: "ok", Limited: "few", Full: "full" };

const TRA_ALL_LIVE = `${RAIL_BASE}/v3/Rail/TRA/TrainLiveBoard?%24format=JSON`;
const traAllLive = () => memoTdx("rail", TRA_ALL_LIVE, 60000);
async function traBoard(get, st) {
  const id = st.ids[0];
  const filter = encodeURIComponent(`StationID eq '${id}'`);
  const storedRows = await ttTrainRows("TRA", id, await dayInfo(svcDate(0))).catch(() => null);
  // 本站 StationLiveBoard ＋ 全台列車動態（Worker 共用快取60秒），讓已發車的每一班都有誤點
  const [tt, slive, tlive] = await Promise.allSettled([
    storedRows ? Promise.resolve([]) : get("rail", `${RAIL_BASE}/v3/Rail/TRA/DailyStationTimetable/Today/Station/${id}?%24format=JSON`)
      .catch(() => get("rail", `${RAIL_BASE}/v2/Rail/TRA/DailyTimetable/Station/${id}/${todayStr()}?%24format=JSON`)),
    get("rail", `${RAIL_BASE}/v3/Rail/TRA/StationLiveBoard?%24filter=${filter}&%24format=JSON`),
    traAllLive(),
  ]);
  if (tlive.status === "fulfilled") railHeal("TRA", tlive.value.map(t => t.StationID));
  const delay = {};
  for (const r of [tlive, slive]) {          // 本站資料較新，後寫覆蓋
    if (r.status !== "fulfilled") continue;
    for (const t of r.value) if (t.TrainNo != null && typeof t.DelayTime === "number") delay[String(t.TrainNo)] = t.DelayTime;
  }
  const live = slive.status === "fulfilled" || tlive.status === "fulfilled";
  let rows = [];
  if (storedRows && storedRows.length) rows = storedRows;
  else if (tt.status === "fulfilled" && tt.value.length) {
    for (const s of tt.value) {
      const list = s.TimeTables || s.Timetables || s.StopTimes;
      if (s.DailyTrainInfo) {                       // v2格式
        const i = s.DailyTrainInfo, p = (s.StopTimes || [])[0] || {};
        rows.push({ no: String(i.TrainNo), type: shortType(zh(i.TrainTypeName)), dest: zh(i.EndingStationName), dir: i.Direction ?? s.Direction, time: hm(p.DepartureTime || p.ArrivalTime) });
      } else if (Array.isArray(list)) {             // v3格式（每個方向一包）
        for (const t of list) rows.push({ no: String(t.TrainNo), type: shortType(zh(t.TrainTypeName)), dest: zh(t.DestinationStationName) || zh(t.EndingStationName), dir: t.Direction ?? s.Direction, time: hm(t.DepartureTime || t.ArrivalTime) });
      }
    }
  } else if (slive.status === "fulfilled") {        // 時刻表失敗時，至少顯示即將進站的車
    rows = slive.value.map(t => ({ no: String(t.TrainNo), type: shortType(zh(t.TrainTypeName)), dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.ScheduleDepartureTime || t.ScheduleArrivalTime || t.ScheduledDepartureTime || t.ScheduledArrivalTime) }));
  } else {
    throw (isRate(tt.reason) ? tt.reason : tt.reason || new Error("台鐵時刻表讀取失敗"));
  }
  const now = nowMin(), seen = new Set();
  rows = rows.filter(r => r.time && !seen.has(r.no) && seen.add(r.no))
    .map(r => ({ ...r, delay: delay[r.no] ?? null, t: toMin(r.time) }))
    .filter(r => r.t + (r.delay || 0) >= now - 1)
    .sort((a, b) => a.t - b.t);
  return { kind: "tra", live, trains: rows, groups: groupTrains("tra", rows), note: live ? null : "誤點資訊暫時讀不到，只顯示表定時間" };
}

async function thsrBoard(get, st) {
  const id = st.ids[0];
  const storedRows = await ttTrainRows("THSR", id, await dayInfo(svcDate(0))).catch(() => null);
  const [tt, seats] = await Promise.allSettled([
    storedRows ? Promise.resolve([]) : get("rail", `${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/Station/${id}/${todayStr()}?%24format=JSON`),
    memoTdx("rail", `${RAIL_BASE}/v2/Rail/THSR/AvailableSeatStatusList/${id}?%24format=JSON`, 60000),
  ]);
  const seatMap = {};
  let seatList = [];
  if (seats.status === "fulfilled") {
    const v = seats.value;
    seatList = (v[0] && v[0].AvailableSeats) ? v[0].AvailableSeats : (v[0] && v[0].TrainNo ? v : []);
    for (const s of seatList) seatMap[String(s.TrainNo)] = { std: SEAT[s.StandardSeatStatus] || null, biz: SEAT[s.BusinessSeatStatus] || null };
  }
  let rows;
  if (storedRows && storedRows.length) rows = storedRows;
  else if (tt.status === "fulfilled" && tt.value.length) {
    rows = tt.value.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else if (seatList.length) {
    rows = seatList.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else {
    throw (tt.reason || new Error("高鐵時刻表讀取失敗"));
  }
  const now = nowMin();
  rows = rows.filter(r => r.time).map(r => ({ ...r, t: toMin(r.time), seats: seatMap[r.no] || null }))
    .filter(r => r.t >= now - 1).sort((a, b) => a.t - b.t);
  return { kind: "thsr", live: seats.status === "fulfilled", trains: rows, groups: groupTrains("thsr", rows), note: seats.status === "fulfilled" ? null : "座位資訊暫時讀不到" };
}

// 北捷即時到站（經 Worker /trtc-eta，來源 Bus+）；失敗或沒資料回傳 null
const TRTC_ROUTE = [["淡水信義", "R"], ["松山新店", "G"], ["中和新蘆", "O"], ["板南", "BL"], ["文湖", "BR"], ["環狀", "Y"], ["新北投", "R"], ["小碧潭", "G"]];
// 北捷與環狀線的轉乘站：查詢時一併帶入另一系統的站碼
// 只列同名轉乘站；新埔（BL08）與新埔民生（Y17）名稱不同，分開顯示
const TRTC_XFER = { BL07: "Y16", G04: "Y07", O02: "Y11", O17: "Y18" };
for (const [a, b] of Object.entries(TRTC_XFER)) TRTC_XFER[b] = a;
const busPlusOK = st => st.op === "TRTC" || (st.op === "NTMC" && st.ids.some(i => /^Y\d/.test(i)));
async function trtcLive(st) {
  const proxy = getProxy(); if (!proxy) return null;
  const ids = [...new Set(st.ids.flatMap(i => TRTC_XFER[i] ? [i, TRTC_XFER[i]] : [i]))].filter(i => !/^LB/.test(i));
  let j;
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
    j = await fetch(`${proxy}/trtc-eta?ids=${encodeURIComponent(ids.join(","))}`, { signal: ctl.signal }).then(r => r.ok ? r.json() : null);
    clearTimeout(tm);
  } catch (e) { return null; }
  if (!j || !Array.isArray(j.stations)) return null;
  const here = new Set(ids), best = {};
  for (const s of j.stations) for (const it of (s.items || [])) {
    let destId = String(it.destinationStationId || "").toUpperCase();
    if (here.has(destId)) continue;                                        // 終點就是本站的列車不顯示
    const dest = (it.stationName && it.stationName.zh) || "?";
    const rn = (it.routeName && it.routeName.zh) || "";
    // 文湖線與環狀線都沒有 routeName：終點或本站代碼是 BR 開頭＝文湖線，否則＝環狀線（環狀線往大坪林的終點代碼給的是 G04）
    let line = (TRTC_ROUTE.find(([k]) => rn.includes(k)) || [])[1] || null;
    if (!line && !rn) line = /^BR\d/.test(destId) || (/^BR\d/.test(s.id || "") && !/^Y\d/.test(destId)) ? "BR" : "Y";
    if (!line) line = (/^[A-Z]+/.exec(destId) || [])[0] || null;
    if (line === "Y" && destId && !/^Y\d/.test(destId) && TRTC_XFER[destId]) destId = TRTC_XFER[destId];
    if (here.has(destId)) continue;
    const raw = String(it.estimateTime ?? "").trim();
    let sec = null, label = null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (m) sec = Math.max(0, +m[1] * 60 + +m[2] - (+it.secondsAgo || 0));
    else if (/進站|到站/.test(raw)) sec = 0;
    else label = raw || null;                                                // 暫無資料、末班車已過等
    const t = { line, dest, destId: destId || null, eta: sec === null ? null : Math.floor(sec / 60), label };
    const k = line + "|" + dest, o = best[k];
    if (!o || (t.eta !== null && (o.eta === null || t.eta < o.eta))) best[k] = t;
  }
  const trains = Object.values(best).sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
  return trains.some(t => t.eta !== null) ? trains : null;
}

// 時刻表只有終點站名：用車站清單把站名換成同一條線的站碼，才能和即時資料用同樣方式判斷方向
async function destFixer(op) {
  let list = []; try { list = await loadRailStations(); } catch (e) {}
  const m = {};
  for (const s of list) if (s.op === op || (op === "TRTC" && s.op === "NTMC") || (op === "NTMC" && s.op === "TRTC")) (m[normZh(s.name).replace(/站$/, "")] = m[normZh(s.name).replace(/站$/, "")] || []).push(s.id);
  return t => {
    if (t.destId) return t;
    const ids = m[normZh(t.dest).replace(/站$/, "")] || [];
    const id = ids.find(i => stnPre(i) === t.line) || null;
    return id ? { ...t, destId: id } : t;
  };
}
// ---------- 沒有站別時刻表的路線（北捷文湖線）：用 TDX 班距＋首末班推估整天班次 ----------
const HW_LINES = { TRTC: ["BR"] };
const hwPack = (freq, fl) => ({
  freq: freq.map(f => ({ LineID: f.LineID || f.LineNo, ServiceDay: f.ServiceDay, Headways: (f.Headways || []).map(h => ({ StartTime: h.StartTime, EndTime: h.EndTime, MinHeadwayMins: h.MinHeadwayMins, MaxHeadwayMins: h.MaxHeadwayMins })) })),
  fl: fl.map(r => ({ LineID: r.LineID || r.LineNo, StationID: r.StationID, DestinationStationID: r.DestinationStaionID || r.DestinationStationID || null, DestinationStationName: { Zh_tw: zh(r.DestinationStationName) }, FirstTrainTime: r.FirstTrainTime, LastTrainTime: r.LastTrainTime, ServiceDay: r.ServiceDay })),
});
const HW_KEY = "jisu_hw_";
async function loadHw(get, op, stored) {
  if (stored && stored.hw) return stored.hw;
  try { const c = JSON.parse(localStorage.getItem(HW_KEY + op)); if (c && Date.now() - c.time < 7 * 86400000) return c.hw; } catch (e) {}
  const f = encodeURIComponent(HW_LINES[op].map(l => `LineID eq '${l}'`).join(" or "));
  const [freq, fl] = await Promise.all([get("rail", `${RAIL_BASE}/v2/Rail/Metro/Frequency/${op}?%24filter=${f}&%24format=JSON`), get("rail", `${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/${op}?%24filter=${f}&%24format=JSON`)]);
  const hw = hwPack(freq || [], fl || []);
  try { localStorage.setItem(HW_KEY + op, JSON.stringify({ time: Date.now(), hw })); } catch (e) {}
  return hw;
}
// 依班距排出本站整天的估算班次（班距取最小與最大的平均）；今日已收班就列明日
async function hwTimetable(hw, ids, op) {
  const now = nowMin() < 180 ? nowMin() + 1440 : nowMin();
  const mk = async (off) => {
    const di = await dayInfo(svcDate(off)), key = di.hol ? "NationalHolidays" : di.key, out = [];
    for (const r of hw.fl.filter(r => ids.includes(r.StationID) && (!r.ServiceDay || r.ServiceDay[key] !== false))) {
      const plan = hw.freq.find(f => f.LineID === r.LineID && f.ServiceDay && f.ServiceDay[key]) || hw.freq.find(f => f.LineID === r.LineID); if (!plan) continue;
      const bands = (plan.Headways || []).map(h => { const s = toMin(h.StartTime); let e = h.EndTime === "24:00" ? 1440 : toMin(h.EndTime); if (e <= s) e += 1440; return { s: s < 180 ? s + 1440 : s, e, hw: Math.max(1, Math.round(((h.MinHeadwayMins || h.MaxHeadwayMins) + (h.MaxHeadwayMins || h.MinHeadwayMins)) / 2)) }; }).sort((a, b) => a.s - b.s);
      const hwAt = t => { const b = bands.find(b => t >= b.s && t < b.e) || (t >= (bands[bands.length - 1] || {}).e ? bands[bands.length - 1] : bands[0]); return b ? b.hw : 8; };
      const first = toMin(r.FirstTrainTime); let last = toMin(r.LastTrainTime); if (last < 180) last += 1440;
      const dest = zh(r.DestinationStationName) || "?", base = { dest, destId: r.DestinationStationID, line: r.LineID, dir: null, via: null, est: true };
      const ts = []; for (let t = first; t < last; t += hwAt(t)) ts.push(t); ts.push(last);
      ts.forEach((t, i) => { const tt = t + off * 1440; out.push({ ...base, time: String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"), t: tt, eta: tt - now, lastTrain: i === ts.length - 1 }); });
    }
    return out;
  };
  const today = (await mk(0)).filter(x => x.t >= now);
  const lines = new Set(today.map(x => x.line + "|" + x.dest));
  const tm = (await mk(1)).filter(x => !lines.has(x.line + "|" + x.dest));   // 這個方向今天收班了：列明日
  return [...today, ...tm].sort((a, b) => a.t - b.t);
}
async function metroBoard(get, st) {
  const filter0 = encodeURIComponent(st.ids.map(i => `StationID eq '${i}'`).join(" or "));
  const ttP = metroTimetable(get, st, filter0, true).catch(() => null);
  const b = await metroBoard0(get, st);
  let tt = await ttP;
  // 這站有沒有站別時刻表的路線（文湖線）：補上依班距估算的班次
  const hwL = (HW_LINES[st.op] || []).filter(l => st.ids.some(i => stnPre(i) === l) && !(tt || []).some(t => t.line === l));
  if (hwL.length) {
    try {
      const stored = await ttLoad(st.op).catch(() => null), hw = await loadHw(get, st.op, stored);
      const est = (await hwTimetable(hw, st.ids, st.op)).filter(t => hwL.includes(t.line));
      if (est.length) { tt = [...(tt || []), ...est].sort((a, b) => a.t - b.t); b.hasEst = true; }
    } catch (e) { if (isRate(e)) throw e; }
  }
  const fix = await destFixer(st.op);
  b.tt = (tt || []).map(fix).map(t => ({ ...t, side: metroSide(t, st.ids) })).filter(t => !(t.destId && st.ids.includes(t.destId)));
  b.ttKind = "official";
  if (!b.live) b.groups = [];          // 沒有即時資料時，看板只用時刻表（避免同方向出現兩個分頁）
  else { b.groups = b.groups.map(g => ({ ...g, trains: g.trains.map(fix) })); }
  if (b.tt.length && !b.live) b.note = null;
  return b;
}
async function metroBoard0(get, st) {
  if (busPlusOK(st)) {
    const trains = await trtcLive(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };   // 資料來源統一寫在設定頁
  }
  const filter = encodeURIComponent(st.ids.map(i => `StationID eq '${i}'`).join(" or "));
  let live = [];
  try { live = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/LiveBoard/${st.op}?%24filter=${filter}&%24format=JSON`); } catch (e) { if (isRate(e)) throw e; }
  if (live.length) {
    railHeal(st.op, live.flatMap(t => [t.StationID, t.DestinationStationID]));
    const vals = live.map(t => t.EstimateTime).filter(v => typeof v === "number");
    const isSec = vals.some(v => v > 120);
    const trains = live.map(t => ({
      line: t.LineNO || t.LineID || lineOf(st.op, t.StationID),
      dest: zh(t.DestinationStaionName) || zh(t.DestinationStationName) || zh(t.TripHeadSign) || "?",
      destId: t.DestinationStationID || null,
      via: (/(順行|逆行)/.exec(zh(t.TripHeadSign) || "") || [])[1] || null,   // 環狀線（高雄輕軌）起訖同站，用順／逆行區分
      eta: typeof t.EstimateTime === "number" ? (isSec ? Math.floor(t.EstimateTime / 60) : t.EstimateTime) : null,
    })).sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
    // 北捷 LiveBoard 只列出「正在進站」的列車（EstimateTime 全為0），不是完整看板：與時刻表合併
    if (!trains.every(t => t.eta === 0)) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };
    const tt = await metroTimetable(get, st, filter).catch(e => { if (isRate(e)) throw e; return []; });
    const liveDest = new Set(trains.map(t => t.dest + "|" + t.line));
    const rest = tt.filter(t => !(liveDest.has(t.dest + "|" + t.line) && t.eta <= 1));
    const all = [...trains.map(t => ({ ...t, arriving: true })), ...rest].sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
    return { kind: "metro", live: true, trains: all, groups: groupTrains("metro", st.ids, all), note: st.op === "TRTC" ? "北捷即時來源暫時無法使用，只有進站中列車＋時刻表" : null };
  }
  let tt;
  try { tt = await metroTimetable(get, st, filter); } catch (e) { if (isRate(e)) throw e; tt = null; }
  if (tt === null) return { kind: "metro", live: false, trains: [], groups: [], note: "這個系統沒有提供即時到站或時刻表資料" };
  const note = !tt.length ? "今日班次已結束" : st.op === "TRTC" ? "北捷即時來源暫時無法使用，以下為時刻表" : null;
  return { kind: "metro", live: false, trains: tt, groups: groupTrains("metro", st.ids, tt), note };
}


// ---------- 時刻表雲端儲存（Worker KV）：手動更新；車站頁優先讀這份，沒有才即時向 TDX 查 ----------
const SD_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "NationalHolidays"];
const TT_SYSTEMS = [
  ["TRTC", "台北捷運", "metro"], ["NTMC", "新北捷運（環狀線）", "metro"], ["NTDLRT", "淡海輕軌", "metro"], ["NTALRT", "安坑輕軌", "metro"],
  ["TYMC", "桃園機場捷運", "metro"], ["TMRT", "台中捷運（班距）", "tmrt"], ["KRTC", "高雄捷運", "metro"], ["KLRT", "高雄輕軌", "metro"],
  ["TRA", "台鐵", "tra"], ["THSR", "高鐵", "thsr"], ["HOLIDAY", "國定假日曆（人事總處）", "holiday"],
];
const sdMask = sd => SD_KEYS.map(k => sd && sd[k] ? "1" : "0").join("");
const sdObj = m => Object.fromEntries(SD_KEYS.map((k, i) => [k, m[i] === "1"]));
let ttMetaP = null; const ttMem = {};
async function ttMeta(force) {
  const proxy = getProxy(); if (!proxy) return { systems: {} };
  if (force || !ttMetaP) ttMetaP = fetch(`${proxy}/tt/meta${force ? "?t=" + Date.now() : ""}`).then(r => r.ok ? r.json() : { systems: {} }).catch(() => (ttMetaP = null, { systems: {} }));
  return ttMetaP;
}
async function ttLoad(op) {
  const m = (await ttMeta()).systems[op]; if (!m) return null;
  const k = op + "|" + m.updated; if (ttMem[k]) return ttMem[k];
  return ttMem[k] = fetch(`${getProxy()}/tt/data/${op}?v=${encodeURIComponent(m.updated)}`).then(r => r.ok ? r.json() : null).catch(() => { delete ttMem[k]; return null; });
}
// 今天（或指定日期）屬於哪一種營運日：國定假日 → NationalHolidays（系統沒有假日表就用週日）；補班日 → 平日
async function dayInfo(date) {
  const h = await ttLoad("HOLIDAY").catch(() => null);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const name = h && h.dates && h.dates[iso];
  if (name && name !== "補班") return { key: "NationalHolidays", hol: true, name };
  if (name === "補班") return { key: "Monday", hol: false, name };
  // 國定假日前一天（平日）：高雄捷運等有「假日前一天」時刻表的系統會用它
  const n = new Date(date); n.setDate(n.getDate() + 1);
  const isoN = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const eve = !!(h && h.dates && h.dates[isoN] && h.dates[isoN] !== "補班") && date.getDay() >= 1 && date.getDay() <= 4;
  return { key: DAY_KEYS[date.getDay()], hol: false, name: null, eve };
}
function pickDay(recs, info) {
  if (info.eve) { const e = recs.filter(r => r.ServiceDay && /前/.test(r.ServiceDay.ServiceTag || "")); if (e.length) return e; }
  if (info.hol) { const h = recs.filter(r => r.ServiceDay && r.ServiceDay.NationalHolidays === true); if (h.length) return h; info = { key: "Sunday" }; }
  const x = recs.filter(r => r.ServiceDay && r.ServiceDay[info.key] === true);
  return x.length ? x : recs;
}
const svcDate = (offsetDays = 0) => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); d.setDate(d.getDate() + offsetDays); return d; };

// 手動更新：瀏覽器向 TDX（經 Worker、金鑰3）抓整個系統，壓縮後存回 Worker KV。回傳用了幾次 TDX 呼叫
async function ttRefresh(op, pass, onStep) {
  const proxy = getProxy(); if (!proxy) throw new Error("尚未設定 Worker");
  if (op === "HOLIDAY") {
    const r = await fetch(`${proxy}/tt/holidays`, { method: "POST", headers: { "x-session": pass } });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status); ttMetaP = null; return { calls: 0, ...j };
  }
  let calls = 0, version = "", out;
  // 每頁之間稍停；限流時等久一點再試（每次嘗試都算一次呼叫）
  const get = async (url, raw) => {
    for (let i = 0; ; i++) {
      calls++; onStep && onStep(calls);
      try {
        if (!raw) return await tdx("rail", url);
        const r = await fetch(proxy + url.slice(TDX_ORIGIN.length) + "&__k=3"); const j = await r.json();
        if (r.status === 429) { const e = new Error(RATE_MSG); e.rate = true; throw e; }
        if (!r.ok) throw new Error("資料讀取失敗 (" + r.status + ")"); return j;
      } catch (e) { if (!isRate(e) || i >= 3) throw e; await sleep(5000 * (i + 1)); }
    }
  };
  const sys = (TT_SYSTEMS.find(x => x[0] === op) || [])[2];
  if (sys === "metro") {
    const all = [], top = 300;
    for (let skip = 0; skip < 20000; skip += top) {
      const page = await get(`${RAIL_BASE}/v2/Rail/Metro/StationTimeTable/${op}?%24top=${top}&%24skip=${skip}&%24format=JSON`);
      all.push(...page); if (page.length < top) break; await sleep(700);
    }
    const sds = [], rows = [];
    for (const r of all) {
      const m = sdMask(r.ServiceDay); let i = sds.findIndex(x => x.m === m); if (i < 0) { sds.push({ m, tag: r.ServiceDay && r.ServiceDay.ServiceTag || "" }); i = sds.length - 1; }
      const times = (r.Timetables || []).map(t => hm(t.DepartureTime || t.ArrivalTime)).filter(Boolean).map(x => x.replace(":", ""));
      rows.push([r.StationID, r.LineID || r.LineNO || "", r.Direction ?? "", r.DestinationStaionID || r.DestinationStationID || "", zh(r.DestinationStaionName) || zh(r.DestinationStationName) || "", i, times.join(" ")]);
      if (r.VersionID && String(r.VersionID) > version) version = String(r.VersionID);
      if (!version && r.UpdateTime) version = r.UpdateTime.slice(0, 10);
    }
    if (!rows.length) throw new Error("TDX 沒有這個系統的站別時刻表");
    out = { v: 1, op, kind: "metro", sd: sds, rows };
    if (HW_LINES[op]) {   // 沒有站別時刻表的路線：一起存班距＋首末班（2次呼叫）
      const f = encodeURIComponent(HW_LINES[op].map(l => `LineID eq '${l}'`).join(" or "));
      out.hw = hwPack(await get(`${RAIL_BASE}/v2/Rail/Metro/Frequency/${op}?%24filter=${f}&%24format=JSON`), await get(`${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/${op}?%24filter=${f}&%24format=JSON`));
    }
  } else if (sys === "tmrt") {
    const [freq, fl] = [await get(`${RAIL_BASE}/v2/Rail/Metro/Frequency/TMRT?%24format=JSON`), await get(`${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/TMRT?%24format=JSON`)];
    if (!freq.length || !fl.length) throw new Error("TDX 沒有台中捷運班距資料");
    version = String((freq[0] && (freq[0].VersionID || (freq[0].UpdateTime || "").slice(0, 10))) || "");
    out = { v: 1, op, kind: "tmrt", freq, fl };
  } else if (sys === "tra") {
    const j = await get(`${RAIL_BASE}/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON`, true);
    const list = j.TrainTimetables || [];
    version = String(j.VersionID || (j.EffectiveDate || j.UpdateTime || "").slice(0, 10));
    const trains = list.map(t => { const i = t.TrainInfo || {};
      return [String(i.TrainNo), shortType(zh(i.TrainTypeName)), i.Direction ?? "", zh(i.StartingStationName) || "", zh(i.EndingStationName) || "", sdMask(t.ServiceDay || i.ServiceDay || { Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1, Sunday: 1, NationalHolidays: 1 }),
        (t.StopTimes || []).map(x => [x.StationID, (hm(x.ArrivalTime) || "").replace(":", ""), (hm(x.DepartureTime) || "").replace(":", "")].join(",")).join(";")]; });
    if (!trains.length) throw new Error("TDX 沒有台鐵定期時刻表");
    out = { v: 1, op, kind: "tra", trains, eff: j.EffectiveDate || null, exp: j.ExpireDate || null };
  } else if (sys === "thsr") {
    const list = await get(`${RAIL_BASE}/v2/Rail/THSR/GeneralTimetable?%24format=JSON`);
    const trains = list.map(x => x.GeneralTimetable || x).map(g => { const i = g.GeneralTrainInfo || {};
      const ut = g.UpdateTime || x.UpdateTime; if (ut && !version) version = String(g.VersionID || x.VersionID || ut.slice(0, 10));
      return [String(i.TrainNo), "高鐵", i.Direction ?? "", zh(i.StartingStationName) || "", zh(i.EndingStationName) || "", sdMask(g.ServiceDay),
        (g.StopTimes || []).map(x => [x.StationID, (hm(x.ArrivalTime) || "").replace(":", ""), (hm(x.DepartureTime) || "").replace(":", "")].join(",")).join(";"),
        g.EffectiveDate || "", g.ExpiringDate || ""]; });
    if (!trains.length) throw new Error("TDX 沒有高鐵定期時刻表");
    out = { v: 1, op, kind: "thsr", trains };
  } else throw new Error("不支援的系統");
  const body = JSON.stringify(out);
  const count = out.rows ? out.rows.length : out.trains ? out.trains.length : (out.fl || []).length;
  const r = await fetch(`${proxy}/tt/data/${op}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": String(calls), "x-tt-version": version, "x-tt-count": String(count) }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || "上傳失敗 " + r.status);
  ttMetaP = null;
  // 捷運／輕軌：同時串出每一班車的官方時刻，存成 TRIPS_系統（不用再呼叫 TDX）
  let trips = null;
  if (out.kind === "metro") {
    try {
      const T = buildTrips(out), tb = JSON.stringify(T);
      const rates = Object.entries(T.stats).map(([l, v]) => `${l} ${v.rate}%`).join("、");
      const r2 = await fetch(`${proxy}/tt/data/TRIPS_${op}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": "0", "x-tt-version": version, "x-tt-count": String(T.trips.length) }, body: tb });
      trips = r2.ok ? { count: T.trips.length, rates } : { error: "車次上傳失敗 " + r2.status };
    } catch (e) { trips = { error: String(e.message || e) }; }
  }
  return { calls, bytes: body.length, count, version, trips, ...j };
}
// ---------- 由各站時刻表串出每一班車的官方時刻（更新時刻表時在瀏覽器計算，存到 KV 的 TRIPS_系統） ----------
// 方法：同一線、同方向、同終點、同日別的各站發車時間，依站序把第 i 站的每個發車接到第 i+1站「時間差≈站間行駛時間」的那一班（不超車、貪婪配對）。
// 直達車（跳站）在下一站接不到時，往後幾站找；支線、短程車因為以終點分組，自然分開；配不到的就退回推估。
const TRIP_RULES = { "TRTC|R": [["leaf", "R22A", "R22"]], "TRTC|G": [["leaf", "G03A", "G03"]], "TRTC|O": [["branch", "O50", "O12"]], "NTDLRT|V": [["branch", "V28", "V09"]] };
const TRIP_LOOP = { "KLRT|C": true };
const TRIP_EXPRESS = { "TYMC|A": true };   // 有直達車：最後幾站接不上時視為直達終點（到站時間推估）
const natKey = id => { const m = /^([A-Z]+)(\d+)([A-Za-z]*)$/.exec(id) || [0, id, 0, ""]; return [m[1], +m[2], (m[3] || "").toUpperCase()]; };
const natCmp = (a, b) => { const x = natKey(a), y = natKey(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : (x[1] - y[1]) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
const t2m = x => { const m = (+x.slice(0, 2)) * 60 + (+x.slice(2, 4)); return m < 180 ? m + 1440 : m; };
const m2t = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + String(m % 60).padStart(2, "0"); };
// 站間行駛時間：試 lo～hi 分，取「不超車貪婪配對」配到最多的那個（同分取較小，避免把班距倍數當成行駛時間）
function tripGreedy(A, B, T, tol, claimed) {
  const out = new Array(A.length).fill(-1); let last = -1, n = 0, amb = 0;
  for (let i = 0; i < A.length; i++) {
    let bj = -1, bd = 9, c = 0;
    for (let j = last + 1; j < B.length && B[j] <= A[i] + T + tol; j++) {
      if (claimed && claimed[j]) continue;
      const d = Math.abs(B[j] - A[i] - T); if (d <= tol) { c++; if (d < bd) { bd = d; bj = j; } }
    }
    if (bj >= 0) { out[i] = bj; last = bj; n++; if (c > 1) amb++; }
  }
  return { out, n, amb };
}
function tripMode(A, B, lo, hi, claimed) {
  let best = null;
  for (let T = lo; T <= hi; T++) { const r = tripGreedy(A, B, T, 1, claimed); if (!best || r.n > best.n) best = { T, n: r.n }; }
  return best && best.n ? best : null;
}
function buildTrips(tt) {
  const byLine = {}; for (const r of tt.rows) (byLine[r[1]] = byLine[r[1]] || []).push(r);
  const groups = [], trips = [], stats = {}, seg = {};
  const lineData = [];
  for (const [line, rows] of Object.entries(byLine)) {
    const key = tt.op + "|" + line, loop = !!TRIP_LOOP[key];
    const gl = {}; for (const r of rows) (gl[r[2] + "|" + r[3]] = gl[r[2] + "|" + r[3]] || []).push(r[0]);
    let best = []; for (const l of Object.values(gl)) { const u = [...new Set(l)]; if (u.length > best.length) best = u; }
    const order = best.slice(), all = new Set(); for (const r of rows) { all.add(r[0]); if (r[3]) all.add(r[3]); }
    for (const id of [...all].filter(x => !order.includes(x)).sort(natCmp)) { let i = order.findIndex(x => natCmp(x, id) > 0); if (i < 0) i = order.length; order.splice(i, 0, id); }
    const adj = {}, add = (a, b) => { (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a); }, del = (a, b) => { adj[a] && adj[a].delete(b); adj[b] && adj[b].delete(a); };
    for (let i = 1; i < order.length; i++) add(order[i - 1], order[i]);
    for (const [type, b, a] of TRIP_RULES[key] || []) {
      const i = order.indexOf(b); if (i < 0) continue;
      if (type === "leaf") { const nb = [...(adj[b] || [])]; for (const x of nb) del(b, x); if (nb.length === 2) add(nb[0], nb[1]); add(a, b); }
      else { if (i > 0) del(order[i - 1], b); add(a, b); }
    }
    if (loop) add(order[0], order[order.length - 1]);
    const gs = {}; for (const r of rows) (gs[r[2] + "|" + r[3] + "|" + r[5]] = gs[r[2] + "|" + r[3] + "|" + r[5]] || []).push(r);
    lineData.push({ line, key, loop, order, adj, gs });
  }
  // 第一輪：算各站間行駛時間（給終點到站時間用）
  const build = [];
  for (const L of lineData) for (const grows of Object.values(L.gs)) {
    const [dir, de, sdi] = [grows[0][2], grows[0][3], grows[0][5]], dn = grows[0][4];
    const st = {}; for (const r of grows) { const a = st[r[0]] = st[r[0]] || []; for (const x of r[6] ? r[6].split(" ") : []) a.push(t2m(x)); }
    for (const a of Object.values(st)) a.sort((x, y) => x - y);
    const next = {};
    if (L.loop) {
      const o = L.order, n = o.length, sc = f => { let c = 0; for (let i = 0; i < n; i++) { const a = st[o[i]], b = st[o[(i + f + n) % n]]; if (a && b) { const m = tripMode(a, b, 1, 6); if (m) c += m.n; } } return c; };
      const f = sc(1) >= sc(-1) ? 1 : -1;
      for (let i = 0; i < n; i++) next[o[i]] = o[(i + f + n) % n];
    } else {
      const dist = { [de]: 0 }, q = [de];
      while (q.length) { const x = q.shift(); for (const y of L.adj[x] || []) if (dist[y] == null) { dist[y] = dist[x] + 1; q.push(y); } }
      for (const s of Object.keys(st)) for (const y of L.adj[s] || []) if (dist[y] === dist[s] - 1) next[s] = y;
    }
    build.push({ L, dir, de, dn, sdi, st, next });
  }
  for (const B of build) for (const [s, a] of Object.entries(B.st)) {
    const n = B.next[s]; if (!n || n === B.de || !B.st[n]) continue;
    const m = tripMode(a, B.st[n], 1, 12); if (m && m.n >= 3) { (seg[s + "|" + n] = seg[s + "|" + n] || []).push(m.T); }
  }
  const segT = (a, b) => { const v = seg[a + "|" + b] || seg[b + "|" + a]; return v ? v.sort((x, y) => x - y)[v.length >> 1] : 2; };
  // 第二輪：配對、串車次
  for (const B of build) {
    const { L, st, next, de } = B, S = Object.keys(st);
    const ss = stats[L.line] = stats[L.line] || { need: 0, ok: 0, skip: 0, ambig: 0, trips: 0, groups: 0, miss: [] };
    ss.groups++;
    const link = {}, claimed = {};
    for (const s of S) { link[s] = new Array(st[s].length).fill(null); claimed[s] = new Array(st[s].length).fill(false); }
    const path = s => { const p = []; let x = next[s], g = 0; while (x && x !== de && g++ < 60) { p.push(x); x = next[x]; } return p; };
    // 依站序處理（離終點遠的先）
    const pend = [];
    for (const s of S) {
      const p = path(s); if (!next[s] || (next[s] === de && (L.loop || !st[de]))) continue;
      const A = st[s];
      ss.need += A.length;
      const n = next[s], Bt = st[n];
      const m = Bt ? tripMode(A, Bt, 1, 12) : null;
      if (m) {
        const g = tripGreedy(A, Bt, m.T, 1, claimed[n]);
        g.out.forEach((j, i) => { if (j >= 0) { link[s][i] = [n, j]; claimed[n][j] = true; } });
        ss.ok += g.n; ss.ambig += g.amb;
        // 第二輪：剩下的放寬到 ±2分（尖峰停站較久），仍要維持不超車
        const left = A.map((t, i) => link[s][i] ? -1 : i).filter(i => i >= 0);
        for (const i of left) {
          let lo = -1, hi = Bt.length;
          for (let q = i - 1; q >= 0; q--) if (link[s][q] && link[s][q][0] === n) { lo = link[s][q][1]; break; }
          for (let q = i + 1; q < A.length; q++) if (link[s][q] && link[s][q][0] === n) { hi = link[s][q][1]; break; }
          const c = []; for (let j = lo + 1; j < hi; j++) if (!claimed[n][j] && Math.abs(Bt[j] - A[i] - m.T) <= 2) c.push(j);
          if (c.length === 1) { link[s][i] = [n, c[0]]; claimed[n][c[0]] = true; ss.ok++; ss.loose = (ss.loose || 0) + 1; }
        }
      }
      pend.push([s, p]);
    }
    // 跳站（直達車）：沒接上的往後2～8站找
    for (const [s, p] of pend) {
      const A = st[s], rest = A.map((t, i) => link[s][i] ? null : i).filter(i => i != null);
      if (!rest.length) continue;
      for (let k = 1; k < Math.min(p.length, 8) && rest.length; k++) {
        const n = p[k], Bt = st[n]; if (!Bt) continue;
        const m = tripMode(rest.map(i => A[i]), Bt, k + 1, 6 * (k + 1), claimed[n]); if (!m || m.n < Math.min(3, rest.length)) continue;
        for (let r = rest.length - 1; r >= 0; r--) {
          const i = rest[r]; let bj = -1, bd = 9;
          for (let j = 0; j < Bt.length; j++) { const d = Math.abs(Bt[j] - A[i] - m.T); if (d <= 1 && !claimed[n][j] && d < bd) { bd = d; bj = j; } }
          if (bj >= 0) { link[s][i] = [n, bj]; claimed[n][bj] = true; ss.ok++; ss.skip++; rest.splice(r, 1); }
        }
      }
    }
    // 直達車會在有待避線的車站超越普通車：普通車「逐站進、跳站出」、直達車「跳站進、逐站出」代表兩者接反了，就互換進站來源
    if (TRIP_EXPRESS[L.key]) {
      const prev = {}; for (const s of S) prev[s] = new Array(st[s].length).fill(null);
      for (const s of S) link[s].forEach((l, i) => { if (l && prev[l[0]]) prev[l[0]][l[1]] = [s, i, l[0] === next[s]]; });
      for (const x of S) {
        const outAdj = k => link[x][k] ? link[x][k][0] === next[x] : null;
        const A = [], Bq = [];
        st[x].forEach((t, k) => { const p = prev[x][k], o = outAdj(k); if (!p || o == null) return; if (p[2] && !o) A.push(k); else if (!p[2] && o) Bq.push(k); });
        for (const ka of A) {
          let bi = -1, bd = 7; Bq.forEach((kb, q) => { const d = Math.abs(st[x][kb] - st[x][ka]); if (kb >= 0 && d < bd) { bd = d; bi = q; } });
          if (bi < 0) continue;
          const kb = Bq[bi]; Bq[bi] = -1;
          const pa = prev[x][ka], pb = prev[x][kb];
          link[pa[0]][pa[1]] = [x, kb]; link[pb[0]][pb[1]] = [x, ka]; prev[x][ka] = pb; prev[x][kb] = pa;
          ss.swap = (ss.swap || 0) + 1;
        }
      }
    }
    for (const [s] of pend) st[s].forEach((t, i) => { if (!link[s][i] && ss.miss.length < 400) ss.miss.push(`${B.dn}/${tt.sd[B.sdi].tag} ${s}@${m2t(t)}→${next[s]}`); });
    // 串成車次
    const sIdx = {}, sList = [...S]; if (!sList.includes(de)) sList.push(de); sList.forEach((x, i) => sIdx[x] = i);
    const gi = groups.length; groups.push({ l: L.line, d: B.dir, de, dn: B.dn, sd: B.sdi, st: sList });
    for (const s of S) for (let i = 0; i < st[s].length; i++) {
      if (claimed[s][i] || (s === de && !L.loop)) continue;     // 終點站的「發車」其實是到站時間，只當串接目標
      const parts = []; let x = s, k = i, guard = 0, ok = true, nAdj = 0, nSkip = 0;
      while (x && guard++ < 80) {
        parts.push(sIdx[x] + "." + m2t(st[x][k]));
        const l = link[x][k];
        if (!l) {
          if (x === de) break;
          if (next[x] === de) parts.push("~" + sIdx[de] + "." + m2t(st[x][k] + segT(x, de)));
          else if (TRIP_EXPRESS[L.key] && path(x).length <= 3) { let y = x, m = st[x][k]; while (y && y !== de) { m += segT(y, next[y]); y = next[y]; } parts.push("~" + sIdx[de] + "." + m2t(m - path(x).length)); ss.xterm = (ss.xterm || 0) + 1; ss.ok++; }
          else ok = false;
          break;
        }
        if (l[0] === next[x]) nAdj++; else nSkip++;
        [x, k] = l;
      }
      // 直達車與普通車混在一起（跳站之外又有很多逐站停靠）＝可能接錯車，標成不確定、改用推估
      if (nSkip && nAdj > 3) { ok = false; ss.mixed = (ss.mixed || 0) + 1; }
      trips.push([gi, parts.join(" "), ok ? 1 : 0]); ss.trips++;
    }
  }
  for (const v of Object.values(stats)) { v.rate = v.need ? +(100 * v.ok / v.need).toFixed(2) : 100; v.missN = v.miss.length; v.miss = v.miss.slice(0, 20); v.uncertain = trips.filter(t => !t[2] && groups[t[0]].l === Object.keys(stats).find(k => stats[k] === v)).length; }
  return { v: 1, op: tt.op, kind: "trips", sd: tt.sd, groups, trips, stats };
}
// 把儲存的捷運列轉回 TDX StationTimeTable 的樣子，沿用原本的處理邏輯
function ttMetroRecs(tt, ids) {
  const want = new Set(ids);
  return tt.rows.filter(r => want.has(r[0])).map(r => ({ StationID: r[0], LineID: r[1] || null, Direction: r[2] === "" ? null : +r[2], DestinationStationID: r[3] || null,
    DestinationStationName: { Zh_tw: r[4] }, ServiceDay: { ...sdObj(tt.sd[r[5]].m), ServiceTag: tt.sd[r[5]].tag }, Timetables: r[6] ? r[6].split(" ").map(x => ({ DepartureTime: x.slice(0, 2) + ":" + x.slice(2) })) : [] }));
}
const hhmm4 = x => x ? x.slice(0, 2) + ":" + x.slice(2) : null;
// 台鐵／高鐵：從定期時刻表取出某站今天（依營運日）停靠的班次
async function ttTrainRows(op, id, info) {
  const tt = await ttLoad(op); if (!tt || !tt.trains) return null;
  // 台鐵／高鐵的定期表沒有國定假日欄，連假多半另有疏運表 → 假日改抓 TDX 當日時刻表
  if (info.hol && !tt.trains.some(t => t[5][7] === "1")) return null;
  const ix = info.hol ? 7 : SD_KEYS.indexOf(info.key), hasHol = tt.trains.some(t => t[5][7] === "1"), sunIx = 6;
  const today = todayStr().replace(/-/g, "");
  const rows = [];
  for (const t of tt.trains) {
    const m = t[5]; const ok = info.hol && !hasHol ? m[sunIx] === "1" : m[ix] === "1"; if (!ok) continue;
    if (t[7] && t[7].replace(/-/g, "") > today) continue; if (t[8] && t[8].replace(/-/g, "") < today) continue;
    const stops = t[6].split(";"), si = stops.findIndex(x => x.startsWith(id + ","));
    if (si < 0 || si === stops.length - 1) continue;            // 終點站不列
    const [, a, d] = stops[si].split(",");
    rows.push({ no: t[0], type: t[1], dir: t[2] === "" ? null : +t[2], dest: t[4], time: hhmm4(d || a) });
  }
  return rows;
}

// 時刻表：回傳今日接下來的班次；查無資料回傳 null
async function metroTimetable(get, st, filter, all) {
  let recs = [];
  const stored = await ttLoad(st.op).catch(() => null);
  if (stored && stored.rows) recs = ttMetroRecs(stored, st.ids);
  else { try { recs = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/StationTimeTable/${st.op}?%24filter=${filter}&%24format=JSON`); } catch (e) { if (isRate(e)) throw e; } }
  // 北捷與環狀線合併的轉乘站（板橋、大坪林、景安、頭前庄）：另一個系統的時刻表也要帶進來
  const other = st.op === "TRTC" && st.ids.some(i => /^Y\d/.test(i)) ? "NTMC" : st.op === "NTMC" && st.ids.some(i => !/^(Y|LB)\d/.test(i)) ? "TRTC" : null;
  if (other && stored && stored.rows) { const o2 = await ttLoad(other).catch(() => null); if (o2 && o2.rows) recs = recs.concat(ttMetroRecs(o2, st.ids)); }
  if (!recs.length) return null;
  const info = await dayInfo(svcDate(0)), infoT = await dayInfo(svcDate(1));
  const todays = pickDay(recs, info), tomorrows = pickDay(recs, infoT);
  metroTimetable.last = { info, infoT, stored: !!stored };
  const now = nowMin() < 180 ? nowMin() + 1440 : nowMin();
  const build = list => { const byKey = {};
  for (const r of list) {
    const dest = zh(r.DestinationStaionName) || zh(r.DestinationStationName) || `方向${r.Direction ?? "?"}`;
    const line = r.LineID || r.LineNO || lineOf(st.op, r.StationID);
    const dir = r.Direction ?? null;
    const k = dest + "|" + line + "|" + dir;
    const set = byKey[k] = byKey[k] || { dest, destId: r.DestinationStationID || null, line, dir, times: new Set() };
    for (const t of (r.Timetables || [])) { const x = hm(t.DepartureTime || t.ArrivalTime); if (x) set.times.add(x); }
  }
  return byKey; };
  const byKey = build(todays), byKeyT = build(tomorrows);
  const trains = [];
  // 同一終點有兩個方向（環狀線）時補上方向；高雄輕軌 Direction 0 = 逆行、1 = 順行（已對照即時看板）
  const dirsOf = {};
  for (const g of Object.values(byKey)) (dirsOf[g.dest + "|" + g.line] = dirsOf[g.dest + "|" + g.line] || new Set()).add(g.dir);
  for (const g of Object.values(byKey)) {
    if (dirsOf[g.dest + "|" + g.line].size > 1) g.via = st.op === "KLRT" ? (g.dir === 1 ? "順行" : "逆行") : `方向${g.dir}`;
    const ts = [...g.times].map(x => ({ x, t: toMin(x) < 180 ? toMin(x) + 1440 : toMin(x) })).sort((a, b) => a.t - b.t);
    let up = ts.filter(o => o.t >= now);
    if (!up.length && all) {                                                   // 今日已收班：列出明日（依明日營運日）班次
      const gT = byKeyT[g.dest + "|" + g.line + "|" + g.dir] || g;
      up = [...gT.times].map(x => ({ x, t: (toMin(x) < 180 ? toMin(x) + 1440 : toMin(x)) + 1440 })).sort((a, b) => a.t - b.t);
    }
    up.slice(0, all ? 999 : 3)
      .forEach(o => trains.push({ time: o.x, t: o.t, dest: g.dest, destId: g.destId, dir: g.dir, line: g.line, via: g.via || null, eta: o.t - now }));
  }
  trains.sort((a, b) => a.t - b.t);
  return trains;
}

// 依方向分組：台鐵用 Direction（0順行、1逆行）；高鐵（0南下、1北上）；捷運／輕軌用終點站（往 X）
// 回傳 [{ label, trains }]，組內依時間排序；沒有班次的組放最後（介面不顯示）；每組最多8班
function groupTrains(kind, a, b) {
  const ids = b === undefined ? [] : a, trains = b === undefined ? a : b;
  const per = kind === "metro" ? 8 : 999, key = t => t.t ?? t.eta ?? 9999;
  let groups;
  if (kind === "tra" || kind === "thsr") {
    groups = kind === "tra" ? [{ label: "順行", dir: 0, trains: [] }, { label: "逆行", dir: 1, trains: [] }] : [{ label: "南下", dir: 0, trains: [] }, { label: "北上", dir: 1, trains: [] }];
    const other = { label: "其他", dir: null, trains: [] };
    for (const t of trains) (t.dir === 0 || t.dir === "0" ? groups[0] : t.dir === 1 || t.dir === "1" ? groups[1] : other).trains.push(t);
    if (other.trains.length) groups.push(other);
  } else {
    // 同一條線依行車方向分組：先看 TDX Direction，否則比較終點與本站在該線的站序
    const m = new Map();
    const here = new Set((ids || []).map(i => String(i).toUpperCase()));
    for (const t of trains.slice().sort((x, y) => key(x) - key(y))) {
      if (t.destId && here.has(String(t.destId).toUpperCase())) continue;   // 終點就是本站
      const side = metroSide(t, ids);
      const k = (t.line || "") + "|" + (side ?? ("x" + t.dest)) + "|" + (t.via || "");
      if (!m.has(k)) m.set(k, { line: t.line || null, side, via: t.via || null, dests: [], trains: [] });
      const g = m.get(k); g.trains.push(t); if (t.dest && !g.dests.includes(t.dest)) g.dests.push(t.dest);
    }
    groups = [...m.values()].map(g => ({ label: "往 " + (g.dests.join("／") || "?") + (g.via ? `（${g.via}）` : ""), line: g.line, side: g.side, trains: g.trains }));
  }
  for (const g of groups) g.trains = g.trains.slice().sort((a, b) => key(a) - key(b)).slice(0, per);
  const first = g => g.trains.length ? key(g.trains[0]) : Infinity;
  return kind === "metro" ? groups.sort((a, b) => first(a) - first(b)) : groups.sort((a, b) => (a.trains.length ? 0 : 1) - (b.trains.length ? 0 : 1));
}

// 站序：BL12→12、G03A→3.5、R22A→22.5；轉乘站的終點代碼可能屬於另一條線（如大安 BR09 = R05）
const STN_ALIAS = { OT1: { O: "O15" }, RK1: { R: "R25" }, BR09: { R: "R05" }, R05: { BR: "BR09" }, BR24: { BL: "BL23" }, BL23: { BR: "BR24" }, BL12: { R: "R10" }, R10: { BL: "BL12" },
  BL11: { G: "G12" }, G12: { BL: "BL11" }, G09: { O: "O05" }, O05: { G: "G09" }, R08: { G: "G10" }, G10: { R: "R08" }, R07: { O: "O06" }, O06: { R: "R07" },
  BL14: { O: "O07" }, O07: { BL: "BL14" }, G15: { O: "O08" }, O08: { G: "G15" }, R13: { O: "O11" }, O11: { R: "R13" }, BR11: { G: "G16" }, G16: { BR: "BR11" },
  BL15: { BR: "BR10" }, BR10: { BL: "BL15" }, G04: { Y: "Y07" }, Y07: { G: "G04" }, O17: { Y: "Y18" }, Y18: { O: "O17" }, BL07: { Y: "Y16" }, Y16: { BL: "BL07" },
  O02: { Y: "Y11" }, Y11: { O: "O02" }, R11: { G: "G14" }, G14: { R: "R11" } };
const stnPre = id => (/^[A-Z]+/.exec(id || "") || [""])[0];
const stnNum = id => { const m = /^[A-Z]+(\d+)([A-Z]?)/.exec(id || ""); return m ? +m[1] + (m[2] ? 0.5 : 0) : null; };
function metroSide(t, ids) {
  const byDir = (t.dir === 0 || t.dir === 1 || t.dir === "0" || t.dir === "1") ? "d" + t.dir : null;
  let d = String(t.destId || "").toUpperCase(); if (!d) return byDir;
  const line = t.line || stnPre(d);
  if (stnPre(d) !== line && STN_ALIAS[d] && STN_ALIAS[d][line]) d = STN_ALIAS[d][line];
  const pre = stnPre(d);
  const cur = (ids || []).map(i => String(i).toUpperCase()).flatMap(i => [i, ...Object.values(STN_ALIAS[i] || {})]).find(i => stnPre(i) === pre);
  const a = stnNum(cur), b = stnNum(d);
  if (a == null || b == null || a === b) return byDir;
  return b > a ? "up" : "dn";
}

// 全台車站搜尋：重用永久保存的車站清單；完全找不到時（每天最多一次）重抓各系統清單再搜一次
const normZh = x => String(x || "").replace(/臺/g, "台").toLowerCase();
async function railSearch(p) {
  const q = normZh(p.q).trim(); if (!q) return [];
  let st = (await loadRailStations()).filter(s => normZh(s.name).includes(q));
  if (!st.length && q.length >= 2 && /[\u4e00-\u9fff]/.test(q) && await railHealAll()) st = (await loadRailStations()).filter(s => normZh(s.name).includes(q));
  const lat = p.lat ?? 25.0478, lon = p.lon ?? 121.517;
  return nearestRail(st, lat, lon, { all: true }).map(s => ({ ...s, score: normZh(s.name) === q ? 0 : normZh(s.name).startsWith(q) ? 1 : 2 }))
    .sort((a, b) => a.score - b.score || a.dist - b.dist).slice(0, 60);
}


// ---------- 路線停靠站（捷運／輕軌）與車次停靠站（台鐵／高鐵） ----------
const SOL_KEY = "jisu_sol";
async function stationOfLine(get, op, heal) {   // heal：清單裡找不到要的站，且存了超過一天才重抓
  let c = {}; try { c = JSON.parse(localStorage.getItem(SOL_KEY)) || {}; } catch (e) {}
  const hit = c[op]; if (hit && !(heal && Date.now() - hit.time > DAY_MS)) return hit.lines;
  const list = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/StationOfLine/${op}?%24format=JSON`);
  const lines = (list || []).map(l => ({ line: l.LineID || l.LineNO, st: (l.Stations || []).slice().sort((a, b) => (a.Sequence ?? 0) - (b.Sequence ?? 0)).map(x => [x.StationID, zh(x.StationName) || x.StationID]) }));
  if (lines.length) { c[op] = { time: Date.now(), lines }; try { localStorage.setItem(SOL_KEY, JSON.stringify(c)); } catch (e) {} }
  return lines;
}
// 依站序串成路網：帶字尾的支線站（G03A、R22A）若前一站不是本站則接到本站；蘆洲支線 O50接大橋頭 O12；高雄輕軌是環狀
const LINE_BRANCH = { TRTC: { O50: "O12" } };
function lineGraph(op, st) {
  const adj = {}; const link = (a, b) => { (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a); };
  st.forEach(([id]) => adj[id] = adj[id] || new Set());
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1][0], b = st[i][0];
    const br = (LINE_BRANCH[op] || {})[b], m = /^([A-Z]+\d+)[A-Za-z]$/.exec(b);
    const baseIdx = m ? st.findIndex(x => x[0] === m[1]) : -1;
    if (br) link(br, b);
    else if (m && a !== m[1] && baseIdx >= 0 && baseIdx < i - 1) link(m[1], b);   // 支線站列在最後（G03A 接 G03）
    else link(a, b);
  }
  if (op === "KLRT" && st.length > 2) link(st[0][0], st[st.length - 1][0]);
  return adj;
}
function bfs(adj, a, b) {
  const prev = { [a]: null }, q = [a];
  while (q.length) { const x = q.shift(); if (x === b) break; for (const y of adj[x] || []) if (!(y in prev)) { prev[y] = x; q.push(y); } }
  if (!(b in prev)) return null;
  const out = []; for (let x = b; x != null; x = prev[x]) out.unshift(x); return out;
}
const liveCache = {};
async function lineView(get, p) {
  let lines = await stationOfLine(get, p.op);
  const ids = (p.ids || []).map(String);
  const canon = (id, line) => { if (!id) return null; id = String(id).toUpperCase(); if (stnPre(id) !== line && STN_ALIAS[id] && STN_ALIAS[id][line]) return STN_ALIAS[id][line]; return id; };
  const pick = () => lines.find(l => l.line === p.line && l.st.some(x => ids.map(i => canon(i, l.line)).includes(x[0]))) || lines.find(l => l.st.some(x => ids.includes(x[0])));
  let L = pick();
  if (!L) { lines = await stationOfLine(get, p.op, true); L = pick(); }
  if (!L) throw new Error("查無這條路線的車站資料");
  const has = id => L.st.some(x => x[0] === id), nameOf = {}; L.st.forEach(([id, n]) => nameOf[id] = n);
  const cur = ids.map(i => canon(i, L.line)).find(has);
  const adj = lineGraph(p.op, L.st);
  const dests = [...new Set((p.dests || []).map(d => { const c = canon(d.id, L.line); if (c && has(c)) return c; const n = normZh(d.name); const f = L.st.find(x => normZh(x[1]) === n || normZh(x[1]).replace(/站$/, "") === n.replace(/站$/, "")); return f ? f[0] : null; }).filter(Boolean))];
  let order;
  if (p.op === "KLRT") {
    const n = L.st.length, i0 = L.st.findIndex(x => x[0] === cur), fwd = !/逆行/.test(p.via || "");
    order = Array.from({ length: n }, (_, k) => L.st[((fwd ? i0 + k : i0 - k) % n + n) % n][0]);
  } else {
    let target = null, best = -1;
    for (const d of dests) { const pa = bfs(adj, cur, d); if (pa && pa.length > best) { best = pa.length; target = d; } }
    if (!target) { order = L.st.map(x => x[0]); }
    else {
      const terms = Object.keys(adj).filter(k => adj[k].size === 1 && k !== target);
      order = bfs(adj, cur, target);
      for (const t of terms) { const pa = bfs(adj, t, target); if (pa && pa.includes(cur) && pa.length > order.length) order = pa; }
    }
  }
  // 即時：TRTC/環狀線只有本站（看板已有）；其他系統一次抓整個系統的 LiveBoard，算每站最近一班
  const eta = {};
  if (!p.noLive && p.op !== "TRTC" && p.op !== "NTMC" && p.op !== "TMRT") {
    try {
      const k = p.op; let rows = liveCache[k] && Date.now() - liveCache[k].t < 20000 ? liveCache[k].rows : null;
      if (!rows) { rows = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/LiveBoard/${p.op}?%24format=JSON`); liveCache[k] = { t: Date.now(), rows }; railHeal(p.op, rows.flatMap(r => [r.StationID, r.DestinationStationID])); }
      const isSec = rows.some(r => r.EstimateTime > 120), want = new Set(dests);
      for (const r of rows) {
        if (typeof r.EstimateTime !== "number") continue;
        if (p.op === "KLRT") { const v = (/(順行|逆行)/.exec(zh(r.TripHeadSign) || "") || [])[1]; if (p.via && v && v !== p.via) continue; }
        else if (want.size && !want.has(canon(r.DestinationStationID, L.line))) continue;
        const m = isSec ? Math.floor(r.EstimateTime / 60) : r.EstimateTime, id = r.StationID;
        if (eta[id] == null || m < eta[id]) eta[id] = m;
      }
    } catch (e) { if (isRate(e)) throw e; }
  }
  { const v = Object.values(eta); if (v.length > 4 && v.filter(x => x === 0).length > v.length / 2) for (const k in eta) delete eta[k]; }   // 收班後看板全是0：不顯示
  const liveAll = Object.keys(eta).length > 0;
  if (p.curEta != null && cur && eta[cur] == null) eta[cur] = p.curEta;
  const ci = order.indexOf(cur);
  return { op: p.op, line: L.line, label: p.label || null, live: liveAll,
    stops: order.map((id, i) => ({ id, name: nameOf[id] || id, here: id === cur, past: ci >= 0 && i < ci, eta: eta[id] ?? null })) };
}
const S2S_KEY = "jisu_s2s";
async function s2sEdges(get, op) {
  let c = {}; try { c = JSON.parse(localStorage.getItem(S2S_KEY)) || {}; } catch (e) {}
  const hit = c[op]; if (hit && (Object.keys(hit.e).length || Date.now() - hit.time < DAY_MS)) return hit.e;   // 有資料就永久；空的明天再試
  const e = {};
  try {
    const list = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/S2STravelTime/${op}?%24format=JSON`);
    for (const r of Array.isArray(list) ? list : []) for (const x of (r.TravelTimes || [])) {
      const sec = (x.RunTime || 0) + (x.StopTime || 0); if (!sec) continue;
      for (const k of [x.FromStationID + "|" + x.ToStationID, x.ToStationID + "|" + x.FromStationID]) if (!e[k]) e[k] = sec;
    }
  } catch (err) { if (isRate(err)) throw err; }
  c[op] = { time: Date.now(), e }; try { localStorage.setItem(S2S_KEY, JSON.stringify(c)); } catch (err) {}
  return e;
}
// 單一班次停靠站時間：本站發車時間 ± TDX 站間行駛時間（S2STravelTime）；沒有站間資料的系統以每站約2分推估
// 從 KV 的 TRIPS_系統 找這一班車（同線、同終點、今天的日別、本站時刻相同）
async function tripOfficial(p) {
  const T = await ttLoad("TRIPS_" + p.op).catch(() => null); if (!T || !T.trips || p.t == null) return null;
  const info = await dayInfo(svcDate(p.t >= 1700 ? 1 : 0));   // 收班後列出的是明天的班次（t 已加1440）
  const ids = new Set(p.ids || []), destId = p.dests && p.dests[0] && p.dests[0].id;
  let gs = T.groups.map((g, i) => ({ g, i })).filter(x => (!p.line || x.g.l === p.line) && (!destId || x.g.de === destId) && x.g.st.some(id => ids.has(id)));
  const recs = [...new Set(gs.map(x => x.g.sd))].map(sd => ({ sd, ServiceDay: { ...sdObj(T.sd[sd].m), ServiceTag: T.sd[sd].tag } }));
  const pick = new Set(pickDay(recs, info).map(r => r.sd)); gs = gs.filter(x => pick.has(x.g.sd));
  const gset = new Map(gs.map(x => [x.i, x.g])), want = t2m(m2t(p.t));
  let best = null;
  for (const tr of T.trips) {
    const g = gset.get(tr[0]); if (!g) continue;
    for (const part of tr[1].split(" ")) {
      const est = part[0] === "~", [si, hh] = (est ? part.slice(1) : part).split(".");
      if (est || !ids.has(g.st[si])) continue;
      const d = Math.abs(t2m(hh) - want);
      if (d <= 1 && (!best || d < best.d)) best = { d, g, tr };
    }
    if (best && best.d === 0) break;
  }
  if (!best) return null;
  const times = {}, seq = []; let first = null;
  for (const part of best.tr[1].split(" ")) { const est = part[0] === "~", [si, hh] = (est ? part.slice(1) : part).split("."); const id = best.g.st[si]; if (!first) first = id; times[id] = { time: hh.slice(0, 2) + ":" + hh.slice(2), est }; seq.push(id); }
  return { times, seq, first, sure: !!best.tr[2], dest: best.g.dn };
}
async function tripView(get, p) {
  const lv = await lineView(get, { ...p, noLive: true });
  const E = await s2sEdges(get, p.op);
  const st = lv.stops, ci = Math.max(0, st.findIndex(x => x.here));
  const T = new Array(st.length); T[ci] = p.t + (p.delay || 0);
  let miss = 0;
  const gap = (a, b) => { const v = E[a + "|" + b]; if (v) return v / 60; miss++; return 2; };
  for (let i = ci + 1; i < st.length; i++) T[i] = T[i - 1] + gap(st[i - 1].id, st[i].id);
  for (let i = ci - 1; i >= 0; i--) T[i] = T[i + 1] - gap(st[i].id, st[i + 1].id);
  const clock = m => { m = Math.round(m); m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  const base = { op: p.op, line: lv.line, approx: miss > 0, noS2S: !Object.keys(E).length, delay: p.delay || 0 };
  // 有串好的官方車次（中捷除外）：各站用官方時刻；不在這班車行經範圍的站不給時間；其餘站推估並標 ≈
  const off = p.op !== "TMRT" && !p.est ? await tripOfficial(p).catch(() => null) : null;
  if (off && off.sure) {
    // 直接用官方車次的站序（支線、短程車都正確，例如淡海往漁人碼頭）；起站之前的站不列
    const nm = {}; for (const x of st) nm[x.id] = x.name;
    try { for (const r of await loadRailStations()) if (r.op === p.op || (r.ids || []).length) for (const id of r.ids || [r.id]) if (!nm[id]) nm[id] = r.name; } catch (e) {}
    const here = new Set(p.ids || []);
    const stops = off.seq.map(id => ({ id, name: nm[id] || id, here: here.has(id), time: off.times[id].time, est: off.times[id].est }));
    return { ...base, official: true, dest: off.dest, nEst: stops.filter(x => x.est).length, stops };
  }
  if (off && off.sure) {
    const fi = st.findIndex(x => x.id === off.first);
    let nEst = 0;
    const stops = st.map((x, i) => {
      const o = off.times[x.id];
      if (o) { if (o.est) nEst++; return { ...x, time: o.time, est: o.est }; }
      if (fi >= 0 && i < fi) return { ...x, time: "", before: true };
      nEst++; return { ...x, time: clock(T[i]), est: true };
    });
    return { ...base, official: true, dest: off.dest, nEst, stops };
  }
  return { ...base, stops: st.map((x, i) => ({ ...x, time: clock(T[i]) })) };
}
async function trainView(get, p) {
  const no = String(p.no), here = new Set((p.ids || []).map(String));
  let stops = [], info = {}, delay = null, pos = null;
  const stT = await ttLoad(p.kind === "tra" ? "TRA" : "THSR").catch(() => null);
  const sT = stT && stT.trains && stT.trains.find(t => t[0] === no || t[0] === no.replace(/^0+/, ""));
  if (sT) {
    const nameOf = {}; try { for (const s of await loadRailStations()) if (s.op === (p.kind === "tra" ? "TRA" : "THSR")) nameOf[s.id] = s.name; } catch (e) {}
    info = { type: sT[1], from: sT[3], to: sT[4] };
    stops = sT[6].split(";").map(x => { const [id, a, d] = x.split(","); return { id, name: nameOf[id] || id, arr: hhmm4(a), dep: hhmm4(d) }; });
    if (p.kind === "tra") { try { const lv = await traAllLive(); const b = lv.find(x => String(x.TrainNo) === no); if (b) { delay = b.DelayTime ?? null; pos = { id: b.StationID, status: b.TrainStationStatus }; } } catch (e) { if (isRate(e)) throw e; } }
  } else if (p.kind === "tra") {
    const [tt, lv] = await Promise.allSettled([
      get("rail", `${RAIL_BASE}/v3/Rail/TRA/DailyTrainTimetable/Today/TrainNo/${encodeURIComponent(no)}?%24format=JSON`),
      traAllLive().then(l => l.filter(x => String(x.TrainNo) === no))]);
    if (tt.status !== "fulfilled") throw tt.reason;
    const T = (tt.value.TrainTimetables || tt.value || [])[0]; if (!T) throw new Error("查無這個車次今日的時刻");
    info = { type: shortType(zh(T.TrainInfo.TrainTypeName)), from: zh(T.TrainInfo.StartingStationName), to: zh(T.TrainInfo.EndingStationName) };
    stops = (T.StopTimes || []).map(x => ({ id: x.StationID, name: zh(x.StationName), arr: hm(x.ArrivalTime), dep: hm(x.DepartureTime) }));
    if (lv.status === "fulfilled") { const b = (lv.value.TrainLiveBoards || lv.value || [])[0]; if (b) { delay = b.DelayTime ?? null; pos = { id: b.StationID, status: b.TrainStationStatus }; } }
  } else {
    const r = await get("rail", `${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/Today/TrainNo/${encodeURIComponent(no)}?%24format=JSON`);
    const T = (r || [])[0]; if (!T) throw new Error("查無這個車次今日的時刻");
    info = { type: "高鐵", from: zh(T.DailyTrainInfo.StartingStationName), to: zh(T.DailyTrainInfo.EndingStationName) };
    stops = (T.StopTimes || []).map(x => ({ id: x.StationID, name: zh(x.StationName), arr: hm(x.ArrivalTime), dep: hm(x.DepartureTime) }));
  }
  const ci = stops.findIndex(s => here.has(String(s.id)));
  return { kind: p.kind, no, ...info, delay, pos, stops: stops.map((s, i) => ({ ...s, here: i === ci, at: pos && pos.id === s.id })) };
}

// ---------- 台中捷運：TDX 沒有即時與站別時刻表，用班距＋首末班推估 ----------
const TMRT_KEY = "jisu_tmrt";
async function loadTmrt(get) {
  const stored = await ttLoad("TMRT").catch(() => null); if (stored && stored.freq) return stored;
  try { const c = JSON.parse(localStorage.getItem(TMRT_KEY)); if (c && Date.now() - c.time < 86400000 && c.freq && c.fl) return c; } catch (e) {}
  const [freq, fl] = await Promise.all([
    get("rail", `${RAIL_BASE}/v2/Rail/Metro/Frequency/TMRT?%24format=JSON`),
    get("rail", `${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/TMRT?%24format=JSON`),
  ]);
  const c = { time: Date.now(), freq, fl };
  try { localStorage.setItem(TMRT_KEY, JSON.stringify(c)); } catch (e) {}
  return c;
}
const DAY_KEYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function tmrtBoard(get, st) {
  const { freq, fl } = await loadTmrt(get);
  const d = new Date();
  let now = nowMin(), day = d.getDay();
  if (now < 180) { now += 1440; day = (day + 6) % 7; }             // 凌晨仍算前一個營運日
  const di = await dayInfo(svcDate(0));
  const dayKey = di.hol ? (freq.some(f => f.ServiceDay && f.ServiceDay.NationalHolidays) ? "NationalHolidays" : "Sunday") : di.key;
  const plan = freq.find(f => f.ServiceDay && f.ServiceDay[dayKey]) || freq[0];
  const bands = ((plan && plan.Headways) || []).map(h => ({ s: toMin(h.StartTime), e: h.EndTime === "24:00" ? 1440 : toMin(h.EndTime), hw: h.MinHeadwayMins || h.MaxHeadwayMins }));
  const hwAt = t => { const x = t % 1440 < 180 ? 1439 : t; const b = bands.find(b => x >= b.s && x < b.e); return b ? b.hw : (bands.length ? bands[bands.length - 1].hw : 10); };
  const clock = m => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const recs = fl.filter(r => st.ids.includes(r.StationID) && (!r.ServiceDay || r.ServiceDay[dayKey] !== false));
  if (!recs.length) return { kind: "metro", live: false, trains: [], groups: [], note: "查無台中捷運首末班資料" };
  const trains = [], lines = [];
  let closed = true, nextFirst = null;
  for (const r of recs) {
    const dest = zh(r.DestinationStationName) || "?";
    const first = toMin(r.FirstTrainTime);
    let last = toMin(r.LastTrainTime); if (last < 180) last += 1440;
    nextFirst = nextFirst === null ? first : Math.min(nextFirst, first);
    const up = [];
    for (let t = first; t <= last && up.length < 3; t += hwAt(t)) if (t >= now) up.push(t);
    if (up.length < 3 && last >= now && !up.includes(last)) up.push(last);   // 末班車一定列入
    if (up.length) closed = false;
    up.forEach(t => trains.push({ time: clock(t), t, eta: t - now, dest, destId: r.DestinationStationID || null, dir: r.Direction ?? null, line: r.LineID || "G", via: null }));
    lines.push(`往${dest}：${up.length ? `約每${hwAt(now)}分一班，` : "今日已收班，"}首班${hm(r.FirstTrainTime)}、末班${hm(r.LastTrainTime)}`);
  }
  trains.sort((a, b) => a.t - b.t);
  const tt = [];
  for (const r of recs) {
    const dest = zh(r.DestinationStationName) || "?", first = toMin(r.FirstTrainTime);
    let last = toMin(r.LastTrainTime); if (last < 180) last += 1440;
    const base = closed ? first : first, from = closed ? -1 : now;
    for (let t = base; t <= last; t += hwAt(t)) if (t >= from) tt.push({ time: clock(t), t, eta: t >= now ? t - now : t + 1440 - now, dest, destId: r.DestinationStationID || null, dir: r.Direction ?? null, line: r.LineID || "G", est: true });
    if (!tt.some(x => x.dest === dest && x.t === last) && last >= from) tt.push({ time: clock(last), t: last, eta: last >= now ? last - now : last + 1440 - now, dest, destId: r.DestinationStationID || null, dir: r.Direction ?? null, line: r.LineID || "G", est: true, lastTrain: true });
  }
  tt.sort((a, b) => a.t - b.t);
  { const fix = await destFixer("TMRT"); tt.forEach((t, i) => { tt[i] = fix(t); tt[i].side = metroSide(tt[i], st.ids); }); }
  const note = null;   // 估算方式寫在設定頁「資料來源」；收班後列出的是明日班次（列上標「明日」）
  return { kind: "metro", live: false, trains, groups: groupTrains("metro", st.ids, trains), note, tt, ttKind: "estimate", ttTomorrow: closed };
}

async function railBoard(get, st) {
  if (st.op === "TMRT") return tmrtBoard(get, st);
  if (st.kind === "tra" || st.op === "TRA") return traBoard(get, st);
  if (st.kind === "thsr" || st.op === "THSR") return thsrBoard(get, st);
  return metroBoard(get, st);
}

function loadRailCache() { try { const c = JSON.parse(localStorage.getItem(RAIL_KEY)); if (c && c.systems) return c; } catch (e) {} return { systems: {} }; }
async function loadRailStations() {
  const cache = loadRailCache(), now = Date.now();
  let rateErr = null;
  const todo = RAIL_SYSTEMS.filter(s => { const c = cache.systems[s.key]; return !(c && c.stations && c.stations.length); });   // 永久：只補還沒有的系統
  for (let i = 0; i < todo.length; i += 3) {           // 一次3個系統，避免限流
    await Promise.all(todo.slice(i, i + 3).map(async s => {
      try {
        const st = mapRailStations(await tdx("rail", s.url), s);
        if (st.length) cache.systems[s.key] = { time: now, stations: st };
      } catch (e) { if (isRate(e)) rateErr = e; }
    }));
  }
  if (todo.length) { try { localStorage.setItem(RAIL_KEY, JSON.stringify(cache)); } catch (e) {} }
  const all = Object.values(cache.systems).flatMap(s => s.stations);
  if (!all.length) throw (rateErr || new Error("車站清單讀取失敗"));
  return all;
}

function loadExitCache() { try { const c = JSON.parse(localStorage.getItem(EXIT_KEY)); if (c && c.systems) return c; } catch (e) {} return { systems: {} }; }
async function loadRailExits() {
  const cache = loadExitCache(), now = Date.now();
  const metros = RAIL_SYSTEMS.filter(s => s.kind === "metro" && !s.optional);
  const todo = metros.filter(s => { const c = cache.systems[s.key]; return !(c && (Object.keys(c.exits || {}).length || now - c.time < DAY_MS)); });   // 有資料就永久；空的／失敗的明天再試
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async s => {
      try {
        const list = await tdx("rail", `${RAIL_BASE}/v2/Rail/Metro/StationExit/${s.key}?%24top=3000&%24format=JSON`);
        cache.systems[s.key] = { time: now, exits: mapExits(list, s.key) };
      } catch (e) { if (!isRate(e)) cache.systems[s.key] = { time: now, exits: {} }; } // 失敗的明天再試；限流的下次開啟就重試
    }));
  }
  if (todo.length) { try { localStorage.setItem(EXIT_KEY, JSON.stringify(cache)); } catch (e) {} }
  return Object.assign({}, ...Object.values(cache.systems).map(s => s.exits || {}));
}

// ---------- 永久清單的自動補救（v2.12.6）：和站牌／YouBike 同一套規則 ----------
// 即時資料、搜尋、點進路線時出現清單沒有的站／路線，且這份清單存了超過一天 → 只重抓那一份（帶 __fresh=1，Worker 端同一份每天最多略過快取一次並覆寫 KV）
// 重抓後還是找不到的代碼（號誌站、資料不一致）記在 ign，之後不再觸發；失敗也記時間，明天再試
const healBusy = {};
const newMiss = (ids, have, ign) => [...new Set(ids.filter(Boolean).map(String))].filter(i => !have.has(i) && !ign.has(i));
function railHeal(op, ids) { railHealA(op, ids || []).catch(() => {}); }
async function railHealA(op, ids, force) {
  const sys = RAIL_SYSTEMS.find(s => s.key === op), k = "rail|" + op;
  if (!sys || healBusy[k]) return false;
  const c = loadRailCache().systems[op]; if (!c || !c.stations || Date.now() - c.time < DAY_MS) return false;
  const ign = new Set(c.ign || []), miss = force ? [] : newMiss(ids, new Set(c.stations.map(s => s.id)), ign);
  if (!force && !miss.length) return false;
  healBusy[k] = true;
  let ok = false, st = null;
  try { st = mapRailStations(await tdx("rail", sys.url + FRESH), sys); ok = st.length > 0; } catch (e) {}
  const cache = loadRailCache(), have = new Set((ok ? st : c.stations).map(s => s.id));
  cache.systems[op] = { time: Date.now(), stations: ok ? st : c.stations, ign: [...ign, ...miss.filter(i => !have.has(i))].slice(-300) };
  try { localStorage.setItem(RAIL_KEY, JSON.stringify(cache)); } catch (e) {}
  delete healBusy[k];
  return ok;
}
// 車站搜尋完全找不到：每天最多一次，重抓存了超過一天的系統清單
async function railHealAll() {
  const HK = "jisu_rail_heal_q";
  if (Date.now() - (+localStorage.getItem(HK) || 0) < DAY_MS) return false;
  localStorage.setItem(HK, String(Date.now()));
  let any = false;
  for (let i = 0; i < RAIL_SYSTEMS.length; i += 3) {
    const r = await Promise.all(RAIL_SYSTEMS.slice(i, i + 3).map(s => railHealA(s.key, [], true).catch(() => false)));
    any = any || r.some(Boolean);
  }
  return any;
}
// 附近捷運站沒有出口資料：重抓那個系統的出口清單
function exitHeal(near) { exitHealA(near || []).catch(() => {}); }
async function exitHealA(near) {
  const metros = new Set(RAIL_SYSTEMS.filter(s => s.kind === "metro" && !s.optional).map(s => s.key));
  const want = {};
  for (const s of near) if (metros.has(s.op) && !s.exit) (want[s.op] = want[s.op] || []).push(...(s.ids || [s.id]));
  for (const [op, ids] of Object.entries(want)) {
    const k = "exit|" + op; if (healBusy[k]) continue;
    const c = loadExitCache().systems[op];
    if (!c || !Object.keys(c.exits || {}).length || Date.now() - c.time < DAY_MS) continue;   // 整個系統沒有出口資料的不重抓（由 loadRailExits 每天重試）
    const have = new Set(Object.keys(c.exits).map(x => x.split("|")[1])), ign = new Set(c.ign || []), miss = newMiss(ids, have, ign);
    if (!miss.length) continue;
    healBusy[k] = true;
    let ex = null;
    try { ex = mapExits(await tdx("rail", `${RAIL_BASE}/v2/Rail/Metro/StationExit/${op}?%24top=3000&%24format=JSON` + FRESH), op); } catch (e) {}
    const ok = ex && Object.keys(ex).length, cache = loadExitCache(), got = new Set(Object.keys(ok ? ex : c.exits).map(x => x.split("|")[1]));
    cache.systems[op] = { time: Date.now(), exits: ok ? ex : c.exits, ign: [...ign, ...miss.filter(i => !got.has(i))].slice(-300) };
    try { localStorage.setItem(EXIT_KEY, JSON.stringify(cache)); } catch (e) {}
    delete healBusy[k];
  }
}

// ---------- 設定 / 收藏 ----------
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s) return s; } catch (e) {}
  return { settings: { busR: 300, bikeR: 500, railWalk: 1.5, railFar: 1, railSys: null, auto: 30 }, favs: { bus: [], bike: [] } };
}

// 全台公車路線索引：各縣市 + 公路客運，永久保存在 IndexedDB busidx（v2.12.6）；失敗的縣市下次再補
// ct＝各縣市清單的抓取時間；出現清單沒有的路線時由 busHeal 重抓那個縣市（每天最多一次）
let idxLoading = null, idxMem = null;
async function busIndex() {
  let c = idxMem || await IDB.get("busidx");
  if (!c || !c.cities) c = { time: Date.now(), cities: {} };
  c.ct = c.ct || {}; c.ign = c.ign || {};
  idxMem = c;
  const all = [...Object.values(UID_CITY), "InterCity"];
  const todo = all.filter(x => !c.cities[x]);
  if (todo.length && !idxLoading) {
    idxLoading = (async () => {
      const proxy = getProxy(); if (!proxy) return;
      for (let i = 0; i < todo.length; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async city => {
          try { const r = await fetch(`${proxy}/bus/routes?c=${city}`); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) { c.cities[city] = j; c.ct[city] = Date.now(); } } } catch (e) {}
        }));
        await sleep(300);
      }
      await IDB.set("busidx", c).catch(() => {});
    })().finally(() => { idxLoading = null; });
    await idxLoading;
  } else if (idxLoading) await idxLoading;
  return { cities: c.cities, missing: all.filter(x => !c.cities[x]) };
}
// uids：即時資料或點進去的 RouteUID；cities：搜尋完全找不到時要重抓的縣市。只檢查已下載的縣市
function busHeal(uids, cities) { return busHealA(uids || [], cities || []).catch(() => false); }
async function busHealA(uids, cities) {
  const c = idxMem || await IDB.get("busidx"); if (!c || !c.cities) return false;
  c.ct = c.ct || {}; c.ign = c.ign || {}; idxMem = c;
  const want = {};
  for (const u of uids) { const k = routeKind(u); if (k) (want[k.kind === "intercity" ? "InterCity" : k.city] = want[k.kind === "intercity" ? "InterCity" : k.city] || []).push(u); }
  for (const city of cities) want[city] = want[city] || [];
  const proxy = getProxy(); let changed = false, touched = false;
  for (const [city, ids] of Object.entries(want)) {
    const list = c.cities[city], k = "bus|" + city;
    if (!list || healBusy[k] || !proxy || Date.now() - (c.ct[city] || c.time || 0) < DAY_MS) continue;
    const ign = new Set(c.ign[city] || []), miss = newMiss(ids, new Set(list.map(r => r[0])), ign);
    if (!miss.length && !cities.includes(city)) continue;
    healBusy[k] = true; touched = true;
    try {
      const r = await fetch(`${proxy}/bus/routes?c=${city}&fresh=1`);
      if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) { c.cities[city] = j; changed = true; } }
    } catch (e) {}
    const have = new Set(c.cities[city].map(r => r[0]));
    c.ign[city] = [...ign, ...miss.filter(u => !have.has(u))].slice(-300);
    c.ct[city] = Date.now();
    delete healBusy[k];
  }
  if (touched) await IDB.set("busidx", c).catch(() => {});
  return changed;
}

// ---------- 全市站牌／YouBike 站點名單（搜尋用）：只抓所在縣市，永久保存 ----------
// 站牌：同名且相距300公尺內的併成一筆 [名稱, 緯度, 經度, 半徑]；YouBike：[UID, 名稱, 地址, 緯度, 經度, 柱數, 類型]
// ts／tb＝站牌／YouBike 抓取時間；最多保留3個縣市（LRU）。即時資料出現名單沒有的站名／站點，且名單超過一天 → 只重抓那一份
const placeJobs = {}, placeMem = {}, placeSets = {}, healing = {};
const r5 = x => Math.round(x * 1e5) / 1e5;
async function placeLoad(city) {   // IndexedDB place|縣市；不限縣市數
  if (placeMem[city] !== undefined) return placeMem[city];
  const c = await IDB.get("place|" + city);
  if (c && !c.ts) { c.ts = c.tb = c.t; }   // v2.12.0 舊格式
  return placeMem[city] = c && c.stops ? c : null;
}
function placeSave(c) {
  placeMem[c.city] = c; delete placeSets[c.city];
  IDB.set("place|" + c.city, c).catch(() => {});
}
async function placeStops(city, heal) {
  const l = await tdx("main", `${BASE}/basic/v2/Bus/Stop/City/${city}?%24select=${enc("StopUID,StopName,StopPosition,Bearing,StationID")}&%24top=30000&%24format=JSON` + (heal ? FRESH : ""));
  const byName = {}, stops = [];
  for (const x of l) {
    const n = x.StopName && x.StopName.Zh_tw, p = x.StopPosition; if (!n || !p || !p.PositionLat) continue;
    const arr = byName[n] = byName[n] || [];
    let g = arr.find(g => haversine(g.lat, g.lon, p.PositionLat, p.PositionLon) <= 300);
    if (!g) arr.push(g = { lat: p.PositionLat, lon: p.PositionLon, pts: [] });
    g.pts.push([p.PositionLat, p.PositionLon]);
  }
  for (const [n, arr] of Object.entries(byName)) for (const g of arr) {
    const la = g.pts.reduce((a, q) => a + q[0], 0) / g.pts.length, lo = g.pts.reduce((a, q) => a + q[1], 0) / g.pts.length;
    stops.push([n, r5(la), r5(lo), Math.round(Math.max(...g.pts.map(q => haversine(la, lo, q[0], q[1]))))]);
  }
  return stops;
}
async function placeBikes(city, heal) {
  const l = await tdx("route", `${BASE}/basic/v2/Bike/Station/City/${city}?%24select=${enc("StationUID,StationName,StationAddress,StationPosition,BikesCapacity,ServiceType")}&%24top=5000&%24format=JSON` + (heal ? FRESH : ""));
  return l.filter(x => x.StationPosition).map(x => [x.StationUID, ((x.StationName && x.StationName.Zh_tw) || "").replace(/^YouBike[12]\.0_/, ""),
    (x.StationAddress && x.StationAddress.Zh_tw) || "", r5(x.StationPosition.PositionLat), r5(x.StationPosition.PositionLon), x.BikesCapacity ?? null, x.ServiceType ?? null]);
}
async function placeIndex({ city }) {
  if (!city || !UID_CITY_SET.has(city)) return null;
  const c0 = await placeLoad(city); if (c0) return c0;
  if (placeJobs[city]) return placeJobs[city];
  return placeJobs[city] = (async () => {
    const [st, bk] = await Promise.allSettled([placeStops(city, false), placeBikes(city, false)]);
    if (st.status === "rejected" && bk.status === "rejected") throw st.reason;
    const now = Date.now();
    const c = { t: now, ts: now, tb: now, city, stops: st.status === "fulfilled" ? st.value : [], bikes: bk.status === "fulfilled" ? bk.value : [],
      part: st.status === "rejected" || bk.status === "rejected" };
    if (!c.part) placeSave(c);
    return c;
  })().finally(() => { delete placeJobs[city]; });
}
// 自動補救：stops＝[{ uid, name }]（即時預估裡的站牌）、bikes＝[StationUID]；只檢查已存名單的縣市
function placeHeal(stops, bikes) { placeHealA(stops, bikes).catch(() => {}); }
async function placeHealA(stops = [], bikes = []) {
  const want = {};
  for (const x of stops) { const city = UID_CITY[(x.uid || "").slice(0, 3)]; if (city && x.name) (want[city] = want[city] || { s: new Set(), b: new Set() }).s.add(x.name); }
  for (const u of bikes) { const city = UID_CITY[(u || "").slice(0, 3)]; if (city) (want[city] = want[city] || { s: new Set(), b: new Set() }).b.add(u); }
  for (const [city, w] of Object.entries(want)) {
    const c = await placeLoad(city); if (!c) continue;
    const S = placeSets[city] = placeSets[city] || { s: new Set(c.stops.map(x => x[0])), b: new Set(c.bikes.map(x => x[0])) };
    const now = Date.now();
    const needS = now - c.ts > DAY_MS && [...w.s].some(n => !S.s.has(n));
    const needB = now - c.tb > DAY_MS && [...w.b].some(u => !S.b.has(u));
    for (const [need, kind] of [[needS, "s"], [needB, "b"]]) {
      if (!need || healing[city + kind]) continue;
      healing[city + kind] = true;
      (kind === "s" ? placeStops(city, true) : placeBikes(city, true)).then(l => {
        const cur = placeMem[city] || c;
        if (kind === "s") { cur.stops = l; cur.ts = Date.now(); } else { cur.bikes = l; cur.tb = Date.now(); }
        placeSave(cur);
      }).catch(() => {
        // 失敗也記時間，明天再試，避免一直重抓
        const cur = placeMem[city] || c; if (kind === "s") cur.ts = Date.now(); else cur.tb = Date.now(); placeSave(cur);
      }).finally(() => { delete healing[city + kind]; });
    }
  }
}
const UID_CITY_SET = new Set(Object.values(UID_CITY));

// 搜尋結果點進去：用站牌位置查一次附近預估到站（Worker 共用快取20秒），只留同名站牌
async function stopAt({ name, lat, lon, r = 0, uLat = null, uLon = null }) {
  const rad = Math.min(Math.max(r + 60, 80), 400);
  const eta = await tdx("main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat.toFixed(4), lon.toFixed(4), rad)}&%24top=400&%24format=JSON`);
  try { placeHeal(eta.map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw }))); } catch (e) {}
  const routes = {};
  for (const it of eta) {
    if (((it.StopName && it.StopName.Zh_tw) || "") !== name) continue;
    const dirNum = it.Direction === 1 ? 1 : 0, sec = typeof it.EstimateTime === "number" ? it.EstimateTime : null;
    const x = { route: (it.RouteName && it.RouteName.Zh_tw) || "?", routeUID: it.RouteUID || null, dirNum, stopUID: it.StopUID || null, sec, status: it.StopStatus ?? 0, next: it.NextBusTime || null };
    const k = `${x.routeUID}|${dirNum}`, old = routes[k];
    if (!old || (sec !== null && (old.sec === null || sec < old.sec))) routes[k] = x;
  }
  const list = Object.values(routes);
  let destMap = {}; try { destMap = await loadRouteDest("main", list.map(x => x.routeUID)); } catch (e) {}
  for (const x of list) x.dest = destOf(x.routeUID, x.dirNum, destMap);
  return { name, lat, lon, dist: uLat == null ? null : haversine(uLat, uLon, lat, lon), bear: null, side: null, bearTxt: null, routes: list };
}
// YouBike 搜尋結果點進去：只查這一站的車位（90秒內重用）
async function bikeAt({ uid, uLat = null, uLon = null, ...b }) {
  const city = UID_CITY[(uid || "").slice(0, 3)];
  let a = {};
  if (city) { try { a = (await memoTdx("route", `${BASE}/basic/v2/Bike/Availability/City/${city}?%24filter=${enc(`StationUID eq '${uid}'`)}&%24top=5&%24format=JSON`, 90000))[0] || {}; } catch (e) {} }
  if (a.StationUID) try { placeHeal([], [a.StationUID]); } catch (e) {}
  const det = a.AvailableRentBikesDetail || null;
  return { ...b, uid, type: BIKE_TYPE[b.type] || b.type || null, dist: uLat == null ? null : haversine(uLat, uLon, b.lat, b.lon),
    rent: typeof a.AvailableRentBikes === "number" ? a.AvailableRentBikes : null, ret: typeof a.AvailableReturnBikes === "number" ? a.AvailableReturnBikes : null,
    general: det ? det.GeneralBikes ?? null : null, electric: det ? det.ElectricBikes ?? null : null,
    status: typeof a.ServiceStatus === "number" ? a.ServiceStatus : null, update: a.SrcUpdateTime || a.UpdateTime || null };
}

// 推播／下車提醒（Worker 端點）
async function pushCall(method, path, body) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const r = await fetch(proxy + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) throw new Error(j.message || ("錯誤 " + r.status));
  return j;
}

// ---------- 登入（帳號存在 Worker；裝置只存 session token，登出前不必再登入） ----------
// ---------- 路線規劃（v2.13.0）：TDX MaaS routing（經 Worker /plan）＋ OpenStreetMap 地點搜尋（經 Worker /geo） ----------
// MaaS 回傳的路段沒有任何代碼（RouteUID／StationID），所以用「名稱＋座標」對回 App 自己的車站清單與公車路線清單，才能顯示即時到站、點進車站頁／路線頁
async function authedGet(path) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const s = getSession();
  let r, j = null;
  try { r = await fetch(proxy + path, { headers: s ? { "x-session": s.token } : {} }); j = await r.json().catch(() => null); }
  catch (e) { throw new Error("連不到伺服器，請確認網路"); }
  if (!r.ok) { const m = j && (j.message || j.Message); throw new Error(r.status === 401 ? "請重新登入" : m || ("錯誤 " + r.status)); }
  return j;
}
const PLAN_MODE = s => { const m = ((s.transport || {}).mode || "") + " " + ((s.transport || {}).category || "");
  return /bus/i.test(m) ? "bus" : /lrt|light/i.test(m) ? "lrt" : /thsr|hsr|high/i.test(m) ? "thsr" : /mrt|metro|subway/i.test(m) ? "mrt" : /tra|rail|train/i.test(m) ? "tra" : "bus"; };
const pPlace = (p, time) => { const pl = (p && p.place) || {}, loc = pl.location || {}; return { name: pl.name || null, type: pl.type || null, lat: loc.lat ?? null, lon: loc.lng ?? null, time: (p && p.time) || null }; };
const tms = s => s ? Date.parse(s + "+08:00") : null;
// 整理成前端好用的格式；計程車／開車路段一律換成步行（標「約」），沒開 YouBike 時騎車路段也換成步行
function planClean(routes, yb) {
  const out = [];
  for (const r of routes || []) {
    const legs = []; let approx = false;
    for (const s of r.sections || []) {
      const from = pPlace(s.departure), to = pPlace(s.arrival), dur = (s.travelSummary && s.travelSummary.duration) || Math.max(0, (tms(to.time) - tms(from.time)) / 1000) || 0;
      const len = (s.travelSummary && s.travelSummary.length) || 0;
      let kind = s.type === "transit" ? "transit" : s.type === "waiting" ? "wait" : s.type === "cycle" && yb ? "bike" : "walk";
      const fake = s.type === "drive" || (s.type === "cycle" && !yb);
      if (kind === "walk" || kind === "bike") {
        const d = fake || !len ? (from.lat != null && to.lat != null ? haversine(from.lat, from.lon, to.lat, to.lon) * 1.3 : len) : len;
        const leg = { kind, from, to, dur: fake ? Math.round(d / 1.2) : dur, len: Math.round(d), approx: fake };
        if (fake) approx = true;
        const prev = legs[legs.length - 1];
        if (kind === "walk" && prev && prev.kind === "walk") {   // 走到出入口＋進站合成一段，記下出入口名稱
          if (/entrance|exit/.test(prev.to.type || "") && prev.to.name) prev.gate = prev.to.name;
          prev.to = to; prev.dur += leg.dur; prev.len += leg.len; prev.approx = prev.approx || fake; continue;
        }
        if (kind === "walk" && /entrance|exit/.test(to.type || "") && to.name && legs.length && legs[legs.length - 1].kind === "transit") leg.gate = to.name;
        legs.push(leg); continue;
      }
      if (kind === "wait") { legs.push({ kind, from, to, dur }); continue; }
      const t = s.transport || {}, fare = typeof t.fareTW === "number" ? t.fareTW : typeof t.fare === "number" ? t.fare : null;
      legs.push({ kind, mode: PLAN_MODE(s), name: t.shortName || t.name || "", longName: t.longName || "", headsign: t.headsign || "", color: /^[0-9a-f]{6}$/i.test(t.route_color || "") ? "#" + t.route_color.toUpperCase() : null,
        number: t.number || "", agency: (s.agency && s.agency.agency_id) || "", agencyName: (s.agency && s.agency.name) || "", fare, from, to, dur,
        stops: (s.intermediateStops || []).map(x => pPlace(x.departure || x.arrival)) });
    }
    // 換成步行的頭尾段：依公共運輸的時刻往前／往後推，算出新的出發／抵達時間
    const tr = legs.filter(l => l.kind === "transit");
    let start = tms(r.start_time), end = tms(r.end_time);
    if (tr.length) {
      const i0 = legs.indexOf(tr[0]), i1 = legs.indexOf(tr[tr.length - 1]);
      if (legs.slice(0, i0).some(l => l.approx)) start = tms(tr[0].from.time) - legs.slice(0, i0).reduce((a, l) => a + l.dur * 1000, 0);
      if (legs.slice(i1 + 1).some(l => l.approx)) end = tms(tr[tr.length - 1].to.time) + legs.slice(i1 + 1).reduce((a, l) => a + l.dur * 1000, 0);
    } else if (approx) end = start + legs.reduce((a, l) => a + l.dur * 1000, 0);
    const fares = tr.map(l => l.fare), sum = typeof r.total_price === "number" && r.total_price > 0 ? r.total_price : fares.reduce((a, f) => a + (f > 0 ? f : 0), 0);
    const sig = legs.map(l => l.kind === "transit" ? l.name + "@" + l.from.name + ">" + l.to.name + "@" + l.from.time : l.kind).join("|");
    if (out.some(o => o.sig === sig)) continue;   // 同一班車、只差頭尾接駁方式的重複結果
    out.push({ sig, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), fare: sum > 0 ? sum : null, farePartial: sum > 0 && fares.some(f => !(f > 0)), approx, legs });
  }
  return out.filter(r => !r.approx).concat(out.filter(r => r.approx));
}
async function planRoutes({ o, d, modes, gc, yb, when, time }) {
  const q = new URLSearchParams({ o: `${o.lat},${o.lon}`, d: `${d.lat},${d.lon}`, t: modes.join(","), gc: gc ? "1" : "0", yb: yb ? "1" : "0" });
  if (when === "dep" && time) q.set("dep", time); if (when === "arr" && time) q.set("arr", time);
  const long = haversine(o.lat, o.lon, d.lat, d.lon) >= 50000 && (modes.includes(3) || modes.includes(4));
  let out = [], err = null;
  try {
    const j = await authedGet("/plan?" + q.toString());
    if (!j || j.result !== "success") throw new Error((j && (j.message || j.Message)) || "規劃失敗");
    out = planClean(j.data && j.data.routes, yb);
  } catch (e) { if (!long || /登入|頻繁|次數/.test(e.message)) throw e; err = e; }   // 長途：TDX 沒結果時還有自己的台鐵／高鐵規劃
  // 「現在出發」時 TDX 偶爾會給已經開走的班次：同樣路線還有較晚一班的就不列；沒有的保留但標示、排到後面
  if (when === "now") {
    const now = Date.now(), gone = r => { const t = r.legs.find(l => l.kind === "transit"); return !!t && tms(t.from.time) < now - 60000; };
    // 第一段是捷運／輕軌／公車這類班次密的：改搭下一班（往後推「已過的時間＋一個班距」），只要下一段前的等車時間夠吸收就照樣可行
    const HW = { mrt: 6, lrt: 10, bus: 12 };
    out = out.map(r => {
      if (!gone(r)) return r;
      const i0 = r.legs.findIndex(l => l.kind === "transit"), L = r.legs[i0], hw = HW[L.mode]; if (!hw) return r;
      const shift = now - tms(L.from.time) + 60000 + hw * 60000;
      const i1 = r.legs.findIndex((l, k) => k > i0 && l.kind === "transit");
      const waits = i1 < 0 ? [] : r.legs.slice(i0 + 1, i1).filter(l => l.kind === "wait"), slack = waits.reduce((a, l) => a + l.dur * 1000, 0);
      if (i1 >= 0 && slack < shift) return r;
      const mv = t => t && isoTpe(tms(t) + shift), upto = i1 < 0 ? r.legs.length : r.legs.indexOf(waits[0]);
      const legs = r.legs.map((l, k) => k < upto ? { ...l, from: { ...l.from, time: mv(l.from.time) }, to: { ...l.to, time: mv(l.to.time) }, stops: l.stops && l.stops.map(x => ({ ...x, time: mv(x.time) })) } : l);
      if (i1 >= 0) { let left = shift / 1000; for (const w of waits) { const k = legs.indexOf(w), cut = Math.min(w.dur, left); legs[k] = { ...w, dur: w.dur - cut, from: { ...w.from, time: mv(w.from.time) } }; left -= cut; } }
      const start = r.start + shift, end = i1 < 0 ? r.end + shift : r.end;
      return { ...r, legs, start, end, dur: Math.round((end - start) / 60000), shifted: true };
    });
    const ok = out.filter(r => !gone(r)), okShape = new Set(ok.map(planShape));
    out = ok.concat(out.filter(r => gone(r) && !okShape.has(planShape(r))).map(r => ({ ...r, missed: true })));
  }
  // 台鐵／高鐵：依官方時刻表自己規劃（長途），並修補 TDX 路線裡漏班的火車段
  const tra = modes.includes(4), thsr = modes.includes(3);
  if (tra || thsr) {
    const t0 = when === "now" || !time ? Date.now() : tms(time);
    const live = when === "arr" ? null : await rpLive(t0);
    try { await planRepair(out, { tra, thsr, live }); } catch (e) {}
    if (long) { try { out = out.concat(await railPlan({ o, d, when, time, modes, routes: out, live })); } catch (e) { if (!out.length) throw e; } }
  }
  if (!out.length && err && !long) throw err;   // 長途兩邊都沒有（例如深夜）：回傳空清單，畫面顯示「找不到可行的路線」
  // 最快：先到的排前面（指定抵達則是最晚出發的排前面）；最便宜維持 TDX 的順序（自己規劃的排在同時抵達的 TDX 結果之後）
  if (gc) out.sort((a, b) => (!!a.missed - !!b.missed) || (a.approx - b.approx) || (when === "arr" ? b.start - a.start : a.end - b.end) || a.dur - b.dur);
  // 去重：①同一種走法、同時出發又同時抵達 ②搭的是同一班火車／同一時間的車（自己規劃和 TDX 修補後常常一樣）；最多列8條
  const seen = new Set(), real = new Set(out.filter(r => !r.shifted).map(r => planShape(r) + "|" + r.end));
  const tsig = r => r.legs.filter(l => l.kind === "transit").map(l => l.mode + "@" + (l.from.time || "").slice(0, 16) + ">" + (l.to.time || "").slice(0, 16)).join("|");
  return out.filter(r => !(r.shifted && real.has(planShape(r) + "|" + r.end))).filter(r => {
    const k1 = planShape(r) + "|" + r.start + "|" + r.end, k2 = "t|" + tsig(r);
    const rl = r.legs.filter(l => l.kind === "transit" && (l.mode === "tra" || l.mode === "thsr") && l.number), k3 = rl.length ? "r|" + rl[rl.length - 1].mode + rl[rl.length - 1].number + "|" + Math.round(r.end / 120000) : k1;
    if (seen.has(k1) || seen.has(k2) || seen.has(k3)) return false; seen.add(k1); seen.add(k2); seen.add(k3); return true; }).slice(0, 8);
}
// 路線「形狀」：搭哪些車、在哪上下車（不看時間），用來判斷是不是同一種走法
const planShape = r => r.legs.filter(l => l.kind === "transit").map(l => l.name + "@" + l.from.name + ">" + l.to.name).join("|");
const isoTpe = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
// ---------- 自己的台鐵／高鐵長途規劃（v2.14.0）：用 KV 裡的定期時刻表（國定假日改抓 TDX 當日時刻表）跑 CSA 最早抵達搜尋 ----------
// 車站代號：台鐵 "T"+StationID、高鐵 "H"+StationID（兩邊的代號會重複，例如 1000）
const RP_CHG = { T: 5, H: 8 };          // 同一系統換車最少分鐘
const RP_HORIZON = 14 * 60;              // 只找出發後14小時內抵達的
const RP_MAXK = 3;                       // 最多轉乘3次（4班車）
const rpDayMem = {}, rpNetMem = {};
let rpStP = null;
async function rpStations() {
  if (rpStP) return rpStP;
  rpStP = (async () => {
    const all = await railAll(), st = {};
    for (const s of all) if (s.op === "TRA" || s.op === "THSR") st[(s.op === "TRA" ? "T" : "H") + s.id] = { key: (s.op === "TRA" ? "T" : "H") + s.id, op: s.op, id: s.id, name: s.name, lat: s.lat, lon: s.lon };
    // 台鐵↔高鐵：700m 內的站互相轉乘（台北、板橋、南港、新竹／六家、苗栗／豐富、台中／新烏日、台南／沙崙、左營／新左營）；嘉義、彰化離太遠不算
    const T = Object.values(st).filter(s => s.op === "TRA"), H = Object.values(st).filter(s => s.op === "THSR"), links = {};
    for (const h of H) for (const t of T) {
      const d = haversine(h.lat, h.lon, t.lat, t.lon); if (d > 700) continue;
      const m = Math.round(d * 1.3 / 1.2 / 60) + 7;      // 步行＋進出站、買票的緩衝
      (links[h.key] = links[h.key] || []).push([t.key, m]); (links[t.key] = links[t.key] || []).push([h.key, m]);
    }
    return { st, links };
  })().catch(e => { rpStP = null; throw e; });
  return rpStP;
}
const rpMin = hm => { const m = /^(\d\d):?(\d\d)/.exec(hm || ""); return m ? +m[1] * 60 + +m[2] : null; };
const rpIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// 某營運日的所有班次：[{op, no, type, end, stops:[[key, arr, dep]]}]，時間是當天0點起的分鐘（跨午夜會超過1440）
async function rpTrains(op, date) {
  const k = op + "|" + date; if (rpDayMem[k]) return rpDayMem[k];
  return rpDayMem[k] = (async () => {
    const dt = new Date(date + "T12:00:00+08:00"), info = await dayInfo(dt), pre = op === "TRA" ? "T" : "H", ymd = date.replace(/-/g, "");
    const fix = stops => { let last = -1, add = 0; return stops.map(([key, a, d]) => { let A = a, D = d; if (A != null) { if (A + add < last - 360) add += 1440; A += add; last = A; } if (D != null) { if (D + add < last - 360) add += 1440; D += add; last = D; } return [key, A ?? D, D ?? A]; }); };
    const tt = await ttLoad(op).catch(() => null);
    const valid = tt && tt.trains && !info.hol && (op !== "TRA" || ((!tt.eff || tt.eff.slice(0, 10) <= date) && (!tt.exp || tt.exp.slice(0, 10) >= date)));
    if (valid) {
      const ix = SD_KEYS.indexOf(info.key), out = [];
      for (const t of tt.trains) {
        if (t[5][ix] !== "1") continue;
        if (t[7] && t[7].replace(/-/g, "").slice(0, 8) > ymd) continue; if (t[8] && t[8].replace(/-/g, "").slice(0, 8) < ymd) continue;
        out.push({ op, no: t[0], type: t[1], end: t[4], stops: fix(t[6].split(";").filter(Boolean).map(x => { const [id, a, d] = x.split(","); return [pre + id, rpMin(a), rpMin(d)]; })) });
      }
      return { trains: out, src: "kv" };
    }
    // 國定假日（或定期表過期）：抓 TDX 當日時刻表（每天每系統1次，Worker 也會快取）
    const url = op === "TRA" ? `${RAIL_BASE}/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}?%24format=JSON` : `${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/TrainDate/${date}?%24format=JSON`;
    const list = await tdx("rail", url);
    return { trains: list.map(t => { const i = t.TrainInfo || t.DailyTrainInfo || {};
      return { op, no: String(i.TrainNo), type: op === "TRA" ? shortType(zh(i.TrainTypeName)) : "高鐵", end: zh(i.EndingStationName) || "",
        stops: fix((t.StopTimes || []).map(x => [pre + x.StationID, rpMin(x.ArrivalTime), rpMin(x.DepartureTime)])) }; }), src: "daily" };
  })().catch(e => { delete rpDayMem[k]; throw e; });
}
// 連接（connection）清單：從 t0（當天分鐘）起 RP_HORIZON 內出發的，依出發時間排序
async function rpNet(t0ms, opt = {}) {
  const d0 = new Date(t0ms), date = rpIso(d0), base = Date.parse(date + "T00:00:00+08:00"), t0 = Math.floor((t0ms - base) / 60000);
  const k = [date, Math.floor(t0 / 60), opt.tra !== false, opt.thsr !== false, opt.live ? opt.liveKey || 1 : 0].join("|");
  if (!rpNetMem[k]) rpNetMem[k] = rpNetBuild(Math.floor(t0 / 60) * 60, date, base, opt).catch(e => { delete rpNetMem[k]; throw e; });
  return { ...(await rpNetMem[k]), t0 };
}
async function rpNetBuild(t0, date, base, { thsr = true, tra = true, live = null } = {}) {
  const S = await rpStations();
  const days = [[date, 0]];
  if (t0 < 4 * 60) { const p = new Date(base - 12 * 3600000); days.push([rpIso(p), -1440]); }
  if (t0 + RP_HORIZON > 1440) { const n = new Date(base + 36 * 3600000); days.push([rpIso(n), 1440]); }
  const trains = [], srcs = [];
  for (const [dt, off] of days) for (const op of [tra && "TRA", thsr && "THSR"].filter(Boolean)) {
    const r = await rpTrains(op, dt); srcs.push(op + ":" + r.src);
    for (const t of r.trains) {
      const dl = off === 0 && live && op === "TRA" ? (live[t.no] || 0) : 0;
      trains.push({ ...t, off, dl, date: dt });
    }
  }
  const conns = [];
  trains.forEach((t, ti) => {
    const s = t.stops;
    for (let i = 0; i + 1 < s.length; i++) {
      const dep = s[i][2] + t.off + t.dl, arr = s[i + 1][1] + t.off + t.dl;
      if (dep < t0 || dep > t0 + RP_HORIZON + 60 || !S.st[s[i][0]] || !S.st[s[i + 1][0]]) continue;
      conns.push([dep, arr, s[i][0], s[i + 1][0], ti, i]);
    }
  });
  conns.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { S, trains, conns, base, t0, srcs };
}
// CSA：src = {站: 可以上車的分鐘}；回傳每個轉乘次數 k 的最早抵達與回溯指標
function rpCSA(net, src, egress) {
  const { S, conns } = net, K = RP_MAXK + 1;
  const R = [], A = [], J = [], AJ = [], tripIn = [];
  for (let k = 0; k < K; k++) { R.push({}); A.push({}); J.push({}); AJ.push({}); tripIn.push({}); }
  const chg = s => RP_CHG[s[0]];
  const best = Array(K).fill(null);
  for (const c of conns) {
    const [dep, arr, u, v, t] = c;
    for (let k = 0; k < K; k++) {
      let b = tripIn[k][t];
      if (!b) {
        const ready = k === 0 ? src[u] : A[k - 1][u];
        if (ready != null && ready <= dep) b = tripIn[k][t] = { c, u, prev: k === 0 ? null : AJ[k - 1][u] };
      }
      if (!b) continue;
      if (R[k][v] == null || arr < R[k][v]) {
        R[k][v] = arr; J[k][v] = { t, b, c };
        const ready = arr + chg(v);
        if (A[k][v] == null || ready < A[k][v]) { A[k][v] = ready; AJ[k][v] = { from: v, j: J[k][v] }; }
        for (const [w, m] of S.links[v] || []) if (A[k][w] == null || arr + m < A[k][w]) { A[k][w] = arr + m; AJ[k][w] = { from: v, j: J[k][v], walk: m }; }
        const e = egress[v];
        if (e && (!best[k] || arr + e.min < best[k].at)) best[k] = { at: arr + e.min, st: v, j: J[k][v], e };
      }
    }
  }
  return best;
}
// 把 CSA 回溯成路段（含換車步行）
function rpLegs(net, j) {
  const { S, trains, base } = net, out = [];
  const tIso = m => isoTpe(base + m * 60000);
  const P = key => { const s = S.st[key]; return { name: s.name, type: "station", lat: s.lat, lon: s.lon }; };
  let cur = j;
  while (cur) {
    const t = trains[cur.t], i0 = cur.b.c[5], i1 = cur.c[5] + 1, s = t.stops, adj = t.off + t.dl;
    const leg = { kind: "transit", mode: t.op === "TRA" ? "tra" : "thsr", name: t.type || (t.op === "TRA" ? "台鐵" : "高鐵"), longName: "", headsign: t.end, color: null, number: t.no, trainType: t.type || "", agency: t.op, agencyName: t.op === "TRA" ? "臺鐵" : "台灣高鐵", fare: null,
      from: { ...P(s[i0][0]), time: tIso(s[i0][2] + adj) }, to: { ...P(s[i1][0]), time: tIso(s[i1][1] + adj) }, dur: (s[i1][1] - s[i0][2]) * 60,
      stops: s.slice(i0 + 1, i1).filter(x => S.st[x[0]]).map(x => ({ ...P(x[0]), time: tIso(x[2] + adj) })), own: true, late: t.dl || 0 };
    out.unshift(leg);
    const pv = cur.b.prev;
    if (!pv) break;
    if (pv.from !== cur.b.u) {
      const a = P(pv.from), b = P(cur.b.u), arr = pv.j.c[1];
      const wm = Math.max(1, pv.walk - 7);   // 連結時間含7分鐘緩衝，畫面上只算走路，其餘變成等車
      out.unshift({ kind: "walk", from: { ...a, time: tIso(arr) }, to: { ...b, time: tIso(arr + wm) }, dur: wm * 60, len: Math.round(haversine(a.lat, a.lon, b.lat, b.lon) * 1.3), xfer: true });
    }
    cur = pv.j;
  }
  // 段與段之間補上等車
  const legs = [];
  for (const l of out) {
    const p = legs[legs.length - 1];
    if (p) { const gap = (tms(l.from.time) - tms(p.to.time)) / 1000; if (gap >= 60) legs.push({ kind: "wait", from: { ...l.from, time: p.to.time }, to: { ...l.from }, dur: gap }); }
    legs.push(l);
  }
  return legs;
}
// 起點／終點到火車站的方式：步行（1.5公里內）＋ TDX 規劃結果裡「搭到某個台鐵／高鐵站之前」的那一段
async function rpAccess(routes, o, d) {
  const S = await rpStations(), acc = {}, egr = {};
  const walkTo = (p, s) => { const m = haversine(p.lat, p.lon, s.lat, s.lon); return { min: Math.ceil(m * 1.3 / 1.2 / 60), len: Math.round(m * 1.3) }; };
  for (const s of Object.values(S.st)) {
    const a = walkTo(o, s); if (a.len <= 2000) { const v = { min: a.min + 3, legs: [{ kind: "walk", from: { name: o.name || "起點", lat: o.lat, lon: o.lon }, to: { name: s.name, type: "station", lat: s.lat, lon: s.lon }, dur: a.min * 60, len: a.len }], walk: true }; if (!acc[s.key] || v.min < acc[s.key].min) acc[s.key] = v; }
    const e = walkTo(d, s); if (e.len <= 2000) { const v = { min: e.min, legs: [{ kind: "walk", from: { name: s.name, type: "station", lat: s.lat, lon: s.lon }, to: { name: d.name || "終點", lat: d.lat, lon: d.lon }, dur: e.min * 60, len: e.len }], walk: true }; if (!egr[s.key] || v.min < egr[s.key].min) egr[s.key] = v; }
  }
  for (const r of routes || []) {
    const rail = r.legs.map((l, i) => [l, i]).filter(([l]) => l.kind === "transit" && (l.mode === "tra" || l.mode === "thsr"));
    if (!rail.length) continue;
    const [L0, i0] = rail[0], [L1, i1] = rail[rail.length - 1];
    let j = i0; while (j > 0 && r.legs[j - 1].kind === "wait") j--;
    const pre = r.legs.slice(0, j), preEnd = j > 0 ? tms(r.legs[j - 1].to.time) : r.start;
    if (pre.some(l => l.kind === "transit")) {
      const g = await planRailStation(L0, "from"), key = g && (L0.mode === "tra" ? "T" : "H") + (g.ids || [g.id])[0];
      const min = Math.ceil((preEnd - r.start) / 60000) + 2;
      if (key && S.st[key] && (!acc[key] || min < acc[key].min)) acc[key] = { min, legs: pre, end: preEnd, est: true };
    }
    let k = i1 + 1; while (k < r.legs.length && r.legs[k].kind === "wait") k++;
    const suf = r.legs.slice(i1 + 1);
    if (suf.some(l => l.kind === "transit")) {
      const g = await planRailStation(L1, "to"), key = g && (L1.mode === "tra" ? "T" : "H") + (g.ids || [g.id])[0];
      const min = Math.ceil((r.end - tms(L1.to.time)) / 60000);
      if (key && S.st[key] && (!egr[key] || min < egr[key].min)) egr[key] = { min, legs: suf, start: tms(L1.to.time), est: true };
    }
  }
  return { acc, egr };
}
const rpShiftLegs = (legs, ms) => legs.map(l => ({ ...l, from: { ...l.from, time: l.from.time ? isoTpe(tms(l.from.time) + ms) : null }, to: { ...l.to, time: l.to.time ? isoTpe(tms(l.to.time) + ms) : null }, stops: l.stops && l.stops.map(x => ({ ...x, time: x.time ? isoTpe(tms(x.time) + ms) : null })) }));
// 步行段沒有時間：從 t 開始依序排
const rpTimeLegs = (legs, t) => legs.map(l => { const f = isoTpe(t); t += (l.dur || 0) * 1000; return { ...l, from: { ...l.from, time: f }, to: { ...l.to, time: isoTpe(t) } }; });
function rpRoute(net, best, label, o, d) {
  const rail = rpLegs(net, best.j), first = rail[0], last = rail[rail.length - 1];
  const dep = tms(first.from.time), arr = tms(last.to.time);
  // 起點接駁：排在剛好趕上第一班車（留緩衝）
  const a = best.acc, lk = a.link, lkMs = lk ? lk.m * 60000 : 0;
  let pre = a.walk ? rpTimeLegs(a.legs, dep - a.min * 60000 - lkMs) : rpShiftLegs(a.legs, dep - 2 * 60000 - lkMs - a.end);
  if (lk) { const A = net.S.st[lk.from], B = net.S.st[lk.to], t = pre.length ? tms(pre[pre.length - 1].to.time) : dep - lkMs;
    const wm = Math.max(1, lk.m - 7);
    pre = pre.concat([{ kind: "walk", from: { name: A.name, type: "station", lat: A.lat, lon: A.lon, time: isoTpe(t) }, to: { name: B.name, type: "station", lat: B.lat, lon: B.lon, time: isoTpe(t + wm * 60000) }, dur: wm * 60, len: Math.round(haversine(A.lat, A.lon, B.lat, B.lon) * 1.3), xfer: true }]); }
  const preEnd = pre.length ? tms(pre[pre.length - 1].to.time) : dep;
  const legs = [...pre];
  if (dep - preEnd >= 60000) legs.push({ kind: "wait", from: { ...first.from, time: isoTpe(preEnd) }, to: { ...first.from }, dur: (dep - preEnd) / 1000 });
  legs.push(...rail);
  const e = best.e;
  const suf = e.walk ? rpTimeLegs(e.legs, arr) : rpShiftLegs(e.legs, arr - e.start);
  legs.push(...suf);
  const start = pre.length ? tms(pre[0].from.time) : dep, end = suf.length ? tms(suf[suf.length - 1].to.time) : arr;
  const tr = legs.filter(l => l.kind === "transit");
  return { sig: "rp|" + tr.map(l => l.number + "@" + l.from.time).join("|"), start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), fare: null, farePartial: false, approx: false, legs,
    official: true, tag: label, est: !!(a.est || e.est) };
}
// 主程式：回傳幾條「依官方時刻表」的路線；不適用或找不到就回傳 []
async function railPlan({ o, d, when, time, modes, routes, live }) {
  const tra = modes.includes(4), thsr = modes.includes(3);
  if (!tra && !thsr) return [];
  if (haversine(o.lat, o.lon, d.lat, d.lon) < 50000) return [];
  const T0 = Date.now();
  const { acc, egr } = await rpAccess(routes, o, d);
  if (!Object.keys(acc).length || !Object.keys(egr).length) return [];
  const want = when === "arr" && time ? tms(time) : null;
  let t0 = when === "dep" && time ? tms(time) : want ? want - 12 * 3600000 : Date.now();
  if (want) live = null;
  const run = async (tms0, opt) => {
    const net = await rpNet(tms0, { tra, thsr: opt.thsr, live, liveKey: live && live._k });
    const tq = net.t0, src = {}, eg = {};
    const via = {};
    for (const [k, v] of Object.entries(acc)) {
      const r = tq + v.min; if (src[k] == null || r < src[k]) { src[k] = r; via[k] = { ...v, link: null }; }
      for (const [w, m] of net.S.links[k] || []) if (src[w] == null || r + m < src[w]) { src[w] = r + m; via[w] = { ...v, link: { from: k, to: w, m } }; }
    }
    for (const [k, v] of Object.entries(egr)) eg[k] = v;
    // 起點接駁：連到站內轉乘的另一系統時，回溯用原本的接駁方式
    const best = rpCSA(net, src, eg);
    const first = j => { let c = j; while (c.b.prev) c = c.b.prev.j; return c.b.u; };
    return { net, best: best.map(b => b && { ...b, acc: via[first(b.j)] }) };
  };
  const variants = [{ thsr, tag: thsr ? "" : "台鐵" }];
  if (thsr && tra) variants.push({ thsr: false, tag: "只搭台鐵" });
  const out = [];
  for (const v of variants) {
    let res;
    if (want) {
      // 指定抵達：二分搜尋「最晚出發、仍能準時到」的時間
      let lo = t0, hi = want, ok = null;
      for (let i = 0; i < 9; i++) {
        const mid = Math.round((lo + hi) / 2 / 60000) * 60000, r = await run(mid, v), b = r.best.filter(Boolean).sort((a, b) => a.at - b.at)[0];
        if (b && r.net.base + b.at * 60000 <= want) { ok = r; lo = mid; } else hi = mid;
      }
      res = ok;
    } else res = await run(t0, v);
    if (!res) continue;
    // 再找「下一班」：從最快那條的第一班車之後出發
    if (!want && v === variants[0]) {
      const b0 = res.best.filter(Boolean).sort((a, b) => a.at - b.at)[0];
      if (b0) { const r0 = rpRoute(res.net, b0, v.tag, o, d), dep0 = tms(r0.legs.find(l => l.own).from.time);
        const acc0 = b0.acc.min + (b0.acc.link ? b0.acc.link.m : 0);
        const r2 = await run(dep0 + 60000 - acc0 * 60000, v), b2 = r2.best.filter(Boolean).sort((a, b) => a.at - b.at)[0];
        if (b2 && r2.net.base + b2.at * 60000 > res.net.base + b0.at * 60000) out.push({ ...rpRoute(r2.net, b2, v.tag, o, d), next: true }); }
    }
    let bestAt = Infinity;
    res.best.forEach((b, k) => {
      if (!b || b.at >= bestAt) return;             // 多轉乘卻沒有更早到的不列
      if (want && res.net.base + b.at * 60000 > want) return;
      bestAt = b.at;
      out.push(rpRoute(res.net, b, v.tag, o, d));
    });
  }
  // 太晚才有車（例如深夜查詢、要等到隔天早上）就不列：第一段出發要在查詢時間3小時內
  const seen = new Set(), late = want ? Infinity : t0 + 3 * 3600000;
  let list = out.filter(r => r.start <= late && !seen.has(r.sig) && seen.add(r.sig));
  // 互相比較（含接駁裡的公車／捷運轉乘）：比別條晚到、轉乘又沒比較少的不列；「下一班」和「只搭台鐵」各自保留最好的一條
  const dom = (a, b) => b.end <= a.end && b.transfers <= a.transfers && (b.end < a.end || b.transfers < a.transfers);
  list = list.filter(r => !list.some(x => x !== r && !x.next && (r.tag ? x.tag === r.tag : !x.tag) && dom(r, x)) || (r.next && !list.some(x => x !== r && x.next && dom(r, x))));
  list.forEach(r => { r.ms = Date.now() - T0; });
  return list;
}
// 修補 TDX 路線裡的台鐵／高鐵段（不限最後一段）：從第一段火車的上車站、同樣的可上車時間起算，用官方時刻表找到原本下車站最早能到的走法；
// 後面的路段能跟著提前（只剩步行，或只有捷運／輕軌）才換，否則提早到也只是多等，不改
async function planRepair(routes, { tra, thsr, live }) {
  const S = await rpStations();
  const keyOf = async (leg, end) => { const g = await planRailStation(leg, end); return g ? (leg.mode === "tra" ? "T" : "H") + (g.ids || [g.id])[0] : null; };
  for (const r of routes) {
    if (r.official) continue;
    const L = r.legs, i0 = L.findIndex(l => l.kind === "transit" && (l.mode === "tra" || l.mode === "thsr")); if (i0 < 0) continue;
    let i1 = i0;
    for (let k = i0 + 1; k < L.length; k++) { const l = L[k]; if (l.kind === "transit") { if (l.mode === "tra" || l.mode === "thsr") i1 = k; else break; } }
    let j0 = i0; while (j0 > 0 && L[j0 - 1].kind === "wait") j0--;
    const ready = j0 > 0 ? tms(L[j0 - 1].to.time) : tms(L[i0].from.time), oldArr = tms(L[i1].to.time);
    const a = await keyOf(L[i0], "from"), b = await keyOf(L[i1], "to"); if (!a || !b || !S.st[a] || !S.st[b]) continue;
    const suf = L.slice(i1 + 1), sufTr = suf.filter(l => l.kind === "transit");
    if (sufTr.some(l => l.mode !== "mrt" && l.mode !== "lrt")) continue;
    const net = await rpNet(ready, { tra, thsr, live, liveKey: live && live._k });
    const src = { [a]: net.t0 + (RP_CHG[a[0]] > 5 ? 3 : 2) };
    for (const [w, m] of S.links[a] || []) src[w] = net.t0 + m;
    const best = rpCSA(net, src, { [b]: { min: 0 } }).filter(Boolean).sort((x, y) => x.at - y.at)[0];
    if (!best) continue;
    const newArr = net.base + best.at * 60000; if (newArr > oldArr - 2 * 60000) continue;
    const rail = rpLegs(net, best.j), dep = tms(rail[0].from.time);
    let shift = newArr - oldArr; if (sufTr.length) shift = Math.min(0, shift + 5 * 60000);   // 後面還有捷運：保守一點，留一個班距
    if (shift > -60000) continue;
    const pre = L.slice(0, j0), legs = [...pre];
    if (dep - ready >= 60000) legs.push({ kind: "wait", from: { ...rail[0].from, time: isoTpe(ready) }, to: { ...rail[0].from }, dur: (dep - ready) / 1000 });
    legs.push(...rail);
    const gap = sufTr.length ? (oldArr + shift) - newArr : 0;   // 提前量沒用完的，變成等車
    if (gap >= 60000) legs.push({ kind: "wait", from: { ...rail[rail.length - 1].to }, to: { ...rail[rail.length - 1].to, time: isoTpe(newArr + gap) }, dur: gap / 1000 });
    legs.push(...rpShiftLegs(suf, shift));
    r.legs = legs; r.end += shift; r.dur = Math.round((r.end - r.start) / 60000); r.fixed = true;
    r.transfers = Math.max(0, legs.filter(l => l.kind === "transit").length - 1);
  }
  return routes;
}

// 台鐵全線即時誤點（Worker 共用快取60秒）：只在「現在／3小時內出發」時用
async function rpLive(t0) {
  if (Math.abs(t0 - Date.now()) > 3 * 3600000) return null;
  try { const rows = await tdx("rail", TRA_ALL_LIVE), live = { _k: Math.floor(Date.now() / 60000) }; for (const r of rows) if (r.TrainNo && r.DelayTime > 0) live[String(r.TrainNo)] = r.DelayTime; return live; }
  catch (e) { return null; }
}

const geoSearch = ({ q, near }) => authedGet(`/geo?q=${enc(q)}${near ? "&near=" + near : ""}`);
const geoReverse = ({ lat, lon }) => authedGet(`/geo?lat=${lat}&lon=${lon}`);

// ---------- 對回 App 的資料：車站（名稱＋座標）、公車路線（名稱＋營運縣市＋站序） ----------
const pn = x => normZh(x).replace(/\(.*?\)|（.*?）/g, "").replace(/站$/, "").replace(/\s/g, "");
const nameHit = (a, b) => { a = pn(a); b = pn(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
const AG_OP = { TRTC: ["TRTC", "NTMC"], NTMC: ["NTMC", "TRTC"], KRTC: ["KRTC", "KLRT"], KLRT: ["KLRT", "KRTC"], TYMC: ["TYMC"], TMRT: ["TMRT"], NTDLRT: ["NTDLRT", "NTMC"], NTALRT: ["NTALRT", "NTMC"], THSR: ["THSR"], TRA: ["TRA"] };
// 多段同時對車站時共用同一次載入（冷啟動時避免同時抓好幾次車站清單）
let railAllP = null;
const railAll = () => railAllP || (railAllP = loadRailStations().finally(() => setTimeout(() => { railAllP = null; }, 60000)));
async function planRailStation(leg, end) {
  const p = leg[end]; if (p.lat == null) return null;
  const all = await railAll();
  const kindOk = g => leg.mode === "tra" ? g.op === "TRA" : leg.mode === "thsr" ? g.op === "THSR" : g.kind === "metro";
  const groups = nearestRail(all, p.lat, p.lon, { all: true }).filter(g => g.dist <= 800 && kindOk(g));
  const pref = AG_OP[(leg.agency || "").toUpperCase()] || [];
  const score = g => (nameHit(g.name, p.name) ? 0 : 2) + (pref.length && !pref.includes(g.op) ? 1 : 0) + g.dist / 1000;
  const best = groups.filter(g => nameHit(g.name, p.name) || g.dist <= 200).sort((a, b) => score(a) - score(b))[0];
  return best || null;
}
const UIDC = Object.fromEntries(Object.entries(UID_CITY).map(([k, v]) => [k, v]));
async function busCity(city) {   // 只下載需要的縣市路線清單（存進同一份 busidx）
  let c = idxMem || await IDB.get("busidx"); if (!c || !c.cities) c = { time: Date.now(), cities: {} };
  c.ct = c.ct || {}; c.ign = c.ign || {}; idxMem = c;
  if (c.cities[city]) return c.cities[city];
  const proxy = getProxy(); if (!proxy) return [];
  try { const r = await fetch(`${proxy}/bus/routes?c=${city}`); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) { c.cities[city] = j; c.ct[city] = Date.now(); IDB.set("busidx", c).catch(() => {}); return j; } } } catch (e) {}
  return [];
}
async function sorOf(k, route) {
  const key = `${k.path}|${route}`, sc = await IDB.get("sor|" + key);
  if (sc) return sc.d;
  const l = await tdx("route", `${BASE}/basic/v2/Bus/StopOfRoute/${k.path}/${enc(route)}?%24top=600&%24format=JSON`);
  const d = sorPack(l); IDB.set("sor|" + key, { t: Date.now(), d }).catch(() => {}); return d;
}
async function planBusMatch(leg) {
  const ag = (leg.agency || "").slice(0, 3).toUpperCase(), c0 = UIDC[ag];
  const order = [...new Set([c0, "InterCity", c0 === "Taipei" ? "NewTaipei" : c0 === "NewTaipei" ? "Taipei" : null].filter(Boolean))];
  for (const city of order) {
    const list = await busCity(city);
    const cands = list.filter(r => pn(r[1]) === pn(leg.name));
    for (const r of cands) {
      const k = routeKind(r[0]); if (!k) continue;
      let sor; try { sor = await sorOf(k, r[1]); } catch (e) { if (isRate(e)) throw e; continue; }
      let best = null;
      for (const dir of sor.filter(x => x.RouteUID === r[0])) {
        const st = dir.Stops || [], nm = x => (x.StopName && x.StopName.Zh_tw) || "";
        // 先比站名；對不到（例如「國光客運臺北車站」vs「臺北車站(東三門)」）再用座標找250m內最近的站
        const at = (p, from) => { let i = st.findIndex((x, j) => j >= from && pn(nm(x)) === pn(p.name)); if (i >= 0 || p.lat == null) return i; let bd = 250; st.forEach((x, j) => { const q = x.P; if (j < from || !q) return; const dd = haversine(p.lat, p.lon, q[0], q[1]); if (dd < bd) { bd = dd; i = j; } }); return i; };
        const bi = at(leg.from, 0), ai = bi >= 0 ? at(leg.to, bi + 1) : -1;
        const sc = bi < 0 ? 9 : ai > bi ? 0 : 1;
        if (sc < 9 && (!best || sc < best.sc)) best = { sc, dirNum: dir.Direction === 1 ? 1 : 0, stopUID: st[bi].StopUID, stopName: nm(st[bi]), alightUID: ai > 0 ? st[ai].StopUID : null };
      }
      if (best) return { routeUID: r[0], route: r[1], dirNum: best.dirNum, stopUID: best.stopUID, stopName: best.stopName, dest: best.dirNum === 1 ? r[2] : r[3], path: k.path, exact: best.sc === 0 };
    }
  }
  return null;
}
// 每段公共運輸：對到的車站／路線＋即時（或表定）到站。只有90分鐘內要搭的才查即時
async function planLive({ legs }) {
  const now = Date.now(), nowM = nowMin(), out = {};
  await Promise.all((legs || []).map(async (leg, i) => {
    if (leg.kind !== "transit") return;
    const m0 = Math.round((tms(leg.from.time) - now) / 60000), wantLive = m0 > -3 && m0 <= 90;
    try {
      if (leg.mode === "bus") {
        const b = await planBusMatch(leg); if (!b) { out[i] = { miss: true }; return; }
        const o = { open: { type: "route", r: { routeUID: b.routeUID, route: b.route, dirNum: b.dirNum, stopUID: b.stopUID, stopName: b.stopName, dest: b.dest } }, exact: b.exact };
        if (wantLive) {
          const etas = await tdx("route", `${BASE}/basic/v2/Bus/EstimatedTimeOfArrival/${b.path}/${enc(b.route)}?%24top=600&%24format=JSON`);
          // 同一站可能有好幾條支線（例如 1815A～G），挑最有用的那筆：有預估秒數的最近一班 > 有下一班時間的 > 其他
          const rank = t => t.StopStatus === 0 && typeof t.EstimateTime === "number" ? t.EstimateTime : (t.StopStatus ?? 0) === 1 && t.NextBusTime ? 1e6 : 2e6 + (t.StopStatus || 0);
          const e = etas.filter(t => t.RouteUID === b.routeUID && t.StopUID === b.stopUID && (t.Direction === 1 ? 1 : 0) === b.dirNum).sort((x, y) => rank(x) - rank(y))[0];
          if (e) o.bus = { sec: typeof e.EstimateTime === "number" ? e.EstimateTime : null, status: e.StopStatus ?? 0, next: e.NextBusTime || null };
        }
        out[i] = o; return;
      }
      const g = await planRailStation(leg, "from"); if (!g) { out[i] = { miss: true }; return; }
      const g2 = await planRailStation(leg, "to").catch(() => null);
      const o = { open: { type: "rail", r: g }, to: g2 ? { op: g2.op, ids: g2.ids, name: g2.name } : null };
      if (wantLive) {
        const B = await railBoard(tdx, g);
        if (B.kind === "tra" || B.kind === "thsr") {
          const hm0 = (leg.from.time || "").slice(11, 16);
          const row = (B.trains || []).find(t => (leg.number && String(t.no) === String(leg.number)) || t.time === hm0);
          if (row) { const m = row.t + (row.delay || 0) - nowM; o.pill = { min: m < -600 ? m + 1440 : m, tag: row.delay == null ? "表定" : row.delay > 0 ? `即時・晚${row.delay}` : "即時・準點", live: row.delay != null, late: row.delay > 0, no: row.no }; }
        } else {
          const head = leg.headsign;
          const lv = B.live ? (B.trains || []).filter(t => t.eta != null && nameHit(t.dest, head) && t.eta >= m0 - 1).sort((a, b) => a.eta - b.eta)[0] : null;
          if (lv) o.pill = { min: lv.eta, tag: "即時", live: true };
          else {
            const tt = (B.tt || []).filter(t => t.eta != null && nameHit(t.dest, head) && t.eta >= m0 - 1).sort((a, b) => a.eta - b.eta)[0];
            if (tt) o.pill = { min: tt.eta, tag: tt.est ? "估算" : "表定", live: false };
          }
        }
      }
      out[i] = o;
    } catch (e) { out[i] = { err: String(e.message || e) }; }
  }));
  return out;
}

const SESS_KEY = "jisu_session";
function getSession() { try { const s = JSON.parse(localStorage.getItem(SESS_KEY)); return s && s.token ? s : null; } catch (e) { return null; } }
async function authLogin({ account, password }) {
  const proxy = getProxy(); if (!proxy) throw new Error("尚未設定資料來源");
  let r, j = {};
  try { r = await fetch(proxy + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, password }) }); j = await r.json().catch(() => ({})); }
  catch (e) { throw new Error("連不到伺服器，請確認網路後再試"); }
  if (!r.ok || !j.token) throw new Error(j.message || "登入失敗，請稍後再試");
  const s = { token: j.token, name: j.name, role: j.role };
  localStorage.setItem(SESS_KEY, JSON.stringify(s));
  return s;
}
// 向 Worker 確認 session（同時續期）；401 才登出，連不上就沿用裝置上的 session（離線也能開）
async function authMe() {
  const s = getSession(); if (!s) return null;
  const proxy = getProxy(); if (!proxy) return { ...s, offline: true };
  try {
    const r = await fetch(proxy + "/auth/me", { headers: { "x-session": s.token }, cache: "no-store" });
    if (r.status === 401) { localStorage.removeItem(SESS_KEY); return null; }
    if (!r.ok) return { ...s, offline: true };
    const j = await r.json(); const n = { ...s, name: j.name, role: j.role };
    localStorage.setItem(SESS_KEY, JSON.stringify(n)); return n;
  } catch (e) { return { ...s, offline: true }; }
}
async function authLogout() {
  const s = getSession(); localStorage.removeItem(SESS_KEY);
  const proxy = getProxy();
  if (s && proxy) { try { await fetch(proxy + "/auth/logout", { method: "POST", headers: { "x-session": s.token } }); } catch (e) {} }
}

window.dataApi = async (action, p = {}) => {
  switch (action) {
    case "nearby": return nearby(p);
    case "route": return routeView(p);
    case "railBoard": return railBoard(tdx, p);
    case "loadState": return loadState();
    case "saveState": localStorage.setItem(STATE_KEY, JSON.stringify(p)); return true;
    case "session": return getSession();
    case "authLogin": return authLogin(p);
    case "authMe": return authMe();
    case "authLogout": return authLogout();
    case "getProxy": return { url: getProxy(), fromConfig: !localStorage.getItem(PROXY_KEY) };
    case "setProxy":
      if (p.url) localStorage.setItem(PROXY_KEY, p.url.trim()); else localStorage.removeItem(PROXY_KEY);
      return true;
    case "testProxy": {
      const proxy = getProxy();
      if (!proxy) throw new Error("請先填入代理網址（https:// 開頭）");
      let j;
      try { j = await fetch(proxy + "/health").then(r => r.json()); }
      catch (e) { throw new Error("連不到代理伺服器：" + e.message); }
      if (!j || !j.ok) throw new Error("代理回應異常：" + JSON.stringify(j).slice(0, 120));
      return j;
    }
    case "open": location.href = p.url; return true;
    case "busIndex": return busIndex();
    case "busHeal": return busHeal(p.uids, p.cities);
    case "planRoutes": return planRoutes(p);
    case "planLive": return planLive(p);
    case "geoSearch": return geoSearch(p);
    case "geoReverse": return geoReverse(p);
    case "locate": return locate();
    case "placeIndex": return placeIndex(p || {});
    case "stopAt": return stopAt(p || {});
    case "bikeAt": return bikeAt(p || {});
    case "railSearch": return railSearch(p || {});
    case "lineView": return lineView(tdx, p);
    case "trainView": return trainView(tdx, p);
    case "tripView": return tripView(tdx, p);
    case "ttMeta": return ttMeta(true);
    case "buildTrips": return buildTrips(p.tt);
    case "ttSystems": return TT_SYSTEMS;
    case "ttRefresh": return ttRefresh(p.op, p.pass, p.onStep);
    case "ttAuth": { const r = await fetch(`${getProxy()}/tt/auth`, { method: "POST", headers: { "x-admin": p.pass } }); if (!r.ok) throw new Error("管理密碼錯誤"); return true; }
    case "pushKey": return pushCall("GET", "/push/key");
    case "pushTest": return pushCall("POST", "/push/test", { sub: p.sub });
    case "remindCreate": {
      const k = routeKind(p.routeUID);
      if (!k) throw new Error("這條路線不支援下車提醒");
      return pushCall("POST", "/reminder", { ...p, path: k.path });
    }
    case "remindStatus": return pushCall("GET", "/reminder/" + p.id);
    case "remindCancel": return pushCall("DELETE", "/reminder/" + p.id);
  }
  throw new Error("未知動作 " + action);
};
})();
