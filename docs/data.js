export const MODELS = [
  {id:'gfs',name:'GFS ENS',feed:'ncep_gefs_seamless',agency:'NOAA · GEFS',members:31,days:16,color:'#f3798a'},
  {id:'ec',name:'EC ENS',feed:'ecmwf_ifs025_ensemble',agency:'ECMWF · IFS ENS',members:51,days:15,color:'#4ac7ce'},
  {id:'gem',name:'GEM ENS',feed:'gem_global_ensemble',agency:'ECCC · GEPS',members:21,days:16,color:'#73b0f3'},
  {id:'mogreps',name:'MOGREPS-G',feed:'ukmo_global_ensemble_20km',agency:'Met Office · Global',members:18,days:8,color:'#70c991'}
];
export const VARIABLES = ['temperature_850hPa','temperature_500hPa','precipitation','snowfall'];
export const valid = v => typeof v === 'number' && Number.isFinite(v);
export function percentile(values,p) {if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),z=(a.length-1)*p,i=Math.floor(z);return a[i]+(a[Math.ceil(z)]-a[i])*(z-i);}
export function statistics(values){const a=values.filter(valid);return {count:a.length,mean:a.length?a.reduce((x,y)=>x+y,0)/a.length:null,min:a.length?Math.min(...a):null,max:a.length?Math.max(...a):null,p10:percentile(a,.1),p90:percentile(a,.9)};}
export function extractMembers(hourly,variable){return Object.keys(hourly).filter(k=>k===variable||new RegExp('^'+variable+'_member\\d+$').test(k)).sort((a,b)=>memberNumber(a)-memberNumber(b)).map(key=>({id:memberNumber(key),values:hourly[key]}));}
function memberNumber(key){return Number(key.match(/_member(\d+)$/)?.[1]??0);}
export function aggregateMember(values,times,index,interval){let sum=0;for(let j=0;j<interval;j++){const k=index-j;if(k<0||!valid(values[k])||times[index]-times[k]!==j*3600)return null;sum+=values[k];}return sum;}
export function prepareDataset(raw,model,retrieved=Date.now()) {if(!raw.hourly?.time?.length)throw new Error('No hourly forecast returned.');const members=Object.fromEntries(VARIABLES.map(v=>[v,extractMembers(raw.hourly,v)]));return {model,raw,members,retrieved};}
export function resample(dataset,interval){const times=dataset.raw.hourly.time,indices=times.map((t,i)=>t%(interval*3600)===0?i:-1).filter(i=>i>=0),result={time:indices.map(i=>times[i]),variables:{}};
  for(const variable of VARIABLES){const accumulated=variable==='precipitation'||variable==='snowfall';const members=dataset.members[variable].map(m=>({id:m.id,values:indices.map(i=>accumulated?aggregateMember(m.values,times,i,interval):(valid(m.values[i])?m.values[i]:null))}));const stats=indices.map((_,i)=>statistics(members.map(m=>m.values[i])));result.variables[variable]={members,stats};}
  const snow=result.variables.snowfall.members;result.variables.snow={members:[],stats:indices.map((_,i)=>{const a=snow.map(m=>m.values[i]).filter(valid),hits=a.filter(v=>v>=.1).length;return {count:a.length,hits,mean:a.length?hits/a.length*100:null};})};return result;
}
export function niceDomain(values,zero=false){const a=values.filter(valid);if(!a.length)return {min:0,max:1,step:.25};let lo=zero?0:Math.min(...a),hi=Math.max(...a);let span=hi-lo;if(span<1){lo=zero?0:lo-1;hi=zero?Math.max(1,hi):hi+1;span=hi-lo;}else{if(!zero)lo-=span*.08;hi+=span*.08;}const raw=(hi-lo)/5,power=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(x=>x*power).find(x=>x>=raw)??power*10;return {min:zero?0:Math.floor(lo/step)*step,max:Math.ceil(hi/step)*step,step};}
export function parseCoordinates(text){const match=text.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*[,;]\s*([+-]?\d+(?:\.\d+)?)$/);if(!match)return null;const lat=+match[1],lon=+match[2];if(Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('Latitude must be −90 to 90, longitude −180 to 180.');return {name:'Selected coordinates',lat,lon};}
export async function fetchEnsemble(model,location,signal){const params=new URLSearchParams({latitude:location.lat,longitude:location.lon,models:model.feed,hourly:VARIABLES.join(','),forecast_days:model.days,past_days:1,timeformat:'unixtime',timezone:'GMT'});const response=await fetch('https://ensemble-api.open-meteo.com/v1/ensemble?'+params,{signal});if(!response.ok){let reason;try{reason=(await response.json()).reason}catch{}throw new Error(reason||`Weather service returned ${response.status}.`);}return prepareDataset(await response.json(),model);}
