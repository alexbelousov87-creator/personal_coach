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

    def test_ignores_automatic_kilometer_laps(self):
        laps = [lap(300, 1000, 135, "Distance") for _ in range(10)]

        signals = server.analyze_tcx_laps_backend(laps)
        structure = server.extract_tcx_workout_structure_backend(laps, signals)

        self.assertTrue(signals["hasAutoDistanceOnly"])
        self.assertIsNone(structure)


if __name__ == "__main__":
    unittest.main()