const STORAGE_KEY = "training-coach-workouts";
const PROFILE_KEY = "training-coach-profile";
const PLANS_KEY = "training-coach-plans";
const PLANS_BY_WEEK_KEY = "training-coach-plans-by-week";
const ACTIVE_PLAN_SOURCE_KEY = "training-coach-active-plan-source";
const SELECTED_WEEK_KEY = "training-coach-selected-week";
const CURRENT_PLAN_KEY = "training-coach-current-plan";
const PLAN_VIEW_MODE_KEY = "training-coach-plan-view-mode";
const WORKOUT_SYNC_INTERVAL_MS = 60000;
const POLAR_SYNC_INTERVAL_MS = 10 * 60000;
const API_BASE_URL = window.location.protocol === "file:" ? "http://127.0.0.1:8765" : "";
const WORKOUT_TYPE_OPTIONS = [
  ["auto", "Авто"],
  ["interval", "Интервалы"],
  ["tempo", "Темпо"],
  ["long", "Длительная"],
  ["recovery", "Восстановление"],
  ["easy", "Кросс"],
  ["cross", "Кросс-тренинг"],
];
const HR_ZONE_BOUNDARY_FIELDS = ["z1Max", "z2Max", "z3Max", "z4Max"];

const state = {
  workouts: loadJson(STORAGE_KEY, []),
  plans: loadJson(PLANS_KEY, {}),
  plansByWeek: loadJson(PLANS_BY_WEEK_KEY, {}),
  activePlanSource: loadJson(ACTIVE_PLAN_SOURCE_KEY, "json"),
  selectedWeekStart: loadJson(SELECTED_WEEK_KEY, currentWeekKey()),
  planViewMode: loadJson(PLAN_VIEW_MODE_KEY, "detailed"),
  planReview: null,
  profile: loadJson(PROFILE_KEY, {
    name: "",
    goal: "Поддержание формы",
    targetDistance: "10k",
    prepPhase: "auto",
    raceDate: "",
    raceDistance: "",
    raceName: "",
    photoDataUrl: "",
    planningMode: "normal",
    maxHr: 185,
    restHr: 50,
    hrZoneMode: "default",
    hrZoneBoundaries: [],
    daysPerWeek: 4,
    constraints: "",
  }),
};

const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const selectWorkoutFilesButton = document.querySelector("#selectWorkoutFiles");
const importLog = document.querySelector("#importLog");
const workoutList = document.querySelector("#workoutList");
const manualForm = document.querySelector("#manualForm");
const settingsForm = document.querySelector("#settingsForm");
const planJsonInput = document.querySelector("#planJsonInput");
const planEditModal = document.querySelector("#planEditModal");
const planEditForm = document.querySelector("#planEditForm");
const profilePhotoInput = document.querySelector("#profilePhotoInput");
const profilePhotoPreview = document.querySelector("#profilePhotoPreview");
const sidebarProfilePhoto = document.querySelector("#sidebarProfilePhoto");
const selectProfilePhotoButton = document.querySelector("#selectProfilePhoto");
const removeProfilePhotoButton = document.querySelector("#removeProfilePhoto");
const useDefaultHrZonesButton = document.querySelector("#useDefaultHrZones");
const polarStatus = document.querySelector("#polarStatus");
const polarHint = document.querySelector("#polarHint");
const connectPolarButton = document.querySelector("#connectPolar");
const syncPolarButton = document.querySelector("#syncPolar");

init();

async function init() {
  wireNavigation();
  wireImport();
  wirePolar();
  wireForms();
  hydrateProfile();
  showPlanLoading("Идет загрузка плана...");
  renderAll();
  await loadBackendState();
  dedupeStoredWorkouts();
  setAiStatus("Идет проверка новых тренировок...", "");
  await syncWorkoutFolderChanges({ render: false });
  await refreshPolarStatus();
  await syncPolarWorkouts({ automatic: true, render: false });
  setAiStatus("Идет уточнение данных тренировок...", "");
  await enrichKnownCsvWorkouts();
  hydrateProfile();
  renderAll();
  restoreCurrentPlanOrGenerate();
  setInterval(() => syncWorkoutFolderChanges(), WORKOUT_SYNC_INTERVAL_MS);
  setInterval(() => syncPolarWorkouts({ automatic: true }), POLAR_SYNC_INTERVAL_MS);
}

function dedupeStoredWorkouts() {
  const before = state.workouts.length;
  state.workouts = dedupeWorkouts(state.workouts).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (state.workouts.length !== before) {
    persistWorkouts();
  }
}

function wireNavigation() {
  navItems.forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.view));
  });

  workoutList?.addEventListener("change", handleWorkoutTypeChange);
  document.querySelector("#openImport").addEventListener("click", () => showView("import"));
  document.querySelector("#generatePlan").addEventListener("click", selectLocalPlan);
  document.querySelector("#adjustPlan").addEventListener("click", adjustDisplayedPlan);
  document.querySelector("#adjustLocalPlan").addEventListener("click", adjustPlanLocally);
  document.querySelector("#adjustJsonPlan").addEventListener("click", reloadJsonPlan);
  document.querySelector("#reviewAiPlan").addEventListener("click", reviewCurrentPlanWithAi);
  document.querySelector("#generateAiPlan").addEventListener("click", selectAiPlan);
  document.querySelector("#loadPlanJson").addEventListener("click", selectJsonPlan);
  document.querySelector("#togglePlanDensity").addEventListener("click", togglePlanDensity);
  document.querySelector("#previousWeek").addEventListener("click", () => changeSelectedWeek(-7));
  document.querySelector("#nextWeek").addEventListener("click", () => changeSelectedWeek(7));
  document.querySelector("#currentWeek").addEventListener("click", () => selectWeek(currentWeekKey()));
  planJsonInput.addEventListener("change", handlePlanJsonFile);
  document.querySelector("#exportPlanJson")?.addEventListener("click", exportCurrentPlanJson);
  document.querySelector("#copyPrompt").addEventListener("click", copyPrompt);
  document.querySelector("#clearData").addEventListener("click", clearWorkouts);
  document.querySelector("#planGrid")?.addEventListener("click", handlePlanGridClick);
  document.querySelector("#cancelPlanEdit")?.addEventListener("click", closePlanEditModal);
  planEditModal?.addEventListener("click", (event) => {
    if (event.target === planEditModal) closePlanEditModal();
  });
  planEditForm?.addEventListener("submit", saveEditedPlanDay);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !planEditModal?.hidden) closePlanEditModal();
  });
}

function wireImport() {
  fileInput.addEventListener("change", (event) => handleFiles([...event.target.files]));
  selectWorkoutFilesButton.addEventListener("click", () => fileInput.click());

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

function wirePolar() {
  if (!connectPolarButton || !syncPolarButton) return;
  connectPolarButton.addEventListener("click", () => {
    window.location.href = `${API_BASE_URL}/api/polar/connect`;
  });
  syncPolarButton.addEventListener("click", () => syncPolarWorkouts({ automatic: false }));
}

function wireForms() {
  const today = new Date().toISOString().slice(0, 10);
  manualForm.elements.date.value = today;
  selectProfilePhotoButton.addEventListener("click", () => profilePhotoInput.click());
  removeProfilePhotoButton.addEventListener("click", () => {
    state.profile.photoDataUrl = "";
    profilePhotoInput.value = "";
    renderProfilePhoto();
  });
  profilePhotoInput.addEventListener("change", handleProfilePhotoFile);
  settingsForm.elements.hrZoneMode?.addEventListener("change", updateHrZoneInputsMode);
  settingsForm.elements.maxHr?.addEventListener("input", updateDefaultHrZoneInputs);
  settingsForm.elements.restHr?.addEventListener("input", updateDefaultHrZoneInputs);
  useDefaultHrZonesButton?.addEventListener("click", () => {
    settingsForm.elements.hrZoneMode.value = "default";
    fillHrZoneBoundaryInputs(defaultHrZoneBoundaries(profileValuesFromSettingsForm()));
    updateHrZoneInputsMode();
  });

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
    const hrZones = hrZoneSettingsFromForm(data);
    state.profile = {
      name: data.get("name").trim(),
      goal: data.get("goal"),
      targetDistance: data.get("targetDistance") || "10k",
      prepPhase: data.get("prepPhase") || "auto",
      raceDate: data.get("raceDate") || "",
      raceDistance: data.get("raceDistance") || "",
      raceName: data.get("raceName").trim(),
      photoDataUrl: state.profile.photoDataUrl || "",
      planningMode: data.get("planningMode") || "normal",
      maxHr: Number(data.get("maxHr")) || 185,
      restHr: Number(data.get("restHr")) || 50,
      hrZoneMode: hrZones.mode,
      hrZoneBoundaries: hrZones.boundaries,
      daysPerWeek: Number(data.get("daysPerWeek")) || 4,
      constraints: data.get("constraints").trim(),
    };
    saveJson(PROFILE_KEY, state.profile);
    saveBackendState();
    hydrateProfile();
    renderAll();
    generatePlan();
    showToast(data.get("hrZoneMode") === "custom" && hrZones.mode !== "custom"
      ? "Профиль сохранен, но пульсовые зоны возвращены к HRR по умолчанию: границы должны возрастать между пульсом покоя и максимумом"
      : "Профиль сохранен");
  });
}

async function handleProfilePhotoFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("Выберите файл изображения");
    profilePhotoInput.value = "";
    return;
  }

  try {
    state.profile.photoDataUrl = await resizeImageToDataUrl(file, 512);
    renderProfilePhoto();
  } catch {
    showToast("Не удалось загрузить фото");
    profilePhotoInput.value = "";
  }
}

function resizeImageToDataUrl(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function showView(viewId) {
  hideAdjustChoice();
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
  const validIncoming = workouts.filter((workout) => workout.date && workout.durationMin > 0);
  const byIncomingKey = new Map();

  for (const workout of validIncoming) {
    const key = workoutDedupKey(workout);
    const existing = byIncomingKey.get(key);
    byIncomingKey.set(key, existing ? mergeDuplicateWorkouts(existing, workout) : workout);
  }

  const uniqueIncoming = [...byIncomingKey.values()];
  const skipped = workouts.length - validIncoming.length;
  const duplicateRows = validIncoming.length - uniqueIncoming.length;
  const existingKeys = new Set(state.workouts.map(workoutDedupKey));
  const duplicates = duplicateRows + uniqueIncoming.filter((workout) => existingKeys.has(workoutDedupKey(workout))).length;
  const accepted = uniqueIncoming.filter((workout) => !existingKeys.has(workoutDedupKey(workout))).length;
  const merged = [...state.workouts, ...uniqueIncoming].filter((workout) => workout.date && workout.durationMin);
  state.workouts = dedupeWorkouts(merged).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (shouldPersist) {
    persistWorkouts();
    autoAdjustActiveLocalPlanIfNeeded();
    renderAll();
    restoreCurrentPlanOrGenerate();
  }
  return { accepted, skipped, duplicates, parsed: workouts.length };
}

function dedupeWorkouts(workouts) {
  const byKey = new Map();
  for (const workout of workouts) {
    const key = workoutDedupKey(workout);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeDuplicateWorkouts(existing, workout) : workout);
  }
  return [...byKey.values()];
}

function workoutDedupKey(workout) {
  const polarId = polarExerciseIdFromSource(workout?.source);
  if (polarId) return `polar-${polarId}`;
  const date = dateFromAny(workout?.date);
  const dateKey = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 16) : "";
  const sportKey = normalizedSportKey(workout?.sport);
  const durationKey = Math.round(Number(workout?.durationMin) || 0);
  const distanceKey = round(Number(workout?.distanceKm) || 0, 2).toFixed(2);
  return `${dateKey}-${sportKey}-${durationKey}-${distanceKey}`;
}

function polarExerciseIdFromSource(source) {
  const value = String(source || "").trim();
  const directMatch = value.match(/^Polar:([^/\\]+)$/i);
  if (directMatch) return directMatch[1].toLowerCase();
  const fileName = fileNameFromSource(value);
  const fileMatch = fileName.match(/^Polar_.+_([A-Za-z0-9-]+)\.TCX$/i);
  return fileMatch ? fileMatch[1].toLowerCase() : "";
}

function normalizedSportKey(sport) {
  const value = String(sport || "").trim().toLowerCase();
  if (value.includes("run") || value.includes("бег")) return "running";
  return value || "unknown";
}

function isRunningWorkout(workout) {
  return normalizedSportKey(workout?.sport) === "running";
}

function isGenericSport(sport) {
  return ["", "other", "polar", "unknown"].includes(String(sport || "").trim().toLowerCase());
}

function mergeDuplicateWorkouts(a, b) {
  const useB = workoutRichnessScore(b) > workoutRichnessScore(a);
  const base = { ...(useB ? b : a) };
  const other = useB ? a : b;
  if (isGenericSport(base.sport) && other.sport) {
    base.sport = other.sport;
  }
  for (const key of ["intervalSignals", "lapSignals", "avgSpeed", "maxSpeed", "hrMax", "hrRest"]) {
    if (!base[key] && other[key]) base[key] = other[key];
  }
  if (!base.paceSource && other.paceSource) {
    base.paceMinPerKm = other.paceMinPerKm;
    base.pace = other.pace;
    base.paceSource = other.paceSource;
  }
  if ((!base.loadSource || base.loadSource === "duration") && other.loadSource && other.loadSource !== "duration") {
    base.load = other.load;
    base.loadSource = other.loadSource;
  }
  if (!base.workoutTypeOverride && other.workoutTypeOverride) {
    base.workoutTypeOverride = other.workoutTypeOverride;
  }
  base.workoutType = classifyWorkout(base);
  return base;
}

function workoutRichnessScore(workout) {
  return [
    String(workout?.source || "").toLowerCase().endsWith(".csv") ? 4 : 0,
    workout?.intervalSignals ? 3 : 0,
    workout?.lapSignals ? 2 : 0,
    workout?.paceSource ? 1 : 0,
    workout?.loadSource === "imported" ? 2 : 0,
  ].reduce((sum, value) => sum + value, 0);
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
  const paceFromImportedDistance = paceFromDistanceDuration(distanceKm, durationMin);
  const paceFromImportedSpeed = paceFromSpeed(avgSpeed);
  const paceMinPerKm = input.paceMinPerKm || paceFromImportedDistance || paceFromImportedSpeed || null;
  const paceSource = input.paceMinPerKm ? "imported" : paceFromImportedDistance ? "distance-duration" : paceFromImportedSpeed ? "speed" : "";
  const isoDate = date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
  const sport = String(input.sport || "Другое").trim();
  return {
    id: `${isoDate.slice(0, 16)}-${normalizedSportKey(sport)}-${durationMin}-${distanceKm}`,
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
    workoutTypeOverride: validWorkoutType(input.workoutTypeOverride) ? input.workoutTypeOverride : "",
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
  renderGoalCenter();
  renderTodayPlan();
  renderWorkouts();
  renderBars();
  renderWeekComparison();
  renderProfileHrZones();
  renderWorkoutTemplateLibrary();
  renderPlanWeekLabel();
  updatePlanDensityUi();
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

function renderGoalCenter() {
  const container = document.querySelector("#goalCenter");
  if (!container) return;

  const target = getTargetDistanceProfile();
  const phase = getPreparationPhase(selectedWeekStartDate());
  const planningMode = getPlanningModeProfile();
  const race = getRaceSummary();
  const readiness = getReadiness();
  const raceLine = race
    ? `${race.name} · ${race.distanceLabel} · ${race.dateLabel}${race.daysUntil >= 0 ? ` · через ${race.daysUntil} дн.` : " · старт уже прошел"}`
    : "гонка не указана";
  const constraints = state.profile.constraints?.trim() || "без дополнительных ограничений";

  container.innerHTML = `
    <div class="panel-head compact-head">
      <div>
        <h2>Цель и этап</h2>
        <span>контекст, с которым строится план</span>
      </div>
    </div>
    <div class="goal-grid">
      <div class="goal-main">
        <span class="section-label">Цель</span>
        <strong>${escapeHtml(state.profile.goal || "Поддержание формы")} · ${escapeHtml(target.label)}</strong>
        <p>${escapeHtml(raceLine)}</p>
      </div>
      <div>
        <span class="section-label">Этап</span>
        <strong>${escapeHtml(phase.label)}</strong>
        <p>${escapeHtml(phase.description)}</p>
      </div>
      <div>
        <span class="section-label">Режим</span>
        <strong>${escapeHtml(planningMode.label)} · ${Number(state.profile.daysPerWeek) || 4} дн./нед. · ${escapeHtml(readiness.label)}</strong>
        <p>${escapeHtml(planningMode.description)} ${escapeHtml(constraints)}</p>
      </div>
    </div>
    ${renderHeartRateZoneStrip()}
  `;
}

function renderHeartRateZoneStrip() {
  const zones = heartRateZonesBpm();
  if (!zones.length) {
    return `
      <div class="hr-zone-strip muted">
        <span class="section-label">Пульсовые зоны</span>
        <p>Укажите корректные максимальный пульс и пульс покоя в профиле.</p>
      </div>
    `;
  }

  return `
    <div class="hr-zone-strip">
      <span class="section-label">Пульсовые зоны HRR</span>
      <div class="hr-zone-grid">
        ${zones.map((zone) => `
          <div class="hr-zone ${zone.className}">
            <strong>${zone.label}</strong>
            <span>${zone.range}</span>
            <small>${zone.note}</small>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderProfileHrZones() {
  const container = document.querySelector("#profileHrZones");
  if (!container) return;
  const modeLabel = state.profile.hrZoneMode === "custom" ? "свои границы" : "по умолчанию HRR";
  container.innerHTML = `
    <div class="panel-head compact-head">
      <div>
        <h2>Пульсовые зоны</h2>
        <span>${modeLabel}: пульс покоя ${Number(state.profile.restHr) || 0}, максимум ${Number(state.profile.maxHr) || 0}</span>
      </div>
    </div>
    ${renderHeartRateZoneStrip()}
  `;
}

function renderWorkoutTemplateLibrary() {
  const container = document.querySelector("#templateLibrary");
  if (!container) return;
  const templates = workoutTemplateLibrary();
  container.innerHTML = templates
    .map((template) => `
      <article class="template-item ${template.toneClass}">
        <div>
          <span class="section-label">${escapeHtml(template.type)}</span>
          <strong>${escapeHtml(template.name)}</strong>
        </div>
        <p>${escapeHtml(template.structure)}</p>
        <small>${escapeHtml(template.useWhen)}</small>
        <small>${escapeHtml(template.constraints)}</small>
        <div class="template-tags">
          ${template.targets.map((target) => `<span>${escapeHtml(target)}</span>`).join("")}
          ${template.phases.map((phase) => `<span>${escapeHtml(phase)}</span>`).join("")}
        </div>
      </article>
    `)
    .join("");
}

function renderTodayPlan() {
  const container = document.querySelector("#todayPlanPanel");
  if (!container) return;

  const today = startOfDay(new Date());
  const weekStart = startOfTrainingWeek(today);
  const weekKey = toDateInputValue(weekStart);
  const savedPlan = storedPlanForWeekKey(weekKey);
  const planDays = savedPlan?.days || buildPlan(weekStart);
  const day = planDays.find((item) => sameDay(new Date(item.date), today));
  container.className = "panel today-plan-panel";
  if (!day) {
    container.innerHTML = `
      <div class="panel-head compact-head">
        <div>
          <h2>Сегодня</h2>
          <span>${formatDate(today)}</span>
        </div>
      </div>
      <div class="empty">На сегодня нет задания.</div>
    `;
    return;
  }

  const status = getPlanDayStatus(day);
  const execution = evaluatePlanDayExecution(day);
  const planned = day.plannedWorkout || day.details || "Задание не описано.";
  const actual = actualWorkoutsForPlanDay(day).map(formatActualWorkout);
  const sourceLabel = savedPlan ? planSourceLabel(savedPlan.source) : "локальный черновик";
  const meta = [
    day.targetDistance ? `Ориентир: ${day.targetDistance}` : "",
    day.intensity ? `Интенсивность: ${day.intensity}` : "",
    day.load ? `Плановая нагрузка: ${day.load}` : "",
  ].filter(Boolean);

  container.className = `panel today-plan-panel eval-${execution.level} ${planToneClass(day)}`;
  container.innerHTML = `
    <div class="panel-head compact-head">
      <div>
        <h2>Сегодня</h2>
        <span>${formatDate(today)} · ${escapeHtml(sourceLabel)}</span>
      </div>
      <span class="today-status ${execution.level}">${escapeHtml(status.label)}</span>
    </div>
    <div class="today-plan-grid">
      <div class="today-assignment">
        <span class="section-label">${escapeHtml(day.focus || "Задание")}</span>
        <strong>${escapeHtml(day.title || "Тренировка")}</strong>
        <p>${escapeHtml(planned)}</p>
        ${meta.length ? `<small>${escapeHtml(meta.join(" · "))}</small>` : ""}
      </div>
      <div class="today-fact">
        <span class="section-label">Факт и оценка</span>
        ${actual.length ? `<p>${actual.map((line) => escapeHtml(line)).join("<br>")}</p>` : "<p>Факт пока не найден среди импортированных тренировок.</p>"}
        ${execution.show ? `<strong class="${execution.level}">${escapeHtml(execution.label)}</strong><small>${escapeHtml(execution.comment)}</small>` : ""}
      </div>
    </div>
  `;
}

function heartRateZonesBpm(profile = state.profile) {
  const restHr = Number(profile?.restHr) || 0;
  const maxHr = Number(profile?.maxHr) || 0;
  if (!restHr || !maxHr || maxHr <= restHr) return [];

  const boundaries = effectiveHrZoneBoundaries(profile);
  if (!boundaries.length) return [];
  return [
    { label: "Z1", range: `до ${boundaries[0]} уд/мин`, note: "восстановление", className: "zone-z1" },
    { label: "Z2", range: `${boundaries[0]}-${boundaries[1]} уд/мин`, note: "легко", className: "zone-z2" },
    { label: "Z3", range: `${boundaries[1]}-${boundaries[2]} уд/мин`, note: "умеренно", className: "zone-z3" },
    { label: "Z4", range: `${boundaries[2]}-${boundaries[3]} уд/мин`, note: "порог", className: "zone-z4" },
    { label: "Z5", range: `от ${boundaries[3]} уд/мин`, note: "VO2max", className: "zone-z5" },
  ];
}

function effectiveHrZoneBoundaries(profile = state.profile) {
  const restHr = Number(profile?.restHr) || 0;
  const maxHr = Number(profile?.maxHr) || 0;
  if (!restHr || !maxHr || maxHr <= restHr) return [];
  const custom = normalizeCustomHrZoneBoundaries(profile?.hrZoneBoundaries, restHr, maxHr);
  if (profile?.hrZoneMode === "custom" && custom) return custom;
  return defaultHrZoneBoundaries(profile);
}

function defaultHrZoneBoundaries(profile = state.profile) {
  const restHr = Number(profile?.restHr) || 0;
  const maxHr = Number(profile?.maxHr) || 0;
  if (!restHr || !maxHr || maxHr <= restHr) return [];
  return [0.6, 0.7, 0.8, 0.9].map((ratio) => Math.round(restHr + (maxHr - restHr) * ratio));
}

function normalizeCustomHrZoneBoundaries(boundaries, restHr, maxHr) {
  if (!Array.isArray(boundaries) || boundaries.length !== 4) return null;
  const values = boundaries.map((value) => Number(value)).filter(Number.isFinite);
  if (values.length !== 4) return null;
  if (values[0] <= restHr || values[3] >= maxHr) return null;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) return null;
  }
  return values.map(Math.round);
}

function profileValuesFromSettingsForm() {
  return {
    maxHr: Number(settingsForm.elements.maxHr?.value) || state.profile.maxHr || 185,
    restHr: Number(settingsForm.elements.restHr?.value) || state.profile.restHr || 50,
  };
}

function fillHrZoneBoundaryInputs(boundaries) {
  HR_ZONE_BOUNDARY_FIELDS.forEach((field, index) => {
    if (settingsForm.elements[field]) {
      settingsForm.elements[field].value = boundaries[index] || "";
    }
  });
}

function updateDefaultHrZoneInputs() {
  if (settingsForm.elements.hrZoneMode?.value !== "default") return;
  fillHrZoneBoundaryInputs(defaultHrZoneBoundaries(profileValuesFromSettingsForm()));
}

function updateHrZoneInputsMode() {
  const custom = settingsForm.elements.hrZoneMode?.value === "custom";
  if (!custom) updateDefaultHrZoneInputs();
  HR_ZONE_BOUNDARY_FIELDS.forEach((field) => {
    if (settingsForm.elements[field]) settingsForm.elements[field].disabled = !custom;
  });
}

function hrZoneSettingsFromForm(data) {
  const mode = data.get("hrZoneMode") === "custom" ? "custom" : "default";
  const values = HR_ZONE_BOUNDARY_FIELDS.map((field) => Number(data.get(field)));
  const { restHr, maxHr } = profileValuesFromSettingsForm();
  const normalized = normalizeCustomHrZoneBoundaries(values, restHr, maxHr);
  return {
    mode: mode === "custom" && normalized ? "custom" : "default",
    boundaries: mode === "custom" && normalized ? normalized : [],
  };
}

function renderWorkouts() {
  const list = workoutList;
  if (!state.workouts.length) {
    list.innerHTML = `<div class="empty">История пуста</div>`;
    return;
  }

  list.innerHTML = state.workouts
    .slice(0, 12)
    .map(
      (workout) => `
        <article class="workout-row" data-workout-key="${escapeHtml(workoutDedupKey(workout))}">
          <div>
            <strong>${escapeHtml(workout.sport)} · ${escapeHtml(workoutTypeLabel(workout))}</strong>
            <span>${formatDate(workout.date)} · ${workout.durationMin} мин · ${formatDistance(workout.distanceKm)} · ${formatTrustedPace(workout)}</span>
            ${workout.workoutTypeOverride ? `<em>тип задан вручную</em>` : ""}
            <label class="workout-type-control">
              Тип
              <select data-workout-type-select>
                ${renderWorkoutTypeOptions(workout)}
              </select>
            </label>
          </div>
          <small>${workout.load} TRIMP</small>
        </article>
      `
    )
    .join("");
}

function renderWorkoutTypeOptions(workout) {
  const selected = workout.workoutTypeOverride || "auto";
  return WORKOUT_TYPE_OPTIONS
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
}

function handleWorkoutTypeChange(event) {
  const select = event.target.closest("[data-workout-type-select]");
  if (!select) return;
  const row = select.closest(".workout-row");
  const key = row?.dataset.workoutKey || "";
  const workout = state.workouts.find((item) => workoutDedupKey(item) === key);
  if (!workout) return;

  if (select.value === "auto") {
    delete workout.workoutTypeOverride;
  } else {
    workout.workoutTypeOverride = select.value;
  }
  workout.workoutType = classifyWorkout(workout);
  persistWorkouts();
  renderAll();
  restoreCurrentPlanOrGenerate();
  showToast(select.value === "auto" ? "Тип тренировки снова определяется автоматически" : "Тип тренировки задан вручную");
}

function renderBars() {
  const bars = document.querySelector("#loadBars");
  const days = lastDays(14);
  const daily = days.map((day) => {
    const workouts = state.workouts.filter((workout) => sameDay(new Date(workout.date), day));
    return {
      label: day.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
      load: workouts.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0),
      distanceKm: workouts.reduce((sum, workout) => sum + (Number(workout.distanceKm) || 0), 0),
      minutes: workouts.reduce((sum, workout) => sum + (Number(workout.durationMin) || 0), 0),
    };
  });
  const maxLoad = Math.max(...daily.map((item) => item.load), 0);
  const maxDistance = Math.max(...daily.map((item) => item.distanceKm), 0);
  const maxMinutes = Math.max(...daily.map((item) => item.minutes), 0);

  document.querySelector("#loadLabel").textContent = state.workouts.length
    ? `пики: ${maxLoad} TRIMP · ${round(maxDistance, 1)} км · ${Math.round(maxMinutes)} мин`
    : "нет данных";
  bars.innerHTML = [
    renderMetricChart("Нагрузка", "TRIMP", daily, "load", maxLoad, (value) => Math.round(value), "load"),
    renderMetricChart("Километраж", "км", daily, "distanceKm", maxDistance, (value) => round(value, 1), "distance"),
    renderMetricChart("Время", "мин", daily, "minutes", maxMinutes, (value) => Math.round(value), "hours"),
  ].join("");
}

function renderMetricChart(title, unit, items, key, maxValue, formatValue, className) {
  const scaleMax = Math.max(maxValue, 1);
  return `
    <section class="load-chart">
      <div class="load-chart-head">
        <strong>${title}</strong>
        <span>${formatValue(maxValue)} ${unit}</span>
      </div>
      <div class="chart-bars">
        ${items
          .map((item) => {
            const value = Number(item[key]) || 0;
            const formatted = formatValue(value);
            const height = value ? Math.max(4, (value / scaleMax) * 120) : 4;
            return `
              <div class="bar-wrap" title="${formatted} ${unit}">
                <span class="bar-value">${value ? formatted : ""}</span>
                <div class="bar ${className}" style="height:${height}px"></div>
                <span class="bar-date">${item.label}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderWeekComparison() {
  const container = document.querySelector("#weekComparison");
  if (!container) return;

  const rows = buildWeekComparison(6);
  const hasData = rows.some((row) => row.actualWorkouts || row.plannedLoad);
  if (!hasData) {
    container.innerHTML = `<div class="empty">Появится после импорта тренировок или сохранения недельного плана.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="week-row head">
      <span>Неделя</span>
      <span>Факт</span>
      <span>План</span>
      <span>Ключевые</span>
    </div>
    ${rows.map((row) => `
      <div class="week-row ${row.weekKey === currentWeekKey() ? "current" : ""}">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <small>${row.weekKey === currentWeekKey() ? "текущая" : escapeHtml(row.sourceLabel)}</small>
        </div>
        <div>
          <strong>${Math.round(row.actualLoad)} TRIMP</strong>
          <small>${round(row.actualDistanceKm, 1)} км · ${Math.round(row.actualMinutes)} мин</small>
        </div>
        <div>
          <strong>${row.plannedLoad ? `${row.plannedLoad} TRIMP` : "нет плана"}</strong>
          <small>${row.plannedDistanceKm ? `${round(row.plannedDistanceKm, 1)} км` : escapeHtml(row.sourceLabel)}</small>
        </div>
        <div>
          <strong>${escapeHtml(row.actualKeyLabel)}</strong>
          <small>${escapeHtml(row.plannedKeyLabel)}</small>
        </div>
      </div>
    `).join("")}
  `;
}

function buildWeekComparison(count = 6) {
  const current = startOfTrainingWeek(new Date());
  return Array.from({ length: count }, (_, index) => {
    const weekStart = addDays(current, (index - count + 1) * 7);
    return summarizeWeekForComparison(weekStart);
  });
}

function summarizeWeekForComparison(weekStart) {
  const range = weekRange(weekStart);
  const weekKey = toDateInputValue(range.start);
  const workouts = dedupeWorkouts(state.workouts.filter((workout) => {
    const date = new Date(workout.date);
    return date >= range.start && date < range.end;
  }));
  const planState = storedPlanForWeekKey(weekKey);
  const planDays = planState?.days || [];
  const keyTypes = new Set(["interval", "tempo", "long", "race"]);
  const actualKeyTypes = [...new Set(workouts.map(getWorkoutType).filter((type) => keyTypes.has(type)))];
  const plannedKeyTypes = [...new Set(planDays.map(plannedTypeForDay).filter((type) => keyTypes.has(type)))];
  const actualLoad = workouts.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const actualDistanceKm = workouts.reduce((sum, workout) => sum + (Number(workout.distanceKm) || 0), 0);
  const actualMinutes = workouts.reduce((sum, workout) => sum + (Number(workout.durationMin) || 0), 0);
  const plannedLoad = planDays.reduce((sum, day) => sum + plannedLoadScoreForDay(day), 0);
  const plannedDistanceKm = planDays.reduce((sum, day) => sum + plannedDistanceEstimate(day), 0);

  return {
    weekKey,
    label: `${formatDate(range.start)} - ${formatDate(addDays(range.start, 6))}`,
    sourceLabel: planState ? planSourceLabel(planState.source) : "план не сохранен",
    actualWorkouts: workouts.length,
    actualLoad,
    actualDistanceKm,
    actualMinutes,
    plannedLoad,
    plannedDistanceKm,
    actualKeyLabel: actualKeyTypes.length ? actualKeyTypes.map(actualTypeLabel).join(", ") : "нет",
    plannedKeyLabel: plannedKeyTypes.length ? `план: ${plannedKeyTypes.map(plannedTypeLabel).join(", ")}` : "ключевых работ в плане нет",
  };
}

function storedPlanForWeekKey(weekKey) {
  const bucket = weekPlans(weekKey);
  const sources = bucket.sources || {};
  const preferred = bucket.activePlanSource || state.activePlanSource || "json";
  const sourceOrder = [...new Set([preferred, "json", "ai", "local"])];
  for (const source of sourceOrder) {
    const normalized = normalizeStoredPlanForWeek(sources[source], weekKey);
    if (normalized) return normalized;
  }
  return null;
}

function planSourceLabel(source) {
  const labels = {
    local: "локальный",
    json: "JSON",
    ai: "ИИ",
  };
  return labels[source] || "сохраненный план";
}

function plannedDistanceEstimate(day) {
  const bounds = plannedDistanceBounds(day);
  if (!bounds) return 0;
  return average([bounds.from, bounds.to]);
}

function plannedDistanceKmForProgress(day) {
  return plannedDistanceKm(day) || plannedDistanceEstimate(day) || 0;
}

function plannedMinutesForProgress(day) {
  return Math.max(plannedDurationMinutes(day) || 0, plannedDurationFromDistance(day) || 0);
}

function generatePlan() {
  hideAdjustChoice();
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
  hideAdjustChoice();
  const savedPlan = getCurrentWeekPlan("local");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  generatePlan();
}

function selectJsonPlan() {
  hideAdjustChoice();
  const savedPlan = getCurrentWeekPlan("json");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  planJsonInput.click();
}

function reloadJsonPlan() {
  hideAdjustChoice();
  planJsonInput.click();
}

function selectAiPlan() {
  hideAdjustChoice();
  const savedPlan = getCurrentWeekPlan("ai");
  if (savedPlan) {
    showPlanState(savedPlan);
    return;
  }
  generateAiPlan();
}

function adjustDisplayedPlan() {
  const choice = document.querySelector("#adjustChoice");
  const isOpen = choice.classList.toggle("open");
  document.querySelector("#adjustPlan").classList.toggle("active", isOpen);
}

function hideAdjustChoice() {
  const choice = document.querySelector("#adjustChoice");
  if (!choice) return;
  choice.classList.remove("open");
  document.querySelector("#adjustPlan")?.classList.remove("active");
}

function adjustPlanLocally() {
  hideAdjustChoice();
  const current = loadCurrentPlan() || {
    source: "local",
    summary: "Локальный план скорректирован по факту выполненных тренировок.",
    days: buildPlan(),
  };
  const adjustedDays = adjustRemainingPlanDays(current.days);
  const changeLog = appendPlanChangeLog(
    current.changeLog,
    buildPlanAdjustmentChanges(current.days, adjustedDays, "local-adjust", "Локальная корректировка")
  );
  const savedPlan = saveCurrentPlan({
    ...current,
    summary: current.summary || "План скорректирован по факту выполненных тренировок.",
    updatedAt: new Date().toISOString(),
    changeLog,
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
  const adjustmentChanges = buildPlanAdjustmentChanges(current.days, adjustedDays, "auto-adjust", "Автокорректировка");
  if (!adjustmentChanges.length) return;
  saveCurrentPlan({
    ...current,
    summary: current.summary || "Локальный план автоматически скорректирован по факту.",
    updatedAt: new Date().toISOString(),
    changeLog: appendPlanChangeLog(current.changeLog, adjustmentChanges),
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
  renderAiPlanReview();
  renderPlanChangeLog(loadCurrentPlan());
  updatePlanDensityUi();
  planGrid.innerHTML = plan
    .map((day, index) => {
      const status = getPlanDayStatus(day);
      const execution = evaluatePlanDayExecution(day);
      const toneClass = planToneClass(day);
      return `
        <article class="plan-card ${status.className} eval-${execution.level} ${toneClass}" data-plan-day-index="${index}">
          <div class="plan-card-head">
            <time>${day.dateLabel}</time>
            <button class="ghost-btn plan-edit-btn" data-edit-plan-day="${index}" type="button" title="Редактировать день">Править</button>
          </div>
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

function togglePlanDensity() {
  state.planViewMode = state.planViewMode === "compact" ? "detailed" : "compact";
  saveJson(PLAN_VIEW_MODE_KEY, state.planViewMode);
  updatePlanDensityUi();
}

function updatePlanDensityUi() {
  const planGrid = document.querySelector("#planGrid");
  const button = document.querySelector("#togglePlanDensity");
  const compact = state.planViewMode === "compact";
  planGrid?.classList.toggle("compact-plan", compact);
  if (button) {
    button.textContent = compact ? "Подробно" : "Компактно";
    button.classList.toggle("active", compact);
  }
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
    ${renderWeekProgress(summary)}
    ${renderPlanControl(summary)}
  `;
}

function renderAiPlanReview() {
  const container = document.querySelector("#aiPlanReview");
  if (!container) return;

  const review = state.planReview;
  if (!review || review.weekKey !== selectedWeekKey()) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const issues = Array.isArray(review.issues) ? review.issues : [];
  const recommendations = Array.isArray(review.recommendations) ? review.recommendations : [];
  container.hidden = false;
  container.innerHTML = `
    <div class="panel-head compact-head">
      <div>
        <h2>ИИ-ревью плана</h2>
        <span>${escapeHtml(review.modelUsed ? `Модель: ${review.modelUsed}` : "проверка текущей недели")}</span>
      </div>
      <strong class="review-verdict ${escapeHtml(review.verdictLevel)}">${escapeHtml(review.verdict)}</strong>
    </div>
    <p class="review-summary">${escapeHtml(review.summary)}</p>
    ${issues.length ? `
      <div class="review-list">
        ${issues.map((issue) => `
          <article class="review-item ${escapeHtml(issue.severity)}">
            <span>${escapeHtml(issue.day || issue.severityLabel)}</span>
            <strong>${escapeHtml(issue.title)}</strong>
            <p>${escapeHtml(issue.details)}</p>
          </article>
        `).join("")}
      </div>
    ` : `<div class="empty">ИИ не нашел критичных конфликтов в структуре плана.</div>`}
    ${recommendations.length ? `
      <div class="review-recommendations">
        <span class="section-label">Что проверить перед выполнением</span>
        <ul>${recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
    ` : ""}
  `;
}

async function reviewCurrentPlanWithAi() {
  hideAdjustChoice();
  const current = loadCurrentPlan();
  if (!current) {
    setAiStatus("Для ИИ-ревью сначала создайте, загрузите или выберите план недели.", "error");
    return;
  }

  const button = document.querySelector("#reviewAiPlan");
  button.disabled = true;
  setAiStatus("ИИ проверяет текущий план...", "");

  try {
    const response = await fetch(`${API_BASE_URL}/api/plan/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPlanReviewRequest(current)),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "сервер вернул ошибку");
    }

    state.planReview = normalizePlanReview(payload.review, current);
    renderAiPlanReview();
    setAiStatus(`ИИ-ревью готово: ${state.planReview.summary}`, state.planReview.verdictLevel === "danger" ? "error" : "ok");
  } catch (error) {
    setAiStatus(`ИИ-ревью недоступно: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function buildPlanReviewRequest(planState) {
  const aiRequest = buildAiRequest();
  const planDays = planState.days || [];
  return {
    system: "Ты опытный тренер-ревьюер. Проверяй готовый недельный план на риски, противоречия и соответствие цели. Не переписывай план целиком.",
    context: aiRequest.context,
    planningWeek: aiRequest.planningWeek,
    plan: {
      source: planState.source || "",
      sourceLabel: planSourceLabel(planState.source),
      summary: planState.summary || "",
      modelUsed: planState.modelUsed || "",
      weekStart: selectedWeekKey(),
      days: planDays.map((day) => ({
        date: day.date,
        dateLabel: day.dateLabel,
        focus: day.focus,
        title: day.title,
        plannedWorkout: day.plannedWorkout || day.details || "",
        targetDistance: day.targetDistance || "",
        intensity: day.intensity || "",
        load: day.load || "",
        rationale: day.rationale || "",
        plannedType: plannedTypeForDay(day),
        plannedLoadEstimate: plannedLoadScoreForDay(day),
      })),
    },
    localAnalysis: buildWeekExecutionSummary(planDays),
    reviewRules: [
      "Проверь соответствие заголовков и заданий: focus/title не должны противоречить plannedWorkout.",
      "Проверь расстояние между тяжелыми беговыми стимулами, особенно интервалы, темпо, гонка и длительная.",
      "Проверь, что цель, этап подготовки, режим planningMode и ближайшая гонка учтены.",
      "Проверь, что тренировки достаточно конкретны: интервалы, темпо, горки и силовая должны иметь объем, интенсивность и восстановление.",
      "Проверь нагрузку относительно recentWorkouts, load7Days, load28Days, acuteChronicRatio и локальных предупреждений.",
      "Не предлагай медицинских диагнозов. Если данных мало, прямо укажи, какие данные ограничивают уверенность.",
    ],
  };
}

function normalizePlanReview(review, planState) {
  const raw = review && typeof review === "object" ? review : {};
  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const normalizedIssues = issues.slice(0, 8).map((issue) => {
    const severity = normalizeReviewSeverity(issue.severity || issue.level);
    return {
      severity,
      severityLabel: reviewSeverityLabel(severity),
      day: String(issue.day || issue.dateLabel || issue.date || "").trim(),
      title: String(issue.title || issue.problem || "Замечание").trim(),
      details: String(issue.details || issue.recommendation || issue.reason || "").trim(),
    };
  }).filter((issue) => issue.title || issue.details);
  const verdictLevel = normalizeReviewVerdict(raw.verdictLevel || raw.level, normalizedIssues);
  return {
    weekKey: selectedWeekKey(),
    source: planState.source || "",
    summary: String(raw.summary || "Проверка готового плана выполнена.").trim(),
    verdict: String(raw.verdict || reviewVerdictLabel(verdictLevel)).trim(),
    verdictLevel,
    issues: normalizedIssues,
    recommendations: Array.isArray(raw.recommendations)
      ? raw.recommendations.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    modelUsed: raw.modelUsed || "",
    reviewedAt: new Date().toISOString(),
  };
}

function normalizeReviewSeverity(value) {
  const text = String(value || "").toLowerCase();
  if (matchesAny(text, ["critical", "danger", "крит", "высок", "сильн"])) return "danger";
  if (matchesAny(text, ["warning", "warn", "сред", "риск", "осторож"])) return "warn";
  return "info";
}

function normalizeReviewVerdict(value, issues) {
  const text = String(value || "").toLowerCase();
  if (matchesAny(text, ["danger", "critical", "крит", "перестро"])) return "danger";
  if (matchesAny(text, ["warn", "caution", "риск", "уточн", "осторож"])) return "warn";
  if (issues.some((issue) => issue.severity === "danger")) return "danger";
  if (issues.some((issue) => issue.severity === "warn")) return "warn";
  return "ok";
}

function reviewSeverityLabel(severity) {
  return {
    danger: "критично",
    warn: "риск",
    info: "замечание",
  }[severity] || "замечание";
}

function reviewVerdictLabel(level) {
  return {
    ok: "план выглядит согласованным",
    warn: "нужна внимательная проверка",
    danger: "лучше скорректировать",
  }[level] || "ревью готово";
}

function renderWeekProgress(summary) {
  const items = [
    weeklyProgressItem("TRIMP", summary.actualLoad, summary.plannedLoad, "TRIMP", (value) => Math.round(value)),
    weeklyProgressItem("Километраж", summary.actualDistanceKm, summary.plannedDistanceKm, "км", (value) => round(value, 1)),
    weeklyProgressItem("Время", summary.actualMinutes, summary.plannedMinutes, "мин", (value) => Math.round(value)),
    weeklyProgressItem("Тренировочные дни", summary.completedDays, summary.plannedTrainingDays, "дн.", (value) => Math.round(value)),
    weeklyProgressItem("Ключевые работы", summary.keyCompleted, summary.keyPlanned, "", (value) => Math.round(value)),
  ];

  return `
    <div class="week-progress-grid">
      ${items.map((item) => `
        <div class="week-progress-item ${item.level}">
          <div class="week-progress-head">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(item.percentLabel)}</strong>
          </div>
          <div class="week-progress-track">
            <div class="week-progress-bar" style="width:${item.width}%"></div>
          </div>
          <small>${escapeHtml(item.details)}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function weeklyProgressItem(label, actual, planned, unit, formatValue) {
  const safeActual = Number(actual) || 0;
  const safePlanned = Number(planned) || 0;
  if (!safePlanned) {
    return {
      label,
      level: "empty",
      width: 0,
      percentLabel: "нет плана",
      details: `${formatValue(safeActual)}${unit ? ` ${unit}` : ""} факт`,
    };
  }

  const ratio = safeActual / safePlanned;
  const percent = Math.round(ratio * 100);
  return {
    label,
    level: weeklyProgressLevel(ratio),
    width: clamp(percent, 0, 100),
    percentLabel: `${percent}%`,
    details: `${formatValue(safeActual)} / ${formatValue(safePlanned)}${unit ? ` ${unit}` : ""}`,
  };
}

function weeklyProgressLevel(ratio) {
  if (ratio < 0.8) return "low";
  if (ratio <= 1.15) return "on-track";
  if (ratio <= 1.35) return "high";
  return "over";
}

function renderPlanControl(summary) {
  const warnings = summary.warnings || [];
  const correctionNotes = summary.correctionNotes || [];
  return `
    <div class="plan-control-grid">
      <div class="plan-control-card ${summary.monotony.level}">
        <span class="section-label">Монотонность нагрузки</span>
        <strong>${summary.monotony.label}</strong>
        <p>${escapeHtml(summary.monotony.comment)}</p>
      </div>
      <div class="plan-control-card ${warnings.length ? "warn" : "ok"}">
        <span class="section-label">Предупреждения</span>
        ${warnings.length ? `<ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>Критичных конфликтов по текущей неделе не видно.</p>"}
      </div>
      <div class="plan-control-card ${summary.adjustmentClass}">
        <span class="section-label">Почему корректировать</span>
        ${correctionNotes.length ? `<ul>${correctionNotes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>Пока достаточно наблюдать за фактом и не менять план заранее.</p>"}
      </div>
    </div>
  `;
}

function renderPlanChangeLog(planState) {
  const container = document.querySelector("#planChangeLog");
  if (!container) return;
  const items = normalizePlanChangeLog(planState?.changeLog).slice(0, 8);
  if (!items.length) {
    container.innerHTML = `
      <div class="panel-head compact-head">
        <div>
          <h2>История изменений</h2>
          <span>для выбранного плана пока нет ручных или локальных правок</span>
        </div>
      </div>
      <div class="empty">Изменения появятся здесь после редактирования дня или локальной корректировки плана.</div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="panel-head compact-head">
      <div>
        <h2>История изменений</h2>
        <span>${items.length} последних записей по выбранному плану</span>
      </div>
    </div>
    <div class="change-log-list">
      ${items.map((item) => `
        <article class="change-log-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(formatChangeLogDate(item.timestamp))}${item.dayLabel ? ` · ${escapeHtml(item.dayLabel)}` : ""}</span>
          </div>
          <p>${escapeHtml(item.details)}</p>
          ${item.fields?.length ? `<small>${escapeHtml(item.fields.join(", "))}</small>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function clearPlanChangeLog(message = "Для выбранной недели нет журнала изменений.") {
  const container = document.querySelector("#planChangeLog");
  if (!container) return;
  container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function clearPlanAnalysis(message = "Для выбранной недели нет плана для анализа.") {
  const container = document.querySelector("#planAnalysis");
  if (!container) return;
  container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  renderAiPlanReview();
}

function handlePlanGridClick(event) {
  const button = event.target.closest("[data-edit-plan-day]");
  if (!button) return;
  openPlanDayEditor(Number(button.dataset.editPlanDay));
}

function openPlanDayEditor(index) {
  const current = loadCurrentPlan();
  const day = current?.days?.[index];
  if (!current || !day || !planEditModal || !planEditForm) {
    setAiStatus("Для редактирования сначала создайте или загрузите план выбранной недели.", "error");
    return;
  }

  planEditForm.elements.dayIndex.value = String(index);
  planEditForm.elements.focus.value = closestPlanFocusOption(day.focus || "Кросс");
  planEditForm.elements.title.value = day.title || "";
  planEditForm.elements.targetDistance.value = day.targetDistance || "";
  planEditForm.elements.intensity.value = day.intensity || "";
  planEditForm.elements.plannedWorkout.value = day.plannedWorkout || day.details || "";
  planEditForm.elements.load.value = day.load || "";
  planEditForm.elements.rationale.value = day.rationale || "";
  document.querySelector("#planEditDate").textContent = day.dateLabel || formatDate(day.date);
  planEditModal.hidden = false;
  planEditForm.elements.title.focus();
}

function closePlanEditModal() {
  if (planEditModal) planEditModal.hidden = true;
}

function saveEditedPlanDay(event) {
  event.preventDefault();
  const current = loadCurrentPlan();
  const index = Number(planEditForm.elements.dayIndex.value);
  const original = current?.days?.[index];
  if (!current || !original || Number.isNaN(index)) {
    closePlanEditModal();
    setAiStatus("Не удалось сохранить день: текущий план не найден.", "error");
    return;
  }

  const plannedWorkout = planEditForm.elements.plannedWorkout.value.trim();
  const edited = {
    ...original,
    focus: planEditForm.elements.focus.value,
    title: planEditForm.elements.title.value.trim(),
    details: plannedWorkout,
    plannedWorkout,
    targetDistance: planEditForm.elements.targetDistance.value.trim(),
    intensity: planEditForm.elements.intensity.value.trim(),
    load: planEditForm.elements.load.value.trim() || original.load || "умеренная нагрузка",
    rationale: planEditForm.elements.rationale.value.trim(),
  };
  const editedDay = normalizePlanDay(edited, original, index);
  const change = buildManualPlanChange(original, editedDay);
  const days = current.days.map((day, dayIndex) => (dayIndex === index ? editedDay : day));
  const savedPlan = saveCurrentPlan({
    ...current,
    summary: markPlanSummaryEdited(current.summary),
    updatedAt: new Date().toISOString(),
    changeLog: change ? appendPlanChangeLog(current.changeLog, change) : normalizePlanChangeLog(current.changeLog),
    days,
  });

  closePlanEditModal();
  renderAll();
  renderPlan(savedPlan?.days || days);
  updatePlanSourceButtons(savedPlan?.source || current.source);
  setAiStatus("День плана сохранен вручную.", "ok");
}

function closestPlanFocusOption(value) {
  const options = [...planEditForm.elements.focus.options].map((option) => option.value);
  if (options.includes(value)) return value;
  const type = planTypeFromFocus(value);
  const mapped = {
    rest: "Отдых",
    recovery: "Восстановление",
    easy: "Кросс",
    long: "Длительная",
    tempo: "Темпо",
    interval: "Интервалы",
    race: "Гонка",
    cross: "ОФП",
  }[type];
  return options.includes(mapped) ? mapped : "Кросс";
}

function markPlanSummaryEdited(summary) {
  const text = String(summary || "").trim() || "План сохранен.";
  return text.includes("Отредактировано вручную") ? text : `${text} Отредактировано вручную.`;
}

function normalizePlanChangeLog(changeLog) {
  if (!Array.isArray(changeLog)) return [];
  return changeLog
    .map((item) => ({
      timestamp: item?.timestamp || new Date().toISOString(),
      type: item?.type || "change",
      title: String(item?.title || "Изменение плана").slice(0, 120),
      details: String(item?.details || "").slice(0, 260),
      dayDate: item?.dayDate || "",
      dayLabel: item?.dayLabel || "",
      fields: Array.isArray(item?.fields) ? item.fields.map(String).slice(0, 8) : [],
    }))
    .filter((item) => item.details || item.fields.length)
    .slice(0, 40);
}

function appendPlanChangeLog(existing, entries) {
  const current = normalizePlanChangeLog(existing);
  const nextEntries = normalizePlanChangeLog(Array.isArray(entries) ? entries : [entries]);
  return [...nextEntries, ...current].slice(0, 40);
}

function buildManualPlanChange(original, edited) {
  const changedFields = changedPlanDayFields(original, edited);
  if (!changedFields.length) return null;
  return {
    timestamp: new Date().toISOString(),
    type: "manual-edit",
    title: "Ручная правка дня",
    details: `${edited.dayLabel || formatDate(edited.date)}: ${edited.focus || "План"} - ${edited.title || "тренировка"}`,
    dayDate: edited.date || "",
    dayLabel: edited.dayLabel || original.dateLabel || "",
    fields: changedFields,
  };
}

function buildPlanAdjustmentChanges(beforeDays, afterDays, type, title) {
  return afterDays
    .map((day, index) => {
      const original = beforeDays[index];
      if (!original) return null;
      const changedFields = changedPlanDayFields(original, day);
      if (!changedFields.length) return null;
      return {
        timestamp: new Date().toISOString(),
        type,
        title,
        details: `${day.dateLabel || formatDate(day.date)}: ${day.focus || "План"} - ${day.title || "тренировка"}`,
        dayDate: day.date || "",
        dayLabel: day.dateLabel || "",
        fields: changedFields,
      };
    })
    .filter(Boolean);
}

function changedPlanDayFields(before, after) {
  const fields = [
    ["focus", "тип"],
    ["title", "заголовок"],
    ["plannedWorkout", "задание"],
    ["targetDistance", "ориентир"],
    ["intensity", "интенсивность"],
    ["load", "нагрузка"],
    ["rationale", "почему так"],
  ];
  return fields
    .filter(([key]) => planDayFieldValue(before, key) !== planDayFieldValue(after, key))
    .map(([, label]) => label);
}

function planDayFieldValue(day, key) {
  if (key === "plannedWorkout") return String(day?.plannedWorkout || day?.details || "").trim();
  return String(day?.[key] || "").trim();
}

function formatChangeLogDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showPlanLoading(message = "Идет загрузка плана...") {
  const planGrid = document.querySelector("#planGrid");
  const weekStart = selectedWeekStartDate();
  const placeholders = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  updatePlanDensityUi();
  clearPlanAnalysis("Идет загрузка плана и проверка выполненных тренировок.");
  clearPlanChangeLog("Журнал изменений появится после загрузки плана.");
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
  updatePlanDensityUi();
  clearPlanAnalysis();
  clearPlanChangeLog();
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
      updatedAt: planState.updatedAt || planState.savedAt || new Date().toISOString(),
      weekStart: normalized.days[0]?.date || "",
      changeLog: normalizePlanChangeLog(planState.changeLog),
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
      updatedAt: planState.updatedAt || planState.savedAt || new Date().toISOString(),
      weekStart: weekKey,
      changeLog: normalizePlanChangeLog(planState.changeLog),
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
    text = expandRaceGoalInSummary(text, raceGoal);
  }

  return text;
}

function expandRaceGoalInSummary(summary, raceGoal) {
  const goalMatch = summary.match(/Цель:\s*Подготовка к старту/i);
  if (!goalMatch) return summary;

  const beforeGoal = summary.slice(0, goalMatch.index);
  const afterGoalStart = goalMatch.index + goalMatch[0].length;
  const afterGoal = summary.slice(afterGoalStart);
  const weekMatch = afterGoal.match(/\s+Неделя:/i);
  const afterGoalBlock = weekMatch ? afterGoal.slice(weekMatch.index) : "";
  return `${beforeGoal}${raceGoal}${afterGoalBlock}`.replace(/\s+/g, " ").trim();
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
  const actualGroups = groupedActualWorkoutsForPlanDay(day);
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
    ${actualGroups.length ? `
      <div class="plan-section plan-actual">
        <span class="section-label">Факт</span>
        ${actualGroups.map((group) => `
          <div class="actual-group ${group.kind}">
            <strong>${escapeHtml(group.label)}</strong>
            <p>${group.workouts.map((workout) => escapeHtml(formatActualWorkout(workout))).join("<br>")}</p>
          </div>
        `).join("")}
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

function groupedActualWorkoutsForPlanDay(day) {
  const actual = actualWorkoutsForPlanDay(day);
  if (!actual.length) return [];

  const credited = planCompletionWorkoutsForDay(day);
  const creditedKeys = new Set(credited.map(workoutDedupKey));
  const primary = actual.filter((workout) => creditedKeys.has(workoutDedupKey(workout)));
  const additional = actual.filter((workout) => !creditedKeys.has(workoutDedupKey(workout)));
  const groups = [];

  if (primary.length) {
    groups.push({
      kind: additional.length ? "primary" : "single",
      label: additional.length ? "Зачет задания" : "Факт",
      workouts: primary,
    });
  }
  if (additional.length) {
    groups.push({
      kind: "additional",
      label: "Доп. нагрузка",
      workouts: additional,
    });
  }
  return groups;
}

function buildWeekExecutionSummary(plan) {
  const days = Array.isArray(plan) ? plan : [];
  const weekStart = selectedWeekStartDate();
  const range = weekRange(weekStart);
  const actualWeekWorkouts = dedupeWorkouts(state.workouts.filter((workout) => {
    const date = new Date(workout.date);
    return date >= range.start && date < range.end;
  }));
  const evaluations = days.map(evaluatePlanDayExecution);
  const plannedTrainingDays = days.filter((day) => plannedTypeForDay(day) !== "rest").length || days.length;
  const completedDays = evaluations.filter((item) => item.completed).length;
  const keyTypes = new Set(["interval", "tempo", "long", "race"]);
  const keyPlanned = days.filter((day) => keyTypes.has(plannedTypeForDay(day))).length;
  const keyCompleted = evaluations.filter((item) => item.keyCompleted).length;
  const plannedLoad = days.reduce((sum, day) => sum + plannedLoadScoreForDay(day), 0);
  const plannedDistanceKm = days.reduce((sum, day) => sum + (plannedDistanceKmForProgress(day) || 0), 0);
  const plannedMinutes = days.reduce((sum, day) => sum + (plannedMinutesForProgress(day) || 0), 0);
  const actualLoad = actualWeekWorkouts.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const actualDistanceKm = actualWeekWorkouts.reduce((sum, workout) => sum + (Number(workout.distanceKm) || 0), 0);
  const actualMinutes = actualWeekWorkouts.reduce((sum, workout) => sum + (Number(workout.durationMin) || 0), 0);
  const previousWeekLoad = sumWorkoutsLoadForRange(addDays(weekStart, -7), weekStart);
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
  const heavyDays = elapsedEvaluations.filter((item) => ["harder", "overloaded"].includes(item.level)).length;
  const phase = getPreparationPhase(weekStart);
  const dailyLoads = days.map((day) => {
    const date = startOfDay(day.date);
    return actualWeekWorkouts
      .filter((workout) => sameDay(startOfDay(workout.date), date))
      .reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  });
  const monotony = describeLoadMonotony(dailyLoads, actualWeekWorkouts.length);

  let adjustmentLevel = "наблюдать";
  let adjustmentReason = "неделя только началась или факта пока мало";
  let adjustmentClass = "watch";
  if (heavyDays || (loadRatio && loadRatio > 1.25 && elapsedCompletedDays > 0)) {
    adjustmentLevel = "снизить";
    adjustmentReason = "фактическая нагрузка выше плана на уже выполненную часть недели";
    adjustmentClass = "warn";
  } else if (missedPastDays || mismatchDays) {
    adjustmentLevel = "перестроить";
    adjustmentReason = "есть пропущенные или замененные тренировки";
    adjustmentClass = "warn";
  } else if (loadRatio !== null && loadRatio < 0.55 && elapsedCompletedDays >= 2) {
    adjustmentLevel = "можно добавить";
    adjustmentReason = "фактическая нагрузка заметно ниже плана на прошедшие дни";
    adjustmentClass = "cool";
  } else if (elapsedCompletedDays > 0) {
    adjustmentLevel = "не нужна";
    adjustmentReason = "выполнение идет близко к текущей части плана";
    adjustmentClass = "ok";
  }

  const warningContext = {
    days,
    evaluations,
    actualWeekWorkouts,
    dailyLoads,
    loadRatio,
    actualLoad,
    actualElapsedLoad,
    expectedElapsedLoad,
    previousWeekLoad,
    missedPastDays,
    mismatchDays,
    heavyDays,
    monotony,
    weekStart,
  };
  const warnings = buildPlanWarnings(warningContext);
  const correctionNotes = buildCorrectionNotes({
    ...warningContext,
    adjustmentLevel,
    adjustmentReason,
    keyPlanned,
    keyCompleted,
  });

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
    actualMinutes,
    plannedLoad,
    plannedDistanceKm,
    plannedMinutes,
    keyPlanned,
    keyCompleted,
    keyComment: keyPlanned ? keyExecutionComment(days, evaluations) : "на неделе нет ключевых работ",
    adjustmentLevel,
    adjustmentReason,
    adjustmentClass,
    monotony,
    warnings,
    correctionNotes,
  };
}

function describeLoadMonotony(dailyLoads, workoutCount) {
  const loads = Array.isArray(dailyLoads) ? dailyLoads.map((value) => Number(value) || 0) : [];
  const total = loads.reduce((sum, value) => sum + value, 0);
  const activeDays = loads.filter((value) => value > 0).length;
  if (!workoutCount || activeDays < 3 || total <= 0) {
    return {
      value: null,
      level: "watch",
      label: "мало данных",
      comment: "нужно минимум несколько дней с фактической нагрузкой, чтобы оценить однообразие недели",
    };
  }

  const avg = average(loads);
  const variance = average(loads.map((value) => (value - avg) ** 2));
  const sd = Math.sqrt(variance);
  const value = sd > 0 ? round(avg / sd, 2) : 3;
  if (value >= 2) {
    return {
      value,
      level: "warn",
      label: `${value}`,
      comment: "нагрузка слишком ровная по дням; стоит чередовать тяжелее и легче, чтобы восстановление было заметнее",
    };
  }
  if (value >= 1.5) {
    return {
      value,
      level: "caution",
      label: `${value}`,
      comment: "монотонность умеренно повышена; следите, чтобы легкие дни действительно оставались легкими",
    };
  }
  return {
    value,
    level: "ok",
    label: `${value}`,
    comment: "чередование нагрузки по дням выглядит достаточно разнообразным",
  };
}

function buildPlanWarnings(context) {
  const warnings = [];
  if (context.loadRatio && context.loadRatio > 1.35) {
    warnings.push(`Фактическая нагрузка уже ${Math.round(context.loadRatio * 100)}% от плановой для прошедшей части недели.`);
  }
  if (context.previousWeekLoad && context.actualLoad > context.previousWeekLoad * 1.45) {
    warnings.push(`Нагрузка недели резко выше предыдущей: ${context.actualLoad} TRIMP против ${context.previousWeekLoad}.`);
  }
  if (context.heavyDays) {
    warnings.push(`Есть дни тяжелее плана: ${context.heavyDays}.`);
  }
  if (context.mismatchDays) {
    warnings.push(`Есть дни с другим типом тренировки: ${context.mismatchDays}.`);
  }
  if (context.missedPastDays) {
    warnings.push(`Есть пропущенные плановые дни: ${context.missedPastDays}.`);
  }
  if (context.monotony.level === "warn") {
    warnings.push(`Высокая монотонность нагрузки: ${context.monotony.label}.`);
  }

  const backToBack = findBackToBackHeavyActualDays(context.dailyLoads, context.weekStart);
  if (backToBack) {
    warnings.push(`Два дня подряд с высокой фактической нагрузкой: ${backToBack}.`);
  }

  const closeStimulus = findClosePlannedHardStimuli(context.days);
  if (closeStimulus) {
    warnings.push(`Ключевые беговые стимулы стоят слишком близко: ${closeStimulus}.`);
  }

  return warnings;
}

function buildCorrectionNotes(context) {
  const notes = [];
  if (context.expectedElapsedLoad) {
    notes.push(`На прошедшую часть недели было запланировано около ${context.expectedElapsedLoad} TRIMP, выполнено ${context.actualElapsedLoad} TRIMP.`);
  }
  if (context.previousWeekLoad) {
    notes.push(`Предыдущая календарная неделя: ${context.previousWeekLoad} TRIMP, текущая неделя сейчас: ${context.actualLoad} TRIMP.`);
  }
  if (context.heavyDays) {
    notes.push("Следующие легкие дни лучше не усиливать: фактическая нагрузка уже выше задания.");
  }
  if (context.missedPastDays || context.mismatchDays) {
    notes.push("Коррекция нужна не только по TRIMP, но и по структуре: часть плановых стимулов не закрыта нужным типом работы.");
  }
  if (context.keyPlanned) {
    notes.push(`Ключевые работы: закрыто ${context.keyCompleted} из ${context.keyPlanned}.`);
  }
  if (context.monotony.value) {
    notes.push(`Монотонность недели: ${context.monotony.label}. ${context.monotony.comment}`);
  }
  if (!notes.length && context.adjustmentLevel === "не нужна") {
    notes.push("Факт близок к плану, поэтому оставшиеся дни можно выполнять без перестройки.");
  }
  return notes;
}

function findBackToBackHeavyActualDays(dailyLoads, weekStart) {
  const threshold = Math.max(100, average(dailyLoads.filter((value) => value > 0)) * 1.15 || 100);
  for (let index = 1; index < dailyLoads.length; index += 1) {
    if (dailyLoads[index - 1] >= threshold && dailyLoads[index] >= threshold) {
      const first = formatDate(addDays(weekStart, index - 1));
      const second = formatDate(addDays(weekStart, index));
      return `${first} и ${second}`;
    }
  }
  return "";
}

function findClosePlannedHardStimuli(days) {
  const hardTypes = new Set(["interval", "tempo", "race"]);
  const items = days
    .map((day, index) => ({ index, type: plannedTypeForDay(day), label: plannedTypeLabel(plannedTypeForDay(day)) }))
    .filter((item) => hardTypes.has(item.type));
  for (let index = 1; index < items.length; index += 1) {
    const prev = items[index - 1];
    const current = items[index];
    if (current.index - prev.index < 3) {
      return `${prev.label} и ${current.label}`;
    }
  }
  return "";
}

function sumWorkoutsLoadForRange(start, end) {
  const from = startOfDay(start);
  const to = startOfDay(end);
  return dedupeWorkouts(state.workouts.filter((workout) => {
    const date = new Date(workout.date);
    return date >= from && date < to;
  })).reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
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
  const completionActual = planCompletionWorkoutsForDay(day);
  const expectsNoRun = planExpectsNoRun(day);

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

  const actualTypes = [...new Set(actual.map(getWorkoutType))];
  const actualLoad = actual.reduce((sum, workout) => sum + (Number(workout.load) || 0), 0);
  const plannedLoad = plannedLoadScoreForDay(day);
  const hasRunningActual = actual.some(isRunningWorkout);
  const typeMatched = expectsNoRun && hasRunningActual
    ? false
    : completionActual.some((workout) => planTypeMatchesActual(plannedType, getWorkoutType(workout), day, workout));
  const typeMismatch = !typeMatched;
  const keyCompleted = ["interval", "tempo", "long", "race"].includes(plannedType) && typeMatched;
  const typeMismatchComment = typeMismatch
    ? `по плану ${plannedTypeLabelForDay(day, plannedType)}, по факту ${actualTypes.map(actualTypeLabel).join(", ")}`
    : "";
  const loadComment = plannedLoad ? `факт ${actualLoad} TRIMP против ориентира около ${plannedLoad}` : "";
  const joinedComment = (...parts) => parts.filter(Boolean).join("; ");

  if (!completionActual.length && planTypeRequiresRunning(plannedType)) {
    return {
      show: true,
      completed: false,
      keyCompleted: false,
      level: "mismatch",
      label: "есть доп. нагрузка",
      comment: joinedComment(typeMismatchComment || `по плану ${plannedTypeLabelForDay(day, plannedType)}, по факту ${actualTypes.map(actualTypeLabel).join(", ")}`, "нагрузка учтена в TRIMP, но беговое задание не закрыто", loadComment),
    };
  }

  if (plannedLoad && actualLoad > plannedLoad * 1.7) {
    return {
      show: true,
      completed: true,
      keyCompleted,
      level: "overloaded",
      label: typeMismatch ? "сильно тяжелее + другой тип" : "сильно тяжелее плана",
      comment: joinedComment(typeMismatchComment, loadComment),
    };
  }

  if (plannedLoad && actualLoad > plannedLoad * 1.35) {
    return {
      show: true,
      completed: true,
      keyCompleted,
      level: "harder",
      label: typeMismatch ? "тяжелее + другой тип" : "тяжелее плана",
      comment: joinedComment(typeMismatchComment, loadComment),
    };
  }

  if (plannedLoad && actualLoad < plannedLoad * 0.55 && plannedType !== "recovery") {
    return {
      show: true,
      completed: true,
      keyCompleted,
      level: "lighter",
      label: typeMismatch ? "легче + другой тип" : "легче плана",
      comment: joinedComment(typeMismatchComment, loadComment),
    };
  }

  if (typeMismatch) {
    return {
      show: true,
      completed: true,
      keyCompleted: false,
      level: "mismatch",
      label: "другой тип",
      comment: joinedComment(typeMismatchComment, loadComment),
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
  const assignmentType = planTypeFromAssignment(`${day.title || ""} ${day.intensity || ""} ${day.plannedWorkout || day.details || ""}`);
  const focusType = planTypeFromFocus(day.focus);
  if (assignmentType && !["recovery", "easy"].includes(assignmentType)) return assignmentType;
  return focusType || assignmentType || "easy";
}

function planToneClass(day) {
  return `plan-tone-${plannedIntensityTone(day)}`;
}

function plannedIntensityTone(day) {
  const text = planDayComparableText(day);
  const type = plannedTypeForDay(day);
  if (type === "rest" || assignmentHasNoRun(text)) return "recovery";
  if (matchesAny(text, ["спринт", "sprint", "максимальн"])) return "sprint";
  if (matchesAny(text, ["vo2", "vo₂", "z5"])) return "vo2";
  if (matchesAny(text, ["усилие 5 км", "5км", "5 km", "5k", "z5"])) return "5k";
  if (matchesAny(text, ["усилие 10 км", "10км", "10 km", "10k"])) return "10k";
  if (matchesAny(text, ["порог", "threshold", "z4"])) return "threshold";
  if (matchesAny(text, ["марафонск", "полумарафонск", "z3"])) return "threshold";
  if (type === "interval" || type === "race") return "vo2";
  if (type === "tempo") return "threshold";
  if (type === "long") return "long";
  if (type === "recovery" || matchesAny(text, ["z1", "восстанов", "очень легко"])) return "recovery";
  return "easy";
}

function planTypeMatchesActual(plannedType, actualType, day = null, workout = null) {
  if (plannedType === actualType) return true;
  if (day && plannedTypeAllowsOptionalEasyRun(day) && ["recovery", "easy", "long"].includes(actualType) && actualMatchesPlannedEnvelope(day, workout)) return true;
  if (day && plannedType === "easy" && actualType === "long" && actualMatchesPlannedEnvelope(day, workout)) return true;
  if (day && plannedType === "long" && actualType === "easy" && actualMatchesPlannedEnvelope(day, workout)) return true;
  if (plannedType === "easy" && ["easy", "cross", "recovery"].includes(actualType)) return true;
  if (plannedType === "recovery" && ["recovery", "easy", "cross"].includes(actualType)) return true;
  if (plannedType === "race") return ["interval", "tempo", "long", "easy"].includes(actualType);
  if (plannedType === "rest") return false;
  return false;
}

function plannedTypeAllowsOptionalEasyRun(day) {
  const text = planDayComparableText(day);
  const optionalRest = matchesAny(text, ["полный отдых либо", "полный отдых или", "отдых либо", "отдых или"]);
  const hasEasyRun = matchesAny(text, ["легко", "очень легко", "z1", "z2", "бег", "мин", "км"]);
  return optionalRest && hasEasyRun;
}

function actualMatchesPlannedEnvelope(day, workout) {
  if (!workout) return false;
  const durationBounds = plannedDurationBounds(day);
  const distanceBounds = plannedDistanceBounds(day);
  const duration = Number(workout.durationMin) || 0;
  const distance = Number(workout.distanceKm) || 0;
  const durationOk = durationBounds ? valueWithinRange(duration, durationBounds, 0.25, 0.15) : false;
  const distanceOk = distanceBounds ? valueWithinRange(distance, distanceBounds, 0.25, 0.15) : false;
  if (durationBounds && distanceBounds) return durationOk || distanceOk;
  if (durationBounds) return durationOk;
  if (distanceBounds) return distanceOk;
  return false;
}

function plannedDurationBounds(day) {
  const text = planDayComparableText(day);
  const ranges = [...text.matchAll(/(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*мин\w*/gi)]
    .map((match) => ({ from: Number(match[1]), to: Number(match[2]) }))
    .filter((range) => range.from > 0 && range.to >= range.from);
  if (!ranges.length) return null;
  return ranges.reduce((best, range) => (range.to > best.to ? range : best), ranges[0]);
}

function plannedDistanceBounds(day) {
  const text = planDayComparableText(day);
  const ranges = [...text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}(?:\.\d+)?)\s*км/gi)]
    .map((match) => ({ from: Number(match[1]), to: Number(match[2]) }))
    .filter((range) => range.to > 0 && range.to >= range.from);
  if (!ranges.length) return null;
  return ranges.reduce((best, range) => (range.to > best.to ? range : best), ranges[0]);
}

function valueWithinRange(value, range, lowerSlack, upperSlack) {
  if (!value || !range) return false;
  const lower = range.from * (1 - lowerSlack);
  const upper = range.to * (1 + upperSlack);
  return value >= lower && value <= upper;
}

function planDayComparableText(day) {
  return `${day.focus || ""} ${day.title || ""} ${day.intensity || ""} ${day.targetDistance || ""} ${day.plannedWorkout || ""} ${day.details || ""}`
    .toLowerCase()
    .replace(/,/g, ".");
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

function plannedTypeLabelForDay(day, type) {
  if (planExpectsNoRun(day)) return "восстановление без бега";
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
    const targetWeekKey = planWeekKey || selectedWeekKey();
    const existingJsonPlan = normalizeStoredPlanForWeek(weekPlans(targetWeekKey).sources?.json, targetWeekKey);
    const replacingExistingPlan = Boolean(existingJsonPlan);
    if (planWeekKey && planWeekKey !== selectedWeekKey()) {
      state.selectedWeekStart = planWeekKey;
      saveJson(SELECTED_WEEK_KEY, state.selectedWeekStart);
      renderAll();
    }
    const savedPlan = saveCurrentPlan({
      source: "json",
      summary: plan.summary,
      modelUsed: plan.modelUsed,
      updatedAt: new Date().toISOString(),
      changeLog: replacingExistingPlan
        ? appendPlanChangeLog(existingJsonPlan.changeLog, {
          timestamp: new Date().toISOString(),
          type: "json-reload",
          title: "План из JSON заменен",
          details: `Загружена новая версия плана на неделю ${targetWeekKey}.`,
          fields: ["весь план"],
        })
        : [],
      days: plan.days,
    });
    renderPlan(savedPlan?.days || plan.days);
    updatePlanSourceButtons("json");
    const action = replacingExistingPlan ? "перезагружен и заменил сохраненный план" : "загружен и сохранен";
    setAiStatus(`План из JSON ${action}: ${plan.summary}`, "ok");
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

function getPlanningModeProfile() {
  const modes = {
    conservative: {
      id: "conservative",
      label: "консервативный",
      description: "меньше риск, мягче прирост нагрузки, при сомнениях приоритет восстановления.",
      loadGuidance: "держи недельный объем и TRIMP около текущей переносимой базы или ниже; добавляй не больше одного тяжелого бегового стимула, если есть усталость или рост нагрузки",
      qualityGuidance: "предпочитай контролируемый порог, короткую активацию, легкие горки или сокращенные интервалы; избегай VO2max при сомнениях",
      progressionGuidance: "не повышай недельную нагрузку больше чем на 5-8% относительно средней переносимой недели",
    },
    normal: {
      id: "normal",
      label: "нормальный",
      description: "сбалансированный развивающий план с учетом фактического восстановления.",
      loadGuidance: "если состояние стабильное, планируй развивающую неделю около текущей базы с умеренным приростом; тяжелые стимулы дозируй по восстановлению",
      qualityGuidance: "допускается 1-2 качественных беговых стимула плюс длительная, если последние тренировки и нагрузка это позволяют",
      progressionGuidance: "обычный прирост недельной нагрузки держи примерно в пределах 8-12%, если нет признаков перегруза",
    },
    aggressive: {
      id: "aggressive",
      label: "агрессивный",
      description: "смелее развивающий план, но без нарушения предупреждений по восстановлению.",
      loadGuidance: "можно планировать верхнюю часть допустимого объема и более выраженный стимул, если данные показывают хорошую переносимость",
      qualityGuidance: "можно выбирать более специфичные интервалы, темповую связку или длительную с блоком, но не игнорировать усталость, гонку и hardSafetyRules",
      progressionGuidance: "не превышай примерно 12-18% прироста недельной нагрузки и обязательно смягчай план при высоком acute/chronic ratio или тяжелых днях подряд",
    },
  };
  return modes[state.profile.planningMode] || modes.normal;
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
    workoutTypeSource: workout.workoutTypeOverride ? "manual" : "auto",
  }));
  const planningMode = getPlanningModeProfile();

  return {
    system:
      "Ты опытный тренер по видам спорта на выносливость. Составляй календарный недельный микроцикл с понедельника по воскресенье от текущего тренировочного состояния спортсмена, цели и этапа подготовки preparationPhase. Не используй жесткое расписание по дням: сначала выбери нужные тренировочные стимулы недели, затем разложи их по календарю с учетом восстановления, гонки, предыдущих тренировок и нагрузки. Базовая развивающая неделя обычно содержит 1 скоростной/интервальный стимул, 1 темповый/пороговый/специфический стимул, 1 длительную, легкие кроссы и восстановление, но это ориентир, а не обязанность. Можешь заменять классические интервалы или темпо на бег в гору, фартлек, прогрессивный бег, марафонский темп, strides, силовую, прыжковые упражнения, ОФП/мобилити или кросс-тренинг, если это лучше соответствует состоянию и цели. Если отклоняешься от базовой структуры, объясни причину в rationale. Не перестраховывайся легкими днями по умолчанию, но при признаках перегруза снижай объем/интенсивность и убирай лишние тяжелые стимулы. Не давай медицинских диагнозов и не назначай лечение.",
    context: {
      profile: profileForPlanning(),
      race: getRaceSummary(),
      preparationPhase: getPreparationPhase(),
      planningMode,
      readiness: getReadiness(),
      trainingState: buildTrainingState(),
      load7Days: sumLoad(7),
      load28Days: sumLoad(28),
      previous7DaysLoad: sumLoadRange(8, 14),
      recentWorkouts: recent,
      workoutReference: workoutReferenceForPlanning(),
      workoutTemplates: workoutTemplateLibrary().map(({ toneClass, ...template }) => template),
      workoutAccountingRules: [
        "Все импортированные активности учитывай как нагрузку и фактор восстановления.",
        "Беговые задания плана закрываются только беговыми тренировками.",
        "Небеговые активности не заменяют интервалы, темпо, длительную или легкий бег, но могут требовать снижения оставшихся беговых нагрузок.",
      ],
      weeklyPlanningGuidelines: [
        "Планируй неделю как набор тренировочных стимулов, а не как фиксированный шаблон вторник-суббота-воскресенье.",
        `Режим генерации: ${planningMode.label}. ${planningMode.loadGuidance}. ${planningMode.qualityGuidance}. ${planningMode.progressionGuidance}.`,
        "В нормальной развивающей неделе обычно нужны: один скоростной/интервальный стимул, один темповый/пороговый/специфический стимул, одна длительная, легкие кроссы и восстановление.",
        "Длительная чаще всего удобна в воскресенье, но ее можно перенести, если это лучше по гонке, восстановлению или фактически выполненным тренировкам.",
        "Темповая + длительная в соседние дни допустимы как специфическая связка, но не обязательны каждую неделю.",
        "Если меняешь базовую структуру, явно объясни, почему выбран другой стимул или другой день.",
      ],
      allowedWorkoutTypes: [
        "отдых",
        "восстановительный бег",
        "легкий кросс",
        "длительная",
        "прогрессивный бег",
        "марафонский темп",
        "темповая работа",
        "пороговые интервалы",
        "VO2max / короткие интервалы",
        "длинные интервалы под 10 км / полумарафон",
        "бег в гору",
        "фартлек",
        "ускорения / strides",
        "силовая",
        "прыжковые упражнения",
        "ОФП / мобилити",
        "кросс-тренинг",
      ],
      hardSafetyRules: [
        "Не ставь больше двух тяжелых беговых работ в неделю плюс длительную, если данные не показывают очень хорошую переносимость.",
        "Между тяжелыми беговыми стимулами желательно минимум 48 часов; если меньше, объясни связку и снизь объем.",
        "Силовую и прыжковые упражнения не ставь накануне тяжелой беговой работы или длительной при признаках усталости.",
        "В recovery и taper не добавляй новые тяжелые стимулы; приоритет - свежесть и восстановление.",
        "Небеговые тренировки учитывай как нагрузку, но не считай их заменой ключевой беговой работы.",
      ],
      racePlanningRules: [
        "если race.date попадает в неделю локального плана, день race.date является главным стартом недели",
        "за 1 день до гонки - отдых или короткая разминка, без темпо и интервалов",
        "за 2 дня до гонки - только короткий легкий бег",
        "после гонки - восстановление; не дублировать длительную, темпо или интервалы",
        "если в неделе нет гонки, применяй базовые принципы развивающей недели, но не фиксируй заранее дни ключевых работ",
      ],
      preparationBlockRules: [
        "если preparationPhase.id = base, приоритет аэробный объем, техника, силовая устойчивость; интервалы контролируемые",
        "если preparationPhase.id = speed, интервалы могут быть быстрее/короче, но легкие дни должны реально восстанавливать",
        "если preparationPhase.id = specific, ключевые работы должны быть максимально близки к целевой дистанции спортсмена",
        "если preparationPhase.id = taper, снижай объем и оставляй короткую активацию без накопления усталости",
        "если preparationPhase.id = recovery, неделя восстановительная: без полноценной интервальной и без тяжелой темповой",
      ],
      workoutSpecificationRules: [
        "Используй context.workoutReference как словарь терминов: не смешивай темповую работу, порог, интервалы, VO2max, strides и спринт.",
        "Используй context.workoutTemplates как библиотеку типовых тренировок: выбирай подходящие шаблоны и адаптируй объем/интенсивность под цель, этап и состояние спортсмена.",
        "Если задание заметно отходит от шаблона библиотеки, объясни это в rationale.",
        "details/plannedWorkout должны содержать только задание на тренировку, а не факт выполнения",
        "не возвращай поле actualWorkout и не пиши факт выполнения в details, plannedWorkout или rationale; факт приложение покажет само из импортированных тренировок",
        "для интервальной тренировки details/plannedWorkout должен содержать: разминка; N x дистанция или время отрезка; целевая интенсивность; восстановление между отрезками; заминка",
        "пример интервальной формулировки: разминка 15 минут, затем 6 x 1000 м в усилии 10 км или 3:55-4:05 мин/км при наличии импортированных темпов, восстановление 400 м трусцой, заминка 10 минут",
        "для темповой тренировки details/plannedWorkout должен содержать: разминка; длительность или блоки темпо; интенсивность; восстановление между блоками; заминка",
        "для длительной details/plannedWorkout должен содержать: длительность или диапазон километража, интенсивность, допустимый прогресс/ускорение и питание/питье для длинных целей",
        "для бега в гору, силовой, прыжковых упражнений, ОФП или мобилити укажи конкретные подходы/повторы/длительность, интенсивность и место в неделе относительно беговых работ",
        "если надежного темпа с paceSource нет, задавай интенсивность через RPE, пульсовую зону, усилие гонки или разговорный темп, а не через восстановленный темп",
      ],
    },
    planningWeek: buildPlanningWeek(),
  };
}

function workoutReferenceForPlanning() {
  return {
    runningTypes: {
      recovery: "Восстановительный бег: очень легкий бег для восстановления, RPE 1-2/10, темп не важен.",
      easy: "Легкий бег / easy: спокойный аэробный бег, RPE 2-3/10, свободный разговор предложениями.",
      long: "Длительный бег: продолжительный преимущественно легкий бег для аэробной выносливости, обычно RPE 2-3/10.",
      progressive: "Прогрессивный бег: интенсивность постепенно растет от легкой к заранее заданной более высокой без резкого ускорения.",
      strides: "Strides / ускорения: 10-30 секунд быстро и расслабленно, не спринт, с полным восстановлением.",
      fartlek: "Фартлек: чередование быстрых и легких участков без обязательной строгой дистанции.",
      hillRunning: "Бег в гору: короткие или средние интенсивные отрезки в подъем для силы, техники и экономичности.",
    },
    qualityIntensities: {
      tempoWorkout: "Темповая работа - формат тренировки, а не одна физиологическая зона; может включать порог, соревновательное усилие или специфический темп.",
      threshold: "Пороговое усилие: тяжелое, но устойчивое и контролируемое, RPE 6-7/10, примерно 40-60 минут для свежего подготовленного спортсмена.",
      effort10k: "Усилие 10 км: RPE 7-8/10, разговор почти невозможен, но темп контролируемый.",
      effort5k: "Усилие 5 км: RPE около 8/10, выше порога, обычно в интервальной работе.",
      vo2max: "VO2max-интервалы: повторные отрезки высокой интенсивности примерно 2-5 минут, RPE 8-9/10, это не спринт.",
      shortIntervals: "Короткие интервалы: 30 секунд - 2 минуты, быстрее усилия 5 км, но контролируемо и повторно.",
      sprint: "Спринт: очень короткое почти максимальное или максимальное ускорение; отдельный стимул, не VO2max и не strides.",
    },
    additionalWork: {
      strength: "Силовая: упражнения с внешним сопротивлением или весом тела для силы и устойчивости.",
      plyometrics: "Прыжковые упражнения / плиометрика: короткие взрывные упражнения для беговой экономичности.",
      generalPhysicalPreparation: "ОФП: корпус, баланс, стабильность, силовая выносливость и общая физическая подготовленность.",
      mobility: "Мобилити: контролируемая подвижность суставов и диапазон движения; не тяжелая силовая.",
      crossTraining: "Кросс-тренинг: небеговая аэробная нагрузка; учитывается как нагрузка, но не заменяет ключевую беговую работу автоматически.",
    },
    intensityScale: ["восстановительный", "легкий", "длительный легкий", "порог", "усилие 10 км", "усилие 5 км", "VO2max", "спринт"],
    heartRateZones: {
      z1: "Восстановительная зона: RPE 1-2/10, ниже 60% HRR.",
      z2: "Легкая аэробная зона: RPE 2-3/10, 60-70% HRR.",
      z3: "Умеренная аэробная зона: steady-усилие, RPE 4-5/10, 70-80% HRR.",
      z4: "Пороговая зона: RPE 6-7/10, 80-90% HRR.",
      z5: "Высокая аэробная / VO2max зона: RPE 8-10/10, выше 90% HRR.",
    },
    heartRateCaveat: "Не используй пульсовые зоны как основной контроль коротких ускорений, strides, спринтов и коротких интервалов из-за запаздывания реакции ЧСС.",
  };
}

function workoutTemplateLibrary() {
  return [
    {
      id: "recovery-run",
      type: "восстановление",
      name: "Восстановительный бег или отдых",
      targets: ["5 км", "10 км", "21 км", "42 км"],
      phases: ["base", "speed", "specific", "taper", "recovery"],
      structure: "Отдых либо 20-45 минут очень легко в Z1-Z2, без ускорений и без контроля темпа.",
      useWhen: "После тяжелой работы, гонки, длительной или при признаках накопленной усталости.",
      constraints: "Не закрывает ключевую работу; при усталости лучше выбрать отдых.",
      toneClass: "tone-recovery",
    },
    {
      id: "easy-run",
      type: "кросс",
      name: "Легкий аэробный кросс",
      targets: ["5 км", "10 км", "21 км", "42 км"],
      phases: ["base", "speed", "specific", "taper"],
      structure: "35-75 минут легко в Z2, разговорный темп, ровно; опционально 4-6 x 15 секунд strides при свежих ногах.",
      useWhen: "Для набора объема между ключевыми стимулами и поддержания аэробной базы.",
      constraints: "Не превращать в скрытую темповую работу; strides не делать при усталости.",
      toneClass: "tone-easy",
    },
    {
      id: "threshold-tempo",
      type: "темповая",
      name: "Пороговая темповая работа",
      targets: ["10 км", "21 км", "42 км"],
      phases: ["base", "speed", "specific"],
      structure: "Разминка 15 минут + 2-4 x 8-15 минут в Z4/RPE 6-7, восстановление 3-5 минут легко, заминка 10-15 минут.",
      useWhen: "Когда нужна устойчивость на контролируемо тяжелом усилии без VO2max-нагрузки.",
      constraints: "Не ставить ближе 48 часов к полноценным интервалам, если нет явной причины.",
      toneClass: "tone-threshold",
    },
    {
      id: "race-pace-block",
      type: "специфическая",
      name: "Блок в целевом соревновательном усилии",
      targets: ["10 км", "21 км", "42 км"],
      phases: ["specific", "taper"],
      structure: "Разминка 15 минут, затем 20-50 минут суммарно в целевом усилии дистанции блоками, восстановление легко, заминка 10 минут.",
      useWhen: "В специфическом этапе, чтобы связать аэробный объем с целевым усилием гонки.",
      constraints: "В taper резко сокращать объем; не добавлять темповый финиш перед длительной без причины.",
      toneClass: "tone-10k",
    },
    {
      id: "10k-intervals",
      type: "интервалы",
      name: "Длинные интервалы под 10 км",
      targets: ["5 км", "10 км", "21 км"],
      phases: ["speed", "specific"],
      structure: "Разминка 15-20 минут + 4 x 15 секунд свободно; затем 4-6 x 1000 м или 4-6 x 3-4 минуты в усилии 10 км, восстановление 2-3 минуты легко, заминка 10-15 минут.",
      useWhen: "Для развития скорости, экономичности и способности держать контролируемо высокое усилие.",
      constraints: "Не делать как спринт; при распаде техники сокращать количество повторов.",
      toneClass: "tone-10k",
    },
    {
      id: "vo2max-short-intervals",
      type: "интервалы",
      name: "VO2max / короткие интервалы",
      targets: ["5 км", "10 км"],
      phases: ["speed"],
      structure: "Разминка 15-20 минут; затем 8-12 x 1-2 минуты в усилии 5 км/VO2max, восстановление 1-2 минуты легко, заминка 10-15 минут.",
      useWhen: "Для коротких целей и этапа развития скорости, если восстановление позволяет.",
      constraints: "Не ставить в неделю с перегрузом; пульс не главный контроль из-за запаздывания ЧСС.",
      toneClass: "tone-vo2",
    },
    {
      id: "hill-repeats",
      type: "горки",
      name: "Бег в гору",
      targets: ["5 км", "10 км", "21 км", "42 км"],
      phases: ["base", "speed"],
      structure: "Разминка 15 минут; затем 8-12 x 20-60 секунд в подъем технично и мощно, спуск/трусца до восстановления, заминка 10 минут.",
      useWhen: "Для силы, техники и экономичности без жесткой привязки к темпу.",
      constraints: "Не выполнять максимально; не ставить накануне тяжелой работы или длительной.",
      toneClass: "tone-5k",
    },
    {
      id: "fartlek",
      type: "фартлек",
      name: "Контролируемый фартлек",
      targets: ["5 км", "10 км", "21 км"],
      phases: ["base", "speed", "specific"],
      structure: "45-70 минут всего: после разминки 8-12 чередований 1-3 минуты бодро / 1-3 минуты легко, заминка легко.",
      useWhen: "Когда нужен развивающий стимул без жесткой дорожки и точных отрезков.",
      constraints: "Быстрые части контролируемые; не превращать в гонку.",
      toneClass: "tone-threshold",
    },
    {
      id: "long-run",
      type: "длительная",
      name: "Длительная легкая",
      targets: ["10 км", "21 км", "42 км"],
      phases: ["base", "specific"],
      structure: "75-150 минут преимущественно в Z2; для марафона длительная обычно не короче 100 минут, с питанием/питьем каждые 30-40 минут.",
      useWhen: "Для развития аэробной выносливости и устойчивости к длительной работе.",
      constraints: "Не добавлять финишное темпо при признаках усталости или после тяжелой недели.",
      toneClass: "tone-long",
    },
    {
      id: "long-run-with-block",
      type: "длительная",
      name: "Длительная с целевым блоком",
      targets: ["21 км", "42 км"],
      phases: ["specific"],
      structure: "90-150 минут: основа Z2, внутри или ближе к концу 20-45 минут суммарно в целевом усилии 21/42 км, без рывков.",
      useWhen: "В специфическом этапе при хорошей переносимости предыдущей нагрузки.",
      constraints: "Не ставить после перегруза; следующий день восстановительный.",
      toneClass: "tone-long",
    },
    {
      id: "strength-mobility",
      type: "дополнительно",
      name: "Силовая / ОФП / мобилити",
      targets: ["5 км", "10 км", "21 км", "42 км"],
      phases: ["base", "speed", "specific", "recovery"],
      structure: "20-45 минут: корпус, ягодичные, стопа, баланс, мобилити; 2-4 упражнения по 2-4 подхода без отказа.",
      useWhen: "Для устойчивости, профилактики перегруза и поддержки техники.",
      constraints: "Не ставить тяжелую силовую накануне ключевой беговой работы или длительной.",
      toneClass: "tone-recovery",
    },
  ];
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
      "Сформируй план именно на эти 7 дат с понедельника по воскресенье. Используй фактические тренировки и состояние спортсмена, а не текущий отображаемый план. Не фиксируй заранее дни ключевых работ: выбирай стимулы недели и расставляй их по календарю по восстановлению, цели и гонке.",
  };
}

function profileForPlanning() {
  const { photoDataUrl, ...profile } = state.profile || {};
  return {
    ...profile,
    heartRateZones: heartRateZonesBpm(state.profile).map((zone) => ({
      zone: zone.label,
      range: zone.range,
      purpose: zone.note,
    })),
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
  const rollingDailyLoads = lastDays(7).map((day) =>
    state.workouts
      .filter((workout) => sameDay(new Date(workout.date), day))
      .reduce((sum, workout) => sum + (Number(workout.load) || 0), 0)
  );
  const loadMonotony7Days = describeLoadMonotony(rollingDailyLoads, workouts7);
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
    loadMonotony7Days,
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
    planningMode: getPlanningModeProfile(),
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
  const details = splitDetails.planned || fallbackDay?.details || "Детали не указаны.";
  const focus = normalizedPlanFocus(day, fallbackDay, details);
  const title = normalizedPlanTitle(day, fallbackDay, focus, details);

  return {
    date,
    dateLabel,
    focus,
    title,
    details,
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

function normalizedPlanFocus(day, fallbackDay, details) {
  const explicitFocus = day.focus || fallbackDay?.focus || "План";
  const explicitType = planTypeFromFocus(explicitFocus);
  const assignmentType = planTypeFromAssignment(`${details} ${day.intensity || ""}`);
  if (assignmentType && !explicitType) {
    return focusForPlannedType(assignmentType);
  }
  if (assignmentType && explicitType && assignmentType !== explicitType) {
    return focusForPlannedType(assignmentType);
  }
  return explicitFocus;
}

function normalizedPlanTitle(day, fallbackDay, focus, details) {
  const title = day.title || fallbackDay?.title || "Тренировка";
  const focusType = planTypeFromFocus(focus);
  const titleType = planTypeFromFocus(title);
  if (titleMentionsRun(title) && assignmentHasNoRun(details)) {
    return defaultTitleForPlannedType(focusType || "recovery", details);
  }
  if (titleMentionsStrides(title) && assignmentForbidsStrides(details)) {
    return defaultTitleForPlannedType(focusType || "easy", details);
  }
  if (focusType && titleType && focusType !== titleType) {
    return defaultTitleForPlannedType(focusType, details);
  }
  return title;
}

function planTypeFromFocus(value) {
  const text = String(value || "").toLowerCase();
  if (matchesAny(text, ["гонка", "старт", "race"])) return "race";
  if (matchesAny(text, ["отдых"])) return "rest";
  if (matchesAny(text, ["интервал", "vo2"])) return "interval";
  if (matchesAny(text, ["темпо", "порог", "threshold"])) return "tempo";
  if (matchesAny(text, ["длитель", "long"])) return "long";
  if (matchesAny(text, ["восстанов", "recovery"])) return "recovery";
  if (matchesAny(text, ["кросс", "легк", "аэроб"])) return "easy";
  return "";
}

function planTypeFromAssignment(value) {
  const text = String(value || "").toLowerCase();
  if (matchesAny(text, ["гонка", "старт", "race"])) return "race";
  if (matchesAny(text, ["полный отдых", "день отдыха", "без нагрузки"])) return "rest";
  if (matchesAny(text, ["без дополнительного бегового задания", "без бегового задания"])) return "recovery";
  if (assignmentHasTempoStructure(text)) return "tempo";
  if (assignmentHasIntervalStructure(text)) return "interval";
  if (matchesAny(text, ["длитель", "long"])) return "long";
  if (matchesAny(text, ["восстанов", "очень легко"])) return "recovery";
  if (matchesAny(text, ["легк", "легкого бега", "z1-z2", "z2", "разговорн", "аэроб"])) return "easy";
  return "";
}

function assignmentHasTempoStructure(text) {
  if (matchesAny(text, ["темповая работа", "темповый блок", "темповое включение", "порог", "threshold"])) return true;
  const hasTempoEffort = matchesAny(text, ["марафонск", "полумарафонск", "tempo"]);
  if (!hasTempoEffort) return false;

  const minuteBlocks = [...text.matchAll(/(\d{1,2})\s*[xх×]\s*(\d{1,3}(?:[.,]\d+)?)\s*(мин|минут|минуту)/gi)]
    .map((match) => Number(String(match[2]).replace(",", ".")) || 0);
  return minuteBlocks.some((minutes) => minutes >= 8);
}

function assignmentHasIntervalStructure(text) {
  if (matchesAny(text, ["интервал", "vo2", "повтор", "отрез"])) return true;
  if (matchesAny(text, ["400 м", "800 м", "1000 м"])) return true;

  const repeatPattern = /(\d{1,2})\s*[xх×]\s*(\d{1,4}(?:[.,]\d+)?)\s*(сек|с|мин|минут|минуту|м|метр|км)/gi;
  const blocks = [...text.matchAll(repeatPattern)].map((match) => ({
    repeats: Number(match[1]) || 0,
    value: Number(String(match[2]).replace(",", ".")) || 0,
    unit: match[3],
  }));
  return blocks.some((block) => {
    if (block.repeats < 3) return false;
    if (block.unit.startsWith("сек") || block.unit === "с") return block.repeats >= 6 && block.value >= 30;
    if (block.unit.startsWith("мин")) return block.value >= 1;
    if (block.unit === "м" || block.unit.startsWith("метр")) return block.value >= 200;
    if (block.unit === "км") return block.value >= 0.2;
    return false;
  });
}

function assignmentHasNoRun(value) {
  const text = String(value || "").toLowerCase();
  return matchesAny(text, ["без дополнительного бегового задания", "без бегового задания", "0 км дополнительно"]);
}

function titleMentionsRun(value) {
  const text = String(value || "").toLowerCase();
  return matchesAny(text, ["бег", "кросс", "run"]);
}

function assignmentForbidsStrides(value) {
  const text = String(value || "").toLowerCase();
  return matchesAny(text, ["без ускорений", "без ускорения", "без финишного ускорения", "без длинных ускорений", "не ускоряйтесь", "не добавляйте лишние ускорения"]);
}

function titleMentionsStrides(value) {
  const text = String(value || "").toLowerCase();
  return matchesAny(text, ["ускорен", "strides"]);
}

function focusForPlannedType(type) {
  return {
    race: "Гонка",
    rest: "Отдых",
    interval: "Интервалы",
    tempo: "Темпо",
    long: "Длительная",
    recovery: "Восстановление",
    easy: "Кросс",
  }[type] || "План";
}

function defaultTitleForPlannedType(type, details) {
  const text = String(details || "").toLowerCase();
  if (assignmentHasNoRun(text) && matchesAny(text, ["мобилити", "офп", "растяж"])) return "Мобилити без бега";
  if (assignmentHasNoRun(text)) return "Восстановительный день без бега";
  if (type === "easy" && matchesAny(text, ["ускорен", "strides"]) && !assignmentForbidsStrides(text)) return "Легкий бег с ускорениями";
  return {
    race: "Старт",
    rest: "Отдых",
    interval: "Интервальная работа",
    tempo: "Темповая работа",
    long: "Длительная тренировка",
    recovery: "Восстановительный день",
    easy: "Легкий аэробный бег",
  }[type] || "Тренировка";
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

function exportCurrentPlanJson() {
  const current = loadCurrentPlan();
  if (!current) {
    setAiStatus("Для выбранной недели нет плана для экспорта.", "error");
    showToast("Нет плана для экспорта");
    return;
  }

  const payload = buildExportPlanPayload(current);
  const source = payload.source || "plan";
  const filename = `training_plan_${selectedWeekKey()}_${source}.json`;
  downloadJsonFile(filename, payload);
  setAiStatus(`План экспортирован: ${filename}`, "ok");
  showToast("План экспортирован в JSON");
}

function buildExportPlanPayload(planState) {
  const normalized = normalizeStoredPlan(planState) || planState;
  return {
    summary: normalized.summary || "",
    source: normalized.source || "local",
    modelUsed: normalized.modelUsed || "",
    weekStart: selectedWeekKey(),
    exportedAt: new Date().toISOString(),
    days: (normalized.days || []).map((day) => ({
      date: day.date,
      dateLabel: day.dateLabel,
      focus: day.focus || "",
      title: day.title || "",
      plannedWorkout: day.plannedWorkout || day.details || "",
      targetDistance: day.targetDistance || "",
      intensity: day.intensity || "",
      load: day.load || "",
      rationale: day.rationale || "",
    })),
  };
}

function downloadJsonFile(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  renderProfilePhoto();
  settingsForm.elements.name.value = state.profile.name || "";
  settingsForm.elements.goal.value = state.profile.goal || "Поддержание формы";
  settingsForm.elements.targetDistance.value = state.profile.targetDistance || "10k";
  settingsForm.elements.prepPhase.value = state.profile.prepPhase || "auto";
  settingsForm.elements.planningMode.value = state.profile.planningMode || "normal";
  settingsForm.elements.raceDate.value = state.profile.raceDate || "";
  settingsForm.elements.raceDistance.value = state.profile.raceDistance || "";
  settingsForm.elements.raceName.value = state.profile.raceName || "";
  settingsForm.elements.maxHr.value = state.profile.maxHr || 185;
  settingsForm.elements.restHr.value = state.profile.restHr || 50;
  settingsForm.elements.hrZoneMode.value = state.profile.hrZoneMode === "custom" ? "custom" : "default";
  fillHrZoneBoundaryInputs(effectiveHrZoneBoundaries(state.profile));
  updateHrZoneInputsMode();
  settingsForm.elements.daysPerWeek.value = state.profile.daysPerWeek || 4;
  settingsForm.elements.constraints.value = state.profile.constraints || "";
}

function renderProfilePhoto() {
  const photo = state.profile.photoDataUrl || "";
  if (!profilePhotoPreview) return;
  profilePhotoPreview.innerHTML = photo
    ? `<img src="${photo}" alt="Фото профиля">`
    : "<span>Фото</span>";
  removeProfilePhotoButton.disabled = !photo;
  renderSidebarProfilePhoto();
}

function renderSidebarProfilePhoto() {
  const photo = state.profile.photoDataUrl || "";
  if (!sidebarProfilePhoto) return;
  sidebarProfilePhoto.hidden = !photo;
  sidebarProfilePhoto.innerHTML = photo
    ? `<img src="${photo}" alt="Фото профиля">`
    : "";
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
    let backendStateChanged = false;

    if (hasBackendWorkouts) {
      state.workouts = dedupeWorkouts(payload.workouts).sort((a, b) => new Date(b.date) - new Date(a.date));
      backendStateChanged = state.workouts.length !== payload.workouts.length;
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
      (!hasBackendSelectedWeekStart && state.selectedWeekStart) ||
      backendStateChanged
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

async function refreshPolarStatus() {
  if (!polarStatus) return null;
  try {
    const response = await fetch(`${API_BASE_URL}/api/polar/status`);
    if (!response.ok) throw new Error("status failed");
    const status = await response.json();
    updatePolarUi(status);
    return status;
  } catch {
    updatePolarUi({ configured: false, connected: false, unavailable: true });
    return null;
  }
}

function updatePolarUi(status) {
  if (!polarStatus || !connectPolarButton || !syncPolarButton) return;
  const configured = Boolean(status?.configured);
  const connected = Boolean(status?.connected);
  connectPolarButton.textContent = connected ? "Polar подключен" : "Подключить Polar";
  connectPolarButton.classList.toggle("connected", connected);
  connectPolarButton.disabled = !configured || connected;
  syncPolarButton.disabled = !configured || !connected;

  if (status?.unavailable) {
    polarStatus.textContent = "Backend недоступен";
    polarHint.textContent = "Запустите server.py, чтобы подключить Polar Flow.";
    return;
  }
  if (!configured) {
    polarStatus.textContent = "Не найдены client_id/client_secret";
    polarHint.textContent = "Добавьте данные клиента Polar в секцию polar файла conf.json.";
    return;
  }
  if (!connected) {
    polarStatus.textContent = "Polar Flow не подключен";
    polarHint.textContent = "Нажмите «Подключить Polar» и разрешите доступ к тренировкам.";
    return;
  }

  const lastSync = status.lastSync ? new Date(Number(status.lastSync) * 1000).toLocaleString("ru-RU") : "еще не выполнялась";
  polarStatus.textContent = `Polar Flow подключен · последняя синхронизация: ${lastSync}`;
  polarHint.textContent = "Новые тренировки будут проверяться автоматически, пока приложение открыто.";
}

async function syncPolarWorkouts(options = {}) {
  const status = await refreshPolarStatus();
  if (!status?.connected) return 0;

  if (!options.automatic && polarStatus) {
    polarStatus.textContent = "Синхронизация Polar Flow...";
  }
  if (syncPolarButton) syncPolarButton.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/polar/sync`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Polar sync failed");

    const summary = addWorkouts(Array.isArray(payload.workouts) ? payload.workouts : [], false);
    const folderAccepted = await autoImportKnownWorkoutFiles();
    await enrichKnownCsvWorkouts();

    if (summary.parsed || folderAccepted || payload.savedTcx?.length) {
      persistWorkouts();
      if (options.render !== false) {
        autoAdjustActiveLocalPlanIfNeeded();
        renderAll();
        restoreCurrentPlanOrGenerate();
      }
    }

    if (!options.automatic) {
      showToast(`Polar Flow: получено ${payload.count || 0}, добавлено ${summary.accepted}, TCX ${payload.savedTcx?.length || 0}`);
    }
    return summary.accepted + folderAccepted;
  } catch (error) {
    if (!options.automatic) {
      showToast(`Polar Flow: ${error.message}`);
    }
    return 0;
  } finally {
    await refreshPolarStatus();
  }
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
  const kmh = value <= 7 ? value * 3.6 : value;
  return kmh > 0 ? round(60 / kmh, 2) : null;
}

function paceFromDistanceDuration(distanceKm, durationMin) {
  const distance = numberOrNull(distanceKm);
  const duration = numberOrNull(durationMin);
  if (!distance || !duration) return null;
  return round(duration / distance, 2);
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
  if (validWorkoutType(workout?.workoutTypeOverride)) return workout.workoutTypeOverride;
  return classifyWorkout(workout);
}

function validWorkoutType(type) {
  return WORKOUT_TYPE_OPTIONS.some(([value]) => value !== "auto" && value === type);
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
  return planCompletionWorkoutsForDay(day).length > 0;
}

function actualWorkoutsForPlanDay(day) {
  const planDate = new Date(day.date);
  if (Number.isNaN(planDate.getTime())) return [];
  return dedupeWorkouts(state.workouts
    .filter((workout) => sameDay(new Date(workout.date), planDate))
  ).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function planCompletionWorkoutsForDay(day) {
  const actual = actualWorkoutsForPlanDay(day);
  const plannedType = plannedTypeForDay(day);
  if (planExpectsNoRun(day)) return actual;
  if (plannedTypeAllowsOptionalEasyRun(day)) return actual.filter(isRunningWorkout);
  if (plannedType === "rest") return [];
  if (planTypeRequiresRunning(plannedType)) {
    return actual.filter(isRunningWorkout);
  }
  return actual;
}

function planExpectsNoRun(day) {
  return assignmentHasNoRun(`${day.plannedWorkout || ""} ${day.details || ""} ${day.targetDistance || ""}`);
}

function planTypeRequiresRunning(type) {
  return ["interval", "tempo", "long", "easy", "recovery", "race"].includes(type);
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
