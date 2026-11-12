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
 const event=(id,type,extra={})=>el(id).events[type]({preventDefault(){},...extra});
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

test("overview contains weekly pace only; observations and spread remain in detailed analysis",()=>{
 const initial=workouts();
 for(const offset of [1,2,3,4,5,6,7]) initial.push({...initial[3],id:"extra"+offset,date:new Date(Date.now()-offset*86400000).toISOString()});
 const h=harness({initial});
 assert.equal(h.el("fitnessDetails").open,false);
 assert.match(h.el("fitnessChart").innerHTML,/data-fitness-week/);
 assert.doesNotMatch(h.el("fitnessChart").innerHTML,/data-fitness-point|fitness-band/);
 assert.match(h.el("fitnessDetailChart").innerHTML,/data-fitness-point/);
 assert.match(h.el("fitnessDetailChart").innerHTML,/fitness-band/);
 assert.match(h.el("fitnessCount").textContent,/Подходящих тренировок: 13/);
 assert.equal(h.el("fitnessPoint").hidden,true);
});

test("switching or restoring the detailed HR mode never changes the main pace chart or verdict",()=>{
 const h=harness(),chart=h.el("fitnessChart").innerHTML,status=h.el("fitnessStatus").textContent;
 h.el("fitnessMode").value="hr";h.event("fitnessMode","change");
 assert.equal(h.el("fitnessChart").innerHTML,chart);
 assert.equal(h.el("fitnessStatus").textContent,status);
 assert.match(h.el("fitnessDetailAxisTitle").textContent,/ЧСС/);
 assert.match(h.el("fitnessAxisTitle").textContent,/Недельный темп/);
 assert.equal(h.el("fitnessHrLabel").hidden,false);
 const restored=harness({storage:h.storage});
 assert.equal(restored.el("fitnessMode").value,"hr");
 assert.equal(restored.el("fitnessDetails").open,false);
 assert.equal(restored.el("fitnessChart").innerHTML,chart);
});

test("week selection uses each chart's own metric and remains independent",()=>{
 const h=harness();h.el("fitnessMode").value="hr";h.event("fitnessMode","change");
 const select=(id)=>{
  const index=h.el(id).innerHTML.match(/data-fitness-week="(\d+)"/)[1];
  h.event(id,"click",{target:{closest:selector=>selector==="[data-fitness-week]" ? {dataset:{fitnessWeek:index}} : null}});
 };
 select("fitnessChart");
 assert.equal(h.el("fitnessPoint").hidden,false);
 assert.match(h.el("fitnessPoint").textContent,/5:00 мин\/км/);
 assert.doesNotMatch(h.el("fitnessPoint").textContent,/25–75%|разброс/);
 assert.equal(h.el("fitnessDetailPoint").hidden,true);
 select("fitnessDetailChart");
 assert.match(h.el("fitnessDetailPoint").textContent,/140 уд\/мин/);
 assert.match(h.el("fitnessPoint").textContent,/5:00 мин\/км/);
 h.state.activeAthleteId="two";h.el("fitnessDetails").open=true;h.render();
 assert.equal(h.el("fitnessDetails").open,false);
 assert.equal(h.el("fitnessPoint").hidden,true);
 assert.equal(h.el("fitnessDetailPoint").hidden,true);
});

test("empty and stale samples cannot produce a positive headline",()=>{
 const empty=harness({initial:[]});
 assert.match(empty.el("fitnessStatus").textContent,/Нет тренировок/);
 assert.match(empty.el("fitnessCount").textContent,/Подходящих тренировок: 0/);
 assert.doesNotMatch(empty.el("fitnessChart").innerHTML,/data-fitness-week|NaN/);
 const stale=harness({initial:workouts().filter(w=>new Date(w.date)<new Date(Date.now()-16*86400000))});
 assert.match(stale.el("fitnessStatus").textContent,/Нет свежих/);
 assert.doesNotMatch(stale.el("fitnessStatus").textContent,/Темп быстрее/);
});
