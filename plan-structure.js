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
    text = text.replace(/недел[а-яё]*\s+(?:старта|гонки|соревновани[а-яё]*)/gu, " ");
    // A postfix prohibition is not a prescription (but "not a sprint" can qualify real strides).
    text = text.replace(/(?:ускорени[а-яё]*|strides|спринт[а-яё]*|sprints?|интервал[а-яё]*|темпов[а-яё]*\s+(?:работ[а-яё]*|встав[а-яё]*|блок[а-яё]*))\s+(?:не\s+(?:выполнять|добавлять|делать|нужен|нужны|требуется)|исключен[а-яё]*|запрещен[а-яё]*)(?![а-яё])/gu, " ");
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
    const adjectives = "(?:(?:очень|преимущественно|ровн[а-я]*|непрерывн[а-я]*|легк[а-я]*|спокойн[а-я]*|аэробн[а-я]*|восстановительн[а-я]*)\\s+){0,5}";
    const running = `(?:${adjectives}бег[а-я]*|(?:(?:очень|преимущественно)\\s+)*(?:легко(?![а-я])|спокойно(?![а-я])|в\\s+z[12]))`;
    const pattern = new RegExp(`${volume}\\s+${running}|(?:легк|спокойн|восстановительн)[а-я]*\\s+бег[а-я]*\\s*[: -]?\\s*${volume}`, "gu");
    for (const match of text.matchAll(pattern)) {
      const preceding = text.slice(0,match.index);
      if (/\d+\s*[xх×]\s*$/u.test(preceding)) continue;
      if (!/размин|замин|офп|мобилити|силов|координац|баланс|без бег|бег[^.;!?]*запрещ/u.test(preceding)) return text.slice(match.index).split(/[;!?\n]|\.(?!\d)/u)[0];
    }
    return "";
  }
  function timeRange(value) {
    const text = String(value || "").trim().toLowerCase().replace(/[–—−]/g, "-").replace(/,/g, ".");
    const point = "(?:\\d{1,3}:[0-5]\\d|\\d+(?:\\.\\d+)?\\s*мин[а-яё]*(?:\\s*\\d+(?:\\.\\d+)?\\s*(?:сек[а-яё]*|с)(?![а-яё]))?|\\d+(?:\\.\\d+)?\\s*(?:сек[а-яё]*|с)(?![а-яё]))";
    const match = text.match(new RegExp(`^(${point})(?:\\s*-\\s*(${point}))?`, "u"));
    const seconds = part => {
      if (part.includes(":")) { const [m,s] = part.split(":").map(Number); return m*60+s; }
      const minutes = part.match(/(\d+(?:\.\d+)?)\s*мин/u), secs = part.match(/(\d+(?:\.\d+)?)\s*(?:сек[а-яё]*|с)(?![а-яё])/u);
      return (minutes ? Number(minutes[1])*60 : 0)+(secs ? Number(secs[1]) : 0);
    };
    const range = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(мин[а-яё]*|сек[а-яё]*|с)(?![а-яё])/u);
    const from = range ? Number(range[1])*(range[3].startsWith("мин") ? 60 : 1) : match ? seconds(match[1]) : NaN;
    const to = range ? Number(range[2])*(range[3].startsWith("мин") ? 60 : 1) : match ? seconds(match[2] || match[1]) : NaN;
    return Number.isFinite(from) && from>0 && to>=from ? {basis:"duration",from,to} : null;
  }
  function assignmentParts(value) {
    const text = String(value || "").toLowerCase().replace(/ё/g,"е").replace(/[–—−]/g,"-");
    const clauses=text.split(/[;!?\n]|\.(?!\d)/u);
    const restChoices=clauses.filter(clause=>!/восстановлени[а-я]*|между\s+(?:повторени[а-я]*|блок[а-я]*|отрез[а-я]*)|через|пауз[а-я]*/u.test(clause)).join(". ");
    const restAllowed = /(?:или|либо)\s+(?:выбрать\s+)?(?:полный\s+)?отдых|(?:полный\s+)?отдых\s+(?:либо|или)\s+\d/u.test(restChoices)
      || /(?:при\s+[^.!?;]*усталости|если[^.!?;]*(?:устал|утом))[^.!?;]*(?:выбрать\s+)?полный отдых/u.test(restChoices);
    const restFirst = /^\s*(?:полный\s+)?отдых\s+(?:либо|или)\s+\d/u.test(text);
    const primary = [], alternatives = [];
    let hasMain = false;
    const laterRun=clauses.some(clause=>!/^(?:\s*если|\s*при\s)/u.test(clause) && primaryRunText(clause));
    for (let clause of clauses) {
      clause=clause.trim(); if (!clause) continue;
      const conditional = /^(?:если|при\s)/u.test(clause);
      const accessory = /(?:strides|ускорени[а-я]*)/u.test(clause) && /\d+\s*[xх×]\s*(?:[12]?\d|30)\s*(?:сек[а-я]*|с)(?![а-я])/u.test(clause);
      if (conditional && (hasMain || (laterRun && /устал|утом/u.test(clause)))) {
        const reduces=/сократ|уменьш[а-я]*\s+(?:бег|продолжительност|объем)|замен|выбрать\s+(?:полный\s+)?отдых|законч|заверш/u.test(clause);
        const fatigue=/устал|утом/u.test(clause);
        if (!accessory && (reduces || (fatigue && /\d+\s*[xх×]|полный отдых/u.test(clause)))) alternatives.push(clause);
        else if (!accessory && /\d+\s*[xх×]/u.test(clause)) primary.push(clause);
        continue;
      }
      if (hasMain && /^(?:дополнительно|допустим[а-я]*|можно|после\s+(?:бега|пробежки))/u.test(clause) && /можно|допустим/u.test(clause) && /мобилити|офп|силов|баланс/u.test(clause)) continue;
      if (restFirst && !primary.length) clause=clause.replace(/^\s*(?:полный\s+)?отдых\s+(?:либо|или)\s+/u, "");
      if (!/восстановлени[а-я]*|между\s+(?:повторени[а-я]*|блок[а-я]*|отрез[а-я]*)|через|пауз[а-я]*/u.test(clause)) clause=clause.replace(/\s+(?:или|либо)\s+(?:выбрать\s+)?(?:полный\s+)?отдых(?:\s+при\s+усталости)?/gu, "");
      primary.push(clause);
      if (!/размин|замин/u.test(clause) && (primaryRunText(clause) || (!accessory && /\d+\s*[xх×]\s*\d/u.test(clause)))) hasMain=true;
    }
    return {text:primary.join(". "),alternatives,conditionalAlternative:alternatives.length>0,restAllowed,restFirst};
  }
  function overallDuration(value) {
    const primary=assignmentParts(value).text;
    const total=primary.match(/(?:всего|общая\s+длительность(?:\s+тренировки)?|общее\s+время(?:\s+тренировки)?|суммарная\s+длительность\s+тренировки|вся\s+тренировка)\s*[: -]?\s*/u);
    const explicit=total ? timeRange(primary.slice(total.index+total[0].length)) : null;
    if (explicit) return explicit;
    const text=primaryRunText(primary);
    if (!text) return null;
    const prefix=text.match(/^[^\d]*/u)[0];
    return timeRange(text.slice(prefix.length));
  }
  function mainIntensityText(value) {
    let text = stimulusText(value).replace(/ё/g, "е").replace(/[–—−]/g, "-");
    const main = text.match(/основн(?:ая|ой)\s+(?:часть|блок)\s*[:.-]?/u);
    if (main) text = text.slice(main.index + main[0].length);
    text = text.split(/замин[а-я]*|суммарн[а-я]*\s+(?:основная\s+)?работа/u)[0];
    return text.split(/[;!?\n]|\.(?!\d)|\s+(?:затем|далее)\s+/u).map(part => {
      const clause = part.replace(/после\s+разминки/gu, "");
      if (/размин[а-я]*|замин[а-я]*|при\s+(?:выраженной\s+)?усталости|если\s/u.test(clause)) return "";
      // Short relaxed strides are an accessory, not the main session's intensity.
      if (/strides|ускорени[а-я]*/u.test(clause) && !/спринт|sprint/u.test(clause) &&
          /\d+\s*[xх×]\s*(?:[12]?\d|30)\s*(?:сек[а-я]*|с)(?![а-я])/u.test(clause)) return "";
      return clause.split(/восстановлени[а-я]*/u)[0];
    }).join(". ");
  }
  function explicitIntensityTone(value) {
    const text = mainIntensityText(value).replace(/не\s+(?:на\s+максимум|с\s+максимальн[а-я]*\s+(?:усили[а-я]*|скорост[а-я]*))/gu, " ");
    if (!text) return null;
    if (/(?:^|[^а-яa-z])(?:спринт(?:а|ы|ов|ом|у|е|ами|ах)?|sprints?)(?![а-яa-z])/u.test(text)) return "sprint";
    // A maximum adjective describing pacing or aerobic power is not an all-out sprint.
    const shortRepetitions = /\d+\s*[xх×]\s*(?:(?:[12]?\d|30)\s*(?:сек[а-я]*|с)|(?:[1-9]\d?|100)\s*(?:метр[а-я]*|м))(?![а-я\d])/u.test(text);
    if (shortRepetitions && /(?:максимальн[а-я]*\s+(?:усили[а-я]*|скорост[а-я]*)|(?:на|почти на)\s+максимум|all[- ]out)/u.test(text)) return "sprint";
    if (/vo[2₂](?:max)?|максимальн[а-я]*\s+аэробн[а-я]*\s+мощност[а-я]*/u.test(text)) return "vo2";
    const effort = text.match(/(?:усили[а-я]*|темп[а-я]*|pace|effort)\s+(?:соревновательн[а-я]*\s+)?(?:на\s+)?(10|5|3|1)\s*(?:км|km|k)(?![а-яa-z\d])/u);
    if (effort) return effort[1] + "k";
    if (/порог[а-я]*|threshold/u.test(text)) return "threshold";
    const zone = text.match(/(?:^|[^a-zа-я\d])z([1-5])(?:\s*[-/]\s*z?([1-5]))?(?![\d])/u);
    if (zone) {
      const from = Number(zone[1]), to = Number(zone[2] || zone[1]);
      if (from > to) return null;
      return to === 5 ? "vo2" : to >= 3 ? "threshold" : to === 2 ? "easy" : "recovery";
    }
    if (/очень\s+легко|восстановительн[а-я]*\s+(?:бег|усилие)/u.test(text)) return "recovery";
    if (/(?:^|[^а-я])легко(?![а-я])|легк[а-я]*\s+(?:бег|усилие)|разговорн[а-я]*\s+(?:темп|усилие)/u.test(text)) return "easy";
    return null;
  }
  function rpeIntensityTone(value) {
    const text=mainIntensityText(value);
    const match=text.match(/\brpe\s*(?::|=|около)?\s*(\d{1,2}(?:[.,]\d+)?)(?:\s*-\s*(\d{1,2}(?:[.,]\d+)?))?(?:\s*(?:\/|из)\s*(\d{1,2}))?(?!\d)/u);
    if (!match) return null;
    const from=Number(match[1].replace(",",".")),to=Number((match[2] || match[1]).replace(",","."));
    if (from<0 || to>10 || from>to || to-from>3 || (match[3] && Number(match[3])!==10)) return null;
    const effort=(from+to)/2;
    return effort<=2 ? "recovery" : effort<=3 ? "easy" : effort<=5 ? "moderate" : effort<=8 ? "intensive" : "very-intensive";
  }
  function intensityTone(day, type) {
    const structured = fromDay(day);
    if (structured) {
      const tone = explicitIntensityTone(structured.work.intensity) || rpeIntensityTone(structured.work.intensity);
      return type === "long" && ["easy", "recovery"].includes(tone) ? "long" : tone || "unspecified";
    }
    const assignment = String(day.plannedWorkout || day.details || "");
    const hasMain = /основн(?:ая|ой)\s+(?:часть|блок)/iu.test(assignment);
    // Explicit main blocks outrank stale labels; totals, titles and goals are never effort evidence.
    const sources = hasMain ? [assignment, day.intensity] : [day.intensity, assignment];
    for (const source of sources) {
      const tone = explicitIntensityTone(source);
      if (tone) return type === "long" && ["easy", "recovery"].includes(tone) ? "long" : tone;
    }
    for (const source of sources) {
      const tone=rpeIntensityTone(source);
      if (tone) return type === "long" && ["easy","recovery"].includes(tone) ? "long" : tone;
    }
    return ["easy", "recovery", "long"].includes(type) ? type : "unspecified";
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
  const api = { stimulusText, hasStrides, primaryRunText, timeRange, assignmentParts, overallDuration, intensityTone, range, normalize, format, inputMeasure, fromDay, prescription, segments };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlanStructure = api;
})(globalThis);
