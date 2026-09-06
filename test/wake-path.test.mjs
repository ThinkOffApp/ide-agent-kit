// SPDX-License-Identifier: AGPL-3.0-only
// Issue #90 item 4: exactly one wake path. With wake_path set to another
// path the poller delivers the notification but never nudges; with the
// default it nudges (positive control, same stubs).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRoomPoller } from '../src/team-relay/room-poller.mjs';

async function runPoll(dir, pollerOverrides) {
  const stubDir = path.join(dir, 'bin'); mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'curl');
  writeFileSync(stub, `#!/bin/sh
case "$*" in *limit=50*) echo "[]";; *) echo '[{"id":"o1","from":"petrus","body":"claudemm are you there","created_at":"2026-09-02T00:00:01Z"}]';; esac
`);
  chmodSync(stub, 0o755);
  const marker = path.join(dir, 'nudged');
  const savedPath = process.env.PATH; process.env.PATH = `${stubDir}:${savedPath}`;
  const logs = []; const origLog = console.log; const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  let timers;
  try {
    timers = await startRoomPoller({
      rooms: ['r'], apiKey: 'k', handle: '@t', interval: 3600,
      config: { poller: { seen_file: path.join(dir, 'seen'), notification_file: path.join(dir, 'notify'), heartbeat_file: path.join(dir, 'hb'),
        nudge_mode: 'command', nudge_command: `touch ${marker}`, ...pollerOverrides }, queue: { path: path.join(dir, 'q.jsonl') } }
    });
  } finally {
    if (timers?.roomTimer) clearInterval(timers.roomTimer);
    if (timers?.dmTimer) clearInterval(timers.dmTimer);
    console.log = origLog; console.error = origErr; process.env.PATH = savedPath;
  }
  return { nudged: existsSync(marker), notified: existsSync(path.join(dir, 'notify')) && /petrus: claudemm are you there/.test(readFileSync(path.join(dir, 'notify'), 'utf8')), log: logs.join('\n') };
}

test('wake_path webhook: notification delivered, nudge refused with the reason, warning at start', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-wake-'));
  try {
    const r = await runPoll(dir, { wake_path: 'webhook' });
    assert.equal(r.notified, true);
    assert.equal(r.nudged, false, 'poller must not nudge when the webhook owns the wake');
    assert.match(r.log, /wake path is webhook, not this poller/);
    assert.match(r.log, /WARNING: poller.nudge_mode is 'command' but poller.wake_path is 'webhook'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default wake_path: the same owner message nudges (positive control)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-wake-'));
  try {
    const r = await runPoll(dir, {});
    assert.equal(r.notified, true);
    assert.equal(r.nudged, true, 'control: with the poller owning the wake, the nudge command runs');
    assert.match(r.log, /wake path: nudge/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
