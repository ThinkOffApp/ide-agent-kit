// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRoomVoice, lockPathFor, readResponderLock } from '../src/responder-lock.mjs';

const tempPaths = [];
function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iak-voice-')));
  tempPaths.push(dir);
  return dir;
}
afterEach(() => {
  while (tempPaths.length > 0) rmSync(tempPaths.pop(), { recursive: true, force: true });
});

/**
 * Fake process table for the injectable exec: {pid: {lstart, ppid}}.
 * Throws (like execFileSync) for unknown pids.
 */
function fakeExec(table) {
  return (cmd, args) => {
    const pid = parseInt(args[1], 10);
    const col = args[3];
    const row = table[pid];
    if (!row) throw new Error(`no such process ${pid}`);
    if (col === 'lstart=') return `${row.lstart}\n`;
    if (col === 'ppid=') return `${row.ppid}\n`;
    throw new Error(`unexpected ps column ${col}`);
  };
}

function writeLock(dir, { pid, sid = 'sess-owner', pstart = '' }) {
  const path = join(dir, 'new.txt.responder.lock');
  writeFileSync(path, `pid=${pid}\nsid=${sid}\n${pstart ? `pstart=${pstart}\n` : ''}`);
  return path;
}

const START = 'Thu Jul 16 11:08:28 2026';

describe('lockPathFor', () => {
  it('derives from the notification file and honors env overrides', () => {
    assert.equal(lockPathFor({}, {}), '/tmp/iak-new-messages.txt.responder.lock');
    assert.equal(lockPathFor({ poller: { notification_file: '/x/n.txt' } }, {}), '/x/n.txt.responder.lock');
    assert.equal(lockPathFor({}, { IAK_NEW_FILE: '/y/n.txt' }), '/y/n.txt.responder.lock');
    assert.equal(lockPathFor({}, { IAK_RESPONDER_LOCK: 'off' }), 'off');
    assert.equal(lockPathFor({}, { IAK_RESPONDER_LOCK: '/z/lock' }), '/z/lock');
  });
});

describe('readResponderLock', () => {
  it('parses the hook lock format and tolerates junk', () => {
    const dir = tempDir();
    const path = writeLock(dir, { pid: 42, sid: 's1', pstart: START });
    assert.deepEqual(readResponderLock(path), { pid: 42, sid: 's1', pstart: START });
    assert.equal(readResponderLock(join(dir, 'missing')), null);
    const junk = join(dir, 'junk');
    writeFileSync(junk, 'pid=not-a-number\n%%%\n');
    assert.equal(readResponderLock(junk).pid, null);
  });
});

describe('assertRoomVoice', () => {
  it('allows when the lock is disabled, absent, or unreadable', () => {
    const dir = tempDir();
    assert.equal(assertRoomVoice({ env: { IAK_RESPONDER_LOCK: 'off' } }).allowed, true);
    assert.equal(assertRoomVoice({
      env: { IAK_RESPONDER_LOCK: join(dir, 'nope') }, exec: fakeExec({}),
    }).allowed, true);
  });

  it('allows when the owner process is dead (stale lock)', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 999, pstart: START });
    const verdict = assertRoomVoice({
      env: { IAK_RESPONDER_LOCK: lock }, selfPid: 10, exec: fakeExec({ 10: { lstart: 'x', ppid: 1 } }),
    });
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /stale/);
  });

  it('allows when the owner pid was recycled (pstart mismatch)', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 999, pstart: 'Thu Jan  1 00:00:00 1970' });
    const verdict = assertRoomVoice({
      env: { IAK_RESPONDER_LOCK: lock },
      selfPid: 10,
      exec: fakeExec({ 999: { lstart: START, ppid: 1 }, 10: { lstart: 'x', ppid: 1 } }),
    });
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /recycled/);
  });

  it('allows the session that holds the lock (owner in the ancestor chain)', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 500, pstart: START });
    // self 10 -> parent 20 -> parent 500 (the owning session process)
    const table = {
      10: { lstart: 'a', ppid: 20 },
      20: { lstart: 'b', ppid: 500 },
      500: { lstart: START, ppid: 1 },
    };
    const verdict = assertRoomVoice({ env: { IAK_RESPONDER_LOCK: lock }, selfPid: 10, exec: fakeExec(table) });
    assert.equal(verdict.allowed, true);
    assert.match(verdict.reason, /holds the responder lock/);
  });

  it('REFUSES a passive session while the owner is alive elsewhere', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 500, sid: 'sess-owner', pstart: START });
    // self 10 -> 20 -> 1: owner 500 alive but NOT in our chain.
    const table = {
      10: { lstart: 'a', ppid: 20 },
      20: { lstart: 'b', ppid: 1 },
      500: { lstart: START, ppid: 1 },
    };
    const verdict = assertRoomVoice({ env: { IAK_RESPONDER_LOCK: lock }, selfPid: 10, exec: fakeExec(table) });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /pid 500/);
    assert.match(verdict.reason, /sess-owner/);
    assert.match(verdict.reason, /PASSIVE/);
  });

  it('legacy lock without pstart still refuses on a live owner pid', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 500 });
    const table = { 10: { lstart: 'a', ppid: 1 }, 500: { lstart: START, ppid: 1 } };
    const verdict = assertRoomVoice({ env: { IAK_RESPONDER_LOCK: lock }, selfPid: 10, exec: fakeExec(table) });
    assert.equal(verdict.allowed, false);
  });

  it('fails open when ps itself explodes', () => {
    const dir = tempDir();
    const lock = writeLock(dir, { pid: 500, pstart: START });
    const verdict = assertRoomVoice({
      env: { IAK_RESPONDER_LOCK: lock },
      selfPid: 10,
      exec: () => { throw new Error('ps unavailable'); },
    });
    assert.equal(verdict.allowed, true);
  });
});
