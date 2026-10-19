"""Build small public byte-range indexes, never download whole model fields.

The native grid, member IDs, units, pressure mask and accumulation bounds are
validated before a run can become latest. An incomplete new run never replaces
the last complete forecast. Runtime products live in the Pages artifact, not Git.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import gzip
import itertools
import json
from pathlib import Path
import re
import shutil
import time
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import fsspec
import h5py
import numpy as np

ROOT = 'https://met-office-global-ensemble-model-data.s3.eu-west-2.amazonaws.com/'
NS = {'s': 'http://s3.amazonaws.com/doc/2006-03-01/'}
KINDS = {'temperature': ('temperature_on_pressure_levels', 'air_temperature'),
         'precipitation': ('precipitation_accumulation', 'lwe_thickness_of_precipitation_amount'),
         'snowfall': ('snowfall_accumulation', 'lwe_thickness_of_snowfall_amount')}


def listing(prefix):
    result = {}
    params = {'list-type': '2', 'prefix': prefix}
    while True:
        with urlopen(ROOT + '?' + urlencode(params), timeout=40) as r:
            xml = ET.fromstring(r.read())
        for obj in xml.findall('s:Contents', NS):
            result[obj.findtext('s:Key', namespaces=NS)] = {
                'size': int(obj.findtext('s:Size', namespaces=NS)),
                'etag': obj.findtext('s:ETag', namespaces=NS)}
        token = xml.findtext('s:NextContinuationToken', namespaces=NS)
        if not token:
            return result
        params['continuation-token'] = token


def source_key(run, lead, kind):
    valid = run + timedelta(hours=lead)
    param = KINDS[kind][0]
    if kind != 'temperature':
        param += '-PT01H' if lead <= 132 else '-PT03H'
    return (run.strftime('global-ensemble/%Y/%m/%d/T%H00Z/') +
            valid.strftime('%Y%m%dT%H00Z') + f'-PT{lead:04d}H00M-{param}.nc')


def native_leads(kind):
    return list(range(0, 247, 3)) if kind == 'temperature' else list(range(1, 133)) + list(range(135, 247, 3))


def text_attr(value):
    return value.decode() if isinstance(value, bytes) else str(value)


def dataset_index(d, levels=None):
    if d.dtype.str not in ('<f4', '|i1'):
        raise ValueError(f'Unsupported dtype {d.dtype.str}')
    filters = []
    plist = d.id.get_create_plist()
    for i in range(plist.get_nfilters()):
        fid, _, params, _ = plist.get_filter(i)
        if fid not in (1, 2):
            raise ValueError(f'Unsupported HDF5 filter {fid}')
        filters.append({'id': fid, 'params': list(params)})
    chunks = {}
    allowed = None if levels is None else {p // d.chunks[1] * d.chunks[1] for p in levels}
    def record(info):
        coord = info.chunk_offset
        if allowed is not None and coord[1] not in allowed:
            return
        if info.byte_offset is None or not info.size:
            raise ValueError('Missing source chunk')
        chunks[','.join(str(v // c) for v, c in zip(coord, d.chunks))] = [info.byte_offset, info.size, info.filter_mask]
    # One B-tree traversal; repeated coordinate lookups can re-scan large indexes.
    d.id.chunk_iter(record)
    expected = np.prod([int(np.ceil(n/c)) if i != 1 or allowed is None else len(allowed) for i, (n,c) in enumerate(zip(d.shape,d.chunks))])
    if len(chunks) != expected:
        raise ValueError('Incomplete chunk index')
    return {'shape': list(d.shape), 'chunkShape': list(d.chunks), 'dtype': d.dtype.str, 'fillValue': float(d.fillvalue),
            'filters': filters, 'chunks': chunks}


def build_file(job):
    run_iso, lead, kind, output, obj = job
    run = datetime.fromisoformat(run_iso)
    key = source_key(run, lead, kind)
    target = Path(output) / f'{kind}-{lead:03d}.json.gz'
    if target.exists():
        with gzip.open(target, 'rt') as f:
            saved = json.load(f)
        if saved.get('etag') == obj['etag'] and saved.get('schema') == 1:
            return {'kind': kind, 'lead': lead, 'cached': True}
    for attempt in range(3):
        try:
            with fsspec.open(ROOT + key, 'rb', block_size=16384, cache_type='blockcache') as remote:
                with h5py.File(remote, 'r') as f:
                    reference = int(f['forecast_reference_time'][()])
                    valid = int(f['time'][()])
                    assert reference == int(run.timestamp()) and valid == reference + lead * 3600
                    members = f['realization'][:].astype(int).tolist()
                    expected = [0] + list(range(1, 18) if run.hour in (0, 12) else range(18, 35))
                    assert members == expected
                    lat, lon = f['latitude'][:], f['longitude'][:]
                    assert len(lat) == 960 and len(lon) == 1280
                    assert np.allclose(lat, -89.90625 + np.arange(960) * .1875)
                    assert np.allclose(lon, -179.859375 + np.arange(1280) * .28125)
                    var = f[KINDS[kind][1]]
                    doc = {'schema': 1, 'key': key, 'size': obj['size'], 'etag': obj['etag'],
                           'run': reference, 'time': valid, 'members': members, 'kind': kind}
                    if kind == 'temperature':
                        assert text_attr(var.attrs['units']) == 'K'
                        levels = [int(np.flatnonzero(f['pressure'][:] == p)[0]) for p in (85000, 50000)]
                        doc['levels'] = levels
                        doc['data'] = dataset_index(var, levels)
                        flag = f['flag']
                        assert text_attr(flag.attrs['flag_meanings']) == 'above_surface_pressure below_surface_pressure'
                        assert flag.attrs['flag_values'].tolist() == [0, 1]
                        doc['flag'] = dataset_index(flag, levels)
                    else:
                        assert text_attr(var.attrs['units']) == 'm'
                        assert text_attr(var.attrs['cell_methods']) == 'time: sum'
                        duration = 1 if lead <= 132 else 3
                        bounds = f['time_bnds'][:].reshape(-1).astype(int).tolist()
                        assert bounds == [valid - duration * 3600, valid]
                        doc['intervalHours'] = duration
                        doc['data'] = dataset_index(var)
            target.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(str(target) + '.tmp', 'wt', compresslevel=6) as f:
                json.dump(doc, f, separators=(',', ':'))
            Path(str(target) + '.tmp').replace(target)
            return {'kind': kind, 'lead': lead, 'cached': False}
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='docs/mogreps')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--run', help='Explicit run, e.g. 2026-10-19T06:00:00+00:00')
    parser.add_argument('--probe', action='store_true', help='Index only +24h temperature and +22/23/24 accumulations')
    args = parser.parse_args()
    output = Path(args.output)
    now = datetime.now(timezone.utc)
    cycle = now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0)
    candidates = [datetime.fromisoformat(args.run)] if args.run else [cycle - timedelta(hours=6*i) for i in range(9)]
    jobs = None
    for run in candidates:
        inventory = listing(run.strftime('global-ensemble/%Y/%m/%d/T%H00Z/'))
        needed = [(kind, lead) for kind in KINDS for lead in native_leads(kind)]
        if args.probe:
            needed = [('temperature', 24)] + [(kind, lead) for kind in ('precipitation', 'snowfall') for lead in (22, 23, 24)]
        if all(source_key(run, lead, kind) in inventory for kind, lead in needed):
            run_id = run.strftime('%Y%m%dT%H00Z')
            folder = output / run_id
            jobs = [(run.isoformat(), lead, kind, str(folder), inventory[source_key(run, lead, kind)]) for kind, lead in needed]
            break
        print(f'Run {run.isoformat()} not complete; checking previous cycle', flush=True)
    if jobs is None:
        raise RuntimeError('No complete Met Office run in the last 48 hours')
    print(f'Indexing {run_id}: {len(jobs)} files, {args.workers} processes', flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(build_file, j) for j in jobs]
        for n, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if n % 20 == 0 or args.probe:
                print(f'{n}/{len(jobs)} indexed; {result}', flush=True)
    manifest = {'schema': 1, 'runId': run_id, 'run': int(run.timestamp()),
                'generated': datetime.now(timezone.utc).isoformat(), 'members': [0] + list(range(1, 18) if run.hour in (0, 12) else range(18, 35)),
                'grid': {'latitude': [-89.90625, .1875, 960], 'longitude': [-179.859375, .28125, 1280]},
                'leads': list(range(0, 247, 3)), 'intervalHours': 3,
                'source': 'Met Office MOGREPS-G on AWS', 'license': 'CC BY-SA 4.0',
                'sourceUrl': 'https://registry.opendata.aws/met-office-global-ensemble/'}
    (folder / 'manifest.json').write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf-8')
    if args.probe:
        print('Probe only; latest pointer not updated', flush=True)
        return
    (output / 'latest.json').write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf-8')
    # Retain 48h of indexes for browsers that already pinned a run.
    for path in output.iterdir():
        if path.is_dir() and re.fullmatch(r'\d{8}T\d{4}Z', path.name):
            age = now - datetime.strptime(path.name, '%Y%m%dT%H%MZ').replace(tzinfo=timezone.utc)
            if age > timedelta(hours=48):
                shutil.rmtree(path)
    print(f'Complete: {run_id}', flush=True)


if __name__ == '__main__':
    main()
