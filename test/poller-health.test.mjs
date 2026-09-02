// SPDX-License-Identifier: AGPL-3.0-only
// Issue #86: a nudge must not fire while the room poller is down, and the
// supervisor must say so once (and once more when it is back).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeHeartbeat, startRoomPoller } from '../src/team-relay/room-poller.mjs';
import { errLogQuietSince, lastSleepLine, sleepEvidenceSince } from '../scripts/poller-health-alert.mjs';

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

test('down-alert says "host slept" when the err log stopped before the heartbeat did, "Last error" when it kept failing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-slept-'));
  const posts = [];
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { posts.push(JSON.parse(raw).body); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hb = path.join(dir, 'hb'); const err = path.join(dir, 'err.log');
    const old = new Date(Date.now() - 900_000);
    writeFileSync(err, 'boot\n'); utimesSync(err, new Date(old.getTime() - 60_000), new Date(old.getTime() - 60_000));
    writeFileSync(hb, ''); utimesSync(hb, old, old);
    const env = (state) => ({ ...process.env, IAK_ALERT_KEY: 'k', IAK_POLLER_HEARTBEAT: hb, IAK_POLLER_ERR_LOG: err, IAK_ALERT_STATE: path.join(dir, state), IAK_ALERT_BASE: base, IAK_ALERT_ROOM: 'r', IAK_ALERT_LABEL: 'p' });
    await execFileP('node', [alert], { encoding: 'utf8', env: env('s1') });
    // no pmset evidence in a test process -> neutral wording, never a sleep claim
    assert.match(posts[0], /exited silently, was killed, or the host was suspended \(no OS sleep evidence found\)/);
    assert.ok(!/Looks like the host slept/.test(posts[0]));
    assert.ok(!/Last error/.test(posts[0]));
    writeFileSync(err, 'boot\nError: poller.rooms must be set\n');
    await execFileP('node', [alert], { encoding: 'utf8', env: env('s2') });
    assert.match(posts[1], /Last error: Error: poller\.rooms must be set/);
    assert.ok(!/host slept/.test(posts[1]));
  } finally { server.closeAllConnections?.(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('errLogQuietSince and lastSleepLine helpers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-helpers-'));
  try {
    const hb = path.join(dir, 'hb'); const err = path.join(dir, 'err');
    writeFileSync(err, 'x'); const t = new Date(Date.now() - 100_000); utimesSync(err, t, t);
    writeFileSync(hb, 'x');
    assert.equal(errLogQuietSince(err, hb), true);
    assert.equal(errLogQuietSince(path.join(dir, 'missing'), hb), false);
    const fake = () => 'noise\n2026-09-02 01:54:05 +0000 Sleep   Entering Sleep state due to Maintenance Sleep: 921 secs\nother\n';
    const sleepAt = Date.parse('2026-09-02T01:54:05Z');
    if (process.platform === 'darwin') {
      assert.match(sleepEvidenceSince(sleepAt - 600_000, fake), /Entering Sleep state/, 'sleep inside the stale window counts');
      assert.equal(sleepEvidenceSince(sleepAt + 3_600_000, fake), '', 'an older sleep is not evidence for a later gap');
      assert.match(lastSleepLine(fake), /Entering Sleep state/);
    } else {
      assert.equal(sleepEvidenceSince(0, fake), '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
