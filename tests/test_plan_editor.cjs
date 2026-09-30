
const {test} = require("node:test");
const assert = require("node:assert/strict");
const S = require("../plan-structure.js");
const C = require("../workout-comparison.js");
const block = (value, unit = "min", intensity = "Z2") => ({...S.range(value, unit), intensity});
const structure = (overrides={}) => ({version:1, mode:"repeats", count:5, warmup:block("15-20"), work:block("1000","m","Усилие 10 км"), recovery:block("150","sec","Z1"), cooldown:block("10"), notes:"", ...overrides});
const day = s => ({plannedStructure:s, plannedWorkout:S.format(s), details:S.format(s), intensity:s.work.intensity, focus:"Интервалы"});
test("editor ranges and units normalize without losing lower/upper bounds",()=>{
  assert.deepEqual(S.range("1,5–2", "km"), {basis:"distance",from:1500,to:2000});
  assert.deepEqual(S.range("2.5", "min"), {basis:"duration",from:150,to:150});
  for(const value of ["", "0", "-1", "20-10", "Infinity", "NaN", "2:99", "<script>", "1-2-3"]) assert.throws(()=>S.range(value,"min"));
});
test("invalid schemas, incomplete repeats and excessive counts fail closed",()=>{
  for(const s of [null,{},structure({version:2}),structure({mode:"invalid"}),structure({count:0}),structure({count:1}),structure({count:2.5}),structure({count:101}),structure({recovery:null}),structure({work:block("1","min","")})]) assert.equal(S.normalize(s),null);
});
test("text, JSON and structured editor round trip",()=>{
  const s=structure({notes:"Контролируемо."});
  const value=JSON.parse(JSON.stringify(day(s)));
  assert.deepEqual(S.fromDay(value),S.normalize(s));
  assert.match(value.plannedWorkout,/5 x 1 км/);
  assert.match(value.plannedWorkout,/15-20 мин/);
  assert.match(value.plannedWorkout,/2.5 мин.*между повторениями/);
  assert.equal(S.format(S.fromDay(value)),value.plannedWorkout);
});
test("edited text or intensity invalidates stale structure",()=>{
  const value=day(structure());
  assert.equal(S.fromDay({...value,plannedWorkout:"40 минут легко"}),null);
  assert.equal(S.fromDay({...value,intensity:"Z1"}),null);
});
test("source schema is not mutated",()=>{
  const s=structure(), before=JSON.stringify(s);
  S.format(s); S.prescription(day(s)); S.segments(day(s),5,.85);
  assert.equal(JSON.stringify(s),before);
});
test("recoveries occur only between repetitions, not after the final work segment",()=>{
  const s=structure({count:8,warmup:block("15"),work:block("2","min","Z5"),recovery:block("1","min","Z1"),cooldown:block("10")});
  const segments=S.segments(day(s),5,.8);
  assert.deepEqual(segments.map(s=>s.duration),[15,16,7,10]);
  assert.equal(segments.reduce((n,s)=>n+s.duration,0),48);
  assert.deepEqual(segments.map(s=>s.intensity),["Z2","Z5","Z1","Z2"]);
});
test("distance based block estimates respect phase-specific pace factors",()=>{
  const values=S.segments(day(structure()),5,.85);
  assert.equal(values.find(s=>s.kind==="work").duration,21.25);
  assert.equal(values.find(s=>s.kind==="recovery").duration,10);
});
test("continuous sessions remove repetitions and recovery",()=>{
  const s=S.normalize(structure({mode:"tempo",work:block("20-25","min","Порог")}));
  assert.equal(s.count,1); assert.equal(s.recovery,null);
  assert.match(S.format(s),/Темповая часть: 20-25 мин/);
  assert.equal(S.prescription(day(s)).mode,"tempo");
});
test("easy total includes warmup/cooldown only with comparable units",()=>{
  const s=structure({mode:"easy",work:block("40"),warmup:block("10"),cooldown:block("5")});
  assert.deepEqual(S.prescription(day(s)).work,{basis:"duration",from:3300,to:3300});
  s.warmup=block("1","km");
  assert.equal(S.prescription(day(s)).supported,false);
});
test("comparison consumes explicit prescribed repetitions and recovery",()=>{
  const s=structure(), parsed=C.parse(day(s));
  assert.equal(parsed.supported,true);
  assert.equal(parsed.count.from,5); assert.equal(parsed.work.from,1000); assert.equal(parsed.recovery.from,150);
  const segments=[];
  for(let i=0;i<5;i++){segments.push({role:"work",distanceM:1000,durationSec:230}); if(i<4)segments.push({role:"recovery",durationSec:150});}
  const w={id:"a",workoutStructure:{source:"tcx-manual-laps",confidence:1,segments,workGroups:[{count:5}],recoveryGroups:[{count:4}],warmupMin:18,cooldownMin:10}};
  assert.equal(C.compare(day(s),[w]).status,"matched");
  const fewer=structure({count:4});
  assert.equal(C.compare(day(fewer),[w]).status,"different");
});

const fs=require("node:fs"), vm=require("node:vm");
const source=fs.readFileSync(require("node:path").join(__dirname,"../app.js"),"utf8");
function appFunctions(names,values={}){
 const c=vm.createContext({PlanStructure:S,WorkoutComparison:C,...values});
 for(const name of names){
  const start=source.indexOf("function "+name+"("), end=source.indexOf("\nfunction ",start+1);
  assert.ok(start>=0,name); vm.runInContext(source.slice(start,end<0?undefined:end),c);
 }
 return c;
}
test("structured load sums phase intensities and excludes a fifth recovery",()=>{
 const s=structure({warmup:block("15","min","Z1"),work:block("2","min","Z5"),recovery:block("1","min","Z1"),cooldown:block("10","min","Z1")});
 const d=day(s);
 const c=appFunctions(["plannedWorkoutSegments","plannedSegmentedLoadScore","plannedDurationMinutes"],{
  recentReliablePace:()=>5,plannedFastPaceFactor:()=>.85,
  plannedWorkHrReserveRatio:d=>d.intensity==="Z5"?.9:.68,
  plannedHrReserveRatio:d=>d.intensity==="Z1"?.55:.68,
  estimateTrimpFromHrr:(duration,hrr)=>duration*hrr,
  plannedDurationFromDistance:()=>{throw new Error("Structured prescription must not gain inferred extra distance");},
  plannedEasyHrReserveRatio:()=>.68,
 });
 assert.equal(c.plannedDurationMinutes(d),39);
 assert.ok(Math.abs(c.plannedSegmentedLoadScore(d)-(15*.55+10*.9+4*.55+10*.55))<.00001);
});
test("short continuous workout is not replaced with generic fallback load",()=>{
 const d=day(structure({mode:"easy",warmup:null,cooldown:null,work:block("8","min","Z1")}));
 const c=appFunctions(["plannedSegmentedLoadScore"],{
  plannedWorkoutSegments:()=>[{duration:8,hrr:.55}],
  estimateTrimpFromHrr:(duration,hrr)=>duration*hrr,plannedEasyHrReserveRatio:()=>.68,
 });
 assert.equal(c.plannedSegmentedLoadScore(d),4.4);
});
test("day normalization and export preserve valid structure but remove stale blocks",()=>{
 const value=day(structure()); value.date="2026-09-28"; value.title="Интервальная работа";
 const c=appFunctions(["normalizePlanDay","splitPlanAndActual","structuredPlanFocus","buildExportPlanPayload"],{
  selectedWeekStartDate:()=>new Date("2026-09-28T00:00:00Z"),addDays:d=>d,
  normalizedPlanFocus:d=>d.focus,normalizedPlanTitle:d=>d.title,normalizeStoredPlan:p=>p,selectedWeekKey:()=>"2026-09-28",
 });
 const normalized=c.normalizePlanDay(value,null,0);
 assert.equal(normalized.plannedStructure.count,5);
 const exported=c.buildExportPlanPayload({days:[normalized]});
 assert.equal(exported.days[0].plannedStructure.count,5);
 const detached=c.normalizePlanDay({...value,plannedWorkout:"40 минут легко",details:"40 минут легко"},null,0);
 assert.equal(detached.plannedStructure,undefined);
});
test("editor rejects stale athlete, week, source and changed day",()=>{
 const original={date:"2026-09-28",plannedWorkout:"40 минут легко"};
 for(const change of [{athleteId:"b"},{week:"2026-10-05"},{source:"local"},{original:"{}"}]){
  let error="";
  const c=appFunctions(["saveEditedPlanDay"],{
   requireCoachForPlanChanges:()=>true,loadCurrentPlan:()=>({source:"json",days:[original]}),
   planEditForm:{elements:{dayIndex:{value:"0"}}},state:{activeAthleteId:"a"},selectedWeekKey:()=>"2026-09-28",
   planEditContext:{athleteId:"a",week:"2026-09-28",source:"json",original:JSON.stringify(original),...change},
   setPlanEditError:message=>error=message,
   saveCurrentPlan:()=>{throw new Error("Must not save");}
  });
  c.saveEditedPlanDay({preventDefault(){}});
  assert.match(error,/изменился/);
 }
});
test("student cannot invoke editor or save even by calling UI functions directly",()=>{
 let closed=false;
 const c=appFunctions(["saveEditedPlanDay","openPlanDayEditor"],{
  requireCoachForPlanChanges:()=>false,closePlanEditModal:()=>closed=true,
  loadCurrentPlan:()=>{throw new Error("Must not access plan");}
 });
 c.openPlanDayEditor(0); c.saveEditedPlanDay({preventDefault(){}});
 assert.equal(closed,true);
});
