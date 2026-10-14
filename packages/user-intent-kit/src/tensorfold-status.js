// SPDX-License-Identifier: AGPL-3.0-only
//
// tensorfold-status.js - what a TensorFold server is doing right now, read
// with GETs only and folded into an object small enough to ride on a device
// heartbeat.
//
// THREE GETS AND NOTHING ELSE. /health (always open), /metrics (Prometheus
// text, may need a key) and /v1/slide/graph (the Living Weights fact graph,
// 404 on a server started without --slide). Never a completion, never a chat
// request, never /health?reset_peak=1. A generated token during a Living
// Weights lesson is a lesson the heartbeat interfered with, and a status
// reader that can change what it reads is not a status reader.
//
// NEVER THROWS. Every failure becomes a field: an unreachable server is
// `reachable: false` with the reason, a 401 on /metrics is
// `metrics: "auth_required"`, a 404 graph is `living_weights.available:
// false`. A value we could not read is null, never 0: an idle server and an
// unreadable counter must not look the same on a dashboard.
//
// KEYS. A key is sent only to an entry the registry marks
// `"engine": "tensorfold"`, only when that same entry names its own key
// (`keyFile`, a path), and only on the two gated routes. The file is read in
// the engine's own key-file format and refused, as the engine refuses it,
// when other users can read it. The fleet-wide LLM_API_KEY / LLM_API_KEY_FILE
// fallbacks are NOT used here: those are some other server's credential as
// far as this reader knows. Auto-detected entries are probed without any key
// at all. A discovered engine's command line is never a source of keys: a
// `--api-key-file` on it is not read (any process of this user can name any
// file there), a `--api-key` value is not kept, and a key held only in a
// process's memory or environment (TensorFold Studio's) is not taken. Those
// engines report `metrics: "auth_required"` with the reason. Nothing here
// logs or returns a token; Prometheus `key="..."` labels (the native server
// labels its request counter by API key label) are never copied into the
// output either.
//
// DISCOVERY. Engines running on this machine are found from the process table
// (tensorfold-discovery.js), each at a loopback socket its own pid listens
// on, merged with the registry by port, and published with
// `source: "discovered"`. Same three GETs, same rules.
//
// FACT TEXT STAYS ON THE BOX. The slide graph carries what the model was
// taught, which can be private. Only counts leave this module.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { readRegistryFile } from './model-capacity.js';
import { discoverTensorFoldEngines } from './tensorfold-discovery.js';

export const TENSORFOLD_ENGINE = 'tensorfold';
export const STATUS_SCHEMA = 1;
export const DEFAULT_STATUS_TIMEOUT_MS = 3000;
/** A port that answered "not TensorFold" is asked again after this long. */
export const DETECT_RECHECK_MS = 10 * 60 * 1000;
export const SCOPES = Object.freeze(['local', 'all']);
export const METRICS_STATES = Object.freeze({
  OK: 'ok',
  AUTH_REQUIRED: 'auth_required',
  AUTH_REJECTED: 'auth_rejected',
  UNAVAILABLE: 'unavailable',
});

const MAX_BODY_BYTES = 1 << 20;
const MAX_GRAPH_BYTES = 8 << 20;
const BYTES_PER_GB = 1e9; // base 10, matching mem_total_gb in host-telemetry.js
const MIN_RATE_WINDOW_MS = 1000;

// --- small parsers ----------------------------------------------------------

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, places) => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);
const count = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const gb = bytes => (bytes === null || bytes < 0 ? null : round(bytes / BYTES_PER_GB, 1));

/**
 * A short human label from /health (`version`, `backend`, `device`). The
 * fields do not exist yet on 0.6.x servers, so absent is the normal case and
 * reads as null. A `device` that turns out to be an object with a `name` is
 * accepted too, because the shape is not settled upstream.
 */
export function healthLabel(value) {
  let v = value;
  if (isObject(v) && typeof v.name === 'string') v = v.name;
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, 120) : null;
}

function unescapeLabel(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
}

/**
 * Prometheus text exposition (0.0.4) into [{name, labels, value}]. Comment
 * and malformed lines are skipped rather than fatal: one odd line from a
 * newer server must not blank every other number on the card.
 */
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/.exec(line);
    if (!m) continue;
    let value;
    if (m[3] === '+Inf') value = Infinity;
    else if (m[3] === '-Inf') value = -Infinity;
    else value = Number(m[3]);
    if (Number.isNaN(value)) continue;
    const labels = {};
    for (const lm of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
      labels[lm[1]] = unescapeLabel(lm[2]);
    }
    out.push({ name: m[1], labels, value });
  }
  return out;
}

/**
 * `histogram_quantile` over cumulative buckets [{le, count}], with the same
 * linear interpolation Prometheus uses. It is an ESTIMATE bounded by the
 * bucket edges, and null when nothing was observed.
 */
export function histogramQuantile(q, buckets) {
  const sorted = (buckets || [])
    .filter(b => Number.isFinite(b.count) && (Number.isFinite(b.le) || b.le === Infinity))
    .sort((a, b) => a.le - b.le);
  if (!sorted.length) return null;
  const total = sorted[sorted.length - 1].count;
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      if (b.le === Infinity) return sorted.length > 1 ? prevLe : null;
      if (b.count === prevCount) return b.le;
      return prevLe + (b.le - prevLe) * ((rank - prevCount) / (b.count - prevCount));
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return null;
}

/** Does this /health body have TensorFold's shape? Used only to auto-detect. */
export function looksLikeTensorFoldHealth(body) {
  return isObject(body)
    && typeof body.status === 'string'
    && Array.isArray(body.model_ids)
    && Number.isFinite(body.max_batch_size)
    && typeof body.warming === 'boolean';
}

/** The /health fields this module uses. Missing fields are null. */
export function summarizeHealth(body) {
  const h = isObject(body) ? body : {};
  const mem = isObject(h.memory) ? h.memory : {};
  return {
    status: typeof h.status === 'string' ? h.status.slice(0, 40) : null,
    model: healthLabel(h.model),
    warming: typeof h.warming === 'boolean' ? h.warming : null,
    version: healthLabel(h.version),
    backend: healthLabel(h.backend),
    device: healthLabel(h.device),
    memory: { active: finite(mem.active), peak: finite(mem.peak), budget: finite(mem.budget), footprint: finite(mem.footprint) },
    // The native server's own live decode rate (`live` block in /health).
    decodeTokS: finite(isObject(h.live) ? h.live.decode_tokens_per_second : undefined),
  };
}

/** The `tensorfold:` series this module uses. Missing series are null. */
export function summarizeMetrics(series) {
  const tf = (series || []).filter(s => s.name.startsWith('tensorfold:'));
  const one = name => {
    const s = tf.find(x => x.name === `tensorfold:${name}`);
    return s ? s.value : null;
  };
  const kv = tf.filter(s => s.name === 'tensorfold:kv_cache_usage_ratio').map(s => s.value).filter(Number.isFinite);
  const buckets = tf
    .filter(s => s.name === 'tensorfold:time_to_first_token_seconds_bucket' && s.labels.le !== undefined)
    .map(s => ({ le: s.labels.le === '+Inf' ? Infinity : Number(s.labels.le), count: s.value }));
  const drafted = count(one('mtp_drafted_total'));
  const accepted = count(one('mtp_accepted_total'));
  return {
    detected: tf.length > 0,
    requests: { running: count(one('requests_running')), waiting: count(one('requests_waiting')) },
    tokens: { prompt_total: count(one('prompt_tokens_total')), generation_total: count(one('generation_tokens_total')) },
    draft: {
      drafted,
      accepted,
      acceptance: drafted > 0 && accepted !== null ? round(accepted / drafted, 3) : null,
    },
    ttftP50: round(histogramQuantile(0.5, buckets), 3),
    kvCacheUsage: kv.length ? round(Math.max(...kv), 3) : null,
    // The native build reports engine memory here (CUDA), and /health hides
    // its memory block when keys are on, so this is the fallback for `used`.
    deviceMemory: finite(one('device_memory_bytes')),
    deviceMemoryPeak: finite(one('device_memory_peak_bytes')),
    // macOS: the process's physical footprint including Metal buffers. Its
    // own field, never folded into `used`: it measures something else.
    processFootprint: finite(one('process_footprint_bytes')),
  };
}

/** Counts from /v1/slide/graph. Never the fact text. */
export function summarizeSlideGraph(body) {
  if (!isObject(body) || !Array.isArray(body.facts)) {
    return { available: null, facts: null, learning: null, learned: null };
  }
  const states = body.facts.map(f => (isObject(f) ? f.state : null));
  return {
    available: true,
    facts: body.facts.length,
    learning: states.filter(s => s === 'learning').length,
    learned: states.filter(s => s === 'learned').length,
  };
}

// --- HTTP -------------------------------------------------------------------

function errorCodes(err) {
  const all = [];
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e.code) all.push(String(e.code));
    if (e.name) all.push(String(e.name));
  }
  return all;
}

function describeFetchError(err, timeoutMs) {
  const all = errorCodes(err);
  if (all.includes('TimeoutError') || all.includes('AbortError')) return `no response within ${timeoutMs} ms`;
  const code = all.find(c => /^E[A-Z]+$/.test(c) || c.startsWith('UND_ERR'));
  if (code) return `connect failed (${code})`;
  return `request failed (${all.find(c => c !== 'TypeError' && c !== 'Error') || 'fetch error'})`;
}

async function readCapped(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
}

/**
 * One GET. Resolves to {status, text, error}; never rejects. `status` is null
 * when no HTTP answer came back at all. Never follows a redirect: a 302 is an
 * unknown destination and following it would hand the key to it.
 */
async function get(url, { fetchImpl, timeoutMs, token = null, maxBytes = MAX_BODY_BYTES, accept = 'application/json' }) {
  // `connection: close`: a status read every half minute has no use for a
  // kept-alive socket, and the Python server parks a thread on every idle
  // one. Measured 2026-10-14: without it, a CLI run that exited with the
  // socket still open left a ConnectionResetError traceback in the 0.6.0
  // server's log.
  const headers = { accept, connection: 'close' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { status: null, text: null, error: describeFetchError(err, timeoutMs) };
  }
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* nothing to drain */ }
    return { status: response.status, text: null, error: `HTTP ${response.status}` };
  }
  try {
    return { status: response.status, text: await readCapped(response, maxBytes), error: null };
  } catch (err) {
    return { status: response.status, text: null, error: err.message === 'response too large' ? 'response too large' : describeFetchError(err, timeoutMs) };
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function baseUrlOf(target) {
  const host = String(target.host);
  const bracket = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracket}:${target.port}`;
}

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

async function readCore(base, io, token) {
  const [health, metrics] = await Promise.all([
    get(`${base}/health`, io),
    get(`${base}/metrics`, { ...io, token, accept: 'text/plain' }),
  ]);
  return { health, metrics };
}

function readSlide(base, io, token) {
  return get(`${base}/v1/slide/graph`, { ...io, token, maxBytes: MAX_GRAPH_BYTES });
}

// --- the status object --------------------------------------------------------

/**
 * Fold the three answers into the published shape. `previous` is the last
 * sample for this server ({generation_total, at}) or null; the returned
 * `sample` is what to keep for the next call.
 */
export function buildStatus(target, { health, metrics, slide }, {
  tokenSent = false, previous = null, clockMs, checkedAt, keyNote = null,
} = {}) {
  const healthBody = health?.status === 200 ? parseJson(health.text) : null;
  const h = summarizeHealth(healthBody);
  const series = metrics?.status === 200 ? parsePrometheus(metrics.text) : [];
  const m = summarizeMetrics(series);

  let metricsState;
  if (metrics?.status === 401 || metrics?.status === 403) {
    metricsState = tokenSent ? METRICS_STATES.AUTH_REJECTED : METRICS_STATES.AUTH_REQUIRED;
  } else if (metrics?.status === 200 && m.detected) {
    metricsState = METRICS_STATES.OK;
  } else {
    metricsState = METRICS_STATES.UNAVAILABLE;
  }
  const metricsOk = metricsState === METRICS_STATES.OK;

  const reachable = health?.status != null || metrics?.status != null || slide?.status != null;
  const reasons = [];
  if (!reachable) {
    reasons.push(health?.error || metrics?.error || 'no answer');
  } else {
    if (health?.status !== 200) reasons.push(`/health ${health?.error || 'no answer'}`);
    else if (!healthBody) reasons.push('/health was not JSON');
    else if (h.status && h.status !== 'ok') reasons.push(`/health status "${h.status}"`);
    if (metricsState === METRICS_STATES.AUTH_REQUIRED) reasons.push('metrics: auth required');
    else if (metricsState === METRICS_STATES.AUTH_REJECTED) reasons.push('metrics: key refused');
    else if (!metricsOk) {
      const readable = metrics?.status === 200 && typeof metrics.text === 'string';
      reasons.push(readable ? 'metrics: no tensorfold series' : `metrics: ${metrics?.error || 'no answer'}`);
    }
    if (keyNote && !metricsOk) reasons.push(keyNote);
  }

  let living = { available: null, facts: null, learning: null, learned: null };
  if (slide?.status === 200) living = summarizeSlideGraph(parseJson(slide.text));
  else if (slide?.status === 404) living = { available: false, facts: null, learning: null, learned: null };

  const generation = metricsOk ? m.tokens.generation_total : null;
  let tokS = null;
  let windowS = null;
  if (previous && generation !== null && Number.isFinite(previous.generation_total)
      && generation >= previous.generation_total && clockMs - previous.at >= MIN_RATE_WINDOW_MS) {
    windowS = round((clockMs - previous.at) / 1000, 1);
    tokS = round((generation - previous.generation_total) / ((clockMs - previous.at) / 1000), 1);
  }
  // A counter that went DOWN means the server restarted: no rate this time,
  // and the new value is the baseline for the next one.
  const sample = generation !== null ? { generation_total: generation, at: clockMs } : previous;

  // /health names what the server serves; a keyed server's /health says only
  // "ok", and then the command line the engine was started with is the next
  // best evidence, labelled as such.
  const argsModel = typeof target.argsModel === 'string' && target.argsModel ? target.argsModel : null;
  const status = {
    id: target.id ?? null,
    host: target.host,
    port: target.port,
    local: isLoopbackHost(target.host),
    source: target.source ?? 'registry',
    name: target.name ?? null,
    app: target.app ?? null,
    reachable,
    reason: reasons.length ? reasons.join('; ').slice(0, 300) : null,
    model: h.model ?? argsModel,
    model_source: h.model ? 'health' : (argsModel ? 'args' : null),
    warming: h.warming,
    version: h.version,
    backend: h.backend,
    device: h.device,
    memory: {
      used_gb: gb(h.memory.active ?? (metricsOk ? m.deviceMemory : null)),
      peak_gb: gb(h.memory.peak ?? (metricsOk ? m.deviceMemoryPeak : null)),
      budget_gb: gb(h.memory.budget),
      footprint_gb: gb(h.memory.footprint ?? (metricsOk ? m.processFootprint : null)),
    },
    requests: metricsOk ? m.requests : { running: null, waiting: null },
    tokens: metricsOk ? m.tokens : { prompt_total: null, generation_total: null },
    tok_s: tokS,
    tok_s_window_s: windowS,
    decode_tok_s: h.decodeTokS === null ? null : round(h.decodeTokS, 1),
    draft: metricsOk ? m.draft : { drafted: null, accepted: null, acceptance: null },
    ttft_p50_s: metricsOk ? m.ttftP50 : null,
    kv_cache_usage: metricsOk ? m.kvCacheUsage : null,
    living_weights: living,
    metrics: metricsState,
    checked_at: checkedAt,
  };
  return { status, sample, detected: m.detected || looksLikeTensorFoldHealth(healthBody) };
}

/**
 * Probe one server that is known to be TensorFold: all three GETs in
 * parallel. `token` is sent on /metrics and /v1/slide/graph only, never on
 * /health (open by design; the native server answers it the same with or
 * without a key).
 */
export async function probeTensorFold(target, {
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  now = () => Date.now(),
  clock = () => performance.now(),
  token = null,
  keyNote = null,
  previous = null,
} = {}) {
  const base = baseUrlOf(target);
  const io = { fetchImpl, timeoutMs };
  const [core, slide] = await Promise.all([readCore(base, io, token), readSlide(base, io, token)]);
  return buildStatus(target, { ...core, slide }, {
    tokenSent: Boolean(token), previous, clockMs: clock(), checkedAt: new Date(now()).toISOString(), keyNote,
  });
}

// --- the registry -----------------------------------------------------------

function expandHome(path) {
  const s = String(path);
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

const MAX_KEY_FILE_BYTES = 1 << 20;

/**
 * The first key in a TensorFold key file, read the way the engine reads it
 * (zig/src/server/auth.zig): one key per line, `label: key` or a bare key,
 * blank lines and `#` comments skipped. Refused, as the engine refuses it,
 * when it is not a regular file or other users can read it (mode & 044).
 *
 * Returns {token, note}. `note` says why no key came out, names the path and
 * never the contents.
 */
export async function readEngineKeyFile(rawPath, { readFileImpl = fsReadFile, statImpl = fsStat } = {}) {
  const path = expandHome(rawPath);
  let info;
  try {
    info = await statImpl(path);
  } catch (err) {
    return { token: null, note: `cannot read key file ${path} (${err.code || 'error'})` };
  }
  if (!info.isFile()) return { token: null, note: `key file ${path} is not a regular file` };
  if (info.mode & 0o044) return { token: null, note: `key file ${path} is readable by other users; chmod 600 it (the engine refuses it too)` };
  if (info.size > MAX_KEY_FILE_BYTES) return { token: null, note: `key file ${path} exceeds 1 MiB` };
  let text;
  try {
    text = String(await readFileImpl(path, 'utf8'));
  } catch (err) {
    return { token: null, note: `cannot read key file ${path} (${err.code || 'error'})` };
  }
  for (const raw of text.split(/[\r\n]/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const key = (colon >= 0 ? line.slice(colon + 1) : line).trim();
    if (key && !/\s/.test(key)) return { token: key, note: null };
  }
  return { token: null, note: `key file ${path} holds no key` };
}

/**
 * The key for one server, from the registry and nothing wider: the keyFile
 * of an entry marked TensorFold (auth "bearer"). A discovered engine's
 * command line only explains why there is none. Returns {token, note};
 * `note` never contains a key.
 */
async function serverToken(entry, engine, readKeyFile) {
  if (entry?.engine === TENSORFOLD_ENGINE && entry.auth === 'bearer') {
    if (entry.keyFile) return readKeyFile(entry.keyFile);
    return { token: null, note: 'the entry names no keyFile' };
  }
  if (!engine) return { token: null, note: null };
  if (engine.app) return { token: null, note: `${engine.app} keeps this engine's key in memory only, so its metrics stay locked` };
  if (engine.apiKeyFile) {
    return {
      token: null,
      note: `the engine was started with --api-key-file, which is not read from a command line; add a models.json entry for port ${engine.port} with "engine": "tensorfold" and that keyFile`,
    };
  }
  if (engine.keyOnArgv) return { token: null, note: 'the key was given on the engine\'s command line; it is not read from there' };
  return { token: null, note: 'the engine was started without a key file' };
}

/** What a discovered engine adds to the target it is probed as. */
function engineTarget(engine) {
  return engine ? { name: engine.name ?? null, app: engine.app ?? null, argsModel: engine.model ?? null } : {};
}

/**
 * Status for every TensorFold server in a loaded registry, plus every engine
 * discovery found running on this machine.
 *
 *   engine "tensorfold"   always reported, reachable or not.
 *   engine absent         auto-detected: reported when /metrics carries
 *                         `tensorfold:` series or /health has TensorFold's
 *                         shape. A port that answered as something else is
 *                         asked again after DETECT_RECHECK_MS; one that was
 *                         TensorFold earlier in this process and stops
 *                         answering stays on the list as unreachable.
 *   any other engine      skipped, no request sent.
 *   discovered            an engine from the process table, at a loopback
 *                         socket its pid was seen listening on. Merged with
 *                         a loopback registry entry on the same port (the
 *                         entry keeps its id, and its keyFile when it is
 *                         marked TensorFold; an entry without an engine
 *                         needs no auto-detection then), otherwise reported
 *                         on its own as `source: "discovered"`, without a
 *                         key. One card per port. A non-loopback address in
 *                         `discovered` is ignored.
 *
 * `samples` and `detected` are Maps the caller keeps between calls (the
 * heartbeat does; a one-shot CLI passes fresh ones). `readKeyFile` is for
 * tests. Never throws.
 */
export async function collectTensorFoldStatus(entries, {
  scope = 'all',
  discovered = null,
  readKeyFile = readEngineKeyFile,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  now = () => Date.now(),
  clock = () => performance.now(),
  samples = new Map(),
  detected = new Map(),
} = {}) {
  const io = { fetchImpl, timeoutMs };
  const inScope = (entries || []).filter(e => scope === 'all' || isLoopbackHost(e.host));
  const engines = new Map();
  for (const engine of Array.isArray(discovered) ? discovered : []) {
    // Discovery returns loopback addresses only; anything else is not read.
    if (!Number.isInteger(engine?.port) || !isLoopbackHost(engine.host) || engines.has(engine.port)) continue;
    engines.set(engine.port, engine);
  }
  const claimed = new Set();
  const stamp = () => new Date(now()).toISOString();

  const probeKnown = async (target, key, entry, engine) => {
    const { token, note } = await serverToken(entry, engine, readKeyFile);
    const { status, sample } = await probeTensorFold(target, {
      ...io, now, clock, token, keyNote: note, previous: samples.get(key) ?? null,
    });
    if (sample) samples.set(key, sample);
    return { server: status };
  };

  const fromRegistry = inScope.map(async entry => {
    const key = `${String(entry.host).toLowerCase()}:${entry.port}`;
    const target = { id: entry.id, host: entry.host, port: entry.port };
    const engine = isLoopbackHost(entry.host) ? engines.get(entry.port) : undefined;
    if (engine) claimed.add(engine.port);
    try {
      if (entry.engine && entry.engine !== TENSORFOLD_ENGINE) {
        const also = engine ? ' (a TensorFold process listens on this port)' : '';
        return { skipped: { id: entry.id, reason: `registry says engine "${entry.engine}"${also}` } };
      }
      if (entry.engine === TENSORFOLD_ENGINE) {
        return await probeKnown({ ...target, ...engineTarget(engine), source: 'registry' }, key, entry, engine);
      }
      if (engine) {
        // The process table already says TensorFold: no detection needed.
        detected.set(key, { tensorfold: true, at: now() });
        return await probeKnown({ ...target, ...engineTarget(engine), source: 'discovered' }, key, entry, engine);
      }
      const seen = detected.get(key);
      if (seen && seen.tensorfold === false && now() - seen.at < DETECT_RECHECK_MS) {
        return { skipped: { id: entry.id, reason: 'not TensorFold (checked recently)' } };
      }
      const base = baseUrlOf(target);
      const core = await readCore(base, io, null);
      const first = buildStatus(target, core, { clockMs: clock(), checkedAt: stamp() });
      if (!first.status.reachable) {
        if (seen?.tensorfold) return { server: { ...first.status, source: 'detected' } };
        return { skipped: { id: entry.id, reason: `unreachable, engine unknown (${first.status.reason})` } };
      }
      if (!first.detected) {
        detected.set(key, { tensorfold: false, at: now() });
        return { skipped: { id: entry.id, reason: 'not TensorFold (no tensorfold: metrics, /health shape differs)' } };
      }
      detected.set(key, { tensorfold: true, at: now() });
      const slide = await readSlide(base, io, null);
      const { status, sample } = buildStatus({ ...target, source: 'detected' }, { ...core, slide }, {
        previous: samples.get(key) ?? null, clockMs: clock(), checkedAt: stamp(),
      });
      if (sample) samples.set(key, sample);
      return { server: status };
    } catch (err) {
      // Belt and braces: everything above is written not to throw, and a
      // heartbeat that dies on a status read is worse than a missing card.
      return { skipped: { id: entry.id, reason: `status read failed (${err?.name || 'error'})` } };
    }
  });

  // Registry entries claim their ports synchronously above, before any await,
  // so what is left here is the engines no entry names.
  const fromDiscovery = [...engines.values()].filter(e => !claimed.has(e.port)).map(async engine => {
    const key = `${String(engine.host).toLowerCase()}:${engine.port}`;
    const target = {
      id: engine.name || `tensorfold-${engine.port}`, host: engine.host, port: engine.port,
      ...engineTarget(engine), source: 'discovered',
    };
    try {
      return await probeKnown(target, key, null, engine);
    } catch (err) {
      return { skipped: { id: target.id, reason: `status read failed (${err?.name || 'error'})` } };
    }
  });

  const results = await Promise.all([...fromRegistry, ...fromDiscovery]);
  return {
    servers: results.filter(r => r.server).map(r => r.server),
    skipped: results.filter(r => r.skipped).map(r => r.skipped),
  };
}

// --- the heartbeat side -------------------------------------------------------

/**
 * Keeps a cached TensorFold snapshot for the device heartbeat.
 *
 * OFF unless a registry path is given (INTENT_TENSORFOLD_REGISTRY) or
 * discovery is asked for (INTENT_TENSORFOLD_DISCOVER=1). With a registry,
 * discovery of engines running on this machine is on unless
 * INTENT_TENSORFOLD_DISCOVER=0. It runs on its own timer and the heartbeat
 * reads `fields()` synchronously, so a slow or dead server costs a stale
 * card, never a late heartbeat. The registry file is re-read and the process
 * table re-scanned every refresh, so an edit or a new engine applies without
 * a restart.
 *
 * Published as ONE key, `tensorfold`, replaced whole on every beat. The
 * intent server merges a PATCH key by key, so a field this monitor stopped
 * sending would otherwise linger on the card forever.
 */
export class TensorFoldMonitor {
  #registryPath; #entries; #scope; #intervalMs; #timeoutMs; #fetchImpl; #now; #clock; #warn;
  #readRegistry; #discover; #discoverImpl; #timer = null; #inFlight = null; #snapshot = null;
  #samples = new Map(); #detected = new Map(); #lastWarning = -Infinity;

  constructor({
    registryPath = process.env.INTENT_TENSORFOLD_REGISTRY,
    entries,
    scope = process.env.INTENT_TENSORFOLD_SCOPE,
    intervalMs = 30000,
    timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
    fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(),
    clock = () => performance.now(),
    warn = message => console.warn(message),
    readRegistry = readRegistryFile,
    discover = process.env.INTENT_TENSORFOLD_DISCOVER,
    discoverImpl = discoverTensorFoldEngines,
  } = {}) {
    const path = typeof registryPath === 'string' ? registryPath.trim() : '';
    this.#registryPath = path && !['0', 'off', 'false', 'no'].includes(path.toLowerCase()) ? expandHome(path) : null;
    this.#entries = Array.isArray(entries) ? entries : null;
    const wanted = typeof scope === 'string' && scope.trim() ? scope.trim().toLowerCase() : 'local';
    if (!SCOPES.includes(wanted)) throw new Error(`INTENT_TENSORFOLD_SCOPE must be one of ${SCOPES.join(', ')}`);
    this.#scope = wanted;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid tensorfold intervalMs');
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#clock = clock;
    this.#warn = warn;
    this.#readRegistry = readRegistry;
    // true/false as given; a string from the environment; unset means "with
    // a registry, yes". In-memory entries (tests, embedders) never scan
    // unless asked: a test must not read the developer's process table.
    let wantDiscover = null;
    if (typeof discover === 'boolean') wantDiscover = discover;
    else if (typeof discover === 'string' && discover.trim()) {
      const v = discover.trim().toLowerCase();
      if (['1', 'on', 'yes', 'true'].includes(v)) wantDiscover = true;
      else if (['0', 'off', 'no', 'false'].includes(v)) wantDiscover = false;
      else throw new Error('INTENT_TENSORFOLD_DISCOVER must be 1 or 0');
    }
    this.#discover = wantDiscover ?? Boolean(this.#registryPath);
    this.#discoverImpl = discoverImpl;
  }

  get enabled() { return Boolean(this.#registryPath || this.#entries || this.#discover); }

  get scope() { return this.#scope; }

  /** For a log line. A path and a scope, never a key. */
  describe() {
    if (!this.enabled) return 'off (set INTENT_TENSORFOLD_REGISTRY to a models.json, or INTENT_TENSORFOLD_DISCOVER=1, to turn it on)';
    const source = this.#registryPath ?? (this.#entries ? 'in-memory registry' : 'no registry');
    return `${source} (scope ${this.#scope}, every ${Math.round(this.#intervalMs / 1000)}s, GET only, discovery ${this.#discover ? 'on' : 'off'})`;
  }

  /** What the heartbeat publishes: {} when off or before the first read. */
  fields() {
    if (!this.enabled || !this.#snapshot) return {};
    return { tensorfold: structuredClone(this.#snapshot) };
  }

  #warning(reason) {
    const t = this.#now();
    if (t >= this.#lastWarning && t - this.#lastWarning < 300000) return;
    this.#lastWarning = t;
    this.#warn(`uik tensorfold: ${reason}`);
  }

  async #read() {
    const checkedAt = new Date(this.#now()).toISOString();
    let entries = [];
    let error = null;
    if (this.#entries || this.#registryPath) {
      try {
        entries = this.#entries ?? await this.#readRegistry(this.#registryPath);
      } catch (err) {
        const message = String(err?.message || 'unknown error').slice(0, 200);
        this.#warning(`registry unreadable, publishing the error with whatever discovery found: ${message}`);
        // An error is not an empty list: `error` says the registry's part
        // of the list is unknown.
        error = `registry unreadable: ${message}`;
      }
    }
    let discovered = null;
    let discovery = 'off';
    if (this.#discover) {
      let found;
      try { found = await this.#discoverImpl(); } catch { found = { ok: false, error: 'process scan failed', engines: [] }; }
      discovery = found?.ok ? 'ok' : 'unavailable';
      if (!found?.ok) this.#warning(`engine discovery unavailable: ${found?.error || 'unknown error'}`);
      discovered = found?.engines ?? [];
    }
    const { servers } = await collectTensorFoldStatus(entries, {
      scope: this.#scope, discovered, fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs,
      now: this.#now, clock: this.#clock, samples: this.#samples, detected: this.#detected,
    });
    // A discovered engine's port changes on every relaunch (TensorFold Studio
    // picks a free one), so rate samples for ports no longer on the card go.
    const live = new Set(servers.map(s => `${String(s.host).toLowerCase()}:${s.port}`));
    for (const key of this.#samples.keys()) if (!live.has(key)) this.#samples.delete(key);
    this.#snapshot = { schema: STATUS_SCHEMA, checked_at: checkedAt, scope: this.#scope, error, discovery, servers };
    return this.#snapshot;
  }

  /** One read. Single flight, never rejects. */
  refresh() {
    if (!this.enabled) return Promise.resolve(null);
    if (!this.#inFlight) {
      this.#inFlight = this.#read()
        .catch(err => { this.#warning(`status read failed: ${err?.name || 'error'}`); return this.#snapshot; })
        .finally(() => { this.#inFlight = null; });
    }
    return this.#inFlight;
  }

  /** Starts the timer; resolves when the first read lands (null when off). */
  start() {
    this.stop();
    if (!this.enabled) return Promise.resolve(null);
    const first = this.refresh();
    this.#timer = setInterval(() => { this.refresh(); }, this.#intervalMs);
    this.#timer.unref?.();
    return first;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
