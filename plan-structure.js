(function (root) {
  "use strict";
  const units = { min: ["duration", 60, "мин"], sec: ["duration", 1, "с"], m: ["distance", 1, "м"], km: ["distance", 1000, "км"] };
  const clean = value => String(value || "").trim();
  const rounded = value => Math.round(value * 1000) / 1000;
  function range(value, unit) {
    const match = clean(value).replace(/,/g, ".").replace(/[–—−]/g, "-").match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
    if (!match || !units[unit]) throw new Error("Укажите положительное число или диапазон, например 15-20.");
    const from = Number(match[1]) * units[unit][1], to = Number(match[2] || match[1]) * units[unit][1];
    return validateRange({ basis: units[unit][0], from, to });
  }
  function validateRange(value) {
    if (!value || !["duration", "distance"].includes(value.basis) ||
        !Number.isFinite(value.from) || !Number.isFinite(value.to) || value.from <= 0 || value.to < value.from ||
        value.to > (value.basis === "duration" ? 86400 : 200000)) throw new Error("Некорректный объем блока: проверьте диапазон и единицы.");
    return { basis: value.basis, from: rounded(value.from), to: rounded(value.to) };
  }
  function normalize(value) {
    try {
      if (!value || value.version !== 1 || !["easy", "tempo", "repeats"].includes(value.mode)) return null;
      const count = value.mode === "repeats" ? value.count : 1;
      if (!Number.isInteger(count) || count < 1 || count > 100 || (value.mode === "repeats" && count < 2)) return null;
      const block = b => {
        if (!b) return null;
        const intensity = clean(b.intensity);
        if (intensity.length > 200) throw new Error("Слишком длинная интенсивность.");
        return { ...validateRange(b), intensity };
      };
      const work = block(value.work);
      if (!work || !work.intensity) return null;
      const recovery = value.mode === "repeats" ? block(value.recovery) : null;
      if (value.mode === "repeats" && !recovery) return null;
      const notes = clean(value.notes);
      if (notes.length > 2000) return null;
      return { version: 1, mode: value.mode, count, warmup: block(value.warmup), work, recovery, cooldown: block(value.cooldown), notes };
    } catch { return null; }
  }
  function inputMeasure(value) {
    if (!value) return { value: "", unit: "min" };
    const unit = value.basis === "distance" ? (value.from >= 1000 ? "km" : "m") : (value.from >= 60 ? "min" : "sec");
    const factor = units[unit][1];
    return { value: String(rounded(value.from / factor)) + (value.to !== value.from ? "-" + rounded(value.to / factor) : ""), unit };
  }
  function formatMeasure(value) {
    const input = inputMeasure(value);
    return input.value + " " + units[input.unit][2];
  }
  function format(value) {
    const s = normalize(value);
    if (!s) return "";
    const describe = block => formatMeasure(block) + (block.intensity ? " в интенсивности " + block.intensity : "");
    const parts = [];
    if (s.warmup) parts.push("Разминка " + describe(s.warmup));
    if (s.mode === "repeats") parts.push((parts.length ? "затем " : "") + s.count + " x " + describe(s.work));
    else parts.push((s.mode === "tempo" ? "Темповая часть: " : "Легкий бег: ") + describe(s.work));
    if (s.recovery) parts.push("восстановление " + describe(s.recovery) + " между повторениями");
    if (s.cooldown) parts.push("заминка " + describe(s.cooldown));
    return parts.join("; ") + "." + (s.notes ? " " + s.notes : "");
  }
  function fromDay(day) {
    const s = normalize(day?.plannedStructure);
    // Text edits invalidate old blocks instead of silently overriding the new assignment.
    return s && clean(day.plannedWorkout || day.details) === format(s) && clean(day.intensity) === s.work.intensity ? s : null;
  }
  function prescription(day) {
    const s = fromDay(day);
    if (!s) return null;
    if (s.mode === "easy" && (s.warmup || s.cooldown)) {
      const blocks = [s.warmup, s.work, s.cooldown].filter(Boolean);
      if (blocks.some(b => b.basis !== s.work.basis)) return { supported: false, reason: "Для непрерывного бега блоки заданы в разных единицах; общий объем нельзя надежно сравнить без темпа каждого блока." };
      return { supported: true, mode: "easy", work: { basis: s.work.basis, from: blocks.reduce((n,b)=>n+b.from,0), to: blocks.reduce((n,b)=>n+b.to,0) }, intensity: s.work.intensity };
    }
    return { supported: true, mode: s.mode, count: { basis: "count", from: s.count, to: s.count }, work: s.work,
      warmup: s.warmup, cooldown: s.cooldown, recovery: s.recovery, intensity: s.work.intensity };
  }
  function segments(day, pace, fastFactor) {
    const s = fromDay(day);
    if (!s) return null;
    const result = [];
    function add(block, kind, count, factor) {
      if (!block || count <= 0) return;
      const value = (block.from + block.to) / 2;
      const duration = count * (block.basis === "duration" ? value / 60 : value / 1000 * pace * factor);
      result.push({ duration, kind, intensity: block.intensity });
    }
    add(s.warmup, "warmup", 1, 1.15);
    add(s.work, "work", s.count, s.mode === "easy" ? 1 : fastFactor);
    add(s.recovery, "recovery", s.count - 1, 1.15);
    add(s.cooldown, "cooldown", 1, 1.15);
    return result;
  }
  const api = { range, normalize, format, inputMeasure, fromDay, prescription, segments };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlanStructure = api;
})(globalThis);