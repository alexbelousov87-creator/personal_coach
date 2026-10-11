const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

function setup() {
  const c = vm.createContext({planGoalSummaryText: value => value ? `Goal: ${value}` : ''});
  for (const name of ['aiPlanningSystemPrompt', 'aiPlanResponseSchema', 'workoutReferenceForPlanning',
    'workoutTemplateLibrary', 'planSummaryText', 'splitPlanAndActual', 'buildAiRequest', 'buildAiPrompt']) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name);
    const end = source.indexOf('\nfunction ', start + 1);
    vm.runInContext(source.slice(start, end < 0 ? undefined : end), c);
  }
  for (const name of ['getPlanningModeProfile', 'getAthleteLevelProfile', 'getAgeGroupProfile', 'getRaceSummary',
    'getPreparationPhaseContext', 'getReadiness', 'subjectiveStateForPlanning', 'buildTrainingState',
    'buildTrainingHistorySummary']) c[name] = () => ({});
  for (const name of ['raceHistoryForPlanning', 'phaseHistoryForPlanning', 'buildWeeklyTrainingHistory']) c[name] = () => [];
  for (const name of ['sumLoad', 'sumLoadRange']) c[name] = () => 0;
  for (const name of ['subjectiveFatigueLabel', 'subjectiveFatigueGuidance']) c[name] = () => 'test';
  c.buildRecentWorkoutsDetailed = () => [{date:'2026-10-05', load:100, studentFeedback:{effort:'normal'}}];
  c.profileForPlanning = () => ({targetDistance:'21k', constraints:'Original athlete constraints'});
  c.buildPlanningWeek = () => ({days:Array.from({length:7},(_,i)=>({date:`2026-10-${12+i}`}))});
  return c;
}

test('prompt hierarchy, phase uncertainty and feedback override templates and metrics', () => {
  const prompt = setup().aiPlanningSystemPrompt();
  for (const field of ['hardSafetyRules', 'racePlanningRules', 'phaseHistory', 'plannedDurationWeeks',
    'summary.warnings', 'recommendedApproach', 'very_hard', 'updatedAt', 'unconfirmedTypeSessions']) assert.ok(prompt.includes(field), field);
  assert.match(prompt, /Не назначай повторную ключевую работу/);
  assert.match(prompt, /качественная уверенность, не вероятность/);
  assert.ok(prompt.indexOf('1) hardSafetyRules') < prompt.indexOf('8) workoutTemplates'));
  assert.match(prompt, /не придумывай/);
});

test('spacing is not inferred as exact from calendar days, and progression changes one parameter', () => {
  const p = setup().aiPlanningSystemPrompt();
  for (const part of ['72 часов','48-71 час','меньше 48','времени суток','один главный параметр',
    'totalWorkMin/totalWorkDistanceKm','Не назначай максимальный объем']) assert.ok(p.includes(part), part);
});

test('HR zones do not prescribe measured threshold or equipment pace equivalence', () => {
  const c = setup(), p = c.aiPlanningSystemPrompt(), r = c.workoutReferenceForPlanning();
  for (const part of ['profile.heartRateZones', 'ЧСС вторична', '1% не гарантирует', 'durationMin/distanceKm',
    'среднему темпу всей интервальной', 'Не придумывай условия']) assert.ok(p.includes(part), part);
  assert.match(r.qualityIntensities.threshold, /не обязана занимать всю пользовательскую Z4/);
  assert.match(r.heartRateZonePriority, /индивидуальным границам/);
  assert.match(r.qualityIntensities.shortIntervals, /не автоматически VO2max/);
  assert.doesNotMatch(r.qualityIntensities.effort10k, /выше threshold/);
});

test('separate short intervals and aerobic power; long easy run supports speed phase', () => {
  const templates = setup().workoutTemplateLibrary();
  assert.equal(new Set(templates.map(t => t.id)).size, templates.length);
  const short = templates.find(t => t.id === 'short-controlled-intervals');
  const power = templates.find(t => t.id === 'aerobic-power-intervals');
  assert.match(short.structure, /30 секунд - 2 минуты/);
  assert.match(power.structure, /3-5 минут/);
  assert.ok(templates.find(t => t.id === 'long-run').phases.includes('speed'));
  assert.doesNotMatch(templates.find(t => t.id === 'threshold-tempo').structure, /в Z4\/RPE/);
  assert.match(power.constraints, /не переносить взрослый шаблон на детей/);
});

test('copied prompt and online request share instructions, context and response contract', () => {
  const c = setup(), request = c.buildAiRequest(), prompt = c.buildAiPrompt({summary:'SHOULD_NOT_BE_CONTEXT'});
  assert.ok(prompt.startsWith(request.system));
  assert.ok(prompt.includes(JSON.stringify(request.context, null, 2)));
  assert.ok(prompt.includes(JSON.stringify(c.aiPlanResponseSchema(), null, 2)));
  assert.ok(prompt.includes(JSON.stringify(request.planningWeek, null, 2)));
  assert.doesNotMatch(prompt, /SHOULD_NOT_BE_CONTEXT/);
  assert.equal(request.context.profile.targetDistance, '21k');
  assert.equal(request.context.profile.constraints, 'Original athlete constraints');
  assert.equal(request.planningWeek.days.length, 7);
  assert.ok(request.context.hardSafetyRules.some(s => s.includes('8-10')));
  assert.doesNotMatch(request.context.preparationBlockRules.join(' '), /быстрее\/короче/);
  assert.ok(c.aiPlanResponseSchema().days[0].date);
});

test('new summary fields are all shown without changing legacy string or object summaries', () => {
  const c = setup();
  const summary = {weekGoal:'goal',phaseDecision:'phase',selectedStimuli:['threshold','long'],
    loadDecision:'load',progressionDecision:'progression',warnings:['warning one','warning two']};
  const text = c.planSummaryText(summary);
  for (const v of ['goal','phase','threshold','long','load','progression','warning one','warning two']) assert.ok(text.includes(v), v);
  assert.doesNotMatch(text, /\[object Object\]|undefined/);
  assert.equal(c.planSummaryText('Legacy summary'), 'Legacy summary');
  assert.equal(c.planSummaryText({mainDecision:'Keep',loadComment:'Load',goal:'10k'}), 'Keep Load Goal: 10k');
  assert.doesNotMatch(c.planSummaryText({weekGoal:'goal',warnings:[]}), /Ограничения/);
});

test('contract requests full details only, optional plannedWorkout must not truncate them', () => {
  const c = setup(), schema = c.aiPlanResponseSchema();
  assert.ok(schema.days[0].details);
  assert.equal(schema.days[0].plannedWorkout, undefined);
  assert.equal(schema.days[0].actualWorkout, undefined);
  assert.match(c.aiPlanningSystemPrompt(), /повтори полное details, не сокращай/);
  const day = {details:'Warmup 15; 5 x 3 min; recover 2 min; cooldown 10', actualWorkout:'Untrusted fact'};
  assert.equal(c.splitPlanAndActual(day).planned, day.details);
  assert.equal(c.splitPlanAndActual(day).actual, '');
  assert.equal(c.splitPlanAndActual({details:'Old details',plannedWorkout:'Explicit legacy assignment'}).planned, 'Explicit legacy assignment');
});