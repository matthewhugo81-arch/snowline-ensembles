import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from check_index_freshness import companion_refresh

class CompanionFreshness(unittest.TestCase):
    def test_missing_anomaly_hours_resume_without_a_new_index(self):
        manifest={'run':1792454400,'leads':[0,3]}
        published={'reference_time':'2026-10-20T00:00:00Z','variable_valid_times':{}}
        self.assertTrue(companion_refresh(manifest,lambda _:json.dumps(published).encode()))

    def test_complete_companions_do_not_rebuild_until_gem_advances(self):
        manifest={'run':1792454400,'leads':[0,3]}
        fields=[f'{base}_{stat}' for base in ['geopotential_height_500hPa','wind_speed_300hPa','wind_speed_200hPa','pressure_msl'] for stat in ['mean','spread']]+['geopotential_height_500hPa_anomaly_mean']
        mog={'reference_time':'2026-10-20T00:00:00Z','variable_valid_times':{k:[0,3] for k in fields}}
        gem={'reference_time':'2026-10-20T00:00:00Z','completed':True,'valid_times':['2026-10-20T00:00:00Z']}
        def load(url):
            return json.dumps(mog if 'snowline_mogreps_global' in url else gem).encode()
        self.assertFalse(companion_refresh(manifest,load))
        gem['completed']=False
        self.assertTrue(companion_refresh(manifest,load))

    def test_new_gem_hours_start_before_the_completed_index_advances(self):
        manifest={'run':1792454400,'leads':[0,3]}
        fields=[f'{base}_{stat}' for base in ['geopotential_height_500hPa','wind_speed_300hPa','wind_speed_200hPa','pressure_msl'] for stat in ['mean','spread']]+['geopotential_height_500hPa_anomaly_mean']
        mog={'reference_time':'2026-10-20T00:00:00Z','variable_valid_times':{k:[0,3] for k in fields}}
        gem={'reference_time':'2026-10-20T00:00:00Z','completed':True,'valid_times':['2026-10-20T00:00:00Z']}
        incoming={'reference_time':'2026-10-20T12:00:00Z','completed':False,'valid_times':['2026-10-20T12:00:00Z']}
        def load(url):
            return json.dumps(mog if 'snowline_mogreps_global' in url else incoming if url.endswith('in-progress.json') else gem).encode()
        self.assertTrue(companion_refresh(manifest,load))

if __name__=='__main__':
    unittest.main()
