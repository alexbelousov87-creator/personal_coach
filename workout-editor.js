(() => {
  "use strict";
  const el=id=>document.getElementById(id);
  let opened=null,busy=false;
  const context=()=>JSON.stringify([state.auth?.coachId || state.coachProfile?.id,state.activeAthleteId,state.auth?.role,state.currentRole]);
  const revision=w=>({distanceKm:w.distanceKm ?? null,paceMinPerKm:w.paceMinPerKm ?? null,
    paceSource:w.paceSource || "",updatedAt:w.manualCorrection?.updatedAt || ""});
  const paceValue=p=>{const s=Math.round(Number(p)*60);return s>0 ? `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}` : "";};
  function checkContext() {
    if (opened && (!canEditWorkoutDetails() || opened.context!==context())) {
      el("workoutEditDialog").close();opened=null;
    }
  }
  function renderControl(w) {
    const c=w.manualCorrection;
    const original=c?.original;
    return `<div class="workout-edit-meta">${c?.active ? `<small>Исправлено учеником · исходная дистанция ${escapeHtml(formatDistance(original.distanceKm))}</small>` : ""}
      ${canEditWorkoutDetails() ? '<button type="button" class="ghost-btn" data-edit-workout>Исправить дистанцию и темп</button>' : ""}</div>`;
  }
  function open(workout) {
    if (!canEditWorkoutDetails() || busy) return;
    const original=workout.manualCorrection?.original || workout;
    opened={context:context(),identity:{id:workout.id || "",date:workout.date,source:workout.source || ""},expected:revision(workout),durationMin:Number(workout.durationMin)};
    el("workoutEditScope").textContent=`${formatDate(workout.date)} · ${workout.sport} · ${workout.durationMin} мин`;
    el("workoutEditOriginal").textContent=`Исходные данные: ${formatDistance(original.distanceKm)} · ${formatTrustedPace(original)}`;
    el("workoutEditDistance").value=workout.distanceKm || 0;
    el("workoutEditPace").value=paceValue(trustedPace(workout));
    el("workoutEditPace").setCustomValidity("");
    el("workoutEditRestore").hidden=!workout.manualCorrection?.active;
    el("workoutEditError").hidden=true;
    el("workoutEditDialog").showModal();
  }
  async function save(restore=false) {
    if (!opened || busy || !canEditWorkoutDetails()) return;
    checkContext();if (!opened) return;
    const form=el("workoutEditForm"),input=el("workoutEditPace"),text=input.value.trim();
    const match=text.match(/^(\d{1,2}):([0-5]\d)$/),p=match ? Number(match[1])+Number(match[2])/60 : null;
    input.setCustomValidity(!restore && text && (!match || p<1 || p>60) ? "Укажите темп от 1:00 до 60:00 мин/км." : "");
    if (!restore && !form.reportValidity()) return;
    const distance=Number(el("workoutEditDistance").value);
    if (!restore && !distance && p!=null) {input.setCustomValidity("При нулевой дистанции темп не указывается.");input.reportValidity();return;}
    const scope=opened;
    busy=true;el("workoutEditError").hidden=true;
    const controls=[...form.querySelectorAll("input,button")];controls.forEach(n=>n.disabled=true);
    el("workoutEditSave").textContent="Сохранение…";
    try {
      const response=await fetch(`${API_BASE_URL}/api/workouts/edit`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({workout:scope.identity,expected:scope.expected,...(restore ? {restore:true} : {distanceKm:distance,paceMinPerKm:p})})});
      const payload=await response.json();
      if (!response.ok) throw new Error(payload.error || "Не удалось сохранить тренировку.");
      if (!payload.workout || typeof payload.workout!=="object") throw new Error("Сервер не вернул исправленную тренировку.");
      if (context()!==scope.context || !canEditWorkoutDetails()) return;
      const index=state.workouts.findIndex(w=>["id","date","source"].every(k=>String(w[k] || "")===String(scope.identity[k] || "")));
      if (index<0) throw new Error("Данные обновились. Обновите страницу, чтобы увидеть сохраненное исправление.");
      state.workouts[index]=payload.workout;
      syncActiveAthleteFromState();
      saveJson(STORAGE_KEY,state.workouts);saveJson(ATHLETES_KEY,state.athletes);
      el("workoutEditDialog").close();opened=null;
      renderAll();restoreCurrentPlanOrGenerate();
      showToast(restore ? "Исходные данные тренировки возвращены" : "Исправление тренировки сохранено");
    } catch(error) {
      if (context()===scope.context) {el("workoutEditError").textContent=error.message;el("workoutEditError").hidden=false;}
    } finally {
      busy=false;controls.forEach(n=>n.disabled=false);el("workoutEditSave").textContent="Сохранить";
    }
  }
  globalThis.WorkoutEditor={renderControl,checkContext};
  document.addEventListener("DOMContentLoaded",()=>{
    el("workoutList").addEventListener("click",event=>{
      const button=event.target.closest("[data-edit-workout]");if (!button) return;
      const key=button.closest(".workout-row")?.dataset.workoutKey;
      const workout=state.workouts.find(w=>workoutDedupKey(w)===key);if (workout) open(workout);
    });
    for(const id of ["workoutEditClose","workoutEditCancel"]) el(id).addEventListener("click",()=>{if(!busy)el("workoutEditDialog").close();});
    el("workoutEditDialog").addEventListener("cancel",event=>{if(busy)event.preventDefault();});
    el("workoutEditDialog").addEventListener("close",()=>{opened=null;});
    el("workoutEditForm").addEventListener("submit",event=>{event.preventDefault();save();});
    el("workoutEditRestore").addEventListener("click",()=>save(true));
    el("workoutEditPace").addEventListener("input",()=>el("workoutEditPace").setCustomValidity(""));
    el("workoutEditDistance").addEventListener("input",()=>{
      checkContext();
      if (!opened || busy) return;
      const distance=Number(el("workoutEditDistance").value),duration=opened.durationMin;
      el("workoutEditPace").value=Number.isFinite(distance) && distance>0 && distance<=1000 && Number.isFinite(duration) && duration>0
        ? paceValue(duration/distance) : "";
      el("workoutEditPace").setCustomValidity("");
    });
  });
})();
