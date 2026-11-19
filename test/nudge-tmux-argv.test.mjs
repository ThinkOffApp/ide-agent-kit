// Nudge must type room text into tmux as one argv after -l, never through a shell.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nudgeTmux, execSafeSession } from '../src/common/notify.mjs';
import { executeActionForTest } from '../src/room-automation.mjs';

const SHELL_BODY = 'hello $(id); echo `uname` && true | cat; reboot';

let binDir;
let logPath;
let markerPath;
let oldPath;

function readArgvLog() {
  try {
    const raw = readFileSync(logPath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function clearArgvLog() {
  writeFileSync(logPath, '');
}

before(() => {
  binDir = mkdtempSync(join(tmpdir(), 'iak-fake-tmux-'));
  logPath = join(binDir, 'argv.jsonl');
  markerPath = join(binDir, 'must-not-exist');
  writeFileSync(logPath, '');
  const tmuxPath = join(binDir, 'tmux');
  writeFileSync(tmuxPath, `#!/usr/bin/env node
const { appendFileSync } = require('fs');
if (!process.env.FAKE_TMUX_LOG) {
  process.stderr.write('FAKE_TMUX_LOG missing\\n');
  process.exit(1);
}
const argv = process.argv.slice(2);
if (argv[0] === 'send-keys') {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '-l') { i += 1; continue; }
    if (a === '-t') { i += 2; continue; }
    if (a.startsWith('-')) {
      process.stderr.write('unknown option: ' + a + '\\n');
      process.exit(1);
    }
    break;
  }
}
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(argv) + '\\n');
process.exit(0);
`);
  chmodSync(tmuxPath, 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.FAKE_TMUX_LOG = logPath;
});

after(() => {
  if (oldPath !== undefined) process.env.PATH = oldPath;
  delete process.env.FAKE_TMUX_LOG;
  if (binDir) rmSync(binDir, { recursive: true, force: true });
});

test('execSafeSession refuses leading dash, spaces, and empty', () => {
  assert.equal(execSafeSession('-n').error, 'session may not start with -');
  assert.equal(execSafeSession('claude session').error, 'session failed the allowed pattern');
  assert.equal(execSafeSession('').error, 'session is empty');
  assert.equal(execSafeSession('claude').value, 'claude');
});

test('nudge types shell characters as one send-keys -l argument', () => {
  clearArgvLog();
  const ok = nudgeTmux('claude', SHELL_BODY, { delayMs: 0 });
  assert.equal(ok, true);
  const calls = readArgvLog();
  assert.deepEqual(calls[0], ['has-session', '-t', 'claude']);
  assert.deepEqual(calls[1], ['send-keys', '-t', 'claude', '-l', '--', SHELL_BODY]);
  assert.deepEqual(calls[2], ['send-keys', '-t', 'claude', 'Enter']);
  assert.equal(calls.length, 3);
  assert.equal(existsSync(markerPath), false);
});

test('leading-dash payload is passed after -- so tmux does not take it as an option', () => {
  clearArgvLog();
  const ok = nudgeTmux('claude', '-literal-text', { delayMs: 0 });
  assert.equal(ok, true);
  const calls = readArgvLog();
  assert.deepEqual(calls[1], ['send-keys', '-t', 'claude', '-l', '--', '-literal-text']);
});

test('bad session names never invoke tmux', () => {
  clearArgvLog();
  assert.equal(nudgeTmux('-n', SHELL_BODY, { delayMs: 0 }), false);
  assert.equal(nudgeTmux('claude; reboot', SHELL_BODY, { delayMs: 0 }), false);
  assert.deepEqual(readArgvLog(), []);
});

test('executeAction nudge interpolates ${body} as typed argv, nothing runs', async () => {
  clearArgvLog();
  const body = `${SHELL_BODY}; touch ${markerPath}`;
  const r = await executeActionForTest(
    { type: 'nudge', text: '${body}' },
    { from: 'petrus', body, room: 'thinkoff-development' },
    'key',
    { poller: { owner_handle: 'petrus' }, tmux: { ide_session: 'claude' } },
    false,
  );
  assert.equal(r.status, 'ok');
  const expected = body.slice(0, 200);
  assert.equal(r.notes, `Sent: ${expected}`);
  const calls = readArgvLog();
  const send = calls.find((argv) => argv[0] === 'send-keys' && argv.includes('-l'));
  assert.ok(send);
  assert.equal(send[send.length - 1], expected);
  assert.equal(existsSync(markerPath), false);
});

test('executeAction refuses a session that fails the token', async () => {
  clearArgvLog();
  const r = await executeActionForTest(
    { type: 'nudge', text: '${body}' },
    { from: 'petrus', body: SHELL_BODY, room: 'thinkoff-development' },
    'key',
    { poller: { owner_handle: 'petrus' }, tmux: { ide_session: '-n' } },
    false,
  );
  assert.equal(r.status, 'error');
  assert.equal(r.notes, 'session may not start with -');
  assert.deepEqual(readArgvLog(), []);
});

test('named files no longer build a tmux shell string', () => {
  const automation = readFileSync(new URL('../src/room-automation.mjs', import.meta.url), 'utf8');
  const notify = readFileSync(new URL('../src/common/notify.mjs', import.meta.url), 'utf8');
  const comments = readFileSync(new URL('../src/comment-poller.mjs', import.meta.url), 'utf8');
  const utils = readFileSync(new URL('../src/utils.mjs', import.meta.url), 'utf8');
  const ideComments = readFileSync(new URL('../src/ide/comment-poller.mjs', import.meta.url), 'utf8');
  for (const src of [automation, notify, comments, utils, ideComments]) {
    assert.equal(src.includes('execSync(`tmux'), false);
    assert.equal(src.includes("execSync('sleep"), false);
  }
  assert.equal(notify.includes("execFileSync('tmux'"), true);
  assert.equal(comments.includes("from './common/notify.mjs'"), true);
  assert.equal(utils.includes("from './common/notify.mjs'"), true);
  assert.equal(ideComments.includes("from '../comment-poller.mjs'"), true);
});
