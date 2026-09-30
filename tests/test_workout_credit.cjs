
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const C = require("../workout-comparison.js");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const prescription = () => ({
  date: "2026-09-29T00:00:00.000Z", focus: "Интервалы",
  plannedWorkout: "Разминка 18 минут; затем 5 x 1000 м в усилии 10 км; восстановление 150 секунд; заминка 12 минут.",
  intensity: "Усилие 10 км", targetDistance: "12-15 км",
});
function workout(count=5, restSec=150) {
  const segments = [];
  for (let i=0; i<count; i++) {
    segments.push({role:"work",durationSec:220,distanceM:1000,avgHr:165});
    if (i<count-1) segments.push({role:"recovery",durationSec:restSec,distanceM:300,avgHr:169});
  }
  return {id:"actual",date:"2026-09-29T06:00:00Z",sport:"Running",durationMin:60,distanceKm:13,load:130,avgHr:155,
    workoutStructure:{source:"tcx-manual-laps",confidence:.96,kind:"intervals",warmupMin:18,cooldownMin:12,
      workGroups:[{count}],recoveryGroups:[{count:count-1}],segments}};
}
function app(names, values={}) {
  const context = vm.createContext({WorkoutComparison:C,...values});
  for (const name of names) {
    let start=source.indexOf("function "+name+"(");
    assert.ok(start>=0,name);
    if(source.slice(start-6,start)==="async ")start-=6;
    const end=source.indexOf("\nfunction ",start+10);
    vm.runInContext(source.slice(start,end<0?undefined:end),context);
  }
  return context;
}
function evaluation(d,w,base={}) {
  return app(["evaluatePlanDayExecution"],{
    actualWorkoutsForPlanDay:()=>w,isRunningWorkout:x=>x.sport==="Running",
    plannedTypeForDay:()=>d.focus==="Гонка"?"race":"interval",plannedLoadScoreForDay:()=>130,
    evaluatePlanDayLoadAndType:()=>({show:true,completed:true,keyCompleted:false,typeUncertain:true,
      level:"uncertain",label:"тип требует уточнения",comment:"тип не подтвержден",...base}),
  }).evaluatePlanDayExecution(d);
}
test("complete primary work remains creditable with a conditional reduced alternative",()=>{
  const d=prescription(); d.plannedWorkout+=" При усталости 4 x 1000 м.";
  const result=C.compare(d,[workout()]);
  assert.equal(result.coreMatches,true);
  assert.match(result.notes.join(" "),/основной вариант/);
  assert.equal(C.compare(d,[workout(4)]).coreMatches,null);
});
test("moderate recovery deviation is accepted, substantial deviation is not",()=>{
  assert.equal(C.compare(prescription(),[workout(5,180)]).coreMatches,true);
  assert.equal(C.compare(prescription(),[workout(5,240)]).coreMatches,false);
});
test("split recovery laps are summed only between their neighboring work laps",()=>{
  const w=workout(), s=w.workoutStructure;
  s.segments.splice(1,1,{role:"recovery",durationSec:50,distanceM:100,avgHr:180},
    {role:"recovery",durationSec:100,distanceM:200,avgHr:160});
  s.recoveryGroups[0].count++;
  const result=C.compare(prescription(),[w]);
  assert.equal(result.coreMatches,true);
  assert.equal(result.lapEvidence.recoveries[0].durationSec,150);
  assert.equal(result.lapEvidence.recoveries[0].avgHr,167);
});
test("HR lag during recovery does not reject real repeated work",()=>{
  const result=C.compare(prescription(),[workout()]);
  assert.equal(result.coreMatches,true);
  assert.equal(result.lapEvidence.hrPairs,4);
  assert.equal(result.lapEvidence.slowerPairs,4);
  assert.match(result.notes.join(" "),/запаздывает/);
});
test("missing recovery still requires review even without a prescribed recovery",()=>{
  const w=workout(); w.workoutStructure.segments.splice(1,1); w.workoutStructure.recoveryGroups[0].count--;
  assert.equal(C.compare({plannedWorkout:"5 x 1000 м"},[w]).coreMatches,null);
});
test("complete lap evidence can credit a session despite tentative coarse type",()=>{
  const value=evaluation(prescription(),[workout()]);
  assert.equal(value.keyCompleted,true); assert.equal(value.keyCredit,"auto");
  assert.equal(value.typeUncertain,false); assert.equal(value.level,"matched");
});
test("automatic credit never hides a high load assessment",()=>{
  const value=evaluation(prescription(),[workout()],{level:"overloaded",label:"сильно тяжелее плана"});
  assert.equal(value.keyCompleted,true); assert.equal(value.level,"overloaded");
  assert.match(value.label,/сильно тяжелее/);
});
test("minor warmup/cooldown differences do not raise key structure review warnings",()=>{
  const w=workout(); w.workoutStructure.warmupMin=10; w.workoutStructure.cooldownMin=null;
  const result=evaluation(prescription(),[w]);
  assert.equal(result.keyCompleted,true);
  assert.equal(result.structureUncertain,false); assert.equal(result.structureDifferent,false);
  assert.equal(result.structureComparison.status,"different");
});
test("manual confirmation survives reload but expires when assignment or fact changes",()=>{
  const d=prescription(),w=workout();
  d.keyConfirmation={version:1,snapshot:C.confirmationSnapshot(d,[w]),by:"Coach",confirmedAt:"2026-09-30T06:00:00Z"};
  assert.ok(C.confirmation(JSON.parse(JSON.stringify(d)),[w]));
  for (const field of ["plannedWorkout","intensity","targetDistance","focus","date"]) {
    assert.equal(C.confirmation({...d,[field]:d[field]+" changed"},[w]),null,field);
  }
  for (const changed of [{...w,load:131},{...w,id:"another"}, {...w,workoutTypeOverride:"easy"}]) {
    assert.equal(C.confirmation(d,[changed]),null);
  }
  assert.equal(C.confirmation(d,[w, {...w,id:"second"}]),null);
  assert.equal(C.confirmation(d,[]),null);
  const edited=structuredClone(w); edited.workoutStructure.segments[0].durationSec++;
  assert.equal(C.confirmation(d,[edited]),null);
});
test("snapshot is independent of object property ordering and workout ordering",()=>{
  const d=prescription(), w=workout(), other={...w,id:"b"};
  const reverse=Object.fromEntries(Object.entries(w).reverse());
  assert.equal(C.confirmationSnapshot(d,[w,other]),C.confirmationSnapshot(d,[other,reverse]));
});
test("manual key credit does not change measured load or workout data",()=>{
  const d=prescription(),w=workout(4), before=JSON.stringify(w);
  d.keyConfirmation={version:1,snapshot:C.confirmationSnapshot(d,[w]),by:"Coach",confirmedAt:"2026-09-30T06:00:00Z"};
  const result=evaluation(d,[w],{level:"overloaded"});
  assert.equal(result.keyCompleted,true); assert.equal(result.keyCredit,"manual");
  assert.equal(result.level,"overloaded"); assert.equal(result.structureDifferent,false);
  assert.equal(JSON.stringify(w),before);
  delete d.keyConfirmation;
  assert.equal(evaluation(d,[w]).keyCompleted,false);
});
test("race is not credited just because interval laps match",()=>{
  const d={...prescription(),focus:"Гонка"};
  assert.equal(evaluation(d,[workout()]).keyCompleted,false);
});
test("future race is shown as upcoming, not as an uncompleted workout",()=>{
  const context=app(["keyExecutionComment"],{plannedTypeForDay:d=>d.type});
  assert.equal(context.keyExecutionComment([{type:"interval"},{type:"race"}],
    [{keyCompleted:true},{keyCompleted:false,level:"pending"}]),"предстоит: гонка");
  assert.match(context.keyExecutionComment([{type:"interval"}],
    [{keyCompleted:false,level:"uncertain"}]),/нужна проверка/);
});
test("confirmation action is hidden for students and automatic matches",()=>{
  const context=app(["renderKeyWorkCredit"],{
    plannedTypeForDay:()=>"interval",actualWorkoutsForPlanDay:()=>[workout()],
    isRunningWorkout:()=>true,isCoachRole:()=>false,escapeHtml:String,
  });
  assert.doesNotMatch(context.renderKeyWorkCredit(prescription(),{keyCompleted:false},true),/data-confirm-plan-day/);
  context.isCoachRole=()=>true;
  assert.match(context.renderKeyWorkCredit(prescription(),{keyCompleted:false},true),/data-confirm-plan-day/);
  assert.doesNotMatch(context.renderKeyWorkCredit(prescription(),{keyCompleted:true},true),/data-confirm-plan-day/);
});
test("student cannot invoke confirmation through handler",async()=>{
  let accessChecked=false;
  const context=app(["handlePlanGridClick"],{
    requireCoachForPlanChanges:()=>{accessChecked=true;return false;},
    loadCurrentPlan:()=>{throw Error("Must not access plans");},
  });
  await context.handlePlanGridClick({target:{closest:()=>({dataset:{confirmPlanDay:prescription().date}})}});
  assert.equal(accessChecked,true);
});
test("malformed or oversized confirmation records are rejected",()=>{
  for(const value of [null,{}, {version:1,snapshot:"x",by:"Coach",confirmedAt:"invalid"},
    {version:1,snapshot:"x".repeat(200001),by:"Coach",confirmedAt:"2026-09-30"}]) {
    assert.equal(C.normalizeConfirmation(value),null);
  }
});

test("explicit alternatives for recovery accept either imported distance or time",()=>{
  const d={...prescription(),plannedWorkout:"5 x 1000 м; восстановление 400 м трусцой или 2:00-2:30 легкого бега"};
  const w=workout();
  w.workoutStructure.segments.filter(s=>s.role==="recovery").forEach(s=>s.distanceM=150);
  assert.equal(C.compare(d,[w]).coreMatches,true);
  assert.match(C.compare(d,[w]).rows.find(r=>r.label==="Восстановление между").planned,/или/);
  w.workoutStructure.segments.filter(s=>s.role==="recovery").forEach(s=>s.durationSec=300);
  assert.equal(C.compare(d,[w]).coreMatches,false);
});
test("ambiguous alternate main sessions remain unsupported",()=>{
  for(const text of ["5x1000м или 8x2 минуты; восстановление 150 секунд",
    "5x1000м; восстановление 150 секунд или полный отдых до готовности"]) {
    assert.equal(C.parse({plannedWorkout:text}).supported,false);
  }
});
test("explicit manual type correction is not overruled by automatic credit",()=>{
  const w=workout(); w.workoutTypeOverride="easy";
  assert.equal(evaluation(prescription(),[w]).keyCompleted,false);
});
test("decimal recovery minutes remain readable in either recovery option",()=>{
  const d={plannedWorkout:"5x1000м; восстановление 2.5 минуты или 400 м трусцой."};
  assert.equal(C.parse(d).supported,true);
  assert.equal(C.compare(d,[workout()]).coreMatches,true);
});

test("changing weeks still renders the selected plan after saving state",()=>{
  const calls=[];
  const context=app(["selectWeek"],{
    document:{querySelector:()=>({classList:{contains:()=>false}})},
    state:{},SELECTED_WEEK_KEY:"week",saveJson:()=>calls.push("local"),
    saveBackendState:()=>{calls.push("backend");return Promise.resolve(true);},
    renderAll:()=>calls.push("render"),restoreCurrentPlanOrGenerate:()=>calls.push("plan"),
  });
  context.selectWeek("2026-10-05");
  assert.equal(context.state.selectedWeekStart,"2026-10-05");
  assert.deepEqual(calls,["local","backend","render","plan"]);
});
