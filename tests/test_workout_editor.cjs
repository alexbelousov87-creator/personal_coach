const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../workout-editor.js'),'utf8');
const WorkoutCorrections=require('../workout-corrections.js');
function setup(durationMin=60){
 const elements=new Map(),listeners={},requests=[];
 const el=id=>{
  if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,open:false,events:{},
   addEventListener(name,fn){this.events[name]=fn;},setCustomValidity(value){this.validation=value;},
   reportValidity(){return !this.validation;},querySelectorAll(){return [];},
   showModal(){this.open=true;},close(){this.open=false;this.events.close?.();}});
  return elements.get(id);
 };
 const workout={id:'one',date:'2026-11-12T08:00:00Z',source:'test.CSV',sport:'Running',durationMin,distanceKm:9,
  paceMinPerKm:6.5,paceSource:'csv',avgHr:140,load:80,loadSource:'trimp-segmented'};
 const state={auth:{enabled:true,authenticated:true,role:'student',coachId:'coach'},currentRole:'student',activeAthleteId:'athlete',workouts:[workout],athletes:[]};
 const c=vm.createContext({state,document:{getElementById:el,addEventListener:(name,fn)=>listeners[name]=fn},
  canEditWorkoutDetails:()=>state.auth.role==='student',escapeHtml:String,formatDate:String,formatDistance:String,
  formatTrustedPace:w=>String(w.paceMinPerKm),trustedPace:w=>w.paceMinPerKm,workoutDedupKey:w=>w.id,
  API_BASE_URL:'',STORAGE_KEY:'workouts',ATHLETES_KEY:'athletes',syncActiveAthleteFromState(){},saveJson(){},renderAll(){},restoreCurrentPlanOrGenerate(){},showToast(){},
  fetch:async(url,options)=>{
   const payload=JSON.parse(options.body);requests.push(payload);
   const updated=WorkoutCorrections.apply({...state.workouts[0],manualCorrection:{active:true,distanceKm:payload.distanceKm,
    paceMinPerKm:payload.paceMinPerKm,original:workout,updatedAt:'1'}});
   return {ok:true,json:async()=>({workout:updated})};
  }});
 vm.runInContext(source,c);listeners.DOMContentLoaded();
 const button={closest:()=>({dataset:{workoutKey:'one'}})};
 el('workoutList').events.click({target:{closest:()=>button}});
 const event=(id,name)=>el(id).events[name]({preventDefault(){}});
 const distance=value=>{el('workoutEditDistance').value=value;event('workoutEditDistance','input');};
 return {el,state,requests,event,distance};
}
test('editing distance instantly updates pace without changing the workout before save',()=>{
 const h=setup(),before=JSON.stringify(h.state.workouts);
 h.distance('12');assert.equal(h.el('workoutEditPace').value,'5:00');
 h.distance('10');assert.equal(h.el('workoutEditPace').value,'6:00');
 assert.equal(JSON.stringify(h.state.workouts),before);assert.equal(h.requests.length,0);
});
test('pace uses fractional minutes and rounds seconds with correct minute carry',()=>{
 const fractional=setup(57.5);fractional.distance('12');assert.equal(fractional.el('workoutEditPace').value,'4:48');
 const carry=setup(59.99);carry.distance('12');assert.equal(carry.el('workoutEditPace').value,'5:00');
});
test('zero, empty or invalid distance and invalid duration never produce Infinity or NaN',()=>{
 const h=setup();
 for(const value of ['0','','-1','1001','NaN','Infinity']){
  h.distance(value);assert.equal(h.el('workoutEditPace').value,'');
 }
 for(const duration of [0,-1,NaN,Infinity]){
  const invalid=setup(duration);invalid.distance('12');assert.equal(invalid.el('workoutEditPace').value,'');
 }
});
test('manual pace remains editable; a subsequent distance edit recalculates it again',()=>{
 const h=setup();h.distance('12');
 h.el('workoutEditPace').value='4:55';h.event('workoutEditPace','input');
 assert.equal(h.el('workoutEditPace').value,'4:55');
 h.distance('10');assert.equal(h.el('workoutEditPace').value,'6:00');
});
test('one save submits the calculated pace and retains duration, HR and TRIMP',async()=>{
 const h=setup();h.distance('12');h.event('workoutEditForm','submit');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].distanceKm,12);assert.equal(h.requests[0].paceMinPerKm,5);
 assert.equal(h.state.workouts[0].distanceKm,12);assert.equal(h.state.workouts[0].paceMinPerKm,5);
 assert.equal(h.state.workouts[0].durationMin,60);assert.equal(h.state.workouts[0].avgHr,140);assert.equal(h.state.workouts[0].load,80);
 assert.equal(h.el('workoutEditDialog').open,false);
});
test('changing athlete or switching to coach closes the editor before recalculation',()=>{
 const h=setup();h.state.auth.role='coach';h.distance('12');assert.equal(h.el('workoutEditDialog').open,false);
 const other=setup();other.state.activeAthleteId='other';other.distance('12');assert.equal(other.el('workoutEditDialog').open,false);
});
