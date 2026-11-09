const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../plan-structure.js');
const tone=(details,intensity='',type='interval',extra={})=>S.intensityTone({details,intensity,...extra},type);

test('November 11 controlled 4 x 6 minutes is not sprint or an invented VO2max zone',()=>{
 const details='Разминка 20–25 минут легкого бега в Z1–Z2. Затем 4 × 15 секунд свободных ускорений с полным восстановлением. Основная часть: 4 × 6 минут в контролируемом высоком усилии RPE 7–8/10. Восстановление между повторениями — 2 минуты 30 секунд очень легкой трусцы. Суммарная основная работа — 24 минуты. Второй и третий — максимально ровно по скорости и усилию. Заминка 15–20 минут очень легкого бега.';
 assert.equal(tone(details,'Контролируемое высокое усилие, RPE 7–8/10'),'unspecified');
});
test('maximum consistency, relaxation and control are not maximal effort',()=>{
 for(const phrase of ['максимально ровно','максимально расслабленно','максимальный контроль техники','максимальная устойчивость скорости'])
  assert.equal(tone('4 x 6 минут, '+phrase),'unspecified',phrase);
});
test('maximum aerobic power is VO2max rather than sprint',()=>{
 assert.equal(tone('5 x 3 минуты для развития максимальной аэробной мощности'),'vo2');
});
test('explicit VO2max and Z5 do not get captured by the 5 km rule',()=>{
 assert.equal(tone('5 x 3 минуты VO₂max'),'vo2');
 assert.equal(tone('5 x 3 минуты','Z5'),'vo2');
});
test('only explicit race effort maps to race-intensity colors',()=>{
 for(const distance of [1,3,5,10]) {
  assert.equal(tone('4 x 3 минуты',`Усилие ${distance} км`),distance+'k');
  assert.equal(tone('4 x 3 минуты',`Темп на ${distance} км`),distance+'k');
 }
 assert.equal(tone('4 x 1 км, всего 10 км'),'unspecified');
 assert.equal(tone('5 x 3 минуты','','interval',{targetDistance:'10 км',focus:'Подготовка к 1 км',title:'Спринт'}),'unspecified');
});
test('warmup zones and strides never replace the main prescription',()=>{
 assert.equal(tone('Разминка 20 минут Z1. Затем 4 x 15 секунд свободных ускорений с полным восстановлением. Затем 5 x 3 минуты VO2max; восстановление 2 минуты Z1. Заминка 15 минут Z1.'),'vo2');
 assert.equal(tone('Разминка 20 минут Z1; затем 5 x 1000 м в усилии 10 км; заминка 10 минут Z1.'),'10k');
});
test('main block marker outranks a stale general intensity field',()=>{
 assert.equal(tone('Разминка Z1. Основная часть: 3 x 10 минут в пороговом усилии. Заминка Z1.','Z2'),'threshold');
});
test('explicit field outranks unsupported descriptive adjectives',()=>{
 assert.equal(tone('4 x 6 минут, максимально ровно по скорости','Усилие 10 км'),'10k');
});
test('short relaxed strides do not promote an easy run to sprint',()=>{
 assert.equal(tone('60 минут легко в Z2; затем 4 x 15 секунд свободных ускорений, не спринт.','Z2','easy'),'easy');
});
test('actual sprint and short maximal efforts remain sprint',()=>{
 assert.equal(tone('6 x 10 секунд спринт, полное восстановление'),'sprint');
 assert.equal(tone('6 x 10 секунд с максимальным усилием'),'sprint');
 assert.equal(tone('6 x 60 м на максимальной скорости'),'sprint');
 assert.equal(tone('6 x 10 секунд all-out'),'sprint');
});
test('negative sprint restrictions and prior-day references are not sprint prescriptions',()=>{
 assert.equal(tone('4 x 6 минут в усилии 10 км. Не добавлять спринт.'),'10k');
 assert.equal(tone('6 x 10 секунд, не на максимум'),'unspecified');
 assert.equal(tone('60 минут легко в Z2 после вчерашних интервалов. Без максимальных ускорений.','','easy'),'easy');
 assert.equal(tone('4 x 6 минут. Спринт не требуется.'),'unspecified');
 assert.equal(tone('4 x 6 минут. Спринт запрещен.'),'unspecified');
 assert.equal(tone('4 x 6 минут. Контролировать спринтерскую технику.'),'unspecified');
});
test('unknown intervals, tempo and race do not invent a physiological zone',()=>{
 for(const type of ['interval','tempo','race']) assert.equal(tone('Контролируемая работа, RPE 7-8/10','',type),'unspecified');
});
test('easy, recovery and long preserve their own low-intensity colors',()=>{
 assert.equal(tone('80 минут легко','Z1-Z2','long'),'long');
 assert.equal(tone('30 минут очень легко','Z1','recovery'),'recovery');
 assert.equal(tone('60 минут легко','Z2','easy'),'easy');
 assert.equal(tone('','', 'recovery'),'recovery');
});
test('recovery in the same clause does not hide the work effort',()=>{
 assert.equal(tone('5 x 3 минуты VO2max, восстановление 2 минуты в Z1'),'vo2');
});
test('structured main intensity takes priority over notes and stale labels',()=>{
 const s={version:1,mode:'repeats',count:4,work:{basis:'duration',from:180,to:180,intensity:'VO2max'},recovery:{basis:'duration',from:120,to:120,intensity:'Z1'},notes:'максимально ровно'};
 const d={plannedStructure:s,plannedWorkout:S.format(s),intensity:s.work.intensity,title:'Спринт',focus:'Интервалы'};
 const snapshot=JSON.stringify(d);
 assert.equal(S.intensityTone(d,'interval'),'vo2');assert.equal(JSON.stringify(d),snapshot);
 d.plannedWorkout='Основная часть: 20 минут порогового бега.';d.intensity='';
 assert.equal(S.intensityTone(d,'tempo'),'threshold');
});
test('unsupported race effort ranges are not silently narrowed',()=>{
 assert.equal(tone('4 x 6 минут в усилии 3-5 км'),'unspecified');
});
test('malformed zones cannot select a high-intensity color',()=>{
 assert.equal(tone('4 x 6 минут','Z10'),'unspecified');
 assert.equal(tone('4 x 6 минут','Z5-Z1'),'unspecified');
});
