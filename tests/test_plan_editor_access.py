
import copy
import unittest
from unittest.mock import patch
import server


class PlanEditorAccessTests(unittest.TestCase):
    def setUp(self):
        self.athletes = [{"id": "athlete-a", "name": "A", "profile": {},
                          "workouts": [{"id": "original-workout"}],
                          "plansByWeek": {"2026-09-28": {"sources": {"json": {
                              "days": [{"plannedStructure": {"version": 1, "count": 5}}]}}}}},
                         {"id": "athlete-b", "name": "B", "workouts": [],
                          "plansByWeek": {"original": {}}}]

    def test_student_cannot_replace_plans_or_structures(self):
        original = copy.deepcopy(self.athletes)
        payload = {"plansByWeek": {"forged": {}}, "athletes": [
            {"id": "athlete-a", "plansByWeek": {"forged": {}}},
            {"id": "athlete-b", "plansByWeek": {"forged": {}}}]}
        with patch.object(server, "auth_enabled", return_value=True), \
             patch.object(server, "telegram_athletes", return_value=copy.deepcopy(original)), \
             patch.object(server, "save_telegram_athletes") as save:
            server.save_state_for_session(payload, {"role": "student", "athlete_id": "athlete-a", "coach_id": "coach-a"})
            saved = save.call_args.args[0]
            for actual, expected in zip(saved, original):
                self.assertEqual(actual["plansByWeek"], expected["plansByWeek"])
                self.assertEqual(actual["workouts"], expected["workouts"])
            self.assertEqual(save.call_args.kwargs["coach_id"], "coach-a")

    def test_coach_plan_save_preserves_imported_fact_and_coach_scope(self):
        payload = {"athletes": [copy.deepcopy(self.athletes[0])]}
        payload["athletes"][0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"][0]["plannedStructure"]["count"] = 8
        payload["athletes"][0]["workouts"] = [{"id": "forged-workout"}]
        with patch.object(server, "load_state", return_value={"athletes": copy.deepcopy(self.athletes)}) as load, \
             patch.object(server, "save_state") as save, \
             patch.object(server, "mirror_legacy_state_from_primary_athlete"):
            server.save_state_from_coach(payload, coach_id="coach-a")
            load.assert_called_once_with("coach-a")
            saved = save.call_args.args[0]["athletes"]
            self.assertEqual(saved[0]["workouts"], self.athletes[0]["workouts"])
            self.assertEqual(saved[1]["plansByWeek"], self.athletes[1]["plansByWeek"])
            self.assertEqual(saved[0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"][0]["plannedStructure"]["count"], 8)
            self.assertEqual(save.call_args.kwargs["coach_id"], "coach-a")



    def test_student_cannot_forge_or_erase_key_confirmation(self):
        original = copy.deepcopy(self.athletes)
        days = original[0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"]
        days[0]["keyConfirmation"] = {"version": 1, "snapshot": "original", "by": "Coach",
                                      "confirmedAt": "2026-09-30T06:00:00Z"}
        forged = copy.deepcopy(original)
        forged[0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"][0]["keyConfirmation"] = {
            "version": 1, "snapshot": "forged", "by": "Student"}
        for submitted in [forged, self.athletes]:
            with patch.object(server, "auth_enabled", return_value=True), \
                 patch.object(server, "telegram_athletes", return_value=copy.deepcopy(original)), \
                 patch.object(server, "save_telegram_athletes") as save:
                server.save_state_for_session({"athletes": submitted, "plansByWeek": submitted[0]["plansByWeek"]},
                    {"role": "student", "athlete_id": "athlete-a", "coach_id": "coach-a"})
                self.assertEqual(save.call_args.args[0][0]["plansByWeek"], original[0]["plansByWeek"])
                self.assertEqual(save.call_args.args[0][1], original[1])
                self.assertEqual(save.call_args.kwargs["coach_id"], "coach-a")

    def test_coach_can_confirm_without_replacing_workouts(self):
        payload = {"athletes": [copy.deepcopy(self.athletes[0])]}
        confirmation = {"version": 1, "snapshot": "measured-fact", "by": "Coach",
                        "confirmedAt": "2026-09-30T06:00:00Z"}
        payload["athletes"][0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"][0]["keyConfirmation"] = confirmation
        with patch.object(server, "load_state", return_value={"athletes": copy.deepcopy(self.athletes)}), \
             patch.object(server, "save_state") as save, \
             patch.object(server, "mirror_legacy_state_from_primary_athlete"):
            server.save_state_from_coach(payload, coach_id="coach-a")
            saved = save.call_args.args[0]["athletes"]
            self.assertEqual(saved[0]["plansByWeek"]["2026-09-28"]["sources"]["json"]["days"][0]["keyConfirmation"], confirmation)
            self.assertEqual(saved[0]["workouts"], self.athletes[0]["workouts"])
            self.assertEqual(saved[1], {**self.athletes[1], "integrations": {}})

if __name__ == "__main__":
    unittest.main()
