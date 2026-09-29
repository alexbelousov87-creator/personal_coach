(function (root) {
  "use strict";
  const number = "\\d+(?:[.,]\\d+)?";
  const span = `(${number})(?:\\s*-\\s*(${number}))?`;
  const units = "(км|километр[а-яё]*|метр[а-яё]*|мин[а-яё]*|сек[а-яё]*|м|с)(?![а-яёa-z])";
  const measurePattern = `${span}\\s*${units}`;
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const rounded = value => Math.round(value * 10) / 10;
  function measure(match) {
    if (!match) return null;
    const low = Number(match[1].replace(",", "."));
    const high = Number((match[2] || match[1]).replace(",", "."));
    const unit = match[3];
    const basis = /^(км|километр|метр|м$)/.test(unit) ? "distance" : "duration";
    const factor = /^(км|километр)/.test(unit) ? 1000 : /^мин/.test(unit) ? 60 : 1;
    return Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low ? { basis, from: low * factor, to: high * factor } : null;
  }
  function readMeasure(text) { return measure(text.match(new RegExp(measurePattern, "i"))); }
  function textRange(range) {
    if (!range) return "не задано";
    const factor = range.basis === "duration" && range.from >= 60 ? 60 : 1;
    const unit = range.basis === "distance" ? "м" : factor === 60 ? "мин" : "с";
    return `${rounded(range.from / factor)}${range.to !== range.from ? `-${rounded(range.to / factor)}` : ""} ${unit}`;
  }
  const structureApi = typeof module === "object" && module.exports ? require("./plan-structure.js") : root.PlanStructure;
  function parse(day = {}) {
    const explicit = structureApi?.prescription(day);
    if (explicit) return explicit;
    const text = String(day.plannedWorkout || day.details || "").toLowerCase().replace(/[–—−]/g, "-").replace(/ё/g, "е");
    if (!text || /без (?:дополнительного )?бегов|полный отдых/.test(text)) return null;
    const qualityText = text.replace(/без\s+(?:темпов[а-я]*(?:\s+финиш[а-я]*)?|ускорени[а-я]*|интервал[а-я]*)/g, "");
    const quality = /интервал|темпо|порог|vo2|vo₂|отрез|усилии?\s*\d+\s*км|марафонск[а-я]*\s+усили/.test(qualityText);
    // Alternatives and nested sets must not silently become a single chosen prescription.
    const ambiguous = /\b\d+\s*[xх×]\s*\(|\d+\s*(?:сери[а-я]*|блок[а-я]*)\s*(?:по|:)|(?:^|[^а-я])(?:либо|или|если)(?:$|[^а-я])|при усталости|при признаках усталости|вместо/.test(text);
    const repeats = new RegExp(`${span}\\s*(?:[xх×]|(?:интервал[а-я]*|отрез[а-я]*|повтор[а-я]*)\\s+по)\\s*${measurePattern}`, "gi");
    const groups = [];
    for (const match of text.matchAll(repeats)) {
      const work = measure([null, match[3], match[4], match[5]]);
      if (!work) continue;
      const tail = text.slice(match.index + match[0].length).split(/[;.!]/)[0];
      if (work.basis === "duration" && work.to <= 30 && /strides|ускорени|свободно/.test(tail)) continue;
      groups.push({ count: { from: Number(match[1]), to: Number(match[2] || match[1]), basis: "count" }, work, end: match.index + match[0].length });
    }
    let main = groups[0];
    let mode = "repeats";
    if (!main && quality) {
      const continuous = text.match(new RegExp(`${measurePattern}\\s*(?:в\\s+)?(?:темп[а-я]*|порог[а-я]*|марафонск[а-я]*\\s+усили[а-я]*)`, "i"));
      const work = measure(continuous);
      if (work) { main = { count: { from: 1, to: 1, basis: "count" }, work, end: continuous.index + continuous[0].length }; mode = "tempo"; }
    }
    if (!main && !quality && !/strides|ускорени|[xх×]/.test(text.replace(/без ускорени[а-я]*/g, "")) && /легк|кросс|длител|z[12]|спокойн/.test(text)) {
      const work = measure(text.match(new RegExp(`^\\s*${measurePattern}`, "i")));
      if (work) { main = { work }; mode = "easy"; }
    }
    if (!main) return quality ? { supported: false, reason: "Не удалось однозначно выделить рабочую часть задания." } : null;
    if (ambiguous || groups.length > 1 || (main.count && (!Number.isInteger(main.count.from) || !Number.isInteger(main.count.to) || main.count.from < 1 || main.count.to < main.count.from))) {
      return { supported: false, reason: "В задании есть альтернативы, несколько серий или неоднозначная запись. Автоматическое сравнение не выбирает вариант за спортсмена." };
    }
    const named = name => measure(((text.match(new RegExp(`${name}[а-я]*\\s*[: -]?\\s*([^;.!]+)`)) || [])[1] || "").match(new RegExp(`^${measurePattern}`, "i")));
    const after = text.slice(main.end || text.length);
    const recoveryText = (after.match(/(?:восстанов[а-я]*|через)\s*([^;.!]+)/) || [])[1] || "";
    const clock = recoveryText.match(/^(\d+):(\d{2})(?:\s*-\s*(\d+):(\d{2}))?(?![\d:])/);
    const recovery = clock && Number(clock[2]) < 60 && Number(clock[4] || 0) < 60
      ? { basis: "duration", from: Number(clock[1]) * 60 + Number(clock[2]), to: Number(clock[3] || clock[1]) * 60 + Number(clock[4] || clock[2]) }
      : readMeasure(recoveryText);
    if (recoveryText && (!recovery || recovery.to < recovery.from)) return { supported: false, reason: "Не удалось однозначно прочитать длительность или дистанцию восстановления." };
    return { supported: true, mode, ...main, recovery, warmup: named("размин"), cooldown: named("замин"), intensity: String(day.intensity || "") };
  }
  function compare(day, workouts = []) {
    const plan = parse(day);
    if (!plan) return null;
    const output = { status: "unknown", coreMatches: null, rows: [], notes: [], summary: "Структура не проверена" };
    if (!workouts.length) return { ...output, status: "pending", summary: "Ожидается факт тренировки" };
    if (!plan.supported) return { ...output, notes: [plan.reason] };
    const structured = workouts.filter(w => w.workoutStructure?.source === "tcx-manual-laps" && Number(w.workoutStructure.confidence) >= 0.85);
    const candidates = plan.mode === "easy" ? workouts : structured;
    if (candidates.length !== 1) return { ...output, notes: [candidates.length > 1 ? "Несколько подходящих беговых тренировок: их рабочие части не объединяются автоматически." : "Нет надежно выделенных ручных кругов. Средний пульс, тип и общий TRIMP не подтверждают выполнение отрезков."] };
    const workout = candidates[0], structure = workout.workoutStructure;
    output.workoutId = workout.id || null;
    if (workouts.length > 1) output.notes.push("Сравнение относится к одной тренировке с ручными кругами; остальные занятия не добавлены к ее отрезкам.");
    function row(label, range, values, core = false, tolerance = null) {
      const numeric = values.filter(positive).map(Number);
      const actual = numeric.length === values.length && numeric.length
        ? { basis: range.basis, from: Math.min(...numeric), to: Math.max(...numeric) } : null;
      const allowance = tolerance === null ? Math.max(range.basis === "distance" ? 20 : 5, range.to * 0.1) : tolerance;
      const matches = actual ? actual.from >= range.from - allowance && actual.to <= range.to + allowance : null;
      output.rows.push({ label, planned: range.basis === "count" ? `${range.from}${range.to !== range.from ? `-${range.to}` : ""}` : textRange(range), actual: actual ? (range.basis === "count" ? `${actual.from}` : textRange(actual)) : "нет данных", matches, core });
    }
    if (plan.mode === "easy") {
      row("Объем бега", plan.work, [plan.work.basis === "duration" ? Number(workout.durationMin) * 60 : Number(workout.distanceKm) * 1000], true);
      const distance = readMeasure(String(day.targetDistance || "").replace(/[–—−]/g, "-"));
      if (plan.work.basis !== "distance" && distance?.basis === "distance") row("Дистанция", distance, [Number(workout.distanceKm) * 1000], true);
    } else {
      const segments = Array.isArray(structure.segments) ? structure.segments : [];
      if (!segments.every(s => s && ["work", "recovery"].includes(s.role)) ||
          !Array.isArray(structure.workGroups) || !Array.isArray(structure.recoveryGroups) ||
          ![...structure.workGroups, ...structure.recoveryGroups].every(g => g && Number.isInteger(g.count) && g.count > 0)) {
        return { ...output, notes: ["Структура кругов содержит неполные или некорректные данные."] };
      }
      const work = segments.filter(s => s.role === "work");
      const expected = structure.workGroups.reduce((sum, g) => sum + g.count, 0);
      const recoveryCount = structure.recoveryGroups.reduce((sum, g) => sum + g.count, 0);
      if (!expected || work.length !== expected || segments.filter(s => s.role === "recovery").length !== recoveryCount) {
        return { ...output, notes: ["Последовательность кругов отсутствует или сохранена не полностью. Округленного описания отрезков недостаточно для точного сравнения."] };
      }
      const key = plan.work.basis === "duration" ? "durationSec" : "distanceM";
      row("Рабочие отрезки", plan.count, [work.length], true, 0);
      row("Каждый отрезок", plan.work, work.map(s => s[key]), true);
      row("Всего работы", { basis: plan.work.basis, from: plan.work.from * plan.count.from, to: plan.work.to * plan.count.to }, [work.every(s => positive(s[key])) ? work.reduce((sum, s) => sum + Number(s[key]), 0) : null], true);
      if (plan.recovery) {
        const first = segments.findIndex(s => s.role === "work"), last = segments.map(s => s.role).lastIndexOf("work");
        const between = segments.slice(first, last + 1);
        const alternating = between.every((s, index) => s.role === (index % 2 ? "recovery" : "work"));
        const rests = between.filter(s => s.role === "recovery");
        const recoveryKey = plan.recovery.basis === "duration" ? "durationSec" : "distanceM";
        row("Восстановление между", plan.recovery, alternating && rests.length === work.length - 1 ? rests.map(s => s[recoveryKey]) : [], true);
      }
      for (const [key, label] of [["warmup", "Разминка"], ["cooldown", "Заминка"]]) {
        if (plan[key]) row(label, plan[key], [plan[key].basis === "duration" && positive(structure[`${key}Min`]) ? Number(structure[`${key}Min`]) * 60 : null], false, 60);
      }
    }
    const core = output.rows.filter(r => r.core);
    output.coreMatches = core.some(r => r.matches === false) ? false : core.some(r => r.matches === null) ? null : true;
    output.status = output.rows.some(r => r.matches === false) ? "different" : output.rows.some(r => r.matches === null) ? "partial" : "matched";
    output.summary = { different: "Есть отличия в структуре", partial: "Структура проверена частично", matched: "Измеримая структура близка к заданию" }[output.status];
    output.notes.push("Допуск размеров отрезков и объема: 10%, минимум 20 м или 5 с; количество отрезков должно попадать в заданный диапазон. Для разминки и заминки по времени: 1 мин.");
    output.notes.push(plan.intensity ? `Интенсивность «${plan.intensity}» не проверена: средний темп и пульс всей тренировки не заменяют данные рабочих отрезков.` : "Сравнение объема и кругов не подтверждает заданную интенсивность.");
    return output;
  }
  const api = { parse, compare };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutComparison = api;
})(globalThis);