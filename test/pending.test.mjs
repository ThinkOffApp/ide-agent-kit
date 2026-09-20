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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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
  KEY_SEPARATOR,
  ageSecondsFrom,
  fetchFailureReason,
  rollbackAnnouncements,
  announceToRoom,
  main,
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
    assert.match(result.unreachable[0].reason, /unreachable: .*ECONNREFUSED/);

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

test('end to end: --older-than hides a fresh item from the LIST but never from the exit code', async () => {
  const s = await intentsEndpoint([liveIntent('fresh', 2 * MIN)]);
  const { dir, cleanup } = tmpDir();
  try {
    const r = await runBin(['--daemon', s.base, '--config', join(dir, 'none.json'), '--json', '--older-than', '1h'], { dir });
    const doc = JSON.parse(r.stdout);
    // A 59-minute-old "Approve: rm -rf the backups" is still pending. The
    // threshold decides what is PRINTED, not whether anything is waiting, so
    // exit 0 keeps meaning exactly what --help says it means.
    assert.equal(r.code, EXIT.PENDING);
    assert.notEqual(r.code, EXIT.NONE_PENDING);
    assert.deepEqual(doc.pending, []);
    assert.equal(doc.pending_total, 1);
    assert.equal(doc.pending_below_threshold, 1);
    assert.deepEqual(doc.unreachable, []);
    assert.equal(doc.older_than_sec, 3600);

    const text = await runBin(['--daemon', s.base, '--config', join(dir, 'none.json'), '--older-than', '1h'], { dir });
    assert.doesNotMatch(text.stdout, /Nothing pending/);
    assert.match(text.stdout, /1 item is pending below that threshold/);
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

// ===========================================================================
// TIER 1: the three confirmed ways this tool could still print "you are clear"
// when the owner is not. Each of these was written to FAIL against the first
// version of bin/iak-pending.mjs, and each failure was a false all-clear.
// ===========================================================================

// --- T1: a roster we cannot read must not silently shrink the fleet ---------

test('T1: a corrupt or unreadable roster is an error, never a one-host all-clear', async () => {
  const up = await intentsEndpoint([]);
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = join(dir, 'none.json');
    const rosterFile = join(dir, 'roster.json');
    const good = JSON.stringify([{ handle: '@peer', gate: 'http://peer.example:8788' }]);

    // Baseline: the SAME roster, valid, sees two hosts and refuses to say all clear.
    writeFileSync(rosterFile, good);
    const valid = await runBin(['--daemon', up.base, '--config', cfg, '--timeout-sec', '1'], {
      dir, env: { IAK_WATCHDOG_ROSTER: '', IAK_WATCHDOG_ROSTER_FILE: rosterFile },
    });
    assert.equal(valid.code, EXIT.SOME_UNREACHABLE, 'baseline: a valid roster must see the peer');

    // ENOENT is the ONE readable-as-empty case: a single-machine install.
    const absent = await runBin(['--daemon', up.base, '--config', cfg], {
      dir, env: { IAK_WATCHDOG_ROSTER: '', IAK_WATCHDOG_ROSTER_FILE: join(dir, 'no-such-roster.json') },
    });
    assert.equal(absent.code, EXIT.NONE_PENDING, 'a missing roster is a single-machine install, not an error');

    // Everything else is a roster we cannot trust, and must never exit 0.
    const broken = {
      'corrupt JSON': () => writeFileSync(rosterFile, '[{"handle": "@peer", "gate"'),
      'NUL truncated': () => writeFileSync(rosterFile, good.slice(0, 20) + '\0'.repeat(40)),
      'wrong shape': () => writeFileSync(rosterFile, JSON.stringify({ peers: [{ handle: '@peer', gate: 'http://peer.example:8788' }] })),
      'unreadable': () => { writeFileSync(rosterFile, good); chmodSync(rosterFile, 0o000); },
    };
    for (const [name, make] of Object.entries(broken)) {
      chmodSync(rosterFile, 0o600);
      make();
      const r = await runBin(['--daemon', up.base, '--config', cfg, '--timeout-sec', '1'], {
        dir, env: { IAK_WATCHDOG_ROSTER: '', IAK_WATCHDOG_ROSTER_FILE: rosterFile },
      });
      assert.notEqual(r.code, EXIT.NONE_PENDING, `${name}: must not exit 0 with a real peer configured`);
      assert.doesNotMatch(r.stdout, /Nothing pending on 1 of 1 host/, `${name}: must not shrink the fleet to one host`);
      assert.match(r.stderr, /roster/i, `${name}: must say which file it could not trust`);
    }
    chmodSync(rosterFile, 0o600);

    // The inline env form has to obey the same rule.
    const inline = await runBin(['--daemon', up.base, '--config', cfg], {
      dir, env: { IAK_WATCHDOG_ROSTER: '[{"handle": "@peer"' },
    });
    assert.notEqual(inline.code, EXIT.NONE_PENDING, 'corrupt inline roster must not exit 0');
    assert.match(inline.stderr, /roster/i);
  } finally { await up.close(); cleanup(); }
});

// --- T2: a 200 whose rows are not the shape we understand -------------------

test('T2: a 200 whose rows do not carry a status we understand is a shape mismatch, not an empty queue', async () => {
  const cases = {
    'no status key': [{ id: 'a1', prompt: 'Approve: the thing', createdAt: NOW - HOUR }],
    'wrong case': [{ id: 'a1', prompt: 'Approve: the thing', status: 'PENDING', createdAt: NOW - HOUR }],
    'unknown vocabulary': [{ id: 'a1', prompt: 'Approve: the thing', status: 'open', createdAt: NOW - HOUR }],
  };
  for (const [name, body] of Object.entries(cases)) {
    const result = await collectPending({
      hosts: [host('local', 'http://shape.example:8788')],
      fetchImpl: fakeFetch({ 'http://shape.example:8788': { body } }),
      now: NOW,
    });
    const text = renderText({ ...result, thresholdSec: 0 });
    // Either it understood the row and listed it, or it could not and said so.
    // What it must never do is drop the row and call the queue empty.
    const listed = result.items.length === 1;
    const flagged = result.unreachable.length === 1;
    assert.ok(listed || flagged, `${name}: a pending item was silently dropped`);
    assert.notEqual(exitCodeFor({ ...result, items: result.items }), EXIT.NONE_PENDING, `${name}: false all-clear`);
    assert.doesNotMatch(text, /Nothing pending on 1 of 1 host/, `${name}: false all-clear in the text`);
    if (flagged) assert.match(result.unreachable[0].reason, /shape|status/i, `${name}: the reason must name the problem`);
  }
});

test('T2: rows the daemon marks decided are still a legitimate empty queue, not a shape mismatch', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://ok.example:8788')],
    fetchImpl: fakeFetch({ 'http://ok.example:8788': { body: [{ id: 'x', status: 'decided', decision: 'approve', createdAt: NOW - HOUR }] } }),
    now: NOW,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.unreachable.length, 0, 'a daemon that answered honestly must not be called unreachable');
  assert.equal(exitCodeFor(result), EXIT.NONE_PENDING);
});

// --- T3: the all-unreachable guard must be able to fail ---------------------

test('T3: with zero hosts answering the output contains NO all-clear sentence at all', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://127.0.0.1:1')],
    fetchImpl: fakeFetch({}),
    now: NOW,
  });
  const text = renderText({ ...result, thresholdSec: 0 });
  // Not a regex tuned to the exact sentence the code happens to emit: the
  // words themselves must not be there when nobody answered. The previous
  // version of this assertion matched a bare "Nothing pending." that the code
  // could never print, so it could not fail.
  assert.doesNotMatch(text, /Nothing pending/, 'zero hosts answered, so nothing may read as an all-clear');
  assert.equal(result.reachedCount, 0);
  assert.match(text, /NO host answered/);
});

test('T3: the all-clear sentence appears only when at least one host actually answered', async () => {
  const up = await intentsEndpoint([]);
  try {
    const answered = await collectPending({ hosts: [host('local', up.base)], now: NOW });
    assert.match(renderText({ ...answered, thresholdSec: 0 }), /Nothing pending on 1 of 1 host\./);
  } finally { await up.close(); }
});

// ===========================================================================
// Tier 2: the rest of the PR #122 review. Age believability, the honest exit
// code, ledger carry-forward, post rollback, and the --room block that had no
// coverage at all.
// ===========================================================================

const NUL = String.fromCharCode(0);

// --- ages we cannot believe -------------------------------------------------

test('an intent with NO createdAt goes through probeHost as an unknown age, and survives --older-than', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://ok.example:8788')],
    fetchImpl: fakeFetch({ 'http://ok.example:8788': { body: [{ id: 'no-ts', prompt: 'Approve: the thing', status: 'pending' }] } }),
    now: NOW,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].ageSec, null, 'a missing timestamp must not read as age zero');
  assert.equal(result.items[0].createdAt, null);
  assert.equal(filterByAge(result.items, 9 * 3600).length, 1, 'an un-ageable item must survive the threshold');
  assert.match(renderText({ ...result, thresholdSec: 0 }), /age unknown\s+local\s+no-ts/);
});

test('a future-dated intent is an unknown age, not a fresh one', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://ok.example:8788')],
    fetchImpl: fakeFetch({ 'http://ok.example:8788': { body: [{ id: 'skewed', status: 'pending', createdAt: NOW + 6 * HOUR }] } }),
    now: NOW,
  });
  assert.equal(result.items[0].ageSec, null, 'clock skew must not clamp to zero and then vanish under --older-than');
  assert.equal(filterByAge(result.items, 3600).length, 1);
});

test('a small clock skew inside the tolerance is still treated as age zero, not as unknown', () => {
  assert.equal(ageSecondsFrom(NOW + 10_000, NOW), 0);
  assert.equal(ageSecondsFrom(NOW + 10 * 60_000, NOW), null);
});

test('a seconds-valued createdAt is an unknown age, never a 20000-day item at the top of the list', async () => {
  const result = await collectPending({
    hosts: [host('local', 'http://ok.example:8788')],
    fetchImpl: fakeFetch({ 'http://ok.example:8788': { body: [
      { id: 'seconds', status: 'pending', createdAt: Math.floor((NOW - HOUR) / 1000) },
      { id: 'genuine', status: 'pending', createdAt: NOW - 9.2 * HOUR },
    ] } }),
    now: NOW,
  });
  const text = renderText({ ...result, thresholdSec: 0 });
  assert.equal(result.items.find((i) => i.id === 'seconds').ageSec, null);
  assert.doesNotMatch(text, /\d{4,}d /, 'an epoch-seconds timestamp must not render as tens of thousands of days');
  assert.match(text, /9h 12m\s+local\s+genuine/);
});

// --- the exit code says what --help says ------------------------------------

test('an item hidden by --older-than still makes the exit code say "pending"', () => {
  const view = { items: [], unreachable: [], hostCount: 1, totalPending: 1 };
  assert.equal(exitCodeFor(view), EXIT.PENDING);
  assert.notEqual(exitCodeFor(view), EXIT.NONE_PENDING);
  assert.equal(exitCodeFor({ items: [], unreachable: [], hostCount: 1, totalPending: 0 }), EXIT.NONE_PENDING);
});

test('the text says how many items the threshold hid, instead of implying none exist', () => {
  const text = renderText({ items: [], unreachable: [], hostCount: 1, reachedCount: 1, totalPending: 2, thresholdSec: 3600 });
  assert.doesNotMatch(text, /Nothing pending/);
  assert.match(text, /2 items are pending below that threshold/);
});

// --- ledger carry-forward ----------------------------------------------------

test('the ledger carries forward items on a host we could not ask, so a flapping peer cannot re-announce', () => {
  const state = {
    version: STATE_VERSION,
    announced: { '@peer p1': { level: 2, at: 1, host: '@peer' }, 'local gone': { level: 1, at: 1, host: 'local' } },
  };
  const picked = selectAnnouncements({
    items: [],
    thresholdSec: 3600,
    stateLoad: { ok: true, state },
    now: NOW,
    unreachableHosts: ['@peer'],
  });
  assert.deepEqual(Object.keys(picked.nextState.announced), ['@peer p1'], 'unreachable host keeps its entries, reachable host is pruned');

  const back = selectAnnouncements({
    items: [{ host: '@peer', id: 'p1', ageSec: 2 * 3600 }],
    thresholdSec: 3600,
    stateLoad: { ok: true, state: picked.nextState },
    now: NOW + HOUR,
  });
  assert.deepEqual(back.announce, [], 'a peer returning from a blip must not re-announce the same escalation');
});

// --- rollback on a failed post ----------------------------------------------

test('rollbackAnnouncements puts a failed announcement back to its previous level', () => {
  const stateLoad = { ok: true, state: { version: STATE_VERSION, announced: { 'local old': { level: 1, at: 1, host: 'local' } } } };
  const picked = selectAnnouncements({
    items: [{ host: 'local', id: 'old', ageSec: 2 * 3600 }, { host: 'local', id: 'new', ageSec: 2 * 3600 }],
    thresholdSec: 3600, stateLoad, now: NOW,
  });
  assert.deepEqual(picked.announce.map((i) => i.id).sort(), ['new', 'old']);
  const rolled = rollbackAnnouncements(picked, stateLoad);
  assert.equal(rolled.announced['local old'].level, 1, 'an escalation that never went out must not be recorded');
  assert.equal(rolled.announced['local new'], undefined);
});

// --- the --room block, which had no tests at all ----------------------------

function roomHarness({ dir, items, unreachable = [] }) {
  const posts = [];
  const errs = [];
  const view = {
    now: NOW, items, unreachable, hostCount: 1 + unreachable.length,
    reachedCount: 1, totalPending: items.length,
  };
  return {
    posts, errs, view,
    statePath: join(dir, 'ledger.json'),
    post: async (payload) => { posts.push(payload); },
    failingPost: async () => { throw new Error('room post failed: HTTP 503'); },
    errOut: (m) => errs.push(String(m)),
  };
}

// The key is the DUMMY_TOKEN constant, never a literal next to `api_key`: the
// repo's pre-commit secret scan flags that shape on sight, and it is right to.
const ROOM_CFG = { poller: { api_key: DUMMY_TOKEN }, mcp: { confirmations: { room: 'a-room' } } };

test('--room: the first escalation posts once, a second run on the same state posts nothing', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const h = roomHarness({ dir, items: [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'Approve: the thing' }] });
    // Run 1: no ledger yet, so by design it seeds and stays silent.
    const seed = await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
    assert.equal(seed.posted, false);
    assert.equal(seed.why, 'ledger-rebuilt');
    assert.equal(h.posts.length, 0);
    assert.equal(loadAnnounceState(h.statePath).ok, true, 'the ledger must actually be written, not assumed');

    // Run 2: the item doubles in age, so this is a new escalation. One post.
    const older = { ...h.view, items: [{ ...h.view.items[0], ageSec: 4 * 3600 }] };
    const first = await announceToRoom({ view: older, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
    assert.equal(first.posted, true);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].room, 'a-room');
    assert.match(h.posts[0].body, /4h 0m - local - `a1`/);

    // Run 3: same escalation, five minutes later. Silence.
    const again = await announceToRoom({ view: older, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
    assert.equal(again.posted, false);
    assert.equal(again.why, 'nothing-new');
    assert.equal(h.posts.length, 1, 'a timer tick must not repeat an announcement');
  } finally { cleanup(); }
});

test('--room: the ledger is genuinely written to disk before any post', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const h = roomHarness({ dir, items: [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'p' }] });
    writeFileSync(h.statePath, JSON.stringify({ version: STATE_VERSION, announced: {} }));
    await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
    const text = readFileSync(h.statePath, 'utf8');
    const onDisk = JSON.parse(text);
    assert.equal(onDisk.announced['local a1'].level, 2); // 2h against a 1h threshold: one doubling
    assert.equal(onDisk.announced['local a1'].host, 'local');
    assert.ok(!text.includes(NUL), 'the ledger must stay text, not become binary to grep');
  } finally { cleanup(); }
});

test('--room: an unwritable ledger means silence, not a post', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const h = roomHarness({ dir, items: [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'p' }] });
    const unwritable = join(dir, 'nope', 'ledger.json');
    chmodSync(dir, 0o500); // cannot create the subdirectory
    try {
      const r = await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: unwritable, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
      assert.equal(r.posted, false);
      assert.equal(r.why, 'ledger-unwritable');
      assert.equal(h.posts.length, 0);
      assert.match(h.errs.join('\n'), /could not write/);
    } finally { chmodSync(dir, 0o700); }
  } finally { cleanup(); }
});

test('--room: a failed post rolls the ledger back so the next run retries that escalation', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const h = roomHarness({ dir, items: [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'p' }] });
    writeFileSync(h.statePath, JSON.stringify({ version: STATE_VERSION, announced: {} }));
    const failed = await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.failingPost, errOut: h.errOut });
    assert.equal(failed.posted, false);
    assert.equal(failed.why, 'post-failed');
    assert.match(h.errs.join('\n'), /rolling back/);
    assert.deepEqual(JSON.parse(readFileSync(h.statePath, 'utf8')).announced, {}, 'a post that never went out must not be recorded');

    // The retry, on the very next run, posts. Without the rollback this item
    // would have gone quiet until its age doubled again: 9h to 18h.
    const retry = await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: h.statePath, config: ROOM_CFG, env: {}, post: h.post, errOut: h.errOut });
    assert.equal(retry.posted, true);
    assert.equal(h.posts.length, 1);
  } finally { cleanup(); }
});

test('--room: with no api key or room it posts nothing and does not record an announcement', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const h = roomHarness({ dir, items: [{ host: 'local', id: 'a1', ageSec: 2 * 3600, prompt: 'p' }] });
    writeFileSync(h.statePath, JSON.stringify({ version: STATE_VERSION, announced: {} }));
    const r = await announceToRoom({ view: h.view, thresholdSec: 3600, statePath: h.statePath, config: {}, env: {}, post: h.post, errOut: h.errOut });
    assert.equal(r.posted, false);
    assert.equal(r.why, 'unconfigured');
    assert.deepEqual(JSON.parse(readFileSync(h.statePath, 'utf8')).announced, {});
  } finally { cleanup(); }
});

test('--room: main() wires the room path end to end and never prints the room key', async () => {
  const s = await intentsEndpoint([liveIntent('a1', 9.2 * HOUR)]);
  const { dir, cleanup } = tmpDir();
  try {
    const statePath = join(dir, 'ledger.json');
    writeFileSync(statePath, JSON.stringify({ version: STATE_VERSION, announced: {} }));
    const posts = [];
    const outLines = [];
    const errLines = [];
    const code = await main(
      ['--daemon', s.base, '--config', join(dir, 'none.json'), '--older-than', '1h', '--room', '--room-name', 'a-room', '--state-file', statePath],
      {
        env: { IAK_WATCHDOG_ROSTER: '[]', GROUPMIND_KEY: DUMMY_TOKEN, IAK_GATE_TOKEN_FILE: process.env.IAK_GATE_TOKEN_FILE },
        out: (l) => outLines.push(String(l)),
        errOut: (l) => errLines.push(String(l)),
        post: async (p) => { posts.push(p); },
      },
    );
    assert.equal(code, EXIT.PENDING);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].apiKey, DUMMY_TOKEN);
    assert.match(posts[0].body, /9h \d+m - local - `a1`/);
    const printed = [...outLines, ...errLines].join('\n');
    assert.ok(!printed.includes(DUMMY_TOKEN), 'the room key must never be printed');
  } finally { await s.close(); cleanup(); }
});

// --- teeth on the tests the review found toothless --------------------------

test('the dedicated 401 branch is what produces the 401 reason, not the generic not-ok branch', async () => {
  const result = await collectPending({
    hosts: [host('@gated', 'http://gated.example:8788')],
    fetchImpl: fakeFetch({ 'http://gated.example:8788': { status: 401, body: {} } }),
    now: NOW,
  });
  const reason = result.unreachable[0].reason;
  // A bare "HTTP 401" is also what the generic branch emits, so asserting only
  // that let the dedicated branch be deleted with every test still passing.
  assert.match(reason, /HTTP 401: daemon (rejected this machine's gate token|requires a gate token)/);
  const other = await collectPending({
    hosts: [host('@x', 'http://x.example:8788')],
    fetchImpl: fakeFetch({ 'http://x.example:8788': { status: 500, body: {} } }),
    now: NOW,
  });
  assert.equal(other.unreachable[0].reason, 'HTTP 500', 'a 500 must not claim anything about tokens');
});

test('a REAL refused connection produces a reason a human can act on, not a bare "fetch failed"', async () => {
  // A port that was listening a moment ago and is now closed, so this is a
  // genuine ECONNREFUSED from Node - which wraps the useful part one level down
  // in `cause` and reports only "fetch failed" at the top.
  const dead = await intentsEndpoint([]);
  await dead.close();
  const result = await collectPending({
    hosts: [host('local', dead.base)],
    timeoutMs: 2000,
    now: Date.now(),
  });
  const reason = result.unreachable[0].reason;
  assert.notEqual(reason, 'unreachable: fetch failed');
  assert.match(reason, /ECONNREFUSED/, `uninformative failure reason: ${reason}`);
});

test('a timeout is reported as a timeout, with the limit that was applied', () => {
  assert.equal(fetchFailureReason({ name: 'TimeoutError' }, 5000), 'no answer in 5000ms');
  assert.match(fetchFailureReason(new TypeError('fetch failed'), 5000), /fetch failed/);
});

test('the ledger key is a plain, greppable, documented string', () => {
  // Hard-coded rather than built by calling itemKey(), which would agree with
  // any separator at all, NUL included.
  assert.equal(itemKey({ host: 'local', id: 'a1' }), 'local a1');
  assert.equal(KEY_SEPARATOR, ' ');
  assert.ok(!itemKey({ host: 'local', id: 'a1' }).includes(NUL));
});

// --- smaller confirmed items -------------------------------------------------

test('the same bad gate listed twice counts as one host, not two', () => {
  const hosts = resolveHosts({
    roster: [
      { handle: '@lanbox', gate: 'http://192.168.1.50:8788' },
      { handle: '@lanbox-again', gate: 'http://192.168.1.50:8788' },
    ],
  });
  assert.equal(hosts.length, 2, 'local plus one blocked peer');
  assert.equal(hosts.filter((h) => h.blocked).length, 1);
});

test('a flag given without a value is an error, not a silently ignored default', async () => {
  for (const argv of [['--older-than'], ['--older-than', '--json'], ['--daemon'], ['--state-file']]) {
    const r = parseArgs(argv);
    assert.match(r.error || '', /requires a value/, `${argv.join(' ')} was silently accepted`);
  }
  const run = await runBin(['--older-than']);
  assert.equal(run.code, EXIT.CANNOT_RUN);
  assert.match(run.stderr, /requires a value/);
});

test('--json reports only fields the daemon actually returns', async () => {
  const s = await intentsEndpoint([liveIntent('a1', 2 * HOUR)]);
  const { dir, cleanup } = tmpDir();
  try {
    const r = await runBin(['--daemon', s.base, '--config', join(dir, 'none.json'), '--json'], { dir });
    const doc = JSON.parse(r.stdout);
    // `options` used to be emitted and was always null: GET /intents is backed
    // by listIntents(), which does not return it. A field that is always null
    // is a claim the daemon never made.
    assert.ok(!('options' in doc.pending[0]), 'do not emit a field the daemon does not return');
    assert.deepEqual(Object.keys(doc.pending[0]).sort(), ['age', 'age_sec', 'created_at', 'host', 'id', 'prompt', 'session']);
    assert.equal(doc.pending_total, 1);
  } finally { await s.close(); cleanup(); }
});
