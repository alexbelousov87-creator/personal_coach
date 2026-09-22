import copy
from datetime import date, datetime, timedelta, timezone
import json
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import server
from coach_overview import build_coach_overview

WEEK = date(2026, 9, 21)
TODAY = date(2026, 9, 23)
NOW = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def athlete(identifier="a", name="Test Athlete"):
    days = [{"date": (WEEK + timedelta(days=i)).isoformat(), "type": "Кросс", "details": "Легкий бег"} for i in range(7)]
    days[0]["type"] = "Отдых"
    return {"id": identifier, "name": name, "profile": {}, "workouts": [],
            "activePlanSource": "json", "plansByWeek": {WEEK.isoformat(): {"sources": {"json": {"days": days}}}}}


def summary(value):
    return build_coach_overview([value], WEEK, TODAY, NOW)["athletes"][0]


class CoachOverviewTests(unittest.TestCase):
    def test_read_only_and_current_day_not_overdue(self):
        a = athlete()
        original = copy.deepcopy(a)
        row = summary(a)
        self.assertEqual(a, original)
        self.assertEqual(row["week"]["plannedDays"], 6)
        self.assertEqual(row["week"]["overdueDays"], 1)
        self.assertIsNone(row["fatigue"]["value"])

    def test_multiple_workouts_one_day_and_cross_training(self):
        a = athlete()
        a["workouts"] = [
            {"date": "2026-09-22T06:00:00+05:00", "sport": "Running", "distanceKm": 10, "load": 70},
            {"date": "2026-09-22T19:00:00+05:00", "sport": "SkiErg", "distanceKm": 3, "load": 15},
            {"date": "2026-09-23T06:00:00+05:00", "sport": "SkiErg", "load": 15},
            {"date": "2026-09-28", "sport": "Running", "distanceKm": 999, "load": 999},
        ]
        row = summary(a)
        self.assertEqual(row["week"]["completedDays"], 1)
        self.assertEqual(row["week"]["overdueDays"], 0)
        self.assertEqual(row["week"]["sessions"], 3)
        self.assertEqual(row["week"]["runKm"], 10)
        self.assertEqual(row["week"]["load"], 100)
        self.assertTrue(row["lastWorkout"]["date"].startswith("2026-09-23"))

    def test_athletes_do_not_share_plans_or_workouts(self):
        a, b = athlete("a"), athlete("b")
        a["workouts"] = [{"date": "2026-09-22", "sport": "Running", "distanceKm": 12}]
        b["plansByWeek"] = {}
        rows = build_coach_overview([a, b], WEEK, TODAY, NOW)["athletes"]
        self.assertEqual(rows[0]["week"]["runKm"], 12)
        self.assertEqual(rows[1]["week"]["runKm"], 0)
        self.assertFalse(rows[1]["plan"]["available"])

    def test_outdated_plan_is_not_current(self):
        a = athlete()
        a["plansByWeek"][WEEK.isoformat()]["sources"]["json"]["days"][0]["date"] = "2026-09-14"
        self.assertFalse(summary(a)["plan"]["available"])

    def test_legacy_plan_and_selected_source(self):
        a = athlete()
        a["plans"] = a.pop("plansByWeek")[WEEK.isoformat()]["sources"]
        self.assertEqual(summary(a)["plan"]["source"], "json")

    def test_fatigue_requires_timestamp_and_marks_stale(self):
        a = athlete()
        a["profile"] = {"subjectiveFatigue": 5}
        self.assertIsNone(summary(a)["fatigue"]["value"])
        a["profile"]["subjectiveFatigueUpdatedAt"] = "2026-09-01"
        row = summary(a)
        self.assertFalse(row["fatigue"]["fresh"])
        self.assertNotIn("fatigue", row["attention"])
        a["profile"]["subjectiveFatigueUpdatedAt"] = "2026-09-23"
        self.assertIn("fatigue", summary(a)["attention"])

    def test_integration_summary_never_exposes_credentials_or_raw_errors(self):
        a = athlete()
        a["integrations"] = {
            "polar": {"token": {"access_token": "secret-123"}, "lastSync": NOW.timestamp()},
            "runalyze": {"token": "secret-456", "readAccess": "denied", "lastError": "raw-private-error"},
        }
        row = summary(a)
        text = json.dumps(row)
        self.assertNotIn("secret", text)
        self.assertNotIn("raw-private-error", text)
        self.assertEqual(row["integrations"][1]["status"], "needs_permission")
        a["integrations"]["polar"]["lastSync"] = (NOW - timedelta(days=2)).timestamp()
        self.assertEqual(summary(a)["integrations"][0]["status"], "stale")

    def test_no_plan_is_not_fabricated(self):
        a = athlete()
        a["plansByWeek"] = {}
        row = summary(a)
        self.assertFalse(row["plan"]["available"])
        self.assertEqual(row["week"]["overdueDays"], 0)
        self.assertIn("missing_plan", row["attention"])

    def test_utc_serialized_plan_dates_use_viewer_timezone(self):
        a = athlete()
        days = a["plansByWeek"][WEEK.isoformat()]["sources"]["json"]["days"]
        for index, day in enumerate(days):
            local = datetime(2026, 9, 21, tzinfo=timezone(timedelta(hours=5))) + timedelta(days=index)
            day["date"] = local.astimezone(timezone.utc).isoformat()
            day["focus"] = day.pop("type")
        a["workouts"] = [{"date": "2026-09-21T20:00:00Z", "sport": "Running", "distanceKm": 10}]
        row = build_coach_overview([a], WEEK, TODAY, NOW, utc_offset_minutes=300)["athletes"][0]
        self.assertTrue(row["plan"]["available"])
        self.assertEqual(row["week"]["plannedDays"], 6)
        self.assertEqual(row["week"]["completedDays"], 1)
        self.assertEqual(row["week"]["overdueDays"], 0)

    def test_non_running_assignment_can_be_completed_by_strength(self):
        a = athlete()
        day = a["plansByWeek"][WEEK.isoformat()]["sources"]["json"]["days"][1]
        day.update({"type": "Восстановление", "title": "ОФП и мобилити", "details": "20 минут мобилити"})
        a["workouts"] = [{"date": "2026-09-22", "sport": "STRENGTH", "durationMin": 20}]
        row = summary(a)
        self.assertEqual(row["week"]["completedDays"], 1)
        self.assertEqual(row["week"]["overdueDays"], 0)

    def test_empty_roster_stays_empty(self):
        self.assertEqual(build_coach_overview([], WEEK, TODAY, NOW)["athletes"], [])

    def test_non_finite_numbers_are_not_returned(self):
        a = athlete()
        a["workouts"] = [{"date": "2026-09-22", "sport": "Running", "load": float("nan"), "distanceKm": -1}]
        self.assertEqual(summary(a)["week"]["load"], 0)
        json.dumps(summary(a), allow_nan=False)


class CoachOverviewAccessTests(unittest.TestCase):
    def setUp(self):
        self.patches = [
            patch.object(server, "auth_enabled", return_value=True),
            patch.object(server, "current_session", side_effect=lambda handler: {
                "coach-a": {"role": "coach", "coach_id": "a"},
                "coach-b": {"role": "coach", "coach_id": "b"},
                "student": {"role": "student", "coach_id": "a", "athlete_id": "a-student"},
            }.get(handler.headers.get("X-Test-Session"))),
            patch.object(server, "load_state_value", side_effect=lambda key, fallback, coach_id=None: [athlete(coach_id + "-student")] if key == "athletes" else fallback),
        ]
        for item in self.patches:
            item.start()
        self.http = server.TrainingCoachHTTPServer(("127.0.0.1", 0), server.TrainingCoachHandler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.http.server_port}/api/coach/overview?week=2026-09-21&today=2026-09-23"

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        for item in reversed(self.patches):
            item.stop()

    def get(self, session="", suffix=""):
        req = Request(self.url + suffix, headers={"X-Test-Session": session})
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            with exc:
                return exc.code, json.load(exc)

    def test_anonymous_is_rejected(self):
        self.assertEqual(self.get()[0], 401)

    def test_student_is_rejected(self):
        self.assertEqual(self.get("student")[0], 403)

    def test_coach_sees_only_own_students_ignoring_query_coach_id(self):
        status, payload = self.get("coach-a", "&coach_id=b")
        self.assertEqual(status, 200)
        self.assertEqual([a["id"] for a in payload["athletes"]], ["a-student"])
        self.assertEqual(self.get("coach-b")[1]["athletes"][0]["id"], "b-student")

    def test_invalid_week_returns_400(self):
        self.url = self.url.replace("week=2026-09-21", "week=2026-09-22")
        self.assertEqual(self.get("coach-a")[0], 400)
