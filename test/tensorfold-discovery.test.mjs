// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding TensorFold engines from the process table, and reading them with
// the same GET-only rules as registry entries.
//
// Fixtures (test/fixtures/tensorfold/):
//   ps-macos-live.txt        the three `serve` lines `ps -U <uid> -o pid=,args=`
//                            printed on 2026-10-14 (home directory renamed to
//                            /Users/me): the 0.6.0 Python engine, a native
//                            1.0.10 bench engine, and TensorFold Studio's
//                            bundled engine on its random port.
//   ps-macos-decoys.txt      synthetic: lines that must NOT be read as engines,
//                            plus the shapes a launcher could produce (spaces
//                            in paths, --port=, -m, a key on argv, no --port).
//   lsof-studio.txt          `lsof -Fn` for the Studio engine's listening socket.
//   health-studio-keyed.json, metrics-studio-401.json
//                            the Studio engine's live GET answers: /health is
//                            {"status": "ok"} and /metrics a 401, because the
//                            app starts it with a key it keeps in memory.
//   health/metrics/slide-graph-native-1.0.10.*
//                            the native bench engine's live GET answers.
//
// No test reads this machine's process table or talks to a live engine: the
// process scan is injected, and every server is a local test server that
// records each request so the suite can assert only the three GETs arrive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePsOutput, parseServeLine, parseServeArgv, parseLsofListen, connectHost, repoFromPath,
  discoverTensorFoldEngines, STUDIO_APP_NAME, DEFAULT_ENGINE_PORT,
} from '../packages/user-intent-kit/src/tensorfold-discovery.js';
import {
  collectTensorFoldStatus, readEngineKeyFile, TensorFoldMonitor, METRICS_STATES,
} from '../packages/user-intent-kit/src/tensorfold-status.js';
import { loadRegistry } from '../packages/user-intent-kit/src/model-capacity.js';

const fixture = name => readFileSync(new URL(`./fixtures/tensorfold/${name}`, import.meta.url), 'utf8');
const PS_LIVE = fixture('ps-macos-live.txt');
const PS_DECOYS = fixture('ps-macos-decoys.txt');
const LSOF_STUDIO = fixture('lsof-studio.txt');
const STUDIO_HEALTH = fixture('health-studio-keyed.json');
const STUDIO_401 = fixture('metrics-studio-401.json');
const NATIVE_HEALTH = fixture('health-native-1.0.10.json');
const NATIVE_METRICS = fixture('metrics-native-1.0.10.prom');
const NATIVE_GRAPH = fixture('slide-graph-native-1.0.10.json');
const STUDIO_MODEL = 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit';

const DUMMY_KEY = 'tf-dummy-not-real';
const ALLOWED = new Set(['GET /health', 'GET /metrics', 'GET /v1/slide/graph']);

async function tfServer(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ line: `${req.method} ${req.url}`, auth: req.headers.authorization ?? null });
    let route = routes[`${req.method} ${req.url}`];
    if (typeof route === 'function') route = route(req);
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error": {"message": "unknown path"}}'); return; }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'application/json', ...(route.headers || {}) });
    res.end(route.body ?? '');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { port: server.address().port, seen };
}

function assertGetOnly(seen) {
  for (const r of seen) assert.ok(ALLOWED.has(r.line), `status reader sent ${r.line}`);
}

// The Studio engine as it answers live: open /health that says only "ok",
// 401 on the gated routes unless the right key comes with the request.
const keyedRoutes = () => {
  const gate = body => req => (req.headers.authorization === `Bearer ${DUMMY_KEY}`
    ? { body, type: 'text/plain' }
    : { status: 401, body: STUDIO_401, headers: { 'www-authenticate': 'Bearer' } });
  return {
    'GET /health': { body: STUDIO_HEALTH },
    'GET /metrics': gate(NATIVE_METRICS),
    'GET /v1/slide/graph': gate(NATIVE_GRAPH),
  };
};
const openNativeRoutes = () => ({
  'GET /health': { body: NATIVE_HEALTH },
  'GET /metrics': { body: NATIVE_METRICS, type: 'text/plain' },
  'GET /v1/slide/graph': { body: NATIVE_GRAPH },
});

/** A discovered engine as discoverTensorFoldEngines returns it. */
const engine = (port, extra = {}) => ({
  pid: 4242, host: '127.0.0.1', port, portFrom: 'args', name: null, model: null,
  app: null, apiKeyFile: null, keyOnArgv: false, slide: false, ...extra,
});

async function keyFile(t, text, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-engine-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'keys');
  await writeFile(path, text, { mode });
  return path;
}

// --- parsing the process table --------------------------------------------------

test('live macOS ps lines: Python 0.6.0, native bench, and the Studio engine on its random port', () => {
  const engines = parsePsOutput(PS_LIVE).map(p => parseServeLine(p.pid, p.args)).filter(Boolean);
  const simple = engines.map(e => ({ pid: e.pid, port: e.port, host: e.listenHost, name: e.name, model: e.model, app: e.app, slide: e.slide, keyOnArgv: e.keyOnArgv }));
  assert.deepEqual(simple, [
    { pid: 1361, port: 8091, host: '127.0.0.1', name: null, model: 'Vontra/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', app: null, slide: false, keyOnArgv: false },
    { pid: 10169, port: 8101, host: '127.0.0.1', name: 'bench', model: 'bench', app: null, slide: false, keyOnArgv: false },
    { pid: 14779, port: 54635, host: '127.0.0.1', name: STUDIO_MODEL, model: STUDIO_MODEL, app: STUDIO_APP_NAME, slide: false, keyOnArgv: false },
  ]);
});

test('decoys are not engines; launcher shapes parse; a key on argv is noted and never kept', () => {
  const byPid = Object.fromEntries(parsePsOutput(PS_DECOYS).map(p => [p.pid, parseServeLine(p.pid, p.args)]));
  for (const pid of [501, 502, 503, 504]) assert.equal(byPid[pid], null, `pid ${pid} is not a TensorFold engine`);
  const studio = byPid[505];
  assert.equal(studio.app, STUDIO_APP_NAME, 'a bundle path with spaces is still the Studio engine');
  assert.equal(studio.port, 9123);
  assert.equal(studio.listenHost, '0.0.0.0');
  assert.equal(studio.name, 'Owner/Model');
  assert.equal(studio.slide, true);
  assert.equal(studio.apiKeyFile, '/Users/me/.tensorfold/keys');
  const keyed = byPid[506];
  assert.equal(keyed.keyOnArgv, true);
  assert.equal(keyed.name, 'small');
  assert.equal(keyed.port, 9200);
  assert.doesNotMatch(JSON.stringify(keyed), /not-a-real-key-x/, 'an --api-key value never leaves the parser');
  assert.equal(byPid[507].port, null, 'no --port: the socket decides');
  assert.equal(byPid[508].model, 'Vontra/ViaModule', 'python -m tensorfold serve');
  assert.equal(byPid[508].port, 9300);
  assert.equal(byPid[510].port, 9400, '--port=N');
  assert.equal(byPid[510].listenHost, '::');
});

test('Linux argv (exact, from /proc/<pid>/cmdline) keeps a value with spaces whole', () => {
  const e = parseServeArgv(7, ['/opt/tf/bin/tensorfold-native', 'serve', '/home/me/My Models/qwen', '--port', '9500', '--api-key-file', '/home/me/tf keys', '--slide']);
  assert.equal(e.model, 'qwen');
  assert.equal(e.port, 9500);
  assert.equal(e.apiKeyFile, '/home/me/tf keys');
  assert.equal(e.slide, true);
  const py = parseServeArgv(8, ['/usr/bin/python3', '/home/me/.venv/bin/tensorfold', 'serve', 'Vontra/X', '--host', '0.0.0.0']);
  assert.equal(py.model, 'Vontra/X');
  assert.equal(py.listenHost, '0.0.0.0');
  const key = parseServeArgv(9, ['/opt/tf/bin/tensorfold-native', 'serve', 'Vontra/X', '--api-key', 'argv-key-x', '--port', '9600']);
  assert.equal(key.keyOnArgv, true);
  assert.equal(key.port, 9600, 'the flag after a dropped key value still parses');
  assert.doesNotMatch(JSON.stringify(key), /argv-key-x/);
  assert.equal(parseServeArgv(10, ['/usr/bin/less', 'tensorfold', 'serve']), null);
  assert.equal(parseServeArgv(11, ['/opt/tf/bin/tensorfold-native', 'pull', 'Vontra/X']), null);
});

test('lsof listen lines, wildcard and IPv6 hosts, and Hugging Face cache paths', () => {
  assert.deepEqual(parseLsofListen(LSOF_STUDIO), [{ host: '127.0.0.1', port: 54635 }]);
  assert.deepEqual(parseLsofListen('p1\nf3\nn*:8080\nf4\nn[::1]:8081\n'), [{ host: '*', port: 8080 }, { host: '::1', port: 8081 }]);
  assert.equal(connectHost('*'), '127.0.0.1');
  assert.equal(connectHost('0.0.0.0'), '127.0.0.1');
  assert.equal(connectHost('::'), '::1');
  assert.equal(connectHost('100.101.102.103'), '100.101.102.103');
  assert.equal(repoFromPath('/Users/me/.cache/huggingface/hub/models--Vontra--Qwen3.8-27B-MLX-4bit/snapshots/70ae7f'), 'Vontra/Qwen3.8-27B-MLX-4bit');
  assert.equal(repoFromPath('/tmp/plain'), null);
});

// --- discovery as a whole ---------------------------------------------------------

/** A fake exec: `ps` answers with `ps`, `lsof` per pid from `lsof`. Records every call. */
function fakeExec({ ps = PS_LIVE, lsof = {}, lsofMissing = false, psFails = false } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ps') return psFails ? { ok: false, stdout: '', error: { code: 'EPERM' } } : { ok: true, stdout: ps, error: null };
    if (command === 'lsof') {
      if (lsofMissing) return { ok: false, stdout: '', error: { code: 'ENOENT' } };
      const pid = args[args.indexOf('-p') + 1];
      return { ok: true, stdout: lsof[pid] ?? '', error: lsof[pid] ? null : { code: 1 } };
    }
    throw new Error(`unexpected exec ${command}`);
  };
  return { exec, calls };
}

test('macOS discovery: one ps for this user, lsof only for an engine without --port, one engine per port', async () => {
  const { exec, calls } = fakeExec({ ps: `${PS_LIVE}${PS_DECOYS}`, lsof: { 507: 'p507\nf5\nn127.0.0.1:9700\n' } });
  const r = await discoverTensorFoldEngines({ platform: 'darwin', exec, uid: 501 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['ps', '-ww', '-U', '501', '-o', 'pid=,args=']);
  assert.ok(calls.every(c => !c.includes('-E') && !c.includes('e')), 'never asks ps for environments');
  assert.deepEqual(calls.filter(c => c[0] === 'lsof').map(c => c[c.indexOf('-p') + 1]), ['507']);
  assert.deepEqual(r.engines.map(e => [e.port, e.portFrom, e.host]), [
    [8091, 'args', '127.0.0.1'], [8101, 'args', '127.0.0.1'], [54635, 'args', '127.0.0.1'],
    [9123, 'args', '127.0.0.1'], [9200, 'args', '127.0.0.1'], [9700, 'socket', '127.0.0.1'],
    [9300, 'args', '127.0.0.1'], [9400, 'args', '::1'],
  ], 'pid 509 shares port 9200 with 506 and is dropped');
});

test('no --port: a process with no listening socket is left out; without lsof the default port stands in', async () => {
  const line = '  700 /opt/tf/bin/tensorfold-native serve Vontra/Loading --name loading\n';
  const quiet = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ ps: line }).exec, uid: 501 });
  assert.deepEqual(quiet.engines, [], 'still loading (or not an engine): no card until it listens');
  const blind = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ ps: line, lsofMissing: true }).exec, uid: 501 });
  assert.deepEqual(blind.engines.map(e => [e.port, e.portFrom]), [[DEFAULT_ENGINE_PORT, 'default']]);
});

test('a failed process scan is ok:false with the reason, never a throw and never "no engines" silently', async () => {
  const r = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ psFails: true }).exec, uid: 501 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ps failed/);
  assert.deepEqual(r.engines, []);
});

test('Linux discovery reads /proc: this user only, comm first, cmdline exactly, never environ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iak-tf-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = async (pid, comm, argv) => {
    await mkdir(join(root, String(pid)));
    await writeFile(join(root, String(pid), 'comm'), `${comm}\n`);
    await writeFile(join(root, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    await writeFile(join(root, String(pid), 'environ'), `TENSORFOLD_API_KEY=${DUMMY_KEY}\0`);
  };
  await proc(100, 'tensorfold-nati', ['/opt/tf/bin/tensorfold-native', 'serve', 'Vontra/A', '--port', '9801']);
  await proc(101, 'tensorfold', ['/usr/bin/python3', '/home/me/.venv/bin/tensorfold', 'serve', 'Vontra/B', '--port', '9802']);
  await proc(102, 'bash', ['/bin/bash', '-c', 'tensorfold-native serve Vontra/C --port 9803']);
  await mkdir(join(root, 'self'));
  const reads = [];
  const fs = {
    readdir: async p => (await import('node:fs/promises')).readdir(p),
    stat: async p => (await import('node:fs/promises')).stat(p),
    readFile: async (p, enc) => { reads.push(p); return (await import('node:fs/promises')).readFile(p, enc); },
  };
  const r = await discoverTensorFoldEngines({ platform: 'linux', procRoot: root, uid: process.getuid(), fs, exec: fakeExec().exec });
  assert.deepEqual(r.engines.map(e => [e.port, e.model]), [[9801, 'Vontra/A'], [9802, 'Vontra/B']]);
  assert.ok(!reads.some(p => p.endsWith('/environ')), 'never reads a process environment');
  assert.ok(!reads.some(p => p.endsWith('/102/cmdline')), 'argv is read only for candidate processes');
  const other = await discoverTensorFoldEngines({ platform: 'linux', procRoot: root, uid: process.getuid() + 1, fs, exec: fakeExec().exec });
  assert.deepEqual(other.engines, [], "another user's processes are not scanned");
});

// --- merging with the registry, and reading the engines -------------------------

test('merge by port: the registry keeps its id, an unnamed entry needs no detection, other engines stay skipped', async t => {
  const a = await tfServer(t, openNativeRoutes());
  const b = await tfServer(t, openNativeRoutes());
  const c = await tfServer(t, openNativeRoutes());
  const d = await tfServer(t, openNativeRoutes());
  const entries = loadRegistry([
    { id: 'plain', host: 'localhost', port: a.port, kind: 'openai' },
    { id: 'marked', host: '127.0.0.1', port: b.port, kind: 'openai', engine: 'tensorfold' },
    { id: 'other', host: '127.0.0.1', port: c.port, kind: 'openai', engine: 'vllm' },
  ]);
  const discovered = [
    engine(a.port, { name: 'bench', model: 'bench' }),
    engine(b.port, { name: 'marked-engine' }),
    engine(c.port),
    engine(d.port, { name: STUDIO_MODEL, model: STUDIO_MODEL, app: STUDIO_APP_NAME }),
    engine(d.port, { name: 'duplicate' }),
  ];
  const { servers, skipped } = await collectTensorFoldStatus(entries, { discovered, scope: 'local' });
  assert.deepEqual(servers.map(s => [s.id, s.source, s.name, s.app, s.local]), [
    ['plain', 'discovered', 'bench', null, true],
    ['marked', 'registry', 'marked-engine', null, true],
    [STUDIO_MODEL, 'discovered', STUDIO_MODEL, STUDIO_APP_NAME, true],
  ]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /registry says engine "vllm" \(a TensorFold process listens on this port\)/);
  assert.equal(c.seen.length, 0, 'an entry the registry calls something else is not asked');
  assert.ok(servers.every(s => s.metrics === METRICS_STATES.OK));
  for (const s of [a, b, d]) assertGetOnly(s.seen);
  const plain = servers[0];
  assert.deepEqual(plain.draft, { drafted: 10231, accepted: 2580, acceptance: 0.252 }, 'the native bench recording reads through');
  assert.equal(plain.decode_tok_s, 0);
  assert.equal(plain.memory.footprint_gb, 43.6);
  assert.equal(plain.memory.used_gb, null, 'footprint is its own field, never passed off as engine memory');
  assert.deepEqual(plain.living_weights, { available: true, facts: 0, learning: 0, learned: 0 });
});

test('the Studio engine: keyed /health, no key file, so metrics auth_required with the reason, and the model from its command line', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const { servers } = await collectTensorFoldStatus([], {
    discovered: [engine(port, { name: STUDIO_MODEL, model: STUDIO_MODEL, app: STUDIO_APP_NAME })],
  });
  const s = servers[0];
  assertGetOnly(seen);
  assert.ok(seen.every(r => r.auth === null), 'no key exists to send, and none is invented');
  assert.equal(s.reachable, true);
  assert.equal(s.metrics, METRICS_STATES.AUTH_REQUIRED);
  assert.match(s.reason, /metrics: auth required; TensorFold Studio keeps this engine's key in memory only/);
  assert.equal(s.model, STUDIO_MODEL);
  assert.equal(s.model_source, 'args');
  assert.equal(s.warming, null);
  assert.deepEqual(s.requests, { running: null, waiting: null });
  assert.equal(s.living_weights.available, null);
});

test('a keyed engine started with --api-key-file: the key goes to /metrics and the graph only, never /health, never out', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const path = await keyFile(t, `# engine keys\n\nops: ${DUMMY_KEY}\nother-key-not-used\n`);
  const { servers } = await collectTensorFoldStatus([], { discovered: [engine(port, { name: 'keyed', apiKeyFile: path })] });
  assertGetOnly(seen);
  const auth = Object.fromEntries(seen.map(r => [r.line, r.auth]));
  assert.equal(auth['GET /health'], null);
  assert.equal(auth['GET /metrics'], `Bearer ${DUMMY_KEY}`);
  assert.equal(auth['GET /v1/slide/graph'], `Bearer ${DUMMY_KEY}`);
  assert.equal(servers[0].metrics, METRICS_STATES.OK);
  assert.equal(servers[0].tokens.generation_total, 6134);
  assert.doesNotMatch(JSON.stringify(servers), new RegExp(DUMMY_KEY));
});

test('key files the engine itself would refuse are refused, and a relative path is never guessed at', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const shared = await keyFile(t, `${DUMMY_KEY}\n`, 0o644);
  const cases = [
    [engine(port, { apiKeyFile: shared }), /readable by other users; chmod 600/],
    [engine(port, { apiKeyFile: 'keys/tf.txt' }), /relative path/],
    [engine(port, { apiKeyFile: join(tmpdir(), 'iak-tf-no-such', 'keys') }), /cannot read key file .* \(ENOENT\)/],
    [engine(port, { keyOnArgv: true }), /given on the engine's command line; it is not read from there/],
    [engine(port), /started without --api-key-file/],
  ];
  for (const [e, why] of cases) {
    const { servers } = await collectTensorFoldStatus([], { discovered: [e] });
    assert.equal(servers[0].metrics, METRICS_STATES.AUTH_REQUIRED);
    assert.match(servers[0].reason, why);
  }
  assert.ok(seen.every(r => r.auth === null));
});

test('readEngineKeyFile reads the engine format: comments, labels, bare keys, the first key wins', async t => {
  assert.equal((await readEngineKeyFile(await keyFile(t, `# c\n  lab: ${DUMMY_KEY}  \nsecond\n`))).token, DUMMY_KEY);
  assert.equal((await readEngineKeyFile(await keyFile(t, `\n${DUMMY_KEY}\n`))).token, DUMMY_KEY);
  const empty = await readEngineKeyFile(await keyFile(t, '# nothing\n\n'));
  assert.equal(empty.token, null);
  assert.match(empty.note, /holds no key/);
});

// --- the heartbeat -----------------------------------------------------------------

test('monitor: discovery alone turns it on; the snapshot says whether discovery ran', async t => {
  const { port } = await tfServer(t, openNativeRoutes());
  const scans = [];
  const m = new TensorFoldMonitor({
    registryPath: '', discover: true, intervalMs: 60000,
    discoverImpl: async () => { scans.push(1); return { ok: true, error: null, engines: [engine(port, { name: 'bench', model: 'bench' })] }; },
  });
  assert.equal(m.enabled, true);
  assert.match(m.describe(), /^no registry .*discovery on/);
  await m.refresh();
  const { tensorfold } = m.fields();
  assert.equal(tensorfold.error, null);
  assert.equal(tensorfold.discovery, 'ok');
  assert.deepEqual(tensorfold.servers.map(s => [s.id, s.source, s.port]), [['bench', 'discovered', port]]);
  assert.equal(scans.length, 1);
  assert.throws(() => new TensorFoldMonitor({ discover: 'sometimes' }), /INTENT_TENSORFOLD_DISCOVER/);
});

test('monitor: a failed scan is "unavailable" on the card and warned once; a broken registry still shows discovered engines', async t => {
  const { port } = await tfServer(t, openNativeRoutes());
  const warnings = [];
  const failing = new TensorFoldMonitor({
    entries: [], discover: true, warn: w => warnings.push(w),
    discoverImpl: async () => ({ ok: false, error: 'ps failed (EPERM)', engines: [] }),
  });
  await failing.refresh();
  await failing.refresh();
  assert.equal(failing.fields().tensorfold.discovery, 'unavailable');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /engine discovery unavailable: ps failed \(EPERM\)/);

  const broken = new TensorFoldMonitor({
    registryPath: join(tmpdir(), 'iak-tf-no-such-registry', 'models.json'), warn: () => {},
    discoverImpl: async () => ({ ok: true, error: null, engines: [engine(port, { name: 'bench' })] }),
  });
  await broken.refresh();
  const snap = broken.fields().tensorfold;
  assert.match(snap.error, /^registry unreadable: /);
  assert.deepEqual(snap.servers.map(s => s.id), ['bench'], 'discovery is on by default with a registry path, and still reports');
});
