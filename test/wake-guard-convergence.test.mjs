import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Convergence acceptance gate (#28 + #29, codex review):
//  - invalid-threshold: garbage IDLE_THRESHOLD_S must never authorize injection
//  - fail-closed: unreadable idle state = human active
//  - mid-focus-activity: human returning between entry check and injection
//    withholds the injection and keeps the message pending
//  - timeout-retry: a deferred nudge is retried on later cycles, never consumed
//
// The shell guard reads HIDIdleTime via ioreg; tests stub ioreg on PATH.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(repoRoot, 'tools', 'human-idle-guard.sh');
const roomPoll = path.join(repoRoot, 'scripts', 'room-poll.sh');

function withStubIoreg(idleNs, fn) {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'iak-ioreg-'));
  try {
    const body = idleNs === null
      ? '#!/bin/sh\nexit 0\n' // ioreg runs but emits no HIDIdleTime line
      : `#!/bin/sh\necho '| "HIDIdleTime" = ${idleNs}'\n`;
    const stub = path.join(stubDir, 'ioreg');
    writeFileSync(stub, body);
    chmodSync(stub, 0o755);
    return fn(stubDir);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

function runGuard(idleNs, env = {}) {
  return withStubIoreg(idleNs, (stubDir) =>
    spawnSync('bash', [guard], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ...env },
    })
  );
}

test('shell guard: garbage threshold clamps to 60s and still blocks recent input', () => {
  // 30s idle with IDLE_THRESHOLD_S=not-a-number: the old bug authorized
  // injection (exit 0). Clamped to 60s it must block.
  const r = runGuard(30n * 1_000_000_000n, { IDLE_THRESHOLD_S: 'not-a-number' });
  assert.equal(r.status, 1, `expected block, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /invalid IDLE_THRESHOLD_S/);
});

test('shell guard: zero threshold clamps to 60s (never authorize-always)', () => {
  const r = runGuard(5n * 1_000_000_000n, { IDLE_THRESHOLD_S: '0' });
  assert.equal(r.status, 1);
});

test('shell guard: fails closed when HIDIdleTime is unreadable', () => {
  const r = runGuard(null);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failing closed/);
});

test('shell guard: allows injection after the idle window', () => {
  const r = runGuard(61n * 1_000_000_000n);
  assert.equal(r.status, 0, r.stderr);
});

// End-to-end retry semantics through room-poll.sh with everything stubbed:
// a stateful guard fails (human active) for its first N calls, then passes.
// The nudge must stay PENDING across failed cycles and deliver once idle.
function runRoomPollCycles({ guardFailures, cycles }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-roompoll-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const guardState = path.join(dir, 'guard-calls');
  const pending = path.join(dir, 'pending');

  // Stub tmux: log every send-keys; has-session always true.
  const tmuxStub = path.join(dir, 'tmux');
  writeFileSync(tmuxStub, `#!/bin/sh
if [ "$1" = "has-session" ]; then exit 0; fi
echo "$@" >> ${JSON.stringify(tmuxLog)}
exit 0
`);
  chmodSync(tmuxStub, 0o755);

  // Stateful stub guard: exit 1 for the first guardFailures calls, then 0.
  const guardStub = path.join(dir, 'guard.sh');
  writeFileSync(guardStub, `#!/bin/sh
n=0
[ -f ${JSON.stringify(guardState)} ] && n=$(cat ${JSON.stringify(guardState)})
n=$((n + 1))
echo $n > ${JSON.stringify(guardState)}
[ "$n" -le ${guardFailures} ] && exit 1
exit 0
`);
  chmodSync(guardStub, 0o755);

  // Check script: NEW on the first cycle only.
  const checkStub = path.join(dir, 'check.py');
  writeFileSync(checkStub, `import os
flag = ${JSON.stringify(path.join(dir, 'newed'))}
if not os.path.exists(flag):
    open(flag, 'w').close()
    print("NEW")
else:
    print("NONE")
`);

  // macOS has no GNU `timeout` binary; spawnSync's timeout kills the loop.
  const r = spawnSync('bash', [roomPoll], {
    encoding: 'utf8',
    timeout: (cycles + 1) * 1000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      IAK_POLL_INTERVAL: '1',
      IAK_TMUX_SESSION: 'stub-session',
      IAK_NUDGE_TEXT: 'check rooms',
      IAK_CHECK_SCRIPT: checkStub,
      IAK_IDLE_GUARD: guardStub,
      IAK_NUDGE_PENDING_FILE: pending,
      IAK_ERR_LOG: path.join(dir, 'err.log'),
      IAK_LOCK_FILE: path.join(dir, 'lock.pid'),
    },
  });

  const sent = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  const pendingLeft = existsSync(pending);
  rmSync(dir, { recursive: true, force: true });
  return { stdout: r.stdout ?? '', sent, pendingLeft };
}

test('room-poll: nudge deferred while human active stays pending and retries to delivery', () => {
  // Guard fails twice (entry checks of cycles 1-2: human typing), passes
  // from call 3 (cycle 3 entry + its pre-Enter recheck). timeout-retry gate:
  // the NEW from cycle 1 must still deliver in cycle 3.
  const { stdout, sent, pendingLeft } = runRoomPollCycles({ guardFailures: 2, cycles: 5 });
  assert.match(stdout, /nudge deferred: human active/);
  assert.match(sent, /-l check rooms/, 'nudge text should eventually be typed');
  assert.match(sent, /Enter/, 'Enter should eventually be sent');
  assert.equal(pendingLeft, false, 'pending marker must clear after delivery');
});

test('room-poll: idle human means clean single-cycle delivery (happy path)', () => {
  const { sent, pendingLeft, stdout } = runRoomPollCycles({ guardFailures: 0, cycles: 2 });
  assert.match(sent, /Enter/);
  assert.equal(pendingLeft, false);
  assert.doesNotMatch(stdout, /Enter withheld/);
});

test('room-poll: pre-Enter recheck failure sends C-u and retains pending', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iak-roompoll2-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const guardState = path.join(dir, 'guard-calls');
  const pending = path.join(dir, 'pending');

  const tmuxStub = path.join(dir, 'tmux');
  writeFileSync(tmuxStub, `#!/bin/sh
if [ "$1" = "has-session" ]; then exit 0; fi
echo "$@" >> ${JSON.stringify(tmuxLog)}
exit 0
`);
  chmodSync(tmuxStub, 0o755);

  // Pass on odd calls (entry), fail on even calls (pre-Enter recheck).
  const guardStub = path.join(dir, 'guard.sh');
  writeFileSync(guardStub, `#!/bin/sh
n=0
[ -f ${JSON.stringify(guardState)} ] && n=$(cat ${JSON.stringify(guardState)})
n=$((n + 1))
echo $n > ${JSON.stringify(guardState)}
[ $((n % 2)) -eq 0 ] && exit 1
exit 0
`);
  chmodSync(guardStub, 0o755);

  const checkStub = path.join(dir, 'check.py');
  writeFileSync(checkStub, `import os
flag = ${JSON.stringify(path.join(dir, 'newed'))}
if not os.path.exists(flag):
    open(flag, 'w').close()
    print("NEW")
else:
    print("NONE")
`);

  const r = spawnSync('bash', [roomPoll], {
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      IAK_POLL_INTERVAL: '1',
      IAK_TMUX_SESSION: 'stub-session',
      IAK_NUDGE_TEXT: 'check rooms',
      IAK_CHECK_SCRIPT: checkStub,
      IAK_IDLE_GUARD: guardStub,
      IAK_NUDGE_PENDING_FILE: pending,
      IAK_ERR_LOG: path.join(dir, 'err.log'),
      IAK_LOCK_FILE: path.join(dir, 'lock.pid'),
    },
  });

  const sent = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  const pendingLeft = existsSync(pending);
  rmSync(dir, { recursive: true, force: true });

  assert.match(r.stdout, /Enter withheld: human became active mid-nudge/);
  assert.match(sent, /C-u/, 'typed nudge must be erased when Enter is withheld');
  assert.doesNotMatch(sent, /(^|\n)send-keys -t stub-session Enter($|\n)/, 'Enter must not fire');
  assert.equal(pendingLeft, true, 'message must remain pending for retry');
});
