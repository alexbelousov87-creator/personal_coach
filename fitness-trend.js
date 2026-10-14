/* Observational comparisons only; this module never changes workouts or plans. */
(function (root) {
  "use strict";
  const TYPES = ["easy", "recovery", "long"];
  const SURFACES = ["unspecified", "road", "track", "treadmill", "indoor", "trail"];
  const DAY = 86400000;
  const LIMITS = Object.freeze({hr: 5, pace: .03, duration: .20, minDays: 3, staleDays: 14});
  function quantile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a,b) => a-b), index = (sorted.length-1)*fraction;
    const lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi]-sorted[lo])*(index-lo);
  }
  const median = values => quantile(values, .5);
  const dateKey = date => [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
  const calendarDate = value => new Date(value+"T12:00:00");
  function surface(sport) {
    const text = String(sport || "").toLowerCase();
    if (/trail|трейл|пересеч|mountain|горный/.test(text)) return "trail";
    if (/treadmill|дорожк/.test(text)) return "treadmill";
    if (/indoor|в помещении/.test(text)) return "indoor";
    if (/track|стадион/.test(text)) return "track";
    if (/road|шоссе/.test(text)) return "road";
    return "unspecified";
  }
  function normalizeCriteria(value = {}) {
    const c = value && typeof value === "object" ? value : {};
    const valid = (n, lo, hi, fallback) => Number.isFinite(Number(n)) && Number(n) >= lo && Number(n) <= hi ? Number(n) : fallback;
    return {duration:valid(c.duration,10,240,60),hr:valid(c.hr,60,220,140),pace:valid(c.pace,2,15,5),
      surface:SURFACES.includes(c.surface) ? c.surface : "unspecified"};
  }
  function exclusion(workout) {
    if (!workout.running) return "sport";
    const c = workout.classification;
    if (!c || !["manual","medium","high"].includes(c.confidence) || c.needsReview) return "uncertain";
    if (!TYPES.includes(c.type)) return "quality";
    if (workout.lapSignals?.hasIntervalLaps || workout.lapSignals?.hasTempoLaps ||
        ["intervals", "tempo-blocks", "tempo-continuous"].includes(workout.workoutStructure?.kind)) return "quality";
    const pace = Number(workout.paceMinPerKm), hr = Number(workout.avgHr), duration = Number(workout.durationMin);
    if (!workout.paceSource || !Number.isFinite(pace) || pace < 2 || pace > 15) return "pace";
    if (!Number.isFinite(hr) || hr < 60 || hr > 220) return "hr";
    if (!Number.isFinite(duration) || duration < 10 || duration > 240) return "duration";
    return "";
  }
  function summarize(rows) {
    const groups = new Map();
    for (const row of rows) { if (!groups.has(row.day)) groups.set(row.day, []); groups.get(row.day).push(row); }
    const daily = [...groups.entries()].map(([day, values]) => ({day,
      ...Object.fromEntries(["pace","hr","duration"].map(metric => [metric, median(values.map(w=>w[metric]))]))}));
    const values = metric => daily.map(w=>w[metric]);
    return {sessions:rows.length, days:daily.length, daily,
      ...Object.fromEntries(["pace","hr","duration"].map(metric=>[metric,median(values(metric))]))};
  }
  function weeklySeries(rows, start, end, mode) {
    const cursor = calendarDate(start);
    cursor.setDate(cursor.getDate()-(cursor.getDay()+6)%7);
    const weeks = [];
    while (dateKey(cursor) <= end) {
      const weekStart = dateKey(cursor);
      cursor.setDate(cursor.getDate()+7);
      const next = dateKey(cursor), last = calendarDate(next); last.setDate(last.getDate()-1);
      const weekEnd = dateKey(last), s = summarize(rows.filter(w=>w.day>=weekStart && w.day<next));
      const values = s.daily.map(w=>w[mode]);
      weeks.push({weekStart,weekEnd,partial:weekStart<start || weekEnd>end,...s,
        value:s[mode],q1:s.days>=3 ? quantile(values,.25) : null,q3:s.days>=3 ? quantile(values,.75) : null});
    }
    return weeks;
  }
  function analyze(workouts, options = {}) {
    const now = new Date(options.now ?? Date.now());
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid date");
    const weeks = options.weeks === 12 ? 12 : 8;
    const mode = options.mode === "hr" ? "hr" : "pace";
    const type = TYPES.includes(options.type) ? options.type : "easy";
    const criteria = normalizeCriteria(options.criteria);
    const end = new Date(now); end.setHours(0,0,0,0); end.setDate(end.getDate()+1);
    const start = new Date(end); start.setDate(start.getDate()-weeks*7);
    const split = new Date(start); split.setDate(split.getDate()+weeks*7/2);
    const excluded = {}, eligible = [], excludedRecords = [], seen = new Set();
    let total = 0;
    const skip = (reason, row) => { excluded[reason] = (excluded[reason] || 0) + 1; excludedRecords.push({...row,reason}); };
    for (const raw of Array.isArray(workouts) ? workouts : []) {
      if (!raw || typeof raw !== "object") continue;
      const stamp = new Date(raw.date).getTime();
      if (!raw.date || !Number.isFinite(stamp) || stamp < start.getTime() || stamp > now.getTime()) continue;
      const key = String(raw.id || [raw.date,raw.sport,raw.durationMin,raw.distanceKm].join("|"));
      if (seen.has(key)) continue;
      seen.add(key); total++;
      const row = {key,date:raw.date,stamp,day:dateKey(new Date(stamp)),sport:String(raw.sport || ""),
        pace:Number(raw.paceMinPerKm),hr:Number(raw.avgHr),duration:Number(raw.durationMin),
        distance:Number(raw.distanceKm) || null,surface:surface(raw.sport)};
      const reason = exclusion(raw);
      if (reason) { skip(reason,row); continue; }
      if (raw.classification.type !== type) { skip("type",row); continue; }
      eligible.push(row);
    }
    eligible.sort((a,b) => a.stamp-b.stamp || a.key.localeCompare(b.key));
    const matched = [];
    for (const w of eligible) {
      if (w.surface !== criteria.surface) { skip("surface",w); continue; }
      if (Math.abs(w.duration-criteria.duration) > criteria.duration*LIMITS.duration + 1e-9) { skip("durationMatch",w); continue; }
      if (mode === "pace" && Math.abs(w.hr-criteria.hr) > LIMITS.hr) { skip("hrMatch",w); continue; }
      if (mode === "hr" && Math.abs(w.pace-criteria.pace) > criteria.pace*LIMITS.pace + 1e-9) { skip("paceMatch",w); continue; }
      matched.push({...w,period:w.stamp<split.getTime() ? "before" : "after"});
    }
    excludedRecords.sort((a,b)=>b.stamp-a.stamp || a.key.localeCompare(b.key));
    const before = summarize(matched.filter(w => w.period === "before"));
    const after = summarize(matched.filter(w => w.period === "after"));
    const latest = matched.at(-1);
    const stale = Boolean(latest && now.getTime()-latest.stamp > LIMITS.staleDays*DAY);
    const enough = before.days >= LIMITS.minDays && after.days >= LIMITS.minDays;
    const conditions = [];
    if (enough) {
      if (Math.abs(after.duration-before.duration) > criteria.duration*LIMITS.duration + 1e-9) conditions.push("duration");
      if (mode === "pace" && Math.abs(after.hr-before.hr) > LIMITS.hr) conditions.push("hr");
      if (mode === "hr" && Math.abs(after.pace-before.pace) > criteria.pace*LIMITS.pace + 1e-9) conditions.push("pace");
    }
    const delta = enough && !conditions.length ? after[mode]-before[mode] : null;
    const percent = delta == null ? null : delta/before[mode]*100;
    const threshold = mode === "pace" ? before.pace*.02 : 3;
    const scatter = s => median(s.daily.map(w=>Math.abs(w[mode]-s[mode])));
    const variability = enough ? Math.max(scatter(before),scatter(after)) : null;
    const status = !matched.length ? "empty" : stale ? "stale" : !enough ? "insufficient" : conditions.length ? "different" :
      Math.abs(delta) <= threshold + 1e-9 ? "stable" : Math.abs(delta) <= variability ? "variable" : delta < 0 ? "lower" : "higher";
    const startKey=dateKey(start), endKey=dateKey(new Date(end.getTime()-1));
    return {weeks,mode,type,start:startKey,split:dateKey(split),end:endKey,total,excluded,excludedRecords,eligible,criteria,
      matched,before,after,delta,percent,status,conditions,variability,limits:LIMITS,
      latestDay:latest?.day || null, weekly:weeklySeries(matched,startKey,endKey,mode)};
  }
  // Suggestions are explicit: analyze never changes its criteria when data arrives.
  function suggestCriteria(workouts, options = {}) {
    const r = analyze(workouts,options);
    let candidates = r.eligible;
    const environment = SURFACES.includes(options.surface) ? options.surface : SURFACES.slice().sort((a,b)=>
      candidates.filter(w=>w.surface===b).length-candidates.filter(w=>w.surface===a).length)[0];
    candidates = candidates.filter(w=>w.surface===environment);
    if (!candidates.length) return null;
    const baseline = candidates.filter(w=>w.day<r.split);
    const s = summarize(summarize(baseline).days>=3 ? baseline : candidates);
    return normalizeCriteria({duration:Math.round(s.duration),hr:Math.round(s.hr),pace:Math.round(s.pace*60)/60,surface:environment});
  }
  const api = {analyze,median,quantile,surface,normalizeCriteria,suggestCriteria};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FitnessTrend = api;
})(globalThis);