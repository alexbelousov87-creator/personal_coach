/* Read-only overview. Preferences are local and isolated by coach and athlete. */
(() => {
  const el = id => document.getElementById(id);
  let owner = "", prefs = null, result = null, selected = "", storageAvailable = true;
  const memory = new Map();
  let suggestibleSurfaces = new Set();
  const esc = value => escapeHtml(String(value ?? ""));
  const date = (value, year = false) => new Date(value.length === 10 ? value+"T12:00:00" : value).toLocaleDateString("ru-RU", {day:"numeric",month:"short",...(year ? {year:"numeric"} : {})});
  const pace = value => {
    if (value == null) return "нет данных";
    const seconds = Math.round(value*60);
    return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;
  };
  const number = value => value == null ? "нет данных" : value.toLocaleString("ru-RU", {maximumFractionDigits:1});
  const environments = {unspecified:"покрытие не указано",road:"шоссе",track:"стадион",treadmill:"беговая дорожка",indoor:"помещение",trail:"трейл"};
  const reasons = {sport:"Небеговое занятие",uncertain:"Тип требует уточнения",quality:"Интенсивная или смешанная работа",
    pace:"Нет надежного импортированного темпа",hr:"Нет надежной средней ЧСС",duration:"Длительность вне 10–240 мин",
    type:"Другой тип бега",surface:"Другое покрытие",durationMatch:"Длительность вне диапазона",hrMatch:"ЧСС вне диапазона",paceMatch:"Темп вне диапазона"};
  const normalizedWorkouts = () => state.workouts.map(w => ({...w,running:isRunningWorkout(w),classification:getWorkoutClassification(w)}));
  const settingsKey = () => "runflow:aerobic:v2:"+JSON.stringify([state.auth?.coachId || state.coachProfile?.id || "",state.activeAthleteId || ""]);
  function save() {
    memory.set(owner,prefs);
    try { localStorage.setItem(owner,JSON.stringify(prefs)); storageAvailable=true; }
    catch { storageAvailable=false; }
  }
  function load() {
    let value=memory.get(owner);
    try { value ||= JSON.parse(localStorage.getItem(owner) || "null"); } catch { storageAvailable=false; }
    prefs={weeks:value?.weeks===12 ? 12 : 8,mode:value?.mode==="hr" ? "hr" : "pace",
      type:["easy","recovery","long"].includes(value?.type) ? value.type : "easy",criteria:{}};
    for (const type of ["easy","recovery","long"]) if (value?.criteria?.[type]) prefs.criteria[type]=FitnessTrend.normalizeCriteria(value.criteria[type]);
    el("fitnessPeriod").value=String(prefs.weeks); el("fitnessMode").value=prefs.mode; el("fitnessType").value=prefs.type;
  }
  function setInputs(criteria) {
    el("fitnessSurface").value=criteria.surface;
    el("fitnessDuration").value=criteria.duration;
    el("fitnessHr").value=criteria.hr;
    el("fitnessPace").value=pace(criteria.pace);
    el("fitnessPace").setCustomValidity("");
    el("fitnessHrLabel").hidden=prefs.mode!=="pace";
    el("fitnessPaceLabel").hidden=prefs.mode!=="hr";
  }
  function render() {
    if (!el("fitnessTrend")) return;
    if (owner!==settingsKey()) { owner=settingsKey(); selected=""; load(); }
    const workouts=normalizedWorkouts();
    if (!prefs.criteria[prefs.type]) {
      // Freeze the initial suggestion once data exists, never on an empty loading state.
      const suggestion=FitnessTrend.suggestCriteria(workouts,{type:prefs.type,weeks:12});
      if (suggestion && state.activeAthleteId) { prefs.criteria[prefs.type]=suggestion; save(); }
    }
    const criteria=FitnessTrend.normalizeCriteria(prefs.criteria[prefs.type]);
    result=FitnessTrend.analyze(workouts,{weeks:prefs.weeks,mode:prefs.mode,type:prefs.type,criteria});
    setInputs(criteria);
    el("fitnessScope").textContent=`${activeAthlete()?.name || "Спортсмен"} · ${date(result.start,true)} – ${date(result.end,true)}`;
    const meaningful=["lower","higher","stable","variable"].includes(result.status);
    const unit=result.mode==="pace" ? "мин/км" : "уд/мин";
    const format=value=>result.mode==="pace" ? pace(value) : number(value);
    const statuses={
      different:"Сравнение ограничено: различаются " + result.conditions.map(key=>({duration:"длительность",hr:"средняя ЧСС",pace:"темп"}[key])).join(", "),
      empty:"Нет тренировок по выбранным критериям",insufficient:"Пока недостаточно сопоставимых дней",stale:"Нет свежих сопоставимых данных за последние 14 дней",
      stable:"Показатель без заметного изменения",variable:"Разница медиан не превышает обычный разброс данных",
      lower:result.mode==="pace" ? "Темп быстрее при близкой ЧСС" : "ЧСС ниже при близком темпе",
      higher:result.mode==="pace" ? "Темп медленнее при близкой ЧСС" : "ЧСС выше при близком темпе",
    };
    el("fitnessStatus").textContent=statuses[result.status];
    const firstEnd=new Date(result.split+"T12:00:00"); firstEnd.setDate(firstEnd.getDate()-1);
    const previousEnd=firstEnd.toLocaleDateString("ru-RU",{day:"numeric",month:"short"});
    const delta=result.delta==null ? "" : result.mode==="pace"
      ? `${result.delta>0?"+":""}${number(result.delta*60)} с/км (${result.percent>0?"+":""}${number(result.percent)}%)`
      : `${result.delta>0?"+":""}${number(result.delta)} уд/мин`;
    el("fitnessSummary").innerHTML=[
      [`${date(result.start)} – ${previousEnd}`,`${format(result.before[result.mode])}${result.before.days ? " "+unit : ""}`,summaryDetail(result.before)],
      [`${date(result.split)} – ${date(result.end)}`,`${format(result.after[result.mode])}${result.after.days ? " "+unit : ""}`,summaryDetail(result.after)],
      ["Разница медиан",meaningful ? delta : "Без вывода",meaningful ? "Наблюдение, не оценка общей формы" : result.status==="different" ? "Контрольные показатели несопоставимы" : result.status==="stale" ? "Выборка устарела" : "Нужно минимум 3 дня в каждом периоде"],
    ].map(([label,value,detail])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`).join("");
    el("fitnessCriteria").textContent=`${prefs.criteria[prefs.type] ? "Фиксированная выборка" : "Стандартные критерии"}: ${number(criteria.duration*.8)}–${number(criteria.duration*1.2)} мин · ${result.mode==="pace" ? `ЧСС ${number(criteria.hr-5)}–${number(criteria.hr+5)} уд/мин` : `темп ${pace(criteria.pace*.97)}–${pace(criteria.pace*1.03)} мин/км`} · ${environments[criteria.surface]}.`;
    el("fitnessFreshness").textContent=`${result.matched.length} из ${result.total} тренировок · ${result.before.days+result.after.days} разных дней${result.latestDay ? ` · последняя ${date(result.latestDay)}` : ""}. ${criteria.surface==="unspecified" ? "Покрытие неизвестно; одинаковые условия не подтверждены. " : ""}${storageAvailable ? "Критерии сохранены в этом браузере отдельно для спортсмена." : "Хранилище браузера недоступно: критерии сохраняются только до закрытия страницы."}`;
    suggestibleSurfaces=new Set(FitnessTrend.analyze(workouts,{type:prefs.type,weeks:12}).eligible.map(w=>w.surface));
    el("fitnessSuggest").disabled=!suggestibleSurfaces.has(criteria.surface);
    el("fitnessEvidenceCount").textContent=`Состав выборки: ${result.matched.length} включено, ${result.excludedRecords.length} исключено`;
    const rows=result.matched.slice().reverse().map(w=>({...w,reason:""}));
    el("fitnessTable").innerHTML=table(rows,false);
    el("fitnessExcludedTable").innerHTML=table(result.excludedRecords,true);
    el("fitnessExclusions").innerHTML=Object.entries(result.excluded).map(([key,count])=>`<li>${esc(reasons[key])}: <strong>${count}</strong></li>`).join("") || "<li>Исключенных записей нет.</li>";
    el("fitnessWeeklyTable").innerHTML=`<table><caption class="visually-hidden">Недельные медианы и разброс</caption><thead><tr><th>Неделя</th><th>Дни</th><th>Медиана, ${unit}</th><th>Разброс 25–75%</th></tr></thead><tbody>${result.weekly.map(w=>`<tr><th scope="row">${esc(date(w.weekStart))}${w.partial ? " *" : ""}</th><td>${w.days}</td><td>${w.value==null ? "Нет данных" : esc(format(w.value))}</td><td>${w.q1==null ? "Недостаточно дней" : `${esc(format(w.q1))}–${esc(format(w.q3))}`}</td></tr>`).join("")}</tbody></table>`;
    el("fitnessLegend").hidden=!result.matched.length;
    el("fitnessAxisTitle").textContent=result.mode==="pace" ? "Темп, мин/км · быстрее выше" : "ЧСС, уд/мин · ниже пульс выше";
    el("fitnessAxisTitle").hidden=!result.matched.length;
    chart();
  }
  function summaryDetail(s) {
    return `${s.days} дн. · ${s.sessions} тренировок${s.days ? ` · ${number(s.duration)} мин · ${result.mode==="pace" ? number(s.hr)+" уд/мин" : pace(s.pace)+" мин/км"}` : ""}`;
  }
  function table(rows, excluded) {
    if (!rows.length) return `<p class="fitness-note">${excluded ? "Исключенных записей нет." : "Сопоставимых тренировок нет."}</p>`;
    return `<table><caption class="visually-hidden">${excluded ? "Исключенные" : "Включенные"} тренировки</caption><thead><tr><th>Дата</th><th>Данные</th><th>${excluded ? "Причина исключения" : "Основание отбора"}</th></tr></thead><tbody>${rows.map(w=>`<tr><th scope="row">${esc(date(w.date))}</th><td>${esc(w.sport)}<br>${Number.isFinite(w.duration)&&w.duration>0 ? number(w.duration)+" мин" : "Время неизвестно"} · ${Number.isFinite(w.hr)&&w.hr>0 ? number(w.hr)+" уд/мин" : "ЧСС неизвестна"}${!excluded ? " · "+pace(w.pace)+" мин/км" : ""}</td><td>${esc(excluded ? reasons[w.reason] : "Тип и показатели в диапазоне; "+environments[w.surface])}</td></tr>`).join("")}</tbody></table>`;
  }
  function chart() {
    const r=result,container=el("fitnessChart");
    if (!r.matched.length) { container.innerHTML='<p class="fitness-empty">Для графика нет сопоставимых тренировок.</p>'; el("fitnessPoint").textContent=""; return; }
    const values=r.matched.map(w=>w[r.mode]);
    const min=Math.min(...values),max=Math.max(...values),padding=Math.max((max-min)*.15,r.mode==="pace"?5/60:2);
    const low=min-padding,high=max+padding;
    const format=value=>r.mode==="pace" ? pace(value) : number(value);
    const first=new Date(r.start+"T00:00:00").getTime(),end=new Date(r.end+"T23:59:59").getTime();
    const x=stamp=>3+94*(stamp-first)/(end-first), y=value=>100*(value-low)/(high-low);
    const weekPosition=w=>{
      const left=Math.max(first,new Date(w.weekStart+"T00:00:00").getTime());
      const right=Math.min(end,new Date(w.weekEnd+"T23:59:59").getTime());
      return {left:x(left),right:x(right),center:x((left+right)/2)};
    };
    const bands=r.weekly.filter(w=>w.q1!=null).map(w=>{
      const p=weekPosition(w);
      return `<rect class="fitness-band" x="${p.left}" width="${p.right-p.left}" y="${y(w.q1)}" height="${Math.max(.5,y(w.q3)-y(w.q1))}"/>`;
    }).join("");
    const lines=r.weekly.map((w,i)=>{
      const prev=r.weekly[i-1];
      if (!prev || prev.days<2 || w.days<2) return "";
      return `<line class="fitness-line" x1="${weekPosition(prev).center}" y1="${y(prev.value)}" x2="${weekPosition(w).center}" y2="${y(w.value)}"/>`;
    }).join("");
    container.innerHTML=`<div class="fitness-axis"><span>${esc(format(low))}</span><span>${esc(format((low+high)/2))}</span><span>${esc(format(high))}</span></div>
      <div class="fitness-plot" role="group" aria-label="${r.mode==="pace" ? "Темп: быстрее выше" : "ЧСС: ниже пульс выше"}">
      <svg class="fitness-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bands}${lines}</svg>
      ${r.matched.map((w,i)=>`<button type="button" class="fitness-dot" style="left:${x(w.stamp)}%;top:${y(w[r.mode])}%" data-fitness-point="${i}" aria-label="${esc(pointLabel(w))}" title="${esc(pointLabel(w))}" aria-pressed="${selected===w.key}"></button>`).join("")}
      ${r.weekly.map((w,i)=>w.value==null ? "" : `<button type="button" class="fitness-week ${w.days===1 ? "single" : ""}" style="left:${weekPosition(w).center}%;top:${y(w.value)}%" data-fitness-week="${i}" aria-label="${esc(weekLabel(w))}" title="${esc(weekLabel(w))}" aria-pressed="${selected==="week:"+w.weekStart}"></button>`).join("")}</div>
      <div class="fitness-dates"><span>${esc(date(r.start))}</span><span>${esc(date(r.split))}</span><span>${esc(date(r.end))}</span></div>`;
    const point=r.matched.find(w=>w.key===selected), week=r.weekly.find(w=>"week:"+w.weekStart===selected);
    el("fitnessPoint").textContent=point ? pointLabel(point)+" · включена: соответствует фиксированным критериям." : week ? weekLabel(week) : r.mode==="pace" ? "Темп, мин/км · быстрее выше" : "ЧСС, уд/мин · ниже пульс выше";
  }
  function pointLabel(w) { return `${date(w.date)} · ${number(w.duration)} мин · ${pace(w.pace)} мин/км · ${number(w.hr)} уд/мин`; }
  function weekLabel(w) {
    const format=v=>result.mode==="pace" ? pace(v)+" мин/км" : number(v)+" уд/мин";
    return `${date(w.weekStart)} – ${date(w.weekEnd)}${w.partial ? " (неполная неделя)" : ""} · медиана ${format(w.value)} · ${w.days} дн. / ${w.sessions} тренировок${w.days===1 ? " · единственное наблюдение" : ""}${w.q1==null ? " · разброс не оценивается" : ` · 25–75%: ${format(w.q1)} – ${format(w.q3)}`}`;
  }
  globalThis.FitnessTrendView={render};
  document.addEventListener("DOMContentLoaded",()=>{
    for (const id of ["fitnessPeriod","fitnessMode","fitnessType"]) el(id).addEventListener("change",()=>{
      prefs.weeks=Number(el("fitnessPeriod").value); prefs.mode=el("fitnessMode").value; prefs.type=el("fitnessType").value;
      selected="";save();render();
    });
    el("fitnessSettings").addEventListener("submit",event=>{
      event.preventDefault();
      const value=el("fitnessPace").value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
      const paceValue=value ? Number(value[1])+Number(value[2])/60 : NaN;
      if (prefs.mode==="hr" && (!Number.isFinite(paceValue) || paceValue<2 || paceValue>15)) {
        el("fitnessPace").setCustomValidity("Укажите темп от 2:00 до 15:00 мин/км");el("fitnessPace").reportValidity();return;
      }
      prefs.criteria[prefs.type]=FitnessTrend.normalizeCriteria({duration:el("fitnessDuration").value,hr:el("fitnessHr").value,
        pace:paceValue,surface:el("fitnessSurface").value});
      selected="";save();render();
    });
    el("fitnessSurface").addEventListener("change",()=>{el("fitnessSuggest").disabled=!suggestibleSurfaces.has(el("fitnessSurface").value);});
    el("fitnessPace").addEventListener("input",()=>el("fitnessPace").setCustomValidity(""));
    el("fitnessSuggest").addEventListener("click",()=>{
      const suggestion=FitnessTrend.suggestCriteria(normalizedWorkouts(),{type:prefs.type,weeks:12,surface:el("fitnessSurface").value});
      if (suggestion) { prefs.criteria[prefs.type]=suggestion; selected="";save();render(); }
    });
    el("fitnessChart").addEventListener("click",event=>{
      const dot=event.target.closest("[data-fitness-point]"),week=event.target.closest("[data-fitness-week]");
      if ((!dot && !week) || !result) return;
      selected=dot ? result.matched[Number(dot.dataset.fitnessPoint)]?.key : "week:"+result.weekly[Number(week.dataset.fitnessWeek)]?.weekStart;
      for (const button of el("fitnessChart").querySelectorAll("button")) button.setAttribute("aria-pressed",String(button===(dot || week)));
      el("fitnessPoint").textContent=dot ? pointLabel(result.matched[Number(dot.dataset.fitnessPoint)])+" · включена: соответствует фиксированным критериям." : weekLabel(result.weekly[Number(week.dataset.fitnessWeek)]);
    });
  });
})();