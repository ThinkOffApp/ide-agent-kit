#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Post ONE room alert when the room poller stops heartbeating, and one
// all-clear when it comes back. Run from a supervisor loop; idempotent via a
// state file. A launchd job with KeepAlive that dies on start restarts every
// few seconds and writes only to a log nobody reads (1134 lines on
// 2026-09-01, issue #86) - this is the line that reaches the phone instead.
//
// Env: IAK_ALERT_KEY (required; the room API key, never an argv),
//      IAK_POLLER_HEARTBEAT (default /tmp/iak-poller.heartbeat),
//      IAK_POLLER_MAX_AGE_SEC (default 180),
//      IAK_POLLER_ERR_LOG (optional; last line is quoted in the alert),
//      IAK_ALERT_ROOM (default thinkoff-development),
//      IAK_ALERT_STATE (default /tmp/iak-poller-alert.state),
//      IAK_ALERT_BASE (default https://groupmind.one/api/v1),
//      IAK_ALERT_LABEL (default "room poller", names the job in the text),
//      IAK_ALERT_TIMEOUT_MS (default 15000; a stalled POST must not block the
//      supervisor loop - codex review of PR #87).
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const key = process.env.IAK_ALERT_KEY;
const heartbeat = process.env.IAK_POLLER_HEARTBEAT || '/tmp/iak-poller.heartbeat';
const maxAge = Number(process.env.IAK_POLLER_MAX_AGE_SEC || 180);
const errLog = process.env.IAK_POLLER_ERR_LOG || '';
const room = process.env.IAK_ALERT_ROOM || 'thinkoff-development';
const stateFile = process.env.IAK_ALERT_STATE || '/tmp/iak-poller-alert.state';
const base = (process.env.IAK_ALERT_BASE || 'https://groupmind.one/api/v1').replace(/\/$/, '');
const label = process.env.IAK_ALERT_LABEL || 'room poller';
const timeoutMs = Number(process.env.IAK_ALERT_TIMEOUT_MS || 15000);

if (!key) {
  console.error('poller-health-alert: IAK_ALERT_KEY missing');
  process.exit(2);
}

export function heartbeatAge(path, now = Date.now()) {
  if (!existsSync(path)) return Infinity;
  return Math.round((now - statSync(path).mtimeMs) / 1000);
}

export function lastLine(path) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
  } catch {
    return '';
  }
}

async function post(body) {
  const res = await fetch(`${base}/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`room post failed: HTTP ${res.status}`);
}

const age = heartbeatAge(heartbeat);
const down = age > maxAge;
const alerted = existsSync(stateFile);

// A failed or timed-out post leaves the state untouched, so the next loop
// simply tries again; the supervisor never waits longer than timeoutMs.
try {
  if (down && !alerted) {
    const err = errLog ? lastLine(errLog) : '';
    const since = age === Infinity ? 'no heartbeat file' : `last heartbeat ${age}s ago`;
    await post(`⚠️ ${label} is down (${since}, heartbeat ${heartbeat}).` + (err ? `\nLast error: ${err}` : '') +
      '\nGUI nudges are suspended until it heartbeats again; this alert is posted once.');
    writeFileSync(stateFile, new Date().toISOString() + '\n');
    console.log('alert posted');
  } else if (!down && alerted) {
    await post(`✅ ${label} is back (heartbeat ${age}s old).`);
    unlinkSync(stateFile);
    console.log('all-clear posted');
  } else {
    console.log(down ? 'down, already alerted' : 'healthy');
  }
} catch (e) {
  console.error(`poller-health-alert: post failed, will retry next loop: ${e.message}`);
  process.exit(1);
}
