(function (root) {
  "use strict";
  const labels = { focus: "Тип", title: "Название", plannedWorkout: "Задание", targetDistance: "Дистанция",
    intensity: "Интенсивность", load: "Нагрузка", rationale: "Обоснование", plannedStructure: "Структура" };
  function value(day, key) {
    if (key === "plannedWorkout") return String(day?.plannedWorkout || day?.details || "");
    if (key === "plannedStructure") return day?.plannedStructure ? JSON.stringify(day.plannedStructure) : "";
    return String(day?.[key] || "");
  }
  function changes(before, after) {
    return (after?.days || []).map((day, index) => ({
      date: day.date, fields: Object.entries(labels).filter(([key]) => value(before?.days?.[index], key) !== value(day, key))
        .map(([key, label]) => ({ key, label, before: value(before?.days?.[index], key), after: value(day, key) })),
    })).filter(day => day.fields.length);
  }
  const api = { changes };
  if (typeof module === "object" && module.exports) { module.exports = api; return; }
  root.PlanHistory = api;
  let pending = null, serial = 0, busy = false;
  const el = id => document.getElementById(id);
  const html = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function scope() { return { athleteId: state.activeAthleteId, viewWeek: selectedWeekKey(), activeSource: loadCurrentPlan()?.source || "" }; }
  function valid(context) {
    const current = scope();
    return isCoachRole() && current.athleteId === context.athleteId && current.viewWeek === context.viewWeek &&
      current.activeSource === context.activeSource;
  }
  function error(message = "") { el("planRevisionError").textContent = message; el("planRevisionError").hidden = !message; }
  function close() {
    if (busy) return;
    serial++; pending = null; el("planRevisionDialog").close();
  }
  function openDialog(title) {
    el("planRevisionTitle").textContent = title;
    el("planRevisionList").replaceChildren();
    el("planRevisionDiff").replaceChildren();
    el("planRevisionMore").hidden = true;
    el("planRevisionApply").hidden = true;
    el("planRevisionReason").value = "";
    error();
    el("planRevisionDialog").showModal();
  }
  function display(field, value) {
    if (field === "plannedStructure" && value) {
      try { return PlanStructure.format(JSON.parse(value)) || value; } catch { return value; }
    }
    return value;
  }
  function diff(before, after) {
    const rows = changes(before, after);
    const summaryChanged = String(before?.summary || "") !== String(after?.summary || "");
    const summary = summaryChanged ? `<div class="revision-field"><strong>Описание недели</strong><div><span>Было</span><p>${html(before?.summary || "Нет плана")}</p></div><div><span>Станет</span><p>${html(after?.summary || "")}</p></div></div>` : "";
    el("planRevisionDiff").innerHTML = summary + rows.map(day => `<section class="revision-day">
      <h3>${html(new Date(day.date).toLocaleDateString("ru-RU", {weekday:"long",day:"numeric",month:"long"}))}</h3>
      ${day.fields.map(field => `<div class="revision-field"><strong>${html(field.label)}</strong>
        <div><span>Было</span><p>${html(display(field.key, field.before) || "Не задано")}</p></div>
        <div><span>Станет</span><p>${html(display(field.key, field.after) || "Не задано")}</p></div></div>`).join("")}
      </section>`).join("") || '<p class="empty">Задания совпадают с текущим планом.</p>';
    return Boolean(rows.length || summaryChanged);
  }
  api.review = function (candidate, reason, week = selectedWeekKey()) {
    if (!requireCoachForPlanChanges()) return;
    const base = weekPlans(week).sources?.[candidate.source] || null;
    const context = scope();
    pending = { ...context, mode: "review", week, source: candidate.source, basePlan: clone(base), plan: clone(candidate) };
    serial++;
    openDialog("Подтвердить изменения плана");
    el("planRevisionScope").textContent = (activeAthlete()?.name || "") + " · " + week + " · " + planSourceLabel(candidate.source);
    el("planRevisionReason").value = reason;
    el("planRevisionApply").textContent = "Применить изменения";
    el("planRevisionApply").hidden = !diff(base, candidate);
  };
  api.open = async function () {
    if (!requireCoachForPlanChanges()) return;
    const current = loadCurrentPlan();
    if (!current) { setAiStatus("Для выбранной недели нет сохраненного плана.", ""); return; }
    const context = { ...scope(), mode: "history", week: selectedWeekKey(), source: current.source, versions: [] };
    pending = context;
    const request = ++serial;
    openDialog("История версий плана");
    el("planRevisionScope").textContent = (activeAthlete()?.name || "") + " · " + context.week + " · " + planSourceLabel(context.source);
    el("planRevisionDiff").textContent = "Загрузка версий...";
    await load(context, request);
  };
  async function load(context, request, before = null) {
    if (context.loading) return;
    context.loading = true; el("planRevisionMore").disabled = true;
    try {
      const query = new URLSearchParams({ athleteId: context.athleteId, week: context.week, source: context.source });
      if (before) query.set("before", before);
      const response = await fetch(API_BASE_URL + "/api/plan/history?" + query);
      const data = await response.json();
      if (pending !== context || request !== serial || !valid(context)) return;
      if (!response.ok) throw new Error(data.error || "Не удалось загрузить историю.");
      if (before && context.fingerprint !== data.currentFingerprint) throw new Error("План изменился. Откройте историю заново.");
      context.currentPlan = data.currentPlan;
      context.fingerprint = data.currentFingerprint;
      context.versions.push(...data.versions);
      context.nextBefore = data.nextBefore;
      el("planRevisionList").innerHTML = context.versions.map(v => `<button class="ghost-btn" type="button" data-revision-id="${v.id}">
        <strong>Версия ${v.number}</strong><span>${html(new Date(v.createdAt).toLocaleString("ru-RU"))}</span>
        <small>${html(v.actor)} · ${html(v.reason)}</small>${v.fingerprint === context.fingerprint ? "<small>Совпадает с текущим планом</small>" : ""}</button>`).join("");
      el("planRevisionMore").hidden = !context.nextBefore;
      if (!before) el("planRevisionDiff").innerHTML = "<p>Версий: " + context.versions.length + (context.nextBefore ? "+" : "") + "</p>";
    } catch (e) { if (pending === context && request === serial) error(e.message); }
    finally { context.loading = false; if (pending === context) el("planRevisionMore").disabled = false; }
  }
  async function apply() {
    const context = pending;
    if (!context || busy) return;
    if (!valid(context)) { error("Спортсмен, неделя или источник изменились. Откройте окно заново."); return; }
    if (context.mode === "history" && !context.versionId) return;
    const body = { athleteId: context.athleteId, week: context.week, source: context.source, timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      reason: el("planRevisionReason").value.trim() || "Подтвержденная корректировка" };
    if (context.mode === "history") Object.assign(body, {versionId:context.versionId,expectedFingerprint:context.fingerprint});
    else Object.assign(body, {basePlan:context.basePlan,plan:context.plan});
    busy = true; el("planRevisionApply").disabled = true; error();
    try {
      const response = await fetch(API_BASE_URL + "/api/plan/apply", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить план.");
      if (!valid(context)) return;
      // Refresh all athlete data before the existing renderer persists normalized state.
      if (!(await loadBackendState())) throw new Error("План сохранен, но не удалось обновить данные. Обновите страницу.");
      if (state.activeAthleteId !== context.athleteId || !isCoachRole()) return;
      state.selectedWeekStart = context.week;
      state.activePlanSource = context.source;
      saveCurrentPlan(data.plan, false);
      renderAll();
      renderPlan(data.plan.days.map((day,index)=>normalizePlanDay(day,day,index)));
      updatePlanSourceButtons(context.source);
      setAiStatus(context.mode === "history" ? "Версия восстановлена как новый план. История сохранена." : "Изменения подтверждены и сохранены.", "ok");
      busy = false; close();
    } catch (e) { error(e.message); }
    finally { busy = false; el("planRevisionApply").disabled = false; }
  }
  document.addEventListener("DOMContentLoaded", () => {
    el("planHistoryButton").addEventListener("click", api.open);
    el("planRevisionClose").addEventListener("click", close);
    el("planRevisionCancel").addEventListener("click", close);
    el("planRevisionDialog").addEventListener("cancel", e => { e.preventDefault(); close(); });
    el("planRevisionApply").addEventListener("click", apply);
    el("planRevisionMore").addEventListener("click", () => { if (pending?.nextBefore) load(pending, serial, pending.nextBefore); });
    el("planRevisionList").addEventListener("click", e => {
      const button = e.target.closest("[data-revision-id]");
      if (!button || !pending || busy) return;
      const version = pending.versions.find(v => v.id === Number(button.dataset.revisionId));
      if (!version) return;
      pending.versionId = version.id;
      el("planRevisionReason").value = "Возврат к версии " + version.number;
      el("planRevisionApply").textContent = "Восстановить как новую версию";
      el("planRevisionApply").hidden = !diff(pending.currentPlan, version.plan);
      for (const item of el("planRevisionList").querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button));
    });
  });
})(globalThis);
