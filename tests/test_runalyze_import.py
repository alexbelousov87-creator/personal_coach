import unittest
from unittest.mock import patch

import server


class RunalyzeImportTests(unittest.TestCase):
    def test_activity_conversion_uses_api_units(self):
        workout = server.runalyze_activity_to_workout(
            {
                "id": 42,
                "sport": {"id": 1, "name": "Running"},
                "type": {"id": 2, "name": "Easy Run"},
                "date_time": "2026-09-01T06:57:50",
                "timezone_offset": 18000,
                "title": "Morning Run",
                "distance": 13030,
                "duration": 3660,
                "elapsed_time": 3700,
                "hr_avg": 145,
                "hr_max": 171,
                "trimp": 89,
                "x_pace": 281.0,
                "rpe": 3,
                "subjective_feeling": 4,
            }
        )

        self.assertEqual(workout["source"], "Runalyze:42")
        self.assertEqual(workout["providerIds"], {"runalyze": "42"})
        self.assertEqual(workout["date"], "2026-09-01T06:57:50+05:00")
        self.assertEqual(workout["durationMin"], 61)
        self.assertEqual(workout["distanceKm"], 13.03)
        self.assertEqual(workout["paceMinPerKm"], 4.68)
        self.assertEqual(workout["load"], 89)
        self.assertEqual(workout["rpe"], 3)

    def test_polar_and_runalyze_activity_merge_without_duplicate(self):
        polar = {
            "source": "Polar:p1",
            "providerIds": {"polar": "p1"},
            "date": "2026-09-01T06:57:50+05:00",
            "sport": "RUNNING",
            "durationMin": 61,
            "distanceKm": 13.03,
            "load": 91,
            "loadSource": "trimp-segmented",
            "tcxFile": "Polar_2026-09-01_06-57-50_p1.TCX",
            "intervalSignals": {"detected": True},
        }
        runalyze = {
            "source": "Runalyze:42",
            "providerIds": {"runalyze": "42"},
            "date": "2026-09-01T01:57:55Z",
            "sport": "Running",
            "durationMin": 61,
            "distanceKm": 13.03,
            "load": 89,
            "loadSource": "imported",
            "paceMinPerKm": 4.68,
            "paceSource": "runalyze",
            "rpe": 3,
        }

        result = server.merge_backend_workout_lists([polar], [runalyze])

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(result["workouts"]), 1)
        merged = result["workouts"][0]
        self.assertEqual(merged["source"], "Polar:p1")
        self.assertEqual(merged["providerIds"], {"polar": "p1", "runalyze": "42"})
        self.assertEqual(merged["load"], 91)
        self.assertEqual(merged["rpe"], 3)
        self.assertEqual(merged["paceSource"], "runalyze")

    def test_two_similar_sessions_on_same_day_are_not_merged(self):
        morning = {
            "source": "Polar:morning",
            "date": "2026-09-01T06:00:00+05:00",
            "sport": "RUNNING",
            "durationMin": 60,
            "distanceKm": 12,
        }
        evening = {
            "source": "Runalyze:evening",
            "date": "2026-09-01T18:00:00+05:00",
            "sport": "Running",
            "durationMin": 60,
            "distanceKm": 12,
        }

        result = server.merge_backend_workout_lists([morning], [evening])

        self.assertEqual(result["added"], 1)
        self.assertEqual(len(result["workouts"]), 2)

    def test_repeated_runalyze_id_is_always_merged(self):
        first = {
            "source": "Runalyze:42",
            "date": "2026-09-01T06:57:50+05:00",
            "sport": "Running",
            "durationMin": 61,
            "distanceKm": 13.03,
        }
        edited = {
            "source": "Runalyze:42",
            "date": "2026-09-01T06:58:00+05:00",
            "sport": "Running",
            "durationMin": 62,
            "distanceKm": 13.05,
        }

        result = server.merge_backend_workout_lists([first], [edited])

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(result["workouts"]), 1)


    def test_sync_reads_activity_endpoint_and_stores_workout(self):
        integration = {"token": "secret", "lastSync": ""}
        activity = {
            "id": 42,
            "sport": {"name": "Running"},
            "date_time": "2026-09-01T01:57:50Z",
            "distance": 13030,
            "duration": 3660,
            "trimp": 89,
        }
        with (
            patch.object(server, "integration_config", return_value={
                "enabled": True,
                "activitiesUrl": "https://runalyze.com/api/v1/activity",
                "itemsPerPage": 200,
                "initialPageCount": 5,
            }),
            patch.object(server, "athlete_integration", side_effect=[dict(integration), dict(integration)]),
            patch.object(server, "http_json", return_value=[activity]) as request_mock,
            patch.object(server, "merge_synced_workouts_into_athlete", return_value={
                "added": 1,
                "duplicates": 0,
                "stored": 1,
            }) as merge_mock,
            patch.object(server, "save_athlete_integration") as save_mock,
        ):
            result = server.sync_runalyze_workouts_locked(
                store=True,
                coach_id="coach",
                athlete_id="athlete",
            )

        self.assertEqual(result["provider"], "runalyze")
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["workouts"][0]["distanceKm"], 13.03)
        self.assertIn("order%5Bid%5D=desc", request_mock.call_args.args[0])
        merge_mock.assert_called_once()
        self.assertEqual(save_mock.call_args.args[3]["readAccess"], "granted")

    def test_sync_explains_missing_read_scope(self):
        integration = {"token": "secret", "lastSync": ""}
        with (
            patch.object(server, "integration_config", return_value={
                "enabled": True,
                "activitiesUrl": "https://runalyze.com/api/v1/activity",
                "itemsPerPage": 200,
            }),
            patch.object(server, "athlete_integration", return_value=dict(integration)),
            patch.object(server, "http_json", side_effect=server.AppError("Access Denied", 403)),
            patch.object(server, "save_athlete_integration") as save_mock,
        ):
            with self.assertRaises(server.AppError) as error:
                server.sync_runalyze_workouts_locked(
                    store=False,
                    coach_id="coach",
                    athlete_id="athlete",
                )

        self.assertEqual(error.exception.status, 403)
        self.assertIn("Supporter/Premium", str(error.exception))
        self.assertEqual(save_mock.call_args.args[3]["readAccess"], "denied")
if __name__ == "__main__":
    unittest.main()