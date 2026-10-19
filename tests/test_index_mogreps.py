import gzip
import importlib.util
import io
import json
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import h5py
import numpy as np

SPEC = importlib.util.spec_from_file_location('index_mogreps', Path(__file__).resolve().parents[1] / 'scripts/index_mogreps.py')
indexer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(indexer)
RUN = datetime(2026, 10, 19, 6, tzinfo=timezone.utc)
MEMBERS = [0] + list(range(18, 35))
OBJECT = {'etag': '"pressure-source"', 'size': 1000000}


def source_file(units='Pa', reference=None, members=None, latitude_shift=0, shape=(18, 960, 1280), cell_methods=''):
    data = io.BytesIO()
    with h5py.File(data, 'w') as f:
        f['forecast_reference_time'] = int(RUN.timestamp()) if reference is None else reference
        f['time'] = int(RUN.timestamp()) + 24 * 3600
        f['realization'] = MEMBERS if members is None else members
        f['latitude'] = -89.90625 + np.arange(960) * .1875 + latitude_shift
        f['longitude'] = -179.859375 + np.arange(1280) * .28125
        d = f.create_dataset('air_pressure_at_sea_level', shape=shape, chunks=(1, 128, 128), dtype='<f4')
        d.attrs['units'] = units
        d.attrs['standard_name'] = 'air_pressure_at_sea_level'
        if cell_methods:
            d.attrs['cell_methods'] = cell_methods
    return data.getvalue()


class PressureIndexTests(unittest.TestCase):
    def test_pressure_is_instantaneous_and_uses_every_three_hour_sample(self):
        for lead in (0, 24, 132, 135, 246):
            key = indexer.source_key(RUN, lead, 'pressure_msl')
            self.assertTrue(key.endswith(f'-PT{lead:04d}H00M-pressure_at_mean_sea_level.nc'))
            self.assertNotIn('PT01H', key)
            self.assertNotIn('PT03H', key)
        self.assertEqual(indexer.native_leads('pressure_msl'), list(range(0, 247, 3)))
        self.assertIn('pressure_msl', indexer.VARIABLES)
        self.assertTrue(indexer.source_key(RUN, 132, 'precipitation').endswith('accumulation-PT01H.nc'))
        self.assertTrue(indexer.source_key(RUN, 135, 'snowfall').endswith('accumulation-PT03H.nc'))

    def test_chunk_index_records_actual_shuffled_compressed_member_chunks(self):
        with h5py.File(io.BytesIO(), 'w') as f:
            d = f.create_dataset('pressure', data=np.arange(72, dtype='<f4').reshape(18, 2, 2), chunks=(1, 2, 2), compression='gzip', shuffle=True)
            result = indexer.dataset_index(d)
            self.assertEqual(result['shape'], [18, 2, 2])
            self.assertEqual(result['chunkShape'], [1, 2, 2])
            self.assertEqual([item['id'] for item in result['filters']], [2, 1])
            self.assertEqual(len(result['chunks']), 18)
            self.assertIn('17,0,0', result['chunks'])
            self.assertTrue(all(offset > 0 and size > 0 for offset, size, _ in result['chunks'].values()))

    def build(self, folder, data):
        with patch.object(indexer.fsspec, 'open', side_effect=lambda *a, **k: io.BytesIO(data)), patch.object(indexer, 'dataset_index', return_value={'shape': [18, 960, 1280]}) as chunks, patch.object(indexer.time, 'sleep'):
            result = indexer.build_file((RUN.isoformat(), 24, 'pressure_msl', str(folder), OBJECT))
            return result, chunks.call_count

    def test_pressure_index_validates_source_headers_and_preserves_native_units(self):
        with tempfile.TemporaryDirectory() as folder:
            result, calls = self.build(folder, source_file())
            self.assertFalse(result['cached'])
            self.assertEqual(calls, 1)
            with gzip.open(Path(folder) / 'pressure_msl-024.json.gz', 'rt') as f:
                saved = json.load(f)
            self.assertEqual(saved['units'], 'Pa')
            self.assertEqual(saved['grid'], indexer.GRID)
            self.assertEqual(saved['members'], MEMBERS)
            self.assertEqual(saved['run'], int(RUN.timestamp()))
            self.assertEqual(saved['time'], int(RUN.timestamp()) + 24 * 3600)
            self.assertNotIn('intervalHours', saved)
            result, calls = self.build(folder, b'unused cached source')
            self.assertTrue(result['cached'])
            self.assertEqual(calls, 0)

    def test_mismatched_pressure_cannot_create_a_verified_index(self):
        for change in ({'units': 'hPa'}, {'reference': int(RUN.timestamp()) - 21600}, {'members': [0] + list(range(1, 18))}, {'latitude_shift': .01}, {'shape': (18, 959, 1280)}, {'cell_methods': 'time: mean'}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(AssertionError):
                    self.build(folder, source_file(**change))
                self.assertFalse((Path(folder) / 'pressure_msl-024.json.gz').exists())

    def test_existing_pressure_index_without_units_or_grid_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'pressure_msl-024.json.gz'
            with gzip.open(target, 'wt') as f:
                json.dump({'schema': 1, 'etag': OBJECT['etag']}, f)
            result, calls = self.build(folder, source_file())
            self.assertFalse(result['cached'])
            self.assertEqual(calls, 1)
            # Existing verified temperature indexes remain reusable while the
            # additional pressure files are generated for the same run.
            with gzip.open(Path(folder) / 'temperature-024.json.gz', 'wt') as f:
                json.dump({'schema': 1, 'etag': OBJECT['etag']}, f)
            with patch.object(indexer.fsspec, 'open') as remote:
                result = indexer.build_file((RUN.isoformat(), 24, 'temperature', folder, OBJECT))
                self.assertTrue(result['cached'])
                remote.assert_not_called()

    def inventory(self, pressure=True):
        return {indexer.source_key(RUN, lead, kind): OBJECT for kind in indexer.KINDS if pressure or kind != 'pressure_msl' for lead in indexer.native_leads(kind)}

    def test_missing_pressure_files_cannot_replace_the_existing_latest_run(self):
        with tempfile.TemporaryDirectory() as folder:
            latest = Path(folder) / 'latest.json'
            latest.write_text('{"runId":"existing-complete-run"}')
            with patch.object(indexer, 'listing', return_value=self.inventory(pressure=False)), patch('sys.argv', ['index_mogreps.py', '--output', folder, '--run', RUN.isoformat()]), patch('sys.stdout', io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'No complete Met Office run'):
                    indexer.main()
            self.assertEqual(json.loads(latest.read_text())['runId'], 'existing-complete-run')

    def test_new_manifest_advertises_pressure_only_after_all_83_indexes_finish(self):
        jobs = []
        class Pool:
            def __init__(self, **kwargs):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def submit(self, fn, job):
                jobs.append(job)
                Path(job[3]).mkdir(parents=True, exist_ok=True)
                future = Future()
                future.set_result({'kind': job[2], 'lead': job[1], 'cached': True})
                return future
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(indexer, 'listing', return_value=self.inventory()), patch.object(indexer, 'ProcessPoolExecutor', Pool), patch('sys.argv', ['index_mogreps.py', '--output', folder, '--run', RUN.isoformat()]), patch('sys.stdout', io.StringIO()):
                indexer.main()
            manifest = json.loads((Path(folder) / 'latest.json').read_text())
            self.assertEqual(manifest['variables'], indexer.VARIABLES)
            self.assertEqual(manifest['members'], MEMBERS)
            self.assertEqual(manifest['grid'], indexer.GRID)
            self.assertEqual(manifest['run'], int(RUN.timestamp()))
            self.assertEqual(sorted(job[1] for job in jobs if job[2] == 'pressure_msl'), list(range(0, 247, 3)))


if __name__ == '__main__':
    unittest.main()
