"""Bounded native-resolution UK/Europe/Atlantic UKMO charts ahead of the full feed."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import argparse
import json
from pathlib import Path
import shutil
import time
import fsspec
import h5py
import numpy as np
from omfiles import OmFileWriter
from ukmo_early_source import BUCKET, DOMAIN, FIELDS, GRID, inventory, iso, pending, period, reference
from retain_map_runs import atomic_json, run_path


def text(value):
    return value.decode() if isinstance(value, bytes) else str(value)


def decode(file, field, run, valid):
    spec = FIELDS[field]
    lead = int((valid-run).total_seconds()/3600)
    for key, value in [('forecast_reference_time', run.timestamp()), ('time', valid.timestamp())]:
        if text(file[key].attrs['units']) != 'seconds since 1970-01-01 00:00:00' or float(file[key][()]) != value:
            raise ValueError('Incorrect native initialization or valid time')
    if text(file['forecast_period'].attrs['units']) != 'seconds' or float(file['forecast_period'][()]) != lead*3600:
        raise ValueError('Incorrect native forecast period')
    lat, lon = file['latitude'][:], file['longitude'][:]
    if lat.shape != (1920,) or lon.shape != (2560,) or not np.allclose(lat, -89.953125+np.arange(1920)*.09375, atol=1e-6, rtol=0) or not np.allclose(lon, -179.9296875+np.arange(2560)*.140625, atol=1e-6, rtol=0):
        raise ValueError('Unexpected native grid')
    yi, xi = np.flatnonzero((lat >= 30) & (lat <= 75)), np.flatnonzero((lon >= -66) & (lon <= 40))
    selection = (slice(yi[0], yi[-1]+1), slice(xi[0], xi[-1]+1))
    if spec[2] is not None:
        if text(file['pressure'].attrs['units']) != 'Pa':
            raise ValueError('Unexpected pressure coordinate units')
        levels = np.flatnonzero(file['pressure'][:] == spec[2])
        if len(levels) != 1:
            raise ValueError('Missing or duplicated pressure level')
        selection = (int(levels[0]), *selection)
    data = file[spec[1]]
    if text(data.attrs['units']) != spec[3] or text(data.attrs['standard_name']) != spec[1]:
        raise ValueError('Unexpected field identity or units')
    if field == 'precipitation':
        if lead <= 0 or not np.array_equal(file['time_bnds'][:], [valid.timestamp()-period(lead)*3600, valid.timestamp()]) or not np.array_equal(file['forecast_period_bnds'][:], [(lead-period(lead))*3600, lead*3600]) or text(data.attrs.get('cell_methods', '')) != 'time: sum':
            raise ValueError('Unverified precipitation accumulation interval')
    values = data[selection].astype(np.float32)
    values[abs(values) > 1e20] = np.nan
    if spec[2] is not None:
        values[file['flag'][selection] != 0] = np.nan
    values = values * spec[4] + spec[5]
    if values.shape != (GRID['ny'], GRID['nx']) or not np.isfinite(values).any():
        raise ValueError('No usable native subset')
    if field == 'cloud_cover' and (np.nanmin(values) < -.01 or np.nanmax(values) > 100.01):
        raise ValueError('Invalid cloud fraction')
    if field == 'precipitation' and np.nanmin(values) < -.001:
        raise ValueError('Negative precipitation')
    return np.ascontiguousarray(values)


def read_field(item, field, run, valid):
    # Pin all byte ranges to the inventoried object. A mid-read replacement fails.
    for attempt in range(3):
        try:
            with fsspec.open(BUCKET + item['key'], 'rb', block_size=262144, cache_type='blockcache', headers={'If-Match': item['etag']}, client_kwargs={'timeout': __import__('aiohttp').ClientTimeout(total=40)}) as remote:
                with h5py.File(remote, 'r') as file:
                    return decode(file, field, run, valid)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt+1)


def build_frame(folder, run, valid_text, items):
    valid = datetime.fromisoformat(valid_text.replace('Z', '+00:00'))
    # Atomic frame replacement: retain the old frame if any advertised field fails.
    arrays = {field: read_field(item, field, run, valid) for field, item in items.items()}
    target = folder / (valid_text[:16].replace(':', '') + '.om')
    temporary = target.with_suffix('.tmp')
    writer = OmFileWriter(str(temporary))
    children = [writer.write_array(values, chunks=[10,100], scale_factor=FIELDS[field][6], add_offset=0, compression='pfor_delta_2d', name=field) for field, values in arrays.items()]
    writer.close(writer.write_group(name='root', children=children))
    return valid_text, items, temporary, target


def prune(parent):
    folders = sorted([p.parent for p in parent.glob('*/*/*/*Z/meta.json')], reverse=True)
    for folder in folders[2:]:
        if not folder.resolve().is_relative_to(parent.resolve()):
            raise ValueError('Cleanup escaped UKMO early cache')
        shutil.rmtree(folder)


def build(run, available, root, workers=4):
    parent = root / DOMAIN
    folder = parent / run_path(iso(run))
    folder.mkdir(parents=True, exist_ok=True)
    existing = json.loads((folder / 'meta.json').read_text()) if (folder / 'meta.json').exists() else {}
    kept = {t: fields for t, fields in existing.get('source_objects', {}).items() if (folder / (t[:16].replace(':','')+'.om')).is_file()}
    tasks = [(t, {**kept.get(t, {}), **items}) for t, items in available.items() if kept.get(t) != items]
    errors = []
    publication = root.parent if root.parent.name == 'docs' else root
    size_of = lambda path: sum(p.stat().st_size for p in path.rglob('*') if p.is_file() and p.suffix != '.tmp')
    own_bytes, publication_bytes = size_of(parent), size_of(publication)
    def publish():
        fields = [field for field in FIELDS if any(field in items for items in kept.values())]
        metadata = dict(format_version=1, domain=DOMAIN, reference_time=iso(run), completed=False,
                        grid=GRID, variables=fields, valid_times=sorted(kept),
                        variable_valid_times={field: sorted(t for t, items in kept.items() if field in items) for field in fields},
                        units={field: FIELDS[field][7] for field in fields}, source_objects=kept,
                        source='Met Office Global Deterministic 10 km, public native NetCDF',
                        license='CC BY-SA 4.0; British Crown copyright, Met Office',
                        coverage='66°W–40°E, 30–75°N; native grid cells; no interpolation',
                        last_modified_time=iso(datetime.now(timezone.utc)))
        atomic_json(folder / 'meta.json', metadata)
        latest_file = parent / 'latest.json'
        latest = json.loads(latest_file.read_text()) if latest_file.exists() else {}
        if latest.get('reference_time', '') <= iso(run):
            atomic_json(latest_file, metadata)
        return metadata
    # At most 89 native forecast times and four concurrent regional decodes.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(build_frame, folder, run, t, fields): t for t, fields in tasks}
        for future in as_completed(futures):
            try:
                valid, items, temporary, target = future.result()
                delta = temporary.stat().st_size - (target.stat().st_size if target.exists() else 0)
                if own_bytes + delta > 249_000_000 or publication_bytes + delta > 949_000_000:
                    temporary.unlink()
                    raise ValueError('UKMO early capacity budget reached; existing charts retained')
                temporary.replace(target)
                own_bytes += delta
                publication_bytes += delta
                kept[valid] = items
                publish()  # A time budget expiry still leaves verified progress resumable.
                if len(list(parent.glob('*/*/*/*Z/meta.json'))) > 2:
                    prune(parent)
                    own_bytes, publication_bytes = size_of(parent), size_of(publication)
            except Exception as error:
                errors.append(str(error))
                print(f'::warning::UKMO {futures[future]} retry required: {error}', flush=True)
    if not kept:
        raise ValueError('No direct UKMO hours could be verified')
    metadata = publish()
    prune(parent)
    size = sum(p.stat().st_size for p in parent.rglob('*') if p.is_file())
    if size > 250_000_000:
        raise ValueError('UKMO early cache exceeds its 250 MB budget')
    print(f'UKMO early {iso(run)}: {len(kept)} times, {len(metadata["variables"])} fields, {size} bytes, {len(errors)} retryable failures', flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('docs/ensemble-data'))
    parser.add_argument('--run', help='Explicit initialization for bounded validation')
    parser.add_argument('--hours', help='Comma-separated test leads; production uses all published hours')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    work = (reference(args.run), None) if args.run else pending()
    if work is None:
        print('UKMO early: no unpublished hours ahead of the full native feed')
        return
    run, available = work
    available = available if available is not None else inventory(run)
    if args.hours:
        leads = {int(h) for h in args.hours.split(',')}
        available = {t: fields for t, fields in available.items() if int((datetime.fromisoformat(t.replace('Z','+00:00'))-run).total_seconds()/3600) in leads}
    build(run, available, args.output, max(1, min(args.workers, 4)))


if __name__ == '__main__':
    main()
