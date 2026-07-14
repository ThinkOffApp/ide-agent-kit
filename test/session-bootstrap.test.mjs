// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureHookCommand, ensureHookInSettingsFile } from '../src/claude-settings.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapScript = join(repoRoot, 'scripts', 'session-bootstrap.sh');

const tempPaths = [];

function tempDir() {
  // realpathSync: on macOS tmpdir() is behind a /var → /private/var symlink,
  // and the CLI under test resolves paths from its (real) cwd.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iak-bootstrap-')));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * Run the hook script the way Claude Code does: JSON on stdin, JSON on stdout.
 * IAK_CONFIG_JSON defaults to a nonexistent path so the developer's real
 * ide-agent-kit.json never leaks into test output.
 */
function runHook({ input = '', env = {} } = {}) {
  const out = execFileSync('bash', [bootstrapScript], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      IAK_CONFIG_JSON: '/tmp/iak-nonexistent-config.json',
      IAK_NEW_FILE: '/tmp/iak-nonexistent-new-messages.txt',
      ...env,
    },
  });
  return JSON.parse(out);
}

describe('session-bootstrap.sh', () => {
  it('emits valid SessionStart hook JSON on startup', () => {
    const payload = runHook({ input: JSON.stringify({ source: 'startup' }) });
    assert.equal(payload.suppressOutput, true);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /Session source: startup/);
    assert.match(payload.hookSpecificOutput.additionalContext, /Monitor/);
    assert.match(payload.hookSpecificOutput.additionalContext, /\/loop check rooms/);
  });

  it('passes the compact source through so the agent verifies instead of re-arming', () => {
    const payload = runHook({ input: JSON.stringify({ source: 'compact' }) });
    assert.match(payload.hookSpecificOutput.additionalContext, /Session source: compact/);
  });

  it('survives empty stdin', () => {
    const payload = runHook({ input: '' });
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /Session source: unknown/);
  });

  it('survives non-JSON stdin', () => {
    const payload = runHook({ input: 'not json at all' });
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /Session source: unknown/);
  });

  it('reports backlog line count from the notification file', () => {
    const dir = tempDir();
    const newFile = join(dir, 'new-messages.txt');
    writeFileSync(newFile, 'msg one\nmsg two\nmsg three\n');
    const payload = runHook({ input: '{}', env: { IAK_NEW_FILE: newFile } });
    const ctx = payload.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Backlog: 3 unconsumed line\(s\)/);
    assert.ok(ctx.includes(newFile));
  });

  it('reports zero backlog when the notification file is missing', () => {
    const payload = runHook({ input: '{}' });
    assert.match(payload.hookSpecificOutput.additionalContext, /Backlog: 0 unconsumed/);
  });

  it('reads notification file and handle from the IAK config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'ide-agent-kit.json');
    const notifyFile = join(dir, 'from-config.txt');
    writeFileSync(configPath, JSON.stringify({
      poller: { notification_file: notifyFile, handle: '@testbot' },
    }));
    const env = { ...process.env, IAK_CONFIG_JSON: configPath };
    delete env.IAK_NEW_FILE;
    delete env.IAK_HANDLE;
    const out = execFileSync('bash', [bootstrapScript], { input: '{}', encoding: 'utf8', env });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(notifyFile));
    assert.match(ctx, /for @testbot/);
  });

  it('env overrides beat the config values', () => {
    const dir = tempDir();
    const configPath = join(dir, 'ide-agent-kit.json');
    writeFileSync(configPath, JSON.stringify({
      poller: { notification_file: '/tmp/from-config.txt', handle: '@configbot' },
    }));
    const envFile = join(dir, 'from-env.txt');
    const payload = runHook({
      input: '{}',
      env: { IAK_CONFIG_JSON: configPath, IAK_NEW_FILE: envFile, IAK_HANDLE: '@envbot' },
    });
    const ctx = payload.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(envFile));
    assert.ok(!ctx.includes('/tmp/from-config.txt'));
    assert.match(ctx, /for @envbot/);
  });
});

describe('claude-settings hook merge', () => {
  it('adds the hook while preserving unrelated hooks and settings', () => {
    const settings = {
      permissions: { allow: ['Bash(*)'], defaultMode: 'bypassPermissions' },
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash check-rooms.sh' }] },
        ],
      },
    };
    const changed = ensureHookCommand(settings, 'SessionStart', 'bash session-bootstrap.sh', { timeout: 10 });
    assert.equal(changed, true);
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.deepEqual(settings.hooks.SessionStart[0].hooks[0], {
      type: 'command',
      command: 'bash session-bootstrap.sh',
      timeout: 10,
    });
    // untouched:
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'bash check-rooms.sh');
    assert.deepEqual(settings.permissions.allow, ['Bash(*)']);
  });

  it('is idempotent: same command is never added twice', () => {
    const settings = {};
    assert.equal(ensureHookCommand(settings, 'SessionStart', 'bash x.sh'), true);
    assert.equal(ensureHookCommand(settings, 'SessionStart', 'bash x.sh'), false);
    assert.equal(settings.hooks.SessionStart.length, 1);
  });

  it('keeps pre-existing SessionStart entries with other commands', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'claude-mem hook session-init' }] },
        ],
      },
    };
    assert.equal(ensureHookCommand(settings, 'SessionStart', 'bash session-bootstrap.sh'), true);
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'claude-mem hook session-init');
  });

  it('file wrapper merges into an existing settings.json, takes a .bak backup, and is idempotent', () => {
    const dir = tempDir();
    const settingsPath = join(dir, 'settings.json');
    const original = {
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash check-rooms.sh' }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');

    const first = ensureHookInSettingsFile(settingsPath, 'SessionStart', 'bash session-bootstrap.sh', { timeout: 10 });
    assert.equal(first.changed, true);
    assert.equal(first.existed, true);
    assert.equal(first.backupPath, `${settingsPath}.bak`);
    assert.deepEqual(JSON.parse(readFileSync(first.backupPath, 'utf8')), original);

    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, 'bash check-rooms.sh');
    assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'bash session-bootstrap.sh');
    assert.equal(merged.permissions.defaultMode, 'bypassPermissions');

    const second = ensureHookInSettingsFile(settingsPath, 'SessionStart', 'bash session-bootstrap.sh', { timeout: 10 });
    assert.equal(second.changed, false);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(after.hooks.SessionStart.length, 1);
  });

  it('file wrapper creates settings.json when missing, without a backup', () => {
    const dir = tempDir();
    const settingsPath = join(dir, 'nested', 'settings.json');
    const res = ensureHookInSettingsFile(settingsPath, 'SessionStart', 'bash session-bootstrap.sh');
    assert.equal(res.changed, true);
    assert.equal(res.existed, false);
    assert.equal(res.backupPath, null);
    assert.equal(existsSync(`${settingsPath}.bak`), false);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(written.hooks.SessionStart[0].hooks[0].command, 'bash session-bootstrap.sh');
  });
});

describe('init installs the SessionStart bootstrap hook (end to end)', () => {
  it('iak init --ide claude-code wires the hook and re-running does not duplicate it', () => {
    const dir = tempDir();
    const cli = join(repoRoot, 'bin', 'cli.mjs');
    const run = () => execFileSync(process.execPath, [cli, 'init', '--ide', 'claude-code'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env },
    });
    const firstOut = run();
    assert.match(firstOut, /Installed SessionStart auto-bootstrap hook/);

    const scriptPath = join(dir, '.claude', 'scripts', 'session-bootstrap.sh');
    assert.ok(existsSync(scriptPath), 'session-bootstrap.sh copied into .claude/scripts');

    const settingsPath = join(dir, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entries = settings.hooks.SessionStart.filter(
      (e) => e.hooks?.some((h) => h.command === `bash ${scriptPath}`)
    );
    assert.equal(entries.length, 1);
    assert.ok(settings.hooks.UserPromptSubmit.length >= 1, 'check-rooms hook still present');

    const secondOut = run();
    assert.match(secondOut, /SessionStart auto-bootstrap hook already present/);
    const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entriesAfter = settingsAfter.hooks.SessionStart.filter(
      (e) => e.hooks?.some((h) => h.command === `bash ${scriptPath}`)
    );
    assert.equal(entriesAfter.length, 1);
  });
});
