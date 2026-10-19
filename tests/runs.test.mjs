import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRunMetadata,resolveFeedRuns,verifiedRun,runSummary,runDetail,runExport,formatRun,relevantSources} from '../docs/runs.js';
import {fetchEnsemble,MODELS,VARIABLES} from '../docs/data.js';

const run=Date.parse('2026-10-19T06:00:00Z')/1000;
const requested=(run+5*3600)*1000;
const model=id=>MODELS.find(m=>m.id===id);
const source=(domain,init=run,available=run+4*3600)=>({domain,run:init,available,modified:available,url:`https://ensemble-api.open-meteo.com/data/${domain}/static/meta.json`});
const ec=[source('ecmwf_ifs025_ensemble')];
const gfs=[source('ncep_gefs025'),source('ncep_gefs05')];
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const metadata=init=>({last_run_initialisation_time:init,last_run_modification_time:init+7200,last_run_availability_time:init+7200});

test('UTC issue label uses the source initialization, not availability or local time',()=>{
  assert.equal(formatRun(run),'19 Oct 06Z');
  assert.equal(formatRun(Date.parse('2026-10-18T18:00Z')/1000),'18 Oct 18Z');
  const info=resolveFeedRuns(model('ec'),ec,ec,requested,requested+500);
  assert.equal(runSummary(info),'Feed run 19 Oct 06Z');
  assert.equal(info.sources[0].status,'available');
});

test('rolling feed metadata cannot masquerade as a verified per-point run in exports',()=>{
  const info=resolveFeedRuns(model('ec'),ec,ec,requested,requested+500);
  const exported=runExport(info,'temperature_850hPa');
  assert.equal(exported.run,'');
  assert.equal(exported.feedRuns,'ecmwf_ifs025_ensemble=2026-10-19T06:00:00.000Z');
  assert.match(runDetail(info),/retain older runs/);
  assert.equal(verifiedRun({generationtime_ms:8,hourly:{time:[run]}}),null);
});

test('GEFS pressure charts use only 0.5-degree timing; precip and snow preserve both runs',()=>{
  const split=[source('ncep_gefs025',run+21600,run+25200),gfs[1]];
  const info=resolveFeedRuns(model('gfs'),split,split,requested+21600000,requested+21601000);
  assert.equal(runSummary(info,'temperature_850hPa'),'Feed run 19 Oct 06Z');
  assert.equal(runSummary(info,'temperature_500hPa'),'Feed run 19 Oct 06Z');
  assert.match(runSummary(info,'precipitation'),/0\.25° 19 Oct 12Z.*0\.5° 19 Oct 06Z/);
  assert.equal(relevantSources(info,'snow').length,2);
  assert.equal(relevantSources(info,'snowfall_member_agreement').length,2);
  assert.equal(runExport(info,'temperature_850hPa').feedRuns,'ncep_gefs05=2026-10-19T06:00:00.000Z');
  assert.match(runExport(info,'snowfall_member_agreement').feedRuns,/ncep_gefs025=.*ncep_gefs05=/);
});

test('matching GEFS component runs collapse to one label without losing provenance',()=>{
  const info=resolveFeedRuns(model('gfs'),gfs,gfs,requested,requested+1000);
  assert.equal(runSummary(info),'Feed run 19 Oct 06Z');
  assert.equal(info.sources.length,2);
});

test('newly available, changed and one-sided metadata never claim a settled chart run',()=>{
  const recent=[source('ecmwf_ifs025_ensemble',run,requested/1000-300)];
  const updating=resolveFeedRuns(model('ec'),recent,recent,requested,requested+1000);
  assert.equal(updating.sources[0].status,'updating');
  assert.match(runSummary(updating),/updating/);
  const newer=[source('ecmwf_ifs025_ensemble',run+21600,run+24000)];
  const changed=resolveFeedRuns(model('ec'),ec,newer,requested,requested+1000);
  assert.equal(changed.sources[0].status,'unverified');
  assert.match(runSummary(changed),/12Z \(unverified\)/);
  const changedData=[{...ec[0],modified:ec[0].modified+30}];
  assert.equal(resolveFeedRuns(model('ec'),ec,changedData,requested,requested).sources[0].status,'unverified');
  const otherServer=[{...ec[0],available:ec[0].available+30}];
  assert.equal(resolveFeedRuns(model('ec'),ec,otherServer,requested,requested).sources[0].status,'available');
  for(const [before,after] of [[[],ec],[ec,[]]])assert.equal(resolveFeedRuns(model('ec'),before,after,requested,requested).sources[0].status,'unverified');
});

test('absent issue metadata stays unavailable and does not use forecast valid times',()=>{
  const info=resolveFeedRuns(model('ec'),[],[],requested,requested);
  assert.equal(info.sources[0].run,null);
  assert.equal(runSummary(info),'Feed run unavailable');
  assert.equal(runExport(info).feedRuns,'');
});

test('direct Met Office run stays verified, including issue time in exports',()=>{
  const info=verifiedRun({run});
  assert.equal(runSummary(info),'Run 19 Oct 06Z');
  assert.equal(runExport(info).run,'2026-10-19T06:00:00.000Z');
  assert.equal(runExport(info).status,'verified');
});

test('metadata uses the actual ensemble feed domains and bypasses browser cache',async t=>{
  const urls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    urls.push(String(url));assert.equal(options.cache,'no-store');return json(metadata(run));
  });
  await fetchRunMetadata(model('gfs'));
  await fetchRunMetadata(model('gem'));
  assert.deepEqual(urls,[
    'https://ensemble-api.open-meteo.com/data/ncep_gefs025/static/meta.json',
    'https://ensemble-api.open-meteo.com/data/ncep_gefs05/static/meta.json',
    'https://ensemble-api.open-meteo.com/data/cmc_gem_geps/static/meta.json'
  ]);
});

test('network failure and malformed metadata fail open without inventing an issue time',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    if(calls++===0)throw Error('offline');
    return json({...metadata(run),last_run_initialisation_time:'2026-10-19T06:00Z'});
  });
  const result=await fetchRunMetadata(model('gfs'));
  assert.ok(result.every(item=>item.run===null));
});

test('user cancellation propagates instead of becoming missing metadata',async t=>{
  const controller=new AbortController();
  controller.abort();
  t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('Aborted','AbortError');});
  await assert.rejects(fetchRunMetadata(model('ec'),controller.signal),{name:'AbortError'});
});

test('forecast fetch brackets the same dataset with metadata and keeps verified run empty',async t=>{
  const order=[],hourly={time:[run+21600,run+25200]};
  for(const variable of VARIABLES){hourly[variable]=[1,2];hourly[variable+'_member01']=[2,3];}
  const raw={latitude:53.9,longitude:-2.2,hourly};
  t.mock.method(Date,'now',()=>requested);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.cache,'no-store');
    if(String(url).includes('/static/meta.json')){order.push('metadata');return json(metadata(run));}
    order.push('forecast');const parsed=new URL(url);
    assert.equal(parsed.searchParams.get('models'),'ecmwf_ifs025_ensemble');
    assert.equal(parsed.searchParams.get('past_days'),'1');
    return json(raw);
  });
  const result=await fetchEnsemble(model('ec'),{lat:53.9,lon:-2.2});
  assert.deepEqual(order,['metadata','forecast','metadata']);
  assert.equal(result.retrieved,requested);
  assert.equal(result.raw.run,undefined);
  assert.equal(result.runInfo.sources[0].run,run);
  assert.deepEqual(result.members.temperature_850hPa[1].values,[2,3]);
});

test('unavailable metadata never prevents otherwise valid forecast charts loading',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('/static/meta.json'))return new Response('',{status:503});
    return json({hourly:{time:[run],temperature_850hPa:[1]}});
  });
  const result=await fetchEnsemble(model('ec'),{lat:53.9,lon:-2.2});
  assert.equal(result.members.temperature_850hPa[0].values[0],1);
  assert.equal(runSummary(result.runInfo),'Feed run unavailable');
});

test('an overall deadline during trailing metadata keeps the successfully parsed forecast',async t=>{
  const controller=new AbortController();let metadataCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('/static/meta.json')){
      if(++metadataCalls===1)return json(metadata(run));
      controller.abort(new DOMException('Overall deadline expired','TimeoutError'));
      throw controller.signal.reason;
    }
    return json({hourly:{time:[run],temperature_850hPa:[7]}});
  });
  const result=await fetchEnsemble(model('ec'),{lat:53.9,lon:-2.2},controller.signal);
  assert.equal(result.members.temperature_850hPa[0].values[0],7);
  assert.equal(result.runInfo.sources[0].status,'unverified');
  assert.match(runSummary(result.runInfo),/19 Oct 06Z \(unverified\)/);
});

test('explicit cancellation during trailing metadata still rejects a completed forecast',async t=>{
  const controller=new AbortController();let metadataCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('/static/meta.json')){
      if(++metadataCalls===1)return json(metadata(run));
      controller.abort();
      throw controller.signal.reason;
    }
    return json({hourly:{time:[run],temperature_850hPa:[7]}});
  });
  await assert.rejects(fetchEnsemble(model('ec'),{lat:53.9,lon:-2.2},controller.signal),{name:'AbortError'});
});
