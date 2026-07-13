import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repoRoot, 'tools', 'macos_human_idle.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

function runIdleCheck(idleSeconds, thresholdSeconds = 60) {
  const fakeModuleDir = mkdtempSync(path.join(tmpdir(), 'iak-quartz-'));
  try {
    writeFileSync(
      path.join(fakeModuleDir, 'Quartz.py'),
      `import os
kCGEventKeyDown = 1
kCGEventFlagsChanged = 2
kCGEventMouseMoved = 3
kCGEventLeftMouseDown = 4
kCGEventRightMouseDown = 5
kCGEventOtherMouseDown = 6
kCGEventScrollWheel = 7
kCGEventSourceStateCombinedSessionState = 8
def CGEventSourceSecondsSinceLastEventType(_state, _event_type):
    return float(os.environ['FAKE_IDLE_SECONDS'])
`,
    );
    return spawnSync(python, [helper, String(thresholdSeconds)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_IDLE_SECONDS: String(idleSeconds),
        PYTHONPATH: fakeModuleDir,
      },
    });
  } finally {
    rmSync(fakeModuleDir, { recursive: true, force: true });
  }
}

test('human-idle guard rejects recent input and clamps thresholds to 60 seconds', {
  skip: !python,
}, () => {
  const result = runIdleCheck(30, 1);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), '30.000');
});

test('human-idle guard allows injection after the safe idle window', {
  skip: !python,
}, () => {
  const result = runIdleCheck(61);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '61.000');
});

test('human-idle guard fails closed when Quartz returns an unknown value', {
  skip: !python,
}, () => {
  const result = runIdleCheck('nan');
  assert.equal(result.status, 2);
});
