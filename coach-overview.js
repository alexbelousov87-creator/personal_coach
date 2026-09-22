/* Coach roster: isolated read-only summaries, never a global athlete switch. */
(() => {
  const root = document.querySelector("#students");
  const results = document.querySelector("#studentsResults");
  const status = document.querySelector("#studentsStatus");
  const totals = document.querySelector("#studentsTotals");
  const search = document.querySelector("#studentSearch");
  const attention = document.querySelector("#studentsAttention");
  const sort = document.querySelector("#studentsSort");
  const refreshButton = document.querySelector("#refreshStudents");
  let payload = null;
  let requestId = 0;
  let controller = null;
  let loadedKey = "";
  let loadingKey = "";
  let loadedAt = 0;
  const esc = (value) => escapeHtml(String(value ?? ""));
  const number = (value) => Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const dateLabel = (value, time = false) => {
    if (!value) return "нет данных";
    const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    if (Number.isNaN(parsed.getTime())) return "нет данных";
    return parsed.toLocaleString("ru-RU", time
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric" });
  };
  const reasons = {
    missing_plan: "Нет плана на неделю", days_without_fact: "Прошедшие задания без факта",
    fatigue: "Повышенная усталость", sync: "Проверить синхронизацию", no_workouts: "Нет тренировок",
  };
  const providerNames = { polar: "Polar", runalyze: "Runalyze", strava: "Strava" };
  const syncLabels = {
    connected: "Подключено", not_connected: "Не подключено", disabled: "Отключено",
    needs_permission: "Не подтверждено чтение", error: "Ошибка проверки",
    stale: "Проверка более суток назад", waiting: "Ещё не синхронизировано",
  };
  function clear() {
    requestId += 1;
    controller?.abort();
    payload = null;
    loadedKey = loadingKey = "";
    loadedAt = 0;
    results.replaceChildren();
    totals.replaceChildren();
    status.textContent = "";
    search.value = "";
    attention.checked = false;
    refreshButton.disabled = false;
    results.setAttribute("aria-busy", "false");
  }
  function render() {
    if (!payload || !isCoachRole()) return;
    const all = payload.athletes;
    totals.innerHTML = [
      ["Всего учеников", all.length], ["Требуют внимания", all.filter((a) => a.attention.length).length],
      ["С планом на неделю", all.filter((a) => a.plan.available).length],
      ["С тренировками за неделю", all.filter((a) => a.week.sessions).length],
    ].map(([label, count]) => `<div><span>${label}</span><strong>${count}</strong></div>`).join("");
    const query = search.value.trim().toLocaleLowerCase("ru");
    const rows = all.filter((a) => a.name.toLocaleLowerCase("ru").includes(query) && (!attention.checked || a.attention.length));
    rows.sort((a, b) => {
      if (sort.value === "attention") return b.attention.length - a.attention.length || a.name.localeCompare(b.name, "ru");
      if (sort.value === "latest") return String(b.lastWorkout?.date || "").localeCompare(String(a.lastWorkout?.date || "")) || a.name.localeCompare(b.name, "ru");
      return a.name.localeCompare(b.name, "ru");
    });
    status.textContent = `Показано ${rows.length} из ${all.length} · Обновлено ${dateLabel(payload.generatedAt, true)}`;
    if (!rows.length) {
      results.innerHTML = `<p class="roster-empty">${all.length ? "Ученики не найдены." : "Ученики ещё не добавлены."}</p>`;
      return;
    }
    results.innerHTML = `<table class="roster-table"><caption class="visually-hidden">Сводка учеников</caption><thead><tr>
      <th scope="col">Ученик</th><th scope="col">Последняя тренировка</th><th scope="col">Неделя: план / факт</th><th scope="col">Самочувствие</th><th scope="col">План</th><th scope="col">Синхронизация</th><th scope="col">Открыть</th>
      </tr></thead><tbody>${rows.map((a) => {
        const fatigue = a.fatigue;
        const fatigueText = fatigue.value == null ? "Не указано" : subjectiveFatigueLabel(fatigue.value);
        return `<tr>
          <td data-label="Ученик"><strong>${esc(a.name)}</strong><small>${esc(targetDistanceLabel(a.targetDistance))}</small><div class="roster-reasons">${a.attention.map((reason) => `<span>${esc(reasons[reason])}</span>`).join("")}</div></td>
          <td data-label="Последняя тренировка">${a.lastWorkout ? `<strong>${esc(dateLabel(a.lastWorkout.date))}</strong><small>${esc(a.lastWorkout.sport)} · ${number(a.lastWorkout.durationMin)} мин${a.lastWorkout.distanceKm ? ` · ${number(a.lastWorkout.distanceKm)} км` : ""}</small>` : `<span class="roster-muted">Нет тренировок</span>`}</td>
          <td data-label="Неделя: план / факт"><strong>${a.plan.available ? `${a.week.completedDays} / ${a.week.plannedDays} дней с фактом` : "Без плана"}</strong>
          ${a.plan.available && a.week.plannedDays ? `<progress value="${a.week.completedDays}" max="${a.week.plannedDays}" aria-label="Дни плана с фактом"></progress>` : ""}
          <small>${a.week.sessions} тренировок · ${number(a.week.runKm)} км бега · ${number(a.week.load)} TRIMP</small>
          ${a.week.overdueDays ? `<small class="roster-warning">Прошедших дней без факта: ${a.week.overdueDays}</small>` : ""}</td>
          <td data-label="Самочувствие"><strong class="${fatigue.fresh && fatigue.value >= 4 ? "roster-warning" : ""}">${esc(fatigueText)}</strong>${fatigue.updatedAt ? `<small>${esc(dateLabel(fatigue.updatedAt))}${fatigue.fresh ? "" : " · устарело"}</small>` : ""}</td>
          <td data-label="План"><span class="roster-badge ${a.plan.available ? "ready" : "missing"}">${a.plan.available ? "На неделю" : "Нет плана"}</span>${a.plan.available ? `<small>${esc({ json: "Из JSON", ai: "От ИИ", local: "Локальный" }[a.plan.source] || a.plan.source)}</small>` : ""}</td>
          <td data-label="Синхронизация">${a.integrations.length ? a.integrations.map((item) => `<div class="roster-provider"><strong>${esc(providerNames[item.provider])}</strong><small class="${["stale", "error", "needs_permission"].includes(item.status) ? "roster-warning" : ""}">${esc(syncLabels[item.status] || "Нет данных")}</small>${item.lastSync ? `<small>${esc(dateLabel(item.lastSync, true))}</small>` : ""}</div>`).join("") : `<span class="roster-muted">Не подключена</span>`}</td>
          <td data-label="Открыть"><div class="roster-actions"><button type="button" class="ghost-btn" data-roster-id="${esc(a.id)}" data-roster-view="plan">План</button><button type="button" class="ghost-btn" data-roster-id="${esc(a.id)}" data-roster-view="settings">Профиль</button></div></td>
        </tr>`;
      }).join("")}</tbody></table>`;
  }
  async function refresh(force = false) {
    if (!isCoachRole() || !root.classList.contains("active")) return;
    const key = `${state.auth.coachId || state.coachProfile?.id}|${selectedWeekKey()}|${toDateInputValue(new Date())}`;
    if (!force && (loadingKey === key || (loadedKey === key && Date.now() - loadedAt < 60000))) return;
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    const signal = controller.signal;
    const timeout = setTimeout(() => { if (requestId === current) controller.abort(); }, 15000);
    loadingKey = key;
    payload = null;
    results.replaceChildren();
    totals.replaceChildren();
    refreshButton.disabled = true;
    results.setAttribute("aria-busy", "true");
    document.querySelector("#studentsPeriod").textContent = `${dateLabel(selectedWeekKey())} - ${dateLabel(toDateInputValue(addDays(selectedWeekStartDate(), 6)))}`;
    status.textContent = "Загрузка сводки учеников...";
    try {
      const query = new URLSearchParams({ week: selectedWeekKey(), today: toDateInputValue(new Date()), utcOffsetMinutes: String(-selectedWeekStartDate().getTimezoneOffset()) });
      const response = await fetch(`${API_BASE_URL}/api/coach/overview?${query}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Сессия завершена. Войдите снова." : response.status === 403 ? "Раздел доступен только тренеру." : "Не удалось загрузить сводку. Повторите обновление.");
      const data = await response.json();
      if (current !== requestId || !isCoachRole()) return;
      payload = data;
      loadedKey = key;
      loadedAt = Date.now();
      render();
    } catch (error) {
      if (current === requestId && isCoachRole()) status.textContent = error.name === "AbortError" ? "Сервер не ответил вовремя. Повторите обновление." : error.message;
    } finally {
      clearTimeout(timeout);
      if (current === requestId) {
        loadingKey = "";
        refreshButton.disabled = false;
        results.setAttribute("aria-busy", "false");
      }
    }
  }
  results.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-roster-id]");
    if (!button || !isCoachRole()) return;
    const coachId = state.auth.coachId;
    const week = selectedWeekKey();
    button.disabled = true;
    await loadBackendState();
    if (!isCoachRole() || state.auth.coachId !== coachId) return;
    if (!state.athletes.some((a) => a.id === button.dataset.rosterId)) {
      status.textContent = "Ученик больше недоступен. Обновите сводку.";
      button.disabled = false;
      return;
    }
    selectAthlete(button.dataset.rosterId);
    if (button.dataset.rosterView === "plan") selectWeek(week);
    showView(button.dataset.rosterView);
    button.disabled = false;
  });
  refreshButton.addEventListener("click", () => refresh(true));
  document.querySelector("#addRosterStudent").addEventListener("click", () => { if (isCoachRole()) openStudentModal(); });
  search.addEventListener("input", render);
  attention.addEventListener("change", render);
  sort.addEventListener("change", render);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  globalThis.CoachOverview = { refresh, clear };
})();
