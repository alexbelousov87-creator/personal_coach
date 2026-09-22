"""Read-only coach summaries. No global athlete state or provider requests."""
from datetime import date, datetime, timedelta, timezone
from functools import partial
import math
import re


def calendar_date(value, tz=None):
    try:
        text = str(value or "")
        if tz is not None and "T" in text:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed.astimezone(tz).date()
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def finite_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else 0
    except (ValueError, TypeError):
        return 0


def sync_time(value):
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            return datetime.fromtimestamp(float(value), timezone.utc)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def saved_week_plan(athlete, week, tz=None):
    read_date = partial(calendar_date, tz=tz)
    bucket = (athlete.get("plansByWeek") or {}).get(week.isoformat()) or {}
    sources = bucket.get("sources") or {}
    order = dict.fromkeys([bucket.get("activePlanSource"), athlete.get("activePlanSource"), "json", "ai", "local", *sources])
    expected = {week + timedelta(days=i) for i in range(7)}
    for source in order:
        plan = sources.get(source) or (athlete.get("plans") or {}).get(source)
        if not isinstance(plan, dict):
            continue
        days = plan.get("days")
        if isinstance(days, list) and len(days) == 7 and {read_date(d.get("date")) for d in days if isinstance(d, dict)} == expected:
            return plan, source
    return None, ""


def activity_kind(day):
    kind = str(day.get("type") or day.get("focus") or "").lower()
    title = str(day.get("title") or "").lower()
    details = str(day.get("details") or "").lower()
    # Optional rest is not an obligatory session; do not mark it as missed.
    if kind in {"rest", "отдых"} or re.search(r"полный отдых|без (?:дополнительного )?бегового задания", details):
        return "rest"
    if re.search(r"силов|мобил|офп|cross|кросс-трен|плиометр|плаван|велосип", kind + " " + title) and not re.search(r"бег|running", title):
        return "other"
    return "run"


def is_run(workout):
    sport = str(workout.get("sport") or "").lower()
    return "run" in sport or "бег" in sport


def integration_summary(integrations, now):
    result = []
    for provider, integration in integrations.items():
        if provider not in {"polar", "runalyze", "strava"} or not isinstance(integration, dict):
            continue
        token = integration.get("token")
        connected = bool(token.get("access_token")) if isinstance(token, dict) else bool(token)
        checked = sync_time(integration.get("lastSync"))
        status = "connected"
        if not connected:
            status = "not_connected"
        elif integration.get("enabled") is False:
            status = "disabled"
        elif provider == "runalyze" and integration.get("readAccess") != "granted":
            status = "needs_permission"
        elif integration.get("lastError"):
            status = "error"
        elif not checked:
            status = "waiting"
        elif now - checked > timedelta(days=1):
            status = "stale"
        result.append({"provider": provider, "status": status, "lastSync": checked.isoformat() if checked else None})
    return result


def athlete_summary(athlete, week, today, now, tz=None):
    read_date = partial(calendar_date, tz=tz)
    end = week + timedelta(days=7)
    workouts = [w for w in athlete.get("workouts", []) if isinstance(w, dict) and read_date(w.get("date")) and read_date(w.get("date")) <= today]
    latest = max(workouts, key=lambda w: str(w.get("date")), default=None)
    actual = [w for w in workouts if week <= read_date(w.get("date")) < end]
    plan, source = saved_week_plan(athlete, week, tz)
    planned = [d for d in plan["days"] if activity_kind(d) != "rest"] if plan else []
    def has_fact(day):
        return any(read_date(w.get("date")) == read_date(day.get("date")) and (activity_kind(day) != "run" or is_run(w)) for w in actual)
    completed = sum(has_fact(d) for d in planned)
    overdue = sum(read_date(d.get("date")) < today and not has_fact(d) for d in planned)
    profile = athlete.get("profile") or {}
    fatigue_date = read_date(profile.get("subjectiveFatigueUpdatedAt"))
    fatigue = finite_number(profile.get("subjectiveFatigue"))
    fatigue_known = fatigue_date is not None and fatigue_date <= today and 1 <= fatigue <= 5
    fatigue_fresh = fatigue_known and (today - fatigue_date).days <= 7
    integrations = integration_summary(athlete.get("integrations") or {}, now)
    reasons = []
    if not plan:
        reasons.append("missing_plan")
    if overdue:
        reasons.append("days_without_fact")
    if fatigue_fresh and fatigue >= 4:
        reasons.append("fatigue")
    if any(item["status"] in {"error", "needs_permission", "stale"} for item in integrations):
        reasons.append("sync")
    if not workouts:
        reasons.append("no_workouts")
    return {
        "id": str(athlete.get("id") or ""),
        "name": str(athlete.get("name") or profile.get("name") or "Спортсмен"),
        "targetDistance": str(profile.get("targetDistance") or ""),
        "lastWorkout": {"date": latest.get("date"), "sport": latest.get("sport"), "distanceKm": finite_number(latest.get("distanceKm")), "durationMin": finite_number(latest.get("durationMin"))} if latest else None,
        "week": {"sessions": len(actual), "runKm": round(sum(finite_number(w.get("distanceKm")) for w in actual if is_run(w)), 2), "load": round(sum(finite_number(w.get("load")) for w in actual)), "completedDays": completed, "plannedDays": len(planned), "overdueDays": overdue},
        "plan": {"available": bool(plan), "source": source, "updatedAt": (plan.get("updatedAt") or plan.get("savedAt")) if plan else None},
        "fatigue": {"value": fatigue if fatigue_known else None, "updatedAt": fatigue_date.isoformat() if fatigue_known else None, "fresh": bool(fatigue_fresh)},
        "integrations": integrations,
        "attention": reasons,
    }


def build_coach_overview(athletes, week, today, now=None, utc_offset_minutes=0):
    tz = timezone(timedelta(minutes=utc_offset_minutes))
    now = now or datetime.now(timezone.utc)
    rows = [athlete_summary(a, week, today, now, tz) for a in athletes if isinstance(a, dict)]
    return {"weekStart": week.isoformat(), "weekEnd": (week + timedelta(days=6)).isoformat(), "generatedAt": now.isoformat(), "athletes": rows}
