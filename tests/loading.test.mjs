import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const app=await readFile(new URL('../docs/app.js',import.meta.url),'utf8');
const loading=app.slice(app.indexOf('async function loadModel('),app.indexOf('function createCharts('));

function fixture(){
  const models=[{id:'mogreps',name:'MOGREPS'},{id:'gfs',name:'GFS ENS'}];
  const partial={retrieved:Date.now(),raw:{run:Date.now()/1000,complete:false,missingSteps:[3],missingVariables:[]}};
  const state={model:'mogreps',location:{name:'Barnoldswick'},mode:'members',epoch:0,abort:new AbortController(),
    datasets:new Map([['mogreps',partial]]),pending:new Set(['mogreps']),errors:new Map(),progress:new Map()};
  const elements=new Map();let requests=0,finish;
  const context=vm.createContext({state,AbortController,AbortSignal,Date,Promise,
    visibleModels:()=>models.filter(m=>m.id===state.model),shortTime:()=> '20 Oct 18:00',
    $:selector=>{if(!elements.has(selector))elements.set(selector,{textContent:'',classList:{toggle(){}}});return elements.get(selector);},
    renderModels(){},renderAll:()=>context.renderStatus(),storeDataset:(id,d)=>state.datasets.set(id,d),
    fetchEnsemble:()=>{requests++;return new Promise(resolve=>{finish=resolve;});}});
  vm.runInContext(loading,context);
  return {state,models,partial,context,elements,requests:()=>requests,finish:data=>finish(data)};
}

test('starting another model after Stop clears the old notice during loading and after success',async()=>{
  const f=fixture();f.context.stopLoading();
  assert.match(f.elements.get('#status').textContent,/Loading stopped/);
  f.state.model='gfs';const request=f.context.loadModel(f.models[1]);
  assert.equal(f.requests(),1);
  assert.match(f.elements.get('#status').textContent,/Loading GFS ENS/);
  assert.doesNotMatch(f.elements.get('#status').textContent,/Loading stopped/);
  assert.equal(f.state.datasets.get('mogreps'),f.partial,'stopped partial forecasts stay available');
  f.finish({retrieved:Date.now()});await request;
  assert.match(f.elements.get('#status').textContent,/Retrieved/);
  assert.doesNotMatch(f.elements.get('#status').textContent,/Loading stopped/);
});

test('selecting retained forecasts after Stop keeps the notice when no new work starts',async()=>{
  const f=fixture();f.context.stopLoading();const notice=f.state.loadNotice;
  await f.context.loadModel(f.models[0]);
  assert.equal(f.requests(),0);
  assert.equal(f.state.loadNotice,notice);
  assert.match(f.elements.get('#status').textContent,/Loading stopped/);
});
