// Metadata uses the same free ensemble service as the point forecast.
// Sources: Open-Meteo /en/docs/model-updates and its GFS/GEM domain mappings.
// GEFS upper-air fields use 0.5° only; precipitation/snowfall/MSLP can use both grids.
const SOURCES = {
  gfs: [
    {domain:'ncep_gefs025',label:'0.25°',variables:['precipitation','snowfall','pressure_msl']},
    {domain:'ncep_gefs05',label:'0.5°'}
  ],
  ec: [{domain:'ecmwf_ifs025_ensemble',label:'IFS ENS'}],
  gem: [{domain:'cmc_gem_geps',label:'GEPS'}]
};
const CONSISTENCY_DELAY = 10 * 60 * 1000;
const timestamp = value => Number.isSafeInteger(value) && value >= 946684800 && value < 4102444800;
const pendingMetadata = new Map();

// The catalogue and the leading forecast check can share an in-flight request.
// No completed response is cached, and the trailing check must request fresh:true
// so it is a separate observation of the feed after the forecast was received.
async function readMetadata(source) {
  const url = `https://ensemble-api.open-meteo.com/data/${source.domain}/static/meta.json`;
  try {
    const response = await fetch(url, {cache:'no-store',signal:AbortSignal.timeout(3500)});
    if (!response.ok) { await response.body?.cancel(); throw Error('Metadata unavailable'); }
    const meta = await response.json();
    const run = meta.last_run_initialisation_time;
    const available = meta.last_run_availability_time;
    const modified = meta.last_run_modification_time;
    if (!timestamp(run) || !timestamp(available) || !timestamp(modified) || available < run || modified < run || run % 3600) throw Error('Invalid run metadata');
    return {...source,url,run,available,modified};
  } catch {
    return {...source,url,run:null,available:null,modified:null};
  }
}

function cancellable(request, signal) {
  if (!signal) return request;
  signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    const abort = () => { signal.removeEventListener('abort',abort); reject(signal.reason); };
    signal.addEventListener('abort',abort,{once:true});
    request.then(value => {
      signal.removeEventListener('abort',abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort',abort); reject(error); });
  });
}

export async function fetchRunMetadata(model, signal, {fresh=false}={}) {
  signal?.throwIfAborted();
  return Promise.all((SOURCES[model.id] || []).map(source => {
    let request = fresh ? null : pendingMetadata.get(source.domain);
    if (!request) {
      request = readMetadata(source);
      if (!fresh) {
        pendingMetadata.set(source.domain,request);
        void request.finally(() => {
          if (pendingMetadata.get(source.domain) === request) pendingMetadata.delete(source.domain);
        });
      }
    }
    // One cancelled location/forecast must not cancel another catalogue reader.
    return cancellable(request,signal);
  }));
}

// Lightweight, location-independent lookups for every model card. These describe
// the latest published feed/index and are deliberately separate from runInfo on
// an already loaded chart; discovering a newer run must not relabel older data.
export async function fetchLatestRun(model, signal) {
  signal?.throwIfAborted();
  if (model.id !== 'mogreps') {
    const metadata = await fetchRunMetadata(model,signal);
    signal?.throwIfAborted();
    const checked = Date.now();
    return {type:'latest-feed',checked,sources:metadata.map(source => ({...source,
      status:!source.run ? 'unavailable' : source.available*1000+CONSISTENCY_DELAY > checked ? 'updating' : 'available'
    }))};
  }
  const url = new URL('./mogreps/latest.json',import.meta.url).href;
  try {
    const timeout = AbortSignal.timeout(3500);
    const response = await fetch(url,{cache:'no-store',signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
    if (!response.ok) { await response.body?.cancel(); throw Error('Index unavailable'); }
    const manifest = await response.json();
    signal?.throwIfAborted();
    const run = manifest.run;
    const runId = timestamp(run) ? new Date(run*1000).toISOString().replace(/[-:]/g,'').slice(0,11)+'00Z' : '';
    if (manifest.schema!==1 || manifest.intervalHours!==3 || !timestamp(run) || run%3600 || manifest.runId!==runId ||
        !Array.isArray(manifest.members) || manifest.members.length!==18 || new Set(manifest.members).size!==18 ||
        !manifest.members.includes(0) || !manifest.members.every(member=>Number.isInteger(member)&&member>=0) ||
        !Array.isArray(manifest.leads) || manifest.leads.length!==83 || manifest.leads.some((lead,index)=>lead!==index*3)) throw Error('Invalid Met Office forecast index');
    const checked = Date.now();
    return {type:'latest-manifest',run,runId:manifest.runId,url,checked,status:checked/1000-run>72*3600?'stale':'available',sources:[]};
  } catch {
    signal?.throwIfAborted();
    return {type:'latest-manifest',run:null,url,checked:Date.now(),status:'unavailable',sources:[]};
  }
}

// A metadata snapshot describes the rolling feed, not a pinned run for every
// forecast hour. Never put it in raw.run or the CSV's verified run_utc column.
// Read before/after the forecast to detect an update while it was loading, and
// allow the provider's documented ten minutes for redundant servers to agree.
export function resolveFeedRuns(model, before, after, requested, retrieved) {
  const sources = (SOURCES[model.id] || []).map(source => {
    const first = before.find(item => item.domain === source.domain);
    const last = after.find(item => item.domain === source.domain);
    const known = last?.run ? last : first;
    const stable = first?.run && last?.run && first.run === last.run && first.modified === last.modified;
    // Availability timestamps can differ between redundant API servers even
    // when they hold the same run. Both observed servers must have settled.
    const settled = stable && Math.max(first.available,last.available) * 1000 + CONSISTENCY_DELAY <= requested;
    const status = !known?.run ? 'unavailable' : !stable ? 'unverified' : settled ? 'available' : 'updating';
    return {...source,url:known?.url || '',run:known?.run || null,status};
  });
  return {type:'feed',sources,checked:retrieved};
}

export function verifiedRun(raw) {
  return timestamp(raw.run) ? {type:'verified',run:raw.run,sources:[]} : null;
}

export function relevantSources(info, variable) {
  const id = variable === 'snow' || variable === 'snowfall_member_agreement' ? 'snowfall' : variable;
  return (info?.sources || []).filter(source => !id || !source.variables || source.variables.includes(id));
}

export function formatRun(run) {
  if (!timestamp(run)) return 'unavailable';
  const date = new Date(run * 1000);
  const day = new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}).format(date);
  return `${day} ${String(date.getUTCHours()).padStart(2,'0')}Z`;
}

export function runSummary(info, variable) {
  if (info?.type === 'verified') return `Run ${formatRun(info.run)}`;
  if (info?.type === 'latest-manifest') return `Latest run ${formatRun(info.run)}${info.run&&info.status==='stale'?' (older run)':''}`;
  const sources = relevantSources(info, variable);
  if (!sources.length) return info?.type==='latest-feed' ? 'Latest feed run unavailable' : 'Checking latest run…';
  const same = sources.every(source => source.run === sources[0].run && source.status === sources[0].status);
  const describe = source => `${formatRun(source.run)}${source.run && source.status === 'updating' ? ' (updating)' : source.run && source.status === 'unverified' ? ' (unverified)' : ''}`;
  const prefix = info?.type==='latest-feed' ? 'Latest feed' : 'Feed';
  return same ? `${prefix} run ${describe(sources[0])}` : prefix+' runs · ' + sources.map(source => `${source.label} ${describe(source)}`).join(' · ');
}

export function runDetail(info, variable) {
  if (info?.type === 'verified') return 'Initialization time verified against the loaded Met Office forecast.';
  if (info?.type === 'latest-manifest') return info.run ? 'Latest complete Met Office forecast index, checked independently of the chart downloads. '+(info.status==='stale'?'This index is over 72 hours old and cannot be loaded as a current forecast. ':'')+'A loaded chart keeps the initialization time of its own data.' : 'The latest Met Office forecast index is temporarily unavailable; no cycle has been guessed.';
  const sources = relevantSources(info, variable);
  if (!sources.length) return 'Checking the latest published model run independently of the chart downloads.';
  const mixed = new Set(sources.filter(source=>source.run).map(source=>source.run)).size > 1;
  return (info?.type==='latest-feed' ? 'Latest initialization reported by Open-Meteo, checked independently of the chart downloads. A loaded chart keeps its own feed timing. ' : 'Open-Meteo reports these initialization times for the feed loaded with this chart. ') +
    (mixed ? 'The GEFS grids currently have different runs. ' : '') +
    'The rolling forecast can retain older runs at longer lead times. ' +
    (sources.some(source=>source.status==='updating') ? 'A new run is still within the provider’s update window. ' : '') +
    (sources.some(source=>source.status==='unverified') ? 'Run metadata changed or could not be checked on both sides of this forecast request; use Refresh to recheck. ' : '') +
    (sources.some(source=>source.status==='unavailable') ? 'Some issue times are unavailable; no cycle has been guessed.' : '');
}

export function runExport(info, variable) {
  const sources = relevantSources(info, variable);
  return {
    run:info?.type === 'verified' ? new Date(info.run*1000).toISOString() : '',
    feedRuns:sources.filter(source=>source.run).map(source=>`${source.domain}=${new Date(source.run*1000).toISOString()}`).join('; '),
    status:info?.type === 'verified' ? 'verified' : sources.map(source=>`${source.domain}=${source.status}`).join('; '),
    source:info?.type === 'verified' ? 'Met Office forecast manifest' : sources.map(source=>source.url).filter(Boolean).join('; ')
  };
}
