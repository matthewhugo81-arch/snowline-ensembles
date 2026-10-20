"""Retain complete additional ensemble fields without copying native model grids."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
from urllib.error import HTTPError
from urllib.request import urlopen

SOURCE = 'https://matthewhugo81-arch.github.io/snowline/ensemble-data/'
PUBLISHED = 'https://matthewhugo81-arch.github.io/snowline-ensembles/ensemble-data/'
DOMAINS = ('snowline_gefs_extra_v2', 'snowline_ecmwf_extra_v2')


def get(url):
    with urlopen(url, timeout=45) as response:
        return response.read()


def run_path(reference):
    return datetime.fromisoformat(reference.replace('Z', '+00:00')).strftime('%Y/%m/%d/%H%MZ')


def needs_refresh(load=get):
    for domain in DOMAINS:
        try:
            latest = json.loads(load(SOURCE + domain + '/latest.json'))
            if latest.get('completed') is not True:
                continue
            archived = json.loads(load(PUBLISHED + domain + '/' + run_path(latest['reference_time']) + '/meta.json'))
            if archived.get('completed') is not True:
                return True
        except HTTPError as error:
            if error.code == 404:
                return True
            raise
    return False


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix('.tmp').write_text(json.dumps(data, indent=2) + '\n')
    path.with_suffix('.tmp').replace(path)


def retain(domain, root=Path('docs/ensemble-data'), load=get):
    latest = json.loads(load(SOURCE + domain + '/latest.json'))
    reference = latest['reference_time']
    parent = root / domain
    if latest.get('completed') is True:
        if latest.get('domain') != domain or not latest.get('valid_times') or not latest.get('variables'):
            raise ValueError('Invalid completed source run')
        folder = parent / run_path(reference)
        folder.mkdir(parents=True, exist_ok=True)
        def copy_frame(time):
            if datetime.fromisoformat(time.replace('Z', '+00:00')) < datetime.fromisoformat(reference.replace('Z', '+00:00')):
                raise ValueError('Forecast precedes initialization')
            name = time[:16].replace(':', '') + '.om'
            target = folder / name
            if target.exists() and target.stat().st_size > 0:
                return
            data = load(SOURCE + domain + '/' + run_path(reference) + '/' + name + '.png')
            if len(data) < 32:
                raise ValueError('Empty forecast frame')
            target.with_suffix('.tmp').write_bytes(data)
            target.with_suffix('.tmp').replace(target)
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(copy_frame, latest['valid_times']))
        atomic_json(folder / 'meta.json', latest)
    # During an incoming run protect one complete predecessor. Immediately after
    # completion keep the preceding complete generation too for existing viewers.
    available = []
    for folder in parent.glob('*/*/*/*Z'):
        if (folder / 'meta.json').is_file():
            meta = json.loads((folder / 'meta.json').read_text())
            if meta.get('completed') is True and all((folder / (t[:16].replace(':', '') + '.om')).is_file() for t in meta['valid_times']):
                available.append((meta['reference_time'], folder))
    available.sort(reverse=True)
    current = [item for item in available if item[0] == reference]
    previous = [item for item in available if item[0] < reference][:1]
    keep = {folder for _, folder in current + previous}
    if not keep and available:
        keep.add(available[0][1])
    for _, folder in available:
        if folder not in keep:
            if not folder.resolve().is_relative_to(parent.resolve()):
                raise ValueError('Refusing cleanup outside retained model data')
            shutil.rmtree(folder)
    atomic_json(parent / 'history.json', dict(format_version=1, runs=[ref for ref, folder in available if folder in keep]))
    total = sum(p.stat().st_size for p in parent.rglob('*') if p.is_file())
    print(f'{domain}: {len(keep)} complete runs, {total / 1024**2:.1f} MiB retained', flush=True)


if __name__ == '__main__':
    for domain in DOMAINS:
        try:
            retain(domain)
        except Exception as error:
            print(f'::warning::{domain}: retention retry needed: {error}', flush=True)
