const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
function setup() {
  const context = vm.createContext({
    state: { profile: { maxHr: 200, targetDistance: "10k" }, workouts: [] },
    WORKOUT_TYPE_OPTIONS: ["auto", "easy", "recovery", "long", "interval", "tempo", "cross", "race"].map(v => [v, v]),
    numberOrNull: v => Number(v) || null,
    isRunningWorkout: w => w.sport === "Running",
    actualWorkoutsForPlanDay: d => d.actual || [],
    planCompletionWorkoutsForDay: d => (d.actual || []).filter(w => d.noRun || w.sport === "Running"),
    plannedTypeForDay: d => d.type,
    planExpectsNoRun: d => !!d.noRun,
    plannedLoadScoreForDay: d => d.load,
    planTypeMatchesActual: (planned, actual) => planned === actual,
    plannedTypeLabelForDay: (d, t) => t,
    actualTypeLabel: t => t,
    trustedPace: () => null,
    formatTrustedPace: () => "",
    workoutFeedbackLabel: v => v,
    isPlanDayCompleted: () => false,
    findBackToBackHeavyActualDays: () => null,
    findClosePlannedHardStimuli: () => null,
  });
  for (const name of ["validWorkoutType", "workoutClassificationResult", "getWorkoutClassification", "getAutomaticWorkoutClassification", "getWorkoutType", "classifyWorkout", "matchesAny", "hasStrongSampleIntervalPattern", "renderWorkoutClassification", "escapeHtml", "workoutTypeLabel", "evaluatePlanDayExecution", "planTypeRequiresRunning", "workoutForAiContext", "compactWorkoutStructureForAi", "buildTrainingHistorySummary", "buildWeeklyTrainingHistory", "compactKeySession", "round", "addDays", "startOfDay", "toDateInputValue", "startOfTrainingWeek", "completedWorkoutTypesForWeek", "adaptPlanToCompletedWorkouts", "planDay", "weekRange", "buildPlanWarnings"]) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const end = source.indexOf("\nfunction ", start + 1);
    vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
  }
  context.workoutsInDateRange = () => context.state.workouts;
  return context;
}
const run = (overrides = {}) => ({ sport: "Running", durationMin: 60, distanceKm: 12, avgHr: 140, load: 80, ...overrides });
const intervals = () => run({ lapSignals: { hasIntervalLaps: true, manualCount: 12, manualRatio: 1, speedRange: 5 }, workoutStructure: { kind: "intervals", display: "5 x 1000 м", workGroups: [{ count: 5 }], recoveryGroups: [{ count: 4 }] } });
const day = (type, actual, load = 80, extra = {}) => ({ date: "2026-09-22", type, actual, load, ...extra });

test("manual choice takes precedence without mutating source data", () => {
  const c = setup(), w = run({ avgHr: 175, workoutTypeOverride: "easy" });
  const before = JSON.stringify(w);
  assert.equal(c.getWorkoutClassification(w).confidence, "manual");
  assert.equal(c.getWorkoutType(w), "easy");
  assert.equal(c.classifyWorkout(w), "tempo");
  assert.equal(JSON.stringify(w), before);
  delete w.workoutTypeOverride;
  assert.equal(c.getWorkoutClassification(w).confidence, "low");
});
test("repeated manual work and recovery is strong evidence", () => {
  const result = setup().getWorkoutClassification(intervals());
  assert.equal(result.type, "interval");
  assert.equal(result.confidence, "high");
  assert.equal(result.canRejectOtherTypes, true);
});
test("legacy interval flag without supporting evidence remains medium", () => {
  assert.equal(setup().getWorkoutClassification(run({ lapSignals: { hasIntervalLaps: true } })).confidence, "medium");
});
test("pulse, load and effort alone are tentative type evidence", () => {
  const c = setup();
  for (const props of [{ avgHr: 175 }, { load: 150 }, { rpe: 7 }, { rpe: 9 }]) {
    const result = c.getWorkoutClassification(run(props));
    assert.equal(result.needsReview, true);
    assert.equal(result.canRejectOtherTypes, false);
  }
});
test("notes including negations and numeric descriptions remain tentative", () => {
  const c = setup();
  const w = intervals(); w.notes = "без темпо";
  const result = c.getWorkoutClassification(w);
  assert.equal(result.confidence, "low");
  assert.ok(result.limitations.some(s => s.includes("разные типы")));
  assert.equal(c.getWorkoutClassification(run({ notes: "1000" })).needsReview, true);
});
test("long manual laps alone do not prove tempo", () => {
  const c = setup(), w = run({ lapSignals: { hasTempoLaps: true } });
  assert.equal(c.getWorkoutClassification(w).confidence, "low");
  w.workoutStructure = { kind: "tempo-blocks", totalWorkMin: 24 };
  assert.equal(c.getWorkoutClassification(w).confidence, "medium");
});
test("missing duration does not imply tempo from zero versus zero load", () => {
  assert.equal(setup().getWorkoutClassification({ sport: "Running" }).type, "easy");
});
test("unknown sport is distinct from a known nonrunning sport", () => {
  const c = setup();
  assert.equal(c.getWorkoutClassification({ sport: "Other" }).confidence, "low");
  assert.equal(c.getWorkoutClassification({ sport: "SkiErg" }).confidence, "high");
});
test("long-run evidence follows active athlete target, not another profile", () => {
  const c = setup(), w = run({ durationMin: 80 });
  assert.equal(c.getWorkoutClassification(w).type, "long");
  c.state.profile.targetDistance = "42k";
  assert.equal(c.getWorkoutClassification(w).type, "easy");
});
test("automatic distance laps do not prove intervals", () => {
  const c = setup(), w = run({ lapSignals: { hasAutoDistanceOnly: true }, intervalSignals: { hasIntervalPattern: true, fastSegments: 8, recoverySegments: 8, speedRange: 5, speedSurgeRatio: 1.3 } });
  assert.equal(c.getWorkoutClassification(w).type, "easy");
  delete w.lapSignals;
  assert.equal(c.getWorkoutClassification(w).confidence, "medium");
  assert.equal(c.getWorkoutType(w), "interval");
});
test("tentative mismatch is neutral, not another type", () => {
  const result = setup().evaluatePlanDayExecution(day("easy", [run({ avgHr: 175 })]));
  assert.equal(result.level, "uncertain");
  assert.equal(result.keyCompleted, false);
  assert.equal(result.completed, true);
  assert.doesNotMatch(result.label, /другой тип/);
});
test("tentative matching type does not credit a key session", () => {
  assert.equal(setup().evaluatePlanDayExecution(day("tempo", [run({ avgHr: 175 })])).keyCompleted, false);
});
test("uncertain types retain independent load assessment", () => {
  const c = setup();
  for (const [load, level] of [[150, "overloaded"], [120, "harder"], [30, "lighter"]]) {
    const result = c.evaluatePlanDayExecution(day("easy", [run({ avgHr: 175, load })]));
    assert.equal(result.level, level);
    assert.equal(result.typeUncertain, true);
    assert.doesNotMatch(result.label, /другой тип/);
    assert.match(result.comment, /Тип требует уточнения/);
  }
});
test("confirmed different format remains a mismatch", () => {
  assert.equal(setup().evaluatePlanDayExecution(day("tempo", [intervals()])).level, "mismatch");
});
test("manual match credits work and is not blocked by a tentative extra", () => {
  const c = setup();
  const result = c.evaluatePlanDayExecution(day("interval", [run({ workoutTypeOverride: "interval", load: 60 }), run({ avgHr: 175, load: 20 })]));
  assert.equal(result.level, "matched");
  assert.equal(result.keyCompleted, true);
});
test("actual running on explicit no-run day remains a mismatch", () => {
  assert.equal(setup().evaluatePlanDayExecution(day("rest", [run({ avgHr: 175 })], 80, { noRun: true })).level, "mismatch");
});
test("nonrunning extra does not credit a running assignment", () => {
  const c = setup();
  const result = c.evaluatePlanDayExecution(day("easy", [{ sport: "SkiErg", load: 80 }]));
  assert.equal(result.completed, false);
  assert.equal(result.level, "mismatch");
  assert.equal(c.evaluatePlanDayExecution(day("easy", [{ sport: "Other", load: 80 }])).level, "uncertain");
});
test("medium evidence cannot disprove another type", () => {
  assert.equal(setup().evaluatePlanDayExecution(day("interval", [run()])).level, "uncertain");
});
test("classification explanation escapes imported text", () => {
  const html = setup().renderWorkoutClassification({ sport: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
test("AI receives evidence and uncertainty without changing load", () => {
  const result = setup().workoutForAiContext(run({ avgHr: 175 }));
  assert.equal(result.workoutClassification.needsReview, true);
  assert.equal(result.load, 80);
  assert.ok(result.workoutClassification.reasons.length);
});
test("AI aggregates retain total volume but separate unconfirmed key types", () => {
  const c = setup();
  c.state.workouts = [run({ avgHr: 175 }), intervals()];
  const summary = c.buildTrainingHistorySummary();
  assert.equal(summary.qualitySessions, 1);
  assert.equal(summary.unconfirmedTypeSessions, 1);
  assert.equal(summary.load, 160);
  assert.equal(summary.runningKm, 24);
  const week = c.buildWeeklyTrainingHistory(1)[0];
  assert.equal(week.qualitySessions, 1);
  assert.equal(week.unconfirmedTypeSessions, 1);
  assert.equal(week.load, 160);
});
test("local adjustment stays conservative without claiming tentative work is confirmed", () => {
  const c = setup(), today = new Date(), tomorrow = new Date(today.getTime() + 86400000);
  c.state.workouts = [run({ avgHr: 175, date: today.toISOString() })];
  const week = c.startOfTrainingWeek(today);
  assert.equal(c.completedWorkoutTypesForWeek(week).has("tempo"), true);
  assert.equal(c.completedWorkoutTypesForWeek(week, true).has("tempo"), false);
  const adjusted = c.adaptPlanToCompletedWorkouts([{ date: tomorrow.toISOString(), focus: "Темпо" }], week, { secondEasyTitle: "Easy", secondEasyDetails: "Easy running" }, false)[0];
  assert.equal(adjusted.focus, "Кросс");
  assert.match(adjusted.details, /требует уточнения/);
  assert.doesNotMatch(adjusted.details, /уже выполнена/);
});
test("week warning distinguishes uncertain type from a missed assignment", () => {
  const warnings = setup().buildPlanWarnings({ uncertainDays: 1, dailyLoads: [], monotony: {}, days: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /не подтверждённая замена или пропуск/);
});