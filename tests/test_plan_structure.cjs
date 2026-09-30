const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parse, compare } = require("../workout-comparison.js");
const day = (details, extra = {}) => ({ details, ...extra });
function workout(count = 5, durationSec = 210, distanceM = 1000, restSec = 150) {
  const segments = [];
  for (let i = 0; i < count; i++) {
    segments.push({ role: "work", durationSec, distanceM });
    if (i < count - 1) segments.push({ role: "recovery", durationSec: restSec, distanceM: 400 });
  }
  return { id: "test", sport: "Running", load: 100, durationMin: 60, distanceKm: 12,
    workoutStructure: { source: "tcx-manual-laps", confidence: 0.96, kind: "intervals", warmupMin: 18, cooldownMin: 13,
      workGroups: [{ count, basis: "distance", value: distanceM }], recoveryGroups: count > 1 ? [{ count: count - 1 }] : [], segments } };
}
const base = "Разминка 18-20 минут; затем 5 x 1000 м в усилии 10 км; восстановление 2:30 трусцой; заминка 12-15 минут.";
test("parse repeats, clock recovery and warmup/cooldown", () => {
  const p = parse(day(base));
  assert.equal(p.supported, true);
  assert.deepEqual(p.count, { from: 5, to: 5, basis: "count" });
  assert.deepEqual(p.work, { from: 1000, to: 1000, basis: "distance" });
  assert.equal(p.recovery.from, 150);
  assert.equal(p.warmup.from, 1080);
});
test("matching manual laps match measured structure", () => {
  const result = compare(day(base), [workout()]);
  assert.equal(result.status, "matched");
  assert.equal(result.coreMatches, true);
  assert.equal(result.rows.length, 6);
});
test("work count lower or higher is not masked by similar load", () => {
  for (const count of [3, 6]) {
    const result = compare(day(base), [workout(count)]);
    assert.equal(result.status, "different");
    assert.equal(result.coreMatches, false);
    assert.equal(result.rows[0].matches, false);
  }
});
test("count ranges are accepted", () => {
  assert.equal(compare(day("4-5 × 1 км в усилии 10 км"), [workout()]).status, "matched");
});
test("time-based repetitions compare time even when import chose distance basis", () => {
  const result = compare(day("8х2 минуты в VO2max; восстановление 90 секунд"), [workout(8, 120, 530, 90)]);
  assert.equal(result.status, "matched");
  assert.equal(result.rows[2].actual, "16 мин");
});
test("count and work distance must both match", () => {
  assert.equal(compare(day(base), [workout(5, 190, 800)]).coreMatches, false);
});
test("one oversized lap is not hidden by averages", () => {
  const w = workout(); w.workoutStructure.segments[2].distanceM = 1600;
  assert.equal(compare(day(base), [w]).rows[1].matches, false);
});
test("GPS/lap tolerances do not reject small differences", () => {
  assert.equal(compare(day(base), [workout(5, 210, 990, 154)]).status, "matched");
});
test("long recovery is a structural difference, not proof of greater TRIMP", () => {
  const result = compare(day(base), [workout(5, 210, 1000, 240)]);
  assert.equal(result.coreMatches, false);
  assert.equal(result.rows.find(r => r.label === "Восстановление между").matches, false);
});
test("warmup and cooldown omissions are unknown, not zero", () => {
  const w = workout(); w.workoutStructure.warmupMin = null;
  const result = compare(day(base), [w]);
  assert.equal(result.status, "partial");
  assert.equal(result.coreMatches, true);
  assert.equal(result.rows.find(r => r.label === "Разминка").actual, "нет данных");
});
test("strides in warmup are not added to main repeats", () => {
  const p = parse(day("Разминка 15 минут + 4 x 15 секунд ускорений; затем 5 x 1000 м в усилии 10 км; заминка 12 минут"));
  assert.equal(p.supported, true);
  assert.equal(p.count.from, 5);
});
test("standalone easy run with strides is not an interval assignment", () => {
  assert.equal(parse(day("60 минут легко; затем 6 x 15 секунд strides")), null);
});
test("tempo blocks and continuous tempo compare separately", () => {
  assert.equal(compare(day("2 x 20 минут в пороговом усилии; восстановление 5 минут"), [workout(2, 1200, 5000, 300)]).status, "matched");
  assert.equal(compare(day("Разминка 18 минут; затем 20 минут темпо; заминка 13 минут"), [workout(1, 1200, 5000)]).status, "matched");
});
test("natural repetition notation and decimal kilometers", () => {
  assert.equal(compare(day("5 интервалов по 1,0 км"), [workout()]).status, "matched");
});
test("alternatives and multi-series plans are not silently reduced", () => {
  for (const text of ["5 x 1000 м или 8 x 2 минуты", "3 x (4 x 400 м)", "2 серии по 5 x 1000 м", "5 x 1000 м + 4 x 400 м"]) {
    assert.equal(compare(day(text), [workout()]).status, "unknown", text);
  }
});
test("no imported manual structure cannot be replaced by type or average HR", () => {
  const result = compare(day(base), [{ sport: "Running", workoutTypeOverride: "interval", avgHr: 180, durationMin: 60 }]);
  assert.equal(result.status, "unknown");
  assert.equal(result.coreMatches, null);
});
test("low-confidence structure is not definitive", () => {
  const w = workout(); w.workoutStructure.confidence = 0.6;
  assert.equal(compare(day(base), [w]).status, "unknown");
});
test("rounded group targets alone are insufficient", () => {
  const w = workout(); delete w.workoutStructure.segments;
  assert.equal(compare(day(base), [w]).status, "unknown");
});
test("truncated sequences cannot claim a match", () => {
  const w = workout(30); w.workoutStructure.segments = w.workoutStructure.segments.slice(0, 50);
  assert.equal(compare(day("30 x 1000 м"), [w]).status, "unknown");
});
test("multiple workouts are never concatenated", () => {
  assert.equal(compare(day(base), [workout(3), workout(2)]).status, "unknown");
});
test("one structured run may be selected, with explicit additional-run note", () => {
  const result = compare(day(base), [workout(), { sport: "Running", durationMin: 20 }]);
  assert.equal(result.status, "matched");
  assert.match(result.notes[0], /одной тренировке/);
});
test("missing recovery between some repeats is not treated as matching", () => {
  const w = workout(); w.workoutStructure.segments.splice(1, 1); w.workoutStructure.recoveryGroups[0].count--;
  assert.equal(compare(day(base), [w]).coreMatches, null);
});
test("easy duration and distance use total run, not interval segments", () => {
  const result = compare(day("55-65 минут легко. Без ускорений.", { targetDistance: "10-13 км" }), [workout()]);
  assert.equal(result.status, "matched");
  assert.equal(result.rows.length, 2);
});
test("no actual workout is pending, not a failed comparison", () => {
  assert.equal(compare(day(base), []).status, "pending");
});
test("input records are unchanged", () => {
  const d = day(base), w = workout(), before = JSON.stringify([d, w]);
  compare(d, [w]); assert.equal(JSON.stringify([d, w]), before);
});
test("intensity is not inferred from overall pace or HR", () => {
  const result = compare(day(base, { intensity: "4:00 мин/км" }), [workout()]);
  assert.match(result.notes.at(-1), /не проверена/);
});
test("clock recovery range is preserved", () => {
  assert.deepEqual(parse(day("5x1000м; восстановление 2:00-2:30 трусцой")).recovery, { basis: "duration", from: 120, to: 150 });
});
test("warmup accelerations do not invent a warmup duration", () => {
  assert.equal(parse(day("Разминка легко + 4x15 секунд ускорений; затем 5x1000м")).warmup, null);
});
test("unreadable recovery is explicitly unsupported", () => {
  assert.equal(parse(day("5x1000м; восстановление до полного отдыха")).supported, false);
});
test("easy long run without a tempo finish is not a tempo assignment", () => {
  assert.equal(compare(day("120-135 минут легко, без темпового финиша"), [{ durationMin: 122, distanceKm: 26 }]).status, "matched");
});
test("continuous marathon effort is recognized as structured work", () => {
  assert.equal(parse(day("20 минут в марафонском усилии")).mode, "tempo");
});
test("malformed imported structure degrades to unknown without crashing", () => {
  for (const change of [{ segments: [null] }, { workGroups: {} }, { recoveryGroups: [null] }, { segments: [{ role: "unknown" }] }]) {
    const w = workout(); Object.assign(w.workoutStructure, change);
    assert.equal(compare(day(base), [w]).status, "unknown");
  }
});
test("equal recovery counts do not hide missing recovery between a pair of repeats", () => {
  const w = workout();
  const segments = w.workoutStructure.segments;
  [segments[2], segments[3]] = [segments[3], segments[2]];
  assert.equal(compare(day(base), [w]).coreMatches, null);
});