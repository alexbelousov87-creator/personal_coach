"""Student corrections to totals; imported laps and heart-rate load stay intact."""
import copy
import math


METRICS = ("distanceKm", "paceMinPerKm", "pace", "paceSource", "avgSpeed")


def revision(workout):
    correction = workout.get("manualCorrection") or {}
    return {"distanceKm": workout.get("distanceKm"), "paceMinPerKm": workout.get("paceMinPerKm"),
            "paceSource": workout.get("paceSource") or "", "updatedAt": correction.get("updatedAt") or ""}


def apply(workout):
    result = dict(workout)
    correction = result.get("manualCorrection")
    if not isinstance(correction, dict) or not isinstance(correction.get("original"), dict):
        return result
    if correction.get("active"):
        pace = correction.get("paceMinPerKm")
        seconds = round(pace * 60) if pace else 0
        result.update(distanceKm=correction["distanceKm"], paceMinPerKm=pace,
                      pace=f"{seconds // 60}:{seconds % 60:02d} мин/км" if pace else "",
                      paceSource="manual" if pace else "", avgSpeed=None)
    else:
        for key in METRICS:
            result[key] = correction["original"].get(key)
    return result


def preserve(base, *sources):
    candidates = [w.get("manualCorrection") for w in sources if isinstance(w, dict)]
    candidates = [c for c in candidates if isinstance(c, dict) and isinstance(c.get("original"), dict)]
    result = dict(base)
    result.pop("manualCorrection", None)
    if candidates:
        result["manualCorrection"] = copy.deepcopy(max(candidates, key=lambda c: str(c.get("updatedAt") or "")))
    return apply(result)


def correct(workout, payload, timestamp):
    if not isinstance(payload, dict):
        raise ValueError("Некорректные данные тренировки.")
    allowed = {"workout", "expected", "distanceKm", "paceMinPerKm", "restore"}
    if set(payload) - allowed:
        raise ValueError("Можно изменить только дистанцию и средний темп.")
    correction = workout.get("manualCorrection") or {}
    original = correction.get("original") or {key: copy.deepcopy(workout.get(key)) for key in METRICS}
    if payload.get("restore") is True:
        if not correction:
            raise ValueError("У тренировки нет ручных исправлений.")
        updated = {"active": False, "original": original, "updatedAt": timestamp}
    else:
        distance = payload.get("distanceKm")
        pace = payload.get("paceMinPerKm")
        if isinstance(distance, bool) or not isinstance(distance, (int, float)) or not math.isfinite(distance) or not 0 <= distance <= 1000:
            raise ValueError("Укажите дистанцию от 0 до 1000 км.")
        if pace is not None and (isinstance(pace, bool) or not isinstance(pace, (int, float)) or not math.isfinite(pace) or not 1 <= pace <= 60):
            raise ValueError("Укажите темп от 1:00 до 60:00 мин/км или оставьте поле пустым.")
        if not distance and pace is not None:
            raise ValueError("Нельзя указать темп при нулевой дистанции.")
        updated = {"active": True, "distanceKm": distance, "paceMinPerKm": pace,
                   "original": original, "updatedAt": timestamp}
    return apply({**workout, "manualCorrection": updated})
