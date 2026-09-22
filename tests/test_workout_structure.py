import unittest
import xml.etree.ElementTree as ET

import server


def lap(duration, distance, hr=150, trigger="Manual"):
    return ET.fromstring(
        f"""
        <Lap>
          <TotalTimeSeconds>{duration}</TotalTimeSeconds>
          <DistanceMeters>{distance}</DistanceMeters>
          <AverageHeartRateBpm><Value>{hr}</Value></AverageHeartRateBpm>
          <TriggerMethod>{trigger}</TriggerMethod>
        </Lap>
        """
    )


class WorkoutStructureTests(unittest.TestCase):
    def test_extracts_eight_two_minute_intervals(self):
        laps = [lap(900, 3000, 135)]
        for index in range(8):
            laps.append(lap(120 + (index % 3) - 1, 535 + (index % 4) * 8, 174))
            laps.append(lap(90 + (index % 2) * 3, 250 + (index % 3) * 7, 150))
        laps.append(lap(720, 2400, 145))

        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)

        self.assertEqual(structure["kind"], "intervals")
        self.assertIn("8 × 2 мин", structure["display"])
        self.assertEqual(structure["workGroups"][0]["count"], 8)
        self.assertEqual(structure["workGroups"][0]["basis"], "duration")
        self.assertEqual(structure["warmupMin"], 15)
        self.assertEqual(structure["cooldownMin"], 12)

    def test_extracts_five_one_kilometer_intervals(self):
        laps = [lap(1080, 3600, 138)]
        for index in range(5):
            laps.append(lap(204 - index, 995 + index * 3, 180))
            laps.append(lap(132 + index, 270 + index * 8, 158))
        laps.append(lap(780, 2600, 148))

        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)

        self.assertEqual(structure["kind"], "intervals")
        self.assertIn("5 × 1000 м", structure["display"])
        self.assertEqual(structure["workGroups"][0]["basis"], "distance")
        self.assertEqual(structure["totalWorkDistanceKm"], 5.0)

    def test_extracts_two_twelve_minute_tempo_blocks(self):
        laps = [
            lap(1200, 4400, 140),
            lap(721, 3320, 181),
            lap(240, 720, 157),
            lap(719, 3340, 183),
            lap(900, 3100, 155),
        ]

        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)

        self.assertFalse(signals["hasIntervalLaps"])
        self.assertTrue(signals["hasTempoLaps"])
        self.assertEqual(structure["kind"], "tempo-blocks")
        self.assertIn("2 × 12 мин темпо", structure["display"])
        self.assertIn("восстановление около 4 мин", structure["display"])

    def test_three_two_kilometer_repeats(self):
        laps = [lap(1272, 4767), lap(409, 2002), lap(157, 418),
                lap(411, 2007), lap(180, 468), lap(406, 2005), lap(1269, 4506)]
        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)
        self.assertTrue(signals["hasIntervalLaps"])
        self.assertFalse(signals["hasTempoLaps"])
        self.assertEqual(structure["kind"], "intervals")
        self.assertEqual(structure["workGroups"][0]["count"], 3)
        self.assertEqual(structure["workGroups"][0]["value"], 2000)

    def test_short_intervals_with_short_recovery(self):
        laps = [lap(1281, 4472, 137)]
        for index in range(10):
            laps.append(lap(36 + index % 4, 182 + index % 3 * 6, 170))
            if index < 9:
                laps.append(lap(34 + index % 6, 111 + index % 4 * 4, 176))
        laps.append(lap(1320, 4660, 153))
        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)
        self.assertTrue(signals["hasIntervalLaps"])
        self.assertFalse(signals["hasTempoLaps"])
        self.assertEqual(structure["kind"], "intervals")
        self.assertEqual(structure["workGroups"][0]["count"], 10)
        self.assertEqual(len([s for s in structure["segments"] if s["role"] == "recovery"]), 9)

    def test_short_strides_are_not_interval_repeats(self):
        laps = [lap(1800, 6000)]
        for _ in range(6):
            laps.extend([lap(15, 80), lap(80, 220)])
        laps.append(lap(600, 2000))
        self.assertFalse(server.analyze_tcx_laps_backend(laps)["hasIntervalLaps"])

    def test_short_laps_without_alternating_recovery_are_not_intervals(self):
        laps = [lap(1200, 4000)] + [lap(38, 190) for _ in range(10)] + [lap(1200, 4000)]
        self.assertFalse(server.analyze_tcx_laps_backend(laps)["hasIntervalLaps"])

    def test_short_laps_at_one_pace_are_not_intervals(self):
        laps = [lap(38, 125 + index % 2) for index in range(20)]
        self.assertFalse(server.analyze_tcx_laps_backend(laps)["hasIntervalLaps"])

    def test_four_long_tempo_blocks_remain_tempo(self):
        laps = [lap(1200, 4000)]
        for _ in range(4):
            laps.extend([lap(720, 3200), lap(120, 330)])
        laps.append(lap(900, 3000))
        signals = server.analyze_tcx_laps_backend(laps)
        self.assertFalse(signals["hasIntervalLaps"])
        self.assertTrue(signals["hasTempoLaps"])

    def test_merge_replaces_old_tempo_but_preserves_feedback_and_override(self):
        original = {"workoutType": "tempo", "workoutTypeOverride": "easy", "feedback": "test", "load": 90}
        updated = server.merge_polar_workout_enrichment(original, {
            "lapSignals": {"hasIntervalLaps": True, "hasTempoLaps": False},
            "workoutStructure": {"kind": "intervals"},
            "tcxEnrichmentVersion": 3,
        })
        self.assertEqual(updated["workoutType"], "interval")
        self.assertEqual(updated["workoutTypeOverride"], "easy")
        self.assertEqual(updated["feedback"], "test")
        self.assertEqual(updated["load"], 90)
        self.assertEqual(original["workoutType"], "tempo")
        self.assertTrue(server.workout_has_tcx_enrichment(updated))
        self.assertFalse(server.workout_has_tcx_enrichment({"tcxEnrichmentVersion": 2}))

    def test_ignores_automatic_kilometer_laps(self):
        laps = [lap(300, 1000, 135, "Distance") for _ in range(10)]

        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)

        self.assertTrue(signals["hasAutoDistanceOnly"])
        self.assertIsNone(structure)


if __name__ == "__main__":
    unittest.main()