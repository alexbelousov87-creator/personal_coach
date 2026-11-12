const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const WorkoutCorrections=require('../workout-corrections.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const original=()=>({id:'one',date:'2026-11-12T08:00:00Z',source:'session.CSV',sport:'Running',durationMin:60,
 distanceKm:9,paceMinPerKm:6.5,pace:'6:30 мин/км',paceSource:'csv',avgSpeed:9.2,avgHr:140,load:80,loadSource:'trimp-segmented'});
function corrected(pace=5){const w=original();return WorkoutCorrections.apply({...w,manualCorrection:{active:true,distanceKm:12,paceMinPerKm:pace,original:w,updatedAt:'1'}});}
function setup(){
 const c=vm.createContext({WorkoutCorrections,state:{auth:{enabled:true,authenticated:true,role:'student'},profile:{maxHr:200,restHr:50}},
  classifyWorkout:()=> 'easy',dateFromAny:v=>new Date(v),numberOrNull:v=>Number(v)||null,estimateTrimp:()=>80,
  paceFromDistanceDuration:()=>6,paceFromSpeed:()=>6,formatPace:p=>String(p),validWorkoutType:()=>false,
  normalizeWorkoutFeedback:()=>null});
 for(const name of ['round','mergeWorkoutLists','findMergeableWorkoutIndex','workoutDedupKey','workoutProviderIds','workoutsShareProviderId',
  'providerActivityIdFromSource','polarExerciseIdFromSource','fileNameFromSource','normalizedSportKey','isGenericSport','isPolarApiSource',
  'tcxFileNameFromWorkout','mergeDuplicateWorkouts','workoutRichnessScore','areSimilarImportedWorkouts','workoutHasStartTime',
  'isImportedWorkoutPair','isExternalWorkout','isPolarLikeWorkout','sourceLooksLikeWorkoutFile','mergeWorkoutEnrichment','normalizeWorkout','canEditWorkoutDetails']){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);
  const end=source.indexOf('\nfunction ',start+1);vm.runInContext(source.slice(start,end<0?undefined:end),c);
 }
 return c;
}
test('manual totals preserve identity and never derive missing pace or change load',()=>{
 const w=corrected(null);assert.equal(w.distanceKm,12);assert.equal(w.paceMinPerKm,null);assert.equal(w.paceSource,'');
 for(const key of ['id','source','date','durationMin','avgHr','load','loadSource'])assert.equal(w[key],original()[key]);
});
test('reimport of corrected file and another provider does not duplicate or overwrite totals',()=>{
 const c=setup(),edited=corrected(),key=c.workoutDedupKey(original());
 assert.equal(c.workoutDedupKey(edited),key);
 for(const w of [original(),{...original(),source:'Polar:p1',providerIds:{polar:'p1'},workoutStructure:{kind:'intervals'}}]){
  const r=c.mergeWorkoutLists([edited],[w]);assert.equal(r.accepted,0);assert.equal(r.workouts.length,1);
  assert.equal(r.workouts[0].distanceKm,12);assert.equal(r.workouts[0].paceMinPerKm,5);
 }
});
test('TCX enrichment and normalization cannot restore bad pace after distance-only correction',()=>{
 const c=setup(),w=corrected(null);
 const enriched=c.mergeWorkoutEnrichment(w,{paceMinPerKm:3,paceSource:'tcx',avgSpeed:20,lapSignals:{hasIntervalLaps:true}});
 assert.equal(enriched.paceMinPerKm,null);assert.equal(enriched.avgSpeed,null);assert.equal(enriched.load,80);
 assert.equal(c.normalizeWorkout(w).paceMinPerKm,null);assert.equal(c.normalizeWorkout(w).manualCorrection.updatedAt,'1');
});
test('restore tombstone wins over stale correction regardless of richness or order',()=>{
 const edited=corrected(),restored=WorkoutCorrections.apply({...edited,manualCorrection:{...edited.manualCorrection,active:false,updatedAt:'2'}});
 for(const rows of [[edited,restored],[restored,edited]]){
  const merged=WorkoutCorrections.preserve({...edited,workoutStructure:{kind:'intervals'}},...rows);
  assert.equal(merged.distanceKm,9);assert.equal(merged.paceSource,'csv');assert.equal(merged.avgSpeed,9.2);
 }
});
test('editing is student-only including the unauthenticated and local coach UI',()=>{
 const c=setup();assert.equal(c.canEditWorkoutDetails(),true);
 c.state.auth.role='coach';assert.equal(c.canEditWorkoutDetails(),false);
 c.state.auth.role='student';c.state.auth.authenticated=false;assert.equal(c.canEditWorkoutDetails(),false);
 c.state.auth.enabled=false;c.state.currentRole='coach';assert.equal(c.canEditWorkoutDetails(),false);
 c.state.currentRole='student';assert.equal(c.canEditWorkoutDetails(),true);
});
