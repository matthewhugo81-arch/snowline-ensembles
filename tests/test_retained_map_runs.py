import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from retain_map_runs import retain, needs_refresh, SOURCE, DOMAINS


class RetainedMapTests(unittest.TestCase):
    def test_incomplete_cycles_never_displace_complete_and_partial_copy_never_publishes(self):
        domain = DOMAINS[0]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = {'hour': 0, 'complete': True, 'fail': False}
            def load(url):
                ref = f'2026-10-20T{state["hour"]:02}:00:00Z'
                if url.endswith('latest.json'):
                    return json.dumps(dict(domain=domain, reference_time=ref, completed=state['complete'], variables=['t'], valid_times=[ref])).encode()
                if state['fail']:
                    raise IOError('Interrupted download')
                return bytes(64)
            retain(domain, root, load)
            state.update(hour=6, complete=False)
            retain(domain, root, load)
            state.update(hour=12, complete=False)
            retain(domain, root, load)
            history=json.loads((root/domain/'history.json').read_text())
            self.assertEqual(history['runs'], ['2026-10-20T00:00:00Z'])
            state.update(complete=True, fail=True)
            with self.assertRaises(IOError):
                retain(domain, root, load)
            self.assertFalse((root/domain/'2026/10/20/1200Z/meta.json').exists())
            self.assertTrue((root/domain/'2026/10/20/0000Z/meta.json').exists())
