// Real app, SVG, canvas and ClipboardItem; deterministic offline weather.
// Only the clipboard boundary is stubbed. Never read or alter the system clipboard.
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit,devices} from 'playwright';

const root=resolve('docs'),out=resolve(process.env.SNOWLINE_TEST_OUTPUT||'review-output/chart-images');
const NOW=Date.UTC(2026,9,19,12),HOUR=3600,START=NOW/1000,END=START+168*HOUR;
const panels=[
  ['temperature_850hPa','850 hPa temperature','°C'],
  ['precipitation','Total precipitation','mm'],
  ['pressure_msl','Mean sea level pressure','hPa'],
  ['snow','Snowfall signal','%'],
  ['temperature_500hPa','500 hPa temperature','°C']
];
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'};
await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://local'),path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(root+sep))throw Error('Invalid path');
    const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream'});res.end(body);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const time=Array.from({length:409},(_,i)=>START-12*HOUR+i*HOUR),hourly={time};
for(let member=0;member<31;member++)for(const key of ['temperature_850hPa','temperature_500hPa','precipitation','snowfall','pressure_msl']){
  hourly[key+(member?'_member'+String(member).padStart(2,'0'):'')]=time.map((_,i)=>
    key==='precipitation'?1+member/30:
    key==='snowfall'?(member%3===0?.03:0):
    key==='pressure_msl'?1008+5*Math.sin(i/18)+(member-15)*.4:
    key==='temperature_850hPa'?3+5*Math.sin(i/12)+(member-15)/5:-25+5*Math.cos(i/18)+(member-15)/4);
}
const forecast={latitude:54,longitude:-2,elevation:180,hourly};
const mogrepsManifest={schema:1,intervalHours:3,members:Array.from({length:18},(_,i)=>i),leads:Array.from({length:83},(_,i)=>i*3),run:START-12*HOUR,runId:'20261019T0000Z',variables:['temperature_850hPa','temperature_500hPa','precipitation','snowfall','pressure_msl']};
const compact=text=>text.replace(/,/g,'').replace(/\s+/g,' ').trim();
const utc=t=>new Date(t*1000).toISOString().replace('T',' ').replace('.000Z',' UTC');
const report=[];

try {
  for(const kind of (process.env.SNOWLINE_TEST_BROWSERS||'chromium,webkit,iphone').split(',')){
    assert.ok(['chromium','webkit','iphone'].includes(kind));
    const browser=await (kind==='chromium'?chromium:webkit).launch();
    const context=await browser.newContext(kind==='iphone'?{...devices['iPhone 13'],acceptDownloads:true}:{viewport:{width:1440,height:1000},acceptDownloads:true});
    await context.tracing.start({screenshots:true,snapshots:true,sources:true});
    const page=await context.newPage(),errors=[],unexpected=[],downloads=[];
    let forecasts=0,metadata=0,manifests=0,traceSaved=false;
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({now})=>{
      Date.now=()=>now;
      window.fixtureSVG=[];window.fixtureWrites=[];window.fixtureCopies=[];
      window.fixtureClipboard='allow';window.fixtureDelayPNG=false;window.fixtureFailPNG=false;window.fixturePNG=[];
      const createURL=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{if(blob.type.startsWith('image/svg+xml'))void blob.text().then(svg=>window.fixtureSVG.push(svg));return createURL(blob);};
      const toBlob=HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob=function(callback,...args){
        return toBlob.call(this,blob=>{
          const deliver=()=>callback(window.fixtureFailPNG?null:blob);
          if(window.fixtureDelayPNG)window.fixturePNG.push(deliver);else deliver();
        },...args);
      };
      const clipboard={write:async items=>{
        window.fixtureWrites.push({active:navigator.userActivation?.isActive,pending:window.fixturePNG.length>0,native:items[0] instanceof ClipboardItem});
        if(window.fixtureClipboard==='deny')throw new DOMException('Fixture permission denied','NotAllowedError');
        const blob=await items[0].getType('image/png');window.fixtureCopies.push({type:blob.type,size:blob.size});
      }};
      Object.defineProperty(navigator,'clipboard',{configurable:true,get:()=>window.fixtureClipboard==='absent'?undefined:clipboard});
    },{now:NOW});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='ensemble-api.open-meteo.com'&&url.pathname==='/v1/ensemble'){
        forecasts++;assert.equal(url.searchParams.get('models'),'ncep_gefs_seamless');
        return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:forecast});
      }
      if(url.hostname==='ensemble-api.open-meteo.com'&&/^\/data\/(?:ncep_gefs(?:025|05)|ecmwf_ifs025_ensemble|cmc_gem_geps)\/static\/meta\.json$/.test(url.pathname)){
        metadata++;const run=START-(url.pathname.includes('ncep_gefs025')?6:12)*HOUR;
        return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{last_run_initialisation_time:run,last_run_modification_time:run+2*HOUR,last_run_availability_time:run+2*HOUR}});
      }
      if(url.origin===origin&&url.pathname==='/mogreps/latest.json'){
        manifests++;return route.fulfill({json:mogrepsManifest});
      }
      if(url.origin===origin)return route.continue();
      if(url.hostname==='fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:''});
      if(url.hostname==='fonts.gstatic.com')return route.abort();
      unexpected.push(url.href);return route.abort();
    });
    try {
      await page.goto(origin+'/?lat=54&lon=-2&place=Fixture%20Valley&model=gfs');
      await page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&document.querySelectorAll('#charts .plot>svg').length===5);
      assert.equal(forecasts,1);assert.equal(metadata,6);assert.equal(manifests,1);
      const requestCount={forecasts,metadata,manifests},menu=page.locator('#chart-image-menu');
      const plot=id=>page.locator('#plot-'+id),card=id=>page.locator('.chart-card[data-var="'+id+'"]');
      const settle=async target=>{await target.scrollIntoViewIfNeeded();await target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
      const svgInfo=async()=>page.evaluate(()=>{
        const svg=window.fixtureSVG.at(-1),doc=new DOMParser().parseFromString(svg,'image/svg+xml'),root=doc.documentElement;
        const path=doc.querySelector('path.cumulative-curve');let point=null;
        if(path){
          const points=Array.from(path.getAttribute('d').matchAll(/[ML]([\d.-]+),([\d.-]+)/g),m=>[+m[1],+m[2]]);
          point=points[Math.floor(points.length/2)];
          for(let parent=path.parentElement;parent;parent=parent.parentElement){const transform=parent.getAttribute('transform')?.match(/^translate\(([\d.-]+)[ ,]+([\d.-]+)\)$/);if(transform){point[0]+=+transform[1];point[1]+=+transform[2];}}
        }
        return {svg,width:+root.getAttribute('width'),height:+root.getAttribute('height'),text:[...doc.querySelectorAll('text')].map(el=>el.textContent).join(' '),point};
      });
      const open=async(id,method=kind==='iphone'?'button':'plot')=>{
        const trigger=method==='button'?card(id).locator('.chart-image-button'):plot(id);
        await settle(trigger);const before=await page.evaluate(()=>window.fixtureSVG.length);
        if(method==='keyboard'){await trigger.focus();await page.keyboard.press('Shift+F10');}
        else if(method==='button'&&kind==='iphone')await trigger.tap();
        else await trigger.click(method==='button'?{}:{button:'right'});
        await menu.waitFor({state:'visible'});
        await page.waitForFunction(n=>window.fixtureSVG.length>n,before);
        const box=await menu.boundingBox(),viewport=page.viewportSize();
        assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,'Menu fits the viewport');
        return svgInfo();
      };
      const save=async(id,info,label=id)=>{
        const pending=page.waitForEvent('download');await menu.locator('[data-action="png"]').click();const download=await pending;
        assert.match(download.suggestedFilename(),new RegExp('^snowline-.*'+id+'.*\\.png$','i'));
        const path=resolve(out,kind+'-'+label+'.png');await download.saveAs(path);const bytes=await readFile(path);
        assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(bytes.length>10000);
        const pixels=await page.evaluate(async({base64,point})=>{
          const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let coloured=0,transparent=0,blue=0;
          for(let i=0;i<data.length;i+=4){if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>40)coloured++;if(data[i+3]!==255)transparent++;}
          if(point){const patch=ctx.getImageData(Math.round(point[0]*2)-4,Math.round(point[1]*2)-4,9,9).data;for(let i=0;i<patch.length;i+=4)if(patch[i+2]>patch[i]+60&&patch[i+1]>patch[i]+40)blue++;}
          return {width:canvas.width,height:canvas.height,coloured,transparent,blue};
        },{base64:bytes.toString('base64'),point:info.point});
        assert.equal(pixels.width,Math.ceil(info.width*2));assert.equal(pixels.height,Math.ceil(info.height*2));
        assert.ok(pixels.coloured>1000,'PNG includes rendered coloured content');assert.equal(pixels.transparent,0,'Opaque chart background');
        if(id==='precipitation'){assert.ok(info.point,'Cumulative curve is included');assert.ok(pixels.blue>0,'Cumulative curve is blue in the actual PNG');}
        downloads.push({panel:id,label,...pixels});await page.keyboard.press('Escape');return pixels;
      };
      for(const [id,title,unit] of panels){
        const info=await open(id),text=compact(info.text);
        assert.ok(text.includes(title)&&text.includes(unit)&&text.includes('Fixture Valley'));
        assert.ok(text.includes(utc(START))&&text.includes(utc(END)),'Both exact visible UTC bounds are exported');
        assert.ok(!info.svg.includes('var(--')&&!/<foreignObject|<image\b|(?:href|src)="https?:/i.test(info.svg),'Standalone SVG has no unresolved theme or external assets');
        if(id.startsWith('temperature')){assert.ok(text.includes('Feed run 19 Oct 00Z'));assert.ok(!text.includes('0.25°'));}
        else{assert.ok(text.includes('0.25° 19 Oct 06Z'));assert.ok(text.includes('0.5° 19 Oct 00Z'));}
        if(id==='precipitation'){assert.ok(text.includes('Cumulative mm'));assert.ok(text.includes('cumulative mean: 252.0 mm'));}
        if(id==='snow'){assert.match(text,/agreement|members forecasting/i);assert.doesNotMatch(text,/Control: dashed|Mean: pink/);}
        await save(id,info);
        if(kind!=='iphone'){
          const headingImage=await open(id,'button');
          assert.ok(compact(headingImage.text).includes(title),'Every heading image button opens the matching chart');
          await page.keyboard.press('Escape');
        }
      }
      if(kind!=='iphone'){
        await settle(plot('precipitation'));const box=await plot('precipitation').boundingBox();
        await page.mouse.move(box.x+box.width*.2,box.y+90);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+90,{steps:8});await page.mouse.up();
        await page.locator('#reset-zoom').waitFor({state:'visible'});
        const countedCoverage=()=>page.locator('#cumulative-precipitation').evaluate(el=>[el.querySelector('.cumulative-heading').textContent,...[...el.querySelectorAll('.cumulative-model')].map(row=>row.children[1].textContent)].join(' | '));
        const zoom=await page.locator('#time-slider').getAttribute('max'),coverage=await countedCoverage();assert.ok(+zoom<28);
        await open('precipitation','plot');await page.keyboard.press('Escape');
        assert.equal(await page.locator('#time-slider').getAttribute('max'),zoom);assert.equal(await countedCoverage(),coverage);
        await open('precipitation','keyboard');await page.keyboard.press('Escape');
        assert.equal(await plot('precipitation').evaluate(el=>el===document.activeElement),true);assert.equal(await page.locator('#reset-zoom').isVisible(),true);
        // A macOS-style Ctrl-click must not leave a drag to commit on pointerup.
        await plot('precipitation').evaluate(el=>{const r=el.getBoundingClientRect(),init={bubbles:true,cancelable:true,pointerType:'mouse',pointerId:77,button:0,buttons:1,ctrlKey:true,clientX:r.x+120,clientY:r.y+80};el.dispatchEvent(new PointerEvent('pointerdown',init));el.dispatchEvent(new MouseEvent('contextmenu',init));el.dispatchEvent(new PointerEvent('pointerup',{...init,buttons:0,clientX:r.x+300}));});
        await menu.waitFor({state:'visible'});await page.keyboard.press('Escape');assert.equal(await page.locator('#time-slider').getAttribute('max'),zoom);
        await page.locator('#reset-zoom').click();
      }
      // Force PNG generation to remain pending through the actual Copy click.
      await page.evaluate(()=>window.fixtureDelayPNG=true);await open('precipitation','button');
      await page.waitForFunction(()=>window.fixturePNG.length>0);await menu.locator('[data-action="copy"]').click();
      await page.waitForFunction(()=>window.fixtureWrites.length===1);
      assert.deepEqual(await page.evaluate(()=>window.fixtureWrites[0]),{active:true,pending:true,native:true});
      assert.equal(await page.evaluate(()=>window.fixtureCopies.length),0);
      await page.evaluate(()=>{window.fixtureDelayPNG=false;for(const callback of window.fixturePNG.splice(0))callback();});
      await page.waitForFunction(()=>window.fixtureCopies.length===1);
      const copy=await page.evaluate(()=>window.fixtureCopies[0]);assert.equal(copy.type,'image/png');assert.ok(copy.size>10000);await page.keyboard.press('Escape');
      for(const mode of ['deny','absent']){
        await page.evaluate(mode=>window.fixtureClipboard=mode,mode);await open('precipitation','button');await menu.locator('[data-action="copy"]').click();
        const preview=page.locator('#chart-image-preview');await preview.waitFor({state:'visible'});await preview.locator('img').evaluate(image=>image.decode());
        assert.ok(await preview.locator('img').evaluate(image=>image.naturalWidth>0));assert.match(await preview.locator('a').getAttribute('download'),/\.png$/);
        await preview.getByRole('button',{name:'Close',exact:true}).click();
        await preview.waitFor({state:'hidden'});
        await page.waitForFunction(()=>document.activeElement?.matches('.chart-image-button[data-id="precipitation"]'));
        assert.equal(await card('precipitation').locator('.chart-image-button').evaluate(el=>el===document.activeElement),true);
      }
      await page.evaluate(()=>{window.fixtureClipboard='allow';window.fixtureFailPNG=true;});const vectorInfo=await open('precipitation','button');
      await page.waitForFunction(()=>document.querySelector('#chart-image-menu [data-action="png"]').disabled);
      assert.equal(await menu.locator('[data-action="svg"]').isEnabled(),true,'Vector download survives a PNG conversion failure');
      const svgDownload=page.waitForEvent('download');await menu.locator('[data-action="svg"]').click();const vectorDownload=await svgDownload;
      assert.match(vectorDownload.suggestedFilename(),/precipitation.*\.svg$/);
      const vectorPath=resolve(out,kind+'-precipitation.svg');await vectorDownload.saveAs(vectorPath);
      const vectorBytes=await readFile(vectorPath,'utf8');assert.equal(vectorBytes,vectorInfo.svg,'SVG download preserves the complete captured chart and metadata');
      assert.ok(vectorBytes.includes('cumulative-curve')&&vectorBytes.includes('Cumulative mm')&&compact(vectorInfo.text).includes('cumulative mean: 252.0 mm'));
      await page.keyboard.press('Escape');
      await page.evaluate(()=>window.fixtureFailPNG=false);
      await page.locator('#theme').selectOption('light');await save('precipitation',await open('precipitation','button'),'precipitation-light');
      if(kind==='iphone')for(const width of [320,390,768]){
        await page.setViewportSize({width,height:844});await open('precipitation','button');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Phone layout has no horizontal overflow');await page.keyboard.press('Escape');
      }
      assert.deepEqual({forecasts,metadata,manifests},requestCount,'Image actions make no weather or metadata requests');
      assert.deepEqual(unexpected,[],'All network requests are local or deterministic fixtures');assert.deepEqual(errors,[]);
      report.push({browser:kind,downloads,clipboard:'Native ClipboardItem accepted promised PNG during user activation',fallback:'Denied and absent clipboard show PNG preview',requests:requestCount});
      await page.screenshot({path:resolve(out,kind+'-page.png'),fullPage:true});
    } catch(error){
      await writeFile(resolve(out,kind+'-failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors,unexpected,forecasts,metadata},null,2));
      await page.screenshot({path:resolve(out,kind+'-failure.png'),fullPage:true}).catch(()=>{});
      await context.tracing.stop({path:resolve(out,kind+'-trace.zip')});traceSaved=true;throw error;
    } finally {if(!traceSaved)await context.tracing.stop();await browser.close();}
  }
  await writeFile(resolve(out,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await new Promise(resolve=>server.close(resolve));}
