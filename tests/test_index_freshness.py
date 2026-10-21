from datetime import datetime, timezone
from pathlib import Path
import json
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import check_index_freshness as gate


class RefreshGateTests(unittest.TestCase):
    def test_unchanged_cycle_skips_and_newer_cycle_refreshes(self):
        reference = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        manifest = json.dumps(dict(schema=1, members=list(range(18)), run=int(reference.timestamp()))).encode()
        with patch.object(gate, 'get', return_value=manifest), patch.object(gate, 'newest_complete_after', return_value=reference), patch.object(gate, 'companion_refresh', return_value=False), patch.object(gate, 'needs_refresh', return_value=False), patch.object(gate, 'pending_ukmo', return_value=None):
            self.assertFalse(gate.check())
        from datetime import timedelta
        with patch.object(gate, 'get', return_value=manifest), patch.object(gate, 'newest_complete_after', return_value=reference+timedelta(hours=6)):
            self.assertTrue(gate.check())

    def test_missing_manifest_recovers_but_source_failures_are_visible(self):
        with patch.object(gate, 'get', side_effect=HTTPError('https://test',404,'missing',None,None)):
            self.assertTrue(gate.check())
        with patch.object(gate, 'get', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                gate.check()
