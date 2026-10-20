import {loadMogrepsForecast} from './mogreps-transport.js?v=20261020-reliable-points';
const ENDPOINT = 'https://znlriqmliaszlxlnkeic.supabase.co/functions/v1/snowline-mogreps';
// Public anon credential only; the cache is inaccessible to browser roles.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpubHJpcW1saWFzemx4bG5rZWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwMDYyNTIsImV4cCI6MjEwNjU4MjI1Mn0.p9RNJx-6QabOBVm1GeuaY42xFgxNtAyeQeljkowypfY';
const REQUIRED_VARIABLES = ['temperature_850hPa','temperature_500hPa','precipitation','snowfall'];
export const MOGREPS_VARIABLES = [...REQUIRED_VARIABLES,'pressure_msl'];
const pressureAvailable = manifest => manifest.variables?.includes('pressure_msl') === true;
const validMembers = values => Array.isArray(values) && values.length === 18 && values.every(n=>n===null || typeof n==='number' && Number.isFinite(n));
export function createMogrepsRaw(manifest) {
  if (manifest.schema !== 1 || manifest.intervalHours !== 3 || manifest.members?.length !== 18 || !manifest.members.includes(0) || new Set(manifest.members).size !== 18 || manifest.leads?.length !== 83 || manifest.leads.some((h,i)=>h!==i*3) || !Number.isFinite(manifest.run)) throw Error('Unrecognised Met Office forecast index.');
  const hourly = {time:manifest.leads.map(h=>manifest.run+h*3600)};
  for (const v of MOGREPS_VARIABLES) for (const m of manifest.members) hourly[v+'_member'+m] = new Array(manifest.leads.length).fill(null);
  return {hourly,intervalHours:3,run:manifest.run,runId:manifest.runId,source:'Met Office MOGREPS-G on AWS',sourceUrl:manifest.sourceUrl,license:'CC BY-SA 4.0',complete:false,completed:0,total:manifest.leads.length,missingSteps:[],missingVariables:pressureAvailable(manifest)?[]:['pressure_msl'],missingVariableSteps:{pressure_msl:pressureAvailable(manifest)?[]:[...manifest.leads]}};
}
export function applyMogrepsStep(raw,manifest,step,lead) {
  if (step.schema!==1 || step.run!==manifest.run || step.time!==manifest.run+lead*3600 || step.intervalHours!==3 || JSON.stringify(step.members)!==JSON.stringify(manifest.members) || !Number.isFinite(step.latitude) || !Number.isFinite(step.longitude)) throw Error('Met Office forecast run or member mismatch.');
  if (raw.latitude!==undefined && (raw.latitude!==step.latitude || raw.longitude!==step.longitude)) throw Error('Met Office grid point mismatch.');
  for (const v of REQUIRED_VARIABLES) if (!validMembers(step.values?.[v])) throw Error('Incomplete Met Office member response.');
  raw.latitude=step.latitude;raw.longitude=step.longitude;
  const i=manifest.leads.indexOf(lead);
  if (i < 0) throw Error('Invalid Met Office forecast time.');
  for (const v of REQUIRED_VARIABLES) manifest.members.forEach((m,j)=>{raw.hourly[v+'_member'+m][i]=step.values[v][j];});
  const pressure=step.values?.pressure_msl,available=step.units?.pressure_msl==='hPa' && validMembers(pressure) && pressure.some(Number.isFinite) && !step.missingVariables?.includes('pressure_msl');
  manifest.members.forEach((m,j)=>{raw.hourly['pressure_msl_member'+m][i]=available?pressure[j]:null;});
  const missing=raw.missingVariableSteps.pressure_msl;
  if (available) raw.missingVariableSteps.pressure_msl=missing.filter(h=>h!==lead);
  else if (!missing.includes(lead)) missing.push(lead);
  raw.missingVariables=raw.missingVariableSteps.pressure_msl.length?['pressure_msl']:[];
}
export async function fetchMogreps(location,signal,onProgress=()=>{},options={}) {
  return loadMogrepsForecast({manifestURL:new URL('./mogreps/latest.json',import.meta.url),
    endpoint:ENDPOINT,headers:{apikey:ANON,Authorization:'Bearer '+ANON},location,signal,onProgress,
    createRaw:createMogrepsRaw,applyStep:applyMogrepsStep,hasPressure:pressureAvailable},options);
}
