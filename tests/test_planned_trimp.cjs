const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(profile={maxHr:201,restHr:45,hrZoneMode:'custom',hrZoneBoundaries:[152,168,185,190]}) {
 const c=vm.createContext({state:{profile},PlanStructure:require('../plan-structure.js'),
 matchesAny:(t,p)=>p.some(s=>t.includes(s)),clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),recentReliablePace:()=>4.7,
 plannedTypeForDay:d=>({'Темпо':'tempo','Длительная':'long','Кросс':'easy','Отдых':'rest'})[d.focus]||'easy'});
 const names=['planDayComparableText','plannedLoadScoreForDay','plannedSegmentedLoadScore','plannedWorkoutSegments','plannedSegmentDescription','plannedRepeatWorkDuration','plannedRecoveryDurationAfterRepeat','plannedRecoveryTimeMinutes','plannedStimulusText','plannedEasyHrReserveRatio','plannedRecoveryHrReserveRatio','plannedWorkHrReserveRatio','plannedFastPaceFactor','plannedDurationMinutes','plannedTotalDurationMinutes','plannedDurationFromDistance','plannedDistanceKm','plannedHrReserveRatio','averageRange','estimateTrimpFromHrr','effectiveHrZoneBoundaries','defaultHrZoneBoundaries','normalizeCustomHrZoneBoundaries','plannedPersonalHrReserveRatio','plannedZoneHrReserveRatio'];
 for (const name of names) { const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);assert.ok(start>=0,name);vm.runInContext(source.slice(start,end<0?undefined:end),c); }
 return c;
}
function bpm(c,ratio) {const p=c.state.profile;return p.restHr+(p.maxHr-p.restHr)*ratio;}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('custom Z2 estimate lies in the profile zone, not hard-coded HRR',()=>{
 const c=setup(), h=c.plannedHrReserveRatio({intensity:'Z2'});
 near(bpm(c,h),164.8);assert.ok(h>.7);
});
test('custom Z1-Z2 combines both zone estimates and is consistent across functions',()=>{
 const c=setup();
 for(const intensity of ['Z1-Z2','z1–z2','Z1 / Z2','Z1-2']) {
 const d={intensity};const value=c.plannedHrReserveRatio(d);
 near(value,(c.plannedPersonalHrReserveRatio(.55)+c.plannedPersonalHrReserveRatio(.68))/2);
 near(c.plannedEasyHrReserveRatio(d),value);near(c.plannedWorkHrReserveRatio(d),value);
 }
});
test('zone-only instructions override heuristic word ordering even with RPE in intensity',()=>{
 const c=setup();const d={focus:'Кросс',intensity:'RPE 1-2/10',details:'40-50 минут очень легко в Z1.'};
 near(c.plannedHrReserveRatio(d),c.plannedPersonalHrReserveRatio(.55));
 near(c.plannedHrReserveRatio({...d,details:'50-60 минут в Z1-Z2.'}),c.plannedZoneHrReserveRatio('Z1-Z2'));
});
test('main intensity wins over zones used only in the warmup text',()=>{
 const c=setup(),d={focus:'Темпо',intensity:'Z4',details:'Разминка 15 минут в Z1, затем 3 x 8 минут в Z4.'};
 near(bpm(c,c.plannedWorkHrReserveRatio(d)),187);
 near(c.plannedHrReserveRatio(d),c.plannedWorkHrReserveRatio(d));
});
test('default and invalid custom profiles retain single-zone defaults',()=>{
 for(const profile of [{maxHr:190,restHr:50,hrZoneMode:'hrr'}, {maxHr:190,restHr:50,hrZoneMode:'custom',hrZoneBoundaries:[160,150,180,185]},{}]) {
 const c=setup(profile);
 for(const [i,expected] of [.55,.68,.76,.84,.9].entries()) near(c.plannedHrReserveRatio({intensity:`Z${i+1}`}),expected);
 }
});
test('selected athlete determines zone calculations; no shared cached profile',()=>{
 const c=setup(),before=c.plannedHrReserveRatio({intensity:'Z2'});
 c.state.profile={maxHr:190,restHr:50,hrZoneMode:'custom',hrZoneBoundaries:[120,135,155,175]};
 const after=c.plannedHrReserveRatio({intensity:'Z2'});
 near(bpm(c,after),132);assert.notEqual(before,after);
});
test('custom threshold is mapped once and warmup remains easy',()=>{
 const c=setup(),d={focus:'Темпо',intensity:'Порог, Z4 185-190',details:'Разминка 15 минут; затем 3 x 8 минут порог, восстановление 3 минуты трусцой; заминка 15 минут.'};
 const parts=c.plannedWorkoutSegments(d);
 near(bpm(c,parts.find(s=>s.kind==='work').hrr),187);
 assert.ok(bpm(c,parts.find(s=>s.kind==='warmup').hrr)<168);
 assert.equal(parts.find(s=>s.kind==='recovery').duration,6);
});
test('warmup and cooldown duration are recognized before and after their names',()=>{
 const c=setup();
 for(const details of ['Разминка 18-20 минут; 3 x 8 минут, восстановление 3 минуты; заминка 15-18 минут.', '18-20 минут разминки; 3 x 8 минут, восстановление 3 минуты; 15-18 минут заминки.']) {
 const parts=c.plannedWorkoutSegments({focus:'Темпо',intensity:'Z4',details});
 assert.equal(parts.filter(s=>s.kind==='warmup').length,1);assert.equal(parts.find(s=>s.kind==='warmup').duration,19);
 assert.equal(parts.filter(s=>s.kind==='cooldown').length,1);assert.equal(parts.find(s=>s.kind==='cooldown').duration,16.5);
 }
});
test('structured phases respect their own zones, not the work intensity throughout',()=>{
 const c=setup(),S=c.PlanStructure;
 const b=(minutes,intensity)=>({...S.range(String(minutes),'min'),intensity});
 const structure={version:1,mode:'repeats',count:3,warmup:b(15,'Z1'),work:b(8,'Z4'),recovery:b(3,'Z1'),cooldown:b(10,'Z2'),notes:''};
 const d={focus:'Темпо',plannedStructure:structure,plannedWorkout:S.format(structure),intensity:'Z4'};
 const parts=c.plannedWorkoutSegments(d);
 assert.deepEqual(Array.from(parts,s=>s.duration),[15,24,6,10]);
 near(parts[0].hrr,c.plannedPersonalHrReserveRatio(.55));near(parts[1].hrr,c.plannedPersonalHrReserveRatio(.84));near(parts[3].hrr,c.plannedPersonalHrReserveRatio(.68));
 near(c.plannedSegmentedLoadScore(d),parts.reduce((sum,s)=>sum+c.estimateTrimpFromHrr(s.duration,s.hrr),0));
});
test('long easy regression: 85 minutes in custom Z1-Z2 is around 145, not 86',()=>{
 const c=setup(),d={focus:'Длительная',intensity:'Z1-Z2, RPE 2-3/10',details:'80-90 минут легкого длительного бега в Z1-Z2, 17-19 км, без быстрого финиша.',targetDistance:'17-19 км'};
 const snapshot=JSON.stringify(d), profile=JSON.stringify(c.state.profile);
 assert.equal(c.plannedLoadScoreForDay(d),145);assert.ok(167<c.plannedLoadScoreForDay(d)*1.35);
 assert.equal(JSON.stringify(d),snapshot);assert.equal(JSON.stringify(c.state.profile),profile);
});
test('easy run with strides retains zone range for the main easy duration',()=>{
 const c=setup(),d={focus:'Кросс',intensity:'RPE 2-3/10',details:'55-65 минут легко в Z1-Z2; опционально 5-6 x 15 секунд strides.',targetDistance:'11-13 км'};
 assert.equal(c.plannedLoadScoreForDay(d),102);
 assert.ok(c.plannedWorkoutSegments(d).find(s=>s.kind==='easy').hrr>.69);
});
test('nonnumeric zone label and multi-digit Z10 are not treated as Z1',()=>{
 const c=setup();assert.equal(c.plannedZoneHrReserveRatio('Z10'),null);assert.equal(c.plannedZoneHrReserveRatio('RPE 2-3'),null);
});

test('October 14: strides, bounded recoveries, compound times and chronological order',()=>{
 const c=setup();
 const d={focus:'VO2max',title:'4 × 3 минуты высокой аэробной мощности',intensity:'Высокая аэробная мощность, RPE 8–9/10; ЧСС вторична',details:'Разминка 20 минут легкого бега в Z1–Z2. Затем 4 × 15 секунд свободных ускорений с полным восстановлением. Основная часть: 4 × 3 минуты высокой аэробной интенсивности, RPE 8–9/10, восстановление между повторениями 2 минуты 30 секунд — 3 минуты очень легкой трусцы. Суммарный качественный объем — 12 минут. Первый отрезок выполнять контролируемо, без спринта. Если третий отрезок требует предельного усилия, закончить после трех повторений. Заминка 15 минут легко.'};
 const snapshot=JSON.stringify(d),parts=c.plannedWorkoutSegments(d);
 assert.deepEqual(Array.from(parts,s=>s.kind),['warmup','strides','recovery','work','recovery','cooldown']);
 assert.deepEqual(Array.from(parts,s=>s.duration),[20,1,0,12,8.25,15]);
 assert.equal(parts[2].unknownDuration,true);
 assert.equal(parts[1].approximate,true);
 near(parts[3].hrr,c.plannedPersonalHrReserveRatio(.9));
 assert.ok(bpm(c,parts[3].hrr)<192);
 assert.ok(bpm(c,parts[4].hrr)<152);
 assert.equal(JSON.stringify(d),snapshot);
 const rendered=parts.map(s=>c.plannedSegmentDescription(s,45,201)).join('; ');
 assert.ok(rendered.includes('4 × 15 секунд (всего 1 мин)'));
 assert.ok(rendered.includes('длительность не указана'));
 assert.ok(!c.plannedSegmentDescription(parts[1],45,201).includes('ЧСС'));
 assert.ok(rendered.includes('8.25 мин'));
});

test('recovery measures include compound, clock, second and distance ranges',()=>{
 const c=setup();
 for(const [text,minutes] of [['2 минуты 30 секунд — 3 минуты',2.75],['2:30–3:00',2.75],['2:30',2.5],['2-3 минуты',2.5],['75–90 секунд',1.375],['90 с',1.5],['1,5 минуты',1.5],['2 минуты 30 секунд',2.5]]) {
 near(c.plannedRecoveryDurationAfterRepeat('восстановление между повторениями '+text+' трусцой',4,{}),minutes*3);
 }
 near(c.plannedRecoveryDurationAfterRepeat('через 400 м трусцы',4,{}),3*.4*4.7*1.15);
 near(c.plannedRecoveryDurationAfterRepeat('через 0,4 км трусцы',4,{}),3*.4*4.7*1.15);
 assert.equal(c.plannedRecoveryDurationAfterRepeat('с полным восстановлением. Затем 4 x 3 минуты, восстановление 2 минуты',4,{}),0);
 assert.equal(c.plannedRecoveryDurationAfterRepeat('полное восстановление. Заминка 15 минут',4,{}),0);
});

test('negated sprint does not raise work HR or distance speed factor',()=>{
 const c=setup(),base={focus:'VO2max',intensity:'RPE 8-9/10'};
 for(const details of ['Без спринта.','Не спринт.','Не как спринт.']) {
 near(c.plannedWorkHrReserveRatio({...base,details}),c.plannedPersonalHrReserveRatio(.9));
 near(c.plannedFastPaceFactor({...base,details}),.78);
 }
 near(c.plannedWorkHrReserveRatio({details:'Спринт'}),c.plannedPersonalHrReserveRatio(.92));
 near(c.plannedFastPaceFactor({details:'Спринт'}),.65);
});

test('separate work blocks retain their own zones and recoveries',()=>{
 const c=setup();
 const parts=c.plannedWorkoutSegments({focus:'VO2max',intensity:'Z5',details:'Разминка 15 минут в Z1. Затем 3 x 8 минут в Z4, восстановление 2 минуты. Затем 4 x 1 минуту в Z5, восстановление 90 секунд. Заминка 10 минут в Z1.'});
 const work=parts.filter(s=>s.kind==='work'),recovery=parts.filter(s=>s.kind==='recovery');
 near(work[0].hrr,c.plannedPersonalHrReserveRatio(.84));
 near(work[1].hrr,c.plannedPersonalHrReserveRatio(.9));
 assert.deepEqual(Array.from(recovery,s=>s.duration),[4,4.5]);
});

test('fatigue alternative does not erase cooldown or add backup repetitions',()=>{
 const c=setup();
 const parts=c.plannedWorkoutSegments({intensity:'Z4',details:'Разминка 15 минут. 3 x 8 минут, восстановление 2 минуты. При усталости 2 x 8 минут. Заминка 10 минут.'});
 assert.deepEqual(Array.from(parts,s=>s.duration),[15,24,4,10]);
});

test('total duration reuses blocks instead of title and descriptive totals',()=>{
 const c=setup(),d={title:'4 x 3 минуты',intensity:'Z5',details:'Разминка 20 минут в Z1-Z2; затем 4 x 3 минуты, восстановление 2:30-3:00. Всего качественной работы 12 минут. Заминка 15 минут.'};
 assert.equal(c.plannedWorkoutSegments(d).filter(s=>s.kind==='work').length,1);
 assert.equal(c.plannedDurationMinutes(d),55);
});

test('warmup zone does not leak into following work in the same sentence',()=>{
 const c=setup(),d={focus:'VO2max',intensity:'RPE 8-9/10',details:'Разминка 20 минут в Z1-Z2 затем 4 x 3 минуты быстро, восстановление 3 минуты. Заминка 15 минут.'};
 near(c.plannedWorkoutSegments(d).find(s=>s.kind==='work').hrr,c.plannedPersonalHrReserveRatio(.9));
});

test('local threshold and race effort override general VO2max focus',()=>{
 const c=setup();
 const parts=c.plannedWorkoutSegments({focus:'VO2max',intensity:'RPE 8-9',details:'3 x 8 минут порогового бега, восстановление 2 минуты. Затем 5 x 1000 м в усилии 10 км, восстановление 400 м.'});
 const work=parts.filter(s=>s.kind==='work');
 near(work[0].hrr,c.plannedPersonalHrReserveRatio(.84));
 near(work[1].hrr,c.plannedPersonalHrReserveRatio(.86));
});