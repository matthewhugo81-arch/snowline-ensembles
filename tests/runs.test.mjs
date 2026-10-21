import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fetchRunMetadata,fetchLatestRun,resolveFeedRuns,verifiedRun,runSummary,runDetail,runExport,formatRun,relevantSources} from '../docs/runs.js';
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

test('GEFS upper-air charts use only 0.5-degree timing; precip, snow and MSLP preserve both runs',()=>{
  const split=[source('ncep_gefs025',run+21600,run+25200),gfs[1]];
  const info=resolveFeedRuns(model('gfs'),split,split,requested+21600000,requested+21601000);
  assert.equal(runSummary(info,'temperature_850hPa'),'Feed run 19 Oct 06Z');
  assert.equal(runSummary(info,'temperature_500hPa'),'Feed run 19 Oct 06Z');
  assert.match(runSummary(info,'precipitation'),/0\.25° 19 Oct 12Z.*0\.5° 19 Oct 06Z/);
  assert.equal(relevantSources(info,'snow').length,2);
  assert.equal(relevantSources(info,'snowfall_member_agreement').length,2);
  assert.equal(relevantSources(info,'pressure_msl').length,2);
  assert.equal(runSummary(info,'pressure_msl'),runSummary(info,'precipitation'));
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
    assert.ok(parsed.searchParams.get('hourly').split(',').includes('pressure_msl'));
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

test('all run cards can be populated using metadata without any point forecast downloads',async t=>{
  const urls=[];
  t.mock.method(Date,'now',()=>requested);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    urls.push(String(url));
    assert.equal(options.cache,'no-store');
    if(String(url).endsWith('/latest.json'))return json({schema:1,run,runId:'20261019T0600Z',intervalHours:3,members:Array.from({length:18},(_,i)=>i),leads:Array.from({length:83},(_,i)=>i*3)});
    assert.match(String(url),/\/static\/meta\.json$/);
    return json(metadata(run));
  });
  const latest=await Promise.all(MODELS.map(m=>fetchLatestRun(m)));
  assert.equal(urls.length,5);
  assert.equal(urls.filter(url=>url.endsWith('/latest.json')).length,1);
  assert.ok(urls.every(url=>!url.includes('/v1/ensemble')&&!url.includes('/functions/v1/')));
  for(let i=0;i<3;i++){
    assert.equal(latest[i].type,'latest-feed');
    assert.equal(runSummary(latest[i]),'Latest feed run 19 Oct 06Z');
    assert.match(runDetail(latest[i]),/independently of the chart downloads/);
    assert.equal(runExport(latest[i]).run,'','latest feed is not a verified plotted cycle');
  }
  assert.equal(latest[3].type,'latest-manifest');
  assert.equal(runSummary(latest[3]),'Latest run 19 Oct 06Z');
  assert.equal(runExport(latest[3]).run,'','unloaded manifest must not be exported as a verified plotted cycle');
});

test('eager metadata and a simultaneous leading forecast check share only in-flight requests',async t=>{
  const finish=[];
  t.mock.method(Date,'now',()=>requested);
  t.mock.method(globalThis,'fetch',url=>new Promise(resolve=>{finish.push(()=>resolve(json(metadata(run))));}));
  const latest=fetchLatestRun(model('gfs'));
  const leading=fetchRunMetadata(model('gfs'));
  assert.equal(finish.length,2,'one request for each GEFS grid, not two per reader');
  finish.splice(0).forEach(resolve=>resolve());
  assert.equal((await latest).sources[0].run,run);
  assert.equal((await leading)[1].run,run);
  const later=fetchRunMetadata(model('gfs'));
  assert.equal(finish.length,2,'completed metadata is not reused as a current check');
  finish.splice(0).forEach(resolve=>resolve());
  await later;
});

test('a fresh trailing check stays independent of an in-flight catalogue request',async t=>{
  const finish=[];
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{finish.push(init=>resolve(json(metadata(init))));}));
  const catalogue=fetchLatestRun(model('ec'));
  const trailing=fetchRunMetadata(model('ec'),undefined,{fresh:true});
  assert.equal(finish.length,2);
  finish[1](run+21600);
  assert.equal((await trailing)[0].run,run+21600);
  finish[0](run);
  assert.equal((await catalogue).sources[0].run,run);
});

test('cancelling one metadata reader does not cancel another shared reader',async t=>{
  let finish,networkSignal;
  t.mock.method(globalThis,'fetch',(_url,options)=>{networkSignal=options.signal;return new Promise(resolve=>{finish=()=>resolve(json(metadata(run)));});});
  const controller=new AbortController();
  const first=fetchRunMetadata(model('ec'),controller.signal);
  const second=fetchLatestRun(model('ec'));
  controller.abort();
  await assert.rejects(first,{name:'AbortError'});
  assert.equal(networkSignal.aborted,false);
  finish();
  assert.equal((await second).sources[0].run,run);
});

test('latest feed status preserves mixed grids and an in-progress provider update',async t=>{
  t.mock.method(Date,'now',()=>requested);
  t.mock.method(globalThis,'fetch',async url=>json(String(url).includes('gefs025')?{...metadata(run+3600),last_run_availability_time:requested/1000-60}:metadata(run)));
  const latest=await fetchLatestRun(model('gfs'));
  assert.match(runSummary(latest),/Latest feed runs.*0\.25° 19 Oct 07Z \(updating\).*0\.5° 19 Oct 06Z/);
  assert.equal(runSummary(latest,'temperature_850hPa'),'Latest feed run 19 Oct 06Z');
});

test('absent or failed eager metadata never requires selecting a model or invents a run',async t=>{
  assert.equal(runSummary(null),'Checking latest run…');
  assert.doesNotMatch(runDetail(null),/Load this ensemble/);
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  assert.equal(runSummary(await fetchLatestRun(model('ec'))),'Latest feed run unavailable');
  assert.equal(runSummary(await fetchLatestRun(model('mogreps'))),'Latest run unavailable');
});

test('MOGREPS latest run validates the published manifest and identifies expired data',async t=>{
  t.mock.method(Date,'now',()=>requested+4*86400000);
  const manifest={schema:1,run,runId:'20261019T0600Z',intervalHours:3,members:Array.from({length:18},(_,i)=>i),leads:Array.from({length:83},(_,i)=>i*3)};
  let payload=manifest;
  t.mock.method(globalThis,'fetch',async()=>json(payload));
  const stale=await fetchLatestRun(model('mogreps'));
  assert.equal(stale.status,'stale');
  assert.equal(runSummary(stale),'Latest run 19 Oct 06Z (older run)');
  for(const changed of [{runId:'20261019T1200Z'},{members:Array(18).fill(0)},{leads:[0,3,6]},{run:run+10},{run:null}]){
    payload={...manifest,...changed};
    assert.equal((await fetchLatestRun(model('mogreps'))).run,null);
  }
});

test('a newer plotted run queues one catalogue refresh behind a slow lookup without relabelling other charts',async()=>{
  const app=await readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  const declarations=app.slice(app.indexOf('const RUN_CHECK_INTERVAL='),app.indexOf('const formatTime='));
  const catalogue=app.slice(app.indexOf('function runSignature('),app.indexOf('async function selectModel('));
  const storeDataset=app.slice(app.indexOf('function storeDataset('),app.indexOf('async function loadModel('));
  const requests=new Map(),finishMogreps=[],elements=new Map();
  const info=(m,init,type='latest-feed')=>m.id==='mogreps'?{type:'latest-manifest',run:init,status:'available',sources:[]}:{type,sources:[{domain:m.id,label:m.name,run:init,status:'available'}]};
  const ecDataset={runInfo:info(model('ec'),run,'feed')};
  const gfsDataset={runInfo:info(model('gfs'),run+21600,'feed')};
  const state={model:'gfs',datasets:new Map([['ec',ecDataset]]),latestRuns:new Map(),sampled:new Map(),pending:new Set(),errors:new Map(),progress:new Map()};
  let announceGfs;
  const gfsReady=new Promise(resolve=>{announceGfs=resolve;});
  const context=vm.createContext({
    MODELS,state,Date,Promise,valid:Number.isFinite,formatRun,runSummary,runDetail,
    document:{activeElement:null},configs:[{id:'temperature_850hPa'}],visibleModels:()=>[model('gfs'),model('ec')],
    escapeHTML:String,$:selector=>{if(!elements.has(selector))elements.set(selector,{});return elements.get(selector);},$$:()=>[],renderAvailability:()=>{if(state.latestRuns.has('gfs'))announceGfs();},
    fetchLatestRun:async m=>{
      const round=(requests.get(m.id)??0)+1;
      requests.set(m.id,round);
      if(m.id==='mogreps')await new Promise(resolve=>finishMogreps.push(resolve));
      return info(m,round===1?run:run+21600);
    }
  });
  vm.runInContext(declarations+catalogue+storeDataset,context);
  const initial=context.refreshLatestRuns({force:true});
  await gfsReady;
  assert.equal(state.latestRuns.get('gfs').sources[0].run,run);
  assert.equal(state.latestRuns.has('mogreps'),false,'the initial catalogue is still waiting on MOGREPS');
  context.storeDataset('gfs',gfsDataset);
  for(let i=0;i<4;i++)void context.refreshLatestRuns({force:true});
  assert.ok([...requests.values()].every(count=>count===1),'forced requests wait for the active round');
  finishMogreps[0]();
  await initial;
  assert.ok([...requests.values()].every(count=>count===2),'all forced requests coalesce into one additional round');
  const followup=vm.runInContext('latestRunsPromise',context);
  finishMogreps[1]();
  await followup;
  await Promise.resolve();
  assert.equal(vm.runInContext('latestRunsPromise',context),null);
  assert.equal(vm.runInContext('latestRunsQueued',context),false);
  assert.equal([...requests.values()].reduce((sum,count)=>sum+count,0),8,'there is no third catalogue round');
  assert.equal(state.latestRuns.get('gfs').sources[0].run,run+21600);
  assert.match(elements.get('#models').innerHTML,/Latest feed run 19 Oct 12Z/);
  assert.doesNotMatch(elements.get('#models').innerHTML,/model-plotted-run|Chart:/);
  assert.equal((elements.get('#models').innerHTML.match(/class="model-run"/g)??[]).length,MODELS.length);
  assert.match(elements.get('#run-temperature_850hPa').textContent,/GFS ENS · Feed run 19 Oct 12Z.*EC ENS · Feed run 19 Oct 06Z/);
  assert.equal(state.datasets.size,2,'catalogue refresh does not load or replace forecast datasets');
  assert.equal(state.datasets.get('gfs'),gfsDataset);
  assert.equal(state.datasets.get('ec'),ecDataset);
});
