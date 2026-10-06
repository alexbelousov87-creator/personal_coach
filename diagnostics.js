/* Scoped read-only diagnostics. Polling never contacts workout providers. */
(() => {
  const el = id => document.getElementById(id);
  let pending=null, serial=0, owner="";
  const esc=v=>escapeHtml(String(v??""));
  const date=v=>v ? new Date(Number(v)*1000).toLocaleString("ru-RU") : "нет данных";
  const duration=v=>v<60 ? `${Math.round(v)} с` : v<3600 ? `${Math.floor(v/60)} мин` : `${Math.floor(v/3600)} ч ${Math.floor(v%3600/60)} мин`;
  const key=()=>JSON.stringify([state.activeAthleteId,state.auth?.coachId,state.coachProfile?.id,state.currentRole]);
  const visible=()=>el("diagnostics")?.classList.contains("active") && !document.hidden && !(state.auth?.enabled && !state.auth?.authenticated);
  const names={polar:"Polar Flow",runalyze:"Runalyze",strava:"Strava"};
  const labels={running:"Выполняется",success:"Завершено",partial:"Частично",error:"Ошибка",skipped:"Пропущено",interrupted:"Прервано перезапуском"};
  function summary(event) {
    if (!event) return "Попыток в журнале пока нет";
    if (event.state==="running") return event.durationSeconds>120 ? "Выполняется дольше обычного; результат пока неизвестен" : "Синхронизация выполняется";
    if (event.message) return event.message;
    if (event.state==="success" && !event.received) return "Источник не вернул тренировок";
    if (event.state==="success" && !event.added) return "Новых записей нет; совпадения объединены";
    return `Добавлено тренировок: ${event.added||0}`;
  }
  function clear() {
    serial++;pending?.abort();pending=null;owner="";
    el("diagnosticServer").replaceChildren();el("diagnosticSources").replaceChildren();
    el("diagnosticStatus").textContent="";el("diagnosticScope").textContent="";
    el("refreshDiagnostics").disabled=false;
  }
  function render(data) {
    const server=data.server, worker=server.worker;
    el("diagnosticScope").textContent=data.athleteName || "Спортсмен не выбран";
    el("diagnosticStatus").textContent=`Проверено: ${date(data.checkedAt)}`;
    el("diagnosticStatus").classList.remove("error");
    let workerText=worker.state==="disabled" ? "Отключена" : !worker.alive ? "Не запущена" : worker.state==="running" ? "Проверяются источники" : "Ожидает следующего цикла";
    const workerDetail=worker.alive && worker.nextCheckAt ? `Следующая проверка не раньше ${date(worker.nextCheckAt)}` : worker.lastStarted ? `Начало цикла: ${date(worker.lastStarted)}` : "Циклы пока не выполнялись";
    el("diagnosticServer").innerHTML=[
      ["Сервер","Доступен",`Без перезапуска: ${duration(server.uptimeSeconds)}`],
      ["База данных",server.database==="ok"?"Доступна":"Недоступна","Проверка чтения SQLite"],
      ["Фоновая проверка",workerText,workerDetail],
      ["Логирование",server.logging?"Подключено":"Не настроено",server.journalAvailable?"Журнал синхронизации доступен":"Есть проблема записи журнала синхронизации"],
    ].map(([label,value,detail])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`).join("");
    const opened=new Set([...el("diagnosticSources").querySelectorAll("details[open]")].map(d=>d.dataset.providerHistory));
    el("diagnosticSources").innerHTML=data.providers.length ? data.providers.map(p=>{
      const latest=p.events[0], blocked=p.provider==="runalyze" && p.readAccess!=="granted";
      const connection=!p.enabled?"Источник выключен":!p.connected?"Не подключен":blocked?"Чтение не подтверждено":"Подключен";
      const auto=!p.enabled || !p.backgroundEnabled ? "Отключена" : !p.connected || blocked ? "Недоступна до подключения и разрешения чтения" : worker.alive?"Включена":"Ожидает запуска фонового процесса";
      return `<section class="diagnostic-source"><header><h2>${esc(names[p.provider]||p.provider)}</h2><span>${esc(connection)}</span></header>
        <dl><div><dt>Автосинхронизация</dt><dd>${esc(auto)}</dd></div><div><dt>Последнее получение данных</dt><dd>${esc(date(p.lastDataAt))}</dd></div><div><dt>Последняя попытка</dt><dd>${esc(date(latest?.startedAt))}</dd></div></dl>
        <p class="diagnostic-outcome" data-state="${esc(latest?.state||"unknown")}">${esc(summary(latest))}</p>
        <details data-provider-history="${esc(p.provider)}" ${opened.has(p.provider)?"open":""}><summary>Последние попытки (${p.events.length})</summary>
        <div class="diagnostic-events">${p.events.map(e=>`<article><div class="diagnostic-event-head"><strong>${esc(labels[e.state]||"Неизвестно")}</strong><span>${esc(date(e.startedAt))} · ${e.trigger==="background"?"Фоновая":"По запросу"}</span></div>
          <p>${esc(summary(e))}</p><small>${e.finishedAt?`Завершена: ${esc(date(e.finishedAt))} · `:""}Длительность: ${esc(duration(e.durationSeconds))}</small>
          ${["success","partial"].includes(e.state)?`<div class="diagnostic-counts"><span>Получено <b>${e.received}</b></span><span>Добавлено <b>${e.added}</b></span><span>Совпадения <b>${e.duplicates}</b></span><span>TCX <b>${e.tcx}</b></span></div>`:""}</article>`).join("")||'<p class="empty">Сохраненных попыток пока нет.</p>'}</div></details></section>`;
    }).join("") : '<p class="empty">Нет выбранного спортсмена или доступных источников.</p>';
  }
  async function refresh() {
    if (!visible()) return;
    const current=key();
    if (current!==owner) { clear();owner=current; }
    if (pending) return;
    const id=++serial, controller=new AbortController();pending=controller;
    const timeout=setTimeout(()=>controller.abort(),8000);
    el("refreshDiagnostics").disabled=true;
    el("diagnosticStatus").textContent="Проверяем сервер и статусы...";
    try {
      const response=await fetch(`${API_BASE_URL}/api/diagnostics?athleteId=${encodeURIComponent(state.activeAthleteId||"")}`,{signal:controller.signal,cache:"no-store"});
      if (!response.ok) throw new Error(response.status===401?"Войдите в приложение заново.":response.status===403||response.status===404?"Нет доступа к данным спортсмена.":"Сервер отвечает, но диагностика хранилища сейчас недоступна.");
      const data=await response.json();
      if (id!==serial || current!==key() || !visible()) return;
      render(data);
    } catch(error) {
      if (id!==serial || current!==key() || !visible()) return;
      el("diagnosticStatus").textContent=error.name==="AbortError"?"Сервер не ответил за 8 секунд. Повторите проверку.":error instanceof TypeError?"Нет соединения с сервером. Данные состояния недоступны.":error.message;
      el("diagnosticStatus").classList.add("error");
      el("diagnosticServer").replaceChildren();el("diagnosticSources").replaceChildren();
    } finally {
      clearTimeout(timeout);
      if (id===serial) { pending=null;el("refreshDiagnostics").disabled=false; }
    }
  }
  globalThis.Diagnostics={refresh,clear};
  document.addEventListener("DOMContentLoaded",()=>{
    el("refreshDiagnostics").addEventListener("click",refresh);
    setInterval(refresh,10000);
    document.addEventListener("visibilitychange",()=>{if(document.hidden)clear();else refresh();});
  });
})();