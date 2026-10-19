import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {gridPoint,extractFile,extractStep,accumulationLeads} from '../server/mogreps-core.js';
import {createMogrepsRaw,applyMogrepsStep} from '../docs/mogreps.js';
import {prepareDataset,resample} from '../docs/data.js';
const members=[0,...Array.from({length:17},(_,i)=>i+18)];
const manifest={schema:1,run:1800000000,runId:'20270115T0800Z',members,leads:Array.from({length:83},(_,i)=>i*3),intervalHours:3};
test('nearest native grid handles poles, the dateline and invalid coordinates',()=>{
  assert.deepEqual(gridPoint(53.9239,-2.1949),{y:767,x:632,latitude:53.90625,longitude:-2.109375});
  assert.equal(gridPoint(90,180).y,959);assert.equal(gridPoint(-90,-180).y,0);
  assert.equal(gridPoint(0,180).x,gridPoint(0,-180).x);
  assert.throws(()=>gridPoint(91,0));assert.throws(()=>gridPoint(0,NaN));
});
// Test actual binary filter decoding, member positions, masks and fill values.
function source(kind='temperature',shuffle=false){
  let offset=0;const payloads=new Map();
  function dataset(shape,dtype,values,filtered=true){
    let bytes=dtype==='<f4'?Buffer.from(new Float32Array(values).buffer):Buffer.from(new Int8Array(values).buffer);
    const filters=[];
    if(shuffle&&dtype==='<f4'){filters.push({id:2});const b=Buffer.alloc(bytes.length);for(let i=0;i<values.length;i++)for(let j=0;j<4;j++)b[j*values.length+i]=bytes[i*4+j];bytes=b;}
    filters.push({id:1});if(filtered)bytes=deflateSync(bytes);
    const entry=[offset,bytes.length,filtered?0:1<<(filters.length-1)];payloads.set(offset,bytes);offset+=bytes.length;
    return {shape,chunkShape:shape,dtype,fillValue:dtype==='<f4'?9.969209968386869e36:-127,filters,chunks:{[shape.map(()=>0).join(',')]:entry}};
  }
  const index={schema:1,key:'global-ensemble/test.nc',members,run:manifest.run,time:manifest.run+24*3600,kind,etag:'"test"'};
  if(kind==='temperature'){
    index.levels=[0,1];const values=Array.from({length:18*2*2*2},(_,i)=>273.15+i/8);values[7]=9.969209968386869e36;
    index.data=dataset([18,2,2,2],'<f4',values);
    const flags=Array(18*2*2*2).fill(0);flags[3]=1;flags[15]=-127;
    index.flag=dataset([18,2,2,2],'|i1',flags,false);
  }else{index.intervalHours=1;index.data=dataset([18,2,2],'<f4',Array.from({length:72},(_,i)=>i/1000));}
  index.size=offset;
  const fetcher=async(u,o)=>{assert.equal(o.headers['If-Match'],'"test"');const [,a,b]=o.headers.Range.match(/bytes=(\d+)-(\d+)/);const bytes=payloads.get(+a);assert.equal(bytes.length,+b-+a+1);return new Response(bytes,{status:206});};
  return {index,fetcher};
}
for(const shuffle of [false,true])test(`binary temperature decoding and pressure flags (shuffle=${shuffle})`,async()=>{
  const {index,fetcher}=source('temperature',shuffle);const t=await extractFile(index,{y:1,x:1},fetcher);
  assert.equal(t[0][0],null);assert.equal(t[1][0],null);assert.equal(t[1][1],null);
  assert.ok(Math.abs(t[0][1]-11/8)<.0001);assert.ok(Math.abs(t[1][17]-143/8)<.0001);
});
test('source retrieval rejects whole-file responses and incompatible forecast members',async()=>{
  const {index}=source();await assert.rejects(()=>extractFile(index,{y:0,x:0},async()=>new Response('wrong')),/range request/);
  await assert.rejects(()=>extractStep(manifest,{y:0,x:0},24,async()=>({...index,run:manifest.run-21600})),/run or member mismatch/);
});
test('hourly-to-three-hour transition uses the correct native accumulation files',()=>{
  assert.deepEqual(accumulationLeads(0),[]);assert.deepEqual(accumulationLeads(3),[1,2,3]);
  assert.deepEqual(accumulationLeads(132),[130,131,132]);assert.deepEqual(accumulationLeads(135),[135]);
});
test('decoder sums native intervals before converting units and leaves analysis-time totals missing',async()=>{
  const files={};for(const kind of ['temperature','precipitation','snowfall']){files[kind]=source(kind);files[kind].index.key=`global-ensemble/${kind}.nc`;}
  const load=async(kind,h)=>({...files[kind].index,time:manifest.run+h*3600});
  const fetcher=(u,o)=>files[u.match(/([^/]+)\.nc$/)[1]].fetcher(u,o);
  const result=await extractStep(manifest,{y:1,x:1},24,load,fetcher);
  const native=new Float32Array([.003])[0];
  assert.equal(result.values.precipitation[0],native*3*1000);
  assert.equal(result.values.snowfall[0],native*3*700);
  const zero=await extractStep(manifest,{y:1,x:1},0,load,fetcher);
  assert.ok(zero.values.precipitation.every(v=>v===null));
});
test('browser data retains actual member IDs, validates run consistency and sums native three-hour totals',()=>{
  const aligned={...manifest,run:1792389600};const raw=createMogrepsRaw(aligned);
  const step=lead=>({schema:1,run:aligned.run,time:aligned.run+lead*3600,intervalHours:3,members,latitude:53.90625,longitude:-2.109375,values:{temperature_850hPa:Array(18).fill(4),temperature_500hPa:Array(18).fill(-15),precipitation:Array(18).fill(lead===0?null:lead),snowfall:Array(18).fill(lead===0?null:.06)}});
  for(const lead of [0,3,6])applyMogrepsStep(raw,aligned,step(lead),lead);
  const six=resample(prepareDataset(raw,{id:'mogreps'}),6);
  assert.deepEqual(six.variables.temperature_850hPa.members.map(m=>m.id),members);
  assert.equal(six.variables.precipitation.members[0].values[0],null);
  assert.equal(six.variables.precipitation.members[0].values[1],9);
  assert.equal(six.variables.snow.stats[1].mean,100);
  assert.equal(six.variables.precipitation.members[0].values[2],null);
  const hourly=resample(prepareDataset(raw,{id:'mogreps'}),1);assert.equal(hourly.variables.precipitation.members[0].values[1],null);
  assert.throws(()=>applyMogrepsStep(raw,aligned,{...step(9),run:aligned.run+21600},9),/run or member/);
  assert.throws(()=>applyMogrepsStep(raw,aligned,{...step(9),latitude:50},9),/grid point/);
});
