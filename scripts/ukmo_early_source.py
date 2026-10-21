"""Public Met Office native-file discovery, without a DataHub account or quota."""
from datetime import datetime, timedelta, timezone
import json
import re
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

BUCKET = 'https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com/'
DOMAIN = 'snowline_ukmo_early'
PUBLISHED = 'https://matthewhugo81-arch.github.io/snowline-ensembles/ensemble-data/'
NATIVE = 'https://openmeteo.s3.amazonaws.com/data_spatial/ukmo_global_deterministic_10km/'
FIELDS = {
    'temperature_2m': ('temperature_at_screen_level', 'air_temperature', None, 'K', 1, -273.15, 20, '°C'),
    'pressure_msl': ('pressure_at_mean_sea_level', 'air_pressure_at_sea_level', None, 'Pa', .01, 0, 10, 'hPa'),
    'geopotential_height_500hPa': ('geopotential_height_on_pressure_levels', 'geopotential_height', 50000, 'm', 1, 0, 1, 'm'),
    'temperature_850hPa': ('temperature_on_pressure_levels', 'air_temperature', 85000, 'K', 1, -273.15, 20, '°C'),
    'cloud_cover': ('cloud_amount_of_total_cloud', 'cloud_area_fraction', None, '1', 100, 0, 1, '%'),
    'precipitation': ('precipitation_accumulation', 'lwe_thickness_of_precipitation_amount', None, 'm', 1000, 0, 1000, 'mm'),
}
GRID = dict(type='regular', nx=753, ny=480, latMin=30.046875, lonMin=-65.8828125, dx=.140625, dy=.09375, zoom=3)


def get(url):
    with urlopen(url, timeout=30) as response:
        return response.read()


def iso(value):
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def reference(value):
    run = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if run.utcoffset() != timedelta(0) or run.hour % 6 or run.minute or run.second or run.microsecond:
        raise ValueError('Expected a UTC UKMO main initialization')
    return run


def period(lead):
    return 1 if lead <= 54 else 3 if lead <= 144 else 6


def inventory(run, load=get):
    """List immutable objects; require matching filename initialization/lead/time."""
    prefix = 'global-deterministic-10km/' + run.strftime('%Y%m%dT%H%MZ') + '/'
    query = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
    found = {}
    for _ in range(12):
        root = ET.fromstring(load(BUCKET + '?' + urlencode(query)))
        for item in root.findall('{*}Contents'):
            key = item.findtext('{*}Key')
            if not key.startswith(prefix):
                raise ValueError('Unexpected source prefix')
            match = re.fullmatch(r'(\d{8}T\d{4}Z)-PT(\d{4})H00M-(.+)\.nc', key[len(prefix):])
            if not match:
                continue
            valid, lead, filename = match.groups()
            lead = int(lead)
            if lead > 168 or (lead > 54 and lead % period(lead)):
                continue
            if valid != (run + timedelta(hours=lead)).strftime('%Y%m%dT%H%MZ'):
                raise ValueError('Source valid time differs from forecast lead')
            for field, spec in FIELDS.items():
                expected = spec[0] + (f'-PT{period(lead):02d}H' if field == 'precipitation' else '')
                if filename == expected and (field != 'precipitation' or lead > 0):
                    etag = item.findtext('{*}ETag')
                    if not etag or int(item.findtext('{*}Size', '0')) < 32:
                        raise ValueError('Invalid source object')
                    found.setdefault(iso(run + timedelta(hours=lead)), {})[field] = dict(key=key, etag=etag)
        token = root.findtext('{*}NextContinuationToken')
        if root.findtext('{*}IsTruncated') != 'true':
            return found
        if not token:
            raise ValueError('Truncated source inventory has no continuation')
        query['continuation-token'] = token
    raise ValueError('Unexpectedly large source inventory')


def pending(now=None, load=get):
    """New raw hours trigger publication even before the intermediary indexes them."""
    now = now or datetime.now(timezone.utc)
    native = json.loads(load(NATIVE + 'latest.json'))
    completed = reference(native['reference_time']) if native.get('completed') is True else now - timedelta(days=2)
    try:
        published = json.loads(load(PUBLISHED + DOMAIN + '/latest.json'))
    except HTTPError as error:
        if error.code != 404:
            raise
        published = {}
    cycle = now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0)
    for run in [cycle - timedelta(hours=6*i) for i in range(4)]:
        if run <= completed:
            break
        available = inventory(run, load)
        if not available:
            continue
        old = published.get('source_objects', {}) if published.get('reference_time') == iso(run) else {}
        if any(old.get(time, {}).get(field) != item for time, fields in available.items() for field, item in fields.items()):
            return run, available
        # The newest raw cycle is already published; never rewind to older data.
        return None
    return None
