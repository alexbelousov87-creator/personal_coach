import unittest
import server


class ClassificationPromptTests(unittest.TestCase):
    def test_prompt_keeps_uncertainty_and_volume(self):
        prompt = server.build_user_prompt({"context": {"recentWorkoutsDetailed": [
            {"load": 80, "workoutClassification": {"confidence": "low", "needsReview": True}}
        ]}})
        for field in ("workoutClassification", "needsReview", "unconfirmedTypeSessions", '"load": 80'):
            self.assertIn(field, prompt)
        self.assertIn("Не назначай повторную ключевую работу", prompt)


if __name__ == "__main__":
    unittest.main()