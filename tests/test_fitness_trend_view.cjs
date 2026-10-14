const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const FitnessTrend=require("../fitness-trend.js");
const source=fs.readFileSync(path.join(__dirname,"../fitness-trend-view.js"),"utf8");
function workouts() {
 return [50,43,36,21,14,7].map((days,i)=>{
  const date=new Date();date.setDate(date.getDate()-days);date.setHours(8,0,0,0);
  return {id:"w"+i,date:date.toISOString(),running:true,sport:"Running",classification:{type:"easy",confidence:"manual"},
   durationMin:60,paceMinPerKm:days>28?5:4.8,avgHr:140,paceSource:"imported"};
 });
}
function harness({storage=new Map(),blocked=false,initial=workouts()}={}) {
 const elements=new Map(),listeners={};
 const el=id=>{
  if(!elements.has(id))elements.set(id,{value:"",innerHTML:"",textContent:"",hidden:false,disabled:false,dataset:{},events:{},
   addEventListener(name,fn){this.events[name]=fn;},setCustomValidity(message){this.validation=message;},reportValidity(){},
   replaceChildren(){this.innerHTML="";},querySelectorAll(){return [];}});
  return elements.get(id);
 };
 const state={activeAthleteId:"one",coachProfile:{id:"coach"},auth:{coachId:"coach"},workouts:initial};
 const c=vm.createContext({state,FitnessTrend,document:{getElementById:el,addEventListener:(name,fn)=>listeners[name]=fn},
  escapeHtml:v=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),
  isRunningWorkout:w=>w.running,getWorkoutClassification:w=>w.classification,activeAthlete:()=>({name:state.activeAthleteId}),
  localStorage:{getItem(key){if(blocked)throw Error("Blocked");return storage.get(key)||null;},setItem(key,value){if(blocked)throw Error("Blocked");storage.set(key,value);}}});
 vm.runInContext(source,c);listeners.DOMContentLoaded();c.FitnessTrendView.render();
 const event=(id,type)=>el(id).events[type]({preventDefault(){}});
 return {el,state,storage,render:()=>c.FitnessTrendView.render(),event};
}
test("initial suggested criteria freeze across imports, repeated renders and periods",()=>{
 const h=harness(),criteria=h.el("fitnessCriteria").textContent;
 h.state.workouts.push({...h.state.workouts[0],id:"new",durationMin:150,avgHr:190});h.render();
 assert.equal(h.el("fitnessCriteria").textContent,criteria);
 h.el("fitnessPeriod").value="12";h.event("fitnessPeriod","change");
 assert.equal(h.el("fitnessCriteria").textContent,criteria);
 assert.ok(h.storage.size===1);
});
test("local criteria survive reload and remain isolated by athlete and coach",()=>{
 const h=harness();h.el("fitnessHr").value="150";h.event("fitnessSettings","submit");
 const restored=harness({storage:h.storage});assert.equal(restored.el("fitnessHr").value,150);
 h.state.activeAthleteId="two";h.render();assert.equal(h.el("fitnessHr").value,140);
 h.state.activeAthleteId="one";h.state.auth.coachId="other-coach";h.render();assert.equal(h.el("fitnessHr").value,140);
 h.state.auth.coachId="coach";h.render();assert.equal(h.el("fitnessHr").value,150);
});
test("empty loading state does not freeze default criteria",()=>{
 const h=harness({initial:[]});assert.equal(h.storage.size,0);
 h.state.workouts=workouts().map(w=>({...w,avgHr:160}));h.render();
 assert.equal(h.el("fitnessHr").value,160);assert.equal(h.storage.size,1);
});
test("blocked local storage uses in-memory settings and reports its limitation",()=>{
 const h=harness({blocked:true});h.el("fitnessHr").value="151";h.event("fitnessSettings","submit");
 h.state.activeAthleteId="two";h.render();h.state.activeAthleteId="one";h.render();
 assert.equal(h.el("fitnessHr").value,151);
 assert.match(h.el("fitnessFreshness").textContent,/только до закрытия страницы/);
});
test("trend controls and renders never mutate application workouts or profile",()=>{
 const h=harness(),before=JSON.stringify(h.state);
 h.el("fitnessMode").value="hr";h.event("fitnessMode","change");
 h.event("fitnessSuggest","click");h.render();assert.equal(JSON.stringify(h.state),before);
});
test("selection details escape imported labels",()=>{
 const values=workouts();values[0].sport='<img src=x onerror="alert(1)">';
 const h=harness({initial:values});assert.ok(!h.el("fitnessTable").innerHTML.includes('<img'));
 assert.match(h.el("fitnessTable").innerHTML,/&lt;img/);
});
test("invalid pace cannot silently replace the saved criteria",()=>{
 const h=harness();h.el("fitnessMode").value="hr";h.event("fitnessMode","change");
 const before=[...h.storage.values()][0];h.el("fitnessPace").value="5:99";h.event("fitnessSettings","submit");
 assert.equal([...h.storage.values()][0],before);assert.ok(h.el("fitnessPace").validation);
 h.el("fitnessPace").value="4:40";h.event("fitnessPace","input");h.event("fitnessSettings","submit");
 assert.equal(h.el("fitnessPace").validation,"");assert.match(h.el("fitnessCriteria").textContent,/4:32–4:48/);
});
test("pending surface selection updates availability of explicit recalibration",()=>{
 const h=harness();assert.equal(h.el("fitnessSuggest").disabled,false);
 h.el("fitnessSurface").value="trail";h.event("fitnessSurface","change");assert.equal(h.el("fitnessSuggest").disabled,true);
 h.el("fitnessSurface").value="unspecified";h.event("fitnessSurface","change");assert.equal(h.el("fitnessSuggest").disabled,false);
});
test("bad persisted criteria are normalized and cannot create a NaN plot",()=>{
 const storage=new Map([["runflow:aerobic:v2:"+JSON.stringify(["coach","one"]),JSON.stringify({mode:"hr",criteria:{easy:{hr:-1,pace:"bad",duration:0,surface:"bad"}}})]]);
 const h=harness({storage});assert.equal(h.el("fitnessHr").value,140);
 assert.ok(!h.el("fitnessChart").innerHTML.includes("NaN"));
});