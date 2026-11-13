/**
 * web/s2stime.js - 兩站行車時間純函式
 * 
 * 包含：
 * 1. S2STIME.travel({ doc, sub, dir, from, to, depart, holidays })
 * 2. S2STIME.fromSchedule({ rec, from, to, depart })
 * 3. S2STIME.fromDistance({ stops, from, to, depart, holidays, speedTable, city })
 * 
 * 保守車速預設值：市區 15 km/h、公路客運 25 km/h
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2STIME = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 車速保守預設值（km/h）
  const DEFAULT_CITY_SPEED = 15;
  const DEFAULT_INTERCITY_SPEED = 25;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function getTaipeiTime(epochMs) {
    const d = new Date(epochMs + 8 * 3600 * 1000);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return {
      ymd: `${year}${month}${day}`,
      day: d.getUTCDay(), // 0: Sun, 6: Sat
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  }

  function parseSlotHour(st) {
    if (!st) return -1;
    const parts = String(st).split(":");
    return parseInt(parts[0], 10);
  }

  function calcMedian(arr) {
    if (!arr || !arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    if (s.length % 2 !== 0) return s[m];
    return Math.round((s[m - 1] + s[m]) / 2);
  }

  function travel({ doc, sub, dir, from, to, depart, holidays }) {
    if (!doc || !Array.isArray(doc.d)) {
      return { ok: false, err: "noData", msg: "無效的站間時間文件" };
    }
    const x = doc.d.find(it => String(it.SubRouteUID) === String(sub) && Number(it.Direction) === Number(dir));
    if (!x) {
      return { ok: false, err: "noSub", msg: `找不到子路線 ${sub} 方向 ${dir}` };
    }

    const pfx = (x.RouteUID || "").slice(0, 3) || "TPE";
    const prefixId = id => {
      if (id == null) return null;
      const s = String(id).trim();
      if (!s) return null;
      if (/^[A-Za-z]/.test(s)) return s;
      return pfx + s;
    };

    // 排除起點標記段（Sequence 1、沒有 FromStopID 或沒有 RunTime）
    const validTT = (x.TravelTimes || []).filter(t => t && t.FromStopID != null && t.ToStopID != null && typeof t.RunTime === "number");
    if (!validTT.length) {
      return { ok: false, err: "noData", msg: "無行駛段資料" };
    }

    // 依 Sequence 首尾相接成站序
    const seqMap = new Map();
    for (const t of validTT) {
      if (!seqMap.has(t.Sequence)) {
        seqMap.set(t.Sequence, {
          seq: t.Sequence,
          from: prefixId(t.FromStopID),
          to: prefixId(t.ToStopID)
        });
      }
    }
    const seqList = Array.from(seqMap.values()).sort((a, b) => a.seq - b.seq);

    // 檢核接合（斷鏈）
    for (let i = 0; i < seqList.length - 1; i++) {
      if (seqList[i].to !== seqList[i + 1].from) {
        return {
          ok: false,
          err: "noData",
          msg: `站序斷鏈: seq ${seqList[i].seq} (${seqList[i].to}) -> seq ${seqList[i + 1].seq} (${seqList[i + 1].from})`
        };
      }
    }

    // 建立站點列表與出現次數
    const stops = [];
    const occMap = new Map();
    const pushStop = uid => {
      const c = (occMap.get(uid) || 0) + 1;
      occMap.set(uid, c);
      stops.push({ uid, occ: c });
    };
    pushStop(seqList[0].from);
    for (const s of seqList) {
      pushStop(s.to);
    }

    const parseTarget = t => {
      if (t && typeof t === "object" && t.uid) {
        return { uid: prefixId(t.uid), occ: t.occ != null ? Number(t.occ) : null };
      }
      return { uid: prefixId(t), occ: null };
    };

    const fromT = parseTarget(from);
    const toT = parseTarget(to);

    const fromMatches = stops.map((s, idx) => ({ ...s, idx })).filter(s => s.uid === fromT.uid);
    if (!fromMatches.length) return { ok: false, err: "notOnRoute", msg: `起點站 ${fromT.uid} 不在路線上` };
    const toMatches = stops.map((s, idx) => ({ ...s, idx })).filter(s => s.uid === toT.uid);
    if (!toMatches.length) return { ok: false, err: "notOnRoute", msg: `訖點站 ${toT.uid} 不在路線上` };

    let fromIdx = -1;
    if (fromT.occ != null) {
      const m = fromMatches.find(s => s.occ === fromT.occ);
      if (!m) return { ok: false, err: "notOnRoute", msg: `起點站 ${fromT.uid} 第 ${fromT.occ} 次出現不存在` };
      fromIdx = m.idx;
    } else {
      fromIdx = fromMatches[0].idx;
    }

    let toIdx = -1;
    if (toT.occ != null) {
      const m = toMatches.find(s => s.occ === toT.occ);
      if (!m) return { ok: false, err: "notOnRoute", msg: `訖點站 ${toT.uid} 第 ${toT.occ} 次出現不存在` };
      toIdx = m.idx;
    } else {
      // 挑「上車那次出現之後、最近一次下車出現」
      const candidate = toMatches.find(s => s.idx > fromIdx);
      if (!candidate) return { ok: false, err: "order", msg: "下車站未在上車站之後出現" };
      toIdx = candidate.idx;
    }

    if (toIdx <= fromIdx) {
      return { ok: false, err: "order", msg: "下車站未在上車站之後" };
    }

    // 計算各段時間
    const departDate = depart instanceof Date ? depart : (depart ? new Date(depart) : new Date());
    let currentEpochMs = departDate.getTime();
    let totalSeconds = 0;
    let borrowed = false;
    const segs = [];

    const findBySlot = (seq, tag, h) => {
      return validTT.find(t => t.Sequence === seq && String(t.ServiceTag) === String(tag) && parseSlotHour(t.StartTime) === h);
    };

    for (let i = fromIdx; i < toIdx; i++) {
      const curSeq = seqList[i];
      const seq = curSeq.seq;
      const tp = getTaipeiTime(currentEpochMs);
      const slotHour = tp.hour;
      const slot = slotHour + ":00";
      const isWeekend = tp.day === 0 || tp.day === 6 || (holidays && holidays.has(tp.ymd));
      const tag = isWeekend ? "0" : "1";

      let sec = null;
      let how = null;

      // 1. 精確時段
      let match = findBySlot(seq, tag, slotHour);
      if (match) {
        sec = match.RunTime;
        how = "exact";
      }

      // 2. 借前一個小時
      if (sec == null) {
        const prevH = (slotHour + 23) % 24;
        match = findBySlot(seq, tag, prevH);
        if (match) {
          sec = match.RunTime;
          how = "prev";
          borrowed = true;
        }
      }

      // 3. 借後一個小時
      if (sec == null) {
        const nextH = (slotHour + 1) % 24;
        match = findBySlot(seq, tag, nextH);
        if (match) {
          sec = match.RunTime;
          how = "next";
          borrowed = true;
        }
      }

      // 4. 同 ServiceTag 全天中位數
      if (sec == null) {
        const sameTagList = validTT.filter(t => t.Sequence === seq && String(t.ServiceTag) === tag);
        if (sameTagList.length > 0) {
          sec = calcMedian(sameTagList.map(t => t.RunTime));
          how = "median";
          borrowed = true;
        }
      }

      // 5. 另一 ServiceTag 全天中位數
      if (sec == null) {
        const otherTag = tag === "0" ? "1" : "0";
        const otherTagList = validTT.filter(t => t.Sequence === seq && String(t.ServiceTag) === otherTag);
        if (otherTagList.length > 0) {
          sec = calcMedian(otherTagList.map(t => t.RunTime));
          how = "otherTagMedian";
          borrowed = true;
        }
      }

      // 6. 都沒有
      if (sec == null) {
        return { ok: false, err: "noData", msg: `Sequence ${seq} 無任何時段資料` };
      }

      totalSeconds += sec;
      currentEpochMs += sec * 1000;
      segs.push({
        seq,
        from: curSeq.from,
        to: curSeq.to,
        sec,
        slot,
        tag,
        how
      });
    }

    const minutes = Number((totalSeconds / 60).toFixed(1));
    return {
      ok: true,
      minutes,
      seconds: totalSeconds,
      source: "s2s",
      borrowed,
      estimated: false,
      segs
    };
  }

  function fromSchedule({ rec, from, to, depart }) {
    if (!rec || !Array.isArray(rec.st) || !Array.isArray(rec.p)) {
      return { ok: false, err: "noData", source: "none" };
    }
    const fromUid = typeof from === "object" ? from.uid : from;
    const toUid = typeof to === "object" ? to.uid : to;
    const fromIdx = rec.st.findIndex(s => s[0] === fromUid || s[0] === from);
    const toIdx = rec.st.findIndex(s => s[0] === toUid || s[0] === to);
    if (fromIdx < 0 || toIdx < 0) return { ok: false, err: "notOnRoute", source: "none" };
    if (toIdx <= fromIdx) return { ok: false, err: "order", source: "none" };

    const trips = rec.tr || [];
    let departMin = 0;
    let dayMask = 0xff;
    if (depart) {
      const d = depart instanceof Date ? depart : new Date(depart);
      const tp = getTaipeiTime(d.getTime());
      departMin = tp.hour * 60 + tp.minute;
      dayMask = 1 << tp.day;
    }

    let chosenPat = null;
    for (const t of trips) {
      const [mask, baseMin, patIdx] = t;
      if (dayMask && !(mask & dayMask)) continue;
      const pat = rec.p[patIdx];
      if (!pat) continue;
      const fromMin = pat[fromIdx];
      const toMin = pat[toIdx];
      if (fromMin == null || fromMin === -1 || toMin == null || toMin === -1) continue;
      if (baseMin + fromMin >= departMin) {
        chosenPat = pat;
        break;
      }
    }

    if (!chosenPat) {
      for (const t of trips) {
        const pat = rec.p[t[2]];
        if (!pat) continue;
        const fromMin = pat[fromIdx];
        const toMin = pat[toIdx];
        if (fromMin != null && fromMin !== -1 && toMin != null && toMin !== -1) {
          chosenPat = pat;
          break;
        }
      }
    }

    if (!chosenPat) {
      return { ok: false, err: "noData", source: "none" };
    }

    const minutes = chosenPat[toIdx] - chosenPat[fromIdx];
    if (minutes < 0) return { ok: false, err: "order", source: "none" };
    return {
      ok: true,
      minutes,
      seconds: minutes * 60,
      source: "schedule",
      estimated: false
    };
  }

  function fromDistance({ stops, from, to, depart, holidays, speedTable, city }) {
    if (!stops || !Array.isArray(stops) || !stops.length) {
      return { ok: false, err: "noStops", source: "none" };
    }
    const fromUid = typeof from === "object" ? from.uid : from;
    const toUid = typeof to === "object" ? to.uid : to;
    const fromIdx = stops.findIndex(s => s && (s.uid === fromUid || s.StopUID === fromUid));
    const toIdx = stops.findIndex(s => s && (s.uid === toUid || s.StopUID === toUid));
    if (fromIdx < 0 || toIdx < 0) return { ok: false, err: "notOnRoute", source: "none" };
    if (toIdx <= fromIdx) return { ok: false, err: "order", source: "none" };

    let totalDistKm = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      const s1 = stops[i];
      const s2 = stops[i + 1];
      const lat1 = s1.lat ?? (s1.P && s1.P[0]) ?? (s1.StopPosition && s1.StopPosition.PositionLat);
      const lon1 = s1.lon ?? (s1.P && s1.P[1]) ?? (s1.StopPosition && s1.StopPosition.PositionLon);
      const lat2 = s2.lat ?? (s2.P && s2.P[0]) ?? (s2.StopPosition && s2.StopPosition.PositionLat);
      const lon2 = s2.lon ?? (s2.P && s2.P[1]) ?? (s2.StopPosition && s2.StopPosition.PositionLon);
      if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
        return { ok: false, err: "noCoord", source: "none" };
      }
      totalDistKm += haversineKm(+lat1, +lon1, +lat2, +lon2);
    }

    const isIntercity = city === "InterCity" || city === "THB";
    let speedKmH = isIntercity ? DEFAULT_INTERCITY_SPEED : DEFAULT_CITY_SPEED;

    if (depart) {
      const d = depart instanceof Date ? depart : new Date(depart);
      const tp = getTaipeiTime(d.getTime());
      const isWeekend = tp.day === 0 || tp.day === 6 || (holidays && holidays.has(tp.ymd));
      const dayKind = isWeekend ? "weekend" : "weekday";
      const hour = tp.hour;
      if (speedTable && city && speedTable[city] && speedTable[city][dayKind] && speedTable[city][dayKind][hour]) {
        const sp = speedTable[city][dayKind][hour];
        if (typeof sp === "number" && sp > 0) {
          speedKmH = sp;
        } else if (sp && typeof sp.median === "number" && sp.median > 0) {
          speedKmH = sp.median;
        } else if (sp && typeof sp.speed === "number" && sp.speed > 0) {
          speedKmH = sp.speed;
        }
      }
    }

    const hours = totalDistKm / speedKmH;
    const minutes = Number((hours * 60).toFixed(1));
    const seconds = Math.round(hours * 3600);
    return {
      ok: true,
      minutes,
      seconds,
      distanceKm: Number(totalDistKm.toFixed(3)),
      speed: speedKmH,
      source: "distance",
      estimated: true
    };
  }

  return {
    travel,
    fromSchedule,
    fromDistance,
    haversineKm,
    getTaipeiTime
  };
});
