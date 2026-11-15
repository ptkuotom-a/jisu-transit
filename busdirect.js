// v2.49.29：自有雲端資料（bsch 公車時刻表＋雲端站牌座標＋s2stime 站間旅行時間）算「公車直達」，不呼叫外部路徑引擎（TDX MaaS／Google）。
// 純函式模組：瀏覽器（含 Web Worker）掛在 self.BusDirect，Node 用 module.exports。時間一律以台北時間（UTC+8）計算，與裝置時區無關。
// 安全子集：支援逐站表定時刻（timetable）、起點發車（startOnly）、班距估算（halfHeadway）。國定假日不再整天不列：有假日位元（bit 7）用假日班表，舊打包沒有這個位元就用週日班表。
// 未定案政策不寫死：步行半徑、步行速度、直線距離係數必須由呼叫端傳入；「提早抵達下限」沒傳就不套用並明示；freqPolicy 支援 "exclude" 與 "halfHeadway"。
(function (root) {
  "use strict";

  // Web Worker 環境載入 s2stime.js
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) {
    if (typeof importScripts === "function" && typeof root.S2STIME === "undefined") {
      try { importScripts("./s2stime.js"); } catch (e) {}
    }
  }

  function getS2STime() {
    if (typeof root !== "undefined" && root.S2STIME) return root.S2STIME;
    if (typeof self !== "undefined" && self.S2STIME) return self.S2STIME;
    if (typeof require === "function") {
      try { return require("./s2stime.js"); } catch (e) {}
    }
    return null;
  }

  const TPE = 8 * 3600000, DAY = 86400000;
  const hav = (a, b, c, d) => {
    const R = 6371000, r = x => x * Math.PI / 180, x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  // "YYYY-MM-DDTHH:MM[:SS]" 視為台北時間 → epoch ms
  function parseTpe(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - TPE : null;
  }
  const isoTpe = ms => new Date(ms + TPE).toISOString().slice(0, 19);
  const hmTpe = ms => new Date(ms + TPE).toISOString().slice(11, 16);
  const dayMid = ms => Math.floor((ms + TPE) / DAY) * DAY - TPE; // 該台北日期 00:00 的 epoch
  const ymd = mid => new Date(mid + TPE).toISOString().slice(0, 10).replace(/-/g, "");
  const wday = mid => new Date(mid + TPE).getUTCDay(); // 0＝日

  // 國定假日：有獨立假日位元（bit 7，新打包才有）就用假日班表；舊雲端打包沒有這個位元，改用週日班表。不再整天不列。
  function serviceBit(mask, weekday, isHoliday) {
    if (isHoliday) {
      if ((mask >> 7) & 1) return true;
      return (mask & 1) === 1;
    }
    return ((mask >> weekday) & 1) === 1;
  }

  function walkChunks(pts) {
    const out = [];
    for (let i = 0; i < (pts || []).length - 1;) {
      const slice = pts.slice(i, i + 5);
      out.push(slice);
      i += Math.max(1, slice.length - 1);
    }
    return out;
  }

  const CITY_BOX = {
    Keelung: [25.07, 121.62, 25.18, 121.82],
    Taipei: [24.96, 121.46, 25.21, 121.67],
    NewTaipei: [24.67, 121.28, 25.30, 122.01],
    Taoyuan: [24.58, 120.98, 25.12, 121.48],
    Hsinchu: [24.75, 120.89, 24.86, 121.04],
    HsinchuCounty: [24.45, 120.92, 24.95, 121.30],
    MiaoliCounty: [24.28, 120.62, 24.75, 121.25],
    Taichung: [24.00, 120.45, 24.45, 121.40],
    ChanghuaCounty: [23.78, 120.20, 24.20, 120.70],
    NantouCounty: [23.45, 120.60, 24.25, 121.35],
    YunlinCounty: [23.50, 120.10, 23.85, 120.75],
    Chiayi: [23.45, 120.40, 23.52, 120.50],
    ChiayiCounty: [23.20, 120.10, 23.65, 120.90],
    Tainan: [22.88, 120.05, 23.42, 120.66],
    Kaohsiung: [22.47, 120.20, 23.05, 120.75],
    PingtungCounty: [21.90, 120.40, 22.90, 120.95],
    YilanCounty: [24.30, 121.30, 24.95, 121.98],
    HualienCounty: [23.00, 120.95, 24.40, 121.80],
    TaitungCounty: [22.00, 120.75, 23.50, 121.55],
    PenghuCounty: [23.15, 119.40, 23.80, 119.75],
    KinmenCounty: [24.38, 118.20, 24.55, 118.50],
    LienchiangCounty: [25.95, 119.90, 26.40, 120.55]
  };

  function citiesFor(o, d) {
    const pad = 0.08;
    const inside = (p, b) => p && isFinite(p.lat) && isFinite(p.lon) && p.lat >= b[0] - pad && p.lat <= b[2] + pad && p.lon >= b[1] - pad && p.lon <= b[3] + pad;
    const names = Object.keys(CITY_BOX).filter(c => inside(o, CITY_BOX[c]) || inside(d, CITY_BOX[c]));
    const far = o && d && isFinite(o.lat) && isFinite(d.lat) && hav(o.lat, o.lon, d.lat, d.lon) > 12000;
    const thin = names.includes("MiaoliCounty") || names.includes("TaitungCounty");
    const out = names.slice(0, 4);
    if (far || thin || !out.length) out.push("InterCity");
    return [...new Set(out)];
  }

  const UID_CITY = {
    TPE: "Taipei", NWT: "NewTaipei", KEE: "Keelung", TAO: "Taoyuan",
    HSZ: "Hsinchu", HSQ: "HsinchuCounty", MIA: "MiaoliCounty",
    TXG: "Taichung", CHA: "ChanghuaCounty", NAN: "NantouCounty",
    YUN: "YunlinCounty", CYI: "Chiayi", CYQ: "ChiayiCounty",
    TNN: "Tainan", KHH: "Kaohsiung", PIF: "PingtungCounty",
    ILA: "YilanCounty", HUA: "HualienCounty", TTT: "TaitungCounty",
    PEN: "PenghuCounty", KIN: "KinmenCounty", LIE: "LienchiangCounty",
    THB: "InterCity"
  };

  function placePt(p, time, kind) {
    return { time, place: { name: p && p.name || "", type: kind || "location", location: p && p.lat != null ? { lat: p.lat, lng: p.lon } : {} } };
  }

  function sectionsFromBus(r, o, d) {
    const wsrc = w => w && w.src === "osrm" ? "osrm" : "line";
    let rideSrc = "line";
    if (r.confidence === "live") rideSrc = "live";
    else if (r.headway) rideSrc = "headway";
    else if (r.confidence === "timetable") rideSrc = "schedule";
    else if (r.confidence === "s2s" || (r.rideSrc && (r.rideSrc === "s2s" || r.rideSrc.ride === "s2s"))) rideSrc = "s2s";
    else if (r.confidence === "schedule" || (r.rideSrc && (r.rideSrc === "schedule" || r.rideSrc.ride === "schedule"))) rideSrc = "schedule";
    const stop = s => ({ time: s.time, place: { name: s.name, type: "stop", ...(s && s.uid ? { stopUID: s.uid } : {}), location: s.pos ? { lat: s.pos[0], lng: s.pos[1] } : {} } });
    const uid = r.routeUID || "";
    const pfx = uid.slice(0, 3).toUpperCase();
    const city = r.city || UID_CITY[pfx] || "";
    return {
      source: "self",
      start_time: r.startIso,
      end_time: r.endIso,
      sections: [
        { type: "pedestrian", timeSrc: wsrc(r.walkO), departure: placePt(o, r.startIso), arrival: stop(r.from), travelSummary: { duration: (r.walkO && r.walkO.min || 0) * 60, length: r.walkO && r.walkO.m || 0 } },
        { type: "transit", timeSrc: rideSrc, transport: { mode: "bus", name: r.name, headsign: r.to && r.to.name || "", ...(uid ? { routeUID: uid } : {}), ...(city ? { city } : {}), ...(r.dir != null ? { dir: r.dir === 1 ? 1 : 0 } : {}), ...(r.confidence === "live" ? { liveDep: true } : rideSrc === "schedule" ? {} : { est: true }) }, agency: { agency_id: uid || "bus", name: "公車" }, departure: stop(r.from), arrival: stop(r.to), travelSummary: { duration: (r.ride || 0) * 60 } },
        { type: "pedestrian", timeSrc: wsrc(r.walkD), departure: stop(r.to), arrival: placePt(d, r.endIso), travelSummary: { duration: (r.walkD && r.walkD.min || 0) * 60, length: r.walkD && r.walkD.m || 0 } }
      ]
    };
  }

  function walkOnlyRoute(o, d, startIso, endIso, sec, meters, src) {
    return {
      source: "self",
      start_time: startIso,
      end_time: endIso,
      sections: [
        { type: "pedestrian", timeSrc: src, departure: placePt(o, startIso), arrival: placePt(d, endIso), travelSummary: { duration: sec, length: meters } }
      ]
    };
  }

  function bikeRoute(o, d, a, b, p) {
    const t0 = parseTpe(p.startIso);
    const t1 = t0 + p.walkO.sec * 1000;
    const t2 = t1 + p.ride.sec * 1000;
    const t3 = t2 + p.walkD.sec * 1000;
    return {
      source: "self",
      start_time: isoTpe(t0),
      end_time: isoTpe(t3),
      sections: [
        { type: "pedestrian", timeSrc: p.walkO.src, departure: placePt(o, isoTpe(t0)), arrival: placePt(a, isoTpe(t1), "stop"), travelSummary: { duration: p.walkO.sec, length: p.walkO.m } },
        { type: "cycle", timeSrc: p.ride.src, departure: placePt(a, isoTpe(t1), "stop"), arrival: placePt(b, isoTpe(t2), "stop"), travelSummary: { duration: p.ride.sec, length: p.ride.m } },
        { type: "pedestrian", timeSrc: p.walkD.src, departure: placePt(b, isoTpe(t2), "stop"), arrival: placePt(d, isoTpe(t3)), travelSummary: { duration: p.walkD.sec, length: p.walkD.m } }
      ]
    };
  }

  function joinRoutes(bus, rail, opt) {
    if (!bus || !rail || !Array.isArray(bus.sections) || !Array.isArray(rail.sections)) return null;
    const b = bus.sections.slice();
    const keepTail = !!(opt && opt.keepTail);
    if (!keepTail && b.length && b[b.length - 1].type === "pedestrian") b.pop();
    const isUrban = s => s && s.type === "transit" && /^(mrt|metro|subway|lrt|light)$/i.test(String(s.transport && s.transport.mode || ""));
    const isLong = s => s && s.type === "transit" && /^(tra|thsr|hsr|rail|train)$/i.test(String(s.transport && s.transport.mode || ""));
    const firstTr = secs => (secs || []).find(s => s && s.type === "transit");
    const hasLong = secs => (secs || []).some(isLong);
    const bEndMs = parseTpe((b.length && b[b.length - 1].arrival && b[b.length - 1].arrival.time) || bus.end_time);
    let chosenRail = rail;
    const baseT0 = firstTr(rail.sections);
    if (bEndMs != null && baseT0 && isUrban(baseT0) && hasLong(rail.sections)) {
      const wait0 = parseTpe(baseT0.departure && baseT0.departure.time) - bEndMs;
      if (wait0 > 10 * 60000 && opt && Array.isArray(opt.railCandidates)) {
        const baseEndMs = parseTpe(rail.end_time);
        const early = opt.railCandidates.filter(c => {
          if (!c || !Array.isArray(c.sections)) return false;
          const c0 = firstTr(c.sections);
          if (!c0 || !isUrban(c0) || !hasLong(c.sections)) return false;
          const dep0 = parseTpe(c0.departure && c0.departure.time);
          const arrEnd = parseTpe(c.end_time);
          return dep0 != null && dep0 >= bEndMs && (baseEndMs == null || arrEnd == null || arrEnd <= baseEndMs);
        }).sort((x, y) => {
          const dx = parseTpe(firstTr(x.sections).departure.time);
          const dy = parseTpe(firstTr(y.sections).departure.time);
          return dx - dy;
        })[0];
        if (early && parseTpe(firstTr(early.sections).departure.time) < parseTpe(baseT0.departure.time)) {
          chosenRail = early;
        }
      }
    }
    const r = chosenRail.sections.slice();
    if (r.length && r[0].type === "pedestrian") r.shift();
    if (chosenRail !== rail) {
      const outR = [];
      for (let i = 0; i < r.length; i++) {
        const cur = r[i];
        if (isLong(cur) && i > 0) {
          const prev = outR[outR.length - 1];
          const pEnd = parseTpe(prev && prev.arrival && prev.arrival.time);
          const cDep = parseTpe(cur.departure && cur.departure.time);
          if (prev && prev.type !== "waiting" && pEnd != null && cDep != null && cDep - pEnd >= 60000) {
            outR.push({ type: "waiting", departure: { time: isoTpe(pEnd), place: prev.arrival.place }, arrival: { time: isoTpe(cDep), place: cur.departure.place }, travelSummary: { duration: Math.round((cDep - pEnd) / 1000) } });
          }
        }
        outR.push(cur);
      }
      return { source: "self", start_time: bus.start_time, end_time: chosenRail.end_time, sections: b.concat(outR) };
    }
    return { source: "self", start_time: bus.start_time, end_time: chosenRail.end_time, sections: b.concat(r) };
  }

  function syncRouteTimes(r) {
    if (!r || !Array.isArray(r.legs)) return r;
    const legs = r.legs;
    const setT = (endObj, ms) => { if (endObj) endObj.time = isoTpe(ms); };
    const trIdx = [];
    for (let i = 0; i < legs.length; i++) if (legs[i] && legs[i].kind === "transit") trIdx.push(i);
    if (trIdx.length) {
      let cur = parseTpe(legs[trIdx[0]].from && legs[trIdx[0]].from.time);
      if (cur != null) {
        for (let i = trIdx[0] - 1; i >= 0; i--) {
          setT(legs[i].to, cur);
          cur -= Math.round((legs[i].dur || 0) * 1000);
          setT(legs[i].from, cur);
        }
        r.start = cur;
      }
      for (let t = 0; t < trIdx.length - 1; t++) {
        const a = trIdx[t], b = trIdx[t + 1];
        let mc = parseTpe(legs[a].to && legs[a].to.time);
        const endC = parseTpe(legs[b].from && legs[b].from.time);
        if (mc == null) continue;
        for (let k = a + 1; k < b; k++) {
          const lg = legs[k];
          if (lg.kind === "wait" && k === b - 1 && endC != null) {
            setT(lg.from, mc);
            setT(lg.to, endC);
            lg.dur = Math.max(0, Math.round((endC - mc) / 1000));
            mc = endC;
          } else {
            setT(lg.from, mc);
            mc += Math.round((lg.dur || 0) * 1000);
            setT(lg.to, mc);
          }
        }
      }
      let fcur = parseTpe(legs[trIdx[trIdx.length - 1]].to && legs[trIdx[trIdx.length - 1]].to.time);
      if (fcur != null) {
        for (let i = trIdx[trIdx.length - 1] + 1; i < legs.length; i++) {
          setT(legs[i].from, fcur);
          fcur += Math.round((legs[i].dur || 0) * 1000);
          setT(legs[i].to, fcur);
        }
        r.end = fcur;
      }
    } else {
      let cur = Number.isFinite(r.start) ? r.start : parseTpe(legs[0] && legs[0].from && legs[0].from.time);
      if (cur != null) {
        r.start = cur;
        for (const lg of legs) {
          setT(lg.from, cur);
          cur += Math.round((lg.dur || 0) * 1000);
          setT(lg.to, cur);
        }
        r.end = cur;
      }
    }
    if (Number.isFinite(r.start) && Number.isFinite(r.end)) {
      r.dur = Math.max(1, Math.round((r.end - r.start) / 60000));
    }
    r.approx = legs.some(x => !!x.approx);
    return r;
  }

  function applyWalkShape(r, l, res) {
    if (!l || !res || !res.ok) return false;
    l.shape = { roads: res.roads || [], parts: res.parts || 1, coords: Array.isArray(res.coords) ? res.coords : [] };
    const newLen = typeof res.distance === "number" && isFinite(res.distance) && res.distance > 0 ? Math.round(res.distance) : l.len;
    const newDur = typeof res.duration === "number" && isFinite(res.duration) && res.duration > 0 ? Math.round(res.duration) : l.dur;
    const changed = (newLen != null && newLen !== l.len) || (newDur != null && newDur !== l.dur) || l.timeSrc !== "osrm";
    if (newLen != null) l.len = newLen;
    if (newDur != null) l.dur = newDur;
    l.timeSrc = "osrm";
    l.approx = false;
    if (changed && r) syncRouteTimes(r);
    return changed;
  }

  function sortOwn(list, when, limit) {
    const walkLen = r => (r.legs || []).reduce((a, l) => a + ((l.kind === "walk" || l.kind === "bike") ? (l.len || 0) : 0), 0);
    const hasT = r => (r.legs || []).some(l => l.kind === "transit");
    const hasBike = r => (r.legs || []).some(l => l.kind === "bike");
    // v2.51.6：同時抵達時晚出發的排前面（少等）；先比分鐘，避免秒數差把晚出發的排到後面
    const minOf = t => Math.floor((t || 0) / 60000);
    const cmp = (a, b) => (when === "arr" ? b.start - a.start : minOf(a.end) - minOf(b.end)) || (when === "arr" ? 0 : minOf(b.start) - minOf(a.start)) || (a.transfers || 0) - (b.transfers || 0) || walkLen(a) - walkLen(b);
    // 指定抵達：先拿掉抵達晚於指定時間的方案（含步行）。全部趕不上才留最早到的一條。
    if (when === "arr" && limit != null && isFinite(limit)) {
      const onTime = list.filter(r => r.end <= limit);
      if (!onTime.length) {
        const earliest = list.slice().sort((a, b) => (a.end - b.end) || (a.start - b.start))[0];
        if (!earliest) return [];
        earliest.note = earliest.note ? earliest.note + "；趕不上指定時間" : "趕不上指定時間";
        return [earliest];
      }
      list = onTime;
    }
    const bikes = list.filter(r => hasBike(r));
    const walks = list.filter(r => !hasT(r) && !hasBike(r));
    const rides = list.filter(r => hasT(r) && !hasBike(r));
    rides.sort(cmp);
    walks.sort(cmp);
    bikes.sort(cmp);
    if (!rides.length && !bikes.length) {
      if (walks[0]) walks[0].suggestWalk = true;
      return walks.slice(0, 1);
    }
    const w = walks[0];
    const walkFirst = !!(w && rides.length && rides.every(r => when === "arr" ? w.start >= r.start : w.end <= r.end));
    if (walkFirst) w.suggestWalk = true;
    const out = (walkFirst ? [w] : []).concat(rides, bikes);
    out.sort(cmp);
    if (walkFirst && out[0] !== w) { out.splice(out.indexOf(w), 1); out.unshift(w); }
    const capped = out.slice(0, 8);
    if (bikes.length && !capped.some(hasBike)) capped[capped.length - 1] = bikes[0];
    return capped;
  }

  function plan(input) {
    const { records, stops, o, d, when, time, opts, s2s, sor, cand, walkTable, live, nowMs, sorOneStop } = input || {};
    const P = opts || {};
    const bad = m => ({ status: "bad-params", message: m, routes: [] });

    for (const k of ["walkRadiusM", "walkMpm", "walkFactor"]) {
      if (!(typeof P[k] === "number" && P[k] > 0)) {
        return bad("缺少參數 " + k + "（尚未定案的政策，必須由呼叫端明確傳入）");
      }
    }

    const freqPolicy = P.freqPolicy || "exclude";
    if (freqPolicy !== "exclude" && freqPolicy !== "halfHeadway") {
      return bad("只有班距的路線列法尚未開放（目前只支援 exclude 與 halfHeadway）");
    }

    if (when !== "dep" && when !== "arr") return bad("when 必須是 dep 或 arr");
    const t = parseTpe(time);
    if (t == null) return bad("時間格式要是 YYYY-MM-DDTHH:MM（台北時間）");
    if (!o || !d || !isFinite(o.lat) || !isFinite(o.lon) || !isFinite(d.lat) || !isFinite(d.lon)) {
      return bad("缺少起訖點座標");
    }

    const early = typeof P.earlyLimitMin === "number" && P.earlyLimitMin > 0 ? P.earlyLimitMin : null;
    const hol = new Set(P.holidays || []), max = P.maxResults > 0 ? P.maxResults : 6;
    const st = {
      recs: 0,
      timetable: 0,
      startOnly: 0,
      freqOnly: 0,
      freqNoHeadway: 0,
      noS2s: 0,
      noStops: 0,
      special: 0,
      missingTime: 0,
      noCoord: 0,
      sorOneStop: sorOneStop || 0,
      holidaySkipped: [],
      tripsChecked: 0
    };
    const notes = [];
    if (early == null && when === "arr") notes.push("「提早抵達下限」尚未定案，未套用");

    if (!Array.isArray(records) || !records.length || !stops || !Object.keys(stops).length) {
      return { status: "not-covered", reason: "雲端沒有這一區的公車時刻表或站牌資料", routes: [], stats: st, notes };
    }

    const R = P.walkRadiusM, wm = m => Math.ceil(m * P.walkFactor / P.walkMpm);
    const near = (p) => {
      const m = new Map();
      for (const [u, c] of Object.entries(stops)) {
        if (!c) continue;
        const x = hav(p.lat, p.lon, c[0], c[1]);
        if (x <= R) m.set(u, x);
      }
      return m;
    };
    const NO = near(o), ND = near(d);
    if (!NO.size) return { status: "not-covered", reason: "起點" + R + "公尺內沒有已收錄座標的站牌", routes: [], stats: st, notes };
    if (!ND.size) return { status: "not-covered", reason: "終點" + R + "公尺內沒有已收錄座標的站牌", routes: [], stats: st, notes };

    const q0 = dayMid(t);
    const days = [q0 - DAY, q0, q0 + DAY];
    const holHit = days.filter(m => hol.has(ymd(m))).map(m => ymd(m));
    if (holHit.length) notes.push("國定假日（" + holHit.join("、") + "）用假日班表；雲端舊打包沒有獨立假日位元時，改用週日班表");

    const s2sInst = getS2STime();
    const best = new Map();

    for (const r of records) {
      st.recs++;

      // 取得站序 S：優先使用 r.st，若無則從 sor 或 s2s 取
      let S = r.st || [];
      let sorEntry = null;
      if (sor) {
        const sorList = sor[r.u] || sor[r.n] || [];
        const rawMatch = sorList.find(x => Number(x.Direction) === Number(r.d) && (!r.s || String(x.SubRouteUID) === String(r.s))) || null;
        if (rawMatch && rawMatch.Stops && rawMatch.Stops.length === 1 && sorOneStop == null) st.sorOneStop++;
        sorEntry = (rawMatch && rawMatch.Stops && rawMatch.Stops.length >= 2) ? rawMatch : null;
      }

      if (!S || S.length < 2) {
        if (sorEntry && sorEntry.Stops && sorEntry.Stops.length >= 2) {
          S = sorEntry.Stops.map(s => [
            s.StopUID,
            s.StopName ? (s.StopName.Zh_tw || s.StopName) : s.StopUID,
            s.P
          ]);
        } else if (!sor && s2s) {
          const doc = s2s[r.u] || s2s[r.n];
          if (doc && Array.isArray(doc.d)) {
            const dx = doc.d.find(x => Number(x.Direction) === Number(r.d) && (!r.s || String(x.SubRouteUID) === String(r.s)));
            if (dx && Array.isArray(dx.TravelTimes)) {
              const seqMap = new Map();
              const pfx = (dx.RouteUID || r.u || "").slice(0, 3) || "TPE";
              const prefixId = id => (id == null ? "" : (/^[A-Za-z]/.test(String(id).trim()) ? String(id).trim() : pfx + String(id).trim()));
              for (const tt of dx.TravelTimes) {
                if (tt && tt.FromStopID != null && tt.ToStopID != null && typeof tt.RunTime === "number" && !seqMap.has(tt.Sequence)) {
                  seqMap.set(tt.Sequence, { from: prefixId(tt.FromStopID), to: prefixId(tt.ToStopID) });
                }
              }
              const seqList = Array.from(seqMap.values());
              if (seqList.length) {
                S = [[seqList[0].from, seqList[0].from], ...seqList.map(x => [x.to, x.to])];
              }
            }
          }
        }
      }

      if (!S || S.length < 2) {
        if (!(r.tr && r.tr.length) && (r.f && r.f.length)) st.freqOnly++;
        st.noStops++;
        continue;
      }

      // 若站點座標不在全域 stops 裡，但 S 帶有座標 P，補齊 stops
      S.forEach(s => {
        if (s[2] && !stops[s[0]]) stops[s[0]] = s[2];
      });

      // 檢查路線是否涵蓋起點附近及終點附近
      const iO = [], iD = [];
      S.forEach((s, idx) => {
        const uid = s[0];
        if (!stops[uid]) {
          if (NO.has(uid) || ND.has(uid)) st.noCoord++;
          return;
        }
        if (NO.has(uid)) iO.push(idx);
        if (ND.has(uid)) iD.push(idx);
      });

      if (!iO.length || !iD.length) {
        if (!(r.tr && r.tr.length) && (r.f && r.f.length)) st.freqOnly++;
        continue;
      }

      // 檢核站序順序：是否有起點站在終點站之前（j > i）
      let hasValidOrder = false;
      for (const i of iO) for (const j of iD) if (j > i) { hasValidOrder = true; break; }
      if (!hasValidOrder) continue;

      // 站間時間計算輔助函式
      const doc = s2s ? (s2s[r.u] || s2s[r.n] || (sorEntry && s2s[sorEntry.SubRouteUID])) : null;
      const sub = (sorEntry && sorEntry.SubRouteUID) || r.s || "";   // Opus：要 SubRouteUID（r.s），不是子路線名稱（r.sn）

      function getTravelTime(fromStop, toStop, departTime) {
        if (s2sInst) {
          if (doc) {
            const res = s2sInst.travel({ doc, sub, dir: r.d, from: fromStop, to: toStop, depart: departTime, holidays: hol });
            if (res && res.ok) return { seconds: res.seconds, minutes: res.minutes, source: "s2s" };
          }
          // 退到 fromSchedule
          const sRes = s2sInst.fromSchedule({ rec: r, from: fromStop, to: toStop, depart: departTime });
          if (sRes && sRes.ok) return { seconds: sRes.seconds, minutes: sRes.minutes, source: "schedule" };
          // 退到 fromDistance
          const stopsList = (sorEntry && sorEntry.Stops && sorEntry.Stops.length)
            ? sorEntry.Stops
            : S.map(s => ({ uid: s[0], StopUID: s[0], P: s[2] || stops[s[0]] }));
          const dRes = s2sInst.fromDistance({
            stops: stopsList,
            from: fromStop,
            to: toStop,
            depart: departTime,
            holidays: hol,
            city: String(r.u || "").slice(0, 3) === "THB" ? "InterCity" : "Taipei"
          });
          if (dRes && dRes.ok) return { seconds: dRes.seconds, minutes: dRes.minutes, source: "distance" };
        }
        return null;
      }

      function walkInfoO(uid) {
        const rawDist = NO.get(uid);
        const oSec = walkTable && walkTable.o && typeof walkTable.o[uid] === "number" && Number.isFinite(walkTable.o[uid]) ? walkTable.o[uid] : null;
        const oDist = walkTable && walkTable.oDist && typeof walkTable.oDist[uid] === "number" && Number.isFinite(walkTable.oDist[uid]) ? walkTable.oDist[uid] : rawDist;
        return oSec != null
          ? { m: Math.round(oDist), min: Math.ceil(oSec / 60), src: "osrm", sec: Math.round(oSec) }
          : { m: Math.round(rawDist), min: wm(rawDist), src: "line" };
      }
      function walkInfoD(uid) {
        const rawDist = ND.get(uid);
        const dSec = walkTable && walkTable.d && typeof walkTable.d[uid] === "number" && Number.isFinite(walkTable.d[uid]) ? walkTable.d[uid] : null;
        const dDist = walkTable && walkTable.dDist && typeof walkTable.dDist[uid] === "number" && Number.isFinite(walkTable.dDist[uid]) ? walkTable.dDist[uid] : rawDist;
        return dSec != null
          ? { m: Math.round(dDist), min: Math.ceil(dSec / 60), src: "osrm", sec: Math.round(dSec) }
          : { m: Math.round(rawDist), min: wm(rawDist), src: "line" };
      }

      // --- 模式 0：即時到站 (live) ---
      if (when === "dep" && live) {
        const baseNowMs = Number.isFinite(nowMs) ? nowMs : t;
        for (const i of iO) for (const j of iD) {
          if (j <= i) continue;
          const uidO = S[i][0];
          const liveSec = live[r.u + "|" + r.d + "|" + uidO];   // Opus：只用這個上車站的即時，對不上站就退到下一順位
          if (typeof liveSec !== "number" || !Number.isFinite(liveSec) || liveSec < 0) continue;
          const depMs = baseNowMs + liveSec * 1000;
          let tRide = null;
          if (r.tr && r.tr.length) {
            for (const tr of r.tr) {
              const pat = (r.p || [])[tr[2]] || [];
              if (pat[i] != null && pat[j] != null && pat[i] >= 0 && pat[j] > pat[i]) {
                tRide = { seconds: (pat[j] - pat[i]) * 60, source: "timetable" };
                break;
              }
            }
          }
          if (!tRide) tRide = getTravelTime(uidO, S[j][0], depMs);
          if (!tRide) { st.noS2s++; continue; }
          const arrMs = depMs + tRide.seconds * 1000;
          const wO = walkInfoO(uidO), wD = walkInfoD(S[j][0]);
          // Opus：走到上車站之前公車就到了＝趕不上，這筆即時不用（退到表定或推估）；出發時刻 t 之前也不能出門
          if (depMs - wO.min * 60000 < t) { st.liveMissed = (st.liveMissed || 0) + 1; continue; }
          const start = depMs - wO.min * 60000;
          const end = arrMs + wD.min * 60000;
          const key = r.u + "|" + r.s + "|" + r.d + "|live";
          const c = {
            src: "own-bus", confidence: "live", estimated: false,
            liveSec: Math.round(liveSec), liveMin: Math.max(0, Math.ceil(liveSec / 60)),
            routeUID: r.u, name: r.n, sub: r.sn || (sorEntry && sorEntry.SubRouteUID) || "", dir: r.d,
            from: { uid: uidO, name: S[i][1], time: isoTpe(depMs), seq: i, pos: stops[uidO] },
            to: { uid: S[j][0], name: S[j][1], time: isoTpe(arrMs), seq: j, pos: stops[S[j][0]] },
            walkO: wO, walkD: wD,
            start, end, startIso: isoTpe(start), endIso: isoTpe(end),
            ride: Math.round(tRide.seconds / 60),
            rideSeconds: tRide.seconds,
            rideSrc: tRide.source,
            serviceDate: ymd(baseNowMs)
          };
          const o2 = best.get(key);
          if (!o2 || c.end < o2.end || (c.end === o2.end && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m)) {
            best.set(key, c);
          }
        }
      }

      // --- 模式 1：有時刻表 (tr) ---
      if (r.tr && r.tr.length) {
        for (const [k, tr] of r.tr.entries()) {
          const [mask, base, pi, sp] = tr, pat = (r.p || [])[pi] || [];
          if (sp !== -1 && sp != null && sp !== "") { st.special++; continue; }

          for (const mid of days) {
            if (!serviceBit(mask, wday(mid), hol.has(ymd(mid)))) continue;
            st.tripsChecked++;

            for (const i of iO) for (const j of iD) {
              if (j <= i) continue;
              const a = pat[i], b = pat[j];
              const wO = walkInfoO(S[i][0]), wD = walkInfoD(S[j][0]);
              const wo = wO.min, wd = wD.min;

              if (a != null && b != null && a >= 0 && b >= 0) {
                // (1) 逐站時刻表班次
                st.timetable++;
                const dep = mid + (base + a) * 60000, arr = mid + (base + b) * 60000;
                const start = dep - wo * 60000, end = arr + wd * 60000;
                if (when === "dep" ? start < t : end > t) continue;
                if (early != null && when === "arr" && t - end > early * 60000) continue;

                const key = r.u + "|" + r.s + "|" + r.d + "|" + k + "|" + mid;
                const c = {
                  src: "own-bus", confidence: "timetable", estimated: false,
                  routeUID: r.u, name: r.n, sub: r.sn || "", dir: r.d,
                  from: { uid: S[i][0], name: S[i][1], time: isoTpe(dep), seq: i, pos: stops[S[i][0]] },
                  to: { uid: S[j][0], name: S[j][1], time: isoTpe(arr), seq: j, pos: stops[S[j][0]] },
                  walkO: wO,
                  walkD: wD,
                  start, end, startIso: isoTpe(start), endIso: isoTpe(end),
                  ride: Math.round((arr - dep) / 60000), rideSrc: "timetable",
                  serviceDate: ymd(mid)
                };
                const o2 = best.get(key);
                if (!o2 || (when === "dep" ? c.end < o2.end || (c.end === o2.end && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m) : c.start > o2.start || (c.start === o2.start && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m))) {
                  best.set(key, c);
                }
              } else if (freqPolicy === "halfHeadway") {
                // (2) 只有起點發車（起點發車時刻＋站間時間）
                const originDepOffset = (pat[0] != null && pat[0] >= 0) ? pat[0] : 0;
                const originDepMs = mid + (base + originDepOffset) * 60000;

                // 起點到上車站
                let offsetSec = 0, offsetSrc = "s2s";
                if (i > 0) {
                  const tOff = getTravelTime(S[0][0], S[i][0], originDepMs);
                  if (!tOff) { st.noS2s++; continue; }
                  offsetSec = tOff.seconds;
                  offsetSrc = tOff.source;
                }
                const depMs = originDepMs + offsetSec * 1000;

                // 上車站到下車站
                const tRide = getTravelTime(S[i][0], S[j][0], depMs);
                if (!tRide) { st.noS2s++; continue; }
                const arrMs = depMs + tRide.seconds * 1000;

                const start = depMs - wo * 60000, end = arrMs + wd * 60000;
                if (when === "dep" ? start < t : end > t) continue;
                if (early != null && when === "arr" && t - end > early * 60000) continue;

                st.startOnly++;
                const conf = (tRide.source === "s2s" && (offsetSrc === "s2s" || offsetSec === 0)) ? "s2s" : (tRide.source === "distance" || offsetSrc === "distance" ? "distance" : "schedule");
                const key = r.u + "|" + r.s + "|" + r.d + "|" + k + "|" + mid;
                const c = {
                  src: "own-bus", confidence: conf, estimated: true,
                  routeUID: r.u, name: r.n, sub: r.sn || (sorEntry && sorEntry.SubRouteUID) || "", dir: r.d,
                  from: { uid: S[i][0], name: S[i][1], time: isoTpe(depMs), seq: i, pos: stops[S[i][0]] },
                  to: { uid: S[j][0], name: S[j][1], time: isoTpe(arrMs), seq: j, pos: stops[S[j][0]] },
                  walkO: wO,
                  walkD: wD,
                  start, end, startIso: isoTpe(start), endIso: isoTpe(end),
                  ride: Math.round(tRide.seconds / 60),
                  rideSrc: { offset: offsetSrc, ride: tRide.source },
                  offsetMin: Number((offsetSec / 60).toFixed(1)),
                  serviceDate: ymd(mid)
                };
                const o2 = best.get(key);
                if (!o2 || (when === "dep" ? c.end < o2.end || (c.end === o2.end && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m) : c.start > o2.start || (c.start === o2.start && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m))) {
                  best.set(key, c);
                }
              } else {
                st.missingTime++;
              }
            }
          }
        }
      }

      // --- 模式 2：只有班距 (f) ---
      if (!(r.tr && r.tr.length) && (r.f && r.f.length)) {
        st.freqOnly++;
        if (freqPolicy !== "halfHeadway") continue;

        for (const [fIdx, f] of r.f.entries()) {
          const [mask, startMin, endMin, minH, maxH] = f;
          const minHeadway = (typeof minH === "number" && minH > 0) ? minH : null;
          const maxHeadway = (typeof maxH === "number" && maxH > 0) ? maxH : null;

          if (!minHeadway && !maxHeadway) {
            st.freqNoHeadway++;
            continue;
          }

          const avgHeadway = (minHeadway && maxHeadway)
            ? (minHeadway + maxHeadway) / 2
            : (minHeadway || maxHeadway);
          const halfHeadwayMin = avgHeadway / 2;
          const halfHeadwayMs = halfHeadwayMin * 60000;

          for (const mid of days) {
            if (!serviceBit(mask, wday(mid), hol.has(ymd(mid)))) continue;

            for (const i of iO) for (const j of iD) {
              if (j <= i) continue;
              const wO = walkInfoO(S[i][0]), wD = walkInfoD(S[j][0]);
              const wo = wO.min, wd = wD.min;

              // 起點服務時段
              const originStartMs = mid + startMin * 60000;
              const originEndMs = mid + endMin * 60000;

              // 起點到上車站位移（以起點服務時段推估）
              let offsetStartSec = 0, offsetEndSec = 0, offsetSrc = "s2s";
              if (i > 0) {
                const tOffStart = getTravelTime(S[0][0], S[i][0], originStartMs);
                const tOffEnd = getTravelTime(S[0][0], S[i][0], originEndMs);
                if (!tOffStart && !tOffEnd) { st.noS2s++; continue; }
                offsetStartSec = tOffStart ? tOffStart.seconds : (tOffEnd ? tOffEnd.seconds : 0);
                offsetEndSec = tOffEnd ? tOffEnd.seconds : (tOffStart ? tOffStart.seconds : 0);
                offsetSrc = (tOffStart && tOffStart.source) || (tOffEnd && tOffEnd.source) || "distance";
              }

              // 上車站服務時段
              const stopStartMs = originStartMs + offsetStartSec * 1000;
              const stopEndMs = originEndMs + offsetEndSec * 1000;

              let boardMs = 0, arrMs = 0, startMs = 0, endMs = 0, tRide = null;

              if (when === "dep") {
                const arrStopMs = t + wo * 60000;
                boardMs = arrStopMs + halfHeadwayMs;

                // 上車時刻要在上車站服務時段內（服務時段邊界：剛好在起始分、結束分、超出）
                if (boardMs < stopStartMs || boardMs > stopEndMs) continue;

                tRide = getTravelTime(S[i][0], S[j][0], boardMs);
                if (!tRide) { st.noS2s++; continue; }

                arrMs = boardMs + tRide.seconds * 1000;
                startMs = t;
                endMs = arrMs + wd * 60000;
              } else {
                // 指定抵達：從抵達時刻減步行得到最晚下車，減行車得到上車，再減半個班距得到最晚到站
                const latestAlightMs = t - wd * 60000;
                // 先用估計值算一次
                const tRideEst = getTravelTime(S[i][0], S[j][0], latestAlightMs - 30 * 60000);
                const estSec = tRideEst ? tRideEst.seconds : 1800;
                const boardMsEst = latestAlightMs - estSec * 1000;

                // 再用算出的上車時刻重算一次
                tRide = getTravelTime(S[i][0], S[j][0], boardMsEst);
                if (!tRide) { st.noS2s++; continue; }

                boardMs = latestAlightMs - tRide.seconds * 1000;
                if (boardMs < stopStartMs || boardMs > stopEndMs) continue;

                const arrStopMs = boardMs - halfHeadwayMs;
                startMs = arrStopMs - wo * 60000;
                arrMs = boardMs + tRide.seconds * 1000;
                endMs = arrMs + wd * 60000;
                if (early != null && t - endMs > early * 60000) continue;
              }

              const conf = tRide.source;
              const key = r.u + "|" + r.s + "|" + r.d + "|f" + fIdx + "|" + mid;
              const tOffBoard = i > 0 ? getTravelTime(S[0][0], S[i][0], boardMs) : null;
              const curOffsetSec = tOffBoard ? tOffBoard.seconds : offsetStartSec;
              const c = {
                src: "own-bus", confidence: conf, estimated: true,
                routeUID: r.u, name: r.n, sub: r.sn || (sorEntry && sorEntry.SubRouteUID) || "", dir: r.d,
                from: { uid: S[i][0], name: S[i][1], time: isoTpe(boardMs), seq: i, pos: stops[S[i][0]] },
                to: { uid: S[j][0], name: S[j][1], time: isoTpe(arrMs), seq: j, pos: stops[S[j][0]] },
                walkO: wO,
                walkD: wD,
                start: startMs, end: endMs, startIso: isoTpe(startMs), endIso: isoTpe(endMs),
                ride: Math.round(tRide.seconds / 60),
                rideSeconds: tRide.seconds,
                wait: Math.round(halfHeadwayMin * 10) / 10,
                headway: {
                  min: minHeadway,
                  max: maxHeadway,
                  avg: avgHeadway,
                  half: halfHeadwayMin,
                  n: Math.round(avgHeadway)
                },
                f: [mask, startMin, endMin, minHeadway, maxHeadway],
                rideSrc: { offset: offsetSrc, ride: tRide.source },
                offsetMin: Number((curOffsetSec / 60).toFixed(1)),
                serviceDate: ymd(mid)
              };

              const o2 = best.get(key);
              if (!o2 || (when === "dep" ? c.end < o2.end || (c.end === o2.end && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m) : c.start > o2.start || (c.start === o2.start && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m))) {
                best.set(key, c);
              }
            }
          }
        }
      }
    }

    const tierOf = r => r.confidence === "live" ? 3 : (r.confidence === "timetable" && !r.estimated ? 2 : 1);
    const cmpTime = when === "dep"
      ? (a, b) => a.end - b.end || a.start - b.start
      : (a, b) => b.start - a.start || a.end - b.end;
    // 同一路線同方向只留最好的一班：即時 > 表定 > 估算，同級比時間
    const perRoute = new Map();
    for (const r of best.values()) {
      const k = r.routeUID + "|" + r.sub + "|" + r.dir;
      const cur = perRoute.get(k);
      if (!cur) { perRoute.set(k, r); continue; }
      const dt = tierOf(r) - tierOf(cur);
      if (dt > 0 || (dt === 0 && cmpTime(r, cur) < 0)) perRoute.set(k, r);
    }
    const routes = [...perRoute.values()].sort(cmpTime).slice(0, max);

    if (st.freqOnly && freqPolicy === "exclude") notes.push(st.freqOnly + " 條只有班距的路線未列（列法尚未定案）");
    if (st.freqNoHeadway) notes.push(st.freqNoHeadway + " 筆班距缺少班距數值，未列");
    if (st.special) notes.push(st.special + " 班有特殊日規則的班次未列（規則尚未支援）");
    if (st.missingTime) notes.push("有 " + st.missingTime + " 個上下車站組合缺表定時刻，未列");
    if (st.noS2s) notes.push("有 " + st.noS2s + " 次估算缺少站間資料，改用班表或直線距離推估");
    if (st.liveMissed) notes.push(st.liveMissed + " 筆即時到站的公車在步行到站前就會到，改列下一班的表定或推估");   // Opus
    if (st.noStops) notes.push(st.noStops + " 條無站序（查無站序資訊，未列）");

    return { status: routes.length ? "ok" : "no-route", reason: routes.length ? null : "已收錄的時刻表內沒有符合條件的直達班次", routes, stats: st, notes };
  }

  // 整版一致性（試行）
  function assemble(meta, shards, o) {
    o = o || {};
    if (!meta || !(meta.n >= 1) || !Array.isArray(shards) || shards.length !== meta.n) throw new Error("時刻表分片數不對");
    if (o.hdrT && (o.hdrT.length !== meta.n || o.hdrT.some(x => String(x) !== String(meta.t)))) throw new Error("時刻表在下載途中更新了，請重試");
    const t0 = shards[0] && shards[0].t, recs = [];
    shards.forEach((s, k) => {
      if (!s || s.t !== t0 || t0 == null) throw new Error("時刻表分片版本不一致");
      if (s.k != null && s.k !== k) throw new Error("時刻表分片順序不對");
      if (o.city && s.c != null && s.c !== o.city) throw new Error("時刻表分片城市不對");
      if (!Array.isArray(s.r)) throw new Error("時刻表分片格式不對");
      recs.push(...s.r);
    });
    return recs;
  }

  // 起點附近公車可到的軌道站，以及軌道下車後可接公車的站。步行上限用呼叫端的 walkRadiusM。不打網路。
  function transferHubs(input) {
    const { records, sor, stops, o, d, stations, opts } = input || {};
    const P = opts || {};
    const R = P.walkRadiusM;
    if (!(R > 0) || !o || !d || !Array.isArray(stations)) return { access: [], egress: [], accessCount: 0, egressCount: 0 };
    const cell = 0.008, keyOf = (lat, lon) => Math.floor(lat / cell) + "," + Math.floor(lon / cell);
    const grid = new Map();
    for (const s of stations) {
      if (!s || s.lat == null || s.lon == null) continue;
      const id = (s.op || "") + ":" + (s.id != null ? s.id : s.name);
      const st = { id, name: s.name || id, lat: +s.lat, lon: +s.lon, op: s.op || "" };
      const c = keyOf(st.lat, st.lon);
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(st);
    }
    const nearSt = (lat, lon) => {
      const a = Math.floor(lat / cell), b = Math.floor(lon / cell), out = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const s of grid.get((a + i) + "," + (b + j)) || []) {
          const m = hav(lat, lon, s.lat, s.lon);
          if (m <= R) out.push([s, m]);
        }
      }
      return out;
    };
    const point = (x) => {
      if (Array.isArray(x)) {
        const uid = x[0], p = x[2], c = stops && stops[uid];
        const lat = p && p[0] ? +p[0] : c && +c[0];
        const lon = p && p[1] ? +p[1] : c && +c[1];
        if (!lat || !lon) return null;
        return { uid, name: x[1] || (c && c[2]) || "", lat, lon };
      }
      if (x && x.StopUID) {
        const p = x.P, c = stops && stops[x.StopUID];
        const lat = p && p[0] ? +p[0] : c && +c[0];
        const lon = p && p[1] ? +p[1] : c && +c[1];
        if (!lat || !lon) return null;
        const nm = x.StopName && (x.StopName.Zh_tw || x.StopName) || (c && c[2]) || "";
        return { uid: x.StopUID, name: typeof nm === "string" ? nm : "", lat, lon };
      }
      return null;
    };
    const seqOf = (r) => {
      if (r && Array.isArray(r.st) && r.st.length >= 2) {
        const s = r.st.map(point).filter(Boolean);
        if (s.length >= 2) return s;
      }
      const list = sor && r && sor[r.u];
      if (!list) return null;
      const match = list.find(x => Number(x.Direction) === Number(r.d) && (!r.s || String(x.SubRouteUID || "") === String(r.s)));
      if (!match || !match.Stops) return null;
      const s = match.Stops.map(point).filter(Boolean);
      return s.length >= 2 ? s : null;
    };
    const rideMin = (seq, i, j) => {
      let m = 0;
      const a = Math.min(i, j), b = Math.max(i, j);
      for (let k = a + 1; k <= b; k++) m += hav(seq[k - 1].lat, seq[k - 1].lon, seq[k].lat, seq[k].lon);
      return Math.ceil(m / 250 + 0.3 * (b - a));
    };
    const access = new Map(), egress = new Map();
    let accessSeen = 0, egressSeen = 0;
    for (const r of records || []) {
      const seq = seqOf(r);
      if (!seq) continue;
      let board = -1, boardM = Infinity;
      for (let i = 0; i < seq.length; i++) {
        const m = hav(o.lat, o.lon, seq[i].lat, seq[i].lon);
        if (m <= R && m < boardM) { board = i; boardM = m; }
      }
      if (board >= 0) {
        for (let j = board + 1; j < seq.length; j++) {
          for (const [st, walkSt] of nearSt(seq[j].lat, seq[j].lon)) {
            accessSeen++;
            const ride = rideMin(seq, board, j);
            const score = Math.ceil(boardM * (P.walkFactor || 1.3) / (P.walkMpm || 70)) + ride + Math.ceil(walkSt * (P.walkFactor || 1.3) / (P.walkMpm || 70));
            const prev = access.get(st.id);
            if (!prev || score < prev.score) access.set(st.id, { station: st, score, ride, walkO: Math.round(boardM), walkSt: Math.round(walkSt), route: r.n || "", uid: r.u || "", board: seq[board].name, alight: seq[j].name });
          }
        }
      }
      let alight = -1, alightM = Infinity;
      for (let i = 0; i < seq.length; i++) {
        const m = hav(d.lat, d.lon, seq[i].lat, seq[i].lon);
        if (m <= R && m < alightM) { alight = i; alightM = m; }
      }
      if (alight > 0) {
        for (let j = 0; j < alight; j++) {
          for (const [st, walkSt] of nearSt(seq[j].lat, seq[j].lon)) {
            egressSeen++;
            const ride = rideMin(seq, j, alight);
            const score = Math.ceil(walkSt * (P.walkFactor || 1.3) / (P.walkMpm || 70)) + ride + Math.ceil(alightM * (P.walkFactor || 1.3) / (P.walkMpm || 70));
            const prev = egress.get(st.id);
            if (!prev || score < prev.score) egress.set(st.id, { station: st, score, ride, walkO: Math.round(walkSt), walkD: Math.round(alightM), route: r.n || "", uid: r.u || "", board: seq[j].name, alight: seq[alight].name });
          }
        }
      }
    }
    const top = (m) => [...m.values()].sort((a, b) => a.score - b.score).slice(0, 8);
    return { access: top(access), egress: top(egress), accessCount: access.size, egressCount: egress.size, accessSeen, egressSeen };
  }

  // 指定抵達的時間窗。scan(t0) 回傳從 t0 起最早開得成的走法，每條要有 dep、arr（毫秒）。
  // 舊視窗從指定時間往前 4 小時起算，每次只推進到最早那班的下一分鐘，最多約 30 次。
  // 約 4 到 6 分一班時，30 次只蓋到約 2 小時，指定 18:00 會停在 16:30 前後，17 點多的班進不了清單。
  // 這裡從指定時間往前 lookback（預設 6 小時）開始。離指定時間還遠就大步靠近，最後 40 分鐘再一班一班往後收。
  // 00:30 的起點在前一天 18:30，前一天 23 點多的班次在窗內。
  function searchArrive(opt) {
    const arrBy = opt && opt.arrBy;
    const scan = opt && opt.scan;
    if (!(arrBy > 0) || typeof scan !== "function") return { list: [], from: null, scans: 0 };
    const look = opt.lookbackMs > 0 ? opt.lookbackMs : 6 * 3600000;
    const cap = opt.maxScan > 0 ? opt.maxScan : 48;
    const from = arrBy - look;
    const kept = [];
    const seen = new Set();
    let t0 = from;
    let scans = 0;
    while (scans < cap && t0 < arrBy) {
      scans++;
      let res = [];
      try { res = scan(t0) || []; } catch (e) { break; }
      const good = [];
      for (const J of res) {
        if (!J || !(J.dep >= t0 - 1000) || !(J.arr <= arrBy)) continue;
        good.push(J);
        const k = J.key != null ? String(J.key) : (J.dep + ":" + J.arr);
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(J);
      }
      if (!good.length) break;
      const deps = good.map(J => J.dep);
      const latestDep = Math.max.apply(null, deps);
      const earliestArr = Math.min.apply(null, good.map(J => J.arr));
      const slack = arrBy - earliestArr;
      let next;
      if (slack > 40 * 60000) {
        const ride = Math.max(10 * 60000, earliestArr - Math.min.apply(null, deps));
        const target = arrBy - ride - 5 * 60000;
        const half = t0 + Math.floor(slack / 2);
        next = Math.max(latestDep + 60000, Math.min(target, half));
      } else next = latestDep + 60000;
      if (!(next > t0)) next = t0 + 60000;
      t0 = next;
    }
    kept.sort((a, b) => b.dep - a.dep || a.arr - b.arr);
    return { list: kept, from, scans };
  }

  // 多個轉乘站都算過之後，用抵達時間選最快。轉乘超過 3 次或任一段步行超過 800 公尺的不列。
  function chooseTransfer(list) {
    const ok = (list || []).filter(x => x && (x.transfers == null || x.transfers <= 3) && (x.walkMax == null || x.walkMax <= 800) && Number.isFinite(x.end));
    ok.sort((a, b) => a.end - b.end || (a.transfers || 0) - (b.transfers || 0) || String(a.id || "").localeCompare(String(b.id || "")));
    return ok;
  }


  // v2.51.4：步行查詢工具（前端與測試共用）。
  // walkQueue：所有 /walk 依序送，上一個不是快取時間隔 gap 毫秒；收到 429 busy 或 502 就隔 gap 再試一次，仍失敗才丟錯。
  function walkQueue(get, opt) {
    const o = opt || {};
    const gap = o.gap || 1100;
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const now = o.now || (() => Date.now());
    const stat = { calls: 0, out: 0, retries: 0, fails: 0 };
    let chain = Promise.resolve(), lastAt = -Infinity;
    const retryable = e => !!e && (e.status === 502 || (e.status === 429 && e.code === "busy"));
    const one = async (path, ms) => {
      const w = lastAt + gap - now();
      if (w > 0) await sleep(w);
      stat.calls++;
      try {
        const j = await get(path, ms);
        if (j && j.cached) lastAt = -Infinity; else { lastAt = now(); stat.out++; }
        return j;
      } catch (e) { lastAt = now(); throw e; }
    };
    const run = async (path, ms) => {
      try { return await one(path, ms); }
      catch (e) {
        if (!retryable(e)) { stat.fails++; throw e; }
        stat.retries++;
        lastAt = Math.max(lastAt, now());
        try { return await one(path, ms); } catch (e2) { stat.fails++; throw e2; }
      }
    };
    const call = (path, ms) => { const p = chain.then(() => run(path, ms)); chain = p.catch(() => {}); return p; };
    call.stat = stat;
    return call;
  }

  // walkBatches：起點附近的點（oPts）、終點附近的點（dPts）、以及起點到終點（只步行）合成 table 查詢。
  // 每批 pts＝[起點, 終點, ...最多 23 點]，sources＝[0, 1]，destinations＝其餘各點（第一批另加 1＝終點，給只步行用）。一共不超過 25 點時只有 1 批。
  function walkBatches(o, d, oPts, dPts, wantOD, maxPts) {
    const cap = (maxPts || 25) - 2, seen = new Map(), list = [];
    const key = q => (+q[0]).toFixed(4) + "," + (+q[1]).toFixed(4);
    for (const [side, arr] of [["o", oPts || []], ["d", dPts || []]]) {
      for (const q of arr) {
        if (!q || q[0] == null || q[1] == null) continue;
        const k = key(q);
        let it = seen.get(k);
        if (!it) { it = { k, q: [+q[0], +q[1]], o: false, d: false }; seen.set(k, it); list.push(it); }
        it[side] = true;
      }
    }
    const out = [];
    if (!list.length && !wantOD) return out;
    for (let s = 0; s < Math.max(1, list.length); s += cap) {
      const part = list.slice(s, s + cap);
      const pts = [[+o.lat, +o.lon], [+d.lat, +d.lon], ...part.map(x => x.q)];
      const dst = part.map((_, i) => i + 2);
      const od = s === 0 && wantOD;
      if (od) dst.push(1);
      if (!dst.length) continue;
      out.push({ pts, src: [0, 1], dst, part, od });
    }
    return out;
  }
  // 把一批的回應拆成 Wo（起點→點）、Wd（終點→點）、od（起點→終點），單位：公尺、秒。
  function walkParse(batch, res, acc) {
    const A = acc || { o: new Map(), d: new Map(), od: null };
    if (!res || !res.ok || !Array.isArray(res.distances)) return A;
    const num = v => typeof v === "number" && isFinite(v);
    const D = res.distances, T = res.durations || [];
    batch.part.forEach((it, c) => {
      if (it.o && D[0] && num(D[0][c])) A.o.set(it.k, { m: Math.round(D[0][c]), s: num(T[0] && T[0][c]) ? T[0][c] : null });
      if (it.d && D[1] && num(D[1][c])) A.d.set(it.k, { m: Math.round(D[1][c]), s: num(T[1] && T[1][c]) ? T[1][c] : null });
    });
    if (batch.od) {
      const c = batch.part.length;
      if (D[0] && num(D[0][c]) && T[0] && num(T[0][c])) A.od = { m: Math.round(D[0][c]), s: T[0][c] };
    }
    return A;
  }

  // 規劃要跑哪些部分。walkOnly：只選「步行」時只查一次步行，不跑軌道、公車、YouBike，不讀班表與雲端站序。
  function planBranches(modes, yb, walk) {
    const m = modes || [];
    if (walk && !m.length && !yb) return { walkOnly: true, rail: false, bus: false, stitch: false, bike: false, walk: true };
    const rail = m.some(x => x !== 5), bus = m.includes(5);
    return { walkOnly: false, rail, bus, stitch: rail && bus, bike: !!yb, walk: true, none: !m.length };
  }

  // 詳情要查路線形狀的段：步行與 YouBike 騎車段依序，最多 3 段；太短（< 30 公尺直線）不查。
  function shapeLegs(route, max) {
    const out = [];
    for (const l of (route && route.legs) || []) {
      if (l.kind !== "walk" && l.kind !== "bike") continue;
      if (!l.from || !l.to || l.from.lat == null || l.to.lat == null) continue;
      const dy = (l.from.lat - l.to.lat) * 111000, dx = (l.from.lon - l.to.lon) * 101000;
      if (Math.sqrt(dx * dx + dy * dy) < 30) continue;
      out.push(l);
      if (out.length >= (max || 3)) break;
    }
    return out;
  }

  // Opus（v2.51.5 審查）：多個起點各自要查一組點時，整組整組塞進同一批 table（每批最多 maxPts 點），
  // 不再一個轉乘站打一次。groups：[{ src:[lat,lon], dsts:[[lat,lon],…] }]；同一組不拆開（太大的組才自己分段）。
  function walkGroupBatches(groups, maxPts) {
    const cap = maxPts || 25, out = [];
    let cur = null;
    const flush = () => { if (cur && cur.items.length) out.push(cur); cur = null; };
    const pieces = [];
    for (const g of groups || []) {
      if (!g || !g.src || !Array.isArray(g.dsts) || !g.dsts.length) continue;
      for (let s = 0; s < g.dsts.length; s += cap - 1) pieces.push({ src: [+g.src[0], +g.src[1]], dsts: g.dsts.slice(s, s + cap - 1).map(q => [+q[0], +q[1]]) });
    }
    for (const pc of pieces) {
      const n = 1 + pc.dsts.length;
      if (!cur || cur.n + n > cap) { flush(); cur = { n: 0, items: [] }; }
      cur.items.push(pc); cur.n += n;
    }
    flush();
    return out.map(b => {
      const pts = [], src = [], dst = [], pairs = [];
      for (const it of b.items) {
        const si = pts.length; pts.push(it.src); src.push(si);
        for (const q of it.dsts) { const di = pts.length; pts.push(q); dst.push(di); pairs.push({ src: it.src, q, si, di }); }
      }
      return { pts, src, dst, pairs };
    });
  }
  // 拆回每一對（起點→點）的公尺、秒。distances[i][j]：第 i 個 src、第 j 個 dst。
  function walkGroupParse(batch, res) {
    const out = [];
    if (!batch || !res || !res.ok || !Array.isArray(res.distances)) return out;
    const num = v => typeof v === "number" && isFinite(v);
    const D = res.distances, T = res.durations || [];
    for (const p of batch.pairs) {
      const i = batch.src.indexOf(p.si), j = batch.dst.indexOf(p.di);
      const m = D[i] && D[i][j], s = T[i] && T[i][j];
      if (num(m)) out.push({ src: p.src, q: p.q, m: Math.round(m), s: num(s) ? s : null });
    }
    return out;
  }

  // ===== v2.51.6：公車即時校正、同一段多路線合併 =====
  const hav2 = (a, b) => (a && b && a.lat != null && b.lat != null) ? hav(+a.lat, +a.lon, +b.lat, +b.lon) : Infinity;
  const nm2 = s => String(s || "").replace(/臺/g, "台").replace(/\s/g, "").replace(/[（(].*?[)）]/g, "");
  // 同一段公車：上車站同名或 200 公尺內、下車站同名或 300 公尺內（步行範圍）
  function sameBusSeg(a, b) {
    const okEnd = (p, q, m) => (nm2(p.name) && nm2(p.name) === nm2(q.name)) || hav2(p, q) <= m;
    return okEnd(a.from || {}, b.from || {}, 200) && okEnd(a.to || {}, b.to || {}, 300);
  }
  const trSig = l => l.mode + "|" + nm2(l.name) + "|" + String(l.from && l.from.time || "").slice(0, 16) + "|" + nm2(l.to && l.to.name);
  // 兩條方案能不能合併：搭車段數一樣；公車段是同一段但路線名不同；其他車段完全一樣（同一班）
  function mergeable(A, B) {
    const ta = (A.legs || []).filter(l => l.kind === "transit"), tb = (B.legs || []).filter(l => l.kind === "transit");
    if (!ta.length || ta.length !== tb.length) return false;
    if ((A.legs || []).some(l => l.kind === "bike") || (B.legs || []).some(l => l.kind === "bike")) return false;
    let busDiff = false;
    for (let k = 0; k < ta.length; k++) {
      const x = ta[k], y = tb[k];
      if (x.mode !== y.mode) return false;
      if (x.mode === "bus") {
        if (!sameBusSeg(x, y)) return false;
        if (nm2(x.name) !== nm2(y.name)) busDiff = true;
        else if (String(x.from.time).slice(0, 16) !== String(y.from.time).slice(0, 16)) return false;   // 同一條路線不同班次：不合併
      } else if (trSig(x) !== trSig(y)) return false;
    }
    return busDiff;
  }
  const altOf = l => ({ name: l.name || "", routeUID: l.routeUID || "", city: l.city || "", dir: l.dir, stopUID: l.stopUID || "", toStopUID: l.toStopUID || "",
    from: { ...l.from }, to: { ...l.to }, dur: l.dur, timeSrc: l.timeSrc || "", ...(l.est ? { est: true } : {}) });
  // 同一段（同一組上下車站附近）有多條路線能到：合併成一條方案。代表那條取最早抵達（同時抵達取晚出發），這一段列出全部路線（alts，依上車時間）
  function mergeBusAlts(list) {
    const src = (list || []).slice(), out = [], used = new Set();
    const better = (a, b) => (a.end - b.end) || (b.start - a.start);
    for (let i = 0; i < src.length; i++) {
      if (used.has(i)) continue;
      const grp = [src[i]];
      for (let j = i + 1; j < src.length; j++) if (!used.has(j) && grp.every(g => mergeable(g, src[j]))) { grp.push(src[j]); used.add(j); }
      if (grp.length === 1) { out.push(src[i]); continue; }
      const best = grp.slice().sort(better)[0];
      const R = { ...best, legs: best.legs.map(l => ({ ...l })) };
      const bi = R.legs.map((l, k) => l.kind === "transit" && l.mode === "bus" ? k : -1).filter(k => k >= 0);
      for (const k of bi) {
        const nth = R.legs.slice(0, k).filter(l => l.kind === "transit").length;
        const alts = [];
        for (const g of grp) {
          const gl = g.legs.filter(l => l.kind === "transit")[nth];
          if (gl && !alts.some(a => nm2(a.name) === nm2(gl.name))) alts.push(altOf(gl));
        }
        alts.sort((a, b) => parseTpe(a.from.time) - parseTpe(b.from.time));
        if (alts.length > 1) R.legs[k].alts = alts;
      }
      R.merged = grp.length;
      out.push(R);
    }
    return out;
  }
  // 公車段的即時校正。live：{ 段落序號: { sec, more:[秒…], alts:[{ routeUID, name, sec, more }] } }（秒＝距現在幾秒到站）
  // 上車時間＝現在＋即時；下車＝上車＋原本的車上時間。趕不上（車比人早到站）改搭下一班即時，沒有就用表定，再沒有就保留原表定並標示。
  // 後面的車接不上原班次時回傳 recatch（交給呼叫端用已載入的時刻表改接下一班）。
  function liveFixRoute(route, live, nowMs, opt) {
    if (!route || !Array.isArray(route.legs)) return { route, changed: false };
    const R = JSON.parse(JSON.stringify(route));
    const legs = R.legs, slack = ((opt && opt.slackSec) || 30) * 1000;
    const num = v => typeof v === "number" && isFinite(v);
    let ready = nowMs, changed = false, recatch = null, seenTransit = false;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind === "walk" || l.kind === "bike") { ready += Math.round((l.dur || 0) * 1000); continue; }
      if (l.kind !== "transit") continue;
      // 再校正時（詳情打開後又查一次）以原本的表定為準，不把上次校正的時間當表定
      const c0 = parseTpe(l.from && l.from.time), ca = parseTpe(l.to && l.to.time);
      const s0 = l.sched ? parseTpe(l.sched.from) : c0, a0 = l.sched ? parseTpe(l.sched.to) : ca;
      if (s0 == null || a0 == null || c0 == null || ca == null) { ready = ca != null ? ca : ready; continue; }
      let dep = c0, ride = ca - c0, pick = null;
      const lv = live && live[i];
      if (l.mode === "bus" && lv) {
        const C = [];
        const altList = Array.isArray(l.alts) && l.alts.length ? l.alts : [altOf(l)];
        for (const a of altList) {
          const ra = parseTpe(a.to && a.to.time) - parseTpe(a.from && a.from.time);
          const rideA = num(ra) && ra > 0 ? ra : ride;
          const info = (nm2(a.name) === nm2(l.name) || a.routeUID === l.routeUID) && !(lv.alts || []).some(x => x.routeUID === a.routeUID && a.routeUID !== l.routeUID) ? lv : (lv.alts || []).find(x => (x.routeUID && x.routeUID === a.routeUID) || nm2(x.name) === nm2(a.name));
          const secs = info ? [info.sec, ...(info.more || [])].filter(num).sort((x, y) => x - y) : [];
          for (const sec of secs) C.push({ a, src: "live", dep: nowMs + sec * 1000, ride: rideA, sec });
          const sa = nm2(a.name) === nm2(l.name) && l.sched ? s0 : parseTpe(a.from && a.from.time);
          if (num(sa)) C.push({ a, src: "schedule", dep: sa, ride: rideA });
        }
        const ok = c => c.dep >= ready - slack;
        const liveC = C.filter(c => c.src === "live").sort((x, y) => x.dep - y.dep);
        const schC = C.filter(c => c.src === "schedule").sort((x, y) => x.dep - y.dep);
        const missedLive = liveC.length > 0 && !ok(liveC[0]);
        pick = liveC.find(ok) || schC.find(ok) || null;
        if (!l.sched) l.sched = { from: l.from.time, to: l.to.time };
        if (pick) {
          dep = pick.dep; ride = pick.ride;
          if (pick.a && nm2(pick.a.name) !== nm2(l.name)) {   // 最近那班是別條路線：這一段改用那條的名稱與代碼
            const a = pick.a;
            l.name = a.name; if (a.routeUID) l.routeUID = a.routeUID; if (a.city) l.city = a.city; if (a.dir != null) l.dir = a.dir;
            if (a.stopUID) l.stopUID = a.stopUID; if (a.toStopUID) l.toStopUID = a.toStopUID;
          }
          if (Array.isArray(l.alts)) {   // 列出各路線的下一班（有即時用即時），最近那班排第一
            for (const a of l.alts) {
              const best = liveC.filter(c => c.a === a && ok(c))[0] || schC.filter(c => c.a === a && ok(c))[0];
              a.next = best ? { time: isoTpe(best.dep), src: best.src, ...(best.sec != null ? { sec: best.sec } : {}) } : null;
            }
            l.alts.sort((x, y) => (x.next ? parseTpe(x.next.time) : Infinity) - (y.next ? parseTpe(y.next.time) : Infinity));
          }
          l.liveFix = { src: pick.src, tag: pick.src === "live" ? (missedLive ? "趕不上前一班・改搭下一班（即時）" : "即時校正") : (missedLive ? "趕不上即時那班・改用下一班表定" : "沒有即時・用表定"), missed: missedLive, at: nowMs };
          if (pick.src === "live") l.timeSrc = "livefix";
        } else {
          dep = s0; ride = a0 - s0;   // 保留原表定
          l.liveFix = { src: "none", tag: "趕不上・沒有下一班資料，保留原表定", missed: true, at: nowMs };
        }
      } else if (seenTransit || l.mode !== "bus") {
        // 沒有即時的車：只檢查接不接得上
        if (c0 < ready - slack) { recatch = { at: i, readyMs: ready }; break; }
      }
      seenTransit = true;
      if (dep !== c0 || ride !== ca - c0) {
        const k = (ca - c0) > 0 ? ride / (ca - c0) : 1;
        l.from.time = isoTpe(dep); l.to.time = isoTpe(dep + ride);
        l.dur = Math.round(ride / 1000);
        if (Array.isArray(l.stops)) for (const st of l.stops) { const t = parseTpe(st.time); if (t != null) st.time = isoTpe(dep + Math.round((t - c0) * k)); }
        changed = true;
      }
      ready = dep + ride;
    }
    if (changed) syncRouteTimes(R);
    if (changed || recatch) R.liveFixed = true;
    return { route: R, changed, recatch };
  }

  const api = { plan, assemble, parseTpe, isoTpe, hmTpe, serviceBit, walkChunks, citiesFor, sectionsFromBus, walkOnlyRoute, bikeRoute, joinRoutes, syncRouteTimes, applyWalkShape, sortOwn, liveFixRoute, mergeBusAlts, sameBusSeg, searchArrive, transferHubs, chooseTransfer, walkQueue, walkBatches, walkParse, walkGroupBatches, walkGroupParse, planBranches, shapeLegs };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BusDirect = api;
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) {
    root.onmessage = e => {
      let out;
      try { out = plan(e.data); }
      catch (x) { out = { status: "error", message: String(x && x.message || x), routes: [] }; }
      root.postMessage({ id: e.data && e.data.id, out });
    };
  }
})(typeof self !== "undefined" ? self : this);
