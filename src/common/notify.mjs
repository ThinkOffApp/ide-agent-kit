// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Shared notification utilities for all platform pollers.
 * Supports tmux nudge and notification file delivery.
 */

// Same token as argvForExec in room-automation.mjs.
const EXEC_SAFE_TOKEN = /^[A-Za-z0-9._@/=+-]+$/;

export function execSafeSession(session) {
  const v = String(session || '');
  if (!v) return { error: 'session is empty' };
  if (v.startsWith('-')) return { error: 'session may not start with -' };
  if (!EXEC_SAFE_TOKEN.test(v)) return { error: 'session failed the allowed pattern' };
  return { value: v };
}

function sleepMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
}

function tmuxArgv(args) {
  execFileSync('tmux', args, { stdio: 'ignore', timeout: 5000 });
}

export function nudgeTmux(session, text, opts = {}) {
  const checked = execSafeSession(session);
  if (checked.error) return false;
  const payload = text == null ? '' : String(text);
  const delayMs = opts.delayMs === undefined ? 300 : opts.delayMs;
  try {
    tmuxArgv(['has-session', '-t', checked.value]);
  } catch {
    return false;
  }
  try {
    tmuxArgv(['send-keys', '-t', checked.value, '-l', '--', payload]);
    sleepMs(delayMs);
    tmuxArgv(['send-keys', '-t', checked.value, 'Enter']);
    return true;
  } catch {
    return false;
  }
}

export function writeNotification(notifyFile, lines) {
  if (lines.length === 0) return;
  appendFileSync(notifyFile, lines.join('\n') + '\n');
}

export function readAndClearNotifications(notifyFile) {
  try {
    const content = readFileSync(notifyFile, 'utf8').trim();
    if (!content) return [];
    writeFileSync(notifyFile, '');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
