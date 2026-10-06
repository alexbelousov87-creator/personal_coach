const {test}=require("node:test");
const assert=require("node:assert/strict");
const F=require("../fitness-trend.js");
const now=new Date(2026,9,6,12);
const ago=days=>{const d=new Date(now);d.setDate(d.getDate()-days);return d.toISOString();};
function run(days, extra={}) {return {id:"run-"+days,date:ago(days),running:true,sport:"Running",classification:{type:"easy",confidence:"medium"},durationMin:60,paceMinPerKm:5,paceSource:"imported",avgHr:140,distanceKm:12,...extra};}
const workouts=()=>[50,43,36,21,14,7].map(days=>run(days,{paceMinPerKm:days<28?4.8:5}));
const analyze=(values,options={})=>F.analyze(values,{now,...options});
test("pace comparison uses six comparable days across two calendar halves",()=>{
 const r=analyze(workouts());assert.equal(r.status,"lower");assert.equal(r.reference.key,"run-7");
 assert.equal(r.before.days,3);assert.equal(r.after.days,3);assert.equal(r.before.pace,5);assert.equal(r.after.pace,4.8);
 assert.ok(Math.abs(r.percent+4)<1e-8);assert.equal(r.matched.length,6);
});
test("HR comparison constrains pace instead of HR",()=>{
 const values=[50,43,36,21,14,7].map(days=>run(days,{avgHr:days<28?135:145}));
 assert.equal(analyze(values).before.days,0);
 const r=analyze(values,{mode:"hr"});assert.equal(r.status,"lower");assert.equal(r.delta,-10);
});
test("higher and stable are descriptive statuses, not inferred fitness scores",()=>{
 assert.equal(analyze(workouts().map(w=>({...w,paceMinPerKm:5}))).status,"stable");
 const r=analyze([50,43,36,21,14,7].map(days=>run(days,{paceMinPerKm:days<28?5.2:5})));
 assert.equal(r.status,"higher");assert.equal("fitnessScore" in r,false);
 const boundary=analyze([50,43,36,21,14,7].map(days=>run(days,{paceMinPerKm:days<28?4.08:4})));
 assert.equal(boundary.status,"stable");
});
test("requires three distinct days in BOTH halves",()=>{
 const values=[50,43,21,14,7].map(d=>run(d));
 values.push(run(43,{id:"second-same-day"}));
 const r=analyze(values);assert.equal(r.before.sessions,3);assert.equal(r.before.days,2);assert.equal(r.status,"insufficient");assert.equal(r.delta,null);
});
test("daily medians prevent double sessions from overweighting a day",()=>{
 const values=[50,43,36,21,14,7].map(d=>run(d));
 values.push(...Array.from({length:10},(_,i)=>run(50,{id:"double-"+i,paceMinPerKm:8})));
 assert.equal(analyze(values).before.pace,5);
});
test("missing pace is never inferred from distance or speed",()=>{
 const r=analyze([run(1,{paceMinPerKm:null,avgSpeed:12}),run(2,{paceSource:""})]);
 assert.equal(r.status,"empty");assert.equal(r.excluded.pace,2);
});
test("invalid numbers and implausible HR, pace and duration are excluded",()=>{
 for(const extra of [{paceMinPerKm:NaN},{paceMinPerKm:Infinity},{paceMinPerKm:1.4},{paceMinPerKm:20},{avgHr:0},{avgHr:NaN},{avgHr:999},{durationMin:0},{durationMin:NaN},{durationMin:999}]) {
  assert.equal(analyze([run(1,extra)]).matched.length,0);
 }
});
test("uncertain classifications, quality work and nonrunning activities are excluded",()=>{
 const r=analyze([run(1,{running:false}),run(2,{classification:{type:"easy",confidence:"low"}}),run(3,{classification:{type:"tempo",confidence:"manual"}}),run(4,{lapSignals:{hasIntervalLaps:true}}),run(5,{workoutStructure:{kind:"tempo-blocks"}}),run(6,{classification:null})]);
 assert.equal(r.status,"empty");assert.equal(r.excluded.sport,1);assert.equal(r.excluded.uncertain,2);assert.equal(r.excluded.quality,3);
});
test("even manually marked easy sessions with manual interval evidence are not compared",()=>{
 assert.equal(analyze([run(1,{classification:{type:"easy",confidence:"manual"},lapSignals:{hasTempoLaps:true}})]).matched.length,0);
});
test("types and surfaces are not mixed",()=>{
 const r=analyze([run(1),run(2,{sport:"Trail running"}),run(3,{sport:"Treadmill running"}),run(4,{classification:{type:"long",confidence:"medium"}})]);
 assert.equal(r.matched.length,1);assert.equal(r.excluded.surface,2);assert.equal(r.excluded.type,1);
 assert.equal(analyze([run(1),run(2,{classification:{type:"long",confidence:"medium"}})],{type:"long"}).reference.key,"run-2");
});
test("duration and HR tolerances are inclusive, anchored to one reference",()=>{
 const values=[run(1),run(2,{durationMin:48,avgHr:145}),run(3,{durationMin:72,avgHr:135}),run(4,{durationMin:72.01}),run(5,{avgHr:146})];
 const r=analyze(values);assert.equal(r.matched.length,3);assert.equal(r.excluded.durationMatch,1);assert.equal(r.excluded.hrMatch,1);
});
test("pace tolerance for pulse comparison is inclusive",()=>{
 const r=analyze([run(1),run(2,{paceMinPerKm:5.15}),run(3,{paceMinPerKm:4.85}),run(4,{paceMinPerKm:5.151})],{mode:"hr"});
 assert.equal(r.matched.length,3);assert.equal(r.excluded.paceMatch,1);
});
test("reference selection changes cohort and missing reference falls back safely",()=>{
 const values=[run(1),run(2,{durationMin:100}),run(3,{durationMin:95})];
 assert.equal(analyze(values).matched.length,1);
 assert.equal(analyze(values,{reference:"run-2"}).matched.length,2);
 assert.equal(analyze(values,{reference:"other-athlete"}).reference.key,"run-1");
});
test("input and options are never mutated",()=>{
 const values=workouts(),options={now,weeks:8,mode:"pace"},before=JSON.stringify([values,options]);
 F.analyze(values,options);assert.equal(JSON.stringify([values,options]),before);
});
test("future, invalid and outside-period dates are not compared",()=>{
 const r=analyze([run(-1),run(57),run(1,{date:"bad"}),run(1,{date:null}),run(7)]);
 assert.equal(r.total,1);assert.equal(r.matched.length,1);
});
test("12-week window includes older data and has a six-week midpoint",()=>{
 const values=[run(70),run(56),run(45),run(30),run(21),run(7)];
 const r=analyze(values,{weeks:12});assert.equal(r.before.days,3);assert.equal(r.after.days,3);assert.equal(r.status,"stable");
 assert.ok(analyze(values).total<6);
});
test("old cohorts cannot yield a current direction",()=>{
 const r=analyze([50,43,36,21,19,18].map(d=>run(d)));
 assert.equal(r.status,"stale");assert.equal(r.before.days,3);assert.equal(r.after.days,3);
});
test("duplicate IDs do not count twice",()=>{
 const r=analyze([...workouts(),...workouts()]);assert.equal(r.total,6);assert.equal(r.matched.length,6);
});
test("empty input has no invented values",()=>{
 for(const values of [[],null,undefined]) {
  const r=analyze(values);assert.equal(r.status,"empty");assert.equal(r.reference,null);assert.equal(r.delta,null);assert.equal(r.before.pace,null);
 }
});
test("every in-range unique record is either selected or excluded once",()=>{
 const values=[...workouts(),run(1,{running:false}),run(2,{avgHr:170}),run(3,{durationMin:100})];
 const r=analyze(values);assert.equal(r.matched.length+Object.values(r.excluded).reduce((a,b)=>a+b,0),r.total);
});
test("median and environment helpers",()=>{
 assert.equal(F.median([]),null);assert.equal(F.median([6,1,3,2]),2.5);
 assert.equal(F.surface("Бег на дорожке"),"indoor");assert.equal(F.surface("Trail Running"),"trail");assert.equal(F.surface("Шоссе"),"road");
});
test("cohort control medians must be comparable, not only individual bounds",()=>{
 const values=[50,43,36,21,14,7].map(d=>run(d,{avgHr:d>=28?145:135}));
 values.push(run(1));
 const r=analyze(values);
 assert.equal(r.matched.length,7);assert.equal(r.status,"different");assert.deepEqual(r.conditions,["hr"]);assert.equal(r.delta,null);
});
test("different duration distributions do not suggest improvement",()=>{
 const values=[50,43,36,21,14,7].map(d=>run(d,{durationMin:d>=28?72:48}));
 values.push(run(1));const r=analyze(values);
 assert.equal(r.status,"different");assert.deepEqual(r.conditions,["duration"]);
});
test("pulse trend rejects cohorts near opposite pace tolerance bounds",()=>{
 const values=[50,43,36,21,14,7].map(d=>run(d,{paceMinPerKm:d>=28?5.15:4.85}));
 values.push(run(1));const r=analyze(values,{mode:"hr"});
 assert.equal(r.status,"different");assert.deepEqual(r.conditions,["pace"]);
});
test("malformed records do not break an otherwise valid cohort",()=>{
 const r=analyze([null,false,"bad",{},...workouts()]);assert.equal(r.matched.length,6);
});