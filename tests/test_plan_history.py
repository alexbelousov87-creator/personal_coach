import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch

import plan_history as history
import server

WEEK = "2026-10-05"
SESSION = {"role": "coach", "coach_id": "history-test-coach"}


def plan(text="40 minutes easy"):
    return {"source": "json", "summary": "Test week", "days": [
        {"date": (date.fromisoformat(WEEK) + timedelta(days=i)).isoformat(), "focus": "easy", "title": "Easy",
         "plannedWorkout": text, "details": text, "intensity": "Z2", "targetDistance": "8 km", "load": "low", "rationale": ""}
        for i in range(7)]}


def athlete(id="one", value=None):
    return {"id": id, "profile": {"name": id}, "workouts": [{"id": id+"-workout", "load": 73}],
            "plansByWeek": {WEEK: {"sources": {"json": value or plan()}, "activePlanSource": "json"}}}


class RevisionStorageTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        history.ensure_schema(self.db)
        self.addCleanup(self.db.close)

    def versions(self, **kwargs):
        return history.list_versions(self.db, "coach", "one", WEEK, "json", **kwargs)

    def test_assignment_changes_version_but_metadata_and_facts_do_not(self):
        first = athlete()
        history.record_changes(self.db, "coach", [], [first])
        second = copy.deepcopy(first)
        saved = second["plansByWeek"][WEEK]["sources"]["json"]
        saved.update({"savedAt": "now", "updatedAt": "later", "changeLog": [{"details": "note"}]})
        saved["days"][0].update({"actualWorkout": "Fact", "keyConfirmation": {"by": "coach"}, "dateLabel": "Monday"})
        second["workouts"].append({"id": "new"})
        history.record_changes(self.db, "coach", [first], [second])
        self.assertEqual(len(self.versions()["versions"]), 1)
        third = copy.deepcopy(second)
        third["plansByWeek"][WEEK]["sources"]["json"]["days"][0]["plannedWorkout"] = "50 minutes easy"
        history.record_changes(self.db, "coach", [second], [third], "Coach", "Adjustment")
        versions = self.versions()["versions"]
        self.assertEqual([v["number"] for v in versions], [2, 1])
        self.assertEqual(versions[0]["reason"], "Adjustment")
        self.assertNotIn("keyConfirmation", versions[0]["plan"]["days"][0])

    def test_first_edit_archives_existing_plan(self):
        history.record_changes(self.db, "coach", [athlete()], [athlete(value=plan("changed"))])
        self.assertEqual(len(self.versions()["versions"]), 2)

    def test_paging_and_scope(self):
        for i in range(25):
            history.append(self.db, "coach", "one", WEEK, "json", plan(str(i)), "Coach", "Edit")
        first = self.versions()
        second = self.versions(before=first["nextBefore"])
        self.assertEqual(len(first["versions"]), 20)
        self.assertEqual(len(second["versions"]), 5)
        self.assertIsNone(second["nextBefore"])
        for key in [("other", "one", WEEK, "json"), ("coach", "other", WEEK, "json"), ("coach", "one", WEEK, "local"), ("coach", "one", "2026-10-12", "json")]:
            self.assertEqual(history.list_versions(self.db, *key)["versions"], [])
            self.assertIsNone(history.find_version(self.db, *key, first["versions"][0]["id"]))

    def test_transaction_rollback(self):
        self.db.commit()
        with self.assertRaises(RuntimeError):
            with self.db:
                history.record_changes(self.db, "coach", [], [athlete()])
                raise RuntimeError("state write failed")
        self.assertEqual(self.versions()["versions"], [])

    def test_validation_and_timezone(self):
        history.validate(plan(), WEEK)
        value = plan()
        for i, day in enumerate(value["days"]):
            day["date"] = (date.fromisoformat(WEEK) + timedelta(days=i-1)).isoformat()+"T19:00:00.000Z"
        history.validate(value, WEEK, -300)
        with self.assertRaises(ValueError): history.validate(value, WEEK)
        for bad in [None, {}, {"days": []}, {"days": [None]*7}]:
            with self.assertRaises(ValueError): history.validate(bad, WEEK)
        value = plan(); value["days"][0]["title"] = {"invalid": True}
        with self.assertRaises(ValueError): history.validate(value, WEEK)
        value = plan(); value["days"][1]["date"] = WEEK
        with self.assertRaises(ValueError): history.validate(value, WEEK)

    def test_legacy_source_deduplication(self):
        value = athlete()
        value["plans"] = {"json": plan()}
        self.assertEqual(len(history.plans(value)), 1)
        del value["plansByWeek"]
        self.assertEqual(len(history.plans(value)), 1)


class RevisionAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for name, value in [("DB_PATH", Path(self.temp.name)/"test.sqlite3"), ("DB_INITIALIZED", False)]:
            patcher = patch.object(server, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        self.initial = [athlete(), athlete("two")]
        server.save_state_value("athletes", self.initial, coach_id=SESSION["coach_id"])
        self.scope = {"athleteId": "one", "week": WEEK, "source": "json"}

    def get(self):
        return server.plan_history_for_session(SESSION, self.scope)

    def apply(self, **kwargs):
        return server.apply_plan_change_for_session(SESSION, {**self.scope, "basePlan": self.get()["currentPlan"], "plan": plan("50 minutes easy"), "reason": "Test edit", **kwargs})

    def assert_error(self, status, func):
        with self.assertRaises(server.AppError) as error: func()
        self.assertEqual(error.exception.status, status)

    def test_edit_and_restore_create_new_versions_and_preserve_other_data(self):
        first = self.get()
        self.assertEqual(len(first["versions"]), 1)
        result = self.apply()
        state = server.load_state_value("athletes", [], coach_id=SESSION["coach_id"])
        self.assertEqual(state[1], self.initial[1])
        self.assertEqual(state[0]["workouts"], self.initial[0]["workouts"])
        self.assertEqual(state[0]["profile"], self.initial[0]["profile"])
        self.assertEqual(len(self.get()["versions"]), 2)
        restored = self.apply(versionId=first["versions"][0]["id"], expectedFingerprint=result["fingerprint"])
        self.assertEqual(restored["fingerprint"], first["currentFingerprint"])
        self.assertEqual([v["number"] for v in self.get()["versions"]], [3, 2, 1])

    def test_stale_edits_and_restore_are_rejected(self):
        before = self.get()
        self.apply()
        self.assert_error(409, lambda: self.apply(basePlan=before["currentPlan"]))
        self.assert_error(409, lambda: self.apply(versionId=before["versions"][0]["id"], expectedFingerprint=before["currentFingerprint"]))
        self.assertEqual(len(self.get()["versions"]), 2)

    def test_roles_ownership_and_cross_source_restore(self):
        self.assert_error(403, lambda: server.plan_history_for_session({**SESSION, "role": "student"}, self.scope))
        self.assert_error(403, lambda: server.apply_plan_change_for_session({**SESSION, "role": "student"}, self.scope))
        self.assert_error(404, lambda: server.plan_history_for_session({**SESSION, "coach_id": "other"}, self.scope))
        self.assert_error(404, lambda: self.apply(athleteId="missing"))
        version = self.get()["versions"][0]
        self.assert_error(404, lambda: self.apply(athleteId="two", versionId=version["id"], expectedFingerprint=version["fingerprint"]))
        self.assert_error(404, lambda: self.apply(source="local", versionId=version["id"], expectedFingerprint=""))

    def test_current_confirmation_is_preserved_not_restored_from_history(self):
        original = self.get()
        self.apply()
        values = server.load_state_value("athletes", [], coach_id=SESSION["coach_id"])
        values[0]["plansByWeek"][WEEK]["sources"]["json"]["days"][0]["keyConfirmation"] = {"id": "latest"}
        server.save_state_value("athletes", values, coach_id=SESSION["coach_id"])
        restored = self.apply(versionId=original["versions"][0]["id"], expectedFingerprint=self.get()["currentFingerprint"])
        self.assertEqual(restored["plan"]["days"][0]["keyConfirmation"], {"id": "latest"})
        self.assertNotIn("keyConfirmation", self.get()["versions"][0]["plan"]["days"][0])

    def test_invalid_plan_and_missing_base_do_not_write(self):
        self.assert_error(400, lambda: self.apply(plan={"days": []}))
        self.assert_error(409, lambda: server.apply_plan_change_for_session(SESSION, {**self.scope, "plan": plan()}))
        self.assertEqual(len(self.get()["versions"]), 1)

    def test_new_source_does_not_replace_existing_source(self):
        self.apply(source="local", basePlan=None)
        state = server.load_state_value("athletes", [], coach_id=SESSION["coach_id"])
        self.assertEqual(state[0]["plansByWeek"][WEEK]["sources"]["json"], self.initial[0]["plansByWeek"][WEEK]["sources"]["json"])


if __name__ == "__main__":
    unittest.main()