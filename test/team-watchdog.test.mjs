import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API, lastSeen, ageMinutes, isStale, loadRoster } from '../scripts/team-watchdog.mjs';

const MIN = 60_000;

// Guards the stale-host regression: every call site must hit groupmind.one, not
// the dead legacy antfarm.world host.
test('API points at the live groupmind.one host, not antfarm.world', () => {
  assert.equal(API, 'https://groupmind.one/api/v1');
  assert.ok(!API.includes('antfarm.world'));
});

test('lastSeen returns the newest matching message timestamp, @/case-insensitively', () => {
  const msgs = [
    { from: '@Codex', created_at: '2026-07-14T00:00:00Z' },
    { from: 'codex', created_at: '2026-07-14T01:00:00Z' }, // newer, no @, lowercase
    { from: '@someone-else', created_at: '2026-07-14T09:00:00Z' },
  ];
  assert.equal(lastSeen(msgs, '@codex'), Date.parse('2026-07-14T01:00:00Z'));
  assert.equal(lastSeen(msgs, 'CODEX'), Date.parse('2026-07-14T01:00:00Z'));
});

test('lastSeen returns 0 when the agent has never posted', () => {
  assert.equal(lastSeen([{ from: '@other', created_at: '2026-07-14T00:00:00Z' }], '@ghost'), 0);
  assert.equal(lastSeen([], '@anyone'), 0);
});

test('ageMinutes is Infinity for a never-seen agent and rounded minutes otherwise', () => {
  const now = 1_000 * MIN;
  assert.equal(ageMinutes(0, now), Infinity);
  assert.equal(ageMinutes(now - 20 * MIN, now), 20);
  assert.equal(ageMinutes(now - 29_000, now), 0); // <30s rounds down to 0
});

test('isStale compares age against the threshold and treats never-seen as stale', () => {
  const now = 1_000 * MIN;
  const staleMs = 20 * MIN;
  assert.equal(isStale(now - 21 * MIN, now, staleMs), true);  // older than threshold
  assert.equal(isStale(now - 19 * MIN, now, staleMs), false); // fresher than threshold
  assert.equal(isStale(0, now, staleMs), true);               // never seen -> stale
});

test('loadRoster reads inline JSON from IAK_WATCHDOG_ROSTER', () => {
  const prev = process.env.IAK_WATCHDOG_ROSTER;
  try {
    process.env.IAK_WATCHDOG_ROSTER = JSON.stringify([
      { handle: '@codex', localWake: '/abs/path/codex_gui_nudge.sh' },
      { handle: '@peer', gate: 'http://host:8788' },
    ]);
    const roster = loadRoster();
    assert.equal(roster.length, 2);
    assert.equal(roster[0].localWake, '/abs/path/codex_gui_nudge.sh');
    assert.equal(roster[1].gate, 'http://host:8788');
  } finally {
    if (prev === undefined) delete process.env.IAK_WATCHDOG_ROSTER;
    else process.env.IAK_WATCHDOG_ROSTER = prev;
  }
});

test('loadRoster reads a roster file via IAK_WATCHDOG_ROSTER_FILE', () => {
  const prevEnv = process.env.IAK_WATCHDOG_ROSTER;
  const prevFile = process.env.IAK_WATCHDOG_ROSTER_FILE;
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-roster-'));
  try {
    delete process.env.IAK_WATCHDOG_ROSTER; // env inline must not shadow the file
    const file = path.join(dir, 'roster.json');
    writeFileSync(file, JSON.stringify([{ handle: '@gateless' }]));
    process.env.IAK_WATCHDOG_ROSTER_FILE = file;
    const roster = loadRoster();
    assert.deepEqual(roster, [{ handle: '@gateless' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.IAK_WATCHDOG_ROSTER;
    else process.env.IAK_WATCHDOG_ROSTER = prevEnv;
    if (prevFile === undefined) delete process.env.IAK_WATCHDOG_ROSTER_FILE;
    else process.env.IAK_WATCHDOG_ROSTER_FILE = prevFile;
  }
});

test('loadRoster returns [] when the roster is missing (nothing to watch, no crash)', () => {
  const prevEnv = process.env.IAK_WATCHDOG_ROSTER;
  const prevFile = process.env.IAK_WATCHDOG_ROSTER_FILE;
  try {
    delete process.env.IAK_WATCHDOG_ROSTER;
    process.env.IAK_WATCHDOG_ROSTER_FILE = path.join(tmpdir(), 'iak-does-not-exist-' + Date.now() + '.json');
    assert.deepEqual(loadRoster(), []);
  } finally {
    if (prevEnv === undefined) delete process.env.IAK_WATCHDOG_ROSTER;
    else process.env.IAK_WATCHDOG_ROSTER = prevEnv;
    if (prevFile === undefined) delete process.env.IAK_WATCHDOG_ROSTER_FILE;
    else process.env.IAK_WATCHDOG_ROSTER_FILE = prevFile;
  }
});
