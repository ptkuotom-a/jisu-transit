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
const STOP_CITY = { ...UID_CITY, THB: "InterCity" };
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
// v2.37.2：請求逾時（網路卡住時不會一直停在「定位中」；逾時就顯示錯誤，可下拉重試）
// 計時涵蓋到讀完內容（r.json() 卡住也會中斷）；讀完後才觸發的 abort 不影響結果
function fetchT(u, ms, opt) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
  const bp = typeof window !== "undefined" && window.BOOT_PERF && window.BOOT_PERF.realData == null ? window.BOOT_PERF : null;   // v2.49.24 開機計時：只記路徑（不記查詢字串）
  const t0 = bp ? performance.now() : 0;
  const rec = ok => { if (bp && bp.requests.length < 40) { let path = ""; try { path = new URL(String(u), location.href).pathname; } catch (e) {} bp.requests.push({ url: path, dur: Math.round(performance.now() - t0), ok }); } };
  return fetch(u, { ...(opt || {}), signal: ac.signal }).then(r => { rec(r.ok); return r; }, e => { clearTimeout(tm); rec(false); throw e; });
}
// v2.49.0 JT-20261030-02：每 10 秒定時更新（auto）期間 AUTO>0（新站補抓 railHeal/exitHeal/busHeal/placeHeal 也略過）：
// ① tdx() 一律不連網：有上一次同網址的結果就沿用（畫面資料不變），沒有就丟出 notdx 錯誤（各頁原本的「讀取失敗沿用舊資料」接手）
// ② 所有送到 Worker 的請求加 notdx=1，Worker 端任何會轉打 TDX 的路徑都直接回 409，不准改打 TDX
// 手動下拉、第一次載入不受影響（原本的官網→TDX 備援照舊）
let AUTO = 0;
const tdxMemo = new Map();
const nt = u => AUTO ? u + (u.includes("?") ? "&" : "?") + "notdx=1" : u;
const NOTDX_MSG = "定時更新略過 TDX";
const TDX_MS = 12000, NET_MSG = "連不到伺服器，請確認網路後重試", TIMEOUT_MSG = "連線逾時，請確認網路後重試";
function tdxKeep(k, v) { tdxMemo.delete(k); tdxMemo.set(k, { v }); if (tdxMemo.size > 80) tdxMemo.delete(tdxMemo.keys().next().value); return v; }
async function tdx(profile, url) {
  const proxy = getProxy();
  if (!proxy) throw new Error("NO_PROXY");
  const target = proxy + url.slice(TDX_ORIGIN.length) + "&__k=" + (profile === "rail" ? 3 : profile === "route" ? 2 : 1);
  if (AUTO) { const m = tdxMemo.get(target); if (m) return m.v; const e = new Error(NOTDX_MSG); e.notdx = true; throw e; }
  const session = getSession(), opt = session && session.role === "admin" ? { headers: { "x-session": session.token } } : undefined;
  let last = "", why = "";
  for (let i = 0; i < 3; i++) {
    let code = 0, res; why = "";
    try {
      const r = await fetchT(target, TDX_MS, opt);
      code = r.status; res = await r.json();
    } catch (e) { why = e && e.name === "AbortError" ? "timeout" : code ? "" : "net"; res = { message: String(e) }; }
    if (Array.isArray(res)) return tdxKeep(target, res);
    if (res && typeof res === "object" && r_ok(code) && !res.message && !res.Message) {
      const arr = Object.values(res).find(Array.isArray);   // v3 API 回傳 {Stations:[...]}這類容器
      if (arr) return tdxKeep(target, arr);
    }
    last = `(${code}) ` + JSON.stringify(res).slice(0, 120);
    if (why === "timeout") break;   // 逾時不再重試：最多等 12 秒就結束轉圈
    if (code === 429 || code === 0 || code >= 500) { if (i < 2) await sleep(1000 + i * 800); continue; }
    break;
  }
  if (last.startsWith("(429)")) { const e = new Error(RATE_MSG); e.rate = true; throw e; }
  if (why === "timeout") throw new Error(TIMEOUT_MSG);
  if (why === "net") throw new Error(NET_MSG);
  if (last.startsWith("(5")) throw new Error("TDX 暫時無法回應，請稍後重試 " + last.slice(0, 5));
  throw new Error("資料讀取失敗 " + last);
}

// ---------- v2.36 開放資料（臺北市、新北市政府交通局）：經 Worker /od/*，不耗 TDX ----------
async function odGet(path, timeoutMs = 15000) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  let r, j = null;
  try { r = await fetchT(nt(proxy + path), timeoutMs); j = await r.json().catch(() => null); } catch (e) { throw new Error("連不到伺服器，請確認網路"); }
  if (!r.ok || !j) throw new Error((j && j.message) || ("開放資料讀取失敗 " + r.status));
  return j;
}
const odMemo = new Map();
async function odMemoGet(path, ms, timeoutMs = 15000) {   // 同一網址 ms 毫秒內重用（YouBike 與原本的 90 秒相同；下拉更新傳 0）
  const h = odMemo.get(path); if (h && Date.now() - h.t < ms) return h.v;
  const v = await odGet(path, timeoutMs); if (!v.err) odMemo.set(path, { t: Date.now(), v });   // 部分來源失敗的結果不重用 if (odMemo.size > 40) odMemo.delete(odMemo.keys().next().value);
  return v;
}
function odWarm(src) {   // 不等回應、失敗不管；只在附近資料更新時發一次（不是定時）
  try { const proxy = getProxy(); if (proxy && (!lastLoc || inNorth(lastLoc.latitude, lastLoc.longitude))) fetch(nt(proxy + "/od/warm" + (src ? "?s=" + src : ""))).catch(() => {}); } catch (e) {}
}
const YB_CLOUD = new Set(["TPE", "NWT", "TAO", "TXG", "HSZ", "HSQ", "MIA", "CYI", "CYQ", "KHH", "TNN", "PIF", "TTT"]);
const YB_CLOUD_CITY = new Set(["Taipei", "NewTaipei", "Taoyuan", "Taichung", "Hsinchu", "HsinchuCounty", "MiaoliCounty", "Chiayi", "ChiayiCounty", "Kaohsiung", "Tainan", "PingtungCounty", "TaitungCounty"]);
const isCloudBike = uid => YB_CLOUD.has((uid || "").slice(0, 3));
const OD_BIKE = new Set(["TPE", "NWT"]);                       // 備援：雙北市府開放資料
const isOdBike = uid => OD_BIKE.has((uid || "").slice(0, 3));
const YB_FEED_URL = "https://apis.youbike.com.tw/json/station-yb2.json";
const YB_AREA = { "00": "TPE", "05": "NWT", "07": "TAO", "01": "TXG", "09": "HSZ", "10": "HSZ", "0B": "HSQ", "0A": "MIA", "08": "CYI", "11": "CYQ", "12": "KHH", "13": "TNN", "14": "PIF", "15": "TTT" };
let ybFeedP = null, ybFeedInFlight = null, ybFeedAt = 0, ybFeedSnap = null, ybUploadBusy = false;
function youbikeFeed(fresh) {
  // 不論是否強制更新，同一時間只允許一個官網請求；成功結果在記憶體保留 90 秒。
  if (ybFeedInFlight) return ybFeedInFlight;
  if (!fresh && ybFeedP && Date.now() - ybFeedAt < 90000) return ybFeedP;
  ybFeedAt = Date.now();
  const p = fetchT(YB_FEED_URL, 15000, { cache: "no-store" }).then(r => { if (!r.ok) throw new Error("feed"); return r.json(); }).then(list => {
    if (!Array.isArray(list)) throw new Error("feed");
    const map = {};
    for (const s of list) {
      const pre = YB_AREA[String(s.area_code)], no = String(s.station_no || "");
      if (!pre || !no || s.lat == null || s.lng == null) continue;
      const uid = pre + no, name = s.name_tw || "";
      const eyb = s.available_spaces_detail ? s.available_spaces_detail.eyb : null;
      const rent = typeof s.available_spaces === "number" ? s.available_spaces : null;
      map[uid] = {
        AvailableRentBikes: rent, AvailableReturnBikes: typeof s.empty_spaces === "number" ? s.empty_spaces : null,
        AvailableRentBikesDetail: { GeneralBikes: rent != null && eyb != null ? rent - eyb : null, ElectricBikes: eyb == null ? null : eyb },
        ServiceStatus: s.status === 1 ? 1 : 2, SrcUpdateTime: s.updated_at || null,
      };
    }
    ybFeedSnap = { t: Date.now(), list };
    return map;
  }).then(map => { ybFeedP = Promise.resolve(map); return map; }).catch(e => { ybFeedP = null; throw e; }).finally(() => { ybFeedInFlight = null; });
  ybFeedInFlight = p;
  ybFeedP = p;
  return p;
}
function ybMaybePush(cloud, live, lat, lon, r) {
  if (ybUploadBusy || !getSession()) return;
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), key = "jisu_ybup_day";
  try { if (localStorage.getItem(key) === day) return; } catch (e) { return; }
  const have = new Map((cloud || []).map(s => [s.StationUID, s]));
  const near = (a, b, c, d) => { const y = (a - c) * 111195, x = (b - d) * 111195 * Math.cos(a * Math.PI / 180); return Math.sqrt(x * x + y * y); };
  let mismatch = false;
  for (const s of live || []) {
    const raw = s && s.area_code != null, pre = raw && YB_AREA[String(s.area_code)], uid = raw ? (pre && s.station_no ? pre + String(s.station_no) : "") : (s && s.StationUID || "");
    const pos = raw ? { lat: +s.lat, lon: +s.lng, name: s.name_tw || "" } : { lat: +(s && s.StationPosition && s.StationPosition.PositionLat), lon: +(s && s.StationPosition && s.StationPosition.PositionLon), name: (s && s.StationName && s.StationName.Zh_tw) || "" };
    const la = pos.lat, lo = pos.lon;
    if (!uid || !isFinite(la) || !isFinite(lo) || near(lat, lon, la, lo) > r) continue;
    const c = have.get(uid), p = c && c.StationPosition;
    if (!c || !p || near(la, lo, p.PositionLat, p.PositionLon) > 50 || String(pos.name).trim() !== String((c.StationName || {}).Zh_tw || "").trim()) { mismatch = true; break; }
  }
  if (!mismatch) return;
  try { localStorage.setItem(key, day); } catch (e) { return; }
  const proxy = getProxy(), session = getSession(); if (!proxy || !session) return;
  ybUploadBusy = true;
  Promise.resolve(live).then(async list => {
    if (!Array.isArray(list)) throw new Error("feed");
    const body = { list: list.flatMap(s => {
      const pre = s && YB_AREA[String(s.area_code)], no = s && s.station_no != null ? String(s.station_no) : "";
      const lat = +(s && s.lat), lng = +(s && s.lng);
      if (!pre || !no || !isFinite(lat) || !isFinite(lng)) return [];
      return [[pre + no, String(s.name_tw || "").trim(), s.address_tw || "", lat, lng, s.parking_spaces ?? null]];
    }) };
    return fetchT(nt(proxy + "/od/ybstn"), 30000, { method: "POST", headers: { "content-type": "application/json", "x-session": session.token }, body: JSON.stringify(body) });
  })
    .catch(() => {}).finally(() => { ybUploadBusy = false; });
}
function withoutBikeLive(s) {
  return { ...s, AvailableRentBikes: null, AvailableReturnBikes: null, AvailableRentBikesDetail: null, ServiceStatus: null, SrcUpdateTime: null, UpdateTime: null, src: null };
}
function withYoubikeFeed(stations, map) {
  return stations.map(s => map[s.StationUID] ? { ...withoutBikeLive(s), ...map[s.StationUID], src: "yb" } : withoutBikeLive(s));
}
const inNorth = (lat, lon) => lat > 24.6 && lat < 25.35 && lon > 121.25 && lon < 122.05;   // 雙北大致範圍（開放資料讀不到時判斷用）
const ODB_ERR = "台北、新北開放資料暫時連不上，請稍後下拉更新";
// 台北市公車用臺北市開放資料；新北、公路客運各先用官方即時來源
const isTpeR = uid => /^TPE/.test(uid || "");
// 附近／某站牌的預估到站：附近只有台北市公車站牌 → 0 次 TDX；有其他站牌 → 照舊 1 次 TDX NearBy，只取非 TPE 的部分
const isNwtR = uid => /^NWT/.test(uid || "");
const isTaoR = uid => /^TAO/.test(uid || "");
const isThbR = uid => /^THB/.test(uid || "");
// 官網只給「06:00」這種時分：轉成台北時間 ISO，規劃頁 Date.parse 與畫面 hhmm 才讀得到；比現在早超過 1 小時視為明天的班次
function nbIso(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || "").trim());
  if (!m) return t;
  const now = Date.now(), day = new Date(now + 288e5).toISOString().slice(0, 10);
  let at = Date.parse(`${day}T${m[1].padStart(2, "0")}:${m[2]}:${m[3] || "00"}+08:00`);
  if (at < now - 36e5) at += 864e5;
  return new Date(at + 288e5).toISOString().slice(0, 19) + "+08:00";
}
const isHszR = uid => /^HSZ/.test(uid || "");
const isTxgR = uid => /^TXG/.test(uid || "");
const isTnnR = uid => /^TNN/.test(uid || "");
const isKhhR = uid => /^(KHH|LIE)/.test(uid || "");   // 高雄、連江都走 taiwanhelper
const isKinR = uid => /^KIN/.test(uid || "");
const CITYBUS = new Set(["KEE", "ILA", "HSQ", "MIA", "CHA", "NAN", "YUN", "CYI", "CYQ", "PIF", "HUA", "TTT", "PEN"]);
const isCitybusR = uid => CITYBUS.has((uid || "").slice(0, 3));
// v2.49.20：附近站牌與預估到站不再呼叫 TDX；讀不到即時時以雲端時刻表補路線，到站欄位顯示「暫無免 TDX 的即時資料」
const NEAR_OK = new Set(["TPE", "NWT", "THB"]);
const isThbStop = s => /^THB/.test((s && s.StopUID) || "");
async function busNearEta(lat, lon, r, profile, tdxUrl, geoKey, fresh, opt = {}) {
  const qStop = geoKey ? +geoKey.split(",")[2] : Math.min(r + 100, 1000);
  const gKey = geoKey || (`s|${(+lat).toFixed(3)},${(+lon).toFixed(3)},${qStop}`);

  // v2.49.27: /od/stops、/od/thbstn、/od/eta 同時發出
  const stopsP = cloudStops(gKey).catch(() => null);
  const thbP = odMemoGet(`/od/thbstn?lat=${lat}&lon=${lon}&r=${qStop}`, fresh ? 0 : 6 * 3600000).catch(() => null);
  const etaP = Promise.race([
    odGet(`/od/eta?lat=${lat}&lon=${lon}&r=${r}&nwt=1&thbx=1${fresh ? "&fresh=1" : ""}`),
    new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 11000))
  ]).catch(() => null);

  // v2.49.27 補充：站牌清單一回來立刻發出 Stage 1 站名卡片（不等 /od/eta）
  stopsP.then(async cs => {
    let c = cs;
    if (!c) c = await IDB.get("geo|" + gKey).catch(() => null);
    if (!c || !Array.isArray(c.d)) return;
    const cityStops = c.d.map(stopUnpack).filter(s => s.StopPosition && !isThbStop(s));
    const stage1Near = cityStops.filter(s => {
      const p = s.StopPosition;
      return p && p.PositionLat != null && haversine(+lat, +lon, p.PositionLat, p.PositionLon) <= r + 30;
    });
    if (stage1Near.length && typeof opt.onStopsEarly === "function") {
      try { opt.onStopsEarly(stage1Near); } catch (e) {}
    }
  }).catch(() => {});

  const [cs, thbData, od] = await Promise.all([stopsP, thbP, etaP]);
  let covZero = false;
  let c = cs;
  if (cs && cs.cov === 0) {
    covZero = true;
  }
  if (!c) {
    c = await IDB.get("geo|" + gKey).catch(() => null);
  }

  const hw = thbData && Array.isArray(thbData.list) ? thbData.list : [];
  const cityStops = c && Array.isArray(c.d) ? c.d.map(stopUnpack).filter(s => s.StopPosition && !isThbStop(s)) : [];
  const nearSt = [...cityStops, ...hw].filter(s => {
    const p = s.StopPosition;
    return p && p.PositionLat != null && haversine(+lat, +lon, p.PositionLat, p.PositionLon) <= r + 30;
  });

  const stopDistMap = new Map();
  for (const s of nearSt) {
    const p = s.StopPosition;
    if (p && p.PositionLat != null) {
      stopDistMap.set(s.StopUID, haversine(+lat, +lon, p.PositionLat, p.PositionLon));
    }
  }

  const liveOk = !!(od && Array.isArray(od.list));
  const okNwt = !!(od && od.nwtOk);
  const okThb = !!(od && (od.thbOk || !(od.thbN > 0)));
  const isCovered = uid => isTpeR(uid) || (okNwt && isNwtR(uid)) || (okThb && isThbR(uid));
  const rawOdRows = (od && Array.isArray(od.list))
    ? od.list.filter(e => isCovered(e.RouteUID)).map(e => ({ ...e, src: e.src || od.src || "od-eta" }))
    : [];

  const coveredStopUIDs = new Set(rawOdRows.map(e => e.StopUID).filter(Boolean));
  const uncoveredStops = nearSt.filter(s => {
    const pfx = (s.StopUID || "").slice(0, 3);
    if (!liveOk) return true;
    if (pfx === "TPE") return !coveredStopUIDs.has(s.StopUID);
    if (pfx === "NWT") return !okNwt || !coveredStopUIDs.has(s.StopUID);
    if (pfx === "THB") return !okThb || !coveredStopUIDs.has(s.StopUID);
    return true;
  });

  const noLiveRows = [];
  if (uncoveredStops.length) {
    let schMetaAll = null;
    try { schMetaAll = await authedGet("/bus/sch/meta"); } catch (e) {}

    const cityMap = new Map();
    for (const s of uncoveredStops) {
      const pfx = (s.StopUID || "").slice(0, 3);
      const city = STOP_CITY[pfx];
      if (!city) continue;
      if (!cityMap.has(city)) cityMap.set(city, []);
      cityMap.get(city).push(s);
    }

    const seenRoutes = new Set();
    for (const [city, stops] of cityMap) {
      let recs = null;
      try {
        const x = await bdCity(city, schMetaAll);
        if (x && Array.isArray(x.recs)) recs = x.recs;
      } catch (e) {}
      if (!recs) {
        const cached = await IDB.get("bd|" + city).catch(() => null);
        if (cached && Array.isArray(cached.recs)) recs = cached.recs;
      }

      for (const s of stops) {
        const stopUID = s.StopUID;
        const stopName = (s.StopName && s.StopName.Zh_tw) || "";
        let found = 0;
        if (Array.isArray(recs)) {
          for (const rec of recs) {
            if (!rec.st || !Array.isArray(rec.st)) continue;
            const hit = rec.st.find(pair => pair && pair[0] === stopUID);
            if (hit) {
              const dir = rec.d === 1 ? 1 : 0;
              const rk = `${rec.u}|${dir}|${stopUID}`;
              if (!seenRoutes.has(rk)) {
                seenRoutes.add(rk);
                found++;
                noLiveRows.push({
                  RouteUID: rec.u,
                  RouteName: { Zh_tw: rec.n },
                  Direction: dir,
                  StopUID: stopUID,
                  StopName: { Zh_tw: hit[1] || stopName },
                  EstimateTime: null,
                  StopStatus: null,
                  noLive: true
                });
              }
            }
          }
        }
        if (!found) {
          noLiveRows.push({
            RouteUID: null,
            RouteName: { Zh_tw: "" },
            Direction: 0,
            StopUID: stopUID,
            StopName: { Zh_tw: stopName },
            EstimateTime: null,
            StopStatus: null,
            noLive: true,
            noRoutes: true
          });
        }
      }
    }
  }

  const allRows = [...rawOdRows, ...noLiveRows];
  allRows.sort((a, b) => (stopDistMap.get(a.StopUID) ?? Infinity) - (stopDistMap.get(b.StopUID) ?? Infinity));

  allRows.liveOk = liveOk;
  if (covZero) {
    allRows.noLiveWhy = "雲端還沒有這一區的站牌清單，暫無免 TDX 的站牌與到站資料";
  } else if (!allRows.liveOk) {
    allRows.noLiveWhy = (!nearSt.length && !allRows.length)
      ? "雲端站牌清單和即時資料都讀不到，請稍後下拉更新"
      : "雲端即時資料讀不到";
  } else if (noLiveRows.length) {
    allRows.noLiveWhy = "這一區沒有免 TDX 的即時資料";
  } else {
    allRows.noLiveWhy = null;
  }

  // v2.49.27: 第一屏不等 /pda/stops，/od/eta 回來後先將卡片交給畫面
  if (typeof opt.onEarlyRows === "function") {
    try { opt.onEarlyRows(allRows, nearSt); } catch (e) {}
  }

  const hasThb = allRows.some(r => isThbStop(r) || (r.StopUID && r.StopUID.startsWith("THB")));
  const canLoadMap = typeof window === "undefined" || window.__firstFrameRendered || opt.loadThbMap;
  if (hasThb && canLoadMap) {
    await loadPdaThbMap().catch(() => {});
  }

  const isAuto = !!(opt && opt.auto) || AUTO > 0;
  const pdaTtl = isAuto ? 20000 : (fresh ? 0 : 20000);
  const stopDynaCandidates = [];

  for (const r of allRows) {
    if (stopDynaCandidates.length >= NEAR_STOPDYNA_MAX) break;
    const pfx = (r.StopUID || "").slice(0, 3);
    if (pfx === "TPE") {
      const id = r.StopUID.slice(3);
      if (/^\d{1,8}$/.test(id)) {
        stopDynaCandidates.push({ city: "TPE", id, row: r });
      }
    } else if (pfx === "NWT") {
      const id = r.StopUID.slice(3);
      if (/^\d{1,8}$/.test(id)) {
        stopDynaCandidates.push({ city: "NWT", id, row: r });
      }
    } else if (pfx === "THB") {
      if (pdaThbMapData && pdaThbMapData.stops && (r.SubRouteUID || r.sub)) {
        const sub = r.SubRouteUID || r.sub;
        const dir = r.Direction === 1 ? 1 : 0;
        const key = `${sub}|${dir}|${r.StopUID}`;
        const id = pdaThbMapData.stops[key];
        if (id && /^\d{1,8}$/.test(String(id))) {
          stopDynaCandidates.push({ city: "THB", id: String(id), row: r, key });
        }
      }
    }
  }

  if (stopDynaCandidates.length > 0) {
    const byCity = { TPE: [], NWT: [], THB: [] };
    for (const c of stopDynaCandidates) byCity[c.city].push(c);

    const pdaResults = await Promise.all(
      ["TPE", "NWT", "THB"].map(async city => {
        const cands = byCity[city];
        if (!cands || !cands.length) return [];
        const ids = [...new Set(cands.map(c => c.id))];
        const res = await pdaStopEta(city, ids, pdaTtl).catch(() => null);
        return (res && Array.isArray(res.list)) ? res.list.map(it => ({ ...it, city })) : [];
      })
    );

    const pdaHitMap = new Map();
    for (const it of pdaResults.flat()) {
      pdaHitMap.set(`${it.city}|${it.id}`, it);
    }

    for (const cand of stopDynaCandidates) {
      const hit = pdaHitMap.get(`${cand.city}|${cand.id}`);
      if (hit && pdaRouteOk(cand.city, cand.row.RouteUID, hit) && (hit.EstimateTime != null || hit.StopStatus != null || hit.NextBusTime != null)) {
        const r = cand.row;
        r.src = "pda-stop";
        r.EstimateTime = hit.EstimateTime;
        r.sec = hit.EstimateTime;
        r.StopStatus = hit.StopStatus;
        r.status = hit.StopStatus;
        r.NextBusTime = hit.NextBusTime;
        r.next = hit.NextBusTime;
        if (hit.PlateNumb) r.PlateNumb = hit.PlateNumb;
        r.noLive = false;
      }
    }
  }

  allRows.liveOk = liveOk || stopDynaCandidates.some(c => c.row.src === "pda-stop");
  if (covZero) {
    allRows.noLiveWhy = "雲端還沒有這一區的站牌清單，暫無免 TDX 的站牌與到站資料";
  } else if (!allRows.liveOk) {
    allRows.noLiveWhy = (!nearSt.length && !allRows.length)
      ? "雲端站牌清單和即時資料都讀不到，請稍後下拉更新"
      : "雲端即時資料讀不到";
  } else if (noLiveRows.length) {
    allRows.noLiveWhy = "這一區沒有免 TDX 的即時資料";
  } else {
    allRows.noLiveWhy = null;
  }

  await fillOfficialEta(allRows, { lat, lon, nearSt, fresh, auto: (opt && opt.auto) || AUTO > 0 }).catch(() => {});
  return allRows;
}
// v2.37.0：自動更新（打開 app、停留 2 秒）時，新北路線也用新北開放資料，不問 TDX；下拉／重新整理（fresh）照舊。
// 只有這一格存過站牌清單時才走這條（看得出附近有沒有基隆、公路客運等其他站牌）；讀不到就回 null 照舊。
// v2.38.0：這一格還沒存站牌清單 → 先從雲端下載雙北（含公路客運）附近站牌清單（不用 TDX），存成同格式的 geo| 快取；雲端沒涵蓋就回 null，照舊 TDX
const cloudJobs = new Map();
// v2.41.0：雲端開始給雙北站牌方向（bearing 欄）。之前存的雲端清單沒有方向，重抓一次。
const oldCloud = c => !!c && c.src === "od" && !c.hv;
function cloudStops(geoKey) {
  if (!geoKey) return Promise.resolve(null);
  if (cloudJobs.has(geoKey)) return cloudJobs.get(geoKey);
  const m = /^s\|([\d.-]+),([\d.-]+),(\d+)$/.exec(geoKey);
  const job = (async () => {
    if (!m) return null;
    const c = await IDB.get("geo|" + geoKey).catch(() => null); if (c && !oldCloud(c)) return c;
    const j = await Promise.race([odGet(`/od/stops?lat=${m[1]}&lon=${m[2]}&r=${m[3]}`), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 6000))]).catch(() => null);
    if (j && j.cov === 0) return { cov: 0, d: [] };
    if (!j || j.cov !== 1 || !Array.isArray(j.d)) return null;
    const v = { t: Date.now(), d: j.d, src: "od", hv: j.d.some(a => a[5]) ? 1 : 0 }; await IDB.set("geo|" + geoKey, v).catch(() => {}); return v;
  })();
  cloudJobs.set(geoKey, job); job.then(v => { if (!v) cloudJobs.delete(geoKey); }, () => cloudJobs.delete(geoKey));
  return job;
}
const NEAR_STOPDYNA_MAX = 40;
// Opus：雙北的 StopDyna 回的路線編號要和這一列的路線一致（雲端 RouteUID＝前綴＋pda 路線編號）；公路客運用對照表，不比
const pdaRouteOk = (city, routeUID, hit) => city === "THB" || !hit || !hit.pdaRoute || !routeUID || String(routeUID).slice(3) === String(hit.pdaRoute);
let pdaThbMapData = null;
let pdaThbMapPromise = null;

async function loadPdaThbMap() {
  if (pdaThbMapData) return pdaThbMapData;
  if (!pdaThbMapPromise) {
    pdaThbMapPromise = (async () => {
      try {
        const res = await fetch("./data/pda-thb-map.json");
        if (!res.ok) return null;
        pdaThbMapData = await res.json();
        return pdaThbMapData;
      } catch (e) {
        return null;
      } finally {
        pdaThbMapPromise = null;
      }
    })();
  }
  return pdaThbMapPromise;
}

async function pdaStopEta(city, stopIds, ttl = 20000) {
  if (!stopIds || !stopIds.length) return { src: "pda-stop", list: [] };
  const c = (city || "").toUpperCase();
  if (c !== "TPE" && c !== "NWT" && c !== "THB") return { src: "pda-stop", list: [] };
  const validIds = [...new Set(stopIds.map(x => String(x).trim()))].filter(x => /^\d{1,8}$/.test(x));
  if (!validIds.length) return { src: "pda-stop", list: [] };

  const batches = [];
  for (let i = 0; i < validIds.length; i += 8) {
    batches.push(validIds.slice(i, i + 8));
  }

  const results = await Promise.all(batches.map(async batch => {
    try {
      const j = await odMemoGet(`/pda/stops?c=${c}&ids=${batch.join(",")}`, ttl);
      return (j && Array.isArray(j.list)) ? j.list : [];
    } catch (e) {
      return [];
    }
  }));
  return { src: "pda-stop", list: results.flat() };
}

async function pdaRouteEta(routeUID, ttl = 20000) {
  const p = (routeUID || "").slice(0, 3);
  if (p !== "TPE" && p !== "NWT") return null;
  const rid = (routeUID || "").slice(3);
  if (!/^\d{1,8}$/.test(rid)) return null;
  try {
    const j = await odMemoGet(`/pda/route?c=${p}&rid=${rid}`, ttl);
    return j && Array.isArray(j.list) && j.list.length ? j : null;
  } catch (e) {
    return null;
  }
}
// 單一路線的預估到站（＋公車位置）：TPE 用開放資料；NWT 先用 ebus 再用開放資料；讀不到或對不到就回 null，呼叫端照舊用 TDX
async function odRouteEta(routeUID, near, routeName, ttl = 15000) {
  if (isTpeR(routeUID)) {
    try { const j = await odGet(`/od/eta?route=${routeUID}${near ? "&near=1" : ""}`); if (j.list && j.list.length) return j; } catch (e) {}
    return null;
  }
  if (isNwtR(routeUID)) {
    if (routeName) {
      try {
        const j = await odMemoGet(`/ebus?route=${routeUID}&name=${encodeURIComponent(routeName)}`, ttl, 17000);
        if (j && Array.isArray(j.list) && j.list.length) return j;
      } catch (e) {}
    }
    try {
      const j = await odGet(`/od/eta?route=${routeUID}&nwt=1`);
      if (j && Array.isArray(j.list) && j.list.length) return j;
    } catch (e) {}
    return null;
  }
  return null;
}
function thbSubs(routeUID, dirNum, sor) {
  const rows = (sor || []).filter(r => r.RouteUID === routeUID);
  const ordered = [...rows.filter(r => (r.Direction === 1 ? 1 : 0) === dirNum), ...rows.filter(r => (r.Direction === 1 ? 1 : 0) !== dirNum)];
  const out = [], seen = new Set();
  for (const r of ordered) {
    const sub = r.SubRouteUID;
    if (!/^THB[0-9A-Za-z]{2,12}$/.test(sub || "") || seen.has(sub)) continue;
    seen.add(sub); out.push(`${sub}:${r.Direction === 1 ? 1 : 0}`);
    if (out.length === 4) break;
  }
  return out;
}
async function thbRouteEta(routeUID, dirNum, sor, ttl = 15000) {
  const subs = thbSubs(routeUID, dirNum, sor);
  if (!subs.length) return null;
  try {
    const j = await odMemoGet(`/thb?sub=${subs.join(",")}&route=${routeUID}`, ttl);
    return j && Array.isArray(j.list) && j.list.length ? j : null;
  } catch (e) { return null; }
}
function citybusStops(routeUID, sor) {
  const sample = rows => {
    const a = (rows || []).slice().sort((x, y) => (x.StopSequence || 0) - (y.StopSequence || 0));
    if (a.length <= 8) return a.map(x => x.StopUID).filter(Boolean);
    return Array.from({ length: 8 }, (_, i) => a[Math.round(i * (a.length - 1) / 7)].StopUID).filter(Boolean);
  };
  const rows = (sor || []).filter(x => x.RouteUID === routeUID);
  const one = d => rows.filter(x => (x.Direction === 1 ? 1 : 0) === d).sort((a, b) => (b.Stops || []).length - (a.Stops || []).length)[0];
  const a = one(0), b = one(1);
  return b ? [a ? sample(a.Stops) : [], sample(b.Stops)].join("|") : a ? sample(a.Stops).join(",") : "";
}
// 子路線車的短標示：中山幹線(綠線) + CYI0714A1 → 「綠A」；主線（SubRouteUID 等於路線或路線碼+0x）不標
function subTag(routeUID, route, sub) {
  if (!sub || sub === routeUID || !sub.startsWith(routeUID) || sub.length !== routeUID.length + 2) return "";
  const L = sub.slice(-2, -1); if (!/[A-Za-z]/.test(L)) return "";
  const m = /[(（]([^()（）]{1,3}?)線[)）]/.exec(route || "");
  return (m ? m[1] : "支") + L.toUpperCase();
}
async function citybusRouteEta(routeUID, routeName, sor, ttl = 15000) {
  const stops = citybusStops(routeUID, sor); if (!stops) return null;
  try {
    const subs = [...new Set((sor || []).filter(x => x.RouteUID === routeUID && x.SubRouteUID).map(x => x.SubRouteUID))].slice(0, 8).join(",");
    const j = await odMemoGet(`/citybus?route=${enc(routeUID)}&name=${enc(routeName)}&stops=${enc(stops)}${subs ? "&subs=" + enc(subs) : ""}`, ttl);
    return j && Array.isArray(j.list) && j.list.length ? j : null;
  } catch (e) { return null; }
}
function mapHszToTdx(j, routeUID, sor) {
  if (!j || !Array.isArray(j.dirs) || !Array.isArray(sor)) return null;
  const upd = j.upd || new Date().toISOString();
  const sorDirs = sor.filter(s => s && s.RouteUID === routeUID);
  if (!sorDirs.length) return null;

  const hav = (la1, lo1, la2, lo2) => {
    if (typeof haversine === "function") return haversine(la1, lo1, la2, lo2);
    const R = 6371000, t = d => d * Math.PI / 180;
    const a = Math.sin(t(la2 - la1) / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(t(lo2 - lo1) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  };

  const list = [];
  for (const dirObj of j.dirs) {
    const hStops = dirObj && Array.isArray(dirObj.stops) ? dirObj.stops : [];
    if (!hStops.length) continue;

    // 挑 sor 中同 RouteUID 的方向：以站名重合數最多者（同分時看首站名相同）
    let bestSorDir = null, maxOverlap = -1, firstMatched = false;
    for (const cand of sorDirs) {
      const cStops = cand.Stops || [];
      const cNames = new Set(cStops.map(s => s.StopName && s.StopName.Zh_tw).filter(Boolean));
      let overlap = 0;
      for (const s of hStops) {
        if (s.name && cNames.has(s.name)) overlap++;
      }
      const firstSame = !!(hStops[0] && cStops[0] && hStops[0].name && (cStops[0].StopName && cStops[0].StopName.Zh_tw) === hStops[0].name);
      if (overlap > maxOverlap || (overlap === maxOverlap && firstSame && !firstMatched)) {
        maxOverlap = overlap;
        firstMatched = firstSame;
        bestSorDir = cand;
      }
    }
    if (!bestSorDir || maxOverlap <= 0) continue;

    const candStops = bestSorDir.Stops || [];
    const tdxDir = bestSorDir.Direction;

    // 官網每站對到該方向 Stops 中站名相同且距離最近（<300m，沒有座標就只看站名、依序號最近）的 StopUID；對不到的略過
    for (const hs of hStops) {
      if (!hs.name) continue;
      const matched = candStops.filter(s => (s.StopName && s.StopName.Zh_tw) === hs.name);
      if (!matched.length) continue;

      let pickedStop = null;
      const hsHasCoord = hs.lat != null && hs.lon != null;
      const withCoord = matched.filter(s => {
        const p = s.StopPosition || (Array.isArray(s.P) ? { PositionLat: s.P[0], PositionLon: s.P[1] } : null);
        return p && p.PositionLat != null && p.PositionLon != null;
      });

      if (hsHasCoord && withCoord.length > 0) {
        let minDist = Infinity;
        for (const cs of withCoord) {
          const p = cs.StopPosition || { PositionLat: cs.P[0], PositionLon: cs.P[1] };
          const d = hav(+hs.lat, +hs.lon, +p.PositionLat, +p.PositionLon);
          if (d < 300 && d < minDist) {
            minDist = d;
            pickedStop = cs;
          }
        }
      } else {
        let minSeqDiff = Infinity;
        for (const cs of matched) {
          const diff = Math.abs((cs.StopSequence ?? 0) - (hs.seq ?? 0));
          if (diff < minSeqDiff) {
            minSeqDiff = diff;
            pickedStop = cs;
          }
        }
      }

      if (!pickedStop || !pickedStop.StopUID) continue;

      const item = {
        RouteUID: routeUID,
        StopUID: pickedStop.StopUID,
        Direction: tdxDir,
        ...(hs.EstimateTime != null ? { EstimateTime: hs.EstimateTime } : {}),
        StopStatus: hs.StopStatus ?? 1,
        ...(hs.PlateNumb ? { PlateNumb: hs.PlateNumb } : {}),
        ...(hs.NextBusTime ? { NextBusTime: nbIso(hs.NextBusTime) } : {}),
        SrcUpdateTime: upd
      };
      list.push(item);
    }
  }

  if (!list.length) return null;
  return { list, upd, src: "hccg" };
}
async function hszRouteEta(routeUID, name, sor, ttl = 15000) {
  if (!sor || !Array.isArray(sor) || !sor.length) return null;
  try {
    const j = await odMemoGet(`/hszbus?route=${enc(routeUID)}&name=${enc(name)}`, ttl);
    if (!j) return null;
    return mapHszToTdx(j, routeUID, sor);
  } catch (e) {
    return null;
  }
}
function mapTcgoToTdx(j, routeUID, sor) {
  if (!j || !Array.isArray(j.dirs) || !Array.isArray(sor)) return null;
  try {
    const upd = j.upd || new Date().toISOString();
    const sorDirs = sor.filter(s => s && s.RouteUID === routeUID);
    if (!sorDirs.length) return null;

    const list = [];
    for (const dirObj of j.dirs) {
      const tcStops = dirObj && Array.isArray(dirObj.stops) ? dirObj.stops : [];
      if (!tcStops.length) continue;

      // 官網 dir 0/1 對 TDX Direction 0/1 的 sor 行；若同方向對不到就用站名重疊數最多的那行
      let bestSorDir = null;
      const sameDirCands = sorDirs.filter(s => s.Direction === dirObj.dir);
      if (sameDirCands.length > 0) {
        let maxOverlap = -1;
        for (const cand of sameDirCands) {
          const candNames = new Set((cand.Stops || []).map(s => s.StopName && s.StopName.Zh_tw).filter(Boolean));
          let overlap = 0;
          for (const s of tcStops) {
            if (s.name && candNames.has(s.name)) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) {
        let maxOverlap = -1;
        for (const cand of sorDirs) {
          const candNames = new Set((cand.Stops || []).map(s => s.StopName && s.StopName.Zh_tw).filter(Boolean));
          let overlap = 0;
          for (const s of tcStops) {
            if (s.name && candNames.has(s.name)) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) continue;

      const candStops = bestSorDir.Stops || [];
      const tdxDir = bestSorDir.Direction;

      // 每站用站名比對，同名多站時取 StopSequence 與官網 seq 最接近者
      for (const ts of tcStops) {
        if (!ts.name) continue;
        const matched = candStops.filter(s => (s.StopName && s.StopName.Zh_tw) === ts.name);
        if (!matched.length) continue;

        let pickedStop = matched[0];
        if (matched.length > 1) {
          let minDiff = Infinity;
          for (const cs of matched) {
            const diff = Math.abs((cs.StopSequence ?? 0) - (ts.seq ?? 0));
            if (diff < minDiff) {
              minDiff = diff;
              pickedStop = cs;
            }
          }
        }

        if (!pickedStop || !pickedStop.StopUID) continue;

        const item = {
          RouteUID: routeUID,
          StopUID: pickedStop.StopUID,
          Direction: tdxDir,
          ...(ts.EstimateTime != null ? { EstimateTime: ts.EstimateTime } : {}),
          StopStatus: ts.StopStatus ?? 1,
          ...(ts.PlateNumb ? { PlateNumb: ts.PlateNumb } : {}),
          ...(ts.NextBusTime ? { NextBusTime: nbIso(ts.NextBusTime) } : {}),
          SrcUpdateTime: upd
        };
        list.push(item);
      }
    }

    if (!list.length) return null;
    return { list, upd, src: "tcgo" };
  } catch (e) {
    return null;
  }
}
async function tcgoRouteEta(routeUID, name, sor, ttl = 15000) {
  if (!sor || !Array.isArray(sor) || !sor.length) return null;
  try {
    const j = await odMemoGet(`/tcgo?route=${enc(routeUID)}&name=${enc(name)}`, ttl);
    if (!j) return null;
    return mapTcgoToTdx(j, routeUID, sor);
  } catch (e) {
    return null;
  }
}
function mapTnbusToTdx(j, routeUID, sor) {
  if (!j || !Array.isArray(j.dirs) || !Array.isArray(sor)) return null;
  try {
    const upd = j.upd || new Date().toISOString();
    const sorDirs = sor.filter(s => s && s.RouteUID === routeUID);
    if (!sorDirs.length) return null;

    const normStop = s => String(s || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");

    const list = [];
    for (const dirObj of j.dirs) {
      const tnStops = dirObj && Array.isArray(dirObj.stops) ? dirObj.stops : [];
      if (!tnStops.length) continue;

      // 官網 dir 0/1 對 TDX Direction 0/1 的 sor 行；若同方向對不到就用站名重疊數最多的那行
      let bestSorDir = null;
      const sameDirCands = sorDirs.filter(s => s.Direction === dirObj.dir);
      if (sameDirCands.length > 0) {
        let maxOverlap = -1;
        for (const cand of sameDirCands) {
          const candNames = new Set((cand.Stops || []).map(s => normStop(s.StopName && s.StopName.Zh_tw)).filter(Boolean));
          let overlap = 0;
          for (const s of tnStops) {
            if (s.name && candNames.has(normStop(s.name))) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) {
        let maxOverlap = -1;
        for (const cand of sorDirs) {
          const candNames = new Set((cand.Stops || []).map(s => normStop(s.StopName && s.StopName.Zh_tw)).filter(Boolean));
          let overlap = 0;
          for (const s of tnStops) {
            if (s.name && candNames.has(normStop(s.name))) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) continue;

      const candStops = bestSorDir.Stops || [];
      const tdxDir = bestSorDir.Direction;

      // 每站用站名比對（去空白、全半形括號統一），同名多站時取 StopSequence 與官網 seq 最接近者
      for (const ts of tnStops) {
        if (!ts.name) continue;
        const normTsName = normStop(ts.name);
        const matched = candStops.filter(s => normStop(s.StopName && s.StopName.Zh_tw) === normTsName);
        if (!matched.length) continue;

        let pickedStop = matched[0];
        if (matched.length > 1) {
          let minDiff = Infinity;
          for (const cs of matched) {
            const diff = Math.abs((cs.StopSequence ?? 0) - (ts.seq ?? 0));
            if (diff < minDiff) {
              minDiff = diff;
              pickedStop = cs;
            }
          }
        }

        if (!pickedStop || !pickedStop.StopUID) continue;

        const plate = ts.plate || ts.PlateNumb;
        const item = {
          RouteUID: routeUID,
          StopUID: pickedStop.StopUID,
          Direction: tdxDir,
          ...(ts.EstimateTime != null ? { EstimateTime: ts.EstimateTime } : {}),
          StopStatus: ts.StopStatus ?? 1,
          ...(plate ? { PlateNumb: plate } : {}),
          ...(ts.NextBusTime ? { NextBusTime: nbIso(ts.NextBusTime) } : {}),
          SrcUpdateTime: upd
        };
        list.push(item);
      }
    }

    if (!list.length) return null;
    return { list, upd, src: "tnbus" };
  } catch (e) {
    return null;
  }
}
async function tnbusRouteEta(routeUID, name, sor, ttl = 15000) {
  if (!sor || !Array.isArray(sor) || !sor.length) return null;
  try {
    const j = await odMemoGet(`/tnbus?route=${enc(routeUID)}&name=${enc(name)}`, ttl);
    if (!j) return null;
    return mapTnbusToTdx(j, routeUID, sor);
  } catch (e) {
    return null;
  }
}
function mapTwhToTdx(j, routeUID, sor) {
  if (!j || j.empty || !Array.isArray(j.dirs) || !Array.isArray(sor)) return null;
  try {
    const upd = j.upd || new Date().toISOString();
    const sorDirs = sor.filter(s => s && s.RouteUID === routeUID);
    if (!sorDirs.length) return null;

    const normStop = s => String(s || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");

    const list = [];
    for (const dirObj of j.dirs) {
      const twhStops = dirObj && Array.isArray(dirObj.stops) ? dirObj.stops : [];
      if (!twhStops.length) continue;

      let bestSorDir = null;
      const sameDirCands = sorDirs.filter(s => s.Direction === dirObj.dir);
      if (sameDirCands.length > 0) {
        let maxOverlap = -1;
        for (const cand of sameDirCands) {
          const candNames = new Set((cand.Stops || []).map(s => normStop(s.StopName && s.StopName.Zh_tw)).filter(Boolean));
          let overlap = 0;
          for (const s of twhStops) {
            if (s.name && candNames.has(normStop(s.name))) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) {
        let maxOverlap = -1;
        for (const cand of sorDirs) {
          const candNames = new Set((cand.Stops || []).map(s => normStop(s.StopName && s.StopName.Zh_tw)).filter(Boolean));
          let overlap = 0;
          for (const s of twhStops) {
            if (s.name && candNames.has(normStop(s.name))) overlap++;
          }
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSorDir = cand;
          }
        }
        if (maxOverlap <= 0) bestSorDir = null;
      }

      if (!bestSorDir) continue;

      const candStops = bestSorDir.Stops || [];
      const tdxDir = bestSorDir.Direction;

      for (const ts of twhStops) {
        if (!ts.name && !ts.stopUID) continue;

        let pickedStop = null;
        if (ts.stopUID) {
          pickedStop = candStops.find(s => s.StopUID === ts.stopUID);
        }
        if (!pickedStop && ts.name) {
          const normTsName = normStop(ts.name);
          const matched = candStops.filter(s => normStop(s.StopName && s.StopName.Zh_tw) === normTsName);
          if (matched.length === 1) {
            pickedStop = matched[0];
          } else if (matched.length > 1) {
            let minDiff = Infinity;
            for (const cs of matched) {
              const diff = Math.abs((cs.StopSequence ?? 0) - (ts.seq ?? 0));
              if (diff < minDiff) {
                minDiff = diff;
                pickedStop = cs;
              }
            }
          }
        }

        if (!pickedStop || !pickedStop.StopUID) continue;

        const plate = ts.plate || ts.PlateNumb;
        const item = {
          RouteUID: routeUID,
          StopUID: pickedStop.StopUID,
          Direction: tdxDir,
          ...(ts.EstimateTime != null ? { EstimateTime: ts.EstimateTime } : {}),
          StopStatus: ts.StopStatus ?? 1,
          ...(plate ? { PlateNumb: plate } : {}),
          ...(ts.NextBusTime ? { NextBusTime: nbIso(ts.NextBusTime) } : {}),
          SrcUpdateTime: upd
        };
        list.push(item);
      }
    }

    if (!list.length) return null;
    return { list, upd, src: "twh" };
  } catch (e) {
    return null;
  }
}
async function twhRouteEta(routeUID, name, sor, ttl = 15000) {
  if (!sor || !Array.isArray(sor) || !sor.length) return null;
  try {
    const j = await odMemoGet(`/twh?route=${enc(routeUID)}&name=${enc(name)}`, ttl);
    if (!j || j.empty) return null;
    return mapTwhToTdx(j, routeUID, sor);
  } catch (e) {
    return null;
  }
}
// 金門官網：TDX StopUID = "KIN" + 官網路線 Id + "-" + SID，先用 StopUID 對；對不到再用站名＋站序對方向
function mapKinbusToTdx(j, routeUID, sor) {
  if (!j || !Array.isArray(j.dirs) || !Array.isArray(sor)) return null;
  try {
    const upd = j.upd || new Date().toISOString();
    const sorDirs = sor.filter(s => s && s.RouteUID === routeUID);
    if (!sorDirs.length) return null;

    const normStop = s => String(s || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
    const rowDir = r => r.Direction === 1 ? 1 : 0;
    const uidDir = new Map();
    for (const r of sorDirs) for (const s of r.Stops || []) if (s.StopUID && !uidDir.has(s.StopUID)) uidDir.set(s.StopUID, rowDir(r));

    const list = [];
    for (const dirObj of j.dirs) {
      const kStops = dirObj && Array.isArray(dirObj.stops) ? dirObj.stops : [];
      if (!kStops.length) continue;

      // 1. StopUID 命中最多的 TDX 方向
      const hits = [0, 0];
      for (const s of kStops) if (s.stopUID && uidDir.has(s.stopUID)) hits[uidDir.get(s.stopUID)]++;
      let tdxDir = null;
      if (hits[0] || hits[1]) tdxDir = hits[1] > hits[0] ? 1 : 0;

      // 2. 站名＋站序：依官網站序在 TDX 該行的位置遞增次數最多者（來回同站名時分得出方向），同分取同 dir
      if (tdxDir === null) {
        let best = -1;
        for (const cand of sorDirs) {
          const names = (cand.Stops || []).slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0)).map(s => normStop(s.StopName && s.StopName.Zh_tw));
          let score = 0, prev = -1;
          for (const s of kStops) {
            const pos = names.indexOf(normStop(s.name));
            if (pos < 0) continue;
            if (prev < 0 || pos > prev) score++;
            prev = pos;
          }
          if (score > best || (score === best && rowDir(cand) === dirObj.dir)) {
            if (score > 0) { best = score; tdxDir = rowDir(cand); }
          }
        }
      }
      if (tdxDir === null) continue;

      const candStops = sorDirs.filter(r => rowDir(r) === tdxDir).flatMap(r => r.Stops || []);
      for (const ks of kStops) {
        let pickedStop = null;
        if (ks.stopUID && uidDir.get(ks.stopUID) === tdxDir) pickedStop = { StopUID: ks.stopUID };
        if (!pickedStop && ks.name) {
          const nm = normStop(ks.name);
          let minDiff = Infinity;
          for (const cs of candStops) {
            if (normStop(cs.StopName && cs.StopName.Zh_tw) !== nm) continue;
            const diff = Math.abs((cs.StopSequence ?? 0) - (ks.seq ?? 0));
            if (diff < minDiff) { minDiff = diff; pickedStop = cs; }
          }
        }
        if (!pickedStop || !pickedStop.StopUID) continue;

        const plate = ks.plate || ks.PlateNumb;
        list.push({
          RouteUID: routeUID,
          StopUID: pickedStop.StopUID,
          Direction: tdxDir,
          ...(ks.EstimateTime != null ? { EstimateTime: ks.EstimateTime } : {}),
          StopStatus: ks.StopStatus ?? 1,
          ...(plate ? { PlateNumb: plate } : {}),
          ...(ks.NextBusTime ? { NextBusTime: nbIso(ks.NextBusTime) } : {}),
          SrcUpdateTime: upd
        });
      }
    }

    if (!list.length) return null;
    return { list, upd, src: "kinbus" };
  } catch (e) {
    return null;
  }
}
// 要查的官網路線 Id：站牌彈窗那幾站的 StopUID 前綴優先，再加每個方向最長那行站序的主要前綴（最多 4 個）
function kinbusIds(routeUID, sor, stopUIDs) {
  const idOf = uid => { const m = /^KIN(\d{1,8})-/.exec(uid || ""); return m ? m[1] : null; };
  const out = [];
  const add = id => { if (id && !out.includes(id)) out.push(id); };
  for (const u of stopUIDs || []) add(idOf(u));
  const rows = (sor || []).filter(r => r && r.RouteUID === routeUID);
  for (const d of [0, 1]) {
    const row = rows.filter(r => (r.Direction === 1 ? 1 : 0) === d).sort((a, b) => (b.Stops || []).length - (a.Stops || []).length)[0];
    if (!row) continue;
    const cnt = {};
    for (const s of row.Stops || []) { const id = idOf(s.StopUID); if (id) cnt[id] = (cnt[id] || 0) + 1; }
    add(Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]);
  }
  return out.slice(0, 4);
}
async function kinbusRouteEta(routeUID, name, sor, stopUIDs, ttl = 15000) {
  if (!sor || !Array.isArray(sor) || !sor.length) return null;
  try {
    const ids = kinbusIds(routeUID, sor, stopUIDs);
    const j = await odMemoGet(`/kinbus?route=${enc(routeUID)}&name=${enc(name)}${ids.length ? `&ids=${ids.join(",")}` : ""}`, ttl);
    if (!j) return null;
    return mapKinbusToTdx(j, routeUID, sor);
  } catch (e) {
    return null;
  }
}
async function taoRouteEta(routeUID, ttl = 15000) {
  try {
    const j = await odMemoGet(`/tyebus?route=${enc(routeUID)}`, ttl);
    return j && Array.isArray(j.list) ? j : null;
  } catch (e) { return null; }
}
async function routeEtas(b) {   // 規劃結果用：同 TDX 路線預估到站的格式
  if (isThbR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await thbRouteEta(b.routeUID, b.dirNum === 1 ? 1 : 0, sor);
    if (official) return official.list;
  }
  if (isCitybusR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await citybusRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isHszR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await hszRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isTxgR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await tcgoRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isTnnR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await tnbusRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isKhhR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await twhRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isKinR(b.routeUID)) {
    const k = routeKind(b.routeUID), sor = k ? await sorOf(k, b.route, b.routeUID).catch(() => []) : [];
    const official = await kinbusRouteEta(b.routeUID, b.route, sor);
    if (official) return official.list;
  }
  if (isTpeR(b.routeUID) || isNwtR(b.routeUID)) {
    const pda = await pdaRouteEta(b.routeUID, 20000);
    if (pda && pda.list) return pda.list;
    const j = await odRouteEta(b.routeUID, false, b.route);
    return j && j.list ? j.list : [];
  }
  const j = await odRouteEta(b.routeUID, false, b.route); if (j) return j.list;
  return tdx("route", `${BASE}/basic/v2/Bus/EstimatedTimeOfArrival/${b.path}?%24filter=${enc(`RouteUID eq '${b.routeUID}'`)}&%24top=600&%24format=JSON`);   // v2.46.3：用 RouteUID 過濾（高雄等路線名稱當路徑會回空）
}

const NEAR_OFFICIAL_MAX = 8;
const NEAR_OFFICIAL_TTL = 30000;
const nearOfficialCache = new Map();

const uidOf = r => (r && (r.RouteUID || r.routeUID)) || "";
const nameOf = r => (r && ((r.RouteName && r.RouteName.Zh_tw) || r.route || r.name)) || "";
const dirOf = r => (r && r.Direction != null) ? (r.Direction === 1 ? 1 : 0) : ((r && r.dirNum === 1) ? 1 : 0);
// v2.49.25：pda5284 的到站沒有 Direction。雙北的站牌 UID 本身就分去、回程，所以沒有 Direction 時只用 StopUID 對；
// 其他縣市（例如公路客運的站牌去回程共用）沒有 Direction 時照舊當成 0，避免填到另一個方向的時間
const etaDirOk = (t, dirNum, routeUID) => t.Direction != null
  ? (t.Direction === 1 ? 1 : 0) === (dirNum === 1 ? 1 : 0)
  : ((isTpeR(routeUID) || isNwtR(routeUID)) ? true : (dirNum === 1 ? 1 : 0) === 0);
const stopOf = r => (r && (r.StopUID || r.stopUID)) || "";

function applyOfficialHit(r, hit, src) {
  const est = typeof hit.EstimateTime === "number" ? hit.EstimateTime : null;
  const stat = hit.StopStatus ?? 0;
  const nxt = hit.NextBusTime || null;

  if (est != null) {
    r.EstimateTime = est;
    r.sec = est;
  } else {
    r.EstimateTime = null;
    r.sec = null;
  }
  r.StopStatus = stat;
  r.status = stat;
  r.NextBusTime = nxt;
  r.next = nxt;
  r.src = src || hit.src || "official";

  if (est !== null || nxt || (stat !== 0 && stat != null)) {
    r.noLive = false;
  }
}

async function fetchOfficialRoute(routeUID, name, items = [], sor = null, fresh = false) {
  const ttl = fresh ? 0 : 15000;
  let res = null;
  if (isTpeR(routeUID) || isNwtR(routeUID)) {
    res = await pdaRouteEta(routeUID, fresh ? 0 : 20000);
    if (res) {
      res.src = res.src || "pda";
    } else if (isTpeR(routeUID)) {
      res = await odRouteEta(routeUID, true, name, ttl);
      if (res) res.src = res.src || "od";
    } else if (isNwtR(routeUID)) {
      if (name) {
        try { res = await odMemoGet(`/ebus?route=${routeUID}&name=${encodeURIComponent(name)}`, ttl, 17000); } catch (e) {}
      }
      if (!res || !Array.isArray(res.list) || !res.list.length) {
        try { res = await odGet(`/od/eta?route=${routeUID}&nwt=1`); } catch (e) {}
      }
      if (res) res.src = res.src || "ebus";
    }
  } else if (isTaoR(routeUID)) {
    res = await taoRouteEta(routeUID, ttl);
    if (res) res.src = res.src || "tyebus";
  } else {
    if (!sor) {
      sor = sorMem.get("uid|" + routeUID);
      if (!sor) {
        const k = routeKind(routeUID), c = k && await IDB.get(`sor|${k.path}|${name}`).catch(() => null);
        sor = c && c.d;
      }
    }
    if (isThbR(routeUID)) {
      const dirNum = items[0] ? dirOf(items[0]) : 0;
      const rows = (sor || []).filter(x => x.RouteUID === routeUID && (items.length === 0 || items.some(r => (x.Direction === 1 ? 1 : 0) === dirOf(r) && (x.Stops || []).some(s => s.StopUID === stopOf(r)))));
      let subs = thbSubs(routeUID, dirNum, rows.length ? rows : (sor || []));
      if (!subs.length && items.length) {
        subs = [...new Set(items.map(r => r.SubRouteUID || r.sub).filter(Boolean))];
      }
      if (subs.length) {
        try { res = await odMemoGet(`/thb?sub=${subs.join(",")}&route=${routeUID}`, ttl); } catch (e) {}
      }
      if (res) res.src = res.src || "thb";
    } else if (isCitybusR(routeUID)) {
      res = await citybusRouteEta(routeUID, name, sor, ttl);
      if (res) res.src = res.src || "citybus";
    } else if (isHszR(routeUID)) {
      res = await hszRouteEta(routeUID, name, sor, ttl);
      if (res) res.src = res.src || "hszbus";
    } else if (isTxgR(routeUID)) {
      res = await tcgoRouteEta(routeUID, name, sor, ttl);
      if (res) res.src = res.src || "tcgo";
    } else if (isTnnR(routeUID)) {
      res = await tnbusRouteEta(routeUID, name, sor, ttl);
      if (res) res.src = res.src || "tnbus";
    } else if (isKhhR(routeUID)) {
      res = await twhRouteEta(routeUID, name, sor, ttl);
      if (res) res.src = res.src || "twh";
    } else if (isKinR(routeUID)) {
      res = await kinbusRouteEta(routeUID, name, sor, items.map(stopOf), ttl);
      if (res) res.src = res.src || "kinbus";
    }
  }
  return res && Array.isArray(res.list) ? res : null;
}

// 使用者正在看的那幾條線（公車卡展開、站牌小視窗）：官方即時來源只補最快前四條
async function refreshNwtRoutes(routes, opt = {}) {
  const isCand = r => {
    if (!r) return false;
    const u = uidOf(r);
    if (!u) return false;
    const hasLive = (r.sec != null && r.sec >= 0) || (r.EstimateTime != null && r.EstimateTime >= 0);
    if (hasLive && !r.noLive) return false;
    return isTpeR(u) || isNwtR(u) || isTaoR(u) || isThbR(u) || isCitybusR(u) || isHszR(u) || isTxgR(u) || isTnnR(u) || isKhhR(u) || isKinR(u);
  };
  const list = (routes || []).filter(isCand);
  if (!list.length) return;

  const max = opt.max || 4;
  let orderedUids = [];

  if (opt.near) {
    let stopDist = opt.stopDist;
    if (!stopDist && opt.nearSt && opt.lat != null && opt.lon != null) {
      stopDist = new Map();
      for (const s of opt.nearSt) {
        if (s.StopUID && s.StopPosition && s.StopPosition.PositionLat != null) {
          stopDist.set(s.StopUID, haversine(+opt.lat, +opt.lon, s.StopPosition.PositionLat, s.StopPosition.PositionLon));
        }
      }
    }
    const uidDist = new Map();
    for (const r of list) {
      const u = uidOf(r);
      const s = stopOf(r);
      const d = (stopDist && stopDist.get(s)) ?? r.dist ?? (r.pos && r.pos.d) ?? Infinity;
      const cur = uidDist.get(u);
      if (cur == null || d < cur) uidDist.set(u, d);
    }
    const uniqUids = [...new Set(list.map(uidOf))];
    uniqUids.sort((a, b) => (uidDist.get(a) ?? Infinity) - (uidDist.get(b) ?? Infinity));
    orderedUids = uniqUids.slice(0, max);
  } else {
    const rank = r => r.sec != null ? r.sec : (r.status === 0 || r.StopStatus === 0) ? 1e6 : 2e6;
    list.sort((a, b) => rank(a) - rank(b));
    orderedUids = list.map(uidOf).filter((u, i, a) => a.indexOf(u) === i).slice(0, max);
  }

  const keep = new Set(orderedUids);
  for (let i = list.length - 1; i >= 0; i--) {
    if (!keep.has(uidOf(list[i]))) list.splice(i, 1);
  }

  const byRoute = new Map();
  for (const r of list) {
    const u = uidOf(r);
    if (!byRoute.has(u)) byRoute.set(u, { name: nameOf(r), items: [] });
    byRoute.get(u).items.push(r);
  }

  const needSor = [];
  for (const [uid, { name }] of byRoute) {
    if (isTpeR(uid) || isNwtR(uid) || isTaoR(uid) || sorMem.get("uid|" + uid)) continue;
    const k = routeKind(uid), c = k && await IDB.get(`sor|${k.path}|${name}`).catch(() => null);
    if (c && c.d && c.d.some(x => x.RouteUID === uid)) { sorMem.set("uid|" + uid, c.d); continue; }
    needSor.push(uid);
  }
  if (needSor.length) {
    const got = await cloudSor(needSor).catch(() => ({}));
    for (const [uid, rows] of Object.entries(got)) {
      if (!rows || !rows.length) continue;
      sorMem.set("uid|" + uid, rows);
      const k = routeKind(uid), nm = byRoute.get(uid) && byRoute.get(uid).name;
      if (k && nm) {
        const key = `sor|${k.path}|${nm}`, old = await IDB.get(key).catch(() => null);
        IDB.set(key, { t: Date.now(), d: [...((old && old.d) || []).filter(x => x.RouteUID !== uid), ...rows], src: "kv" }).catch(() => {});
      }
    }
  }

  const now = Date.now();
  const isAuto = !!opt.auto || AUTO > 0;
  const isFresh = !!opt.fresh;

  // 雙北站牌到站優先來源：pda5284 StopDyna
  const pdaItemsByCity = { TPE: [], NWT: [], THB: [] };
  const pdaItemMap = new Map();

  for (const r of list) {
    const u = uidOf(r);
    const s = stopOf(r);
    const d = dirOf(r);
    if (isTpeR(u) || (s && s.startsWith("TPE"))) {
      const id = s ? s.slice(3) : "";
      if (/^\d{1,8}$/.test(id)) {
        pdaItemsByCity.TPE.push(id);
        if (!pdaItemMap.has(`TPE|${id}`)) pdaItemMap.set(`TPE|${id}`, []);
        pdaItemMap.get(`TPE|${id}`).push(r);
      }
    } else if (isNwtR(u) || (s && s.startsWith("NWT"))) {
      const id = s ? s.slice(3) : "";
      if (/^\d{1,8}$/.test(id)) {
        pdaItemsByCity.NWT.push(id);
        if (!pdaItemMap.has(`NWT|${id}`)) pdaItemMap.set(`NWT|${id}`, []);
        pdaItemMap.get(`NWT|${id}`).push(r);
      }
    } else if (isThbR(u) || (s && s.startsWith("THB"))) {
      if (pdaThbMapData && pdaThbMapData.stops) {
        const sub = r.SubRouteUID || (r.sub) || "";
        const key = `${sub}|${d === 1 ? 1 : 0}|${s}`;
        const id = pdaThbMapData.stops[key];
        if (id && /^\d{1,8}$/.test(String(id))) {
          pdaItemsByCity.THB.push(String(id));
          if (!pdaItemMap.has(`THB|${id}`)) pdaItemMap.set(`THB|${id}`, []);
          pdaItemMap.get(`THB|${id}`).push(r);
        }
      }
    }
  }

  const pdaHandled = new Set();
  const totalPda = pdaItemsByCity.TPE.length + pdaItemsByCity.NWT.length + pdaItemsByCity.THB.length;
  if (totalPda > 0) {
    const ttl = isFresh ? 0 : 20000;
    const pdaResults = await Promise.all(
      ["TPE", "NWT", "THB"].map(async city => {
        const ids = [...new Set(pdaItemsByCity[city])];
        if (!ids.length) return [];
        const res = await pdaStopEta(city, ids, ttl).catch(() => null);
        return (res && Array.isArray(res.list)) ? res.list.map(it => ({ ...it, city })) : [];
      })
    );

    for (const item of pdaResults.flat()) {
      const rows = pdaItemMap.get(`${item.city}|${item.id}`) || [];
      for (const r of rows) {
        if (!pdaRouteOk(item.city, uidOf(r), item)) continue;
        r.src = "pda-stop";
        if (item.EstimateTime != null || item.StopStatus != null || item.NextBusTime != null) {
          r.EstimateTime = item.EstimateTime;
          r.sec = item.EstimateTime;
          r.StopStatus = item.StopStatus;
          r.status = item.StopStatus;
          r.NextBusTime = item.NextBusTime;
          r.next = item.NextBusTime;
          if (item.PlateNumb) r.PlateNumb = item.PlateNumb;
          r.noLive = false;
        } else {
          r.EstimateTime = null;
          r.sec = null;
          r.status = null;
          r.StopStatus = null;
          r.noLive = true;
        }
        pdaHandled.add(r);
      }
    }
  }

  // 對於已由 StopDyna 取得之項目，不需再打路線官方來源
  for (const [routeUID, val] of byRoute) {
    val.items = val.items.filter(r => !pdaHandled.has(r));
    if (!val.items.length) byRoute.delete(routeUID);
  }

  await Promise.all([...byRoute.entries()].map(async ([routeUID, { name, items }]) => {
    let res = null;
    const entry = nearOfficialCache.get(routeUID);
    // 審查修正：定時更新（AUTO）也只在快取超過 30 秒時才重打；原本 AUTO 一律用快取，時間會一直停在第一次抓到的值
    if (!isFresh && entry && (now - entry.t < NEAR_OFFICIAL_TTL)) {
      res = entry.res;
    } else {
      res = await fetchOfficialRoute(routeUID, name, items, null, isFresh).catch(() => null);
      nearOfficialCache.set(routeUID, { t: now, res });
    }

    if (res && Array.isArray(res.list)) {
      for (const r of items) {
        const sUid = stopOf(r);
        const rDir = dirOf(r);
        const hits = res.list.filter(t => t.RouteUID === routeUID && t.StopUID === sUid && etaDirOk(t, rDir, routeUID));
        const hit = hits.sort((a, b) => (typeof a.EstimateTime === "number" ? a.EstimateTime : 1e9) - (typeof b.EstimateTime === "number" ? b.EstimateTime : 1e9))[0];
        if (hit) {
          applyOfficialHit(r, hit, res.src);
        }
      }
    }
  }));
}

async function fillOfficialEta(rows, opt = {}) {
  if (!rows || !Array.isArray(rows) || !rows.length) return rows;
  const noLiveRows = rows.filter(r => r && (r.noLive || (r.EstimateTime == null && r.sec == null)) && uidOf(r));
  if (!noLiveRows.length) return rows;
  await refreshNwtRoutes(noLiveRows, {
    max: NEAR_OFFICIAL_MAX,
    near: true,
    auto: opt.auto,
    fresh: opt.fresh,
    lat: opt.lat,
    lon: opt.lon,
    nearSt: opt.nearSt,
    stopDist: opt.stopDist
  });
  return rows;
}

// ---------- 工具 ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, t = d => d * Math.PI / 180;
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) - Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function circMean(degs) {
  let x = 0, y = 0;
  for (const d of degs) { const r = d * Math.PI / 180; x += Math.cos(r); y += Math.sin(r); }
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function groupByRelativeQuadrant(origin, items) {
  const oLat = origin ? (Array.isArray(origin) ? origin[0] : (origin.lat ?? origin.latitude)) : null;
  const oLon = origin ? (Array.isArray(origin) ? origin[1] : (origin.lon ?? origin.longitude)) : null;

  const nameOf = r => r.dest || r.n || (r.dirNum === 1 ? "返程" : "去程");
  const formatDestLine = rs => {
    const names = rs.map(nameOf).filter(Boolean);
    const uniq = [...new Set(names)];
    const show = uniq.slice(0, 4);
    return `往 ${show.join("／")}${uniq.length > show.length ? " 等" : ""}`;
  };

  const withB = [];
  const noB = [];

  for (const item of items || []) {
    let b = null;
    if (item.destHead != null && Number.isFinite(item.destHead)) {
      b = item.destHead;
    } else if (item.b != null && Number.isFinite(item.b)) {
      b = item.b;
    } else if (item.ll && oLat != null && oLon != null) {
      const dLat = Array.isArray(item.ll) ? item.ll[0] : (item.ll.lat ?? item.ll.latitude);
      const dLon = Array.isArray(item.ll) ? item.ll[1] : (item.ll.lon ?? item.ll.longitude);
      if (dLat != null && dLon != null) {
        b = bearingDeg(oLat, oLon, dLat, dLon);
      }
    }
    const copy = { ...item };
    if (b != null && Number.isFinite(b)) {
      copy.b = (b % 360 + 360) % 360;
      withB.push(copy);
    } else {
      copy.b = null;
      noB.push(copy);
    }
  }

  let best = 0, bm = -1;
  if (withB.length > 1) {
    for (let a = 0; a < 90; a++) {
      let m = 90;
      for (const o of withB) {
        const t = ((o.b - a) % 90 + 90) % 90;
        const dist = Math.min(t, 90 - t);
        if (dist < m) m = dist;
      }
      if (m > bm) {
        bm = m;
        best = a;
      }
    }
  } else if (withB.length === 1) {
    best = 0;
    bm = 0;
  }

  const g = [[], [], [], []];
  withB.forEach(o => {
    const q = Math.floor((((o.b - best) % 360 + 360) % 360) / 90);
    o.q = q;
    g[q].push(o);
  });

  const activeGroups = g.filter(x => x.length > 0);
  const destLines = activeGroups.map(group => {
    const heads = group.map(r => r.head).filter(h => h != null && Number.isFinite(h));
    const groupHead = heads.length ? circMean(heads) : null;
    return { destLine: formatDestLine(group), head: groupHead };
  });

  if (noB.length > 0) {
    const heads = noB.map(r => r.head).filter(h => h != null && Number.isFinite(h));
    const noBHead = heads.length ? circMean(heads) : null;
    destLines.push({ destLine: formatDestLine(noB), head: noBHead });
  }

  return {
    axis: best,
    margin: bm,
    dests: withB.concat(noB),
    groups: activeGroups,
    lines: destLines,
  };
}
if (typeof window !== "undefined") window.groupByRelativeQuadrant = groupByRelativeQuadrant;
function llOf(s) {
  if (!s) return null;
  if (Array.isArray(s.P) && s.P.length >= 2 && s.P[0] != null && s.P[1] != null) return [+s.P[0], +s.P[1]];
  const p = s.StopPosition;
  if (p && p.PositionLat != null && p.PositionLon != null) return [+p.PositionLat, +p.PositionLon];
  return null;
}
// 往下一站的方位：沿站序取這一站之後、第一個有座標的下一站。不往終點跳，也不用終點或前一站的方位。
function travelHead(stops, uid, lat, lon) {
  if (!stops || !uid) return null;
  const ordered = stops.some(s => s && s.StopSequence > 0)
    ? stops.slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0))
    : stops;
  const idx = ordered.findIndex(s => s.StopUID === uid);
  if (idx < 0) return null;
  const here = lat != null && lon != null ? [+lat, +lon] : llOf(ordered[idx]);
  if (!here) return null;
  for (let i = idx + 1; i < ordered.length; i++) {
    const p = llOf(ordered[i]);
    if (!p || haversine(here[0], here[1], p[0], p[1]) < 1) continue;
    return bearingDeg(here[0], here[1], p[0], p[1]);
  }
  return null;
}
function headsFromList(list, routeUID, dirNum, stopUID, lat, lon) {
  let matchedBranch = null;
  let head = null;
  for (const r of list || []) {
    if (r.RouteUID !== routeUID || (r.Direction === 1 ? 1 : 0) !== dirNum) continue;
    const h = travelHead(r.Stops || [], stopUID, lat, lon);
    if (h != null) {
      head = h;
      matchedBranch = r;
      break;
    }
  }
  if (!matchedBranch) {
    for (const r of list || []) {
      if (r.RouteUID !== routeUID || (r.Direction === 1 ? 1 : 0) !== dirNum) continue;
      const stops = r.Stops || [];
      if (stops.some(s => s && s.StopUID === stopUID)) {
        matchedBranch = r;
        break;
      }
    }
  }
  if (!matchedBranch) return { head: null, destHead: null };

  const stops = matchedBranch.Stops || [];
  const ordered = stops.some(s => s && s.StopSequence > 0)
    ? stops.slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0))
    : stops;
  const idx = ordered.findIndex(s => s && s.StopUID === stopUID);
  if (idx < 0) return { head, destHead: null };

  const here = lat != null && lon != null ? [+lat, +lon] : llOf(ordered[idx]);
  if (!here) return { head, destHead: null };

  let destHead = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const p = llOf(ordered[i]);
    if (p) {
      if (i > idx && haversine(here[0], here[1], p[0], p[1]) >= 1) {
        destHead = bearingDeg(here[0], here[1], p[0], p[1]);
      }
      break;
    }
  }

  return { head, destHead };
}
function headFromList(list, routeUID, dirNum, stopUID, lat, lon) {
  return headsFromList(list, routeUID, dirNum, stopUID, lat, lon).head;
}
if (typeof window !== "undefined") {
  window.headsFromList = headsFromList;
  window.travelHead = travelHead;
}
const sorMem = new Map();
// v2.42.0：站序先問雲端（Worker 讀 KV 分片，不打 TDX）。雲端沒有這條路線或還沒建這個縣市，才退回 TDX。
// 回傳 { RouteUID: [各方向／支線站序] }，格式同 sorPack。
async function cloudSor(uids) {
  const want = [...new Set((uids || []).filter(Boolean))].slice(0, 60), out = {};
  for (let i = 0; i < want.length; i += 20) {
    try {
      const j = await authedGet("/bus/sor/route?uids=" + want.slice(i, i + 20).map(enc).join(","));
      for (const r of (j && j.list) || []) (out[r.RouteUID] = out[r.RouteUID] || []).push(r);
    } catch (e) { if (/登入|NO_PROXY/.test(String(e && e.message))) break; }
  }
  return out;
}
// v2.43.0：公車／公路客運時刻表（雲端 /bus/sch/route，資料格式見 Worker schPut 說明）。手機快取一天。
// 回傳 { routeUID, recs:[{ u, n, s, sn, d, st, p, tr, sp, f }], t }；recs 空的、或 need 有值＝雲端還沒有這條路線的時刻表
async function busSchedule({ routeUID, fresh }) {
  if (!routeUID) throw new Error("缺少路線代碼");
  const key = "sch|" + routeUID;
  // v2.44.1：雲端時刻表可能隨時更新（例如補上逐站時刻）：手機快取只用 10 分鐘，之後一律重抓；抓不到才退回手機存的那份
  const c = fresh ? null : await IDB.get(key).catch(() => null);
  if (c && Date.now() - c.t < 10 * 60000) return c.d;
  let j;
  try { j = await authedGet("/bus/sch/route?uid=" + enc(routeUID)); } catch (e) { if (c) return c.d; throw e; }
  const d = { routeUID, recs: (j && j.list) || [], t: j && j.t || null, need: j && j.need || null };
  if (!d.need) IDB.set(key, { t: Date.now(), d }).catch(() => {});
  return d;
}
// v2.43.0：管理者手動更新時刻表（進階設定）。整個縣市分頁抓 TDX（經 Worker 金鑰 2），在手機／瀏覽器精簡、gzip，
// 依 RouteUID 分片打包成一包上傳（POST /bus/sch/put）；Worker 只寫 KV，不解析。寫入計入每日額度，滿了會回 503。
const SCH_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function schMask(sd) { let m = 0; SCH_DAYS.forEach((d, i) => { if (sd && +sd[d] === 1) m |= 1 << i; }); return m; }
function schMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; }
function schPack(rec) {
  const zh = x => (x && x.Zh_tw) || "";
  const trips = rec.Timetables || [];
  const st = [], at = new Map();
  // 循環線同一站會出現兩次（起點＝終點）：用「站號＋第幾次出現」當鍵
  const keyed = t => { const n = new Map(); return (t.StopTimes || []).slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0)).map(s => { const c = (n.get(s.StopUID) || 0) + 1; n.set(s.StopUID, c); return [s.StopUID + "#" + c, s]; }); };
  const longest = trips.slice().sort((a, b) => (b.StopTimes || []).length - (a.StopTimes || []).length)[0];
  const addStop = (k, s) => { if (s.StopUID && !at.has(k)) { at.set(k, st.length); st.push([s.StopUID, zh(s.StopName)]); } };
  if (longest) for (const [k, s] of keyed(longest)) addStop(k, s);
  for (const t of trips) for (const [k, s] of keyed(t)) addStop(k, s);
  const p = [], pi = new Map(), sp = [], spi = new Map(), tr = [];
  for (const t of trips) {
    const times = new Array(st.length).fill(null);
    for (const [k, s] of keyed(t)) { const i = at.get(k); if (i == null) continue; const m = schMin(s.DepartureTime) ?? schMin(s.ArrivalTime); if (m != null) times[i] = m; }
    let first = times.findIndex(x => x != null);
    if (first < 0) continue;
    let base = times[first];
    // 跨午夜：後面的站時間變小就加一天
    let prev = base;
    for (let i = first + 1; i < times.length; i++) if (times[i] != null) { while (times[i] < prev - 60) times[i] += 1440; prev = times[i]; }
    const pat = times.map(x => (x == null ? -1 : x - base));
    while (pat.length && pat[pat.length - 1] === -1) pat.pop();
    const pk = pat.join(",");
    if (!pi.has(pk)) { pi.set(pk, p.length); p.push(pat); }
    let s = -1;
    if (t.SpecialDays && t.SpecialDays.length) {
      for (const d of t.SpecialDays) {
        const e = [+(d.ServiceStatus || 0) ? 1 : 0, (d.Description || "").slice(0, 30), (d.Dates || []).map(x => x.replace(/-/g, "")).join(","),
          d.DatePeriod ? `${(d.DatePeriod.StartDate || "").replace(/-/g, "")}~${(d.DatePeriod.EndDate || "").replace(/-/g, "")}` : ""];
        const k = e.join("|");
        if (!spi.has(k)) { spi.set(k, sp.length); sp.push(e); }
      }
      // 一個班次可能有多筆特殊日：用 "a.b.c" 串起來
      s = t.SpecialDays.map(d => spi.get([+(d.ServiceStatus || 0) ? 1 : 0, (d.Description || "").slice(0, 30), (d.Dates || []).map(x => x.replace(/-/g, "")).join(","),
        d.DatePeriod ? `${(d.DatePeriod.StartDate || "").replace(/-/g, "")}~${(d.DatePeriod.EndDate || "").replace(/-/g, "")}` : ""].join("|"))).join(".");
    }
    tr.push([schMask(t.ServiceDay), base, pi.get(pk), s, t.IsLowFloor ? 1 : 0]);
  }
  tr.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const f = (rec.Frequencys || []).map(q => [schMask(q.ServiceDay), schMin(q.StartTime), schMin(q.EndTime), q.MinHeadwayMins ?? null, q.MaxHeadwayMins ?? null]).filter(x => x[1] != null);
  const out = { u: rec.RouteUID, n: zh(rec.RouteName), s: rec.SubRouteUID || "", sn: zh(rec.SubRouteName), d: rec.Direction === 1 ? 1 : rec.Direction === 2 ? 2 : 0, v: rec.VersionID ?? null };
  if (st.length) out.st = st;
  if (p.length) out.p = p;
  if (tr.length) out.tr = tr;
  if (sp.length) out.sp = sp;
  if (f.length) out.f = f;
  return out;
}
const SCH_N = uid => { let h = 0; for (const ch of String(uid)) h = h * 31 + ch.charCodeAt(0) >>> 0; return h; };
const gzBytes = async s => new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
// v2.44.0：高雄市公車在 TDX 沒有班表（Schedule 全空），只有「每日站別時刻表」（DailyStopTimeTable，各站一整天的時刻，拼不回整班車），
// 而且停在 2026-08-22 沒再更新。管理頁打開時查一次它的日期（1 次 TDX 呼叫），恢復每天更新後再做匯入。
async function khhSchDate() {
  const l = await tdx("route", `${BASE}/basic/v2/Bus/DailyStopTimeTable/City/Kaohsiung?%24select=BusDate&%24top=1&%24format=JSON`);
  return { busDate: ((l && l[0] && l[0].BusDate) || "").slice(0, 10) || null };
}
async function schBuild({ city, onProgress }) {
  if (!city) throw new Error("缺少縣市");
  const proxy = getProxy(), sess = getSession(); if (!proxy) throw new Error("NO_PROXY"); if (!sess) throw new Error("請重新登入");
  const path = city === "InterCity" ? "InterCity" : "City/" + city, top = 20, recs = [];
  let raw = 0, trips = 0;
  for (let skip = 0, page = 0; page < 1000; page++, skip += top) {
    const l = await tdx("route", `${BASE}/basic/v2/Bus/Schedule/${path}?%24top=${top}&%24skip=${skip}&%24format=JSON`);
    if (!Array.isArray(l)) throw new Error("TDX 回傳格式不對");
    for (const r of l) { raw += JSON.stringify(r).length; const c = schPack(r); trips += (c.tr || []).length; recs.push(c); }
    if (onProgress) try { onProgress({ city, page: page + 1, recs: recs.length }); } catch (e) {}
    if (l.length < top) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!recs.length) throw new Error("TDX 沒有這個縣市的時刻表");
  const size = recs.reduce((a, r) => a + JSON.stringify(r).length, 0);
  const n = Math.max(1, Math.min(64, Math.ceil(size / 600000)));
  const sh = Array.from({ length: n }, () => []);
  for (const r of recs) sh[SCH_N(r.u) % n].push(r);
  const t = Date.now(), parts = [];
  for (let k = 0; k < n; k++) parts.push(await gzBytes(JSON.stringify({ v: 1, c: city, k, t, r: sh[k] })));
  const routes = new Set(recs.map(r => r.u)).size;
  const head = new TextEncoder().encode(JSON.stringify({ n, parts: parts.map(b => b.length), routes, recs: recs.length, trips, raw, ver: Math.max(0, ...recs.map(r => +r.v || 0)) || null }));
  const body = new Uint8Array(4 + head.length + parts.reduce((a, b) => a + b.length, 0));
  body.set([head.length >>> 24 & 255, head.length >>> 16 & 255, head.length >>> 8 & 255, head.length & 255], 0); body.set(head, 4);
  let off = 4 + head.length; for (const b of parts) { body.set(b, off); off += b.length; }
  if (onProgress) try { onProgress({ city, uploading: true, recs: recs.length }); } catch (e) {}
  const r = await fetch(proxy + "/bus/sch/put?c=" + enc(city), { method: "POST", headers: { "x-session": sess.token, "content-type": "application/octet-stream" }, body });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.message) || ("錯誤 " + r.status));
  return { ...j, packed: size };
}
// v2.42.1：路線頁發現「即時到站有、站序裡沒有」的站，回報雲端；Worker 核對後自動重建該縣市站序。每條路線每次開 App 只報一次。
const sorReported = new Set();
function reportSor(routeUID, sor, etas) {
  if (!routeUID || sorReported.has(routeUID)) return;
  const have = new Set(); for (const r of sor || []) if (r.RouteUID === routeUID) for (const x of r.Stops || []) have.add(x.StopUID);
  const miss = new Map();
  for (const t of etas || []) if (t.RouteUID === routeUID && t.StopUID && !have.has(t.StopUID)) miss.set(t.StopUID, (t.StopName && t.StopName.Zh_tw) || "");
  if (!miss.size) return;
  sorReported.add(routeUID);
  const proxy = getProxy(), s = getSession(); if (!proxy || !s) return;
  const r = have.size ? [...miss].slice(0, 20).map(([u, n]) => [routeUID, u, n]) : [[routeUID, "", ""]];
  fetch(proxy + "/bus/sor/report", { method: "POST", headers: { "content-type": "application/json", "x-session": s.token }, body: JSON.stringify({ r }) }).catch(() => {});
}
async function loadTravelHead(jobs) {
  const heads = {}, dests = {};
  const want = new Map();
  for (const j of jobs) {
    const k = routeKind(j.routeUID);
    if (!k || !j.stopUID || !j.routeUID) continue;
    if (!want.has(j.routeUID)) want.set(j.routeUID, { path: k.path, route: j.route || "", jobs: [] });
    const info = want.get(j.routeUID);
    if (!info.route && j.route) info.route = j.route;
    info.jobs.push(j);
  }
  const miss = [];
  await Promise.all([...want.values()].map(async info => {
    const sk = info.route && info.route !== "?" ? `sor|${info.path}|${info.route}` : "";
    let list = sorMem.get("uid|" + info.jobs[0].routeUID);
    if (!list && sk) {
      list = sorMem.get(sk);
      if (list === undefined) {
        const sc = await IDB.get(sk).catch(() => null);
        list = sc && sc.d ? sc.d : null;
        if (list) sorMem.set(sk, list);
      }
    }
    let hit = 0;
    for (const j of info.jobs) {
      const res = list ? headsFromList(list, j.routeUID, j.dirNum, j.stopUID, j.lat, j.lon) : null;
      if (res) {
        const hk = `${j.routeUID}|${j.dirNum}|${j.stopUID}`;
        if (res.head != null) { heads[hk] = res.head; hit++; }
        if (res.destHead != null) dests[hk] = res.destHead;
      }
    }
    if (hit < info.jobs.length) miss.push(info);
  }));
  const cloud = miss.length ? await cloudSor(miss.map(info => info.jobs[0].routeUID)).catch(() => ({})) : {};
  for (const [uid, rs] of Object.entries(cloud)) {
    sorMem.set("uid|" + uid, rs);
    const info = miss.find(x => x.jobs[0].routeUID === uid), nm = (rs[0].RouteName && rs[0].RouteName.Zh_tw) || (info && info.route) || "";
    if (info && nm && nm !== "?") { const key = `sor|${info.path}|${nm}`; sorMem.set(key, rs); IDB.set(key, { t: Date.now(), d: rs, src: "kv" }).catch(() => {}); }
  }
  for (const info of miss) for (const j of info.jobs) {
    const hk = `${j.routeUID}|${j.dirNum}|${j.stopUID}`;
    if (heads[hk] != null) continue;
    const list = sorMem.get("uid|" + j.routeUID) || (info.route ? sorMem.get(`sor|${info.path}|${info.route}`) : null);
    const res = list ? headsFromList(list, j.routeUID, j.dirNum, j.stopUID, j.lat, j.lon) : null;
    if (res) {
      if (res.head != null) heads[hk] = res.head;
      if (res.destHead != null) dests[hk] = res.destHead;
    }
  }
  return { heads, dests };
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
let pendingRelocLoc = null;
function getPos(high, timeout) {   // v2.37.2：iOS 有時不理 timeout、永遠不回應 → 自己加一道計時，逾時當作失敗
  return new Promise((res, rej) => {
    const tm = setTimeout(() => rej({ code: 3, message: "timeout" }), timeout + 1500);
    navigator.geolocation.getCurrentPosition(p => { clearTimeout(tm); res(p); }, e => { clearTimeout(tm); rej(e); },
      { enableHighAccuracy: high, timeout, maximumAge: high ? 10000 : 30000 });
  });
}
let locBootDone = false;   // Opus：快速定位（上次位置、低精度）只用在開 app 後的第一次；之後的定時、手動更新照 v2.49.22 等精確定位，走路時位置才不會停住
async function locateSlow() {
  if (pendingRelocLoc) {
    const loc = pendingRelocLoc;
    pendingRelocLoc = null;
    return loc;
  }
  let p;
  try { p = await getPos(true, 7000); }
  catch (e) {
    if (e && e.code === 1) { if (lastLoc) return lastLoc; throw new Error("沒有定位權限：到 iPhone 設定 › 隱私權與安全性 › 定位服務 › Safari 網站，改成「使用 App 期間」並開啟「精確位置」"); }
    try { p = await getPos(false, 10000); }
    catch (e2) { if (lastLoc) return lastLoc; throw new Error("無法取得定位，請稍後再試"); }
  }
  lastLoc = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0), t: p.timestamp || Date.now() };
  try { localStorage.setItem("jisu_last_loc", JSON.stringify(lastLoc)); } catch (e) {}
  return lastLoc;
}
async function locate(fresh = false) {
  if (!navigator.geolocation) { if (lastLoc) return lastLoc; throw new Error("這個瀏覽器不支援定位"); }
  if (pendingRelocLoc) {
    const loc = pendingRelocLoc;
    pendingRelocLoc = null;
    return loc;
  }
  if (locBootDone) return locateSlow();
  locBootDone = true;

  // 1. 先看 localStorage 裡上次的位置（v2.49.27：開 App 第一次直接用，不限 2 分鐘）
  let saved = null;
  if (!fresh) {
    try {
      const raw = localStorage.getItem("jisu_last_loc");
      if (raw) {
        const parsed = JSON.parse(raw);
        const isStaleMock = typeof window !== "undefined" && window.mockLoc &&
          (Math.abs(parsed.latitude - window.mockLoc.latitude) > 0.001 || Math.abs(parsed.longitude - window.mockLoc.longitude) > 0.001);
        if (!isStaleMock && parsed && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
          saved = parsed;
        }
      }
    } catch (e) {}
  }

  const tStart = performance.now();

  // 2. 低精度定位（enableHighAccuracy:false、maximumAge:120000、逾時約 1.5 秒）
  const lowPromise = new Promise((res, rej) => {
    let done = false;
    const tm = setTimeout(() => { if (!done) { done = true; rej(new Error("low-loc-timeout")); } }, 1500);
    navigator.geolocation.getCurrentPosition(
      p => {
        if (!done) {
          done = true;
          clearTimeout(tm);
          const dur = performance.now() - tStart;
          if (typeof window !== "undefined" && window.BOOT_PERF) window.BOOT_PERF.locLow = Math.round(dur);
          res({
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: Math.round(p.coords.accuracy || 0),
            t: p.timestamp || Date.now()
          });
        }
      },
      e => {
        if (!done) {
          done = true;
          clearTimeout(tm);
          rej(e);
        }
      },
      { enableHighAccuracy: false, timeout: 1500, maximumAge: 120000 }
    );
  });

  // 3. 高精度定位同時進行，逾時縮短到約 3 秒
  const highPromise = new Promise((res, rej) => {
    let done = false;
    const tm = setTimeout(() => { if (!done) { done = true; rej(new Error("high-loc-timeout")); } }, 3000);
    navigator.geolocation.getCurrentPosition(
      p => {
        if (!done) {
          done = true;
          clearTimeout(tm);
          const dur = performance.now() - tStart;
          if (typeof window !== "undefined" && window.BOOT_PERF) window.BOOT_PERF.locHigh = Math.round(dur);
          res({
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: Math.round(p.coords.accuracy || 0),
            t: p.timestamp || Date.now()
          });
        }
      },
      e => {
        if (!done) {
          done = true;
          clearTimeout(tm);
          rej(e);
        }
      },
      { enableHighAccuracy: true, timeout: 3000, maximumAge: 10000 }
    );
  });

  // 背景定位：新位置離剛剛查的位置超過 100 公尺才重查一次附近
  let usedLoc = saved || null;
  const onBgLoc = newLoc => {
    if (!newLoc || !Number.isFinite(newLoc.latitude) || !Number.isFinite(newLoc.longitude)) return;
    try { localStorage.setItem("jisu_last_loc", JSON.stringify(newLoc)); } catch (e) {}
    if (usedLoc && usedLoc !== newLoc) {
      const moved = haversine(usedLoc.latitude, usedLoc.longitude, newLoc.latitude, newLoc.longitude);
      if (moved > 100) {
        usedLoc = newLoc;
        lastLoc = newLoc;
        pendingRelocLoc = newLoc;
        if (typeof window !== "undefined") {
          if (typeof window.refreshRelocate === "function") window.refreshRelocate();   // Opus：載入中會排隊，不會被吃掉
          else if (typeof window.refresh === "function") window.refresh();
        }
      }
    }
    lastLoc = newLoc;
  };

  highPromise.then(onBgLoc, () => lowPromise.then(onBgLoc)).catch(() => {});
  lowPromise.then(onBgLoc).catch(() => {});

  if (saved) {
    lastLoc = usedLoc = saved;
    if (typeof window !== "undefined" && window.BOOT_PERF) {
      window.BOOT_PERF.locType = "cache";
    }
    if (typeof window !== "undefined") {
      window.__jisuLocating = false;
      window.__jisuLocTime = performance.now();
    }
    return lastLoc;
  }

  // 沒有存過位置時：等定位
  if (typeof window !== "undefined") {
    window.__jisuLocating = true;
    if (typeof window.renderStatus === "function") window.renderStatus();
  }

  try {
    const loc = await Promise.race([lowPromise, highPromise]);
    lastLoc = usedLoc = loc;
    if (typeof window !== "undefined") {
      window.__jisuLocating = false;
      window.__jisuLocTime = performance.now();
      if (typeof window.renderStatus === "function") window.renderStatus();
    }
    try { localStorage.setItem("jisu_last_loc", JSON.stringify(lastLoc)); } catch (e) {}
    return lastLoc;
  } catch (e1) {
    if (e1 && e1.code === 1) {
      if (typeof window !== "undefined") {
        window.__jisuLocating = false;
        if (typeof window.renderStatus === "function") window.renderStatus();
      }
      if (lastLoc) return lastLoc;
      throw new Error("沒有定位權限：到 iPhone 設定 › 隱私權與安全性 › 定位服務 › Safari 網站，改成「使用 App 期間」並開啟「精確位置」");
    }
    try {
      const loc = await highPromise;
      lastLoc = usedLoc = loc;
      if (typeof window !== "undefined") {
        window.__jisuLocating = false;
        window.__jisuLocTime = performance.now();
        if (typeof window.renderStatus === "function") window.renderStatus();
      }
      try { localStorage.setItem("jisu_last_loc", JSON.stringify(lastLoc)); } catch (e) {}
      return lastLoc;
    } catch (e2) {
      if (typeof window !== "undefined") {
        window.__jisuLocating = false;
        if (typeof window.renderStatus === "function") window.renderStatus();
      }
      if (lastLoc) return lastLoc;
      throw new Error("無法取得定位，請稍後再試");
    }
  }
}
// v2.33.0：路線規劃的「目前位置」（首頁附近資料的定位照舊用 locate()）：2分鐘內、誤差100公尺以內的位置直接用；
// 沒有就先試快速定位（可用2分鐘內的系統定位），夠準就用；不夠準或失敗才照 locate() 等 GPS 精確定位
let planLoc = null;
async function locatePlan() {
  const ok = l => l && l.t && Date.now() - l.t <= 120000 && l.accuracy > 0 && l.accuracy <= 100;
  if (ok(lastLoc)) return lastLoc;
  if (ok(planLoc)) return planLoc;
  if (!navigator.geolocation) return locate();
  let low = null;
  try {
    const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 4000, maximumAge: 120000 }));
    low = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0), t: p.timestamp || Date.now() };
    if (ok(low)) return planLoc = low;
  } catch (e) { if (e && e.code === 1) return locate(); }   // 沒有權限：照 locate() 的錯誤訊息
  try { const l = await locate(); return l; } catch (e) { if (low) return low; throw e; }
}

// ---------- 終點站快取（沿用原腳本格式） ----------
function readDestCache() {
  try { const c = JSON.parse(localStorage.getItem(DEST_KEY)); if (c && c.routes) return c; } catch (e) {}
  return { routes: {} };
}
// 永久保存（v2.12.6）；沒有的先從已下載的全台路線清單（busidx）找，再讀 Worker 的 br: 索引；絕不回退 TDX。
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
    for (const u of missing) { const k = routeKind(u); if (k) (groups[k.kind === "intercity" ? "InterCity" : k.city] = groups[k.kind === "intercity" ? "InterCity" : k.city] || []).push(u); }
    await Promise.all(Object.entries(groups).map(async ([city, list]) => {
      try {
        const rows = await authedGet("/bus/routes?c=" + enc(city));
        const wanted = new Set(list);
        for (const r of Array.isArray(rows) ? rows : []) if (wanted.has(r[0])) cache.routes[r[0]] = { time: now, dep: r[2] || null, dest: r[3] || null };
      } catch (e) {}
    }));
  }
  if (uids.some(u => u && cache.routes[u] && cache.routes[u].time === now)) { try { localStorage.setItem(DEST_KEY, JSON.stringify(cache)); } catch (e) {} }
  return cache.routes;
}
// 單向路線（如連江 LIE19 只有 Direction 1，依 TDX 慣例會被寫成「往起點」）：改用站序最後一站當「往」，頭尾同站（環狀）就不改
function oneWayDest(dest, dirs, dirNum, stops) {
  if (!dirs || dirs.length !== 1 || !stops || stops.length < 2) return dest;
  const nm = s => (s && s.StopName && s.StopName.Zh_tw) || "", a = nm(stops[0]), z = nm(stops[stops.length - 1]);
  return z && z !== a ? { ...dest, [dirNum]: z } : dest;
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
    setTimeout(() => res(null), 3000);   // v2.37.2：iOS 偶爾 indexedDB.open 永遠不回應 → 3 秒後先不用手機資料庫
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
      const late = ms => new Promise((_, no) => setTimeout(() => no(new Error("idb timeout")), ms));   // v2.37.2：iOS 資料庫卡住時不要整個停住
      const db = await Promise.race([open(), late(4000)]).catch(() => null); if (!db) return mem.get(k) || null;
      try {
        const t = db.transaction(["kv", "meta"], "readonly");
        const [v, m] = await Promise.race([Promise.all([rq(t.objectStore("kv").get(k)), rq(t.objectStore("meta").get(k))]), late(3000)]);
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
    async del(k) {
      mem.delete(k);
      const db = await open(); if (!db) return;
      try { const t = db.transaction(["kv", "meta"], "readwrite"); t.objectStore("kv").delete(k); t.objectStore("meta").delete(k); await done(t); } catch (e) {}
    },
    async keys(prefix = "") {
      const db = await open();
      if (!db) return [...mem.keys()].filter(k => typeof k === "string" && k.startsWith(prefix));
      try {
        const t = db.transaction(["kv"], "readonly");
        const allKeys = await rq(t.objectStore("kv").getAllKeys());
        return allKeys.filter(k => typeof k === "string" && k.startsWith(prefix));
      } catch (e) {
        return [...mem.keys()].filter(k => typeof k === "string" && k.startsWith(prefix));
      }
    },
    open,
  };
})();
IDB.open();
if (typeof window !== "undefined") window.IDB = IDB;
const stopPack = s => [s.StopUID || "", (s.StopName && s.StopName.Zh_tw) || "", s.StopPosition ? s.StopPosition.PositionLat : null, s.StopPosition ? s.StopPosition.PositionLon : null, s.StationID || "", s.Bearing || ""];
const stopUnpack = a => ({ StopUID: a[0] || null, StopName: { Zh_tw: a[1] }, StopPosition: a[2] == null ? null : { PositionLat: a[2], PositionLon: a[3] }, StationID: a[4] || null, Bearing: a[5] || null });
const bikePack = s => [s.StationUID, (s.StationName && s.StationName.Zh_tw) || "", (s.StationAddress && s.StationAddress.Zh_tw) || "", s.BikesCapacity ?? null, s.ServiceType ?? null, s.StationPosition ? s.StationPosition.PositionLat : null, s.StationPosition ? s.StationPosition.PositionLon : null];
const bikeUnpack = a => ({ StationUID: a[0], StationName: { Zh_tw: a[1] }, StationAddress: { Zh_tw: a[2] || null }, BikesCapacity: a[3], ServiceType: a[4], StationPosition: a[5] == null ? null : { PositionLat: a[5], PositionLon: a[6] } });
// 取得格子裡的靜態清單；即時資料出現清單裡沒有的代號才重抓（站牌異動時自動修正）
async function geoList(kind, key, url, profile, pack, unpack, liveUIDs) {
  let c = await IDB.get("geo|" + key);
  if (kind === "stop" && (!c || oldCloud(c))) c = (await cloudStops(key).catch(() => null)) || c;
  const fresh = async heal => {
    if (kind === "stop") {
      const v = await cloudStops(key).catch(() => null);
      return v && Array.isArray(v.d) ? v.d.map(unpack) : [];
    }
    const l = await tdx(profile, url + (heal ? FRESH : "")); IDB.set("geo|" + key, { t: Date.now(), d: l.map(pack) }).catch(() => {}); return l;
  };
  if (!c) return fresh(false);
  const list = c.d.map(unpack);
  if (liveUIDs) {
    const have = new Set(list.map(x => x.StopUID || x.StationUID));
    if ((await liveUIDs).some(u => u && !have.has(u))) return fresh(true).catch(() => list);
  }
  return list;
}

// ---------- 附近：公車 + YouBike + 收藏 ----------
const BEAR_TXT = { N: "向北", S: "向南", E: "向東", W: "向西", NE: "向東北", NW: "向西北", SE: "向東南", SW: "向西南" };
async function nearby({ settings = {}, favs = { bus: [], bike: [] }, only = null, fresh = false, onEarly = null, onBusEarly = null, auto = false }) {
  // v2.26.0：only＝'bus'／'bike'／'rail' 只更新那一部分（公車、YouBike、軌道分頁的下拉更新），其他部分不呼叫
  const doBus = !only || only === "bus", doBike = !only || only === "bike", doRail = !only || only === "rail";
  const SKIP = Promise.reject(new Error("skip")); SKIP.catch(() => {});
  if (!only || only !== "rail") odWarm(only === "bike" ? "ybTPE,ybNWT" : only === "bus" ? (fresh ? "eta" : "eta,nwt") : (fresh ? "eta,ybTPE,ybNWT" : null));   // v2.36.3：定位的同時請 Worker 先抓開放資料
  const loc = await locate(fresh);
  // 查詢座標取到小數第3位（約100公尺格子），半徑多加100公尺補足，之後再用實際位置過濾 → 同一格的請求可共用快取
  const lat = loc.latitude.toFixed(3), lon = loc.longitude.toFixed(3);
  const busR = clampR(settings.busR || 300), bikeR = clampR(settings.bikeR || 500);
  const qBus = Math.min(busR + 100, 1000), qStop = Math.min(busR + 200, 1000), qBike = Math.min(bikeR + 100, 1000);

  // v2.36.3：收藏的公車、YouBike 分開查，YouBike 慢不拖住公車
  const favBusP = doBus && (favs.bus || []).length ? liveFavs({ bus: favs.bus, bike: [] }, fresh).catch(() => ({ bus: {}, bike: {} })) : Promise.resolve({ bus: {}, bike: {} });
  const favBikeP = doBike && (favs.bike || []).length ? liveFavs({ bus: [], bike: favs.bike }, fresh).catch(() => ({ bus: {}, bike: {} })) : Promise.resolve({ bus: {}, bike: {} });
  const railP = !doRail ? SKIP : Promise.all([loadRailStations(), loadRailExits().catch(() => ({}))])
    .then(([st, ex]) => nearestRail(st, loc.latitude, loc.longitude,
      { walkKm: settings.railWalk || 1.5, systems: settings.railSys || null, far: { TRA: (settings.railFarTra ?? settings.railFar ?? 1) !== 0, THSR: (settings.railFarThsr ?? settings.railFar ?? 1) !== 0 } }, ex));

  // v2.49.27 補充：站名不等 /od/eta，三階段更新畫面
  // Opus：提早階段只拿已經完成的收藏、軌道結果，沒完成就先不等（最後的完整結果照舊會有）
  const doneV = new Map();
  for (const p of [favBusP, railP]) p.then(v => doneV.set(p, v), () => {});
  const settledOr = async (p, dflt) => (doneV.has(p) ? doneV.get(p) : dflt);
  let stage1Emitted = false;
  const handleStopsEarly = async (stage1Near) => {
    if (!onBusEarly) return;
    if (stage1Emitted) return;
    stage1Emitted = true;
    try {
      const sorted = [...stage1Near].sort((a, b) => {
        const da = haversine(loc.latitude, loc.longitude, a.StopPosition.PositionLat, a.StopPosition.PositionLon);
        const db = haversine(loc.latitude, loc.longitude, b.StopPosition.PositionLat, b.StopPosition.PositionLon);
        return da - db;
      });
      const seen = new Set();
      const stage1BusStops = [];
      for (const s of sorted) {
        const name = (s.StopName && s.StopName.Zh_tw) || "未知站牌";
        if (seen.has(name)) continue;
        seen.add(name);
        const d = haversine(loc.latitude, loc.longitude, s.StopPosition.PositionLat, s.StopPosition.PositionLon);
        stage1BusStops.push({
          name,
          dist: Math.round(d),
          lat: s.StopPosition.PositionLat,
          lon: s.StopPosition.PositionLon,
          sid: s.StationID || null,
          bear: s.Bearing || null,
          routes: [],
          loading: true,
          busPending: true
        });
        if (stage1BusStops.length >= 6) break;
      }
      const earlyFavBus = await settledOr(favBusP, { bus: {}, bike: {} });   // Opus：收藏、軌道還沒好就先不等
      const earlyRail = await settledOr(railP, []);
      const earlyObj = {
        lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy || null,
        busStops: stage1BusStops, bikes: [], bikePending: true,
        only, rail: Array.isArray(earlyRail) ? earlyRail : [],
        railError: null, busError: null,
        noLiveWhy: null,
        liveOk: true,
        stage: "stops",
        favs: { bus: (earlyFavBus && earlyFavBus.bus) || {}, bike: {} }
      };
      if (onBusEarly) onBusEarly(earlyObj);   // Opus：不退到 onEarly（定時更新不給 onBusEarly，就不走提早階段）
    } catch (e) {}
  };

  const handleEarlyBus = async (earlyRows, earlyStops) => {
    if (!onBusEarly) return;
    try {
      const earlyBusR = { status: "fulfilled", value: [earlyRows, earlyStops] };
      const earlyBusStops = await busGroup(earlyBusR);
      const earlyFavBus = await settledOr(favBusP, { bus: {}, bike: {} });   // Opus：收藏、軌道還沒好就先不等
      const earlyRail = await settledOr(railP, []);
      const earlyObj = {
        lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy || null,
        busStops: earlyBusStops, bikes: [], bikePending: true,
        only, rail: Array.isArray(earlyRail) ? earlyRail : [],
        railError: null, busError: null,
        noLiveWhy: earlyRows.noLiveWhy || null,
        liveOk: earlyRows.liveOk,
        stage: "eta",
        favs: { bus: (earlyFavBus && earlyFavBus.bus) || {}, bike: {} }
      };
      if (onBusEarly) onBusEarly(earlyObj);   // Opus：不退到 onEarly（定時更新不給 onBusEarly，就不走提早階段）
    } catch (e) {}
  };

  const etaP = doBus ? busNearEta(lat, lon, qBus, "main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat, lon, qBus)}&%24top=600&%24format=JSON`, `s|${lat},${lon},${qStop}`, fresh, { auto: !!auto, onStopsEarly: handleStopsEarly, onEarlyRows: handleEarlyBus }) : SKIP;
  const isThbStop = s => /^THB/.test((s && s.StopUID) || "");
  const busP = !doBus ? SKIP : (async () => {
    const [eta, cs, thb] = await Promise.all([
      etaP,
      cloudStops(`s|${lat},${lon},${qStop}`).catch(() => null),
      odMemoGet(`/od/thbstn?lat=${lat}&lon=${lon}&r=${qStop}`, fresh ? 0 : 6 * 3600000).catch(() => null)
    ]);
    let city = cs && Array.isArray(cs.d) ? cs.d.map(stopUnpack).filter(s => s.StopPosition && !isThbStop(s)) : [];
    if (!city.length) {
      const cached = await IDB.get("geo|" + `s|${lat},${lon},${qStop}`).catch(() => null);
      if (cached && Array.isArray(cached.d)) city = cached.d.map(stopUnpack).filter(s => s.StopPosition && !isThbStop(s));
      else if (cs && cs.cov === 0 && eta) {
        eta.noLiveWhy = "雲端還沒有這一區的站牌清單，暫無免 TDX 的站牌與到站資料";
      }
    }
    if (cs && (cs.cov === 1 || cs.src === "od")) {
      const have = new Set(city.map(s => s.StopUID)), miss = new Map();
      for (const e of eta || []) if (e.StopUID && !isThbStop(e) && !have.has(e.StopUID)) miss.set(e.StopUID, [e.RouteUID || "", e.StopUID, (e.StopName && e.StopName.Zh_tw) || ""]);
      if (miss.size) {
        const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), rk = `jisu_sor_near_report|${lat},${lon},${qStop}`;
        IDB.del(`geo|s|${lat},${lon},${qStop}`).catch(() => {});
        const rows = [...miss.values()].filter(x => x[0]).slice(0, 20), proxy = getProxy(), session = getSession();
        try {
          if (rows.length && proxy && session && localStorage.getItem(rk) !== day) {
            localStorage.setItem(rk, day);
            fetch(proxy + "/bus/sor/report", { method: "POST", headers: { "content-type": "application/json", "x-session": session.token }, body: JSON.stringify({ r: rows }) }).catch(() => {});
          }
        } catch (e) {}
      }
    }
    // /od/stops 與 /od/thbstn 是手機端附近站牌唯一的靜態來源；雲端不完整時安靜略過。
    const hw = thb && Array.isArray(thb.list) ? thb.list : [];
    return [eta, [...city, ...hw]];
  })();
  // /od/ybstn 只提供靜態站點；全台 YouBike 即時車位一律先取官網 feed。
  const bkKey = `b|${lat},${lon},${qBike}`;
  const bikeP = !doBike ? SKIP : (async () => {
    // 雲端站點尚未就緒（503 fallback:tdx）或讀取失敗時，不把空清單寫進永久快取。
    let list = [], cloudOK = false;
    try {
      const j = await odMemoGet(`/od/ybstn?lat=${lat}&lon=${lon}&r=${qBike}`, fresh ? 0 : 6 * 3600000);
      if (Array.isArray(j.list)) { list = j.list.map(withoutBikeLive); cloudOK = true; }
    } catch (e) {
      const old = await IDB.get("geo|" + bkKey).catch(() => null);
      if (old && Array.isArray(old.d)) list = old.d.map(bikeUnpack);
      // 雙北的市府即時 API 也可依位置給附近站點，作為沒有舊清單時的備援。
      if (!list.length && inNorth(+lat, +lon)) try {
        const od = await odMemoGet(`/od/bike?lat=${lat}&lon=${lon}&r=${qBike}${fresh ? "&fresh=1" : ""}`, fresh ? 0 : 90000);
        if (Array.isArray(od.list)) list = od.list.map(withoutBikeLive);
      } catch (e) {}
    }
    if (cloudOK && list.length) IDB.set("geo|" + bkKey, { t: Date.now(), d: list.map(bikePack) }).catch(() => {});
    const odLive = async ids => {
      const od = await odMemoGet(`/od/bike?ids=${ids.join(",")}${fresh ? "&fresh=1" : ""}`, fresh ? 0 : 90000);
      const am = {}; for (const a of od.list || []) am[a.StationUID] = a;
      return am;
    };
    let feed = null;
    try { feed = await youbikeFeed(fresh); if (cloudOK) ybMaybePush(list, ybFeedSnap && ybFeedSnap.list, +lat, +lon, qBike); } catch (e) {}
    let live = withYoubikeFeed(list, feed || {});
    // 官網沒有該雙北站、或官網失敗時，才以市府資料補缺；其他縣市附近清單原本沒有 TDX 即時查詢。
    const northMiss = list.filter(s => isOdBike(s.StationUID) && (!feed || !feed[s.StationUID])).map(s => s.StationUID);
    if (northMiss.length) try {
      const od = await odLive(northMiss);
      live = live.map(s => od[s.StationUID] ? { ...withoutBikeLive(s), ...od[s.StationUID], src: "od" } : s);
    } catch (e) {}
    return [list, live];
  })();

  const settle = p => p.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
  const bikeS = settle(bikeP);
  const [busR_, railR_, favBus] = await Promise.all([settle(busP), settle(railP), favBusP]);
  try {   // 全市搜尋名單的自動補救（只比對、不額外呼叫；發現新站才重抓）
    placeHeal(busR_.status === "fulfilled" ? busR_.value[0].filter(e => e.StopUID).map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw })) : [], []);
    if (busR_.status === "fulfilled") busHeal(busR_.value[0].map(e => e.RouteUID).filter(Boolean));          // 全台路線清單沒有的 RouteUID
    if (railR_.status === "fulfilled") exitHeal(railR_.value);                               // 附近捷運站沒有出口資料
  } catch (e) {}
  const busStops = await busGroup(busR_);
  // v2.36.3：YouBike 還沒好 → 先把公車、軌道交給畫面（onEarly），YouBike 好了再回完整結果
  let bikeR_ = null; bikeS.then(r => { bikeR_ = r; });
  await Promise.resolve(); await Promise.resolve();
  if (!bikeR_ && onEarly && doBike && !only && busR_.status === "fulfilled") {
    try { onEarly(finish({ status: "pending" }, { bus: favBus.bus, bike: {} })); } catch (e) {}
  }
  bikeR_ = await bikeS;
  const favBike = await favBikeP;
  if (!only && busR_.status === "rejected" && bikeR_.status === "rejected") throw busR_.reason;
  if (only) { const r = { bus: busR_, bike: bikeR_, rail: railR_ }[only]; if (r.status === "rejected") throw r.reason; }
  try { if (bikeR_.status === "fulfilled") placeHeal([], bikeR_.value[1].map(a => a.StationUID)); } catch (e) {}
  return finish(bikeR_, { bus: favBus.bus, bike: favBike.bike });

  async function busGroup(busR_) {
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
    const rawMap = new Map();
    for (const it of eta) {
      const name = (it.StopName && it.StopName.Zh_tw) || "未知站牌";
      const uid = it.StopUID || "";
      const pos = (uid && byUID[uid]) || (!uid && byName[name]) || null;
      if (pos && pos.d > busR) continue;
      const dirNum = it.Direction === 1 ? 1 : 0;
      const sec = typeof it.EstimateTime === "number" ? it.EstimateTime : null;
      const key = `${it.RouteUID || ""}|${dirNum}|${uid}`;
      const prev = rawMap.get(key);
      if (prev && !(sec !== null && (prev.r.sec === null || sec < prev.r.sec))) continue;
      const r = {
        route: (it.RouteName && it.RouteName.Zh_tw) || "?", routeUID: it.RouteUID || null, dirNum,
        stopUID: uid || null, sec, status: it.StopStatus ?? 0, next: it.NextBusTime || null,
        noLive: !!it.noLive, noRoutes: !!it.noRoutes,
        src: it.src || null,
      };
      rawMap.set(key, { name, uid, pos, r });
    }
    let raw = [...rawMap.values()];
    // /od/stops 未覆蓋的站牌，以雲端站序座標補距離；只查缺座標的路線一次。
    const missing = [...new Set(raw.filter(row => !row.pos && row.r.routeUID).map(row => row.r.routeUID))].slice(0, 60);
    const sor = {};
    const wantSor = [];
    for (const uid of missing) {
      const cached = sorMem.get("uid|" + uid);
      if (cached) sor[uid] = cached;
      else wantSor.push(uid);
    }
    const isFirstBoot = typeof window !== "undefined" && !window.__firstFrameRendered;

    if (!isFirstBoot && wantSor.length) {
      const got = await cloudSor(wantSor).catch(() => ({}));
      for (const [uid, rows] of Object.entries(got)) { sor[uid] = rows; sorMem.set("uid|" + uid, rows); }
    }
    for (const row of raw) if (!row.pos && row.r.routeUID && row.uid) {
      const seq = (sor[row.r.routeUID] || []).filter(x => (x.Direction === 1 ? 1 : 0) === row.r.dirNum);
      let hit = null;
      for (const route of seq) for (const stop of route.Stops || []) {
        if (stop.StopUID !== row.uid || !Array.isArray(stop.P)) continue;
        const [lat, lon] = stop.P;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const d = haversine(loc.latitude, loc.longitude, lat, lon);
        if (!hit || d < hit.d) hit = { d, lat, lon, sid: null, bear: null };
      }
      if (hit) row.pos = hit;
    }
    raw = raw.filter(row => !row.pos || row.pos.d <= busR);
    // v2.41.0：同名公車站分卡。分馬路兩側靠方向，不靠距離（實測同側可差 30 公尺、對側可只差 10 公尺）。
    // 1. 同一根站牌：同 StationID，沒有 StationID 時同座標（雙北座標只到小數 4 位，同一根站牌座標完全相同）。
    // 2. 方向：站牌的 Bearing（其他縣市 TDX 原生；雙北由雲端用站序算好）。沒有才用往下一站方位補。
    // 3. 兩根站牌都有方向：最接近的一對差 45 度以內、相距 60 公尺內才合併；相反或垂直就分開。
    //    有一邊沒有方向：10 公尺內才合併。用併查集，結果不受資料順序影響。
    const B8 = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
    const poleKey = row => row.pos ? (row.pos.sid ? "s" + row.pos.sid : `p${row.pos.lat},${row.pos.lon}`) : row.uid ? "u" + row.uid : "x";
    const polesOf = {};
    for (const row of raw) {
      const ps = polesOf[row.name] = polesOf[row.name] || new Map(), k = poleKey(row);
      if (!ps.has(k)) ps.set(k, { pos: row.pos, rows: [], dirs: [] });
      ps.get(k).rows.push(row);
    }
    const need = [];
    for (const row of raw) {
      if (row.r.routeUID && row.uid) need.push({ routeUID: row.r.routeUID, route: row.r.route, dirNum: row.r.dirNum, stopUID: row.uid, lat: row.pos ? row.pos.lat : null, lon: row.pos ? row.pos.lon : null });
    }
    let heads = {}, destHeads = {}, destMap = {};
    if (!isFirstBoot) {
      const [hR, dR] = await Promise.all([
        need.length ? loadTravelHead(need).catch(() => ({})) : {},
        loadRouteDest("main", raw.map(row => row.r.routeUID)).catch(() => ({})),
      ]);
      heads = (hR && hR.heads) || hR || {};
      destHeads = (hR && hR.dests) || {};
      destMap = dR || {};
    } else {
      setTimeout(async () => {
        try {
          if (wantSor.length) {
            const got = await cloudSor(wantSor).catch(() => ({}));
            for (const [uid, rows] of Object.entries(got)) { sor[uid] = rows; sorMem.set("uid|" + uid, rows); }
          }
          const [hR, dR] = await Promise.all([
            need.length ? loadTravelHead(need).catch(() => ({})) : {},
            loadRouteDest("main", raw.map(row => row.r.routeUID)).catch(() => ({})),
          ]);
          const newDestMap = dR || {};
          if (typeof window !== "undefined" && window.S && window.S.data && window.S.data.busStops) {
            for (const card of window.S.data.busStops) {
              for (const route of card.routes || []) {
                if (newDestMap[route.routeUID]) {
                  route.dest = destOf(route.routeUID, route.dirNum, newDestMap);
                }
              }
            }
            if (typeof window.render === "function") window.render();
          }
        } catch (e) {}
      }, 0);
    }
    const list = [], cardsOf = {};
    for (const [name, ps] of Object.entries(polesOf)) {
      const poles = [...ps.values()];
      for (const p of poles) {
        for (const row of p.rows) {
          const b = row.pos ? B8[row.pos.bear] : null;
          const h = b != null ? b : heads[`${row.r.routeUID}|${row.r.dirNum}|${row.uid}`];
          if (h != null) p.dirs.push(h);
        }
      }
      const up = poles.map((_, i) => i), find = i => (up[i] === i ? i : (up[i] = find(up[i])));
      for (let i = 0; i < poles.length; i++) for (let j = i + 1; j < poles.length; j++) {
        const a = poles[i], b = poles[j];
        if (!a.pos || !b.pos) continue;
        const d = haversine(a.pos.lat, a.pos.lon, b.pos.lat, b.pos.lon);
        let ok;
        if (a.dirs.length && b.dirs.length) {
          let m = 180;
          for (const x of a.dirs) for (const y of b.dirs) m = Math.min(m, angDiff(x, y));
          ok = m <= 45 && d <= 60;
        } else ok = d <= 10;
        if (ok) up[find(i)] = find(j);
      }
      const byRoot = new Map();
      for (let i = 0; i < poles.length; i++) {
        const k = find(i);
        if (!byRoot.has(k)) byRoot.set(k, []);
        byRoot.get(k).push(poles[i]);
      }
      const cards = cardsOf[name] = [];
      for (const ms of byRoot.values()) {
        const near = ms.filter(p => p.pos).sort((a, b) => a.pos.d - b.pos.d)[0] || null;
        const bc = {};   // 卡片顯示的方向：卡上各路線站牌 Bearing 最多的那個（同票取字母序），不受資料順序影響
        for (const p of ms) for (const row of p.rows) if (row.pos && B8[row.pos.bear] != null) bc[row.pos.bear] = (bc[row.pos.bear] || 0) + 1;
        const bear = Object.keys(bc).sort((x, y) => bc[y] - bc[x] || (x < y ? -1 : 1))[0] || null;
        const g = { name, dist: near ? near.pos.d : null, lat: near ? near.pos.lat : null, lon: near ? near.pos.lon : null, bear, dirs: ms.flatMap(p => p.dirs), routes: {} };
        for (const p of ms) for (const row of p.rows) {
          row.r.dest = destOf(row.r.routeUID, row.r.dirNum, destMap);
          row.r.head = heads[`${row.r.routeUID}|${row.r.dirNum}|${row.uid}`] ?? (row.pos && B8[row.pos.bear] != null ? B8[row.pos.bear] : null);
          row.r.destHead = destHeads[`${row.r.routeUID}|${row.r.dirNum}|${row.uid}`] ?? null;
          const rk = `${row.r.routeUID}|${row.r.dirNum}`;
          const old = g.routes[rk];
          if (!old || (row.r.sec !== null && (old.sec === null || row.r.sec < old.sec))) {
            if (old && row.r.destHead == null && old.destHead != null) row.r.destHead = old.destHead;
            g.routes[rk] = row.r;
          } else {
            if (old.destHead == null && row.r.destHead != null) old.destHead = row.r.destHead;
          }
        }
        cards.push(g); list.push(g);
      }
    }
    for (const arr of Object.values(cardsOf)) {
      // 「同向／對向」只在剛好兩張卡、而且方向相反（135 度以上）時標
      const located = arr.filter(g => g.lat != null).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
      if (arr.length === 2 && located.length === 2 && located[0].dirs.length && located[1].dirs.length) {
        let m = 180;
        for (const x of located[0].dirs) for (const y of located[1].dirs) m = Math.min(m, angDiff(x, y));
        if (m >= 135) { located[0].side = "同向"; located[1].side = "對向"; }
      }
      if (arr.length < 2) continue;
      for (const g of arr) {
        const rs = Object.values(g.routes);
        const dests = [...new Set(rs.map(r => r.dest).filter(Boolean))];
        const others = new Set(arr.filter(x => x !== g).flatMap(x => Object.values(x.routes).map(r => r.dest).filter(Boolean)));
        const uniq = dests.filter(d => !others.has(d));
        const show = (uniq.length ? uniq : dests).slice(0, 2);
        if (show.length) g.dirTxt = `往 ${show.join("／")}${dests.length > show.length ? " 等" : ""}`;
        else if (rs.length && rs.every(r => r.dirNum === rs[0].dirNum)) g.dirTxt = rs[0].dirNum === 1 ? "返程" : "去程";
      }
    }
    busStops = list.map(g => {
      const routes = Object.values(g.routes);
      const qRes = groupByRelativeQuadrant({ lat: g.lat, lon: g.lon }, routes);
      const destLines = qRes.lines;
      // 白點（公車行進方向）維持 v2.49.6 的取法：舊 45° 分組中第一個有方位的組的平均方位
      const legacyHead = (() => {
        const buckets = [routes.filter(r => r.dest), routes.filter(r => !r.dest && r.dirNum !== 1), routes.filter(r => !r.dest && r.dirNum === 1)];
        for (const rs of buckets) {
          let pool = rs.filter(r => r.head != null);
          if (!pool.length) continue;
          const lone = pool.filter(r => !pool.some(o => o !== r && angDiff(o.head, r.head) <= 45));
          pool = pool.filter(r => !lone.includes(r));
          if (pool.length) {
            let best = [];
            for (const seed of pool) { const hit = pool.filter(r => (r.head - seed.head + 360) % 360 <= 45); if (hit.length > best.length) best = hit; }
            return circMean(best.map(r => r.head));
          }
          return lone[0].head;
        }
        return null;
      })();
      g.destLines = destLines;
      g.destLine = destLines.map(x => x.destLine).join("\n");
      g.head = legacyHead;   // index.html stopTag 先用 s.head，所以白點方向和 v2.49.6 相同
      const { dirs, ...rest } = g;
      return { ...rest, bearTxt: BEAR_TXT[g.bear] || null, routes };
    }).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9) || String(a.dirTxt || "").localeCompare(String(b.dirTxt || ""), "zh-Hant"));
  }
  return busStops;
  }

  function finish(bikeR_, favLive) {
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
        src: a.src || null,
      });
    }
    bikes.sort((x, y) => x.dist - y.dist);
  } else if (doBike && bikeR_.status === "rejected") bikeError = String(bikeR_.reason && bikeR_.reason.message || bikeR_.reason).slice(0, 120);

  return {
    lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy || null, busStops, bikes, bikeError, bikePending: bikeR_.status === "pending",
    only, rail: railR_.status === "fulfilled" ? railR_.value : [],
    railError: doRail && railR_.status === "rejected" ? String(railR_.reason.message || railR_.reason).slice(0, 120) : null,
    busError: doBus && busR_.status === "rejected" ? String(busR_.reason.message || busR_.reason).slice(0, 120) : null,
    noLiveWhy: busR_.status === "fulfilled" && busR_.value[0] && busR_.value[0].noLiveWhy || null,
    liveOk: busR_.status === "fulfilled" && busR_.value[0] && busR_.value[0].liveOk,
    favs: favLive,
  };
  }
}

// ---------- 收藏的即時資料（不受目前位置限制） ----------
async function liveFavs(favs, fresh) {
  const out = { bus: {}, bike: {} };
  const jobs = [];
  // 公車：依城市分組，用 $filter 一次查多筆
  const putBus = t => {
    const key = `${t.RouteUID}|${t.Direction === 1 ? 1 : 0}|${t.StopUID}`;
    const sec = typeof t.EstimateTime === "number" ? t.EstimateTime : null;
    const old = out.bus[key];
    if (!old || (sec !== null && (old.sec === null || sec < old.sec))) out.bus[key] = { sec, status: t.StopStatus ?? 0, next: t.NextBusTime || null, noLive: false };
  };
  const fb = (favs.bus || []).slice(0, 30);
  const tp = fb.filter(f => isTpeR(f.routeUID) || isNwtR(f.routeUID));
  let odOk = false, nwtOk = false;
  if (tp.length) {
    try {
      const j = await odGet(`/od/eta?stops=${[...new Set(tp.map(f => f.stopUID))].join(",")}&nwt=1${fresh ? "&fresh=1" : ""}`);
      for (const t of j.list || []) putBus(t);
      odOk = true; nwtOk = !!j.nwtOk;
    } catch (e) {}
  }
  const otherBuses = [];
  for (const f of fb) {
    const key = `${f.routeUID}|${f.dirNum}|${f.stopUID}`;
    if (out.bus[key]) continue;
    if (isTpeR(f.routeUID) || (nwtOk && isNwtR(f.routeUID))) {
      out.bus[key] = { sec: null, status: null, noLive: true };
      continue;
    }
    otherBuses.push({ route: f.route || f.name, routeUID: f.routeUID, dirNum: f.dirNum, stopUID: f.stopUID });
  }
  if (otherBuses.length) {
    jobs.push(refreshNwtRoutes(otherBuses).then(() => {
      for (const r of otherBuses) {
        const key = `${r.routeUID}|${r.dirNum}|${r.stopUID}`;
        if (r.sec != null || r.next || (r.status != null && r.status !== 0)) {
          out.bus[key] = { sec: r.sec, status: r.status ?? 0, next: r.next || null, noLive: false };
        } else {
          out.bus[key] = { sec: null, status: null, noLive: true };
        }
      }
    }).catch(() => {
      for (const r of otherBuses) {
        const key = `${r.routeUID}|${r.dirNum}|${r.stopUID}`;
        out.bus[key] = { sec: null, status: null, noLive: true };
      }
    }));
  }
  // YouBike：依城市分組
  const favBikes = (favs.bike || []).slice(0, 30);
  const kg = {};
  for (const f of favBikes) { const c = UID_CITY[(f.uid || "").slice(0, 3)]; if (c) (kg[c] = kg[c] || []).push(f.uid); }
  jobs.push((async () => {
    const feedU = [], northU = [];
    for (const [city, uids] of Object.entries(kg)) {
      // 所有可對應 YouBike 官網代碼的縣市先用同一份 feed；未命中才各自備援。
      feedU.push(...uids.filter(isCloudBike));
      const other = uids.filter(u => !isCloudBike(u));
      northU.push(...other.filter(isOdBike));
    }
    if (feedU.length) {
      try {
        const map = await youbikeFeed(fresh);
        for (const uid of feedU) {
          if (map[uid]) out.bike[uid] = odBikeLive(map[uid], "yb");
          else if (isOdBike(uid)) northU.push(uid);
        }
      } catch (e) {
        northU.push(...feedU.filter(isOdBike));
      }
    }
    if (northU.length) {
      try { const j = await odMemoGet(`/od/bike?ids=${[...new Set(northU)].join(",")}${fresh ? "&fresh=1" : ""}`, fresh ? 0 : 90000); for (const a of j.list || []) out.bike[a.StationUID] = odBikeLive(a, "od"); } catch (e) {}
    }
    for (const f of favBikes) {
      if (!out.bike[f.uid]) {
        out.bike[f.uid] = { rent: null, ret: null, src: "none", noLive: true };
      }
    }
  })());
  await Promise.all(jobs);
  return out;
}

function odBikeLive(a, src = null) {
  const det = a.AvailableRentBikesDetail || null;
  return { rent: a.AvailableRentBikes ?? null, ret: a.AvailableReturnBikes ?? null, general: det ? det.GeneralBikes ?? null : null, electric: det ? det.ElectricBikes ?? null : null,
    status: typeof a.ServiceStatus === "number" ? a.ServiceStatus : null, update: a.SrcUpdateTime || null, src };
}
// ---------- 路線頁：沿途站牌 + 預估 + 公車位置 ----------
const sorPack = l => l.map(r => ({ RouteUID: r.RouteUID, Direction: r.Direction, Stops: (r.Stops || []).map(x => ({ StopUID: x.StopUID, StopName: { Zh_tw: x.StopName && x.StopName.Zh_tw }, StopSequence: x.StopSequence, ...(x.StopPosition && x.StopPosition.PositionLat ? { P: [+x.StopPosition.PositionLat.toFixed(5), +x.StopPosition.PositionLon.toFixed(5)] } : {}) })) }));
// v2.49.3：官網讀不到時的 TDX 備援，雙北路線同一個網址 60 秒內只問一次（含下拉）；其他縣市照舊
const rvTdx = (routeUID, url) => isNwtR(routeUID) || isTpeR(routeUID) ? memoTdx("route", url, 60000) : tdx("route", url);
async function routeView({ routeUID, route, dirNum = 0, stopUID, stopName }) {
  const k = routeKind(routeUID);
  if (!k) throw new Error("缺少路線識別資訊");
  // v2.46.3：預估與公車位置用 RouteUID 過濾；高雄等路線名稱當路徑參數 TDX 會回 []
  const u = api => `${BASE}/basic/v2/Bus/${api}/${k.path}?%24filter=${enc(`RouteUID eq '${routeUID}'`)}&%24top=600&%24format=JSON`;
  // 站序永久保存（IndexedDB sor|路線）；預估資料出現站序裡沒有的站，或找不到這條路線，就重抓
  const sorKey = `${k.path}|${route}`, sc = await IDB.get("sor|" + sorKey);
  // 雲端 KV 的全 23 地區站序是手機端唯一來源；同名的其他路線保留在同一份快取裡。
  const sorCloud = async (base = []) => {
    const l = (await cloudSor([routeUID]).catch(() => ({})))[routeUID];
    if (!l || !l.length) return null;
    const d = [...base.filter(r => r.RouteUID !== routeUID), ...l];
    IDB.set("sor|" + sorKey, { t: Date.now(), d, src: "kv" }).catch(() => {});
    return d;
  };
  let sor = sc ? sc.d : await sorCloud().then(d => d || []);
  let odR = null;
  const isNorth = isTpeR(routeUID) || isNwtR(routeUID);
  if (isNorth) {
    odR = await pdaRouteEta(routeUID, 20000);
    if (!odR) {
      odR = await odRouteEta(routeUID, true, route);
    }
  } else {
    odR = isTaoR(routeUID) ? await taoRouteEta(routeUID) : isThbR(routeUID) ? await thbRouteEta(routeUID, dirNum, sor) : isCitybusR(routeUID) ? await citybusRouteEta(routeUID, route, sor) : isHszR(routeUID) ? await hszRouteEta(routeUID, route, sor) : isTxgR(routeUID) ? await tcgoRouteEta(routeUID, route, sor) : isTnnR(routeUID) ? await tnbusRouteEta(routeUID, route, sor) : isKhhR(routeUID) ? await twhRouteEta(routeUID, route, sor) : isKinR(routeUID) ? await kinbusRouteEta(routeUID, route, sor) : await odRouteEta(routeUID, true, route);
  }
  const [etas, near] = isNorth
    ? [odR ? (odR.list || []) : [], odR ? (Array.isArray(odR.near) ? odR.near : []) : []]
    : await Promise.all([
        odR ? odR.list : rvTdx(routeUID, u("EstimatedTimeOfArrival")),
        odR ? (Array.isArray(odR.near) ? odR.near : []) : rvTdx(routeUID, u("RealTimeNearStop")).catch(() => []),
      ]);
  try { reportSor(routeUID, sor, etas); } catch (e) {}
  if (sc) {
    let have = new Set(); for (const r of sor) if (r.RouteUID === routeUID) for (const x of r.Stops || []) have.add(x.StopUID);
    if (!have.size) { const d = await sorCloud(sor); if (d) { sor = d; for (const r of sor) if (r.RouteUID === routeUID) for (const x of r.Stops || []) have.add(x.StopUID); } }
    const stale = !have.size || etas.some(t => t.RouteUID === routeUID && t.StopUID && !have.has(t.StopUID));
    if (stale) sor = await sorCloud(sor).catch(() => null) || sor;
  }
  try { placeHeal(etas.map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw }))); } catch (e) {}
  const mine = sor.filter(r => r.RouteUID === routeUID);
  const dirs = [...new Set((mine.length ? mine : sor).map(r => r.Direction === 1 ? 1 : 0))].sort();
  // 單向路線（如連江 LIE19 只有 Direction 1）：要的方向不存在就改用實際有的方向，否則預估全對不上
  if (mine.length && dirs.length && !dirs.includes(dirNum)) dirNum = dirs[0];
  let cand = mine.filter(r => (r.Direction === 1 ? 1 : 0) === dirNum);
  if (!cand.length) cand = sor.filter(r => (r.Direction === 1 ? 1 : 0) === dirNum);
  if (!cand.length) cand = sor;
  // 官網來源：優先用和官網站牌對得最多的子路線（例如新竹市 2 路主線 20 站，不要被 21 站的繞駛支線蓋掉），一樣多才比站數
  const etaU = new Set(odR ? etas.filter(t => t.RouteUID === routeUID && etaDirOk(t, dirNum, routeUID) && t.StopUID).map(t => t.StopUID) : []);
  const hitN = r => etaU.size ? (r.Stops || []).filter(x => etaU.has(x.StopUID)).length : 0;
  cand.sort((a, b) => hitN(b) - hitN(a) || (b.Stops || []).length - (a.Stops || []).length);
  const stops = ((cand[0] && cand[0].Stops) || []).slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0));
  if (!stops.length) return { routeUID, route, dirs: [dirNum], dest: { 0: null, 1: null }, stops: [] };

  const em = {};
  for (const t of etas) {
    if (t.RouteUID !== routeUID || !etaDirOk(t, dirNum, routeUID) || !t.StopUID) continue;
    const sec = typeof t.EstimateTime === "number" ? t.EstimateTime : null;
    const c = em[t.StopUID];
    if (!c || (sec !== null && (c.sec === null || sec < c.sec))) em[t.StopUID] = { sec, status: t.StopStatus ?? 0, next: t.NextBusTime || null };
  }
  const busAt = {}, busSub = {};
  const routeStopSet = new Set(stops.map(s => s.StopUID));
  for (const b of near) {
    if (b.RouteUID && b.RouteUID !== routeUID) continue;
    if (b.Direction != null && (b.Direction === 1 ? 1 : 0) !== dirNum) continue;
    if (b.StopUID && routeStopSet.has(b.StopUID)) busAt[b.StopUID] = b.PlateNumb || true;
  }
  // 官網來源沒有車輛位置：每個車牌只標在它最快會到的那一站（同秒數取站序最前），不要整排都畫公車
  if (!near.length) {
    const ord = new Map(stops.map((s, i) => [s.StopUID, i]));
    const best = new Map();
    for (const e of etas) {
      if (e.RouteUID !== routeUID || !etaDirOk(e, dirNum, routeUID) || !e.StopUID || !e.PlateNumb) continue;
      const sec = typeof e.EstimateTime === "number" ? e.EstimateTime : 1e9, q = ord.has(e.StopUID) ? ord.get(e.StopUID) : 1e6, b = best.get(e.PlateNumb);
      if (!b || sec < b.sec || (sec === b.sec && q < b.q)) best.set(e.PlateNumb, { uid: e.StopUID, sec, q, sub: e.SubRouteUID });
    }
    for (const [p, b] of best) { busAt[b.uid] = p; const t = subTag(routeUID, route, b.sub); if (t) busSub[b.uid] = t; }
  }
  let destMap = {};
  try { destMap = await loadRouteDest("route", [routeUID]); } catch (e) {}
  busHeal([routeUID]);

  return {
    routeUID, route, dirNum, dirs: dirs.length ? dirs : [dirNum],
    dest: oneWayDest({ 0: destOf(routeUID, 0, destMap), 1: destOf(routeUID, 1, destMap) }, dirs, dirNum, stops),
    stops: stops.map(s => {
      const nm = (s.StopName && s.StopName.Zh_tw) || "?";
      const e = em[s.StopUID] || { sec: null, status: null, noLive: isNorth ? !odR : !etas.length };
      // v2.50.0：站序本來就帶的站牌座標（雲端 P:[lat,lon] 或 TDX StopPosition）一併傳給路線頁畫真地圖；不多抓任何資料
      const sp = s.StopPosition && s.StopPosition.PositionLat != null ? [s.StopPosition.PositionLat, s.StopPosition.PositionLon] : Array.isArray(s.P) ? s.P : null;
      return {
        seq: s.StopSequence, name: nm, uid: s.StopUID, ...e, ...(sp && Number.isFinite(+sp[0]) && Number.isFinite(+sp[1]) ? { lat: +sp[0], lon: +sp[1] } : {}),
        noLive: e.noLive ?? (isNorth ? !odR : !etas.length),
        bus: !!busAt[s.StopUID], plate: typeof busAt[s.StopUID] === "string" ? busAt[s.StopUID] : null, sub: busSub[s.StopUID] || null,
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
// 北捷支線（v2.27.3）：臺北捷運路線資料 LineID R-3 新北投支線、G-3 小碧潭支線（IsBranch=1，LineGroup R／G），路線圖另用淺粉紅／淺綠色。
// TDX 時刻表與即時都把支線算在 R／G；這裡改成 app 內的 RA／GA 當獨立路線顯示、分組；查站序等 TDX 資料時再換回 R／G（BR_BASE）
const BR_STN = { TRTC: { R22A: "RA", G03A: "GA" } }, BR_BASE = { RA: "R", GA: "G" }, BR_HUB = { TRTC: { R22: "RA", G03: "GA" } };
const BR_DEST = { "新北投": "RA", "小碧潭": "GA" };
function brLine(op, line, sid, did, dname) {
  const m = BR_STN[op]; if (!m || !line || BR_BASE[line]) return line;
  const b = m[String(sid || "").toUpperCase()] || m[String(did || "").toUpperCase()] || BR_DEST[dname] || null;
  return b && BR_BASE[b] === line ? b : line;
}
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
    const l = (BR_STN[s.op] || {})[s.id] || lineOf(s.op, s.id), hub = (BR_HUB[s.op] || {})[s.id];
    const g = groups[k];
    if (!g) {
      groups[k] = { ...s, ids: [s.id], dist: d, lines: [l, hub].filter(Boolean), exit: exit ? exit.name : null,
        navLat: exit ? exit.lat : s.lat, navLon: exit ? exit.lon : s.lon };
    } else {
      g.ids.push(s.id);
      for (const x of [l, hub]) if (x && !g.lines.includes(x)) g.lines.push(x);
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
      if (opts.far !== true && !opts.far[op]) continue;   // v2.29.0：台鐵、高鐵分開開關
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
// 台鐵官網即時誤點（經 Worker /tra，每站快取 30 秒）；逾時或失敗回傳 null（改走 TDX）
async function traOfficial(st) {
  const proxy = getProxy(); if (!proxy) return null;
  const id = st.ids && st.ids[0], name = st.name;
  if (!id || !name) return null;
  let json;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 27000);
  try {
    const response = await fetch(nt(`${proxy}/tra?st=${encodeURIComponent(id)}&n=${encodeURIComponent(name)}`), { signal: ctl.signal });
    json = response.ok ? await response.json() : null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!json || !Array.isArray(json.trains) || !json.trains.length) return null;
  return json;
}

function traProcessRows(rows, delay, now = nowMin()) {
  const seen = new Set();
  return rows.filter(r => r.time && !seen.has(r.no) && seen.add(r.no))
    .map(r => ({ ...r, delay: delay ? (delay[r.no] ?? null) : null, t: toMin(r.time) }))
    .filter(r => r.t + (r.delay || 0) >= now - 1)
    .sort((a, b) => (a.t + (a.delay || 0)) - (b.t + (b.delay || 0)) || a.t - b.t);
}

function traOfficialBoard(official, storedRows) {
  const delay = {}, peek = traAllPeek(); // 官網未列誤點時，若有 60 秒內已抓的 TDX 全台動態就補上
  if (Array.isArray(peek)) for (const t of peek) if (t.TrainNo != null && typeof t.DelayTime === "number") delay[String(t.TrainNo)] = t.DelayTime;
  for (const t of official.trains) if (t.no != null && typeof t.delay === "number") delay[String(t.no)] = t.delay;
  let rows = (storedRows && storedRows.length) ? storedRows : official.trains.map(t => ({
    no: String(t.no),
    type: shortType(t.type),
    dest: t.to,
    dir: t.dir,
    time: t.dep,
  }));
  rows = traProcessRows(rows, delay);
  return { kind: "tra", live: true, trains: rows, groups: groupTrains("tra", rows), note: null };
}

async function traTdxLive(get, id, storedRows) {
  const filter = encodeURIComponent(`StationID eq '${id}'`);
  // 本站 StationLiveBoard ＋ 全台列車動態（Worker 共用快取60秒），讓已發車的每一班都有誤點
  const [tt, slive, tlive] = await Promise.allSettled([
    Promise.resolve([]),
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
  rows = traProcessRows(rows, delay);
  return { kind: "tra", live, trains: rows, groups: groupTrains("tra", rows), note: live ? null : "誤點資訊暫時讀不到，只顯示表定時間" };
}

async function traBoard(get, st) {
  const id = st.ids[0];
  const officialPromise = traOfficial(st);
  const storedRows = await ttTrainRows("TRA", id, await dayInfo(svcDate(0))).catch(() => null);

  const fetchLive = async () => {
    let official = null;
    try { official = await officialPromise; } catch (e) {}
    if (official) return traOfficialBoard(official, storedRows);
    return traTdxLive(get, id, storedRows);
  };

  if (storedRows && storedRows.length) {
    const rows = traProcessRows(storedRows, null);
    return {
      kind: "tra",
      live: false,
      trains: rows,
      groups: groupTrains("tra", rows),
      note: "正在讀取官網誤點…",
      pending: fetchLive(),
    };
  }
  return fetchLive();
}

async function thsrBoard(get, st) {
  const id = st.ids[0];
  const storedRows = await ttTrainRows("THSR", id, await dayInfo(svcDate(0))).catch(() => null);
  const tt = { status: "fulfilled", value: [] };
  const seatMap = {};
  const seatList = [];
  let rows;
  if (storedRows && storedRows.length) rows = storedRows;
  else if (tt.status === "fulfilled" && tt.value.length) {
    rows = tt.value.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else if (seatList.length) {
    rows = seatList.map(t => ({ no: String(t.TrainNo), type: "高鐵", dest: zh(t.EndingStationName), dir: t.Direction, time: hm(t.DepartureTime) }));
  } else rows = [];
  const now = nowMin();
  rows = rows.filter(r => r.time).map(r => ({ ...r, t: toMin(r.time), seats: seatMap[r.no] || null }))
    .filter(r => r.t >= now - 1).sort((a, b) => a.t - b.t);
  return { kind: "thsr", live: false, trains: rows, groups: groupTrains("thsr", rows), note: null };
}

// 北捷即時到站（經 Worker /trtc-eta，來源 Bus+）；失敗或沒資料回傳 null
const TRTC_ROUTE = [["淡水信義", "R"], ["松山新店", "G"], ["中和新蘆", "O"], ["板南", "BL"], ["文湖", "BR"], ["環狀", "Y"], ["新北投", "RA"], ["小碧潭", "GA"]];
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
    j = await fetch(nt(`${proxy}/trtc-eta?ids=${encodeURIComponent(ids.join(","))}`), { signal: ctl.signal }).then(r => r.ok ? r.json() : null);
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
    line = brLine("TRTC", line, s.id, destId, dest);
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
// v2.47.0 北捷官網即時到站（經 Worker /trtc，含路線擁擠度 low/mid/busy/high）；全部失敗或沒有任何到站時間回傳 null
// 官網以「線＋站」查詢：轉乘站每條線各查一次（含環狀線轉乘站碼，最多 4 次）；支線站（R22A、G03A）官網不支援，跳過
const TRTC_OFF_LINES = ["BR", "R", "G", "O", "BL", "Y"];
const trtcOffKey = s => normZh(s).replace(/站$/, "").replace(/[\/／・\s]/g, "");   // 官網「廣慈奉天宮」＝車站清單「廣慈/奉天宮」
async function trtcOfficial(st) {
  const proxy = getProxy(); if (!proxy) return null;
  const all = [...new Set(st.ids.flatMap(i => TRTC_XFER[i] ? [i, TRTC_XFER[i]] : [i]))];
  const ids = all.filter(i => /^[A-Z]{1,2}\d{2}$/.test(i) && TRTC_OFF_LINES.includes(stnPre(i))).slice(0, 4);
  if (!ids.length) return null;
  const one = async id => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
    try { const r = await fetch(nt(`${proxy}/trtc?line=${stnPre(id)}&st=${id}`), { signal: ctl.signal }); const j = r.ok ? await r.json() : null; return j && j.ok && Array.isArray(j.trains) ? j : null; }
    catch (e) { return null; }
    finally { clearTimeout(tm); }
  };
  const res = await Promise.all(ids.map(one));
  if (!res.some(Boolean)) return null;
  let list = []; try { list = await loadRailStations(); } catch (e) {}
  const byName = {};
  for (const s of list) if (s.op === "TRTC" || s.op === "NTMC") (byName[trtcOffKey(s.name)] = byName[trtcOffKey(s.name)] || []).push(s);
  const here = new Set(all), now = nowMin(), covered = new Set(), trains = [];
  res.forEach((j, k) => {
    if (!j) return;
    const base = stnPre(ids[k]); covered.add(base);
    for (const x of j.trains) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(x.time || ""); if (!m) continue;
      let d = +m[1] * 60 + +m[2] - now;
      if (d < -720) d += 1440; else if (d > 720) d -= 1440;                     // 跨午夜（23:58 查 00:03 的車＝5 分）
      if (d < -2) continue;                                                    // 已過站的舊資料（star 只是「下一班」標記，同樣過濾）
      // 終點站名換成車站清單的站名與站碼（同名轉乘站優先取本線的站碼）
      const cand = byName[trtcOffKey(x.dest)] || [], s = cand.find(c => stnPre(c.id) === base) || cand[0] || null;
      const destId = s ? s.id : null, dest = s ? s.name : (x.dest || "?");
      if (destId && here.has(destId)) continue;                                // 終點就是本站的列車不顯示
      trains.push({ line: brLine("TRTC", base, ids[k], destId, dest), dest, destId, eta: Math.max(0, d), label: null,   // * ＝官網「下一班」標記，不是已到站，eta 一律用時間計算
        crowd: x.crowd || null, star: !!x.star, car: x.car || null, src: "official" });
    }
  });
  // 有線查不到，或本站有支線列車（北投、七張的新北投／小碧潭支線）：只就官網沒涵蓋的路線補上 Bus+ 的資料
  if (res.some(j => !j) || all.some(i => BR_HUB.TRTC[i] || BR_STN.TRTC[i])) {
    const bp = await trtcLive(st);
    if (bp) trains.push(...bp.filter(t => !covered.has(t.line)));
  }
  trains.sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999));
  return trains.some(t => t.eta !== null) ? trains : null;
}
// 桃園機捷官網即時到站（經 Worker /tymc，Worker 端整份全線資料快取 30 秒）：直達／普通、車廂擁擠度；失敗或沒有任何到站時間回傳 null
// 官網站碼 A08／A14A 與車站清單的 A8／A14a 都正規化成同一種寫法再比對
const tymcNorm = id => { const m = /^A0*(\d{1,2})(a?)$/i.exec(String(id || "").trim()); return m && +m[1] > 0 ? "A" + +m[1] + (m[2] ? "a" : "") : null; };
// 官網車廂擁擠度：1→低、2→中、3→偏高、4 以上→高（等級上限未確認，樣本只見 1～3）；取四節車廂裡最擠的一節
const tymcCrowd = lv => { const n = Array.isArray(lv) ? Math.max(...lv.map(Number).filter(Number.isFinite)) : NaN; return n >= 4 ? "high" : ({ 1: "low", 2: "mid", 3: "busy" })[n] || null; };
async function tymcOfficial(st) {
  const proxy = getProxy(); if (!proxy) return null;
  const ids = [...new Set(st.ids.map(tymcNorm).filter(Boolean))].slice(0, 2);
  if (!ids.length) return null;
  const one = async id => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
    try { const r = await fetch(nt(`${proxy}/tymc?st=${encodeURIComponent(id)}`), { signal: ctl.signal }); const j = r.ok ? await r.json() : null; return j && j.ok && Array.isArray(j.trains) ? j : null; }
    catch (e) { return null; }
    finally { clearTimeout(tm); }
  };
  const res = (await Promise.all(ids.map(one))).filter(Boolean);
  if (!res.length) return null;
  let list = []; try { list = await loadRailStations(); } catch (e) {}
  const byCode = {};
  for (const s of list) if (s.op === "TYMC" && tymcNorm(s.id)) byCode[tymcNorm(s.id)] = s;
  const here = new Set(ids), d0 = new Date(), now = d0.getHours() * 3600 + d0.getMinutes() * 60 + d0.getSeconds(), trains = [];
  // "16:51:26" → 距現在幾分鐘（跨午夜：23:58 查 00:03 的車＝5 分）
  const mins = s => { const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(s || ""); if (!m) return null; let d = +m[1] * 3600 + +m[2] * 60 + +m[3] - now; if (d < -43200) d += 86400; else if (d > 43200) d -= 86400; return d / 60; };
  for (const j of res) for (const x of j.trains) {
    let e = mins(x.arr); if (e === null) continue;
    const dp = mins(x.dep);
    // 已過到站時間但還沒開（起點站、待避直達車的普通車停比較久）：改用發車時間，這班還趕得上
    if (e < -1) { if (dp === null || dp < -1) continue; e = dp; }   // 過站略過
    // 終點照官網 EndStation（普通車 A22 老街溪，和雲端時刻表一致）；車站清單找不到才退回最後停靠站 last
    let code = tymcNorm(x.dest); if (code && !byCode[code] && byCode[tymcNorm(x.last)]) code = tymcNorm(x.last);
    if (!code || here.has(code)) continue;                                              // 終點就是本站的列車不顯示
    const s = byCode[code] || null, lc = tymcNorm(x.last);
    // 直達與普通同時刻同終點也各自一筆，不合併
    // lastId：最後停靠站（官網終點 A22 但只停到 A21 時有值），畫面對表定班次時用來判斷終點不同的是不是同一班
    // etaDep：發車倒數。時刻表記的是發車時間，普通車在長庚等站待避直達車會停 4 分多（17:04 到、17:08 開），對表定班次要用它
    trains.push({ line: "A", dest: s ? s.name : code, destId: s ? s.id : code, eta: Math.max(0, Math.floor(e)), etaDep: dp === null ? undefined : Math.max(0, Math.floor(dp)), label: null,
      ex: x.type === "express" ? true : undefined, crowd: tymcCrowd(x.crowd), src: "tymetro", ...(lc ? { lastId: byCode[lc] ? byCode[lc].id : lc } : {}) });
  }
  trains.sort((a, b) => a.eta - b.eta);
  return trains.length ? trains : null;
}
// 高捷官網（經 Worker /krtc）：美麗島一次回傳紅橘兩線，不重複查詢同一個轉乘站。
const krtcNorm = value => { const match = /^([ROC](?:K|T)?)0*(\d{1,2})(A?)$/i.exec(String(value || "")); const code = match && +match[2] > 0 ? match[1].toUpperCase() + +match[2] + match[3].toUpperCase() : null; return ({ R25: "RK1", O15: "OT1" })[code] || code; };
async function krtcOfficial(st) {
  const proxy = getProxy(); if (!proxy) return null;
  const ids = st.ids.map(krtcNorm).filter(Boolean), id = ids.find(code => st.op === "KLRT" ? code[0] === "C" : /^[RO]/.test(code));
  if (!id) return null;
  let json;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try { const response = await fetch(nt(`${proxy}/krtc?st=${encodeURIComponent(id)}`), { signal: ctl.signal }); json = response.ok ? await response.json() : null; }
  catch (error) { return null; }
  finally { clearTimeout(timer); }
  if (!json || !json.ok || !Array.isArray(json.lines)) return null;
  let list = []; try { list = await loadRailStations(); } catch (error) {}
  const byCode = {};
  for (const station of list) if (station.op === st.op && krtcNorm(station.id)) byCode[krtcNorm(station.id)] = station;
  const trains = [];
  for (const item of json.lines) {
    if (!(st.op === "KLRT" ? item.line === "C" : item.line === "R" || item.line === "O")) continue;
    const code = krtcNorm(item.dir), station = byCode[code];
    if (!code || ids.includes(code) || !Array.isArray(item.next)) continue;
    for (const next of item.next) {
      if (typeof next.min !== "number" || !Number.isFinite(next.min) || next.min < 0 || next.min > 20) continue;
      trains.push({ line: item.line, dest: item.line === "C" ? item.dest || "環狀輕軌" : station ? station.name : item.dest || code, destId: item.line === "C" ? null : station ? station.id : code, eta: next.min, arriving: !!next.arriving, label: null, src: "krtc",
        ...(item.line === "C" ? { dir: item.direction, via: item.via } : {}) });
    }
  }
  trains.sort((first, second) => first.eta - second.eta);
  return trains.length ? trains : null;
}
// v2.47.0 新北捷官網淡海／安坑輕軌即時（經 Worker /ntm，整條線一份快取 30 秒）：官網只有列車位置，Worker 依官網標準行駛時間換算成到站秒數
// 同方向會列出上游的每一台車；失敗、這站沒有車或沒有任何到站時間回傳 null（改走 TDX）
const NTM_LINE = { NTDLRT: "V", NTALRT: "K" };
async function ntmOfficial(st) {
  const proxy = getProxy(), line = NTM_LINE[st.op]; if (!proxy || !line) return null;
  const id = st.ids.map(i => String(i || "").toUpperCase()).find(i => stnPre(i) === line);
  if (!id) return null;
  let j = null;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(nt(`${proxy}/ntm?line=${line}&st=${encodeURIComponent(id)}`), { signal: ctl.signal }); j = r.ok ? await r.json() : null; }
  catch (e) { j = null; }
  finally { clearTimeout(tm); }
  if (!j || !j.ok || !Array.isArray(j.trains)) return null;
  // 淡海上行共用段的車（alt）官網路線不可靠，Worker 兩個終點各列一筆：用時刻表在分岔站 V09 對班，只留對得上的那筆
  const pick = j.trains.some(x => x.alt) ? await ntmAltPick(st.op, j.trains) : {};
  let list = []; try { list = await loadRailStations(); } catch (e) {}
  const byCode = {};
  for (const s of list) if (s.op === st.op) byCode[String(s.id).toUpperCase()] = s;
  const here = new Set(st.ids.map(i => String(i || "").toUpperCase())), trains = [], seen = new Set();
  for (const x of j.trains.slice().sort((a, b) => a.eta - b.eta)) {
    const code = String(x.destId || "").toUpperCase();
    if (!code || here.has(code) || typeof x.eta !== "number" || !(x.eta >= 0)) continue;   // 終點就是本站的列車不顯示
    const p = x.alt ? pick[x.car] : null;
    if (x.alt && (!p || p.destId !== code)) continue;                                      // 對不上班次或不是這個終點：不列（該班維持表定）
    const k = x.car ? x.dir + "|" + code + "|" + x.car : null;                               // 去重：同方向同終點同車號只留最早一筆
    if (k) { if (seen.has(k)) continue; seen.add(k); }
    const s = byCode[code] || null;   // 終點名用車站清單換（紅樹林、崁頂、淡水漁人碼頭…）
    // ttEta：對到的表定班次在本站的時間（分），畫面用它配時刻表的列，誤點超過 4 分也配得上同一班
    trains.push({ line, dest: s ? s.name : code, destId: s ? s.id : code, eta: Math.floor(x.eta / 60), label: null, src: "ntmetro", ...(p ? { ttEta: x.eta / 60 - p.late } : {}) });
  }
  trains.sort((a, b) => a.eta - b.eta);
  return trains.length ? trains : null;
}
// 對班：每台 alt 車兩個假設（往 V11／往 V26）各自到 V09 的時間，和時刻表 V09 該終點的上行班次比；早 2 分～晚 8 分內算對上。
// 停在 V01 等開車的車（Worker 附 o＝開車秒數，來自官網 drivingTime＝時刻表）改和 V01 時刻表比，差 1 分內算對上（官網 18:23 的 108 車：
// V01 18:26 是崁頂班；用 V09 比反而會對到漁人碼頭班，因為雲端時刻表這班沒有 V09）。
// 兩個終點都對得上（誤點約半個班距）：照官網地圖顏色（rid＝routeId，3 崁頂／4 漁人碼頭）；沒有 rid 或都對不上：不採用這台車（不猜）。
// 只有一個終點對得上就照時刻表，不看官網顏色（共用段 routeId 常沿用上一趟，見 worker/ntm.js）；兩台車搶同一班：留時間差小的
// 回傳 { 車號: { destId, late(分) } }
const NTM_JCT = { NTDLRT: "V09" }, NTM_ORG = { NTDLRT: "V01" }, NTM_RID = { NTDLRT: { 3: "V11", 4: "V26" } };
async function ntmAltPick(op, rows) {
  const jct = NTM_JCT[op]; if (!jct) return {};
  const load = async id => { try { return await metroTimetable(null, { op, ids: [id] }, null, true) || []; } catch (e) { if (isRate(e)) throw e; return []; } };
  const needOrg = rows.some(x => x.alt && typeof x.o === "number");
  const [tt, tt0] = await Promise.all([load(jct), needOrg ? load(NTM_ORG[op]) : []]);
  if (!tt.length && !tt0.length) return {};
  const d0 = new Date(); let nowS = d0.getHours() * 3600 + d0.getMinutes() * 60 + d0.getSeconds(); if (nowS < 10800) nowS += 86400;
  const cand = {};
  for (const x of rows) {
    if (!x.alt || !x.car || typeof x.j !== "number") continue;
    const dest = String(x.destId || "").toUpperCase();
    if ((cand[x.car] || []).some(c => c.destId === dest)) continue;
    const org = typeof x.o === "number", sec = org ? x.o : x.j;
    for (const t of org ? tt0 : tt) {
      if (String(t.destId || "").toUpperCase() !== dest || t.dir === 1) continue;
      const late = (nowS + sec - t.t * 60) / 60;
      if (org ? Math.abs(late) <= 1 : late >= -2 && late <= 8) (cand[x.car] = cand[x.car] || []).push({ destId: dest, late, t: t.t, at: org ? "o" : "j", rid: x.rid });
    }
  }
  const one = [];
  for (const [car, c] of Object.entries(cand)) {
    const ds = new Set(c.map(o => o.destId)), rd = (NTM_RID[op] || {})[c[0].rid];
    if (c.length === 1) one.push({ car, ...c[0] });
    else if (ds.size > 1 && rd && c.filter(o => o.destId === rd).length === 1) one.push({ car, ...c.find(o => o.destId === rd) });   // 兩個終點都對得上：照官網顏色
  }
  const out = {};
  for (const c of one.sort((a, b) => Math.abs(a.late) - Math.abs(b.late))) {
    if (Object.values(out).some(o => o.destId === c.destId && o.t === c.t && o.at === c.at)) continue;
    out[c.car] = c;
  }
  return out;
}

// 時刻表只有終點站名：用車站清單把站名換成同一條線的站碼，才能和即時資料用同樣方式判斷方向
async function destFixer(op) {
  let list = []; try { list = await loadRailStations(); } catch (e) {}
  const m = {};
  for (const s of list) if (s.op === op || (op === "TRTC" && s.op === "NTMC") || (op === "NTMC" && s.op === "TRTC")) (m[normZh(s.name).replace(/站$/, "")] = m[normZh(s.name).replace(/站$/, "")] || []).push(s.id);
  return t => {
    if (t.destId) return t;
    const ids = m[normZh(t.dest).replace(/站$/, "")] || [];
    const id = ids.find(i => stnPre(i) === (BR_BASE[t.line] || t.line)) || null;
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
  try { const c = JSON.parse(localStorage.getItem(HW_KEY + op)); if (c && c.hw && await rgenOk(op, c)) return c.hw; } catch (e) {}
  return hwPack([], []);
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
  b.tt = (tt || []).map(fix).map(t => ({ ...t, side: metroSide(t, st.ids) })).filter(t => !(t.destId && st.ids.includes(t.destId)) || TRIP_LOOP[st.op + "|" + t.line]);
  b.ttKind = "official";
  // v2.44.1：即時來源偶爾給出離譜的到站時間（例：Bus+ 兩個方向都回「59:37」，其實幾分鐘就有車）。
  // 即時說 30 分以上才到、但時刻表上同線同方向早 20 分以上就有車：這筆即時不採用；全部都不可信就只用時刻表
  if (b.live && b.tt.length) {
    const sideOf = t => metroSide(fix(t), st.ids);
    // 北捷官網一次列出 40 分鐘內的每一班（v2.47.0），遠的班次本來就晚於時刻表上的下一班，不套用這條規則
    // 桃捷官網（src "tymetro"）同樣一次列出一小時內的每一班，也不套用；新北捷官網（src "ntmetro"）列出上游每一台車，也不套用
    const bogus = t => t.src !== "official" && t.src !== "tymetro" && t.src !== "ntmetro" && t.eta != null && t.eta > 30 && b.tt.some(x => x.line === t.line && x.eta >= 0 && x.eta < t.eta - 20 && (x.dest === t.dest || (x.side && x.side === sideOf(t))));
    if (b.trains.some(bogus)) {
      b.trains = b.trains.filter(t => !bogus(t));
      if (!b.trains.some(t => t.eta != null)) { b.live = false; b.trains = b.tt; }
    }
  }
  if (!b.live) b.groups = [];          // 沒有即時資料時，看板只用時刻表（避免同方向出現兩個分頁）
  else { b.groups = groupTrains("metro", st.ids, b.trains.map(fix)); }
  if (b.tt.length && !b.live) b.note = null;
  return b;
}
async function metroBoard0(get, st) {
  if (busPlusOK(st)) {
    // v2.47.0：①北捷官網 → ②Bus+ → ③下面的 TDX 即時看板＋時刻表
    const trains = await trtcOfficial(st) || await trtcLive(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };   // 資料來源統一寫在設定頁
  }
  if (st.op === "TYMC") {
    // 桃捷：①桃捷官網（直達／普通、車廂擁擠度）→ ②下面的 TDX 即時看板＋時刻表（官網失敗才走，不多打 TDX）
    const trains = await tymcOfficial(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };
  }
  if (NTM_LINE[st.op]) {
    // 淡海／安坑輕軌：①新北捷官網 → ②下面的 TDX 即時看板＋時刻表（官網失敗才走，不多打 TDX）
    const trains = await ntmOfficial(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };
  }
  if (st.op === "KRTC" || st.op === "KLRT") {
    // 原有來源就是 TDX：官網失敗才接回既有的即時看板、時刻表備援，不另增外部來源。
    const trains = await krtcOfficial(st);
    if (trains) return { kind: "metro", live: true, trains, groups: groupTrains("metro", st.ids, trains), note: null };
  }
  const filter = encodeURIComponent(st.ids.map(i => `StationID eq '${i}'`).join(" or "));
  let live = [];
  try { live = await get("rail", `${RAIL_BASE}/v2/Rail/Metro/LiveBoard/${st.op}?%24filter=${filter}&%24format=JSON`); } catch (e) { if (isRate(e)) throw e; }
  if (live.length) {
    railHeal(st.op, live.flatMap(t => [t.StationID, t.DestinationStationID]));
    const vals = live.map(t => t.EstimateTime).filter(v => typeof v === "number");
    const isSec = vals.some(v => v > 120);
    const trains = live.map(t => ({
      line: brLine(st.op, t.LineNO || t.LineID || lineOf(st.op, t.StationID), t.StationID, t.DestinationStationID, zh(t.DestinationStaionName) || zh(t.DestinationStationName)),
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
  if (force || !ttMetaP) ttMetaP = fetchT(`${proxy}/tt/meta${force ? "?t=" + Date.now() : ""}`, 12000).then(r => r.ok ? r.json() : { systems: {}, offline: true }).catch(() => (ttMetaP = null, { systems: {}, offline: true }));
  return ttMetaP;
}
// v2.27.4：軌道靜態資料（站序、站間時間、班距、首末班）手機端永久保存，直到伺服器那邊這個系統「換代」（/tt/meta 的 rgen：時刻表有新版時換）
async function rgenNow(op) { const m = await ttMeta(); return m.offline ? null : ((m.rgen || {})[op] || ""); }
async function rgenOk(op, hit) { const g = await rgenNow(op); return g === null || (hit && (hit.g || "") === g); }
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
      const r = await fetchT(`${getProxy()}/tt/data/${op}?v=${encodeURIComponent(m.updated)}`, 30000);
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
// ---------- v2.49.9 試行：自有資料公車直達（busdirect.js） ----------
// 只用雲端既有資料：公車時刻表分片（/bus/sch/meta＋/bus/sch/shard，只讀 KV）＋雲端站牌座標（/od/citystops，只讀 KV 站序／站牌）。
// 不呼叫 TDX MaaS／Google，不觸發站序重建；雲端沒有就回「未涵蓋」，不退回外部引擎。
// 試行縣市（雙北）只是建議；BD_TRIAL 的步行數值是「試行估算值」，不是正式政策，畫面可調整。
const BD_CITIES = ["Taipei", "NewTaipei"];
const BD_MAX_CANDIDATES = 12;
const BD_TRIAL = { walkRadiusM: 500, walkMpm: 70, walkFactor: 1.3 };   // 試行估算值（未定案）
const BD_LIM = { walkRadiusM: [50, 1500], walkMpm: [30, 150], walkFactor: [1, 3], earlyLimitMin: [1, 1440] };
const BD_SHARD_MS = 30000, BD_CALC_MS = 20000, BD_MAX_BYTES = 40 * 1024 * 1024;   // 40MB＝Worker 上傳上限（schPut）
function bdOpts(u) {
  const o = { ...BD_TRIAL, freqPolicy: "halfHeadway", maxResults: 6 };
  if (u && u.freqPolicy) o.freqPolicy = u.freqPolicy;
  for (const [k, [lo, hi]] of Object.entries(BD_LIM)) if (u && u[k] != null && u[k] !== "") { const v = +u[k]; if (!(isFinite(v) && v >= lo && v <= hi)) throw new Error(`${k} 要在 ${lo}～${hi} 之間`); o[k] = v; }
  return o;
}
async function bdCity(city, metaAll, signal) {
  const meta = metaAll && metaAll[city];
  if (!meta || !(meta.n >= 1)) return { city, recs: null, why: "雲端沒有" + city + "的公車時刻表" };
  if (meta.bytes > BD_MAX_BYTES) return { city, recs: null, why: city + "的時刻表太大，試行版不下載" };
  const key = "bd|" + city, c = await IDB.get(key).catch(() => null);
  if (c && c.t === meta.t && c.n === meta.n && Array.isArray(c.recs)) return { city, recs: c.recs, t: meta.t, cached: true };
  const proxy = getProxy(), sess = getSession(); if (!proxy) throw new Error("NO_PROXY"); if (!sess) throw new Error("請重新登入");
  const shards = [], hdrT = [];
  for (let k = 0; k < meta.n; k++) {
    if (signal && signal.aborted) throw new Error("已取消");
    let r;
    try { r = await fetchT(proxy + "/bus/sch/shard?c=" + enc(city) + "&k=" + k, BD_SHARD_MS, { headers: { "x-session": sess.token } }); }
    catch (e) { throw new Error(e && e.name === "AbortError" ? TIMEOUT_MSG : "連不到伺服器，請確認網路"); }
    if (!r.ok) { const j = await r.json().catch(() => null); throw new Error(r.status === 401 ? "請重新登入" : (j && j.message) || ("時刻表分片 " + r.status)); }
    hdrT.push(r.headers.get("x-sch-t"));
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] !== 31 || buf[1] !== 139) throw new Error("時刻表分片不是 gzip");
    shards.push(JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()));
  }
  const recs = BusDirect.assemble(meta, shards, { city, hdrT });   // 換版／不一致整包拒用，不混版；舊的快取也不拿來混
  await IDB.set(key, { t: meta.t, n: meta.n, recs }).catch(() => {});
  return { city, recs, t: meta.t };
}
let bdWorker = null, bdSeq = 0;
function bdRun(msg) {
  if (typeof Worker === "undefined") return Promise.resolve(BusDirect.plan(msg));
  if (!bdWorker) bdWorker = new Worker("./busdirect.js");
  const id = ++bdSeq, w = bdWorker;
  return new Promise((res, rej) => {
    let tm = null;
    const done = () => { clearTimeout(tm); w.removeEventListener("message", on); w.removeEventListener("error", er); };
    const on = e => { if (!e.data || e.data.id !== id) return; done(); res(e.data.out); };
    const er = () => { done(); bdWorker = null; try { w.terminate(); } catch (x) {} rej(new Error("背景計算失敗")); };
    tm = setTimeout(() => { done(); bdWorker = null; try { w.terminate(); } catch (x) {} rej(new Error("計算逾時")); }, BD_CALC_MS);
    w.addEventListener("message", on); w.addEventListener("error", er);
    w.postMessage({ ...msg, id });
  });
}
const bsorMem = new Map();
async function bsorReadResp(r) {
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return await r.json().catch(() => null);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 31 && buf[1] === 139) {
    return JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}
function bsorDecode(shards) {
  const byRoute = {}, stops = {};
  let oneStop = 0;
  for (const S of shards) {
    if (!S || !Array.isArray(S.r)) continue;
    const names = S.n || [], pos = S.p || [];
    for (const row of S.r) {
      if (!Array.isArray(row) || row.length < 7) continue;
      const [uid, rName, subUID, subName, dir, stopUids, posIdxs] = row;
      if (!uid || !Array.isArray(stopUids)) continue;
      if (stopUids.length < 2) {
        if (stopUids.length === 1) oneStop++;
        continue;
      }
      const Stops = [];
      for (let k = 0; k < stopUids.length; k++) {
        const suid = stopUids[k];
        const p = pos[posIdxs[k]] || [0, 0, 0];
        const sname = names[p[0]] || "";
        const lat = p[1] / 1e4, lon = p[2] / 1e4;
        if (lat && lon && !stops[suid]) stops[suid] = [lat, lon, sname];
        Stops.push({ StopUID: suid, StopName: { Zh_tw: sname }, P: [lat, lon] });
      }
      if (!byRoute[uid]) byRoute[uid] = [];
      byRoute[uid].push({
        RouteUID: uid,
        RouteName: { Zh_tw: rName || "" },
        SubRouteUID: subUID || "",
        SubRouteName: { Zh_tw: subName || "" },
        Direction: dir,
        Stops
      });
    }
  }
  return { byRoute, stops, oneStop };
}
async function bsorCity(city, signal) {
  const now = Date.now();
  const mem = bsorMem.get(city);
  if (mem && now >= mem.checkedAt && now - mem.checkedAt < 600000 && mem.byRoute) {
    return { ...mem, cached: true, netCalls: 0 };
  }
  const c = await IDB.get("bsor|" + city).catch(() => null);
  if (c && c.checkedAt && now >= c.checkedAt && now - c.checkedAt < 600000 && c.byRoute) {
    bsorMem.set(city, c);
    return { ...c, cached: true, netCalls: 0 };
  }
  const proxy = getProxy(), sess = getSession();
  if (!proxy || !sess) return null;
  if (signal && signal.aborted) throw new Error("已取消");
  let r0;
  try {
    r0 = await fetchT(proxy + "/bus/sor/part?c=" + enc(city) + "&k=0", BD_SHARD_MS, { headers: { "x-session": sess.token } });
  } catch { return null; }
  if (!r0.ok) return null;
  const s0 = await bsorReadResp(r0).catch(() => null);
  if (!s0 || !Array.isArray(s0.r)) return null;
  const hdrT = r0.headers.get("x-sor-t") || String(s0.t || 0);
  const hdrN = Number(r0.headers.get("x-sor-n")) || 16;
  if (c && String(c.t) === String(hdrT) && c.byRoute) {
    const upd = { ...c, checkedAt: Date.now() };
    bsorMem.set(city, upd);
    await IDB.set("bsor|" + city, upd).catch(() => {});
    return { ...upd, cached: true, netCalls: 1 };
  }
  const shards = new Array(hdrN);
  shards[0] = s0;
  for (let start = 1; start < hdrN; start += 4) {
    if (signal && signal.aborted) throw new Error("已取消");
    const batch = [];
    for (let k = start; k < Math.min(start + 4, hdrN); k++) {
      batch.push((async idx => {
        const rk = await fetchT(proxy + "/bus/sor/part?c=" + enc(city) + "&k=" + idx, BD_SHARD_MS, { headers: { "x-session": sess.token } });
        if (!rk.ok) throw new Error("bsor_" + rk.status);
        const sk = await bsorReadResp(rk);
        if (!sk || !Array.isArray(sk.r)) throw new Error("bsor_bad");
        shards[idx] = sk;
      })(k));
    }
    try { await Promise.all(batch); } catch { return null; }
  }
  const decoded = bsorDecode(shards);
  const entry = { city, t: Number(hdrT) || s0.t || 0, n: hdrN, checkedAt: Date.now(), ...decoded };
  bsorMem.set(city, entry);
  await IDB.set("bsor|" + city, entry).catch(() => {});
  return { ...entry, cached: false, netCalls: hdrN };
}
async function walkTable(o, d, oStops, dStops) {
  // Opus：Worker 每秒最多往外 1 次，兩次同時送第二次一定被擋（busy）。
  // 點數夠（≤25）就合成一次 OSRM table：sources＝[起點, 各下車站]、destinations＝[各上車站, 終點]；不夠才分兩次、間隔 1.1 秒
  const out = { o: {}, d: {}, oDist: {}, dDist: {}, calls: 0 };
  const r4 = n => Number(n).toFixed(4);
  const oList = (oStops || []).slice(0, 24), dList = (dStops || []).slice(0, 24);
  const num = v => typeof v === "number" && Number.isFinite(v);
  const get = q => authedGet(q, 6000);
  if (oList.length && dList.length && oList.length + dList.length + 2 <= 25) {
    const P = [[+o.lat, +o.lon], ...oList.map(x => [x.lat, x.lon]), ...dList.map(x => [x.lat, x.lon]), [+d.lat, +d.lon]];
    const oi = oList.map((_, i) => 1 + i), di = dList.map((_, i) => 1 + oList.length + i), dEnd = P.length - 1;
    const src = [0, ...di], dst = [...oi, dEnd];
    out.calls++;
    const res = await get(`/walk?mode=foot&q=table&pts=${P.map(([a, b]) => `${r4(a)},${r4(b)}`).join(";")}&src=${src.join(",")}&dst=${dst.join(",")}`).catch(() => null);
    if (res && res.ok && Array.isArray(res.durations)) {
      const D = res.durations, M = res.distances || [];
      oList.forEach((x, k) => { const v = D[0] && D[0][k], m = M[0] && M[0][k]; if (num(v)) out.o[x.uid] = v; if (num(m)) out.oDist[x.uid] = m; });
      dList.forEach((x, k) => { const row = 1 + k, col = oList.length, v = D[row] && D[row][col], m = M[row] && M[row][col]; if (num(v)) out.d[x.uid] = v; if (num(m)) out.dDist[x.uid] = m; });
    }
    return out;
  }
  if (oList.length) {
    const pts = [[+o.lat, +o.lon], ...oList.map(x => [x.lat, x.lon])].map(([a, b]) => `${r4(a)},${r4(b)}`).join(";");
    out.calls++;
    const res = await get(`/walk?mode=foot&q=table&pts=${pts}&src=0&dst=${oList.map((_, i) => i + 1).join(",")}`).catch(() => null);
    if (res && res.ok && Array.isArray(res.durations) && Array.isArray(res.durations[0])) oList.forEach((x, k) => { const v = res.durations[0][k], m = res.distances && res.distances[0] && res.distances[0][k]; if (num(v)) out.o[x.uid] = v; if (num(m)) out.oDist[x.uid] = m; });
  }
  if (dList.length) {
    if (out.calls) await new Promise(r => setTimeout(r, 1100));
    const pts = [...dList.map(x => [x.lat, x.lon]), [+d.lat, +d.lon]].map(([a, b]) => `${r4(a)},${r4(b)}`).join(";");
    out.calls++;
    const res = await get(`/walk?mode=foot&q=table&pts=${pts}&src=${dList.map((_, i) => i).join(",")}&dst=${dList.length}`).catch(() => null);
    if (res && res.ok && Array.isArray(res.durations)) dList.forEach((x, k) => { const v = res.durations[k] && res.durations[k][0], m = res.distances && res.distances[k] && res.distances[k][0]; if (num(v)) out.d[x.uid] = v; if (num(m)) out.dDist[x.uid] = m; });
  }
  return out;
}
async function walkRoute({ mode = "foot", pts = [] }) {
  if (!Array.isArray(pts) || pts.length < 2) throw new Error("座標點不足");
  const r4 = n => Number(n).toFixed(4);
  const ptsStr = pts.map(([a, b]) => `${r4(a)},${r4(b)}`).join(";");
  return await authedGet(`/walk?mode=${enc(mode)}&q=route&pts=${ptsStr}`, 8000);   // Opus：/walk 要登入
}
async function busDirectPlan({ o, d, when, time, opts, signal }) {
  if (!o || !d || o.lat == null || d.lat == null) throw new Error("請先選好起點和終點");
  const P = bdOpts(opts);
  const w = when === "arr" ? "arr" : "dep", t = when === "now" || !time ? BusDirect.isoTpe(Date.now()).slice(0, 16) : time;
  const metaAll = await authedGet("/bus/sch/meta");
  const cities = [], miss = [];
  for (const c of BD_CITIES) { const x = await bdCity(c, metaAll, signal); if (x.recs) cities.push(x); else miss.push(x.why); }
  const recs = cities.flatMap(x => x.recs), stops = {}, sorMap = {}, bsorMeta = [];
  let bsorLoaded = false, sorOneStop = 0;
  for (const x of cities) {
    const b = await bsorCity(x.city, signal).catch(() => null);
    if (b && b.byRoute) {
      bsorLoaded = true;
      sorOneStop += b.oneStop || 0;
      bsorMeta.push({ city: x.city, t: b.t, cached: !!b.cached, oneStop: b.oneStop || 0, netCalls: b.netCalls || 0 });
      for (const [uid, pos] of Object.entries(b.stops || {})) if (!stops[uid]) stops[uid] = [pos[0], pos[1]];
      for (const [ruid, list] of Object.entries(b.byRoute)) sorMap[ruid] = (sorMap[ruid] || []).concat(list);
    } else {
      const l = await cloudCityStops(x.city).catch(() => null);
      if (!l) miss.push(x.city + "的雲端站牌座標讀不到");
      for (const s of l || []) { const p = s.StopPosition; if (p && p.PositionLat) stops[s.StopUID] = [p.PositionLat, p.PositionLon]; }
    }
  }
  if (signal && signal.aborted) throw new Error("已取消");
  const hol = await ttLoad("HOLIDAY").catch(() => null), holidays = Object.keys((hol && hol.dates) || {}).map(x => x.replace(/-/g, ""));

  // 1. 挑選起訖點附近站牌
  const hav = (a, b, c, d) => {
    const R = 6371000, r = x => x * Math.PI / 180, x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const R = P.walkRadiusM;
  const nearO = new Map(), nearD = new Map();
  for (const [uid, pos] of Object.entries(stops)) {
    if (!pos) continue;
    const do_ = hav(+o.lat, +o.lon, pos[0], pos[1]);
    if (do_ <= R) nearO.set(uid, do_);
    const dd_ = hav(+d.lat, +d.lon, pos[0], pos[1]);
    if (dd_ <= R) nearD.set(uid, dd_);
  }

  // 2. 候選路線挑選（優先使用 r.st 與雲端 bsor 站序，嚴格比對 RouteUID + Direction + SubRouteUID，最多 12 條）
  const candMap = new Map();
  const considerStops = (r, stopList) => {
    if (!Array.isArray(stopList) || stopList.length < 2) return;
    let firstOIdx = Infinity, minO = Infinity, boardStopUID = null;
    const oUids = [], dUids = [];
    for (let idx = 0; idx < stopList.length; idx++) {
      const suid = typeof stopList[idx] === "string" ? stopList[idx] : (Array.isArray(stopList[idx]) ? stopList[idx][0] : stopList[idx].StopUID);
      if (nearO.has(suid)) {
        if (idx < firstOIdx) firstOIdx = idx;
        oUids.push(suid);
        const distO = nearO.get(suid);
        if (distO < minO) { minO = distO; boardStopUID = suid; }
      }
      if (nearD.has(suid) && idx > firstOIdx) {
        dUids.push(suid);
      }
    }
    if (boardStopUID && dUids.length) {
      const k = r.u + "|" + r.d;
      const cur = candMap.get(k);
      if (!cur || minO < cur.walkO) {
        candMap.set(k, { routeUID: r.u, dir: r.d, sub: r.s || r.sn || "", walkO: minO, boardStopUID, oUids, dUids, rec: r });
      }
    }
  };
  for (const r of recs) {
    if (r.st && r.st.length >= 2) {
      considerStops(r, r.st);
      continue;
    }
    const list = sorMap[r.u];
    if (list && list.length) {
      const match = list.find(x => Number(x.Direction) === Number(r.d) && (!r.s || String(x.SubRouteUID) === String(r.s)) && x.Stops && x.Stops.length >= 2);
      if (match) considerStops(r, match.Stops);
    }
  }

  // Opus：工單「拿掉終點那次 /od/eta、候選不再靠 /od/eta」：雲端站序讀不到時只用班表 st 找候選，不再打 /od/eta 找路線
  if (!bsorLoaded) miss.push("雲端站序讀不到，只用班表站序找候選路線");
  // 依起點步行距離排序，最多 12 條
  let candidates = Array.from(candMap.values()).sort((a, b) => a.walkO - b.walkO).slice(0, BD_MAX_CANDIDATES);

  // 3. 若無 bsor 才退回 cloudSor（正常路徑零 /bus/sor/route 請求）
  if (!bsorLoaded && candidates.length) {
    const candUids = [...new Set(candidates.map(c => c.routeUID))];
    const extraSor = await cloudSor(candUids).catch(() => ({}));
    Object.assign(sorMap, extraSor);
    candidates = candidates.filter(cand => {
      if (cand.rec && cand.rec.st && cand.rec.st.length >= 2) {
        let hasO = false;
        for (const s of cand.rec.st) {
          if (nearO.has(s[0])) { hasO = true; cand.oUids = cand.oUids || []; if (!cand.oUids.includes(s[0])) cand.oUids.push(s[0]); }
          if (nearD.has(s[0]) && hasO) { cand.dUids = cand.dUids || []; if (!cand.dUids.includes(s[0])) cand.dUids.push(s[0]); }
        }
        return !!(cand.dUids && cand.dUids.length);
      }
      const sorList = sorMap[cand.routeUID] || [];
      const sorEntry = sorList.find(x => Number(x.Direction) === Number(cand.dir) && (!cand.sub || String(x.SubRouteUID) === String(cand.sub)));
      if (sorEntry && sorEntry.Stops && sorEntry.Stops.length >= 2) {
        let hasO = false;
        for (const s of sorEntry.Stops) {
          if (nearO.has(s.StopUID)) { hasO = true; cand.oUids = cand.oUids || []; if (!cand.oUids.includes(s.StopUID)) cand.oUids.push(s.StopUID); }
          if (nearD.has(s.StopUID) && hasO) { cand.dUids = cand.dUids || []; if (!cand.dUids.includes(s.StopUID)) cand.dUids.push(s.StopUID); }
        }
        return !!(cand.dUids && cand.dUids.length);
      }
      return false;
    });
  }

  // 4. 即時到站校正（僅限指定出發／現在出發且在未來 60 分鐘內；指定抵達或超過 60 分鐘零請求）
  const nowMs = Date.now();
  const queryMs = BusDirect.parseTpe(t);
  const useLive = (w === "dep") && Number.isFinite(queryMs) && (queryMs - nowMs >= -60000) && (queryMs - nowMs <= 60 * 60000);
  const liveMap = {};
  if (useLive && candidates.length) {
    const tpeCands = candidates.filter(c => String(c.routeUID).startsWith("TPE"));
    const otherCands = candidates.filter(c => !String(c.routeUID).startsWith("TPE"));
    const liveJobs = [];
    if (tpeCands.length) {
      liveJobs.push(odGet(`/od/eta?lat=${+o.lat}&lon=${+o.lon}&r=${R}`).then(etaO => {
        for (const it of (etaO && etaO.list) || []) {
          if (it && it.RouteUID && typeof it.EstimateTime === "number" && Number.isFinite(it.EstimateTime) && it.EstimateTime >= 0 && (it.StopStatus == null || it.StopStatus === 0)) {
            const dir = it.Direction ?? 0;
            liveMap[it.RouteUID + "|" + dir + "|" + it.StopUID] = it.EstimateTime;   // Opus：只記上車站本身，不用同路線別站的時間
          }
        }
      }).catch(() => {}));
    }
    if (otherCands.length) {
      const stopIds = [...new Set(otherCands.map(c => c.boardStopUID).filter(Boolean))].slice(0, 20);   // Opus：Worker 上限 20
      if (stopIds.length) {
        liveJobs.push((async () => {
          const bgRes = await authedGet(`/busgo/live?ids=${enc(stopIds.join(","))}`, 5000).catch(() => null);   // Opus：/busgo/live 要登入
          if (bgRes && bgRes.ok && bgRes.live) {
            for (const c of otherCands) {
              const sec = bgRes.live[c.routeUID + "_" + c.dir];
              if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) {
                liveMap[c.routeUID + "|" + c.dir + "|" + c.boardStopUID] = sec;
              }
            }
          }
          const unresolved = otherCands.filter(c => liveMap[c.routeUID + "|" + c.dir + "|" + c.boardStopUID] == null).slice(0, 3);
          await Promise.all(unresolved.map(async c => {
            const off = await fetchOfficialRoute(c.routeUID, c.rec && c.rec.n, [], sorMap[c.routeUID] || null).catch(() => null);
            const list = (off && off.list) || [];
            const hit = list.find(x => x.StopUID === c.boardStopUID && (x.Direction == null || (x.Direction === 1 ? 1 : 0) === Number(c.dir)) && typeof x.EstimateTime === "number" && x.EstimateTime >= 0);   // Opus：只認上車站本身
            if (hit) liveMap[c.routeUID + "|" + c.dir + "|" + c.boardStopUID] = hit.EstimateTime;
          }));
        })());
      }
    }
    await Promise.all(liveJobs);
  }

  // 5. OSRM 步行時間矩陣（最多 2 次 /walk?q=table&mode=foot：起點→上車站、下車站→終點）
  const oStopObjs = [], dStopObjs = [], seenO = new Set(), seenD = new Set();
  for (const c of candidates) {
    for (const uid of c.oUids || [c.boardStopUID]) {
      if (uid && stops[uid] && !seenO.has(uid)) { seenO.add(uid); oStopObjs.push({ uid, lat: stops[uid][0], lon: stops[uid][1] }); }
    }
    for (const uid of c.dUids || []) {
      if (uid && stops[uid] && !seenD.has(uid)) { seenD.add(uid); dStopObjs.push({ uid, lat: stops[uid][0], lon: stops[uid][1] }); }
    }
  }
  const wt = await walkTable(o, d, oStopObjs, dStopObjs);

  // 6. 站間資料只讀候選路線（IndexedDB 有就不打網路，同一包只讀/下載一次）
  const s2sDocs = {};
  let s2sLocalPacks = 0, s2sNetPacks = 0, s2sBytes = 0, s2sNetBytes = 0;
  const seenPacks = new Set();

  for (const cand of candidates) {
    const r = cand.rec;
    if (!r) continue;
    const city = (r.u && r.u.startsWith("NWT")) ? "NewTaipei" : "Taipei";
    const routeName = r.n;
    if (!routeName) continue;
    try {
      const res = await s2sDocGet({ c: city, route: routeName });
      if (res && res.doc) {
        s2sDocs[r.u] = res.doc;
        s2sDocs[routeName] = res.doc;
        const pId = res.partId || routeName;
        if (!seenPacks.has(pId)) {
          seenPacks.add(pId);
          if (res.fromNet) s2sNetPacks++; else s2sLocalPacks++;
          s2sBytes += res.bytes || 0;
          s2sNetBytes += res.netBytes || 0;
        }
      }
    } catch (e) {}
  }

  // 7. 執行直達計算
  const out = await bdRun({
    records: recs,
    stops,
    o: { lat: +o.lat, lon: +o.lon },
    d: { lat: +d.lat, lon: +d.lon },
    when: w,
    time: t,
    opts: { ...P, holidays },
    s2s: s2sDocs,
    sor: sorMap,
    cand: candidates,
    walkTable: wt,
    live: useLive ? liveMap : null,
    nowMs,
    sorOneStop
  });

  out.notes = [...(out.notes || []), ...miss, ...(hol ? [] : ["國定假日曆讀不到，無法排除國定假日"])];
  out.meta = {
    cities: cities.map(x => ({ city: x.city, t: x.t, cached: !!x.cached })),
    bsor: bsorMeta,
    walkCalls: wt.calls,
    useLive,
    opts: P,
    query: { when: w, time: t },
    candCount: candidates.length,
    s2sPacks: {
      local: s2sLocalPacks,
      net: s2sNetPacks,
      total: s2sLocalPacks + s2sNetPacks,
      bytes: s2sBytes,
      netBytes: s2sNetBytes   // Opus：實際網路下載量
    },
    s2sBytes
  };
  return out;
}
// ---------- JT-20261107-02：站間旅行時間（TDX 加值，歷史推估）管理者匯入：一次一條，由管理者按鈕觸發 ----------
async function s2sImportOne({ c, route, force }) {
  const proxy = getProxy(), sess = getSession(); if (!proxy) throw new Error("NO_PROXY"); if (!sess) throw new Error("請重新登入");
  let r, j = null;
  try { r = await fetchT(proxy + "/bus/s2s/import?c=" + enc(c || "") + "&route=" + enc(route || "") + (force ? "&force=1" : ""), 30000, { method: "POST", headers: { "x-session": sess.token } }); j = await r.json().catch(() => null); }
  catch (e) { throw new Error(e && e.name === "AbortError" ? TIMEOUT_MSG : "連不到伺服器，請確認網路"); }
  if (!r.ok) { const e = new Error(r.status === 401 ? "請重新登入" : (j && typeof j.message === "string" && j.message) || ("錯誤 " + r.status)); e.s2s = s2sDiag(r.status, j);
    if (j && j.raw && typeof j.raw === "object") e.s2s.sample = await s2sKeepSample({ c, route, status: r.status, diag: e.s2s, raw: j.raw }, sess);   // JT-20261108-01：拒收樣本留在本機（只限管理者 session）
    throw e; }
  return j;
}
// v2.49.11：把 Worker 錯誤回應裡既有的安全診斷（drop／total／up／upstream／detail）整理成純資料，只留合法型別；不猜測、不補值
function s2sDiag(status, j) {
  const n = v => (typeof v === "number" && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null;
  const o = j && typeof j === "object" && !Array.isArray(j) ? j : null, d = { status: n(status), json: !!o, total: o ? n(o.total) : null, drop: null, up: null, upstream: o ? n(o.upstream) : null, detail: null };
  if (o && o.drop && typeof o.drop === "object") { const x = { name: n(o.drop.name), city: n(o.drop.city), shape: n(o.drop.shape) }; if (x.name !== null || x.city !== null || x.shape !== null) d.drop = x; }
  if (o && o.up && typeof o.up === "object" && !Array.isArray(o.up)) { const u = Object.entries(o.up).filter(([k, v]) => typeof k === "string" && (typeof v === "string" || typeof v === "number")).slice(0, 20).map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 200)]); d.up = u; }
  if (o && typeof o.detail === "string" && o.detail) d.detail = o.detail.slice(0, 300);
  d.shape = o ? s2sShapeDiag(o.shape) : null;
  if (o && o.raw && typeof o.raw === "object") d.raw = { attached: o.raw.attached === true && "data" in o.raw, chars: n(o.raw.chars), why: typeof o.raw.why === "string" ? o.raw.why.slice(0, 100) : null };
  return d;
}
// JT-20261108-01：shape 細部原因（只收合法型別，最多 20 筆位置）
const S2S_SHAPE_R = ["notArray", "empty", "segNull", "fromMissing", "toMissing", "runMissing", "runNull", "runType"];
function s2sShapeDiag(x) {
  if (!x || typeof x !== "object") return null;
  const n = v => (typeof v === "number" && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null, t = (v, m = 60) => typeof v === "string" ? v.slice(0, m) : (typeof v === "number" && Number.isFinite(v) ? String(v) : null);
  const R = x.reasons && typeof x.reasons === "object" ? x.reasons : {};
  const rt = x.runTypes && typeof x.runTypes === "object" ? Object.entries(x.runTypes).slice(0, 8).map(([k, v]) => [String(k).slice(0, 20), n(v)]).filter(z => z[1] !== null) : [];
  const first = Array.isArray(x.first) ? x.first.slice(0, 20).filter(f => f && typeof f === "object").map(f => ({ rec: n(f.rec), seg: n(f.seg), field: t(f.field, 40), reason: S2S_SHAPE_R.includes(f.reason) ? f.reason : null, type: t(f.type, 20), value: t(f.value, 80),
    route: t(f.route), sub: t(f.sub), dir: t(f.dir, 10), recKeys: Array.isArray(f.recKeys) ? f.recKeys.slice(0, 30).map(k => String(k).slice(0, 40)) : [], segKeys: Array.isArray(f.segKeys) ? f.segKeys.slice(0, 30).map(k => String(k).slice(0, 40)) : [],
    also: Array.isArray(f.also) ? f.also.filter(r => S2S_SHAPE_R.includes(r)) : [] })) : [];
  return { recs: n(x.recs), segTotal: n(x.segTotal), segBad: n(x.segBad), reasons: Object.fromEntries(S2S_SHAPE_R.map(k => [k, n(R[k])])), runTypes: rt, first, firstOmitted: n(x.firstOmitted) };
}
// JT-20261108-01：拒收的原始交通資料只存本機獨立 IndexedDB「jisu-s2s-sample」（不碰 jisu kv/meta），只留最近一份；綁定這個管理者 session（雜湊），登出就整個刪掉
const S2SS_DB = "jisu-s2s-sample";
const s2ssOwner = async sess => { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("s2ss|" + ((sess && sess.token) || ""))); return [...new Uint8Array(b)].slice(0, 16).map(x => x.toString(16).padStart(2, "0")).join(""); };
function s2ssDb() { return new Promise((res, rej) => { let done = false; const tm = setTimeout(() => { if (!done) { done = true; rej(new Error("瀏覽器資料庫沒有回應")); } }, 3000);
  try { if (!self.indexedDB) throw new Error("這個瀏覽器不能用 IndexedDB"); const r = indexedDB.open(S2SS_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("s")) r.result.createObjectStore("s"); };
    r.onsuccess = () => { if (done) { r.result.close(); return; } done = true; clearTimeout(tm); res(r.result); }; r.onerror = () => { if (!done) { done = true; clearTimeout(tm); rej(r.error || new Error("開不了瀏覽器資料庫")); } }; r.onblocked = () => {};
  } catch (e) { done = true; clearTimeout(tm); rej(e); } }); }
async function s2ssTx(mode, f) { const db = await s2ssDb(); try { return await new Promise((res, rej) => { const t = db.transaction("s", mode), st = t.objectStore("s"); let out; const q = f(st); if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error || new Error("瀏覽器資料庫寫入失敗")); }); } finally { db.close(); } }
async function s2sKeepSample({ c, route, status, diag, raw }, sess) {
  const env = { kind: "jisu-s2s-rejected-sample", notAccepted: true, note: "TDX 原始交通資料，驗證未通過、未採用，只存這台裝置；不是成功資料", savedAt: new Date().toISOString(), city: c, route, httpStatus: status,
    rawAttached: raw.attached === true && "data" in raw, rawChars: diag.raw ? diag.raw.chars : null, rawWhy: diag.raw ? diag.raw.why : null,
    diagnostic: { total: diag.total, drop: diag.drop, shape: diag.shape }, tdx: raw.attached === true && "data" in raw ? raw.data : null };
  const out = { env, saved: false, err: null };
  if (!sess || sess.role !== "admin") { out.err = "不是管理者，未保留"; return out; }
  try { const owner = await s2ssOwner(sess); await s2ssTx("readwrite", st => { st.clear(); return st.put({ owner, env }, "last"); }); out.saved = true; }
  catch (e) { out.err = "本機保存失敗：" + String((e && e.message) || e).slice(0, 80) + "（這頁還能下載，重新整理就會不見）"; }
  return out;
}
async function s2sSampleGet() {
  const sess = getSession(); if (!sess || sess.role !== "admin") return null;
  const owner = await s2ssOwner(sess), v = await s2ssTx("readonly", st => st.get("last"));
  return v && v.owner === owner && v.env && v.env.notAccepted === true ? { env: v.env, saved: true } : null;
}
async function s2sSampleClear() { try { await s2ssTx("readwrite", st => st.clear()); } catch (e) {} try { indexedDB.deleteDatabase(S2SS_DB); } catch (e) {} return true; }
async function s2sPending({ c }) {   // 待匯入表：雲端班表（bsch）裡這個縣市的路線名稱，去掉雲端已有的；只讀，不打 TDX
  const [metaAll, meta] = await Promise.all([authedGet("/bus/sch/meta"), authedGet("/bus/s2s/meta?c=" + enc(c || ""))]);
  const x = await bdCity(c, metaAll);
  if (!x.recs) throw new Error(x.why || "讀不到雲端班表");
  const names = [...new Set(x.recs.map(r => r.n).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
  const none = meta.none || {};   // 已查無（TDX 曾回 200＋空陣列）的也不列
  return { c, total: names.length, pending: names.filter(n => !meta.r[n] && !none[n]), noneN: names.filter(n => !meta.r[n] && none[n]).length, meta };
}
// ---------- JT-20261108-03：雙北站間時間批次匯入（管理者主動開始；逐條串行、間隔≥3秒；可暫停／續跑；進度存 localStorage）----------
// 只匯入雲端還沒有的路線（不送 force）；名單來自雲端班表（s2sPending，不打 TDX）。遇到 401／403／429／寫入額度滿／TDX 錯誤／驗證拒收就停；網路或伺服器不確定時記下那條，續跑前先查雲端。
const S2SB_KEY = "jisu_s2sb", S2SB_LOCK = "jisu_s2sb_lock", S2SB_GAP = 10500, S2SB_STALE = 90000;   // 間隔 10.5 秒：Worker 匯入端點每個管理者 session 每分鐘最多 6 次（≥3 秒的要求也滿足）
let s2sbLive = false, s2sbTabId = Math.random().toString(36).slice(2);
const s2sbLoad = () => { try { const v = JSON.parse(localStorage.getItem(S2SB_KEY)); return v && v.v === 1 ? v : null; } catch (e) { return null; } };
const s2sbSave = st => { st.t = Date.now(); localStorage.setItem(S2SB_KEY, JSON.stringify(st)); return st; };
function s2sbCounts(st) { const n = { ok: 0, skip: 0, nodata: 0, noneSkip: 0, fail: 0 }; for (const k of Object.keys(st.res || {})) { const x = st.res[k]; if (n[x.s] !== undefined) n[x.s]++; } return { ...n, total: st.q.length, left: Math.max(0, st.q.length - st.i) }; }
function s2sBatchGet() {
  const st = s2sbLoad(); if (!st) return null;
  if (st.st === "running" && !s2sbLive) { let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SB_LOCK)); } catch (e) {} if (!lk || Date.now() - lk.t > S2SB_STALE) { st.st = "paused"; st.why = "上次中途離開，已暫停（按續跑）"; s2sbSave(st); } }
  return { ...st, n: s2sbCounts(st), cur: st.q[st.i] || null, live: s2sbLive };
}
async function s2sBatchPrepare({ c }) {   // 建立新批次（不開始跑）：同一城市已有未完成的批次就沿用
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次匯入");
  if (s2sbLive) throw new Error("批次正在執行中");
  const old = s2sbLoad(); if (old && old.c === c && old.i < old.q.length) return s2sBatchGet();
  const p = await s2sPending({ c });
  s2sbSave({ v: 1, c, q: [...new Set(p.pending)], i: 0, res: {}, st: "paused", why: "尚未開始", unc: null, stop: null, made: Date.now(), cityTotal: p.total, had: p.total - p.pending.length });
  return s2sBatchGet();
}
function s2sBatchReset() { if (s2sbLive) throw new Error("批次正在執行中，請先暫停"); localStorage.removeItem(S2SB_KEY); localStorage.removeItem(S2SB_LOCK); return null; }
function s2sBatchSkipCur() {   // 停在驗證拒收那條時，管理者明確選「略過這條」才往下
  const st = s2sbLoad(); if (!st || s2sbLive) return s2sBatchGet(); const nm = st.q[st.i];
  if (nm && st.stop && st.stop.kind === "reject") { st.res[nm] = { s: "fail", m: st.stop.m }; st.i++; st.stop = null; st.why = "已略過「" + nm + "」"; s2sbSave(st); }
  return s2sBatchGet();
}
const s2sbSleep = (ms, stopNow) => new Promise(res => { const t0 = Date.now(); const tk = () => { if (stopNow() || Date.now() - t0 >= ms) return res(); setTimeout(tk, 200); }; tk(); });
// 管理者按「開始／續跑」才呼叫。shouldPause()：畫面要求暫停或 App 進背景時回 true。onTick(state)：每步後通知畫面
async function s2sBatchRun({ shouldPause, onTick } = {}) {
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次匯入");
  if (s2sbLive) return { busy: true };
  let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SB_LOCK)); } catch (e) {}
  if (lk && lk.id !== s2sbTabId && Date.now() - lk.t < S2SB_STALE) return { busy: true, why: "另一個分頁正在跑批次" };
  let st = s2sbLoad(); if (!st) throw new Error("還沒有建立批次");
  s2sbLive = true; const lock = () => localStorage.setItem(S2SB_LOCK, JSON.stringify({ id: s2sbTabId, t: Date.now() }));
  const pz = () => !!(shouldPause && shouldPause()), tick = () => { try { onTick && onTick(s2sBatchGet()); } catch (e) {} };
  try {
    lock(); st.st = "running"; st.why = ""; st.stop = null; s2sbSave(st); tick();
    if (st.unc) {   // 上次不確定有沒有存成功：先查雲端（只讀），有就算成功，不重抓
      let m = null; try { m = await authedGet("/bus/s2s/meta?c=" + enc(st.c)); } catch (e) { st.st = "stopped"; st.stop = { kind: "net", m: "確認上一條時連不到伺服器：" + e.message }; st.why = st.stop.m; s2sbSave(st); tick(); return s2sBatchGet(); }
      if (st.q[st.i] === st.unc && m && m.r && m.r[st.unc]) { st.res[st.unc] = { s: "ok", m: "雲端已有（上次其實已存成功）" }; st.i++; }
      else if (st.q[st.i] === st.unc && m && m.none && m.none[st.unc]) { st.res[st.unc] = { s: "nodata", m: "雲端已記為查無資料（上次其實已記錄）" }; st.i++; }
      st.unc = null; s2sbSave(st); tick();
    }
    let first = true;
    while (st.i < st.q.length) {
      if (pz()) { st.st = "paused"; st.why = "已暫停"; break; }
      if (!first) { await s2sbSleep(S2SB_GAP, pz); if (pz()) { st.st = "paused"; st.why = "已暫停"; break; } }
      first = false; lock();
      const nm = st.q[st.i]; st.unc = nm; s2sbSave(st);
      let r = null, e = null; try { r = await s2sImportOne({ c: st.c, route: nm, force: false }); } catch (x) { e = x; }
      if (r && r.none && r.saved === true) { st.res[nm] = { s: "nodata", m: "TDX 查無資料（已記入雲端）" }; st.unc = null; st.i++; s2sbSave(st); tick(); continue; }
      if (r && r.none && r.skip) { st.res[nm] = { s: "noneSkip", m: r.why || "" }; st.unc = null; st.i++; s2sbSave(st); tick(); continue; }
      if (r && (r.ok === true || r.skip === true)) { st.res[nm] = r.skip ? { s: "skip", m: r.why || "" } : { s: "ok", m: (r.segs ?? "?") + " 段" }; st.unc = null; st.i++; s2sbSave(st); tick(); continue; }
      if (r) { st.st = "stopped"; st.stop = { kind: "uncertain", m: "伺服器回應看不懂", route: nm }; st.why = "「" + nm + "」伺服器回應看不懂；續跑時會先查雲端"; break; }
      const d = e && e.s2s, code = d && d.status;
      if (code === 400) { st.res[nm] = { s: "fail", m: e.message }; st.unc = null; st.i++; s2sbSave(st); tick(); continue; }
      if (code === 404) { st.unc = null; st.st = "stopped"; st.stop = { kind: "reject", m: e.message, route: nm, diag: { ...d, sample: undefined } }; st.why = "「" + nm + "」資料驗證沒通過，已停下（診斷與樣本保留在下面）"; break; }
      if (code && code !== 500) { st.unc = null; st.st = "stopped"; st.stop = { kind: "http" + code, m: e.message, route: nm }; st.why = "「" + nm + "」" + e.message + "，已停下（不換金鑰、不自動重試）"; break; }
      st.st = "stopped"; st.stop = { kind: "uncertain", m: e ? e.message : "不明錯誤", route: nm }; st.why = "「" + nm + "」結果不確定（" + st.stop.m + "）；續跑時會先查雲端"; break;   // unc 保留
    }
    if (st.i >= st.q.length) { st.st = "done"; st.why = "全部處理完"; st.unc = null; }
    s2sbSave(st); tick(); return s2sBatchGet();
  } finally { s2sbLive = false; try { const l = JSON.parse(localStorage.getItem(S2SB_LOCK)); if (l && l.id === s2sbTabId) localStorage.removeItem(S2SB_LOCK); } catch (x) {} }
}
// ---------- JT-20261108-03：站間時間「雲端唯讀」資料層入口（規劃用；只讀雲端，不打 TDX；來源有效期只供參考，不拒讀）----------
const s2sMem = new Map();

async function s2sMetaFetch(proxy, s, c) {
  let r;
  try {
    r = await fetchT(proxy + "/bus/s2s/meta?c=" + enc(c || ""), 30000, { headers: { "x-session": s.token } });
  } catch (e) {
    throw new Error("連不到伺服器，請確認網路");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error(r.status === 401 ? "請重新登入" : (j && j.message) || ("錯誤 " + r.status));
  }
  const meta = await r.json();
  const record = { t: Date.now(), meta };
  await IDB.set("s2sm|" + c, record).catch(() => {});

  // 清單更新後，本機有、但新清單已經沒有任何路線引用的 s2sp|{c}|*，要刪掉
  try {
    const activeP = new Set();
    if (meta && meta.r) {
      for (const item of Object.values(meta.r)) {
        if (item && item.p) activeP.add(item.p);
      }
    }
    const localKeys = await IDB.keys("s2sp|" + c + "|");
    for (const lk of localKeys) {
      const parts = lk.split("|");
      const partId = parts[2];
      if (partId && !activeP.has(partId)) {
        await IDB.del(lk).catch(() => {});
      }
    }
  } catch (e) {}

  return meta;
}

async function s2sDocGet(o) {
  try { return await s2sDocGet1(o, false); }
  catch (e) { if (e && e.s2sBad) return s2sDocGet1(o, true); throw e; }
}

async function s2sDocGet1({ c, route }, retry) {
  const proxy = getProxy(), s = getSession();
  if (!proxy) throw new Error("NO_PROXY");
  if (!s) throw new Error("請重新登入");

  // 1. 清單：IndexedDB s2sm|{c}（存 meta 回應和抓取時間）。超過 10 分鐘，或找不到這條路線時，才重抓 /bus/s2s/meta。
  let cached = await IDB.get("s2sm|" + c).catch(() => null);
  let meta = (cached && cached.meta && (Date.now() - (cached.t || 0) < 600000)) ? cached.meta : null;

  // 如果找不到這條路線（或者快取過期），重新抓取 meta
  if (!meta || (!meta.r?.[route] && !meta.none?.[route] && !meta.rej?.[route])) {
    try { meta = await s2sMetaFetch(proxy, s, c); }
    catch (err) { if (cached && cached.meta) meta = cached.meta; else throw err; }   // Opus：連不上時用本機舊清單（離線也能算）
  }

  // 查無或拒收
  if (meta) {
    if (meta.none && meta.none[route]) return null;
    if (meta.rej && meta.rej[route]) return null;
  }

  const e = meta && meta.r && meta.r[route];
  if (!e) return null; // 路線不在清單中

  let gzBytes = null, packBufRef = null;
  let fromNet = false;

  if (e.p) {
    // 2. 新格式（有 p）：IndexedDB s2sp|{c}|{p} 有就用，沒有就打 /bus/s2s/part 整包存進去。再用 o、n 切出這條路線的 gzip、解壓。
    const packKey = "s2sp|" + c + "|" + e.p;
    let packBuf = retry ? null : await IDB.get(packKey).catch(() => null);
    if (!packBuf) {
      let r;
      try {
        r = await fetchT(proxy + "/bus/s2s/part?c=" + enc(c || "") + "&p=" + enc(e.p), 30000, { headers: { "x-session": s.token } });
      } catch (err) {
        throw new Error("連不到伺服器，請確認網路");
      }
      if (r.status === 404) return null;
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(r.status === 401 ? "請重新登入" : (j && j.message) || ("錯誤 " + r.status));
      }
      packBuf = await r.arrayBuffer();
      await IDB.set(packKey, packBuf).catch(() => {});
      fromNet = true;
    } else {
      fromNet = false;
    }
    // 切片
    packBufRef = packBuf;
    gzBytes = packBuf.slice(e.o, e.o + e.n);
  } else {
    // 3. 舊格式（沒有 p）：沿用 /bus/s2s/route 單條讀取，結果（gzip bytes）存進 IndexedDB s2sr|{c}|{route}|{ver}。下次同 ver 直接用本機。
    const routeKey = "s2sr|" + c + "|" + route + "|" + (e.ver || "");
    gzBytes = retry ? null : await IDB.get(routeKey).catch(() => null);
    if (!gzBytes) {
      // Opus：同一條路線舊 ver 的本機單條資料刪掉
      try { for (const lk of await IDB.keys("s2sr|" + c + "|" + route + "|")) if (lk !== routeKey) await IDB.del(lk).catch(() => {}); } catch (err) {}
      let r;
      try {
        r = await fetchT(proxy + "/bus/s2s/route?c=" + enc(c || "") + "&route=" + enc(route || ""), 30000, { headers: { "x-session": s.token } });
      } catch (err) {
        throw new Error("連不到伺服器，請確認網路");
      }
      if (r.status === 404) return null;
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(r.status === 401 ? "請重新登入" : (j && j.message) || ("錯誤 " + r.status));
      }
      gzBytes = await r.arrayBuffer();
      await IDB.set(routeKey, gzBytes).catch(() => {});
      fromNet = true;
    } else {
      fromNet = false;
    }
  }

  if (!gzBytes) return null;

  // 解壓
  let doc = null;
  try { doc = JSON.parse(await new Response(new Blob([gzBytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()); } catch (err) {}
  if (!doc || (e.ver && doc.ver !== e.ver) || (e.p && gzBytes.byteLength !== e.n)) {
    await IDB.del(e.p ? "s2sp|" + c + "|" + e.p : "s2sr|" + c + "|" + route + "|" + (e.ver || "")).catch(() => {});
    if (!retry) { const bad = new Error("站間時間資料核對不符"); bad.s2sBad = true; throw bad; }
    throw new Error("站間時間資料核對不符");
  }

  // Opus：netBytes＝這次真的從網路下載的大小（新格式是整包，舊格式是單條）；bytes＝這條路線切片大小
  const netBytes = fromNet ? (e.p && packBufRef ? packBufRef.byteLength : gzBytes.byteLength) : 0;
  return { doc, ver: doc.ver || (e && e.ver) || null, partId: e.p || null, bytes: e.n || gzBytes.byteLength, netBytes, fromNet };
}

async function s2sRouteGet(o) {
  // Opus：解壓後 doc.ver 要等於清單的 ver（上傳時的 sha256 前 16 碼）；不符就丟掉本機那份、重抓一次
  try { return await s2sRouteGet1(o, false); }
  catch (e) { if (e && e.s2sBad) return s2sRouteGet1(o, true); throw e; }
}
async function s2sRouteGet1({ c, route }, retry) {
  const k = c + "|" + route;
  if (s2sMem.has(k)) return s2sMem.get(k);

  const res = await s2sDocGet1({ c, route }, retry);
  if (!res || !res.doc) return null;
  const { doc } = res;

  const segs = [];
  for (const x of doc.d || []) {
    for (const t of x.TravelTimes || []) {
      if (t && t.FromStopID != null && typeof t.RunTime === "number") {
        segs.push({
          sub: x.SubRouteUID,
          dir: x.Direction,
          seq: t.Sequence,
          from: t.FromStopID,
          to: t.ToStopID,
          sec: t.RunTime,
          start: t.StartTime,
          end: t.EndTime,
          tag: t.ServiceTag
        });
      }
    }
  }
  const out = { c, route, ver: doc.ver, srcEff: doc.eff || null, srcExp: doc.exp || null, segs, doc };
  s2sMem.set(k, out);
  return out;
}
// ---------- JT-20261108-04：站間時間「本機暫存（先下載到本機、再上傳雲端）」----------
// 1. 本機存放：IndexedDB「jisu-s2s-local」，綁定管理者 session，每條路線一筆：
//    { c, route, kind:"ok"|"empty"|"reject", fetchedAt, httpStatus, ver, routeUIDs:[…], segs, err, raw:<原始陣列>, up:"pending"|"done"|"skip"|"none"|"reject", upAt, upMsg }
const S2SL_DB = "jisu-s2s-local";
const s2slOwner = async sess => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("s2sl|" + ((sess && sess.token) || "")));
  return [...new Uint8Array(b)].slice(0, 16).map(x => x.toString(16).padStart(2, "0")).join("");
};
function s2slDb() {
  return new Promise((res, rej) => {
    let done = false;
    const tm = setTimeout(() => { if (!done) { done = true; rej(new Error("瀏覽器資料庫沒有回應")); } }, 3000);
    try {
      const idb = typeof indexedDB !== "undefined" ? indexedDB : (typeof self !== "undefined" ? self.indexedDB : globalThis.indexedDB);
      if (!idb) throw new Error("這個瀏覽器不能用 IndexedDB");
      const r = idb.open(S2SL_DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("routes")) r.result.createObjectStore("routes");
      };
      r.onsuccess = () => { if (done) { r.result.close(); return; } done = true; clearTimeout(tm); res(r.result); };
      r.onerror = () => { if (!done) { done = true; clearTimeout(tm); rej(r.error || new Error("開不了瀏覽器資料庫")); } };
      r.onblocked = () => {};
    } catch (e) { done = true; clearTimeout(tm); rej(e); }
  });
}
async function s2slTx(mode, f) {
  const db = await s2slDb();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction("routes", mode), st = t.objectStore("routes");
      let out;
      const q = f(st);
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error || new Error("瀏覽器資料庫操作失敗"));
    });
  } finally {
    db.close();
  }
}
async function s2slPut(rec) {
  const sess = getSession();
  if (!sess || sess.role !== "admin") throw new Error("不是管理者，不能存取本機暫存");
  const owner = await s2slOwner(sess);
  const key = `${rec.c}|${rec.route}`;
  return await s2slTx("readwrite", st => st.put({ owner, ...rec }, key));
}
async function s2slGet(c, route) {
  const sess = getSession();
  if (!sess || sess.role !== "admin") return null;
  const owner = await s2slOwner(sess);
  const key = `${c}|${route}`;
  const v = await s2slTx("readonly", st => st.get(key));
  if (!v || v.owner !== owner) return null;
  const { owner: _o, ...rec } = v;
  return rec;
}
async function s2slGetAll(c) {
  const sess = getSession();
  if (!sess || sess.role !== "admin") return {};
  const owner = await s2slOwner(sess);
  const db = await s2slDb();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction("routes", "readonly"), st = t.objectStore("routes");
      const out = {};
      const req = st.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          const v = cursor.value;
          if (v && v.owner === owner && (!c || v.c === c)) {
            const { owner: _o, ...rec } = v;
            out[rec.route] = rec;
          }
          cursor.continue();
        } else {
          res(out);
        }
      };
      req.onerror = () => rej(req.error || new Error("讀取資料失敗"));
    });
  } finally {
    db.close();
  }
}
async function s2slClear() {
  const sess = getSession();
  if (!sess || sess.role !== "admin") throw new Error("只有管理者可以清除本機暫存");
  const owner = await s2slOwner(sess);
  const db = await s2slDb();
  try {
    await new Promise((res, rej) => {
      const t = db.transaction("routes", "readwrite"), st = t.objectStore("routes");
      const req = st.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value && cursor.value.owner === owner) cursor.delete();
          cursor.continue();
        } else {
          res();
        }
      };
      req.onerror = () => rej(req.error || new Error("清除資料失敗"));
    });
    return true;
  } finally {
    db.close();
  }
}
async function s2slCounts(c = "Taipei") {
  const all = await s2slGetAll(c === "all" ? null : c);   // "all"：全部縣市合計（清除前的警告用）
  const items = Object.values(all);
  let ok = 0, empty = 0, reject = 0, cloud = 0, kindOther = 0;
  let upDone = 0, upNone = 0, upRejectCloud = 0, upPending = 0, upSkip = 0, upOther = 0;
  for (const it of items) {
    if (it.kind === "ok") ok++;
    else if (it.kind === "empty") empty++;
    else if (it.kind === "reject") reject++;
    else if (it.kind === "cloud") cloud++;
    else kindOther++;

    if (it.up === "done") upDone++;
    else if (it.up === "none") upNone++;
    else if (it.up === "reject-cloud") upRejectCloud++;
    else if (s2slUpWaiting(it)) upPending++;
    else if (it.up === "skip") upSkip++;
    else upOther++;
  }
  return { total: items.length, ok, empty, reject, cloud, kindOther, upDone, upNone, upRejectCloud, upPending, upSkip, upOther };
}

// 2. 下載批次（只打 /bus/s2s/fetch，下載開放 22 縣市＋公路客運，串行 12 秒）
const S2SL_CITIES = ["Taipei", "NewTaipei"];
const S2SL_DL_CITIES = [
  "Taipei", "NewTaipei", "Keelung", "Taoyuan",
  "Hsinchu", "HsinchuCounty", "MiaoliCounty", "Taichung",
  "ChanghuaCounty", "NantouCounty", "YunlinCounty", "Chiayi",
  "ChiayiCounty", "Tainan", "Kaohsiung", "PingtungCounty",
  "YilanCounty", "HualienCounty", "TaitungCounty", "PenghuCounty",
  "KinmenCounty", "LienchiangCounty", "InterCity"
];
const S2SL_CITY_ZH = {
  Taipei: "臺北市", NewTaipei: "新北市", Keelung: "基隆市", Taoyuan: "桃園市",
  Hsinchu: "新竹市", HsinchuCounty: "新竹縣", MiaoliCounty: "苗栗縣",
  Taichung: "臺中市", ChanghuaCounty: "彰化縣", NantouCounty: "南投縣",
  YunlinCounty: "雲林縣", Chiayi: "嘉義市", ChiayiCounty: "嘉義縣",
  Tainan: "臺南市", Kaohsiung: "高雄市", PingtungCounty: "屏東縣",
  YilanCounty: "宜蘭縣", HualienCounty: "花蓮縣", TaitungCounty: "臺東縣",
  PenghuCounty: "澎湖縣", KinmenCounty: "金門縣", LienchiangCounty: "連江縣",
  InterCity: "公路客運"
};
const s2slUpCityOk = c => { if (!S2SL_DL_CITIES.includes(c)) throw new Error("這個縣市不在上傳清單"); };
const s2slCityOk = s2slUpCityOk;
const s2slDlCityOk = c => { if (!S2SL_DL_CITIES.includes(c)) throw new Error("這個縣市不在下載清單"); };
function s2sRouteOk(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  return n === name && n.length >= 1 && n.length <= 30 && /^[\p{L}\p{N}\-()（）]+$/u.test(n);
}
const S2SL_DL_GAP = 12000, S2SL_UP_GAP = 10500, S2SL_SEAL_GAP = 2000;
const S2SL_DL_LOCK = "jisu_s2sl_dl_lock", S2SL_UP_LOCK = "jisu_s2sl_up_lock";
let s2slDlLive = false, s2slDlTabId = Math.random().toString(36).slice(2);
let s2slUpLive = false, s2slUpTabId = Math.random().toString(36).slice(2);

function s2slMigrateOnce() {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("jisu_s2sl_mig") === "1") return;
    const rawDl = localStorage.getItem("jisu_s2sl_dl");
    if (rawDl) {
      try {
        const v = JSON.parse(rawDl);
        if (v && v.v === 1 && v.c && S2SL_DL_CITIES.includes(v.c)) {
          const targetKey = "jisu_s2sl_dl:" + v.c;
          if (!localStorage.getItem(targetKey)) {
            localStorage.setItem(targetKey, rawDl);
            if (!localStorage.getItem("jisu_s2sl_dl_cur")) {
              localStorage.setItem("jisu_s2sl_dl_cur", v.c);
            }
          }
        }
      } catch (e) {}
    }
    const rawUp = localStorage.getItem("jisu_s2sl_up");
    if (rawUp) {
      try {
        const v = JSON.parse(rawUp);
        if (v && v.v === 1 && v.c && S2SL_DL_CITIES.includes(v.c)) {
          const targetKey = "jisu_s2sl_up:" + v.c;
          if (!localStorage.getItem(targetKey)) {
            localStorage.setItem(targetKey, rawUp);
            if (!localStorage.getItem("jisu_s2sl_up_cur")) {
              localStorage.setItem("jisu_s2sl_up_cur", v.c);
            }
          }
        }
      } catch (e) {}
    }
    localStorage.setItem("jisu_s2sl_mig", "1");
  } catch (e) {}
}
s2slMigrateOnce();

function s2slDlCurCity(c) {
  if (c && typeof c === "string") {
    try { localStorage.setItem("jisu_s2sl_dl_cur", c); } catch (e) {}
    return c;
  }
  let cur = null;
  try { cur = localStorage.getItem("jisu_s2sl_dl_cur"); } catch (e) {}
  return cur || "Taipei";
}

function s2slUpCurCity(c) {
  if (c && typeof c === "string") {
    try { localStorage.setItem("jisu_s2sl_up_cur", c); } catch (e) {}
    return c;
  }
  let cur = null;
  try { cur = localStorage.getItem("jisu_s2sl_up_cur"); } catch (e) {}
  return cur || "Taipei";
}

const s2slDlLoad = (c) => {
  s2slMigrateOnce();
  const city = c || s2slDlCurCity();
  try {
    const v = JSON.parse(localStorage.getItem("jisu_s2sl_dl:" + city));
    return v && v.v === 1 ? v : null;
  } catch (e) { return null; }
};

const s2slDlSave = (st, c) => {
  s2slMigrateOnce();
  const city = c || (st && st.c) || s2slDlCurCity();
  st.t = Date.now();
  localStorage.setItem("jisu_s2sl_dl:" + city, JSON.stringify(st));
  return st;
};

const s2slUpLoad = (c) => {
  s2slMigrateOnce();
  const city = c || s2slUpCurCity();
  try {
    const v = JSON.parse(localStorage.getItem("jisu_s2sl_up:" + city));
    return v && v.v === 1 ? v : null;
  } catch (e) { return null; }
};

const s2slUpSave = (st, c) => {
  s2slMigrateOnce();
  const city = c || (st && st.c) || s2slUpCurCity();
  st.t = Date.now();
  localStorage.setItem("jisu_s2sl_up:" + city, JSON.stringify(st));
  return st;
};

function s2sLocalDlBatchOpen() {
  s2slMigrateOnce();
  const open = [];
  for (const c of S2SL_DL_CITIES) {
    const st = s2slDlLoad(c);
    if (st && st.st !== "done" && Array.isArray(st.q) && st.i < st.q.length) {
      open.push(c);
    }
  }
  return open;
}

function s2sLocalUpBatchOpen() {
  s2slMigrateOnce();
  const open = [];
  for (const c of S2SL_DL_CITIES) {
    const st = s2slUpLoad(c);
    if (st && st.st !== "done" && Array.isArray(st.q) && st.i < st.q.length) {
      open.push(c);
    }
  }
  return open;
}

function s2sLocalDlBatchGet(arg = {}) {
  const c = typeof arg === "string" ? arg : (arg && arg.c);
  const city = c || s2slDlCurCity();
  const st = s2slDlLoad(city); if (!st) return null;
  if (st.st === "running" && !s2slDlLive) {
    let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SL_DL_LOCK)); } catch (e) {}
    if (!lk || Date.now() - lk.t > 90000) { st.st = "paused"; st.why = "上次中途離開，已暫停（按續跑）"; s2slDlSave(st, city); }
  }
  const n = { ok: 0, empty: 0, reject: 0, skip: 0, fail: 0 };
  for (const k of Object.keys(st.res || {})) { const x = st.res[k]; if (n[x.s] !== undefined) n[x.s]++; }
  return { ...st, n: { ...n, total: st.q.length, left: Math.max(0, st.q.length - st.i) }, cur: st.q[st.i] || null, live: s2slDlLive };
}

async function s2sLocalDlBatchPrepare({ c = "Taipei" } = {}) {
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次下載");
  s2slDlCityOk(c);
  if (s2slDlLive) throw new Error("下載批次正在執行中");
  const openCities = s2sLocalDlBatchOpen();
  const otherOpen = openCities.find(oc => oc !== c);
  if (otherOpen) throw new Error((S2SL_CITY_ZH[otherOpen] || otherOpen) + "的下載批次還沒跑完，請先跑完或清掉下載進度");
  const old = s2slDlLoad(c);
  if (old && old.c === c && old.i < old.q.length) {
    s2slDlCurCity(c);
    return s2sLocalDlBatchGet({ c });
  }
  const p = await s2sPending({ c });
  const localMap = await s2slGetAll(c);
  const pending = p.pending.filter(n => !localMap[n]);
  const valid = [], bad = [];
  for (const n of pending) {
    if (s2sRouteOk(n)) valid.push(n);
    else bad.push(n);
  }
  const badNames = bad.length ? { count: bad.length, total: bad.length, names: bad.slice(0, 20), list: bad.slice(0, 20) } : null;
  s2slDlCurCity(c);
  s2slDlSave({
    v: 1, c, q: [...new Set(valid)], i: 0, res: {}, st: "paused", why: "尚未開始",
    unc: null, stop: null, made: Date.now(), cityTotal: p.total, had: p.total - pending.length,
    badNames, lastReject: null, rejNames: []
  }, c);
  return s2sLocalDlBatchGet({ c });
}

function s2sLocalDlBatchReset(arg = {}) {
  const c = typeof arg === "string" ? arg : (arg && arg.c);
  if (s2slDlLive) throw new Error("下載批次正在執行中，請先暫停");
  const cur = s2slDlCurCity();
  const curSt = s2slDlLoad(cur);
  if (c && !s2slDlLoad(c) && curSt && curSt.st !== "done" && curSt.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "，請切回" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "再操作");
  const targetCity = c || cur;
  const st = s2slDlLoad(targetCity);
  if (st && c && st.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[st.c] || st.c) + "，請切回" + (S2SL_CITY_ZH[st.c] || st.c) + "再操作");
  localStorage.removeItem("jisu_s2sl_dl:" + targetCity);
  localStorage.removeItem(S2SL_DL_LOCK);
  return null;
}

function s2sLocalDlBatchSkipCur(arg = {}) {
  const c = typeof arg === "string" ? arg : (arg && arg.c);
  const cur = s2slDlCurCity();
  const curSt = s2slDlLoad(cur);
  if (c && !s2slDlLoad(c) && curSt && curSt.st !== "done" && curSt.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "，請切回" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "再操作");
  const targetCity = c || cur;
  const st = s2slDlLoad(targetCity); if (!st || s2slDlLive) return s2sLocalDlBatchGet({ c: targetCity });
  if (c && st.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[st.c] || st.c) + "，請切回" + (S2SL_CITY_ZH[st.c] || st.c) + "再操作");
  const nm = st.q[st.i];
  if (nm && st.stop && st.stop.kind === "reject") {
    st.res[nm] = { s: "reject", m: st.stop.m };
    st.i++; st.stop = null; st.why = "已略過「" + nm + "」";
    s2slDlSave(st, targetCity);
  }
  return s2sLocalDlBatchGet({ c: targetCity });
}

async function s2sLocalDlBatchRun({ c, shouldPause, onTick, gap } = {}) {
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次下載");
  if (s2slDlLive) return { busy: true };
  let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SL_DL_LOCK)); } catch (e) {}
  if (lk && lk.id !== s2slDlTabId && Date.now() - lk.t < 90000) return { busy: true, why: "另一個分頁正在跑下載批次" };
  const cur = s2slDlCurCity();
  const curSt = s2slDlLoad(cur);
  if (c && !s2slDlLoad(c) && curSt && curSt.st !== "done" && curSt.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "，請切回" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "再操作");
  const targetCity = c || cur;
  let st = s2slDlLoad(targetCity); if (!st) throw new Error("還沒有建立下載批次");
  if (c && st.c !== c) throw new Error("下載進度屬於" + (S2SL_CITY_ZH[st.c] || st.c) + "，請切回" + (S2SL_CITY_ZH[st.c] || st.c) + "再操作");
  s2slDlCurCity(st.c);
  s2slDlCityOk(st.c);

  s2slDlLive = true;
  const lock = () => localStorage.setItem(S2SL_DL_LOCK, JSON.stringify({ id: s2slDlTabId, t: Date.now() }));
  const pz = () => !!(shouldPause && shouldPause()), tick = () => { try { onTick && onTick(s2sLocalDlBatchGet({ c: st.c })); } catch (e) {} };
  const waitMs = typeof gap === "number" ? gap : S2SL_DL_GAP;

  try {
    lock(); st.st = "running"; st.why = ""; st.stop = null; s2slDlSave(st, st.c); tick();
    if (st.unc) {
      const rec = await s2slGet(st.c, st.unc);
      if (rec) {
        st.res[st.unc] = { s: rec.kind, m: "本機已存" };
        st.i++;
      }
      st.unc = null; s2slDlSave(st, st.c); tick();
    }
    let first = true;
    while (st.i < st.q.length) {
      if (pz()) { st.st = "paused"; st.why = "已暫停"; break; }
      if (!first) { await s2sbSleep(waitMs, pz); if (pz()) { st.st = "paused"; st.why = "已暫停"; break; } }
      first = false; lock();
      const nm = st.q[st.i]; st.unc = nm; s2slDlSave(st, st.c);
      const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");

      const existing = await s2slGet(st.c, nm);
      if (existing) {
        st.res[nm] = { s: existing.kind, m: "本機已存" };
        st.unc = null;
        st.i++;
        s2slDlSave(st, st.c);
        tick();
        continue;
      }

      let r = null, j = null, netErr = null;
      try {
        r = await fetchT(proxy + "/bus/s2s/fetch?c=" + enc(st.c) + "&route=" + enc(nm), 30000, {
          method: "POST",
          headers: { "x-session": sess.token }
        });
        j = await r.json().catch(() => null);
      } catch (e) {
        netErr = e;
      }

      if (netErr) {
        st.st = "stopped";
        st.stop = { kind: "net", m: "連線錯誤：" + (netErr.message || netErr), route: nm };
        st.why = "「" + nm + "」連線錯誤（" + st.stop.m + "）；續跑時會先查本機";
        break;
      }

      if (!r.ok) {
        const code = r.status, msg = (j && j.message) || ("HTTP " + code);
        st.unc = null;
        if (code === 401) {
          st.st = "stopped"; st.stop = { kind: "http401", m: "請重新登入", route: nm };
          st.why = "登入已逾期，請重新登入";
          break;
        }
        if (code === 403 || code === 429) {
          st.st = "stopped"; st.stop = { kind: "http" + code, m: msg, route: nm };
          st.why = "「" + nm + "」" + msg + (/不自動重試/.test(msg) ? "" : "，已停下（不換金鑰、不自動重試）");
          break;
        }
        if (code === 502 || code >= 500) {
          st.st = "stopped"; st.stop = { kind: "http" + code, m: msg, route: nm };
          st.why = "「" + nm + "」TDX 錯誤（" + msg + "），已停下";
          break;
        }
        st.st = "stopped"; st.stop = { kind: "http" + code, m: msg, route: nm };
        st.why = "「" + nm + "」錯誤（" + msg + "），已停下";
        break;
      }

      if (j && j.cloudHas === true) {
        await s2slPut({
          c: st.c, route: nm, kind: "cloud", fetchedAt: j.fetchedAt || new Date().toISOString(),
          httpStatus: 200, ver: j.ver || null, routeUIDs: j.routes || [], segs: j.segs || 0,
          err: null, raw: [], up: "skip", upAt: new Date().toISOString(), upMsg: "雲端已有資料"
        });
        st.res[nm] = { s: "skip", m: "雲端已有略過" };
        st.unc = null; st.i++; s2slDlSave(st, st.c); tick();
        continue;
      }

      if (j && j.kind === "ok" && !(Array.isArray(j.raw) && j.raw.length)) {
        st.st = "stopped"; st.stop = { kind: "uncertain", m: "回應缺原始資料", route: nm };
        st.why = "「" + nm + "」伺服器回應缺原始資料，沒有存；續跑時會先查本機"; break;
      }
      if (j && j.kind === "ok") {
        await s2slPut({
          c: st.c, route: nm, kind: "ok", fetchedAt: j.fetchedAt || new Date().toISOString(),
          httpStatus: 200, ver: j.ver || null, routeUIDs: j.routes || [], segs: j.segs || 0,
          err: null, raw: j.raw || [], up: "pending", upAt: null, upMsg: null
        });
        st.res[nm] = { s: "ok", m: (j.segs ?? "?") + " 段" };
        st.unc = null; st.i++; s2slDlSave(st, st.c); tick();
        continue;
      }

      if (j && j.kind === "empty") {
        await s2slPut({
          c: st.c, route: nm, kind: "empty", fetchedAt: j.fetchedAt || new Date().toISOString(),
          httpStatus: 200, ver: null, routeUIDs: [], segs: 0,
          err: null, raw: [], up: "pending", upAt: null, upMsg: null
        });
        st.res[nm] = { s: "empty", m: "查無資料" };
        st.unc = null; st.i++; s2slDlSave(st, st.c); tick();
        continue;
      }

      if (j && j.kind === "reject") {
        await s2slPut({
          c: st.c, route: nm, kind: "reject", fetchedAt: j.fetchedAt || new Date().toISOString(),
          httpStatus: 200, ver: null, routeUIDs: [], segs: null,
          err: j.err || "資料驗證沒通過", raw: j.raw || [], up: "reject", upAt: null, upMsg: j.err
        });
        st.res[nm] = { s: "reject", m: j.err || "資料驗證沒通過" };
        if (!Array.isArray(st.rejNames)) st.rejNames = [];
        if (st.rejNames.length < 200) st.rejNames.push(nm);
        st.lastReject = {
          route: nm,
          err: j.err || "資料驗證沒通過",
          diag: { ...s2sDiag(200, { ...j, raw: undefined }), localRaw: Array.isArray(j.raw) ? j.raw.length : null }
        };
        st.unc = null;
        st.i++;
        s2slDlSave(st, st.c);
        tick();
        continue;
      }

      st.st = "stopped"; st.stop = { kind: "uncertain", m: "伺服器回應看不懂", route: nm };
      st.why = "「" + nm + "」伺服器回應看不懂；續跑時會先查本機";
      break;
    }
    if (st.i >= st.q.length) { st.st = "done"; st.why = "下載完成"; st.unc = null; }
    s2slDlSave(st, st.c); tick(); return s2sLocalDlBatchGet({ c: st.c });
  } finally {
    s2slDlLive = false;
    try { const l = JSON.parse(localStorage.getItem(S2SL_DL_LOCK)); if (l && l.id === s2slDlTabId) localStorage.removeItem(S2SL_DL_LOCK); } catch (x) {}
  }
}

// BRIEF-gemini-2: Base64 / Binary helpers for pack & seal
const enc8 = new TextEncoder();
function b64(u8) {
  let s = "";
  const CHUNK = 32768;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function ub64(b64str) {
  if (!b64str) return new Uint8Array(0);
  const s = atob(b64str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

const S2SL_CITY_PREFIX = {
  Taipei: "TPE", NewTaipei: "NWT", Keelung: "KEE", Taoyuan: "TAO",
  Hsinchu: "HSZ", HsinchuCounty: "HSQ", MiaoliCounty: "MIA",
  Taichung: "TXG", ChanghuaCounty: "CHA", NantouCounty: "NAN",
  YunlinCounty: "YUN", Chiayi: "CYI", ChiayiCounty: "CYQ",
  Tainan: "TNN", Kaohsiung: "KHH", PingtungCounty: "PIF",
  YilanCounty: "ILA", HualienCounty: "HUA", TaitungCounty: "TTT",
  PenghuCounty: "PEN", KinmenCounty: "KIN", LienchiangCounty: "LIE",
  InterCity: "THB"
};

function s2sCheckClient(c, name, arr) {
  const pre = S2SL_CITY_PREFIX[c] || c;
  if (!Array.isArray(arr)) return { err: "TDX 回傳不是陣列" };
  const zh = x => typeof x === "string" ? x : (x && (x.Zh_tw || x.zh_tw)) || "";
  const ymd = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[1] + m[2] + m[3] : null; };
  const idOk = v => (typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isFinite(v));
  function originIdx(T) {
    const out = new Set(), seen = new Set();
    T.forEach((t, i) => {
      if (!t || typeof t !== "object" || Array.isArray(t) || t.Sequence !== 1 || "FromStopID" in t || "RunTime" in t || !idOk(t.ToStopID)) return;
      const k = JSON.stringify([t.ServiceTag ?? null, t.StartTime ?? null, t.EndTime ?? null]);
      if (seen.has(k)) return; seen.add(k); out.add(i);
    });
    return out;
  }
  const segOk = t => t && t.FromStopID != null && t.ToStopID != null && typeof t.RunTime === "number";

  const keep = [], drop = { name: 0, city: 0, shape: 0 };
  for (let ri = 0; ri < arr.length; ri++) {
    const x = arr[ri];
    if (!x || zh(x.RouteName) !== name) { drop.name++; continue; }
    if (!String(x.RouteUID || "").startsWith(pre)) { drop.city++; continue; }
    const T = x.TravelTimes;
    const O = Array.isArray(T) ? originIdx(T) : null;
    if (!Array.isArray(T) || !T.length || O.size === T.length || !T.every((t, i) => O.has(i) || segOk(t))) {
      drop.shape++; continue;
    }
    keep.push(x);
  }
  if (!keep.length) return { err: arr.length ? "TDX 有回資料，但沒有符合這條路線／縣市／欄位的筆" : "TDX 沒有這條路線的站間時間", drop, total: arr.length };
  const effs = new Set(keep.map(x => ymd(x.EffectiveDate))), exps = new Set(keep.map(x => ymd(x.ExpireDate))), uis = new Set(keep.map(x => x.UpdateInterval ?? null));
  const expL = [...exps].filter(Boolean).sort();
  return {
    keep, drop, total: arr.length,
    eff: effs.size === 1 ? [...effs][0] : null,
    exp: expL.length === keep.length || exps.size === 1 ? expL[0] || null : null,
    ui: uis.size === 1 ? [...uis][0] : null,
    mixed: effs.size > 1 || exps.size > 1 || uis.size > 1,
    routes: [...new Set(keep.map(x => x.RouteUID))],
    subs: keep.length,
    origins: keep.reduce((a, x) => a + originIdx(x.TravelTimes).size, 0),
    segs: keep.reduce((a, x) => { const O = originIdx(x.TravelTimes); return a + x.TravelTimes.length - O.size; }, 0),
    neg: keep.reduce((a, x) => { const O = originIdx(x.TravelTimes); return a + x.TravelTimes.filter((t, i) => !O.has(i) && t.RunTime < 0).length; }, 0)
  };
}

async function gzCompress(data) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(typeof data === "string" ? enc8.encode(data) : data);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  let len = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    len += value.byteLength;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function s2sSha256(str) {
  const b = await crypto.subtle.digest("SHA-256", enc8.encode(str));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// 3. 上傳批次（兩階段：封存 /bus/s2s/seal → 打包 /bus/s2s/pack，絕不打 TDX，間隔 10.5 秒）
// 審查修正：下載拒收的紀錄存成 up:"reject"（還沒上傳），也要上傳到雲端的拒收紀錄（x）；上傳後變 "reject-cloud"
const s2slUpWaiting = rec => !!rec && (rec.up === "pending" || (rec.kind === "reject" && rec.up === "reject"));
function s2sLocalUpBatchGet(arg = {}) {
  const c = typeof arg === "string" ? arg : (arg && arg.c);
  const city = c || s2slUpCurCity();
  const st = s2slUpLoad(city); if (!st) return null;
  if (st.st === "running" && !s2slUpLive) {
    let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SL_UP_LOCK)); } catch (e) {}
    if (!lk || Date.now() - lk.t > 90000) { st.st = "paused"; st.why = "上次中途離開，已暫停（按續跑）"; s2slUpSave(st, city); }
  }
  const n = { ok: 0, none: 0, skip: 0, reject: 0, fail: 0, sealed: 0, packed: 0 };
  for (const k of Object.keys(st.res || {})) {
    const x = st.res[k];
    if (x.s === "ok") { n.ok++; n.packed++; }
    else if (x.s === "none") { n.none++; n.packed++; }
    else if (x.s === "reject") { n.reject++; n.packed++; }
    else if (x.s === "skip") { n.skip++; }
    else if (x.s === "sealed") { n.sealed++; }
    else if (x.s === "fail") { n.fail++; }
  }
  const doneCount = n.packed + n.skip;
  const left = Math.max(0, st.q.length - doneCount);
  return {
    ...st,
    n: { ...n, total: st.q.length, left },
    cur: st.q[st.i] || null,
    phase: st.phase || "seal",
    live: s2slUpLive
  };
}

async function s2sLocalUpBatchPrepare({ c = "Taipei" } = {}) {
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次上傳");
  s2slUpCityOk(c);
  if (s2slUpLive) throw new Error("上傳批次正在執行中");
  const openCities = s2sLocalUpBatchOpen();
  const otherOpen = openCities.find(oc => oc !== c);
  if (otherOpen) throw new Error((S2SL_CITY_ZH[otherOpen] || otherOpen) + "的上傳批次還沒跑完，請先跑完或清掉上傳進度");
  const old = s2slUpLoad(c);
  if (old && old.c === c && old.st !== "done" && old.i < old.q.length) {
    s2slUpCurCity(c);
    return s2sLocalUpBatchGet({ c });
  }
  const localMap = await s2slGetAll(c);
  const q = Object.values(localMap)
    .filter(it => (it.kind === "ok" || it.kind === "empty" || it.kind === "reject") && s2slUpWaiting(it))
    .map(it => it.route);
  s2slUpCurCity(c);
  s2slUpSave({
    v: 1, c, q: [...new Set(q)], i: 0, phase: "seal",
    res: {}, st: "paused", why: "尚未開始", unc: null, stop: null, made: Date.now()
  }, c);
  return s2sLocalUpBatchGet({ c });
}

function s2sLocalUpBatchReset(arg = {}) {
  const c = typeof arg === "string" ? arg : (arg && arg.c);
  if (s2slUpLive) throw new Error("上傳批次正在執行中，請先暫停");
  const cur = s2slUpCurCity();
  const curSt = s2slUpLoad(cur);
  if (c && !s2slUpLoad(c) && curSt && curSt.st !== "done" && curSt.c !== c) throw new Error("上傳進度屬於" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "，請切回" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "再操作");
  const targetCity = c || cur;
  const st = s2slUpLoad(targetCity);
  if (st && c && st.c !== c) throw new Error("上傳進度屬於" + (S2SL_CITY_ZH[st.c] || st.c) + "，請切回" + (S2SL_CITY_ZH[st.c] || st.c) + "再操作");
  localStorage.removeItem("jisu_s2sl_up:" + targetCity);
  localStorage.removeItem(S2SL_UP_LOCK);
  return null;
}

async function s2sLocalUpBatchRun({ c, shouldPause, onTick, gap } = {}) {
  const sess = getSession(); if (!sess || sess.role !== "admin") throw new Error("只有管理者可以批次上傳");
  if (s2slUpLive) return { busy: true };
  let lk = null; try { lk = JSON.parse(localStorage.getItem(S2SL_UP_LOCK)); } catch (e) {}
  if (lk && lk.id !== s2slUpTabId && Date.now() - lk.t < 90000) return { busy: true, why: "另一個分頁正在跑上傳批次" };
  const cur = s2slUpCurCity();
  const curSt = s2slUpLoad(cur);
  if (c && !s2slUpLoad(c) && curSt && curSt.st !== "done" && curSt.c !== c) throw new Error("上傳進度屬於" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "，請切回" + (S2SL_CITY_ZH[curSt.c] || curSt.c) + "再操作");
  const targetCity = c || cur;
  let st = s2slUpLoad(targetCity); if (!st) throw new Error("還沒有建立上傳批次");
  if (c && st.c !== c) throw new Error("上傳進度屬於" + (S2SL_CITY_ZH[st.c] || st.c) + "，請切回" + (S2SL_CITY_ZH[st.c] || st.c) + "再操作");
  s2slUpCurCity(st.c);
  s2slUpCityOk(st.c);

  s2slUpLive = true;
  const lock = () => localStorage.setItem(S2SL_UP_LOCK, JSON.stringify({ id: s2slUpTabId, t: Date.now() }));
  const pz = () => !!(shouldPause && shouldPause()), tick = () => { try { onTick && onTick(s2sLocalUpBatchGet({ c: st.c })); } catch (e) {} };
  const waitMs = typeof gap === "number" ? gap : S2SL_UP_GAP;

  try {
    lock(); st.st = "running"; st.why = ""; st.stop = null; s2slUpSave(st, st.c); tick();

    // 檢查上次打包是否遇連線不確定：續跑前先讀 /bus/s2s/meta
    if (st.unc) {
      let m = null;
      try {
        const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
        const mr = await fetchT(proxy + "/bus/s2s/meta?c=" + enc(st.c), 30000, {
          headers: { "x-session": sess.token }
        });
        m = await mr.json();
      } catch (e) {
        st.st = "stopped"; st.stop = { kind: "net", m: "確認上傳狀態時連不到伺服器：" + e.message };
        st.why = st.stop.m; s2slUpSave(st, st.c); tick(); return s2sLocalUpBatchGet({ c: st.c });
      }
      if (m) {
        const allLocal = await s2slGetAll(st.c);
        for (const nm of Object.keys(allLocal)) {
          const rec = allLocal[nm];
          if (!s2slUpWaiting(rec)) continue;
          if (m.r && m.r[nm]) {
            rec.up = "done"; rec.upAt = new Date().toISOString(); rec.upMsg = "雲端已有資料";
            await s2slPut(rec);
            st.res[nm] = { s: "ok", m: "已上傳" };
          } else if (m.none && m.none[nm]) {
            rec.up = "none"; rec.upAt = new Date().toISOString(); rec.upMsg = "雲端已記錄查無";
            await s2slPut(rec);
            st.res[nm] = { s: "none", m: "查無記錄" };
          } else if (m.rej && m.rej[nm]) {
            rec.up = "reject-cloud"; rec.upAt = new Date().toISOString(); rec.upMsg = m.rej[nm];
            await s2slPut(rec);
            st.res[nm] = { s: "reject", m: "雲端拒收記錄" };
          }
        }
      }
      st.unc = null; s2slUpSave(st, st.c); tick();
    }

    st.phase = st.phase || "seal";
    let first = true;

    // 階段 1：封存 (Seal)
    if (st.phase === "seal") {
      const sealWaitMs = typeof gap === "number" ? gap : S2SL_SEAL_GAP;
      while (st.i < st.q.length) {
        if (pz()) { st.st = "paused"; st.why = "已暫停"; break; }

        let batchItems = [];
        let batchRawSizeTotal = 0;
        let scanIdx = st.i;

        while (scanIdx < st.q.length) {
          const nm = st.q[scanIdx];
          const rec = await s2slGet(st.c, nm);
          if (!s2slUpWaiting(rec)) {
            if (batchItems.length === 0) {
              st.i++;
              scanIdx++;
              continue;
            } else {
              break;
            }
          }
          if (rec.kind === "ok" && (!Array.isArray(rec.raw) || rec.raw.length === 0)) {
            st.unc = null; st.st = "stopped"; st.stop = { kind: "local", m: "本機資料不完整", route: nm };
            st.why = "「" + nm + "」本機資料不完整（狀態和原始資料對不上），沒有上傳，已停下";
            s2slUpSave(st, st.c); tick();
            break;
          }
          if (rec.seal) {
            st.res[nm] = { s: "sealed", m: rec.seal.kind === "ok" ? "已封存" : rec.seal.kind === "none" ? "已封存（查無）" : "已封存（拒收）" };
            if (batchItems.length === 0) {
              st.i++;
              scanIdx++;
              continue;
            } else {
              break;
            }
          }

          let prepared = null;
          if (rec.kind === "empty") {
            prepared = {
              route: nm,
              kind: "none",
              len: 0,
              drop: 0,
              total: 0,
              gzBytes: new Uint8Array(0),
              rawDocSize: 2,
              rec
            };
          } else if (rec.kind === "ok") {
            const rawArr = rec.raw;
            if (!Array.isArray(rawArr) || rawArr.length === 0) {
              st.unc = null; st.st = "stopped"; st.stop = { kind: "local", m: "本機資料不完整", route: nm };
              st.why = "「" + nm + "」本機資料不完整（狀態和原始資料對不上），沒有上傳，已停下";
              s2slUpSave(st, st.c); tick();
              break;
            }
            const ck = s2sCheckClient(st.c, nm, rawArr);
            if (ck.err) {
              st.unc = null; st.st = "stopped"; st.stop = { kind: "local", m: ck.err, route: nm };
              st.why = "「" + nm + "」本機檢核未通過（" + ck.err + "），沒有上傳，已停下";
              s2slUpSave(st, st.c); tick();
              break;
            }
            const rawJsonStr = JSON.stringify(rawArr);
            const ver = (await s2sSha256(rawJsonStr)).slice(0, 16);
            const doc = {
              v: 1,
              src: "TDX premium V3 Map/Estimation/Bus/S2STravelTime（歷史推估，不是表定）",
              c: st.c,
              name: nm,
              t: Date.now(),
              ft: rec.fetchedAt || null,
              via: "pack",
              ver,
              eff: ck.eff,
              exp: ck.exp,
              ui: ck.ui,
              d: ck.keep
            };
            const docJsonStr = JSON.stringify(doc);
            const gzBytes = await gzCompress(docJsonStr);
            const dropCount = (ck.drop ? (ck.drop.name || 0) + (ck.drop.city || 0) + (ck.drop.shape || 0) : 0);
            prepared = {
              route: nm,
              kind: "ok",
              len: gzBytes.length,
              drop: dropCount,
              total: ck.total || rawArr.length,
              gzBytes,
              rawDocSize: enc8.encode(docJsonStr).length,
              rec
            };
          } else if (rec.kind === "reject") {
            const rawArr = rec.raw || [];
            const ck = s2sCheckClient(st.c, nm, rawArr);
            const doc = {
              v: 1,
              src: "TDX premium V3 Map/Estimation/Bus/S2STravelTime（歷史推估，不是表定）",
              c: st.c,
              name: nm,
              t: Date.now(),
              ft: rec.fetchedAt || null,
              via: "pack-reject",
              err: rec.err || ck.err || "檢核失敗",
              drop: ck.drop,
              total: ck.total || rawArr.length,
              d: rawArr
            };
            const docJsonStr = JSON.stringify(doc);
            const gzBytes = await gzCompress(docJsonStr);
            prepared = {
              route: nm,
              kind: "reject",
              len: gzBytes.length,
              drop: ck.drop,
              total: ck.total || rawArr.length,
              gzBytes,
              rawDocSize: enc8.encode(docJsonStr).length,
              rec
            };
          }

          if (prepared) {
            if (prepared.rawDocSize > 1024 * 1024) {
              if (batchItems.length > 0) {
                break;
              } else {
                batchItems.push(prepared);
                scanIdx++;
                break;
              }
            }
            if (batchItems.length > 0 && (batchRawSizeTotal + prepared.rawDocSize > 1024 * 1024 || batchItems.length >= 50)) {
              break;
            }
            batchItems.push(prepared);
            batchRawSizeTotal += prepared.rawDocSize;
            scanIdx++;
          } else {
            scanIdx++;
          }
        }

        if (st.st === "stopped") break;

        if (batchItems.length === 0) {
          s2slUpSave(st, st.c); tick();
          continue;
        }

        if (!first) { await s2sbSleep(sealWaitMs, pz); if (pz()) { st.st = "paused"; st.why = "已暫停"; break; } }
        first = false; lock();

        const headerObj = {
          v: 2,
          c: st.c,
          items: batchItems.map(x => ({
            route: x.route,
            kind: x.kind,
            len: x.len,
            drop: x.drop,
            total: x.total
          }))
        };
        const headerBytes = enc8.encode(JSON.stringify(headerObj));
        let totalGzLen = 0;
        for (const it of batchItems) totalGzLen += it.len;

        const bodyBuf = new Uint8Array(4 + headerBytes.length + totalGzLen);
        const dv = new DataView(bodyBuf.buffer);
        dv.setUint32(0, headerBytes.length);
        bodyBuf.set(headerBytes, 4);

        let curGzOff = 4 + headerBytes.length;
        for (const it of batchItems) {
          if (it.len > 0) {
            bodyBuf.set(it.gzBytes, curGzOff);
            curGzOff += it.len;
          }
        }

        const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
        let r = null, j = null, netErr = null;
        try {
          r = await fetchT(proxy + "/bus/s2s/seal?c=" + enc(st.c), 60000, {
            method: "POST",
            headers: {
              "x-session": sess.token,
              "content-type": "application/octet-stream"
            },
            body: bodyBuf
          });
          j = await r.json().catch(() => null);
        } catch (e) {
          netErr = e;
        }

        if (netErr) {
          st.st = "stopped";
          st.stop = { kind: "net", m: "連線錯誤：" + (netErr.message || netErr) };
          st.why = "封存時連線錯誤（" + st.stop.m + "）；續跑時會先查本機";
          s2slUpSave(st, st.c); tick();
          break;
        }

        if (!r.ok) {
          const code = r.status, msg = (j && j.message) || ("HTTP " + code);
          st.st = "stopped";
          st.stop = { kind: "http" + code, m: msg };
          st.why = "封存錯誤（" + msg + "），已停下（不換金鑰、不自動重試）";
          s2slUpSave(st, st.c); tick();
          break;
        }

        const respItems = (j && Array.isArray(j.items)) ? j.items : [];
        const respMap = new Map(respItems.map(it => [it.route, it]));

        let hasBad = null;
        for (const it of batchItems) {
          const resIt = respMap.get(it.route);
          if (!resIt) continue;
          if (resIt.bad) {
            hasBad = { route: it.route, bad: resIt.bad };
            break;
          }
          if (resIt.skip) {
            it.rec.up = "skip";
            it.rec.upAt = new Date().toISOString();
            it.rec.upMsg = "雲端已有略過";
            await s2slPut(it.rec);
            st.res[it.route] = { s: "skip", m: it.rec.upMsg };
          } else {
            it.rec.seal = {
              kind: resIt.kind,
              t: resIt.t,
              entry: resIt.entry || undefined,
              err: resIt.err || undefined,
              drop: resIt.drop || undefined,
              total: resIt.total || undefined,
              mac: resIt.mac,
              gz: it.len > 0 ? b64(it.gzBytes) : null
            };
            await s2slPut(it.rec);
            st.res[it.route] = {
              s: "sealed",
              m: resIt.kind === "ok" ? "已封存" : resIt.kind === "none" ? "已封存（查無）" : "已封存（拒收）"
            };
          }
        }

        if (hasBad) {
          st.st = "stopped";
          st.stop = { kind: "bad", m: hasBad.bad, route: hasBad.route };
          st.why = "「" + hasBad.route + "」檢核異常（" + hasBad.bad + "），已停下";
          s2slUpSave(st, st.c); tick();
          break;
        }

        st.i = scanIdx;
        s2slUpSave(st, st.c);
        tick();
      }

      if (st.i >= st.q.length && st.st === "running") {
        st.phase = "pack";
        st.i = 0;
        first = true;
        s2slUpSave(st, st.c); tick();
      }
    }

    // 階段 2：打包 (Pack)
    if (st.phase === "pack" && st.st === "running") {
      while (true) {
        if (pz()) { st.st = "paused"; st.why = "已暫停"; break; }
        const allMap = await s2slGetAll(st.c);
        // 審查修正：封存超過 6 天的（Worker 7 天後拒收）先清掉封存，回到封存階段重封
        const staleSeal = Object.values(allMap).filter(rec => rec.seal && s2slUpWaiting(rec) && !(Date.now() - rec.seal.t < 6 * 86400000));
        if (staleSeal.length) {
          for (const rec of staleSeal) { delete rec.seal; await s2slPut(rec); delete st.res[rec.route]; }
          st.phase = "seal"; st.i = 0; st.st = "paused"; st.why = "有 " + staleSeal.length + " 條封存超過 6 天，需要重新封存，請按續跑";
          s2slUpSave(st, st.c); tick(); break;
        }
        const pendingToPack = Object.values(allMap).filter(rec => rec.seal && s2slUpWaiting(rec));
        if (pendingToPack.length === 0) {
          st.st = "done";
          st.i = st.q.length;
          st.why = "上傳完成";
          s2slUpSave(st, st.c); tick();
          break;
        }

        const incomplete = pendingToPack.find(rec => rec.kind === "ok" && (!Array.isArray(rec.raw) || rec.raw.length === 0));
        if (incomplete) {
          st.unc = null; st.st = "stopped"; st.stop = { kind: "local", m: "本機資料不完整", route: incomplete.route };
          st.why = "「" + incomplete.route + "」本機資料不完整（狀態和原始資料對不上），沒有上傳，已停下";
          s2slUpSave(st, st.c); tick();
          break;
        }

        let curPackItems = [];
        let curPackGzBytesTotal = 0;
        for (const rec of pendingToPack) {
          const gzBytesLen = rec.seal.gz ? ub64(rec.seal.gz).length : 0;
          if (curPackItems.length > 0 && (curPackGzBytesTotal + gzBytesLen > 1024 * 1024 || curPackItems.length >= 60)) {   // 審查修正（CPU）：每包 ≤ 1 MiB、最多 60 條
            break;
          }
          curPackItems.push({ rec, gzLen: gzBytesLen });
          curPackGzBytesTotal += gzBytesLen;
        }

        if (!first) { await s2sbSleep(waitMs, pz); if (pz()) { st.st = "paused"; st.why = "已暫停"; break; } }
        first = false; lock();

        const headerObj = {
          v: 2,
          c: st.c,
          known: Array.isArray(st.known) ? st.known : [],   // 審查修正：這次批次已知的包，Worker 用來確認清單已同步
          items: curPackItems.map(({ rec, gzLen }) => ({
            kind: rec.seal.kind,
            route: rec.route,
            t: rec.seal.t,
            entry: rec.seal.entry || undefined,
            err: rec.seal.err || undefined,
            drop: rec.seal.drop || undefined,
            total: rec.seal.total || undefined,
            len: gzLen,
            mac: rec.seal.mac
          }))
        };
        const headerJsonBytes = enc8.encode(JSON.stringify(headerObj));
        const totalBodyLen = 4 + headerJsonBytes.length + curPackGzBytesTotal;
        const packBody = new Uint8Array(totalBodyLen);
        const packDv = new DataView(packBody.buffer);
        packDv.setUint32(0, headerJsonBytes.length);
        packBody.set(headerJsonBytes, 4);

        let gzWriteOff = 4 + headerJsonBytes.length;
        for (const { rec } of curPackItems) {
          if (rec.seal.gz) {
            const chunkBytes = ub64(rec.seal.gz);
            packBody.set(chunkBytes, gzWriteOff);
            gzWriteOff += chunkBytes.length;
          }
        }

        const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
        let r = null, j = null, netErr = null;
        try {
          r = await fetchT(proxy + "/bus/s2s/pack?c=" + enc(st.c), 60000, {
            method: "POST",
            headers: {
              "x-session": sess.token,
              "content-type": "application/octet-stream"
            },
            body: packBody
          });
          j = await r.json().catch(() => null);
        } catch (e) {
          netErr = e;
        }

        if (netErr) {
          st.unc = true;
          st.st = "stopped";
          st.stop = { kind: "net", m: "打包連線錯誤：" + (netErr.message || netErr) };
          st.why = "打包時連線錯誤（" + st.stop.m + "）；續跑時會先查雲端";
          s2slUpSave(st, st.c); tick();
          break;
        }

        if (!r.ok) {
          const code = r.status, msg = (j && j.message) || ("HTTP " + code);
          st.st = "stopped";
          st.stop = { kind: "http" + code, m: msg };
          st.why = "打包錯誤（" + msg + "），已停下（不換金鑰、不自動重試）";
          s2slUpSave(st, st.c); tick();
          break;
        }

        const nowIso = new Date().toISOString();
        if (j && Array.isArray(j.parts)) st.known = j.parts.slice(0, 2000);
        const acceptedOk = new Set((j && j.accepted && j.accepted.ok) || []);
        const acceptedNone = new Set((j && j.accepted && j.accepted.none) || []);
        const acceptedReject = new Set((j && j.accepted && j.accepted.reject) || []);
        const skippedSet = new Set((j && j.skipped) || []);

        let anyUpdated = false;
        for (const { rec } of curPackItems) {
          if (acceptedOk.has(rec.route)) {
            rec.up = "done"; rec.upAt = nowIso;
            st.res[rec.route] = { s: "ok", m: "已上傳" };
            anyUpdated = true;
          } else if (acceptedNone.has(rec.route)) {
            rec.up = "none"; rec.upAt = nowIso;
            st.res[rec.route] = { s: "none", m: "查無記錄" };
            anyUpdated = true;
          } else if (acceptedReject.has(rec.route)) {
            rec.up = "reject-cloud"; rec.upAt = nowIso;
            st.res[rec.route] = { s: "reject", m: "雲端拒收記錄" };
            anyUpdated = true;
          } else if (skippedSet.has(rec.route)) {
            rec.up = "skip"; rec.upAt = nowIso;
            st.res[rec.route] = { s: "skip", m: "雲端已有略過" };
            anyUpdated = true;
          }
          await s2slPut(rec);
        }
        if (!anyUpdated) {
          st.st = "stopped";
          st.stop = { kind: "unknown", m: "伺服器未回報接收狀態" };
          st.why = "伺服器回應異常，已停下";
          s2slUpSave(st, st.c); tick();
          break;
        }
        s2slUpSave(st, st.c);
        tick();
      }
    }

    if (st.st === "done") {
      s2slUpSave(st, st.c); tick();
    }
    return s2sLocalUpBatchGet({ c: st.c });
  } finally {
    s2slUpLive = false;
    try { const l = JSON.parse(localStorage.getItem(S2SL_UP_LOCK)); if (l && l.id === s2slUpTabId) localStorage.removeItem(S2SL_UP_LOCK); } catch (x) {}
  }
}

async function s2sLocalExportAll(c = "Taipei") {
  const all = await s2slGetAll(c);
  const items = Object.values(all);
  return {
    kind: "jisu-s2s-local-export",
    v: 1,
    exportedAt: new Date().toISOString(),
    city: c,
    count: items.length,
    items
  };
}
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
    const list = op === "TRA" ? ((j && j.TrainTimetables) || []).map(x => { const t = x.TrainInfo || {}; return [String(t.TrainNo), zh(t.TrainTypeName), t.Direction ?? "", zh(t.StartingStationName) || "", zh(t.EndingStationName) || "", mask, stops(x.StopTimes)]; })
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
// v2.46.4 捷運車種：TDX Timetables[i].TrainType（1普通、2直達…），沒有就看 StoppingPatternID（SP2／含 express＝直達）
// 存成 rows 第8欄代碼："X"＝直達（TrainType 2）、其他數字照原值；普通車＝空字串（不加第8欄）
const ttTyCode = t => { const ty = +t.TrainType; if (ty > 1) return ty === 2 ? "X" : String(ty); if (ty === 1) return ""; return /^SP2$|express/i.test(String(t.StoppingPatternID || "")) ? "X" : ""; };
const ttCodeTy = c => !c ? 1 : c === "X" ? 2 : +c > 1 ? +c : 1;
const svcDate = (offsetDays = 0) => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); d.setDate(d.getDate() + offsetDays); return d; };

// 手動更新：瀏覽器向 TDX（經 Worker、金鑰3）抓整個系統，壓縮後存回 Worker KV。回傳用了幾次 TDX 呼叫
// v2.27：opt.get 換成別的抓法（每日訪客同步：手機直接以訪客身分向 TDX 抓，不經 Worker、不用金鑰）。
//   opt.skip7：不重做七天班表；opt.same(out)：內容和雲端一樣就不上傳；opt.dry：只下載和建檔、不上傳（測試用）
async function ttRefresh(op, pass, onStep, opt = {}) {
  const proxy = getProxy(); if (!proxy) throw new Error("尚未設定 Worker");
  if (op === "HOLIDAY") {
    const r = await fetch(`${proxy}/tt/holidays`, { method: "POST", headers: { "x-session": pass } });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status); ttMetaP = null; return { calls: 0, ...j };
  }
  const guest = !!opt.get;
  // 雲端限流：同一個系統一小時內只能更新一次（保護 TDX 額度）；先向 Worker 取得許可才開始抓。訪客同步改成要上傳前才取得
  const lock = () => ttLock(op, pass);
  if (!guest) await lock();
  let calls = 0, version = "", out;
  // 每頁之間稍停；限流時等久一點再試（每次嘗試都算一次呼叫）
  const get = guest ? async (url, raw) => { calls++; onStep && onStep(calls); return opt.get(url, raw); } : async (url, raw) => {
    for (let i = 0; ; i++) {
      calls++; onStep && onStep(calls);
      try {
        // v2.27.4：Worker 端這些資料永久存，手動更新要帶 __fresh=1 才會向 TDX 抓最新版並覆寫（同一網址每天一次，之後讀當天抓的那份）
        if (!raw) return await tdx("rail", url + FRESH);
        const r = await fetch(proxy + url.slice(TDX_ORIGIN.length) + FRESH + "&__k=3"); const j = await r.json();
        if (r.status === 429) { const e = new Error(RATE_MSG); e.rate = true; throw e; }
        if (!r.ok) throw new Error("資料讀取失敗 (" + r.status + ")"); return j;
      } catch (e) { if (!isRate(e) || i >= 3) throw e; await sleep(5000 * (i + 1)); }
    }
  };
  const sys = (TT_SYSTEMS.find(x => x[0] === op) || [])[2];
  const vmax = (a, b) => { if (b == null || b === "") return a; const x = String(b); return !a || (/^\d+$/.test(x) && /^\d+$/.test(a) ? +x > +a : x > a) ? x : a; };
  if (sys === "metro") {
    const all = [], top = 300;
    for (let skip = 0; skip < 20000; skip += top) {
      const page = await get(`${RAIL_BASE}/v2/Rail/Metro/StationTimeTable/${op}?%24top=${top}&%24skip=${skip}&%24format=JSON`);
      all.push(...page); if (page.length < top) break; await sleep(700);
    }
    const sds = [], rows = [];
    for (const r of all) {
      const m = sdMask(r.ServiceDay); let i = sds.findIndex(x => x.m === m); if (i < 0) { sds.push({ m, tag: r.ServiceDay && r.ServiceDay.ServiceTag || "" }); i = sds.length - 1; }
      // v2.46.4：同一筆裡有不同車種（桃園捷運直達車）就拆成多列，第8欄＝車種代碼（ttTyCode）；普通車照舊只有7欄
      const byTy = new Map([["", []]]);
      for (const t of (r.Timetables || [])) { const x = hm(t.DepartureTime || t.ArrivalTime); if (!x) continue; const c = ttTyCode(t); if (!byTy.has(c)) byTy.set(c, []); byTy.get(c).push(x.replace(":", "")); }
      const base = [r.StationID, r.LineID || r.LineNO || "", r.Direction ?? "", r.DestinationStaionID || r.DestinationStationID || "", zh(r.DestinationStaionName) || zh(r.DestinationStationName) || "", i];
      for (const [c, times] of byTy) { if (!times.length && (c || byTy.size > 1)) continue; rows.push(c ? [...base, times.join(" "), c] : [...base, times.join(" ")]); }
      if (r.VersionID != null) version = vmax(version, r.VersionID);   // v2.27：版本取數字最大（以前是字串比較）
    }
    if (!version) for (const r of all) if (r.UpdateTime) version = vmax(version, r.UpdateTime.slice(0, 10));
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
    } catch (e) { if (isRate(e) || e.stop || e.budget) throw e; }
    try { const sol = solPack(await get(`${RAIL_BASE}/v2/Rail/Metro/StationOfLine/${op}?%24format=JSON`)); if (sol.length) out.sol = sol; }   // v2.43.0：各線車站順序也存雲端（1次呼叫）
    catch (e) { if (isRate(e) || e.stop || e.budget) throw e; }
    if (HW_LINES[op]) {   // 沒有站別時刻表的路線：一起存班距＋首末班（2次呼叫）
      const f = encodeURIComponent(HW_LINES[op].map(l => `LineID eq '${l}'`).join(" or "));
      out.hw = hwPack(await get(`${RAIL_BASE}/v2/Rail/Metro/Frequency/${op}?%24filter=${f}&%24format=JSON`), await get(`${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/${op}?%24filter=${f}&%24format=JSON`));
    }
  } else if (sys === "tmrt") {
    const [freq, fl] = [await get(`${RAIL_BASE}/v2/Rail/Metro/Frequency/TMRT?%24format=JSON`), await get(`${RAIL_BASE}/v2/Rail/Metro/FirstLastTimetable/TMRT?%24format=JSON`)];
    if (!freq.length || !fl.length) throw new Error("TDX 沒有台中捷運班距資料");
    for (const f of freq) version = vmax(version, f.VersionID);
    if (!version) version = String((freq[0] && (freq[0].UpdateTime || "").slice(0, 10)) || "");
    out = { v: 1, op, kind: "tmrt", freq, fl };
    try { const sol = solPack(await get(`${RAIL_BASE}/v2/Rail/Metro/StationOfLine/TMRT?%24format=JSON`)); if (sol.length) out.sol = sol; }   // v2.43.0：車站順序、站間時間也存雲端
    catch (e) { if (isRate(e) || e.stop || e.budget) throw e; }
    try { const e2 = s2sPack(await get(`${RAIL_BASE}/v2/Rail/Metro/S2STravelTime/TMRT?%24format=JSON`)); if (Object.keys(e2).length) out.s2s = e2; }
    catch (e) { if (isRate(e) || e.stop || e.budget) throw e; }
  } else if (sys === "tra") {
    const j = await get(`${RAIL_BASE}/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON`, true);
    const list = j.TrainTimetables || [];
    version = String(j.VersionID || (j.EffectiveDate || j.UpdateTime || "").slice(0, 10));
    const trains = list.map(t => { const i = t.TrainInfo || {};
      return [String(i.TrainNo), zh(i.TrainTypeName), i.Direction ?? "", zh(i.StartingStationName) || "", zh(i.EndingStationName) || "", sdMask(t.ServiceDay || i.ServiceDay || { Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1, Sunday: 1, NationalHolidays: 1 }),
        (t.StopTimes || []).map(x => [x.StationID, (hm(x.ArrivalTime) || "").replace(":", ""), (hm(x.DepartureTime) || "").replace(":", "")].join(",")).join(";")]; });
    if (!trains.length) throw new Error("TDX 沒有台鐵定期時刻表");
    out = { v: 1, op, kind: "tra", trains, eff: j.EffectiveDate || null, exp: j.ExpireDate || null };
  } else if (sys === "thsr") {
    const list = await get(`${RAIL_BASE}/v2/Rail/THSR/GeneralTimetable?%24format=JSON`);
    const trains = list.map(x => { const g = x.GeneralTimetable || x, i = g.GeneralTrainInfo || {};   // v2.27：修正 x 沒定義
      const ut = g.UpdateTime || x.UpdateTime; if (ut && !version) version = String(g.VersionID || x.VersionID || ut.slice(0, 10));
      return [String(i.TrainNo), "高鐵", i.Direction ?? "", zh(i.StartingStationName) || "", zh(i.EndingStationName) || "", sdMask(g.ServiceDay),
        (g.StopTimes || []).map(x => [x.StationID, (hm(x.ArrivalTime) || "").replace(":", ""), (hm(x.DepartureTime) || "").replace(":", "")].join(",")).join(";"),
        g.EffectiveDate || "", g.ExpiringDate || ""]; });
    if (!trains.length) throw new Error("TDX 沒有高鐵定期時刻表");
    out = { v: 1, op, kind: "thsr", trains };
  } else throw new Error("不支援的系統");
  const body = JSON.stringify(out);
  const count = out.rows ? out.rows.length : out.trains ? out.trains.length : (out.fl || []).length;
  if (opt.same && await opt.same(out)) return { calls, bytes: body.length, count, version, unchanged: true };
  if (opt.dry) { const res = { calls, bytes: body.length, count, version, dry: true, out };
    if (out.kind === "metro") { try { res.trips = buildTrips(out); } catch (e) { res.tripsErr = String(e.message || e); } }
    return res; }
  if (guest) await lock();
  const gh = guest ? { "x-tt-guest": "1" } : {};
  const vh = out.eff || out.exp ? { "x-tt-eff": out.eff || "", "x-tt-exp": out.exp || "" } : {};
  const r = await fetch(`${proxy}/tt/data/${op}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": String(calls), "x-tt-version": version, "x-tt-count": String(count), ...vh, ...gh }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || "上傳失敗 " + r.status);
  ttMetaP = null;
  // 台鐵／高鐵（v2.20）：七天時刻表取自最近一整個平常週（不含國定假日、連假和其前一天，含平常的週六日）的實際時刻表，
  // 星期一～日各抓一天（7 次呼叫）存成 TRA_MON…TRA_SUN；記下取自哪 7 天
  let days = null, src7 = null;
  if ((out.kind === "tra" || out.kind === "thsr") && !opt.skip7) {
    const hol = await ttLoad("HOLIDAY").catch(() => null);
    if (!hol || !hol.dates) throw new Error("先更新國定假日曆，才能挑出平常週");
    src7 = clean7(hol.dates, taipeiDay());
    if (src7.some(x => !x)) throw new Error("9 週內找不到平常日");
    days = await rail7Run(op, pass, get, src7, { eff: out.eff || null, exp: out.exp || null }, { version, calls: () => calls, guest });
    ttMetaP = null;
  }
  // 捷運／輕軌：同時串出每一班車的官方時刻，存成 TRIPS_系統（不用再呼叫 TDX）
  let trips = null;
  if (out.kind === "metro") {
    try {
      const T = buildTrips(out), tb = JSON.stringify(T);
      const rates = Object.entries(T.stats).map(([l, v]) => `${l} ${v.rate}%`).join("、");
      const r2 = await fetch(`${proxy}/tt/data/TRIPS_${op}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": "0", "x-tt-version": version, "x-tt-count": String(T.trips.length), ...gh }, body: tb });
      trips = r2.ok ? { count: T.trips.length, rates } : { error: "車次上傳失敗 " + r2.status };
    } catch (e) { trips = { error: String(e.message || e) }; }
  }
  return { calls, bytes: body.length, count, version, trips, days, src7, ...j };
}
const taipeiDay = (k = 0) => new Date(Date.now() + 8 * 3600000 + k * 86400000).toISOString().slice(0, 10);
async function ttLock(op, pass) {
  const r = await fetch(`${getProxy()}/tt/lock/${op}`, { method: "POST", headers: { "x-session": pass } });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.message || "無法取得更新許可 " + r.status); e.locked = r.status === 429; throw e; }
}
const dayUrl = (op, ds) => op === "TRA" ? `${RAIL_BASE}/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${ds}?%24format=JSON` : `${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/TrainDate/${ds}?%24format=JSON`;
// 七天班表：下載 src7 裡需要的日子（o.keep[i] 有給的就沿用雲端那份，不下載），建好後上傳（o.only：只上傳這幾天；預設 7 天都傳）
async function rail7Run(op, pass, get, src7, gen, o = {}) {
  const proxy = getProxy(), keep = o.keep || {}, dl = [];
  for (let i = 0; i < 7; i++) {
    if (keep[i]) { dl.push(null); continue; }
    dl.push(op === "TRA" ? await get(dayUrl(op, src7[i]), true) : await get(dayUrl(op, src7[i])));
    await sleep(700);
  }
  const sets = rail7Build(op, dl, src7, gen);
  sets.forEach(([, p], i) => { if (keep[i]) p.trains = keep[i].trains; });
  if (sets.some(([, p]) => !p.trains.length)) throw new Error("TDX 還沒有其中某天的時刻表：" + src7.filter((d, i) => !sets[i][1].trains.length).join("、"));
  if (o.dry) return sets.map(([, p]) => p.trains.length);
  if (o.lock) await o.lock();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const [d, part] = sets[i];
    days.push(part.trains.length);
    if (o.only && !o.only.includes(i)) continue;
    const h7 = { "x-tt-src": part.src, "x-tt-src7": src7.join(","), ...(part.eff ? { "x-tt-eff": part.eff, "x-tt-exp": part.exp || "" } : {}), ...(o.guest ? { "x-tt-guest": "1" } : {}) };
    const nc = o.calls ? o.calls() : 0;
    const r3 = await fetch(`${proxy}/tt/data/${op}_${d}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json", "x-tt-calls": String(d === "MON" ? nc : 0), "x-tt-version": o.version || "", "x-tt-count": String(part.trains.length), ...h7 }, body: JSON.stringify(part) });
    if (!r3.ok) throw new Error(`${d} 上傳失敗 ${r3.status}`);
  }
  ttMetaP = null;
  return days;
}

// ---------- v2.27 每日訪客同步：管理者手機每天第一次打開 app 時，在背景用 TDX「訪客」額度檢查各系統時刻表，有變才下載 ----------
// 訪客＝不帶金鑰直接向 TDX 抓（真的 Safari，用手機自己的 IP，每個 IP 每天 20 次），完全不吃我們的金鑰額度；
// 瀏覽器讀不到 TDX 的剩餘次數標頭（沒開放 CORS），所以自己數：一天最多用 GUEST_MAX 次，留 3 次緩衝。遇到 401／429 就停，明天再來
// v2.30.1：TDX 訪客的「一天」是 UTC 日（RateLimit-Reset 指到 UTC 午夜＝台北 08:00），不是台北日期；
//   以前用台北日期計算，00:00–08:00 跑的檢查會和前一天下午共用同一份 20 次 → 429。額度與「今天跑過沒」都改用 UTC 日（guestDay）。
//   TDX 對訪客只有每日上限（標頭只有 X-RateLimit-Limit-Day），沒有每秒限制；仍然每次請求間隔 3 秒，遇到 429 等 45 秒重試一次，再 429 才停。
// v2.43.0：改成數「成功」的次數（2xx），成功 20 次才停；失敗的請求不算進上限（401／429 仍然立刻停）
const GUEST_MAX = 20, GUEST_DAY = 20, GUEST_GAP = 3000, GUEST_BACKOFF = 45000;
const guestDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);   // TDX 訪客額度的日子（UTC）
const untilVisible = () => (typeof document === "undefined" || !document.hidden) ? Promise.resolve() : new Promise(res => {   // App 在背景時先暫停，回到前景再繼續
  const f = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", f); res(); } }; document.addEventListener("visibilitychange", f); });
function guestFetcher(st) {
  const prog = w => { try { st.onProgress && st.onProgress({ n: st.ok - st.ok0, total: Math.max(1, GUEST_MAX - st.ok0), wait: w || null }); } catch (e) {} };
  return async (url, raw) => {
    if (st.ok >= GUEST_MAX) { const e = new Error("今天的訪客額度已用到上限"); e.budget = true; throw e; }
    let r;
    for (let attempt = 0; ; attempt++) {
      await untilVisible();
      const gap = (st.last || 0) + GUEST_GAP - Date.now(); if (gap > 0) { await sleep(gap); await untilVisible(); }
      st.used++; st.last = Date.now(); prog();
      try { r = await fetch(url, { cache: "no-store", credentials: "omit" }); }   // 不加自訂標頭：簡單請求，不會有 CORS 預檢
      catch (e) { const x = new Error("連不到 TDX"); x.stop = "net"; throw x; }
      st.last = Date.now();
      if (r.status === 429 && attempt === 0 && !st.retried && st.ok < GUEST_MAX) {   // 可能是短時間太密：等 45 秒重試一次（整次檢查只重試一次）
        st.retried = true; prog("TDX 回 429，45 秒後重試一次"); await sleep(GUEST_BACKOFF); continue;
      }
      break;
    }
    if (r.status === 401 || r.status === 403 || r.status === 429) { const e = new Error("TDX 訪客 " + r.status + (r.status === 429 ? (st.retried ? "（等 45 秒重試仍是 429，可能是同一個 IP 今天的 20 次已用完，例如行動網路共用 IP）" : "") : "")); e.stop = r.status; throw e; }
    if (!r.ok) throw new Error("TDX " + r.status);
    st.ok++; prog();
    st.bytes += +(r.headers.get("content-length") || 0);
    const j = await r.json();
    if (raw) return j;
    if (Array.isArray(j)) return j;
    const arr = j && Object.values(j).find(Array.isArray); return arr || [];
  };
}
async function gsyncCall(method, pass, body) {
  const r = await fetch(`${getProxy()}/tt/gsync`, { method, headers: { "x-session": pass, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || "gsync " + r.status); return j;
}
// 雲端存的時間 → 毫秒；TDX 的 UpdateTime 比雲端那份的更新時間還新，才算有新版
const newer = (ut, stored) => !!ut && (!stored || Date.parse(ut) > Date.parse(stored));
// TDX 每天都會重新發布（VersionID、UpdateTime 天天變，內容不變），真正的改版看 SrcUpdateTime（業者來源資料的更新時間）；
// 高鐵每日時刻表沒有 SrcUpdateTime，它的 UpdateTime 不會天天變，就用它
const srcT = x => (x && (x.SrcUpdateTime || x.UpdateTime)) || "";
async function guestSync(p = {}) {
  const pass = p.pass, today = taipeiDay(), qday = guestDay();
  if (!pass || !getProxy()) return { skipped: "no-admin" };
  const prev = await gsyncCall("GET", pass).catch(() => ({}));
  const prevQ = prev.qday || (prev.at ? guestDay(Date.parse(prev.at)) : "");   // 舊紀錄沒有 qday：用開始時間換算 UTC 日
  const resume = prev.status === "running" || (prev.status === "stopped" && /連不到/.test(prev.err || ""));   // 上次中途被關掉／斷線：同一天接著跑
  if (!p.force && prevQ === qday && !resume) return { skipped: "done-today", state: prev };
  const used0 = prevQ === qday ? (prev.used || 0) : 0, ok0 = prevQ === qday ? (prev.ok ?? prev.used ?? 0) : 0;   // 舊紀錄沒有 ok：用 used（保守）
  const st = { used: used0, used0, ok: ok0, ok0, bytes: 0, onProgress: p.onProgress }, gget = guestFetcher(st);   // 同一個 TDX 日再跑一次（手動）時接著算
  const S = { day: today, qday, at: new Date().toISOString(), status: "running", used: 0, bytes: 0, changed: [], deferred: [], checked: [], notes: [], ptr: prev.ptr || 0, hol: prev.hol || {}, sig: { ...(prev.sig || {}) }, dry: !!p.dry };
  // sig：每個系統上次看到的來源時間；沒有的話拿雲端那份的存放時間比（來源時間比它新＝我們還沒有）
  const isNew = (key, t, storedAt) => newer(t, S.sig[key] || storedAt), seen = (key, t) => { if (t && !p.dry) S.sig[key] = t; };
  if (!p.dry) await gsyncCall("PUT", pass, S).catch(() => {});
  const left = () => GUEST_MAX - st.ok;
  const force = new Set(p.forceChange || []), only = p.only ? new Set(p.only) : null, skip = op => !!only && !only.has(op);   // only：測試用，只跑這幾個系統
  const log = (op, what) => S.changed.push({ op, what });
  const meta = await ttMeta(true), M = meta.systems || {};
  const name = op => ((TT_SYSTEMS.find(x => x[0] === op) || [])[1] || op);
  const hol = await ttLoad("HOLIDAY").catch(() => null), hd = (hol && hol.dates) || {};
  const run = async (fn) => { try { return await fn(); } catch (e) { if (e.stop || e.budget) throw e; if (e.locked) { S.notes.push(String(e.message)); return null; } S.notes.push(String(e.message || e).slice(0, 120)); return null; } };
  try {
    // ---- 台鐵、高鐵優先 ----
    for (const op of ["TRA", "THSR"]) {
      if (skip(op) || (!M[op] && !M[op + "_MON"])) continue;
      let full = false;
      if (op === "TRA") {
        if (left() < 1) { S.deferred.push(op); continue; }
        const g = await gget(`${RAIL_BASE}/v3/Rail/TRA/GeneralTrainTimetable?%24top=0&%24format=JSON`, true);
        S.checked.push(op);
        const t = srcT(g);
        if (force.has(op) || isNew("TRA", t, M.TRA && M.TRA.updated)) {
          if (left() < 8) { S.deferred.push(op + "（定期表有新版，額度不夠，明天下載）"); continue; }
          const r = await run(() => ttRefresh("TRA", pass, null, { get: gget, dry: p.dry }));
          if (r) { log(op, "定期表與七天班表重抓"); full = true; seen("TRA", t); }
        } else seen("TRA", t);
      } else {
        if (left() < 1) { S.deferred.push(op); continue; }
        const stored = await ttLoad("THSR").catch(() => null);
        const r = await run(() => ttRefresh("THSR", pass, null, { get: gget, skip7: true, dry: p.dry,
          same: o => !force.has(op) && !!stored && JSON.stringify(stored.trains) === JSON.stringify(o.trains) }));
        S.checked.push(op);
        if (r && !r.unchanged) log(op, "定期表有變更");
      }
      if (full) continue;
      // 七天班表：最近一整個平常週變了（例如這週已經開始）就換週；同一天的日期沿用雲端那份，只下載新的日子
      const m7 = M[op + "_MON"], old7 = (m7 && m7.src7) || [];
      const want = clean7(hd, today);
      if (want.some(x => !x)) { S.notes.push(name(op) + "：9 週內找不到平常日"); continue; }
      const need = want.map((d, i) => d !== old7[i] ? i : -1).filter(i => i >= 0);
      if (need.length) {
        if (left() < need.length) { S.deferred.push(name(op) + "七天班表換週（需 " + need.length + " 次）"); continue; }
        const keep = {};
        for (let i = 0; i < 7; i++) if (!need.includes(i)) keep[i] = await ttLoad(op + "_" + DOW[(i + 1) % 7]).catch(() => null);
        if (Object.values(keep).some(x => !x || !x.trains)) { S.notes.push(name(op) + "：雲端七天班表不完整，請手動更新"); continue; }
        const gen = { eff: (M[op] && M[op].eff) || null, exp: (M[op] && M[op].exp) || null };
        const r = await run(() => rail7Run(op, pass, gget, want, gen, { keep, version: (m7 && m7.version) || "", guest: true, dry: p.dry, lock: () => ttLock(op, pass), calls: () => need.length }));
        if (r) log(op, "七天班表換成 " + want[0].slice(5) + "–" + want[6].slice(5) + "（下載 " + need.length + " 天）");
      }
    }
    // ---- 捷運、輕軌：各 1 次小檢查（版本號），有新版才整份下載 ----
    for (const [op, , sys] of TT_SYSTEMS) {
      if (sys !== "metro" && sys !== "tmrt") continue;
      const m = M[op]; if (!m || skip(op)) continue;
      if (left() < 1) { S.deferred.push(name(op)); continue; }
      const q = `${RAIL_BASE}/v2/Rail/Metro/${sys === "tmrt" ? "Frequency" : "StationTimeTable"}/${op}?%24select=VersionID,SrcUpdateTime,UpdateTime&%24orderby=SrcUpdateTime%20desc&%24top=1&%24format=JSON`;
      const a = await gget(q); S.checked.push(op);
      const x = a[0] || {}, t = srcT(x), rv = t.slice(0, 10), sv = (S.sig[op] || m.updated || "").slice(0, 10);
      const changed = force.has(op) || isNew(op, t, m.updated);
      if (!changed) { seen(op, t); continue; }
      const cost = sys === "tmrt" ? 2 : Math.ceil(((m.count || 0) + 1) / 300) + 1 + (HW_LINES[op] ? 2 : 0);
      if (left() < cost) { S.deferred.push(name(op) + "（有新版 " + rv + "，額度不夠，明天下載）"); continue; }
      const r = await run(() => ttRefresh(op, pass, null, { get: gget, dry: p.dry }));
      if (r) { seen(op, t); log(op, "來源更新 " + rv + "（雲端那份 " + sv + "）"); if (p.dry) S.notes.push(name(op) + " 試跑：" + r.count + " 筆" + (r.trips ? "、串成 " + r.trips.trips.length + " 班" : "")); if (p.dry && p.keepOut) (S.out = S.out || {})[op] = r; }
    }
    // ---- 國定假日／連假／前一天（今天起 3 天內）：手機用訪客抓那天的實際時刻表存到雲端，Worker 就不用拿金鑰抓 ----
    for (let k = 0; k <= 3 && !only; k++) {
      const ds = taipeiDay(k); if (!holRel(hd, ds)) continue;
      for (const op of ["TRA", "THSR"]) {
        const hk = op + ":" + ds; if (S.hol[hk] === today) continue;
        if (left() < 1) { S.deferred.push(name(op) + " " + ds.slice(5) + " 假日時刻表"); continue; }
        const j = await gget(dayUrl(op, ds), op === "TRA");
        const trains = holDayTrains(op, j);
        if (!trains.length) { S.notes.push(name(op) + " " + ds.slice(5) + "：TDX 還沒有那天的時刻表"); continue; }
        if (!p.dry) {
          const r = await fetch(`${getProxy()}/tt/day/${op}/${ds}`, { method: "PUT", headers: { "x-session": pass, "content-type": "application/json" }, body: JSON.stringify({ v: 1, op, kind: op.toLowerCase(), date: ds, daily: true, trains }) });
          if (!r.ok) { S.notes.push(name(op) + " " + ds.slice(5) + " 上傳失敗 " + r.status); continue; }
        }
        S.hol[hk] = today; log(op, ds.slice(5) + " 假日時刻表");
      }
    }
    for (const k of Object.keys(S.hol)) if (k.slice(-10) < taipeiDay(-3)) delete S.hol[k];
    for (const k of Object.keys(S.sig)) if (k.includes(":") && k.slice(-10) < today) delete S.sig[k];
    // ---- 剩下的額度：輪流檢查七天班表裡的日子有沒有被改（每次 1 次；有改才再下載那 1 天） ----
    for (let n = 0; n < 14 && left() >= 2 && !only; n++) {
      const idx = S.ptr % 14; S.ptr = (S.ptr + 1) % 14;
      const op = idx < 7 ? "TRA" : "THSR", i = idx % 7, part = op + "_" + DOW[(i + 1) % 7], m = M[part];
      if (!m || !m.src) continue;
      const ut = srcT(op === "TRA" ? await gget(`${RAIL_BASE}/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${m.src}?%24top=0&%24format=JSON`, true)
        : (await gget(`${RAIL_BASE}/v2/Rail/THSR/DailyTimetable/TrainDate/${m.src}?%24select=UpdateTime&%24top=1&%24format=JSON`))[0]);
      S.checked.push(part);
      const sk = part + ":" + m.src;
      if (!isNew(sk, ut, m.updated)) { seen(sk, ut); continue; }
      const src7 = (M[op + "_MON"] && M[op + "_MON"].src7) || [];
      if (src7[i] !== m.src) continue;
      const keep = {};
      for (let j = 0; j < 7; j++) if (j !== i) keep[j] = await ttLoad(op + "_" + DOW[(j + 1) % 7]).catch(() => null);
      if (Object.values(keep).some(x => !x || !x.trains)) continue;
      const gen = { eff: (M[op] && M[op].eff) || null, exp: (M[op] && M[op].exp) || null };
      const r = await run(() => rail7Run(op, pass, gget, src7, gen, { keep, only: [i], version: (M[op + "_MON"] || {}).version || "", guest: true, dry: p.dry, lock: () => ttLock(op, pass), calls: () => 1 }));
      if (r) { seen(sk, ut); log(part, m.src.slice(5) + " 有更新"); }
    }
    S.status = "ok";
  } catch (e) {
    S.status = e.budget ? "budget" : "stopped"; S.err = String(e.message || e);
  }
  S.used = st.used; S.ok = st.ok; S.bytes = st.bytes; S.end = new Date().toISOString();
  const outs = S.out; delete S.out;
  if (S.checked.length > 60) S.checked = S.checked.slice(0, 60);
  if (!p.dry) { await gsyncCall("PUT", pass, S).catch(() => {}); ttMetaP = null; }
  return { ...S, out: outs };
}
// 和 Worker /tt/day 同樣格式（台鐵車種用 TDX 原名、行駛日旗標全 1）
function holDayTrains(op, j) {
  const hm4 = x => (x || "").slice(0, 5).replace(":", ""), zt = o => (o && o.Zh_tw) || "";
  const stops = L => (L || []).filter(x => x.SuspendedFlag !== 1).map(x => [x.StationID, hm4(x.ArrivalTime), hm4(x.DepartureTime)].join(",")).join(";");
  return op === "TRA"
    ? ((j && j.TrainTimetables) || []).map(x => { const i = x.TrainInfo || {}; return [String(i.TrainNo), zt(i.TrainTypeName), i.Direction ?? "", zt(i.StartingStationName), zt(i.EndingStationName), "11111111", stops(x.StopTimes)]; })
    : (Array.isArray(j) ? j : []).map(x => { const i = x.DailyTrainInfo || {}; return [String(i.TrainNo), "高鐵", i.Direction ?? "", zt(i.StartingStationName), zt(i.EndingStationName), "11111111", stops(x.StopTimes)]; });
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
// v2.46.4：第8欄車種代碼（沒有＝普通車，舊資料就是這樣）帶回每個 Timetables 項目的 TrainType
function ttMetroRecs(tt, ids) {
  const want = new Set(ids);
  return tt.rows.filter(r => want.has(r[0])).map(r => { const ty = ttCodeTy(r[7]);
    return { StationID: r[0], LineID: r[1] || null, Direction: r[2] === "" ? null : +r[2], DestinationStationID: r[3] || null,
    DestinationStationName: { Zh_tw: r[4] }, ServiceDay: { ...sdObj(tt.sd[r[5]].m), ServiceTag: tt.sd[r[5]].tag }, Timetables: r[6] ? r[6].split(" ").map(x => ty > 1 ? { DepartureTime: x.slice(0, 2) + ":" + x.slice(2), TrainType: ty } : { DepartureTime: x.slice(0, 2) + ":" + x.slice(2) }) : [] }; });
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
    rows.push({ no: t[0], type: shortType(t[1]), dir: t[2] === "" ? null : +t[2], dest: t[4], time: hhmm4(d || a) });
  }
  return rows;
}

// 時刻表：回傳今日接下來的班次；查無資料回傳 null
async function metroTimetable(get, st, filter, all) {
  let recs = [];
  const stored = await ttLoad(st.op).catch(() => null);
  if (stored && stored.rows) recs = ttMetroRecs(stored, st.ids);
  // 手機端時刻表只讀 /tt/data；雲端尚未建置時不向 TDX 補抓。
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
    const line = brLine(st.op, r.LineID || r.LineNO || lineOf(st.op, r.StationID), r.StationID, r.DestinationStationID, dest);
    const dir = r.Direction ?? null;
    const k = dest + "|" + line + "|" + dir;
    const set = byKey[k] = byKey[k] || { dest, destId: r.DestinationStationID || null, line, dir, times: new Set(), ex: new Set() };
    for (const t of (r.Timetables || [])) { const x = hm(t.DepartureTime || t.ArrivalTime); if (x) { set.times.add(x); if (t.TrainType > 1) set.ex.add(x); } }   // ex：直達車的時刻
  }
  return byKey; };
  const byKey = build(todays), byKeyT = build(tomorrows);
  const trains = [];
  // 同一終點有兩個方向（環狀線）時補上方向；高雄輕軌 TDX 時刻表 Direction 1＝逆行、0＝順行
  const dirsOf = {};
  for (const g of Object.values(byKey)) (dirsOf[g.dest + "|" + g.line] = dirsOf[g.dest + "|" + g.line] || new Set()).add(g.dir);
  for (const g of Object.values(byKey)) {
    if (dirsOf[g.dest + "|" + g.line].size > 1) g.via = st.op === "KLRT" ? (g.dir === 1 ? "逆行" : "順行") : `方向${g.dir}`;
    const ts = [...g.times].map(x => ({ x, t: toMin(x) < 180 ? toMin(x) + 1440 : toMin(x) })).sort((a, b) => a.t - b.t);
    let up = ts.filter(o => o.t >= now - ((st.op === "TRTC" || st.op === "NTMC") ? 4 : 25)), ex = g.ex;
    if (!up.length && all) {                                                   // 今日已收班：列出明日（依明日營運日）班次
      const gT = byKeyT[g.dest + "|" + g.line + "|" + g.dir] || g; ex = gT.ex;
      up = [...gT.times].map(x => ({ x, t: (toMin(x) < 180 ? toMin(x) + 1440 : toMin(x)) + 1440 })).sort((a, b) => a.t - b.t);
    }
    up.slice(0, all ? 999 : 3)
      .forEach(o => trains.push({ time: o.x, t: o.t, dest: g.dest, destId: g.destId, dir: g.dir, line: g.line, via: g.via || null, eta: o.t - now, ...(ex.has(o.x) ? { ex: true } : {}) }));
  }
  trains.sort((a, b) => a.t - b.t);
  return trains;
}

// 依方向分組：台鐵用 Direction（0順行、1逆行）；高鐵（0南下、1北上）；捷運／輕軌用終點站（往 X）
// 回傳 [{ label, trains }]，組內依時間排序；沒有班次的組放最後（介面不顯示）；每組最多8班
function groupTrains(kind, a, b) {
  const ids = b === undefined ? [] : a, trains = b === undefined ? a : b;
  const per = kind === "metro" ? 8 : 999, key = t => (t.t != null ? t.t + (t.delay || 0) : t.eta ?? 9999);
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
  for (const g of groups) g.trains = g.trains.slice().sort((a, b) => key(a) - key(b) || (a.t ?? 0) - (b.t ?? 0)).slice(0, per);
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
  // 淡海輕軌藍海線支線 V26～V28：行車順序 V09→V28→V27→V26，站號往淡水漁人碼頭遞減。
  // 在支線站上，往 V26 那頭（終點是站號較小的支線站）＝up（和幹線站往淡水漁人碼頭同一邊），往 V09／V01（紅樹林）＝dn
  if (pre === "V" && a >= 26 && a <= 28) return b >= 26 && b < a ? "up" : "dn";
  return b > a ? "up" : "dn";
}

// 全台車站搜尋：重用永久保存的車站清單；完全找不到時（每天最多一次）重抓各系統清單再搜一次
const normZh = x => String(x || "").replace(/臺/g, "台").toLowerCase();
// v2.29.0 選地點頁的預設車站：1.5 公里內每個軌道系統（營運單位）最近的一站，由近而遠；1.5 公里內都沒有 → 最近的台鐵站
// 只用手機已存的車站清單與出口座標（不另呼叫 TDX）
async function railPickNear({ lat, lon }) {
  if (lat == null || lon == null) return [];
  const st = await loadRailStations();
  const ex = {}; try { for (const s of Object.values(loadExitCache().systems || {})) Object.assign(ex, s.exits || {}); } catch (e) {}
  const all = nearestRail(st, lat, lon, { all: true }, ex), out = [], seen = new Set();
  for (const s of all) { if (s.dist > 1500) break; if (seen.has(s.op)) continue; seen.add(s.op); out.push(s); }
  if (out.length) return out;
  const t = all.find(s => s.op === "TRA"); return t ? [{ ...t, fallback: true }] : [];
}
// v2.30.0：通知的深層連結（?station=系統:代碼）→ 找回 App 自己的車站卡（同名轉乘站合併後的那張），用本機車站清單
async function railStationRef({ op, id, lat, lon }) {
  if (!op || !id) return null;
  const st = await loadRailStations(), s = st.find(x => x.op === op && String(x.id) === String(id));
  if (!s) return null;
  const ex = {}; try { for (const c of Object.values(loadExitCache().systems || {})) Object.assign(ex, c.exits || {}); } catch (e) {}
  const here = lat != null && lon != null, all = nearestRail(st, here ? lat : s.lat, here ? lon : s.lon, { all: true }, ex);   // 有目前位置才顯示距離
  const g = all.find(g => g.ids.includes(s.id) && (g.op === op || (op === "NTMC" && g.op === "TRTC")));
  return g ? (here ? g : { ...g, dist: null, exit: null }) : null;
}
// v2.30.0：Siri 捷徑（個人捷徑金鑰）：需要登入
async function scCall(method, path, body) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const s = getSession(); let r, j = null;
  try { r = await fetch(proxy + path, { method, headers: { ...(s ? { "x-session": s.token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); j = await r.json().catch(() => null); }
  catch (e) { throw new Error("連不到伺服器，請確認網路"); }
  if (!r.ok) { const m = j && j.message; throw new Error(r.status === 401 && !/捷徑/.test(m || "") ? "請重新登入" : m || ("錯誤 " + r.status)); }
  return j;
}
async function scTry({ token, lat, lon }) {   // 從 App 內試跑一次捷徑（和捷徑打同一個網址）
  const r = await fetch(getProxy() + "/shortcut/nearest?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lat, lon }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || ("錯誤 " + r.status)); return j;
}
async function railSearch(p) {
  const q = normZh(p.q).trim(); if (!q) return [];
  // noHeal（v2.35.0 公車目的地篩選）：只用手機已存的車站清單，缺的系統不去補抓（不打 TDX）
  let st = (p.noHeal ? Object.values(loadRailCache().systems).flatMap(s => s.stations || []) : await loadRailStations()).filter(s => normZh(s.name).includes(q));
  if (!st.length && !p.noHeal && q.length >= 2 && /[\u4e00-\u9fff]/.test(q) && await railHealAll()) st = (await loadRailStations()).filter(s => normZh(s.name).includes(q));
  const lat = p.lat ?? 25.0478, lon = p.lon ?? 121.517;
  return nearestRail(st, lat, lon, { all: true }).map(s => ({ ...s, score: normZh(s.name) === q ? 0 : normZh(s.name).startsWith(q) ? 1 : 2 }))
    .sort((a, b) => a.score - b.score || a.dist - b.dist).slice(0, 60);
}


// ---------- 路線停靠站（捷運／輕軌）與車次停靠站（台鐵／高鐵） ----------
const SOL_KEY = "jisu_sol";
const solPack = list => (Array.isArray(list) ? list : []).map(l => ({ line: l.LineID || l.LineNO, st: (l.Stations || []).slice().sort((a, b) => (a.Sequence ?? 0) - (b.Sequence ?? 0)).map(x => [x.StationID, zh(x.StationName) || x.StationID]) }));
const s2sPack = list => { const e = {}; for (const r of Array.isArray(list) ? list : []) for (const x of (r.TravelTimes || [])) {
  const sec = (x.RunTime || 0) + (x.StopTime || 0); if (!sec) continue;
  for (const k of [x.FromStationID + "|" + x.ToStationID, x.ToStationID + "|" + x.FromStationID]) if (!e[k]) e[k] = sec; } return e; };
async function stationOfLine(get, op, heal) {   // heal：清單裡找不到要的站，且存了超過一天才重抓
  // 雲端那份（更新時刻表時一起存的各線車站順序）優先，否則只用本機快取。
  { const stored = await ttLoad(op).catch(() => null); if (stored && Array.isArray(stored.sol) && stored.sol.length) return stored.sol; }
  let c = {}; try { c = JSON.parse(localStorage.getItem(SOL_KEY)) || {}; } catch (e) {}
  const hit = c[op]; if (hit && !(heal && Date.now() - hit.time > DAY_MS) && await rgenOk(op, hit)) return hit.lines;
  return [];
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
  // 雲端那份（更新時刻表時一起存的站間行駛時間）優先；雲端沒有才用舊的本機快取。
  const stored = await ttLoad(op).catch(() => null);
  if (stored && stored.s2s) { try { localStorage.removeItem(S2S_KEY); } catch (e) {} return stored.s2s; }
  let c = {}; try { c = JSON.parse(localStorage.getItem(S2S_KEY)) || {}; } catch (e) {}
  const hit = c[op]; if (hit && (Object.keys(hit.e).length || Date.now() - hit.time < DAY_MS) && await rgenOk(op, hit)) return hit.e;   // 有資料就永久（直到換代）；空的明天再試
  return {};
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
  let stops = [], info = {}, delay = null, pos = null, suspended = false;
  // v2.44.0：用「查詢的那一天」適用的時刻表（雲端：定期表依星期與有效期間篩選，或當天時刻表）；只有今天才查即時位置、才會直接問 TDX
  // （以前一律用今天的表：從 10/27 的車站時刻表點進來，卻拿到今天停駛那一筆，只剩空白一站）
  const op = p.kind === "tra" ? "TRA" : "THSR";
  const day = p.date ? dateOfIso(p.date) : svcDate(0), isToday = isoDay(day) === isoDay(svcDate(0));
  let P = null;
  try { P = await railTrains(op, day); } catch (e) {}
  const cand = P ? P.trains.filter(t => t.no === no || t.no === no.replace(/^0+/, "")).sort((a, b) => b.pts.length - a.pts.length) : [];
  const sT0 = cand[0] && cand[0].raw;
  const sT = sT0 ? [sT0[0], shortType(sT0[1]), ...sT0.slice(2)] : null;
  if (sT && !cand[0].pts.length) {   // 那一天的實際時刻表裡有這班車，但每一站都停駛
    suspended = true; info = { type: sT[1], from: sT[3], to: sT[4] };
  } else if (sT) {
    const nameOf = {}; try { for (const s of await loadRailStations()) if (s.op === (p.kind === "tra" ? "TRA" : "THSR")) nameOf[s.id] = s.name; } catch (e) {}
    info = { type: sT[1], from: sT[3], to: sT[4] };
    stops = sT[6].split(";").filter(Boolean).map(x => { const [id, a, d] = x.split(","); return { id, name: nameOf[id] || id, arr: hhmm4(a), dep: hhmm4(d) }; });
    if (p.kind === "tra" && isToday) { try { const lv = await traAllLive(); const b = lv.find(x => String(x.TrainNo) === no); if (b) { delay = b.DelayTime ?? null; pos = { id: b.StationID, status: b.TrainStationStatus }; } } catch (e) { if (isRate(e)) throw e; } }
  } else if (!isToday) {
    throw new Error("這一天的時刻表裡沒有這個車次");
  } else if (p.kind === "tra") {
    // 今日車次明細沒有雲端時刻表時仍可保留即時位置；不向 TDX 補抓靜態停靠站。
    try { const lv = await traAllLive(); const b = lv.find(x => String(x.TrainNo) === no); if (b) { delay = b.DelayTime ?? null; pos = { id: b.StationID, status: b.TrainStationStatus }; } } catch (e) { if (isRate(e)) throw e; }
  }
  const ci = stops.findIndex(s => here.has(String(s.id)));
  return { kind: p.kind, no, ...info, delay, pos, suspended, date: isoDay(day), today: isToday, stops: stops.map((s, i) => ({ ...s, here: i === ci, at: pos && pos.id === s.id })) };
}

// ---------- 台中捷運：TDX 沒有即時與站別時刻表，用班距＋首末班推估 ----------
const TMRT_KEY = "jisu_tmrt";
async function loadTmrt(get) {
  const stored = await ttLoad("TMRT").catch(() => null); if (stored && stored.freq) { try { localStorage.removeItem(TMRT_KEY); } catch (e) {} return stored; }
  try { const c = JSON.parse(localStorage.getItem(TMRT_KEY)); if (c && c.freq && c.fl && await rgenOk("TMRT", c)) return c; } catch (e) {}
  return { freq: [], fl: [] };
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
const railCloudJobs = {};
function railCloud(kind) {
  if (railCloudJobs[kind]) return railCloudJobs[kind];
  return railCloudJobs[kind] = authedGet("/static/rail/" + kind).finally(() => { delete railCloudJobs[kind]; });
}
async function loadRailStations() {
  const cache = loadRailCache(), now = Date.now();
  const todo = RAIL_SYSTEMS.filter(s => { const c = cache.systems[s.key]; return !c || !c.stations; });
  if (todo.length) try {
    const j = await railCloud("stations"), systems = (j && j.systems) || {};
    for (const s of todo) { const st = mapRailStations(systems[s.key] || [], s); if (st.length) cache.systems[s.key] = { time: now, stations: st }; }
    localStorage.setItem(RAIL_KEY, JSON.stringify(cache));
  } catch (e) {}
  const all = Object.values(cache.systems).flatMap(s => s.stations);
  if (!all.length) throw new Error("車站清單讀取失敗");
  return all;
}

function loadExitCache() { try { const c = JSON.parse(localStorage.getItem(EXIT_KEY)); if (c && c.systems) return c; } catch (e) {} return { systems: {} }; }
async function loadRailExits() {
  const cache = loadExitCache(), now = Date.now();
  const todo = RAIL_SYSTEMS.filter(s => s.kind === "metro" && !s.optional && !NO_EXIT.has(s.key) && (!cache.systems[s.key] || !cache.systems[s.key].exits));
  if (todo.length) try {
    const j = await railCloud("exits"), systems = (j && j.systems) || {};
    for (const s of todo) { const exits = mapExits(systems[s.key] || [], s.key); if (Object.keys(exits).length) cache.systems[s.key] = { time: now, exits }; }
    localStorage.setItem(EXIT_KEY, JSON.stringify(cache));
  } catch (e) {}
  return Object.assign({}, ...Object.values(cache.systems).map(s => s.exits || {}));
}

// ---------- 永久清單的自動補救（v2.12.6）：和站牌／YouBike 同一套規則 ----------
// 即時資料、搜尋、點進路線時出現清單沒有的站／路線才重讀既有雲端索引；一般使用者不觸發重抓。
// 重抓後還是找不到的代碼（號誌站、資料不一致）記在 ign，之後不再觸發；同縣市每天最多重抓一次。
const healBusy = {};
const newMiss = (ids, have, ign) => [...new Set(ids.filter(Boolean).map(String))].filter(i => !have.has(i) && !ign.has(i));
function railHeal(op, ids) { if (AUTO) return; railHealA(op, ids || []).catch(() => {}); }
async function railHealA(op, ids, force) {
  const sys = RAIL_SYSTEMS.find(s => s.key === op), k = "rail|" + op;
  if (!sys || healBusy[k]) return false;
  const c = loadRailCache().systems[op]; if (!c || !c.stations || Date.now() - c.time < DAY_MS) return false;
  const ign = new Set(c.ign || []), miss = force ? [] : newMiss(ids, new Set(c.stations.map(s => s.id)), ign);
  if (!force && !miss.length) return false;
  healBusy[k] = true;
  let ok = false, st = null;
  try { const j = await railCloud("stations"); st = mapRailStations(((j && j.systems) || {})[op] || [], sys); ok = st.length > 0; } catch (e) {}
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
// 附近捷運站沒有出口資料：從雲端重新下載該系統的出口清單
function exitHeal(near) { if (AUTO) return; exitHealA(near).catch(() => {}); }
async function exitHealA(near) {
  const cache = loadExitCache(), want = [...new Set((near || []).map(s => s.op).filter(op => !NO_EXIT.has(op)))];
  if (!want.some(op => { const c = cache.systems[op]; return c && Date.now() - c.time >= DAY_MS; })) return false;
  try {
    const j = await railCloud("exits"), systems = (j && j.systems) || {}; let ok = false;
    for (const op of want) { const exits = mapExits(systems[op] || [], op); if (Object.keys(exits).length) { cache.systems[op] = { time: Date.now(), exits }; ok = true; } }
    if (ok) localStorage.setItem(EXIT_KEY, JSON.stringify(cache));
    return ok;
  } catch (e) { return false; }
}

// ---------- 設定 / 收藏 ----------
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s) return s; } catch (e) {}
  return { settings: { busR: 300, bikeR: 500, railWalk: 1.5, railFar: 1, railFarTra: 1, railFarThsr: 1, railSys: null, auto: 30 }, favs: { bus: [], bike: [] } };
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
      let saved = false;
      for (let i = 0; i < todo.length; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async city => {
          try { const r = await fetch(nt(`${proxy}/bus/routes?c=${city}`)); if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) { c.cities[city] = j; c.ct[city] = Date.now(); saved = true; } } } catch (e) {}
        }));
        await sleep(300);
      }
      if (saved) await IDB.set("busidx", c).catch(() => {});
    })().finally(() => { idxLoading = null; });
    await idxLoading;
  } else if (idxLoading) await idxLoading;
  return { cities: c.cities, missing: all.filter(x => !c.cities[x]) };
}
// uids：即時資料或點進去的 RouteUID；cities：搜尋完全找不到時要重抓的縣市。只檢查已下載的縣市
function busHeal(uids, cities) { if (AUTO) return Promise.resolve(false); return busHealA(uids || [], cities || []).catch(() => false); }
async function busHealA(uids, cities) {
  const c = idxMem || await IDB.get("busidx"); if (!c || !c.cities) return false;
  c.ct = c.ct || {}; c.ign = c.ign || {}; idxMem = c;
  const want = {};
  for (const u of uids) { const k = routeKind(u); if (k) (want[k.kind === "intercity" ? "InterCity" : k.city] = want[k.kind === "intercity" ? "InterCity" : k.city] || []).push(u); }
  for (const city of cities) want[city] = want[city] || [];
  const proxy = getProxy(); let changed = false, touched = false;
  for (const [city, ids] of Object.entries(want)) {
    const list = c.cities[city], k = "bus|" + city;
    if (!list || healBusy[k] || !proxy) continue;
    const ign = new Set(c.ign[city] || []), miss = newMiss(ids, new Set(list.map(r => r[0])), ign);
    if (!miss.length) continue;
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), dk = "jisu_bus_heal_day|" + city;
    try { if (localStorage.getItem(dk) === day) continue; localStorage.setItem(dk, day); } catch (e) { continue; }
    healBusy[k] = true;
    let refreshed = false;
    try {
      const r = await fetch(nt(`${proxy}/bus/routes?c=${city}`));
      if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) { c.cities[city] = j; changed = true; refreshed = true; } }
    } catch (e) {}
    if (refreshed) {
      const have = new Set(c.cities[city].map(r => r[0]));
      c.ign[city] = [...ign, ...miss.filter(u => !have.has(u))].slice(-300);
      c.ct[city] = Date.now();
      touched = true;
    }
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
// v2.49.3：先用雲端已有的全縣市站牌（/od/citystops，不打 TDX）；雲端沒有這個縣市才問 TDX。
// 補救（heal）時：雲端名單也找不到要的站名，才帶 FRESH 問 TDX
async function cloudCityStops(city) {
  const j = await odGet(`/od/citystops?city=${city}`).catch(() => null);
  return j && Array.isArray(j.d) && j.d.length ? j.d.map(x => ({ StopUID: x[0], StopName: { Zh_tw: x[1] }, StopPosition: { PositionLat: x[2], PositionLon: x[3] } })) : null;
}
async function placeStops(city, heal, want) {
  let l = await cloudCityStops(city);
  if (l && heal && want && want.size) { const have = new Set(l.map(x => x.StopName.Zh_tw)); if ([...want].some(n => !have.has(n))) l = null; }
  if (!l) l = await tdx("main", `${BASE}/basic/v2/Bus/Stop/City/${city}?%24select=${enc("StopUID,StopName,StopPosition,Bearing,StationID")}&%24top=30000&%24format=JSON` + (heal ? FRESH : ""));
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
  const pack = x => [x.StationUID, ((x.StationName && x.StationName.Zh_tw) || "").replace(/^YouBike[12]\.0_/, ""),
    (x.StationAddress && x.StationAddress.Zh_tw) || "", r5(x.StationPosition.PositionLat), r5(x.StationPosition.PositionLon), x.BikesCapacity ?? null, x.ServiceType ?? null];
  if (city === "Taipei" || city === "NewTaipei") {
    const j = await odGet(`/od/bike?city=${city}`);
    return (j.list || []).filter(x => x.StationPosition).map(pack);
  }
  try {
    const j = await odGet(`/od/ybstn?city=${city}`);
    return (j.list || []).filter(x => x.StationPosition).map(pack);
  } catch (e) { return []; }
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
      part: st.status === "rejected" || bk.status === "rejected" || !(st.value && st.value.length) };   // 雲端沒站牌時不存成永久空名單
    if (!c.part) placeSave(c);
    return c;
  })().finally(() => { delete placeJobs[city]; });
}
// 自動補救：stops＝[{ uid, name }]（即時預估裡的站牌）、bikes＝[StationUID]；只檢查已存名單的縣市
function placeHeal(stops, bikes) { if (AUTO) return; placeHealA(stops, bikes).catch(() => {}); }
async function placeHealA(stops = [], bikes = []) {
  const want = {};
  for (const x of stops) { const city = UID_CITY[(x.uid || "").slice(0, 3)]; if (city && x.name) (want[city] = want[city] || { s: new Set(), b: new Set() }).s.add(x.name); }
  for (const u of bikes) { const city = UID_CITY[(u || "").slice(0, 3)]; if (city) (want[city] = want[city] || { s: new Set(), b: new Set() }).b.add(u); }
  for (const [city, w] of Object.entries(want)) {
    const c = await placeLoad(city); if (!c) continue;
    const S = placeSets[city] = placeSets[city] || { s: new Set(c.stops.map(x => x[0])), b: new Set(c.bikes.map(x => x[0])) };
    const now = Date.now();
    // 對不上才重讀；同縣市每天最多一次（只防重複下載，不讓資料過期）
    const sDay = new Date(now + 8 * 3600000).toISOString().slice(0, 10), sKey = "jisu_place_heal_day|" + city;
    let needS = [...w.s].some(n => !S.s.has(n));
    if (needS) { try { if (localStorage.getItem(sKey) === sDay) needS = false; else localStorage.setItem(sKey, sDay); } catch (e) { needS = false; } }
    const needB = now - c.tb > DAY_MS && [...w.b].some(u => !S.b.has(u));
    for (const [need, kind] of [[needS, "s"], [needB, "b"]]) {
      if (!need || healing[city + kind]) continue;
      healing[city + kind] = true;
      (kind === "s" ? placeStops(city, true, new Set([...w.s].filter(n => !S.s.has(n)))) : placeBikes(city, true)).then(l => {
        const cur = placeMem[city] || c;
        if (!Array.isArray(l) || !l.length) return;   // 雲端沒資料：不覆蓋舊名單
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
  const eta = await busNearEta(lat.toFixed(4), lon.toFixed(4), rad, "main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat.toFixed(4), lon.toFixed(4), rad)}&%24top=400&%24format=JSON`);
  try { placeHeal(eta.map(e => ({ uid: e.StopUID, name: e.StopName && e.StopName.Zh_tw }))); } catch (e) {}
  const routes = {};
  for (const it of eta) {
    if (((it.StopName && it.StopName.Zh_tw) || "") !== name) continue;
    const dirNum = it.Direction === 1 ? 1 : 0, sec = typeof it.EstimateTime === "number" ? it.EstimateTime : null;
    const x = { route: (it.RouteName && it.RouteName.Zh_tw) || "?", routeUID: it.RouteUID || null, dirNum, stopUID: it.StopUID || null, sec, status: it.StopStatus ?? 0, next: it.NextBusTime || null, noLive: !!it.noLive, noRoutes: !!it.noRoutes, src: it.src || "pda-stop" };
    const k = `${x.routeUID}|${dirNum}|${x.stopUID || ""}`, old = routes[k];
    if (!old || (sec !== null && (old.sec === null || sec < old.sec))) routes[k] = x;
  }
  const list = Object.values(routes);
  await refreshNwtRoutes(list).catch(() => {});
  let destMap = {}; try { destMap = await loadRouteDest("main", list.map(x => x.routeUID)); } catch (e) {}
  for (const x of list) x.dest = destOf(x.routeUID, x.dirNum, destMap);
  return { name, lat, lon, dist: uLat == null ? null : haversine(uLat, uLon, lat, lon), bear: null, side: null, bearTxt: null, routes: list };
}
// YouBike 搜尋結果點進去：只查這一站的車位（90秒內重用）
async function bikeAt({ uid, uLat = null, uLon = null, ...b }) {
  const city = UID_CITY[(uid || "").slice(0, 3)];
  let a = {};
  let feedHit = false, src = null;
  if (city && isCloudBike(uid)) try { const feed = await youbikeFeed(false); if (feed[uid]) { a = feed[uid]; feedHit = true; src = "yb"; } } catch (e) {}
  // 官網沒有此站或失敗時，雙北才改市府資料；TDX 備援已全數移除。
  if (!feedHit && city && isOdBike(uid)) { try { const b = ((await odMemoGet(`/od/bike?ids=${uid}`, 90000)).list || [])[0]; if (b) { a = b; src = "od"; } } catch (e) {} }
  if (a.StationUID) try { placeHeal([], [a.StationUID]); } catch (e) {}
  const det = a.AvailableRentBikesDetail || null;
  const noLive = !src || (typeof a.AvailableRentBikes !== "number" && typeof a.AvailableReturnBikes !== "number");
  return { ...b, uid, type: BIKE_TYPE[b.type] || b.type || null, dist: uLat == null ? null : haversine(uLat, uLon, b.lat, b.lon),
    rent: typeof a.AvailableRentBikes === "number" ? a.AvailableRentBikes : null, ret: typeof a.AvailableReturnBikes === "number" ? a.AvailableReturnBikes : null,
    general: det ? det.GeneralBikes ?? null : null, electric: det ? det.ElectricBikes ?? null : null,
    status: typeof a.ServiceStatus === "number" ? a.ServiceStatus : null, update: a.SrcUpdateTime || a.UpdateTime || null, src: src || "none", noLive };
}

// 推播／下車提醒（Worker 端點）
async function pushCall(method, path, body) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const r = await fetch(proxy + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) throw new Error(j.message || ("錯誤 " + r.status));
  return j;
}

// ---------- v2.35.0 公車目的地篩選（資料只存雲端） ----------
// 手機把附近站牌的「路線、方向、站牌」和目的地（打字中的字／選定的站名／地點座標）送給 Worker（POST /bus/dest），Worker 用存在雲端的整縣市站序比對後只回結果；
// 不打 TDX。手機只在這次使用期間記住單次結果（記憶體），不存整份站序。這個縣市雲端還沒有站序（第一次有人用）才請 Worker 建一次（/bus/sor，每個縣市只抓一次 TDX）
const busDestMemo = new Map(), busSorAsked = new Set();
async function busDest(p) {
  const b = [], seen = new Set();
  for (const st of p.stops || []) for (const r of st.routes || []) {
    const k = routeKind(r.routeUID); if (!k || !r.stopUID) continue;
    const city = k.kind === "intercity" ? "InterCity" : k.city, key = r.routeUID + "|" + (r.dirNum ? 1 : 0) + "|" + r.stopUID;
    if (seen.has(key)) continue; seen.add(key); b.push([r.routeUID, r.dirNum ? 1 : 0, r.stopUID, city, st.name || ""]);
  }
  if (!b.length) return p.q != null ? { sug: [] } : { res: [] };
  const body = { b: b.slice(0, 120), ...(p.q != null ? { q: String(p.q).slice(0, 30) } : p.name ? { name: p.name } : { lat: +p.lat, lon: +p.lon, r: 400 }) };
  const mk = JSON.stringify(body), h = busDestMemo.get(mk); if (h) return h;
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const s = getSession();
  const post = async () => {
    let r, j = null;
    try { r = await fetch(nt(proxy + "/bus/dest"), { method: "POST", headers: { "content-type": "application/json", ...(s ? { "x-session": s.token } : {}) }, body: mk }); j = await r.json().catch(() => null); }
    catch (e) { throw new Error("連不到伺服器，請確認網路"); }
    if (!r.ok) throw new Error(r.status === 401 ? "請重新登入" : (j && j.message) || ("錯誤 " + r.status));
    return j;
  };
  let j = await post();
  const need = (j.need || []).filter(c => !busSorAsked.has(c));
  if (need.length) {   // 雲端還沒有這些縣市的站序：請 Worker 建一次（之後所有人共用），建好再問一次
    need.forEach(c => busSorAsked.add(c));
    const ok = await Promise.all(need.map(c => authedGet("/bus/sor?c=" + c).then(() => true).catch(() => false)));
    if (ok.some(Boolean)) j = await post();
  }
  if (!j.upd) busDestMemo.set(mk, j);   // 雲端正在更新站序：先不記，之後再查拿新資料
  if (busDestMemo.size > 60) busDestMemo.delete(busDestMemo.keys().next().value);
  return j;
}

// ---------- 登入（帳號存在 Worker；裝置只存 session token，登出前不必再登入） ----------
// ---------- 路線規劃（v2.13.0）：TDX MaaS routing（經 Worker /plan）＋ OpenStreetMap 地點搜尋（經 Worker /geo） ----------
// MaaS 回傳的路段沒有任何代碼（RouteUID／StationID），所以用「名稱＋座標」對回 App 自己的車站清單與公車路線清單，才能顯示即時到站、點進車站頁／路線頁
async function authedGet(path, ms = 30000) {
  const proxy = getProxy(); if (!proxy) throw new Error("NO_PROXY");
  const s = getSession();
  let r, j = null;
  try { r = await fetchT(nt(proxy + path), ms, { headers: s ? { "x-session": s.token } : {} }); j = await r.json().catch(() => null); }   // 30 秒：含路線規劃、大型清單下載
  catch (e) { throw new Error(e && e.name === "AbortError" ? TIMEOUT_MSG : "連不到伺服器，請確認網路"); }
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
        stops: (s.intermediateStops || []).map(x => pPlace(x.departure || x.arrival)), ...(s.stopCount ? { stopCount: s.stopCount } : {}), ...(t.trainType ? { trainType: t.trainType } : {}), ...(t.est ? { est: true } : {}), ...(t.liveDep ? { liveDep: true } : {}) });
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
    out.push({ sig, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), approx, legs, src: r.source === "google" ? "google" : r.source === "timetable" ? "tt" : r.source === "self" ? "self" : "tdx", ...(r.polyline ? { poly: r.polyline } : {}), ...(r.tightNote ? { tightNote: r.tightNote } : {}), ...(r.busNote ? { busNote: r.busNote } : {}) });
  }
  return out.filter(r => !r.approx).concat(out.filter(r => r.approx));
}
// TDX 規劃網路還沒收錄的新車站（例如淡水信義線東延段的廣慈/奉天宮，TDX 一律改走到板南線永春站）：
// 起訖點是這種車站時，改用同一條線上相鄰、TDX 認得的車站去查，並在結果上註明
const TDX_MISSING = { "廣慈/奉天宮": { name: "象山", lat: 25.032871, lon: 121.570029, line: "淡水信義線", mode: 6 } };
const planIsStation = p => !!p && !p.here && (!!p.st || /北捷|新北捷|機捷|桃捷|中捷|高捷|捷運|輕軌|台鐵|高鐵/.test(p.sub || ""));
// v2.34.0：Worker 有問 Google 時兩組都帶回來（data.cand），前端不再「兩組挑一組」（舊的 planPickG），合併後一起校正、去重、排序（最多8條）
// ---------- v2.44.0 軌道自算規劃 ----------
// 起訖點都是軌道車站時，用雲端的官方時刻表自己排路線（不靠 Google／TDX 規劃）：
// 台鐵、高鐵用當天適用的時刻表（railTrains：定期表依星期與有效期間，連假用當天實際時刻表）；捷運／輕軌用由各站時刻表串好的整班車（TRIPS_系統）。
// 方法：Connection Scan（所有班次的「站→下一站」依開車時間排序掃一遍），同時記「搭了幾段車」，
// 找出每個搭乘段數最早到的走法（段數少但只晚一點的也列出來）；再從第一班車的下一分鐘重掃，多給幾個出發時間。
// 文湖線、台中捷運只有班距：依首末班＋班距＋站間行駛時間排出「估算班次」一起算（這幾段標「依班距估計」）。
// 轉乘時間（使用者訂的規則）：同站轉乘 3 分（同一站換車、或同系統同名站 150 公尺內，例如民權西路 R13↔O11）；
// 出站轉乘依直線距離：3 分＋每 100 公尺 1 分（200 公尺 5 分、300 公尺 6 分…，最遠 500 公尺）。
// 轉乘時間內就開走、但趕得上會更早到的車：另外算一次，在路線上用小字提醒（tightNote）。
const RP_OPS = { 4: ["TRA"], 3: ["THSR"], 6: ["TRTC", "NTMC", "TYMC", "KRTC", "TMRT"], 7: ["KLRT", "NTDLRT", "NTALRT"] };
const RP_LINE_ZH = { TRTC: { BL: "板南線", BR: "文湖線", R: "淡水信義線", G: "松山新店線", O: "中和新蘆線", Y: "環狀線", RA: "新北投支線", GA: "小碧潭支線" }, NTMC: { Y: "環狀線", LB: "三鶯線" },
  KRTC: { R: "紅線", O: "橘線", C: "環狀輕軌" }, TMRT: { G: "綠線" }, KLRT: { C: "環狀輕軌" }, TYMC: { A: "機場線" }, NTDLRT: { V: "淡海輕軌" }, NTALRT: { K: "安坑輕軌" } };
const RP_LRT = { KLRT: 1, NTDLRT: 1, NTALRT: 1 };
const RP_CHG = () => 3;
const RP_K = 4, RP_FP = 500, RP_MS = 60000;
const rpBig = op => op === "TRA" || op === "THSR";
const rpWalk = m => Math.ceil(m / 100);
const rpSameSt = (a, b, d) => a.op === b.op && d < 150 && pn(a.name) === pn(b.name);   // 同系統同名站（站內轉乘）；台鐵↔高鐵、捷運↔台鐵 同名也要出站，算距離
const rpXfer = (a, b, d) => rpSameSt(a, b, d) ? 3 : 3 + rpWalk(d);            // 規則內的轉乘時間
const rpTight = (a, b, d) => rpSameSt(a, b, d) ? 1 : Math.max(1, rpWalk(d));   // 用跑的、不留餘裕的時間（提醒用）
// 只有班距的線（文湖線、台中捷運）：依首末班、班距（取最短與最長的中間）、站間行駛時間排出估算班次
async function rpHwTrips(op, day) {
  const T = await ttLoad(op).catch(() => null); if (!T) return [];
  const src = op === "TMRT" ? T : T.hw, lines = op === "TMRT" ? ["G"] : (HW_LINES[op] || []);
  if (!src || !src.freq || !src.fl || !T.sol) return [];
  const di = await dayInfo(day), s2s = T.s2s || {}, out = [];
  const am = x => { const v = toMin(x); return v < 180 ? v + 1440 : v; };
  for (const L of lines) {
    const sol = (T.sol.find(l => l.line === L) || {}).st; if (!sol || sol.length < 2) continue;
    const fq = src.freq.filter(f => !(f.LineID || f.LineNo) || (f.LineID || f.LineNo) === L || (op === "TMRT"));
    const key = di.hol ? (fq.some(f => f.ServiceDay && f.ServiceDay.NationalHolidays) ? "NationalHolidays" : "Sunday") : di.key;
    const plan = fq.find(f => f.ServiceDay && f.ServiceDay[key]) || fq[0]; if (!plan) continue;
    const bands = (plan.Headways || []).map(h => ({ s: am(h.StartTime), e: h.EndTime === "24:00" || h.EndTime === "00:00" ? 1440 : am(h.EndTime), hw: Math.round(((h.MinHeadwayMins || h.MaxHeadwayMins || 10) + (h.MaxHeadwayMins || h.MinHeadwayMins || 10)) / 2) })).sort((a, b) => a.s - b.s);
    const hwAt = t => { const b = bands.find(x => t >= x.s && t < x.e) || bands.filter(x => x.s <= t).pop() || bands[0]; return Math.max(2, (b && b.hw) || 10); };
    for (const seq of [sol, sol.slice().reverse()]) {
      const o = seq[0][0], dst = seq[seq.length - 1][0];
      const r = src.fl.find(x => x.StationID === o && (x.DestinationStationID === dst || zh(x.DestinationStationName) === seq[seq.length - 1][1]) && (!x.ServiceDay || x.ServiceDay[key] !== false))
        || src.fl.find(x => x.StationID === o && (!x.ServiceDay || x.ServiceDay[key] !== false));
      const first = r ? am(r.FirstTrainTime) : bands.length ? bands[0].s : 360, last = r ? am(r.LastTrainTime) : bands.length ? bands[bands.length - 1].e : 1440;
      const off = [0]; let sec = 0;
      for (let i = 1; i < seq.length; i++) { sec += s2s[seq[i - 1][0] + "|" + seq[i][0]] || 120; off.push(Math.round(sec / 60)); }
      for (let t = first; t <= last; t += hwAt(t)) out.push({ op, line: L, dest: seq[seq.length - 1][1], est: true, p: seq.map((x, i) => [x[0], t + off[i]]) });
    }
  }
  return out;
}
// 某營運日的所有班次（台北時間絕對毫秒）：trips[i].pts＝[[站鍵, 到, 開]]；C＝[開, 到, 班次, 第幾站]，依開車時間排序
const rpDayMem = {};
function rpDay(ops, day) {
  const key = ops.join(",") + "|" + isoDay(day); if (rpDayMem[key]) return rpDayMem[key];
  return rpDayMem[key] = (async () => {
    const base = tpeMid(day), C = [], trips = [];
    for (const op of ops) {
      if (rpBig(op)) {
        const P = await railTrains(op, day).catch(() => null); if (!P) continue;
        for (const t of P.trains) {
          if (t.pts.length < 2) continue;
          const ti = trips.length;
          trips.push({ op, no: t.no, type: (t.raw && t.raw[1]) || t.type, start: t.start, dest: t.dest, pts: t.pts.map(p => [op + ":" + p[0], base + p[1] * RP_MS, base + p[2] * RP_MS]) });
          for (let k = 0; k + 1 < t.pts.length; k++) C.push([base + t.pts[k][2] * RP_MS, base + t.pts[k + 1][1] * RP_MS, ti, k]);
        }
      } else {
        for (const h of await rpHwTrips(op, day).catch(() => [])) {   // 只有班距的線：估算班次
          const ti = trips.length;
          trips.push({ op, line: h.line, dest: h.dest, est: true, pts: h.p.map(p => [op + ":" + p[0], base + p[1] * RP_MS, base + p[1] * RP_MS, true]) });
          for (let k = 0; k + 1 < h.p.length; k++) C.push([base + h.p[k][1] * RP_MS, base + h.p[k + 1][1] * RP_MS, ti, k]);
        }
        const X = await tripIdx(op).catch(() => null); if (!X) continue;
        const ok = await tripDayGroups(X, day);
        for (const t of X.trips) {
          if (!ok.has(t.g.sd) || t.p.length < 2) continue;
          const ti = trips.length;
          trips.push({ op, line: t.g.l, dest: t.g.dn, pts: t.p.map(p => [op + ":" + p[0], base + p[1] * RP_MS, base + p[1] * RP_MS, !!p[2]]) });
          for (let k = 0; k + 1 < t.p.length; k++) C.push([base + t.p[k][1] * RP_MS, base + t.p[k + 1][1] * RP_MS, ti, k]);
        }
      }
    }
    C.sort((a, b) => a[0] - b[0]);
    return { C, trips };
  })().catch(e => { delete rpDayMem[key]; throw e; });
}
// 兩天合併（深夜查詢要接到隔天早上的車）
function rpMerge(A, B) {
  if (!B) return A;
  const off = A.trips.length, trips = A.trips.concat(B.trips), C = new Array(A.C.length + B.C.length);
  let i = 0, j = 0, n = 0;
  while (i < A.C.length || j < B.C.length) {
    if (j >= B.C.length || (i < A.C.length && A.C[i][0] <= B.C[j][0])) C[n++] = A.C[i++];
    else { const c = B.C[j++]; C[n++] = [c[0], c[1], c[2] + off, c[3]]; }
  }
  return { C, trips };
}
// 車站（站鍵 → 名稱、座標）與 400 公尺內可以走過去轉乘的站
const rpStMem = {};
function rpStations(ops) {
  const key = ops.join(","); if (rpStMem[key]) return rpStMem[key];
  return rpStMem[key] = (async () => {
    const all = (await loadRailStations().catch(() => [])).filter(s => ops.includes(s.op) && s.lat != null);
    const info = new Map(), cell = new Map(), ck = (a, b) => Math.floor(a / 0.004) + "," + Math.floor(b / 0.004);
    for (const s of all) { const k = s.op + ":" + s.id; if (info.has(k)) continue; info.set(k, { key: k, op: s.op, id: s.id, name: s.name, lat: s.lat, lon: s.lon }); const c = ck(s.lat, s.lon); if (!cell.has(c)) cell.set(c, []); cell.get(c).push(k); }
    const near = (lat, lon, r) => { const out = [], a = Math.floor(lat / 0.004), b = Math.floor(lon / 0.004);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of cell.get((a + i) + "," + (b + j)) || []) { const s = info.get(k), d = haversine(lat, lon, s.lat, s.lon); if (d <= r) out.push([s, d]); }
      return out; };
    const foot = new Map();
    for (const s of info.values()) foot.set(s.key, near(s.lat, s.lon, RP_FP).filter(([x]) => x.key !== s.key).map(([x, d]) => [x.key, rpXfer(s, x, d), rpTight(s, x, d)]));
    return { info, near, foot };
  })().catch(e => { delete rpStMem[key]; throw e; });
}
// 起訖點 → 可以進出的車站與步行分鐘：選的那一站本身 0 分；附近其他車站（同名或 400 公尺內）＝步行＋進出站 3 分
function rpEnds(S, p) {
  const out = new Map(), nm = pn(p.name || "");
  for (const [s, d] of S.near(p.lat, p.lon, RP_FP)) {
    const same = pn(s.name) === nm && d <= 300;
    const m = same ? 0 : rpWalk(d) + 3;   // 選的那一站 0 分；別站＝出站轉乘的規則
    if (!out.has(s.key) || out.get(s.key) > m) out.set(s.key, m);
  }
  return out;
}
// 一次掃描：t0 之後出發，回傳各搭乘段數的最佳走法（每條是 [{ ti, b, a }...] 加頭尾步行）
function rpScan(net, S, src, dst, t0, tMax) {
  const { C, trips } = net, K = RP_K;
  const R = Array.from({ length: K + 1 }, () => new Map());      // 搭了 j 段車後，在某站「可以上車」的最早時間
  const A = Array.from({ length: K + 1 }, () => new Map());      // 搭了 j 段車、在某站下車的最早時間
  const T = new Map();                                             // 班次 → 各段數的上車資訊
  for (const [k, m] of src) R[0].set(k, { t: t0 + m * RP_MS, src: m });
  const best = new Array(K + 1).fill(Infinity);
  let lo = 0, hi = C.length; while (lo < hi) { const md = (lo + hi) >> 1; if (C[md][0] < t0) lo = md + 1; else hi = md; }
  const upd = (j, k, lab) => { const o = R[j].get(k); if (!o || lab.t < o.t) R[j].set(k, lab); };
  for (let i = lo; i < C.length; i++) {
    const c = C[i]; if (c[0] > tMax) break;
    const minB = Math.min(...best); if (c[0] > minB + 180 * RP_MS) break;   // 已經有走法：比最快的晚三小時以上才開的車不用看（轉乘少、晚一點到的也要找得到）
    const tr = trips[c[2]], from = tr.pts[c[3]][0], to = tr.pts[c[3] + 1][0];
    let st = T.get(c[2]);
    for (let j = 0; j < K; j++) {
      if (!st || !st[j]) { const r = R[j].get(from); if (r && r.t <= c[0]) { if (!st) { st = new Array(K).fill(null); T.set(c[2], st); } st[j] = { at: c[3], prev: r, j }; } }
      if (!st || !st[j]) continue;
      let pm = Infinity; for (let q = 1; q <= j + 1; q++) if (best[q] < pm) pm = best[q];
      if (c[1] >= pm) continue;   // 比「搭乘段數一樣或更少」的已知走法晚到：不用再算
      const o = A[j + 1].get(to); if (o && o.t <= c[1]) continue;
      const lab = { t: c[1], ti: c[2], b: st[j], a: c[3] + 1, node: to };
      A[j + 1].set(to, lab);
      const eg = dst.get(to); if (eg != null && c[1] + eg * RP_MS < best[j + 1]) { best[j + 1] = c[1] + eg * RP_MS; lab.goal = true; }
      if (j + 1 < K) {
        upd(j + 1, to, { t: c[1] + RP_CHG(tr.op) * RP_MS, ride: lab, node: to });
        for (const [w, m] of S.foot.get(to) || []) upd(j + 1, w, { t: c[1] + m * RP_MS, ride: lab, node: w, walk: m });
      }
    }
  }
  // 每個段數各取最早到的那條，只留「段數多、但比較早到」的（柏拉圖）
  const out = []; let lastT = Infinity;
  for (let k = 1; k <= K; k++) {
    if (!(best[k] < lastT)) continue;
    let pick = null, pt = Infinity;
    for (const [node, lab] of A[k]) { const eg = dst.get(node); if (eg == null) continue; const t = lab.t + eg * RP_MS; if (t < pt) { pt = t; pick = lab; } }
    if (!pick) continue;
    const rides = []; let lab = pick, startWalk = 0;
    while (lab) {
      rides.unshift({ ti: lab.ti, b: lab.b.at, a: lab.a, walkTo: 0 });
      const prev = lab.b.prev;
      if (prev.src != null) { startWalk = prev.src; break; }
      if (prev.walk) rides[0].walkFrom = prev.walk;
      lab = prev.ride;
    }
    out.push({ rides, startWalk, endWalk: dst.get(pick.node), arr: pt });
    lastT = pt;
  }
  return out;
}
// ---------- 公車接駁（起訖點不是車站時的頭尾段） ----------
// 起點：附近 400 公尺站牌的公車（即時預估＋雲端站序），坐到某個軌道車站 300 公尺內的站牌；終點反過來（車站附近上車、終點附近下車）。
// 公車行駛時間用站序座標估：路線距離÷每分鐘 250 公尺＋每站 0.3 分；等車：現在出發用即時預估（第一段），其他估 5 分（有 2 條以上路線可搭估 3 分）。
// 同一個站牌（150 公尺內）有好幾條路線都到同一個車站時，一起列出（例：榮總→石牌 508／小8／128…），哪班先來搭哪班：現在出發取即時預估最早的一班。
// 軌道車站 800 公尺內也可以直接走過去（路上步行：OSRM 實際距離，沒有就直線×1.3；÷每分鐘 75 公尺，進出站另加 3 分）。
const RP_BUS_R = 400, RP_BUS_ST = 300, RP_WALK_ST = 800, RP_BUS_WAIT = 5, RP_DIR_R = 600;
// 現在出發的發車時間：有即時預估且走得到 → 用即時；這班來不及 → 估下一班（再等 8 分）；沒有預估但有預定發車時間 → 用預定；
// 都沒有（末班已過、今日未營運、還沒發車又沒時間）→ 不用這條。指定時間出發：一律估等 5 分（好幾條可搭 3 分）
function rpDepAt(b, ready, live, many) {
  if (!live) return { dep: ready + (many ? 3 : RP_BUS_WAIT) * RP_MS, live: false };
  if (b.eta != null) { const e = Date.now() + b.eta * 1000; return e >= ready ? { dep: e, live: true } : { dep: ready + 8 * RP_MS, live: false }; }
  if (b.nb && b.nb > Date.now() - 60000) return { dep: Math.max(b.nb, ready), live: false };
  return null;
}
const RP_WSPD = 75;   // 步行速度（公尺／分）：和 Google 步行段相近（約 60～74）
const rpStreet = d => Math.ceil(d * 1.3 / RP_WSPD);
// ---------- 實際步行距離（OSRM 公用伺服器：FOSSGIS 架的 routing.openstreetmap.de 步行版，OpenStreetMap 路網） ----------
// 起點／終點到附近車站、站牌的走路距離：一次問一張表（table：1 個起點對多個目的地），結果記在本機 30 天。
// 免費示範服務：每秒最多 1 次（排隊送）、可能連不上 → 逾時（4 秒）或失敗就照舊用「直線×1.3」估。走路時間＝距離÷每分鐘 75 公尺。
const RP_OSRM = "https://routing.openstreetmap.de/routed-foot/table/v1/foot/", RP_OS_TTL = 30 * 864e5;
const rpLL = (lat, lon) => (+lat).toFixed(4) + "," + (+lon).toFixed(4);
let rpOsLast = 0, rpOsQ = Promise.resolve(), rpOsMem = null;
function rpOsCache() { if (!rpOsMem) { try { rpOsMem = JSON.parse(localStorage.getItem("jisu_walk2") || "{}") || {}; } catch (e) { rpOsMem = {}; } } return rpOsMem; }
function rpOsSave() {
  try { const c = rpOsMem, ks = Object.keys(c); if (ks.length > 3000) ks.sort((a, b) => c[a][1] - c[b][1]).slice(0, ks.length - 2500).forEach(k => delete c[k]); localStorage.setItem("jisu_walk2", JSON.stringify(c)); } catch (e) {}
}
// p：起點 {lat,lon}；pts：[[lat,lon]] → Map(「lat,lon」→ 公尺)。起點本身離道路的距離（例如在醫院園區裡）加上去；
// 目的地（站牌、車站）那端不加：站牌本來就在路邊，加了反而短距離過馬路會多算 20～45 公尺（和 Google 比對過）
async function rpWalkMap(p, pts) {
  const C = rpOsCache(), W = new Map(), need = [], now = Date.now(), seen = new Set(), src = rpLL(p.lat, p.lon);
  for (const q of pts) {
    if (q[0] == null || q[1] == null) continue; const k = rpLL(q[0], q[1]); if (seen.has(k)) continue; seen.add(k);
    const v = C[src + ">" + k]; if (v && now - v[1] < RP_OS_TTL) W.set(k, v[0]); else need.push([k, q]);
  }
  for (let s = 0; s < need.length; s += 90) {
    const part = need.slice(s, s + 90);
    const job = rpOsQ.then(async () => {
      const wait = rpOsLast + 1100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      rpOsLast = Date.now();
      const url = RP_OSRM + [[p.lat, p.lon], ...part.map(x => x[1])].map(q => (+q[1]).toFixed(5) + "," + (+q[0]).toFixed(5)).join(";") + "?sources=0&annotations=distance";
      const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 4000);
      try { const r = await fetch(url, { signal: ac.signal }); return r.ok ? await r.json() : null; } finally { clearTimeout(tm); }
    });
    rpOsQ = job.catch(() => null);
    const j = await job.catch(() => null);
    if (!j || j.code !== "Ok" || !j.distances || !j.distances[0]) break;   // 連不上：剩下的照估算
    const s0 = Math.min(150, ((j.sources || [])[0] || {}).distance || 0);
    part.forEach(([k, q], n) => {
      const d = j.distances[0][n + 1]; if (d == null) return;
      const v = Math.round(d + s0);
      W.set(k, v); C[src + ">" + k] = [v, now];
    });
  }
  if (need.length) rpOsSave();
  return W;
}
// 路上步行公尺：有 OSRM 就用（不會短於直線；比直線長 4 倍以上多半是定位到別條路，改回估算），沒有就直線×1.3
function rpWalkM(W, p, lat, lon) { const s = haversine(p.lat, p.lon, lat, lon), v = W && W.get(rpLL(lat, lon)); return v != null && v <= s * 4 + 200 ? Math.max(v, s) : s * 1.3; }
const rpStreetW = (W, p, lat, lon) => Math.ceil(rpWalkM(W, p, lat, lon) / RP_WSPD);
// 要問步行距離的點：附近車站（RP_WALK_ST 內）＋附近公車的上下車站牌（＋直達公車在終點附近的下車站牌）
function rpWalkPts(S, p, B, dirTo) {
  const out = S ? S.near(p.lat, p.lon, RP_WALK_ST).map(([x]) => [x.lat, x.lon, false]) : [];
  for (const r of (B && B.rows) || []) {
    const sq = rpSeq(B.sor, r.RouteUID, r.Direction); if (!sq) continue;
    const st = sq.Stops || [], i = st.findIndex(x => x.StopUID === r.StopUID); if (i < 0 || !st[i].P) continue;
    if (!dirTo) { out.push([st[i].P[0], st[i].P[1], true]); continue; }
    for (let j = i + 1; j < st.length && j <= i + 80; j++) { const P = st[j].P; if (P && haversine(P[0], P[1], dirTo.lat, dirTo.lon) <= RP_DIR_R) out.push([P[0], P[1], true]); }
  }
  return out;
}
async function rpBusNear(p) {
  const lat = +(+p.lat).toFixed(4), lon = +(+p.lon).toFixed(4);
  const rows = await busNearEta(lat, lon, RP_BUS_R, "main", `${BASE}/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy${nearbyQ(lat, lon, RP_BUS_R)}&%24top=600&%24format=JSON`, null, false).catch(() => []);
  const uids = [...new Set((rows || []).map(r => r.RouteUID).filter(Boolean))].slice(0, 40);
  return { rows: rows || [], sor: uids.length ? await cloudSor(uids) : {} };
}
const rpSeq = (sor, uid, dir) => (sor[uid] || []).find(r => (r.Direction === 1 ? 1 : 0) === (dir === 1 ? 1 : 0)) || null;
const rpRide = (st, i, j) => { let m = 0; for (let k = i + 1; k <= j; k++) { const a = st[k - 1].P, b = st[k].P; m += a && b ? haversine(a[0], a[1], b[0], b[1]) : 400; } return Math.ceil(m / 250 + 0.3 * (j - i)); };
const rpStopNm = x => (x && x.StopName && x.StopName.Zh_tw) || "";
function rpBusOpts(B, S, p, acc, W) {   // acc：起點（往後找車站）；否則終點（往前找車站）
  const out = [], seen = new Set();
  for (const r of B.rows) {
    const k = r.RouteUID + "|" + r.Direction + "|" + r.StopUID; if (seen.has(k)) continue; seen.add(k);
    const sq = rpSeq(B.sor, r.RouteUID, r.Direction); if (!sq) continue;
    const st = sq.Stops || [], i = st.findIndex(x => x.StopUID === r.StopUID); if (i < 0 || !st[i].P) continue;
    const walkM = Math.round(rpWalkM(W, p, st[i].P[0], st[i].P[1])), walk = Math.ceil(walkM / RP_WSPD), best = new Map();
    const rng = acc ? [i + 1, Math.min(st.length - 1, i + 60), 1] : [i - 1, Math.max(0, i - 60), -1];
    for (let j = rng[0]; acc ? j <= rng[1] : j >= rng[1]; j += rng[2]) {
      const P = st[j].P; if (!P) continue;
      for (const [x, dd] of S.near(P[0], P[1], RP_BUS_ST)) {
        const ride = acc ? rpRide(st, i, j) : rpRide(st, j, i), m = ride + 3 + rpWalk(dd), b = best.get(x.key);
        if (!b || m < b.m) best.set(x.key, { j, ride, m, st: 3 + rpWalk(dd) });
      }
    }
    for (const [key, b] of best) out.push({ key, walk, walkM, a: acc ? i : b.j, b: acc ? b.j : i, ride: b.ride, stWalk: b.st, seq: st, uid: r.RouteUID, name: zh(r.RouteName) || "",
      eta: acc && (r.StopStatus ?? 0) === 0 && typeof r.EstimateTime === "number" ? r.EstimateTime : null, nb: acc && r.StopStatus === 1 && r.NextBusTime ? Date.parse(r.NextBusTime) || null : null });
  }
  return out;
}
// 起點能進到哪些車站、各要幾分鐘（t0 起算）；how 記下是走路還是坐公車
const rpNear = (a, b) => { const p = a.seq[a.a].P, q = b.seq[b.a].P; return p && q && haversine(p[0], p[1], q[0], q[1]) <= 150; };
// 同一站牌出發、到同一車站、車程差不多（多 5 分內）的其他路線；現在出發只列有即時預估（正在營運）的，依到站先後排
function rpAlts(b, list, live, ready) {
  const m = new Map();
  for (const x of list) {
    if (x === b || x.key !== b.key || !rpNear(x, b) || !x.name || x.name === b.name || x.ride > b.ride + 5) continue;
    const at = x.eta != null ? Date.now() + x.eta * 1000 : null;
    if (live && (at == null || (ready != null && at < ready))) continue;
    if (!m.has(x.name) || (at != null && (m.get(x.name).at == null || at < m.get(x.name).at))) m.set(x.name, { name: x.name, at });
  }
  return [...m.values()].sort((p, q) => (p.at ?? 9e15) - (q.at ?? 9e15));
}
const rpAltTxt = (b, alts, live) => [b.name + (live && b.dep ? `（${hmTpe(b.dep)}）` : ""), ...alts.slice(0, 5).map(a => a.name + (a.at ? `（${hmTpe(a.at)}）` : ""))].join("、") + (alts.length > 5 ? ` 等 ${alts.length + 1} 條` : "");
function rpAccess(S, o, isSt, bus, t0, live, W) {
  const src = new Map(), how = new Map(), put = (k, m, h) => { if (!src.has(k) || src.get(k) > m) { src.set(k, m); how.set(k, h); } };
  if (isSt) for (const [k, m] of rpEnds(S, o)) put(k, m, { type: "walk", m });
  else for (const [x] of S.near(o.lat, o.lon, RP_WALK_ST)) { const len = Math.round(rpWalkM(W, o, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len }); }
  for (const b of bus) {
    const ready = t0 + b.walk * RP_MS, alts = rpAlts(b, bus, live, ready), q = rpDepAt(b, ready, live, alts.length > 0); if (!q) continue;
    const dep = q.dep, lv = q.live;
    const m = Math.ceil((dep + (b.ride + b.stWalk) * RP_MS - t0) / RP_MS);
    put(b.key, m, { type: "bus", m, opt: b, dep, live: lv, alts });
  }
  return { src, how };
}
function rpEgress(S, d, isSt, bus, W) {
  const dst = new Map(), how = new Map(), put = (k, m, h) => { if (!dst.has(k) || dst.get(k) > m) { dst.set(k, m); how.set(k, h); } };
  if (isSt) for (const [k, m] of rpEnds(S, d)) put(k, m, { type: "walk", m });
  else for (const [x] of S.near(d.lat, d.lon, RP_WALK_ST)) { const len = Math.round(rpWalkM(W, d, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len }); }
  for (const b of bus) {   // 終點那頭：同一站牌好幾條路線都到終點附近，等車估 3 分
    const alts = rpAlts(b, bus, false, null), w = alts.length ? 3 : RP_BUS_WAIT, m = b.stWalk + w + b.ride + b.walk;
    put(b.key, m, { type: "bus", m, opt: b, alts, wait: w });
  }
  return { dst, how };
}
// 公車那一段（路線格式）：沿途各站時間依距離比例推
function rpBusSec(b, dep, live, isoT, alts) {
  const st = b.seq, pl = (x, t) => ({ time: isoT(t), place: { name: rpStopNm(x), type: "stop", location: x.P ? { lat: x.P[0], lng: x.P[1] } : {} } });
  const arr = dep + b.ride * RP_MS, mids = [];
  for (let k = b.a + 1; k < b.b; k++) mids.push({ departure: pl(st[k], dep + rpRide(st, b.a, k) * RP_MS) });
  const nm = [b.name, ...(alts || []).map(a => a.name)].slice(0, 3).join("／") + ((alts || []).length > 2 ? "等" : "");
  return { type: "transit", transport: { mode: "bus", name: nm, headsign: (alts || []).length ? rpStopNm(st[b.b]) : rpStopNm(st[st.length - 1]), ...(live ? { liveDep: true } : { est: true }) }, agency: { agency_id: "bus", name: "公車" },
    departure: pl(st[b.a], dep), arrival: pl(st[b.b], arr), intermediateStops: mids, stopCount: b.b - b.a, travelSummary: { duration: Math.round((arr - dep) / 1000) } };
}
// 轉成和 TDX／Google 一樣的路線格式（給 planClean）
function rpRoute(net, S, J, o, d) {
  const { trips } = net, sec = [], isoT = ms => isoTpe(ms);
  const stOf = k => S.info.get(k) || { name: k.split(":")[1], lat: null, lon: null };
  const place = (k, t) => { const s = stOf(k); return { time: isoT(t), place: { name: s.name, type: "station", location: s.lat != null ? { lat: s.lat, lng: s.lon } : {} } }; };
  const free = (p, t) => ({ time: isoT(t), place: { name: p.name || null, type: "location", location: { lat: p.lat, lng: p.lon } } });
  const r0 = J.rides[0], t0 = trips[r0.ti], dep0 = t0.pts[r0.b][2];
  const stop = (x, t) => ({ time: isoT(t), place: { name: rpStopNm(x), type: "stop", location: x.P ? { lat: x.P[0], lng: x.P[1] } : {} } });
  let start = dep0 - J.startWalk * RP_MS;
  if (J.acc && J.acc.type === "bus") {   // 公車接駁：走到站牌 → 公車 → 走進車站
    const b = J.acc.opt, bd = J.acc.dep, ba = bd + b.ride * RP_MS; start = bd - b.walk * RP_MS;
    sec.push({ type: "pedestrian", departure: free(o, start), arrival: stop(b.seq[b.a], bd), travelSummary: { duration: b.walk * 60, ...(b.walkM ? { length: b.walkM } : {}) } });
    sec.push(rpBusSec(b, bd, J.acc.live, isoT, J.acc.alts));
    sec.push({ type: "pedestrian", departure: stop(b.seq[b.b], ba), arrival: place(t0.pts[r0.b][0], ba + b.stWalk * RP_MS), travelSummary: { duration: b.stWalk * 60 } });
  } else if (J.startWalk) sec.push({ type: "pedestrian", departure: free(o, start), arrival: place(t0.pts[r0.b][0], dep0), travelSummary: { duration: J.startWalk * 60, ...(J.acc && J.acc.len ? { length: J.acc.len } : {}) } });
  let lastArr = null;
  J.rides.forEach((r, i) => {
    const t = trips[r.ti], A = t.pts[r.b], B = t.pts[r.a], dep = A[2], arr = B[1];
    if (i > 0 && r.walkFrom) {
      const p = J.rides[i - 1], pt = trips[p.ti], P = pt.pts[p.a];
      const sa = stOf(P[0]), sb = stOf(A[0]);
      if (!(sa.op && sa.op === sb.op && pn(sa.name) === pn(sb.name)))   // 同系統同名的轉乘站（民權西路 R13↔O11 等）是站內轉乘，不算步行
      sec.push({ type: "pedestrian", departure: place(P[0], P[1]), arrival: place(A[0], P[1] + r.walkFrom * RP_MS), travelSummary: { duration: r.walkFrom * 60 } });
    }
    const big = rpBig(t.op);
    const transport = big
      ? { mode: t.op, name: t.start && t.dest ? t.start + "-" + t.dest : t.op === "TRA" ? "台鐵" : "高鐵", headsign: t.dest, number: t.no, ...(t.op === "TRA" && t.type ? { trainType: t.type } : {}) }
      : { mode: RP_LRT[t.op] ? "lrt" : "metro", name: (RP_LINE_ZH[t.op] || {})[t.line] || t.line, headsign: t.dest || "", ...(t.est ? { est: true } : {}) };
    sec.push({ type: "transit", transport, agency: { agency_id: t.op, name: t.op },
      departure: place(A[0], dep), arrival: place(B[0], arr),
      intermediateStops: t.pts.slice(r.b + 1, r.a).map(x => ({ departure: place(x[0], x[2]) })),
      stopCount: r.a - r.b, travelSummary: { duration: Math.round((arr - dep) / 1000) } });
    lastArr = { k: B[0], t: arr };
  });
  let end = lastArr.t + J.endWalk * RP_MS;
  if (J.egr && J.egr.type === "bus") {   // 公車接駁：出站走到站牌 → 等車（估 5 分）→ 公車 → 走到終點
    const b = J.egr.opt, at = lastArr.t + b.stWalk * RP_MS, bd = at + (J.egr.wait || RP_BUS_WAIT) * RP_MS, ba = bd + b.ride * RP_MS;
    sec.push({ type: "pedestrian", departure: place(lastArr.k, lastArr.t), arrival: stop(b.seq[b.a], at), travelSummary: { duration: b.stWalk * 60 } });
    sec.push(rpBusSec(b, bd, false, isoT, J.egr.alts));
    sec.push({ type: "pedestrian", departure: stop(b.seq[b.b], ba), arrival: free(d, ba + b.walk * RP_MS), travelSummary: { duration: b.walk * 60, ...(b.walkM ? { length: b.walkM } : {}) } });
    end = ba + b.walk * RP_MS;
  } else if (J.endWalk) sec.push({ type: "pedestrian", departure: place(lastArr.k, lastArr.t), arrival: free(d, end), travelSummary: { duration: J.endWalk * 60, ...(J.egr && J.egr.len ? { length: J.egr.len } : {}) } });
  const bn = [J.acc && J.acc.type === "bus" && J.acc.alts && J.acc.alts.length ? `${rpStopNm(J.acc.opt.seq[J.acc.opt.a])}：${rpAltTxt({ name: J.acc.opt.name, dep: J.acc.dep }, J.acc.alts, J.acc.live)} 都到${stOf(t0.pts[r0.b][0]).name}，哪班先來搭哪班` : "",
    J.egr && J.egr.type === "bus" && J.egr.alts && J.egr.alts.length ? `${rpStopNm(J.egr.opt.seq[J.egr.opt.a])}：${rpAltTxt({ name: J.egr.opt.name }, J.egr.alts, false)} 都到${rpStopNm(J.egr.opt.seq[J.egr.opt.b])}，哪班先來搭哪班` : ""].filter(Boolean).join("；");
  return { source: "self", start_time: isoT(start), end_time: isoT(end), sections: sec, ...(J.tightNote ? { tightNote: J.tightNote } : {}), ...(bn ? { busNote: bn } : {}) };
}
// 轉乘提醒：每個轉乘點用「跑過去、不留餘裕」的時間再算一次，早到 3 分鐘以上就記下那班車
const rpLabel = t => rpBig(t.op) ? (t.op === "THSR" ? `高鐵${t.no}次` : `${TRA_TYPE(t.type || "").replace(/號$/, "")}${t.no}次`) : ((RP_LINE_ZH[t.op] || {})[t.line] || t.line || "");
function rpTightNote(net, S, J, dst) {
  const { trips } = net;
  for (let i = 1; i < J.rides.length; i++) {
    const p = J.rides[i - 1], P = trips[p.ti].pts[p.a], a = S.info.get(P[0]); if (!a) continue;
    const src = new Map([[P[0], 1]]);
    for (const [x, d] of S.near(a.lat, a.lon, RP_FP)) if (x.key !== P[0]) src.set(x.key, rpTight(a, x, d));
    const res = rpScan(net, S, src, dst, P[1], P[1] + 6 * 3600000);
    const b = res.sort((x, y) => x.arr - y.arr)[0];
    if (!b || b.arr > J.arr - 3 * RP_MS) continue;
    const f = b.rides[0], ft = trips[f.ti], dep = ft.pts[f.b][2], bx = S.info.get(ft.pts[f.b][0]), st = (bx || {}).name || "", slack = Math.round((dep - P[1]) / RP_MS);
    const rule = ft.pts[f.b][0] === P[0] ? 3 : bx ? rpXfer(a, bx, haversine(a.lat, a.lon, bx.lat, bx.lon)) : 3;
    if (slack >= rule) continue;   // 照規則就接得上（應該已經列成另一條路線），不用提醒
    return `轉乘提醒：${st} ${hmTpe(dep)} 的${rpLabel(ft)}（下車後只有 ${slack} 分鐘${ft.pts[f.b][0] === P[0] || (bx && rpSameSt(a, bx, 0)) ? "" : "，要出站走過去"}），趕得上可以早 ${Math.round((J.arr - b.arr) / RP_MS)} 分到（${hmTpe(b.arr)}）`;
  }
  return null;
}
// planClean 之後：每段車都是時刻表上的真實班次（標「表定」）；台鐵車種和校正過的路線一樣分成簡稱＋全名
const rpTag = r => ({ ...r, legs: r.legs.map(l => l.kind !== "transit" || l.mode === "bus" ? l : { ...l, tt: true, ...(l.mode === "tra" && l.trainType ? { trainType: TRA_TYPE(l.trainType), trainTypeFull: l.trainType } : {}) }) });
// 主程式：回傳路線（planClean 前的格式）；查不到回傳 []
// 起點不是車站：附近公車直接坐到終點附近（不轉車）也算一條，和軌道的走法一起比（例：榮總到北車，有時候公車直達比轉捷運快）
function rpDirect(B, o, d, t0, live, Wo, Wd) {
  const opts = [], seen = new Set();
  for (const r of B.rows) {
    const k = r.RouteUID + "|" + r.Direction + "|" + r.StopUID; if (seen.has(k)) continue; seen.add(k);
    const sq = rpSeq(B.sor, r.RouteUID, r.Direction); if (!sq) continue;
    const st = sq.Stops || [], i = st.findIndex(x => x.StopUID === r.StopUID); if (i < 0 || !st[i].P) continue;
    let best = null;
    for (let j = i + 1; j < st.length && j <= i + 80; j++) {
      const P = st[j].P; if (!P) continue; const dd = haversine(P[0], P[1], d.lat, d.lon); if (dd > RP_DIR_R) continue;
      const weM = Math.round(rpWalkM(Wd, d, P[0], P[1])), ride = rpRide(st, i, j), we = Math.ceil(weM / RP_WSPD); if (!best || ride + we < best.ride + best.we) best = { j, ride, we, weM };
    }
    if (!best) continue;
    const walkM = Math.round(rpWalkM(Wo, o, st[i].P[0], st[i].P[1])), walk = Math.ceil(walkM / RP_WSPD);
    opts.push({ key: "D", walk, walkM, a: i, b: best.j, ride: best.ride, we: best.we, weM: best.weM, seq: st, uid: r.RouteUID, name: zh(r.RouteName) || "",
      eta: (r.StopStatus ?? 0) === 0 && typeof r.EstimateTime === "number" ? r.EstimateTime : null, nb: r.StopStatus === 1 && r.NextBusTime ? Date.parse(r.NextBusTime) || null : null });
  }
  const js = opts.map(b => {
    const ready = t0 + b.walk * RP_MS, alts = rpAlts(b, opts.filter(x => { const p = x.seq[x.b].P, q = b.seq[b.b].P; return p && q && haversine(p[0], p[1], q[0], q[1]) <= 300; }), live, ready);
    const q = rpDepAt(b, ready, live, alts.length > 0); if (!q) return null;
    return { b, alts, dep: q.dep, live: q.live, end: q.dep + (b.ride + b.we) * RP_MS };
  }).filter(Boolean).sort((x, y) => x.end - y.end);
  const out = [], used = new Set();
  for (const J of js) {   // 同一群路線（同站上、同站下）只留最早到的那條
    const g = J.b.name; if (used.has(g)) continue; [g, ...J.alts.map(a => a.name)].forEach(n => used.add(n));
    const isoT = ms => isoTpe(ms), b = J.b, st = b.seq, ba = J.dep + b.ride * RP_MS;
    const stop = (x, t) => ({ time: isoT(t), place: { name: rpStopNm(x), type: "stop", location: x.P ? { lat: x.P[0], lng: x.P[1] } : {} } });
    const free = (p, t) => ({ time: isoT(t), place: { name: p.name || null, type: "location", location: { lat: p.lat, lng: p.lon } } });
    const bn = J.alts.length ? `${rpStopNm(st[b.a])}：${rpAltTxt({ name: b.name, dep: J.dep }, J.alts, J.live)} 都到${rpStopNm(st[b.b])}，哪班先來搭哪班` : "";
    out.push({ source: "self", start_time: isoT(J.dep - b.walk * RP_MS), end_time: isoT(J.end), ...(bn ? { busNote: bn } : {}), sections: [
      { type: "pedestrian", departure: free(o, J.dep - b.walk * RP_MS), arrival: stop(st[b.a], J.dep), travelSummary: { duration: b.walk * 60, length: b.walkM } },
      rpBusSec(b, J.dep, J.live, isoT, J.alts),
      { type: "pedestrian", departure: stop(st[b.b], ba), arrival: free(d, J.end), travelSummary: { duration: b.we * 60, length: b.weM } }] });
    if (out.length >= 3) break;
  }
  return out;
}
async function railPlan(p) {
  const { o, d, modes, when, time } = p;
  if (o.lat == null || d.lat == null) return [];
  const oSt = planIsStation(o), useBus = (modes || []).includes(5);
  const dSt = planIsStation(d), far = haversine(o.lat, o.lon, d.lat, d.lon) >= 1500;
  if (oSt && dSt) return railPlanRail(p).catch(e => { console.warn("railPlanRail", e); return []; });
  if (!far) return [];
  // 起訖點不是車站：先抓附近公車＋車站，問實際步行距離（OSRM），再排路線
  const ops = [...new Set((modes || []).flatMap(m => RP_OPS[m] || []))];
  const [S, Bo, Bd] = await Promise.all([ops.length ? rpStations(ops).catch(() => null) : null, !oSt && useBus ? rpBusNear(o).catch(() => null) : null, !dSt && useBus ? rpBusNear(d).catch(() => null) : null]);
  const Wo = oSt ? null : await rpWalkMap(o, rpWalkPts(S, o, Bo)).catch(() => null);
  const Wd = dSt ? null : await rpWalkMap(d, rpWalkPts(S, d, Bd).concat(Bo && when !== "arr" ? rpWalkPts(null, o, Bo, d) : [])).catch(() => null);
  const rail = await railPlanRail({ ...p, Bo, Bd, Wo, Wd }).catch(e => { console.warn("railPlanRail", e); return []; });
  let direct = [];
  if (Bo && when !== "arr") { try { direct = rpDirect(Bo, o, d, when === "dep" && time ? tms(time) : Date.now(), when === "now", Wo, Wd); } catch (e) { console.warn("rpDirect", e); } }
  return rail.concat(direct);
}
async function railPlanRail({ o, d, modes, when, time, Bo: Bo0, Bd: Bd0, Wo, Wd }) {
  const ops = [...new Set((modes || []).flatMap(m => RP_OPS[m] || []))]; if (!ops.length) return [];
  if (o.lat == null || d.lat == null) return [];
  const oSt = planIsStation(o), dSt = planIsStation(d), useBus = (modes || []).includes(5);
  if (!(oSt && dSt) && haversine(o.lat, o.lon, d.lat, d.lon) < 1500) return [];   // 很近：走路或公車直達比較合適，交給 Google／TDX
  const S = await rpStations(ops);
  const [Bo, Bd] = await Promise.all([!oSt && useBus ? (Bo0 !== undefined ? Bo0 : rpBusNear(o).catch(() => null)) : null, !dSt && useBus ? (Bd0 !== undefined ? Bd0 : rpBusNear(d).catch(() => null)) : null]);
  const accBus = Bo ? rpBusOpts(Bo, S, o, true, Wo) : [], E = rpEgress(S, d, dSt, Bd ? rpBusOpts(Bd, S, d, false, Wd) : [], Wd), dst = E.dst;
  const accAt = t => rpAccess(S, o, oSt, accBus, t, when === "now", Wo);
  { const a0 = accAt(Date.now()); if (!a0.src.size || !dst.size) return []; for (const k of a0.src.keys()) if (dst.has(k) && a0.how.get(k).type === "walk" && E.how.get(k).type === "walk") return []; }   // 起訖是同一站
  const arrBy = when === "arr" && time ? tms(time) : null;
  const ref = when === "dep" && time ? tms(time) : arrBy ? arrBy - 4 * 3600000 : Date.now();
  const day = tpeSvcDay(ref), late = new Date(ref + 8 * 3600000).getUTCHours();
  const A = await rpDay(ops, day), B = late >= 19 || late < 3 || arrBy ? await rpDay(ops, dayAdd(day, 1)) : null;
  const net = rpMerge(A, B);
  if (!net.C.length) return [];
  const sig = J => J.rides.map(r => r.ti + "." + r.b + "." + r.a).join("|");
  const got = new Map(); let t0 = ref;
  const bKey = J => net.trips[J.rides[0].ti].pts[J.rides[0].b][0], aKey = J => { const L = J.rides[J.rides.length - 1]; return net.trips[L.ti].pts[L.a][0]; };
  const depOf = J => J.acc && J.acc.type === "bus" ? J.acc.dep - J.acc.opt.walk * RP_MS : net.trips[J.rides[0].ti].pts[J.rides[0].b][2] - J.startWalk * RP_MS;
  for (let n = 0; n < (arrBy ? 30 : 8); n++) {
    const A0 = accAt(t0);
    const res = rpScan(net, S, A0.src, dst, t0, t0 + 10 * 3600000);
    if (!res.length) break;
    for (const J of res) { J.acc = A0.how.get(bKey(J)); J.egr = E.how.get(aKey(J)); if (!arrBy || J.arr <= arrBy) got.set(sig(J) + "|" + (J.acc && J.acc.type === "bus" ? J.acc.opt.uid + J.acc.dep : "w"), J); }
    const dep = Math.min(...res.map(depOf));
    if (arrBy && Math.min(...res.map(J => J.arr)) > arrBy) break;
    t0 = Math.max(t0 + RP_MS, dep + RP_MS);
  }
  // 同一班「最後那段車」同時到的：只留最晚出發的（重掃時第一段捷運每一班都會各算出一條，前面早出門只是在轉乘站多等）
  const byLast = new Map();
  for (const J of got.values()) { const L = J.rides[J.rides.length - 1], k = L.ti + "." + L.a + "|" + J.arr, o = byLast.get(k); if (!o || depOf(J) > depOf(o)) byLast.set(k, J); }
  let list = [...byLast.values()];
  // 多轉一次車只早到 5 分鐘以內（而且沒有比較晚出發）就不列：例如坐高鐵到新竹再轉區間車，只比直達的自強號早到 2 分
  list = list.filter(J => !list.some(Y => Y !== J && Y.rides.length < J.rides.length && Y.arr <= J.arr + 5 * RP_MS && depOf(Y) >= depOf(J) - 5 * RP_MS));
  list = arrBy ? list.sort((a, b) => b.arr - a.arr).slice(0, 4) : list.sort((a, b) => a.arr - b.arr).slice(0, 6);
  for (const J of list) { try { J.tightNote = rpTightNote(net, S, J, dst); } catch (e) {} }
  return list.map(J => rpRoute(net, S, J, o, d));
}
async function planRoutes({ o, d, modes, yb, when, time, onLive }) {
  // v2.33.0：「目前位置」座標取到小數第4位（約10公尺）再送 /plan：Worker 快取鍵用收到的座標，站著不動重查、換交通工具再換回來都能共用快取
  const r4 = p => p && p.here && p.lat != null ? { ...p, lat: +(+p.lat).toFixed(4), lon: +(+p.lon).toFixed(4) } : p;
  o = r4(o); d = r4(d);
  const snapOf = p => { if (!planIsStation(p)) return null; const m = TDX_MISSING[String(p.name || "").replace(/站$/, "")]; return m && modes.includes(m.mode) ? m : null; };
  let so = snapOf(o), sd = snapOf(d); const qo = so || o, qd = sd || d;
  // 座標原樣送出（車站用車站本身的座標，不四捨五入）；換成相鄰站時另外帶原本的座標（Worker 改問 Google 時用）
  const q = new URLSearchParams({ o: `${qo.lat},${qo.lon}`, d: `${qd.lat},${qd.lon}`, t: modes.join(","), gc: "1", yb: yb ? "1" : "0" });
  if (so) q.set("go", `${o.lat},${o.lon}`); if (sd) q.set("gd", `${d.lat},${d.lon}`);
  if (when === "dep" && time) q.set("dep", time); if (when === "arr" && time) q.set("arr", time);
  let out = [], cand = null; const so0 = so, sd0 = sd;
  // v2.44.0：起訖都是軌道車站：同時用官方時刻表自己算（和 Google／TDX 的結果一起比，最快的排前面）
  const endOk = p => planIsStation(p) || (modes.includes(5) && p && p.lat != null);   // v2.44.0：不是車站的起訖點用公車接駁（或走路）到車站
  const selfP = endOk(o) && endOk(d) ? railPlan({ o, d, modes, when, time }).then(l => planClean(l, yb).map(rpTag)).catch(e => { console.warn("railPlan", e); return []; }) : Promise.resolve([]);
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
    if (/登入|頻繁|次數|太多|連線|TDX 5\d\d/.test(e.message) || !/找不到|no route|40001|spec params|fail|規劃失敗|404/i.test(e.message + " " + (e.status || ""))) { if (!(await selfP).length) throw e; }   // 自算有結果就照樣列出
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
    // v2.34.0：兩組合併（TDX 用相鄰站查的照樣加註、Google 用原本的起訖點），之後一起去重、排序
    so = so0; sd = sd0;
    const [T, G] = await Promise.all([fix(trim(cand.T, so, sd)), fix(trim(cand.G, null, null))]);
    out = T.concat(G);
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
  { const self = await selfP; if (self.length) out = out.concat(self); }
  // 「現在出發」時 TDX 偶爾會給已經開走的班次；「指定出發」時 TDX 也常給比指定時間更早出門的走法（例如指定18:12卻17:54出發）：
  // 同樣路線還有較晚一班的就不列；班次密的第一段改搭下一班；其餘「現在出發」保留但標示，「指定出發」直接拿掉
  const ref = ref0;
  // 對不到時刻表的才用下面的班距估計
  if (ref) {
    // v2.27.1：現在出發也要算上走到第一個上車站的時間（以前只比第一班車的開車時間，出門時間可能早於現在）
    const now = ref, late = r => { if (when === "dep") return r.start - ref; const t = r.legs.find(l => l.kind === "transit"); return t ? tms(t.from.time) - preWalk(r) - ref : 0; };
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
    out = out.map(planStartNorm);
    const ok = out.filter(r => !gone(r)), okShape = new Set(ok.map(planShape));
    out = when === "dep" ? ok : ok.concat(out.filter(r => gone(r) && !okShape.has(planShape(r))).map(r => ({ ...r, missed: true })));
  }
  // 末班車後 Google 會連隔天早上的班次一起給：3小時內有車就不列更晚的
  if (ref && when !== "arr") { const near = out.filter(r => r.start - ref < 3 * 3600000); if (near.length) out = near; }
  if (so || sd) {
    const note = so && sd ? `TDX 還沒有${o.name}和${d.name}站的資料，改從相鄰的${so.name}站規劃到${sd.name}站` : so ? `TDX 還沒有${o.name}站的資料，改從相鄰的${so.name}站（同為${so.line}）起算` : `TDX 還沒有${d.name}站的資料，改規劃到相鄰的${sd.name}站（同為${sd.line}）`;
    out = out.map(r => r.src === "tdx" ? { ...r, note } : r);   // v2.34.0：合併時只有 TDX 的路線是用相鄰站查的
  }
  // 一律最快：先到的排前面（指定抵達則是最晚出發的排前面），同時到的轉乘少、走路少的優先
  const walkOf = r => r.legs.reduce((a, l) => a + (l.kind === "walk" ? l.dur : 0), 0);
  // 起點是車站：在這一站直接上車的路線，抵達時間差2分鐘以內也排前面（不用先走到別站）
  const oName = so ? so.name : o.name, atO = r => { if (!planIsStation(o)) return 0; const t = r.legs.find(l => l.kind === "transit"); return t && nameHit(t.from.name, oName) ? 120000 : 0; };
  const cmpR = (a, b) => (!!a.missed - !!b.missed) || (a.approx - b.approx) || (when === "arr" ? (b.start + atO(b)) - (a.start + atO(a)) : (a.end - atO(a)) - (b.end - atO(b))) || a.dur - b.dur || a.transfers - b.transfers || walkOf(a) - walkOf(b);
  out.sort(cmpR);
  // v2.27.2：現在出發：只對排第一的路線查第一段公車的即時動態（每次規劃最多 2 次：查完被拿掉或掉出第一名，才再查新的第一名）
  // v2.33.0：有 onLive 時先回傳 TDX＋校正的結果，即時查詢在背景做完再用 onLive(新清單) 更新；查不到或不用查就 onLive(null)
  const liveRun = async list => {
    let hit = false;
    for (let n = 0; n < 2; n++) {
      const top = list.find(r => !r.missed && !r.approx); if (!top || !top._lv) break;
      let x = null; hit = true;
      try { x = (await planTtFix([top._src], { when, ref, arrBy, live: true }))[0]; } catch (e) { console.warn("plan live", e); }
      x = x && !x.broken ? planStartNorm({ ...x, ...(top.note ? { note: top.note } : {}) }) : null;
      if (x && x.start < ref - 60000) x = null;
      list = list.filter(r => r !== top); if (x) { delete x._lv; x.liveChecked = true; list.push(x); }
      list.sort(cmpR);
      if (list.find(r => !r.missed && !r.approx) === x) break;
    }
    return hit ? list : null;
  };
  const strip = list => list.map(r => { if (!("_lv" in r) && !("_src" in r)) return r; const x = { ...r }; delete x._lv; delete x._src; return x; });
  const liveNeed = when === "now" && ref && out.some(r => r._lv);
  if (liveNeed && typeof onLive === "function") {
    const pend = out.slice();
    setTimeout(() => liveRun(pend).then(l => onLive(l ? planDedupe(strip(l)) : null), e => { console.warn("plan live", e); onLive(null); }), 0);
    const first = planDedupe(strip(out));
    const t = first.find(r => !r.missed && !r.approx); if (t && pend.some(r => r._lv && r === pend.find(y => !y.missed && !y.approx))) t.livePending = true;
    return first;
  }
  if (liveNeed) out = (await liveRun(out)) || out;
  return planDedupe(strip(out));
}
function planDedupe(out) {
  // 去重：①同一種走法、同時出發又同時抵達 ②每段車都同時刻 ③同一班火車同時抵達 ④主要那段車（最久的一段）同一班、同時抵達，只是前面接駁不同（例如兩條都搭同一班1839）；最多列8條
  const seen = new Set(), real = new Set(out.filter(r => !r.shifted).map(r => planShape(r) + "|" + r.end));
  const tsig = r => r.legs.filter(l => l.kind === "transit").map(l => l.mode + "@" + (l.from.time || "").slice(0, 16) + ">" + (l.to.time || "").slice(0, 16)).join("|");
  // v2.23.3：多繞的路線不列：另一條路線搭的車（同一班、同一段）是這條的一部分，這條只是前後多接了幾段車，卻沒有比較晚出發、也沒有比較早到
  // （例如 1839 到屏東轉運站，另一條同一班 1839 再轉 8218 坐一站到真耶穌教會、反而更晚到）
  // v2.34.0：TDX 和 Google 合併後，同一班車的名稱寫法可能不同（臺北／台北、捷運石牌站(西安)、高鐵車次只有校正後才有）：站名用 pn 正規化，台鐵／高鐵有車次就比車次
  const lnm = l => (l.mode === "tra" || l.mode === "thsr") && l.number ? l.number : l.mode === "thsr" ? "" : pn(l.name || "");
  const legSig = r => r.legs.filter(l => l.kind === "transit").map(l => l.mode + lnm(l) + "@" + pn(l.from.name || "") + ">" + pn(l.to.name || "") + "@" + (l.from.time || "").slice(0, 16));
  const within = (a, b) => { for (let i = 0; i + a.length <= b.length; i++) if (a.every((x, k) => x === b[i + k])) return true; return false; };
  const sigs = out.map(legSig);
  // v2.33.2：同時出發、同時到（各差2分內）時，步行少8分以上的優先：多繞不列不刪這種（例如坐公車到石牌站、不用走17分），去重時也排到前面留下
  const walkMs = r => r.legs.reduce((a, l) => a + (l.kind === "walk" ? (l.dur || 0) * 1000 : 0), 0);
  const lessWalk = (a, b) => !a.missed && !b.missed && Math.abs(a.start - b.start) <= 120000 && Math.abs(a.end - b.end) <= 120000 && walkMs(b) - walkMs(a) >= 8 * 60000;
  out = out.filter((r, i) => !out.some((y, j) => j !== i && !y.missed && !y.approx && sigs[j].length && sigs[j].length < sigs[i].length && within(sigs[j], sigs[i]) && r.end >= y.end && r.start <= y.start && !lessWalk(r, y)));
  { const ord = []; for (const r of out) { const i = ord.findIndex(y => lessWalk(r, y)); if (i >= 0) ord.splice(i, 0, r); else ord.push(r); } out = ord; }
  // v2.33.1：③④（同一班主幹車同時抵達）：從兩條第一段共同搭的車（例如同一班高鐵）往前看，接駁不同類就兩條都列：
  // 一條有坐公車（B）、另一條只坐捷運／輕軌／台鐵／高鐵（R）。只有步行（沒坐車）跟哪一類都合併（維持原本「同時到就留排前面那條」）。
  // 第二條加註：同一班什麼車、改坐什麼、在那班車開車前多留幾分
  const MZ = { mrt: "捷運", lrt: "輕軌", tra: "台鐵", thsr: "高鐵", bus: "公車" };
  const lid = l => l.mode + "|" + (l.number || pn(l.name || "")) + "|" + pn(l.from.name || "") + "|" + (l.from.time || "").slice(0, 16);
  const tr = r => r.legs.filter(l => l.kind === "transit");
  const firstCommon = (r, y) => { const ys = new Set(tr(y).map(lid)); return tr(r).find(l => ys.has(lid(l))) || null; };
  const preOf = (r, tk) => r.legs.slice(0, r.legs.indexOf(tk)).filter(l => l.kind === "transit");
  const cls = pre => !pre.length ? "" : pre.some(l => l.mode === "bus") ? "B" : "R";
  const pairOf = (r, y) => { const a = firstCommon(r, y); if (!a) return null; const b = tr(y).find(l => lid(l) === lid(a)); return { a, b, cr: cls(preOf(r, a)), cy: cls(preOf(y, b)) }; };
  const split = q => !!q && ((q.cr === "B" && q.cy === "R") || (q.cr === "R" && q.cy === "B"));
  const atTk = (r, tk) => { const i = r.legs.indexOf(tk); let t = null, w = 0; for (let k = i - 1; k >= 0; k--) { const l = r.legs[k]; if (l.kind === "transit") { t = tms(l.to.time); break; } if (l.kind !== "wait") w += (l.dur || 0) * 1000; } return t == null ? null : t + w; };
  const altOf = (r, y, q) => {
    const pre = preOf(r, q.a), ypre = preOf(y, q.b), rail = p => new Set(p.filter(l => l.mode !== "bus").map(l => l.mode));
    const rr = rail(pre), yr = rail(ypre), sameRail = rr.size > 0 && [...rr].every(m => yr.has(m));
    const st = String((pre.find(l => l.mode !== "bus") || {}).from?.name || "").replace(/站$/, "");
    // v2.33.2：兩條都坐同一種軌道（例如都坐捷運），差別只在走過去還是坐公車到站：照實寫「改坐公車到石牌」／「不坐公車、走到石牌」
    const how = sameRail && st ? (q.cr === "B" ? `改坐公車到${st}` : `不坐公車、走到${st}`) : `改坐${q.cr === "B" ? "公車" : MZ[(pre.find(l => l.mode !== "bus") || pre[0] || {}).mode] || "其他車"}`;
    const ta = atTk(r, q.a), tb = atTk(y, q.b), dep = tms(q.a.from.time), d = ta != null && tb != null ? Math.round((tb - ta) / 60000) : 0;
    return `同一班${MZ[q.a.mode] || "車"}，${how}${d >= 3 && dep ? `，${hmTpe(dep)} 前多留約${d}分` : ""}`;
  };
  const owners = new Map(), altM = new Map();
  const kept = out.filter(r => !(r.shifted && real.has(planShape(r) + "|" + r.end))).filter(r => {
    const k1 = planShape(r) + "|" + r.start + "|" + r.end, k2 = "t|" + tsig(r);
    const rl = r.legs.filter(l => l.kind === "transit" && (l.mode === "tra" || l.mode === "thsr") && l.number), k3 = rl.length ? "r|" + rl[rl.length - 1].mode + rl[rl.length - 1].number + "|" + Math.round(r.end / 120000) : null;
    const mt = r.legs.filter(l => l.kind === "transit").sort((x, y) => y.dur - x.dur)[0];
    const k4 = mt ? "m|" + mt.mode + lnm(mt) + "@" + (mt.to.time || "").slice(0, 16) + "|" + Math.round(r.end / 120000) : null;
    if (seen.has(k1) || seen.has(k2)) return false;
    const ks = [k3, k4].filter(Boolean); let alt = null;
    for (const k of ks) for (const y of owners.get(k) || []) { const q = pairOf(r, y); if (!split(q)) return false; if (!alt) alt = altOf(r, y, q); }
    seen.add(k1); seen.add(k2); for (const k of ks) { if (!owners.has(k)) owners.set(k, []); if (!owners.get(k).includes(r)) owners.get(k).push(r); }
    if (alt) altM.set(r, alt); return true; }).slice(0, 8);
  return kept.map(r => { const a = altM.get(r); if (a) return { ...r, altNote: a }; if (r.altNote) { const x = { ...r }; delete x.altNote; return x; } return r; });
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
      const c = { dep: P.base + t.pts[i][2] * 60000, arr: P.base + t.pts[j][1] * 60000, no: t.no, type: shortType(t.type), tf: t.type, dest: t.dest };
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
    let triedTt = false;
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const targetMid = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const diff = Math.round((targetMid - todayMid) / 86400000);
    if (op === "TRA" && diff >= -1 && diff <= 60) {
      triedTt = true;
      try { const j = await authedGet(`/tt/day/TRA/${iso}`); if (j && j.trains && j.trains.length) return { tt: j, daily: true }; } catch (e) {}
    }
    // ① 國定假日、連假或其前一天：那一天的實際時刻表（TDX DailyTimetable，經 Worker 存在 KV；含疏運加班、停駛）。平常日不抓（v2.20）
    const h = await ttLoad("HOLIDAY").catch(() => null);
    if (!triedTt && holRel(h && h.dates, iso)) { try { const j = await authedGet(`/tt/day/${op}/${iso}`); if (j && j.trains && j.trains.length) return { tt: j, daily: true }; } catch (e) {} }
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
      trains.push({ no: String(t[0]), type: t[1] || "", dir: t[2] === "" || t[2] == null ? null : +t[2], start: t[3] || "", dest: t[4] || "", pts, raw: t });
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
    trains.push({ no: t.no, type: shortType(t.type), tf: t.type, dir: t.dir, start: t.start, dest: t.dest, t: dep, time: clk(dep), next });
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
// 起迄站指定（v2.44.0）：ends＝不標的端點；br＝分岔那一側的端點，要標（白字），用來分辨往哪一條支線
// 淡水信義線：廣慈/奉天宮—淡水（往象山是區間車）；中和新蘆線：南勢角一頭不標，迴龍、蘆洲要標；淡海輕軌：紅樹林一頭不標，崁頂、淡水漁人碼頭要標（藍海線站碼 V26 漁人碼頭→V28 海洋大學是反過來編的，不能用站碼推）
const END_FIX = { "TRTC|R": { ends: ["廣慈/奉天宮", "淡水"] }, "TRTC|O": { ends: ["南勢角"], br: ["迴龍", "蘆洲"] }, "NTDLRT|V": { ends: ["紅樹林"], br: ["崁頂", "淡水漁人碼頭"] } };
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
      const dest = zh(r.DestinationStationName) || `方向${r.Direction ?? "?"}`, line = brLine(op, r.LineID || lineOf(op, r.StationID), r.StationID, r.DestinationStationID, dest), dir = r.Direction ?? null;
      (dirsOf[dest + "|" + line] = dirsOf[dest + "|" + line] || new Set()).add(dir);
      for (const x0 of (r.Timetables || [])) {
        const x = hm(x0.DepartureTime || x0.ArrivalTime); if (!x) continue;
        const ex = x0.TrainType > 1, k = [line, dest, dir, x, ex ? "X" : ""].join("|"); if (seen.has(k)) continue; seen.add(k);   // v2.46.4：直達車（ex）和同時刻的普通車分開算
        const v = toMin(x);
        list.push(fix({ time: x, t: v < 180 ? v + 1440 : v, dest, destId: r.DestinationStationID || null, line, dir, via: null, ...(ex ? { ex: true } : {}) }));
      }
    }
    const trains = list.filter(t => !(t.destId && ids.includes(t.destId)) || TRIP_LOOP[op + "|" + t.line]);
    for (const t of trains) {
      if (dirsOf[t.dest + "|" + t.line].size > 1) t.via = op === "KLRT" ? (t.dir === 1 ? "逆行" : "順行") : `方向${t.dir}`;
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
    // v2.44.0：各線起迄站（時刻表只標不到起迄站的班次）＝站碼最小、最大的站；有支線的線照 END_FIX 指定
    try {
      const st = await loadRailStations(), ends = {}, brEnds = {};
      for (const L of new Set(trains.map(t => t.line).filter(Boolean))) {
        if (BR_BASE[L]) { ends[L] = [...new Set(trains.filter(t => t.line === L).map(t => t.dest))]; continue; }   // 新北投、小碧潭支線：兩站之間來回
        const ns = [];
        for (const s of st) {
          if (s.op !== op && s.op !== other) continue;
          const id = (STN_ALIAS[s.id] || {})[L] || s.id, n = stnNum(id);
          if (stnPre(id) === L && n != null) ns.push([n, s.name]);
        }
        if (ns.length < 2 && !END_FIX[op + "|" + L]) continue;
        ns.sort((a, b) => a[0] - b[0]);
        const fx = END_FIX[op + "|" + L];
        if (fx) { ends[L] = fx.ends; if (fx.br) brEnds[L] = fx.br; continue; }
        ends[L] = [...new Set([ns[0][1], ns[ns.length - 1][1]])];
      }
      out.ends = ends; out.brEnds = brEnds;
    } catch (e) {}
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
async function railFix(leg, { p0, a0, ready, readyX, limit, stOf, first, avoid, now, ref }) {
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
  // v2.32.1：現在出發的第一段，TDX 給的班次在查詢時間（＋走到車站）前就開走：優先說明「已經開走」，等很久時加註空窗時段（只用手機已有的時刻表）
  const goneFirst = now && first && limit == null && ready != null && p0 < ready - 1000;
  const goneNote = (g, c) => {
    const lab = x => x.op === "THSR" ? `高鐵${x.no}次` : trainLab(x);
    const nd = all.filter(x => x.dep >= ready).sort((a, b) => a.dep - b.dep)[0];
    let s = `TDX 給的 ${g ? `${hmTpe(g.dep)} ${lab(g)}` : `${hmTpe(p0)} 班次`}${ref != null && p0 < ref - 30000 ? "已經開走" : `走到${nmA}來不及搭`}，${nd && nd.no === c.no ? "下一班是" : "改搭最早到的"} ${hmTpe(c.dep)} ${lab(c)}（${hmTpe(c.arr)} 到）`;
    if (nd && nd.dep - ready > 30 * 60000) { const pv = all.filter(x => x.dep < ready).sort((a, b) => b.dep - a.dep)[0]; s += `；${hmTpe(pv ? pv.dep : ready)}–${hmTpe(nd.dep)} ${nmA}沒有往${nmB}的車`; }
    return s;
  };
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
    if (goneFirst) return { c, sys, note: goneNote(m, c) };
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
  else if (goneFirst) why = goneNote(m || same || near.slice().sort((a, b) => Math.abs(a.dep - p0) - Math.abs(b.dep - p0))[0] || null, c);
  else {
    const early = p0 < (ready || 0) - 1000;
    why = m && limit != null ? `${trainLab(m)} ${hmTpe(m.arr)} 才到，來不及` : m ? (early && first ? `TDX 給的 ${trainLab(m)}（${hmTpe(m.dep)} 開）比出發時間早` : `接不上 ${hmTpe(m.dep)} 的${trainLab(m)}`) : same ? `TDX 給的 ${hmTpe(p0)} 班次是${trainLab(same)}，實際 ${hmTpe(same.arr)} 才到` : early ? (first ? `TDX 給的 ${hmTpe(p0)} 班次比出發時間早` : `接不上 ${hmTpe(p0)} 的台鐵`) : `TDX 給的 ${hmTpe(p0)}–${hmTpe(a0)} 班次不在時刻表上`;
    why += `，改搭 ${hmTpe(c.dep)} ${trainLab(c)}（${hmTpe(c.arr)} 到）`;
  }
  return { c, sys, note: why };
}
const KLRT_DIR = d => d === 1 ? "逆行" : "順行";   // 高雄輕軌 TDX 時刻表 Direction 1＝逆行、0＝順行
const NTD_LINE = { V11: "紅樹林－崁頂", V26: "紅樹林－淡水漁人碼頭" };
async function planTtFix(routes, opt = {}) {
  const stMemo = new Map();
  opt = { ...opt, avoid: new Set() };
  const stOf = (leg, end) => { const p = leg[end] || {}, k = leg.mode + "|" + (p.name || "") + "|" + p.lat + "," + p.lon;
    if (!stMemo.has(k)) stMemo.set(k, planRailStation(leg, end).catch(() => null)); return stMemo.get(k); };
  const out = [];
  for (const r of routes) {
    const ft = r.legs.find(l => l.kind === "transit"), needFirst = opt.ref != null && opt.when !== "arr" && ft && ft.mode === "bus";   // v2.27.1：第一段是公車也要檢查趕不趕得上
    if (!needFirst && !r.legs.some(l => l.kind === "transit" && (l.mode === "lrt" || l.mode === "mrt" || l.mode === "tra" || l.mode === "thsr"))) { out.push(r); continue; }
    if (r.src === "tt" || r.src === "self") { out.push(r); continue; }   // 深夜直達車（v2.21）、軌道自算（v2.44.0）：本來就取自官方時刻表
    if (r.src === "google") {   // v2.22：Google 的路線也依官方時刻表校正（同 TDX）；註記裡的來源改成 Google
      let x; try { x = await planRetime(r, stOf, opt); } catch (e) { console.warn("planRetime", e); x = r; }
      out.push(x.ttNote ? { ...x, ttNote: x.ttNote.replace(/TDX/g, "Google") } : x); continue;
    }
    try { out.push(await planRetime(r, stOf, opt)); } catch (e) { console.warn("planRetime", e); out.push(r); }
  }
  return out;
}
// v2.27.1：第一段（公車等沒有時刻表的車）趕不趕得上：ready＝查詢時間＋前面的步行，最早能到站牌的時間。
// 回傳 null＝不用改；{ dep, live|est, note }＝改搭這個時間的車；{ gone }＝這條路線不成立（末班已過等）
const FIRST_HW = { bus: 12, mrt: 6, lrt: 10 };
const planBusLiveMemo = new Map();
function planBusNext(leg) {   // 這條公車在上車站的下一班（即時動態），30 秒內共用；網址和行程頁的即時到站相同（Worker 快取共用）
  const k = leg.name + "|" + (leg.from.name || "") + "|" + (leg.to.name || ""), h = planBusLiveMemo.get(k);
  if (h && Date.now() - h.t < 30000) return h.p;
  const p = (async () => {
    const b = await planBusMatch(leg); if (!b) return null;
    const etas = await routeEtas(b);
    const rank = t => t.StopStatus === 0 && typeof t.EstimateTime === "number" ? t.EstimateTime : (t.StopStatus ?? 0) === 1 && t.NextBusTime ? 1e6 : 2e6 + (t.StopStatus || 0);
    const e = etas.filter(t => t.RouteUID === b.routeUID && t.StopUID === b.stopUID && etaDirOk(t, b.dirNum, b.routeUID)).sort((x, y) => rank(x) - rank(y))[0];
    if (!e) return null;
    if (e.StopStatus === 0 && typeof e.EstimateTime === "number") return { at: Date.now() + e.EstimateTime * 1000, live: true };
    if ((e.StopStatus ?? 0) === 1 && e.NextBusTime) { const t = Date.parse(e.NextBusTime); return t ? { at: t, live: false } : null; }
    if (e.StopStatus === 3) return { gone: "末班車已過" };
    if (e.StopStatus === 4) return { gone: "今日未營運" };
    return null;
  })().catch(() => null);
  planBusLiveMemo.set(k, { t: Date.now(), p }); if (planBusLiveMemo.size > 40) planBusLiveMemo.delete(planBusLiveMemo.keys().next().value);
  return p;
}
async function firstLegFix(leg, ready, when, opt) {
  const p0 = tms(leg.from.time), hw = (FIRST_HW[leg.mode] || 15) * 60000, nm = leg.name || MODE_NAME[leg.mode] || "車", at = leg.from.name || "上車站";
  const next = (t0, why) => { const dep = t0 + Math.ceil((ready - t0) / hw) * hw; return { dep, est: true, note: `${why}，${hmTpe(ready)} 才走得到${at}，依班距估計搭 ${hmTpe(dep)} 左右的${nm}` }; };
  let L = null;
  // 現在出發、20 分鐘內要搭（或已經趕不上）的公車才查即時（同一條公車共用；每次規劃最多查 5 條）
  // v2.27.2：只有排第一的路線才查即時（opt.live，由 planRoutes 決定）；其他路線只用班距估計
  if (opt.live && when === "now" && leg.mode === "bus" && p0 - ready <= 20 * 60000) L = await planBusNext(leg);
  if (L && L.gone) return { gone: L.gone };
  if (L && L.at) {
    const tag = L.live ? "即時動態" : "預定發車";
    if (L.at >= ready - 30000) {
      if (p0 >= ready && L.at <= p0 - 8 * 60000) return null;   // TDX 刻意搭比較晚的一班（接下一段車），即時的這班比較早：不改
      if (Math.abs(L.at - p0) < 60000) return null;
      return { dep: L.at, live: L.live, note: `${nm}${tag}：${hmTpe(L.at)} 到${at}（TDX 給 ${hmTpe(p0)}）` };
    }
    if (p0 >= ready) return null;
    return next(L.at, `${nm}${tag} ${hmTpe(L.at)} 到${at}`);
  }
  if (p0 >= ready - 30000) return null;
  return next(p0, `趕不上 TDX 給的 ${hmTpe(p0)} ${nm}`);
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
  const res = [], notes = [], warns = [], busNotes = [], sysNames = new Set();
  // 沿途停靠站（官方時刻）：站名與座標取自車站清單
  let stIx = null;
  const stopsOf = async c => { if (!c.stops || !c.stops.length) return [];
    if (!stIx) { stIx = {}; try { for (const x of await railAll()) if (x.id) stIx[x.op + "|" + x.id] = x; } catch (e) {} }
    return c.stops.map(([id, ms]) => { const x = stIx[c.op + "|" + id] || {}; return { name: x.name || id, type: "station", lat: x.lat ?? null, lon: x.lon ?? null, time: isoTpe(ms) }; }); };
  let cursor = null, origCursor = null, first = true, start = r.start, firstFixed = false, broken = null, lvCand = false;
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
      const rf = await railFix(base, { p0, a0, ready: rdy, readyX: first ? rdy : cursor + (leg.mode === "thsr" ? 180000 : 120000), limit: lim, stOf, first, avoid: opt.avoid, now: opt.when === "now", ref: opt.ref }).catch(e => { console.warn("railFix", e); return null; });
      if (rf && rf.c) {
        const c = rf.c, st = c.shift != null ? (base.stops || []).map(x => ({ ...x, time: x.time && isoTpe(tms(x.time) + c.shift) })) : await stopsOf(c);
        const extra = leg.mode === "mrt" ? { tt: true, headsign: headNew(base, c.dest), ...(c.op === "TYMC" ? { trainType: c.skip ? "直達車" : "普通車" } : {}) }
          : { tt: true, number: c.no, trainType: leg.mode === "tra" ? TRA_TYPE(c.type) : "", ...(leg.mode === "tra" && c.type ? { trainTypeFull: c.tf || c.type } : {}), headsign: c.dest, ...(c.start && c.dest ? { name: `${c.start}-${c.dest}`, longName: `${c.start}-${c.dest}` } : {}) };
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
    if (first) {
      // v2.27.1：第一段是公車等沒有時刻表的車：TDX 常給「出發時間已經過了」的班次（例如 11:40 查、要 11:33 出門走 9 分鐘去搭 11:42 的公車）。
      // 現在出發：用公車即時動態（最近一班的預估到站）決定搭哪班；走到站牌前就開走了→依班距估計下一班。指定出發：依班距往後推。後面的車照樣往後校正
      if (when === "now" && leg.mode === "bus" && ref != null && p0 - (ref + walkSum(pre)) <= 20 * 60000 && !opt.live) lvCand = true;
      const fx = ref != null && when !== "arr" ? await firstLegFix(base, ref + walkSum(pre), when, opt).catch(e => { console.warn("firstLegFix", e); return null; }) : null;
      if (fx && fx.gone) {   // 末班已過／今日停駛
        warns.push(`${leg.name || "公車"}在${leg.from.name || "上車站"}${fx.gone}`); broken = broken || leg.name || "公車";
        res.push(...pre, base); cursor = a0; origCursor = a0; first = false; continue;
      }
      if (!fx) { res.push(...pre, base); cursor = a0; origCursor = a0; first = false; continue; }
      const sh = fx.dep - p0, mv = t => t && isoTpe(tms(t) + sh);
      const nl = { ...base, from: { ...base.from, time: isoTpe(fx.dep) }, to: { ...base.to, time: isoTpe(a0 + sh) }, stops: (base.stops || []).map(x => ({ ...x, time: mv(x.time) })), ...(fx.est ? { est: true } : {}), ...(fx.live ? { liveDep: true } : {}) };
      const w = pre.filter(l => l.kind !== "wait"); let t = fx.dep - walkSum(w);
      for (const l of w) { res.push({ ...l, from: { ...l.from, time: isoTpe(t) }, to: { ...l.to, time: isoTpe(t + l.dur * 1000) } }); t += l.dur * 1000; }
      start = fx.dep - walkSum(w); firstFixed = true;
      res.push(nl); (fx.est ? warns : busNotes).push(fx.note);
      cursor = a0 + sh; origCursor = a0; first = false; continue;
    }
    const catchable = cursor <= origCursor || p0 >= cursor + 60000;
    if (catchable) { pushWait(base, cursor, p0); res.push(base); cursor = a0; origCursor = a0; continue; }
    const ready = cursor + 60000;
    let c = null;
    if (leg.mode === "mrt" || leg.mode === "tra" || leg.mode === "thsr") {
      const A = await stOf(leg, "from"), B = await stOf(leg, "to");
      if (A && B && A.op === B.op) c = leg.mode === "mrt" ? await tripPick(A.op, A.ids, B.ids, { ready }) : await trainPick(A.op, A.ids, B.ids, ready);
    }
    if (c) {
      const nl = retimed(base, c.dep, c.arr, leg.mode === "mrt" ? { tt: true, headsign: c.dest || base.headsign, stops: await stopsOf(c) } : { tt: true, number: c.no, trainType: leg.mode === "tra" && c.type ? TRA_TYPE(c.type) : c.type || base.trainType, ...(leg.mode === "tra" && c.type ? { trainTypeFull: c.tf || c.type } : {}), headsign: c.dest || base.headsign });
      pushWait(nl, cursor, c.dep); res.push(nl);
      notes.push(`接不上原本 ${hmTpe(p0)} 的${leg.mode === "tra" || leg.mode === "thsr" ? (TRA_TYPE(c.type) || leg.name) : leg.name}，改搭 ${hmTpe(c.dep)}${leg.mode === "tra" || leg.mode === "thsr" ? ` ${c.no}次` : ""}`);
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
    // v2.28.0：記下續坐點（路線詳情顯示「免轉乘 ○○ HH:MM・同一班車，不用下車」）
    const thru = [...(L.thru || []), { name: L.to.name, time: L.to.time, dep: M.from.time }, ...(M.thru || [])];
    res.splice(k, j - k + 1, { ...L, to: M.to, dur: Math.round((tms(M.to.time) - tms(L.from.time)) / 1000), stops: st, stopCount: st.length + 1, thru });
    k--;
  }
  for (let k = notes.length - 1; k >= 0; k--) if (!notes[k]) notes.splice(k, 1);
  for (const l of res) delete l._note;
  const end = cursor;
  const sys = [...sysNames].join("、");
  const ttNote = [...busNotes, notes.length ? `${sys || "班次"}已依官方時刻表校正：` + notes.join("；") : "", ...warns.map(w => "注意：" + w)].filter(Boolean).join("；");
  const tr = res.filter(l => l.kind === "transit");
  const o = { ...r, legs: res, start, end, dur: Math.round((end - start) / 60000), transfers: Math.max(0, tr.length - 1), ttNote: [r.ttNote, ttNote].filter(Boolean).join("；") || undefined, ...(warns.length ? { ttWarn: true } : {}), ...(broken ? { broken } : {}) };
  if (firstFixed) { delete o.shifted; delete o.missed; }
  if (lvCand) { o._lv = true; o._src = r; } else { delete o._lv; delete o._src; }
  return o;
}
const MODE_NAME = { bus: "公車", mrt: "捷運", lrt: "輕軌", tra: "台鐵", thsr: "高鐵" };
const addNote = (a, b) => a ? a + "；" + b.replace(/^淡海輕軌已依官方時刻表校正：|^.*?已依官方時刻表校正：/, "") : b;
const hmTpe = ms => isoTpe(ms).slice(11, 16);
// 路線「形狀」：搭哪些車、在哪上下車（不看時間），用來判斷是不是同一種走法
// 第一段車之前的步行（不含等車）
const preWalk = r => { let s = 0; for (const l of r.legs) { if (l.kind === "transit") return s; if (l.kind !== "wait") s += l.dur * 1000; } return 0; };
// 出發時間＝第一班車開車時間－前面的步行（TDX 的 start_time 有時含開頭的等車、或對不上校正過的時間）；步行段排到剛好趕上第一班車
function planStartNorm(r) {
  const i0 = r.legs.findIndex(l => l.kind === "transit"); if (i0 < 0) return r;
  const f0 = tms(r.legs[i0].from.time), w = preWalk(r), st = f0 - w;
  if (Math.abs(st - r.start) < 60000) return r;
  let t = st; const pre = r.legs.slice(0, i0).filter(l => l.kind !== "wait").map(l => { const x = { ...l, from: { ...l.from, time: isoTpe(t) }, to: { ...l.to, time: isoTpe(t + l.dur * 1000) } }; t += l.dur * 1000; return x; });
  return { ...r, legs: [...pre, ...r.legs.slice(i0)], start: st, dur: Math.round((r.end - st) / 60000) };
}
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
  try { const r = await fetch(nt(`${proxy}/bus/routes?c=${city}`)); if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) { c.cities[city] = j; c.ct[city] = Date.now(); IDB.set("busidx", c).catch(() => {}); return j; } } } catch (e) {}
  return [];
}
async function sorOf(k, route, uid) {
  const key = `${k.path}|${route}`, sc = await IDB.get("sor|" + key);
  if (sc && (!uid || sc.d.some(r => r.RouteUID === uid))) return sc.d;
  if (uid) {   // v2.42.0：先問雲端
    const l = (await cloudSor([uid]).catch(() => ({})))[uid];
    if (l && l.length) { const d = [...(sc ? sc.d.filter(r => r.RouteUID !== uid) : []), ...l]; IDB.set("sor|" + key, { t: Date.now(), d, src: "kv" }).catch(() => {}); return d; }
    if (sc) return sc.d;
  }
  return sc ? sc.d : [];
}
async function planBusMatch(leg) {
  const ag = (leg.agency || "").slice(0, 3).toUpperCase(), c0 = UIDC[ag];
  const order = [...new Set([c0, "InterCity", c0 === "Taipei" ? "NewTaipei" : c0 === "NewTaipei" ? "Taipei" : null].filter(Boolean))];
  for (const city of order) {
    const list = await busCity(city);
    const cands = list.filter(r => pn(r[1]) === pn(leg.name));
    for (const r of cands) {
      const k = routeKind(r[0]); if (!k) continue;
      let sor; try { sor = await sorOf(k, r[1], r[0]); } catch (e) { if (isRate(e)) throw e; continue; }
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
          const etas = await routeEtas(b);
          // 同一站可能有好幾條支線（例如 1815A～G），挑最有用的那筆：有預估秒數的最近一班 > 有下一班時間的 > 其他
          const rank = t => t.StopStatus === 0 && typeof t.EstimateTime === "number" ? t.EstimateTime : (t.StopStatus ?? 0) === 1 && t.NextBusTime ? 1e6 : 2e6 + (t.StopStatus || 0);
          const e = etas.filter(t => t.RouteUID === b.routeUID && t.StopUID === b.stopUID && etaDirOk(t, b.dirNum, b.routeUID)).sort((x, y) => rank(x) - rank(y))[0];
          if (e) o.bus = { sec: typeof e.EstimateTime === "number" ? e.EstimateTime : null, status: e.StopStatus ?? 0, next: e.NextBusTime || null };
        }
        out[i] = o; return;
      }
      const g = await planRailStation(leg, "from"); if (!g) { out[i] = { miss: true }; return; }
      const g2 = await planRailStation(leg, "to").catch(() => null);
      const o = { open: { type: "rail", r: g }, to: g2 ? { op: g2.op, ids: g2.ids, name: g2.name } : null };
      if (wantLive) {
        const B = await railBoard(tdx, g);
        if (AUTO && B && B.pending) await B.pending.catch(() => null);   // v2.49.0：定時更新時等延後的部分結束，避免 AUTO 放開後才補打 TDX
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
    if (r.status === 401) { localStorage.removeItem(SESS_KEY); s2sSampleClear().catch(() => {}); return null; }
    if (!r.ok) return { ...s, offline: true };
    const j = await r.json(); const n = { ...s, name: j.name, role: j.role };
    localStorage.setItem(SESS_KEY, JSON.stringify(n)); return n;
  } catch (e) { return { ...s, offline: true }; }
}
async function authLogout() {
  const s = getSession(); localStorage.removeItem(SESS_KEY); await s2sSampleClear().catch(() => {}); try { if (!s2sbLive) { localStorage.removeItem(S2SB_KEY); localStorage.removeItem(S2SB_LOCK); } } catch (e) {}   // JT-20261108-01：登出就刪掉本機拒收樣本
  const proxy = getProxy();
  if (s && proxy) { try { await fetch(proxy + "/auth/logout", { method: "POST", headers: { "x-session": s.token } }); } catch (e) {} }
}

// v2.49.0：定時更新（p.auto）期間 AUTO>0；有延後補上的結果（railBoard 的 pending）就等它結束才放開
const AUTO_OK = new Set(["nearby", "route", "railBoard", "planLive"]);
let autoGen = 0;
window.dataApi = async (action, p = {}) => {
  if (!(p && p.auto && AUTO_OK.has(action))) {
    if (AUTO && AUTO_OK.has(action)) { AUTO = 0; autoGen++; }   // 手動更新／第一次載入優先：放開還沒結束的定時更新旗標，讓原本的 TDX 備援照舊
    return dataApi0(action, p);
  }
  AUTO++;
  const gen = autoGen; let held = false;
  const dec = () => { if (gen === autoGen && AUTO > 0) AUTO--; };
  try {
    const r = await dataApi0(action, p);
    if (r && r.pending && typeof r.pending.then === "function") { held = true; let done = false; const rel = () => { if (!done) { done = true; dec(); } }; r.pending.then(rel, rel); setTimeout(rel, 30000); }   // 最多 30 秒就放開，避免卡住
    return r;
  } finally { if (!held) dec(); }
};
const dataApi0 = async (action, p = {}) => {
  switch (action) {
    case "nearby": return nearby(p);
    case "busNearEta": return busNearEta(p.lat, p.lon, p.r, p.profile || "main", p.tdxUrl, p.geoKey, p.fresh, p.opt || p);
    case "route": return routeView(p);
    case "schedule": return busSchedule(p || {});
    case "schStatus": return authedGet("/bus/sch/meta");
    case "s2sMeta": return authedGet("/bus/s2s/meta?c=" + enc(p.c || ""));
    case "s2sImport": return s2sImportOne(p || {});
    case "s2sBatchGet": return s2sBatchGet();
    case "s2sBatchPrepare": return s2sBatchPrepare(p || {});
    case "s2sBatchRun": return s2sBatchRun(p || {});
    case "s2sBatchSkipCur": return s2sBatchSkipCur();
    case "s2sBatchReset": return s2sBatchReset();
    case "s2sDocGet": return s2sDocGet(p || {});
    case "walkTable": return walkTable(p.o, p.d, p.oStops, p.dStops);   // Opus：測試分兩次 table 的間隔用
    case "s2sRouteGet": return s2sRouteGet(p || {});
    case "s2sSampleGet": return s2sSampleGet();
    case "s2sSampleClear": return s2sSampleClear();
    case "s2sPending": return s2sPending(p || {});
    case "s2sLocalCounts": return s2slCounts(p && p.c);
    case "s2sLocalGet": return s2slGet(p.c, p.route);
    case "s2sLocalPut": case "s2slPut": return s2slPut(p);
    case "s2sLocalDlBatchGet": return s2sLocalDlBatchGet(p || {});
    case "s2sLocalDlBatchPrepare": return s2sLocalDlBatchPrepare(p || {});
    case "s2sLocalDlBatchRun": return s2sLocalDlBatchRun(p || {});
    case "s2sLocalDlBatchSkipCur": return s2sLocalDlBatchSkipCur(p || {});
    case "s2sLocalDlBatchReset": return s2sLocalDlBatchReset(p || {});
    case "s2sLocalDlBatchOpen": return s2sLocalDlBatchOpen();
    case "s2sLocalUpBatchGet": return s2sLocalUpBatchGet(p || {});
    case "s2sLocalUpBatchPrepare": return s2sLocalUpBatchPrepare(p || {});
    case "s2sLocalUpBatchRun": return s2sLocalUpBatchRun(p || {});
    case "s2sLocalUpBatchReset": return s2sLocalUpBatchReset(p || {});
    case "s2sLocalUpBatchOpen": return s2sLocalUpBatchOpen();
    case "s2sLocalExportAll": return s2sLocalExportAll(p && p.c);
    case "s2sLocalClearAll": return s2slClear();
    case "s2slMigrateOnce": return s2slMigrateOnce();
    case "schBuild": return schBuild(p || {});
    case "khhSchDate": return khhSchDate();
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
    case "busDirect": return busDirectPlan(p || {});
    case "walkRoute": return walkRoute(p || {});
    case "locatePlan": return locatePlan();
    case "planLive": return planLive(p);
    case "rpBusNear": return rpBusNear(p || {});
    case "liveFavs": return liveFavs(p.favs || {}, p.fresh);
    case "gmapImg": return gmapImg(p || {});
    case "geoSearch": return geoSearch(p);
    case "geoReverse": return geoReverse(p);
    case "locate": return locate();
    case "placeIndex": return placeIndex(p || {});
    case "stopAt": return stopAt(p || {});
    case "pdaStopEta": return pdaStopEta(p && p.city, p && (p.ids || p.stopIds), p && p.ttl);
    case "loadPdaThbMap": return loadPdaThbMap();
    case "refreshNwtRoutes": return refreshNwtRoutes(p.routes || [], p.opt || {});
    case "fillOfficialEta": return fillOfficialEta(p.rows || [], p.opt || {});
    case "bikeAt": return bikeAt(p || {});
    case "railSearch": return railSearch(p || {});
    case "busDest": return busDest(p || {});
    case "railPickNear": return railPickNear(p || {});
    case "railStationRef": return railStationRef(p || {});
    case "scStatus": return scCall("GET", "/shortcut/status");
    case "scToken": return scCall("POST", "/shortcut/token", { sub: p.sub });
    case "scSub": return scCall("POST", "/shortcut/sub", { sub: p.sub });
    case "scRevoke": return scCall("POST", "/shortcut/revoke", {});
    case "scTry": return scTry(p || {});
    case "lineView": return lineView(tdx, p && BR_BASE[p.line] ? { ...p, line: BR_BASE[p.line] } : p);
    case "trainView": return trainView(tdx, p);
    case "tripView": return tripView(tdx, p && BR_BASE[p.line] ? { ...p, line: BR_BASE[p.line] } : p);
    case "stationTT": return stationTT(p || {});
    case "ttMeta": return ttMeta(true);
    case "buildTrips": return buildTrips(p.tt);
    case "ttSystems": return TT_SYSTEMS;
    case "ttRefresh": return ttRefresh(p.op, p.pass, p.onStep);
    case "guestSync": return guestSync(p || {});
    case "gsyncGet": return gsyncCall("GET", p.pass);
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
