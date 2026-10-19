import {extractStep, gridPoint, jsonIndex} from './mogreps-core.js';

const INDEX_ROOT = 'https://matthewhugo81-arch.github.io/snowline-ensembles/mogreps/';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TABLE = `${SUPABASE_URL}/rest/v1/snowline_mogreps_cache`;
const dbHeaders = {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json'};
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, OPTIONS'};
const indexes = new Map<string, {expires: number, promise: Promise<any>}>();
const pending = new Map<string, Promise<any>>();
let lastCleanup = 0;

function reply(data: unknown, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {status, headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': cache}});
}
async function index(path: string, signal: AbortSignal) {
  const cached = indexes.get(path);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = jsonIndex(INDEX_ROOT + path, (u: string, o = {}) => fetch(u, {...o, signal}));
  indexes.set(path, {expires: Date.now() + 300000, promise});
  if (indexes.size > 160) indexes.delete(indexes.keys().next().value!);
  try { return await promise; } catch (e) { indexes.delete(path); throw e; }
}
async function cleanup() {
  if (Date.now() - lastCleanup < 3600000) return;
  lastCleanup = Date.now();
  const cutoff = Math.floor(Date.now() / 1000) - 72 * 3600;
  const r = await fetch(`${TABLE}?run=lt.${cutoff}`, {method: 'DELETE', headers: dbHeaders});
  await r.body?.cancel();
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (req.method !== 'GET') return reply({error: 'GET required'}, 405);
  const u = new URL(req.url);
  try {
    const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
    const runId = u.searchParams.get('run') ?? '';
    const lead = Number(u.searchParams.get('lead'));
    if (!u.searchParams.has('lat') || !u.searchParams.has('lon') || !u.searchParams.has('lead') || !/^\d{8}T(?:00|06|12|18)00Z$/.test(runId) || !Number.isInteger(lead) || lead < 0 || lead > 246 || lead % 3) return reply({error: 'Invalid forecast request'}, 400);
    const point = gridPoint(lat, lon);
    const signal = AbortSignal.timeout(110000);
    const manifest = await index(`${runId}/manifest.json`, signal);
    if (manifest.runId !== runId || Math.abs(Date.now() / 1000 - manifest.run) > 72 * 3600) return reply({error: 'Forecast run expired. Refresh to load a newer run.'}, 410);
    const key = `v1:${runId}:${point.y}:${point.x}:${lead}`;
    const hit = await fetch(`${TABLE}?key=eq.${key}&select=payload`, {headers: dbHeaders, signal});
    if (hit.ok) {
      const rows = await hit.json();
      if (rows.length) return reply({...rows[0].payload, cached: true}, 200, 'public, max-age=21600');
    } else await hit.body?.cancel();
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        const result = await extractStep(manifest, point, lead,
          (kind: string, h: number) => index(`${runId}/${kind}-${String(h).padStart(3, '0')}.json.gz`, signal),
          (url: string, options = {}) => fetch(url, {...options, signal}));
        const saved = await fetch(TABLE + '?on_conflict=key', {method: 'POST', headers: {...dbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify({key, run: manifest.run, payload: result}), signal});
        if (!saved.ok) console.error('MOGREPS cache write failed', saved.status);
        await saved.body?.cancel();
        return result;
      })());
    }
    try {
      const result = await pending.get(key);
      await cleanup().catch(() => {});
      return reply(result, 200, 'public, max-age=21600');
    } finally { pending.delete(key); }
  } catch (e) {
    console.error('MOGREPS extraction failed', e instanceof Error ? e.message : 'Unknown error');
    return reply({error: 'Met Office data could not be retrieved. Please retry.'}, 503);
  }
});
