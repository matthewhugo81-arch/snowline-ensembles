import test from 'node:test';
import assert from 'node:assert/strict';
import {mogrepsTransport,retryDelay} from '../docs/mogreps-request.js';

test('a service-wide 503 stops the four-worker queue within a small request budget',async t=>{
 let calls=0;const waits=[];
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:503});});
 const transport=mogrepsTransport({wait:async ms=>{waits.push(ms);await new Promise(r=>setImmediate(r));}});
 try{
  await Promise.all(Array.from({length:4},async()=>{
   for(let lead=0;lead<83&&!transport.stopped;lead++)try{await transport.request('https://test.invalid');}catch{}
  }));
  assert.ok(calls<=7,`outage produced ${calls} requests`);assert.ok(transport.stopped);assert.ok(waits.every(ms=>ms>=500));
 }finally{transport.close();}
});

test('client errors are not retried and Retry-After controls transient recovery',async t=>{
 for(const status of [400,403,404]){
  let calls=0;const transport=mogrepsTransport();
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status});});
  try{await assert.rejects(transport.request('https://test.invalid'));assert.equal(calls,1);}finally{transport.close();t.mock.restoreAll();}
 }
 let calls=0;const waits=[];
 t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'2'}}):Response.json({ok:true}));
 const transport=mogrepsTransport({wait:async ms=>waits.push(ms)});
 try{assert.deepEqual(await transport.request('https://test.invalid'),{ok:true});assert.equal(calls,2);assert.ok(waits[0]>=1900);assert.equal(transport.stopped,false);}finally{transport.close();}
 assert.equal(retryDelay(new Response('',{headers:{'Retry-After':'Wed, 21 Oct 2026 08:00:02 GMT'}}),Date.parse('2026-10-21T08:00:00Z')),2000);
});

test('an overall deadline aborts stalled requests and stops scheduling leads',async t=>{
 t.mock.method(globalThis,'fetch',async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 const transport=mogrepsTransport({deadlineMs:30,timeoutMs:100});
 try{await assert.rejects(transport.request('https://test.invalid'),{name:'TimeoutError'});assert.equal(transport.stopped,true);}finally{transport.close();}
});

