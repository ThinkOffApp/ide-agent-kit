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
//   ps-macos-decoys.txt      synthetic: lines that must NOT be read as engines
//                            (501-504; 511 is @codexmb's repro, printf with an
//                            engine-shaped argv; 512 an argv[0] that lies about
//                            its executable; 513 an engine claiming a remote
//                            --host), plus the shapes a launcher could produce
//                            (spaces in paths, --port=, -m, a key on argv, no
//                            --port, a --port it does not listen on).
//   lsof-studio.txt          `lsof -Fn` for the Studio engine's listening socket.
//
// What each process really runs comes from the kernel (`lsof -d txt` here,
// faked per pid in EXE): `ps` shows argv, which any process can set.
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
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePsOutput, parseServeLine, parseServeArgv, parseLsofListen, parseLsofExecutable, parseProcNetTcp,
  connectHost, chooseSocket, repoFromPath, discoverTensorFoldEngines, STUDIO_APP_NAME,
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
  app: null, apiKeyFile: false, keyOnArgv: false, slide: false, ...extra,
});

/** The real executable of every pid in the fixtures, as `lsof -d txt` reports it. */
const STUDIO_EXE = '/Applications/TensorFold Studio.app/Contents/Resources/engine/bin/tensorfold-native';
const EXE = {
  1361: '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python',
  10169: '/Users/me/tmp/tf-rel/v1.0.10/zig-out/native/bin/tensorfold-native',
  14779: '/Volumes/TensorFold/TensorFold.app/Contents/Resources/engine/bin/tensorfold-native',
  501: '/usr/bin/grep', 502: '/usr/bin/vim', 503: '/usr/bin/python3', 504: '/usr/bin/python3',
  505: STUDIO_EXE, 506: '/opt/tf/bin/tensorfold-native', 507: '/opt/tf/bin/tensorfold-native',
  508: '/usr/bin/python3', 509: '/opt/tf/bin/tensorfold-native', 510: '/opt/tf/bin/tensorfold-native',
  511: '/usr/bin/printf', 512: '/bin/sleep', 513: '/opt/tf/bin/tensorfold-native',
};
const parseLines = text => Object.fromEntries(parsePsOutput(text).map(p => [p.pid, parseServeLine(p.pid, p.args, EXE[p.pid])]));

async function keyFile(t, text, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), 'iak-tf-engine-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'keys');
  await writeFile(path, text, { mode });
  return path;
}

// --- parsing the process table --------------------------------------------------

test('live macOS ps lines: Python 0.6.0, native bench, and the Studio engine on its random port', () => {
  const engines = Object.values(parseLines(PS_LIVE)).filter(Boolean);
  const simple = engines.map(e => ({ pid: e.pid, port: e.port, name: e.name, model: e.model, app: e.app, slide: e.slide, keyOnArgv: e.keyOnArgv }));
  assert.deepEqual(simple, [
    { pid: 1361, port: 8091, name: null, model: 'Vontra/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', app: null, slide: false, keyOnArgv: false },
    { pid: 10169, port: 8101, name: 'bench', model: 'bench', app: null, slide: false, keyOnArgv: false },
    { pid: 14779, port: 54635, name: STUDIO_MODEL, model: STUDIO_MODEL, app: STUDIO_APP_NAME, slide: false, keyOnArgv: false },
  ]);
});

test('decoys are not engines; launcher shapes parse; a key or key file on argv is noted and never kept', () => {
  const byPid = parseLines(PS_DECOYS);
  for (const pid of [501, 502, 503, 504]) assert.equal(byPid[pid], null, `pid ${pid} is not a TensorFold engine`);
  assert.equal(byPid[511], null, 'printf with an engine-shaped argv is printf (@codexmb repro)');
  assert.equal(byPid[512], null, 'an argv[0] naming tensorfold-native does not make /bin/sleep an engine');
  const studio = byPid[505];
  assert.equal(studio.app, STUDIO_APP_NAME, 'a bundle path with spaces is still the Studio engine');
  assert.equal(studio.port, 9123);
  assert.equal(studio.name, 'Owner/Model');
  assert.equal(studio.slide, true);
  assert.equal(studio.apiKeyFile, true, 'only THAT a key file was named');
  assert.ok(!('host' in studio) && !('listenHost' in studio), '--host is never taken from argv');
  assert.doesNotMatch(JSON.stringify(byPid), /\.tensorfold\/keys|dummy-key|example\.invalid|192\.0\.2\.7/, 'no key path or argv host leaves the parser');
  const keyed = byPid[506];
  assert.equal(keyed.keyOnArgv, true);
  assert.equal(keyed.name, 'small');
  assert.equal(keyed.port, 9200);
  assert.doesNotMatch(JSON.stringify(keyed), /not-a-real-key-x/, 'an --api-key value never leaves the parser');
  assert.equal(byPid[507].port, null, 'no --port: the socket decides');
  assert.equal(byPid[508].model, 'Vontra/ViaModule', 'python -m tensorfold serve');
  assert.equal(byPid[508].port, 9300);
  assert.equal(byPid[510].port, 9400, '--port=N');
  // The line matches, but the executable does not: no engine either way.
  assert.equal(parseServeLine(1, '/opt/tf/bin/tensorfold-native serve X', undefined), null, 'no executable known, no engine');
  assert.equal(parseServeLine(1, '/usr/bin/python3 /tmp/x.py -m tensorfold serve X', '/usr/bin/python3'), null);
});

test('Linux argv (exact, from /proc/<pid>/cmdline) keeps a value with spaces whole; identity is /proc/<pid>/exe', () => {
  const native = '/opt/tf/bin/tensorfold-native';
  const e = parseServeArgv(7, [native, 'serve', '/home/me/My Models/qwen', '--port', '9500', '--api-key-file', '/home/me/tf keys', '--slide'], native);
  assert.equal(e.model, 'qwen');
  assert.equal(e.port, 9500);
  assert.equal(e.apiKeyFile, true);
  assert.equal(e.slide, true);
  const py = parseServeArgv(8, ['/usr/bin/python3', '/home/me/.venv/bin/tensorfold', 'serve', 'Vontra/X', '--host', '0.0.0.0'], '/usr/bin/python3.12');
  assert.equal(py.model, 'Vontra/X');
  const key = parseServeArgv(9, [native, 'serve', 'Vontra/X', '--api-key', 'argv-key-x', '--port', '9600'], native);
  assert.equal(key.keyOnArgv, true);
  assert.equal(key.port, 9600, 'the flag after a dropped key value still parses');
  assert.doesNotMatch(JSON.stringify(key), /argv-key-x/);
  assert.equal(parseServeArgv(10, ['/usr/bin/less', 'tensorfold', 'serve'], '/usr/bin/less'), null);
  assert.equal(parseServeArgv(11, [native, 'pull', 'Vontra/X'], native), null);
  assert.equal(parseServeArgv(12, [native, 'serve', 'Vontra/X'], '/usr/bin/printf'), null, 'argv[0] is a claim; exe is the process');
  assert.equal(parseServeArgv(13, ['/usr/bin/python3', 'tensorfold', 'serve'], '/usr/bin/python3'), null, 'a relative script is not an entry point we can name');
  assert.equal(parseServeArgv(14, ['/usr/bin/python3', '/tmp/r.py', '-m', 'tensorfold', 'serve'], '/usr/bin/python3'), null);
});

test('lsof and /proc socket tables, loopback-only connect hosts, and Hugging Face cache paths', () => {
  assert.deepEqual(parseLsofListen(LSOF_STUDIO), [{ host: '127.0.0.1', port: 54635 }]);
  assert.deepEqual(parseLsofListen('p1\nf3\nn*:8080\nf4\nn[::1]:8081\n'), [{ host: '*', port: 8080 }, { host: '::1', port: 8081 }]);
  assert.equal(parseLsofExecutable(`p1\nftxt\nn${STUDIO_EXE}\nftxt\nn/usr/lib/dyld\n`), STUDIO_EXE);
  assert.equal(parseLsofExecutable(''), null);
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const tcp = `${header}   0: 0100007F:2649 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0\n`
    + '   1: 0100007F:264A 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0\n'
    + '   2: 00000000:264B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0\n';
  assert.deepEqual(parseProcNetTcp(tcp, new Set(['5551'])), [{ host: '127.0.0.1', port: 9801 }], 'LISTEN rows of our inodes only');
  const tcp6 = `${header}   0: 00000000000000000000000001000000:2649 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 42 1 0\n`
    + '   1: 0000000000000000FFFF00000100007F:264A 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 43 1 0\n';
  assert.deepEqual(parseProcNetTcp(tcp6, new Set(['42', '43']), true), [{ host: '::1', port: 9801 }, { host: '::ffff:127.0.0.1', port: 9802 }]);
  assert.equal(connectHost('*'), '127.0.0.1');
  assert.equal(connectHost('0.0.0.0'), '127.0.0.1');
  assert.equal(connectHost('::'), '::1');
  assert.equal(connectHost('127.0.0.2'), '127.0.0.2');
  assert.equal(connectHost('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(connectHost('100.101.102.103'), null, 'a LAN or tailnet address is not read');
  assert.equal(connectHost('example.invalid'), null);
  assert.equal(repoFromPath('/Users/me/.cache/huggingface/hub/models--Vontra--Qwen3.8-27B-MLX-4bit/snapshots/70ae7f'), 'Vontra/Qwen3.8-27B-MLX-4bit');
  assert.equal(repoFromPath('/tmp/plain'), null);
});

test('chooseSocket: the pid must listen where it says, on loopback, and unambiguously', () => {
  const e = port => ({ port });
  assert.deepEqual(chooseSocket(e(9000), [{ host: '::1', port: 9000 }, { host: '*', port: 9000 }]), { host: '127.0.0.1', port: 9000, portFrom: 'args' });
  assert.match(chooseSocket(e(9000), [{ host: '127.0.0.1', port: 9001 }]).reason, /does not listen on its --port 9000/);
  assert.match(chooseSocket(e(9000), [{ host: '192.0.2.7', port: 9000 }]).reason, /on a loopback address/);
  assert.equal(chooseSocket(e(9000), []).quiet, true, 'not listening yet is not worth a line');
  assert.deepEqual(chooseSocket(e(null), [{ host: '127.0.0.1', port: 9100 }]), { host: '127.0.0.1', port: 9100, portFrom: 'socket' });
  assert.match(chooseSocket(e(null), [{ host: '127.0.0.1', port: 9100 }, { host: '127.0.0.1', port: 9101 }]).reason, /2 ports and names none/);
  assert.match(chooseSocket(e(null), [{ host: '10.0.0.5', port: 9100 }]).reason, /only on non-loopback/);
});

// --- discovery as a whole ---------------------------------------------------------

/**
 * A fake exec: `ps` answers with `ps`; `lsof -d txt` with the pid's
 * executable from `exe`; `lsof -iTCP` with its listen addresses from
 * `listen`. Records every call.
 */
function fakeExec({ ps = PS_LIVE, exe = EXE, listen = {}, lsofMissing = false, psFails = false } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ps') return psFails ? { ok: false, stdout: '', error: { code: 'EPERM' } } : { ok: true, stdout: ps, error: null };
    if (command === 'lsof') {
      if (lsofMissing) return { ok: false, stdout: '', error: { code: 'ENOENT' } };
      const pid = args[args.indexOf('-p') + 1];
      if (args.includes('txt')) {
        return exe[pid] ? { ok: true, stdout: `p${pid}\nftxt\nn${exe[pid]}\nftxt\nn/usr/lib/dyld\n`, error: null } : { ok: false, stdout: '', error: { code: 1 } };
      }
      const addrs = listen[pid] ?? [];
      return addrs.length ? { ok: true, stdout: `p${pid}\n${addrs.map((a, i) => `f${i + 3}\nn${a}`).join('\n')}\n`, error: null } : { ok: false, stdout: '', error: { code: 1 } };
    }
    throw new Error(`unexpected exec ${command}`);
  };
  return { exec, calls };
}

const LISTEN = {
  1361: ['127.0.0.1:8091'], 10169: ['127.0.0.1:8101'], 14779: ['127.0.0.1:54635'],
  505: ['*:9123'], 506: ['127.0.0.1:9200'], 507: ['127.0.0.1:9700'], 508: ['127.0.0.1:9300'],
  509: ['127.0.0.1:9201'], 510: ['[::1]:9400'], 511: ['127.0.0.1:1234'], 512: ['127.0.0.1:1235'],
  513: ['192.0.2.7:9500'],
};

test('macOS discovery: one ps for this user, lsof for candidates only, each engine at a loopback socket its pid holds', async () => {
  const { exec, calls } = fakeExec({ ps: `${PS_LIVE}${PS_DECOYS}`, listen: LISTEN });
  const r = await discoverTensorFoldEngines({ platform: 'darwin', exec, uid: 501 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['ps', '-ww', '-U', '501', '-o', 'pid=,args=']);
  assert.ok(calls.every(c => !c.includes('-E') && !c.includes('e')), 'never asks ps for environments');
  const asked = [...new Set(calls.filter(c => c[0] === 'lsof').map(c => c[c.indexOf('-p') + 1]))];
  assert.ok(!asked.some(pid => ['501', '502', '503', '504'].includes(pid)), 'grep, vim and friends are never inspected');
  assert.deepEqual(r.engines.map(e => [e.pid, e.port, e.portFrom, e.host]), [
    [1361, 8091, 'args', '127.0.0.1'], [10169, 8101, 'args', '127.0.0.1'], [14779, 54635, 'args', '127.0.0.1'],
    [505, 9123, 'args', '127.0.0.1'], [506, 9200, 'args', '127.0.0.1'], [507, 9700, 'socket', '127.0.0.1'],
    [508, 9300, 'args', '127.0.0.1'], [510, 9400, 'args', '::1'],
  ]);
  assert.deepEqual(r.skipped.map(s => [s.pid, s.reason]), [
    [509, 'does not listen on its --port 9200 on a loopback address; not read'],
    [513, 'does not listen on its --port 9500 on a loopback address; not read'],
  ]);
  assert.doesNotMatch(JSON.stringify(r), /example\.invalid|192\.0\.2\.7|dummy-key/);
});

test('no --port and no socket yet: left out quietly; without lsof nothing is trusted and the scan says why', async () => {
  const line = '  700 /opt/tf/bin/tensorfold-native serve Vontra/Loading --name loading\n';
  const exe = { 700: '/opt/tf/bin/tensorfold-native' };
  const quiet = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ ps: line, exe }).exec, uid: 501 });
  assert.equal(quiet.ok, true);
  assert.deepEqual(quiet.engines, [], 'still loading (or not an engine): no card until it listens');
  assert.deepEqual(quiet.skipped, []);
  const blind = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ ps: line, exe, lsofMissing: true }).exec, uid: 501 });
  assert.equal(blind.ok, false, 'fail closed: no default port, no engine on its word');
  assert.match(blind.error, /cannot verify engines: lsof unavailable \(ENOENT\)/);
  assert.deepEqual(blind.engines, []);
});

test('a failed process scan is ok:false with the reason, never a throw and never "no engines" silently', async () => {
  const r = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ psFails: true }).exec, uid: 501 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ps failed/);
  assert.deepEqual(r.engines, []);
});

test('Linux discovery reads /proc: this user only, comm first, exe for identity, sockets from fd links, never environ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iak-tf-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const row = (addr, port, inode) => `   0: ${addr}:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0\n`;
  const proc = async (pid, comm, exe, argv, { tcp = '', tcp6 = '', sockets = [] } = {}) => {
    const dir = join(root, String(pid));
    await mkdir(join(dir, 'fd'), { recursive: true });
    await mkdir(join(dir, 'net'));
    await writeFile(join(dir, 'comm'), `${comm}\n`);
    await writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    await writeFile(join(dir, 'environ'), `TENSORFOLD_API_KEY=${DUMMY_KEY}\0`);
    await symlink(exe, join(dir, 'exe'));
    await writeFile(join(dir, 'net', 'tcp'), `${header}${tcp}`);
    await writeFile(join(dir, 'net', 'tcp6'), `${header}${tcp6}`);
    for (const [i, inode] of sockets.entries()) await symlink(`socket:[${inode}]`, join(dir, 'fd', String(i + 3)));
  };
  await proc(100, 'tensorfold-nati', '/opt/tf/bin/tensorfold-native', ['/opt/tf/bin/tensorfold-native', 'serve', 'Vontra/A', '--port', '9801'],
    { tcp: row('0100007F', 9801, 5551), sockets: [5551] });
  await proc(101, 'tensorfold', '/usr/bin/python3.12', ['/usr/bin/python3', '/home/me/.venv/bin/tensorfold', 'serve', 'Vontra/B', '--port', '9802'],
    { tcp6: row('00000000000000000000000000000000', 9802, 5552), sockets: [5552] });
  await proc(102, 'bash', '/bin/bash', ['/bin/bash', '-c', 'tensorfold-native serve Vontra/C --port 9803']);
  await proc(103, 'python3', '/usr/bin/python3', ['/usr/bin/python3', '/tmp/report.py', 'tensorfold', 'serve', '--port', '9805']);
  await proc(104, 'tensorfold-nati', '/opt/tf/bin/tensorfold-native', ['/opt/tf/bin/tensorfold-native', 'serve', 'Fake/Remote', '--host', '192.0.2.7', '--port', '9804'],
    { tcp: row('070200C0', 9804, 5554), sockets: [5554] });
  await proc(105, 'tensorfold-nati', '/opt/tf/bin/tensorfold-native', ['/opt/tf/bin/tensorfold-native', 'serve', 'Fake/Other', '--port', '9806'],
    { tcp: row('0100007F', 9806, 9999), sockets: [5556] });
  await mkdir(join(root, 'self'));
  const reads = [];
  const real = await import('node:fs/promises');
  const fs = {
    readdir: p => real.readdir(p),
    stat: p => real.stat(p),
    readlink: p => real.readlink(p),
    readFile: async (p, enc) => { reads.push(p); return real.readFile(p, enc); },
  };
  const r = await discoverTensorFoldEngines({ platform: 'linux', procRoot: root, uid: process.getuid(), fs, exec: fakeExec().exec });
  assert.deepEqual(r.engines.map(e => [e.port, e.host, e.model]), [[9801, '127.0.0.1', 'Vontra/A'], [9802, '::1', 'Vontra/B']]);
  assert.deepEqual(r.skipped.map(s => s.pid), [104], 'a remote-only socket is not read, and says so');
  assert.ok(!r.engines.some(e => e.pid === 105), 'a --port whose socket another process holds is not read (quietly: it may still be loading)');
  assert.ok(!reads.some(p => p.endsWith('/environ')), 'never reads a process environment');
  assert.ok(!reads.some(p => p.endsWith('/102/cmdline')), 'argv is read only for candidate processes');
  const other = await discoverTensorFoldEngines({ platform: 'linux', procRoot: root, uid: process.getuid() + 1, fs, exec: fakeExec().exec });
  assert.deepEqual(other.engines, [], "another user's processes are not scanned");
});

// --- @codexmb's attack, end to end: argv must not choose a host or a key file -------

test('a process that only claims to be an engine gets no request; a real one is read on loopback with no key from argv', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const decoyKey = await keyFile(t, `${DUMMY_KEY}\n`);
  const ps = [
    `  601 /usr/bin/printf /tmp/tensorfold-native serve Fake/Model --host example.invalid --port ${port} --api-key-file ${decoyKey}`,
    `  602 /opt/tf/bin/tensorfold-native serve Fake/Claims --host example.invalid --port ${port} --api-key-file ${decoyKey}`,
    `  603 /opt/tf/bin/tensorfold-native serve Fake/Remote --host 192.0.2.7 --port 9500 --api-key-file ${decoyKey}`,
  ].join('\n');
  const exe = { 601: '/usr/bin/printf', 602: '/opt/tf/bin/tensorfold-native', 603: '/opt/tf/bin/tensorfold-native' };
  const listen = { 601: [`127.0.0.1:${port}`], 602: [`127.0.0.1:${port}`], 603: ['192.0.2.7:9500'] };
  const found = await discoverTensorFoldEngines({ platform: 'darwin', exec: fakeExec({ ps, exe, listen }).exec, uid: 501 });
  assert.deepEqual(found.engines.map(e => [e.pid, e.host, e.port]), [[602, '127.0.0.1', port]], 'printf is not an engine; the remote one is not read');

  const urls = [];
  const keyReads = [];
  const { servers } = await collectTensorFoldStatus([], {
    discovered: found.engines,
    fetchImpl: (url, opts) => { urls.push(String(url)); return fetch(url, opts); },
    readKeyFile: async path => { keyReads.push(path); return { token: DUMMY_KEY, note: null }; },
  });
  assert.ok(urls.length > 0 && urls.every(u => u.startsWith(`http://127.0.0.1:${port}/`)), `only loopback was asked: ${urls.join(', ')}`);
  assert.deepEqual(keyReads, [], 'no key file named on a command line is read');
  assert.ok(seen.every(r => r.auth === null), 'no Bearer header went anywhere');
  assertGetOnly(seen);
  assert.equal(servers[0].metrics, METRICS_STATES.AUTH_REQUIRED);
  assert.match(servers[0].reason, /--api-key-file, which is not read from a command line; add a models\.json entry for port \d+/);
});

test('a non-loopback address handed in as discovered is ignored, whatever the caller passes', async () => {
  const urls = [];
  const { servers, skipped } = await collectTensorFoldStatus([], {
    discovered: [engine(9, { host: 'example.invalid', apiKeyFile: true }), engine(10, { host: '192.0.2.7' })],
    fetchImpl: async url => { urls.push(String(url)); throw new Error('no network in this test'); },
    readKeyFile: async () => { throw new Error('no key file may be read'); },
  });
  assert.deepEqual([servers, skipped, urls], [[], [], []]);
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

test('a keyed engine is read with the key the user configured: a marked registry entry on its port, gated routes only', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const path = await keyFile(t, `# engine keys\n\nops: ${DUMMY_KEY}\nother-key-not-used\n`);
  const [marked] = loadRegistry([{ id: 'mine', host: '127.0.0.1', port, kind: 'openai', engine: 'tensorfold', keyFile: path }]);
  const { servers } = await collectTensorFoldStatus([marked], { discovered: [engine(port, { name: 'keyed', apiKeyFile: true })] });
  assertGetOnly(seen);
  const auth = Object.fromEntries(seen.map(r => [r.line, r.auth]));
  assert.equal(auth['GET /health'], null);
  assert.equal(auth['GET /metrics'], `Bearer ${DUMMY_KEY}`);
  assert.equal(auth['GET /v1/slide/graph'], `Bearer ${DUMMY_KEY}`);
  assert.deepEqual([servers[0].id, servers[0].source, servers[0].name], ['mine', 'registry', 'keyed']);
  assert.equal(servers[0].metrics, METRICS_STATES.OK);
  assert.equal(servers[0].tokens.generation_total, 6134);
  assert.doesNotMatch(JSON.stringify(servers), new RegExp(DUMMY_KEY));

  // An entry that does not say TensorFold keeps the old rule: probed without a key.
  const before = seen.length;
  const [unmarked] = loadRegistry([{ id: 'unmarked', host: '127.0.0.1', port, kind: 'openai', keyFile: path }]);
  const keyReads = [];
  await collectTensorFoldStatus([unmarked], {
    discovered: [engine(port)], readKeyFile: async p => { keyReads.push(p); return { token: DUMMY_KEY, note: null }; },
  });
  assert.deepEqual(keyReads, []);
  assert.ok(seen.slice(before).every(r => r.auth === null));
});

test('key files the engine itself would refuse are refused; command-line keys are only explained', async t => {
  const { port, seen } = await tfServer(t, keyedRoutes());
  const shared = await keyFile(t, `${DUMMY_KEY}\n`, 0o644);
  const marked = keyFilePath => loadRegistry([{ id: 'e', host: '127.0.0.1', port, kind: 'openai', engine: 'tensorfold', keyFile: keyFilePath }]);
  const cases = [
    [marked(shared), [engine(port)], /readable by other users; chmod 600/],
    [marked(join(tmpdir(), 'iak-tf-no-such', 'keys')), [engine(port)], /cannot read key file .* \(ENOENT\)/],
    [[], [engine(port, { keyOnArgv: true })], /given on the engine's command line; it is not read from there/],
    [[], [engine(port)], /started without a key file/],
  ];
  for (const [entries, discovered, why] of cases) {
    const { servers } = await collectTensorFoldStatus(entries, { discovered });
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
