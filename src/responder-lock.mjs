// SPDX-License-Identifier: AGPL-3.0-only
//
// Enforcement half of the single room-responder lock (#40 wrote it, #42
// enforces it): scripts/session-bootstrap.sh gives PASSIVE sessions
// instructions not to answer the room, but instructions are model-followed.
// This module lets the MCP room-post path REFUSE the post when another live
// session holds the machine's responder lock, so a session that ignores its
// PASSIVE context still cannot speak as the agent through IAK tooling.
// (Raw curl against the GroupMind API is out of scope here — that needs
// server-side per-session keys; see issue #42.)
//
// Semantics mirror the bash hook exactly:
//   - lock file: $IAK_RESPONDER_LOCK, else <notification file>.responder.lock;
//     the literal value "off" disables enforcement.
//   - owner identity: pid + process start time (a recycled pid is stale).
//   - fail OPEN on mechanics (missing/corrupt lock, ps failures): a machine
//     with a broken lock keeps its room voice; the hook is the same way.
//   - "we hold the lock": the lock's pid is this process or one of its
//     ancestors — the MCP server is spawned by the session process, so the
//     owning session appears in our parent chain.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function lockPathFor(config, env = process.env) {
  const explicit = env.IAK_RESPONDER_LOCK;
  if (explicit) return explicit; // may be the literal 'off'
  const newFile =
    env.IAK_NEW_FILE ||
    config?.poller?.notification_file ||
    '/tmp/iak-new-messages.txt';
  return `${newFile}.responder.lock`;
}

export function readResponderLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const get = (k) => {
      const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const pid = parseInt(get('pid'), 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      sid: get('sid'),
      pstart: get('pstart'),
    };
  } catch {
    return null;
  }
}

function procStart(pid, exec) {
  try {
    return exec('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function parentOf(pid, exec) {
  try {
    const out = exec('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim();
    const parent = parseInt(out, 10);
    return Number.isInteger(parent) && parent > 0 ? parent : 0;
  } catch {
    return 0;
  }
}

function isSelfOrAncestor(targetPid, fromPid, exec) {
  let pid = fromPid;
  // The owning session process is normally our direct parent; walk a few
  // levels to cover wrapper processes between the session and this server.
  for (let hops = 0; hops < 10 && pid && pid > 1; hops++) {
    if (pid === targetPid) return true;
    pid = parentOf(pid, exec);
  }
  return false;
}

/**
 * Decide whether THIS process may post to the room as the agent.
 * Returns {allowed, reason}. Never throws.
 *
 * Injectables (tests): env, selfPid (start of the ancestor walk), exec.
 */
export function assertRoomVoice({
  config,
  env = process.env,
  selfPid = process.pid,
  exec = execFileSync,
} = {}) {
  try {
    const lockPath = lockPathFor(config, env);
    if (lockPath === 'off') return { allowed: true, reason: 'responder lock disabled' };

    const lock = readResponderLock(lockPath);
    if (!lock || !lock.pid) return { allowed: true, reason: 'no responder lock' };

    const start = procStart(lock.pid, exec);
    if (!start) return { allowed: true, reason: 'lock owner process is gone (stale lock)' };
    if (lock.pstart && start !== lock.pstart) {
      return { allowed: true, reason: 'lock owner pid was recycled (stale lock)' };
    }

    if (isSelfOrAncestor(lock.pid, selfPid, exec)) {
      return { allowed: true, reason: 'this session holds the responder lock' };
    }

    return {
      allowed: false,
      reason:
        `another live session (pid ${lock.pid}${lock.sid ? `, session ${lock.sid}` : ''}) ` +
        `holds the room-responder lock (${lockPath}). This session is PASSIVE and must not ` +
        `post to the room — duplicate agent voices confuse the team. Takeover only on the ` +
        `user's explicit request: delete the lock file, then re-run the standard bootstrap.`,
    };
  } catch {
    // Mechanics failure: fail open, same philosophy as the bash hook.
    return { allowed: true, reason: 'lock check failed (fail open)' };
  }
}
