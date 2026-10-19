// Metadata uses the same free ensemble service as the point forecast.
// Sources: Open-Meteo /en/docs/model-updates and its GFS/GEM domain mappings.
// GEFS upper-air fields use 0.5° only; precipitation/snowfall can use both grids.
const SOURCES = {
  gfs: [
    {domain:'ncep_gefs025',label:'0.25°',variables:['precipitation','snowfall']},
    {domain:'ncep_gefs05',label:'0.5°'}
  ],
  ec: [{domain:'ecmwf_ifs025_ensemble',label:'IFS ENS'}],
  gem: [{domain:'cmc_gem_geps',label:'GEPS'}]
};
const CONSISTENCY_DELAY = 10 * 60 * 1000;
const timestamp = value => Number.isSafeInteger(value) && value >= 946684800 && value < 4102444800;

export async function fetchRunMetadata(model, signal) {
  return Promise.all((SOURCES[model.id] || []).map(async source => {
    const url = `https://ensemble-api.open-meteo.com/data/${source.domain}/static/meta.json`;
    try {
      const timeout = AbortSignal.timeout(3500);
      const response = await fetch(url, {cache:'no-store',signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
      if (!response.ok) { await response.body?.cancel(); throw Error('Metadata unavailable'); }
      const meta = await response.json();
      const run = meta.last_run_initialisation_time;
      const available = meta.last_run_availability_time;
      const modified = meta.last_run_modification_time;
      if (!timestamp(run) || !timestamp(available) || !timestamp(modified) || available < run || modified < run || run % 3600) throw Error('Invalid run metadata');
      return {...source,url,run,available,modified};
    } catch (error) {
      signal?.throwIfAborted();
      return {...source,url,run:null,available:null,modified:null};
    }
  }));
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
  const sources = relevantSources(info, variable);
  if (!sources.length) return 'Run available after loading';
  const same = sources.every(source => source.run === sources[0].run && source.status === sources[0].status);
  const describe = source => `${formatRun(source.run)}${source.run && source.status === 'updating' ? ' (updating)' : source.run && source.status === 'unverified' ? ' (unverified)' : ''}`;
  return same ? `Feed run ${describe(sources[0])}` : 'Feed runs · ' + sources.map(source => `${source.label} ${describe(source)}`).join(' · ');
}

export function runDetail(info, variable) {
  if (info?.type === 'verified') return 'Initialization time verified against the loaded Met Office forecast.';
  const sources = relevantSources(info, variable);
  if (!sources.length) return 'Load this ensemble to see its issue time.';
  const mixed = new Set(sources.filter(source=>source.run).map(source=>source.run)).size > 1;
  return 'Open-Meteo reports these initialization times for the feed loaded with this chart. ' +
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
