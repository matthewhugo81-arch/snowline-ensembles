import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateMember,statistics,extractMembers,prepareDataset,resample,niceDomain,parseCoordinates,VARIABLES,VARIABLE_DETAILS} from '../docs/data.js';
import {runExport} from '../docs/runs.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('precipitation sums preceding complete windows, preserving missing hours',()=>{const t=[0,3600,7200,10800,14400,18000,21600];assert.equal(aggregateMember([1,2,3,4,5,6,7],t,6,6),27);assert.equal(aggregateMember([1,2,null,4,5,6,7],t,6,6),null);assert.equal(aggregateMember([1,2,3],t,1,3),null);assert.equal(aggregateMember([0,0,0],t,2,3),0);assert.equal(aggregateMember([1,2,3],[0,3600,10800],2,3),null);});
test('member statistics exclude null, not zero, and interpolate percentiles',()=>{const s=statistics([null,0,10,20,NaN]);assert.equal(s.count,3);assert.equal(s.mean,10);assert.equal(s.p10,2);assert.equal(s.p90,18);assert.equal(statistics([null]).mean,null);});
test('member order separates unsuffixed control and perturbed members',()=>{const m=extractMembers({time:[0],temperature_850hPa_member10:[3],temperature_850hPa:[1],temperature_850hPa_member01:[2],temperature_500hPa:[-20]},'temperature_850hPa');assert.deepEqual(m.map(x=>x.id),[0,1,10]);});
test('snow agreement uses available members; pressure-level nulls stay null',()=>{const hourly={time:Array.from({length:7},(_,i)=>i*3600),temperature_850hPa:Array(7).fill(null),temperature_500hPa:Array(7).fill(null),precipitation:Array(7).fill(1),snowfall:Array(7).fill(0),snowfall_member01:Array(7).fill(.05),snowfall_member02:Array(7).fill(null)};const s=resample(prepareDataset({hourly},{id:'test'}),6);assert.equal(s.variables.precipitation.members[0].values[1],6);assert.equal(s.variables.snow.stats[1].mean,50);assert.equal(s.variables.snow.stats[1].count,2);assert.equal(s.variables.temperature_850hPa.stats[1].mean,null);});
test('auto domains include all extremes and maintain a real zero precip baseline',()=>{const d=niceDomain([-22.5,3,12.5]);assert.ok(d.min<=-22.5&&d.max>=12.5);assert.equal(niceDomain([0,.2,19],true).min,0);assert.ok(niceDomain([0,0],true).max>0);});
test('coordinate input validates limits and supports signed decimals',()=>{assert.deepEqual(parseCoordinates('53.8, -2.3'),{name:'Selected coordinates',lat:53.8,lon:-2.3});assert.equal(parseCoordinates('Leeds'),null);assert.throws(()=>parseCoordinates('100, 0'));assert.throws(()=>parseCoordinates('50, 181'));});

test('MSLP samples instantaneous hPa member values at 3h and 6h, preserving gaps',()=>{
  const hourly={time:Array.from({length:7},(_,i)=>i*3600),pressure_msl:[1015,1013,1010,null,1000,999,997],pressure_msl_member01:[1017,1016,1014,1008,1004,null,999],precipitation:[1,2,3,4,5,6,7]};
  const dataset=prepareDataset({hourly},{id:'test'});
  const three=resample(dataset,3),six=resample(dataset,6);
  assert.deepEqual(three.variables.pressure_msl.members[0].values,[1015,null,997]);
  assert.deepEqual(six.variables.pressure_msl.members[0].values,[1015,997]);
  assert.equal(three.variables.pressure_msl.stats[1].count,1);
  assert.equal(three.variables.pressure_msl.stats[1].mean,1008);
  assert.equal(six.variables.pressure_msl.stats[1].mean,998);
  assert.equal(six.variables.pressure_msl.stats[1].p10,997.2);
  assert.equal(six.variables.precipitation.members[0].values[1],27);
  const axis=niceDomain([972.1,1018.7]);
  assert.ok(axis.min>900&&axis.min<=972.1&&axis.max>=1018.7);
});

test('missing pressure is not replaced by temperatures or a deterministic forecast',()=>{
  const sampled=resample(prepareDataset({hourly:{time:[0,10800],temperature_850hPa:[5,6]}},{id:'test'}),3);
  assert.deepEqual(sampled.variables.pressure_msl.members,[]);
  assert.deepEqual(sampled.variables.pressure_msl.stats.map(s=>s.mean),[null,null]);
  assert.deepEqual(sampled.variables.temperature_850hPa.members[0].values,[5,6]);
});

test('actual CSV export writes hPa pressure rows with zero accumulation interval and member identity',async()=>{
  const moduleText=await readFile(new URL('../docs/app.js',import.meta.url),'utf8');
  const source=moduleText.slice(moduleText.indexOf('function exportCSV(){'),moduleText.indexOf('function saveChart('));
  const m={id:'gfs',name:'GFS ENS',feed:'ncep_gefs_seamless'};
  const d=prepareDataset({hourly:{time:[0,10800],pressure_msl:[1014.2,1008.6],pressure_msl_member01:[1015.8,1005.4]}},m,0);
  const sampled=resample(d,3);let output;
  const context={state:{model:'gfs',location:{lat:53.9,lon:-2.2},interval:3,datasets:new Map([['gfs',d]])},VARIABLES,VARIABLE_DETAILS,valid:Number.isFinite,runExport,visibleModels:()=>[m],getSample:()=>sampled,visiblePoints:()=>[0,1],Date,Blob,toast:()=>{},download:blob=>{output=blob;}};
  vm.runInNewContext(source+'\nexportCSV();',context);
  const lines=(await output.text()).replace(/^\uFEFF/,'').split('\r\n').map(line=>line.slice(1,-1).split('","'));
  const header=lines.shift(),rows=lines.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]])));
  const pressure=rows.filter(row=>row.variable==='pressure_msl');
  assert.equal(pressure.length,4);
  assert.ok(pressure.every(row=>row.unit==='hPa'&&row.interval_hours==='0'));
  assert.deepEqual(pressure.map(row=>[row.member,row.value]),[['0','1014.2'],['1','1015.8'],['0','1008.6'],['1','1005.4']]);
});
