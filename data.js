// 極速通勤 PWA — TDX 資料層（公車 + YouBike）
// 所有 TDX 請求都經過自己的 Cloudflare Worker 代理，金鑰只存在 Worker 的 Secrets。
(() => {
const ROUTE_CACHE_DAYS = 30;
const BASE = "https://tdx.transportdata.tw/api";
const PROXY_KEY = "jisu_proxy", STATE_KEY = "jisu_state", DEST_KEY = "jisu_route_dest";
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

// ---------- GET（經代理；429 稍等重試） ----------
// profile "main" 用第一組金鑰，"route" 用第二組（Worker 端沒設第二組會自動退回第一組）
async function tdx(profile, url) {
  const proxy = getProxy();
  if (!proxy) throw new Error("NO_PROXY");
  const target = proxy + url.slice(TDX_ORIGIN.length) + "&__k=" + (profile === "route" ? 2 : 1);
  let last = "";
  for (let i = 0; i < 3; i++) {
    let code = 0, res;
    try {
      const r = await fetch(target);
      code = r.status; res = await r.json();
    } catch (e) { res = { message: String(e) }; }
    if (Array.isArray(res)) return res;
    last = `(${code}) ` + JSON.stringify(res).slice(0, 120);
    if (code === 429 || code === 0 || code >= 500) { await sleep(1000 + i * 800); continue; }
    break;
  }
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
function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return lastLoc ? res(lastLoc) : rej(new Error("這個瀏覽器不支援定位"));
    navigator.geolocation.getCurrentPosition(
      p => { lastLoc = { latitude: p.coords.latitude, longitude: p.coords.longitude }; res(lastLoc); },
      e => lastLoc ? res(lastLoc) : rej(new Error(e.code === 1
        ? "沒有定位權限：到 iPhone 設定 › 隱私權與安全性 › 定位服務 › Safari 網站，改成「使用 App 期間」"
        : "無法取得定位，請稍後再試")),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 20000 });
  });
}

// ---------- 終點站快取（沿用原腳本格式） ----------
function readDestCache() {
  try { const c = JSON.parse(localStorage.getItem(DEST_KEY)); if (c && c.routes) return c; } catch (e) {}
  return { routes: {} };
}
async function loadRouteDest(profile, uids) {
  const cache = readDestCache(), now = Date.now(), maxAge = ROUTE_CACHE_DAYS * 86400000;
  const missing = [...new Set(uids)].filter(u => u && !(cache.routes[u] && now - cache.routes[u].time < maxAge));
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
    try { localStorage.setItem(DEST_KEY, JSON.stringify(cache)); } catch (e) {}
  }
  return cache.routes;
}
const destOf = (uid, dirNum, map) => { const r = map[uid]; return r ? (dirNum === 1 ? r.dep : r.dest) || null : null; };

// ---------- 附近：公車 + YouBike + 收藏 ----------
async function nearby({ settings = {}, favs = { bus: [], bike: [] } }) {
  const loc = await locate();
  const lat = loc.latitude.toFixed(6), lon = loc.longitude.toFixed(6);
  const busR = clampR(settings.busR || 300), bikeR = clampR(settings.bikeR || 500);

  const busP = Promise.all([
    tdx("main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat, lon, busR)}&%24top=400&%24format=JSON`),
    tdx("main", `${BASE}/advanced/v2/Bus/Stop/NearBy${nearbyQ(lat, lon, Math.min(busR + 100, 1000))}&%24top=400&%24format=JSON`),
  ]);
  const bikeP = Promise.all([
    tdx("route", `${BASE}/advanced/v2/Bike/Station/NearBy${nearbyQ(lat, lon, bikeR)}&%24top=150&%24format=JSON`),
    tdx("route", `${BASE}/advanced/v2/Bike/Availability/NearBy${nearbyQ(lat, lon, bikeR)}&%24top=150&%24format=JSON`),
  ]);
  const favP = liveFavs(favs).catch(() => ({ bus: {}, bike: {} }));

  const [busR_, bikeR_, favLive] = await Promise.allSettled([busP, bikeP, favP]);
  if (busR_.status === "rejected" && bikeR_.status === "rejected") throw busR_.reason;

  // 公車：依站名分組
  let busStops = [];
  if (busR_.status === "fulfilled") {
    const [eta, stops] = busR_.value;
    const byUID = {}, byName = {};
    for (const s of stops) {
      const p = s.StopPosition; if (!p) continue;
      const d = haversine(loc.latitude, loc.longitude, p.PositionLat, p.PositionLon);
      const v = { d, lat: p.PositionLat, lon: p.PositionLon };
      if (s.StopUID && (!byUID[s.StopUID] || d < byUID[s.StopUID].d)) byUID[s.StopUID] = v;
      const n = s.StopName && s.StopName.Zh_tw;
      if (n && (!byName[n] || d < byName[n].d)) byName[n] = v;
    }
    const groups = {};
    for (const it of eta) {
      const name = (it.StopName && it.StopName.Zh_tw) || "未知站牌";
      const pos = byUID[it.StopUID] || byName[name] || null;
      const g = groups[name] = groups[name] || { name, dist: null, lat: null, lon: null, routes: {} };
      if (pos && (g.dist === null || pos.d < g.dist)) { g.dist = pos.d; g.lat = pos.lat; g.lon = pos.lon; }
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
    busStops = Object.values(groups).map(g => {
      const routes = Object.values(g.routes);
      for (const r of routes) r.dest = destOf(r.routeUID, r.dirNum, destMap);
      return { ...g, routes };
    }).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  }

  // YouBike
  let bikes = [], bikeError = null;
  if (bikeR_.status === "fulfilled") {
    const [st, av] = bikeR_.value;
    const am = {}; for (const a of av) if (a.StationUID) am[a.StationUID] = a;
    for (const s of st) {
      const p = s.StationPosition; if (!p) continue;
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
    lat: loc.latitude, lon: loc.longitude, busStops, bikes, bikeError,
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
    jobs.push(tdx("route", `${BASE}/basic/v2/Bike/Availability/City/${city}?%24filter=${enc(filter)}&%24top=50&%24format=JSON`).then(list => {
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
async function routeView({ routeUID, route, dirNum = 0, stopUID, stopName }) {
  const k = routeKind(routeUID);
  if (!k) throw new Error("缺少路線識別資訊");
  const name = enc(route);
  const u = api => `${BASE}/basic/v2/Bus/${api}/${k.path}/${name}?%24top=600&%24format=JSON`;
  const [sor, etas, near] = await Promise.all([
    tdx("route", u("StopOfRoute")),
    tdx("route", u("EstimatedTimeOfArrival")),
    tdx("route", u("RealTimeNearStop")).catch(() => []),
  ]);
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

// ---------- 設定 / 收藏 ----------
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s) return s; } catch (e) {}
  return { settings: { busR: 300, bikeR: 500, auto: 30 }, favs: { bus: [], bike: [] } };
}

window.dataApi = async (action, p = {}) => {
  switch (action) {
    case "nearby": return nearby(p);
    case "route": return routeView(p);
    case "loadState": return loadState();
    case "saveState": localStorage.setItem(STATE_KEY, JSON.stringify(p)); return true;
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
  }
  throw new Error("未知動作 " + action);
};
})();
