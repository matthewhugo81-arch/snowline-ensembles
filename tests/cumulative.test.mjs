import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {MODELS,VARIABLES,VARIABLE_DETAILS,valid,statistics,niceDomain,prepareDataset,resample,cumulativePrecipitation} from '../docs/data.js';
import {runSummary,runDetail,runExport,resolveFeedRuns} from '../docs/runs.js';
import {buildMobileTimeAxis,MOBILE_AXIS_BOTTOM} from '../docs/time-axis.js';

const H=3600;
const fixture=(times,values,native=1,model={...MODELS[0],members:values.length})=>prepareDataset({intervalHours:native,hourly:{time:times.map(t=>t*H),...Object.fromEntries(values.map((v,i)=>[i?'precipitation_member'+i:'precipitation',v]))}},model,0);
const hourly=(last,fn)=>Array.from({length:last+1},(_,i)=>fn(i));

test('complete 3h and 6h periods give the same total and exclude rainfall ending at the visible start',()=>{
  const d=fixture(hourly(18,i=>i),[hourly(18,i=>i<=6?100:1)]);
  const six=cumulativePrecipitation(resample(d,6),6*H,18*H),three=cumulativePrecipitation(resample(d,3),6*H,18*H);
  assert.deepEqual(six.time.map(t=>t/H),[6,12,18]);
  assert.deepEqual(six.values,[0,6,12]);
  assert.deepEqual(three.values,[0,3,6,9,12]);
  assert.equal(six.total,three.total);
  assert.equal(six.status,'complete');
});

test('only whole periods within nonaligned edges count; missing values outside coverage do not matter',()=>{
  const d=fixture(hourly(18,i=>i),[hourly(18,i=>i<10?null:1)]);
  const three=cumulativePrecipitation(resample(d,3),7*H,18.5*H),six=cumulativePrecipitation(resample(d,6),7*H,18.5*H);
  assert.deepEqual([three.start/H,three.end/H,three.total],[9,18,9]);
  assert.deepEqual([six.start/H,six.end/H,six.total],[12,18,6]);
  assert.equal(cumulativePrecipitation(resample(d,6),7*H,8*H).status,'empty');
});

test('zero baseline needs no source sample and a null baseline is outside the cumulative period',()=>{
  const d=fixture([3,6],[[3,6]],3),sample=resample(d,3);
  assert.deepEqual(cumulativePrecipitation(sample,0,6*H).values,[0,3,9]);
  const nullBaseline=resample(fixture([0,3,6],[[null,3,6]],3),3);
  assert.equal(cumulativePrecipitation(nullBaseline,0,6*H).total,9);
  assert.equal(cumulativePrecipitation(resample(fixture([6],[[6]],3),3),0,6*H).total,null);
});

test('cumulative sums the chart available-member means, including changing member counts',()=>{
  const sample=resample(fixture([0,1,2,3],[[100,1,3,5],[100,3,null,7]]),1);
  const result=cumulativePrecipitation(sample,0,3*H);
  assert.deepEqual(sample.variables.precipitation.stats.map(s=>s.mean),[100,2,3,6]);
  assert.deepEqual(result.values,[0,2,5,11]);
  assert.equal(result.total,11);
  assert.equal(result.memberMin.at(-1),1);
  assert.equal(result.memberMax.at(-1),2);
  assert.equal(result.expectedMembers,2);
});

test('a missing mean permanently ends the known prefix and never becomes dry weather or a later restart',()=>{
  const sample=resample(fixture([0,1,2,3,4],[[0,2,null,4,0],[0,4,null,6,0]]),1);
  const result=cumulativePrecipitation(sample,0,4*H);
  assert.deepEqual(result.values,[0,3,null,null,null]);
  assert.equal(result.total,null);
  assert.equal(result.completed,1);
  assert.equal(result.required,4);
  assert.equal(result.firstMissing,2*H);
  assert.equal(result.status,'incomplete');
  assert.equal(cumulativePrecipitation(sample,2*H,4*H).total,5,'zoom starts a new visible-period accumulation');
});

test('missing and duplicate timestamps cannot be skipped or counted twice',()=>{
  const missing=resample(fixture([0,1,3],[[0,1,3]]),1);
  assert.deepEqual(cumulativePrecipitation(missing,0,3*H).values,[0,1,null,null]);
  const duplicate=resample(fixture([0,1,1,2],[[0,1,10,2]]),1);
  assert.deepEqual(cumulativePrecipitation(duplicate,0,2*H).values,[0,null,null]);
});

test('native MOGREPS 3h accumulations combine once at 6h and missing native periods invalidate their window',()=>{
  const d=fixture([0,3,6,9,12],[[null,1,2,3,4]],3);
  assert.deepEqual(cumulativePrecipitation(resample(d,6),0,12*H).values,[0,3,10]);
  assert.equal(cumulativePrecipitation(resample(d,3),0,12*H).total,10);
  const incomplete=fixture([0,3,6,9,12],[[null,1,2,null,4]],3);
  assert.deepEqual(cumulativePrecipitation(resample(incomplete,6),0,12*H).values,[0,3,null]);
});

test('dry periods are complete but a model ending before the visible window cannot supply a full-window total',()=>{
  const sample=resample(fixture([0,3,6],[[null,0,0]],3),3);
  assert.equal(cumulativePrecipitation(sample,0,6*H).total,0);
  const longer=cumulativePrecipitation(sample,0,9*H);
  assert.deepEqual(longer.values,[0,0,0,null]);
  assert.equal(longer.total,null);
  assert.equal(longer.firstMissing,9*H);
});

const app=await readFile(new URL('../docs/app.js',import.meta.url),'utf8');
const configSource=app.slice(app.indexOf('const configs=['),app.indexOf('];',app.indexOf('const configs=['))+2);
const nearestSource=app.slice(app.indexOf('function nearestTime('),app.indexOf('function pointIndex('));
const runLabelSource=app.slice(app.indexOf('function chartRunInfo('),app.indexOf('async function refreshLatestRuns('));
const chartSource=app.slice(app.indexOf('function getYDomain('),app.indexOf('function mogrInfo('));
const csvSource=app.slice(app.indexOf('function exportCSV(){'),app.indexOf('function captureChartImage('));
const svgSource=app.slice(app.indexOf('function captureChartImage('),app.indexOf('async function openMap('));

function harness(datasets,window,options={}){
  const models=datasets.map(d=>d.model),sampled=new Map(datasets.map(d=>[d.model.id,resample(d,options.interval??3)])),elements=new Map();
  const element=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},getBoundingClientRect:()=>({width:options.width??640,height:390})});return elements.get(key);};
  const context={window,buildMobileTimeAxis,MOBILE_AXIS_BOTTOM,matchMedia:()=>({matches:options.mobile??(options.width!==undefined&&options.width<500)}),MODELS:models,VARIABLES,VARIABLE_DETAILS,valid,statistics,niceDomain,cumulativePrecipitation,runSummary,runDetail,runExport,Date,Intl,Blob,chartMetrics:new Map(),document:{documentElement:{dataset:{theme:options.theme??'dark'}}},state:{model:models[0].id,location:{name:'Test point',lat:53.9,lon:-2.2},datasets:new Map(datasets.map(d=>[d.model.id,d])),latestRuns:new Map(),mode:options.mode??'members',interval:options.interval??3,scale:'auto',custom:options.custom??{},inspect:options.inspect??window[0],pending:new Set(),errors:new Map(),showMean:true,showControl:false,showBand:false,palette:'colour'},renderAvailability:()=>{},toast:()=>{},formatTime:t=>new Date(t*1000).toISOString(),shortTime:t=>new Date(t).toISOString(),fmt:(v,n=1)=>valid(v)?v.toFixed(n):'—',escapeHTML:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),coordinateText:()=> '53.9° N · 2.2° W'};
  context.$=selector=>{if(selector.endsWith(' svg')){const text=element(selector.slice(0,-4)).innerHTML;return text.startsWith('<svg')?{innerHTML:text.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}:null;}return element(selector);};
  context.$$=selector=>selector==='.chart-time-slider'?Array.from({length:5},(_,i)=>element('local-slider-'+i)):[];
  context.model=()=>models[0];context.visibleModels=()=>context.state.mode==='compare'?models:[models[0]];context.getSample=id=>sampled.get(id);context.domain=()=>context.window;context.visiblePoints=s=>s.time.map((t,i)=>t>=context.window[0]&&t<=context.window[1]?i:-1).filter(i=>i>=0);context.pointIndex=s=>s?.time.indexOf(context.state.inspect)??-1;context.nearestTime=t=>Math.round(t/(context.state.interval*H))*context.state.interval*H;
  context.download=(blob,name)=>{context.downloaded={blob,name};};
  context.getComputedStyle=()=>({getPropertyValue:name=>({'--cumulative':options.theme==='light'?'#0058bd':'#54b8ff','--surface':'#142437','--grid':'#304458','--muted':'#a8bbce','--ink':'#e4edf6','--teal':'#6ce1d6','--mean':'#f889a6','--control':'#8dacf5','--member':'#6ebfb7','--band':'#60bdb52b'}[name]??'')});
  vm.createContext(context);vm.runInContext(configSource+'\n'+nearestSource+'\n'+runLabelSource+'\n'+chartSource+'\n'+csvSource+'\n'+svgSource+'\nrenderCharts();',context);
  return {context,element,run:source=>vm.runInContext(source,context)};
}

test('actual renderer keeps the cumulative axis independent of manual period scale and all panels time-aligned',()=>{
  const d=fixture(hourly(18,i=>i),[hourly(18,i=>i<=6?100:1)]),h=harness([d],[6*H,18*H],{interval:6,inspect:18*H,custom:{precipitation:{min:0,max:10,step:2}}});
  const metric=h.context.chartMetrics.get('precipitation');
  assert.deepEqual(metric.yDomain,{min:0,max:10,step:2});
  assert.equal(metric.cumulativeDomain.min,0);
  assert.ok(metric.cumulativeDomain.max>=12&&Number.isFinite(metric.cy(12)));
  assert.match(h.element('#plot-precipitation').innerHTML,/Cumulative mm/);
  assert.match(h.element('#plot-precipitation .inspection').innerHTML,new RegExp('cy="'+metric.cy(12)+'"[^>]*fill="var\\(--cumulative\\)"'));
  assert.match(h.element('#cumulative-precipitation').innerHTML,/Total <b>12\.0 mm/);
  for(const m of h.context.chartMetrics.values())assert.equal(m.x(12*H),metric.x(12*H));
  h.context.window=[12*H,18*H];h.run('renderCharts();');
  assert.equal(h.context.chartMetrics.get('precipitation').cumulative[0].summary.total,6);
  for(const width of [280,320]){const mobile=harness([d],[6*H,18*H],{interval:6,width}),p=mobile.context.chartMetrics.get('precipitation');assert.equal(p.r,53);assert.ok(p.pw>0&&Number.isFinite(p.cy(12)));for(const metric of mobile.context.chartMetrics.values())assert.equal(metric.x(12*H),p.x(12*H));}
});

test('actual comparison renderer uses separate cumulative forecasts on one shared right axis',()=>{
  const gfs=fixture([0,3,6],[[null,3,3]],3,{...MODELS[0],members:1}),ec=fixture([0,3,6],[[null,6,6]],3,{...MODELS[1],members:1});
  const h=harness([gfs,ec],[0,6*H],{mode:'compare'}),metric=h.context.chartMetrics.get('precipitation');
  assert.deepEqual(Array.from(metric.cumulative,item=>item.summary.total),[6,12]);
  assert.ok(metric.cumulativeDomain.max>=12);
  const svg=h.element('#plot-precipitation').innerHTML;
  assert.equal((svg.match(/class="cumulative-curve"/g)??[]).length,2);
  assert.match(svg,/data-model="gfs"/);assert.match(svg,/data-model="ec"/);
  assert.match(h.element('#cumulative-precipitation').innerHTML,/GFS ENS/);
  assert.match(h.element('#cumulative-precipitation').innerHTML,/EC ENS/);
});

test('actual inspection clamps far-right endpoints to a complete period and preserves aligned zoom',()=>{
  const d=fixture(hourly(30,i=>i),[hourly(30,()=>1)]),six=harness([d],[0,22*H],{interval:6});
  assert.equal(six.run('nearestTime(22*3600)'),18*H);
  six.run('state.inspect=nearestTime(22*3600);updateReadouts();');
  assert.match(six.element('#cumulative-precipitation').innerHTML,/At inspected time <b>18\.0 mm/);
  assert.deepEqual(six.context.window,[0,22*H]);
  six.context.window=[6*H,18*H];assert.equal(six.run('nearestTime(18*3600)'),18*H);assert.equal(six.run('nearestTime(13*3600)'),12*H);
  const three=harness([d],[18*H,26*H],{interval:3});
  assert.equal(three.run('nearestTime(26*3600)'),24*H,'02Z snaps to the complete period ending 00Z');
});

test('actual CSV exports model-specific cumulative values, boundaries, member counts and blank incomplete totals',async()=>{
  const gfs=fixture([0,3,6],[[100,2,4],[100,4,null]],3,{...MODELS[0],members:2}),ec=fixture([0,3,6],[[100,5,null]],3,{...MODELS[1],members:1});
  const run=Date.parse('2026-10-19T06:00:00Z')/1000,source=(domain,init)=>({domain,run:init,available:init+7200,modified:init+7200,url:'https://ensemble-api.open-meteo.com/data/'+domain+'/static/meta.json'}),split=[source('ncep_gefs025',run+6*H),source('ncep_gefs05',run)];
  gfs.runInfo=resolveFeedRuns(gfs.model,split,split,(run+12*H)*1000,(run+12*H)*1000);
  const h=harness([gfs,ec],[0,6*H],{mode:'compare'});h.run('exportCSV();');
  const lines=(await h.context.downloaded.blob.text()).replace(/^\uFEFF/,'').split('\r\n').map(line=>line.slice(1,-1).split('","')),header=lines.shift(),rows=lines.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]])));
  const gfsCurve=rows.filter(r=>r.model==='GFS ENS'&&r.variable==='precipitation_cumulative_mean');
  assert.deepEqual(gfsCurve.map(r=>r.value),['0','3','7']);
  assert.deepEqual(gfsCurve.map(r=>r.interval_hours),['0','3','6']);
  const totals=rows.filter(r=>r.variable==='precipitation_visible_period_total');
  assert.deepEqual(totals.map(r=>[r.model,r.value,r.coverage_status]),[['GFS ENS','7','complete'],['EC ENS','','incomplete']]);
  assert.equal(totals[0].accumulation_start_utc,'1970-01-01T00:00:00.000Z');
  assert.equal(totals[0].accumulation_end_utc,'1970-01-01T06:00:00.000Z');
  assert.equal(totals[0].available_members_min,'1');assert.equal(totals[0].available_members_max,'2');
  assert.equal(totals[0].unit,'mm');assert.equal(totals[0].member,'ensemble_mean');
  assert.equal(totals[0].feed_runs_utc,'ncep_gefs025=2026-10-19T12:00:00.000Z; ncep_gefs05=2026-10-19T06:00:00.000Z');
  assert.equal(totals[0].run_utc,'');
  assert.equal(gfsCurve.at(-1).feed_runs_utc,totals[0].feed_runs_utc);
});

test('actual SVG export resolves theme blue and distinguishes requested coverage from the counted prefix',async()=>{
  const d=fixture([0,3,6,9],[[null,2,null,4]],3),h=harness([d],[0,9*H],{theme:'light'});h.run("download(new Blob([captureChartImage('precipitation').svg],{type:'image/svg+xml'}),'chart.svg');");
  const svg=await h.context.downloaded.blob.text();
  assert.match(svg,/stroke="#0058bd"/);
  assert.doesNotMatch(svg,/var\(--cumulative\)/);
  assert.match(svg,/Cumulative mm/);
  assert.match(svg,/cumulative mean: unavailable/);
  assert.match(svg,/Requested complete-period span/);
  assert.match(svg,/Known cumulative total: 2\.0 mm through/);
  assert.match(svg,/1970-01-01T03:00:00\.000Z/);
});
