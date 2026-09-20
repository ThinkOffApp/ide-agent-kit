// SPDX-License-Identifier: AGPL-3.0-only
//
// One test per state, plus the negative controls that make the states mean
// something: an unreachable host must not render as DOWN, a busy box must not
// render as UP, a LAN IP must not load at all, and - the one that failed live
// - a 401 with a key must not print the same line as a 401 without one.
//
// Every credential test uses DUMMY_TOKEN, a made-up string, and the suite
// asserts it appears in no output anywhere. A test fixture that carried a real
// key would publish it: this repository is public and the fixtures are in it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  probeModels,
  loadRegistry,
  resolveEntryToken,
  AUTH_MISSING_REASON,
  AUTH_REJECTED_REASON,
  KEY_SOURCES,
  lanIpReason,
  parseFreeMemGiB,
  findExclusiveProcess,
  parseTailscalePath,
  summariseLatency,
  percentile,
  stddev,
  sshArgv,
  tailscalePingArgv,
  defaultCallerHost,
  resolveCallerHost,
  RegistryError,
} from '../packages/user-intent-kit/src/model-capacity.js';

// --- helpers ---------------------------------------------------------------

/** An in-process endpoint on loopback. Loopback is allowed by the LAN rule. */
async function endpoint(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => new Promise(r => server.close(r)) };
}

const jsonEndpoint = (body, status = 200) => endpoint((req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

/** A fake ssh: returns whatever the real remote script would have printed. */
function fakeExec({ mem = '', gpu = null, proc = '', code = 0, stderr = '', tsPing = null, tsCode = 0 } = {}) {
  const calls = [];
  const fn = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === 'tailscale') {
      if (tsPing === null) return { code: 1, stdout: '', stderr: 'tailscale: command not found' };
      return { code: tsCode, stdout: tsPing, stderr: '' };
    }
    // `mem` goes in the GPU section by default, matching the old shorthand;
    // pass `gpu` explicitly to exercise the nvidia-smi -> free fallback.
    const gpuText = gpu === null ? mem : gpu;
    const sysText = gpu === null ? '' : mem;
    return { code, stderr, stdout: `__GPU__\n${gpuText}\n__SYS__\n${sysText}\n__PROC__\n${proc}\n__END__\n` };
  };
  fn.calls = calls;
  fn.sshCalls = () => calls.filter(c => c.argv[0] === 'ssh');
  return fn;
}

// Keep the suite quick: 1 sample unless a test is specifically about spread.
const FAST = { latencySamples: 1 };
const probe = (registry, opts = {}) => probeModels(registry, { ...FAST, ...opts });

const GPU_IDLE = '1024, 81920';        // ~78 GiB free
const GPU_FULL = '79000, 81920';       // ~2.9 GiB free
const FREE_IDLE = 'Mem:  125  10  90  0  25  114';

const entry = (port, extra = {}) => ({
  id: 'unit', host: '127.0.0.1', port, kind: 'openai', sharing: 'shared', box: null, owner: null, ...extra,
});

const ONE_MODEL = { data: [{ id: 'qwen3-coder-30b' }] };

// --- credential helpers ----------------------------------------------------

// Made up on the spot. Nothing in this repository may contain a real one, and
// `assertNoToken` below is what keeps that from degrading into a promise.
const DUMMY_TOKEN = 'dummy-token-not-a-real-key-7f3a';

/** A key file on disk with a mode, because the mode check is a real stat(2). */
async function keyFileWith(contents, mode = 0o600, name = 'key.txt') {
  const dir = await mkdtemp(join(tmpdir(), 'mc-auth-'));
  const path = join(dir, name);
  await writeFile(path, contents);
  await chmod(path, mode);
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * An endpoint that wants a bearer token: 401 without the right one, the model
 * list with it. It also records every Authorization header it saw, so a test
 * can assert what was on the wire rather than what the result claims.
 */
async function bearerEndpoint(expected, { body = ONE_MODEL, status = 401 } = {}) {
  const seen = [];
  const server = await endpoint((req, res) => {
    seen.push(req.headers.authorization ?? null);
    if (expected !== null && req.headers.authorization === `Bearer ${expected}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  });
  server.seen = seen;
  return server;
}

/**
 * The rule the whole feature rests on: a token is read in-process and goes
 * into one header. It must not be reachable from any string the probe hands
 * back - not the reason, not a warning, not a nested field, not the JSON the
 * CLI prints.
 */
function assertNoToken(...values) {
  for (const v of values) {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    assert.ok(!text.includes(DUMMY_TOKEN), `the token leaked into output: ${text}`);
    assert.ok(!/Bearer\s/.test(text), `an Authorization header leaked into output: ${text}`);
  }
}

// --- one test per state ----------------------------------------------------

test('UP: endpoint serves a model and the box has room', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'UP');
    assert.deepEqual(r.models, ['qwen3-coder-30b']);
    assert.equal(r.freeMemGiB, 79);
    assert.equal(r.capacityUnknown, false);
    assert.equal(r.busyReason, null);
    assert.ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0);
  } finally { await server.close(); }
});

test('BUSY: a live exclusive job on the box, even though the endpoint answers', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const exec = fakeExec({ mem: GPU_IDLE, proc: '4711 /opt/ltx/bin/ltx --render scene.yaml' });
    const [r] = await probe([entry(server.port)], { exec });
    // NEGATIVE CONTROL: a busy box must never be offered as UP.
    assert.notEqual(r.state, 'UP');
    assert.equal(r.state, 'BUSY');
    assert.match(r.busyReason, /exclusive job running: ltx \(pid 4711\)/);
    // It still answered, so the model list is real data and must survive.
    assert.deepEqual(r.models, ['qwen3-coder-30b']);
  } finally { await server.close(); }
});

test('BUSY: free memory under the threshold', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_FULL }) });
    assert.notEqual(r.state, 'UP');
    assert.equal(r.state, 'BUSY');
    assert.match(r.busyReason, /2\.9 GiB free, threshold 8 GiB/);
  } finally { await server.close(); }
});

test('DOWN: connects, but /v1/models errors', async () => {
  const server = await jsonEndpoint({ error: 'no engine' }, 503);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'DOWN');
    assert.match(r.reason, /HTTP 503/);
    assert.deepEqual(r.models, []);
  } finally { await server.close(); }
});

test('DOWN: connects, answers 200, lists nothing', async () => {
  const server = await jsonEndpoint({ object: 'list', data: [] });
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'DOWN');
    assert.match(r.reason, /lists no loaded model/);
  } finally { await server.close(); }
});

test('UNREACHABLE: the name does not resolve', async () => {
  const [r] = await probe(
    [entry(8000, { id: 'bogus', host: 'nowhere.invalid' })],
    { exec: fakeExec({ code: 255, stderr: 'ssh: Could not resolve hostname' }), timeoutMs: 6000 });
  // NEGATIVE CONTROL: a host we never reached must not be reported as DOWN.
  // DOWN says "the server is broken, go start it"; UNREACHABLE says "the
  // network or the name is broken". Opposite actions, so never the same word.
  assert.notEqual(r.state, 'DOWN');
  assert.equal(r.state, 'UNREACHABLE');
  assert.deepEqual(r.models, []);
  assert.equal(r.freeMemGiB, null);
  assert.equal(r.capacityUnknown, true);
});

test('UNREACHABLE: TCP connect refused on a closed port', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  const closedPort = server.port;
  await server.close();
  const [r] = await probe([entry(closedPort)], { exec: fakeExec({ mem: GPU_IDLE }) });
  assert.notEqual(r.state, 'DOWN');
  assert.equal(r.state, 'UNREACHABLE');
  assert.match(r.reason, /connect failed/);
});

// --- a failed capacity read is never a clean bill of health ----------------

test('ssh failure leaves the HTTP state intact and says capacity is unknown', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const exec = fakeExec({ code: 255, stderr: 'Permission denied (publickey).' });
    const [r] = await probe([entry(server.port)], { exec });
    assert.equal(r.state, 'UP');
    assert.equal(r.freeMemGiB, null);
    assert.equal(r.capacityUnknown, true);
    assert.match(r.reason, /capacity unknown/);
    assert.match(r.reason, /Permission denied/);
  } finally { await server.close(); }
});

test('a box with neither nvidia-smi nor free(1) reports capacityUnknown, not 0 GiB', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: '' }) });
    assert.equal(r.freeMemGiB, null);
    assert.equal(r.capacityUnknown, true);
    assert.notEqual(r.state, 'BUSY'); // unknown must not be read as "no memory"
    assert.equal(r.state, 'UP');
  } finally { await server.close(); }
});

// --- the ssh command itself ------------------------------------------------

test('capacity is read over BatchMode ssh with a connect timeout', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const exec = fakeExec({ mem: FREE_IDLE });
    await probe([entry(server.port, { host: '127.0.0.1' })], { exec, timeoutMs: 4000 });
    const [{ argv, options }] = exec.sshCalls();
    assert.equal(argv[0], 'ssh');
    assert.ok(argv.includes('BatchMode=yes'), 'never prompt for a password');
    assert.ok(argv.includes('ConnectTimeout=5'));
    assert.match(argv.at(-1), /nvidia-smi --query-gpu=memory\.used,memory\.total/);
    assert.match(argv.at(-1), /free -g/);
    assert.match(argv.at(-1), /pgrep -fl/);
    assert.equal(options.timeoutMs, 4000);
  } finally { await server.close(); }
});

test('a unified-memory box (nvidia-smi prints "[N/A]") falls back to free -g', async () => {
  // Measured on asus1, an ASUS Ascent GX10: nvidia-smi exits 0 and prints
  // "[N/A], [N/A]" because Grace Blackwell memory is unified. A shell-level
  // `nvidia-smi || free -g` would never fall back, and the box would report
  // capacityUnknown forever.
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const exec = fakeExec({ gpu: '[N/A], [N/A]', mem: FREE_IDLE });
    const [r] = await probe([entry(server.port)], { exec });
    assert.equal(r.capacityUnknown, false);
    assert.equal(r.freeMemGiB, 114);
    assert.equal(r.state, 'UP');
  } finally { await server.close(); }
});

test('the remote pgrep matching its own shell is not an exclusive job', () => {
  // Measured on asus1: `pgrep -fl 'grid|cgpt|...'` matches the bash running
  // our own probe script, because the pattern is in that command line.
  assert.equal(findExclusiveProcess('1624214 bash'), null);
});

test('sshArgv is read-only: no write verbs in the remote script', () => {
  const script = sshArgv('asus1').at(-1);
  for (const verb of ['rm ', 'kill', 'systemctl', 'shutdown', 'mv ', 'chmod', 'tee ', 'dd ']) {
    assert.ok(!script.includes(verb), `remote script must not contain ${JSON.stringify(verb)}`);
  }
  // The only redirection allowed is throwing stderr away.
  for (const redirect of script.match(/[12]?>>?\s*[^\s;|&]+/g) || []) {
    assert.match(redirect, /^2>\/dev\/null$/, `unexpected redirection ${redirect}`);
  }
});

// --- the LAN-IP rule -------------------------------------------------------

test('LAN IPs are rejected at load with a message that says why', () => {
  for (const host of ['10.0.0.5', '192.168.1.50', '172.16.4.4', '172.31.255.1']) {
    assert.throws(
      () => loadRegistry([{ id: 'x', host, port: 8000, kind: 'openai' }]),
      err => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, /private LAN address/);
        assert.match(err.message, /tailnet MagicDNS/);
        assert.match(err.message, /--allow-lan/);
        return true;
      },
      `${host} must be rejected`);
  }
});

test('NEGATIVE CONTROL: the LAN check does not reject what it must accept', () => {
  // If this passed while the check were "reject every host", the test above
  // would prove nothing. Tailnet names, tailnet CGNAT IPs, loopback and the
  // 172.32 address just outside the private block must all load.
  for (const host of ['asus1', 'mini', '100.101.102.103', '127.0.0.1', 'localhost', '172.32.0.1', '11.0.0.1']) {
    const [e] = loadRegistry([{ id: 'x', host, port: 8000, kind: 'openai' }]);
    assert.equal(e.host, host);
    assert.equal(e.lanOverride, false);
    assert.equal(lanIpReason(host), null);
  }
});

test('--allow-lan loads a LAN entry and flags it', () => {
  const [e] = loadRegistry([{ id: 'x', host: '192.168.1.50', port: 8000, kind: 'openai' }], { allowLan: true });
  assert.equal(e.lanOverride, true);
});

test('registry validation rejects bad kinds, ports, sharing and duplicate ids', () => {
  const ok = { id: 'a', host: 'asus1', port: 8000, kind: 'openai' };
  assert.throws(() => loadRegistry([{ ...ok, kind: 'ollama' }]), /kind "ollama"/);
  assert.throws(() => loadRegistry([{ ...ok, port: '8000' }]), /port must be an integer/);
  assert.throws(() => loadRegistry([{ ...ok, port: 70000 }]), /port must be an integer/);
  assert.throws(() => loadRegistry([{ ...ok, sharing: 'sometimes' }]), /sharing "sometimes"/);
  assert.throws(() => loadRegistry([ok, ok]), /duplicate id "a"/);
  assert.throws(() => loadRegistry([]), /registry is empty/);
  assert.throws(() => loadRegistry({ nope: 1 }), /must be a JSON array/);
  const [e] = loadRegistry({ models: [ok] });
  assert.equal(e.sharing, 'shared', 'sharing defaults to shared');
});

// --- lmstudio shape (reconcile with model-discovery.js when that branch lands)

test('lmstudio counts loaded instances, not downloaded models', async () => {
  const server = await endpoint((req, res) => {
    assert.equal(req.url, '/api/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [
      { type: 'llm', loaded_instances: [{ id: 'gpt-oss-20b' }] },
      { type: 'llm', loaded_instances: [] },
      { type: 'embedding', loaded_instances: [{ id: 'nomic' }] },
    ] }));
  });
  try {
    const [r] = await probe([entry(server.port, { kind: 'lmstudio' })], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'UP');
    assert.deepEqual(r.models, ['gpt-oss-20b']);
  } finally { await server.close(); }
});

test('an lmstudio box with nothing loaded is DOWN, not UP with zero models', async () => {
  const server = await jsonEndpoint({ models: [{ type: 'llm', loaded_instances: [] }] });
  try {
    const [r] = await probe([entry(server.port, { kind: 'lmstudio' })], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'DOWN');
  } finally { await server.close(); }
});

// --- parsers ---------------------------------------------------------------

test('parseFreeMemGiB sums free across GPUs and prefers `available` from free -g', () => {
  assert.equal(parseFreeMemGiB('1024, 81920'), 79);
  assert.equal(parseFreeMemGiB('1024, 81920\n1024, 81920'), 158);
  assert.equal(parseFreeMemGiB('              total used free shared buff/cache available\nMem:  125  10  90  0  25  114'), 114);
  assert.equal(parseFreeMemGiB(''), null);
  assert.equal(parseFreeMemGiB('bash: nvidia-smi: command not found'), null);
});

test('findExclusiveProcess matches the process name, not any path containing it', () => {
  assert.equal(findExclusiveProcess('2001 /usr/bin/grid --serve').name, 'grid');
  assert.equal(findExclusiveProcess('2002 cgpt').name, 'cgpt');
  assert.equal(findExclusiveProcess('2003 /opt/Grid/bin/Grid').name, 'Grid');
  assert.equal(findExclusiveProcess('2004 /home/p/ltx25/bin/python3.11 infer.py').name, 'ltx25 venv python');
  // NEGATIVE CONTROL: a mere path component must not fake a running job, or
  // every box with a /var/grid log directory would read as BUSY forever.
  assert.equal(findExclusiveProcess('2005 /var/grid/logs/tail.sh'), null);
  assert.equal(findExclusiveProcess('2006 /usr/bin/python3 /srv/ltx25-notes/readme.py'), null);
  assert.equal(findExclusiveProcess(''), null);
});

// --- parallelism and the per-entry budget ----------------------------------

test('entries are probed in parallel and no entry outlives timeoutMs', async () => {
  const slow = await endpoint(() => { /* never answers */ });
  try {
    const registry = [
      entry(slow.port, { id: 'slow-a' }),
      entry(slow.port, { id: 'slow-b' }),
      entry(slow.port, { id: 'slow-c' }),
    ];
    const started = Date.now();
    const results = await probe(registry, { exec: fakeExec({ mem: GPU_IDLE }), timeoutMs: 700 });
    const elapsed = Date.now() - started;
    assert.equal(results.length, 3);
    assert.ok(elapsed < 2100, `three 700ms probes ran in parallel, took ${elapsed}ms`);
    for (const r of results) {
      assert.equal(r.state, 'UNREACHABLE');
      assert.match(r.reason, /no response within/);
    }
  } finally { await slow.close(); }
});

test('with no key configured, probeModels sends no Authorization header, and never follows a redirect', async () => {
  const seen = [];
  const server = await endpoint((req, res) => {
    seen.push(req.headers);
    res.writeHead(302, { location: 'http://example.com/v1/models' });
    res.end();
  });
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'DOWN', 'a redirecting endpoint is not serving models');
    // An entry with no auth mode and no key gets no header. The header is
    // sent when a token exists FOR THAT ENTRY, never as a blanket default.
    assert.equal(seen[0].authorization, undefined);
    assert.equal(seen[0].cookie, undefined);
    assert.equal(r.keySource, null);
    assert.equal(r.auth, 'none');
  } finally { await server.close(); }
});

test('a redirect is still refused when a token IS configured, so the header never reaches the new host', async () => {
  // `redirect: "error"` matters more once there is something to leak: a 302
  // to an arbitrary host would otherwise be handed the Authorization header.
  const hits = [];
  const server = await endpoint((req, res) => {
    hits.push(req.headers.authorization);
    res.writeHead(302, { location: 'http://example.com/v1/models' });
    res.end();
  });
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const [r] = await probe([entry(server.port, { auth: 'bearer', keyFile: key.path })],
      { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'DOWN');
    assert.match(r.reason, /request failed/);
    assert.equal(hits.length, 1, 'exactly one request: the redirect was not followed');
    assertNoToken(r);
  } finally { await server.close(); await key.cleanup(); }
});

test('every result carries exactly one known state and a reason', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const results = await probe(
      [entry(server.port, { id: 'a' }), entry(8000, { id: 'b', host: 'nowhere.invalid' })],
      { exec: fakeExec({ mem: GPU_IDLE }), timeoutMs: 6000 });
    assert.equal(results.length, 2, 'one line per entry, every run - silence is impossible');
    for (const r of results) {
      assert.ok(['UP', 'BUSY', 'DOWN', 'UNREACHABLE'].includes(r.state));
      assert.ok(r.reason && r.reason.length, `${r.id} must explain itself`);
      assert.ok(r.checkedAt);
    }
    assert.notEqual(results[0].state, results[1].state);
  } finally { await server.close(); }
});

// --- path is a SEPARATE axis from capacity --------------------------------

test('parseTailscalePath reads DERP as relayed and an ip:port as direct', () => {
  assert.equal(parseTailscalePath('pong from asus1 (100.64.195.32) via DERP(hel) in 63ms'), 'relayed');
  assert.equal(parseTailscalePath('pong from asus1 (100.64.195.32) via 93.184.1.2:41641 in 35ms'), 'direct');
  assert.equal(parseTailscalePath('pong from mini (100.97.140.13) via [2001:db8::1]:41641 in 4ms'), 'direct');
  // NEGATIVE CONTROL: absence of evidence is `unknown`, never `direct`. A
  // switcher that reads "direct" off a missing binary picks the wrong box.
  assert.equal(parseTailscalePath(''), 'unknown');
  assert.equal(parseTailscalePath('tailscale: command not found'), 'unknown');
  assert.equal(parseTailscalePath('no matching peer'), 'unknown');
});

test('path is measured even when the endpoint is UNREACHABLE, and does not change the state', async () => {
  const exec = fakeExec({ tsPing: 'pong from asus1 (100.64.195.32) via DERP(hel) in 63ms' });
  const [r] = await probe([entry(8000, { id: 'far', host: 'nowhere.invalid' })], { exec, timeoutMs: 6000 });
  assert.equal(r.state, 'UNREACHABLE');
  assert.equal(r.path, 'relayed', 'the path is its own axis, not a function of the state');
  assert.ok(exec.calls.some(c => c.argv[0] === 'tailscale' && c.argv.includes('nowhere.invalid')));
  assert.deepEqual(tailscalePingArgv('asus1'), ['tailscale', 'ping', '-c', '1', 'asus1']);
});

test('an idle box on a relayed path still reports the path beside its capacity', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const exec = fakeExec({ mem: GPU_IDLE, tsPing: 'pong via DERP(hel) in 190ms' });
    // Loopback has no tailnet path, so this asserts the honest `unknown`.
    const [r] = await probe([entry(server.port)], { exec });
    assert.equal(r.state, 'UP');
    assert.equal(r.freeMemGiB, 79, 'capacity axis');
    assert.equal(r.path, 'unknown', 'path axis');
    assert.match(r.pathReason, /loopback, no tailnet path/);
  } finally { await server.close(); }
});

// --- latency is never one number ------------------------------------------

test('percentile and stddev', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([63, 400], 90), 400, 'p90 of two samples is the slow one');
  assert.equal(percentile([], 90), null);
  assert.equal(Math.round(stddev([63, 167, 263])), 82);
  assert.equal(stddev([5]), null, 'one sample has no spread');
});

test('summariseLatency reports p90 and spread, and refuses to fake a spread', () => {
  const many = summariseLatency([63, 90, 140, 200, 410]);
  assert.equal(many.samples, 5);
  assert.equal(many.minMs, 63);
  assert.equal(many.p90Ms, 410);
  assert.ok(many.jitterMs > 100, `spread measured, got ${many.jitterMs}`);
  assert.equal(many.singleSample, false);
  // NEGATIVE CONTROL: one sample has no spread. Reporting jitter 0 would read
  // as a rock-steady link, which is the opposite of what one sample proves.
  const one = summariseLatency([63]);
  assert.equal(one.samples, 1);
  assert.equal(one.p90Ms, 63);
  assert.equal(one.jitterMs, null);
  assert.equal(one.singleSample, true);
  const none = summariseLatency([]);
  assert.equal(none.samples, 0);
  assert.equal(none.p90Ms, null);
  assert.equal(none.jitterMs, null);
});

test('a reachable endpoint is sampled several times and reports p90 over the spread', async () => {
  let n = 0;
  const server = await endpoint((req, res) => {
    n++;
    // Make one sample slow, the way a relayed hop does.
    const delay = n === 3 ? 260 : 5;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ONE_MODEL));
    }, delay);
  });
  try {
    const [r] = await probeModels([entry(server.port)], {
      exec: fakeExec({ mem: GPU_IDLE }), timeoutMs: 8000, latencySamples: 5, latencySpreadMs: 1200,
    });
    assert.equal(r.state, 'UP');
    assert.ok(r.latencySamples >= 3, `took several samples, got ${r.latencySamples}`);
    assert.equal(r.latencyMs, r.p90Ms, 'the headline latency IS the p90, not a lucky single ping');
    // NEGATIVE CONTROL: the p90 must not be the fastest sample. If it were,
    // a link that is fast once and slow four times would rank as fast.
    assert.ok(r.p90Ms > r.minMs, `p90 ${r.p90Ms} must exceed min ${r.minMs}`);
    assert.ok(r.p90Ms >= 200, `p90 ${r.p90Ms} must carry the slow sample`);
    assert.ok(r.jitterMs > 0, 'spread measured');
    assert.ok(!/1 sample only/.test(r.reason));
  } finally { await server.close(); }
});

test('a single-sample run says the spread is unmeasured rather than implying steadiness', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const [r] = await probeModels([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), latencySamples: 1 });
    assert.equal(r.latencySamples, 1);
    assert.equal(r.jitterMs, null);
    assert.match(r.reason, /latency from 1 sample only, spread unmeasured/);
  } finally { await server.close(); }
});

test('an UNREACHABLE entry reports no latency at all, not the connect-failure time', async () => {
  const exec = fakeExec({ tsPing: 'pong via DERP(hel) in 190ms' });
  const [r] = await probe([entry(8000, { id: 'far', host: 'nowhere.invalid' })], { exec, timeoutMs: 6000 });
  assert.equal(r.state, 'UNREACHABLE');
  // NEGATIVE CONTROL: how fast a DNS failure bounced is not a round trip to a
  // model server. Printing it as latency would make the least usable entry
  // look like the fastest one.
  assert.equal(r.latencySamples, 0);
  assert.equal(r.latencyMs, null);
  assert.equal(r.p90Ms, null);
  assert.equal(r.jitterMs, null);
});

test('a DOWN entry keeps its latency, because it really did answer', async () => {
  const server = await jsonEndpoint({ error: 'no engine' }, 503);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }) });
    assert.equal(r.state, 'DOWN');
    assert.equal(r.latencySamples, 1);
    assert.ok(typeof r.p90Ms === 'number');
  } finally { await server.close(); }
});

// --- path is per PEER PAIR, so results are stamped with who measured them --

test('a registry carrying a measurement field is rejected with a message that says why', () => {
  // Measured tonight: M5 and mini, same Helsinki router, same Berlin target -
  // M5 direct at 03:20 while mini had been relayed since 02:22. A `path`
  // written into a shared registry file is therefore wrong for everyone
  // except whoever wrote it, so the loader refuses it outright.
  for (const field of ['path', 'latencyMs', 'p90Ms', 'jitterMs', 'freeMemGiB', 'state']) {
    assert.throws(
      () => loadRegistry([{ id: 'x', host: 'asus1', port: 8000, kind: 'openai', [field]: 'whatever' }]),
      err => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, new RegExp(`remove "${field}"`));
        assert.match(err.message, /per peer pair/);
        return true;
      },
      `${field} must be refused in the registry`);
  }
});

test('NEGATIVE CONTROL: the measurement-field check does not reject a clean entry', () => {
  // If it rejected everything, the test above would prove nothing.
  const [e] = loadRegistry([{
    id: 'x', host: 'asus1', port: 8000, kind: 'vllm', box: 'GX10', sharing: 'exclusive', owner: '@petrus',
  }]);
  assert.equal(e.id, 'x');
  assert.equal(e.host, 'asus1');
});

test('every result names the host that measured it, and scopes the path to that host', async () => {
  const server = await jsonEndpoint(ONE_MODEL);
  try {
    const [mini] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), callerHost: 'mini' });
    const [m5] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), callerHost: 'm5' });
    assert.equal(mini.from, 'mini');
    assert.equal(m5.from, 'm5');
    assert.equal(mini.pathScope, 'per-caller-host');
    // Capacity is per target, so the two agree there. The stamp is what keeps
    // a path reading from being reused by the host that did not take it.
    assert.equal(mini.freeMemGiB, m5.freeMemGiB);
  } finally { await server.close(); }
});

test('defaultCallerHost returns a usable short name', () => {
  const h = defaultCallerHost();
  assert.equal(typeof h, 'string');
  assert.ok(h.length > 0);
  assert.ok(!/\.local\.?$/i.test(h), 'the .local suffix is stripped');
});

test('resolveCallerHost prefers the tailnet name over the router-assigned hostname', async () => {
  // os.hostname() gives "Petruss-MBP.box" on the Berlin router: a name no peer
  // can match to the other end of the path being measured.
  const tailnet = async () => ({ code: 0, stdout: JSON.stringify({ Self: { DNSName: 'mb.tailc88873.ts.net.' } }), stderr: '' });
  assert.equal(await resolveCallerHost({ exec: tailnet }), 'mb');
  // NEGATIVE CONTROL: no tailscale must fall back to a real local name, not
  // to a made-up one and not to a crash.
  const missing = async () => ({ code: 127, stdout: '', stderr: 'command not found' });
  const fallback = await resolveCallerHost({ exec: missing });
  assert.equal(fallback, defaultCallerHost());
  assert.ok(fallback.length > 0);
  const garbage = async () => ({ code: 0, stdout: 'not json', stderr: '' });
  assert.equal(await resolveCallerHost({ exec: garbage }), defaultCallerHost());
});

// --- one slow axis must not erase another axis's finished answer ----------

test('a slow ssh does not overwrite a finished HTTP verdict', async () => {
  // Found in a live run: four fleet boxes probed at once, ssh and `tailscale
  // ping` contending, and a shared per-entry deadline replaced an HTTP result
  // that had already returned ECONNREFUSED with "no response within 8000 ms".
  // The precise, actionable answer was destroyed by the vague one.
  const server = await jsonEndpoint(ONE_MODEL);
  const port = server.port;
  await server.close(); // so the HTTP probe fails fast and precisely
  const slowExec = async (argv) => {
    await new Promise(r => setTimeout(r, 5000)); // never finishes in time
    return { code: 0, stdout: '', stderr: '' };
  };
  const [r] = await probeModels([entry(port)], { exec: slowExec, timeoutMs: 900, latencySamples: 1 });
  assert.equal(r.state, 'UNREACHABLE');
  // NEGATIVE CONTROL: the reason must still be the specific connect error,
  // not the deadline's generic message.
  assert.match(r.reason, /connect failed/);
  assert.doesNotMatch(r.reason, /no response within/);
  // ...while the axis that really did time out says so honestly.
  assert.equal(r.capacityUnknown, true);
  assert.equal(r.freeMemGiB, null);
});

test('a slow tailscale ping does not delay or alter the other two axes', async () => {
  // A non-loopback host, so the path probe actually runs; it never resolves,
  // so nothing leaves this machine.
  const exec = async (argv) => {
    if (argv[0] === 'tailscale') { await new Promise(r => setTimeout(r, 9000)); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: `__GPU__\n${GPU_IDLE}\n__SYS__\n\n__PROC__\n\n__END__\n`, stderr: '' };
  };
  const started = Date.now();
  const [r] = await probeModels([entry(8000, { host: 'nowhere.invalid' })], { exec, timeoutMs: 8000, latencySamples: 1 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `path has its own shorter budget, took ${elapsed}ms`);
  assert.equal(r.path, 'unknown');
  assert.match(r.pathReason, /path read exceeded/);
  assert.equal(r.state, 'UNREACHABLE');
  assert.equal(r.freeMemGiB, 79, 'the capacity axis survived a stuck path probe');
});

// --- credentials: the check that could not distinguish its cases -----------
//
// Found live at 04:18 against the GLM server on asus1:8888. The probe sent no
// Authorization header and printed `DOWN ... HTTP 401` whether or not a key
// was available, so the with-key and without-key runs were byte-identical
// while the server was serving fine. These tests are the negative control
// that failure lacked.

test('401 with NO key available: DOWN, and the reason says a key is missing', async () => {
  const server = await bearerEndpoint(DUMMY_TOKEN);
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'DOWN');
    assert.equal(r.reason, AUTH_MISSING_REASON);
    assert.equal(r.reason, 'needs auth: no key configured for this entry');
    assert.equal(r.authState, 'no-key');
    assert.equal(r.httpStatus, 401);
    assert.equal(r.keySource, null);
    assert.equal(server.seen[0], null, 'nothing to send, so nothing was sent');
    // NEGATIVE CONTROL: the old generic line must be gone. "HTTP 401" tells
    // the operator to go restart a server that is healthy.
    assert.doesNotMatch(r.reason, /returned HTTP 401/);
  } finally { await server.close(); }
});

test('401 WITH a key: DOWN, and the reason says the key was refused', async () => {
  const server = await bearerEndpoint('some-other-token');
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const [r] = await probe([entry(server.port, { auth: 'bearer', keyFile: key.path })],
      { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'DOWN');
    assert.equal(r.reason, AUTH_REJECTED_REASON);
    assert.equal(r.reason, 'auth rejected: key present but refused');
    assert.equal(r.authState, 'rejected');
    assert.equal(r.keySource, KEY_SOURCES.ENTRY_FILE);
    assert.equal(server.seen[0], `Bearer ${DUMMY_TOKEN}`, 'the header really went on the wire');
    assertNoToken(r);
  } finally { await server.close(); await key.cleanup(); }
});

test('NEGATIVE CONTROL: against a 401 server, the with-key run and the without-key run DIFFER', async () => {
  // THIS IS THE TEST THAT THE LIVE RUN FAILED. Before the fix both arms
  // produced the identical line, which is what a check that cannot fail looks
  // like from the outside: confident, well formatted and uninformative.
  const server = await bearerEndpoint('a-token-this-probe-will-never-have');
  const key = await keyFileWith(DUMMY_TOKEN);
  const strip = r => JSON.stringify({ ...r, checkedAt: null, latencyMs: null, p90Ms: null, medianMs: null, minMs: null });
  try {
    const opts = { exec: fakeExec({ mem: GPU_IDLE }), env: {} };
    const [without] = await probe([entry(server.port, { id: 'same' })], opts);
    const [with_] = await probe([entry(server.port, { id: 'same', auth: 'bearer', keyFile: key.path })], opts);
    assert.notEqual(with_.reason, without.reason, 'the two runs must not print the same reason');
    assert.notEqual(strip(with_), strip(without), 'the two runs must not be byte-identical');
    // Both are still DOWN: neither can serve a model right now. It is the
    // REPAIR that differs, and that is what the reason has to carry.
    assert.equal(with_.state, 'DOWN');
    assert.equal(without.state, 'DOWN');
    assert.equal(without.authState, 'no-key');
    assert.equal(with_.authState, 'rejected');
    assertNoToken(with_, without);
    // ...and the difference must be grounded in what went ON THE WIRE, not
    // merely in what the probe knew about its own configuration. Asserting
    // only on the two reasons is not enough: with the header send deleted,
    // "key present but refused" would still be printed, and would be a lie
    // about a request that carried nothing. So check the server's record.
    assert.deepEqual(server.seen, [null, `Bearer ${DUMMY_TOKEN}`]);
  } finally { await server.close(); await key.cleanup(); }
});

test('the SAME server answers the two runs differently: 401 without the key, its model list with it', async () => {
  // The strongest form of the control above. This can only pass if the header
  // actually leaves the process: the verdicts differ by STATE, which no
  // amount of local bookkeeping can fake.
  const server = await bearerEndpoint(DUMMY_TOKEN);
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const opts = { exec: fakeExec({ mem: GPU_IDLE }), env: {} };
    const [without] = await probe([entry(server.port, { id: 'same' })], opts);
    const [with_] = await probe([entry(server.port, { id: 'same', auth: 'bearer', keyFile: key.path })], opts);
    assert.equal(without.state, 'DOWN');
    assert.equal(without.reason, AUTH_MISSING_REASON);
    assert.deepEqual(without.models, []);
    assert.equal(with_.state, 'UP');
    assert.deepEqual(with_.models, ['qwen3-coder-30b']);
    assert.notEqual(with_.state, without.state);
    assertNoToken(with_, without);
  } finally { await server.close(); await key.cleanup(); }
});

test('200 WITH a token: the auth step gets out of the way and normal UP logic runs', async () => {
  const server = await bearerEndpoint(DUMMY_TOKEN);
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const [r] = await probe([entry(server.port, { auth: 'bearer', keyFile: key.path })],
      { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'UP');
    assert.deepEqual(r.models, ['qwen3-coder-30b']);
    assert.equal(r.freeMemGiB, 79);
    assert.equal(r.authState, 'sent');
    assert.equal(r.httpStatus, 200);
    assertNoToken(r);
  } finally { await server.close(); await key.cleanup(); }
});

test('200 WITH a token on a busy box is still BUSY: auth does not outrank capacity', async () => {
  // NEGATIVE CONTROL: "the key worked" must not short-circuit into UP. The
  // 200 hands control back to the ordinary rules, it does not replace them.
  const server = await bearerEndpoint(DUMMY_TOKEN);
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const exec = fakeExec({ mem: GPU_IDLE, proc: '4711 /opt/ltx/bin/ltx --render scene.yaml' });
    const [r] = await probe([entry(server.port, { auth: 'bearer', keyFile: key.path })], { exec, env: {} });
    assert.notEqual(r.state, 'UP');
    assert.equal(r.state, 'BUSY');
    assert.match(r.busyReason, /exclusive job running: ltx/);
    assert.equal(r.authState, 'sent');
  } finally { await server.close(); await key.cleanup(); }
});

test('200 on an open server with no token: normal UP, and no header was sent', async () => {
  const seen = [];
  const server = await endpoint((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ONE_MODEL));
  });
  try {
    const [r] = await probe([entry(server.port)], { exec: fakeExec({ mem: GPU_IDLE }), env: {} });
    assert.equal(r.state, 'UP');
    assert.equal(r.authState, 'open');
    assert.equal(r.auth, 'none');
    assert.equal(seen[0], null);
  } finally { await server.close(); }
});

test('the token goes on every latency sample, not just the first', async () => {
  const server = await bearerEndpoint(DUMMY_TOKEN);
  const key = await keyFileWith(DUMMY_TOKEN);
  try {
    const [r] = await probeModels([entry(server.port, { auth: 'bearer', keyFile: key.path })], {
      exec: fakeExec({ mem: GPU_IDLE }), env: {}, latencySamples: 3, latencySpreadMs: 200, timeoutMs: 8000,
    });
    assert.equal(r.state, 'UP');
    assert.ok(server.seen.length >= 2, `sampled more than once, got ${server.seen.length}`);
    // An unauthenticated later sample would come back 401 and silently stop
    // counting as a latency sample, quietly halving the measurement.
    for (const header of server.seen) assert.equal(header, `Bearer ${DUMMY_TOKEN}`);
    assert.equal(r.latencySamples, server.seen.length);
  } finally { await server.close(); await key.cleanup(); }
});

// --- where a token may come from, and where it may not --------------------

test('credential sources resolve in priority order: entry keyFile, then LLM_API_KEY_FILE, then LLM_API_KEY', async () => {
  const entryKey = await keyFileWith(DUMMY_TOKEN, 0o600, 'entry.txt');
  const envKey = await keyFileWith(`${DUMMY_TOKEN}-from-env-file`, 0o600, 'env.txt');
  const env = { LLM_API_KEY_FILE: envKey.path, LLM_API_KEY: `${DUMMY_TOKEN}-from-env-value` };
  try {
    const first = await resolveEntryToken({ auth: 'bearer', keyFile: entryKey.path }, { env });
    assert.equal(first.token, DUMMY_TOKEN, 'the entry keyFile wins');
    assert.equal(first.keySource, KEY_SOURCES.ENTRY_FILE);

    const second = await resolveEntryToken({ auth: 'bearer' }, { env });
    assert.equal(second.token, `${DUMMY_TOKEN}-from-env-file`, 'then LLM_API_KEY_FILE');
    assert.equal(second.keySource, KEY_SOURCES.ENV_FILE);

    const third = await resolveEntryToken({ auth: 'bearer' }, { env: { LLM_API_KEY: `${DUMMY_TOKEN}-value` } });
    assert.equal(third.token, `${DUMMY_TOKEN}-value`, 'then LLM_API_KEY');
    assert.equal(third.keySource, KEY_SOURCES.ENV_VALUE);
    assert.match(third.keyWarning, /environment VALUE/);

    // NEGATIVE CONTROL: an entry that never asked for auth takes no token,
    // however much the environment is offering. A key belongs to the lock it
    // opens, not to every box in the registry.
    const none = await resolveEntryToken({ auth: 'none' }, { env });
    assert.equal(none.token, null);
    assert.equal(none.keySource, null);
    const empty = await resolveEntryToken({ auth: 'bearer' }, { env: {} });
    assert.equal(empty.token, null);
    assert.equal(empty.keySource, null);
  } finally { await entryKey.cleanup(); await envKey.cleanup(); }
});

test('a group/world readable key file warns, and a 0600 one does not', async () => {
  const loose = await keyFileWith(DUMMY_TOKEN, 0o644);
  const tight = await keyFileWith(DUMMY_TOKEN, 0o600);
  try {
    const warned = await resolveEntryToken({ auth: 'bearer', keyFile: loose.path }, { env: {} });
    assert.equal(warned.token, DUMMY_TOKEN, 'a warning, not a refusal');
    assert.match(warned.keyWarning, /mode 0644/);
    assert.match(warned.keyWarning, /chmod 600/);
    assert.ok(warned.keyWarning.includes(loose.path), 'the warning names the file');
    assertNoToken(warned.keyWarning);
    // NEGATIVE CONTROL: if it warned about everything the check would prove
    // nothing.
    const quiet = await resolveEntryToken({ auth: 'bearer', keyFile: tight.path }, { env: {} });
    assert.equal(quiet.keyWarning, null);
    assert.equal(quiet.token, DUMMY_TOKEN);
  } finally { await loose.cleanup(); await tight.cleanup(); }
});

test('a keyFile that cannot be read does not silently fall back to the environment', async () => {
  // Substituting a different credential for the one the operator named makes
  // "which key was refused?" unanswerable.
  const env = { LLM_API_KEY: `${DUMMY_TOKEN}-from-env-value` };
  const resolved = await resolveEntryToken({ auth: 'bearer', keyFile: '/nonexistent/iak/key.txt' }, { env });
  assert.equal(resolved.token, null);
  assert.equal(resolved.keySource, null);
  assert.equal(resolved.keyBlocked, true);
  assert.match(resolved.keyWarning, /cannot read key file \/nonexistent\/iak\/key\.txt/);

  const server = await bearerEndpoint(DUMMY_TOKEN);
  try {
    const [r] = await probe([entry(server.port, { auth: 'bearer', keyFile: '/nonexistent/iak/key.txt' })],
      { exec: fakeExec({ mem: GPU_IDLE }), env });
    assert.equal(r.state, 'DOWN');
    // The verdict is "no key", and the reason also says the configured one
    // could not be read - otherwise "no key configured" contradicts the
    // keyFile sitting in the registry.
    assert.match(r.reason, new RegExp(`^${AUTH_MISSING_REASON}`));
    assert.match(r.reason, /cannot read key file/);
    assert.equal(server.seen[0], null);
  } finally { await server.close(); }
});

test('an empty key file is reported, not sent as an empty bearer token', async () => {
  const blank = await keyFileWith('   \n', 0o600);
  try {
    const resolved = await resolveEntryToken({ auth: 'bearer', keyFile: blank.path }, { env: {} });
    assert.equal(resolved.token, null);
    assert.equal(resolved.keyBlocked, true);
    assert.match(resolved.keyWarning, /is empty/);
  } finally { await blank.cleanup(); }
});

test('a ~ in keyFile is expanded rather than taken literally', async () => {
  const resolved = await resolveEntryToken({ auth: 'bearer', keyFile: '~/.iak/definitely-not-here.txt' }, { env: {} });
  assert.equal(resolved.token, null);
  assert.ok(!resolved.keyWarning.includes('~/'), `the ~ was not expanded: ${resolved.keyWarning}`);
  assert.match(resolved.keyWarning, /\/\.iak\/definitely-not-here\.txt/);
});

// --- the registry may name a key file; it may never hold a key ------------

test('a registry entry carrying a literal credential is rejected with a message that says why', () => {
  // config/models.json is committed and this repository is public, so a token
  // written into it is published rather than configured.
  const fields = ['key', 'apiKey', 'api_key', 'token', 'apiToken', 'accessToken',
    'bearer', 'bearerToken', 'secret', 'password', 'authorization', 'credentials', 'headers'];
  for (const field of fields) {
    assert.throws(
      () => loadRegistry([{ id: 'x', host: 'asus1', port: 8888, kind: 'openai', [field]: 'sk-literal-value' }]),
      err => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, new RegExp(`remove "${field}"`));
        assert.match(err.message, /never a VALUE/);
        assert.match(err.message, /keyFile/);
        return true;
      },
      `${field} must be refused in the registry`);
  }
});

test('NEGATIVE CONTROL: the credential check accepts auth + keyFile, which is the supported way', () => {
  // If it rejected every entry, or every entry mentioning a key at all, the
  // test above would prove nothing.
  const [e] = loadRegistry([{
    id: 'glm53-asus', host: 'asus1', port: 8888, kind: 'openai',
    box: 'asus1+asus2', sharing: 'exclusive', owner: '@codexmb',
    auth: 'bearer', keyFile: '~/.iak/example_api_key.txt',
  }]);
  assert.equal(e.auth, 'bearer');
  assert.equal(e.keyFile, '~/.iak/example_api_key.txt');
  // ...and an entry that mentions neither still loads, defaulting to no auth.
  const [plain] = loadRegistry([{ id: 'y', host: 'mini', port: 1234, kind: 'lmstudio' }]);
  assert.equal(plain.auth, 'none');
  assert.equal(plain.keyFile, null);
});

test('keyFile must be a PATH, and auth must be a known mode', () => {
  const ok = { id: 'x', host: 'asus1', port: 8888, kind: 'openai' };
  // A pasted token in the keyFile slot has to fail loudly rather than be read
  // as a relative filename and reported as a missing file.
  assert.throws(() => loadRegistry([{ ...ok, auth: 'bearer', keyFile: 'sk-abcdef0123456789' }]),
    /must be a PATH to a file containing the token/);
  assert.throws(() => loadRegistry([{ ...ok, auth: 'bearer', keyFile: 'A'.repeat(48) }]),
    /must be a PATH to a file containing the token/);
  assert.throws(() => loadRegistry([{ ...ok, auth: 'bearer', keyFile: '' }]), /non-empty string path/);
  // A keyFile nothing would ever send is a configuration that lies.
  assert.throws(() => loadRegistry([{ ...ok, auth: 'none', keyFile: '/tmp/k.txt' }]), /would never be sent/);
  assert.throws(() => loadRegistry([{ ...ok, auth: 'basic' }]), /auth "basic"/);
  // NEGATIVE CONTROL: ordinary paths, including the fake-looking ones, load.
  for (const path of ['/Users/p/.iak/glm.txt', '~/.iak/example_api_key.txt', './secrets/key', 'key.txt']) {
    const [e] = loadRegistry([{ ...ok, auth: 'bearer', keyFile: path }]);
    assert.equal(e.keyFile, path);
  }
  // keyFile alone implies bearer: a key nobody sends is a silent misconfig.
  const [implied] = loadRegistry([{ ...ok, keyFile: '/tmp/k.txt' }]);
  assert.equal(implied.auth, 'bearer');
});

test('the token appears in NO output string, whatever the endpoint does', async () => {
  const key = await keyFileWith(DUMMY_TOKEN, 0o644); // loose mode, so the warning path runs too
  const refusing = await bearerEndpoint('not-the-configured-one');
  const accepting = await bearerEndpoint(DUMMY_TOKEN);
  try {
    const opts = { exec: fakeExec({ mem: GPU_IDLE }), env: { LLM_API_KEY: DUMMY_TOKEN } };
    const results = await probe([
      entry(refusing.port, { id: 'refused', auth: 'bearer', keyFile: key.path }),
      entry(accepting.port, { id: 'accepted', auth: 'bearer', keyFile: key.path }),
      entry(8000, { id: 'gone', host: 'nowhere.invalid', auth: 'bearer', keyFile: key.path }),
      entry(8001, { id: 'env-key', host: 'nowhere.invalid', auth: 'bearer' }),
    ], { ...opts, timeoutMs: 6000 });
    assert.equal(results.length, 4);
    // The whole payload, exactly as the CLI would print it with --json.
    assertNoToken(JSON.stringify({ results }, null, 2));
    for (const r of results) {
      assertNoToken(r, r.reason, r.keyWarning ?? '', r.busyReason ?? '', r.pathReason ?? '');
      // What it may say is WHERE the key came from.
      if (r.keySource) assert.ok(Object.values(KEY_SOURCES).includes(r.keySource));
    }
    assert.equal(results[0].authState, 'rejected');
    assert.equal(results[1].authState, 'sent');
    assert.equal(results[3].keySource, KEY_SOURCES.ENV_VALUE);
  } finally { await refusing.close(); await accepting.close(); await key.cleanup(); }
});
