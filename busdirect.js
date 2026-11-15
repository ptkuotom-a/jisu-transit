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
    const stop = s => ({ time: s.time, place: { name: s.name, type: "stop", location: s.pos ? { lat: s.pos[0], lng: s.pos[1] } : {} } });
    return {
      source: "self",
      start_time: r.startIso,
      end_time: r.endIso,
      sections: [
        { type: "pedestrian", timeSrc: wsrc(r.walkO), departure: placePt(o, r.startIso), arrival: stop(r.from), travelSummary: { duration: (r.walkO && r.walkO.min || 0) * 60, length: r.walkO && r.walkO.m || 0 } },
        { type: "transit", timeSrc: rideSrc, transport: { mode: "bus", name: r.name, headsign: r.to && r.to.name || "", ...(r.confidence === "live" ? { liveDep: true } : rideSrc === "schedule" ? {} : { est: true }) }, agency: { agency_id: "bus", name: "公車" }, departure: stop(r.from), arrival: stop(r.to), travelSummary: { duration: (r.ride || 0) * 60 } },
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
    const r = rail.sections.slice();
    const keepTail = !!(opt && opt.keepTail);
    if (!keepTail && b.length && b[b.length - 1].type === "pedestrian") b.pop();
    if (r.length && r[0].type === "pedestrian") r.shift();
    return { source: "self", start_time: bus.start_time, end_time: rail.end_time, sections: b.concat(r) };
  }

  function sortOwn(list, when, limit) {
    const walkLen = r => (r.legs || []).reduce((a, l) => a + ((l.kind === "walk" || l.kind === "bike") ? (l.len || 0) : 0), 0);
    const hasT = r => (r.legs || []).some(l => l.kind === "transit");
    const hasBike = r => (r.legs || []).some(l => l.kind === "bike");
    const cmp = (a, b) => (when === "arr" ? b.start - a.start : a.end - b.end) || (a.transfers || 0) - (b.transfers || 0) || walkLen(a) - walkLen(b);
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

  const api = { plan, assemble, parseTpe, isoTpe, hmTpe, serviceBit, walkChunks, citiesFor, sectionsFromBus, walkOnlyRoute, bikeRoute, joinRoutes, sortOwn, searchArrive, transferHubs, chooseTransfer };
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
