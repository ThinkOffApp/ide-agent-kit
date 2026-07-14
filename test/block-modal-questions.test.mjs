import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureHookCommand } from '../src/claude-settings.mjs';

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

test('deny payload is never truncated across many runs (no process.exit-before-flush)', () => {
  // Regression for the POSIX async-pipe truncation bug (codex review, #36):
  // process.exit() after stdout.write could ship a partial/empty decision.
  // A large reason string + repeated runs would surface truncation as a
  // JSON parse failure or a missing permissionDecision.
  for (let i = 0; i < 50; i++) {
    const r = run(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: {} }));
    assert.equal(r.status, 0, `run ${i} exit`);
    let out;
    assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, `run ${i} produced unparseable/truncated JSON: ${JSON.stringify(r.stdout)}`);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', `run ${i} missing deny`);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 100, `run ${i} reason truncated`);
  }
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

test('ensureHookCommand scopes the matcher when given (spawn only for that tool)', () => {
  const s = {};
  ensureHookCommand(s, 'PreToolUse', 'node guard.mjs', { matcher: 'AskUserQuestion', timeout: 5 });
  const entry = s.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'AskUserQuestion');
  assert.deepEqual(entry.hooks[0], { type: 'command', command: 'node guard.mjs', timeout: 5 });
});

test('ensureHookCommand matcher defaults to empty (all tools / lifecycle events)', () => {
  const s = {};
  ensureHookCommand(s, 'SessionStart', 'bash boot.sh');
  assert.equal(s.hooks.SessionStart[0].matcher, '');
});
