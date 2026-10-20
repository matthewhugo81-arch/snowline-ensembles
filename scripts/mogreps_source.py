"""Independent, bounded inventory check of complete Met Office global cycles."""
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

ROOT = 'https://met-office-global-ensemble-model-data.s3.eu-west-2.amazonaws.com/'
KINDS = ('temperature_on_pressure_levels', 'pressure_at_mean_sea_level',
         'precipitation_accumulation', 'snowfall_accumulation')


def required_keys(run):
    prefix = run.strftime('global-ensemble/%Y/%m/%d/T%H00Z/')
    for kind in KINDS:
        accumulation = kind.endswith('_accumulation')
        leads = list(range(1, 133)) + list(range(135, 247, 3)) if accumulation else range(0, 247, 3)
        for lead in leads:
            period = ('-PT01H' if lead <= 132 else '-PT03H') if accumulation else ''
            yield (prefix + (run + timedelta(hours=lead)).strftime('%Y%m%dT%H00Z')
                   + f'-PT{lead:04d}H00M-{kind}{period}.nc')


def get(url):
    with urlopen(url, timeout=20) as response:
        return response.read()


def complete(run, fetch=get):
    needed = set(required_keys(run))
    query = {'list-type': '2', 'prefix': run.strftime('global-ensemble/%Y/%m/%d/T%H00Z/')}
    tokens = set()
    for _ in range(40):
        tree = ET.fromstring(fetch(ROOT + '?' + urlencode(query)))
        needed.difference_update(n.text for n in tree.findall('{*}Contents/{*}Key'))
        if not needed:
            return True
        if tree.findtext('{*}IsTruncated') != 'true':
            return False
        token = tree.findtext('{*}NextContinuationToken')
        if not token or token in tokens:
            raise ValueError('Invalid Met Office listing pagination')
        tokens.add(token)
        query['continuation-token'] = token
    raise ValueError('Met Office listing exceeded pagination limit')


def newest_complete_after(reference, now, fetch=get):
    candidate = now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0)
    # At most the latest four cycles; outages never create an unbounded crawl.
    for _ in range(4):
        if candidate <= reference:
            break
        if complete(candidate, fetch):
            return candidate
        candidate -= timedelta(hours=6)
    return reference
