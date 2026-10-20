import test from 'node:test';
import assert from 'node:assert/strict';
import {MODELS,VARIABLES,fetchEnsemble,resample,cumulativePrecipitation} from '../docs/data.js';

const hour=3600,day=24*hour;
const midnight=Date.parse('2026-10-20T00:00:00Z')/1000;
const json=body=>new Response(JSON.stringify(body));

for(const model of MODELS.filter(m=>m.id!=='mogreps')){
  for(const cycle of model.id==='gem'?[0,12]:[0,6,12,18]){
    test(`${model.name} ${String(cycle).padStart(2,'0')}Z retains the inclusive +${model.days*24}h endpoint`,async t=>{
      const run=midnight+cycle*hour,end=run+model.days*day;
      t.mock.method(Date,'now',()=>(run+5*hour)*1000);
      t.mock.method(globalThis,'fetch',async url=>{
        if(String(url).includes('/static/meta.json'))return json({
          last_run_initialisation_time:run,
          last_run_modification_time:run+4*hour,
          last_run_availability_time:run+4*hour
        });
        // Simulate the provider's UTC calendar-day bounds, including past_days.
        // Values beyond the model's real endpoint must stay missing.
        const params=new URL(url).searchParams;
        assert.equal(params.get('past_days'),'1');
        assert.equal(params.get('timezone'),'GMT');
        assert.equal(params.get('timeformat'),'unixtime');
        assert.deepEqual(params.get('hourly').split(','),VARIABLES);
        const start=midnight-Number(params.get('past_days'))*day;
        const stop=midnight+Number(params.get('forecast_days'))*day;
        const time=Array.from({length:(stop-start)/hour},(_,i)=>start+i*hour);
        const hourly={time};
        for(const variable of VARIABLES)for(let member=0;member<model.members;member++){
          hourly[variable+(member?`_member${member}`:'')]=time.map(t=>t<=end?1:null);
        }
        return json({hourly});
      });
      const dataset=await fetchEnsemble(model,{lat:53.9239,lon:-2.1949});
      assert.ok(dataset.raw.hourly.time.includes(end),'Request must include the final run-relative timestamp');
      for(const interval of [1,3,6]){
        const sample=resample(dataset,interval),last=sample.time.indexOf(end);
        assert.ok(last>=0);
        for(const variable of VARIABLES){
          const stat=sample.variables[variable].stats[last];
          assert.equal(stat.count,model.members);
          assert.equal(stat.mean,['precipitation','snowfall'].includes(variable)?interval:1);
          assert.ok(sample.variables[variable].stats.slice(last+1).every(s=>s.mean===null));
        }
        const summary=cumulativePrecipitation(sample,end-day,end);
        assert.equal(summary.status,'complete');
        assert.equal(summary.total,24);
      }
    });
  }
}
