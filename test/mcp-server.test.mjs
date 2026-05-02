// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the MCP server's pure functions.
// Coverage focus: the security-critical decideTmuxRunMode() and the explicit
// session-discovery in configuredAgentSessions(), plus a smoke check that the
// stdio server boots, advertises tools, and omits tmux_run by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decideTmuxRunMode, configuredAgentSessions } from '../src/mcp-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'iak-mcp.mjs');

// --- decideTmuxRunMode -------------------------------------------------------

test('decideTmuxRunMode: missing config disables tmux_run (fail-closed)', () => {
  const r = decideTmuxRunMode({});
  assert.equal(r.enabled, false);
  assert.match(r.reason, /tmux\.allow is missing or empty/);
});

test('decideTmuxRunMode: empty allowlist disables tmux_run', () => {
  const r = decideTmuxRunMode({ tmux: { allow: [] } });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /tmux\.allow is missing or empty/);
});

test('decideTmuxRunMode: non-empty allowlist enables tmux_run', () => {
  const r = decideTmuxRunMode({ tmux: { allow: ['npm test', 'git status'] } });
  assert.equal(r.enabled, true);
  assert.match(r.reason, /tmux\.allow has 2 pattern\(s\)/);
});

test('decideTmuxRunMode: mcp.allow_unrestricted=true enables tmux_run even with empty allowlist', () => {
  const r = decideTmuxRunMode({ tmux: { allow: [] }, mcp: { allow_unrestricted: true } });
  assert.equal(r.enabled, true);
  assert.match(r.reason, /allow_unrestricted=true/);
});

test('decideTmuxRunMode: mcp.allow_unrestricted=false does not enable when allowlist empty', () => {
  const r = decideTmuxRunMode({ tmux: { allow: [] }, mcp: { allow_unrestricted: false } });
  assert.equal(r.enabled, false);
});

// --- configuredAgentSessions ------------------------------------------------

test('configuredAgentSessions: returns empty array when nothing is configured', () => {
  assert.deepEqual(configuredAgentSessions({}), []);
  assert.deepEqual(configuredAgentSessions(null), []);
});

test('configuredAgentSessions: prefers explicit mcp.sessions array', () => {
  const sessions = configuredAgentSessions({
    mcp: { sessions: ['claude', 'claudemb', 'antigravity'] },
    tmux: { ide_session: 'should-be-ignored', default_session: 'also-ignored' },
  });
  assert.deepEqual(sessions, ['claude', 'claudemb', 'antigravity']);
});

test('configuredAgentSessions: falls back to tmux.ide_session + tmux.default_session', () => {
  const sessions = configuredAgentSessions({
    tmux: { ide_session: 'claudemb', default_session: 'iak-mb-runner' },
  });
  assert.deepEqual(sessions.sort(), ['claudemb', 'iak-mb-runner']);
});

test('configuredAgentSessions: deduplicates ide_session and default_session', () => {
  const sessions = configuredAgentSessions({
    tmux: { ide_session: 'same', default_session: 'same' },
  });
  assert.deepEqual(sessions, ['same']);
});

test('configuredAgentSessions: does NOT scan unrelated config keys (anti-fragility)', () => {
  // Without the explicit mcp.sessions, only the tmux fields are honored.
  // The previous implementation would have picked up hypothetical adapter
  // entries with .session keys and might pull in unrelated future config.
  const sessions = configuredAgentSessions({
    tmux: { ide_session: 'claude' },
    sentry: { session: 'this-should-not-leak' },
    discord: { session: 'this-too' },
  });
  assert.deepEqual(sessions, ['claude']);
});

test('configuredAgentSessions: drops empty strings and non-strings from mcp.sessions', () => {
  const sessions = configuredAgentSessions({
    mcp: { sessions: ['ok', '', null, 42, 'also-ok'] },
  });
  assert.deepEqual(sessions, ['ok', 'also-ok']);
});

// --- end-to-end stdio smoke ------------------------------------------------

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function rpc(line) { return JSON.stringify(line) + '\n'; }

async function bootAndListTools(configPath) {
  const args = configPath ? [BIN, '--config', configPath] : [BIN];
  const child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  child.stdout.on('data', (b) => stdout.push(b));
  child.stdin.write(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }));
  child.stdin.write(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  child.stdin.write(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const messages = Buffer.concat(stdout).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    init: messages.find((m) => m.id === 1),
    tools: (messages.find((m) => m.id === 2)?.result?.tools || []).map((t) => t.name).sort(),
  };
}

test('iak-mcp.mjs boots, advertises name + a real semver, exposes the safe tools', async () => {
  const { init, tools } = await bootAndListTools();
  assert.ok(init, 'expected initialize response');
  assert.equal(init.result.serverInfo.name, 'ide-agent-kit');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.ok(tools.includes('wake_ide'));
  assert.ok(tools.includes('list_sessions'));
  assert.ok(tools.includes('wake_all'));
  assert.ok(tools.includes('read_session'));
});

test('iak-mcp.mjs with empty tmux.allow OMITS tmux_run from the tool list (fail-closed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-mcp-test-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ tmux: { allow: [], default_session: 't' } }));
  try {
    const { tools } = await bootAndListTools(cfgPath);
    assert.deepEqual(tools, ['list_sessions', 'read_session', 'wake_all', 'wake_ide', 'wake_remote']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('iak-mcp.mjs with mcp.allow_unrestricted=true INCLUDES tmux_run even when allowlist empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-mcp-test-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    tmux: { allow: [], default_session: 't' },
    mcp: { allow_unrestricted: true },
  }));
  try {
    const { tools } = await bootAndListTools(cfgPath);
    assert.ok(tools.includes('tmux_run'), `expected tmux_run, got ${tools.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
