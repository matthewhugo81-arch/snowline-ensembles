import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchMogreps,MOGREPS_VARIABLES} from '../docs/mogreps.js';
import {retryAfter} from '../docs/mogreps-transport.js';

const manifest={schema:1,run:1792454400,runId:'20261020T0000Z',intervalHours:3,
 members:[0,...Array.from({length:17},(_,i)=>i+18)],leads:Array.from({length:83},(_,i)=>i*3),variables:MOGREPS_VARIABLES};
const step=lead=>({schema:1,run:manifest.run,time:manifest.run+lead*3600,intervalHours:3,members:manifest.members,
 latitude:53.90625,longitude:-2.109375,units:{pressure_msl:'hPa'},values:{
 temperature_850hPa:Array(18).fill(4),temperature_500hPa:Array(18).fill(-15),
 precipitation:Array(18).fill(lead?3:null),snowfall:Array(18).fill(lead?.06:null),pressure_msl:Array(18).fill(1000)}});
function fixture(respond,settings={}) {
 let clock=manifest.run*1000+3600000;const requests=[],waits=[];
 const options={now:()=>clock,random:()=>0,cooldown:{until:0},
  sleep:async(ms,signal)=>{signal?.throwIfAborted();if(ms>0){waits.push(ms);clock+=ms;}},
  fetcher:async(url,init)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/latest.json'))return Response.json(manifest);
   const lead=+parsed.searchParams.get('lead');requests.push({lead,time:clock});return respond(lead,requests,init.signal);},...settings};
 return {requests,waits,options,load:(signal,onProgress)=>fetchMogreps({lat:54,lon:-2},signal,onProgress,options)};
}

test('a service-wide 503 outage stops a load after bounded delayed attempts',async()=>{
 const f=fixture(()=>new Response('',{status:503}));
 await assert.rejects(f.load(),/repeatedly failed/);
 assert.ok(f.requests.length<=11,`Only ${f.requests.length} point requests; not 249`);
 assert.ok(f.waits.length&&f.waits.every(ms=>ms>=500),'Retries back off instead of running in a burst');
});
for(const status of [400,401,403,404,410])test(`${status} does not retry permanent failures or queue the remaining 83 times`,async()=>{
 const f=fixture(()=>new Response('',{status}));await assert.rejects(f.load(),status===410?/expired/:new RegExp(String(status)));
 assert.ok(f.requests.length<=4);assert.equal(f.waits.length,0);
});
test('Retry-After supports seconds and HTTP dates and is shared with Refresh',async()=>{
 const now=manifest.run*1000;
 assert.equal(retryAfter(new Response('',{status:429,headers:{'Retry-After':'45'}}),now),now+45000);
 assert.equal(retryAfter(new Response('',{status:429,headers:{'Retry-After':new Date(now+90000).toUTCString()}}),now),now+90000);
 assert.equal(retryAfter(new Response('',{status:429,headers:{'Retry-After':'invalid'}}),now),0);
 const cooldown={until:0};let first=true;
 const f=fixture((lead)=>{if(first){first=false;return new Response('',{status:429,headers:{'Retry-After':'2'}});}return Response.json(step(lead));},{cooldown});
 const result=await f.load();assert.equal(result.complete,true);assert.ok(f.waits.some(ms=>ms>0));
 const limit=f.requests[0].time+2000;
 assert.ok(f.requests.slice(4).every(request=>request.time>=limit),'Only requests already in flight may precede the cooldown');
 assert.equal(cooldown.until,limit);
 const refreshed=fixture(lead=>Response.json(step(lead)),{cooldown});
 await refreshed.load();assert.ok(refreshed.requests.every(request=>request.time>=limit),'Refresh also respects the existing service cooldown');
});
test('a temporary failure can recover without losing successful steps or changing pressure units',async()=>{
 const attempts=new Map(),f=fixture(lead=>{const count=(attempts.get(lead)??0)+1;attempts.set(lead,count);
 return lead===3&&count===1?new Response('',{status:503}):Response.json(step(lead));});
 const raw=await f.load();assert.equal(attempts.get(3),2);assert.equal(raw.completed,83);assert.equal(raw.complete,true);
 assert.deepEqual(raw.missingSteps,[]);assert.deepEqual(raw.missingVariables,[]);assert.equal(raw.hourly.pressure_msl_member0[1],1000);
});
test('widespread missing optional pressure has a bounded retry budget and retains all original fields',async()=>{
 const f=fixture(lead=>{const value=step(lead);delete value.values.pressure_msl;return Response.json(value);});
 const raw=await f.load();assert.ok(f.requests.length<=91);assert.equal(raw.completed,83);assert.equal(raw.complete,false);
 assert.deepEqual(raw.missingVariables,['pressure_msl']);assert.equal(raw.missingVariableSteps.pressure_msl.length,83);
 assert.equal(raw.hourly.temperature_850hPa_member34[82],4);assert.equal(raw.hourly.pressure_msl_member0[1],null);
});
function untilAbort(signal){return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
test('a whole-load deadline preserves received data and marks every unfinished time missing',async()=>{
 const progress=[],f=fixture((lead,requests,signal)=>lead===0?Response.json(step(lead)):untilAbort(signal),{loadTimeout:30});
 const raw=await f.load(undefined,data=>progress.push(data.completed));
 assert.equal(raw.completed,1);assert.equal(raw.complete,false);assert.equal(raw.missingSteps.length,82);assert.match(raw.loadError,/timed out/);
 assert.equal(raw.hourly.temperature_850hPa_member0[0],4);assert.equal(raw.hourly.temperature_850hPa_member0[1],null);assert.ok(progress.includes(1));
});
test('deadline with no data rejects and a later fresh load can recover',async()=>{
 const f=fixture((lead,requests,signal)=>untilAbort(signal),{loadTimeout:20});await assert.rejects(f.load(),{name:'TimeoutError'});
 const recovered=await fixture(lead=>Response.json(step(lead))).load();assert.equal(recovered.complete,true);
});
test('external cancellation suppresses all late progress and does not prevent Refresh',async()=>{
 const controller=new AbortController(),updates=[];
 const f=fixture((lead,requests,signal)=>untilAbort(signal));const loading=f.load(controller.signal,data=>updates.push(data));
 setTimeout(()=>controller.abort(),10);await assert.rejects(loading,{name:'AbortError'});assert.deepEqual(updates,[]);
 const recovered=await fixture(lead=>Response.json(step(lead))).load();assert.equal(recovered.complete,true);
});
