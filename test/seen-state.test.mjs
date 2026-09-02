// SPDX-License-Identifier: AGPL-3.0-only
// Issue #90 item 1: seen-state is durable and written per handled message.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveSeenIds, loadSeenIds } from '../src/common/seen-ids.mjs';
import { startRoomPoller } from '../src/team-relay/room-poller.mjs';

test('saveSeenIds writes atomically (no temp file left, content complete, round-trips)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-seen-'));
  try {
    const f = path.join(dir, 'seen');
    saveSeenIds(f, new Set(['a', 'b', 'c']));
    assert.deepEqual([...loadSeenIds(f)], ['a', 'b', 'c']);
    assert.deepEqual(readdirSync(dir), ['seen'], 'temp file renamed away');
    saveSeenIds(f, new Set(Array.from({ length: 2500 }, (_, i) => `id${i}`)), 2000);
    assert.equal(loadSeenIds(f).size, 2000, 'capped at maxIds');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the live poller remembers each message as it is handled, not once per batch', async () => {
  // Second message has a numeric body, which the poller cannot handle and
  // throws on. Before #90 the batch-level save never ran, so a restart
  // re-delivered message 1 (and every message before it). Now message 1 is
  // in the seen-file and its notification line is on disk before the crash.
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-seenlive-'));
  const savedPath = process.env.PATH;
  let timers;
  try {
    const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir);
    const stub = path.join(stubDir, 'curl');
    // first call (seeding, limit=50) must return nothing so the ids are unseen;
    // later calls return the two messages
    writeFileSync(stub, `#!/bin/sh
case "$*" in *limit=50*) echo "[]";; *) echo '[{"id":"m1","from":"petrus","body":"hello one","created_at":"2026-09-02T00:00:01Z"},{"id":"m2","from":"petrus","body":123,"created_at":"2026-09-02T00:00:02Z"}]';; esac
`);
    chmodSync(stub, 0o755);
    process.env.PATH = `${stubDir}:${savedPath}`;
    const seenFile = path.join(dir, 'seen'); const notifyFile = path.join(dir, 'notify');
    let threw = false;
    try {
      timers = await startRoomPoller({
        rooms: ['r'], apiKey: 'k', handle: '@t', interval: 3600,
        config: { poller: { seen_file: seenFile, notification_file: notifyFile, heartbeat_file: path.join(dir, 'hb'), nudge_mode: 'none' }, queue: { path: path.join(dir, 'q.jsonl') } }
      });
    } catch (e) { threw = true; }
    assert.ok(threw, 'the numeric body makes the first poll throw (the test premise)');
    assert.ok(existsSync(seenFile), 'seen-file exists after the crash');
    const seen = loadSeenIds(seenFile);
    assert.ok(seen.has('m1'), 'message 1 was persisted before message 2 crashed the batch');
    assert.match(readFileSync(notifyFile, 'utf8'), /petrus: hello one/, 'message 1 notification line is on disk');
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
