// SPDX-License-Identifier: AGPL-3.0-only
// A message first seen when already old is remembered, never delivered.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRoomPoller } from '../src/team-relay/room-poller.mjs';
import { loadSeenIds } from '../src/common/seen-ids.mjs';

test('old messages are marked seen without notification; fresh ones are delivered (control)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-stale-'));
  const savedPath = process.env.PATH; const origLog = console.log; const logs = [];
  let timers;
  try {
    const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir);
    const fresh = new Date().toISOString();
    writeFileSync(path.join(stubDir, 'curl'), `#!/bin/sh
case "$*" in *limit=50*) echo "[]";; *) echo '[{"id":"old1","from":"petrus","body":"codex make 2.0 release","created_at":"2026-03-08T19:56:35Z"},{"id":"new1","from":"petrus","body":"claudemm are you there","created_at":"${fresh}"}]';; esac
`);
    chmodSync(path.join(stubDir, 'curl'), 0o755);
    process.env.PATH = `${stubDir}:${savedPath}`;
    console.log = (...a) => logs.push(a.join(' '));
    const seenFile = path.join(dir, 'seen'); const notifyFile = path.join(dir, 'notify');
    timers = await startRoomPoller({ rooms: ['r'], apiKey: 'k', handle: '@t', interval: 3600,
      config: { poller: { seen_file: seenFile, notification_file: notifyFile, heartbeat_file: path.join(dir, 'hb'), nudge_mode: 'none' }, queue: { path: path.join(dir, 'q.jsonl') } } });
    const seen = loadSeenIds(seenFile);
    assert.ok(seen.has('old1') && seen.has('new1'), 'both remembered');
    const notify = existsSync(notifyFile) ? readFileSync(notifyFile, 'utf8') : '';
    // #92 appends the asker's previous message as context to the fresh line, so
    // the March TEXT may appear inside it; what must not exist is a LINE for it.
    assert.ok(!notify.split('\n').some((l) => l.startsWith('[2026-03-08')), 'the March message is not delivered as a line');
    assert.match(notify, /petrus: claudemm are you there/, 'control: the fresh message is delivered');
    assert.ok(logs.some((l) => /1 message\(s\) older than 21600s marked seen without notifying/.test(l)), logs.join('\n'));
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    console.log = origLog; process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true });
  }
});
