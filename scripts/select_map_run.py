"""Finish the published partial run before advancing the source index."""
from datetime import datetime, timedelta, timezone
import json
from urllib.error import HTTPError
from mogreps_source import get

URL = 'https://matthewhugo81-arch.github.io/snowline-ensembles/ensemble-data/snowline_mogreps_global/latest.json'


def pending_run(meta, now):
    # Supplemental native layers and the optional NOAA anomaly continue on
    # later passes; they must not hold a complete core cycle behind newer data.
    if meta.get('completed') or meta.get('core_completed') is True:
        return ''
    reference = datetime.fromisoformat(meta['reference_time'].replace('Z', '+00:00'))
    if reference.tzinfo is None or reference.minute or reference.second or reference.microsecond or reference.hour not in (0, 6, 12, 18):
        raise ValueError('Invalid published MOGREPS initialization')
    # Do not pin the importer indefinitely to source files which have expired.
    if not timedelta(0) <= now - reference < timedelta(hours=48):
        return ''
    return reference.astimezone(timezone.utc).isoformat()


def main():
    try:
        meta = json.loads(get(URL))
    except HTTPError as error:
        if error.code != 404:
            raise
        meta = {'completed': True}
    print('run=' + pending_run(meta, datetime.now(timezone.utc)))


if __name__ == '__main__':
    main()
