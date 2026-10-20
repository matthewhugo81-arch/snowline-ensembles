from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check_build_backoff', Path(__file__).resolve().parents[1] / 'scripts/check_build_backoff.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BuildBackoffTests(unittest.TestCase):
    now = datetime(2026, 10, 20, 19, tzinfo=timezone.utc)

    def run_record(self, **changes):
        return {'id': 123, 'head_sha': 'same', 'conclusion': 'failure',
                'updated_at': (self.now - timedelta(minutes=3)).isoformat(),
                'html_url': 'https://github.com/example/repo/actions/runs/123', **changes}

    def jobs(self, step='Test source index validation', conclusion='failure'):
        return lambda _: [{'name': 'build', 'steps': [{'name': step, 'conclusion': conclusion}]}]

    def test_repeated_test_failure_on_same_commit_waits_only_until_deadline(self):
        result = module.check_backoff([self.run_record()], self.jobs(), 'same', self.now)
        self.assertTrue(result['blocked'])
        self.assertEqual(module.parse_time(result['retry_at']), self.now + timedelta(minutes=27))
        self.assertFalse(module.check_backoff([self.run_record()], self.jobs(), 'same', self.now + timedelta(minutes=27))['blocked'])

    def test_new_commit_is_not_blocked_by_old_failure(self):
        self.assertFalse(module.check_backoff([self.run_record()], lambda _: self.fail('Unnecessary job lookup'), 'fixed', self.now)['blocked'])

    def test_transient_source_and_deployment_failures_are_not_suppressed(self):
        for step in ['Index required complete Met Office run', 'Prepare native GEM upper air and MOGREPS comparison grids', 'Deploy to existing GitHub Pages URL']:
            self.assertFalse(module.check_backoff([self.run_record()], self.jobs(step), 'same', self.now)['blocked'])

    def test_successful_test_is_not_treated_as_failed(self):
        self.assertFalse(module.check_backoff([self.run_record()], self.jobs(conclusion='success'), 'same', self.now)['blocked'])

    def test_chart_test_failure_also_pauses_automatic_retry(self):
        self.assertTrue(module.check_backoff([self.run_record()], self.jobs('Test chart calculations and source decoder'), 'same', self.now)['blocked'])


if __name__ == '__main__':
    unittest.main()
