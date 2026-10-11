import json
import unittest

import server


class PlanningPromptTests(unittest.TestCase):
    def test_contract_and_rules_match_new_prompt(self):
        prompt = server.build_user_prompt({"context": {}, "planningWeek": {"days": []}})
        schema = json.loads(prompt.split("Форма JSON:\n", 1)[1])
        self.assertEqual(set(schema["summary"]), {
            "weekGoal", "phaseDecision", "selectedStimuli", "loadDecision", "progressionDecision", "warnings"
        })
        self.assertIn("date", schema["days"][0])
        self.assertIn("details", schema["days"][0])
        self.assertNotIn("plannedWorkout", schema["days"][0])
        self.assertNotIn("actualWorkout", schema["days"][0])
        self.assertIn("повтори полное details", prompt)
        self.assertIn("ЧСС вторична", prompt)
        self.assertNotIn("вторник-суббота-воскресенье", prompt)
        self.assertNotIn("1 км - техника", prompt)

    def test_online_passes_same_system_and_real_context_without_current_plan(self):
        payload = {"system": "Revised client instructions", "context": {"profile": {"targetDistance": "21k"}},
                   "planningWeek": {"days": [{"date": "2026-10-12"}]}, "plan": {"summary": "DO_NOT_SEND"}}
        body = server.build_chat_body(payload, "test-model")
        self.assertEqual(body["messages"][0]["content"], payload["system"])
        prompt = body["messages"][1]["content"]
        self.assertIn('"targetDistance": "21k"', prompt)
        self.assertIn('"date": "2026-10-12"', prompt)
        self.assertNotIn("DO_NOT_SEND", prompt)

    def test_parser_preserves_new_summary_and_removes_model_facts(self):
        summary = {"weekGoal": "Goal", "phaseDecision": "Keep speed", "selectedStimuli": ["threshold"],
                   "loadDecision": "Maintain", "progressionDecision": "One parameter", "warnings": []}
        days = [{"date": f"2026-10-{12+i}", "details": "Assignment", "actualWorkout": "Untrusted"} for i in range(7)]
        plan = server.parse_plan_json(json.dumps({"summary": summary, "days": days}))
        server.strip_model_actuals(plan)
        self.assertEqual(plan["summary"], summary)
        self.assertTrue(all("actualWorkout" not in day for day in plan["days"]))
        variants = server.PLAN_SCHEMA["properties"]["summary"]["anyOf"]
        self.assertEqual({v["type"] for v in variants}, {"string", "object"})
        self.assertIn("date", server.PLAN_SCHEMA["properties"]["days"]["items"]["required"])


if __name__ == "__main__":
    unittest.main()