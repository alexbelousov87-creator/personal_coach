const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function setup() {
 const c=vm.createContext({matchesAny:(text,parts)=>parts.some(part=>text.includes(part)),
  PlanStructure:require('../plan-structure.js'),WorkoutComparison:require('../workout-comparison.js'),
  selectedWeekStartDate:()=>new Date('2026-10-12T07:00:00Z'),addDays:(d,n)=>new Date(d.getTime()+n*86400000)});
 const names=['plannedStimulusText','primaryPlannedStimulusText','planTypeFromFocus','planTypeFromAssignment','assignmentHasTempoStructure','assignmentHasIntervalStructure','assignmentHasEasyRunVolume','plannedTypeForDay','plannedIntensityTone',
 'normalizedPlanFocus','normalizedPlanTitle','defaultTitleForPlannedType','focusForPlannedType','titleMentionsRun','titleMentionsStrides','assignmentHasNoRun','assignmentForbidsStrides','splitPlanAndActual','normalizePlanDay','structuredPlanFocus','groupedActualWorkoutsForPlanDay','planCompletionWorkoutsForDay','planExpectsNoRun','planTypeRequiresRunning','plannedTypeAllowsOptionalEasyRun','planDayComparableText','evaluatePlanDayLoadAndType','planTypeMatchesActual','actualMatchesPlannedEnvelope','plannedDurationBounds','plannedDistanceBounds','valueWithinRange'];
 for(const name of names) {const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);assert.ok(start>=0,name);vm.runInContext(source.slice(start,end<0?undefined:end),c);}
 return c;
}
const sunday={date:'2026-10-18T07:00:00.000Z',focus:'легкая длительная',title:'Поддерживающая длительная без ускорений',
 details:'75–85 минут спокойного бега. Первые 15 минут в Z1, далее преимущественно Z1–Z2, RPE 2–3/10, свободный разговорный темп. Без прогрессии, темповых блоков и быстрого финиша. При остаточной усталости после субботней пороговой работы сократить длительную до 60–70 минут или заменить восстановительным бегом. Пить по жажде с учетом условий тренировки. Интенсивный SkiErg после длительной не добавлять.',
 targetDistance:'16–18 км; при выраженной усталости меньше',intensity:'Z1–Z2, RPE 2–3/10',load:'умеренная'};

test('October 18 easy long run is not threshold and keeps its title and intensity strip',()=>{
 const c=setup(),before=JSON.stringify(sunday),d=c.normalizePlanDay(sunday,sunday,6);
 assert.equal(c.plannedTypeForDay(d),'long');assert.equal(c.plannedIntensityTone(d),'long');
 assert.equal(d.focus,sunday.focus);assert.equal(d.title,sunday.title);assert.equal(d.details,sunday.details);
 assert.equal(JSON.stringify(sunday),before);
});
test('already saved wrong tempo label is repaired by normalizing the unchanged assignment',()=>{
 const c=setup(),d=c.normalizePlanDay({...sunday,focus:'Темпо',title:'Темповая работа'},sunday,6);
 assert.equal(d.focus,'Длительная');assert.equal(c.plannedTypeForDay(d),'long');assert.equal(c.plannedIntensityTone(d),'long');
 assert.equal(d.details,sunday.details);
});
test('other-day references are not prescriptions, including titles',()=>{
 const c=setup();
 for(const reference of ['после субботней пороговой работы','перед завтрашними интервалами','после вчерашней длительной','накануне гонки']) {
  assert.equal(c.planTypeFromAssignment('60 минут легко в Z2 '+reference),'easy',reference);
 }
 assert.equal(c.planTypeFromFocus('Восстановительный кросс после интервалов'),'recovery');
 assert.equal(c.planTypeFromFocus('Восстановление после длительной'),'recovery');
});
test('negative lists and non-sprint strides do not create intensive sessions',()=>{
 const c=setup();
 for(const prohibition of ['Без темповой работы.','Без прогрессии, темповых блоков и быстрого финиша.','Без интервалов и порога.']) {
  assert.equal(c.planTypeFromAssignment('60 минут легко в Z2. '+prohibition),'easy');
 }
 const d={focus:'Кросс',details:'50-60 минут легко в Z2. В конце 4 x 15 секунд strides, без максимального ускорения.',intensity:'Z2, strides свободные, не спринт'};
 assert.equal(c.plannedTypeForDay(d),'easy');assert.equal(c.plannedIntensityTone(d),'easy');
});
test('real threshold and intervals survive references and negative caveats',()=>{
 const c=setup();
 assert.equal(c.planTypeFromAssignment('Разминка 20 минут; затем 3 x 8 минут в пороговом усилии. Без быстрого финиша.'),'tempo');
 assert.equal(c.planTypeFromAssignment('После разминки 4 x 3 минуты VO2max, восстановление 2 минуты. Без спринта.'),'interval');
 assert.equal(c.planTypeFromAssignment('Без спринта, затем 3 x 8 минут порог.'),'tempo');
 assert.equal(c.planTypeFromAssignment('20 минут без пауз в пороговом усилии.'),'tempo');
 assert.equal(c.plannedTypeForDay({focus:'Длительная',details:'Длительная с блоком 20 минут пороговой работы.'}),'tempo');
});
test('explicit long run stays long with purely easy instructions, stale interval label is corrected',()=>{
 const c=setup(),details='80 минут легко в Z2, разговорный темп.';
 assert.equal(c.normalizedPlanFocus({focus:'Длительная'},null,details),'Длительная');
 assert.equal(c.plannedTypeForDay({focus:'Длительная',details}),'long');
 assert.equal(c.normalizedPlanFocus({focus:'Интервалы'},null,details),'Кросс');
});
const monday={date:'2026-10-12T07:00:00.000Z',focus:'восстановительный бег',title:'Восстановление после длительной',
 details:'35–45 минут очень легкого бега преимущественно в Z1, до 152 уд/мин, RPE 1–2/10. Темп свободный, без ускорений, прогрессии и горок. Если после воскресной длительной сохраняется выраженная усталость, сократить до 25–35 минут или выбрать полный отдых. Дополнительную интенсивную небеговую работу не проводить.',
 targetDistance:'7–9 км или отдых при выраженной усталости',intensity:'Z1, RPE 1–2/10',load:'низкая'};
function withActual(actual) {
 const c=setup();c.actualWorkoutsForPlanDay=()=>actual;c.workoutDedupKey=w=>w.id;c.isRunningWorkout=w=>w.sport==='Running';
 c.getWorkoutType=w=>w.sport==='Running'?'easy':'cross';
 c.getWorkoutClassification=w=>({type:c.getWorkoutType(w),confidence:'medium',needsReview:false,canRejectOtherTypes:false});
 c.plannedLoadScoreForDay=()=>54;c.plannedTypeLabelForDay=(d,type)=>type;c.actualTypeLabel=type=>type;
 return c;
}
const mondayRun={id:'run',date:'2026-10-12T06:00:00Z',sport:'Running',durationMin:48,distanceKm:10.1,avgHr:139,load:60};

test('October 12 primary run is not replaced by the conditional full-rest fallback',()=>{
 const c=withActual([mondayRun]),snapshot=JSON.stringify(monday);
 const d=c.normalizePlanDay(monday,monday,0);
 assert.ok(['easy','recovery'].includes(c.plannedTypeForDay(d)));
 const groups=c.groupedActualWorkoutsForPlanDay(d);
 assert.equal(groups.length,1);assert.equal(groups[0].kind,'single');assert.equal(groups[0].label,'');
 assert.equal(groups[0].workouts[0].id,'run');
 const result=c.evaluatePlanDayLoadAndType(d);
 assert.equal(result.level,'matched');assert.equal(result.completed,true);assert.equal(result.label,'по плану');
 assert.equal(JSON.stringify(monday),snapshot);assert.equal(mondayRun.load,60);assert.equal(d.details,monday.details);
});
test('existing rest label is repaired without editing the saved workout fact',()=>{
 const c=withActual([mondayRun]);
 const d=c.normalizePlanDay({...monday,focus:'Отдых',title:'Отдых'},monday,0);
 assert.notEqual(c.plannedTypeForDay(d),'rest');assert.notEqual(d.title,'Отдых');
 assert.equal(c.planCompletionWorkoutsForDay(d).length,1);
});
test('non-running extra load remains separated and counted in the load assessment',()=>{
 const c=withActual([mondayRun,{id:'skierg',sport:'SkiErg',load:40}]),d=c.normalizePlanDay(monday,monday,0);
 const groups=c.groupedActualWorkoutsForPlanDay(d);
 assert.equal(groups[0].kind,'primary');assert.equal(groups[0].workouts[0].id,'run');
 assert.equal(groups[1].kind,'additional');assert.equal(groups[1].workouts[0].id,'skierg');
 assert.equal(c.evaluatePlanDayLoadAndType(d).level,'overloaded');
});
test('true rest is not converted to a running day by zone metadata or walking',()=>{
 const c=withActual([mondayRun]);
 for(const details of ['Полный отдых. Можно 30 минут ходьбы.', 'День отдыха без нагрузки.', 'Полный отдых. 30 минут бега запрещены.']) {
  const d={focus:'Отдых',details,intensity:'Z1'};
  assert.equal(c.plannedTypeForDay(d),'rest');assert.equal(c.planCompletionWorkoutsForDay(d).length,0);
  assert.equal(c.groupedActualWorkoutsForPlanDay(d)[0].kind,'additional');
 }
});
test('rest-first optional easy run remains creditable; fatigued-run fallback works both orders',()=>{
 const c=withActual([{...mondayRun,durationMin:35,distanceKm:6}]);
 const optional={focus:'Отдых',details:'Полный отдых либо 30-40 минут очень легко в Z1.'};
 assert.equal(c.plannedTypeForDay(optional),'rest');assert.equal(c.planCompletionWorkoutsForDay(optional).length,1);
 assert.equal(c.evaluatePlanDayLoadAndType(optional).level,'matched');
 for(const details of ['40 минут легкого бега в Z1 или полный отдых при усталости.', 'При выраженной усталости выбрать полный отдых. Иначе 40 минут легкого бега в Z1.']) {
  assert.notEqual(c.planTypeFromAssignment(details),'rest');
 }
});
test('a reference to prior rest does not erase a real conditional quality session',()=>{
 const c=setup();
 // This wording remains outside the fatigue-fallback rule; its primary text must not be erased.
 assert.match(c.primaryPlannedStimulusText('Разминка 15 минут легкого бега. Если вчера был полный отдых, выполнить 5 x 1000 м.'),/5 x 1000/);
});