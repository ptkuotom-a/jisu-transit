// v2.49.29：自有雲端資料（bsch 公車時刻表＋雲端站牌座標＋s2stime 站間旅行時間）算「公車直達」，不呼叫外部路徑引擎（TDX MaaS／Google）。
// 純函式模組：瀏覽器（含 Web Worker）掛在 self.BusDirect，Node 用 module.exports。時間一律以台北時間（UTC+8）計算，與裝置時區無關。
// 安全子集：支援逐站表定時刻（timetable）、起點發車（startOnly）、班距估算（halfHeadway）；有特殊日規則的班次、國定假日都不列，只計數回報。
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

  function plan(input) {
    const { records, stops, o, d, when, time, opts, s2s, sor, cand } = input || {};
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
    const days = [q0 - DAY, q0, q0 + DAY].filter(m => {
      if (hol.has(ymd(m))) {
        st.holidaySkipped.push(ymd(m));
        return false;
      }
      return true;
    });
    if (st.holidaySkipped.length) notes.push("國定假日（" + st.holidaySkipped.join("、") + "）的公車班表規則尚未支援，那天不列");

    const s2sInst = getS2STime();
    const best = new Map();

    for (const r of records) {
      st.recs++;

      // 取得站序 S：優先使用 r.st，若無則從 sor 或 s2s 取
      let S = r.st || [];
      let sorEntry = null;
      if (sor) {
        const sorList = sor[r.u] || sor[r.n] || [];
        sorEntry = sorList.find(x => Number(x.Direction) === Number(r.d) && (!r.s || String(x.SubRouteUID) === String(r.s))) || null;
      }

      if (!S || S.length < 2) {
        if (sorEntry && sorEntry.Stops && sorEntry.Stops.length >= 2) {
          S = sorEntry.Stops.map(s => [
            s.StopUID,
            s.StopName ? (s.StopName.Zh_tw || s.StopName) : s.StopUID,
            s.P
          ]);
        } else if (s2s) {
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
            city: (r.u && r.u.slice(0, 3) === "NWT" ? "NewTaipei" : "Taipei")
          });
          if (dRes && dRes.ok) return { seconds: dRes.seconds, minutes: dRes.minutes, source: "distance" };
        }
        return null;
      }

      // --- 模式 1：有時刻表 (tr) ---
      if (r.tr && r.tr.length) {
        for (const [k, tr] of r.tr.entries()) {
          const [mask, base, pi, sp] = tr, pat = (r.p || [])[pi] || [];
          if (sp !== -1 && sp != null && sp !== "") { st.special++; continue; }

          for (const mid of days) {
            if (!(mask >> wday(mid) & 1)) continue;
            st.tripsChecked++;

            for (const i of iO) for (const j of iD) {
              if (j <= i) continue;
              const a = pat[i], b = pat[j];
              const wo = wm(NO.get(S[i][0])), wd = wm(ND.get(S[j][0]));

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
                  from: { uid: S[i][0], name: S[i][1], time: isoTpe(dep), seq: i },
                  to: { uid: S[j][0], name: S[j][1], time: isoTpe(arr), seq: j },
                  walkO: { m: Math.round(NO.get(S[i][0])), min: wo },
                  walkD: { m: Math.round(ND.get(S[j][0])), min: wd },
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
                  from: { uid: S[i][0], name: S[i][1], time: isoTpe(depMs), seq: i },
                  to: { uid: S[j][0], name: S[j][1], time: isoTpe(arrMs), seq: j },
                  walkO: { m: Math.round(NO.get(S[i][0])), min: wo },
                  walkD: { m: Math.round(ND.get(S[j][0])), min: wd },
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
            if (!(mask >> wday(mid) & 1)) continue;

            for (const i of iO) for (const j of iD) {
              if (j <= i) continue;
              const wo = wm(NO.get(S[i][0])), wd = wm(ND.get(S[j][0]));

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
                from: { uid: S[i][0], name: S[i][1], time: isoTpe(boardMs), seq: i },
                to: { uid: S[j][0], name: S[j][1], time: isoTpe(arrMs), seq: j },
                walkO: { m: Math.round(NO.get(S[i][0])), min: wo },
                walkD: { m: Math.round(ND.get(S[j][0])), min: wd },
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

    let routes = [...best.values()];
    routes.sort(when === "dep"
      ? (a, b) => a.end - b.end || a.start - b.start
      : (a, b) => b.start - a.start || a.end - b.end);

    // 同一路線同方向只留最好的一班
    const seen = new Set();
    routes = routes.filter(r => {
      const k = r.routeUID + "|" + r.sub + "|" + r.dir;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, max);

    if (st.freqOnly && freqPolicy === "exclude") notes.push(st.freqOnly + " 條只有班距的路線未列（列法尚未定案）");
    if (st.freqNoHeadway) notes.push(st.freqNoHeadway + " 筆班距缺少班距數值，未列");
    if (st.special) notes.push(st.special + " 班有特殊日規則的班次未列（規則尚未支援）");
    if (st.missingTime) notes.push("有 " + st.missingTime + " 個上下車站組合缺表定時刻，未列");
    if (st.noS2s) notes.push("有 " + st.noS2s + " 次估算缺少站間資料，改用班表或直線距離推估");
    if (st.noStops) notes.push(st.noStops + " 條路線查無站序資訊，未列");

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

  const api = { plan, assemble, parseTpe, isoTpe, hmTpe };
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
