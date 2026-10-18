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
// 淡海／安坑／高雄輕軌：TDX 沒有出口資料（StationExit 一律回 400），不抓（v2.24.0）
const NO_EXIT = new Set(["NTDLRT", "NTALRT", "KLRT"]);
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
// v2.24.0：車站頁不再抓全台列車動態（只有點進某一班車才抓）；60 秒內抓過就順便拿來補誤點
const traAllPeek = () => { const h = memoMap.get(TRA_ALL_LIVE); return h && Date.now() - h.t < 60000 ? h.v : null; };
async function traBoard(get, st) {
  const id = st.ids[0];
  const filter = encodeURIComponent(`StationID eq '${id}'`);
  const storedRows = await ttTrainRows("TRA", id, await dayInfo(svcDate(0))).catch(() => null);
  // 本站 StationLiveBoard ＋ 全台列車動態（Worker 共用快取60秒），讓已發車的每一班都有誤點
  const [tt, slive, tlive] = await Promise.allSettled([
    storedRows ? Promise.resolve([]) : get("rail", `${RAIL_BASE}/v3/Rail/TRA/DailyStationTimetable/Today/Station/${id}?%24format=JSON`)
      .catch(() => get("rail", `${RAIL_BASE}/v2/Rail/TRA/DailyTimetable/Station/${id}/${todayStr()}?%24format=JSON`)),
    get("rail", `${RAIL_BASE}/v3/Rail/TRA/StationLiveBoard?%24filter=${filter}&%24format=JSON`),
    traAllPeek() || Promise.reject(new Error("skip")),
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
  if (stored && stored.hw) { try { localStorage.removeItem(HW_KEY + op); } catch (e) {} return stored.hw; }
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
// 雲端（Worker KV）是唯一來源：meta 列出每個系統的 updated（版本）；手機把下載過的那份存在 IndexedDB（tt|系統），
// updated 一樣就直接用本機那份，雲端有新版才重新下載；連不到 Worker 時暫用本機那份（v2.19）
async function ttMeta(force) {
  const proxy = getProxy(); if (!proxy) return { systems: {}, offline: true };
  if (force || !ttMetaP) ttMetaP = fetch(`${proxy}/tt/meta${force ? "?t=" + Date.now() : ""}`).then(r => r.ok ? r.json() : { systems: {}, offline: true }).catch(() => (ttMetaP = null, { systems: {}, offline: true }));
  return ttMetaP;
}
async function ttLoad(op) {
  const meta = await ttMeta(), m = meta.systems[op];
  if (!m) {   // 連不到 Worker：用本機存過的那份（不知道是不是最新版，但比沒有好）
    if (!meta.offline) return null;
    const k0 = op + "|offline"; if (ttMem[k0]) return ttMem[k0];
    return ttMem[k0] = IDB.get("tt|" + op).then(c => (c && c.d) || null).catch(() => null).finally(() => setTimeout(() => delete ttMem[k0], 60000));
  }
  const k = op + "|" + m.updated; if (ttMem[k]) return ttMem[k];
  return ttMem[k] = (async () => {
    const c = await IDB.get("tt|" + op).catch(() => null);
    if (c && c.u === m.updated && c.d) return c.d;
    try {
      const r = await fetch(`${getProxy()}/tt/data/${op}?v=${encodeURIComponent(m.updated)}`);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      IDB.set("tt|" + op, { u: m.updated, d }).catch(() => {});
      return d;
    } catch (e) {
      delete ttMem[k];
      return (c && c.d) || null;   // 下載失敗：先用本機舊版
    }
  })();
}
// 台鐵定期時刻表涵蓋的日期（EffectiveDate ≤ 日期 < ExpireDate，皆取台北日期）；沒有效期資料就當作不涵蓋
// 七天時刻表（v2.20，取自平常週的實際時刻表）的 exp 可以是空的＝一直用到下次手動更新
const ttCovers = (tt, ds) => { ds = String(ds).replace(/-/g, "").slice(0, 8); return !!(tt && tt.trains && tt.eff && (tt.exp || tt.src7) && tt.eff.slice(0, 10).replace(/-/g, "") <= ds && (!tt.exp || ds < tt.exp.slice(0, 10).replace(/-/g, ""))); };
const ttHasHol = tt => !!(tt && tt.trains && tt.trains.some(t => (t[5] || "")[7] === "1"));
// 台鐵／高鐵的雲端時刻表分成星期一～日 7 份（TRA_MON…TRA_SUN），每份只有那天有開的車（v2.19）；
// 每班車仍保留自己的行駛日旗標（一～日＋國定假日）。7 份還沒建好時退回整份定期表（同樣依旗標篩）
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
async function ttDow(op, day) {
  const bu = (await dayInfo(day)).name === "補班";   // 週末補行上班：用星期一那份
  const t = await ttLoad(op + "_" + (bu ? "MON" : DOW[day.getDay()])).catch(() => null);
  if (t && t.trains) return t;
  return ttLoad(op).catch(() => null);
}
const dowSplit = out => DOW.map((d, i) => { const ix = (i + 6) % 7;   // 旗標順序是 一…日
  return [d, { ...out, dow: d, trains: out.trains.filter(t => (t[5] || "")[ix] === "1") }]; });
// ---------- 國定假日／連假規則（v2.20） ----------
// 連假＝含國定假日（或補假）的連續放假日（國定假日＋相連的週末），前一天＝連假第一天的前一天。
// 台鐵／高鐵只有這些日期才抓那一天的實際時刻表（/tt/day）；平常的平日和週末一律用七天那份。Worker 也照同一套規則擋。
const isoAdd = (iso, k) => new Date(Date.parse(iso + "T00:00:00Z") + k * 86400000).toISOString().slice(0, 10);
function holRel(dates, iso) {
  dates = dates || {};
  const off = x => { const n = dates[x]; if (n === "補班") return false; if (n) return true; const w = new Date(x + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6; };
  const run = x => { if (!off(x)) return null; let a = x, b = x, hol = !!dates[x]; for (let i = 0; i < 20 && off(isoAdd(a, -1)); i++) { a = isoAdd(a, -1); if (dates[a]) hol = true; }
    for (let i = 0; i < 20 && off(isoAdd(b, 1)); i++) { b = isoAdd(b, 1); if (dates[b]) hol = true; } return hol ? [a, b] : null; };
  const r = run(iso); if (r) return { kind: "holiday", run: r };
  const n = isoAdd(iso, 1), rn = run(n); if (rn && rn[0] === n) return { kind: "eve", run: rn };
  return null;
}
// 七天時刻表要取自哪 7 天：從今天起找最近的一整個平常週（星期一～日都不是國定假日、連假或其前一天）；
// 找不到（9 週內）就每個星期幾各自挑最近的平常日。回傳 [一,二,三,四,五,六,日] 的日期
function clean7(dates, todayIso) {
  const ok = x => !holRel(dates, x), w0 = new Date(todayIso + "T00:00:00Z").getUTCDay();
  let mon = isoAdd(todayIso, (8 - w0) % 7);   // 今天以後（含今天）的第一個星期一
  for (let k = 0; k < 9; k++, mon = isoAdd(mon, 7)) { const wk = [0, 1, 2, 3, 4, 5, 6].map(i => isoAdd(mon, i)); if (wk.every(ok)) return wk; }
  return [1, 2, 3, 4, 5, 6, 0].map(wd => { for (let i = 0; i < 63; i++) { const x = isoAdd(todayIso, i); if (new Date(x + "T00:00:00Z").getUTCDay() === wd && ok(x)) return x; } return null; });
}
// 把 7 天的實際時刻表（TDX DailyTimetable）做成 TRA_MON…TRA_SUN；每班車的行駛日旗標只標那個星期幾
function rail7Build(op, dailyList, src7, gen) {
  const hm4 = x => (x || "").slice(0, 5).replace(":", "");
  const stops = L => (L || []).filter(x => x.SuspendedFlag !== 1).map(x => [x.StationID, hm4(x.ArrivalTime), hm4(x.DepartureTime)].join(",")).join(";");
  const exp = gen && gen.exp && src7.every(d => d < gen.exp.slice(0, 10)) ? gen.exp : null;   // 取的日期都在定期表有效期內才沿用它的到期日
  return src7.map((ds, i) => {   // i：0＝星期一 … 6＝星期日
    const mask = "00000000".split("").map((c, k) => k === i ? "1" : "0").join(""), j = dailyList[i];
    const list = op === "TRA" ? ((j && j.TrainTimetables) || []).map(x => { const t = x.TrainInfo || {}; return [String(t.TrainNo), shortType(zh(t.TrainTypeName)), t.Direction ?? "", zh(t.StartingStationName) || "", zh(t.EndingStationName) || "", mask, stops(x.StopTimes)]; })
      : (Array.isArray(j) ? j : []).map(x => { const t = x.DailyTrainInfo || {}; return [String(t.TrainNo), "高鐵", t.Direction ?? "", zh(t.StartingStationName) || "", zh(t.EndingStationName) || "", mask, stops(x.StopTimes)]; });
    return [DOW[(i + 1) % 7], { v: 1, op, kind: op.toLowerCase(), dow: DOW[(i + 1) % 7], src: ds, src7, trains: list, eff: (gen && gen.eff) || null, exp }];
  });
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
  // 雲端限流：同一個系統一小時內只能更新一次（保護 TDX 額度）；先向 Worker 取得許可才開始抓
  { const r = await fetch(`${proxy}/tt/lock/${op}`, { method: "POST", headers: { "x-session": pass } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || "無法取得更新許可 " + r.status); }
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
    // 站間行駛時間（單一班次各站時間推估用）一起存到雲端：1次呼叫，失敗不影響時刻表
    try {
      const list = await get(`${RAIL_BASE}/v2/Rail/Metro/S2STravelTime/${op}?%24format=JSON`), e = {};
      for (const r of Array.isArray(list) ? list : []) for (const x of (r.TravelTimes || [])) {
        const sec = (x.RunTime || 0) + (x.StopTime || 0); if (!sec) continue;
        for (const k of [x.FromStationID + "|" + x.ToStationID, x.ToStationID + "|" + x.FromStationID]) if (!e[k]) e[k] = sec;
      }
      if (Object.keys(e).length) out.s2s = e;
    } catch (e) { if (isRate(e)) throw e; }
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
  const vh = out.eff || out.exp ? { "x-tt-eff": out.eff || "", "x-tt-exp": out.exp || "" } : {};
  const r = await fetch(`${proxy}/tt/data/${op}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": String(calls), "x-tt-version": version, "x-tt-count": String(count), ...vh }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || "上傳失敗 " + r.status);
  ttMetaP = null;
  // 台鐵／高鐵（v2.20）：七天時刻表取自最近一整個平常週（不含國定假日、連假和其前一天，含平常的週六日）的實際時刻表，
  // 星期一～日各抓一天（7 次呼叫）存成 TRA_MON…TRA_SUN；記下取自哪 7 天
  let days = null, src7 = null;
  if (out.kind === "tra" || out.kind === "thsr") {
    const hol = await ttLoad("HOLIDAY").catch(() => null);
    if (!hol || !hol.dates) throw new Error("先更新國定假日曆，才能挑出平常週");
    src7 = clean7(hol.dates, isoDay(new Date()));
    if (src7.some(x => !x)) throw new Error("9 週內找不到平常日");
    const dl = [];
    for (const ds of src7) {
      dl.push(op === "TRA" ? await get(`${RAIL_BASE}/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${ds}?%24format=JSON`, true) : await get(`${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/TrainDate/${ds}?%24format=JSON`));
      await sleep(700);
    }
    const sets = rail7Build(op, dl, src7, { eff: out.eff || null, exp: out.exp || null });
    if (sets.some(([, p]) => !p.trains.length)) throw new Error("TDX 還沒有其中某天的時刻表：" + src7.filter((d, i) => !sets[i][1].trains.length).join("、"));
    days = [];
    for (const [d, part] of sets) {
      const h7 = { "x-tt-src": part.src, "x-tt-src7": src7.join(","), ...(part.eff ? { "x-tt-eff": part.eff, "x-tt-exp": part.exp || "" } : {}) };
      const r3 = await fetch(`${proxy}/tt/data/${op}_${d}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": String(d === "MON" ? calls : 0), "x-tt-version": version, "x-tt-count": String(part.trains.length), ...h7 }, body: JSON.stringify(part) });
      if (!r3.ok) throw new Error(`${d} 上傳失敗 ${r3.status}`);
      days.push(part.trains.length);
    }
    ttMetaP = null;
  }
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
  return { calls, bytes: body.length, count, version, trips, days, src7, ...j };
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
// 台鐵／高鐵：某站今天（依營運日）停靠的班次。都從雲端拿（railDayTt）：先用當天的實際時刻表（/tt/day，KV 快取），
// 沒有才用那個星期幾的那份定期表（台鐵還要在有效期間內、國定假日不用定期表）
async function ttTrainRows(op, id, info) {
  const day = svcDate(0), D = await railDayTt(op, day);
  if (!D || !D.tt || !D.tt.trains) return null;
  const tt = D.tt, hasHol = ttHasHol(tt), ix = info.hol ? 7 : SD_KEYS.indexOf(info.key), sunIx = 6;
  if (!D.daily && info.hol && !hasHol) return null;
  const today = isoDay(day).replace(/-/g, "");
  const rows = [];
  for (const t of tt.trains) {
    if (!D.daily) { const m = t[5] || ""; if (m[ix] !== "1") continue; }
    if (t[7] && t[7].replace(/-/g, "").slice(0, 8) > today) continue; if (t[8] && t[8].replace(/-/g, "").slice(0, 8) < today) continue;
    const stops = t[6].split(";"), si = stops.findIndex(x => x.startsWith(id + ","));
    if (si < 0 || si === stops.length - 1) continue;            // 終點站不列
    const [, a, d] = stops[si].split(",");
    rows.push({ no: t[0], type: D.daily ? shortType(t[1]) : t[1], dir: t[2] === "" ? null : +t[2], dest: t[4], time: hhmm4(d || a) });
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
  // 雲端那份（更新時刻表時一起存的站間行駛時間）優先；雲端沒有才用舊的本機快取／向 TDX 查
  const stored = await ttLoad(op).catch(() => null);
  if (stored && stored.s2s) { try { localStorage.removeItem(S2S_KEY); } catch (e) {} return stored.s2s; }
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
  // 今天適用的那份時刻表（雲端：涵蓋今天的定期表，或當天時刻表），找不到才直接問 TDX
  const op = p.kind === "tra" ? "TRA" : "THSR";
  let stT = null;
  try { const D = await railDayTt(op, svcDate(0)); stT = D && D.tt; } catch (e) {}
  const sT0 = stT && stT.trains && stT.trains.find(t => t[0] === no || t[0] === no.replace(/^0+/, ""));
  const sT = sT0 && stT.daily ? [sT0[0], shortType(sT0[1]), ...sT0.slice(2)] : sT0;
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
  const stored = await ttLoad("TMRT").catch(() => null); if (stored && stored.freq) { try { localStorage.removeItem(TMRT_KEY); } catch (e) {} return stored; }
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
  const metros = RAIL_SYSTEMS.filter(s => s.kind === "metro" && !s.optional && !NO_EXIT.has(s.key));
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
  const metros = new Set(RAIL_SYSTEMS.filter(s => s.kind === "metro" && !s.optional && !NO_EXIT.has(s.key)).map(s => s.key));
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
// TDX MaaS 的輕軌路段 headsign 常是字串 "nan"（資料缺值），當成沒有終點
const planHead = h => { h = String(h ?? "").trim(); return /^(nan|null|undefined|none|-)?$/i.test(h) ? "" : h; };
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
      const t = s.transport || {};
      legs.push({ kind, mode: PLAN_MODE(s), name: t.shortName || t.name || "", longName: t.longName || "", headsign: r.source !== "google" && /環狀輕軌/.test((t.shortName || t.name || "") + (t.longName || "")) ? "" : planHead(t.headsign), color: /^[0-9a-f]{6}$/i.test(t.route_color || "") ? "#" + t.route_color.toUpperCase() : null,
        number: t.number || "", agency: (s.agency && s.agency.agency_id) || "", agencyName: (s.agency && s.agency.name) || "", from, to, dur,
        stops: (s.intermediateStops || []).map(x => pPlace(x.departure || x.arrival)), ...(s.stopCount ? { stopCount: s.stopCount } : {}), ...(t.trainType ? { trainType: t.trainType } : {}) });
    }
    // 換成步行的頭尾段：依公共運輸的時刻往前／往後推，算出新的出發／抵達時間
    const tr = legs.filter(l => l.kind === "transit");
    let start = tms(r.start_time), end = tms(r.end_time);
    if (tr.length) {
      const i0 = legs.indexOf(tr[0]), i1 = legs.indexOf(tr[tr.length - 1]);
      if (legs.slice(0, i0).some(l => l.approx)) start = tms(tr[0].from.time) - legs.slice(0, i0).reduce((a, l) => a + l.dur * 1000, 0);
      if (legs.slice(i1 + 1).some(l => l.approx)) end = tms(tr[tr.length - 1].to.time) + legs.slice(i1 + 1).reduce((a, l) => a + l.dur * 1000, 0);
    } else if (approx) end = start + legs.reduce((a, l) => a + l.dur * 1000, 0);
    const sig = legs.map(l => l.kind === "transit" ? l.name + "@" + l.from.name + ">" + l.to.name + "@" + l.from.time : l.kind).join("|");
    if (out.some(o => o.sig === sig)) continue;   // 同一班車、只差頭尾接駁方式的重複結果
    out.push({ sig, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), approx, legs, src: r.source === "google" ? "google" : r.source === "timetable" ? "tt" : "tdx", ...(r.polyline ? { poly: r.polyline } : {}) });
  }
  return out.filter(r => !r.approx).concat(out.filter(r => r.approx));
}
// TDX 規劃網路還沒收錄的新車站（例如淡水信義線東延段的廣慈/奉天宮，TDX 一律改走到板南線永春站）：
// 起訖點是這種車站時，改用同一條線上相鄰、TDX 認得的車站去查，並在結果上註明
const TDX_MISSING = { "廣慈/奉天宮": { name: "象山", lat: 25.032871, lon: 121.570029, line: "淡水信義線", mode: 6 } };
const planIsStation = p => !!p && !p.here && (!!p.st || /北捷|新北捷|機捷|桃捷|中捷|高捷|捷運|輕軌|台鐵|高鐵/.test(p.sub || ""));
// TDX 和 Google 兩組都校正過之後，照 Worker 原本的規則用「校正後」的時間決定用哪一組（v2.22）：
// faster＝Google 早到 15 分以上或快 15% 以上（指定抵達則是晚出發）；klrt-night＝Google 有搭高雄輕軌、或比較好
function planPickG(T, G, rule, { when, ref, arrBy }) {
  const best = rs => { let b = null;
    for (const r of rs) { if (r.approx) continue; const ft = r.legs.find(l => l.kind === "transit"), f0 = ft ? tms(ft.from.time) : r.start;
      if (when === "arr") { if (arrBy && r.end <= arrBy + 60000 && (b == null || r.start > b)) b = r.start; }
      else if (f0 >= ref - 60000 && (b == null || r.end < b)) b = r.end; }
    return b; };
  const tb = best(T), gb = best(G);
  if (gb == null) return false;
  if (tb == null) return true;
  const better = when === "arr" ? gb > tb : gb < tb;
  if (rule === "klrt-night") return G.some(r => r.legs.some(l => l.kind === "transit" && l.mode === "lrt")) || better;
  const gain = when === "arr" ? gb - tb : tb - gb, base = when === "arr" ? arrBy - tb : tb - ref;
  return gain >= 15 * 60000 || gain >= 0.15 * base;
}
async function planRoutes({ o, d, modes, yb, when, time }) {
  const snapOf = p => { if (!planIsStation(p)) return null; const m = TDX_MISSING[String(p.name || "").replace(/站$/, "")]; return m && modes.includes(m.mode) ? m : null; };
  let so = snapOf(o), sd = snapOf(d); const qo = so || o, qd = sd || d;
  // 座標原樣送出（車站用車站本身的座標，不四捨五入）；換成相鄰站時另外帶原本的座標（Worker 改問 Google 時用）
  const q = new URLSearchParams({ o: `${qo.lat},${qo.lon}`, d: `${qd.lat},${qd.lon}`, t: modes.join(","), gc: "1", yb: yb ? "1" : "0" });
  if (so) q.set("go", `${o.lat},${o.lon}`); if (sd) q.set("gd", `${d.lat},${d.lon}`);
  if (when === "dep" && time) q.set("dep", time); if (when === "arr" && time) q.set("arr", time);
  let out = [], cand = null;
  try {
    const j = await authedGet("/plan?" + q.toString());
    if (!j || j.result !== "success") throw new Error((j && (j.message || j.Message)) || "規劃失敗");
    out = planClean(j.data && j.data.routes, yb);
    // Google 備援的結果是用原本的起訖點查的：不套用「換成相鄰站」的註記，車站頭尾的步行也照常剪掉
    if (j.source === "google" || j.source === "timetable") { so = null; sd = null; }   // Worker 用原本的起訖點查（Google 備援、深夜直達車）
    // Worker 比較過 TDX 和 Google（v2.22）：兩組都帶回來，各自依官方時刻表校正後再用校正過的時間決定用哪一組
    const c = j.data && j.data.cand;
    if (c && Array.isArray(c.tdx) && Array.isArray(c.google) && c.tdx.length && c.google.length) cand = { rule: c.rule, T: planClean(c.tdx, yb), G: planClean(c.google, yb) };
  } catch (e) {
    // TDX 找不到路線（404／result: fail）：回傳空清單，畫面顯示「找不到可行的路線」；登入、次數限制等其他錯誤照常顯示
    if (/登入|頻繁|次數|太多|連線|TDX 5\d\d/.test(e.message) || !/找不到|no route|40001|spec params|fail|規劃失敗|404/i.test(e.message + " " + (e.status || ""))) throw e;
  }
  // 起訖點本身就是車站（從車站清單選的）：在這一站上車／下車的路線，不算進出站的步行，直接從上車時間算起、到下車時間為止
  const ref0 = when === "now" ? Date.now() : when === "dep" && time ? tms(time) : null, arrBy = when === "arr" && time ? tms(time) : null;
  const sysOk = (p, l) => /台鐵/.test(p.sub || "") ? l.mode === "tra" : /高鐵/.test(p.sub || "") ? l.mode === "thsr" : l.mode === "mrt" || l.mode === "lrt";
  const sameSt = (p, pl, l) => sysOk(p, l) && (nameHit(pl.name || "", p.name || "") || (pl.lat != null && haversine(pl.lat, pl.lon, p.lat, p.lon) <= 300));
  // v2.23.3：起訖點是車站時，路線「經過」那一站就在那裡上／下車（TDX 常常坐火車到了屏東站、又下車轉公車繞到屏東站旁邊）：
  // 終點：第一段到達或沿途停靠終點站的同系統軌道車，就在終點站下車，後面的轉乘、步行都拿掉；起點：最後一段從起點站開出（或沿途停靠起點站）的同系統軌道車，
  // 從起點站上車，前面的都拿掉。中途的站要「同名或 300 公尺內」（不用包含比對，免得「北新竹」被當成「新竹」）；最後一段車照舊（原本的頭尾步行剪掉）
  const stHit = (p, pl, l) => sysOk(p, l) && !!pl && ((pl.name && pn(pl.name) === pn(p.name || "")) || (pl.lat != null && haversine(pl.lat, pl.lon, p.lat, p.lon) <= 300));
  const trim = (list, so, sd) => list.map(r => {
    let legs = r.legs, start = r.start, end = r.end, cut = false;
    const tr = () => legs.filter(l => l.kind === "transit");
    if (!sd && planIsStation(d) && tr().length) {
      const lastT = tr()[tr().length - 1];
      for (let k = 0; k < legs.length; k++) {
        const l = legs[k]; if (l.kind !== "transit" || !sysOk(d, l)) continue;
        if (l === lastT ? sameSt(d, l.to, l) : stHit(d, l.to, l)) { if (k < legs.length - 1) { legs = legs.slice(0, k + 1); end = tms(l.to.time); cut = true; } break; }
        const si = (l.stops || []).findIndex(x => x.time && stHit(d, x, l));
        if (si >= 0) { const x = l.stops[si]; legs = [...legs.slice(0, k), { ...l, to: { ...x, type: "station" }, stops: l.stops.slice(0, si), stopCount: si + 1, dur: Math.round((tms(x.time) - tms(l.from.time)) / 1000) }]; end = tms(x.time); cut = true; break; }
      }
    }
    if (!so && planIsStation(o) && tr().length) {
      const firstT = tr()[0];
      for (let k = legs.length - 1; k >= 0; k--) {
        const l = legs[k]; if (l.kind !== "transit" || !sysOk(o, l)) continue;
        if (l === firstT ? sameSt(o, l.from, l) : stHit(o, l.from, l)) { if (k > 0) { legs = legs.slice(k); start = tms(l.from.time); cut = true; } break; }
        const st = l.stops || []; let si = -1; for (let q = st.length - 1; q >= 0; q--) if (st[q].time && stHit(o, st[q], l)) { si = q; break; }
        if (si >= 0) { const x = st[si]; legs = [{ ...l, from: { ...x, type: "station" }, stops: st.slice(si + 1), stopCount: st.length - si, dur: Math.round((tms(l.to.time) - tms(x.time)) / 1000) }, ...legs.slice(k + 1)]; start = tms(x.time); cut = true; break; }
      }
    }
    if (!cut) return r;
    const n = legs.filter(l => l.kind === "transit").length;
    return { ...r, legs, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, n - 1), trimmed: true };
  });
  // 先對官方時刻表（v2.18：捷運／台鐵／高鐵／輕軌的第一班車直接改搭「指定時間以後」的真實班次；v2.22 起 Google 的路線也一樣校正）
  const fix = list => planTtFix(list, { when, ref: ref0 || (when === "now" ? Date.now() : null), arrBy });
  // v2.23.3：校正後接不上後面沒有時刻表的車（公車、沒有時刻表的捷運等）的路線不成立，一律不列（r.broken）；
  // 全部都不成立時：Worker 比較過兩組就改用另一組，否則再問一次 Worker 的備援（fb=1：起訖都是車站時的官方時刻表直達車＋Google），校正後一樣要成立
  const okOf = l => l.filter(r => !r.broken);
  if (cand) {
    let [T, G] = await Promise.all([fix(trim(cand.T, so, sd)), fix(trim(cand.G, null, null))]);
    const T1 = okOf(T), G1 = okOf(G);
    const useG = !T1.length && G1.length ? true : !G1.length && T1.length ? false : planPickG(T1.length ? T1 : T, G1.length ? G1 : G, cand.rule, { when, ref: ref0 || Date.now(), arrBy });
    out = useG ? G : T; if (useG) { so = null; sd = null; }
  } else out = await fix(trim(out, so, sd));
  if (out.length && !okOf(out).length) {
    let fb = [];
    try {
      q.set("fb", "1"); if (so) q.set("o", `${o.lat},${o.lon}`); if (sd) q.set("d", `${d.lat},${d.lon}`); q.delete("go"); q.delete("gd");
      const j = await authedGet("/plan?" + q.toString());
      if (j && j.result === "success") fb = okOf(await fix(trim(planClean(j.data && j.data.routes, yb), null, null)));
    } catch (e) { console.warn("plan fb", e); }
    if (fb.length) { so = null; sd = null; }
    out = fb;
  } else out = okOf(out);
  // 「現在出發」時 TDX 偶爾會給已經開走的班次；「指定出發」時 TDX 也常給比指定時間更早出門的走法（例如指定18:12卻17:54出發）：
  // 同樣路線還有較晚一班的就不列；班次密的第一段改搭下一班；其餘「現在出發」保留但標示，「指定出發」直接拿掉
  const ref = ref0;
  // 對不到時刻表的才用下面的班距估計
  if (ref) {
    const now = ref, late = r => { if (when === "dep") return r.start - ref; const t = r.legs.find(l => l.kind === "transit"); return t ? tms(t.from.time) - ref : 0; };
    // 指定出發：顯示到分鐘也不能早於指定時間；現在出發：TDX 的「現在」常慢幾分鐘，容許1分鐘
    const gone = r => when === "dep" ? Math.floor(r.start / 60000) < Math.floor(ref / 60000) : late(r) < -60000;
    // 第一段是捷運／輕軌／公車這類班次密的：改搭下一班（往後推「已過的時間＋一個班距」），只要下一段前的等車時間夠吸收就照樣可行
    const HW = { mrt: 6, lrt: 10, bus: 12 };
    out = out.map(r => {
      if (!gone(r)) return r;
      const i0 = r.legs.findIndex(l => l.kind === "transit"), L = r.legs[i0], hw = HW[L.mode]; if (!hw) return r;
      const shift = Math.ceil((-late(r) + 60000 + hw * 60000) / 60000) * 60000;
      const i1 = r.legs.findIndex((l, k) => k > i0 && l.kind === "transit");
      const waits = i1 < 0 ? [] : r.legs.slice(i0 + 1, i1).filter(l => l.kind === "wait"), slack = waits.reduce((a, l) => a + l.dur * 1000, 0);
      if (i1 >= 0 && slack < shift) return r;
      const mv = t => t && isoTpe(tms(t) + shift), upto = i1 < 0 ? r.legs.length : r.legs.indexOf(waits[0]);
      const legs = r.legs.map((l, k) => k < upto ? { ...l, from: { ...l.from, time: mv(l.from.time) }, to: { ...l.to, time: mv(l.to.time) }, stops: l.stops && l.stops.map(x => ({ ...x, time: mv(x.time) })) } : l);
      if (i1 >= 0) { let left = shift / 1000; for (const w of waits) { const k = legs.indexOf(w), cut = Math.min(w.dur, left); legs[k] = { ...w, dur: w.dur - cut, from: { ...w.from, time: mv(w.from.time) } }; left -= cut; } }
      const start = r.start + shift, end = i1 < 0 ? r.end + shift : r.end;
      return { ...r, legs, start, end, dur: Math.round((end - start) / 60000), shifted: when === "dep" ? "dep" : true };
    });
    const ok = out.filter(r => !gone(r)), okShape = new Set(ok.map(planShape));
    out = when === "dep" ? ok : ok.concat(out.filter(r => gone(r) && !okShape.has(planShape(r))).map(r => ({ ...r, missed: true })));
  }
  // 末班車後 Google 會連隔天早上的班次一起給：3小時內有車就不列更晚的
  if (ref && when !== "arr") { const near = out.filter(r => r.start - ref < 3 * 3600000); if (near.length) out = near; }
  if (so || sd) {
    const note = so && sd ? `TDX 還沒有${o.name}和${d.name}站的資料，改從相鄰的${so.name}站規劃到${sd.name}站` : so ? `TDX 還沒有${o.name}站的資料，改從相鄰的${so.name}站（同為${so.line}）起算` : `TDX 還沒有${d.name}站的資料，改規劃到相鄰的${sd.name}站（同為${sd.line}）`;
    out = out.map(r => ({ ...r, note }));
  }
  // 一律最快：先到的排前面（指定抵達則是最晚出發的排前面），同時到的轉乘少、走路少的優先
  const walkOf = r => r.legs.reduce((a, l) => a + (l.kind === "walk" ? l.dur : 0), 0);
  // 起點是車站：在這一站直接上車的路線，抵達時間差2分鐘以內也排前面（不用先走到別站）
  const oName = so ? so.name : o.name, atO = r => { if (!planIsStation(o)) return 0; const t = r.legs.find(l => l.kind === "transit"); return t && nameHit(t.from.name, oName) ? 120000 : 0; };
  out.sort((a, b) => (!!a.missed - !!b.missed) || (a.approx - b.approx) || (when === "arr" ? (b.start + atO(b)) - (a.start + atO(a)) : (a.end - atO(a)) - (b.end - atO(b))) || a.dur - b.dur || a.transfers - b.transfers || walkOf(a) - walkOf(b));
  // 去重：①同一種走法、同時出發又同時抵達 ②每段車都同時刻 ③同一班火車同時抵達 ④主要那段車（最久的一段）同一班、同時抵達，只是前面接駁不同（例如兩條都搭同一班1839）；最多列8條
  const seen = new Set(), real = new Set(out.filter(r => !r.shifted).map(r => planShape(r) + "|" + r.end));
  const tsig = r => r.legs.filter(l => l.kind === "transit").map(l => l.mode + "@" + (l.from.time || "").slice(0, 16) + ">" + (l.to.time || "").slice(0, 16)).join("|");
  // v2.23.3：多繞的路線不列：另一條路線搭的車（同一班、同一段）是這條的一部分，這條只是前後多接了幾段車，卻沒有比較晚出發、也沒有比較早到
  // （例如 1839 到屏東轉運站，另一條同一班 1839 再轉 8218 坐一站到真耶穌教會、反而更晚到）
  const legSig = r => r.legs.filter(l => l.kind === "transit").map(l => l.mode + l.name + "@" + l.from.name + ">" + l.to.name + "@" + (l.from.time || "").slice(0, 16));
  const within = (a, b) => { for (let i = 0; i + a.length <= b.length; i++) if (a.every((x, k) => x === b[i + k])) return true; return false; };
  const sigs = out.map(legSig);
  out = out.filter((r, i) => !out.some((y, j) => j !== i && !y.missed && !y.approx && sigs[j].length && sigs[j].length < sigs[i].length && within(sigs[j], sigs[i]) && r.end >= y.end && r.start <= y.start));
  return out.filter(r => !(r.shifted && real.has(planShape(r) + "|" + r.end))).filter(r => {
    const k1 = planShape(r) + "|" + r.start + "|" + r.end, k2 = "t|" + tsig(r);
    const rl = r.legs.filter(l => l.kind === "transit" && (l.mode === "tra" || l.mode === "thsr") && l.number), k3 = rl.length ? "r|" + rl[rl.length - 1].mode + rl[rl.length - 1].number + "|" + Math.round(r.end / 120000) : k1;
    const mt = r.legs.filter(l => l.kind === "transit").sort((x, y) => y.dur - x.dur)[0];
    const k4 = mt ? "m|" + mt.mode + mt.name + "@" + (mt.to.time || "").slice(0, 16) + "|" + Math.round(r.end / 120000) : k1;
    if (seen.has(k1) || seen.has(k2) || seen.has(k3) || seen.has(k4)) return false; [k1, k2, k3, k4].forEach(k => seen.add(k)); return true; }).slice(0, 8);
}
// ---------- 輕軌（以及趕不上時的捷運／台鐵／高鐵）對官方時刻表（v2.17.0） ----------
// TDX MaaS 的輕軌班次大多是推算的假班次（淡海 0/13、安坑 5/10、高雄 0/8 對得上），還會把同一班車拆成好幾段、配錯線（淡海綠山／藍海）、
// 終點寫 "nan" 或高雄成環前的舊端點，高雄行駛時間也偏長。做法：
// ① 連續的同系統輕軌段先合併成「一趟」；② 用 KV 裡由各站官方時刻表串好的車次（TRIPS_系統，依當天日別：平日／假日／國定假日）
//    找「先停上車站、再停下車站」最早到的那班（轉乘要比到站晚至少1分；第一段車不早於指定時間＋前面的步行），到站時間直接用時刻表；
//    高雄是環狀線：同一班車繞回籬仔內後接同方向的下一班（≤5分），方向顯示順行／逆行；整趟找不到就試在中間某站轉一次車（淡海綠山↔藍海）；
// ③ 時間差往後傳：等車重算；後面的車趕不上原班次時，捷運／台鐵／高鐵改查時刻表的下一班，公車等查不到的保留原班次並註明。
// 任何日期都校正（不限12小時內）；時刻表來自 KV（手動更新、瀏覽器記憶體快取），不另外呼叫 TDX。
const tpeSvcDay = ms => { const d = new Date(ms + 5 * 3600000); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };   // 營運日：台北時間03:00前算前一天
const tpeMid = dt => Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - 8 * 3600000;
const dayAdd = (dt, n) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n);
const tripIdxMem = {};
async function tripIdx(op) {
  const m = ((await ttMeta()).systems || {})["TRIPS_" + op]; if (!m) return null;
  const k = op + "|" + m.updated; if (tripIdxMem[k]) return tripIdxMem[k];
  return tripIdxMem[k] = ttLoad("TRIPS_" + op).then(T => {
    if (!T || !T.trips || !T.groups) return null;
    const trips = T.trips.map(tr => { const g = T.groups[tr[0]];
      return { gi: tr[0], g, p: tr[1].split(" ").map(s => { const est = s[0] === "~", [si, hh] = (est ? s.slice(1) : s).split("."); return [g.st[+si], t2m(hh), est]; }) }; });
    // 終點站的到站時間（時刻表只有發車）：用前一站發車＋反方向「終點站→前一站」最常見的站間時間（與 TDX 規劃的行駛時間相符）
    const cnt = {};
    for (const t of trips) for (let k = 1; k < t.p.length; k++) { const a = t.p[k - 1], b = t.p[k]; if (a[2] || b[2]) continue; const c = cnt[a[0] + "|" + b[0]] = cnt[a[0] + "|" + b[0]] || {}; c[b[1] - a[1]] = (c[b[1] - a[1]] || 0) + 1; }
    const seg = {}; for (const [k, c] of Object.entries(cnt)) seg[k] = +Object.entries(c).sort((x, y) => y[1] - x[1])[0][0];
    for (const t of trips) for (let k = 1; k < t.p.length; k++) { const b = t.p[k]; if (!b[2]) continue; const r = seg[b[0] + "|" + t.p[k - 1][0]]; if (r > 0 && r < 15) b[1] = t.p[k - 1][1] + r; }
    return { T, trips, loop: Object.keys(TRIP_LOOP).some(x => x.startsWith(op + "|")), days: {} };
  }).catch(() => { delete tripIdxMem[k]; return null; });
}
// 這個營運日適用的車次群組（平日／假日／國定假日，沿用 pickDay 的規則）
async function tripDayGroups(X, day) {
  const key = day.toDateString(); if (X.days[key]) return X.days[key];
  const info = await dayInfo(day), sds = [...new Set(X.T.groups.map(g => g.sd))].map(sd => ({ sd, ServiceDay: { ...sdObj(X.T.sd[sd].m), ServiceTag: X.T.sd[sd].tag } }));
  return X.days[key] = new Set(pickDay(sds, info).map(x => x.sd));
}
// 某營運日裡所有「A 上車 → B 下車」的班次（絕對時間 ms）
async function tripRides(X, A, B, day) {
  const ok = await tripDayGroups(X, day), base = tpeMid(day), out = [], As = new Set(A), Bs = new Set(B);
  const okTrips = X.trips.filter(t => ok.has(t.g.sd));
  for (const t of okTrips) {
    const i = t.p.findIndex((x, k) => As.has(x[0]) && !x[2] && k < t.p.length - 1); if (i < 0) continue;
    let j = t.p.findIndex((x, k) => k > i && Bs.has(x[0])), arr = j >= 0 ? t.p[j][1] : null, est = j >= 0 && t.p[j][2], via = j >= 0 ? t.p.slice(i + 1, j) : null;
    if (j < 0 && X.loop) {   // 環狀線：繞回端點站後接同方向下一班
      const L = t.p[t.p.length - 1], nx = okTrips.filter(u => u.g.d === t.g.d && u.p[0][0] === L[0] && u.p[0][1] >= L[1] && u.p[0][1] <= L[1] + 5).sort((a, b) => a.p[0][1] - b.p[0][1])[0];
      const j2 = nx ? nx.p.findIndex((x, k) => k > 0 && Bs.has(x[0])) : -1;
      if (j2 > 0) { arr = nx.p[j2][1]; est = nx.p[j2][2]; via = t.p.slice(i + 1, -1).concat(nx.p.slice(0, j2)); }
    }
    if (arr == null) continue;
    const si = t.g.st.indexOf(t.p[i][0]), sj = j >= 0 ? t.g.st.indexOf(t.p[j][0]) : -1;   // 跳站＝直達車（機捷）
    out.push({ dep: base + t.p[i][1] * 60000, arr: base + arr * 60000, est, dest: t.g.dn, destId: t.g.de, dir: t.g.d, line: t.g.l, op: X.T.op, stops: via.map(x => [x[0], base + x[1] * 60000]), skip: si >= 0 && sj > si && sj - si > j - i });
  }
  return out;
}
// TDX 給的班次在上車站有沒有這個時間發車的車（有的話代表配錯線／方向）
async function tripDepAt(op, A, ms) {
  const X = await tripIdx(op); if (!X) return null;
  const day = tpeSvcDay(ms), ok = await tripDayGroups(X, day), base = tpeMid(day), As = new Set(A);
  for (const t of X.trips) { if (!ok.has(t.g.sd)) continue;
    const x = t.p.find((x, k) => As.has(x[0]) && !x[2] && k < t.p.length - 1);
    if (x && Math.abs(base + x[1] * 60000 - ms) < 60000) return { dest: t.g.dn, dir: t.g.d }; }
  return null;
}
// 往後找：dep ≥ ready、最早到（同時到取較晚出發）；往前找（指定抵達）：arr ≤ limit、最晚出發
async function tripPick(op, A, B, { ready, limit }) {
  const X = await tripIdx(op); if (!X || !A || !B || !A.length || !B.length) return null;
  const t = ready != null ? ready : limit, d0 = tpeSvcDay(t);
  const days = ready != null ? [d0, dayAdd(d0, 1)] : [d0, dayAdd(d0, -1)];
  let best = null;
  for (const day of days) {
    for (const c of await tripRides(X, A, B, day)) {
      if (ready != null) { if (c.dep < ready || c.arr <= c.dep) continue; if (!best || c.arr < best.arr || (c.arr === best.arr && c.dep > best.dep)) best = c; }
      else { if (c.arr > limit || c.arr <= c.dep) continue; if (!best || c.dep > best.dep || (c.dep === best.dep && c.arr < best.arr)) best = c; }
    }
    if (best) break;
  }
  return best;
}
// 台鐵／高鐵：A→B 的下一班（時刻表依日期挑：涵蓋那天的定期表，或雲端的當天時刻表；見 railDayTt）
async function trainPick(op, A, B, ready) {
  const As = new Set(A), Bs = new Set(B);
  let best = null;
  for (const day of [tpeSvcDay(ready), dayAdd(tpeSvcDay(ready), 1)]) {
    const P = await railTrains(op, day); if (!P) continue;
    for (const t of P.trains) {
      const i = t.pts.findIndex(x => As.has(x[0])); if (i < 0) continue;
      const j = t.pts.findIndex((x, k) => k > i && Bs.has(x[0])); if (j < 0) continue;
      const c = { dep: P.base + t.pts[i][2] * 60000, arr: P.base + t.pts[j][1] * 60000, no: t.no, type: shortType(t.type), dest: t.dest };
      if (c.dep >= ready && (!best || c.arr < best.arr)) best = c;
    }
    if (best) break;
  }
  return best;
}
// ---------- 捷運／台鐵／高鐵對官方時刻表（v2.18） ----------
// 稽核（10/17）：高鐵時刻全對但沒有車次、會漏掉最早到的班次；台鐵 20 段只有 8 段對（不存在的班次、假快車、車名終點錯）；
// 北捷約 70% 對、其餘差1–3分、終點寫舊的「象山」；機捷把普通車當直達車算；高捷紅線終點寫舊的「岡山高醫」。
// 台鐵：手動更新的定期時刻表涵蓋那天就用它，否則經 Worker 抓 TDX 當天時刻表（KV 快取，每個日期每天最多抓一次）；高鐵一律用當天時刻表（沒有才退回定期）。
const isoDay = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const railDayMem = {}, railParsedMem = {};
async function railDayTt(op, day) {
  const iso = isoDay(day), k = op + "|" + iso; if (railDayMem[k]) return railDayMem[k];
  return railDayMem[k] = (async () => {
    // ① 國定假日、連假或其前一天：那一天的實際時刻表（TDX DailyTimetable，經 Worker 存在 KV；含疏運加班、停駛）。平常日不抓（v2.20）
    const h = await ttLoad("HOLIDAY").catch(() => null);
    if (holRel(h && h.dates, iso)) { try { const j = await authedGet(`/tt/day/${op}/${iso}`); if (j && j.trains && j.trains.length) return { tt: j, daily: true }; } catch (e) {} }
    // ② 那個星期幾的那份定期表；定期表沒有國定假日欄，國定假日不用；台鐵還要在定期表自己的有效期間內
    const stored = await ttDow(op, day);
    if (!stored || !stored.trains || ((await dayInfo(day)).hol && !ttHasHol(stored))) return null;
    if (op === "TRA" && !ttCovers(stored, iso)) return null;
    return { tt: stored, daily: false };
  })().catch(() => { delete railDayMem[k]; return null; });
}
async function railTrains(op, day) {
  const k = op + "|" + isoDay(day); if (railParsedMem[k]) return railParsedMem[k];
  return railParsedMem[k] = (async () => {
    const D = await railDayTt(op, day); if (!D) return null;
    const tt = D.tt, ds = isoDay(day).replace(/-/g, "");
    let ix = -1;
    if (!D.daily) { const info = await dayInfo(day), hasHol = tt.trains.some(t => (t[5] || "")[7] === "1"); if (info.hol && !hasHol) return null; ix = info.hol ? 7 : SD_KEYS.indexOf(info.key); }
    const trains = [];
    for (const t of tt.trains) {
      if (ix >= 0 && (t[5] || "")[ix] !== "1") continue;
      if (t[7] && t[7].replace(/-/g, "").slice(0, 8) > ds) continue; if (t[8] && t[8].replace(/-/g, "").slice(0, 8) < ds) continue;
      let last = -1, roll = 0; const pts = [];
      const m = x => { if (!x) return null; let v = +x.slice(0, 2) * 60 + +x.slice(2); if (v + roll < last) roll += 1440; v += roll; last = v; return v; };
      for (const s of (t[6] || "").split(";")) { const [id, a, d] = s.split(","); const am = m(a), dm = m(d); if (am == null && dm == null) continue; pts.push([id, am ?? dm, dm ?? am]); }
      trains.push({ no: String(t[0]), type: t[1] || "", dir: t[2] === "" || t[2] == null ? null : +t[2], start: t[3] || "", dest: t[4] || "", pts });
    }
    return { base: tpeMid(day), trains };
  })().catch(() => { delete railParsedMem[k]; return null; });
}
// ---------- 車站時刻表查詢（v2.23）：只用雲端 KV（經 Worker）與本機 IndexedDB 快取，不直接打 TDX ----------
// 日期規則同路線規劃：台鐵／高鐵平常日用 7 天定期表，國定假日、連假與其前一天用那天的實際時刻表（railDayTt）；
// 捷運／輕軌用平日／假日班表（dayInfo + pickDay，含國定假日與補班）；文湖線、台中捷運沒有站別時刻表，回傳班距與首末班。
const dateOfIso = x => { const [y, m, d] = String(x).split("-").map(Number); return new Date(y, m - 1, d); };
const clk = m => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
async function stationTT(p) {
  const day = p.date ? dateOfIso(p.date) : svcDate(0), iso = isoDay(day), today = isoDay(svcDate(0));
  const now = iso === today ? (nowMin() < 180 ? nowMin() + 1440 : nowMin()) : iso < today ? 1e6 : -1;
  const di = await dayInfo(day);
  const dayLabel = (di.hol ? `國定假日（${di.name}）` : di.name === "補班" ? "補班日（平日班表）" : "週" + "日一二三四五六"[day.getDay()]) + (di.eve ? "・假日前一天" : "");
  const base = { op: p.op, date: iso, today: iso === today, dayLabel, now };
  return p.op === "TRA" || p.op === "THSR" ? stationTTrain(p, day, base) : stationTTMetro(p, day, di, base);
}
async function stationTTrain(p, day, base) {
  const op = p.op, D = await railDayTt(op, day), P = D && await railTrains(op, day);
  if (!P) return { ...base, kind: "train", none: true, trains: [], dests: [], types: [] };
  const ids = new Set(p.ids), names = {}, reach = {}, trains = [];
  try { for (const s of await loadRailStations()) if (s.op === op) names[s.id] = s.name; } catch (e) {}
  for (const t of P.trains) {
    const i = t.pts.findIndex(x => ids.has(x[0])); if (i < 0 || i === t.pts.length - 1) continue;   // 終點站不列
    const dep = t.pts[i][2], next = {};
    for (let k = i + 1; k < t.pts.length; k++) {
      const [id, a] = t.pts[k]; if (next[id] != null || ids.has(id)) continue;
      next[id] = a; const r = reach[id]; if (!r || a - dep < r.min) reach[id] = { id, min: a - dep, dir: t.dir };
    }
    trains.push({ no: t.no, type: shortType(t.type), dir: t.dir, start: t.start, dest: t.dest, t: dep, time: clk(dep), next });
  }
  trains.sort((a, b) => a.t - b.t);
  const dests = Object.values(reach).filter(r => names[r.id]).map(r => ({ ...r, name: names[r.id] })).sort((a, b) => a.min - b.min);
  const cnt = {}; for (const t of trains) if (t.type) cnt[t.type] = (cnt[t.type] || 0) + 1;
  return { ...base, kind: "train", src: D.daily ? "day" : "7day", trains, dests, types: Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]) };
}
// 班距＋首末班（文湖線存在 TRTC 那份的 hw；台中捷運那份本身就是 freq＋fl）
function hwInfo(freq, fl, ids, di, lines) {
  const lineOfR = r => r.LineID || r.LineNo || "G", out = {};
  const recs = fl.filter(r => ids.includes(r.StationID) && (!lines || lines.includes(lineOfR(r))) && !(r.DestinationStationID && ids.includes(r.DestinationStationID)));
  for (const r of recs) {
    const line = lineOfR(r), fq = freq.filter(f => !(f.LineID || f.LineNo) || (f.LineID || f.LineNo) === line);
    const key = di.hol ? (fq.some(f => f.ServiceDay && f.ServiceDay.NationalHolidays) ? "NationalHolidays" : "Sunday") : di.key;
    if (r.ServiceDay && r.ServiceDay[key] === false) continue;
    const dest = zh(r.DestinationStationName) || "?", k = line + "|" + dest, exact = !!(r.ServiceDay && r.ServiceDay[key]);
    if (out[k] && (out[k].exact || !exact)) continue;
    const plan = fq.find(f => f.ServiceDay && f.ServiceDay[key]) || fq[0];
    const am = x => { const v = toMin(x); return v < 180 ? v + 1440 : v; };
    const bands = ((plan && plan.Headways) || []).map(h => ({ s: hm(h.StartTime), e: hm(h.EndTime), min: h.MinHeadwayMins || h.MaxHeadwayMins, max: h.MaxHeadwayMins || h.MinHeadwayMins }))
      .filter(b => b.s && b.e).sort((a, b) => am(a.s) - am(b.s));
    out[k] = { line, dest, destId: r.DestinationStationID || null, first: hm(r.FirstTrainTime), last: hm(r.LastTrainTime), bands, exact };
  }
  return Object.values(out);
}
async function stationTTMetro(p, day, di, base) {
  const op = p.op, ids = p.ids, out = { ...base, kind: "metro", trains: [], groups: [], hw: [] };
  const stored = await ttLoad(op).catch(() => null);
  const hwL = op === "TMRT" ? null : (HW_LINES[op] || []).filter(l => ids.some(i => stnPre(i) === l));
  if (op === "TMRT" || hwL.length) {
    const src = op === "TMRT" ? (stored && stored.freq ? stored : null) : stored && stored.hw;
    if (src && src.freq && src.fl) out.hw = hwInfo(src.freq, src.fl, ids, di, hwL); else out.hwMissing = true;
  }
  if (stored && stored.rows) {
    let recs = ttMetroRecs(stored, ids);
    const other = op === "TRTC" && ids.some(i => /^Y\d/.test(i)) ? "NTMC" : op === "NTMC" && ids.some(i => !/^(Y|LB)\d/.test(i)) ? "TRTC" : null;
    if (other) { const o2 = await ttLoad(other).catch(() => null); if (o2 && o2.rows) recs = recs.concat(ttMetroRecs(o2, ids)); }
    if (hwL && hwL.length) recs = recs.filter(r => !hwL.includes(r.LineID || lineOf(op, r.StationID)));
    recs = recs.length ? pickDay(recs, { ...di }) : [];
    const fix = await destFixer(op), seen = new Set(), dirsOf = {}, list = [];
    for (const r of recs) {
      const dest = zh(r.DestinationStationName) || `方向${r.Direction ?? "?"}`, line = r.LineID || lineOf(op, r.StationID), dir = r.Direction ?? null;
      (dirsOf[dest + "|" + line] = dirsOf[dest + "|" + line] || new Set()).add(dir);
      for (const x0 of (r.Timetables || [])) {
        const x = hm(x0.DepartureTime || x0.ArrivalTime); if (!x) continue;
        const k = [line, dest, dir, x].join("|"); if (seen.has(k)) continue; seen.add(k);
        const v = toMin(x);
        list.push(fix({ time: x, t: v < 180 ? v + 1440 : v, dest, destId: r.DestinationStationID || null, line, dir, via: null }));
      }
    }
    const trains = list.filter(t => !(t.destId && ids.includes(t.destId)));
    for (const t of trains) {
      if (dirsOf[t.dest + "|" + t.line].size > 1) t.via = op === "KLRT" ? (t.dir === 1 ? "順行" : "逆行") : `方向${t.dir}`;
      t.side = metroSide(t, ids);
    }
    trains.sort((a, b) => a.t - b.t);
    // 方向分組：同一條線、同一側（往站序大／小）算一組，標示列出最常見的終點
    const gm = new Map();
    for (const t of trains) {
      const k = (t.line || "") + "|" + (t.side ?? ("x" + t.dest)) + "|" + (t.via || "");
      if (!gm.has(k)) gm.set(k, { key: k, line: t.line, via: t.via, cnt: {}, n: 0 });
      const g = gm.get(k); g.n++; g.cnt[t.dest] = (g.cnt[t.dest] || 0) + 1; t.g = k;
    }
    out.groups = [...gm.values()].map(g => ({ key: g.key, line: g.line, n: g.n, label: "往 " + Object.keys(g.cnt).sort((a, b) => g.cnt[b] - g.cnt[a]).join("／") + (g.via ? `（${g.via}）` : "") }));
    out.trains = trains;
  }
  out.none = !out.trains.length && !out.hw.length;
  return out;
}
// 先停 A、後停 B 的班次，發車時間在 [t0, t1]（絕對時間 ms）
async function railRides(op, A, B, t0, t1) {
  const As = new Set(A), Bs = new Set(B), out = [], d0 = tpeSvcDay(t0), d1 = tpeSvcDay(t1);
  const days = [d0]; if (new Date(t0 + 8 * 3600000).getUTCHours() < 5) days.unshift(dayAdd(d0, -1)); if (d1 > d0) days.push(d1);
  for (const day of days) {
    const P = await railTrains(op, day); if (!P) continue;
    for (const t of P.trains) {
      const i = t.pts.findIndex(p => As.has(p[0])); if (i < 0) continue;
      let j = -1; for (let k = i + 1; k < t.pts.length; k++) if (Bs.has(t.pts[k][0])) { j = k; break; }
      if (j < 0) continue;
      const dep = P.base + t.pts[i][2] * 60000, arr = P.base + t.pts[j][1] * 60000;
      if (dep < t0 || dep > t1 || arr <= dep) continue;
      out.push({ dep, arr, no: t.no, type: t.type, start: t.start, dest: t.dest, op, stops: t.pts.slice(i + 1, j).map(p => [p[0], P.base + p[1] * 60000]) });
    }
  }
  return out;
}
const TRA_TYPE = t => { t = shortType(t); return /^(自強|莒光|復興)$/.test(t) ? t + "號" : t === "區間" ? "區間車" : t; };
// 過時的終點名：淡水信義線已延伸到廣慈/奉天宮、高雄紅線已延伸到岡山車站
const HEAD_OLD = { "岡山高醫": "岡山車站", "南岡山": "岡山車站" };
const headNew = (l, h) => { h = planHead(h); h = HEAD_OLD[h] || h; if (h === "象山" && /淡水信義/.test(l.name || "")) h = "廣慈/奉天宮"; return h; };
const MRT_TT = { TRTC: "北捷", NTMC: "環狀線", TYMC: "機捷" }, MRT_SYS = { ...MRT_TT, KRTC: "高捷" };   // 有站別時刻表、可串車次的捷運（文湖線、台中捷運沒有；高捷只修終點名）
const RAIL_SYS = { tra: "台鐵", thsr: "高鐵" };
const trainLab = c => c.op === "THSR" ? `${c.no}次` : `${TRA_TYPE(c.type)}${c.no}次`;
const earliest = (cs, ready, max) => cs.filter(c => c.dep >= ready && (max == null || c.dep <= max)).sort((a, b) => a.arr - b.arr || b.dep - a.dep)[0] || null;
const rideKey = c => c.op + "|" + c.no + "|" + c.dep;
const latest = (cs, limit) => cs.filter(c => c.arr <= limit).sort((a, b) => b.dep - a.dep || a.arr - b.arr)[0] || null;
// 一段捷運／台鐵／高鐵：回傳 { c: 真實班次, note, sys } 或 { keep, warn }；null 表示這段沒有時刻表可對（照舊）
// ready：最早能上車的時間（第一段＝指定時間＋前面的步行，之後＝前一段到站＋1分）；readyX：改搭「更早到」的班次時要求的轉乘餘裕；limit：指定抵達的第一段
async function railFix(leg, { p0, a0, ready, readyX, limit, stOf, first, avoid }) {
  if (leg.mode === "mrt" && /文湖/.test(leg.name || "")) return null;
  const A = await stOf(leg, "from"), B = await stOf(leg, "to");
  if (!A || !B || A.op !== B.op) return null;
  const op = A.op, nmA = leg.from.name || A.name || "", nmB = leg.to.name || B.name || "";
  const okR = c => limit != null ? c.arr <= limit : c.dep >= ready;
  if (leg.mode === "mrt") {
    // 高捷：TDX 時刻正確，只有「第一班車比出發時間早」時才改搭時刻表上的下一班（不再用班距估計）
    const krtcEarly = op === "KRTC" && first && limit == null && p0 < ready - 1000;
    if (!MRT_TT[op] && !krtcEarly) return null;
    let c = null;
    if (limit != null) c = await tripPick(op, A.ids, B.ids, { limit });
    if (!c) { c = await tripPick(op, A.ids, B.ids, { ready }); if (c && c.dep - ready > 45 * 60000) c = null; }
    if (!c) return null;
    if (krtcEarly) c = { ...c, arr: c.dep + (a0 - p0), stops: null, shift: c.dep - p0 };   // 高捷串車次的到站時間不可靠：行駛時間照 TDX
    // 終點站只有發車時刻，到站時間是推估的：TDX 的行駛時間合理（差 5 分內）就用 TDX 的
    if (c.est && Math.abs((a0 - p0) - (c.arr - c.dep)) <= 5 * 60000) c = { ...c, arr: c.dep + Math.round((a0 - p0) / 60000) * 60000 };
    const dd = Math.abs(c.dep - p0) >= 60000, da = Math.abs(c.arr - a0) >= 60000;
    let note = null;
    const ty = c => op === "TYMC" ? (c.skip ? "直達車" : "普通車") : "";
    if (dd) {
      const early = p0 < ready - 1000, alt = early ? null : (await tripRides(await tripIdx(op), A.ids, B.ids, tpeSvcDay(p0)).catch(() => [])).find(x => Math.abs(x.dep - p0) < 60000);
      const why = early ? (first ? `TDX 給的 ${hmTpe(p0)} 班次比出發時間早` : `接不上 ${hmTpe(p0)} 的${leg.name}`) : alt ? `TDX 給的 ${hmTpe(p0)} ${ty(alt) || "班次"}比較晚到` : `TDX 給的 ${hmTpe(p0)} ${leg.name}不在時刻表上`;
      note = `${why}，改搭 ${hmTpe(c.dep)} ${ty(c)}往${c.dest}（${hmTpe(c.arr)} 到${nmB}）`;
    } else if (da) note = `${hmTpe(c.dep)} ${leg.name}${ty(c)}，${hmTpe(c.arr)} 到${nmB}（TDX 估 ${hmTpe(a0)}）`;
    return { c, note, sys: MRT_SYS[op] };
  }
  if (leg.mode !== "tra" && leg.mode !== "thsr") return null;
  if (op !== (leg.mode === "tra" ? "TRA" : "THSR")) return null;
  const lo = Math.min(p0, ready != null ? ready : p0, limit != null ? limit - 6 * 3600000 : p0) - 20 * 60000, hi = Math.max(p0, ready || 0) + 4 * 3600000;
  const all = await railRides(op, A.ids, B.ids, lo, hi);
  // 第一段車被改搭時，避開前面幾條路線已經用掉的班次（例如 TDX 三條都給不存在的班次時，改成三班不同的真實班次，而不是三條一樣）
  const fresh = first && avoid ? all.filter(c => !avoid.has(rideKey(c))) : all, rides = fresh.length ? fresh : all;
  if (!all.length) return { keep: true, warn: `時刻表上找不到 ${hmTpe(p0)} 從${nmA}到${nmB}的${RAIL_SYS[leg.mode]}班次` };
  const sys = RAIL_SYS[leg.mode];
  if (leg.mode === "thsr") {
    const m = all.filter(c => Math.abs(c.dep - p0) <= 60000).sort((a, b) => Math.abs(a.arr - a0) - Math.abs(b.arr - a0))[0] || null;
    if (m && okR(m)) {
      if (limit != null) return { c: m, note: null, sys };
      const e = earliest(rides, readyX != null ? readyX : ready);
      if (e && e.arr <= m.arr - 60000) return { c: e, sys, note: `TDX 沒列出更早到的 ${e.no}次：${hmTpe(e.dep)} 開、${hmTpe(e.arr)} 到${nmB}（原 ${m.no}次 ${hmTpe(m.arr)} 到）` };
      return { c: m, note: null, sys };
    }
    const c = limit != null ? latest(rides, limit) || latest(all, limit) : earliest(rides, ready, ready + 3 * 3600000) || earliest(all, ready, ready + 3 * 3600000);
    if (!c) return { keep: true, warn: `${hmTpe(ready || p0)} 以後 3 小時內時刻表上沒有從${nmA}到${nmB}的高鐵` };
    if (limit != null && m) return { c, sys, note: `TDX 給的 ${m.no}次 ${hmTpe(m.arr)} 才到，來不及，改搭 ${hmTpe(c.dep)} ${c.no}次（${hmTpe(c.arr)} 到）` };
    return { c, sys, note: `${p0 < (ready || 0) - 1000 ? (first ? `TDX 給的 ${hmTpe(p0)} 高鐵比出發時間早` : `接不上 ${hmTpe(p0)} 的高鐵`) : `TDX 給的 ${hmTpe(p0)} 高鐵不在時刻表上`}，改搭 ${hmTpe(c.dep)} ${c.no}次（${hmTpe(c.arr)} 到）` };
  }
  // 台鐵：上車站發車 ±3 分、下車站到站 ±3 分 → 同一班車（同分取沿途停靠站較吻合的）
  const stopHit = c => { const ns = (leg.stops || []).map(s => s.time && tms(s.time)).filter(Boolean); if (!ns.length) return 0; const ts = c.stops.map(x => x[1]); return ns.filter(t => ts.some(u => Math.abs(u - t) <= 120000)).length / ns.length; };
  const near = all.filter(c => Math.abs(c.dep - p0) <= 180000);
  const m = near.filter(c => Math.abs(c.arr - a0) <= 180000).sort((a, b) => (Math.abs(a.dep - p0) + Math.abs(a.arr - a0)) / 60000 - stopHit(a) - ((Math.abs(b.dep - p0) + Math.abs(b.arr - a0)) / 60000 - stopHit(b)))[0] || null;
  if (m && okR(m)) {
    // v2.23.3：跟高鐵一樣，TDX 給的那班之外、趕得上又早到 3 分鐘以上的台鐵（例如 0207 到左營後 TDX 給 10:13 區間快 10:54 到屏東，漏了 10:20 自強號 10:43 到）就改搭
    if (limit == null) { const e = earliest(rides, readyX != null ? readyX : ready); if (e && e.no !== m.no && e.arr <= m.arr - 3 * 60000) return { c: e, sys, note: `TDX 沒列出更早到的${trainLab(e)}：${hmTpe(e.dep)} 開、${hmTpe(e.arr)} 到${nmB}（原${trainLab(m)} ${hmTpe(m.arr)} 到）` }; }
    const ch = Math.abs(m.dep - p0) >= 60000 || Math.abs(m.arr - a0) >= 60000;
    return { c: m, sys, note: ch ? `${trainLab(m)}實際 ${hmTpe(m.dep)} 開、${hmTpe(m.arr)} 到（TDX 估 ${hmTpe(p0)}–${hmTpe(a0)}）` : null };
  }
  const c = limit != null ? latest(rides, limit) || latest(all, limit) : earliest(rides, ready, ready + 3 * 3600000) || earliest(all, ready, ready + 3 * 3600000);
  if (!c) return { keep: true, warn: `${hmTpe(ready || p0)} 以後 3 小時內時刻表上沒有從${nmA}到${nmB}的台鐵` };
  const same = near.filter(x => Math.abs(x.arr - a0) > 180000).sort((a, b) => Math.abs(a.dep - p0) - Math.abs(b.dep - p0))[0];   // 那個時間確實有車，但 TDX 的到站時間是錯的（假快車）
  let why;
  if (same && same.no === c.no) why = `TDX 估 ${hmTpe(a0)} 到，${trainLab(c)}實際 ${hmTpe(c.arr)} 才到`;
  else {
    const early = p0 < (ready || 0) - 1000;
    why = m && limit != null ? `${trainLab(m)} ${hmTpe(m.arr)} 才到，來不及` : m ? (early && first ? `TDX 給的 ${trainLab(m)}（${hmTpe(m.dep)} 開）比出發時間早` : `接不上 ${hmTpe(m.dep)} 的${trainLab(m)}`) : same ? `TDX 給的 ${hmTpe(p0)} 班次是${trainLab(same)}，實際 ${hmTpe(same.arr)} 才到` : early ? (first ? `TDX 給的 ${hmTpe(p0)} 班次比出發時間早` : `接不上 ${hmTpe(p0)} 的台鐵`) : `TDX 給的 ${hmTpe(p0)}–${hmTpe(a0)} 班次不在時刻表上`;
    why += `，改搭 ${hmTpe(c.dep)} ${trainLab(c)}（${hmTpe(c.arr)} 到）`;
  }
  return { c, sys, note: why };
}
const KLRT_DIR = d => d === 1 ? "順行" : "逆行";   // 高雄輕軌 Direction 1＝順行、0＝逆行（已對照即時看板）
const NTD_LINE = { V11: "紅樹林－崁頂", V26: "紅樹林－淡水漁人碼頭" };
async function planTtFix(routes, opt = {}) {
  const stMemo = new Map();
  opt = { ...opt, avoid: new Set() };
  const stOf = (leg, end) => { const p = leg[end] || {}, k = leg.mode + "|" + (p.name || "") + "|" + p.lat + "," + p.lon;
    if (!stMemo.has(k)) stMemo.set(k, planRailStation(leg, end).catch(() => null)); return stMemo.get(k); };
  const out = [];
  for (const r of routes) {
    if (!r.legs.some(l => l.kind === "transit" && (l.mode === "lrt" || l.mode === "mrt" || l.mode === "tra" || l.mode === "thsr"))) { out.push(r); continue; }
    if (r.src === "tt") { out.push(r); continue; }   // 深夜直達車（v2.21）：本來就取自官方時刻表
    if (r.src === "google") {   // v2.22：Google 的路線也依官方時刻表校正（同 TDX）；註記裡的來源改成 Google
      let x; try { x = await planRetime(r, stOf, opt); } catch (e) { console.warn("planRetime", e); x = r; }
      out.push(x.ttNote ? { ...x, ttNote: x.ttNote.replace(/TDX/g, "Google") } : x); continue;
    }
    try { out.push(await planRetime(r, stOf, opt)); } catch (e) { console.warn("planRetime", e); out.push(r); }
  }
  return out;
}
async function planRetime(r, stOf, opt) {
  const { when, ref, arrBy } = opt;
  // ① 合併：同系統輕軌段之間只有等車段（MaaS 把同一班車拆成好幾段）
  const L0 = [];
  for (let i = 0; i < r.legs.length; i++) {
    const l = r.legs[i];
    if (l.kind !== "transit" || l.mode !== "lrt") { L0.push(l); continue; }
    const parts = [l]; let j = i;
    for (;;) { let k = j + 1; while (k < r.legs.length && r.legs[k].kind === "wait") k++;
      const n = r.legs[k]; if (n && n.kind === "transit" && n.mode === "lrt" && n.name === l.name) { parts.push(n); j = k; } else break; }
    const last = parts[parts.length - 1];
    L0.push(parts.length > 1 ? { ...l, to: last.to, dur: (tms(last.to.time) - tms(l.from.time)) / 1000, stops: [], parts } : { ...l, parts });
    i = j;
  }
  const res = [], notes = [], warns = [], sysNames = new Set();
  // 沿途停靠站（官方時刻）：站名與座標取自車站清單
  let stIx = null;
  const stopsOf = async c => { if (!c.stops || !c.stops.length) return [];
    if (!stIx) { stIx = {}; try { for (const x of await railAll()) if (x.id) stIx[x.op + "|" + x.id] = x; } catch (e) {} }
    return c.stops.map(([id, ms]) => { const x = stIx[c.op + "|" + id] || {}; return { name: x.name || id, type: "station", lat: x.lat ?? null, lon: x.lon ?? null, time: isoTpe(ms) }; }); };
  let cursor = null, origCursor = null, first = true, start = r.start, firstFixed = false, broken = null;
  const pre = [];
  const walkSum = ls => ls.reduce((a, l) => a + (l.kind === "wait" ? 0 : l.dur * 1000), 0);
  const pushWait = (leg, at, dep) => { if (dep - at > 30000) res.push({ kind: "wait", from: { ...leg.from, time: isoTpe(at) }, to: { ...leg.from, time: isoTpe(dep) }, dur: Math.round((dep - at) / 1000) }); };
  const retimed = (leg, dep, arr, extra) => ({ ...leg, stops: [], stopCount: undefined, ...extra, from: { ...leg.from, time: isoTpe(dep) }, to: { ...leg.to, time: isoTpe(arr) }, dur: Math.round((arr - dep) / 1000), ttFix: { from: leg.from.time, to: leg.to.time } });
  for (let li = 0; li < L0.length; li++) {
    const leg = L0[li];
    if (leg.kind !== "transit") {
      if (first) { pre.push(leg); continue; }
      if (leg.kind === "wait") continue;      // 等車段重算
      res.push({ ...leg, from: { ...leg.from, time: isoTpe(cursor) }, to: { ...leg.to, time: isoTpe(cursor + leg.dur * 1000) } });
      cursor += leg.dur * 1000; origCursor += leg.dur * 1000; continue;
    }
    const p0 = tms(leg.from.time), a0 = tms(leg.to.time), { parts, ...base } = leg;
    if (leg.mode === "lrt") {
      const A = await stOf(parts[0], "from"), B = await stOf(parts[parts.length - 1], "to");
      const op = A && B && A.op === B.op && /LRT$/.test(A.op) ? A.op : null;
      let ready = first ? (ref != null ? ref : start) + walkSum(pre) : cursor + 60000;
      let picks = null;
      if (op) {
        // 指定抵達、第一段就是輕軌：找趕得上下一段（或指定抵達時間）的最晚一班
        if (first && when === "arr") {
          const nk = L0.findIndex((l, k) => k > li && l.kind === "transit");
          const lim = nk >= 0 ? tms(L0[nk].from.time) - walkSum(L0.slice(li + 1, nk)) - 60000 : (arrBy || a0) - walkSum(L0.slice(li + 1));
          const c = await tripPick(op, A.ids, B.ids, { limit: lim }); if (c) picks = [c];
        }
        if (!picks) { const c = await tripPick(op, A.ids, B.ids, { ready }); if (c) picks = [c]; }
        // 整趟沒有直達的車：試在中間某個分段站轉一次車（例如淡海綠山線↔藍海線）
        if (!picks && parts.length > 1) {
          for (let k = 0; k < parts.length - 1; k++) {
            const M = await stOf(parts[k], "to"); if (!M || M.op !== op) continue;
            const c1 = await tripPick(op, A.ids, M.ids, { ready }); if (!c1) continue;
            const c2 = await tripPick(op, M.ids, B.ids, { ready: c1.arr + 60000 }); if (!c2) continue;
            if (!picks || c2.arr < picks[1].arr) picks = [c1, c2, parts[k].to];
          }
        }
      }
      if (!picks) {   // 時刻表查不到：保留 TDX 的班次（高雄 headsign 是舊端點，不顯示）
        const keep = { ...base, headsign: op === "KLRT" || /環狀輕軌/.test(leg.name) ? "" : base.headsign };
        if (!first) { if (p0 < cursor) { warns.push(`${hmTpe(cursor)} 到${leg.from.name || "車站"}，可能趕不上 ${hmTpe(p0)} 的${leg.name || "輕軌"}`); broken = broken || leg.name || "輕軌"; } pushWait(leg, cursor, p0); }
        else { res.push(...pre); }
        res.push(keep); cursor = a0; origCursor = a0; first = false; continue;
      }
      sysNames.add(leg.name || "輕軌");
      const lab = c => op === "KLRT" ? KLRT_DIR(c.dir) : "往" + c.dest;
      const mk = (c, from, to) => retimed({ ...base, from, to }, c.dep, c.arr, { headsign: op === "KLRT" ? "" : c.dest, via: op === "KLRT" ? KLRT_DIR(c.dir) : null, tt: true,
        ...(op === "NTDLRT" && NTD_LINE[c.destId] ? { longName: NTD_LINE[c.destId] } : {}) });
      const legsNew = picks.length === 1 ? [mk(picks[0], leg.from, leg.to)] : [mk(picks[0], leg.from, picks[2]), mk(picks[1], picks[2], leg.to)];
      for (let q = 0; q < legsNew.length; q++) { const st = await stopsOf(picks[q]); if (st.length) legsNew[q] = { ...legsNew[q], stops: st, stopCount: st.length + 1 }; }
      const nd = picks[0].dep, na = (picks[1] || picks[0]).arr;
      if (first) {
        // 第一段：前面的步行改成剛好趕上這班車（不留等車）
        const w = pre.filter(l => l.kind !== "wait"); let t = nd - walkSum(w);
        for (const l of w) { res.push({ ...l, from: { ...l.from, time: isoTpe(t) }, to: { ...l.to, time: isoTpe(t + l.dur * 1000) } }); t += l.dur * 1000; }
        start = nd - walkSum(w); firstFixed = true;
      } else pushWait(leg, cursor, nd);
      res.push(legsNew[0]);
      if (legsNew[1]) { pushWait(legsNew[1], picks[0].arr, picks[1].dep); res.push(legsNew[1]); }
      const atA = Math.abs(nd - p0) >= 60000 ? await tripDepAt(op, A.ids, p0).catch(() => null) : null;
      const sameWay = atA && (op === "KLRT" ? atA.dir === picks[0].dir : atA.dest === picks[0].dest);   // 那班車也會到，只是比較晚到（改搭更早到的）
      const why = sameWay ? "比較晚到" : atA ? `是往${op === "KLRT" ? KLRT_DIR(atA.dir) : atA.dest}的車，不會到${leg.to.name || "下車站"}` : "不在時刻表上";
      if (Math.abs(nd - p0) >= 60000) notes.push(`TDX 給的 ${hmTpe(p0)} 班次${why}，改搭 ${hmTpe(nd)} ${lab(picks[0])}${legsNew[1] ? `，在${picks[2].name || "中途站"}轉 ${hmTpe(picks[1].dep)} ${lab(picks[1])}` : ""}`);
      else if (legsNew[1]) notes.push(`${hmTpe(nd)} ${lab(picks[0])}，在${picks[2].name || "中途站"}轉 ${hmTpe(picks[1].dep)} ${lab(picks[1])}`);
      else if (Math.abs(na - a0) >= 60000) notes.push(`${hmTpe(nd)} ${lab(picks[0])}，${hmTpe(na)} 到${leg.to.name || ""}（TDX 估 ${hmTpe(a0)}）`);
      cursor = na; origCursor = a0; first = false; continue;
    }
    // 捷運（北捷／環狀線／機捷）、台鐵、高鐵：對官方時刻表（v2.18）
    if (leg.mode === "mrt") base.headsign = headNew(base, base.headsign);
    if (leg.mode === "mrt" || leg.mode === "tra" || leg.mode === "thsr") {
      const rdy = first ? (ref != null ? ref : start) + walkSum(pre) : cursor + 60000;
      let lim = null;
      if (first && when === "arr") { const nk = L0.findIndex((l, k) => k > li && l.kind === "transit"); lim = nk >= 0 ? tms(L0[nk].from.time) - walkSum(L0.slice(li + 1, nk)) - 60000 : (arrBy || a0) - walkSum(L0.slice(li + 1)); }
      const rf = await railFix(base, { p0, a0, ready: rdy, readyX: first ? rdy : cursor + (leg.mode === "thsr" ? 180000 : 120000), limit: lim, stOf, first, avoid: opt.avoid }).catch(e => { console.warn("railFix", e); return null; });
      if (rf && rf.c) {
        const c = rf.c, st = c.shift != null ? (base.stops || []).map(x => ({ ...x, time: x.time && isoTpe(tms(x.time) + c.shift) })) : await stopsOf(c);
        const extra = leg.mode === "mrt" ? { tt: true, headsign: headNew(base, c.dest), ...(c.op === "TYMC" ? { trainType: c.skip ? "直達車" : "普通車" } : {}) }
          : { tt: true, number: c.no, trainType: leg.mode === "tra" ? TRA_TYPE(c.type) : "", headsign: c.dest, ...(c.start && c.dest ? { name: `${c.start}-${c.dest}`, longName: `${c.start}-${c.dest}` } : {}) };
        const nl = retimed(base, c.dep, c.arr, { ...extra, ...(st.length ? { stops: st, stopCount: st.length + 1 } : {}) });
        if (first) {
          const w = pre.filter(l => l.kind !== "wait"); let t = c.dep - walkSum(w);
          for (const l of w) { res.push({ ...l, from: { ...l.from, time: isoTpe(t) }, to: { ...l.to, time: isoTpe(t + l.dur * 1000) } }); t += l.dur * 1000; }
          start = c.dep - walkSum(w); firstFixed = true;
        } else pushWait(nl, cursor, c.dep);
        if (rf.note) { notes.push(rf.note); sysNames.add(rf.sys); nl._note = notes.length - 1; }
        res.push(nl);
        if (first && opt.avoid && c.no) opt.avoid.add(rideKey(c));
        cursor = c.arr; origCursor = a0; first = false; continue;
      }
      if (rf && rf.warn) warns.push(rf.warn);
    }
    // 其他車（公車、文湖線、台中捷運、高捷，或時刻表對不到的）：時刻不動，除非前面延後而趕不上
    if (first) { res.push(...pre, base); cursor = a0; origCursor = a0; first = false; continue; }
    const catchable = cursor <= origCursor || p0 >= cursor + 60000;
    if (catchable) { pushWait(base, cursor, p0); res.push(base); cursor = a0; origCursor = a0; continue; }
    const ready = cursor + 60000;
    let c = null;
    if (leg.mode === "mrt" || leg.mode === "tra" || leg.mode === "thsr") {
      const A = await stOf(leg, "from"), B = await stOf(leg, "to");
      if (A && B && A.op === B.op) c = leg.mode === "mrt" ? await tripPick(A.op, A.ids, B.ids, { ready }) : await trainPick(A.op, A.ids, B.ids, ready);
    }
    if (c) {
      const nl = retimed(base, c.dep, c.arr, leg.mode === "mrt" ? { tt: true, headsign: c.dest || base.headsign, stops: await stopsOf(c) } : { tt: true, number: c.no, trainType: c.type || base.trainType, headsign: c.dest || base.headsign });
      pushWait(nl, cursor, c.dep); res.push(nl);
      notes.push(`接不上原本 ${hmTpe(p0)} 的${leg.mode === "tra" || leg.mode === "thsr" ? (c.type || leg.name) : leg.name}，改搭 ${hmTpe(c.dep)}${leg.mode === "tra" || leg.mode === "thsr" ? ` ${c.no}次` : ""}`);
      cursor = c.arr; origCursor = a0;
    } else if (leg.mode === "mrt" && /文湖|烏日|中捷/.test((leg.name || "") + (leg.agency || ""))) {
      // 文湖線、台中捷運沒有站別時刻表（班距 2–10 分）：依班距估計下一班，行駛時間照 TDX
      const dep = Math.ceil(ready / 60000) * 60000 + 2 * 60000, arr = dep + (a0 - p0);
      const nl = { ...base, from: { ...base.from, time: isoTpe(dep) }, to: { ...base.to, time: isoTpe(arr) }, stops: (base.stops || []).map(x => ({ ...x, time: x.time && isoTpe(tms(x.time) + dep - p0) })), est: true };
      pushWait(nl, cursor, dep); res.push(nl);
      warns.push(`${leg.name}沒有時刻表，接不上 ${hmTpe(p0)} 那班，依班距估計 ${hmTpe(dep)} 上車`);
      cursor = arr; origCursor = a0;
    } else {
      warns.push(`${hmTpe(cursor)} 才到${leg.from.name || "轉乘站"}，可能趕不上 ${hmTpe(p0)} 的${leg.name || MODE_NAME[leg.mode] || "車"}`);
      broken = broken || leg.name || MODE_NAME[leg.mode] || "車";   // v2.23.3：校正後接不上沒有時刻表可改的車（公車等）→ 這條路線不成立，planRoutes 會拿掉
      res.push(base); cursor = a0; origCursor = a0;
    }
  }
  if (first) return r;
  // TDX 在中途站換車、校正後兩段是同一班火車（例如兩段都改成 238 次）：合併成一段，不必下車
  for (let k = 0; k < res.length; k++) {
    const L = res[k]; if (L.kind !== "transit" || !L.number || (L.mode !== "tra" && L.mode !== "thsr")) continue;
    let j = k + 1; while (j < res.length && res[j].kind === "wait") j++;
    const M = res[j]; if (!M || M.kind !== "transit" || M.mode !== L.mode || M.number !== L.number) continue;
    const mid = { name: L.to.name, type: "station", lat: L.to.lat ?? null, lon: L.to.lon ?? null, time: M.from.time }, st = [...(L.stops || []), mid, ...(M.stops || [])];
    if (L._note != null && notes[L._note]) { const n0 = notes[L._note], n1 = n0.replace(`（${hmTpe(tms(L.to.time))} 到）`, `（${hmTpe(tms(M.to.time))} 到${M.to.name || ""}）`);
      notes[L._note] = n1 !== n0 ? n1 : `${n0}（${L.to.name || "中途站"}），續坐到${M.to.name || "下車站"} ${hmTpe(tms(M.to.time))}`; }
    if (M._note != null) notes[M._note] = null;
    res.splice(k, j - k + 1, { ...L, to: M.to, dur: Math.round((tms(M.to.time) - tms(L.from.time)) / 1000), stops: st, stopCount: st.length + 1 });
    k--;
  }
  for (let k = notes.length - 1; k >= 0; k--) if (!notes[k]) notes.splice(k, 1);
  for (const l of res) delete l._note;
  const end = cursor;
  const sys = [...sysNames].join("、");
  const ttNote = [notes.length ? `${sys || "班次"}已依官方時刻表校正：` + notes.join("；") : "", ...warns.map(w => "注意：" + w)].filter(Boolean).join("；");
  const tr = res.filter(l => l.kind === "transit");
  const o = { ...r, legs: res, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), ttNote: [r.ttNote, ttNote].filter(Boolean).join("；") || undefined, ...(warns.length ? { ttWarn: true } : {}), ...(broken ? { broken } : {}) };
  if (firstFixed) { delete o.shifted; delete o.missed; }
  return o;
}
const MODE_NAME = { bus: "公車", mrt: "捷運", lrt: "輕軌", tra: "台鐵", thsr: "高鐵" };
const addNote = (a, b) => a ? a + "；" + b.replace(/^淡海輕軌已依官方時刻表校正：|^.*?已依官方時刻表校正：/, "") : b;
const hmTpe = ms => isoTpe(ms).slice(11, 16);
// 路線「形狀」：搭哪些車、在哪上下車（不看時間），用來判斷是不是同一種走法
const planShape = r => r.legs.filter(l => l.kind === "transit").map(l => l.name + "@" + l.from.name + ">" + l.to.name).join("|");
const isoTpe = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
// Google 來源路線的靜態地圖（Worker 代理 Maps Static API，金鑰不在前端）：回傳 blob URL；Maps Static API 沒開通時回 null（之後這次開啟 App 都不再試）
let gmapOff = false;
async function gmapImg({ poly, o, d, x }) {
  if (gmapOff || !poly || !o || !d) return null;
  const proxy = getProxy(), s = getSession(); if (!proxy) return null;
  const f = p => `${(+p.lat).toFixed(6)},${(+p.lon).toFixed(6)}`;
  const q = new URLSearchParams({ p: poly, o: f(o), d: f(d) }); if (x && x.length) q.set("x", x.map(f).join("|"));
  try {
    const r = await fetch(`${proxy}/gmap?${q}`, { headers: s ? { "x-session": s.token } : {} });
    if (!r.ok) { const j = await r.json().catch(() => null); if (j && j.code === "STATIC_DISABLED") gmapOff = true; return null; }
    return URL.createObjectURL(await r.blob());
  } catch (e) { return null; }
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
  // 輕軌路段要對到輕軌系統的站（紅樹林同時有北捷 R28 和淡海輕軌 V01，MaaS 的 agency 兩者都寫 NTMC）；捷運路段反之
  const sysPen = g => leg.mode === "lrt" ? (/LRT$/.test(g.op) ? 0 : 1.5) : leg.mode === "mrt" ? (/LRT$/.test(g.op) ? 1.5 : 0) : 0;
  const score = g => (nameHit(g.name, p.name) ? 0 : 2) + (pref.length && !pref.includes(g.op) ? 1 : 0) + sysPen(g) + g.dist / 1000;
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
            else if (leg.tt) o.pill = { min: Math.max(0, m0), tag: "表定", live: false };   // 已依官方時刻表校正的班次（高雄輕軌沒有終點名可對）
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
    case "gmapImg": return gmapImg(p || {});
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
    case "stationTT": return stationTT(p || {});
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
