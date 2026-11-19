// exec actions must not go through a shell, and must not interpolate
// message body into the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argvForExecForTest, executeActionForTest } from '../src/room-automation.mjs';

test('exec template cannot include ${body}', () => {
  const r = argvForExecForTest('echo ${body}', 'thinkoff-development', 'petrus');
  assert.equal(r.error, 'exec command may not include ${body}');
});

test('exec template with shell metacharacters is refused', () => {
  const r = argvForExecForTest('node bin/cli.mjs; reboot', 'thinkoff-development', 'petrus');
  assert.equal(r.error, 'exec command has shell metacharacters');
});

test('fixed argv form still parses the documented comments-poll command', () => {
  const r = argvForExecForTest('node bin/cli.mjs comments poll', 'thinkoff-development', 'petrus');
  assert.deepEqual(r.argv, ['node', 'bin/cli.mjs', 'comments', 'poll']);
});

test('executeAction refuses ${body} without running anything', async () => {
  const r = await executeActionForTest(
    { type: 'exec', command: 'echo ${body}' },
    { from: 'petrus', body: 'hello', room: 'thinkoff-development' },
    'key',
    { poller: { owner_handle: 'petrus' } },
    false,
  );
  assert.equal(r.status, 'error');
  assert.equal(r.notes, 'exec command may not include ${body}');
});
