const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm");
const H=require("../plan-history.js");
const source=fs.readFileSync(require("node:path").join(__dirname,"../app.js"),"utf8");
function app(name, values) {
 const c=vm.createContext(values);
 const pattern=new RegExp("(?:async )?function "+name+"\\(");
 const start=source.search(pattern), tail=source.slice(start+1).search(/\n(?:async )?function /);
 assert.ok(start>=0);vm.runInContext(source.slice(start,tail<0?undefined:start+1+tail),c);return c;
}
const day={date:"2026-10-05",plannedWorkout:"40 minutes easy",title:"Easy",intensity:"Z2"};
test("diff excludes facts, labels and metadata",()=>{
 assert.deepEqual(H.changes({days:[day]},{days:[{...day,dateLabel:"Monday",actualWorkout:"Fact",keyConfirmation:{by:"Coach"}}],updatedAt:"now"}),[]);
});
test("diff lists changed assignment fields without mutating plans",()=>{
 const before={days:[day]}, after={days:[{...day,plannedWorkout:"50 minutes easy",intensity:"Z1"}]};
 const original=JSON.stringify([before,after]);
 assert.deepEqual(H.changes(before,after)[0].fields.map(f=>f.key),["plannedWorkout","intensity"]);
 assert.equal(JSON.stringify([before,after]),original);
});
test("legacy details and explicit planned workout compare equally",()=>{
 assert.deepEqual(H.changes({days:[{details:"Run"}]},{days:[{plannedWorkout:"Run"}]}),[]);
});
test("local correction only proposes a revision",()=>{
 let candidate;
 const c=app("adjustPlanLocally",{requireCoachForPlanChanges:()=>true,hideAdjustChoice(){},loadCurrentPlan:()=>({source:"json",days:[day]}),
 adjustRemainingPlanDays:()=>[{...day,plannedWorkout:"Rest"}],PlanHistory:{review:p=>candidate=p},saveCurrentPlan(){throw Error("Must not write before approval");}});
 c.adjustPlanLocally(); assert.equal(candidate.source,"json");assert.equal(candidate.days[0].plannedWorkout,"Rest");
});
test("automatic adjustment cannot silently change assignments",()=>{
 let message;
 const c=app("autoAdjustActiveLocalPlanIfNeeded",{isCoachRole:()=>true,selectedWeekKey:()=>"week",currentWeekKey:()=>"week",getCurrentWeekPlan:()=>({days:[day]}),
 selectedWeekPlans:()=>({activePlanSource:"local"}),adjustRemainingPlanDays:()=>[],buildPlanAdjustmentChanges:()=>[{}],setAiStatus:s=>message=s,
 saveCurrentPlan(){throw Error("Must not write");}});
 c.autoAdjustActiveLocalPlanIfNeeded();assert.match(message,/предложение/);
});
test("JSON for another week is proposed without navigating or writing",async()=>{
 let candidate, target;
 const c=app("handlePlanJsonFile",{requireCoachForPlanChanges:()=>true,isCoachRole:()=>true,state:{activeAthleteId:"one"},selectedWeekKey:()=>"2026-10-05",loadCurrentPlan:()=>({source:"local"}),
 planJsonInput:{value:"file"},parsePlanJsonText:JSON.parse,normalizeAiPlan:p=>p,weekKeyFromPlanDays:()=>"2026-10-12",
 PlanHistory:{review:(p,r,w)=>{candidate=p;target=w;}},setAiStatus(){throw Error("Unexpected failure");},saveCurrentPlan(){throw Error("Must not write");}});
 await c.handlePlanJsonFile({target:{files:[{text:async()=>JSON.stringify({summary:"next",days:[day]})}]}});
 assert.equal(candidate.source,"json");assert.equal(target,"2026-10-12");assert.equal(c.planJsonInput.value,"");
});
test("athlete change during file reading rejects JSON",async()=>{
 let status;
 const state={activeAthleteId:"one"};
 const c=app("handlePlanJsonFile",{requireCoachForPlanChanges:()=>true,isCoachRole:()=>true,state,selectedWeekKey:()=>"week",loadCurrentPlan:()=>({source:"json"}),
 planJsonInput:{value:"file"},parsePlanJsonText:JSON.parse,setAiStatus:s=>status=s,PlanHistory:{review(){throw Error("Wrong athlete");}}});
 await c.handlePlanJsonFile({target:{files:[{text:async()=>{state.activeAthleteId="two";return "{}";}}]}});
 assert.match(status,/изменился/);
});
test("student JSON import is rejected before reading the file",async()=>{
 const c=app("handlePlanJsonFile",{requireCoachForPlanChanges:()=>false,planJsonInput:{value:"file"}});
 await c.handlePlanJsonFile({target:{files:[{text(){throw Error("Must not read");}}]}});
 assert.equal(c.planJsonInput.value,"");
});