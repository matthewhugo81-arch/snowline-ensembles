from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from select_map_run import pending_run
from check_index_freshness import companion_refresh
import json

NOW = datetime(2026, 10, 20, 18, tzinfo=timezone.utc)


class PendingMapRunTests(unittest.TestCase):
    def test_incomplete_06z_is_finished_even_when_a_newer_cycle_exists(self):
        self.assertEqual(pending_run({'reference_time': '2026-10-20T06:00:00Z', 'completed': False}, NOW),
                         '2026-10-20T06:00:00+00:00')

    def test_complete_or_expired_run_allows_new_cycle(self):
        self.assertEqual(pending_run({'reference_time': '2026-10-20T06:00:00Z', 'completed': True}, NOW), '')
        self.assertEqual(pending_run({'reference_time': '2026-10-18T06:00:00Z', 'completed': False}, NOW), '')

    def test_malformed_initialization_is_rejected(self):
        for reference in ['2026-10-20T07:00:00Z', '2026-10-20T06:00:01Z', '2026-10-20T06:00:00', 'bad']:
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                pending_run({'reference_time': reference, 'completed': False}, NOW)

    def test_same_run_missing_comparison_times_requests_another_build(self):
        run = NOW - timedelta(hours=12)
        manifest = {'run': int(run.timestamp()), 'leads': list(range(0, 247, 3))}
        fields = [f'{base}_{stat}' for base in ['geopotential_height_500hPa', 'wind_speed_300hPa', 'wind_speed_200hPa', 'pressure_msl'] for stat in ['mean', 'spread']]
        fields += ['geopotential_height_500hPa_anomaly_mean']
        metadata = {'reference_time': run.isoformat(), 'variable_valid_times': {key: list(range(83)) for key in fields}}
        metadata['variable_valid_times'][fields[-1]] = list(range(40))
        self.assertTrue(companion_refresh(manifest, load=lambda url: json.dumps(metadata).encode()))

    def test_completed_fields_stop_requesting_builds_when_other_sources_current(self):
        run = NOW - timedelta(hours=12)
        manifest = {'run': int(run.timestamp()), 'leads': list(range(0, 247, 3))}
        fields = [f'{base}_{stat}' for base in ['geopotential_height_500hPa', 'wind_speed_300hPa', 'wind_speed_200hPa', 'pressure_msl'] for stat in ['mean', 'spread']]
        fields += ['geopotential_height_500hPa_anomaly_mean']
        metadata = {'reference_time': run.isoformat(), 'variable_valid_times': {key: list(range(83)) for key in fields}}
        def load(url):
            if 'snowline_mogreps_global' in url:
                value = metadata
            elif 'snowline_gem_upper' in url:
                value = {'reference_time': run.isoformat(), 'completed': True}
            else:
                # Native latest/in-progress indexes advertise the actual hours.
                # A completed companion is not a substitute for this evidence.
                value = {'reference_time': run.isoformat(), 'completed': True,
                         'valid_times': [run.isoformat()]}
            return json.dumps(value).encode()
        self.assertFalse(companion_refresh(manifest, load=load))


if __name__ == '__main__':
    unittest.main()
