import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {GRID, SOURCE} from '../server/mogreps-core.js';

const members = [0, ...Array.from({length: 17}, (_, i) => i + 18)];
const baseVariables = ['temperature_850hPa', 'temperature_500hPa', 'precipitation', 'snowfall'];
let handlerSequence = 0;

// Exercise the real Deno request handler and decoder with bounded native-grid
// chunks. Every network route is synthetic, including the persistent cache.
async function endpoint(t, {legacy = false} = {}) {
  const run = Math.floor(Date.now() / 21600000) * 21600;
  const iso = new Date(run * 1000).toISOString();
  const runId = iso.slice(0, 10).replaceAll('-', '') + 'T' + iso.slice(11, 13) + '00Z';
  const manifest = {schema: 1, run, runId, members, leads: [0], intervalHours: 3, grid: GRID};
  const fixture = {manifest: legacy ? manifest : {...manifest, variables: [...baseVariables, 'pressure_msl']}, pressureUnavailable: false, requests: [], cacheWrites: [], rows: new Map()};
  const chunks = new Map();
  function source(kind) {
    let offset = 0;
    const key = 'global-ensemble/endpoint-test/' + kind + '.nc';
    const etag = '"endpoint-' + kind + '"';
    function dataset(shape, chunkShape, dtype, values) {
      const bytes = Buffer.alloc(values.length * (dtype === '<f4' ? 4 : 1));
      values.forEach((value, i) => dtype === '<f4' ? bytes.writeFloatLE(value, i * 4) : bytes.writeInt8(value, i));
      const entry = [offset, bytes.length, 0];
      chunks.set(SOURCE + key + '|bytes=' + offset + '-' + (offset + bytes.length - 1), {bytes, etag});
      offset += bytes.length;
      return {shape, chunkShape, dtype, fillValue: dtype === '<f4' ? 9.969209968386869e36 : -127, filters: [], chunks: {[shape.map(() => 0).join(',')]: entry}};
    }
    const index = {schema: 1, kind, key, etag, members, run, time: run};
    if (kind === 'temperature') {
      index.levels = [0, 1];
      index.data = dataset([18, 2, 960, 1280], [18, 2, 1, 1], '<f4', members.flatMap((_, i) => [273.15 + i, 253.15 + i]));
      index.flag = dataset([18, 2, 960, 1280], [18, 2, 1, 1], '|i1', Array(36).fill(0));
    } else {
      index.units = 'Pa';
      index.grid = GRID;
      index.data = dataset([18, 960, 1280], [18, 1, 1], '<f4', members.map((_, i) => 100000 + i * 100));
    }
    index.size = offset;
    return index;
  }
  const indexes = {temperature: source('temperature'), pressure_msl: source('pressure_msl')};
  const table = 'https://endpoint-test.invalid/rest/v1/snowline_mogreps_cache';
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = String(input), method = options.method ?? 'GET';
    fixture.requests.push({url, method, cache: options.cache});
    if (url.startsWith(table)) {
      if (method === 'DELETE') return new Response(null, {status: 204});
      if (method === 'POST') {
        const row = JSON.parse(options.body);
        fixture.cacheWrites.push(row); fixture.rows.set(row.key, row.payload);
        return new Response(null, {status: 201});
      }
      assert.equal(method, 'GET');
      const query = new URL(url).searchParams;
      assert.equal(query.get('select'), 'payload');
      const key = query.get('key').slice(3);
      return Response.json(fixture.rows.has(key) ? [{payload: fixture.rows.get(key)}] : []);
    }
    if (url.endsWith('/' + runId + '/manifest.json')) return Response.json(fixture.manifest);
    const indexed = url.match(new RegExp('/' + runId + '/(temperature|pressure_msl)-000\\.json\\.gz$'));
    if (indexed) {
      if (indexed[1] === 'pressure_msl' && fixture.pressureUnavailable) return new Response(null, {status: 404});
      return new Response(gzipSync(JSON.stringify(indexes[indexed[1]])));
    }
    const headers = new Headers(options.headers);
    const chunk = chunks.get(url + '|' + headers.get('Range'));
    assert.ok(chunk, 'Unexpected network request: ' + url);
    assert.equal(headers.get('If-Match'), chunk.etag);
    return new Response(chunk.bytes, {status: 206});
  });
  const originalDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  let handler;
  Object.defineProperty(globalThis, 'Deno', {configurable: true, writable: true, value: {
    env: {get: name => ({SUPABASE_URL: 'https://endpoint-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-endpoint-test-key'})[name]},
    serve: callback => { handler = callback; }
  }});
  t.after(() => { if (originalDeno) Object.defineProperty(globalThis, 'Deno', originalDeno); else delete globalThis.Deno; });
  const module = new URL('../server/index.ts', import.meta.url);
  module.searchParams.set('test', String(++handlerSequence));
  await import(module.href);
  assert.equal(typeof handler, 'function');
  fixture.get = () => handler(new Request('https://endpoint-test.invalid/functions/v1/mogreps-point?' + new URLSearchParams({lat: String(GRID.latitude[0]), lon: String(GRID.longitude[0]), run: runId, lead: '0'})));
  fixture.key = capability => `v2:${capability}:${runId}:0:0:0`;
  fixture.upgrade = () => { fixture.manifest = {...manifest, variables: [...baseVariables, 'pressure_msl']}; };
  fixture.manifestReads = () => fixture.requests.filter(request => request.url.endsWith('/manifest.json'));
  fixture.pressureReads = () => fixture.requests.filter(request => request.url.endsWith('/pressure_msl-000.json.gz'));
  fixture.rangeReads = () => fixture.requests.filter(request => request.url.startsWith(SOURCE));
  return fixture;
}

function assertBaseFields(payload) {
  assert.deepEqual(payload.members, members);
  for (const field of baseVariables) assert.equal(payload.values[field].length, 18, field);
  assert.ok(Math.abs(payload.values.temperature_850hPa[0]) < .0001);
  assert.ok(Math.abs(payload.values.temperature_500hPa[17] + 3) < .0001);
  assert.ok(payload.values.precipitation.every(value => value === null), 'Analysis-time precipitation stays missing');
  assert.ok(payload.values.snowfall.every(value => value === null), 'Analysis-time snowfall stays missing');
}
function assertMissingPressure(payload) {
  assertBaseFields(payload);
  assert.deepEqual(payload.missingVariables, ['pressure_msl']);
  assert.deepEqual(payload.values.pressure_msl, Array(18).fill(null));
}
function assertPressure(payload) {
  assertBaseFields(payload);
  assert.deepEqual(payload.missingVariables, []);
  assert.equal(payload.units.pressure_msl, 'hPa');
  assert.deepEqual(payload.values.pressure_msl, members.map((_, i) => 1000 + i));
}

test('legacy endpoint responses retain four fields and revalidate a same-run pressure upgrade', async t => {
  const fixture = await endpoint(t, {legacy: true});
  const legacy = await fixture.get();
  assert.equal(legacy.status, 200); assert.equal(legacy.headers.get('Cache-Control'), 'no-store');
  assertMissingPressure(await legacy.json());
  assert.equal(fixture.cacheWrites.length, 0); assert.equal(fixture.pressureReads().length, 0);
  assert.ok(fixture.requests.some(request => new URL(request.url).searchParams.get('key') === 'eq.' + fixture.key('legacy')));

  fixture.upgrade();
  const upgraded = await fixture.get();
  assert.equal(upgraded.status, 200); assert.equal(upgraded.headers.get('Cache-Control'), 'public, max-age=21600');
  assertPressure(await upgraded.json());
  assert.equal(fixture.manifestReads().length, 2, 'Legacy manifest cannot hide pressure added to the same run');
  assert.ok(fixture.manifestReads().every(request => request.cache === 'no-cache'));
  assert.equal(fixture.cacheWrites.length, 1); assert.equal(fixture.cacheWrites[0].key, fixture.key('mslp'));

  const ranges = fixture.rangeReads().length;
  const cached = await fixture.get(), payload = await cached.json();
  assert.equal(payload.cached, true); assertPressure(payload);
  assert.equal(fixture.rangeReads().length, ranges, 'Complete persistent result avoids native source downloads');
  assert.equal(fixture.cacheWrites.length, 1);
});

test('a temporary pressure index failure preserves other fields without caching and recovers on retry', async t => {
  const fixture = await endpoint(t);
  fixture.pressureUnavailable = true;
  const partial = await fixture.get();
  assert.equal(partial.status, 200); assert.equal(partial.headers.get('Cache-Control'), 'no-store');
  assertMissingPressure(await partial.json()); assert.equal(fixture.cacheWrites.length, 0);

  fixture.pressureUnavailable = false;
  const recovered = await fixture.get();
  assert.equal(recovered.status, 200); assert.equal(recovered.headers.get('Cache-Control'), 'public, max-age=21600');
  assertPressure(await recovered.json());
  assert.equal(fixture.pressureReads().length, 2, 'Failed pressure index does not poison the warm endpoint cache');
  assert.equal(fixture.cacheWrites.length, 1); assert.equal(fixture.cacheWrites[0].key, fixture.key('mslp'));
});

test('an incomplete persistent payload is replaced by a verified pressure result', async t => {
  const fixture = await endpoint(t);
  fixture.rows.set(fixture.key('mslp'), {schema: 1, units: {pressure_msl: 'Pa'}, values: {pressure_msl: Array(18).fill(100000)}});
  const response = await fixture.get(), payload = await response.json();
  assert.equal(response.status, 200); assert.notEqual(payload.cached, true); assertPressure(payload);
  assert.equal(fixture.cacheWrites.length, 1);
  assert.equal(fixture.rows.get(fixture.key('mslp')).units.pressure_msl, 'hPa');
});
