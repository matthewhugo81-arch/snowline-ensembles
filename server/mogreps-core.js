// Runtime-neutral decoder used by the hosted endpoint and independent tests.
export const SOURCE = 'https://met-office-global-ensemble-model-data.s3.eu-west-2.amazonaws.com/';
export const GRID = {latitude: [-89.90625, .1875, 960], longitude: [-179.859375, .28125, 1280]};
export const hasPressure = manifest => manifest.variables?.includes('pressure_msl') === true;
// Capability is part of the key: an old four-field index can be upgraded for
// the same run without inheriting a cached response that has no pressure.
export function stepCacheKey(manifest, point, lead) {
  return `v2:${hasPressure(manifest) ? 'mslp' : 'legacy'}:${manifest.runId}:${point.y}:${point.x}:${lead}`;
}
export function completeStep(step) {
  return step.schema === 1 && step.units?.pressure_msl === 'hPa' && !step.missingVariables?.length && Array.isArray(step.values?.pressure_msl) && step.values.pressure_msl.length === 18 && step.values.pressure_msl.some(Number.isFinite) && step.values.pressure_msl.every(v => v === null || typeof v === 'number' && Number.isFinite(v));
}
export function gridPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw Error('Invalid coordinates');
  const y = Math.max(0, Math.min(959, Math.round((lat - GRID.latitude[0]) / GRID.latitude[1])));
  const x = ((Math.round((lon - GRID.longitude[0]) / GRID.longitude[1]) % 1280) + 1280) % 1280;
  return {y, x, latitude: GRID.latitude[0] + y * GRID.latitude[1], longitude: GRID.longitude[0] + x * GRID.longitude[1]};
}
export async function pool(items, concurrency, task) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(items.length, concurrency)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await task(items[i], i); }
  }));
  return results;
}
export async function inflate(bytes, format = 'deflate') {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function jsonIndex(url, fetcher = fetch) {
  const r = await fetcher(url);
  if (!r.ok) throw Error(`Forecast index unavailable (${r.status})`);
  if (url.endsWith('.gz')) return JSON.parse(new TextDecoder().decode(await inflate(new Uint8Array(await r.arrayBuffer()), 'gzip')));
  return r.json();
}
export function accumulationLeads(lead) { return lead === 0 ? [] : lead <= 132 ? [lead - 2, lead - 1, lead] : [lead]; }

export async function extractFile(index, point, fetcher = fetch) {
  if (index.schema !== 1 || !index.key.startsWith('global-ensemble/') || index.members.length !== 18) throw Error('Unsupported source index');
  const chunks = new Map();
  const output = new Map();
  function register(dataset, coords, label) {
    const chunkKey = coords.map((n, i) => Math.floor(n / dataset.chunkShape[i])).join(',');
    const entry = dataset.chunks[chunkKey];
    if (!entry) throw Error('Missing source chunk index');
    const id = entry[0];
    if (!chunks.has(id)) chunks.set(id, {dataset, entry, points: []});
    let position = 0;
    coords.forEach((n, i) => { position = position * dataset.chunkShape[i] + n % dataset.chunkShape[i]; });
    chunks.get(id).points.push({position, label});
  }
  for (let m = 0; m < 18; m++) {
    if (index.kind === 'temperature') {
      for (let p = 0; p < 2; p++) {
        const coords = [m, index.levels[p], point.y, point.x];
        register(index.data, coords, `t:${p}:${m}`);
        register(index.flag, coords, `f:${p}:${m}`);
      }
    } else register(index.data, [m, point.y, point.x], `v:${m}`);
  }
  await pool([...chunks.values()], 8, async ({dataset, entry, points}) => {
    const [offset, size, mask] = entry;
    if (!Number.isSafeInteger(offset) || size < 1 || offset + size > index.size) throw Error('Invalid source range');
    const r = await fetcher(SOURCE + index.key, {headers: {Range: `bytes=${offset}-${offset + size - 1}`, 'If-Match': index.etag}});
    if (r.status !== 206) { await r.body?.cancel(); throw Error(`Met Office range request failed (${r.status})`); }
    let bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length !== size) throw Error('Truncated source range');
    let shuffled = false;
    for (let i = dataset.filters.length - 1; i >= 0; i--) {
      if (mask & (1 << i)) continue;
      if (dataset.filters[i].id === 1) bytes = await inflate(bytes);
      else if (dataset.filters[i].id === 2) shuffled = true;
      else throw Error('Unsupported compression');
    }
    const itemSize = dataset.dtype === '<f4' ? 4 : dataset.dtype === '|i1' ? 1 : 0;
    const count = dataset.chunkShape.reduce((a, b) => a * b, 1);
    if (!itemSize || bytes.length !== count * itemSize) throw Error('Unexpected decoded source size');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const scratch = new DataView(new ArrayBuffer(4));
    for (const {position, label} of points) {
      let value;
      if (itemSize === 1) value = view.getInt8(position);
      else if (!shuffled) value = view.getFloat32(position * 4, true);
      else { for (let b = 0; b < 4; b++) scratch.setUint8(b, bytes[b * count + position]); value = scratch.getFloat32(0, true); }
      output.set(label, Number.isFinite(value) && value !== dataset.fillValue && Math.abs(value) < 1e30 ? value : null);
    }
  });
  if (index.kind === 'temperature') return [0, 1].map(p => index.members.map((_, m) => output.get(`f:${p}:${m}`) === 0 && output.get(`t:${p}:${m}`) !== null ? output.get(`t:${p}:${m}`) - 273.15 : null));
  return index.members.map((_, m) => output.get(`v:${m}`));
}

export async function extractStep(manifest, point, lead, loadIndex, fetcher = fetch) {
  if (!manifest.leads.includes(lead)) throw Error('Invalid forecast time');
  const reference = manifest.run;
  const check = (idx, kind, h) => {
    if (idx.run !== reference || idx.time !== reference + h * 3600 || idx.kind !== kind || JSON.stringify(idx.members) !== JSON.stringify(manifest.members)) throw Error('Forecast run or member mismatch');
    return idx;
  };
  const tempIndex = check(await loadIndex('temperature', lead), 'temperature', lead);
  const [t850, t500] = await extractFile(tempIndex, point, fetcher);
  const values = {temperature_850hPa: t850, temperature_500hPa: t500};
  // Process one accumulation file at a time to keep peak memory bounded.
  for (const kind of ['precipitation', 'snowfall']) {
    let total = lead ? new Array(18).fill(0) : new Array(18).fill(null);
    for (const h of accumulationLeads(lead)) {
      const index = check(await loadIndex(kind, h), kind, h);
      if (index.intervalHours !== (h <= 132 ? 1 : 3)) throw Error('Incorrect accumulation bounds');
      const values = await extractFile(index, point, fetcher);
      total = total.map((sum, m) => sum !== null && values[m] !== null && values[m] >= 0 ? sum + values[m] : null);
    }
    // Snow-depth equivalent uses Open-Meteo's 7:1 snow-to-water ratio.
    values[kind] = total.map(v => v === null ? null : v * (kind === 'precipitation' ? 1000 : 700));
  }
  values.pressure_msl = new Array(18).fill(null);
  const missingVariables = [];
  if (hasPressure(manifest)) {
    try {
      const index = check(await loadIndex('pressure_msl', lead), 'pressure_msl', lead);
      if (index.units !== 'Pa' || !['latitude', 'longitude'].every(axis => Array.isArray(index.grid?.[axis]) && index.grid[axis].length === 3 && index.grid[axis].every((v, i) => v === (manifest.grid ?? GRID)[axis]?.[i])) || JSON.stringify(index.data?.shape) !== JSON.stringify([18, 960, 1280])) throw Error('Mean sea-level pressure units or grid mismatch');
      const pressure = await extractFile(index, point, fetcher);
      values.pressure_msl = pressure.map(v => v === null ? null : v / 100);
      if (!values.pressure_msl.some(Number.isFinite)) missingVariables.push('pressure_msl');
    } catch {
      // Keep the other verified fields available if pressure is temporarily
      // missing. This response is not cached, so Refresh can retry it.
      missingVariables.push('pressure_msl');
    }
  } else missingVariables.push('pressure_msl');
  return {schema: 1, run: reference, time: reference + lead * 3600, intervalHours: 3,
    members: manifest.members, latitude: point.latitude, longitude: point.longitude,
    units: {pressure_msl: 'hPa'}, missingVariables, values};
}
