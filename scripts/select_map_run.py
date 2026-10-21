"""Finish the published partial run before advancing the source index."""
from datetime import datetime, timedelta, timezone
import json
from urllib.error import HTTPError
from mogreps_source import get

URL = 'https://matthewhugo81-arch.github.io/snowline-ensembles/ensemble-data/snowline_mogreps_global/latest.json'


def verified_core_coverage(meta, reference):
    # Existing publications predate core_completed. Verify their actual field
    # times so an optional-source outage does not require one more old run.
    if meta.get('format_version') != 2 or meta.get('member_count') != 18:
        return False
    instant = ['temperature_850hPa_mean', 'temperature_850hPa_spread', 'temperature_500hPa_mean', 'temperature_500hPa_spread']
    period = ['precipitation_mean', 'snowfall_water_equivalent_mean', 'precipitation_probability', 'snowfall_probability']
    for field in instant + period:
        expected = {reference + timedelta(hours=h) for h in range(0 if field in instant else 3, 247, 3)}
        try:
            actual = {datetime.fromisoformat(value.replace('Z', '+00:00')) for value in meta.get('variable_valid_times', {}).get(field, [])}
        except (TypeError, ValueError, AttributeError):
            return False
        if not expected <= actual:
            return False
    return True


def pending_run(meta, now):
    # Supplemental native layers and the optional NOAA anomaly continue on
    # later passes; they must not hold a complete core cycle behind newer data.
    if meta.get('completed') or meta.get('core_completed') is True:
        return ''
    reference = datetime.fromisoformat(meta['reference_time'].replace('Z', '+00:00'))
    if reference.tzinfo is None or reference.minute or reference.second or reference.microsecond or reference.hour not in (0, 6, 12, 18):
        raise ValueError('Invalid published MOGREPS initialization')
    if verified_core_coverage(meta, reference):
        return ''
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
