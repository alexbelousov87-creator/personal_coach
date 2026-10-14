const {test}=require("node:test");
const assert=require("node:assert/strict");
const F=require("../fitness-trend.js");
const now=new Date(2026,9,6,12);
const ago=days=>{const d=new Date(now);d.setDate(d.getDate()-days);return d.toISOString();};
function run(days, extra={}) {return {id:"run-"+days,date:ago(days),running:true,sport:"Running",classification:{type:"easy",confidence:"medium"},durationMin:60,paceMinPerKm:5,paceSource:"imported",avgHr:140,distanceKm:12,...extra};}
const workouts=()=>[50,43,36,21,14,7].map(days=>run(days,{paceMinPerKm:days<28?4.8:5}));
const analyze=(values,options={})=>F.analyze(values,{now,...options});
test("pace comparison uses six comparable days across two calendar halves",()=>{
 const r=analyze(workouts());assert.equal(r.status,"lower");assert.deepEqual(r.criteria,{duration:60,hr:140,pace:5,surface:"unspecified"});
 assert.equal(r.before.days,3);assert.equal(r.after.days,3);assert.equal(r.before.pace,5);assert.equal(r.after.pace,4.8);
 assert.ok(Math.abs(r.percent+4)<1e-8);assert.equal(r.matched.length,6);
});
test("HR comparison constrains pace instead of HR",()=>{
 const values=[50,43,36,21,14,7].map(days=>run(days,{avgHr:days<28?135:145}));
 assert.equal(analyze(values).status,"different");
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
 assert.equal(analyze([run(1),run(2,{classification:{type:"long",confidence:"medium"}})],{type:"long"}).matched[0].key,"run-2");
});
test("duration and HR tolerances are inclusive, anchored to fixed criteria",()=>{
 const values=[run(1),run(2,{durationMin:48,avgHr:145}),run(3,{durationMin:72,avgHr:135}),run(4,{durationMin:72.01}),run(5,{avgHr:146})];
 const r=analyze(values);assert.equal(r.matched.length,3);assert.equal(r.excluded.durationMatch,1);assert.equal(r.excluded.hrMatch,1);
});
test("pace tolerance for pulse comparison is inclusive",()=>{
 const r=analyze([run(1),run(2,{paceMinPerKm:5.15}),run(3,{paceMinPerKm:4.85}),run(4,{paceMinPerKm:5.151})],{mode:"hr"});
 assert.equal(r.matched.length,3);assert.equal(r.excluded.paceMatch,1);
});
test("explicit criteria change the cohort; obsolete references have no effect",()=>{
 const values=[run(1),run(2,{durationMin:100}),run(3,{durationMin:95})];
 assert.equal(analyze(values).matched.length,1);
 assert.equal(analyze(values,{criteria:{duration:100}}).matched.length,2);
 assert.equal(analyze(values,{reference:"other-athlete"}).matched[0].key,"run-1");
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
  const r=analyze(values);assert.equal(r.status,"empty");assert.equal(r.latestDay,null);assert.equal(r.delta,null);assert.equal(r.before.pace,null);
 }
});
test("every in-range unique record is either selected or excluded once",()=>{
 const values=[...workouts(),run(1,{running:false}),run(2,{avgHr:170}),run(3,{durationMin:100})];
 const r=analyze(values);assert.equal(r.matched.length+Object.values(r.excluded).reduce((a,b)=>a+b,0),r.total);
});
test("median and environment helpers",()=>{
 assert.equal(F.median([]),null);assert.equal(F.median([6,1,3,2]),2.5);
 assert.equal(F.surface("Бег на дорожке"),"treadmill");assert.equal(F.surface("Trail Running"),"trail");assert.equal(F.surface("Шоссе"),"road");
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
test("a new unrelated workout cannot move existing selection boundaries",()=>{
 const values=workouts(),before=analyze(values);
 const after=analyze([...values,run(0,{durationMin:110,avgHr:180,sport:"Trail running"})]);
 assert.deepEqual(after.criteria,before.criteria);
 assert.deepEqual(after.matched,before.matched);
 assert.equal(after.excluded.surface,1);
});
test("changing period never recalibrates fixed criteria",()=>{
 const criteria={duration:70,hr:150,pace:4.5,surface:"road"};
 assert.deepEqual(analyze(workouts(),{criteria,weeks:8}).criteria,analyze(workouts(),{criteria,weeks:12}).criteria);
});
test("suggestions use baseline day medians and never alter an analysis",()=>{
 const values=[...workouts(),run(0,{durationMin:100,avgHr:190})];
 const c=F.suggestCriteria(values,{now});
 assert.equal(c.hr,140);assert.equal(c.duration,60);assert.equal(c.pace,5);
 assert.equal(F.suggestCriteria([],{now}),null);
 assert.equal(F.suggestCriteria(values,{now,surface:"trail"}),null);
 const before=JSON.stringify(values);F.suggestCriteria(values,{now});assert.equal(JSON.stringify(values),before);
});
test("track, treadmill, indoor, road and unknown remain separate",()=>{
 const sports=["Running","Road running","Track running","Treadmill running","Indoor running","Trail running"];
 const r=analyze(sports.map((sport,i)=>run(i+1,{sport})),{criteria:{surface:"track"}});
 assert.equal(r.matched.length,1);assert.equal(r.matched[0].surface,"track");assert.equal(r.excluded.surface,5);
 assert.equal(F.surface("Бег на стадионе"),"track");
});
test("weekly bins are Monday based, include empty weeks and mark partial edges",()=>{
 const r=analyze([run(1),run(50)]);
 assert.ok(r.weekly.some(w=>w.days===0 && w.value===null));
 for (const w of r.weekly) assert.equal(new Date(w.weekStart+"T12:00:00").getDay(),1);
 assert.equal(r.weekly[0].partial,true);assert.equal(r.weekly.at(-1).partial,true);
 assert.equal(r.weekly.reduce((n,w)=>n+w.sessions,0),2);
});
test("weekly dispersion requires three distinct days and uses daily medians",()=>{
 const values=[run(1,{paceMinPerKm:4}),run(2,{paceMinPerKm:5}),run(3,{paceMinPerKm:6})];
 // Keep all sessions within the same calendar week.
 values.forEach((w,i)=>w.date=`2026-09-${21+i}T08:00:00`);
 let w=analyze(values).weekly.find(w=>w.days===3);
 assert.equal(w.value,5);assert.equal(w.q1,4.5);assert.equal(w.q3,5.5);
 const copies=Array.from({length:10},(_,i)=>({...values[0],id:"same-day-"+i}));
 w=analyze([...values,...copies]).weekly.find(w=>w.days===3);
 assert.equal(w.value,5);assert.equal(w.sessions,13);
 for(const row of analyze(values.slice(0,2)).weekly) {assert.equal(row.q1,null);assert.equal(row.q3,null);}
});
test("each excluded record carries the first applicable reason",()=>{
 const r=analyze([run(1,{running:false,avgHr:0}),run(2,{avgHr:180}),...workouts()]);
 assert.equal(r.excludedRecords.length,2);
 assert.equal(r.excludedRecords.find(w=>w.key==="run-1").reason,"sport");
 assert.equal(r.excludedRecords.find(w=>w.key==="run-2").reason,"hrMatch");
 assert.equal(r.matched.length+r.excludedRecords.length,r.total);
});
test("large ordinary scatter suppresses a directional conclusion",()=>{
 const before=[4,5,6],after=[4.2,5.2,6.2];
 const values=[50,43,36,21,14,7].map((d,i)=>run(d,{paceMinPerKm:i<3?before[i]:after[i-3]}));
 const r=analyze(values);assert.equal(r.status,"variable");assert.ok(r.delta>0);assert.equal(r.variability,1);
});
test("criteria reject invalid persisted settings without NaN or impossible ranges",()=>{
 assert.deepEqual(F.normalizeCriteria({duration:Infinity,hr:0,pace:"bad",surface:"evil"}),{duration:60,hr:140,pace:5,surface:"unspecified"});
 assert.deepEqual(F.normalizeCriteria(null),F.normalizeCriteria());
});
test("weekly median and imported raw values are preserved in HR mode",()=>{
 const r=analyze(workouts().map(w=>({...w,paceMinPerKm:5})),{mode:"hr"});
 for (const w of r.weekly.filter(w=>w.days)) assert.equal(w.value,140);
 assert.equal(F.quantile([1,2,3,4],.25),1.75);
});