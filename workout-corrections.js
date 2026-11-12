/* Corrections affect totals only; source laps and TRIMP remain unchanged. */
(function(root) {
  "use strict";
  function apply(workout) {
    const w={...workout},c=w.manualCorrection;
    if (!c?.original) return w;
    if (c.active) {
      const p=c.paceMinPerKm || null,s=p ? Math.round(p*60) : 0;
      Object.assign(w,{distanceKm:c.distanceKm,paceMinPerKm:p,pace:p ? `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")} мин/км` : "",
        paceSource:p ? "manual" : "",avgSpeed:null});
    } else {
      for (const key of ["distanceKm","paceMinPerKm","pace","paceSource","avgSpeed"]) w[key]=c.original[key] ?? null;
    }
    return w;
  }
  function preserve(base,...sources) {
    const candidates=sources.map(w=>w?.manualCorrection).filter(c=>c?.original)
      .sort((a,b)=>String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const w={...base};delete w.manualCorrection;
    if (candidates.length) w.manualCorrection=candidates[0];
    return apply(w);
  }
  const api={apply,preserve};
  if (typeof module==="object" && module.exports) module.exports=api;
  else root.WorkoutCorrections=api;
})(globalThis);
