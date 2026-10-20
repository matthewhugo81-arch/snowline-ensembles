"""Cheap independent freshness gate; do not rebuild unchanged scheduled runs."""
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
import json
import os
from pathlib import Path
from mogreps_source import get, newest_complete_after


def check():
    now = datetime.now(timezone.utc)
    try:
        manifest = json.loads(get('https://matthewhugo81-arch.github.io/snowline-ensembles/mogreps/latest.json'))
        reference = datetime.fromtimestamp(manifest['run'], timezone.utc)
        if manifest.get('schema') != 1 or len(manifest.get('members', [])) != 18:
            raise ValueError('Invalid published ensemble manifest')
        latest = newest_complete_after(reference, now)
        refresh = latest > reference or now - reference > timedelta(hours=48)
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
