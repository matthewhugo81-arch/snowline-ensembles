import {fetchMogreps} from './mogreps.js?v=20261019-image-background';
import {fetchRunMetadata,resolveFeedRuns,verifiedRun} from './runs.js?v=20261020-mobile-time-runs';
export const MODELS = [
  {id:'gfs',name:'GFS ENS',feed:'ncep_gefs_seamless',agency:'NOAA · GEFS',members:31,days:16,color:'#f3798a'},
  {id:'ec',name:'EC ENS',feed:'ecmwf_ifs025_ensemble',agency:'ECMWF · IFS ENS',members:51,days:15,color:'#4ac7ce'},
  {id:'gem',name:'GEM ENS',feed:'gem_global_ensemble',agency:'ECCC · GEPS',members:21,days:16,color:'#73b0f3'},
  {id:'mogreps',name:'MOGREPS-G',feed:'Met Office · direct AWS data',agency:'Met Office · Global',members:18,days:10,color:'#70c991'}
];
export const VARIABLE_DETAILS = {
  temperature_850hPa:{unit:'degC',accumulated:false},
  temperature_500hPa:{unit:'degC',accumulated:false},
  precipitation:{unit:'mm',accumulated:true},
  snowfall:{unit:'cm',accumulated:true},
  pressure_msl:{unit:'hPa',accumulated:false}
};
export const VARIABLES = Object.keys(VARIABLE_DETAILS);
export const valid = v => typeof v === 'number' && Number.isFinite(v);
export function percentile(values,p) {if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),z=(a.length-1)*p,i=Math.floor(z);return a[i]+(a[Math.ceil(z)]-a[i])*(z-i);}
export function statistics(values){const a=values.filter(valid);return {count:a.length,mean:a.length?a.reduce((x,y)=>x+y,0)/a.length:null,min:a.length?Math.min(...a):null,max:a.length?Math.max(...a):null,p10:percentile(a,.1),p90:percentile(a,.9)};}
export function extractMembers(hourly,variable){return Object.keys(hourly).filter(k=>k===variable||new RegExp('^'+variable+'_member\\d+$').test(k)).sort((a,b)=>memberNumber(a)-memberNumber(b)).map(key=>({id:memberNumber(key),values:hourly[key]}));}
function memberNumber(key){return Number(key.match(/_member(\d+)$/)?.[1]??0);}
export function aggregateMember(values,times,index,interval,nativeInterval=1){if(interval<nativeInterval||interval%nativeInterval)return null;let sum=0;for(let j=0;j<interval/nativeInterval;j++){const k=index-j;if(k<0||!valid(values[k])||times[index]-times[k]!==j*nativeInterval*3600)return null;sum+=values[k];}return sum;}
export function prepareDataset(raw,model,retrieved=Date.now()) {if(!raw.hourly?.time?.length)throw new Error('No hourly forecast returned.');const members=Object.fromEntries(VARIABLES.map(v=>[v,extractMembers(raw.hourly,v)]));return {model,raw,members,retrieved,runInfo:verifiedRun(raw)};}
export function resample(dataset,interval){const times=dataset.raw.hourly.time,indices=times.map((t,i)=>t%(interval*3600)===0?i:-1).filter(i=>i>=0),result={time:indices.map(i=>times[i]),intervalHours:interval,expectedMembers:dataset.model.members,variables:{}};
  for(const variable of VARIABLES){const accumulated=VARIABLE_DETAILS[variable].accumulated;const members=dataset.members[variable].map(m=>({id:m.id,values:indices.map(i=>accumulated?aggregateMember(m.values,times,i,interval,dataset.raw.intervalHours??1):(valid(m.values[i])?m.values[i]:null))}));const stats=indices.map((_,i)=>statistics(members.map(m=>m.values[i])));result.variables[variable]={members,stats};}
  const snow=result.variables.snowfall.members;result.variables.snow={members:[],stats:indices.map((_,i)=>{const a=snow.map(m=>m.values[i]).filter(valid),hits=a.filter(v=>v>=.1).length;return {count:a.length,hits,mean:a.length?hits/a.length*100:null};})};return result;
}
// A sampled precipitation value covers (time - interval, time]. The value at
// the visible start therefore belongs before the cumulative window. Only whole,
// adjacent periods inside the visible range contribute; a gap ends the known
// cumulative prefix instead of silently restarting or skipping missing rain.
export function cumulativePrecipitation(sample,start,end){
  const step=sample?.intervalHours*3600;
  if(!valid(step)||step<=0||!valid(start)||!valid(end)||end<start)return null;
  const first=Math.ceil(start/step)*step,last=Math.floor(end/step)*step,required=Math.max(0,Math.round((last-first)/step));
  const result={start:first,end:last,visibleStart:start,visibleEnd:end,intervalHours:sample.intervalHours,required,completed:0,time:[],values:[],memberMin:[],memberMax:[],firstMissing:null,total:null,status:'empty',expectedMembers:sample.expectedMembers};
  if(!required)return result;
  const indices=new Map();
  sample.time.forEach((t,i)=>indices.set(t,indices.has(t)?null:i));
  let sum=0,min=Infinity,max=0,broken=false;
  result.time.push(first);result.values.push(0);result.memberMin.push(null);result.memberMax.push(null);
  for(let t=first+step;t<=last;t+=step){
    const i=indices.get(t),stat=i===undefined||i===null?null:sample.variables.precipitation?.stats[i];
    if(!broken&&(!valid(stat?.mean)||!(stat.count>0))){broken=true;result.firstMissing=t;}
    if(!broken){sum+=stat.mean;min=Math.min(min,stat.count);max=Math.max(max,stat.count);result.completed++;}
    result.time.push(t);result.values.push(broken?null:sum);result.memberMin.push(!broken?min:null);result.memberMax.push(!broken?max:null);
  }
  result.status=broken?'incomplete':'complete';result.total=broken?null:sum;
  return result;
}
export function niceDomain(values,zero=false){const a=values.filter(valid);if(!a.length)return {min:0,max:1,step:.25};let lo=zero?0:Math.min(...a),hi=Math.max(...a);let span=hi-lo;if(span<1){lo=zero?0:lo-1;hi=zero?Math.max(1,hi):hi+1;span=hi-lo;}else{if(!zero)lo-=span*.08;hi+=span*.08;}const raw=(hi-lo)/5,power=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(x=>x*power).find(x=>x>=raw)??power*10;return {min:zero?0:Math.floor(lo/step)*step,max:Math.ceil(hi/step)*step,step};}
export function parseCoordinates(text){const match=text.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*[,;]\s*([+-]?\d+(?:\.\d+)?)$/);if(!match)return null;const lat=+match[1],lon=+match[2];if(Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('Latitude must be −90 to 90, longitude −180 to 180.');return {name:'Selected coordinates',lat,lon};}
export async function fetchEnsemble(model,location,signal,onProgress) {
  if(model.id==='mogreps')return prepareDataset(await fetchMogreps(location,signal,(raw,done,total)=>onProgress?.(prepareDataset(raw,model),done,total)),model);
  // forecast_days counts UTC calendar days starting at midnight, not days from
  // initialization. Include the final calendar date so +384h/+360h and non-00Z
  // endpoints are fetched too; the provider's unavailable values remain null.
  const params=new URLSearchParams({latitude:location.lat,longitude:location.lon,models:model.feed,hourly:VARIABLES.join(','),forecast_days:model.days+1,past_days:1,timeformat:'unixtime',timezone:'GMT'});
  const before=await fetchRunMetadata(model,signal);
  signal?.throwIfAborted();
  const requested=Date.now();
  const response=await fetch('https://ensemble-api.open-meteo.com/v1/ensemble?'+params,{signal,cache:'no-store'});
  if(!response.ok){let reason;try{reason=(await response.json()).reason}catch{}throw new Error(reason||`Weather service returned ${response.status}.`);}
  const raw=await response.json(),retrieved=Date.now();
  let after;
  try {
    after=await fetchRunMetadata(model,signal,{fresh:true});
    signal?.throwIfAborted();
  } catch(error) {
    // A late metadata check must not discard a forecast already received.
    // Location changes and other explicit cancellations still abort the load.
    if(error.name!=='TimeoutError' || signal?.reason?.name!=='TimeoutError')throw error;
    after=[];
  }
  return {...prepareDataset(raw,model,retrieved),runInfo:resolveFeedRuns(model,before,after,requested,retrieved)};
}
