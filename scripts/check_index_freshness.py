"""Cheap independent freshness gate; do not rebuild unchanged scheduled runs."""
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
import json
import os
from pathlib import Path
from mogreps_source import get, newest_complete_after
from retain_map_runs import needs_refresh


def companion_refresh(manifest, load=get):
    """Resume unpublished field-hours even when the source index is unchanged."""
    base = 'https://matthewhugo81-arch.github.io/snowline-ensembles/ensemble-data/'
    try:
        mogreps = json.loads(load(base+'snowline_mogreps_global/latest.json'))
        reference = datetime.fromtimestamp(manifest['run'], timezone.utc)
        if datetime.fromisoformat(mogreps['reference_time'].replace('Z', '+00:00')) < reference:
            return True
        fields = [f'{base}_{stat}' for base in ['geopotential_height_500hPa','wind_speed_300hPa','wind_speed_200hPa','pressure_msl'] for stat in ['mean','spread']] + ['geopotential_height_500hPa_anomaly_mean']
        for key in fields:
            if len(mogreps.get('variable_valid_times', {}).get(key, [])) < len(manifest['leads']):
                return True
        gem = json.loads(load(base+'snowline_gem_upper/latest.json'))
        # The completed index can lag the first published hours of the next run.
        # Match the importer's latest/in-progress selection, including same-run
        # growth, instead of waiting for the entire native run to finish.
        candidates = []
        for filename in ('latest.json', 'in-progress.json'):
            try:
                native = json.loads(load('https://openmeteo.s3.amazonaws.com/data_spatial/cmc_gem_gdps_15km/'+filename))
                if native.get('valid_times'):
                    candidates.append(native)
            except HTTPError as error:
                if error.code != 404:
                    raise
        if not candidates:
            raise ValueError('No published native GEM hours verified')
        native = max(candidates, key=lambda meta: (meta['reference_time'], len(meta['valid_times'])))
        if gem['reference_time'] > native['reference_time']:
            return False
        return not gem.get('completed') or gem['reference_time'] < native['reference_time']
    except HTTPError as error:
        if error.code != 404:
            raise
        return True


def check():
    now = datetime.now(timezone.utc)
    try:
        manifest = json.loads(get('https://matthewhugo81-arch.github.io/snowline-ensembles/mogreps/latest.json'))
        reference = datetime.fromtimestamp(manifest['run'], timezone.utc)
        if manifest.get('schema') != 1 or len(manifest.get('members', [])) != 18:
            raise ValueError('Invalid published ensemble manifest')
        latest = newest_complete_after(reference, now)
        refresh = latest > reference or now - reference > timedelta(hours=48) or companion_refresh(manifest) or needs_refresh()
        print(f'Published: {reference.isoformat()}; newest complete: {latest.isoformat()}; refresh: {refresh}')
    except HTTPError as error:
        if error.code != 404:
            raise
        refresh = True
    if os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write(f'refresh={str(refresh).lower()}\n')
    return refresh


if __name__ == '__main__':
    check()
