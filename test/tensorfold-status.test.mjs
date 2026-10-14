// SPDX-License-Identifier: AGPL-3.0-only
//
// TensorFold status on the device heartbeat.
//
// The fixtures under test/fixtures/tensorfold/ named *-mlx-0.6.0.* and
// slide-graph-404.json are byte-for-byte GET answers recorded from a live
// TensorFold server (tensorfold 0.6.0, MLX, 127.0.0.1:8091) on 2026-10-14.
// Its counters were all zero, so the traffic case below edits the counter
// values of that same recording rather than inventing a format. The 401 case
// mirrors the native server's key gate (zig/src/server/server.zig
// `authenticate` and status_routes.zig `health`), and the 200 slide graph
// mirrors zig/src/server/slide_graph.zig `document`.
//
// Every test server records every request, and the suite asserts that only
// GETs to /health, /metrics and /v1/slide/graph ever arrive: a status reader
// that sent a completion would teach the model something mid-lesson. The
// recorder has its own negative control so the check can fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import {
  parsePrometheus, histogramQuantile, summarizeMetrics, summarizeHealth, summarizeSlideGraph,
  looksLikeTensorFoldHealth, probeTensorFold, collectTensorFoldStatus, TensorFoldMonitor,
  DETECT_RECHECK_MS, METRICS_STATES, STATUS_SCHEMA,
} from '../packages/user-intent-kit/src/tensorfold-status.js';
import { loadRegistry, resolveEntryToken, RegistryError, KEY_SOURCES } from '../packages/user-intent-kit/src/model-capacity.js';
import { DesktopAdapter } from '../packages/user-intent-kit/src/adapters/desktop.js';
import { resolveTensorFoldRegistryPath, runTensorFoldStatus, formatServer } from '../src/tensorfold-status.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => readFileSync(new URL(`./fixtures/tensorfold/${name}`, import.meta.url), 'utf8');
const LIVE_HEALTH = fixture('health-mlx-0.6.0.json');
const LIVE_METRICS = fixture('metrics-mlx-0.6.0.prom');
const LIVE_SLIDE_404 = fixture('slide-graph-404.json');
const LIVE_MODEL = 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit';

// Made up. The suite asserts it never appears in any output.
const DUMMY_TOKEN = 'tf-dummy-not-real';
const ALLOWED = new Set(['GET /health', 'GET /metrics', 'GET /v1/slide/graph']);

/** Replace the value of one exact series line in a Prometheus recording. */
function setSeries(text, series, value) {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped} \\S+$`, 'm');
  assert.match(text, re, `fixture has no line for ${series}`);
  return text.replace(re, `${series} ${value}`);
}

/** The live recording with traffic: edited values, same format. */
function trafficMetrics({ generation = 1200 } = {}) {
  let t = LIVE_METRICS;
  t = setSeries(t, 'tensorfold:requests_running', 2);
  t = setSeries(t, 'tensorfold:requests_waiting', 1);
  t = setSeries(t, 'tensorfold:prompt_tokens_total', 5000);
  t = setSeries(t, 'tensorfold:generation_tokens_total', generation);
  t = setSeries(t, 'tensorfold:kv_cache_usage_ratio{pool="0"}', 0.25);
  t = t.replace('tensorfold:kv_cache_usage_ratio{pool="0"} 0.25', 'tensorfold:kv_cache_usage_ratio{pool="0"} 0.25\ntensorfold:kv_cache_usage_ratio{pool="1"} 0.5');
  t = setSeries(t, 'tensorfold:mtp_drafted_total', 1000);
  t = setSeries(t, 'tensorfold:mtp_accepted_total', 750);
  const ttft = { '0.01': 0, '0.05': 0, '0.1': 2, '0.25': 7, '0.5': 9, '1': 10, '2.5': 10, '5': 10, '10': 10, '30': 10, '60': 10, '120': 10, '300': 10, '+Inf': 10 };
  for (const [le, n] of Object.entries(ttft)) t = setSeries(t, `tensorfold:time_to_first_token_seconds_bucket{le="${le}"}`, n);
  t = setSeries(t, 'tensorfold:time_to_first_token_seconds_count', 10);
  return t;
}

/** A recording HTTP server. `routes` maps "GET /path" to a reply or a function returning one. */
async function tfServer(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ line: `${req.method} ${req.url}`, auth: req.headers.authorization ?? null, connection: req.headers.connection ?? null });
    let route = routes[`${req.method} ${req.url}`];
    if (typeof route === 'function') route = route(req);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown path ${req.url}` } }));
      return;
    }
    if (route.hang) return;
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'application/json', ...(route.headers || {}) });
    res.end(route.body ?? '');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { port: server.address().port, seen, server };
}

function assertGetOnly(seen) {
  for (const r of seen) assert.ok(ALLOWED.has(r.line), `status reader sent ${r.line}`);
}

const liveRoutes = (overrides = {}) => ({
  'GET /health': { body: LIVE_HEALTH },
  'GET /metrics': { body: LIVE_METRICS, type: 'text/plain; version=0.0.4; charset=utf-8' },
  'GET /v1/slide/graph': { status: 404, body: LIVE_SLIDE_404 },
  ...overrides,
});

// The native server with keys on: /health is open and minimal, the rest 401.
const GATE_BODY = '{"error": {"message": "A valid API key is required", "type": "invalid_request_error", "param": null, "code": "invalid_api_key"}}';
const gated = (body, type = 'application/json') => req => (req.headers.authorization === `Bearer ${DUMMY_TOKEN}`
  ? { body, type }
  : { status: 401, body: GATE_BODY, headers: { 'www-authenticate': 'Bearer' } });
const authRoutes = () => ({
  'GET /health': { body: '{"status": "ok"}' },
  'GET /metrics': gated(LIVE_METRICS, 'text/plain; version=0.0.4; charset=utf-8'),
  'GET /v1/slide/graph': gated(JSON.stringify({ next: 1, facts: [] })),
});

const entry = (port, extra = {}) => loadRegistry([{ id: 'tf', host: '127.0.0.1', port, kind: 'openai', ...extra }])[0];

/** A 0600 key file holding `token`, removed after the test. */
async function keyFileWith(t, token) {
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'tensorfold_api_key.txt');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return path;
}

// --- the recorder can fail ------------------------------------------------------

test('negative control: the GET-only recorder catches a completion request', async t => {
  const { port, seen } = await tfServer(t, liveRoutes());
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.throws(() => assertGetOnly(seen), /POST \/v1\/chat\/completions/);
});

// --- parsing the live recording -------------------------------------------------

test('live 0.6.0 /metrics parses into tensorfold series with labels', () => {
  const series = parsePrometheus(LIVE_METRICS);
  assert.ok(series.length > 30);
  assert.ok(series.every(s => s.name.startsWith('tensorfold:')));
  const kv = series.find(s => s.name === 'tensorfold:kv_cache_usage_ratio');
  assert.deepEqual(kv.labels, { pool: '0' });
  const inf = series.find(s => s.name === 'tensorfold:time_to_first_token_seconds_bucket' && s.labels.le === '+Inf');
  assert.equal(inf.value, 0);
  const m = summarizeMetrics(series);
  assert.equal(m.detected, true);
  assert.deepEqual(m.requests, { running: 0, waiting: 0 });
  assert.deepEqual(m.draft, { drafted: 0, accepted: 0, acceptance: null }, 'no drafts is n/a, never 0%');
  assert.equal(m.ttftP50, null, 'nothing observed is null, never 0 s');
  assert.equal(m.kvCacheUsage, 0);
});

test('live 0.6.0 /health has the TensorFold shape; other servers do not', () => {
  assert.equal(looksLikeTensorFoldHealth(JSON.parse(LIVE_HEALTH)), true);
  assert.equal(looksLikeTensorFoldHealth({ status: 'ok' }), false, 'llama-server and a keyed TensorFold both say just this');
  assert.equal(looksLikeTensorFoldHealth(null), false);
  const h = summarizeHealth(JSON.parse(LIVE_HEALTH));
  assert.equal(h.model, LIVE_MODEL);
  assert.equal(h.warming, false);
  assert.equal(h.version, null);
  assert.equal(h.backend, null);
  assert.equal(h.device, null);
});

test('version, backend and device are read when /health carries them', () => {
  const future = { ...JSON.parse(LIVE_HEALTH), version: '1.1.0', backend: 'cuda', device: { name: 'NVIDIA GB10' } };
  const h = summarizeHealth(future);
  assert.equal(h.version, '1.1.0');
  assert.equal(h.backend, 'cuda');
  assert.equal(h.device, 'NVIDIA GB10');
  assert.equal(summarizeHealth({ ...future, device: 'Apple M5 Max\u0007' }).device, 'Apple M5 Max');
});

test('histogram p50 interpolates like Prometheus and is null with no observations', () => {
  const b = (le, count) => ({ le, count });
  assert.equal(histogramQuantile(0.5, [b(0.1, 2), b(0.25, 7), b(Infinity, 10)]), 0.19);
  assert.equal(histogramQuantile(0.5, [b(0.1, 0), b(Infinity, 0)]), null);
  assert.equal(histogramQuantile(0.5, [b(1, 0), b(Infinity, 4)]), 1, 'mass in +Inf reports the highest finite edge');
  assert.equal(histogramQuantile(0.5, []), null);
});

test('slide graph: counts only, never the taught text', () => {
  const graph = {
    next: 4,
    facts: [
      { id: 1, text: 'private fact one', source: 'chat', at: 1, state: 'learned', links: [] },
      { id: 2, text: 'private fact two', source: 'chat', at: 2, state: 'learning', links: [], phase: 'fitting' },
      { id: 3, text: 'private fact three', source: 'chat', at: 3, state: 'queued', links: [] },
    ],
  };
  const lw = summarizeSlideGraph(graph);
  assert.deepEqual(lw, { available: true, facts: 3, learning: 1, learned: 1 });
  assert.doesNotMatch(JSON.stringify(lw), /private/);
  assert.deepEqual(summarizeSlideGraph({ error: 'x' }), { available: null, facts: null, learning: null, learned: null });
});

// --- one server, end to end ------------------------------------------------------

test('live recording end to end: the published object, GET only, no key sent', async t => {
  const { port, seen } = await tfServer(t, liveRoutes());
  const { status, sample } = await probeTensorFold({ id: 'mb-tensorfold-nemotron', host: '127.0.0.1', port }, {
    now: () => Date.parse('2026-10-14T09:00:00Z'), clock: () => 5000,
  });
  assertGetOnly(seen);
  assert.deepEqual(seen.map(r => r.line).sort(), ['GET /health', 'GET /metrics', 'GET /v1/slide/graph']);
  assert.ok(seen.every(r => r.auth === null));
  assert.ok(seen.every(r => r.connection === 'close'), 'no idle keep-alive socket parked on the server between reads');
  assert.deepEqual(status, {
    id: 'mb-tensorfold-nemotron',
    host: '127.0.0.1',
    port,
    local: true,
    source: 'registry',
    reachable: true,
    reason: null,
    model: LIVE_MODEL,
    warming: false,
    version: null,
    backend: null,
    device: null,
    memory: { used_gb: 18.7, peak_gb: 40.7, budget_gb: 96.2 },
    requests: { running: 0, waiting: 0 },
    tokens: { prompt_total: 0, generation_total: 0 },
    tok_s: null,
    tok_s_window_s: null,
    decode_tok_s: null,
    draft: { drafted: 0, accepted: 0, acceptance: null },
    ttft_p50_s: null,
    kv_cache_usage: 0,
    living_weights: { available: false, facts: null, learning: null, learned: null },
    metrics: 'ok',
    checked_at: '2026-10-14T09:00:00.000Z',
  });
  assert.deepEqual(sample, { generation_total: 0, at: 5000 });
  assert.ok(JSON.stringify(status).length < 1024, 'one server stays under 1 KB on the heartbeat');
});

test('traffic: tok/s from generation_tokens_total deltas, acceptance, ttft p50, fullest kv pool', async t => {
  const state = { generation: 1200 };
  const { port, seen } = await tfServer(t, liveRoutes({
    'GET /metrics': () => ({ body: trafficMetrics({ generation: state.generation }), type: 'text/plain' }),
  }));
  const target = { id: 'tf', host: '127.0.0.1', port };
  const first = await probeTensorFold(target, { clock: () => 10_000 });
  assert.equal(first.status.tok_s, null, 'the first sample has no rate');
  assert.deepEqual(first.status.requests, { running: 2, waiting: 1 });
  assert.deepEqual(first.status.tokens, { prompt_total: 5000, generation_total: 1200 });
  assert.deepEqual(first.status.draft, { drafted: 1000, accepted: 750, acceptance: 0.75 });
  assert.equal(first.status.ttft_p50_s, 0.19);
  assert.equal(first.status.kv_cache_usage, 0.5);

  state.generation = 1800;
  const second = await probeTensorFold(target, { clock: () => 20_000, previous: first.sample });
  assert.equal(second.status.tok_s, 60);
  assert.equal(second.status.tok_s_window_s, 10);

  state.generation = 40; // the server restarted
  const third = await probeTensorFold(target, { clock: () => 30_000, previous: second.sample });
  assert.equal(third.status.tok_s, null, 'a counter that went down is a restart, not a negative rate');
  assert.deepEqual(third.sample, { generation_total: 40, at: 30_000 });
  assertGetOnly(seen);
});

test('401 on /metrics: "auth required", minimal /health reads as unknown, no key invented', async t => {
  const { port, seen } = await tfServer(t, authRoutes());
  const { status } = await probeTensorFold({ id: 'gb10', host: '127.0.0.1', port });
  assertGetOnly(seen);
  assert.ok(seen.every(r => r.auth === null));
  assert.equal(status.reachable, true);
  assert.equal(status.metrics, METRICS_STATES.AUTH_REQUIRED);
  assert.match(status.reason, /metrics: auth required/);
  assert.equal(status.model, null);
  assert.deepEqual(status.memory, { used_gb: null, peak_gb: null, budget_gb: null });
  assert.deepEqual(status.requests, { running: null, waiting: null }, 'unread is null, never 0');
  assert.equal(status.living_weights.available, null, 'a 401 graph is unknown, not absent');
  assert.match(formatServer(status), /metrics: auth required/);
});

test('keyFile: the entry key goes to /metrics and /v1/slide/graph only, never /health, never in output', async t => {
  const { port, seen } = await tfServer(t, authRoutes());
  const warnings = [];
  const e = entry(port, { engine: 'tensorfold', keyFile: await keyFileWith(t, DUMMY_TOKEN) });
  const { servers } = await collectTensorFoldStatus([e], { env: {} });
  assertGetOnly(seen);
  const byPath = Object.fromEntries(seen.map(r => [r.line, r.auth]));
  assert.equal(byPath['GET /health'], null);
  assert.equal(byPath['GET /metrics'], `Bearer ${DUMMY_TOKEN}`);
  assert.equal(byPath['GET /v1/slide/graph'], `Bearer ${DUMMY_TOKEN}`);
  assert.equal(servers[0].metrics, METRICS_STATES.OK);
  assert.deepEqual(servers[0].living_weights, { available: true, facts: 0, learning: 0, learned: 0 });
  assert.doesNotMatch(JSON.stringify(servers) + warnings.join(''), new RegExp(DUMMY_TOKEN));

  seen.length = 0;
  const other = entry(port, { engine: 'tensorfold', keyFile: await keyFileWith(t, 'some-other-made-up-key') });
  const wrong = await collectTensorFoldStatus([other], { env: {} });
  assert.equal(wrong.servers[0].metrics, METRICS_STATES.AUTH_REJECTED, 'a key that was sent and refused is a different repair');
});

test('a redirect is never followed, so a key cannot be carried to another host', async t => {
  const elsewhere = await tfServer(t, liveRoutes());
  const to = `http://127.0.0.1:${elsewhere.port}`;
  const { port } = await tfServer(t, {
    'GET /health': { body: LIVE_HEALTH },
    'GET /metrics': { status: 302, headers: { location: `${to}/metrics` } },
    'GET /v1/slide/graph': { status: 302, headers: { location: `${to}/v1/slide/graph` } },
  });
  const e = entry(port, { engine: 'tensorfold', keyFile: await keyFileWith(t, DUMMY_TOKEN) });
  const { servers } = await collectTensorFoldStatus([e], { env: {} });
  assert.equal(elsewhere.seen.length, 0);
  assert.equal(servers[0].metrics, METRICS_STATES.UNAVAILABLE);
});

test('a named key that is missing is reported, and the fleet-wide LLM_API_KEY is never substituted', async t => {
  const { port, seen } = await tfServer(t, authRoutes());
  const env = { LLM_API_KEY: DUMMY_TOKEN, LLM_API_KEY_FILE: '' };
  const missing = join(tmpdir(), 'iak-tf-no-such-dir', 'key.txt');
  const named = await collectTensorFoldStatus([entry(port, { engine: 'tensorfold', keyFile: missing })], { env });
  assert.match(named.servers[0].reason, /metrics: auth required; cannot read key file .*key\.txt \(ENOENT\)/);
  const bearerNoKey = await collectTensorFoldStatus([entry(port, { engine: 'tensorfold', auth: 'bearer' })], { env });
  assert.match(bearerNoKey.servers[0].reason, /names no keyFile/);
  assert.ok(seen.every(r => r.auth === null), 'LLM_API_KEY went out to a TensorFold status read');
});

test('unreachable: closed port and a socket that never answers both give reachable:false, never a throw', async t => {
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const closedPort = probe.address().port;
  await new Promise(r => probe.close(r));
  const closed = await probeTensorFold({ id: 'gone', host: '127.0.0.1', port: closedPort });
  assert.equal(closed.status.reachable, false);
  assert.match(closed.status.reason, /connect failed \(ECONNREFUSED\)/);
  assert.equal(closed.status.metrics, METRICS_STATES.UNAVAILABLE);
  assert.equal(closed.status.living_weights.available, null);
  assert.equal(closed.sample, null);

  const { port } = await tfServer(t, { 'GET /health': { hang: true }, 'GET /metrics': { hang: true }, 'GET /v1/slide/graph': { hang: true } });
  const hung = await probeTensorFold({ id: 'hung', host: '127.0.0.1', port }, { timeoutMs: 150 });
  assert.equal(hung.status.reachable, false);
  assert.match(hung.status.reason, /no response within 150 ms/);

  const thrown = await probeTensorFold({ id: 'x', host: '127.0.0.1', port }, { fetchImpl: () => { throw new Error('boom'); } });
  assert.equal(thrown.status.reachable, false);
});

// --- the registry ---------------------------------------------------------------

test('registry: engine is a short name, lower-cased and kept; absent is null', () => {
  const [e] = loadRegistry([{ id: 'a', host: 'localhost', port: 8091, kind: 'openai', engine: 'TensorFold' }]);
  assert.equal(e.engine, 'tensorfold');
  assert.equal(e.auth, 'none');
  const [plain] = loadRegistry([{ id: 'b', host: 'localhost', port: 8091, kind: 'openai' }]);
  assert.equal(plain.engine, null);
  const bad = extra => () => loadRegistry([{ id: 'c', host: 'localhost', port: 1, kind: 'openai', ...extra }]);
  assert.throws(bad({ engine: 'tensor fold!' }), /short name/);
  assert.throws(bad({ engine: 42 }), RegistryError);
  assert.throws(bad({ engine: 'tensorfold', apiKey: DUMMY_TOKEN }), /never a VALUE/, 'a TensorFold entry still refuses a pasted key');
});

test('resolveEntryToken: entryOnly uses the entry keyFile and stops before the fleet-wide env', async t => {
  const env = { LLM_API_KEY: 'fleet-wide-made-up' };
  const [withFile] = loadRegistry([{ id: 'a', host: 'localhost', port: 1, kind: 'openai', keyFile: await keyFileWith(t, DUMMY_TOKEN) }]);
  const r = await resolveEntryToken(withFile, { env, entryOnly: true });
  assert.equal(r.token, DUMMY_TOKEN);
  assert.equal(r.keySource, KEY_SOURCES.ENTRY_FILE);
  const [bare] = loadRegistry([{ id: 'b', host: 'localhost', port: 1, kind: 'openai', auth: 'bearer' }]);
  assert.equal((await resolveEntryToken(bare, { env })).token, 'fleet-wide-made-up', 'the picker keeps its fallbacks');
  assert.equal((await resolveEntryToken(bare, { env, entryOnly: true })).token, null);
});

// --- many servers ---------------------------------------------------------------

test('collect: explicit, auto-detected, other engine, scope local, and the not-TensorFold recheck', async t => {
  const tf = await tfServer(t, liveRoutes());
  const llama = await tfServer(t, { 'GET /health': { body: '{"status":"ok"}' } });
  const vllm = await tfServer(t, liveRoutes());
  const urls = [];
  const fetchImpl = (url, init) => { urls.push(url); return fetch(url, init); };
  let now = Date.parse('2026-10-14T09:00:00Z');
  const entries = loadRegistry([
    { id: 'auto-tf', host: '127.0.0.1', port: tf.port, kind: 'openai' },
    { id: 'llama', host: 'localhost', port: llama.port, kind: 'openai' },
    { id: 'vllm', host: '127.0.0.1', port: vllm.port, kind: 'vllm', engine: 'vllm' },
    { id: 'remote', host: 'remote-box.invalid', port: 8091, kind: 'openai', engine: 'tensorfold' },
  ]);
  const detected = new Map();
  const opts = { fetchImpl, now: () => now, detected, scope: 'local', env: {} };
  const one = await collectTensorFoldStatus(entries, opts);
  assert.deepEqual(one.servers.map(s => [s.id, s.source]), [['auto-tf', 'detected']]);
  assert.deepEqual(one.skipped.map(s => s.id), ['llama', 'vllm']);
  assert.equal(vllm.seen.length, 0, 'an entry the registry calls something else gets no request');
  assert.ok(!urls.some(u => u.includes('remote-box.invalid')), 'scope local must not leave the machine');
  assert.ok(llama.seen.length > 0);
  for (const s of [tf, llama]) assertGetOnly(s.seen);

  const before = llama.seen.length;
  await collectTensorFoldStatus(entries, opts);
  assert.equal(llama.seen.length, before, 'a port that answered "not TensorFold" is not asked again at once');
  now += DETECT_RECHECK_MS + 1;
  await collectTensorFoldStatus(entries, opts);
  assert.ok(llama.seen.length > before, 'and is asked again after the recheck interval');

  const all = await collectTensorFoldStatus(entries, { ...opts, scope: 'all', timeoutMs: 1500 });
  const remote = all.servers.find(s => s.id === 'remote');
  assert.equal(remote.reachable, false);
  assert.equal(remote.local, false);

  // A detected server that stops answering stays on the card as unreachable.
  tf.server.closeAllConnections();
  await new Promise(r => tf.server.close(r));
  const down = await collectTensorFoldStatus(entries, opts);
  const gone = down.servers.find(s => s.id === 'auto-tf');
  assert.equal(gone.reachable, false);
  assert.equal(gone.source, 'detected');
});

test('auto-detection never sends a key, even when the entry names one', async t => {
  const { port, seen } = await tfServer(t, authRoutes());
  const e = entry(port, { keyFile: await keyFileWith(t, DUMMY_TOKEN) });
  const { servers, skipped } = await collectTensorFoldStatus([e], { env: {} });
  assert.equal(servers.length, 0);
  assert.match(skipped[0].reason, /not TensorFold/);
  assert.ok(seen.every(r => r.auth === null));
});

// --- the heartbeat ----------------------------------------------------------------

function macSources() {
  return {
    platform: () => 'darwin', loadavg: () => [1, 1, 1], cpuCount: () => 10,
    totalMemBytes: () => 16e9, freeMemBytes: () => 4e9, availableMemBytes: () => 12e9,
    run: () => '', listProcessCommandLines: () => [], listThermalZones: () => [],
    readThermalZone: () => '', readThermalCriticalMilli: () => '',
  };
}
const offSwitcher = { enabled: false, refresh: async () => ({}), start() {}, stop() {}, fields: () => ({}) };

test('monitor: off by default, network-free, publishes nothing', async () => {
  for (const registryPath of ['', 'off', undefined]) {
    const m = new TensorFoldMonitor({ registryPath, env: {}, fetchImpl: () => { throw new Error('network while off'); } });
    if (registryPath === undefined && process.env.INTENT_TENSORFOLD_REGISTRY) continue;
    assert.equal(m.enabled, false);
    assert.deepEqual(m.fields(), {});
    assert.equal(await m.refresh(), null);
    assert.equal(await m.start(), null);
    m.stop();
    assert.match(m.describe(), /^off/);
  }
  assert.throws(() => new TensorFoldMonitor({ registryPath: '/x', scope: 'everywhere' }), /local, all/);
});

test('monitor: an unreadable registry is an error on the card, not an empty list', async () => {
  const warnings = [];
  const m = new TensorFoldMonitor({ registryPath: join(tmpdir(), 'no-such-dir-iak', 'models.json'), warn: w => warnings.push(w) });
  await m.refresh();
  await m.refresh();
  const { tensorfold } = m.fields();
  assert.equal(tensorfold.schema, STATUS_SCHEMA);
  assert.match(tensorfold.error, /^registry unreadable: /);
  assert.deepEqual(tensorfold.servers, []);
  assert.equal(warnings.length, 1, 'warned once, not once per beat');
});

test('monitor: reads the registry file each refresh and keeps the rate between refreshes', async t => {
  const state = { generation: 100 };
  const { port, seen } = await tfServer(t, liveRoutes({
    'GET /metrics': () => ({ body: trafficMetrics({ generation: state.generation }), type: 'text/plain' }),
  }));
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ models: [{ id: 'mb-tf', host: 'localhost', port, kind: 'openai', engine: 'tensorfold' }] }));
  let clock = 0;
  const m = new TensorFoldMonitor({ registryPath: path, scope: 'local', clock: () => clock, intervalMs: 30000 });
  assert.match(m.describe(), /scope local, every 30s, GET only/);
  await m.refresh();
  clock = 30_000;
  state.generation = 1600;
  await m.refresh();
  const { tensorfold } = m.fields();
  assert.equal(tensorfold.error, null);
  assert.equal(tensorfold.scope, 'local');
  assert.equal(tensorfold.servers.length, 1);
  assert.equal(tensorfold.servers[0].tok_s, 50);
  assert.equal(tensorfold.servers[0].tok_s_window_s, 30);
  assertGetOnly(seen);

  await writeFile(path, JSON.stringify({ models: [{ id: 'mb-tf', host: 'localhost', port, kind: 'openai', engine: 'llama.cpp' }] }));
  await m.refresh();
  assert.deepEqual(m.fields().tensorfold.servers, [], 'an edited registry applies without a restart');
});

test('heartbeat: the device PATCH carries the tensorfold key; off and null publish no key', async t => {
  const { port } = await tfServer(t, liveRoutes());
  const monitor = new TensorFoldMonitor({ entries: [entry(port, { engine: 'tensorfold' })], intervalMs: 60000 });
  const patched = [];
  const client = { deviceId: 'testbox', patchDevice: async s => { patched.push(s); } };
  const base = { pollIntervalMs: 60000, hostSources: macSources(), modelProbe: null, availabilityProbe: null, modelSwitcher: offSwitcher };

  const before = new DesktopAdapter(client, { ...base, tensorfold: monitor });
  await before.publishState();
  assert.equal(patched[0].tensorfold, undefined, 'nothing until the first read lands: no misleading empty list');

  await monitor.refresh();
  const adapter = new DesktopAdapter(client, { ...base, tensorfold: monitor });
  await adapter.publishState();
  const beat = patched.at(-1);
  assert.equal(beat.tensorfold.schema, STATUS_SCHEMA);
  assert.equal(beat.tensorfold.error, null);
  assert.equal(beat.tensorfold.servers[0].model, LIVE_MODEL);
  assert.equal(beat.tensorfold.servers[0].reachable, true);
  assert.equal(beat.ttl_sec, 90);

  const off = new DesktopAdapter(client, { ...base, tensorfold: null });
  await off.publishState();
  assert.equal('tensorfold' in patched.at(-1), false);
});

test('heartbeat: start() publishes again as soon as the first read lands', async t => {
  const { port } = await tfServer(t, liveRoutes());
  const monitor = new TensorFoldMonitor({ entries: [entry(port, { engine: 'tensorfold' })], intervalMs: 60000 });
  const patched = [];
  const adapter = new DesktopAdapter({ deviceId: 'testbox', patchDevice: async s => { patched.push(s); } }, {
    pollIntervalMs: 60000, hostSources: macSources(), modelProbe: null, availabilityProbe: null,
    modelSwitcher: offSwitcher, tensorfold: monitor,
  });
  adapter.start();
  t.after(() => adapter.stop());
  for (let i = 0; i < 100 && !patched.some(p => p.tensorfold); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(patched.some(p => p.tensorfold?.servers?.[0]?.model === LIVE_MODEL));
});

// --- the CLI --------------------------------------------------------------------

test('registry path: --registry, then INTENT_TENSORFOLD_REGISTRY, then the picker\'s path', () => {
  assert.equal(resolveTensorFoldRegistryPath({ cliPath: '/a/models.json', env: { INTENT_TENSORFOLD_REGISTRY: '/b' } }), '/a/models.json');
  assert.equal(resolveTensorFoldRegistryPath({ env: { INTENT_TENSORFOLD_REGISTRY: '/b/models.json' } }), '/b/models.json');
  assert.equal(resolveTensorFoldRegistryPath({ env: {}, config: { mcp: { confirmations: { model_registry: '/c.json' } } } }), '/c.json');
  assert.equal(resolveTensorFoldRegistryPath({ env: { INTENT_TENSORFOLD_REGISTRY: 'off' }, rootDir: '/repo' }), join('/repo', 'config', 'models.json'));
});

test('read-out: human text says "unknown" for absent fields; --json is the heartbeat object', async t => {
  const { port, seen } = await tfServer(t, liveRoutes());
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ models: [{ id: 'mb-tf', host: '127.0.0.1', port, kind: 'openai' }] }));
  const human = await runTensorFoldStatus({ registryPath: path, callerHost: 'testhost', env: {} });
  assert.equal(human.exitCode, 0);
  assert.match(human.text, /mb-tf {2}127\.0\.0\.1:\d+ {2}reachable {2}\(auto-detected\)/);
  assert.match(human.text, /version: unknown {3}backend: unknown {3}device: unknown/);
  assert.match(human.text, /memory: 18\.7 GB used, 40\.7 GB peak, 96\.2 GB budget/);
  assert.match(human.text, /tok\/s: needs two samples/);
  assert.match(human.text, /living weights: not available/);
  const json = await runTensorFoldStatus({ registryPath: path, callerHost: 'testhost', json: true, env: {} });
  const report = JSON.parse(json.text);
  assert.equal(report.schema, STATUS_SCHEMA);
  assert.equal(report.servers[0].model, LIVE_MODEL);
  assertGetOnly(seen);

  const missing = await runTensorFoldStatus({ registryPath: join(dir, 'nope.json'), callerHost: 'testhost' });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.text, /cannot read registry/);
});

test('cli: ide-agent-kit tensorfold-status --json runs end to end', async t => {
  const { port } = await tfServer(t, liveRoutes());
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ models: [{ id: 'mb-tf', host: '127.0.0.1', port, kind: 'openai', engine: 'tensorfold' }] }));
  const env = { ...process.env };
  delete env.INTENT_TENSORFOLD_REGISTRY;
  const run = args => new Promise(resolve => {
    execFile(process.execPath, [join(ROOT, 'bin', 'cli.mjs'), 'tensorfold-status', ...args], { cwd: dir, env, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  const ok = await run(['--registry', path, '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.servers[0].id, 'mb-tf');
  assert.equal(report.servers[0].source, 'registry');
  const bad = await run(['--registry', join(dir, 'missing.json')]);
  assert.equal(bad.code, 2);
});
