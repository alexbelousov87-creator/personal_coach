/* Read-only overview; only the active athlete's already loaded workouts are used. */
(() => {
  const el = id => document.getElementById(id);
  let owner = "", result = null, selected = "";
  const esc = value => escapeHtml(String(value ?? ""));
  const date = (value, year = false) => new Date(value.length === 10 ? value+"T12:00:00" : value).toLocaleDateString("ru-RU", {day:"numeric",month:"short",...(year ? {year:"numeric"} : {})});
  const pace = value => {
    if (value == null) return "нет данных";
    const seconds = Math.round(value*60);
    return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;
  };
  const number = value => value == null ? "нет данных" : value.toLocaleString("ru-RU", {maximumFractionDigits:1});
  const environments = {unspecified:"обычный бег / покрытие не указано",road:"шоссе или стадион",trail:"трейл",indoor:"беговая дорожка / помещение"};
  const reasons = {sport:"Небеговые занятия",uncertain:"Тип требует уточнения",quality:"Интенсивная или смешанная работа",
    pace:"Нет надежного темпа",hr:"Нет надежной средней ЧСС",duration:"Нет подходящей длительности (10–240 мин)",
    type:"Другой тип бега",surface:"Другой вид покрытия",durationMatch:"Другая длительность",hrMatch:"Пульс вне допуска",paceMatch:"Темп вне допуска"};
  function render() {
    if (!el("fitnessTrend")) return;
    if (owner !== state.activeAthleteId) {
      owner = state.activeAthleteId; selected = "";
      el("fitnessReference").replaceChildren();
    }
    const reference = el("fitnessReference").value;
    const workouts = state.workouts.map(w => ({...w, running:isRunningWorkout(w), classification:getWorkoutClassification(w)}));
    result = FitnessTrend.analyze(workouts, {weeks:Number(el("fitnessPeriod").value),mode:el("fitnessMode").value,
      type:el("fitnessType").value,reference});
    el("fitnessScope").textContent = `${activeAthlete()?.name || "Спортсмен"} · ${date(result.start, true)} – ${date(result.end, true)}`;
    el("fitnessReference").innerHTML = result.eligible.length ? '<option value="">Последняя подходящая</option>' + result.eligible.map(w => `<option value="${esc(w.key)}">${esc(date(w.date))} · ${Math.round(w.duration)} мин · ${pace(w.pace)}/км · ЧСС ${Math.round(w.hr)}</option>`).join("") : '<option value="">Нет подходящих тренировок</option>';
    el("fitnessReference").disabled = !result.reference;
    el("fitnessReference").value = result.eligible.some(w=>w.key===reference) ? reference : "";
    const meaningful = ["lower","higher","stable"].includes(result.status);
    const metric = result.mode === "pace" ? "Темп" : "Пульс";
    const unit = result.mode === "pace" ? "мин/км" : "уд/мин";
    const format = value => result.mode === "pace" ? pace(value) : number(value);
    const statuses = {
      different:"Условия двух половин различаются: " + result.conditions.map(key=>({duration:"длительность",hr:"пульс",pace:"темп"}[key])).join(", "),
      empty:"Нет подходящих тренировок", insufficient:"Пока недостаточно сопоставимых дней", stale:"Данные устарели: нет сопоставимых тренировок более 14 дней",
      stable:"Показатель без заметного изменения",
      lower:result.mode === "pace" ? "Темп быстрее при близком пульсе" : "Пульс ниже при близком темпе",
      higher:result.mode === "pace" ? "Темп медленнее при близком пульсе" : "Пульс выше при близком темпе",
    };
    el("fitnessStatus").textContent = statuses[result.status];
    el("fitnessStatus").dataset.status = result.status;
    const delta = result.delta == null ? "" : result.mode === "pace"
      ? `${result.delta>0?"+":""}${number(result.delta*60)} с/км (${result.percent>0?"+":""}${number(result.percent)}%)`
      : `${result.delta>0?"+":""}${number(result.delta)} уд/мин`;
    el("fitnessSummary").innerHTML = [
      ["Первая половина",`${format(result.before[result.mode])}${result.before.days ? " "+unit : ""}`,`${result.before.days} дн. · ${result.before.sessions} тренировок${result.before.days ? ` · ${number(result.before.duration)} мин · ${result.mode==="pace" ? number(result.before.hr)+" уд/мин" : pace(result.before.pace)+" мин/км"}` : ""}`],
      ["Вторая половина",`${format(result.after[result.mode])}${result.after.days ? " "+unit : ""}`,`${result.after.days} дн. · ${result.after.sessions} тренировок${result.after.days ? ` · ${number(result.after.duration)} мин · ${result.mode==="pace" ? number(result.after.hr)+" уд/мин" : pace(result.after.pace)+" мин/км"}` : ""}`],
      ["Изменение медианы",meaningful ? delta : result.status==="different" ? "Условия несопоставимы" : result.status==="stale" ? "Нет свежих данных" : "Недостаточно данных", meaningful ? metric : result.status==="different" ? "Разница медиан условий выше допуска" : result.status==="stale" ? "Последняя сопоставимая старше 14 дней" : "Не менее 3 разных дней в каждой половине"],
    ].map(([label,value,detail])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`).join("");
    const ref = result.reference;
    el("fitnessCriteria").textContent = ref ? `Опора: ${date(ref.date)}, ${Math.round(ref.duration)} мин. Длительность ±20%; ${result.mode==="pace" ? `ЧСС ${ref.hr} ±5 уд/мин` : `темп ${pace(ref.pace)} мин/км ±3%`}; ${environments[ref.surface]}.` : "Для сравнения нужны сохраненные темп, средняя ЧСС и длительность ровного бега.";
    el("fitnessEvidenceCount").textContent = `Выборка: ${result.matched.length} из ${result.total} тренировок`;
    el("fitnessExclusions").innerHTML = Object.entries(result.excluded).map(([key,count])=>`<li>${esc(reasons[key])}: <strong>${count}</strong></li>`).join("") || "<li>Исключенных записей нет.</li>";
    el("fitnessTable").innerHTML = result.matched.length ? `<table><caption class="visually-hidden">Сопоставимые тренировки</caption><thead><tr><th scope="col">Дата</th><th scope="col">Время</th><th scope="col">Темп</th><th scope="col">ЧСС</th></tr></thead><tbody>${result.matched.map(w=>`<tr><th scope="row">${esc(date(w.date))}${w.key===ref.key ? " · опора" : ""}</th><td>${number(w.duration)} мин</td><td>${pace(w.pace)}</td><td>${number(w.hr)}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">Сопоставимых тренировок нет.</p>';
    el("fitnessLegend").hidden = !result.matched.length;
    chart();
  }
  function chart() {
    const r = result, container = el("fitnessChart");
    if (!r.matched.length) { container.replaceChildren(); el("fitnessPoint").textContent=""; return; }
    const values = r.matched.map(w=>r.mode==="pace" ? w.pace*60 : w.hr);
    const min = Math.min(...values), max = Math.max(...values), padding = Math.max((max-min)*.15,r.mode==="pace"?5:2);
    const low = min-padding, high = max+padding;
    const format = value => r.mode==="pace" ? pace(value/60) : number(value);
    const first = new Date(r.start+"T00:00:00").getTime(), end = new Date(r.end+"T23:59:59").getTime();
    container.innerHTML = `<div class="fitness-axis"><span>${esc(format(high))}</span><span>${esc(format((high+low)/2))}</span><span>${esc(format(low))}</span></div>
      <div class="fitness-plot" role="group" aria-label="${r.mode==="pace" ? "Темп, мин/км" : "Пульс, уд/мин"}">
      <div class="fitness-half"></div>${r.matched.map((w,i)=>{
        const x=(w.stamp-first)/(end-first)*100, y=(values[i]-low)/(high-low)*100;
        const label=`${date(w.date)} · ${pace(w.pace)} мин/км · ${w.hr} уд/мин · ${number(w.duration)} мин`;
        return `<button type="button" class="fitness-dot ${w.period}${w.key===r.reference.key ? " reference" : ""}" style="left:${x.toFixed(3)}%;bottom:${y.toFixed(3)}%" data-fitness-point="${i}" aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="${w.key===selected}"></button>`;
      }).join("")}</div><div class="fitness-dates"><span>${esc(date(r.start))}</span><span>${esc(date(r.split))}</span><span>${esc(date(r.end))}</span></div>`;
    const point = r.matched.find(w=>w.key===selected);
    el("fitnessPoint").textContent = point ? `${date(point.date)} · ${number(point.duration)} мин · ${pace(point.pace)} мин/км · ${point.hr} уд/мин` : `${r.mode==="pace" ? "Темп, мин/км" : "Пульс, уд/мин"}`;
  }
  globalThis.FitnessTrendView = {render};
  document.addEventListener("DOMContentLoaded",()=>{
    for (const id of ["fitnessPeriod","fitnessMode","fitnessType"]) el(id).addEventListener("change",()=>{selected="";el("fitnessReference").value="";render();});
    el("fitnessReference").addEventListener("change",()=>{selected="";render();});
    el("fitnessChart").addEventListener("click",event=>{
      const dot=event.target.closest("[data-fitness-point]");
      if (!dot || !result) return;
      selected=result.matched[Number(dot.dataset.fitnessPoint)]?.key || "";
      for (const node of el("fitnessChart").querySelectorAll("button")) node.setAttribute("aria-pressed",String(node===dot));
      const point=result.matched.find(w=>w.key===selected);
      el("fitnessPoint").textContent=point ? `${date(point.date)} · ${number(point.duration)} мин · ${pace(point.pace)} мин/км · ${point.hr} уд/мин` : "";
    });
  });
})();