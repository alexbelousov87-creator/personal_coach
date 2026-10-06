/* Observational comparisons only; this module never changes workouts or plans. */
(function (root) {
  "use strict";
  const TYPES = ["easy", "recovery", "long"];
  const DAY = 86400000;
  const LIMITS = {hr: 5, pace: .03, duration: .20, minDays: 3, staleDays: 14};
  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a,b) => a-b), middle = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
  };
  const dateKey = date => [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
  function surface(sport) {
    const text = String(sport || "").toLowerCase();
    if (/trail|трейл|пересеч|mountain|горный/.test(text)) return "trail";
    if (/treadmill|дорожк|indoor|в помещении/.test(text)) return "indoor";
    if (/road|шоссе|track|стадион/.test(text)) return "road";
    return "unspecified";
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
  function analyze(workouts, options = {}) {
    const now = new Date(options.now ?? Date.now());
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid date");
    const weeks = options.weeks === 12 ? 12 : 8;
    const mode = options.mode === "hr" ? "hr" : "pace";
    const type = TYPES.includes(options.type) ? options.type : "easy";
    const end = new Date(now); end.setHours(0,0,0,0); end.setDate(end.getDate()+1);
    const start = new Date(end); start.setDate(start.getDate()-weeks*7);
    const split = new Date(start); split.setDate(split.getDate()+weeks*7/2);
    const excluded = {}, eligible = [], seen = new Set();
    let total = 0;
    const skip = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
    for (const raw of Array.isArray(workouts) ? workouts : []) {
      if (!raw || typeof raw !== "object") continue;
      const stamp = new Date(raw.date).getTime();
      if (!raw.date || !Number.isFinite(stamp) || stamp < start.getTime() || stamp > now.getTime()) continue;
      const key = String(raw.id || [raw.date,raw.sport,raw.durationMin,raw.distanceKm].join("|"));
      if (seen.has(key)) continue;
      seen.add(key); total++;
      const reason = exclusion(raw);
      if (reason) { skip(reason); continue; }
      if (raw.classification.type !== type) { skip("type"); continue; }
      eligible.push({key, date: raw.date, stamp, day: dateKey(new Date(stamp)),
        pace: Number(raw.paceMinPerKm), hr: Number(raw.avgHr), duration: Number(raw.durationMin),
        distance: Number(raw.distanceKm) || null, surface: surface(raw.sport)});
    }
    eligible.sort((a,b) => b.stamp-a.stamp || a.key.localeCompare(b.key));
    const reference = eligible.find(w => w.key === options.reference) || eligible[0] || null;
    const matched = [];
    if (reference) for (const w of eligible) {
      if (w.surface !== reference.surface) { skip("surface"); continue; }
      if (Math.abs(w.duration-reference.duration) > reference.duration*LIMITS.duration + 1e-9) { skip("durationMatch"); continue; }
      if (mode === "pace" && Math.abs(w.hr-reference.hr) > LIMITS.hr) { skip("hrMatch"); continue; }
      if (mode === "hr" && Math.abs(w.pace-reference.pace) > reference.pace*LIMITS.pace + 1e-9) { skip("paceMatch"); continue; }
      matched.push({...w, period: w.stamp < split.getTime() ? "before" : "after"});
    }
    matched.sort((a,b) => a.stamp-b.stamp || a.key.localeCompare(b.key));
    function summarize(rows) {
      const days = new Map();
      for (const row of rows) { if (!days.has(row.day)) days.set(row.day, []); days.get(row.day).push(row); }
      const daily = [...days.values()];
      const perDay = metric => daily.map(values => median(values.map(w=>w[metric])));
      return {sessions:rows.length, days:days.size, pace:median(perDay("pace")), hr:median(perDay("hr")), duration:median(perDay("duration"))};
    }
    const before = summarize(matched.filter(w => w.period === "before"));
    const after = summarize(matched.filter(w => w.period === "after"));
    const latest = matched.at(-1);
    const stale = Boolean(latest && now.getTime()-latest.stamp > LIMITS.staleDays*DAY);
    const enough = before.days >= LIMITS.minDays && after.days >= LIMITS.minDays;
    const conditions = [];
    if (enough) {
      if (Math.abs(after.duration-before.duration) > reference.duration*LIMITS.duration + 1e-9) conditions.push("duration");
      if (mode === "pace" && Math.abs(after.hr-before.hr) > LIMITS.hr) conditions.push("hr");
      if (mode === "hr" && Math.abs(after.pace-before.pace) > reference.pace*LIMITS.pace + 1e-9) conditions.push("pace");
    }
    const delta = enough && !conditions.length ? after[mode]-before[mode] : null;
    const percent = delta == null ? null : delta/before[mode]*100;
    const threshold = mode === "pace" ? before.pace*.02 : 3;
    const status = !reference ? "empty" : stale ? "stale" : !enough ? "insufficient" : conditions.length ? "different" :
      Math.abs(delta) <= threshold + 1e-9 ? "stable" : delta < 0 ? "lower" : "higher";
    return {weeks, mode, type, start:dateKey(start), split:dateKey(split), end:dateKey(new Date(end.getTime()-1)),
      total, excluded, eligible, reference, matched, before, after, delta, percent, status, conditions, limits:LIMITS};
  }
  const api = {analyze, median, surface};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FitnessTrend = api;
})(globalThis);