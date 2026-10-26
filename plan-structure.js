(function (root) {
  "use strict";
  const units = { min: ["duration", 60, "мин"], sec: ["duration", 1, "с"], m: ["distance", 1, "м"], km: ["distance", 1000, "км"] };
  const clean = value => String(value || "").trim();
  const rounded = value => Math.round(value * 1000) / 1000;
  function stimulusText(value) {
    let text = String(value || "").toLowerCase();
    const modifier = "(?:(?:вчерашн|сегодняшн|завтрашн|предыдущ|прошл|следующ|понедельничн|вторничн|средов|четвергов|пятничн|субботн|воскресн|тяжел|тяжёл|интенсивн)[а-яё]*\\s+){0,3}";
    const session = "(?:порог[а-яё]*|темпов[а-яё]*|интервал[а-яё]*|длитель[а-яё]*|гонк[а-яё]*|старт[а-яё]*|vo2max|vo₂max|threshold|ускорени[а-яё]*|strides)";
    // References to another session are context, not today's prescribed stimulus.
    text = text.replace(new RegExp(`(?:после|перед|накануне|вслед за)\\s+${modifier}${session}(?:\\s+(?:работ|тренировк|бег)[а-яё]*)?`, "gu"), " ");
    // A postfix prohibition is not a prescription (but "not a sprint" can qualify real strides).
    text = text.replace(/(?:ускорени[а-яё]*|strides|интервал[а-яё]*|темпов[а-яё]*\s+(?:работ[а-яё]*|встав[а-яё]*|блок[а-яё]*))\s+(?:не\s+(?:выполнять|добавлять|делать|нужны)|исключены|запрещены)(?![а-яё])/gu, " ");
    const excludedStimulus = /^(?:без|не(?:\s+(?:как|(?:(?:нужно|следует|стоит)\s+)?(?:добавлять|добавляйте|выполнять|выполняйте|делать|делайте|включать|включайте|проводить|проводите)))?)\s+(?:перехода\s+в\s+)?(?:(?:дополнительн|полноценн|тяжел|тяжёл|коротк|быстр|прогрессивн|финишн|длинн|резк|лишн|специальн)[а-яё]*\s+){0,3}(?:темп|порог|интервал|ускор|прогрес|горок|гонк|спринт|максимальн|strides|vo2|vo₂|threshold|sprint|попытки\s+сразу\s+достичь)/u;
    return text.replace(/(?:без|не(?:\s+как)?)\s+[^.;!?\n]*?(?=[.;!?\n]|,\s*(?:затем|далее|но|а\s|в\s+конце|\d+\s*(?:мин|км))|\s+(?:затем|далее)\s|$)/gu,
      fragment => excludedStimulus.test(fragment) ? " " : fragment);
  }
  function hasStrides(value) {
    return /(?:^|[^а-яёa-z])(?:ускорени[а-яё]*|strides)(?![а-яёa-z])/u.test(stimulusText(value));
  }
  // Only a prescribed run, not a strength session's warmup, can take precedence over supplementary mobility.
  function primaryRunText(value) {
    const text = stimulusText(value).replace(/ё/g, "е");
    const volume = "\\d+(?:[.,]\\d+)?(?:\\s*[-–—]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:мин[а-я]*|км)(?![а-я])";
    const running = "(?:(?:очень|преимущественно)\\s+)*(?:легко(?![а-я])|спокойно(?![а-я])|(?:легк|спокойн|восстановительн)[а-я]*\\s+бег[а-я]*|бег[а-я]*|в\\s+z[12])";
    const pattern = new RegExp(`${volume}\\s+${running}|(?:легк|спокойн|восстановительн)[а-я]*\\s+бег[а-я]*\\s*[: -]?\\s*${volume}`, "gu");
    for (const match of text.matchAll(pattern)) {
      const preceding = text.slice(0,match.index);
      if (!/размин|замин|офп|мобилити|силов|координац|баланс|без бег|бег[^.;!?]*запрещ/u.test(preceding)) return text.slice(match.index).split(/[;!?\n]|\.(?!\d)/u)[0];
    }
    return "";
  }
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
  const api = { stimulusText, hasStrides, primaryRunText, range, normalize, format, inputMeasure, fromDay, prescription, segments };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlanStructure = api;
})(globalThis);