// SPDX-License-Identifier: AGPL-3.0-only
// Regression (claudemm, 2 Sep 2026): after #92 widened the fetch window, a
// restart replayed months-old messages whose ids the seen cap had evicted.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSeenIds } from '../src/common/seen-ids.mjs';
import { startRoomPoller } from '../src/team-relay/room-poller.mjs';

test('old messages below the room watermark are marked seen and never notified, new ones still are', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-wm-'));
  const savedPath = process.env.PATH;
  let timers;
  try {
    const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir);
    // seed (limit=50): two messages from 31 Aug set the watermark.
    // first poll (limit=25): the wide window now shows three February/June
    // messages with ids nobody has seen (evicted from the seen cap on a real
    // box) plus one genuinely new message.
    writeFileSync(path.join(stubDir, 'curl'), `#!/bin/sh
case "$*" in
  *limit=50*) echo '[{"id":"a1","from":"petrus","body":"old aug one","created_at":"2026-08-31T12:00:00Z"},{"id":"a2","from":"petrus","body":"old aug two","created_at":"2026-08-31T12:05:00Z"}]';;
  *) echo '[{"id":"n1","from":"petrus","body":"genuinely new","created_at":"2026-09-02T14:50:00Z"},{"id":"a2","from":"petrus","body":"old aug two","created_at":"2026-08-31T12:05:00Z"},{"id":"f1","from":"petrus","body":"from february","created_at":"2026-02-10T09:00:00Z"},{"id":"f2","from":"@x","body":"from june","created_at":"2026-06-03T09:00:00Z"},{"id":"f3","from":"petrus","body":"from may","created_at":"2026-05-01T09:00:00Z"}]';;
esac
`);
    chmodSync(path.join(stubDir, 'curl'), 0o755);
    process.env.PATH = `${stubDir}:${savedPath}`;
    const seenFile = path.join(dir, 'seen'); const notifyFile = path.join(dir, 'notify');
    const origLog = console.log; console.log = () => {};
    try {
      timers = await startRoomPoller({
        rooms: ['r'], apiKey: 'k', handle: '@t', interval: 3600,
        config: { poller: { seen_file: seenFile, notification_file: notifyFile, heartbeat_file: path.join(dir, 'hb'), nudge_mode: 'none', owner_handle: 'petrus', history_file: path.join(dir, 'hist.json') }, queue: { path: path.join(dir, 'q.jsonl') } }
      });
    } finally { console.log = origLog; }
    const lines = readFileSync(notifyFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.filter((l) => /petrus: genuinely new/.test(l)).length, 1, `the new message is notified once: ${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => /from february|from june|from may/.test(l)), `old messages never reach the notification file: ${lines.join(' | ')}`);
    const seen = loadSeenIds(seenFile);
    for (const id of ['a1', 'a2', 'n1', 'f1', 'f2', 'f3']) assert.ok(seen.has(id), `${id} is in the seen file`);
    const hist = JSON.parse(readFileSync(path.join(dir, 'hist.json'), 'utf8'));
    assert.equal(hist._marks.r, '2026-09-02T14:50:00.000Z', 'watermark advanced to the new message');
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an outage backlog behind the first new message in a newest-first batch is still delivered (codex, PR #95)', async () => {
  const { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { startRoomPoller } = await import('../src/team-relay/room-poller.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-wm-backlog-'));
  const savedPath = process.env.PATH; const origLog = console.log; console.log = () => {};
  let timers;
  try {
    const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir);
    // seed sets the watermark at 12:00; the poller then "returns from an outage"
    // and the fetch shows, newest first: a 14:50 message and a 13:00 backlog
    // message. Both are newer than the watermark and both must be delivered.
    writeFileSync(path.join(stubDir, 'curl'), `#!/bin/sh
case "$*" in
  *limit=50*) echo '[{"id":"a1","from":"petrus","body":"seed","created_at":"2026-08-31T12:00:00Z"}]';;
  *) echo '[{"id":"n1","from":"petrus","body":"newest first","created_at":"2026-09-02T14:50:00Z"},{"id":"b1","from":"petrus","body":"backlog from the outage","created_at":"2026-09-02T13:00:00Z"},{"id":"a1","from":"petrus","body":"seed","created_at":"2026-08-31T12:00:00Z"}]';;
esac
`);
    chmodSync(path.join(stubDir, 'curl'), 0o755);
    process.env.PATH = `${stubDir}:${savedPath}`;
    const notifyFile = path.join(dir, 'notify');
    timers = await startRoomPoller({ rooms: ['r'], apiKey: 'k', handle: '@t', interval: 3600,
      config: { poller: { seen_file: path.join(dir, 'seen'), notification_file: notifyFile, heartbeat_file: path.join(dir, 'hb'), nudge_mode: 'none', history_file: path.join(dir, 'hist.json') }, queue: { path: path.join(dir, 'q.jsonl') } } });
    const lines = readFileSync(notifyFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.filter((l) => /petrus: newest first/.test(l)).length, 1, 'new message delivered once');
    assert.equal(lines.filter((l) => /petrus: backlog from the outage/.test(l)).length, 1, `backlog behind it delivered too: ${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => /petrus: seed/.test(l)), 'the seeded message is not re-delivered');
    const hist = JSON.parse(readFileSync(path.join(dir, 'hist.json'), 'utf8'));
    assert.equal(hist._marks.r, '2026-09-02T14:50:00.000Z', 'watermark advanced once, to the newest processed');
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    console.log = origLog; process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true });
  }
});
