const STORAGE_KEY = "training-coach-workouts";
const PROFILE_KEY = "training-coach-profile";
const PLANS_KEY = "training-coach-plans";
const PLANS_BY_WEEK_KEY = "training-coach-plans-by-week";
const ACTIVE_PLAN_SOURCE_KEY = "training-coach-active-plan-source";
const SELECTED_WEEK_KEY = "training-coach-selected-week";
const CURRENT_PLAN_KEY = "training-coach-current-plan";
const WORKOUT_SYNC_INTERVAL_MS = 60000;
const API_BASE_URL = window.location.protocol === "file:" ? "http://127.0.0.1:8765" : "";

const state = {
  workouts: loadJson(STORAGE_KEY, []),
  plans: loadJson(PLANS_KEY, {}),
  plansByWeek: loadJson(PLANS_BY_WEEK_KEY, {}),
  activePlanSource: loadJson(ACTIVE_PLAN_SOURCE_KEY, "json"),
  selectedWeekStart: loadJson(SELECTED_WEEK_KEY, currentWeekKey()),
  profile: loadJson(PROFILE_KEY, {
    name: "",
    goal: "Поддержание формы",
    targetDistance: "10k",
    prepPhase: "auto",
    raceDate: "",
    raceDistance: "",
    raceName: "",
    maxHr: 185,
    restHr: 50,
    daysPerWeek: 4,
    constraints: "",
  }),
};

const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const importLog = document.querySelector("#importLog");
const manualForm = document.querySelector("#manualForm");
const settingsForm = document.querySelector("#settingsForm");
const planJsonInput = document.querySelector("#planJsonInput");

init();

async function init() {
  wireNavigation();
  wireImport();
  wireForms();
  hydrateProfile();
  showPlanLoading("Идет загрузка плана...");
  renderAll();
  await loadBackendState();
  setAiStatus("Идет проверка новых тренировок...", "");
  await syncWorkoutFolderChanges({ render: false });
  setAiStatus("Идет уточнение данных тренировок...", "");
  await enrichKnownCsvWorkouts();
  hydrateProfile();
  renderAll();
  restoreCurrentPlanOrGenerate();
  setInterval(() => syncWorkoutFolderChanges(), WORKOUT_SYNC_INTERVAL_MS);
}

function wireNavigation() {
  navItems.forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.view));
  });

  document.querySelector("#openImport").addEventListener("click", () => showView("import"));
  document.querySelector("#generatePlan").addEventListener("click", selectLocalPlan);
  document.querySelector("#adjustPlan").addEventListener("click", adjustDisplayedPlan);
  document.querySelector("#generateAiPlan").addEventListener("click", selectAiPlan);
  document.querySelector("#loadPlanJson").addEventListener("click", selectJsonPlan);
  document.querySelector("#previousWeek").addEventListener("click", () => changeSelectedWeek(-7));
  document.querySelector("#nextWeek").addEventListener("click", () => changeSelectedWeek(7));
  document.querySelector("#currentWeek").addEventListener("click", () => selectWeek(currentWeekKey()));
  planJsonInput.addEventListener("change", handlePlanJsonFile);
  document.querySelector("#copyPrompt").addEventListener("click", copyPrompt);
  document.querySelector("#clearData").addEventListener("click", clearWorkouts);
}

function wireImport() {
  fileInput.addEventListener("change", (event) => handleFiles([...event.target.files]));

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    handleFiles([...event.dataTransfer.files]);
  });
}

function wireForms() {
  const today = new Date().toISOString().slice(0, 10);
  manualForm.elements.date.value = today;

  manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(manualForm);
    const workout = normalizeWorkout({
      source: "manual",
      date: data.get("date"),
      sport: data.get("sport"),
      durationMin: numberOrNull(data.get("duration")),
      distanceKm: numberOrNull(data.get("distance")),
      avgHr: numberOrNull(data.get("avgHr")),
      rpe: numberOrNull(data.get("rpe")),
      notes: data.get("notes"),
    });

    addWorkouts([workout]);
    manualForm.reset();
    manualForm.elements.date.value = today;
    showView("dashboard");
  });

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(settingsForm);
    state.profile = {
      name: data.get("name").trim(),
      goal: data.get("goal"),
      targetDistance: data.get("targetDistance") || "10k",
      prepPhase: data.get("prepPhase") || "auto",
      raceDate: data.get("raceDate") || "",
      raceDistance: data.get("raceDistance") || "",
      raceName: data.get("raceName").trim(),
      maxHr: Number(data.get("maxHr")) || 185,
      restHr: Number(data.get("restHr")) || 50,
      daysPerWeek: Number(data.get("daysPerWeek")) || 4,
      constraints: data.get("constraints").trim(),
    };
    saveJson(PROFILE_KEY, state.profile);
    saveBackendState();
    renderAll();
    generatePlan();
    showToast("Профиль сохранен");
  });
}

function showView(viewId) {
  views.forEach((view) => view.classList.toggle("active", view.id === viewId));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === viewId));
}

async function handleFiles(files) {
  if (!files.length) return;

  const results = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const parsed = parseWorkoutFile(file.name, text);
      const summary = addWorkouts(parsed, false);
      if (summary.accepted > 0) {
        results.push(`Импортировано: ${file.name} (${summary.accepted})`);
      } else if (summary.duplicates > 0) {
        results.push(`Новых тренировок нет: ${file.name} (${summary.duplicates} уже были загружены)`);
      } else {
        results.push(`Тренировки не добавлены: ${file.name}. Проверьте колонки даты и длительности.`);
      }
      if (summary.skipped > 0) {
        results.push(`Пропущено строк: ${summary.skipped} без даты или длительности.`);
      }
    } catch (error) {
      results.push(`Не удалось прочитать ${file.name}: ${error.message}`);
    }
  }

  persistWorkouts();
  await enrichKnownCsvWorkouts();
  autoAdjustActiveLocalPlanIfNeeded();
  renderAll();
  restoreCurrentPlanOrGenerate();
  importLog.innerHTML = results.map((line) => `<div class="log-line">${escapeHtml(line)}</div>`).join("");
  fileInput.value = "";
}

function parseWorkoutFile(fileName, text) {
  const extension = fileName.split(".").pop().toLowerCase();
  if (extension === "tcx" || text.includes("<TrainingCenterDatabase")) return parseTcx(text, fileName);
  if (extension === "gpx" || text.includes("<gpx")) return parseGpx(text, fileName);
  if (extension === "json") return parseJsonWorkouts(text, fileName);
  if (extension === "csv") return parseCsv(text, fileName);
  throw new Error("формат не распознан");
}

function parseTcx(text, fileName) {
  const doc = parseXml(text);
  const activities = descendants(doc, "Activity");
  return activities.map((activity, index) => {
    const laps = descendants(activity, "Lap");
    const lapSignals = analyzeTcxLaps(laps);
    const durationSec = sumNodes(laps, "TotalTimeSeconds");
    const distanceM = sumNodes(laps, "DistanceMeters");
    const avgHr = average(
      laps
        .map((lap) => {
          const hrBlock = firstDescendant(lap, "AverageHeartRateBpm");
          return hrBlock ? textOf(hrBlock, "Value") : "";
        })
        .filter(Boolean)
        .map(Number)
    );
    const avgSpeed = average(
      laps
        .map((lap) => textOf(lap, "AverageSpeed") || textOf(lap, "AvgSpeed"))
        .filter(Boolean)
        .map(Number)
        .map((speed) => (speed <= 12 ? speed * 3.6 : speed))
    );
    const maxSpeed = Math.max(
      0,
      ...laps
        .map((lap) => numberOrNull(textOf(lap, "MaximumSpeed")))
        .filter(Boolean)
        .map((speed) => (speed <= 12 ? speed * 3.6 : speed))
    );
    return normalizeWorkout({
      source: fileName,
      date: textOf(activity, "Id") || new Date().toISOString(),
      sport: activity.getAttribute("Sport") || "Другое",
      durationMin: durationSec ? Math.round(durationSec / 60) : null,
      distanceKm: distanceM ? round(distanceM / 1000, 2) : null,
      speed: avgSpeed || null,
      maxSpeed: maxSpeed || null,
      lapSignals,
      avgHr: avgHr ? Math.round(avgHr) : null,
      notes: `TCX #${index + 1}`,
    });
  });
}

function parseGpx(text, fileName) {
  const doc = parseXml(text);
  const points = descendants(doc, "trkpt");
  const times = points.map((point) => new Date(textOf(point, "time")).getTime()).filter(Boolean);
  const hrs = points
    .map((point) => firstDescendant(point, "hr"))
    .map((node) => (node ? Number(node.textContent) : null))
    .filter(Boolean);
  const distanceKm = calculateGpxDistance(points);
  const durationMin = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : null;
  return [
    normalizeWorkout({
      source: fileName,
      date: times.length ? new Date(Math.min(...times)).toISOString() : new Date().toISOString(),
      sport: "Другое",
      durationMin,
      distanceKm,
      avgHr: hrs.length ? Math.round(average(hrs)) : null,
      notes: "GPX импорт",
    }),
  ];
}

function parseJsonWorkouts(text, fileName) {
  const raw = JSON.parse(text);
  const items = Array.isArray(raw) ? raw : raw.exercises || raw.workouts || raw.trainingSessions || [raw];
  return items.map((item) =>
    normalizeWorkout({
      source: fileName,
      date: item.date || item.startTime || item.start_time || item.start || item.created,
      sport: item.sport || item.sportName || item.type || item.exercise || "Другое",
      durationMin: minutesFromAny(item.duration || item.durationMin || item.duration_min),
      distanceKm: kmFromAny(item.distance || item.distanceKm || item.distance_km),
      paceMinPerKm: paceFromAny(item.pace || item.avgPace || item.averagePace || item.paceMinPerKm),
      speed: numberOrNull(item.speed || item.avgSpeed || item.averageSpeed || item.average_speed),
      maxSpeed: numberOrNull(item.maxSpeed || item.maximumSpeed || item.max_speed),
      avgHr: numberOrNull(item.avgHr || item.averageHeartRate || item.heart_rate_avg),
      hrMax: numberOrNull(item.hrMax || item.maxHr || item.maximumHeartRate || item.hr_max),
      hrRest: numberOrNull(item.hrRest || item.restHr || item.restingHeartRate || item.hr_rest),
      load: numberOrNull(item.load || item.trainingLoad || item.cardioLoad || item.trimp),
      rpe: numberOrNull(item.rpe),
      notes: item.notes || item.comment || "JSON импорт",
    })
  );
}

function parseCsv(text, fileName) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV без строк данных");

  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeHeader);
  const workouts = [];
  const sampleHeaderIndex = lines.findIndex((line, index) => index > 0 && looksLikeCsvHeader(splitCsvLine(line, delimiter)));
  const workoutLines = sampleHeaderIndex > -1 ? lines.slice(1, sampleHeaderIndex) : lines.slice(1);
  const intervalSignals = sampleHeaderIndex > -1 ? analyzeCsvSamples(lines.slice(sampleHeaderIndex), delimiter) : null;

  for (const line of workoutLines) {
    const values = splitCsvLine(line, delimiter);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    workouts.push(normalizeWorkout({
      source: fileName,
      date: dateFromCsvRow(row),
      sport: pick(row, ["sport", "type", "exercise", "вид", "спорт"]) || "Другое",
      durationMin: minutesFromAny(pick(row, ["duration", "duration min", "duration_min", "длительность"])),
      distanceKm: kmFromAny(pick(row, ["distance", "distance km", "distance_km", "total distance", "total distance (km)", "дистанция"])),
      paceMinPerKm: paceFromAny(pick(row, ["pace", "pace (min/km)", "avg pace", "average pace", "average pace (min/km)", "avg_pace", "темп", "средний темп"])),
      speed: numberOrNull(pick(row, ["speed", "speed (km/h)", "avg speed", "average speed", "average speed (km/h)", "avg_speed", "скорость", "средняя скорость"])),
      maxSpeed: numberOrNull(pick(row, ["max speed", "maximum speed", "max speed (km/h)", "max_speed", "максимальная скорость"])),
      avgHr: numberOrNull(pick(row, ["avg hr", "average heart rate", "average heart rate (bpm)", "avg_hr", "hr (bpm)", "средний пульс"])),
      hrMax: numberOrNull(pick(row, ["hr max", "max hr", "maximum heart rate", "maximum heart rate (bpm)", "hr_max"])),
      hrRest: numberOrNull(pick(row, ["hr sit", "hr rest", "rest hr", "resting heart rate", "resting heart rate (bpm)", "hr_rest"])),
      load: numberOrNull(pick(row, ["training load", "cardio load", "cardio load (trimp)", "trimp", "load", "кардионагрузка", "тренировочная нагрузка"])),
      rpe: numberOrNull(pick(row, ["rpe", "effort"])),
      notes: pick(row, ["notes", "comment", "заметки"]) || "CSV импорт",
      intervalSignals,
    }));
  }

  return workouts;
}

function addWorkouts(workouts, shouldPersist = true) {
  const existingIds = new Set(state.workouts.map((workout) => workout.id));
  const validIncoming = workouts.filter((workout) => workout.date && workout.durationMin > 0);
  const uniqueIncoming = [];
  const seenIncomingIds = new Set();

  for (const workout of validIncoming) {
    if (seenIncomingIds.has(workout.id)) continue;
    seenIncomingIds.add(workout.id);
    uniqueIncoming.push(workout);
  }

  const skipped = workouts.length - validIncoming.length;
  const duplicateRows = validIncoming.length - uniqueIncoming.length;
  const duplicates = duplicateRows + uniqueIncoming.filter((workout) => existingIds.has(workout.id)).length;
  const accepted = uniqueIncoming.filter((workout) => !existingIds.has(workout.id)).length;
  const merged = [...state.workouts, ...uniqueIncoming].filter((workout) => workout.date && workout.durationMin);
  const byId = new Map(merged.map((workout) => [workout.id, workout]));
  state.workouts = [...byId.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (shouldPersist) {
    persistWorkouts();
    autoAdjustActiveLocalPlanIfNeeded();
    renderAll();
    restoreCurrentPlanOrGenerate();
  }
  return { accepted, skipped, duplicates, parsed: workouts.length };
}

function normalizeWorkout(input) {
  const date = input.date ? dateFromAny(input.date) : null;
  const durationMin = Number(input.durationMin) || 0;
  const distanceKm = Number(input.distanceKm) || 0;
  const avgHr = Number(input.avgHr) || null;
  const rpe = Number(input.rpe) || null;
  const avgSpeed = numberOrNull(input.speed);
  const maxSpeed = numberOrNull(input.maxSpeed);
  const hrMax = numberOrNull(input.hrMax) || state.profile.maxHr || 185;
  const hrRest = numberOrNull(input.hrRest) || state.profile.restHr || 50;
  const importedLoad = numberOrNull(input.load);
  const intervalSignals = input.intervalSignals || null;
  const lapSignals = input.lapSignals || null;
  const trimp = estimateTrimp(durationMin, avgHr, hrMax, hrRest);
  const load = Math.round(importedLoad || trimp || durationMin);
  const loadSource = importedLoad ? "imported" : trimp ? "trimp" : "duration";
  const paceMinPerKm = input.paceMinPerKm || paceFromSpeed(avgSpeed) || null;
  const paceSource = paceMinPerKm ? "imported" : "";
  const isoDate = date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
  const sport = String(input.sport || "Другое").trim();
  return {
    id: `${isoDate.slice(0, 16)}-${sport}-${durationMin}-${distanceKm}`,
    source: input.source || "manual",
    date: isoDate,
    sport,
    durationMin,
    distanceKm,
    paceMinPerKm,
    pace: paceSource ? formatPace(paceMinPerKm) : "",
    paceSource,
    avgSpeed,
    maxSpeed,
    intervalSignals,
    lapSignals,
    avgHr,
    hrMax,
    hrRest,
    rpe,
    load,
    loadSource,
    notes: String(input.notes || "").trim(),
    workoutType: classifyWorkout({
      sport,
      durationMin,
      distanceKm,
      paceMinPerKm,
      avgSpeed,
      maxSpeed,
      intervalSignals,
      lapSignals,
      avgHr,
      hrMax,
      hrRest,
      rpe,
      load,
      notes: input.notes,
    }),
  };
}

function estimateTrimp(durationMin, avgHr, hrMax, hrRest) {
  if (!durationMin || !avgHr || !hrMax || hrMax <= hrRest) return 0;
  const hrReserveRatio = clamp((avgHr - hrRest) / (hrMax - hrRest), 0, 1.1);
  return estimateTrimpFromHrr(durationMin, hrReserveRatio);
}

function estimateTrimpFromHrr(durationMin, hrReserveRatio) {
  if (!durationMin || !hrReserveRatio) return 0;
  if (hrReserveRatio <= 0) return 0;
  return durationMin * hrReserveRatio * 0.64 * Math.exp(1.92 * hrReserveRatio);
}

function renderAll() {
  renderMetrics();
  renderWorkouts();
  renderBars();
  renderPlanWeekLabel();
  document.querySelector("#storageCount").textContent = formatCount(state.workouts.length);
}

function renderMetrics() {
  const week = buildPeriodSummary(7);
  const month = buildPeriodSummary(28);
  const last = state.workouts[0];
  const readiness = getReadiness();

  document.querySelector("#weekLoad").textContent = week.totalLoad;
  document.querySelector("#weekDetails").textContent = formatPeriodSummary(week);
  document.querySelector("#monthLoad").textContent = month.totalLoad;
  document.querySelector("#monthDetails").textContent = formatPeriodSummary(month);
  document.querySelector("#lastWorkout").textContent = last ? formatDate(last.date) : "нет данных";
  document.querySelector("#lastWorkoutType").textContent = last
    ? `${last.sport}, ${last.durationMin} мин, ${formatTrustedPace(last)}, TRIMP ${last.load}`
    : "добавьте файл или запись";
  document.querySelector("#readiness").textContent = readiness.label;
  document.querySelector("#readinessReason").textContent = readiness.reason;
  document.querySelector("#readinessCard").className = `metric readiness ${readiness.level}`;
}

function renderWorkouts() {
  const list = document.querySelector("#workoutList");
  if (!state.workouts.length) {
    list.innerHTML = `<div class="empty">История пуста</div>`;
    return;
  }

  list.innerHTML = state.workouts
    .slice(0, 12)
    .map(
      (workout) => `
        <article class="workout-row">
          <div>
            <strong>${escapeHtml(workout.sport)} · ${escapeHtml(workoutTypeLabel(workout))}</strong>
            <span>${formatDate(workout.date)} · ${workout.durationMin} мин · ${formatDistance(workout.distanceKm)} · ${formatTrustedPace(workout)}</span>
          </div>
          <small>${workout.load} TRIMP</small>
        </article>
      `
    )
    .join("");
}

function renderBars() {
  const bars = document.querySelector("#loadBars");
  const days = lastDays(14);
  const loads = days.map((day) => ({
    label: day.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
    load: state.workouts
      .filter((workout) => sameDay(new Date(workout.date), day))
      .reduce((sum, workout) => sum + workout.load, 0),
  }));
  const maxLoad = Math.max(...loads.map((item) => item.load), 1);

  document.querySelector("#loadLabel").textContent = state.workouts.length
    ? `пик ${maxLoad} TRIMP за день`
    : "нет данных";
  bars.innerHTML = loads
    .map(
      (item) => `
        <div class="bar-wrap" title="${item.load} TRIMP">
          <div class="bar" style="height:${Math.max(4, (item.load / maxLoad) * 190)}px"></div>
          <span>${item.label}</span>
        </div>
      `
    )
    .join("");
}

function generatePlan() {
  const plan = buildPlan();
  const savedPlan = saveCurrentPlan({
    source: "local",
    summary: "Сейчас показан локальный недельный план.",
    days: plan,
  });
  renderPlan(savedPlan?.days || plan);
  updatePlanSourceButtons("local");
  setAiStatus("Сейчас показан локальный недельный план.", "");
}

function selectLocalPlan() {
  const savedPlan = getCurrentWeekPlan("local");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  generatePlan();
}

function selectJsonPlan() {
  const savedPlan = getCurrentWeekPlan("json");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  planJsonInput.click();
}

function selectAiPlan() {
  const savedPlan = getCurrentWeekPlan("ai");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  generateAiPlan();
}

function adjustDisplayedPlan() {
  const current = loadCurrentPlan() || {
    source: "local",
    summary: "Локальный план скорректирован по факту выполненных тренировок.",
    days: buildPlan(),
  };
  const adjustedDays = adjustRemainingPlanDays(current.days);
  const savedPlan = saveCurrentPlan({
    ...current,
    summary: current.summary || "План скорректирован по факту выполненных тренировок.",
    days: adjustedDays,
  });
  renderPlan(savedPlan?.days || adjustedDays);
  updatePlanSourceButtons(savedPlan?.source || current.source || "local");
  setAiStatus("План скорректирован локально по выполненным тренировкам текущей недели.", "ok");
}

function autoAdjustActiveLocalPlanIfNeeded() {
  if (selectedWeekKey() !== currentWeekKey()) return;
  const bucket = selectedWeekPlans();
  if (bucket.activePlanSource !== "local") return;
  const current = getCurrentWeekPlan("local");
  if (!current) return;
  const adjustedDays = adjustRemainingPlanDays(current.days);
  saveCurrentPlan({
    ...current,
    summary: current.summary || "Локальный план автоматически скорректирован по факту.",
    days: adjustedDays,
  });
}

function adjustRemainingPlanDays(days) {
  const weekStart = selectedWeekStartDate();
  const target = getTargetDistanceProfile();
  const caution = getPlanCaution(getReadiness());
  const adjusted = adaptPlanToCompletedWorkouts(days, weekStart, target, caution).map((day) => ({ ...day }));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const evaluations = adjusted.map(evaluatePlanDayExecution);

  rescheduleMissedQuality(adjusted, evaluations, "interval", target, caution, today);
  rescheduleMissedQuality(adjusted, evaluations, "tempo", target, caution, today);
  softenAfterHeavyActual(adjusted, evaluations, target, today);
  return adjusted.map((day) => normalizePlanDay(day, day, 0));
}

function rescheduleMissedQuality(days, evaluations, type, target, caution, today) {
  const alreadyCompleted = evaluations.some((item, index) => item.keyCompleted && plannedTypeForDay(days[index]) === type);
  if (alreadyCompleted) return;

  const plannedIndex = days.findIndex((day) => plannedTypeForDay(day) === type);
  if (plannedIndex === -1 || evaluations[plannedIndex]?.level !== "missed") return;

  const replacementIndex = findRescheduleSlot(days, type, today);
  if (replacementIndex === -1) return;

  const date = new Date(days[replacementIndex].date);
  const nextDay = days[replacementIndex + 1];
  const isTempoBeforeLong = type === "tempo" && nextDay && plannedTypeForDay(nextDay) === "long";
  const replacement = type === "interval"
    ? planDay(date, "Интервалы", target.intervalTitle, `${target.intervalDetails} ${caution.quality} Работа перенесена, потому что плановый интервальный день не был закрыт фактом.`, caution.qualityLoad)
    : planDay(date, "Темпо", target.tempoTitle, `${target.tempoDetails} ${caution.quality} ${isTempoBeforeLong ? "Связка темпо + длительная сохранена." : "Темповая работа перенесена после пропуска планового дня."}`, caution.qualityLoad);

  days[replacementIndex] = replacement;
}

function findRescheduleSlot(days, type, today) {
  for (let index = 0; index < days.length; index += 1) {
    const date = new Date(days[index].date);
    date.setHours(0, 0, 0, 0);
    if (date <= today) continue;
    if (["interval", "tempo", "long", "race"].includes(plannedTypeForDay(days[index]))) continue;
    if (type === "interval" && !hasTwoDaysBetweenType(days, index, "tempo")) continue;
    if (type === "tempo") {
      const next = days[index + 1];
      if (next && plannedTypeForDay(next) !== "long") continue;
    }
    return index;
  }
  return -1;
}

function hasTwoDaysBetweenType(days, index, otherType) {
  const otherIndex = days.findIndex((day) => plannedTypeForDay(day) === otherType);
  if (otherIndex === -1) return true;
  return Math.abs(otherIndex - index) >= 3;
}

function softenAfterHeavyActual(days, evaluations, target, today) {
  const hasHeavyActual = evaluations.some((item) => item.level === "harder");
  if (!hasHeavyActual) return;

  for (let index = 0; index < days.length; index += 1) {
    const date = new Date(days[index].date);
    date.setHours(0, 0, 0, 0);
    if (date <= today) continue;
    const type = plannedTypeForDay(days[index]);
    if (["easy", "recovery"].includes(type)) {
      days[index] = planDay(date, "Восстановление", target.recoveryTitle, `${target.recoveryDetails} День смягчен, потому что фактическая нагрузка недели выше плана.`, "низкая нагрузка");
      return;
    }
  }
}

function renderPlan(plan) {
  const planGrid = document.querySelector("#planGrid");
  renderPlanAnalysis(plan);
  planGrid.innerHTML = plan
    .map((day) => {
      const status = getPlanDayStatus(day);
      return `
        <article class="plan-card ${status.className}">
          <time>${day.dateLabel}</time>
          <div class="plan-status">${status.label}</div>
          <span>${day.focus}</span>
          <strong>${day.title}</strong>
          ${renderPlanDayDetails(day)}
          <small>${day.load}</small>
        </article>
      `;
    })
    .join("");
  document.querySelector("#aiPrompt").value = buildAiPrompt(plan);
}

function renderPlanAnalysis(plan) {
  const container = document.querySelector("#planAnalysis");
  if (!container) return;

  const summary = buildWeekExecutionSummary(plan);
  container.innerHTML = `
    <div class="panel-head compact-head">
      <h2>План vs факт</h2>
      <span>${escapeHtml(summary.weekLabel)}</span>
    </div>
    <div class="analysis-grid">
      <div>
        <span>Выполнение</span>
        <strong>${summary.completedDays}/${summary.plannedTrainingDays}</strong>
        <small>${escapeHtml(summary.completionComment)}</small>
      </div>
      <div>
        <span>Километраж факт</span>
        <strong>${round(summary.actualDistanceKm, 1)} км</strong>
        <small>${formatCount(summary.actualWorkouts)} · ${summary.actualLoad} TRIMP</small>
      </div>
      <div>
        <span>Ключевые работы</span>
        <strong>${summary.keyCompleted}/${summary.keyPlanned}</strong>
        <small>${escapeHtml(summary.keyComment)}</small>
      </div>
      <div>
        <span>Коррекция</span>
        <strong>${escapeHtml(summary.adjustmentLevel)}</strong>
        <small>${escapeHtml(summary.adjustmentReason)}</small>
      </div>
    </div>
  `;
}

function clearPlanAnalysis(message = "Для выбранной недели нет плана для анализа.") {
  const container = document.querySelector("#planAnalysis");
  if (!container) return;
  container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function showPlanLoading(message = "Идет загрузка плана...") {
  const planGrid = document.querySelector("#planGrid");
  const weekStart = selectedWeekStartDate();
  const placeholders = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  clearPlanAnalysis("Идет загрузка плана и проверка выполненных тренировок.");
  planGrid.innerHTML = placeholders
    .map(
      (date) => `
        <article class="plan-card upcoming">
          <time>${date.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}</time>
          <div class="plan-status">загрузка</div>
          <span>План</span>
          <strong>${escapeHtml(message)}</strong>
          <div class="plan-section plan-meta">
            <span class="section-label">Статус</span>
            <p>Проверяем сохраненный план и импортированные тренировки.</p>
          </div>
          <small>подождите</small>
        </article>
      `
    )
    .join("");
  document.querySelector("#aiPrompt").value = "";
  setAiStatus(message, "");
}

function restoreCurrentPlanOrGenerate() {
  const savedPlan = loadCurrentPlan();
  if (!savedPlan) {
    if (selectedWeekKey() !== currentWeekKey()) {
      showNoSavedPlanForWeek();
      return;
    }
    generatePlan();
    return;
  }

  showPlanState(savedPlan);
}

function showNoSavedPlanForWeek() {
  const planGrid = document.querySelector("#planGrid");
  clearPlanAnalysis();
  planGrid.innerHTML = `
    <div class="empty">
      Для выбранной недели нет сохраненного плана. Можно создать локальный план, загрузить JSON или сформировать план от ИИ.
    </div>
  `;
  document.querySelector("#aiPrompt").value = buildAiPrompt();
  updatePlanSourceButtons("");
  setAiStatus("Для выбранной недели нет сохраненного плана.", "");
}

function loadCurrentPlan() {
  migrateLegacyCurrentPlan();
  migrateLegacyPlans();
  const bucket = selectedWeekPlans();
  const sources = [bucket.activePlanSource, state.activePlanSource, "json", "ai", "local"].filter(Boolean);
  for (const source of [...new Set(sources)]) {
    const plan = getCurrentWeekPlan(source);
    if (plan) return plan;
  }
  return null;
}

function saveCurrentPlan(planState) {
  const normalized = normalizeStoredPlan(planState);
  if (!normalized) return null;
  const bucket = selectedWeekPlans(true);
  bucket.sources[normalized.source] = normalized;
  bucket.activePlanSource = normalized.source;
  state.activePlanSource = normalized.source;
  state.plans[normalized.source] = normalized;
  persistPlans();
  return normalized;
}

function getCurrentWeekPlan(source) {
  if (!source) return null;
  return normalizeStoredPlan(selectedWeekPlans().sources?.[source] || null);
}

function normalizeStoredPlan(planState) {
  if (!planState || !Array.isArray(planState.days) || planState.days.length !== 7) return null;
  if (!isSelectedWeekPlan(planState.days)) return null;

  try {
    const normalized = normalizeAiPlan({
      summary: planState.summary || "",
      modelUsed: planState.modelUsed || "",
      days: planState.days,
    });
    return {
      source: planState.source || "local",
      summary: normalized.summary,
      modelUsed: normalized.modelUsed || planState.modelUsed || "",
      savedAt: planState.savedAt || new Date().toISOString(),
      weekStart: normalized.days[0]?.date || "",
      days: normalized.days,
    };
  } catch {
    return null;
  }
}

function showPlanState(planState) {
  const normalized = saveCurrentPlan(planState) || normalizeStoredPlan(planState);
  if (!normalized) {
    generatePlan();
    return;
  }
  renderPlan(normalized.days);
  updatePlanSourceButtons(normalized.source);
  setAiStatus(currentPlanStatusText(normalized), normalized.source === "local" ? "" : "ok");
}

function persistPlans() {
  saveJson(PLANS_KEY, state.plans);
  saveJson(PLANS_BY_WEEK_KEY, state.plansByWeek);
  saveJson(ACTIVE_PLAN_SOURCE_KEY, state.activePlanSource);
  saveJson(SELECTED_WEEK_KEY, state.selectedWeekStart);
  saveBackendState();
}

function migrateLegacyCurrentPlan() {
  const legacy = loadJson(CURRENT_PLAN_KEY, null);
  if (!legacy || !Array.isArray(legacy.days)) return;
  const source = legacy.source || "json";
  const weekKey = weekKeyFromPlanDays(legacy.days) || selectedWeekKey();
  const bucket = weekPlans(weekKey, true);
  if (!bucket.sources[source]) {
    const normalized = normalizeStoredPlanForWeek(legacy, weekKey);
    if (normalized) {
      bucket.sources[source] = normalized;
      bucket.activePlanSource = source;
      state.plans[source] = normalized;
      state.activePlanSource = source;
      persistPlans();
    }
  }
  localStorage.removeItem(CURRENT_PLAN_KEY);
}

function migrateLegacyPlans() {
  if (!state.plans || !Object.keys(state.plans).length) return;
  for (const [source, plan] of Object.entries(state.plans)) {
    const weekKey = weekKeyFromPlanDays(plan?.days);
    if (!weekKey) continue;
    const bucket = weekPlans(weekKey, true);
    if (!bucket.sources[source]) {
      const normalized = normalizeStoredPlanForWeek(plan, weekKey);
      if (normalized) bucket.sources[source] = normalized;
    }
  }
}

function isSelectedWeekPlan(days) {
  return isWeekPlan(days, selectedWeekKey());
}

function normalizeStoredPlanForWeek(planState, weekKey) {
  if (!planState || !Array.isArray(planState.days) || planState.days.length !== 7) return null;
  if (!isWeekPlan(planState.days, weekKey)) return null;

  try {
    const normalized = normalizeAiPlan({
      summary: planState.summary || "",
      modelUsed: planState.modelUsed || "",
      days: planState.days,
    });
    return {
      source: planState.source || "local",
      summary: normalized.summary,
      modelUsed: normalized.modelUsed || planState.modelUsed || "",
      savedAt: planState.savedAt || new Date().toISOString(),
      weekStart: weekKey,
      days: normalized.days,
    };
  } catch {
    return null;
  }
}

function isWeekPlan(days, weekKey) {
  return weekKeyFromPlanDays(days) === weekKey;
}

function selectedWeekPlans(create = false) {
  return weekPlans(selectedWeekKey(), create);
}

function weekPlans(weekKey, create = false) {
  if (!state.plansByWeek || typeof state.plansByWeek !== "object") state.plansByWeek = {};
  if (!state.plansByWeek[weekKey] && create) {
    state.plansByWeek[weekKey] = {
      activePlanSource: "",
      sources: {},
    };
  }
  const bucket = state.plansByWeek[weekKey] || {};
  if (!bucket.sources) bucket.sources = {};
  return bucket;
}

function selectedWeekStartDate() {
  const parsed = dateFromAny(state.selectedWeekStart);
  return startOfTrainingWeek(parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date());
}

function selectedWeekKey() {
  return toDateInputValue(selectedWeekStartDate());
}

function currentWeekKey() {
  return toDateInputValue(startOfTrainingWeek(new Date()));
}

function weekKeyFromPlanDays(days) {
  if (!Array.isArray(days) || !days[0]?.date) return "";
  const firstDate = dateFromAny(days[0].date);
  if (!firstDate || Number.isNaN(firstDate.getTime())) return "";
  return toDateInputValue(startOfTrainingWeek(firstDate));
}

function selectWeek(weekKey) {
  state.selectedWeekStart = weekKey;
  saveJson(SELECTED_WEEK_KEY, state.selectedWeekStart);
  saveBackendState();
  renderAll();
  restoreCurrentPlanOrGenerate();
}

function changeSelectedWeek(days) {
  selectWeek(toDateInputValue(addDays(selectedWeekStartDate(), days)));
}

function renderPlanWeekLabel() {
  const label = document.querySelector("#planWeekLabel");
  if (!label) return;
  const start = selectedWeekStartDate();
  const end = addDays(start, 6);
  const range = `${formatDate(start)} - ${formatDate(end)}`;
  label.textContent = selectedWeekKey() === currentWeekKey() ? `${range} · текущая` : range;
}

function currentPlanStatusText(planState) {
  const summary = cleanPlanSummaryForStatus(planState.summary || "");
  if (planState.source === "ai") {
    const modelLabel = planState.modelUsed ? ` Модель: ${planState.modelUsed}.` : "";
    return `Представлен ИИ-план.${modelLabel} ${summary}`.trim();
  }
  if (planState.source === "json") {
    return `Представлен план из JSON. ${summary}`.trim();
  }
  return "Представлен локальный недельный план.";
}

function cleanPlanSummaryForStatus(summary) {
  let text = String(summary || "")
    .replace(/(?:\s*Локальная корректировка оставшихся дней выполнена по импортированным тренировкам\.)+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const raceGoal = raceGoalSummaryText();
  if (raceGoal) {
    text = text.replace(/Цель:\s*Подготовка к старту/gi, raceGoal);
  }

  return text;
}

function updatePlanSourceButtons(source) {
  const buttons = {
    local: document.querySelector("#generatePlan"),
    json: document.querySelector("#loadPlanJson"),
    ai: document.querySelector("#generateAiPlan"),
  };
  Object.entries(buttons).forEach(([key, button]) => {
    if (button) button.classList.toggle("active", key === source);
  });
}

function renderPlanDayDetails(day) {
  const planned = day.plannedWorkout || day.details || "";
  const actual = actualWorkoutsForPlanDay(day).map(formatActualWorkout);
  const execution = evaluatePlanDayExecution(day);
  const meta = [
    day.targetDistance ? `Ориентир: ${day.targetDistance}` : "",
    day.intensity ? `Интенсивность: ${day.intensity}` : "",
  ].filter(Boolean);

  return `
    ${planned ? `
      <div class="plan-section plan-assignment">
        <span class="section-label">Задание</span>
        <p>${escapeHtml(planned)}</p>
      </div>
    ` : ""}
    ${meta.length ? `
      <div class="plan-section plan-meta">
        <span class="section-label">Параметры</span>
        <p>${escapeHtml(meta.join(" · "))}</p>
      </div>
    ` : ""}
    ${actual.length ? `
      <div class="plan-section plan-actual">
        <span class="section-label">Факт</span>
        <p>${actual.map((line) => escapeHtml(line)).join("<br>")}</p>
      </div>
    ` : ""}
    ${execution.show ? `
      <div class="plan-section plan-execution ${execution.level}">
        <span class="section-label">Оценка</span>
        <p><strong>${escapeHtml(execution.label)}</strong> · ${escapeHtml(execution.comment)}</p>
      </div>
    ` : ""}
    ${day.rationale ? `
      <div class="plan-section rationale">
        <span class="section-label">Почему так</span>
        <p>${escapeHtml(day.rationale)}</p>
      </div>
    ` : ""}
  `;
}

function buildWeekExecutionSummary(plan) {
  const days = Array.isArray(plan) ? plan : [];
  const weekStart = selectedWeekStartDate();
  const range = weekRange(weekStart);
  const actualWeekWorkouts = state.workouts.filter((workout) => {
    const date = new Date(workout.date);
    return date >= range.start && date < range.end;
  });
  const evaluations = days.map(evaluatePlanDayExecution);
  const plannedTrainingDays = days.filter((day) => plannedTypeForDay(day) !== "rest").length || days.length;
  const completedDays = evaluations.filter((item) => item.completed).length;
  const keyTypes = new Set(["interval", "tempo", "long", "race"]);
  const keyPlanned = days.filter((day) => keyTypes.has(plannedTypeForDay(day))).length;
  const keyCompleted = evaluations.filter((item) => item.keyCompleted).length;
  const actualLoad = actualWeekWorkouts.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const actualDistanceKm = actualWeekWorkouts.reduce((sum, workout) => sum + (Number(workout.distanceKm) || 0), 0);
  const today = startOfDay(new Date());
  const elapsedIndexes = days
    .map((day, index) => ({ day, index, date: startOfDay(day.date) }))
    .filter((item) => item.date <= today)
    .map((item) => item.index);
  const expectedElapsedLoad = elapsedIndexes.reduce((sum, index) => sum + plannedLoadScoreForDay(days[index]), 0);
  const actualElapsedLoad = actualWeekWorkouts
    .filter((workout) => startOfDay(workout.date) <= today)
    .reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const loadRatio = expectedElapsedLoad ? actualElapsedLoad / expectedElapsedLoad : null;
  const elapsedEvaluations = elapsedIndexes.map((index) => evaluations[index]);
  const elapsedCompletedDays = elapsedEvaluations.filter((item) => item.completed).length;
  const missedPastDays = elapsedEvaluations.filter((item) => item.level === "missed").length;
  const mismatchDays = elapsedEvaluations.filter((item) => item.level === "mismatch").length;
  const heavyDays = elapsedEvaluations.filter((item) => item.level === "harder").length;
  const phase = getPreparationPhase(weekStart);

  let adjustmentLevel = "наблюдать";
  let adjustmentReason = "неделя только началась или факта пока мало";
  if (heavyDays || (loadRatio && loadRatio > 1.25 && elapsedCompletedDays > 0)) {
    adjustmentLevel = "снизить";
    adjustmentReason = "фактическая нагрузка выше плана на уже выполненную часть недели";
  } else if (missedPastDays || mismatchDays) {
    adjustmentLevel = "перестроить";
    adjustmentReason = "есть пропущенные или замененные тренировки";
  } else if (loadRatio !== null && loadRatio < 0.55 && elapsedCompletedDays >= 2) {
    adjustmentLevel = "можно добавить";
    adjustmentReason = "фактическая нагрузка заметно ниже плана на прошедшие дни";
  } else if (elapsedCompletedDays > 0) {
    adjustmentLevel = "не нужна";
    adjustmentReason = "выполнение идет близко к текущей части плана";
  }

  return {
    weekLabel: `${formatDate(weekStart)} - ${formatDate(addDays(weekStart, 6))} · ${phase.label}`,
    plannedTrainingDays,
    completedDays,
    completionComment: completedDays
      ? `${Math.round((completedDays / plannedTrainingDays) * 100)}% дней с фактом`
      : "пока нет выполненных тренировок",
    actualWorkouts: actualWeekWorkouts.length,
    actualLoad,
    actualDistanceKm,
    keyPlanned,
    keyCompleted,
    keyComment: keyPlanned ? keyExecutionComment(days, evaluations) : "на неделе нет ключевых работ",
    adjustmentLevel,
    adjustmentReason,
  };
}

function keyExecutionComment(days, evaluations) {
  const labels = {
    interval: "интервалы",
    tempo: "темпо",
    long: "длительная",
    race: "гонка",
  };
  const missing = days
    .map((day, index) => ({ type: plannedTypeForDay(day), evaluation: evaluations[index] }))
    .filter((item) => labels[item.type] && !item.evaluation.keyCompleted)
    .map((item) => labels[item.type]);
  return missing.length ? `не закрыто: ${[...new Set(missing)].join(", ")}` : "ключевые работы закрыты";
}

function evaluatePlanDayExecution(day) {
  const actual = actualWorkoutsForPlanDay(day);
  const planDate = new Date(day.date);
  planDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const plannedType = plannedTypeForDay(day);

  if (!actual.length) {
    if (planDate < today && plannedType !== "rest") {
      return {
        show: true,
        completed: false,
        keyCompleted: false,
        level: "missed",
        label: "нет факта",
        comment: "тренировка в этот день не найдена среди импортированных",
      };
    }
    return {
      show: planDate <= today,
      completed: false,
      keyCompleted: false,
      level: "pending",
      label: planDate.getTime() === today.getTime() ? "ожидает факта" : "предстоит",
      comment: "после импорта тренировки статус обновится автоматически",
    };
  }

  const actualTypes = actual.map(getWorkoutType);
  const actualLoad = actual.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const plannedLoad = plannedLoadScoreForDay(day);
  const typeMatched = actualTypes.some((type) => planTypeMatchesActual(plannedType, type));
  const keyCompleted = ["interval", "tempo", "long", "race"].includes(plannedType) && typeMatched;

  if (!typeMatched && plannedType !== "rest") {
    return {
      show: true,
      completed: true,
      keyCompleted: false,
      level: "mismatch",
      label: "другой тип",
      comment: `по плану ${plannedTypeLabel(plannedType)}, по факту ${actualTypes.map(actualTypeLabel).join(", ")}`,
    };
  }

  if (plannedLoad && actualLoad > plannedLoad * 1.35) {
    return {
      show: true,
      completed: true,
      keyCompleted,
      level: "harder",
      label: "тяжелее плана",
      comment: `факт ${actualLoad} TRIMP против ориентира около ${plannedLoad}`,
    };
  }

  if (plannedLoad && actualLoad < plannedLoad * 0.55 && plannedType !== "recovery") {
    return {
      show: true,
      completed: true,
      keyCompleted,
      level: "lighter",
      label: "легче плана",
      comment: `факт ${actualLoad} TRIMP против ориентира около ${plannedLoad}`,
    };
  }

  return {
    show: true,
    completed: true,
    keyCompleted,
    level: "matched",
    label: "по плану",
    comment: "тип тренировки и нагрузка выглядят близко к заданию",
  };
}

function plannedTypeForDay(day) {
  const focus = String(day.focus || "").toLowerCase();
  if (matchesAny(focus, ["гонка", "старт", "race"])) return "race";
  if (matchesAny(focus, ["отдых"])) return "rest";
  if (matchesAny(focus, ["интервал", "vo2"])) return "interval";
  if (matchesAny(focus, ["темпо", "порог", "threshold"])) return "tempo";
  if (matchesAny(focus, ["длитель", "long"])) return "long";
  if (matchesAny(focus, ["восстанов", "recovery"])) return "recovery";
  if (matchesAny(focus, ["кросс", "легк", "аэроб"])) return "easy";

  const assignment = `${day.title || ""} ${day.plannedWorkout || day.details || ""}`.toLowerCase();
  if (matchesAny(assignment, ["гонка", "старт", "race"])) return "race";
  if (matchesAny(assignment, ["отдых", "без нагрузки"])) return "rest";
  if (matchesAny(assignment, ["интервал", "vo2", "повтор", "400", "800", "1000"])) return "interval";
  if (matchesAny(assignment, ["темповая работа", "темповый блок", "темповое включение", "порог", "threshold"])) return "tempo";
  if (matchesAny(assignment, ["длитель", "long"])) return "long";
  if (matchesAny(assignment, ["восстанов", "recovery"])) return "recovery";
  return "easy";
}

function planTypeMatchesActual(plannedType, actualType) {
  if (plannedType === actualType) return true;
  if (plannedType === "easy" && ["easy", "cross", "recovery"].includes(actualType)) return true;
  if (plannedType === "recovery" && ["recovery", "easy", "cross"].includes(actualType)) return true;
  if (plannedType === "race") return ["interval", "tempo", "long", "easy"].includes(actualType);
  if (plannedType === "rest") return false;
  return false;
}

function plannedLoadScoreForDay(day) {
  const durationFromStructure = plannedDurationMinutes(day);
  const durationFromDistance = plannedDurationFromDistance(day);
  const duration = Math.max(durationFromStructure || 0, durationFromDistance || 0) || null;
  const hrr = plannedHrReserveRatio(day);
  if (duration && hrr) {
    return Math.round(estimateTrimpFromHrr(duration, hrr));
  }

  const load = String(day.load || "").toLowerCase();
  if (load.includes("сорев")) return 180;
  if (load.includes("высок")) return 130;
  if (load.includes("сред")) return 95;
  if (load.includes("умерен")) return 75;
  if (load.includes("низк")) return 45;
  if (load.includes("без")) return 15;
  return 70;
}

function plannedDurationMinutes(day) {
  let text = `${day.title || ""} ${day.plannedWorkout || day.details || ""}`.toLowerCase();
  text = text
    .replace(/при признаках усталости[\s\S]*$/i, "")
    .replace(/при усталости[\s\S]*$/i, "")
    .replace(/каждые\s+\d{1,3}\s*[-–—]?\s*\d{0,3}\s*мин\w*/gi, "");

  const totalDuration = plannedTotalDurationMinutes(text);
  if (totalDuration) return totalDuration;

  let total = 0;
  const repeatedBlockPattern = /(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?\s*[xх×]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\s*мин\w*/gi;
  text = text.replace(repeatedBlockPattern, (match, fromRepeats, toRepeats, fromMinutes, toMinutes) => {
    const repeats = averageRange(fromRepeats, toRepeats);
    const minutes = averageRange(fromMinutes, toMinutes);
    total += repeats * minutes;
    return " ";
  });

  const rangePattern = /(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*мин\w*/gi;
  text = text.replace(rangePattern, (match, fromMinutes, toMinutes) => {
    total += averageRange(fromMinutes, toMinutes);
    return " ";
  });

  const minutePattern = /(\d{1,3})\s*мин\w*/gi;
  text.replace(minutePattern, (match, minutes) => {
    total += Number(minutes) || 0;
    return match;
  });

  return total > 0 ? Math.round(total) : null;
}

function plannedTotalDurationMinutes(text) {
  const firstTimeMatch = text.match(/(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\s*мин\w*/i);
  if (!firstTimeMatch) return null;

  const before = text.slice(0, firstTimeMatch.index);
  const after = text.slice(firstTimeMatch.index + firstTimeMatch[0].length, firstTimeMatch.index + firstTimeMatch[0].length + 90);
  const value = averageRange(firstTimeMatch[1], firstTimeMatch[2]);
  const looksLikeOverall =
    value >= 30 &&
    !matchesAny(before, ["размин", "затем", "после", "восстанов", "замин", "первые", "в конце", "между"]) &&
    !matchesAny(after, ["с восстановлением", "восстановление", "между блоками"]);

  return looksLikeOverall ? Math.round(value) : null;
}

function plannedDurationFromDistance(day) {
  const distance = plannedDistanceKm(day);
  const pace = recentReliablePace();
  if (!distance || !pace) return null;
  return Math.round(distance * pace);
}

function plannedDistanceKm(day) {
  const text = `${day.targetDistance || ""} ${day.title || ""} ${day.plannedWorkout || day.details || ""}`.toLowerCase().replace(",", ".");
  const ranges = [...text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}(?:\.\d+)?)\s*км/g)]
    .map((match) => averageRange(match[1], match[2]))
    .filter((value) => value > 0);
  if (ranges.length) return Math.max(...ranges);

  const values = [...text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*км/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 0);
  if (values.length) return Math.max(...values);
  return null;
}

function recentReliablePace() {
  const recent = state.workouts
    .filter((workout) => trustedPace(workout) && Number(workout.distanceKm) > 0)
    .slice(0, 12);
  return weightedAveragePace(recent);
}

function plannedHrReserveRatio(day) {
  const intensity = String(day.intensity || "").toLowerCase();
  if (intensity.includes("z1")) return 0.55;
  if (intensity.includes("z2")) return 0.68;
  if (intensity.includes("z3")) return 0.76;
  if (intensity.includes("z4")) return 0.84;
  if (intensity.includes("z5")) return 0.9;

  const text = `${day.focus || ""} ${day.title || ""} ${day.plannedWorkout || day.details || ""} ${intensity}`.toLowerCase();
  const type = plannedTypeForDay(day);

  if (matchesAny(text, ["z5", "vo2", "интервал"])) return 0.9;
  if (matchesAny(text, ["z4", "порог", "threshold"])) return 0.84;
  if (matchesAny(text, ["z2", "легко", "разговорный"])) return 0.68;
  if (matchesAny(text, ["z3", "верхней части легкой"])) return 0.76;
  if (matchesAny(text, ["марафонск"])) return 0.73;
  if (matchesAny(text, ["z1", "очень легко", "восстанов"])) return 0.55;

  if (type === "recovery") return 0.55;
  if (type === "easy" || type === "long") return 0.68;
  if (type === "tempo") return 0.78;
  if (type === "interval" || type === "race") return 0.9;
  if (type === "rest") return 0.2;
  return 0.68;
}

function averageRange(fromValue, toValue) {
  const from = Number(fromValue) || 0;
  const to = Number(toValue) || from;
  return (from + to) / 2;
}

function plannedTypeLabel(type) {
  return {
    interval: "интервалы",
    tempo: "темпо",
    long: "длительная",
    recovery: "восстановление",
    easy: "кросс",
    cross: "кросс",
    race: "гонка",
    rest: "отдых",
  }[type] || "тренировка";
}

function actualTypeLabel(type) {
  return plannedTypeLabel(type);
}

async function generateAiPlan() {
  const button = document.querySelector("#generateAiPlan");
  const fallbackPlan = buildPlan();
  renderPlan(fallbackPlan);
  setAiStatus("ИИ формирует план...", "");
  button.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAiRequest()),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "сервер вернул ошибку");
    }

    const aiPlan = normalizeAiPlan(payload.plan);
    const savedPlan = saveCurrentPlan({
      source: "ai",
      summary: aiPlan.summary,
      modelUsed: aiPlan.modelUsed,
      days: aiPlan.days,
    });
    renderPlan(savedPlan?.days || aiPlan.days);
    updatePlanSourceButtons("ai");
    const modelLabel = aiPlan.modelUsed ? `Модель: ${aiPlan.modelUsed}. ` : "";
    setAiStatus(`План сформирован ИИ. ${modelLabel}${aiPlan.summary}`, "ok");
  } catch (error) {
    const savedPlan = saveCurrentPlan({
      source: "local",
      summary: "ИИ недоступен. Показан локальный план.",
      days: fallbackPlan,
    });
    renderPlan(savedPlan?.days || fallbackPlan);
    updatePlanSourceButtons("local");
    setAiStatus(`ИИ недоступен: ${error.message}. Показан локальный план.`, "error");
  } finally {
    button.disabled = false;
  }
}

async function handlePlanJsonFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const rawPlan = parsePlanJsonText(await file.text());
    const plan = normalizeAiPlan(rawPlan.plan || rawPlan);
    const planWeekKey = weekKeyFromPlanDays(plan.days);
    if (planWeekKey && planWeekKey !== selectedWeekKey()) {
      state.selectedWeekStart = planWeekKey;
      saveJson(SELECTED_WEEK_KEY, state.selectedWeekStart);
      renderAll();
    }
    const savedPlan = saveCurrentPlan({
      source: "json",
      summary: plan.summary,
      modelUsed: plan.modelUsed,
      days: plan.days,
    });
    renderPlan(savedPlan?.days || plan.days);
    updatePlanSourceButtons("json");
    setAiStatus(`План из JSON загружен и сохранен: ${plan.summary}`, "ok");
  } catch (error) {
    setAiStatus(`Не удалось загрузить JSON плана: ${error.message}`, "error");
  } finally {
    planJsonInput.value = "";
  }
}

function parsePlanJsonText(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("файл должен содержать JSON-объект со свойствами summary и days");
  }
}

function buildPlan(weekStart = selectedWeekStartDate()) {
  const readiness = getReadiness();
  const target = getTargetDistanceProfile();
  const phase = getPreparationPhase(weekStart);
  const phaseGuidance = getPhaseGuidance(phase.id, target);
  const caution = getPlanCaution(readiness);
  const race = getRaceForWeek(weekStart);
  if (phase.id === "recovery" && !race) {
    return adaptPlanToCompletedWorkouts(buildRecoveryWeekPlan(weekStart, target, phaseGuidance), weekStart, target, caution);
  }

  const monday = readiness.level === "bad"
    ? planDay(weekStart, "Восстановление", "Отдых или очень легкая активность", `Полный отдых, 20-30 минут ходьбы или ${target.recoveryDetails.toLowerCase()} ${caution.recovery} ${phaseGuidance.recovery}`, "без нагрузки")
    : planDay(weekStart, "Восстановление", target.recoveryTitle, `${target.recoveryDetails} ${caution.recovery} ${phaseGuidance.recovery}`, "низкая нагрузка");

  const plan = [
    monday,
    planDay(addDays(weekStart, 1), "Интервалы", phaseGuidance.intervalTitle || target.intervalTitle, `${phaseGuidance.intervalDetails || target.intervalDetails} ${caution.quality} ${phaseGuidance.quality}`, phaseGuidance.qualityLoad || caution.qualityLoad),
    planDay(addDays(weekStart, 2), "Кросс", target.easyTitle, `${target.easyDetails} ${caution.easy} ${phaseGuidance.easy}`, phaseGuidance.easyLoad || "умеренная нагрузка"),
    planDay(addDays(weekStart, 3), "Кросс", target.secondEasyTitle, `${target.secondEasyDetails} ${caution.easy} ${phaseGuidance.easy}`, phaseGuidance.easyLoad || "умеренная нагрузка"),
    planDay(addDays(weekStart, 4), "Кросс", target.easyTitle, `${target.easyDetails} ${caution.easy} ${phaseGuidance.easy}`, phaseGuidance.easyLoad || "умеренная нагрузка"),
    planDay(addDays(weekStart, 5), "Темпо", phaseGuidance.tempoTitle || target.tempoTitle, `${phaseGuidance.tempoDetails || target.tempoDetails} ${caution.quality} На следующий день запланирована длительная, поэтому не добирайте лишний объем сверх задания. ${phaseGuidance.quality}`, phaseGuidance.qualityLoad || caution.qualityLoad),
    planDay(addDays(weekStart, 6), "Длительная", phaseGuidance.longTitle || target.longTitle, `${phaseGuidance.longDetails || target.longDetails} ${caution.long} ${phaseGuidance.long}`, phaseGuidance.longLoad || caution.longLoad),
  ];

  if (race) {
    return adaptPlanToCompletedWorkouts(buildRaceWeekPlan(weekStart, race, target, caution, readiness), weekStart, target, caution);
  }

  return adaptPlanToCompletedWorkouts(plan, weekStart, target, caution);
}

function getPreparationPhase(weekStart = selectedWeekStartDate()) {
  const selected = state.profile.prepPhase || "auto";
  if (selected !== "auto") return preparationPhaseById(selected);

  const race = getRaceSummary();
  if (!race) {
    const target = state.profile.targetDistance || "10k";
    return preparationPhaseById(target === "5k" || target === "10k" ? "speed" : "base");
  }

  const raceDate = dateFromAny(race.date);
  const weekEnd = addDays(weekStart, 6);
  const daysToRaceFromWeekEnd = Math.round((raceDate - weekEnd) / 86400000);
  if (daysToRaceFromWeekEnd < -3) return preparationPhaseById("recovery");
  if (daysToRaceFromWeekEnd <= 10) return preparationPhaseById("taper");
  if (daysToRaceFromWeekEnd <= 56) return preparationPhaseById("specific");
  return preparationPhaseById("base");
}

function preparationPhaseById(id) {
  const phases = {
    auto: {
      id: "auto",
      label: "авто по гонке",
      description: "этап определяется по дате старта",
    },
    base: {
      id: "base",
      label: "базовый период",
      description: "приоритет аэробного объема, техники и устойчивости к нагрузке",
    },
    speed: {
      id: "speed",
      label: "развитие скорости",
      description: "больше внимания экономичности, коротким ускорениям и VO2max",
    },
    specific: {
      id: "specific",
      label: "специфическая подготовка",
      description: "ключевые работы максимально близки к целевой дистанции",
    },
    taper: {
      id: "taper",
      label: "подводка",
      description: "снижение объема с сохранением короткой активации",
    },
    recovery: {
      id: "recovery",
      label: "восстановительная неделя",
      description: "снижение нагрузки и возвращение свежести",
    },
  };
  return phases[id] || phases.auto;
}

function getPhaseGuidance(phaseId, target) {
  const base = {
    recovery: "",
    quality: "",
    easy: "",
    long: "",
    qualityLoad: "",
    easyLoad: "",
    longLoad: "",
  };

  if (phaseId === "base") {
    return {
      ...base,
      intervalTitle: "Контролируемая развивающая работа",
      intervalDetails: "Разминка 15 минут, затем короткие интервалы по технике и экономичности: 10 x 1 минута бодро с 1 минутой легко, заминка 10 минут.",
      quality: "Главная цель этапа - не максимальная скорость, а чистая техника и запас.",
      easy: "Допускается небольшой прирост объема, если пульс и восстановление стабильны.",
      long: "Длительная остается спокойной, без соревновательного усилия.",
    };
  }

  if (phaseId === "speed") {
    return {
      ...base,
      intervalTitle: target.intervalTitle,
      intervalDetails: target.intervalDetails,
      quality: "Сохраняйте высокое качество быстрых отрезков, но прекращайте работу при распаде техники.",
      easy: "Кроссы должны помогать восстановиться после скорости, а не добавлять скрытое темпо.",
      long: "Длительную держите легче обычного, чтобы скорость не утонула в усталости.",
    };
  }

  if (phaseId === "specific") {
    return {
      ...base,
      quality: "Интенсивность должна быть близка к усилию целевой дистанции, без лишней героики.",
      easy: "Легкие дни поддерживают объем и не конкурируют с ключевыми работами.",
      long: "Добавляйте специфический блок только если неделя идет по плану.",
    };
  }

  if (phaseId === "taper") {
    return {
      ...base,
      intervalTitle: "Короткая активация вместо полной интервальной",
      intervalDetails: "Разминка 15 минут, затем 5 x 1 минута в целевом усилии с полным легким восстановлением, заминка 10 минут.",
      tempoTitle: "Короткое темповое включение",
      tempoDetails: "Разминка 15 минут, затем 2 x 8 минут в целевом усилии с 4 минутами легко, заминка 10 минут.",
      longTitle: "Сокращенная длительная",
      longDetails: "60-80 минут легко, без добора объема и без финишного ускорения.",
      quality: "Объем снижен: задача - сохранить тонус, а не накопить усталость.",
      easy: "Все легкие дни короче обычного и с запасом.",
      long: "Если старт близко, выбирайте нижнюю границу длительности.",
      qualityLoad: "средняя нагрузка",
      easyLoad: "низкая нагрузка",
      longLoad: "средняя нагрузка",
    };
  }

  return base;
}

function buildRecoveryWeekPlan(weekStart, target, phaseGuidance) {
  return [
    planDay(weekStart, "Восстановление", "Отдых или очень легкая активность", "Полный отдых, ходьба или 20-30 минут очень легко. Цель недели - восстановить свежесть.", "без нагрузки"),
    planDay(addDays(weekStart, 1), "Восстановление", target.recoveryTitle, `${target.recoveryDetails} Без ускорений и без контроля темпа.`, "низкая нагрузка"),
    planDay(addDays(weekStart, 2), "Кросс", "Легкий аэробный бег", "35-50 минут спокойно в Z1-Z2. Остановитесь раньше, если ноги тяжелые.", "низкая нагрузка"),
    planDay(addDays(weekStart, 3), "Восстановление", "Отдых или ОФП", "Отдых, мобилити или 20-30 минут очень легко. Силовая только легкая.", "без нагрузки"),
    planDay(addDays(weekStart, 4), "Кросс", target.easyTitle, `${target.easyDetails} ${phaseGuidance.easy || "Держите запас и не добавляйте прогрессии."}`, "низкая нагрузка"),
    planDay(addDays(weekStart, 5), "Кросс", "Легкий бег с короткими ускорениями", "35-45 минут легко, в конце 4 x 15 секунд свободно только при хорошей свежести.", "низкая нагрузка"),
    planDay(addDays(weekStart, 6), "Длительная", "Сокращенная длительная восстановительной недели", "70-90 минут легко для 21/42 км или 55-70 минут для 5/10 км. Без темпового финиша.", "средняя нагрузка"),
  ];
}

function getRaceForWeek(weekStart) {
  const race = getRaceSummary();
  if (!race) return null;
  const raceDate = dateFromAny(race.date);
  raceDate.setHours(0, 0, 0, 0);
  const range = weekRange(weekStart);
  if (raceDate < range.start || raceDate >= range.end) return null;
  return {
    date: raceDate,
    distance: race.distance,
    distanceLabel: race.distanceLabel,
    name: race.name,
    dayIndex: Math.round((raceDate - range.start) / 86400000),
  };
}

function getRaceSummary() {
  if (!state.profile.raceDate) return null;
  const raceDate = dateFromAny(state.profile.raceDate);
  if (!raceDate || Number.isNaN(raceDate.getTime())) return null;
  raceDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const raceDistance = state.profile.raceDistance || state.profile.targetDistance || "10k";
  return {
    date: toDateInputValue(raceDate),
    dateLabel: raceDate.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" }),
    daysUntil: Math.round((raceDate - today) / 86400000),
    distance: raceDistance,
    distanceLabel: raceDistanceLabel(raceDistance),
    name: state.profile.raceName || `Гонка ${raceDistanceLabel(raceDistance)}`,
  };
}

function buildRaceWeekPlan(weekStart, race, target, caution, readiness) {
  const plan = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(weekStart, index);
    const daysToRace = race.dayIndex - index;
    const daysAfterRace = index - race.dayIndex;

    if (index === race.dayIndex) {
      plan.push(planDay(date, "Гонка", race.name, raceDayDetails(race), "соревновательная нагрузка"));
    } else if (daysToRace === 1) {
      plan.push(planDay(date, "Подводка", "Отдых или короткая разминка", "20-30 минут очень легко или полный отдых. Можно 4 x 15 секунд ускорения только если ноги свежие.", "низкая нагрузка"));
    } else if (daysToRace === 2) {
      plan.push(planDay(date, "Кросс", "Короткий легкий бег перед стартом", "30-45 минут в Z1-Z2, без добора объема и без темповой работы. Главная цель - свежесть к гонке.", "низкая нагрузка"));
    } else if (daysToRace >= 3 && daysToRace <= 5 && index === 1 && readiness.level !== "bad") {
      plan.push(planDay(date, "Активация", raceTuneUpTitle(race), `${raceTuneUpDetails(race)} Это не полноценная интервальная тренировка, а короткая активация перед стартом.`, "средняя нагрузка"));
    } else if (daysToRace > 0) {
      plan.push(planDay(date, index === 0 ? "Восстановление" : "Кросс", target.easyTitle, `${target.easyDetails} Неделя старта: оставьте запас, не добавляйте лишние ускорения.`, index === 0 ? "низкая нагрузка" : "умеренная нагрузка"));
    } else if (daysAfterRace === 1) {
      plan.push(planDay(date, "Восстановление", "Восстановление после гонки", "Полный отдых, ходьба или 20-30 минут очень легко по самочувствию. Оцените ноги и общий тонус.", "низкая нагрузка"));
    } else {
      plan.push(planDay(date, "Восстановление", target.recoveryTitle, `${target.recoveryDetails} После гонки держите неделю восстановительной, качество не дублируйте.`, "низкая нагрузка"));
    }
  }
  return plan;
}

function raceDistanceLabel(value) {
  const labels = {
    "5k": "5 км",
    "10k": "10 км",
    "21k": "21 км",
    "42k": "42 км",
  };
  return labels[value] || value || "целевая дистанция";
}

function toDateInputValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function raceDayDetails(race) {
  const warmup = race.distance === "42k"
    ? "10-15 минут очень легко, суставная разминка, без длинных ускорений."
    : "15-20 минут легко, 3-4 коротких ускорения по 10-15 секунд, затем спокойно выйти на старт.";
  return `${race.distanceLabel}. ${warmup} Стартуйте контролируемо: первая часть без форсирования, затем работайте по самочувствию и плану питания/питья.`;
}

function raceTuneUpTitle(race) {
  if (race.distance === "5k") return "Короткая активация под 5 км";
  if (race.distance === "10k") return "Короткая активация под 10 км";
  if (race.distance === "21k") return "Активация под полумарафон";
  return "Легкая активация перед марафоном";
}

function raceTuneUpDetails(race) {
  if (race.distance === "5k") return "Разминка 15 минут, затем 5 x 1 минута в усилии 5 км с полным легким восстановлением, заминка 10 минут.";
  if (race.distance === "10k") return "Разминка 15 минут, затем 4 x 2 минуты в усилии 10 км с 2 минутами легко, заминка 10 минут.";
  if (race.distance === "21k") return "Разминка 15 минут, затем 3 x 5 минут в усилии полумарафона с 3 минутами легко, заминка 10 минут.";
  return "40-50 минут легко, в середине 3 x 3 минуты в марафонском усилии с полным контролем пульса.";
}

function getTargetDistanceProfile() {
  const value = state.profile.targetDistance || "10k";
  const profiles = {
    "5k": {
      label: "5 км",
      intervalTitle: "Интервалы под 5 км",
      intervalDetails: "Разминка 15 минут, затем 8 x 400 м или 8 x 90 секунд в усилии 3-5 км с 200 м трусцы, заминка 10 минут.",
      tempoTitle: "Темповая устойчивость для 5 км",
      tempoDetails: "Разминка 15 минут, затем 18-22 минуты ровно в пороговом усилии RPE 7/10, заминка 10 минут.",
      longTitle: "Аэробная база для 5 км",
      longDetails: "60-75 минут легко. В конце 4 x 20 секунд ускорения с полным восстановлением, если ноги свежие.",
      easyTitle: "Легкий кросс для экономичности",
      easyDetails: "35-50 минут в Z2, ровно и без гонки за темпом. После бега 6-8 минут ОФП корпуса.",
      secondEasyTitle: "Кросс с техникой",
      secondEasyDetails: "35-45 минут легко, затем 6 коротких беговых упражнений или ускорений по 15 секунд.",
      recoveryTitle: "Восстановительный бег",
      recoveryDetails: "25-35 минут очень легко в Z1-Z2, без ускорений.",
    },
    "10k": {
      label: "10 км",
      intervalTitle: "Интервалы под 10 км",
      intervalDetails: "Разминка 15 минут, затем 5 x 1000 м в усилии 5-10 км с 2-3 минутами легкого бега, заминка 10 минут.",
      tempoTitle: "Пороговая работа под 10 км",
      tempoDetails: "Разминка 15 минут, затем 3 x 8 минут в районе порога с 3 минутами легко, заминка 10 минут.",
      longTitle: "Длинная спокойная тренировка",
      longDetails: "75-95 минут легко. Держите разговорный темп и ровное усилие.",
      easyTitle: "Аэробный кросс под 10 км",
      easyDetails: "45-55 минут в Z2, последние 10 минут чуть собраннее, но без перехода в темпо.",
      secondEasyTitle: "Легкий кросс",
      secondEasyDetails: "40-50 минут легко, цель - набрать объем без утомления.",
      recoveryTitle: "Восстановительный бег",
      recoveryDetails: "30-40 минут очень легко в Z1-Z2, можно заменить ходьбой при усталости.",
    },
    "21k": {
      label: "21 км",
      intervalTitle: "Длинные интервалы под полумарафон",
      intervalDetails: "Разминка 15 минут, затем 5 x 5 минут в усилии 10 км с 2 минутами легко, заминка 10 минут.",
      tempoTitle: "Темповая выносливость под 21 км",
      tempoDetails: "Разминка 15 минут, затем 2 x 15 минут в устойчивом темпе полумарафона с 5 минутами легко, заминка 10 минут.",
      longTitle: "Длинная для полумарафона",
      longDetails: "90-110 минут легко, последние 15 минут чуть быстрее, если самочувствие ровное.",
      easyTitle: "Аэробный кросс под 21 км",
      easyDetails: "50-65 минут легко в Z2. Главная цель - ровный пульс и экономичность.",
      secondEasyTitle: "Восстановительный кросс",
      secondEasyDetails: "45-55 минут спокойно, без ускорений и без контроля темпа.",
      recoveryTitle: "Восстановительный бег",
      recoveryDetails: "30-45 минут очень легко, держать запас по дыханию.",
    },
    "42k": {
      label: "42 км",
      intervalTitle: "Контролируемые интервалы под марафон",
      intervalDetails: "Разминка 15 минут, затем 6 x 3 минуты в усилии 10 км или в подъем с 2 минутами легко, заминка 10 минут.",
      tempoTitle: "Марафонская устойчивость",
      tempoDetails: "Разминка 15 минут, затем 2 x 20 минут в марафонском усилии с 5 минутами легко, заминка 10 минут.",
      longTitle: "Длинная аэробная для марафона",
      longDetails: "120-150 минут легко. Приоритет - экономичность, питание, питье и ровный пульс.",
      easyTitle: "Аэробный кросс под марафон",
      easyDetails: "60-75 минут легко в Z2, без ускорений. Нагрузка должна ощущаться накопительной, не острой.",
      secondEasyTitle: "Легкий объемный кросс",
      secondEasyDetails: "50-65 минут спокойно, можно по мягкому покрытию.",
      recoveryTitle: "Восстановительный бег",
      recoveryDetails: "35-45 минут очень легко, цель - снять остаточную усталость.",
    },
  };
  return profiles[value] || profiles["10k"];
}

function getPlanCaution(readiness) {
  if (readiness.level === "bad") {
    return {
      quality: "Из-за текущей готовности сократите объем на 30-40% и держите технику без борьбы за темп.",
      recovery: "Если есть тяжелые ноги, замените на ходьбу.",
      easy: "Держите разговорный темп и закончите с ощущением запаса.",
      long: "Сократите длительную на 20-30%, если пульс выше обычного или есть накопленная усталость.",
      qualityLoad: "средняя нагрузка, сниженный объем",
      longLoad: "средняя нагрузка",
    };
  }

  if (readiness.level === "warn") {
    return {
      quality: "Держите верхнюю границу усилия под контролем и не добавляйте лишние повторы.",
      recovery: "Не ускоряйтесь даже при хорошем самочувствии.",
      easy: "Ровное Z2, без добора объема сверх плана.",
      long: "Последнее ускорение выполняйте только при хорошем самочувствии.",
      qualityLoad: "средняя нагрузка",
      longLoad: "средняя нагрузка",
    };
  }

  return {
    quality: "Если самочувствие нормальное, выполняйте полный объем.",
    recovery: "Бег должен ощущаться легче обычного кросса.",
    easy: "Работайте спокойно, это поддержка ключевых тренировок недели.",
    long: "Держите ровное усилие и не превращайте длительную в темповую.",
    qualityLoad: "высокая нагрузка",
    longLoad: "средняя нагрузка",
  };
}

function adaptPlanToCompletedWorkouts(plan, weekStart, target, caution) {
  const completedTypes = completedWorkoutTypesForWeek(weekStart);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return plan.map((day) => {
    const planDate = new Date(day.date);
    planDate.setHours(0, 0, 0, 0);
    if (planDate <= today || isPlanDayCompleted(day)) return day;

    if (day.focus === "Интервалы" && completedTypes.has("interval")) {
      return planDay(planDate, "Кросс", target.easyTitle, `${target.easyDetails} Интервальная работа на этой неделе уже выполнена, повторять ее не нужно.`, "умеренная нагрузка");
    }

    if (day.focus === "Темпо" && completedTypes.has("tempo")) {
      return planDay(planDate, "Кросс", target.secondEasyTitle, `${target.secondEasyDetails} Темповая работа на этой неделе уже выполнена, оставьте день аэробным.`, "умеренная нагрузка");
    }

    if (day.focus === "Длительная" && completedTypes.has("long")) {
      return planDay(planDate, "Восстановление", target.recoveryTitle, `${target.recoveryDetails} Длительная на этой неделе уже выполнена, приоритет - восстановление.`, "низкая нагрузка");
    }

    if ((completedTypes.has("interval") || completedTypes.has("tempo")) && day.focus === "Кросс") {
      return {
        ...day,
        details: `${day.details} Уже есть качественная работа на этой неделе, держите этот день строго аэробным.`,
      };
    }

    return day;
  });
}

function completedWorkoutTypesForWeek(weekStart) {
  const range = weekRange(weekStart);
  return new Set(
    state.workouts
      .filter((workout) => {
        const date = new Date(workout.date);
        return date >= range.start && date < range.end;
      })
      .map(getWorkoutType)
  );
}

function planDay(date, focus, title, details, load) {
  return {
    date: date.toISOString(),
    dateLabel: date.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }),
    focus,
    title,
    details,
    load,
  };
}

function getReadiness() {
  if (state.workouts.length < 2) {
    return { level: "bad", label: "низкая", reason: "мало истории" };
  }

  const week = sumLoad(7);
  const previousWeek = sumLoadRange(8, 14);
  const last = state.workouts[0];
  const hoursSinceLast = (Date.now() - new Date(last.date).getTime()) / 36e5;

  if (hoursSinceLast < 18 && last.load > 80) {
    return { level: "bad", label: "восстановление", reason: "недавно была заметная нагрузка" };
  }

  if (previousWeek > 0 && week > previousWeek * 1.45) {
    return { level: "warn", label: "осторожно", reason: "нагрузка выросла быстрее обычного" };
  }

  if (hoursSinceLast > 72 || week < 120) {
    return { level: "good", label: "готов", reason: "есть пространство для тренировки" };
  }

  return { level: "warn", label: "средняя", reason: "держите нагрузку контролируемой" };
}

function buildAiPrompt(plan) {
  const request = buildAiRequest();
  return [
    request.system,
    `Данные спортсмена и тренировок: ${JSON.stringify(request.context, null, 2)}`,
    `Планируемая неделя: ${JSON.stringify(request.planningWeek, null, 2)}`,
    "Верни JSON по схеме: summary, days[] на 7 дней. В days указывай только задание на тренировку: details/plannedWorkout, targetDistance, intensity, load, rationale. Не добавляй actualWorkout и не описывай факт выполнения: приложение возьмет факт из импортированных тренировок. Для интервальных и темповых дней в details/plannedWorkout обязательно укажи разминку, количество/длительность отрезков или блоков, интенсивность, восстановление и заминку.",
  ].join("\n\n");
}

function buildAiRequest() {
  const recent = state.workouts.slice(0, 20).map((workout) => ({
    date: workout.date.slice(0, 10),
    sport: workout.sport,
    workoutType: getWorkoutType(workout),
    durationMin: workout.durationMin,
    distanceKm: workout.distanceKm,
    paceMinPerKm: trustedPace(workout),
    pace: formatTrustedPace(workout),
    paceSource: workout.paceSource || "",
    avgSpeed: workout.avgSpeed || null,
    maxSpeed: workout.maxSpeed || null,
    intervalSignals: workout.intervalSignals || null,
    lapSignals: workout.lapSignals || null,
    avgHr: workout.avgHr,
    rpe: workout.rpe,
    load: workout.load,
    loadSource: workout.loadSource || "",
  }));

  return {
    system:
      "Ты опытный тренер по видам спорта на выносливость. Составляй календарный недельный микроцикл с понедельника по воскресенье от текущего тренировочного состояния спортсмена и этапа подготовки preparationPhase. Понедельник - восстановительный бег или отдых при необходимости, воскресенье - длительная тренировка. В нормальной развивающей неделе должны быть 1 интенсивная интервальная работа, 1 темповая работа, 1 длительная, легкие кроссы и восстановительный бег. Если этап recovery или taper, снижай объем и не дублируй тяжелые стимулы. Все работы должны строго соответствовать целевой дистанции спортсмена. Для интервальных и темповых дней обязательно указывай структуру работы: разминку, количество повторов/блоков, длину или время каждого отрезка, интенсивность, восстановление между отрезками и заминку. Не перестраховывайся легкими днями по умолчанию. Если данные показывают перегруз, сохраняй смысл недели, но снижай объем/интенсивность и объясняй почему. Не давай медицинских диагнозов и не назначай лечение.",
    context: {
      profile: state.profile,
      race: getRaceSummary(),
      preparationPhase: getPreparationPhase(),
      readiness: getReadiness(),
      trainingState: buildTrainingState(),
      load7Days: sumLoad(7),
      load28Days: sumLoad(28),
      previous7DaysLoad: sumLoadRange(8, 14),
      recentWorkouts: recent,
      requiredWeeklyStructure: [
        "понедельник: восстановительный бег или отдых при необходимости",
        "вторник: интенсивная интервальная работа",
        "среда: легкий кросс",
        "четверг: легкий кросс",
        "пятница: легкий кросс",
        "суббота: темповая работа",
        "воскресенье: длительная тренировка",
      ],
      racePlanningRules: [
        "если race.date попадает в неделю локального плана, день race.date является главным стартом недели",
        "за 1 день до гонки - отдых или короткая разминка, без темпо и интервалов",
        "за 2 дня до гонки - только короткий легкий бег",
        "после гонки - восстановление; не дублировать длительную, темпо или интервалы",
        "обычная недельная структура применяется только если в неделе нет гонки",
      ],
      preparationBlockRules: [
        "если preparationPhase.id = base, приоритет аэробный объем, техника, силовая устойчивость; интервалы контролируемые",
        "если preparationPhase.id = speed, интервалы могут быть быстрее/короче, но легкие дни должны реально восстанавливать",
        "если preparationPhase.id = specific, ключевые работы должны быть максимально близки к целевой дистанции спортсмена",
        "если preparationPhase.id = taper, снижай объем и оставляй короткую активацию без накопления усталости",
        "если preparationPhase.id = recovery, неделя восстановительная: без полноценной интервальной и без тяжелой темповой",
      ],
      workoutSpecificationRules: [
        "details/plannedWorkout должны содержать только задание на тренировку, а не факт выполнения",
        "не возвращай поле actualWorkout и не пиши факт выполнения в details, plannedWorkout или rationale; факт приложение покажет само из импортированных тренировок",
        "для интервальной тренировки details/plannedWorkout должен содержать: разминка; N x дистанция или время отрезка; целевая интенсивность; восстановление между отрезками; заминка",
        "пример интервальной формулировки: разминка 15 минут, затем 6 x 1000 м в усилии 10 км или 3:55-4:05 мин/км при наличии импортированных темпов, восстановление 400 м трусцой, заминка 10 минут",
        "для темповой тренировки details/plannedWorkout должен содержать: разминка; длительность или блоки темпо; интенсивность; восстановление между блоками; заминка",
        "для длительной details/plannedWorkout должен содержать: длительность или диапазон километража, интенсивность, допустимый прогресс/ускорение и питание/питье для длинных целей",
        "если надежного импортированного темпа нет, задавай интенсивность через RPE, пульсовую зону, усилие гонки или разговорный темп, а не через вычисленный темп",
      ],
    },
    planningWeek: buildPlanningWeek(),
  };
}

function buildPlanningWeek() {
  const weekStart = selectedWeekStartDate();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    return {
      date: date.toISOString(),
      dateLabel: date.toLocaleDateString("ru-RU", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      weekday: date.toLocaleDateString("ru-RU", { weekday: "long" }),
    };
  });

  return {
    weekStart: days[0]?.date || "",
    weekEnd: days[6]?.date || "",
    days,
    targetDistance: getTargetDistanceProfile().label,
    preparationPhase: getPreparationPhase(weekStart),
    race: getRaceSummary(),
    instruction:
      "Сформируй план именно на эти 7 дат с понедельника по воскресенье. Используй фактические тренировки и состояние спортсмена, а не текущий отображаемый план.",
  };
}

function buildTrainingState() {
  const load7 = sumLoad(7);
  const load28 = sumLoad(28);
  const previous7 = sumLoadRange(8, 14);
  const weekStart = selectedWeekStartDate();
  const completedThisWeek = completedWorkoutTypesForWeek(weekStart);
  const avg7From28 = Math.round(load28 / 4);
  const monotony = avg7From28 ? round(load7 / avg7From28, 2) : null;
  const rampRate = previous7 ? round(load7 / previous7, 2) : null;
  const workouts7 = countWorkouts(7);
  const workouts28 = countWorkouts(28);
  const last = state.workouts[0];
  const hoursSinceLast = last ? Math.round((Date.now() - new Date(last.date).getTime()) / 36e5) : null;
  const longestRecent = maxBy(state.workouts.slice(0, 12), "durationMin");
  const hardestRecent = maxBy(state.workouts.slice(0, 12), "load");
  const paceSamples = state.workouts
    .filter((workout) => trustedPace(workout))
    .slice(0, 12)
    .map((workout) => trustedPace(workout))
    .filter(Boolean);

  return {
    load7,
    load28,
    previous7,
    avgWeeklyLoadFrom28Days: avg7From28,
    acuteChronicRatio: monotony,
    rampRate,
    workouts7,
    workouts28,
    hoursSinceLast,
    longestRecentWorkoutMin: longestRecent?.durationMin || 0,
    hardestRecentWorkoutLoad: hardestRecent?.load || 0,
    recentAveragePaceMinPerKm: paceSamples.length ? round(average(paceSamples), 2) : null,
    recentAveragePace: paceSamples.length ? formatPace(average(paceSamples)) : "нет данных",
    completedWorkoutTypesThisWeek: [...completedThisWeek],
    recommendedApproach: chooseTrainingApproach(load7, avg7From28, rampRate, hoursSinceLast),
    targetDistance: getTargetDistanceProfile().label,
    preparationPhase: getPreparationPhase(weekStart),
    race: getRaceSummary(),
  };
}

function chooseTrainingApproach(load7, avg7From28, rampRate, hoursSinceLast) {
  if (hoursSinceLast !== null && hoursSinceLast < 18 && load7 > 250) {
    return "сначала восстановить свежесть, затем вернуться к развивающей работе";
  }
  if (rampRate && rampRate > 1.45) {
    return "не наращивать объем резко; оставить одну качественную, но контролируемую тренировку";
  }
  if (avg7From28 && load7 < avg7From28 * 0.8) {
    return "можно планировать развивающую тренировку и умеренное увеличение объема";
  }
  if (avg7From28 && load7 <= avg7From28 * 1.15) {
    return "поддерживать текущую базу и добавить один качественный стимул";
  }
  return "держать нагрузку умеренной и следить за восстановлением";
}

function normalizeAiPlan(plan) {
  if (!plan || !Array.isArray(plan.days)) {
    throw new Error("ИИ вернул план в неожиданном формате");
  }

  const fallback = buildPlan(selectedWeekStartDate());
  const days = plan.days.slice(0, 7).map((day, index) => normalizePlanDay(day, fallback[index], index));

  while (days.length < 7) {
    days.push(fallback[days.length]);
  }

  return {
    summary: planSummaryText(plan.summary),
    modelUsed: plan.modelUsed || "",
    days,
  };
}

function normalizePlanDay(day, fallbackDay, index) {
  const fallbackDate = addDays(selectedWeekStartDate(), index).toISOString();
  const date = day.date || fallbackDay?.date || fallbackDate;
  const dateLabel =
    day.dateLabel ||
    new Date(date).toLocaleDateString("ru-RU", {
      weekday: "short",
      day: "numeric",
        month: "short",
      });
  const splitDetails = splitPlanAndActual(day);

  return {
    date,
    dateLabel,
    focus: day.focus || fallbackDay?.focus || "План",
    title: day.title || fallbackDay?.title || "Тренировка",
    details: splitDetails.planned || fallbackDay?.details || "Детали не указаны.",
    plannedWorkout: splitDetails.planned,
    actualWorkout: "",
    intensity: day.intensity || "",
    targetDistance: day.targetDistance || "",
    load: day.load || day.loadLevel || fallbackDay?.load || "умеренная нагрузка",
    rationale: day.rationale || day.purpose || "",
  };
}

function splitPlanAndActual(day) {
  const explicitPlanned = day.plannedWorkout || "";
  const details = String(day.details || "").trim();
  if (!details) return { planned: explicitPlanned, actual: "" };

  const actualMatch = details.match(/^(?:Выполнено|Факт|Actual)\s*:\s*/i);
  if (!actualMatch) {
    return {
      planned: explicitPlanned || details,
      actual: "",
    };
  }

  const rest = details.slice(actualMatch[0].length).trim();
  const planMarker = rest.search(/(?:Структура работы|План|Задание|Разминка|Основной блок)\s*:/i);
  if (planMarker === -1) {
    return {
      planned: explicitPlanned,
      actual: "",
    };
  }

  const planned = rest.slice(planMarker).trim();
  return {
    planned: explicitPlanned || planned,
    actual: "",
  };
}

function planDayDetailsText(day) {
  const splitDetails = splitPlanAndActual(day);
  const parts = [
    splitDetails.planned || "",
    day.targetDistance ? `Ориентир по дистанции: ${day.targetDistance}` : "",
    day.intensity ? `Интенсивность: ${day.intensity}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function planSummaryText(summary) {
  if (!summary) return "Проверьте самочувствие перед выполнением.";
  if (typeof summary === "string") return summary;
  if (typeof summary !== "object") return String(summary);

  return [
    summary.mainDecision,
    summary.loadComment,
    planGoalSummaryText(summary.goal),
    summary.week ? `Неделя: ${summary.week}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function planGoalSummaryText(goal) {
  const text = String(goal || "").trim();
  if (!text) return "";

  const raceGoal = raceGoalSummaryText();
  if (raceGoal && text.toLowerCase() === "подготовка к старту") {
    return raceGoal;
  }

  return `Цель: ${text}`;
}

function raceGoalSummaryText() {
  const race = getRaceSummary();
  if (!race) return "";
  return `Цель: подготовка к старту ${race.name}, ${race.distanceLabel}, ${race.dateLabel}`;
}

function setAiStatus(message, level) {
  const status = document.querySelector("#aiStatus");
  status.textContent = message;
  status.className = `ai-status ${level || ""}`.trim();
}

function clearWorkouts() {
  if (!confirm("Удалить все сохраненные тренировки из браузера и локальной БД?")) return;
  state.workouts = [];
  persistWorkouts();
  renderAll();
  restoreCurrentPlanOrGenerate();
}

async function copyPrompt() {
  const field = document.querySelector("#aiPrompt");
  const prompt = field.value;

  if (!prompt.trim()) {
    showToast("Контекст для ИИ пока пуст");
    return;
  }

  const copied = await copyTextToClipboard(prompt, field);
  if (copied) {
    showToast("Контекст скопирован");
    return;
  }

  setAiStatus("Не удалось скопировать контекст. Выделите текст вручную.", "error");
  showToast("Не удалось скопировать");
}

async function copyTextToClipboard(text, sourceField) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Some browsers allow clipboard access only in secure contexts.
    }
  }

  if (sourceField && copyFromTextField(sourceField)) {
    return true;
  }

  const tempField = document.createElement("textarea");
  tempField.value = text;
  tempField.setAttribute("readonly", "");
  tempField.style.position = "fixed";
  tempField.style.left = "-9999px";
  tempField.style.top = "0";
  document.body.appendChild(tempField);

  const copied = copyFromTextField(tempField);
  tempField.remove();
  return copied;
}

function copyFromTextField(field) {
  const wasReadonly = field.hasAttribute("readonly");

  try {
    if (wasReadonly) {
      field.removeAttribute("readonly");
    }
    try {
      field.focus({ preventScroll: true });
    } catch {
      field.focus();
    }
    field.select();
    field.setSelectionRange(0, field.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    if (wasReadonly) {
      field.setAttribute("readonly", "");
    }
    window.getSelection()?.removeAllRanges();
  }
}

function hydrateProfile() {
  settingsForm.elements.name.value = state.profile.name || "";
  settingsForm.elements.goal.value = state.profile.goal || "Поддержание формы";
  settingsForm.elements.targetDistance.value = state.profile.targetDistance || "10k";
  settingsForm.elements.prepPhase.value = state.profile.prepPhase || "auto";
  settingsForm.elements.raceDate.value = state.profile.raceDate || "";
  settingsForm.elements.raceDistance.value = state.profile.raceDistance || "";
  settingsForm.elements.raceName.value = state.profile.raceName || "";
  settingsForm.elements.maxHr.value = state.profile.maxHr || 185;
  settingsForm.elements.restHr.value = state.profile.restHr || 50;
  settingsForm.elements.daysPerWeek.value = state.profile.daysPerWeek || 4;
  settingsForm.elements.constraints.value = state.profile.constraints || "";
}

function persistWorkouts() {
  saveJson(STORAGE_KEY, state.workouts);
  saveBackendState();
}

async function loadBackendState() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/state`);
    if (!response.ok) return;
    const payload = await response.json();
    const hasBackendWorkouts = Array.isArray(payload.workouts) && payload.workouts.length > 0;
    const hasBackendProfile = payload.profile && typeof payload.profile === "object";
    const hasBackendPlans = payload.plans && typeof payload.plans === "object" && Object.keys(payload.plans).length > 0;
    const hasBackendPlansByWeek = payload.plansByWeek && typeof payload.plansByWeek === "object" && Object.keys(payload.plansByWeek).length > 0;
    const hasBackendActivePlanSource = typeof payload.activePlanSource === "string" && payload.activePlanSource;
    const hasBackendSelectedWeekStart = typeof payload.selectedWeekStart === "string" && payload.selectedWeekStart;

    if (hasBackendWorkouts) {
      state.workouts = payload.workouts.sort((a, b) => new Date(b.date) - new Date(a.date));
      saveJson(STORAGE_KEY, state.workouts);
    }
    if (hasBackendProfile) {
      state.profile = { ...state.profile, ...payload.profile };
      saveJson(PROFILE_KEY, state.profile);
    }
    if (hasBackendPlans) {
      state.plans = { ...state.plans, ...payload.plans };
      saveJson(PLANS_KEY, state.plans);
    }
    if (hasBackendPlansByWeek) {
      state.plansByWeek = { ...state.plansByWeek, ...payload.plansByWeek };
      saveJson(PLANS_BY_WEEK_KEY, state.plansByWeek);
    }
    if (hasBackendActivePlanSource) {
      state.activePlanSource = payload.activePlanSource;
      saveJson(ACTIVE_PLAN_SOURCE_KEY, state.activePlanSource);
    }
    if (hasBackendSelectedWeekStart) {
      state.selectedWeekStart = payload.selectedWeekStart;
      saveJson(SELECTED_WEEK_KEY, state.selectedWeekStart);
    }

    if (
      (!hasBackendWorkouts && state.workouts.length) ||
      (!hasBackendProfile && state.profile) ||
      (!hasBackendPlans && Object.keys(state.plans || {}).length) ||
      (!hasBackendPlansByWeek && Object.keys(state.plansByWeek || {}).length) ||
      (!hasBackendActivePlanSource && state.activePlanSource) ||
      (!hasBackendSelectedWeekStart && state.selectedWeekStart)
    ) {
      saveBackendState();
    }
  } catch {
    // Browser storage remains the offline fallback when backend is unavailable.
  }
}

async function syncWorkoutFolderChanges(options = {}) {
  const accepted = await autoImportKnownWorkoutFiles();
  if (!accepted) return 0;

  await enrichKnownCsvWorkouts();
  if (options.render !== false) {
    autoAdjustActiveLocalPlanIfNeeded();
    renderAll();
    restoreCurrentPlanOrGenerate();
  }
  return accepted;
}

async function autoImportKnownWorkoutFiles() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/workout-files`);
    if (!response.ok) return 0;
    const payload = await response.json();
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!files.length) return 0;

    const csvStems = new Set(files.filter((file) => file.type === "csv").map((file) => fileStem(file.name)));
    const importedNames = importedWorkoutFileNames();
    const importable = files
      .filter((file) => file.type !== "tcx" || !csvStems.has(fileStem(file.name)))
      .filter((file) => !importedNames.has(String(file.name || "").toLowerCase()))
      .sort((a, b) => importPriority(a.type) - importPriority(b.type) || a.name.localeCompare(b.name));
    if (!importable.length) return 0;

    const results = [];
    let accepted = 0;
    for (const file of importable) {
      try {
        const fileResponse = await fetch(`${API_BASE_URL}${file.url}`);
        if (!fileResponse.ok) continue;
        const parsed = parseWorkoutFile(file.name, await fileResponse.text());
        const summary = addWorkouts(parsed, false);
        accepted += summary.accepted;
        if (summary.accepted > 0) {
          results.push(`Автоимпорт: ${file.name} (${summary.accepted})`);
        }
      } catch {
        // Ignore individual files; manual import can still show a detailed error.
      }
    }

    if (accepted > 0) {
      persistWorkouts();
      importLog.innerHTML = results.map((line) => `<div class="log-line">${escapeHtml(line)}</div>`).join("");
    }
    return accepted;
  } catch {
    // Auto scan works only when the local backend is running.
    return 0;
  }
}

function importPriority(type) {
  return { csv: 1, json: 2, gpx: 3, tcx: 4 }[type] || 9;
}

function fileStem(name) {
  return String(name || "").replace(/\.[^.]+$/, "").toLowerCase();
}

function importedWorkoutFileNames() {
  return new Set(
    state.workouts
      .map((workout) => fileNameFromSource(workout.source))
      .filter(Boolean)
      .map((name) => name.toLowerCase())
  );
}

async function enrichKnownCsvWorkouts() {
  const candidates = state.workouts.filter(needsWorkoutEnrichment);
  if (!candidates.length) return;

  const parsedBySource = new Map();
  let changed = false;

  for (const workout of candidates) {
    const sourceName = fileNameFromSource(workout.source);
    if (!sourceName || !sourceName.toLowerCase().endsWith(".csv")) continue;

    if (!parsedBySource.has(sourceName)) {
      parsedBySource.set(sourceName, await fetchKnownCsvWorkouts(sourceName));
    }

    const parsedWorkouts = parsedBySource.get(sourceName);
    let parsed = findMatchingParsedWorkout(parsedWorkouts, workout);
    if (sourceName.toLowerCase().endsWith(".csv")) {
      const tcxSourceName = sourceName.replace(/\.csv$/i, ".TCX");
      if (!parsedBySource.has(tcxSourceName)) {
        parsedBySource.set(tcxSourceName, await fetchKnownTcxWorkouts(tcxSourceName));
      }
      const tcxParsed = findMatchingParsedWorkout(parsedBySource.get(tcxSourceName), workout);
      if (tcxParsed) parsed = { ...(parsed || {}), lapSignals: tcxParsed.lapSignals, maxSpeed: parsed?.maxSpeed || tcxParsed.maxSpeed };
    }
    if (!parsed) continue;

    const enriched = mergeWorkoutEnrichment(workout, parsed);
    if (enriched !== workout) {
      Object.assign(workout, enriched);
      changed = true;
    }
  }

  if (changed) {
    state.workouts.sort((a, b) => new Date(b.date) - new Date(a.date));
    persistWorkouts();
  }
}

function needsWorkoutEnrichment(workout) {
  return Boolean(
      workout &&
      workout.source &&
      (!workout.intervalSignals || !workout.lapSignals || !workout.avgSpeed || !workout.maxSpeed || !workout.loadSource || !workout.workoutType)
  );
}

async function fetchKnownCsvWorkouts(sourceName) {
  try {
    const url = `${API_BASE_URL}/Workouts/CSV/${encodeURIComponent(sourceName)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return parseCsv(await response.text(), sourceName);
  } catch {
    return null;
  }
}

async function fetchKnownTcxWorkouts(sourceName) {
  try {
    const url = `${API_BASE_URL}/Workouts/TCX/${encodeURIComponent(sourceName)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return parseTcx(await response.text(), sourceName);
  } catch {
    return null;
  }
}

function findMatchingParsedWorkout(parsedWorkouts, workout) {
  if (!Array.isArray(parsedWorkouts) || !parsedWorkouts.length) return null;
  const workoutTime = new Date(workout.date).getTime();
  return (
    parsedWorkouts.find((parsed) => parsed.id === workout.id) ||
    parsedWorkouts.find((parsed) => {
      const parsedTime = new Date(parsed.date).getTime();
      const sameStart = Number.isFinite(workoutTime) && Number.isFinite(parsedTime) && Math.abs(parsedTime - workoutTime) < 60000;
      const sameDuration = Math.abs((Number(parsed.durationMin) || 0) - (Number(workout.durationMin) || 0)) <= 1;
      return sameStart && sameDuration;
    }) ||
    (parsedWorkouts.length === 1 ? parsedWorkouts[0] : null)
  );
}

function mergeWorkoutEnrichment(workout, parsed) {
  let changed = false;
  const enriched = { ...workout };

  for (const key of ["avgSpeed", "maxSpeed", "intervalSignals", "lapSignals", "hrMax", "hrRest"]) {
    if (!enriched[key] && parsed[key]) {
      enriched[key] = parsed[key];
      changed = true;
    }
  }

  if (parsed.load && (!enriched.loadSource || parsed.loadSource === "imported")) {
    enriched.load = parsed.load;
    enriched.loadSource = parsed.loadSource || "trimp";
    changed = true;
  }

  const trimp = estimateTrimp(
    Number(enriched.durationMin) || 0,
    Number(enriched.avgHr) || 0,
    numberOrNull(enriched.hrMax) || state.profile.maxHr || 185,
    numberOrNull(enriched.hrRest) || state.profile.restHr || 50
  );
  if (enriched.loadSource !== "imported" && trimp && Math.round(trimp) !== enriched.load) {
    enriched.load = Math.round(trimp);
    enriched.loadSource = "trimp";
    changed = true;
  }

  if (!enriched.paceMinPerKm && parsed.paceMinPerKm) {
    enriched.paceMinPerKm = parsed.paceMinPerKm;
    enriched.pace = parsed.pace;
    enriched.paceSource = parsed.paceSource;
    changed = true;
  }

  const workoutType = classifyWorkout(enriched);
  if (enriched.workoutType !== workoutType) {
    enriched.workoutType = workoutType;
    changed = true;
  }

  return changed ? enriched : workout;
}

function fileNameFromSource(source) {
  return String(source || "").split(/[\\/]/).pop();
}

async function saveBackendState() {
  try {
    await fetch(`${API_BASE_URL}/api/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workouts: state.workouts,
        profile: state.profile,
        plans: state.plans,
        plansByWeek: state.plansByWeek,
        activePlanSource: state.activePlanSource,
        selectedWeekStart: state.selectedWeekStart,
      }),
    });
  } catch {
    // Keep localStorage as a fallback if backend is unavailable.
  }
}

function sumLoad(days) {
  return sumLoadRange(0, days);
}

function buildPeriodSummary(days) {
  const workouts = workoutsForLastDays(days);
  const totalLoad = workouts.reduce((sum, workout) => sum + workout.load, 0);
  const totalDistance = workouts.reduce((sum, workout) => sum + (Number(workout.distanceKm) || 0), 0);
  const weightedPace = weightedAveragePace(workouts);

  return {
    days,
    workouts,
    count: workouts.length,
    totalLoad,
    avgDistanceKm: workouts.length ? totalDistance / workouts.length : 0,
    avgLoad: workouts.length ? totalLoad / workouts.length : 0,
    avgPaceMinPerKm: weightedPace,
  };
}

function workoutsForLastDays(days) {
  const now = Date.now();
  const from = now - days * 864e5;
  return state.workouts.filter((workout) => new Date(workout.date).getTime() >= from);
}

function weightedAveragePace(workouts) {
  const samples = workouts
    .map((workout) => ({
      pace: trustedPace(workout),
      distance: Number(workout.distanceKm) || 0,
    }))
    .filter((sample) => sample.pace && sample.distance > 0);

  const totalDistance = samples.reduce((sum, sample) => sum + sample.distance, 0);
  if (!totalDistance) return null;
  const totalPaceDistance = samples.reduce((sum, sample) => sum + sample.pace * sample.distance, 0);
  return totalPaceDistance / totalDistance;
}

function formatPeriodSummary(summary) {
  if (!summary.count) return "нет тренировок";
  return `${formatCount(summary.count)} · ${round(summary.avgDistanceKm, 1)} км/тр · ${formatPace(summary.avgPaceMinPerKm)} · ${Math.round(summary.avgLoad)} TRIMP/тр`;
}

function countWorkouts(days) {
  const now = Date.now();
  const from = now - days * 864e5;
  return state.workouts.filter((workout) => new Date(workout.date).getTime() >= from).length;
}

function sumLoadRange(fromDaysAgo, toDaysAgo) {
  const now = Date.now();
  const from = now - toDaysAgo * 864e5;
  const to = now - fromDaysAgo * 864e5;
  return state.workouts
    .filter((workout) => {
      const time = new Date(workout.date).getTime();
      return time >= from && time <= to;
    })
    .reduce((sum, workout) => sum + workout.load, 0);
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML поврежден");
  return doc;
}

function calculateGpxDistance(points) {
  let meters = 0;
  for (let index = 1; index < points.length; index += 1) {
    meters += haversine(points[index - 1], points[index]);
  }
  return round(meters / 1000, 2);
}

function haversine(a, b) {
  const radius = 6371000;
  const lat1 = toRad(Number(a.getAttribute("lat")));
  const lat2 = toRad(Number(b.getAttribute("lat")));
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.getAttribute("lon")) - Number(a.getAttribute("lon")));
  const value =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function detectCsvDelimiter(headerLine) {
  return [",", ";", "\t"]
    .map((delimiter) => ({ delimiter, columns: splitCsvLine(headerLine, delimiter).length }))
    .sort((a, b) => b.columns - a.columns)[0].delimiter;
}

function splitCsvLine(line, delimiter = ",") {
  const result = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      result.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  result.push(value.trim());
  return result;
}

function looksLikeCsvHeader(values) {
  const normalized = values.map(normalizeHeader);
  const headerWords = ["date", "duration", "time", "hr (bpm)", "pace (min/km)", "speed (km/h)", "sample rate"];
  return normalized.filter((value) => headerWords.includes(value)).length >= 2;
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pick(row, keys) {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    if (row[normalizedKey] !== undefined && row[normalizedKey] !== "") return row[normalizedKey];
  }
  return null;
}

function dateFromCsvRow(row) {
  const date = pick(row, ["date", "start date", "дата"]);
  const time = pick(row, ["start time", "start_time", "time", "время"]);
  if (date && time && !String(date).includes(":")) return `${date} ${time}`;
  return date || time;
}

function analyzeTcxLaps(laps) {
  const lapRows = laps
    .map((lap) => {
      const duration = numberOrNull(textOf(lap, "TotalTimeSeconds")) || 0;
      const distance = numberOrNull(textOf(lap, "DistanceMeters")) || 0;
      const trigger = textOf(lap, "TriggerMethod") || "";
      const speed = duration && distance ? (distance / duration) * 3.6 : null;
      return { duration, distance, trigger, speed };
    })
    .filter((lap) => lap.duration > 0 || lap.distance > 0);

  if (!lapRows.length) return null;

  const manualLaps = lapRows.filter((lap) => lap.trigger.toLowerCase() === "manual");
  const distanceLaps = lapRows.filter((lap) => lap.trigger.toLowerCase() === "distance");
  const manualRatio = manualLaps.length / lapRows.length;
  const speeds = lapRows.map((lap) => lap.speed).filter(Boolean);
  const speedRange = speeds.length >= 2 ? percentile(speeds, 0.85) - percentile(speeds, 0.2) : 0;
  const shortManualLaps = manualLaps.filter((lap) => lap.duration >= 45 && lap.duration <= 420 && lap.distance >= 150 && lap.distance <= 1600);
  const longManualLaps = manualLaps.filter((lap) => lap.duration >= 600 || lap.distance >= 2500);
  const hasAutoDistanceOnly = distanceLaps.length >= Math.max(3, lapRows.length * 0.8) && manualLaps.length === 0;
  const hasManualStructure = manualLaps.length >= 2 && manualRatio >= 0.5;
  const hasIntervalLaps = hasManualStructure && manualLaps.length >= 6 && shortManualLaps.length >= 4 && speedRange >= 1.2;
  const hasTempoLaps = hasManualStructure && !hasIntervalLaps;

  return {
    lapCount: lapRows.length,
    manualCount: manualLaps.length,
    distanceCount: distanceLaps.length,
    manualRatio: round(manualRatio, 2),
    shortManualCount: shortManualLaps.length,
    longManualCount: longManualLaps.length,
    speedRange: round(speedRange, 2),
    hasAutoDistanceOnly,
    hasIntervalLaps,
    hasTempoLaps,
  };
}

function analyzeCsvSamples(lines, delimiter) {
  if (lines.length < 10) return null;

  const headers = splitCsvLine(lines[0], delimiter).map(normalizeHeader);
  const points = lines
    .slice(1)
    .map((line) => {
      const values = splitCsvLine(line, delimiter);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
      return {
        seconds: secondsFromAny(pick(row, ["time", "время"])),
        speed: numberOrNull(pick(row, ["speed", "speed (km/h)", "скорость"])),
        hr: numberOrNull(pick(row, ["hr", "hr (bpm)", "heart rate", "пульс"])),
      };
    })
    .filter((point) => Number.isFinite(point.seconds) && point.speed && point.speed > 3);

  if (points.length < 30) return null;

  const buckets = buildSampleBuckets(points, 30);
  const speeds = buckets.map((bucket) => bucket.speed).filter((speed) => speed > 3);
  const hrs = buckets.map((bucket) => bucket.hr).filter(Boolean);
  if (speeds.length < 6) return null;

  const avgSpeed = average(speeds);
  const maxSpeed = Math.max(...speeds);
  const p20 = percentile(speeds, 0.2);
  const p50 = percentile(speeds, 0.5);
  const p85 = percentile(speeds, 0.85);
  const highThreshold = Math.max(p85, avgSpeed * 1.12);
  const lowThreshold = Math.max(5, p50 * 0.92);
  const fastSegments = countSegments(buckets, (bucket) => bucket.speed >= highThreshold, 2);
  const recoverySegments = countSegments(buckets, (bucket) => bucket.speed <= lowThreshold, 2);
  const hrRange = hrs.length ? Math.max(...hrs) - Math.min(...hrs) : 0;
  const speedRange = p85 - p20;
  const speedSurgeRatio = avgSpeed ? maxSpeed / avgSpeed : 0;
  const hasIntervalPattern =
    fastSegments >= 3 &&
    recoverySegments >= 2 &&
    speedRange >= 2 &&
    (speedSurgeRatio >= 1.18 || hrRange >= 18);

  return {
    hasIntervalPattern,
    fastSegments,
    recoverySegments,
    avgSpeed: round(avgSpeed, 2),
    maxSpeed: round(maxSpeed, 2),
    speedRange: round(speedRange, 2),
    speedSurgeRatio: round(speedSurgeRatio, 2),
    hrRange: Math.round(hrRange),
  };
}

function buildSampleBuckets(points, bucketSeconds) {
  const buckets = new Map();
  for (const point of points) {
    const key = Math.floor(point.seconds / bucketSeconds);
    if (!buckets.has(key)) buckets.set(key, { speeds: [], hrs: [] });
    buckets.get(key).speeds.push(point.speed);
    if (point.hr) buckets.get(key).hrs.push(point.hr);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({
      speed: average(bucket.speeds),
      hr: bucket.hrs.length ? average(bucket.hrs) : null,
    }))
    .filter((bucket) => bucket.speed > 3);
}

function countSegments(items, predicate, minLength) {
  let count = 0;
  let current = 0;
  for (const item of items) {
    if (predicate(item)) {
      current += 1;
    } else {
      if (current >= minLength) count += 1;
      current = 0;
    }
  }
  if (current >= minLength) count += 1;
  return count;
}

function dateFromAny(value) {
  if (value instanceof Date) return value;

  const text = String(value || "").trim();
  if (!text) return null;

  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (hasTimezone) {
    const timezoneDate = new Date(text);
    if (!Number.isNaN(timezoneDate.getTime())) return timezoneDate;
  }

  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = isoMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }

  const directDate = new Date(text);
  if (!Number.isNaN(directDate.getTime())) return directDate;

  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;

  const [, day, month, rawYear, hour = "0", minute = "0", second = "0"] = match;
  const year = rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear);
  return new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function minutesFromAny(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 10000 ? Math.round(value / 60) : value;
  const text = String(value);
  if (text.includes(":")) {
    const parts = text.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 60 + parts[1] + Math.round(parts[2] / 60);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const number = numericFromText(text);
  if (!Number.isFinite(number)) return null;
  return number > 10000 ? Math.round(number / 60) : number;
}

function paceFromAny(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 0 ? round(value, 2) : null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  if (text.includes(":")) {
    const parts = text.split(":").map((part) => Number(part.replace(",", ".")));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return round(parts[0] + parts[1] / 60, 2);
    }
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return round(parts[0] * 60 + parts[1] + parts[2] / 60, 2);
    }
  }

  const number = numericFromText(text);
  return Number.isFinite(number) && number > 0 ? round(number, 2) : null;
}

function paceFromSpeed(speed) {
  const value = numberOrNull(speed);
  if (!value) return null;
  const kmh = value <= 12 ? value * 3.6 : value;
  return kmh > 0 ? round(60 / kmh, 2) : null;
}

function kmFromAny(value) {
  const number = numberOrNull(value);
  if (!number) return null;
  return number > 1000 ? round(number / 1000, 2) : number;
}

function textOf(root, selector) {
  const node = firstDescendant(root, selector);
  return node ? node.textContent.trim() : "";
}

function firstDescendant(root, localName) {
  return [...root.getElementsByTagName("*")].find((node) => node.localName === localName) || null;
}

function descendants(root, localName) {
  return [...root.getElementsByTagName("*")].filter((node) => node.localName === localName);
}

function sumNodes(nodes, selector) {
  return nodes.map((node) => Number(textOf(node, selector))).filter(Boolean).reduce((sum, value) => sum + value, 0);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maxBy(items, key) {
  return items.reduce((best, item) => (!best || Number(item[key]) > Number(best[key]) ? item : best), null);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = numericFromText(value);
  return Number.isFinite(number) ? number : null;
}

function numericFromText(value) {
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function secondsFromAny(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return value;
  const parts = String(value).trim().split(":").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  return numberOrNull(value);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatDate(date) {
  return new Date(date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDistance(distanceKm) {
  return distanceKm ? `${round(distanceKm, 2)} км` : "без дистанции";
}

function trustedPace(workout) {
  return workout.paceSource ? workout.paceMinPerKm : null;
}

function formatTrustedPace(workout) {
  return formatPace(trustedPace(workout));
}

function formatPace(paceMinPerKm) {
  if (!paceMinPerKm) return "темп неизвестен";
  const minutes = Math.floor(paceMinPerKm);
  const seconds = Math.round((paceMinPerKm - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, "0")} мин/км`;
}

function getWorkoutType(workout) {
  return classifyWorkout(workout);
}

function classifyWorkout(workout) {
  const notes = String(workout.notes || "").toLowerCase();
  const sport = String(workout.sport || "").toLowerCase();
  const duration = Number(workout.durationMin) || 0;
  const distance = Number(workout.distanceKm) || 0;
  const avgHr = Number(workout.avgHr) || 0;
  const rpe = Number(workout.rpe) || 0;
  const load = Number(workout.load) || 0;
  const avgSpeed = numberOrNull(workout.avgSpeed || workout.speed);
  const maxSpeed = numberOrNull(workout.maxSpeed);
  const intervalSignals = workout.intervalSignals || null;
  const lapSignals = workout.lapSignals || null;
  const maxHr = numberOrNull(workout.hrMax) || state.profile.maxHr || 185;
  const hrRatio = avgHr ? avgHr / maxHr : 0;
  const targetDistance = state.profile.targetDistance || "10k";
  const longMin = targetDistance === "42k" ? 100 : targetDistance === "21k" ? 85 : targetDistance === "10k" ? 70 : 60;
  const longKm = targetDistance === "21k" ? 16 : targetDistance === "10k" ? 12 : targetDistance === "5k" ? 10 : Infinity;
  const hasStrongSampleIntervals = hasStrongSampleIntervalPattern(intervalSignals, duration, longMin);

  if (matchesAny(notes, ["интервал", "interval", "повтор", "repeat", "vo2", "400", "800", "1000", "фартлек", "fartlek"])) {
    return "interval";
  }
  if (matchesAny(notes, ["темпо", "tempo", "порог", "threshold", "марафонск", "полумарафонск"])) {
    return "tempo";
  }
  if (matchesAny(notes, ["длитель", "long run", "longrun", "long"])) {
    return "long";
  }
  if (matchesAny(notes, ["восстанов", "recovery", "easy", "легко", "отдых"])) {
    return "recovery";
  }

  if (!sport.includes("run") && !sport.includes("бег") && !sport.includes("running")) {
    return "cross";
  }

  if (lapSignals?.hasIntervalLaps) return "interval";
  if (lapSignals?.hasTempoLaps) return "tempo";
  if (!lapSignals?.hasAutoDistanceOnly && hasStrongSampleIntervals) return "interval";
  if (rpe >= 8 && duration < longMin) return "interval";
  if (duration >= longMin || distance >= longKm) return "long";
  if (rpe >= 7 || hrRatio >= 0.83 || load >= duration * 2.2) return "tempo";
  if (duration <= 40 && (hrRatio && hrRatio < 0.72)) return "recovery";
  return "easy";
}

function hasStrongSampleIntervalPattern(intervalSignals, duration, longMin) {
  if (!intervalSignals?.hasIntervalPattern) return false;
  if (duration > Math.max(longMin, 100)) return false;
  if (intervalSignals.fastSegments < 4 || intervalSignals.recoverySegments < 3) return false;
  if (intervalSignals.speedRange < 2.8) return false;
  return intervalSignals.speedSurgeRatio >= 1.18 || intervalSignals.hrRange >= 25;
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function workoutTypeLabel(workout) {
  const labels = {
    interval: "интервалы",
    tempo: "темпо",
    long: "длительная",
    recovery: "восстановление",
    easy: "кросс",
    cross: "кросс-тренинг",
  };
  return labels[getWorkoutType(workout)] || "тренировка";
}

function isPlanDayCompleted(day) {
  return actualWorkoutsForPlanDay(day).length > 0;
}

function actualWorkoutsForPlanDay(day) {
  const planDate = new Date(day.date);
  if (Number.isNaN(planDate.getTime())) return [];
  return state.workouts
    .filter((workout) => sameDay(new Date(workout.date), planDate))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function formatActualWorkout(workout) {
  const parts = [
    workoutTypeLabel(workout),
    workout.durationMin ? `${workout.durationMin} мин` : "",
    formatDistance(workout.distanceKm),
    formatTrustedPace(workout),
    workout.avgHr ? `ср. пульс ${workout.avgHr}` : "",
    workout.load ? `TRIMP ${workout.load}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function getPlanDayStatus(day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const planDate = new Date(day.date);
  planDate.setHours(0, 0, 0, 0);

  if (isPlanDayCompleted(day)) return { className: "completed", label: "выполнено" };
  if (sameDay(planDate, today)) return { className: "today", label: "сегодня" };
  if (planDate > today) return { className: "upcoming", label: "предстоит" };
  return { className: "past", label: "без записи" };
}

function formatCount(count) {
  const tail = count % 10;
  if (count % 100 >= 11 && count % 100 <= 14) return `${count} тренировок`;
  if (tail === 1) return `${count} тренировка`;
  if (tail >= 2 && tail <= 4) return `${count} тренировки`;
  return `${count} тренировок`;
}

function lastDays(count) {
  return Array.from({ length: count }, (_, index) => addDays(new Date(), index - count + 1));
}

function startOfTrainingWeek(date) {
  const start = new Date(date);
  start.setHours(12, 0, 0, 0);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function startOfDay(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function weekRange(weekStart) {
  const start = startOfDay(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  importLog.innerHTML = `<div class="log-line">${escapeHtml(message)}</div>`;
}
