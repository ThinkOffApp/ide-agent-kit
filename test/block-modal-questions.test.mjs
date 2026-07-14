import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repoRoot, 'scripts', 'block-modal-questions.mjs');

function run(stdin) {
  return spawnSync('node', [hook], { input: stdin, encoding: 'utf8' });
}

test('denies AskUserQuestion with a redirect-to-room reason', () => {
  const r = run(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /room|phone|Approve\/Deny/);
});

test('allows every other tool (no output, exit 0)', () => {
  for (const tool of ['Bash', 'Read', 'Edit', 'room_post', 'request_confirmation']) {
    const r = run(JSON.stringify({ tool_name: tool, tool_input: {} }));
    assert.equal(r.status, 0, `${tool} should pass`);
    assert.equal(r.stdout.trim(), '', `${tool} should produce no block output`);
  }
});

test('fails OPEN on malformed payload (never wedges the agent)', () => {
  const r = run('not json at all');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('fails OPEN on empty stdin', () => {
  const r = run('');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});
