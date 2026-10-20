from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import mogreps_source as source


class OfficialInventoryTests(unittest.TestCase):
    reference = datetime(2026, 10, 20, 0, tzinfo=timezone.utc)

    def page(self, keys, token=None):
        return ('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                + ''.join(f'<Contents><Key>{key}</Key></Contents>' for key in keys)
                + f'<IsTruncated>{str(bool(token)).lower()}</IsTruncated>'
                + (f'<NextContinuationToken>{token}</NextContinuationToken>' if token else '')
                + '</ListBucketResult>').encode()

    def test_requires_every_file_and_correct_accumulation_period(self):
        keys = list(source.required_keys(self.reference))
        self.assertEqual(len(keys), 506)
        self.assertTrue(any('PT0135H00M-precipitation_accumulation-PT03H' in key for key in keys))
        self.assertTrue(source.complete(self.reference, lambda _: self.page(keys)))
        self.assertFalse(source.complete(self.reference, lambda _: self.page(keys[:-1])))
        self.assertFalse(source.complete(self.reference, lambda _: self.page([k.replace('PT01H.nc', 'PT03H.nc') for k in keys])))

    def test_pagination_and_repeated_token(self):
        keys = list(source.required_keys(self.reference))
        urls = []
        def fetch(url):
            urls.append(url)
            return self.page(keys[:200], 'next') if len(urls) == 1 else self.page(keys[200:])
        self.assertTrue(source.complete(self.reference, fetch))
        self.assertIn('continuation-token=next', urls[1])
        with self.assertRaisesRegex(ValueError, 'pagination'):
            source.complete(self.reference, lambda _: self.page([], 'repeat'))

    def test_selects_newest_complete_and_does_not_recheck_indexed_cycle(self):
        now = self.reference + timedelta(hours=13)
        with patch.object(source, 'complete', side_effect=[False, True]) as check:
            self.assertEqual(source.newest_complete_after(self.reference, now), self.reference + timedelta(hours=6))
            self.assertEqual(check.call_count, 2)
        with patch.object(source, 'complete') as check:
            self.assertEqual(source.newest_complete_after(self.reference, self.reference), self.reference)
            check.assert_not_called()

    def test_network_failure_is_not_reported_as_current(self):
        with self.assertRaisesRegex(OSError, 'offline'):
            source.complete(self.reference, lambda _: (_ for _ in ()).throw(OSError('offline')))


if __name__ == '__main__':
    unittest.main()
