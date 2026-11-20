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
    const bikes = list.filter(r => hasBike(r) && !hasT(r));
    const isLongBike = r => hasBike(r) && !hasT(r) && ((r.dur || 0) > 90 || ((r.end - r.start) > 90 * 60000));
    const walks = list.filter(r => !hasT(r) && !hasBike(r));
    const rides = list.filter(r => hasT(r));
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
    out.sort((a, b) => {
      if (rides.length) {
        const la = isLongBike(a), lb = isLongBike(b);
        if (la !== lb) return la ? 1 : -1;
      }
      return cmp(a, b);
    });
    if (walkFirst && out[0] !== w) { out.splice(out.indexOf(w), 1); out.unshift(w); }
    const capped = out.slice(0, 8);
    if (bikes.length && !capped.some(hasBike) && !isLongBike(bikes[0])) capped[capped.length - 1] = bikes[0];
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


  // v2.60.5：步行查詢工具（前端與測試共用）。
  // walkQueue：每筆開始時間相隔至少 gap 毫秒（不等上一筆回來）；Worker 回 cached 不佔間隔；在途最多 maxInFlight 筆；429 busy 或 502 隔 gap 重試一次。
  function walkQueue(get, opt) {
    // v2.60.5（Opus 審查修正）：每一筆「沒有被 Worker 快取」的請求，開始時間相隔至少 gap 毫秒，不必等上一筆回來；同時在途最多 maxInFlight 筆。
    // 回 cached 的那筆事後從間隔計算拿掉（不佔間隔），但不會清掉其他還在路上那筆的間隔。
    // 429 busy 或 502：從失敗那一刻再隔 gap 重試一次（和 v2.51.4 起相同），仍失敗才丟錯。不會多送任何一筆。
    const o = opt || {};
    const gap = o.gap || 1100, maxInFlight = o.maxInFlight || 3;
    const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const now = o.now || (() => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()));   // 量間隔用單調時鐘（系統時間被調整也不影響）
    const stat = { calls: 0, out: 0, retries: 0, fails: 0, maxInFlight: 0 };
    const retryable = e => !!e && (e.status === 502 || (e.status === 429 && e.code === "busy"));
    const starts = [];   // { t, cached, done }
    let inFlight = 0, wake = null, gate = Promise.resolve();
    const waiters = [];
    const anchor = () => { let m = -Infinity; for (const x of starts) if (!x.cached && x.t > m) m = x.t; return m; };
    const prune = () => { const lim = now() - gap; for (let i = starts.length - 1; i >= 0; i--) if (starts[i].cached || (starts[i].done && starts[i].t < lim)) starts.splice(i, 1); };
    const acquire = async () => { while (inFlight >= maxInFlight) await new Promise(r => waiters.push(r)); inFlight++; if (inFlight > stat.maxInFlight) stat.maxInFlight = inFlight; };
    const release = () => { inFlight--; const w = waiters.shift(); if (w) w(); };
    // 依送出順序一筆一筆決定開始時間（先來先送）
    const begin = () => {
      const p = gate.then(async () => {
        for (;;) {
          const w = anchor() + gap - now();
          if (w <= 0) break;
          await new Promise(r => { let d = false; const f = () => { if (!d) { d = true; if (wake === f) wake = null; r(); } }; wake = f; sleep(w).then(f); });
        }
        const x = { t: now(), cached: false, done: false };
        starts.push(x);
        return x;
      });
      gate = p.catch(() => {});
      return p;
    };
    const one = async (path, ms) => {
      await acquire();
      const x = await begin();
      stat.calls++;
      try {
        const j = await get(path, ms);
        x.done = true;
        if (j && j.cached) { x.cached = true; if (wake) wake(); } else stat.out++;
        return j;
      } catch (e) {
        x.done = true;
        if (retryable(e)) x.t = Math.max(x.t, now());   // 重試要從失敗那一刻再隔 gap
        throw e;
      } finally { release(); prune(); }
    };
    const call = async (path, ms) => {
      try { return await one(path, ms); }
      catch (e) {
        if (!retryable(e)) { stat.fails++; throw e; }
        stat.retries++;
        try { return await one(path, ms); } catch (e2) { stat.fails++; throw e2; }
      }
    };
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

  // ===== v2.51.7：同一班車、同樣上下車時間、只差步行的方案合併成一條（留走路較短的） =====
  // 每一段車：種類、名稱、上車時間（分）相同，下車時間差 ≤2 分；整條出發、抵達也各差 ≤2 分
  function dedupeSameTrip(list) {
    const src = (list || []).slice(), out = [];
    const m = t => Math.floor((parseTpe(t) || 0) / 60000);
    const tr = r => (r.legs || []).filter(l => l.kind === "transit");
    const walk = r => (r.legs || []).reduce((a, l) => a + (l.kind === "walk" ? (l.dur || 0) : 0), 0);
    const same = (A, B) => {
      const a = tr(A), b = tr(B);
      if (!a.length || a.length !== b.length) return false;
      if ((A.legs || []).some(l => l.kind === "bike") !== (B.legs || []).some(l => l.kind === "bike")) return false;
      if (Math.abs(Math.floor(A.start / 60000) - Math.floor(B.start / 60000)) > 2 || Math.abs(Math.floor(A.end / 60000) - Math.floor(B.end / 60000)) > 2) return false;
      return a.every((x, k) => { const y = b[k]; return x.mode === y.mode && nm2(x.name) === nm2(y.name) && m(x.from.time) === m(y.from.time) && Math.abs(m(x.to.time) - m(y.to.time)) <= 2; });
    };
    const better = (a, b) => (walk(a) - walk(b)) || (a.end - b.end) || (b.start - a.start);
    for (const r of src) {
      const i = out.findIndex(x => same(x, r));
      if (i < 0) { out.push(r); continue; }
      if (better(r, out[i]) < 0) out[i] = r;
    }
    return out;
  }

  // ===== v2.51.7：車站各方向接下來 N 班（車站小卡大時間卡、列表、附近車站卡片共用）=====
  // 台鐵／高鐵：依看板的方向分組（順行／逆行、南下／北上）。
  // 捷運／輕軌：依「路線＋方向」分組（多線交會站＝每條線兩個方向）；有即時用即時，沒有即時的方向改用自有時刻表（src:"tt"，畫面標表定）。
  function railDirPick(D, opt) {
    const per = (opt && opt.per) || 2, lines = (opt && opt.lines) || [];
    if (!D) return [];
    const ok = t => t && (t.eta == null || t.eta >= 0);
    if (D.kind === "tra" || D.kind === "thsr") {
      return (D.groups || []).map(g => ({ key: "d" + g.dir, label: g.label, dir: g.dir, trains: (g.trains || []).filter(ok).slice(0, per), src: "live" })).filter(g => g.trains.length);
    }
    const keyOf = (line, side, via, dest) => (line || "") + "|" + (side || ("x" + (dest || ""))) + "|" + (via || "");
    const out = new Map();
    for (const g of D.groups || []) {
      const tr = (g.trains || []).filter(ok).slice().sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999)).slice(0, per);
      if (!tr.length) continue;
      const line = g.line || tr[0].line || "", k = keyOf(line, g.side, tr[0].via, tr[0].dest);
      if (!out.has(k)) out.set(k, { key: k, line, side: g.side || null, label: g.label || ("往 " + (tr[0].dest || "")), trains: tr, src: "live" });
    }
    // v2.60.3：opt.fill：即時方向不足 per 班時，用同線同方向的時刻表補後面的班次（比最後一班即時晚 2 分以上，避免把同一班列兩次），補的班次標 tt:true
    if (opt && opt.fill) for (const g of out.values()) {
      if (g.trains.length >= per || !g.side) continue;
      const last = g.trains[g.trains.length - 1].eta ?? 0;
      const more = (D.tt || []).filter(t => t.eta != null && t.eta >= last + 2 && (t.line || "") === g.line && t.side === g.side).sort((a, b) => a.eta - b.eta);
      g.trains = g.trains.concat(more.slice(0, per - g.trains.length).map(t => ({ ...t, tt: true })));
    }
    const tt = new Map();
    for (const t of D.tt || []) {
      if (t.eta == null || t.eta < 0) continue;
      const k = keyOf(t.line, t.side, t.via, t.dest);
      if (out.has(k)) continue;   // 這個方向有即時就用即時
      if (!tt.has(k)) tt.set(k, { key: k, line: t.line || "", side: t.side || null, trains: [], src: "tt" });
      tt.get(k).trains.push(t);
    }
    for (const [k, g] of tt) {
      g.trains.sort((a, b) => a.eta - b.eta); g.trains = g.trains.slice(0, per);
      g.label = "往 " + [...new Set(g.trains.map(t => t.dest).filter(Boolean))].join("／") + (g.trains[0].via ? "（" + g.trains[0].via + "）" : "");
      out.set(k, g);
    }
    const rank = l => { const i = lines.indexOf(l); return i < 0 ? 50 + (String(l || "").charCodeAt(0) || 0) : i; };
    const sk = x => x === "up" || x === "d0" ? 0 : x === "dn" || x === "d1" ? 1 : 2;
    return [...out.values()].sort((a, b) => rank(a.line) - rank(b.line) || sk(a.side) - sk(b.side) || a.key.localeCompare(b.key));
  }

  // v2.60.4：站牌格子索引（約 500 公尺一格）。stopsNear(pt) 回傳 radius 內最近的 limit 個站牌 { uid, lat, lon, dist }，
  // 結果（含同距離時的先後）和逐一掃描 coords 全部站牌、依距離穩定排序完全相同
  function stopGrid(coords, hav, radius, limit) {
    const CLAT = 0.0045, CLON = 0.005, cells = new Map();
    let i = 0;
    for (const [uid, p] of Object.entries(coords || {})) {
      const idx = i++;
      if (!p || p[0] == null || p[1] == null) continue;
      const k = Math.floor(p[0] / CLAT) + "," + Math.floor(p[1] / CLON);
      let c = cells.get(k); if (!c) cells.set(k, c = []);
      c.push([uid, p, idx]);
    }
    return pt => {
      if (!pt || pt.lat == null || pt.lon == null) return [];
      const la = +pt.lat, lo = +pt.lon;
      const nLat = Math.ceil(radius / (CLAT * 111000)) + 1, nLon = Math.ceil(radius / (CLON * 111000 * Math.max(0.2, Math.cos(la * Math.PI / 180)))) + 1;
      const a0 = Math.floor(la / CLAT), b0 = Math.floor(lo / CLON), arr = [];
      for (let a = a0 - nLat; a <= a0 + nLat; a++) for (let b = b0 - nLon; b <= b0 + nLon; b++) {
        for (const [uid, p, idx] of cells.get(a + "," + b) || []) {
          const dist = hav(pt.lat, pt.lon, p[0], p[1]);
          if (dist <= radius) arr.push({ uid, lat: p[0], lon: p[1], dist, _i: idx });
        }
      }
      arr.sort((x, y) => x.dist - y.dist || x._i - y._i);
      return arr.slice(0, limit).map(({ uid, lat, lon, dist }) => ({ uid, lat, lon, dist }));
    };
  }

  // v2.60.5：軌道班次背景掃描（可於主執行緒或 Web Worker 執行）
  const havRound = (lat1, lon1, lat2, lon2) => Math.round(hav(lat1, lon1, lat2, lon2));
  const RP_LINE_ZH = {
    TRTC: { BL: "板南線", BR: "文湖線", R: "淡水信義線", G: "松山新店線", O: "中和新蘆線", Y: "環狀線", RA: "新北投支線", GA: "小碧潭支線" },
    NTMC: { Y: "環狀線", LB: "三鶯線" },
    KRTC: { R: "紅線", O: "橘線", C: "環狀輕軌" },
    TMRT: { G: "綠線" },
    KLRT: { C: "環狀輕軌" },
    TYMC: { A: "機場線" },
    NTDLRT: { V: "淡海輕軌" },
    NTALRT: { K: "安坑輕軌" }
  };
  const RP_LRT = { KLRT: 1, NTDLRT: 1, NTALRT: 1 };
  const RP_CHG = () => 3;
  const RP_K = 4, RP_FP = 800, RP_MS = 60000, RP_WALK_ST = 1200, RP_FALLBACK_WALK_ST = 5000, RP_WSPD = 75;
  const rpBig = op => op === "TRA" || op === "THSR";
  const rpWalk = m => Math.ceil(m / 100);
  const pn = x => String(x || "").replace(/臺/g, "台").toLowerCase().replace(/\(.*?\)|（.*?）/g, "").replace(/站$/, "").replace(/\s/g, "");
  const rpSameSt = (a, b, d) => a.op === b.op && d < 150 && pn(a.name) === pn(b.name);
  const rpXfer = (a, b, d) => rpSameSt(a, b, d) ? 3 : 3 + rpWalk(d);
  const rpTight = (a, b, d) => rpSameSt(a, b, d) ? 1 : Math.max(1, rpWalk(d));
  const shortType = s => (s || "").replace(/\(.*?\)|（.*?）/g, "").trim();
  const TRA_TYPE = t => { t = shortType(t); return /^(自強|莒光|復興)$/.test(t) ? t + "號" : t === "區間" ? "區間車" : t; };
  const rpLabel = t => rpBig(t.op) ? (t.op === "THSR" ? `高鐵${t.no}次` : `${TRA_TYPE(t.type || "").replace(/號$/, "")}${t.no}次`) : ((RP_LINE_ZH[t.op] || {})[t.line] || t.line || "");
  const rpLL = (lat, lon) => (+lat).toFixed(4) + "," + (+lon).toFixed(4);
  const tms = s => s ? Date.parse(s + "+08:00") : null;

  function prepareRailPack(net, stations, footData) {
    const info = new Map(), cell = new Map(), ck = (a, b) => Math.floor(a / 0.004) + "," + Math.floor(b / 0.004);
    for (const s of (stations || [])) {
      const k = s.key || (s.op + ":" + s.id);
      info.set(k, { key: k, op: s.op, id: s.id, name: s.name, lat: s.lat, lon: s.lon });
      const c = ck(s.lat, s.lon);
      if (!cell.has(c)) cell.set(c, []);
      cell.get(c).push(k);
    }
    const near = (lat, lon, r) => {
      const out = [], a = Math.floor(lat / 0.004), b = Math.floor(lon / 0.004), span = Math.max(1, Math.ceil((r || 800) / 400));
      for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
        for (const k of cell.get((a + i) + "," + (b + j)) || []) {
          const s = info.get(k), d = havRound(lat, lon, s.lat, s.lon);
          if (d <= r) out.push([s, d]);
        }
      }
      return out;
    };
    const foot = footData instanceof Map ? footData : new Map(footData || []);
    const S = { info, near, foot };
    return { net, S };
  }

  const toWMap = w => {
    if (!w) return null;
    if (w instanceof Map) return w;
    if (Array.isArray(w)) return new Map(w);
    if (typeof w === "object") return new Map(Object.entries(w));
    return null;
  };
  function rpWalkM(W, p, lat, lon) {
    const s = havRound(p.lat, p.lon, lat, lon);
    const m = toWMap(W);
    const v = m ? m.get(rpLL(lat, lon)) : null;
    return v != null && v <= s * 4 + 200 ? Math.max(v, s) : s * 1.3;
  }
  function rpWalkSrc(W, p, lat, lon) {
    const s = havRound(p.lat, p.lon, lat, lon);
    const m = toWMap(W);
    const v = m ? m.get(rpLL(lat, lon)) : null;
    return v != null && v <= s * 4 + 200 ? "osrm" : "line";
  }
  function rpEnds(S, p) {
    const out = new Map(), nm = pn(p.name || "");
    for (const [s, d] of S.near(p.lat, p.lon, RP_FP)) {
      const same = pn(s.name) === nm && d <= 300;
      const m = same ? 0 : rpWalk(d) + 3;
      if (!out.has(s.key) || out.get(s.key) > m) out.set(s.key, m);
    }
    return out;
  }
  function rpAccess(S, o, isSt, bus, t0, live, W) {
    const src = new Map(), how = new Map(), put = (k, m, h) => { if (!src.has(k) || src.get(k) > m) { src.set(k, m); how.set(k, h); } };
    if (isSt) for (const [k, m] of rpEnds(S, o)) put(k, m, { type: "walk", m });
    else {
      if (S) for (const [x] of S.near(o.lat, o.lon, RP_WALK_ST)) { const len = Math.round(rpWalkM(W, o, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len, src: rpWalkSrc(W, o, x.lat, x.lon) }); }
      if (S && src.size === 0) {
        const fallback = S.near(o.lat, o.lon, RP_FALLBACK_WALK_ST).sort((a, b) => a[1] - b[1]).slice(0, 2);
        for (const [x] of fallback) { const len = Math.round(rpWalkM(W, o, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len, src: rpWalkSrc(W, o, x.lat, x.lon) }); }
      }
    }
    for (const b of (bus || [])) {
      const ready = t0 + b.walk * RP_MS, dep = b.dep, lv = b.live;
      const m = Math.ceil((dep + (b.ride + b.stWalk) * RP_MS - t0) / RP_MS);
      put(b.key, m, { type: "bus", m, opt: b, dep, live: lv, alts: b.alts || [] });
    }
    return { src, how };
  }
  function rpEgress(S, d, isSt, bus, W) {
    const dst = new Map(), how = new Map(), put = (k, m, h) => { if (!dst.has(k) || dst.get(k) > m) { dst.set(k, m); how.set(k, h); } };
    if (isSt) for (const [k, m] of rpEnds(S, d)) put(k, m, { type: "walk", m });
    else {
      if (S) for (const [x] of S.near(d.lat, d.lon, RP_WALK_ST)) { const len = Math.round(rpWalkM(W, d, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len, src: rpWalkSrc(W, d, x.lat, x.lon) }); }
      if (S && dst.size === 0) {
        const fallback = S.near(d.lat, d.lon, RP_FALLBACK_WALK_ST).sort((a, b) => a[1] - b[1]).slice(0, 2);
        for (const [x] of fallback) { const len = Math.round(rpWalkM(W, d, x.lat, x.lon)), m = Math.ceil(len / RP_WSPD) + 3; put(x.key, m, { type: "walk", m, len, src: rpWalkSrc(W, d, x.lat, x.lon) }); }
      }
    }
    for (const b of (bus || [])) {
      const w = b.wait || 5, m = b.stWalk + w + b.ride + b.walk;
      put(b.key, m, { type: "bus", m, opt: b, alts: b.alts || [], wait: w });
    }
    return { dst, how };
  }
  function rpScan(net, S, src, dst, t0, tMax, arriveBy) {
    const { C, trips } = net, K = RP_K;
    const R = Array.from({ length: K + 1 }, () => new Map());
    const A = Array.from({ length: K + 1 }, () => new Map());
    const T = new Map();
    for (const [k, m] of src) R[0].set(k, { t: t0 + m * RP_MS, src: m });
    const best = new Array(K + 1).fill(Infinity);
    let lo = 0, hi = C.length; while (lo < hi) { const md = (lo + hi) >> 1; if (C[md][0] < t0) lo = md + 1; else hi = md; }
    const upd = (j, k, lab) => { const o = R[j].get(k); if (!o || lab.t < o.t) R[j].set(k, lab); };
    for (let i = lo; i < C.length; i++) {
      const c = C[i]; if (c[0] > tMax) break;
      const minB = Math.min(...best);
      if (arriveBy > 0) { if (c[0] > arriveBy) break; }
      else if (c[0] > minB + 180 * RP_MS) break;
      const tr = trips[c[2]], from = tr.pts[c[3]][0], to = tr.pts[c[3] + 1][0];
      let st = T.get(c[2]);
      for (let j = 0; j < K; j++) {
        if (!st || !st[j]) { const r = R[j].get(from); if (r && r.t <= c[0]) { if (!st) { st = new Array(K).fill(null); T.set(c[2], st); } st[j] = { at: c[3], prev: r, j }; } }
        if (!st || !st[j]) continue;
        let pm = Infinity; for (let q = 1; q <= j + 1; q++) if (best[q] < pm) pm = best[q];
        if (c[1] >= pm) continue;
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
      const rule = ft.pts[f.b][0] === P[0] ? 3 : bx ? rpXfer(a, bx, havRound(a.lat, a.lon, bx.lat, bx.lon)) : 3;
      if (slack >= rule) continue;
      return `轉乘提醒：${st} ${hmTpe(dep)} 的${rpLabel(ft)}（下車後只有 ${slack} 分鐘${ft.pts[f.b][0] === P[0] || (bx && rpSameSt(a, bx, 0)) ? "" : "，要出站走過去"}），趕得上可以早 ${Math.round((J.arr - b.arr) / RP_MS)} 分到（${hmTpe(b.arr)}）`;
    }
    return null;
  }
  function rpRoute(net, S, J, o, d) {
    const { trips } = net, sec = [], isoT = ms => isoTpe(ms);
    const stOf = k => S.info.get(k) || { name: k.split(":")[1], lat: null, lon: null };
    const place = (k, t) => { const s = stOf(k); return { time: isoT(t), place: { name: s.name, type: "station", location: s.lat != null ? { lat: s.lat, lng: s.lon } : {} } }; };
    const free = (p, t) => ({ time: isoT(t), place: { name: p.name || null, type: "location", location: { lat: p.lat, lng: p.lon } } });
    const r0 = J.rides[0], t0 = trips[r0.ti], dep0 = t0.pts[r0.b][2];
    let start = dep0 - J.startWalk * RP_MS;
    if (J.startWalk) sec.push({ type: "pedestrian", timeSrc: (J.acc && J.acc.src) || "line", departure: free(o, start), arrival: place(t0.pts[r0.b][0], dep0), travelSummary: { duration: J.startWalk * 60, ...(J.acc && J.acc.len ? { length: J.acc.len } : {}) } });
    let lastArr = null;
    J.rides.forEach((r, i) => {
      const t = trips[r.ti], A = t.pts[r.b], B = t.pts[r.a], dep = A[2], arr = B[1];
      if (i > 0) {
        const p = J.rides[i - 1], pt = trips[p.ti], P = pt.pts[p.a];
        const sa = stOf(P[0]), sb = stOf(A[0]);
        let walkEnd = P[1];
        if (r.walkFrom && !(sa.op && sa.op === sb.op && pn(sa.name) === pn(sb.name))) {
          walkEnd = P[1] + r.walkFrom * RP_MS;
          sec.push({ type: "pedestrian", timeSrc: "line", departure: place(P[0], P[1]), arrival: place(A[0], walkEnd), travelSummary: { duration: r.walkFrom * 60 } });
        }
        if (J.earlyUrban && rpBig(t.op) && dep - walkEnd >= 60000) {
          sec.push({ type: "waiting", departure: place(A[0], walkEnd), arrival: place(A[0], dep), travelSummary: { duration: Math.round((dep - walkEnd) / 1000) } });
        }
      }
      const big = rpBig(t.op);
      const transport = big
        ? { mode: t.op, name: t.start && t.dest ? t.start + "-" + t.dest : t.op === "TRA" ? "台鐵" : "高鐵", headsign: t.dest, number: t.no, ...(t.op === "TRA" && t.type ? { trainType: t.type } : {}) }
        : { mode: RP_LRT[t.op] ? "lrt" : "metro", name: (RP_LINE_ZH[t.op] || {})[t.line] || t.line, headsign: t.dest || "", ...(t.est ? { est: true } : {}) };
      sec.push({ type: "transit", timeSrc: t.est ? "headway" : "schedule", transport, agency: { agency_id: t.op, name: t.op },
        departure: place(A[0], dep), arrival: place(B[0], arr),
        intermediateStops: t.pts.slice(r.b + 1, r.a).map(x => ({ departure: place(x[0], x[2]) })),
        stopCount: r.a - r.b, travelSummary: { duration: Math.round((arr - dep) / 1000) } });
      lastArr = { k: B[0], t: arr };
    });
    let end = lastArr.t + J.endWalk * RP_MS;
    if (J.endWalk) sec.push({ type: "pedestrian", timeSrc: (J.egr && J.egr.src) || "line", departure: place(lastArr.k, lastArr.t), arrival: free(d, end), travelSummary: { duration: J.endWalk * 60, ...(J.egr && J.egr.len ? { length: J.egr.len } : {}) } });
    return { source: "self", start_time: isoT(start), end_time: isoT(end), sections: sec, ...(J.tightNote ? { tightNote: J.tightNote } : {}) };
  }

  function railPlan(input) {
    const { net, S, o, d, when, time, fromBus, busReadyMs } = input;
    const Wo = toWMap(input.Wo);
    const Wd = toWMap(input.Wd);
    if (!o || !d || o.lat == null || d.lat == null || !net || !net.C || !net.C.length) return [];
    const oSt = !!(o && o.st);
    const dSt = !!(d && d.st);
    const E = rpEgress(S, d, dSt, [], Wd), dst = E.dst;
    const accAt = t => rpAccess(S, o, oSt, [], t, when === "now", Wo);
    {
      const a0 = accAt(Date.now());
      if (!a0.src.size || !dst.size) return [];
      for (const k of a0.src.keys()) {
        if (dst.has(k) && a0.how.get(k).type === "walk" && E.how.get(k).type === "walk") return [];
      }
    }
    const arrBy = when === "arr" && time ? tms(time) : null;
    const ref = when === "dep" && time ? tms(time) : (arrBy ? arrBy - 6 * 3600000 : Date.now());
    const sig = J => J.rides.map(r => r.ti + "." + r.b + "." + r.a).join("|");
    const got = new Map();
    let t0 = ref;
    const bKey = J => net.trips[J.rides[0].ti].pts[J.rides[0].b][0];
    const aKey = J => { const L = J.rides[J.rides.length - 1]; return net.trips[L.ti].pts[L.a][0]; };
    const depOf = J => J.acc && J.acc.type === "bus" ? J.acc.dep - J.acc.opt.walk * RP_MS : net.trips[J.rides[0].ti].pts[J.rides[0].b][2] - J.startWalk * RP_MS;

    if (arrBy) {
      const found = searchArrive({
        arrBy,
        lookbackMs: 6 * 3600000,
        scan(t0s) {
          const A0 = accAt(t0s);
          const res = rpScan(net, S, A0.src, dst, t0s, arrBy + 30 * RP_MS, arrBy);
          return res.map(J => {
            J.acc = A0.how.get(bKey(J));
            J.egr = E.how.get(aKey(J));
            return { dep: depOf(J), arr: J.arr, raw: J, key: sig(J) + "|" + (J.acc && J.acc.type === "bus" ? J.acc.opt.uid + J.acc.dep : "w") };
          });
        }
      });
      for (const x of found.list) if (x.raw) got.set(x.key, x.raw);
    } else {
      for (let n = 0; n < 8; n++) {
        const A0 = accAt(t0);
        const res = rpScan(net, S, A0.src, dst, t0, t0 + 10 * 3600000);
        if (!res.length) break;
        for (const J of res) {
          J.acc = A0.how.get(bKey(J));
          J.egr = E.how.get(aKey(J));
          got.set(sig(J) + "|" + (J.acc && J.acc.type === "bus" ? J.acc.opt.uid + J.acc.dep : "w"), J);
        }
        const dep = Math.min(...res.map(depOf));
        t0 = Math.max(t0 + RP_MS, dep + RP_MS);
      }
    }

    const byLast = new Map(), firstByLast = new Map();
    for (const J of got.values()) {
      const L = J.rides[J.rides.length - 1], k = L.ti + "." + L.a + "|" + J.arr;
      const oL = byLast.get(k); if (!oL || depOf(J) > depOf(oL)) byLast.set(k, J);
      const oF = firstByLast.get(k); if (!oF || depOf(J) < depOf(oF)) firstByLast.set(k, J);
    }

    for (const [k, late] of byLast.entries()) {
      const isFromBus = !!(fromBus || busReadyMs != null || (late.acc && late.acc.type === "bus"));
      if (!isFromBus) continue;
      const r0 = late.rides && late.rides[0], t0r = r0 && net.trips[r0.ti];
      if (!t0r || rpBig(t0r.op) || !late.rides.slice(1).some(r => rpBig(net.trips[r.ti].op))) continue;
      const readyAtSt = (late.acc && late.acc.type === "bus")
        ? late.acc.dep + (late.acc.opt.ride + late.acc.opt.stWalk) * RP_MS
        : (Number.isFinite(busReadyMs) ? busReadyMs : ref) + (late.startWalk || 0) * RP_MS;
      const waitMs = t0r.pts[r0.b][2] - readyAtSt;
      const early = firstByLast.get(k);
      if (waitMs > 10 * RP_MS && early && early.arr <= late.arr && depOf(early) < depOf(late)) {
        early.earlyUrban = true;
        byLast.set(k, early);
      }
    }

    let list = [...byLast.values()];
    list = list.filter(J => !list.some(Y => Y !== J && Y.rides.length < J.rides.length && Y.arr <= J.arr + 5 * RP_MS && depOf(Y) >= depOf(J) - 5 * RP_MS));
    list = arrBy ? list.sort((a, b) => depOf(b) - depOf(a) || a.arr - b.arr).slice(0, 6) : list.sort((a, b) => a.arr - b.arr).slice(0, 6);
    for (const J of list) { try { J.tightNote = rpTightNote(net, S, J, dst); } catch (e) {} }
    return list.map(J => rpRoute(net, S, J, o, d));
  }

  const api = { stopGrid, plan, assemble, parseTpe, isoTpe, hmTpe, serviceBit, walkChunks, citiesFor, sectionsFromBus, walkOnlyRoute, bikeRoute, joinRoutes, syncRouteTimes, applyWalkShape, sortOwn, liveFixRoute, mergeBusAlts, sameBusSeg, railDirPick, dedupeSameTrip, searchArrive, transferHubs, chooseTransfer, walkQueue, walkBatches, walkParse, walkGroupBatches, walkGroupParse, planBranches, shapeLegs, prepareRailPack, railPlan };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BusDirect = api;
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) {
    // v2.60.4：大資料（records／stops／sor）只收一次（cmd "pack"），之後的計算用 packRef 指到那份，不再每次複製
    const packs = new Map();
    // v2.60.5：大資料（net／stations／foot）只收一次（cmd "railPack"），之後的計算用 railPackRef 指到那份
    const railPacks = new Map();
    root.onmessage = e => {
      const m = e.data || {};
      if (m.cmd === "pack") { packs.set(m.key, { records: m.records, stops: m.stops, sor: m.sor }); while (packs.size > 4) packs.delete(packs.keys().next().value); return; }
      if (m.cmd === "railPack") { railPacks.set(m.key, prepareRailPack(m.net, m.stations, m.foot)); while (railPacks.size > 4) railPacks.delete(railPacks.keys().next().value); return; }
      if (m.cmd === "railPlan" || m.railPackRef) {
        let out;
        try {
          const RP = m.railPackRef ? railPacks.get(m.railPackRef) : null;
          if (m.railPackRef && !RP) throw new Error("軌道背景資料遺失");
          const net = RP ? RP.net : m.net;
          const S = RP ? RP.S : m.S;
          out = { status: "ok", routes: railPlan({ ...m, net, S }) };
        } catch (x) {
          out = { status: "error", message: String(x && x.message || x), routes: [] };
        }
        root.postMessage({ id: e.data && e.data.id, out });
        return;
      }
      let out;
      try {
        const P = m.packRef ? packs.get(m.packRef) : null;
        if (m.packRef && !P) throw new Error("背景資料遺失");
        out = plan(P ? { ...m, records: P.records, stops: P.stops, sor: P.sor } : m);
      }
      catch (x) { out = { status: "error", message: String(x && x.message || x), routes: [] }; }
      root.postMessage({ id: e.data && e.data.id, out });
    };
  }
})(typeof self !== "undefined" ? self : this);
