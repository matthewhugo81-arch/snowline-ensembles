// Offline browser regression checks for the mobile UTC axis and eager run cards.
// Forecast responses are held initially to prove that metadata does not wait for them.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit,devices} from 'playwright';

const root=resolve('docs'),out=resolve(process.env.SNOWLINE_TEST_OUTPUT||'review-output/mobile-time-runs');
const HOUR=3600,NOW=Date.UTC(2026,9,20,4),START=NOW/1000;
const panels=['temperature_850hPa','precipitation','pressure_msl','snow','temperature_500hPa'];
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'};
const members=Array.from({length:18},(_,i)=>i),leads=Array.from({length:83},(_,i)=>i*3);
const manifest={schema:1,intervalHours:3,members,leads,run:START-16*HOUR,runId:'20261019T1200Z',variables:['temperature_850hPa','temperature_500hPa','precipitation','snowfall','pressure_msl']};
const time=Array.from({length:430},(_,i)=>START-28*HOUR+i*HOUR),hourly={time};
for(let member=0;member<31;member++)for(const key of manifest.variables){
  hourly[key+(member?'_member'+String(member).padStart(2,'0'):'')]=time.map((_,i)=>
    key==='precipitation'?1+member/30:key==='snowfall'?(member%3===0?.03:0):
    key==='pressure_msl'?1008+5*Math.sin(i/18)+(member-15)*.4:
    key==='temperature_850hPa'?3+5*Math.sin(i/12)+(member-15)/5:-25+5*Math.cos(i/18)+(member-15)/4);
}
const forecast={latitude:54,longitude:-2,elevation:180,hourly};
const step=lead=>({schema:1,run:manifest.run,time:manifest.run+lead*HOUR,intervalHours:3,members,latitude:54,longitude:-2,units:{pressure_msl:'hPa'},values:Object.fromEntries(manifest.variables.map(key=>[key,members.map((_,i)=>key==='pressure_msl'?1010+Math.sin(lead/18)*5+i/10:key==='precipitation'?lead?3+i/18:null:key==='snowfall'?lead?.06:null:key==='temperature_850hPa'?3+Math.sin(lead/12)*4+i/10:-25+Math.cos(lead/18)*3+i/10)]))});
await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://local'),path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!path.startsWith(root+sep))throw Error('Invalid path');const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream'});res.end(body);}
  catch{res.writeHead(404);res.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin='http://127.0.0.1:'+server.address().port,report=[];

async function fixture(page,{holdForecast=false,metadataUnavailable=false}={}){
  const errors=[],unexpected=[],counts={forecasts:0,metadata:0,manifests:0,points:0};
  let runAdvance=0;
  let release;const gate=holdForecast?new Promise(resolve=>release=resolve):Promise.resolve();
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(now=>{Date.now=()=>now;},NOW);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='ensemble-api.open-meteo.com'&&url.pathname==='/v1/ensemble'){
      counts.forecasts++;await gate;return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:forecast});
    }
    if(url.hostname==='ensemble-api.open-meteo.com'&&/^\/data\/(?:ncep_gefs(?:025|05)|ecmwf_ifs025_ensemble|cmc_gem_geps)\/static\/meta\.json$/.test(url.pathname)){
      counts.metadata++;if(metadataUnavailable)return route.fulfill({status:503,headers:{'Access-Control-Allow-Origin':'*'},body:'Unavailable'});
      const run=START-(url.pathname.includes('ncep_gefs025')||url.pathname.includes('ecmwf')?10:16)*HOUR+runAdvance;
      return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{last_run_initialisation_time:run,last_run_modification_time:run+2*HOUR,last_run_availability_time:run+2*HOUR}});
    }
    if(url.origin===origin&&url.pathname==='/mogreps/latest.json'){
      counts.manifests++;return metadataUnavailable?route.fulfill({status:503,body:'Unavailable'}):route.fulfill({json:manifest});
    }
    if(url.pathname==='/functions/v1/snowline-mogreps'){
      counts.points++;assert.equal(url.searchParams.get('run'),manifest.runId);return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:step(+url.searchParams.get('lead'))});
    }
    if(url.origin===origin)return route.continue();
    if(url.hostname==='fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:''});
    if(url.hostname==='fonts.gstatic.com')return route.abort();
    unexpected.push(url.href);return route.abort();
  });
  return {counts,errors,unexpected,release:()=>release?.(),advanceRuns:()=>{runAdvance=6*HOUR;}};
}
const settled=page=>page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&document.querySelectorAll('#charts .plot>svg').length===5);
const settleLayout=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function axisInfo(page){
  return page.locator('.plot svg').evaluateAll(svgs=>svgs.map(svg=>{
    const labels=[...svg.querySelectorAll('.mobile-time-axis .date-tick')].map(el=>{const rect=el.getBBox();return {time:+el.dataset.time,text:el.textContent,x:rect.x,right:rect.x+rect.width};});
    return {id:svg.parentElement.id,width:svg.viewBox.baseVal.width,labels,days:svg.querySelectorAll('.day-grid').length,hours:[...svg.querySelectorAll('.tick-clock,.time-tick')].map(el=>el.textContent)};
  }));
}
function assertAxisFits(info){
  for(const panel of info){assert.ok(panel.labels.length>=3,panel.id+' has useful date labels');for(let i=0;i<panel.labels.length;i++){const label=panel.labels[i];assert.ok(label.x>=0&&label.right<=panel.width+.5,panel.id+' labels fit SVG');if(i)assert.ok(label.x>=panel.labels[i-1].right+1,panel.id+' adjacent date labels do not overlap: '+JSON.stringify([panel.labels[i-1],label]));}}
  assert.ok(info.every(panel=>JSON.stringify(panel.labels.map(x=>x.time))===JSON.stringify(info[0].labels.map(x=>x.time))),'All five panels use identical UTC tick positions');
}
async function dragWindow(page,from,to){
  const plot=page.locator('#plot-temperature_850hPa');await plot.scrollIntoViewIfNeeded();
  const points=await plot.evaluate((el,{from,to})=>{
    const rect=el.getBoundingClientRect(),svg=el.querySelector('svg'),clip=svg.querySelector('clipPath rect');
    const left=+clip.getAttribute('x'),width=+clip.getAttribute('width'),ratio=rect.width/svg.viewBox.baseVal.width;
    const x=f=>rect.x+(left+width*f)*ratio;
    return {from:x(from),to:x(to),y:rect.y+80};
  },{from,to});
  await page.mouse.move(points.from,points.y);await page.mouse.down();await page.mouse.move(points.to,points.y,{steps:8});await page.mouse.up();
  await page.locator('#reset-zoom').waitFor({state:'visible'});await settleLayout(page);
}
async function assertInspectors(page){
  const expected=await page.locator('#inspect-time').textContent(),values=await page.locator('.chart-inspection strong').allTextContents();
  assert.equal(values.length,5);assert.ok(values.every(value=>value===expected),'Every panel shows the exact inspected UTC date/time');
  const sliders=await page.locator('#time-slider,.chart-time-slider').evaluateAll(inputs=>inputs.map(input=>[input.value,input.max,input.getAttribute('aria-valuetext')]));
  assert.equal(sliders.length,6);assert.ok(sliders.every(value=>JSON.stringify(value)===JSON.stringify(sliders[0])),'Top and local sliders stay synchronized');
}

try{
  for(const kind of (process.env.SNOWLINE_TEST_BROWSERS||'chromium,webkit,iphone').split(',')){
    const browser=await(kind==='chromium'?chromium:webkit).launch(),context=await browser.newContext(kind==='iphone'?{...devices['iPhone 13']}:{viewport:{width:1440,height:1000}}),page=await context.newPage();
    page.setDefaultTimeout(15000);const f=await fixture(page,{holdForecast:true});
    try{
      await page.goto(origin+'/?lat=54&lon=-2&place=Fixture%20Valley&model=gfs');
      await page.waitForFunction(()=>document.querySelectorAll('.model-run').length===4&&[...document.querySelectorAll('.model-run')].every(el=>/19 Oct (12|18)Z/.test(el.textContent)));
      assert.equal(f.counts.forecasts,1);assert.equal(f.counts.points,0,'Only metadata is requested for unselected MOGREPS');
      assert.equal(await page.locator('.plot>svg').count(),0,'Runs are visible before chart data arrives');
      assert.doesNotMatch(await page.locator('body').textContent(),/Run available after loading/);
      assert.match(await page.locator('[data-model="gfs"] .model-run').textContent(),/0\.25°.*18Z.*0\.5°.*12Z/);
      assert.match(await page.locator('[data-model="ec"] .model-run').textContent(),/18Z/);
      assert.match(await page.locator('[data-model="gem"] .model-run').textContent(),/12Z/);
      assert.match(await page.locator('[data-model="mogreps"] .model-run').textContent(),/12Z/);
      f.release();await settled(page);
      const initialRequests={...f.counts};assert.equal(initialRequests.forecasts,1);assert.equal(initialRequests.metadata,6);assert.equal(initialRequests.manifests,1);
      if(kind!=='iphone'){
        assert.equal(await page.locator('.mobile-time-axis').count(),0,'Desktop retains its existing chart axes');
        assert.equal(await page.locator('.chart-inspection').first().isVisible(),false,'Local phone controls stay hidden on desktop');
      }
      const views=[];
      for(const width of [320,390,430]){
        await page.setViewportSize({width,height:844});await settleLayout(page);
        const sevenDays=await axisInfo(page);assertAxisFits(sevenDays);assert.ok(sevenDays.every(panel=>panel.labels.length>=6),'Seven-day phone view labels each day');
        assert.equal(await page.locator('.chart-window').first().isVisible(),true);
        const ranges=await page.locator('.chart-window').allTextContents();assert.equal(new Set(ranges).size,1);assert.match(ranges[0],/20 Oct.*27 Oct/);assert.match(ranges[0],/UTC/);
        await dragWindow(page,.01,.75);const fiveDays=await axisInfo(page);assertAxisFits(fiveDays);
        assert.ok(fiveDays.every(panel=>panel.labels.length>=4),'Five-day phone window has daily date markers');
        for(const panel of fiveDays)for(let i=1;i<panel.labels.length;i++)assert.equal(panel.labels[i].time-panel.labels[i-1].time,24*HOUR,'Five-day UTC labels are daily');
        await page.locator('#time-slider').evaluate(input=>{input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));});await assertInspectors(page);
        const lower=page.locator('.chart-card[data-var="temperature_500hPa"] .chart-time-slider');await lower.scrollIntoViewIfNeeded();
        await lower.evaluate(input=>{input.value=String(Math.min(9,+input.max));input.dispatchEvent(new Event('input',{bubbles:true}));});await assertInspectors(page);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Phone layout does not overflow');
        if(width===390){await page.locator('.chart-card[data-var="precipitation"]').screenshot({path:resolve(out,kind+'-phone-dark.png')});await page.locator('#theme').selectOption('light');await page.locator('.chart-card[data-var="precipitation"]').screenshot({path:resolve(out,kind+'-phone-light.png')});await page.locator('#theme').selectOption('dark');}
        await page.locator('#reset-zoom').click();await page.locator('#horizon').selectOption('72');await dragWindow(page,.1,.7);
        const short=await axisInfo(page);assertAxisFits(short);assert.ok(short.every(panel=>panel.hours.some(hour=>hour!=='00Z')),'Zoomed phone view exposes sub-day UTC times');
        await page.locator('#reset-zoom').click();await page.locator('#horizon').selectOption('168');await settleLayout(page);
        views.push({width,sevenDayLabels:sevenDays[0].labels.length,fiveDayLabels:fiveDays[0].labels.length,zoomHours:short[0].hours});
      }
      assert.deepEqual(f.counts,initialRequests,'Time controls, zoom, resizing and themes never reload weather');
      await page.locator('[data-mode="compare"]').click();await settled(page);
      assert.equal(f.counts.forecasts,3,'Compare loads only the two remaining Open-Meteo models');assert.equal(f.counts.points,83);
      assertAxisFits(await axisInfo(page));assert.equal(await page.locator('#plot-precipitation .cumulative-curve').count(),4);
      await assertInspectors(page);
      const chartRun=await page.locator('#run-temperature_850hPa').textContent();f.advanceRuns();
      await page.evaluate(now=>{Date.now=()=>now;window.dispatchEvent(new Event('focus'));},NOW+6*HOUR*1000);
      await page.waitForFunction(()=>/20 Oct 00Z/.test(document.querySelector('[data-model="gfs"] .model-run:not(.model-plotted-run)').textContent));
      assert.equal(await page.locator('#run-temperature_850hPa').textContent(),chartRun,'New catalogue runs cannot relabel previously loaded charts');
      assert.match(await page.locator('[data-model="gfs"] .model-plotted-run').textContent(),/19 Oct/);
      assert.equal(f.counts.forecasts,3);assert.equal(f.counts.points,83,'Refreshing latest runs uses no extra point forecasts');
      assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);
      report.push({browser:kind,views,eagerRunCards:4,requests:f.counts,errors:f.errors});
    }catch(error){f.release();await page.screenshot({path:resolve(out,kind+'-failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,kind+'-failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors:f.errors,unexpected:f.unexpected,counts:f.counts},null,2));throw error;}
    finally{await context.close();await browser.close();}
  }
  // A metadata outage must not block selected forecast charts or invent a run.
  const browser=await chromium.launch(),page=await browser.newPage();const failed=await fixture(page,{metadataUnavailable:true});
  try{await page.goto(origin+'/?lat=54&lon=-2&model=gfs');await settled(page);await page.waitForFunction(()=>[...document.querySelectorAll('.model-run')].every(el=>/unavailable/i.test(el.textContent)));assert.equal(await page.locator('.plot>svg').count(),5);assert.doesNotMatch((await page.locator('.model-run').allTextContents()).join(' '),/\d{2} Oct \d{2}Z/);assert.deepEqual(failed.errors,[]);assert.deepEqual(failed.unexpected,[]);report.push({metadataOutage:'Charts remain usable; all four run cards report unavailable'});}
  finally{await browser.close();}
  await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await new Promise(resolve=>server.close(resolve));}
