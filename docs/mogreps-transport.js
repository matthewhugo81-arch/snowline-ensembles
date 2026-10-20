// Kept locally in both Snowline applications; no cross-origin module dependency.
const LOAD_TIMEOUT = 180000;
const REQUEST_TIMEOUT = 120000;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const FAILURE_LIMIT = 8;
const PRESSURE_RETRY_LIMIT = 8;
const serviceCooldown = {until:0};

export function retryAfter(response, now = Date.now()) {
  const value = response.headers?.get('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  const time = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(time) ? Math.max(now, time) : 0;
}

export function pause(ms, signal) {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, {once:true});
  });
}

// Injected timing/fetch functions let offline tests exercise outages without
// contacting the provider or waiting through real production timeouts.
export async function loadMogrepsForecast(config, {
  fetcher = (...args) => globalThis.fetch(...args),
  now = () => Date.now(), sleep = pause, random = Math.random,
  loadTimeout = LOAD_TIMEOUT, requestTimeout = REQUEST_TIMEOUT, cooldown = serviceCooldown
} = {}) {
  const {manifestURL, endpoint, headers, location, signal, onProgress, createRaw, applyStep, hasPressure} = config;
  signal?.throwIfAborted();
  const deadline = new AbortController(), stopped = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Met Office loading timed out. Received forecasts have been kept; use Refresh to retry.', 'TimeoutError')), loadTimeout);
  const combined = AbortSignal.any([deadline.signal, stopped.signal, ...(signal ? [signal] : [])]);
  let raw, manifest, next = 0, finished = 0, lastRender = -Infinity;
  let failures = 0, pressureRetries = 0, notBefore = cooldown.until;
  const received = new Set();
  const stop = error => { if (!stopped.signal.aborted) stopped.abort(error); };
  const emit = force => {
    if (!signal?.aborted && raw?.completed && (force || now() - lastRender > 700)) {
      lastRender = now(); onProgress(raw, finished, raw.total);
    }
  };
  async function json(url, options = {}) {
    const requestSignal = AbortSignal.any([combined, AbortSignal.timeout(requestTimeout)]);
    const response = await fetcher(url, {...options, signal:requestSignal});
    if (!response.ok) {
      const retryAt = retryAfter(response, now());
      await response.body?.cancel();
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw Object.assign(Error(response.status === 410 ? 'The Met Office run has expired. Use Refresh to select a newer run.' :
        response.status === 429 ? 'Met Office requests are temporarily limited. Retry after the service cooldown.' :
        `Met Office data service returned ${response.status}. Use Refresh to retry.`),
        {status:response.status, retryable, retryAt});
    }
    try { return await response.json(); }
    catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      throw Object.assign(Error('Invalid Met Office forecast response; no values have been substituted.'), {retryable:false});
    }
  }
  async function worker() {
    while (next < manifest.leads.length && !combined.aborted) {
      const lead = manifest.leads[next++];
      let delay = 0;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !combined.aborted; attempt++) {
        try {
          await sleep(delay, combined);
          while (notBefore > now()) await sleep(notBefore - now(), combined);
          combined.throwIfAborted();
          const query = new URLSearchParams({lat:location.lat, lon:location.lon, run:manifest.runId, lead, v:2});
          const step = await json(endpoint + '?' + query, {headers});
          combined.throwIfAborted();
          try { applyStep(raw, manifest, step, lead); }
          catch (error) { throw Object.assign(error, {retryable:false}); }
          failures = 0;
          if (!received.has(lead)) { received.add(lead); raw.completed = received.size; }
          if (!hasPressure(manifest) || !raw.missingVariableSteps.pressure_msl.includes(lead)) break;
          // Preserve all four original fields even when a pressure upgrade is
          // incomplete; cap optional retries across the entire forecast.
          if (pressureRetries >= PRESSURE_RETRY_LIMIT || attempt === MAX_ATTEMPTS - 1) break;
          pressureRetries++;
          delay = 500 * 2 ** attempt + Math.floor(random() * 250);
        } catch (error) {
          if (combined.aborted) break;
          if (error.retryable === false) { stop(error); break; }
          failures++;
          notBefore = Math.max(notBefore, error.retryAt || 0);
          cooldown.until = Math.max(cooldown.until, notBefore);
          if (failures >= FAILURE_LIMIT) {
            stop(Object.assign(Error('Met Office requests repeatedly failed. Received forecasts have been kept; use Refresh to retry.'),
              {status:error.status, retryAt:notBefore}));
            break;
          }
          if (attempt === MAX_ATTEMPTS - 1) break;
          delay = 500 * 2 ** attempt + Math.floor(random() * 250);
        }
      }
      finished++; emit(false);
    }
  }
  try {
    manifest = await json(manifestURL, {cache:'no-cache'});
    raw = createRaw(manifest);
    if (now() / 1000 - manifest.run > 72 * 3600) throw Error('The last Met Office run has expired. Please retry later.');
    await Promise.all(Array.from({length:CONCURRENCY}, worker));
    signal?.throwIfAborted();
    const reason = deadline.signal.aborted ? deadline.signal.reason : stopped.signal.reason;
    raw.missingSteps = manifest.leads.filter(lead => !received.has(lead));
    raw.complete = raw.missingSteps.length === 0 && raw.missingVariables.length === 0;
    if (reason) {
      raw.complete = false;
      raw.loadError = reason.message;
      if (notBefore > now()) raw.retryAt = notBefore;
    }
    if (!raw.completed) {
      const error = reason || Error('The Met Office forecast could not be loaded. Use Refresh to retry.');
      if (notBefore > now()) error.retryAt = notBefore;
      throw error;
    }
    emit(true);
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

