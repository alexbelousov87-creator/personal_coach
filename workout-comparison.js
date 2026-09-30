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
    let text = String(day.plannedWorkout || day.details || "").toLowerCase().replace(/[–—−]/g, "-").replace(/ё/g, "е");
    const conditional = text.search(/[.;]\s*при (?:усталости|признаках усталости)(?=\s|[,:.-]|$)/i);
    // A conditional fallback does not invalidate a fully completed primary prescription.
    const conditionalAlternative = conditional >= 0;
    if (conditionalAlternative) text = text.slice(0, conditional);
    if (!text || /^\s*(?:без (?:дополнительного )?бегов|полный отдых)/.test(text)) return null;
    const qualityText = text.replace(/без\s+(?:темпов[а-я]*(?:\s+финиш[а-я]*)?|ускорени[а-я]*|интервал[а-я]*)/g, "");
    const quality = /интервал|темпо|порог|vo2|vo₂|отрез|усилии?\s*\d+\s*км|марафонск[а-я]*\s+усили/.test(qualityText);
    // Alternatives and nested sets must not silently become a single chosen prescription.
    const ambiguityText = text.replace(/(?:восстанов[а-я]*|через)\s*[^;!]*?(?=\.(?!\d)|[;!]|$)/g, part => part.replace(/(?:^|\s)(?:или|либо)(?=\s|$)/g, " "));
    const ambiguous = /\b\d+\s*[xх×]\s*\(|\d+\s*(?:сери[а-я]*|блок[а-я]*)\s*(?:по|:)|(?:^|[^а-я])(?:либо|или|если)(?:$|[^а-я])|при усталости|при признаках усталости|вместо/.test(ambiguityText);
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
    const recoveryText = (after.match(/(?:восстанов[а-я]*|через)\s*([^;!]*?)(?=\.(?!\d)|[;!]|$)/) || [])[1] || "";
    const recoveryOptions = recoveryText ? recoveryText.split(/\s+(?:или|либо)\s+/).map(part => {
      const clock = part.trim().match(/^(\d+):(\d{2})(?:\s*-\s*(\d+):(\d{2}))?(?![\d:])/);
      return clock && Number(clock[2]) < 60 && Number(clock[4] || 0) < 60
        ? { basis: "duration", from: Number(clock[1]) * 60 + Number(clock[2]), to: Number(clock[3] || clock[1]) * 60 + Number(clock[4] || clock[2]) }
        : measure(part.trim().match(new RegExp(`^${measurePattern}`, "i")));
    }) : [];
    const recovery = recoveryOptions[0] || null;
    if (recoveryOptions.some(option => !option || option.to < option.from)) return { supported: false, reason: "Не удалось однозначно прочитать длительность или дистанцию восстановления." };
    return { supported: true, mode, conditionalAlternative, ...main, recovery, recoveryOptions, warmup: named("размин"), cooldown: named("замин"), intensity: String(day.intensity || "") };
  }
  function compare(day, workouts = []) {
    const plan = parse(day);
    if (!plan) return null;
    const output = { mode: plan.mode, status: "unknown", coreMatches: null, rows: [], notes: [], summary: "Структура не проверена" };
    if (!workouts.length) return { ...output, status: "pending", summary: "Ожидается факт тренировки" };
    if (!plan.supported) return { ...output, notes: [plan.reason] };
    if (plan.conditionalAlternative) output.notes.push("Сравнивается основной вариант задания. Условный облегченный вариант требует проверки тренером.");
    const structured = workouts.filter(w => w.workoutStructure?.source === "tcx-manual-laps" && Number(w.workoutStructure.confidence) >= 0.85);
    const candidates = plan.mode === "easy" ? workouts : structured;
    if (candidates.length !== 1) return { ...output, notes: [candidates.length > 1 ? "Несколько подходящих беговых тренировок: их рабочие части не объединяются автоматически." : "Нет надежно выделенных ручных кругов. Средний пульс, тип и общий TRIMP не подтверждают выполнение отрезков."] };
    const workout = candidates[0], structure = workout.workoutStructure;
    output.workoutId = workout.id || null;
    output.actualTypeOverride = workout.workoutTypeOverride || "";
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
      const evidence = lapEvidence(segments);
      output.lapEvidence = evidence;
      if (work.length > 1 && !evidence.continuous) {
        output.rows.push({ label: "Чередование работы и отдыха", planned: "восстановление между отрезками", actual: "неполная последовательность", matches: null, core: true });
      }
      if (plan.recovery) {
        const options = plan.recoveryOptions?.length ? plan.recoveryOptions : [plan.recovery];
        const start = output.rows.length;
        for (const option of options) {
          const recoveryKey = option.basis === "duration" ? "durationSec" : "distanceM";
          row("Восстановление между", option, evidence.continuous ? evidence.recoveries.map(s => s[recoveryKey]) : [], true,
            Math.max(option.basis === "duration" ? 15 : 50, option.to * 0.25));
        }
        if (options.length > 1) {
          const variants = output.rows.splice(start);
          output.rows.push({ label: "Восстановление между", planned: variants.map(r => r.planned).join(" или "),
            actual: variants.map(r => r.actual).join(" / "), core: true,
            matches: variants.some(r => r.matches === true) ? true : variants.some(r => r.matches === null) ? null : false });
          output.notes.push("Для восстановления достаточно соответствия одному из явно заданных вариантов.");
        }
      }
      for (const [key, label] of [["warmup", "Разминка"], ["cooldown", "Заминка"]]) {
        if (plan[key]) row(label, plan[key], [plan[key].basis === "duration" && positive(structure[`${key}Min`]) ? Number(structure[`${key}Min`]) * 60 : null], false, 60);
      }
    }
    const core = output.rows.filter(r => r.core);
    output.coreMatches = core.some(r => r.matches === false) ? false : core.some(r => r.matches === null) ? null : true;
    output.status = output.rows.some(r => r.matches === false) ? "different" : output.rows.some(r => r.matches === null) ? "partial" : "matched";
    if (plan.conditionalAlternative && output.coreMatches !== true) {
      output.coreMatches = null;
      output.notes.push("Основной вариант не подтвержден полностью. Нужно уточнить, выполнялся ли облегченный вариант.");
    }
    output.summary = { different: "Есть отличия в структуре", partial: "Структура проверена частично", matched: "Измеримая структура близка к заданию" }[output.status];
    output.notes.push("Допуск размеров отрезков и объема: 10%, минимум 20 м или 5 с; количество отрезков должно попадать в заданный диапазон. Для разминки и заминки по времени: 1 мин.");
    if (output.lapEvidence) {
      output.notes.push("Проверена последовательность рабочих кругов и восстановления. Соседние круги восстановления объединяются; рабочие отрезки не объединяются.");
      output.notes.push("Допуск восстановления: 25%, минимум 15 с или 50 м. Более заметное отличие требует проверки. Разминка и заминка оцениваются отдельно от зачета основной работы.");
      const { hrPairs, hrDropPairs, slowerPairs, recoveries } = output.lapEvidence;
      if (recoveries.length) output.notes.push(`Восстановление медленнее соседних рабочих кругов: ${slowerPairs} из ${recoveries.length}. Сравнение по дистанции и времени кругов доступно при наличии обоих показателей.`);
      if (hrPairs) output.notes.push(`ЧСС доступна для ${hrPairs} пар работы и восстановления; снижение среднего пульса отмечено в ${hrDropPairs}. Его снижение не обязательно: на коротких отрезках ЧСС запаздывает.`);
    }
    output.notes.push(plan.intensity ? `Интенсивность «${plan.intensity}» не проверена: средний темп и пульс всей тренировки не заменяют данные рабочих отрезков.` : "Сравнение объема и кругов не подтверждает заданную интенсивность.");
    return output;
  }
  function lapEvidence(segments) {
    const positions = segments.map((s, i) => s.role === "work" ? i : -1).filter(i => i >= 0);
    const recoveries = [];
    let continuous = true, hrPairs = 0, hrDropPairs = 0, slowerPairs = 0;
    for (let i = 1; i < positions.length; i++) {
      const left = segments[positions[i - 1]], right = segments[positions[i]];
      const rest = segments.slice(positions[i - 1] + 1, positions[i]);
      if (!rest.length || rest.some(s => s.role !== "recovery" || !positive(s.durationSec))) {
        continuous = false; recoveries.push(null);
        continue;
      }
      const durationSec = rest.reduce((sum, s) => sum + Number(s.durationSec), 0);
      const distanceM = rest.every(s => s.distanceM != null && Number.isFinite(Number(s.distanceM)) && Number(s.distanceM) >= 0)
        ? rest.reduce((sum, s) => sum + Number(s.distanceM), 0) : null;
      const avgHr = rest.every(s => positive(s.avgHr))
        ? Math.round(rest.reduce((sum, s) => sum + s.avgHr * s.durationSec, 0) / durationSec) : null;
      recoveries.push({ durationSec, distanceM, avgHr });
      if (avgHr && positive(left.avgHr) && positive(right.avgHr)) {
        hrPairs++;
        if (avgHr < (Number(left.avgHr) + Number(right.avgHr)) / 2) hrDropPairs++;
      }
      if (distanceM !== null && positive(left.durationSec) && positive(right.durationSec) &&
          positive(left.distanceM) && positive(right.distanceM) &&
          distanceM / durationSec < Math.min(left.distanceM / left.durationSec, right.distanceM / right.durationSec)) slowerPairs++;
    }
    return { continuous, recoveries, hrPairs, hrDropPairs, slowerPairs, work: segments.filter(s => s.role === "work") };
  }

  function confirmationSnapshot(day, workouts) {
    const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key] ?? null]));
    const canonical = value => Array.isArray(value) ? value.map(canonical) :
      value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return JSON.stringify(canonical({
      plan: { ...pick(day, ["date", "focus", "intensity", "targetDistance", "plannedStructure"]),
        assignment: day.plannedWorkout || day.details || "" },
      workouts: workouts.map(w => pick(w, ["id", "date", "sport", "durationMin", "distanceKm", "avgHr", "load",
        "workoutTypeOverride", "workoutStructure", "lapSignals", "intervalSignals"])).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }));
  }
  function normalizeConfirmation(value) {
    if (!value || value.version !== 1 || typeof value.snapshot !== "string" || value.snapshot.length > 200000 ||
        !value.snapshot || !Number.isFinite(Date.parse(value.confirmedAt)) || typeof value.by !== "string") return null;
    return { version: 1, snapshot: value.snapshot, confirmedAt: value.confirmedAt, by: value.by.slice(0, 120) };
  }
  function confirmation(day, workouts) {
    const saved = normalizeConfirmation(day.keyConfirmation);
    return saved && workouts.length && saved.snapshot === confirmationSnapshot(day, workouts) ? saved : null;
  }
  const api = { parse, compare, lapEvidence, confirmationSnapshot, normalizeConfirmation, confirmation };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutComparison = api;
})(globalThis);