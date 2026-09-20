// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for bin/iak-pending.mjs.
//
// The shape here follows test/model-capacity.test.mjs: real loopback servers
// for the reachable cases, an injected fetch for the failure cases, and one
// test per state - plus the negative controls that make the states mean
// anything. The controls that matter most:
//
//   - an unreachable host must NOT reduce to "nothing pending"
//   - every host unreachable must NOT exit with the success code
//
// Both of those are failures this repo has actually shipped, so they are
// asserted from two directions each: the exit code AND the rendered text.
//
// Every credential in here is DUMMY_TOKEN, a made-up string, and the suite
// asserts it never appears in any output. This repository is public.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  STATE_VERSION,
  parseDuration,
  formatAge,
  resolveHosts,
  probeHost,
  collectPending,
  filterByAge,
  byOldestFirst,
  exitCodeFor,
  escalationLevel,
  loadAnnounceState,
  saveAnnounceState,
  selectAnnouncements,
  renderText,
  renderRoomBody,
  parseArgs,
  itemKey,
  HELP,
} from '../bin/iak-pending.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'iak-pending.mjs');
const DUMMY_TOKEN = 'dummy-gate-token-not-a-real-credential';
const NOW = Date.parse('2026-09-20T22:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

// The token resolver reads a file by default. Point it at nothing so no test
// can pick up the developer's real gate token and print it.
process.env.IAK_GATE_TOKEN_FILE = join(tmpdir(), 'iak-pending-test-no-such-token-file');
delete process.env.IAK_GATE_TOKEN;

// --- helpers ---------------------------------------------------------------

async function intentsEndpoint(rows, { status = 200 } = {}) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const intent = (id, agoMs, extra = {}) => ({
  id, prompt: `Approve: ${id}`, session: 'codex', status: 'pending',
  createdAt: NOW - agoMs, ...extra,
});

/**
 * An intent aged against the REAL clock, for the end-to-end tests: the spawned
 * binary reads Date.now() itself and cannot be handed the frozen NOW above.
 */
const liveIntent = (id, agoMs) => ({
  id, prompt: `Approve: ${id}`, session: 'codex', status: 'pending', createdAt: Date.now() - agoMs,
});

const host = (label, base, blocked = null) => ({ label, base, blocked });

/** A fetch that answers per-base, or throws for bases marked down. */
function fakeFetch(map) {
  return async (url) => {
    const base = new URL(url).origin;
    const entry = map[base];
    if (!entry) throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
    if (entry.throws) throw entry.throws;
    return {
      ok: entry.status === undefined || entry.status < 400,
      status: entry.status ?? 200,
      json: async () => entry.body,
    };
  };
}

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'iak-pending-'));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

/**
 * Run the real binary and read its exit code directly, never through a pipe.
 * Async on purpose: the stub daemons in these tests live in THIS process, so a
 * spawnSync would block the event loop that has to serve them and every probe
 * would time out (the same trap noted in poller-health.test.mjs).
 */
function runBin(argv, { dir, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...argv], {
      encoding: 'utf8',
      cwd: dir || tmpdir(),
      env: {
        ...process.env,
        IAK_WATCHDOG_ROSTER: env.IAK_WATCHDOG_ROSTER ?? '[]',
        IAK_GATE_TOKEN_FILE: process.env.IAK_GATE_TOKEN_FILE,
        ...env,
      },
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// --- duration + age --------------------------------------------------------

test('parseDuration understands s/m/h/d and bare seconds, and refuses junk', () => {
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('3600'), 3600);
  assert.equal(parseDuration('2 h'), 7200);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('-5m'), null);
  assert.equal(parseDuration(''), null);
});

test('formatAge makes a 9 hour wait look nothing like a 2 minute one', () => {
  assert.equal(formatAge(120), '2m');
  assert.equal(formatAge(33_120), '9h 12m');   // the measured 9.2h case
  assert.equal(formatAge(45), '45s');
  assert.equal(formatAge(90_000), '1d 1h');
  assert.equal(formatAge(null), 'age unknown');
  assert.notEqual(formatAge(33_120), formatAge(120));
});

// --- ordering + age computation --------------------------------------------

test('pending items sort oldest first and the age is computed from createdAt', async () => {
  const a = await intentsEndpoint([intent('young', 2 * MIN)]);
  const b = await intentsEndpoint([intent('ancient', 9.2 * HOUR), intent('middle', 45 * MIN)]);
  try {
    const result = await collectPending({
      hosts: [host('local', a.base), host('@peer', b.base)],
      now: NOW,
    });
    assert.deepEqual(result.items.map((i) => i.id), ['ancient', 'middle', 'young']);
    assert.equal(result.items[0].ageSec, Math.round(9.2 * 3600));
    assert.equal(formatAge(result.items[0].ageSec), '9h 12m');
    assert.equal(result.items[1].ageSec, 45 * 60);
    assert.equal(result.items[2].ageSec, 120);
    assert.equal(result.items[0].host, '@peer');
    assert.equal(result.unreachable.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('byOldestFirst puts an item with no usable timestamp at the very top', () => {
  const rows = [
    { id: 'b', ageSec: 100 }, { id: 'unknown', ageSec: null }, { id: 'a', ageSec: 9000 },
  ];
  assert.deepEqual([...rows].sort(byOldestFirst).map((r) => r.id), ['unknown', 'a', 'b']);
});

test('the rendered list is oldest first, with the age in the leading column', async () => {
  const s = await intentsEndpoint([intent('young', 2 * MIN), intent('ancient', 9.2 * HOUR)]);
  try {
    const result = await collectPending({ hosts: [host('local', s.base)], now: NOW });
    const lines = renderText({ ...result, thresholdSec: 0 }).split('\n').filter((l) => l.trim().startsWith('9h') || l.trim().startsWith('2m'));
    assert.match(lines[0], /^\s+9h 12m\s+local\s+ancient\s+Approve: ancient/);
    assert.match(lines[1], /^\s+2m\s+local\s+young/);
  } finally { await s.close(); }
});

// --- CORE CONTROL: unreachable is not "nothing pending" ---------------------

test('CONTROL: an unreachable host gets its own visible line and does NOT read as "nothing pending"', async () => {
  const up = await intentsEndpoint([]); // answered honestly: it has nothing
  try {
    const result = await collectPending({
      hosts: [host('local', up.base), host('@peer', 'http://peer.example:8788')],
      fetchImpl: fakeFetch({ [up.base]: { body: [] } }),
      now: NOW,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.unreachable.length, 1);
    assert.equal(result.unreachable[0].label, '@peer');
    assert.match(result.unreachable[0].reason, /unreachable: ECONNREFUSED/);

    const text = renderText({ ...result, thresholdSec: 0 });
    assert.match(text, /COULD NOT ASK 1 of 2 hosts/);
    assert.match(text, /@peer\s+http:\/\/peer\.example:8788\s+unreachable/);
    // The whole point: the output must not claim the fleet is clear.
    assert.doesNotMatch(text, /^Nothing pending\.$/m);
    assert.match(text, /Nothing pending on 1 of 2 hosts\./);
    assert.match(text, /NOT in the list above/);
    // And the exit code must not be the all-clear one.
    assert.equal(exitCodeFor({ ...result, thresholdSec: 0 }), EXIT.SOME_UNREACHABLE);
    assert.notEqual(exitCodeFor({ ...result }), EXIT.NONE_PENDING);
  } finally { await up.close(); }
});

test('CONTROL: an unreachable host still outranks pending items in the exit code, because the list is incomplete', () => {
  const view = { items: [{ id: 'x', ageSec: 10 }], unreachable: [{ label: '@peer' }], hostCount: 2 };
  assert.equal(exitCodeFor(view), EXIT.SOME_UNREACHABLE);
  assert.notEqual(exitCodeFor(view), EXIT.PENDING);
});

test('a 401 from a gated daemon is an unreachable line, not an empty list', async () => {
  const result = await collectPending({
    hosts: [host('@gated', 'http://gated.example:8788')],
    fetchImpl: fakeFetch({ 'http://gated.example:8788': { status: 401, body: { ok: false } } }),
    now: NOW,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.unreachable.length, 1);
  assert.match(result.unreachable[0].reason, /HTTP 401/);
  assert.equal(exitCodeFor(result), EXIT.NONE_REACHABLE);
});

test('a daemon answering with a non-list body is unreachable, not empty', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://127.0.0.1:1')],
    fetchImpl: fakeFetch({ 'http://127.0.0.1:1': { body: { ok: true } } }),
    now: NOW,
  });
  assert.equal(result.unreachable.length, 1);
  assert.match(result.unreachable[0].reason, /non-list body/);
  assert.notEqual(exitCodeFor(result), EXIT.NONE_PENDING);
});

// --- CORE CONTROL: all hosts unreachable ------------------------------------

test('CONTROL: all hosts unreachable exits with the distinct "could not reach any" code, not success', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://127.0.0.1:1'), host('@peer', 'http://peer.example:8788')],
    fetchImpl: fakeFetch({}),
    now: NOW,
  });
  assert.equal(result.reachedCount, 0);
  assert.equal(exitCodeFor(result), EXIT.NONE_REACHABLE);
  assert.notEqual(EXIT.NONE_REACHABLE, EXIT.NONE_PENDING);
  assert.notEqual(EXIT.NONE_REACHABLE, EXIT.SOME_UNREACHABLE);
  const text = renderText({ ...result, thresholdSec: 0 });
  assert.match(text, /NO host answered/);
  assert.match(text, /not "you are all clear"/);
});

test('the four exit codes are distinct and documented in --help', () => {
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.ok(new RegExp(`^\\s*${c}\\s`, 'm').test(HELP), `exit code ${c} is not documented in --help`);
});

// --- host resolution --------------------------------------------------------

test('resolveHosts always includes the local daemon and every roster gate', () => {
  const hosts = resolveHosts({
    config: { mcp: { confirmations: { host: '127.0.0.1', port: 8788 } } },
    roster: [
      { handle: '@peer', gate: 'http://peer.example:8788/' },
      { handle: '@mention-only' },                              // no gate: nothing to ask
      { handle: '@dupe', gate: 'http://peer.example:8788' },     // same gate as @peer
    ],
  });
  assert.deepEqual(hosts.map((h) => h.label), ['local', '@peer']);
  assert.equal(hosts[0].base, 'http://127.0.0.1:8788');
  assert.equal(hosts[1].base, 'http://peer.example:8788');
});

test('a roster gate naming another machine by LAN IP is refused, and shows up as its own unreachable line', async () => {
  const hosts = resolveHosts({ roster: [{ handle: '@lanbox', gate: 'http://192.168.1.50:8788' }] });
  const blocked = hosts.find((h) => h.label === '@lanbox');
  assert.match(blocked.blocked, /LAN IP \(192\.168\.x\)/);
  const result = await collectPending({ hosts: [blocked], fetchImpl: () => { throw new Error('must not be probed'); }, now: NOW });
  assert.equal(result.unreachable[0].asked, false);
  assert.match(result.unreachable[0].reason, /stable name/);
  assert.notEqual(exitCodeFor(result), EXIT.NONE_PENDING);
});

// --- decided intents --------------------------------------------------------

test('a decided intent never appears, even from a daemon that ignores ?status=pending', async () => {
  const s = await intentsEndpoint([
    intent('open', 3 * HOUR),
    { id: 'settled', prompt: 'Approve: settled', status: 'decided', decision: 'approve', createdAt: NOW - 4 * HOUR, decidedAt: NOW - HOUR },
  ]);
  try {
    const result = await collectPending({ hosts: [host('local', s.base)], now: NOW });
    assert.deepEqual(result.items.map((i) => i.id), ['open']);
    assert.doesNotMatch(renderText({ ...result, thresholdSec: 0 }), /settled/);
  } finally { await s.close(); }
});

test('probeHost asks for status=pending explicitly', async () => {
  let seen;
  await probeHost(host('local', 'http://127.0.0.1:1'), {
    fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => [] }; },
    now: NOW,
  });
  assert.equal(seen, 'http://127.0.0.1:1/intents?status=pending');
});

// --- --older-than -----------------------------------------------------------

test('--older-than filters at the boundary: equal counts, one second under does not', () => {
  const items = [
    { id: 'exactly', ageSec: 3600 },
    { id: 'under', ageSec: 3599 },
    { id: 'over', ageSec: 3601 },
    { id: 'unknown', ageSec: null },
  ];
  const kept = filterByAge(items, 3600).map((i) => i.id);
  assert.deepEqual(kept, ['exactly', 'over', 'unknown']);
  assert.ok(!kept.includes('under'));
  // No threshold means no filtering.
  assert.equal(filterByAge(items, 0).length, 4);
});

test('--older-than does not turn a filtered-out item into an all-clear on an unreachable fleet', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://127.0.0.1:1')],
    fetchImpl: fakeFetch({}),
    now: NOW,
  });
  const view = { ...result, items: filterByAge(result.items, 3600) };
  assert.equal(exitCodeFor(view), EXIT.NONE_REACHABLE);
});

// --- anti-nag ---------------------------------------------------------------

test('escalationLevel is 0 below the threshold, then one level per doubling', () => {
  assert.equal(escalationLevel(1800, 3600), 0);
  assert.equal(escalationLevel(3600, 3600), 1);
  assert.equal(escalationLevel(7199, 3600), 1);
  assert.equal(escalationLevel(7200, 3600), 2);
  assert.equal(escalationLevel(4 * 3600, 3600), 3);
  assert.equal(escalationLevel(9.2 * 3600, 3600), 4);   // the measured case: 4 posts, not 110
  assert.equal(escalationLevel(null, 3600), 1);         // unknown age: announce once
});

test('the anti-nag ledger prevents a second announcement of the same item', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, 'ledger.json');
    const items = [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'p' }];

    // First run: ledger exists but is empty of this item, so it is announced.
    assert.ok(saveAnnounceState(path, { version: STATE_VERSION, announced: {} }));
    const first = selectAnnouncements({ items, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW });
    assert.deepEqual(first.announce.map((i) => i.id), ['a1']);
    assert.ok(saveAnnounceState(path, first.nextState));

    // Second run, same item, same escalation: silence.
    const second = selectAnnouncements({ items, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW + 5 * MIN });
    assert.deepEqual(second.announce, []);
    assert.ok(saveAnnounceState(path, second.nextState));

    // Third run, the item has doubled in age: one more announcement, and only one.
    const older = [{ ...items[0], ageSec: 4 * 3600 }];
    const third = selectAnnouncements({ items: older, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW + HOUR });
    assert.deepEqual(third.announce.map((i) => i.id), ['a1']);
    assert.ok(saveAnnounceState(path, third.nextState));
    const fourth = selectAnnouncements({ items: older, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW + 2 * HOUR });
    assert.deepEqual(fourth.announce, []);
  } finally { cleanup(); }
});

test('a MISSING ledger results in silence, not a re-announcement of everything', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const path = join(dir, 'never-written.json');
    const items = [
      { host: 'local', id: 'a', ageSec: 9 * 3600 },
      { host: 'local', id: 'b', ageSec: 5 * 3600 },
      { host: '@peer', id: 'c', ageSec: 2 * 3600 },
    ];
    const load = loadAnnounceState(path);
    assert.equal(load.ok, false);
    assert.equal(load.reason, 'missing');
    const picked = selectAnnouncements({ items, thresholdSec: 3600, stateLoad: load, now: NOW });
    assert.deepEqual(picked.announce, [], 'a missing ledger must not produce a storm');
    assert.equal(picked.silencedBecause, 'missing');
    // It seeds the ledger instead, so the NEXT escalation is announced normally.
    assert.equal(Object.keys(picked.nextState.announced).length, 3);
    assert.ok(saveAnnounceState(path, picked.nextState));
    const next = selectAnnouncements({ items, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW + MIN });
    assert.deepEqual(next.announce, []);
    const doubled = items.map((i) => ({ ...i, ageSec: i.ageSec * 2 }));
    const after = selectAnnouncements({ items: doubled, thresholdSec: 3600, stateLoad: loadAnnounceState(path), now: NOW + HOUR });
    assert.deepEqual(after.announce.map((i) => i.id), ['a', 'b', 'c']);
  } finally { cleanup(); }
});

test('a CORRUPT ledger results in silence, and is rebuilt rather than trusted', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const items = [{ host: 'local', id: 'a', ageSec: 9 * 3600 }];
    for (const [name, contents] of [
      ['garbage.json', 'not json at all {{{'],
      ['array.json', '[]'],
      ['wrong-version.json', JSON.stringify({ version: 999, announced: {} })],
      ['no-map.json', JSON.stringify({ version: STATE_VERSION, announced: 'nope' })],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, contents);
      const load = loadAnnounceState(path);
      assert.equal(load.ok, false, `${name} should not load`);
      assert.match(load.reason, /corrupt/);
      const picked = selectAnnouncements({ items, thresholdSec: 3600, stateLoad: load, now: NOW });
      assert.deepEqual(picked.announce, [], `${name} must degrade to silence`);
      assert.ok(saveAnnounceState(path, picked.nextState));
      assert.equal(loadAnnounceState(path).ok, true, `${name} should be rebuilt`);
    }
  } finally { cleanup(); }
});

test('the ledger holds only currently-pending items, so decided ones are pruned', () => {
  const state = { version: STATE_VERSION, announced: { [itemKey({ host: 'local', id: 'gone' })]: { level: 2, at: 1 } } };
  const picked = selectAnnouncements({
    items: [{ host: 'local', id: 'still-here', ageSec: 2 * 3600 }],
    thresholdSec: 3600,
    stateLoad: { ok: true, state },
    now: NOW,
  });
  assert.deepEqual(Object.keys(picked.nextState.announced), [itemKey({ host: 'local', id: 'still-here' })]);
});

test('items below the threshold never enter the ledger, so crossing it later still announces', () => {
  const picked = selectAnnouncements({
    items: [{ host: 'local', id: 'fresh', ageSec: 60 }],
    thresholdSec: 3600,
    stateLoad: { ok: true, state: { version: STATE_VERSION, announced: {} } },
    now: NOW,
  });
  assert.deepEqual(picked.announce, []);
  assert.deepEqual(picked.nextState.announced, {});
});

test('--room refuses to run without --older-than, so a timer cannot post every tick', async () => {
  const r = await runBin(['--room']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--room requires --older-than/);
});

test('--older-than rejects an unparseable duration instead of guessing one', async () => {
  const r = await runBin(['--older-than', 'soonish']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot parse/);
});

// --- end to end through the real binary ------------------------------------

test('end to end: exit code 10 with pending items, 0 when genuinely clear', async () => {
  const withItems = await intentsEndpoint([liveIntent('a1', 9.2 * HOUR)]);
  const empty = await intentsEndpoint([]);
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = join(dir, 'no-config.json');
    const hot = await runBin(['--daemon', withItems.base, '--config', cfg], { dir });
    assert.equal(hot.code, EXIT.PENDING);
    assert.match(hot.stdout, /WAITING ON YOU/);
    assert.match(hot.stdout, /9h \d+m\s+local\s+a1/);

    const clear = await runBin(['--daemon', empty.base, '--config', cfg], { dir });
    assert.equal(clear.code, EXIT.NONE_PENDING);
    assert.match(clear.stdout, /Nothing pending on 1 of 1 host\./);
  } finally { await withItems.close(); await empty.close(); cleanup(); }
});

test('end to end: every host unreachable exits 12 and never prints an all-clear', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const r = await runBin(['--daemon', 'http://127.0.0.1:9', '--config', join(dir, 'none.json'), '--timeout-sec', '1'], {
      dir,
      env: { IAK_WATCHDOG_ROSTER: JSON.stringify([{ handle: '@peer', gate: 'http://127.0.0.1:10' }]) },
    });
    assert.equal(r.code, EXIT.NONE_REACHABLE);
    assert.notEqual(r.code, EXIT.NONE_PENDING);
    assert.match(r.stdout, /COULD NOT ASK 2 of 2 hosts/);
    assert.match(r.stdout, /NO host answered/);
    assert.doesNotMatch(r.stdout, /WAITING ON YOU/);
  } finally { cleanup(); }
});

test('end to end: --json carries ages, unreachable hosts and the exit code', async () => {
  const s = await intentsEndpoint([liveIntent('a1', 9.2 * HOUR)]);
  const { dir, cleanup } = tmpDir();
  try {
    const r = await runBin(['--daemon', s.base, '--config', join(dir, 'none.json'), '--json', '--timeout-sec', '1'], {
      dir,
      env: { IAK_WATCHDOG_ROSTER: JSON.stringify([{ handle: '@peer', gate: 'http://127.0.0.1:10' }]) },
    });
    const doc = JSON.parse(r.stdout);
    assert.equal(r.code, EXIT.SOME_UNREACHABLE);
    assert.equal(doc.exit_code, EXIT.SOME_UNREACHABLE);
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0].id, 'a1');
    assert.match(doc.pending[0].age, /^9h/);
    assert.ok(doc.pending[0].age_sec >= 9 * 3600);
    assert.equal(doc.unreachable.length, 1);
    assert.equal(doc.unreachable[0].host, '@peer');
    assert.equal(doc.reached_count, 1);
    assert.equal(doc.host_count, 2);
  } finally { await s.close(); cleanup(); }
});

test('end to end: --older-than hides fresh items but the host is still reported as asked', async () => {
  const s = await intentsEndpoint([liveIntent('fresh', 2 * MIN)]);
  const { dir, cleanup } = tmpDir();
  try {
    const r = await runBin(['--daemon', s.base, '--config', join(dir, 'none.json'), '--json', '--older-than', '1h'], { dir });
    const doc = JSON.parse(r.stdout);
    assert.equal(r.code, EXIT.NONE_PENDING);
    assert.deepEqual(doc.pending, []);
    assert.deepEqual(doc.unreachable, []);
    assert.equal(doc.older_than_sec, 3600);
  } finally { await s.close(); cleanup(); }
});

// --- secrets ----------------------------------------------------------------

test('the gate token never reaches the output or the command line', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const tokenFile = join(dir, 'gate.token');
    writeFileSync(tokenFile, `${DUMMY_TOKEN}\n`, { mode: 0o600 });
    let sawAuth = null;
    const server = createServer((req, res) => {
      sawAuth = req.headers.authorization || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await runBin(['--daemon', base, '--config', join(dir, 'none.json'), '--json'], {
        dir, env: { IAK_GATE_TOKEN_FILE: tokenFile },
      });
      // It is sent to loopback (a trusted host) ...
      assert.equal(sawAuth, `Bearer ${DUMMY_TOKEN}`);
      // ... and appears nowhere a human or a log would see it.
      assert.ok(!r.stdout.includes(DUMMY_TOKEN), 'token leaked to stdout');
      assert.ok(!r.stderr.includes(DUMMY_TOKEN), 'token leaked to stderr');
    } finally { await new Promise((res2) => server.close(res2)); }
  } finally { cleanup(); }
});

test('the 401 reason says whether a token was offered, and never what it was', async () => {
  const result = await collectPending({
    hosts: [host('@gated', 'http://gated.example:8788')],
    fetchImpl: fakeFetch({ 'http://gated.example:8788': { status: 401, body: {} } }),
    now: NOW,
  });
  const reason = result.unreachable[0].reason;
  assert.match(reason, /HTTP 401/);
  assert.ok(!reason.includes(DUMMY_TOKEN));
});

// --- misc -------------------------------------------------------------------

test('parseArgs reads the flags it documents and refuses what it does not', () => {
  const a = parseArgs(['--json', '--room', '--older-than', '2h', '--daemon', 'http://x:1', '--state-file', '/tmp/s.json']);
  assert.equal(a.json, true);
  assert.equal(a.room, true);
  assert.equal(a.olderThan, '2h');
  assert.equal(a.daemon, 'http://x:1');
  assert.equal(a.stateFile, '/tmp/s.json');
  assert.equal(a.error, null);
  assert.match(parseArgs(['--nope']).error, /unknown argument/);
});

test('the room summary leads with age and says plainly when hosts were missed', () => {
  const body = renderRoomBody({
    items: [{ host: 'local', id: 'a1', ageSec: 9.2 * 3600, prompt: 'Approve: restart the poller' }],
    unreachable: [{ label: '@peer' }],
    hostCount: 2, reachedCount: 1, thresholdSec: 3600,
  });
  assert.match(body, /9h 12m - local - `a1` - Approve: restart the poller/);
  assert.match(body, /Could not reach 1 of 2 hosts \(@peer\)/);
  assert.ok(!body.includes('\u2014'), 'no em dashes in room posts');
});

test('--help documents the anti-nag contract and the empty-vs-error rule', async () => {
  assert.match(HELP, /ANTI-NAG/);
  assert.match(HELP, /MISSING or CORRUPT/);
  assert.match(HELP, /EMPTY IS NOT ERROR/);
  const r = await runBin(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /EXIT CODES/);
});

test('this suite never wrote a real credential into the repo', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(source.includes('dummy-gate-token-not-a-real-credential'));
  assert.ok(!/xfb_[a-f0-9]{16}/.test(source));
  assert.ok(!/antfarm_[A-Za-z0-9]{16}/.test(source));
});
