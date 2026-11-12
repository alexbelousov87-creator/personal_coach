import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server
import workout_corrections as corrections


def workout(**extra):
    return {"id": "one", "date": "2026-11-12T08:00:00+05:00", "source": "session.CSV",
            "sport": "Running", "durationMin": 60, "distanceKm": 9, "paceMinPerKm": 6.5,
            "pace": "6:30 мин/км", "paceSource": "csv", "avgSpeed": 9.2, "avgHr": 140,
            "load": 80, "loadSource": "trimp-segmented", "workoutStructure": {"kind": "intervals"}, **extra}


def payload(w, **extra):
    return {"workout": {k: w.get(k, "") for k in ("id", "date", "source")},
            "expected": corrections.revision(w), "distanceKm": 12, "paceMinPerKm": 5, **extra}


class WorkoutCorrectionsTests(unittest.TestCase):
    def test_changes_totals_only_and_keeps_original(self):
        original = workout()
        before = copy.deepcopy(original)
        edited = corrections.correct(original, payload(original), "2026-11-12T08:00:00Z")
        self.assertEqual(original, before)
        self.assertEqual(edited["distanceKm"], 12)
        self.assertEqual(edited["paceMinPerKm"], 5)
        self.assertEqual(edited["paceSource"], "manual")
        self.assertEqual(edited["manualCorrection"]["original"]["distanceKm"], 9)
        for key in ("id", "date", "source", "avgHr", "durationMin", "load", "loadSource", "workoutStructure"):
            self.assertEqual(edited[key], original[key])

    def test_no_invented_pace_and_restore_first_original_after_multiple_edits(self):
        w = workout()
        edited = corrections.correct(w, payload(w, paceMinPerKm=None), "1")
        self.assertIsNone(edited["paceMinPerKm"])
        self.assertEqual(edited["paceSource"], "")
        self.assertIsNone(edited["avgSpeed"])
        again = corrections.correct(edited, payload(edited, distanceKm=13), "2")
        restored = corrections.correct(again, {"restore": True}, "3")
        for key in corrections.METRICS:
            self.assertEqual(restored[key], w[key])
        self.assertFalse(restored["manualCorrection"]["active"])
        self.assertEqual(corrections.preserve(edited, edited, restored)["distanceKm"], 9)

    def test_invalid_values_and_noneditable_fields_are_rejected(self):
        for extra in ({"distanceKm": -1}, {"distanceKm": True}, {"distanceKm": float("nan")},
                      {"distanceKm": 1001}, {"paceMinPerKm": 0}, {"paceMinPerKm": float("inf")},
                      {"distanceKm": 0}, {"load": 1}, {"athleteId": "other"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                corrections.correct(workout(), payload(workout(), **extra), "1")

    def test_reimport_and_cross_provider_merge_keep_correction_without_duplicate(self):
        w = workout()
        edited = corrections.correct(w, payload(w), "1")
        for imported in (w, {**w, "source": "Polar:p1", "providerIds": {"polar": "p1"}, "lapSignals": {"hasIntervalLaps": True}}):
            with self.subTest(source=imported["source"]):
                result = server.merge_backend_workout_lists([edited], [imported])
                self.assertEqual(result["added"], 0)
                self.assertEqual(len(result["workouts"]), 1)
                self.assertEqual(result["workouts"][0]["distanceKm"], 12)
                self.assertEqual(result["workouts"][0]["paceSource"], "manual")
        enriched = server.merge_polar_workout_enrichment(edited, {"paceMinPerKm": 3, "paceSource": "tcx", "lapSignals": {"hasIntervalLaps": True}})
        self.assertEqual(enriched["paceMinPerKm"], 5)
        self.assertTrue(enriched["lapSignals"]["hasIntervalLaps"])

    def test_stale_full_state_cannot_erase_correction_or_forge_metadata(self):
        w = workout()
        edited = corrections.correct(w, payload(w), "1")
        saved = server.preserve_saved_workout_corrections([edited], [w])[0]
        self.assertEqual(saved["distanceKm"], 12)
        forged = {**w, "manualCorrection": {**edited["manualCorrection"], "distanceKm": 999, "updatedAt": "9"}}
        self.assertEqual(server.preserve_saved_workout_corrections([edited], [forged])[0]["distanceKm"], 12)
        self.assertNotIn("manualCorrection", server.preserve_saved_workout_corrections([], [forged])[0])
        self.assertEqual(server.preserve_saved_workout_corrections([edited], []), [edited])


class WorkoutEditApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for name, value in (("DB_PATH", Path(self.temp.name)/"test.sqlite3"), ("DB_INITIALIZED", False),
                            ("AUTH_CONFIG", {"enabled": True})):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.student = {"role": "student", "coach_id": "coach-test", "athlete_id": "a"}
        self.athletes = [{"id": "a", "workouts": [workout()]}, {"id": "b", "workouts": [workout(id="two")] }]
        server.save_telegram_athletes(copy.deepcopy(self.athletes), coach_id="coach-test")
        self.athletes = server.telegram_athletes("coach-test")

    def test_save_persists_after_reload_and_preserves_other_athlete(self):
        result = server.edit_workout_for_session(self.student, payload(workout()))
        athletes = server.telegram_athletes("coach-test")
        self.assertEqual(athletes[0]["workouts"][0], result["workout"])
        self.assertEqual(athletes[1], self.athletes[1])
        server.merge_synced_workouts_into_athlete([workout()], "coach-test", "a")
        self.assertEqual(server.telegram_athletes("coach-test")[0]["workouts"][0]["distanceKm"], 12)
        server.save_state_for_session({"workouts": [workout()]}, self.student)
        saved = server.telegram_athletes("coach-test")[0]["workouts"]
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["distanceKm"], 12)
        restored = server.edit_workout_for_session(self.student, payload(saved[0], restore=True))
        self.assertEqual(restored["workout"]["distanceKm"], 9)

    def test_forbidden_coach_other_athlete_and_other_coach(self):
        for session, body, expected in (({**self.student, "role": "coach"}, payload(workout()), 403),
                (self.student, payload(workout(id="two")), 404),
                ({**self.student, "coach_id": "another"}, payload(workout()), 404)):
            with self.subTest(session=session), self.assertRaises(server.AppError) as error:
                server.edit_workout_for_session(session, body)
            self.assertEqual(error.exception.status, expected)
        self.assertEqual(server.telegram_athletes("coach-test"), self.athletes)

    def test_concurrent_stale_editor_returns_conflict_without_overwriting(self):
        first = server.edit_workout_for_session(self.student, payload(workout()))
        with self.assertRaises(server.AppError) as error:
            server.edit_workout_for_session(self.student, payload(workout(), distanceKm=15))
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(server.telegram_athletes("coach-test")[0]["workouts"][0], first["workout"])

    def test_http_auth_and_student_only_route(self):
        http = server.TrainingCoachHTTPServer(("127.0.0.1", 0), server.TrainingCoachHandler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f"http://127.0.0.1:{http.server_port}/api/workouts/edit"
            for session, expected in ((None, 401), ({**self.student, "role": "coach"}, 403), (self.student, 200)):
                with self.subTest(role=(session or {}).get("role")), patch.object(server, "current_session", return_value=session):
                    req = Request(origin, data=json.dumps(payload(workout())).encode(), headers={"Content-Type": "application/json"})
                    if expected == 200:
                        with urlopen(req, timeout=5) as response:
                            self.assertEqual(json.load(response)["workout"]["distanceKm"], 12)
                    else:
                        with self.assertRaises(HTTPError) as error:
                            urlopen(req, timeout=5)
                        self.assertEqual(error.exception.code, expected)
                        error.exception.close()
        finally:
            http.shutdown()
            http.server_close()
            thread.join(5)


if __name__ == "__main__":
    unittest.main()
