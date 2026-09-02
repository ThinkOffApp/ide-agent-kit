// SPDX-License-Identifier: AGPL-3.0-only
// Issue #86: a nudge must not fire while the room poller is down, and the
// supervisor must say so once (and once more when it is back).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeHeartbeat, startRoomPoller } from '../src/team-relay/room-poller.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nudge = path.join(repoRoot, 'tools', 'codex_gui_nudge.sh');
const alert = path.join(repoRoot, 'scripts', 'poller-health-alert.mjs');

test('writeHeartbeat stamps the file with the current time', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-hb-'));
  try {
    const hb = path.join(dir, 'hb');
    assert.equal(writeHeartbeat(hb), true);
    assert.match(readFileSync(hb, 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex_gui_nudge refuses to type while the poller heartbeat is missing or stale', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-nudge-'));
  try {
    const log = path.join(dir, 'nudge.log');
    const missing = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, IAK_POLLER_HEARTBEAT: path.join(dir, 'none'), IAK_CODEX_NUDGE_LOG: log } });
    assert.equal(missing.status, 1);
    assert.match(readFileSync(log, 'utf8'), /ABORT poller down \(no heartbeat/);

    const hb = path.join(dir, 'hb');
    writeFileSync(hb, 'x');
    const old = new Date(Date.now() - 600_000);
    utimesSync(hb, old, old);
    const stale = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, IAK_POLLER_HEARTBEAT: hb, IAK_POLLER_MAX_AGE_SEC: '180', IAK_CODEX_NUDGE_LOG: log } });
    assert.equal(stale.status, 1);
    assert.match(readFileSync(log, 'utf8'), /ABORT poller down \(heartbeat \d+s old, max 180s\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('poller-health-alert posts once when down, once when back, nothing in between', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-alert-'));
  const posts = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      posts.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw).body });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hb = path.join(dir, 'hb'); const state = path.join(dir, 'state'); const err = path.join(dir, 'err.log');
    writeFileSync(err, 'boot\nError: poller.rooms, poller.api_key (or poller.api_key_file), and poller.handle must be set in config\n');
    const env = { ...process.env, IAK_ALERT_KEY: 'k1', IAK_POLLER_HEARTBEAT: hb, IAK_POLLER_ERR_LOG: err, IAK_ALERT_STATE: state, IAK_ALERT_BASE: base, IAK_ALERT_ROOM: 'r', IAK_ALERT_LABEL: 'test poller' };
    // async spawn: the stub server lives in THIS process, so a spawnSync
    // child could never be answered (deadlock, found writing this test)
    const run = () => execFileP('node', [alert], { encoding: 'utf8', env });

    await run();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/rooms/r/messages');
    assert.equal(posts[0].key, 'k1');
    assert.match(posts[0].body, /test poller is down \(no heartbeat file/);
    assert.match(posts[0].body, /Last error: Error: poller\.rooms/);
    assert.ok(existsSync(state));

    await run();
    assert.equal(posts.length, 1, 'second run must not post again');

    writeHeartbeat(hb);
    await run();
    assert.equal(posts.length, 2);
    assert.match(posts[1].body, /test poller is back/);
    assert.ok(!existsSync(state));

    await run(); assert.equal(posts.length, 2, 'healthy + no state = silent');
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the poller the CLI actually runs writes the heartbeat on every poll', async () => {
  // src/team-relay/room-poller.mjs is what bin/cli.mjs imports; a stub curl on
  // PATH keeps it off the network (same trick as the ioreg stub tests).
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-live-'));
  const stub = path.join(dir, 'curl');
  writeFileSync(stub, '#!/bin/sh\necho "[]"\n');
  chmodSync(stub, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  const hb = path.join(dir, 'hb');
  let timers;
  try {
    timers = await startRoomPoller({
      rooms: ['r'], apiKey: 'k', handle: '@t', interval: 1,
      config: { poller: { seen_file: path.join(dir, 'seen'), notification_file: path.join(dir, 'notify'), heartbeat_file: hb, nudge_mode: 'none' }, queue: { path: path.join(dir, 'q.jsonl') } }
    });
    assert.ok(existsSync(hb), 'heartbeat written by the first poll');
    const first = readFileSync(hb, 'utf8');
    await new Promise((r) => setTimeout(r, 1300));
    assert.notEqual(readFileSync(hb, 'utf8'), first, 'heartbeat refreshed by the interval poll');
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('poller-health-alert gives up on a stalled POST within the timeout and keeps no state', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-alert-stall-'));
  let hits = 0;
  const server = createServer((req) => { hits++; req.on('data', () => {}); /* never answer */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = path.join(dir, 'state');
    const env = { ...process.env, IAK_ALERT_KEY: 'k1', IAK_POLLER_HEARTBEAT: path.join(dir, 'none'), IAK_ALERT_STATE: state, IAK_ALERT_BASE: base, IAK_ALERT_ROOM: 'r', IAK_ALERT_TIMEOUT_MS: '300' };
    const t0 = Date.now();
    await assert.rejects(execFileP('node', [alert], { encoding: 'utf8', env }), (e) => /post failed, will retry next loop/.test(e.stderr));
    assert.ok(Date.now() - t0 < 5000, 'returned promptly, not hung on the socket');
    assert.equal(hits, 1);
    assert.ok(!existsSync(state), 'no state file after a failed post, so the next loop retries');
  } finally { server.closeAllConnections?.(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('codex_gui_nudge debounces a second nudge inside the window, and only a real injection stamps it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-debounce-'));
  try {
    const log = path.join(dir, 'nudge.log');
    const hb = path.join(dir, 'hb'); writeHeartbeat(hb);
    const stamp = path.join(dir, 'last');
    // a nudge injected 10 s ago -> this one is debounced before any GUI or idle wait
    writeFileSync(stamp, '');
    const t = new Date(Date.now() - 10_000); utimesSync(stamp, t, t);
    const r = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, IAK_POLLER_HEARTBEAT: hb, IAK_NUDGE_STAMP: stamp, IAK_NUDGE_DEBOUNCE_SEC: '120', IAK_CODEX_NUDGE_LOG: log } });
    assert.equal(r.status, 0);
    assert.match(readFileSync(log, 'utf8'), /debounced \(\d+s since last nudge, window 120s\)/);
    // an aborted nudge (poller down) must not touch the stamp
    const stale = path.join(dir, 'none');
    const before = statSync(stamp).mtimeMs;
    const r2 = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, IAK_POLLER_HEARTBEAT: stale, IAK_NUDGE_STAMP: stamp, IAK_CODEX_NUDGE_LOG: log } });
    assert.equal(r2.status, 1);
    assert.equal(statSync(stamp).mtimeMs, before, 'abort paths never write the stamp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex_gui_nudge: a reservation held by another nudge debounces this one right before injection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-reserve-'));
  try {
    const log = path.join(dir, 'nudge.log');
    const hb = path.join(dir, 'hb'); writeHeartbeat(hb);
    const stamp = path.join(dir, 'last');
    mkdirSync(stamp + '.lock'); // the other process is injecting right now
    // stubs so the run passes the screen-lock and human-idle checks and reaches
    // the reservation: ioreg (idle guard), a fake python that reports
    // "unlocked" and "idle", and an osascript that must never be reached
    const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir);
    const mk = (name, body) => { const f = path.join(stubDir, name); writeFileSync(f, body); chmodSync(f, 0o755); return f; };
    mk('ioreg', '#!/bin/sh\necho \'| "HIDIdleTime" = 999999999999\'\n');
    const py = mk('fakepy', '#!/bin/sh\n[ "$1" = "-" ] && echo unlocked\nexit 0\n');
    mk('osascript', '#!/bin/sh\necho "MUST NOT RUN" >&2; exit 99\n');
    const idleCheck = mk('idle.py', '#!/bin/sh\nexit 0\n');
    const r = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, IAK_POLLER_HEARTBEAT: hb, IAK_NUDGE_STAMP: stamp, IAK_CODEX_NUDGE_LOG: log, IAK_CLICLICK_BIN: '/nonexistent', IAK_PYTHON_BIN: py, IAK_HUMAN_IDLE_CHECK: idleCheck } });
    const out = readFileSync(log, 'utf8');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/MUST NOT RUN/.test(r.stderr), 'no injection while another nudge holds the reservation');
    assert.match(out, /debounced \(another nudge is injecting right now\)/);
    assert.ok(existsSync(stamp + '.lock'), 'a reservation held by another process is not released by us');
    assert.ok(!existsSync(stamp), 'no stamp written by a debounced run');
    // positive control: with no reservation the same stubs DO reach the
    // injection (the osascript stub fails), and a failed send leaves no stamp
    rmSync(stamp + '.lock', { recursive: true, force: true });
    const r2 = spawnSync('bash', [nudge], { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, IAK_POLLER_HEARTBEAT: hb, IAK_NUDGE_STAMP: stamp, IAK_CODEX_NUDGE_LOG: log, IAK_CLICLICK_BIN: '/nonexistent', IAK_PYTHON_BIN: py, IAK_HUMAN_IDLE_CHECK: idleCheck } });
    assert.match(r2.stderr, /MUST NOT RUN/, 'control: the stubs reach the injection point');
    assert.equal(r2.status, 1, 'a failed injection exits 1');
    assert.ok(!existsSync(stamp), 'a failed injection writes no stamp');
    assert.ok(!existsSync(stamp + '.lock'), 'the reservation is released on exit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
