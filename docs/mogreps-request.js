// One deadline and outage budget shared by every lead in a point forecast.
export const retryDelay = (response, now=Date.now()) => {
 const value=response.headers?.get('Retry-After');
 if(!value)return 0;
 const seconds=Number(value),until=Number.isFinite(seconds)?now+seconds*1000:Date.parse(value);
 return Number.isFinite(until)?Math.max(0,until-now):0;
};
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal.aborted){reject(signal.reason);return;}
 const abort=()=>{clearTimeout(timer);reject(signal.reason);};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
 signal.addEventListener('abort',abort,{once:true});
});
export function mogrepsTransport({signal,deadlineMs=180000,timeoutMs=30000,maxFailures=4,wait=sleep}={}){
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new DOMException('Met Office loading deadline reached','TimeoutError')),deadlineMs);
 const combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
 let failures=0,stopped=false,cooldown=0,lastError;
 const open=()=>stopped||combined.aborted;
 return {
  get stopped(){return open();},
  get error(){return lastError??combined.reason;},
  close(){clearTimeout(timer);},
  async request(url,options={}){
   for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted();
    if(open())throw lastError??combined.reason??Error('Met Office service is temporarily unavailable.');
    try{
     if(cooldown>Date.now())await wait(cooldown-Date.now(),combined);
     if(open())throw lastError??combined.reason;
     const response=await fetch(url,{...options,signal:AbortSignal.any([combined,AbortSignal.timeout(timeoutMs)])});
     if(!response.ok){
      const delay=retryDelay(response);
      cooldown=Math.max(cooldown,Date.now()+delay);
      await response.body?.cancel();
      throw Object.assign(Error('Met Office forecast request failed (HTTP '+response.status+').'),{status:response.status,retryAfter:delay/1000});
     }
     const value=await response.json();combined.throwIfAborted();failures=0;return value;
    }catch(error){
     signal?.throwIfAborted();lastError=error;
     if(combined.aborted)throw error;
     failures++;
     const retryable=!error.status||error.status===408||error.status===429||error.status>=500;
     if([400,401,403].includes(error.status)||failures>=maxFailures)stopped=true;
     if(!retryable||stopped||attempt===2)throw error;
     await wait(Math.max(cooldown-Date.now(),500*2**attempt),combined);
    }
   }
  }
 };
}
