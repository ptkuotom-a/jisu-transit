// v2.49.9 試行：自有雲端資料（bsch 公車時刻表＋雲端站牌座標）算「公車直達」，不呼叫任何外部路徑引擎（TDX MaaS／Google）。
// 純函式模組：瀏覽器（含 Web Worker）掛在 self.BusDirect，Node 用 module.exports。時間一律以台北時間（UTC+8）計算，與裝置時區無關。
// 安全子集：只用「上車站與下車站都有表定時刻」的班次；只有班距（Frequencys）的路線、有特殊日規則的班次、國定假日都不列，只計數回報。
// 未定案政策不寫死：步行半徑、步行速度、直線距離係數必須由呼叫端傳入；「提早抵達下限」沒傳就不套用並明示；只有班距的列法目前只開放 "exclude"。
(function (root) {
  "use strict";
  const TPE = 8 * 3600000, DAY = 86400000;
  const hav = (a, b, c, d) => { const R = 6371000, r = x => x * Math.PI / 180, x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  // "YYYY-MM-DDTHH:MM[:SS]" 視為台北時間 → epoch ms
  function parseTpe(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - TPE : null;
  }
  const isoTpe = ms => new Date(ms + TPE).toISOString().slice(0, 19);
  const hmTpe = ms => new Date(ms + TPE).toISOString().slice(11, 16);
  const dayMid = ms => Math.floor((ms + TPE) / DAY) * DAY - TPE;                     // 該台北日期 00:00 的 epoch
  const ymd = mid => new Date(mid + TPE).toISOString().slice(0, 10).replace(/-/g, "");
  const wday = mid => new Date(mid + TPE).getUTCDay();                              // 0＝日
  function plan(input) {
    const { records, stops, o, d, when, time, opts } = input || {};
    const P = opts || {};
    const bad = m => ({ status: "bad-params", message: m, routes: [] });
    for (const k of ["walkRadiusM", "walkMpm", "walkFactor"]) if (!(typeof P[k] === "number" && P[k] > 0)) return bad("缺少參數 " + k + "（尚未定案的政策，必須由呼叫端明確傳入）");
    if (P.freqPolicy && P.freqPolicy !== "exclude") return bad("只有班距的路線列法尚未開放（目前只支援 exclude）");
    if (when !== "dep" && when !== "arr") return bad("when 必須是 dep 或 arr");
    const t = parseTpe(time); if (t == null) return bad("時間格式要是 YYYY-MM-DDTHH:MM（台北時間）");
    if (!o || !d || !isFinite(o.lat) || !isFinite(o.lon) || !isFinite(d.lat) || !isFinite(d.lon)) return bad("缺少起訖點座標");
    const early = typeof P.earlyLimitMin === "number" && P.earlyLimitMin > 0 ? P.earlyLimitMin : null;
    const hol = new Set(P.holidays || []), max = P.maxResults > 0 ? P.maxResults : 6;
    const st = { recs: 0, freqOnly: 0, special: 0, missingTime: 0, noCoord: 0, holidaySkipped: [], tripsChecked: 0 };
    const notes = [];
    if (early == null && when === "arr") notes.push("「提早抵達下限」尚未定案，未套用");
    if (!Array.isArray(records) || !records.length || !stops || !Object.keys(stops).length) return { status: "not-covered", reason: "雲端沒有這一區的公車時刻表或站牌資料", routes: [], stats: st, notes };
    const R = P.walkRadiusM, wm = m => Math.ceil(m * P.walkFactor / P.walkMpm);
    const near = (p) => { const m = new Map(); for (const [u, c] of Object.entries(stops)) { if (!c) continue; const x = hav(p.lat, p.lon, c[0], c[1]); if (x <= R) m.set(u, x); } return m; };
    const NO = near(o), ND = near(d);
    if (!NO.size) return { status: "not-covered", reason: "起點" + R + "公尺內沒有已收錄座標的站牌", routes: [], stats: st, notes };
    if (!ND.size) return { status: "not-covered", reason: "終點" + R + "公尺內沒有已收錄座標的站牌", routes: [], stats: st, notes };
    const q0 = dayMid(t), days = [q0 - DAY, q0, q0 + DAY].filter(m => { if (hol.has(ymd(m))) { st.holidaySkipped.push(ymd(m)); return false; } return true; });
    if (st.holidaySkipped.length) notes.push("國定假日（" + st.holidaySkipped.join("、") + "）的公車班表規則尚未支援，那天不列");
    const best = new Map();
    for (const r of records) {
      st.recs++;
      const S = r.st || [];
      if (!(r.tr && r.tr.length)) { if (r.f && r.f.length) st.freqOnly++; continue; }
      const iO = [], iD = [];
      S.forEach((s, i) => { if (!stops[s[0]]) { if (NO.has(s[0]) || ND.has(s[0])) st.noCoord++; return; } if (NO.has(s[0])) iO.push(i); if (ND.has(s[0])) iD.push(i); });
      if (!iO.length || !iD.length) continue;
      for (const [k, tr] of r.tr.entries()) {
        const [mask, base, pi, sp] = tr, pat = (r.p || [])[pi] || [];
        if (sp !== -1 && sp != null && sp !== "") { st.special++; continue; }
        for (const mid of days) {
          if (!(mask >> wday(mid) & 1)) continue;
          st.tripsChecked++;
          for (const i of iO) for (const j of iD) {
            if (j <= i) continue;
            const a = pat[i], b = pat[j];
            if (a == null || b == null || a < 0 || b < 0) { st.missingTime++; continue; }
            const dep = mid + (base + a) * 60000, arr = mid + (base + b) * 60000;
            const wo = wm(NO.get(S[i][0])), wd = wm(ND.get(S[j][0]));
            const start = dep - wo * 60000, end = arr + wd * 60000;
            if (when === "dep" ? start < t : end > t) continue;
            if (early != null && when === "arr" && t - end > early * 60000) continue;
            const key = r.u + "|" + r.s + "|" + r.d + "|" + k + "|" + mid;
            const c = { src: "own-bus", confidence: "timetable", routeUID: r.u, name: r.n, sub: r.sn || "", dir: r.d,
              from: { uid: S[i][0], name: S[i][1], time: isoTpe(dep), seq: i }, to: { uid: S[j][0], name: S[j][1], time: isoTpe(arr), seq: j },
              walkO: { m: Math.round(NO.get(S[i][0])), min: wo }, walkD: { m: Math.round(ND.get(S[j][0])), min: wd },
              start, end, startIso: isoTpe(start), endIso: isoTpe(end), ride: Math.round((arr - dep) / 60000), serviceDate: ymd(mid) };
            const o2 = best.get(key);
            if (!o2 || (when === "dep" ? c.end < o2.end || (c.end === o2.end && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m) : c.start > o2.start || (c.start === o2.start && c.walkO.m + c.walkD.m < o2.walkO.m + o2.walkD.m))) best.set(key, c);
          }
        }
      }
    }
    let routes = [...best.values()];
    routes.sort(when === "dep" ? (a, b) => a.end - b.end || a.start - b.start : (a, b) => b.start - a.start || a.end - b.end);
    // 同一路線同方向只留最好的一班
    const seen = new Set(); routes = routes.filter(r => { const k = r.routeUID + "|" + r.sub + "|" + r.dir; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
    if (st.freqOnly) notes.push(st.freqOnly + " 條只有班距的路線未列（列法尚未定案）");
    if (st.special) notes.push(st.special + " 班有特殊日規則的班次未列（規則尚未支援）");
    if (st.missingTime) notes.push("有 " + st.missingTime + " 個上下車站組合缺表定時刻，未列");
    return { status: routes.length ? "ok" : "no-route", reason: routes.length ? null : "已收錄的時刻表內沒有符合條件的直達班次", routes, stats: st, notes };
  }
  // 整版一致性（試行）：meta.t 是 Worker 收到上傳的時間，分片內的 t 是管理者瀏覽器打包的時間，兩者本來就不同；
  // 所以檢查：分片數＝meta.n、每片 k 與城市對得上、所有分片的打包時間 t 相同（同一次打包）、每片回應標頭的 meta.t（hdrT）都等於這次用的 meta.t（下載途中換版就整包拒用）
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
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) root.onmessage = e => { let out; try { out = plan(e.data); } catch (x) { out = { status: "error", message: String(x && x.message || x), routes: [] }; } root.postMessage({ id: e.data && e.data.id, out }); };
})(typeof self !== "undefined" ? self : this);
