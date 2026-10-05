"""Assignment-only plan revisions. Call writes inside the app_state transaction."""
import hashlib
import json
from datetime import date, datetime, timedelta, timezone

SOURCES = {"local", "json", "ai"}
FIELDS = ("date", "focus", "title", "plannedWorkout", "intensity", "targetDistance", "load", "rationale", "plannedStructure")


def snapshot(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get("days"), list) or len(plan["days"]) != 7:
        return None
    if not all(isinstance(day, dict) for day in plan["days"]):
        return None
    days = []
    for day in plan["days"]:
        value = {key: day.get(key) or "" for key in FIELDS if key != "plannedStructure"}
        value["plannedWorkout"] = day.get("plannedWorkout") or day.get("details") or ""
        value["plannedStructure"] = day.get("plannedStructure") or None
        days.append(value)
    return {"summary": str(plan.get("summary") or ""), "days": days}


def fingerprint(plan):
    value = snapshot(plan)
    if value is None:
        return ""
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate(plan, week, timezone_offset=0):
    value = snapshot(plan)
    if value is None:
        raise ValueError("План должен содержать семь дней.")
    try:
        start = date.fromisoformat(week)
        if start.weekday() != 0:
            raise ValueError()
        zone = timezone(timedelta(minutes=-int(timezone_offset)))
        for index, day in enumerate(value["days"]):
            text = str(day["date"])
            timestamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
            day_date = timestamp.astimezone(zone).date() if timestamp.tzinfo else timestamp.date()
            if day_date != start + timedelta(days=index):
                raise ValueError()
    except (TypeError, ValueError):
        raise ValueError("Даты плана должны соответствовать выбранной неделе с понедельника по воскресенье.") from None
    for day in value["days"]:
        if any(not isinstance(day[key], str) for key in FIELDS if key != "plannedStructure"):
            raise ValueError("Поля задания должны содержать текст.")
        if day["plannedStructure"] is not None and not isinstance(day["plannedStructure"], dict):
            raise ValueError("Некорректная структура задания.")
    if len(json.dumps(value, ensure_ascii=False).encode()) > 256000:
        raise ValueError("План слишком большой для сохранения версии.")
    return value


def ensure_schema(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS plan_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            coach_id TEXT NOT NULL,
            athlete_id TEXT NOT NULL,
            week TEXT NOT NULL,
            source TEXT NOT NULL,
            number INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            plan TEXT NOT NULL,
            UNIQUE(coach_id, athlete_id, week, source, number)
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS plan_versions_scope ON plan_versions(coach_id, athlete_id, week, source, id)")


def plans(athlete):
    result = {}
    if not isinstance(athlete, dict):
        return result
    buckets = athlete.get("plansByWeek")
    for week, bucket in (buckets if isinstance(buckets, dict) else {}).items():
        if not isinstance(bucket, dict):
            continue
        sources = bucket.get("sources")
        for source, plan in (sources if isinstance(sources, dict) else {}).items():
            if source in SOURCES and snapshot(plan):
                result[(week, source)] = plan
    # Preserve older installations that have not migrated the current week yet.
    legacy = athlete.get("plans")
    for source, plan in (legacy if isinstance(legacy, dict) else {}).items():
        if source not in SOURCES or not snapshot(plan):
            continue
        try:
            first = date.fromisoformat(str(plan["days"][0].get("date", ""))[:10])
            week = (first - timedelta(days=first.weekday())).isoformat()
        except ValueError:
            continue
        result.setdefault((week, source), plan)
    return result


def append(connection, coach, athlete, week, source, plan, actor, reason):
    value = snapshot(plan)
    if value is None:
        return
    key = (coach, athlete, week, source)
    last = connection.execute(
        "SELECT fingerprint, number FROM plan_versions WHERE coach_id=? AND athlete_id=? AND week=? AND source=? ORDER BY id DESC LIMIT 1", key
    ).fetchone()
    digest = fingerprint(value)
    if last and last[0] == digest:
        return
    connection.execute(
        "INSERT INTO plan_versions(coach_id,athlete_id,week,source,number,created_at,actor,reason,fingerprint,plan) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (*key, last[1] + 1 if last else 1, datetime.now(timezone.utc).isoformat(timespec="seconds"),
         str(actor or "Система")[:120], str(reason or "Изменение задания")[:300], digest, json.dumps(value, ensure_ascii=False)),
    )


def record_changes(connection, coach, previous, current, actor="Система", reason="Изменение задания"):
    ensure_schema(connection)
    old = {str(a.get("id")): a for a in previous or [] if isinstance(a, dict) and a.get("id")}
    for athlete in current or []:
        if not isinstance(athlete, dict) or not athlete.get("id"):
            continue
        athlete_id = str(athlete["id"])
        before = plans(old.get(athlete_id))
        for (week, source), plan in plans(athlete).items():
            original = before.get((week, source))
            if original and fingerprint(original) == fingerprint(plan):
                continue
            if original:
                append(connection, coach, athlete_id, week, source, original, "Система", "Исходный сохраненный план")
            append(connection, coach, athlete_id, week, source, plan, actor, reason)


def list_versions(connection, coach, athlete, week, source, before=None):
    ensure_schema(connection)
    params = [coach, athlete, week, source]
    query = "SELECT id,number,created_at,actor,reason,fingerprint,plan FROM plan_versions WHERE coach_id=? AND athlete_id=? AND week=? AND source=?"
    if before is not None:
        query += " AND id < ?"
        params.append(before)
    rows = connection.execute(query + " ORDER BY id DESC LIMIT 21", params).fetchall()
    return {"versions": [
        {"id": r[0], "number": r[1], "createdAt": r[2], "actor": r[3], "reason": r[4],
         "fingerprint": r[5], "plan": json.loads(r[6])} for r in rows[:20]],
        "nextBefore": rows[19][0] if len(rows) > 20 else None}


def find_version(connection, coach, athlete, week, source, version_id):
    ensure_schema(connection)
    row = connection.execute(
        "SELECT plan,number FROM plan_versions WHERE coach_id=? AND athlete_id=? AND week=? AND source=? AND id=?",
        (coach, athlete, week, source, version_id),
    ).fetchone()
    return (json.loads(row[0]), row[1]) if row else None
