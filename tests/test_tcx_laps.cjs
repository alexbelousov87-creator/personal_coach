const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const context = vm.createContext({ tcxLapRows: (rows) => rows });
for (const name of ["analyzeTcxLaps", "hasTcxIntervalRepeats", "isTcxBoundaryLap", "splitTcxLapIntensity", "percentile", "round", "average"]) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
}
function classify(pairs, trigger = "Manual") {
  return context.analyzeTcxLaps(pairs.map(([duration, distance], index) => ({
    duration, distance, index, trigger, speed: distance / duration * 3.6,
  })));
}
function repeats(count, work, rest) {
  return [[1200, 4000], ...Array.from({ length: count }, () => [work, rest]).flat(), [1200, 4000]];
}
test("short work and short recovery form intervals", () => {
  const result = classify(repeats(10, [38, 186], [36, 115]));
  assert.equal(result.hasIntervalLaps, true);
  assert.equal(result.hasTempoLaps, false);
});
test("warmup strides alone do not form intervals", () => {
  assert.equal(classify(repeats(6, [15, 80], [80, 220])).hasIntervalLaps, false);
});
test("tempo recovery laps are not counted as work", () => {
  const result = classify(repeats(4, [720, 3200], [120, 330]));
  assert.equal(result.hasIntervalLaps, false);
  assert.equal(result.hasTempoLaps, true);
});
test("longer intervals still qualify", () => {
  assert.equal(classify(repeats(5, [460, 2000], [120, 330])).hasIntervalLaps, true);
});
test("accidental short laps do not invalidate intervals", () => {
  const laps = repeats(8, [75, 400], [65, 180]);
  laps.splice(5, 0, [2, 12]);
  assert.equal(classify(laps).hasIntervalLaps, true);
});
test("uninterrupted fast laps have no recovery", () => {
  const laps = [[1200, 4000], ...Array(10).fill([38, 190]), [1200, 4000]];
  assert.equal(classify(laps).hasIntervalLaps, false);
});
test("automatic kilometer laps do not prove intervals", () => {
  const result = classify(Array(12).fill([272, 1000]), "Distance");
  assert.equal(result.hasAutoDistanceOnly, true);
  assert.equal(result.hasIntervalLaps, false);
});
