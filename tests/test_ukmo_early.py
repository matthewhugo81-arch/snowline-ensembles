from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import h5py
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ukmo_early_source as source
from build_ukmo_early import decode, prune

RUN = datetime(2026,10,20,12,tzinfo=timezone.utc)
VALID = RUN + timedelta(hours=57)


def fixture(field='precipitation'):
    file = h5py.File(io.BytesIO(), 'w')
    for name, value, units in [('forecast_reference_time',RUN.timestamp(),'seconds since 1970-01-01 00:00:00'),('time',VALID.timestamp(),'seconds since 1970-01-01 00:00:00'),('forecast_period',57*3600,'seconds')]:
        file.create_dataset(name,data=value).attrs['units'] = units
    file.create_dataset('latitude',data=-89.953125+np.arange(1920)*.09375)
    file.create_dataset('longitude',data=-179.9296875+np.arange(2560)*.140625)
    file.create_dataset('time_bnds',data=[VALID.timestamp()-10800,VALID.timestamp()])
    file.create_dataset('forecast_period_bnds',data=[54*3600,57*3600])
    spec=source.FIELDS[field]
    shape=(1920,2560) if spec[2] is None else (1,1920,2560)
    data=file.create_dataset(spec[1],shape=shape,dtype='f4',fillvalue=.003 if field=='precipitation' else 273.15,chunks=True)
    data.attrs.update(units=spec[3],standard_name=spec[1],cell_methods='time: sum')
    if spec[2] is not None:
        file.create_dataset('pressure',data=[spec[2]]).attrs['units']='Pa'
        file.create_dataset('flag',shape=shape,dtype='i1',fillvalue=0,chunks=True)
    return file


class DirectUKMOTests(unittest.TestCase):
    def test_native_rain_amount_and_precise_grid_are_preserved(self):
        with fixture() as file:
            values=decode(file,'precipitation',RUN,VALID)
            self.assertEqual(values.shape,(480,753))
            np.testing.assert_allclose(values,3,atol=.0001)

    def test_pressure_temperature_units_and_below_ground_mask(self):
        with fixture('temperature_850hPa') as file:
            file['flag'][0,1280,811]=1
            values=decode(file,'temperature_850hPa',RUN,VALID)
            self.assertTrue(np.isnan(values[0,0]))
            np.testing.assert_allclose(values[1:],0,atol=.0001)

    def test_changed_times_units_and_accumulation_bounds_are_rejected(self):
        for key,value in [('time',VALID.timestamp()+3600),('forecast_reference_time',RUN.timestamp()-21600),('time_bnds',[VALID.timestamp()-3600,VALID.timestamp()])]:
            with fixture() as file:
                file[key][...]=value
                with self.assertRaises(ValueError): decode(file,'precipitation',RUN,VALID)
        with fixture() as file:
            file['lwe_thickness_of_precipitation_amount'].attrs['units']='kg m-2'
            with self.assertRaises(ValueError): decode(file,'precipitation',RUN,VALID)

    def test_inventory_keeps_fields_as_they_arrive_and_checks_lead_identity(self):
        key='global-deterministic-10km/20261020T1200Z/20261020T1500Z-PT0003H00M-temperature_at_screen_level.nc'
        xml=f'<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>{key}</Key><Size>1024</Size><ETag>"abc"</ETag></Contents></ListBucketResult>'
        result=source.inventory(RUN,lambda _:xml.encode())
        self.assertEqual(list(result['2026-10-20T15:00:00Z']),['temperature_2m'])
        with self.assertRaises(ValueError):source.inventory(RUN,lambda _:xml.replace('PT0003','PT0004').encode())

    def test_early_hours_trigger_without_waiting_for_native_completion(self):
        available={'2026-10-20T15:00:00Z':{'temperature_2m':{'key':'x','etag':'y'}}}
        def load(url):
            return json.dumps({'reference_time':source.iso(RUN-timedelta(hours=6)),'completed':True} if url.startswith(source.NATIVE) else {}).encode()
        with patch.object(source,'inventory',return_value=available):
            self.assertEqual(source.pending(RUN+timedelta(hours=5),load),(RUN,available))
        with patch.object(source,'inventory') as listing:
            self.assertIsNone(source.pending(RUN+timedelta(hours=5),lambda _:json.dumps({'reference_time':source.iso(RUN),'completed':True}).encode()))
            listing.assert_not_called()

    def test_unchanged_inventory_does_not_dispatch_duplicate_builds(self):
        available={'2026-10-20T15:00:00Z':{'temperature_2m':{'key':'x','etag':'y'}}}
        def load(url):
            return json.dumps({'reference_time':source.iso(RUN-timedelta(hours=6)),'completed':True} if url.startswith(source.NATIVE) else {'reference_time':source.iso(RUN),'source_objects':available}).encode()
        with patch.object(source,'inventory',return_value=available):
            self.assertIsNone(source.pending(RUN+timedelta(hours=5),load))

    def test_retention_keeps_two_early_cycles_and_never_other_model_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); parent=root/source.DOMAIN
            for hour in ['0000Z','0600Z','1200Z']:
                folder=parent/'2026/10/20'/hour;folder.mkdir(parents=True);(folder/'meta.json').write_text('{}')
            other=root/'another-model';other.mkdir();(other/'keep').write_text('protected')
            prune(parent)
            self.assertEqual(len(list(parent.rglob('meta.json'))),2)
            self.assertTrue((parent/'2026/10/20/0600Z/meta.json').exists())
            self.assertTrue((other/'keep').exists())


if __name__=='__main__': unittest.main()
