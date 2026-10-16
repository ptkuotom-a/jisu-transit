// 極速通勤 PWA — TDX 資料層（公車 + YouBike）
// 所有 TDX 請求都經過自己的 Cloudflare Worker 代理，金鑰只存在 Worker 的 Secrets。
(() => {
const ROUTE_CACHE_DAYS = 30;
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

// ---------- GET（經代理；429 稍等重試） ----------
// profile "main" 用第一組金鑰，"route" 用第二組，"rail"（軌道）用第三組（Worker 端沒設會退回第一組）
// 遇到 429 時 Worker 會先換另一組金鑰重試；仍然限流就丟出 RATE_MSG
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
      const arr = Object.values(res).find(Array.isArray);   // v3 API 回傳 {Stations:[...]} 這類容器
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
const BEAR_TXT = { N: "向北", S: "向南", E: "向東", W: "向西", NE: "向東北", NW: "向西北", SE: "向東南", SW: "向西南" };
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
  const railP = Promise.all([loadRailStations(), loadRailExits().catch(() => ({}))])
    .then(([st, ex]) => nearestRail(st, loc.latitude, loc.longitude,
      { walkKm: settings.railWalk || 1.5, systems: settings.railSys || null, far: settings.railFar !== 0 }, ex));

  const [busR_, bikeR_, favLive, railR_] = await Promise.allSettled([busP, bikeP, favP, railP]);
  if (busR_.status === "rejected" && bikeR_.status === "rejected") throw busR_.reason;

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
    // 同名站牌依實際位置分開（相距 > 20 公尺視為不同站牌），之後依距離標「同向／對向」
    const groups = {}, list = [];
    for (const it of eta) {
      const name = (it.StopName && it.StopName.Zh_tw) || "未知站牌";
      const pos = byUID[it.StopUID] || byName[name] || null;
      const arr = groups[name] = groups[name] || [];
      // 同一 StationID 一定同一站；不同 StationID 只有在 20 公尺內且行車方位（Bearing）相同時才合併（兩側站牌可能只差 10 公尺）
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

// ---------- 軌道（台鐵、高鐵、捷運、輕軌） ----------
// get(profile, url) 需回傳陣列（v3 的物件容器要先拆成陣列）
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
const RAIL_STATION_DAYS = 30;

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
// 1. 步行範圍內的車站依距離排序，不分系統（同系統最多 3 站、總共最多 8 站）
// 2. 範圍內沒有車站 → 顯示最近的 2 站（fallback）
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
  // 北捷與環狀線轉乘站（板橋 BL07／Y16 等）合併成一張卡
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

async function traBoard(get, st) {
  const id = st.ids[0];
  const filter = encodeURIComponent(`StationID eq '${id}'`);
  const [tt, tlive, slive] = await Promise.allSettled([
    get("rail", `${RAIL_BASE}/v3/Rail/TRA/DailyStationTimetable/Today/Station/${id}?%24format=JSON`)
      .catch(() => get("rail", `${RAIL_BASE}/v2/Rail/TRA/DailyTimetable/Station/${id}/${todayStr()}?%24format=JSON`)),
    get("rail", `${RAIL_BASE}/v3/Rail/TRA/TrainLiveBoard?%24format=JSON`),
    get("rail", `${RAIL_BASE}/v3/Rail/TRA/StationLiveBoard?%24filter=${filter}&%24format=JSON`),
  ]);
  const delay = {};
  for (const r of [tlive, slive]) {
    if (r.status !== "fulfilled") continue;
    for (const t of r.value) if (t.TrainNo != null && typeof t.DelayTime === "number") delay[String(t.TrainNo)] = t.DelayTime;
  }
  const live = tlive.status === "fulfilled" || slive.status === "fulfilled";
  let rows = [];
  if (tt.status === "fulfilled" && tt.value.length) {
    for (const s of tt.value) {
      const list = s.TimeTables || s.Timetables || s.StopTimes;
      if (s.DailyTrainInfo) {                       // v2 格式
        const i = s.DailyTrainInfo, p = (s.StopTimes || [])[0] || {};
        rows.push({ no: String(i.TrainNo), type: shortType(zh(i.TrainTypeName)), dest: zh(i.EndingStationName), dir: i.Direction ?? s.Direction, time: hm(p.DepartureTime || p.ArrivalTime) });
      } else if (Array.isArray(list)) {             // v3 格式（每個方向一包）
        for (const t of list) rows.push({ no: String(t.TrainNo), type: shortType(zh(t.TrainTypeName)), dest: zh(t.DestinationStationName) || zh(t.EndingStationName), dir: t.Direction ?? s.Direction, time: hm(t.DepartureTime || t.ArrivalTime) });
      }
    }
  } else if (slive.status === "fulfilled") {        // 時刻表失敗時，至少顯示即將進站的車
    rows = slive.value.map(t => ({ no: String(t.TrainNo), type: shortType(zh(t.TrainTypeName)), dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.ScheduledDepartureTime || t.ScheduledArrivalTime) }));
  } else {
    throw (isRate(tt.reason) ? tt.reason : tt.reason || new Error("台鐵時刻表讀取失敗"));
  }
  const now = nowMin(), seen = new Set();
  rows = rows.filter(r => r.time && !seen.has(r.no) && seen.add(r.no))
    .map(r => ({ ...r, delay: delay[r.no] ?? null, t: toMin(r.time) }))
    .filter(r => r.t + (r.delay || 0) >= now - 1)
    .sort((a, b) => a.t - b.t).slice(0, 24);
  return { kind: "tra", live, trains: rows, groups: groupTrains("tra", rows), note: live ? null : "誤點資訊暫時讀不到，只顯示表定時間" };
}

async function thsrBoard(get, st) {
  const id = st.ids[0];
  const [tt, seats] = await Promise.allSettled([
    get("rail", `${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/Station/${id}/${todayStr()}?%24format=JSON`),
    get("rail", `${RAIL_BASE}/v2/Rail/THSR/AvailableSeatStatusList/${id}?%24format=JSON`),
  ]);
  const seatMap = {};
  let seatList = [];
  if (seats.status === "fulfilled") {
    const v = seats.value;
    seatList = (v[0] && v[0].AvailableSeats) ? v[0].AvailableSeats : (v[0] && v[0].TrainNo ? v : []);
    for (const s of seatList) seatMap[String(s.TrainNo)] = { std: SEAT[s.StandardSeatStatus] || null, biz: SEAT[s.BusinessSeatStatus] || null };
  }
  let rows;
  if (tt.status === "fulfilled" && tt.value.length) {
    rows = tt.value.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else if (seatList.length) {
    rows = seatList.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else {
    throw (tt.reason || new Error("高鐵時刻表讀取失敗"));
  }
  const now = nowMin();
  rows = rows.filter(r => r.time).map(r => ({ ...r, t: toMin(r.time), seats: seatMap[r.no] || null }))
    .filter(r => r.t >= now - 1).sort((a, b) => a.t - b.t).slice(0, 24);
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
    const destId = String(it.destinationStationId || "").toUpperCase();
    if (here.has(destId)) continue;                                        // 終點就是本站的列車不顯示
    const dest = (it.stationName && it.stationName.zh) || "?";
    const rn = (it.routeName && it.routeName.zh) || "";
    const line = (TRTC_ROUTE.find(([k]) => rn.includes(k)) || [])[1] || (!rn ? "Y" : null) || (/^[A-Z]+/.exec(destId) || [])[0] || null;   // 環狀線沒有 routeName   // 終點代碼可能是轉乘站的另一條線（如大安 BR09）
    const raw = String(it.estimateTime ?? "").trim();
    let sec = null, label = null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (m) sec = Math.max(0, +m[1] * 60 + +m[2] - (+it.secondsAgo || 0));
    else if (/進站|到站/.test(raw)) sec = 0;
    else label = raw || null;                                                // 暫無資料、末班車已過等
    const t = { line, dest, eta: sec === null ? null : Math.floor(sec / 60), label };
    const k = line + "|" + dest, o = best[k];
    if (!o || (t.eta !== null && (o.eta === null || t.eta < o.eta))) best[k] = t;
  }
  const trains = Object.values(best).sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
  return trains.some(t => t.eta !== null) ? trains : null;
}

async function metroBoard(get, st) {
  if (busPlusOK(st)) {
    const trains = await trtcLive(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", trains), note: "北捷／環狀線即時到站（資料來源：Bus+ 非官方）" };
  }
  const filter = encodeURIComponent(st.ids.map(i => `StationID eq '${i}'`).join(" or "));
  let live = [];
  try { live = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/LiveBoard/${st.op}?%24filter=${filter}&%24format=JSON`); } catch (e) { if (isRate(e)) throw e; }
  if (live.length) {
    const vals = live.map(t => t.EstimateTime).filter(v => typeof v === "number");
    const isSec = vals.some(v => v > 120);
    const trains = live.map(t => ({
      line: t.LineNO || t.LineID || lineOf(st.op, t.StationID),
      dest: zh(t.DestinationStaionName) || zh(t.DestinationStationName) || zh(t.TripHeadSign) || "?",
      via: (/(順行|逆行)/.exec(zh(t.TripHeadSign) || "") || [])[1] || null,   // 環狀線（高雄輕軌）起訖同站，用順／逆行區分
      eta: typeof t.EstimateTime === "number" ? (isSec ? Math.floor(t.EstimateTime / 60) : t.EstimateTime) : null,
    })).sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
    // 北捷 LiveBoard 只列出「正在進站」的列車（EstimateTime 全為 0），不是完整看板：與時刻表合併
    if (!trains.every(t => t.eta === 0)) return { kind: "metro", live: true, trains, groups: groupTrains("metro", trains), note: null };
    const tt = await metroTimetable(get, st, filter).catch(e => { if (isRate(e)) throw e; return []; });
    const liveDest = new Set(trains.map(t => t.dest + "|" + t.line));
    const rest = tt.filter(t => !(liveDest.has(t.dest + "|" + t.line) && t.eta <= 1));
    const all = [...trains.map(t => ({ ...t, arriving: true })), ...rest].sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
    return { kind: "metro", live: true, trains: all, groups: groupTrains("metro", all), note: "北捷即時來源暫時無法使用；改用 TDX（只有進站中列車）＋時刻表" };
  }
  let tt;
  try { tt = await metroTimetable(get, st, filter); } catch (e) { if (isRate(e)) throw e; tt = null; }
  if (tt === null) return { kind: "metro", live: false, trains: [], groups: [], note: "這個系統沒有提供即時到站或時刻表資料" };
  const note = !tt.length ? "今日班次已結束" : st.op === "TRTC" ? "北捷即時來源暫時無法使用，以下為時刻表" : "這個系統沒有即時到站資料，以下為時刻表";
  return { kind: "metro", live: false, trains: tt, groups: groupTrains("metro", tt), note };
}

// 時刻表：回傳今日接下來的班次；查無資料回傳 null
async function metroTimetable(get, st, filter) {
  let recs = [];
  try { recs = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/StationTimeTable/${st.op}?%24filter=${filter}&%24format=JSON`); } catch (e) { if (isRate(e)) throw e; }
  if (!recs.length) return null;
  const dayKey = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
  let todays = recs.filter(r => r.ServiceDay && r.ServiceDay[dayKey] === true);
  if (!todays.length) todays = recs;
  const now = nowMin(), byKey = {};
  for (const r of todays) {
    const dest = zh(r.DestinationStaionName) || zh(r.DestinationStationName) || `方向 ${r.Direction ?? "?"}`;
    const line = r.LineID || r.LineNO || lineOf(st.op, r.StationID);
    const dir = r.Direction ?? null;
    const k = dest + "|" + line + "|" + dir;
    const set = byKey[k] = byKey[k] || { dest, line, dir, times: new Set() };
    for (const t of (r.Timetables || [])) { const x = hm(t.DepartureTime || t.ArrivalTime); if (x) set.times.add(x); }
  }
  const trains = [];
  // 同一終點有兩個方向（環狀線）時補上方向；高雄輕軌 Direction 0 = 逆行、1 = 順行（已對照即時看板）
  const dirsOf = {};
  for (const g of Object.values(byKey)) (dirsOf[g.dest + "|" + g.line] = dirsOf[g.dest + "|" + g.line] || new Set()).add(g.dir);
  for (const g of Object.values(byKey)) {
    if (dirsOf[g.dest + "|" + g.line].size > 1) g.via = st.op === "KLRT" ? (g.dir === 1 ? "順行" : "逆行") : `方向 ${g.dir}`;
    [...g.times].map(x => ({ x, t: toMin(x) })).filter(o => o.t >= now).sort((a, b) => a.t - b.t).slice(0, 3)
      .forEach(o => trains.push({ time: o.x, t: o.t, dest: g.dest, line: g.line, via: g.via || null, eta: o.t - now }));
  }
  trains.sort((a, b) => a.t - b.t);
  return trains;
}

// 依方向分組：台鐵用 Direction（0 順行、1 逆行）；高鐵（0 南下、1 北上）；捷運／輕軌用終點站（往 X）
// 回傳 [{ label, trains }]，組內依時間排序；沒有班次的組放最後（介面不顯示）；每組最多 8 班
function groupTrains(kind, trains) {
  const per = 8, key = t => t.t ?? t.eta ?? 9999;
  let groups;
  if (kind === "tra" || kind === "thsr") {
    groups = kind === "tra" ? [{ label: "順行", dir: 0, trains: [] }, { label: "逆行", dir: 1, trains: [] }] : [{ label: "南下", dir: 0, trains: [] }, { label: "北上", dir: 1, trains: [] }];
    const other = { label: "其他", dir: null, trains: [] };
    for (const t of trains) (t.dir === 0 || t.dir === "0" ? groups[0] : t.dir === 1 || t.dir === "1" ? groups[1] : other).trains.push(t);
    if (other.trains.length) groups.push(other);
  } else {
    const m = new Map();
    for (const t of trains) {
      const label = "往 " + (t.dest || "?") + (t.via ? `（${t.via}）` : "");
      const k = (t.line || "") + "|" + label;   // 同終點不同路線（如往南港展覽館的板南線／文湖線）分開
      if (!m.has(k)) m.set(k, { label, line: t.line || null, trains: [] });
      m.get(k).trains.push(t);
    }
    groups = [...m.values()];
  }
  for (const g of groups) g.trains = g.trains.slice().sort((a, b) => key(a) - key(b)).slice(0, per);
  const first = g => g.trains.length ? key(g.trains[0]) : Infinity;
  return kind === "metro" ? groups.sort((a, b) => first(a) - first(b)) : groups.sort((a, b) => (a.trains.length ? 0 : 1) - (b.trains.length ? 0 : 1));
}

// ---------- 台中捷運：TDX 沒有即時與站別時刻表，用班距＋首末班推估 ----------
const TMRT_KEY = "jisu_tmrt";
async function loadTmrt(get) {
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
  const dayKey = DAY_KEYS[day];
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
    up.forEach(t => trains.push({ time: clock(t), t, eta: t - now, dest, line: r.LineID || "G", via: null }));
    lines.push(`往 ${dest}：${up.length ? `約每 ${hwAt(now)} 分一班，` : "今日已收班，"}首班 ${hm(r.FirstTrainTime)}、末班 ${hm(r.LastTrainTime)}`);
  }
  trains.sort((a, b) => a.t - b.t);
  const note = (closed ? `今日已收班／明日首班 ${clock(nextFirst)}\n` : "預估（依班距推算，非即時）\n") + lines.join("\n");
  return { kind: "metro", live: false, trains, groups: groupTrains("metro", trains), note };
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
  const todo = RAIL_SYSTEMS.filter(s => { const c = cache.systems[s.key]; return !(c && c.stations && c.stations.length && now - c.time < RAIL_STATION_DAYS * 86400000); });
  for (let i = 0; i < todo.length; i += 3) {           // 一次 3 個系統，避免限流
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
  const todo = metros.filter(s => { const c = cache.systems[s.key]; return !(c && now - c.time < RAIL_STATION_DAYS * 86400000); });
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async s => {
      try {
        const list = await tdx("rail", `${RAIL_BASE}/v2/Rail/Metro/StationExit/${s.key}?%24top=3000&%24format=JSON`);
        cache.systems[s.key] = { time: now, exits: mapExits(list, s.key) };
      } catch (e) { if (!isRate(e)) cache.systems[s.key] = { time: now - (RAIL_STATION_DAYS - 1) * 86400000, exits: {} }; } // 失敗的明天再試；限流的下次開啟就重試
    }));
  }
  if (todo.length) { try { localStorage.setItem(EXIT_KEY, JSON.stringify(cache)); } catch (e) {} }
  return Object.assign({}, ...Object.values(cache.systems).map(s => s.exits || {}));
}

// ---------- 設定 / 收藏 ----------
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s) return s; } catch (e) {}
  return { settings: { busR: 300, bikeR: 500, railWalk: 1.5, railFar: 1, railSys: null, auto: 30 }, favs: { bus: [], bike: [] } };
}

// 全台公車路線索引：各縣市 + 公路客運，一週更新一次；失敗的縣市下次再補
const IDX_KEY = "jisu_bus_idx", IDX_DAYS = 7;
let idxLoading = null;
async function busIndex() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(IDX_KEY)); } catch (e) {}
  if (!c || Date.now() - c.time > IDX_DAYS * 86400000) c = { time: Date.now(), cities: {} };
  const all = [...Object.values(UID_CITY), "InterCity"];
  const todo = all.filter(x => !c.cities[x]);
  if (todo.length && !idxLoading) {
    idxLoading = (async () => {
      const proxy = getProxy(); if (!proxy) return;
      for (let i = 0; i < todo.length; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async city => {
          try { const r = await fetch(`${proxy}/bus/routes?c=${city}`); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) c.cities[city] = j; } } catch (e) {}
        }));
        await sleep(300);
      }
      try { localStorage.setItem(IDX_KEY, JSON.stringify(c)); } catch (e) {}
    })().finally(() => { idxLoading = null; });
    await idxLoading;
  } else if (idxLoading) await idxLoading;
  return { cities: c.cities, missing: all.filter(x => !c.cities[x]) };
}

// 推播／下車提醒（Worker 端點）
async function pushCall(method, path, body) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const r = await fetch(proxy + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) throw new Error(j.message || ("錯誤 " + r.status));
  return j;
}

window.dataApi = async (action, p = {}) => {
  switch (action) {
    case "nearby": return nearby(p);
    case "route": return routeView(p);
    case "railBoard": return railBoard(tdx, p);
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
    case "busIndex": return busIndex();
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
