const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function setup() {
 const c=vm.createContext({matchesAny:(text,parts)=>parts.some(part=>text.includes(part)),
  PlanStructure:require('../plan-structure.js'),WorkoutComparison:require('../workout-comparison.js'),
  selectedWeekStartDate:()=>new Date('2026-10-12T07:00:00Z'),addDays:(d,n)=>new Date(d.getTime()+n*86400000)});
 const names=['plannedStimulusText','planTypeFromFocus','planTypeFromAssignment','assignmentHasTempoStructure','assignmentHasIntervalStructure','assignmentHasEasyRunVolume','plannedTypeForDay','plannedIntensityTone',
 'normalizedPlanFocus','normalizedPlanTitle','defaultTitleForPlannedType','focusForPlannedType','titleMentionsRun','titleMentionsStrides','assignmentHasNoRun','assignmentForbidsStrides','splitPlanAndActual','normalizePlanDay','structuredPlanFocus'];
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