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

import {
  confirmationFromHandle,
  configuredRoomApi,
  decideTmuxRunMode,
  configuredAgentSessions,
  roomApiConfigured,
  removeConsumedNotifications,
  ackNotificationFile,
} from '../src/mcp-server.mjs';

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

// --- confirmation attribution -----------------------------------------------

test('confirmationFromHandle: prefers explicit request handle', () => {
  assert.equal(
    confirmationFromHandle({ fromHandle: '@explicit' }, { poller: { handle: '@configured' } }),
    '@explicit'
  );
  assert.equal(
    confirmationFromHandle({ from_handle: '@snake' }, { poller: { handle: '@configured' } }),
    '@snake'
  );
});

test('confirmationFromHandle: falls back to poller.handle', () => {
  assert.equal(confirmationFromHandle({}, { poller: { handle: '@CodexMB' } }), '@CodexMB');
});

test('confirmationFromHandle: returns undefined without attribution', () => {
  assert.equal(confirmationFromHandle({}, {}), undefined);
});

// --- room MCP helpers --------------------------------------------------------

test('configuredRoomApi: resolves default room and per-agent API key', () => {
  const cfg = {
    poller: { api_key: 'default-key', rooms: ['thinkoff-development'], handle: '@CodexMB' },
    intent: { baseUrl: 'https://groupmind.one/api/v1/' },
    mcp: { confirmations: { api_keys: { '@Other': 'other-key' } } },
  };
  assert.deepEqual(configuredRoomApi(cfg), {
    apiKey: 'default-key',
    room: 'thinkoff-development',
    baseUrl: 'https://groupmind.one/api/v1',
    fromHandle: '@CodexMB',
  });
  assert.equal(configuredRoomApi(cfg, { fromHandle: '@Other' }).apiKey, 'other-key');
});

test('roomApiConfigured: requires both API key and room', () => {
  assert.equal(roomApiConfigured({}), false);
  assert.equal(roomApiConfigured({ poller: { api_key: 'k' } }), false);
  assert.equal(roomApiConfigured({ poller: { rooms: ['r'] } }), false);
  assert.equal(roomApiConfigured({ poller: { api_key: 'k', rooms: ['r'] } }), true);
});

// --- end-to-end stdio smoke ------------------------------------------------

import { writeFileSync, appendFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    assert.deepEqual(tools, ['list_sessions', 'read_session', 'room_ack', 'room_list_new', 'wake_all', 'wake_ide', 'wake_remote']);
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

test('iak-mcp.mjs with room API config exposes low-latency room tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-mcp-test-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    poller: { api_key: 'test-key', rooms: ['thinkoff-development'] },
    tmux: { allow: [], default_session: 't' },
  }));
  try {
    const { tools } = await bootAndListTools(cfgPath);
    assert.ok(tools.includes('room_post'), `expected room_post, got ${tools.join(',')}`);
    assert.ok(tools.includes('room_recent'), `expected room_recent, got ${tools.join(',')}`);
    assert.ok(tools.includes('alert_recipient'), `expected alert_recipient, got ${tools.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- removeConsumedNotifications (pure) --------------------------------------

test('removeConsumedNotifications: consumed prefix is dropped, later append survives', () => {
  const consumed = '[room] alice: first\n[room] bob: second\n';
  const current = consumed + '[room] petrus: arrived after the read\n';
  const r = removeConsumedNotifications(current, consumed);
  assert.equal(r.remainder, '[room] petrus: arrived after the read\n');
  assert.equal(r.consumedLines, 2);
  assert.equal(r.mode, 'prefix');
});

test('removeConsumedNotifications: nothing appended → file drains to empty', () => {
  const consumed = '[room] alice: first\n';
  const r = removeConsumedNotifications(consumed, consumed);
  assert.equal(r.remainder, '');
  assert.equal(r.consumedLines, 1);
});

test('removeConsumedNotifications: empty read consumes nothing (late lines survive)', () => {
  const r = removeConsumedNotifications('[room] petrus: late\n', '');
  assert.equal(r.remainder, '[room] petrus: late\n');
  assert.equal(r.consumedLines, 0);
  assert.equal(r.mode, 'noop');
});

test('removeConsumedNotifications: rewritten file falls back to per-line removal', () => {
  // File no longer starts with what was read (e.g. rotated/edited in between):
  // remove read lines by exact match, keep everything else.
  const consumed = '[room] alice: first\n[room] bob: second\n';
  const current = '[room] petrus: new head\n[room] bob: second\n[room] alice: first\n[room] petrus: tail\n';
  const r = removeConsumedNotifications(current, consumed);
  assert.equal(r.remainder, '[room] petrus: new head\n[room] petrus: tail\n');
  assert.equal(r.consumedLines, 2);
  assert.equal(r.mode, 'lines');
});

test('removeConsumedNotifications: duplicate lines removed with multiset semantics', () => {
  const consumed = '[room] bot: ping\n';
  const current = '[room] bot: other\n[room] bot: ping\n[room] bot: ping\n';
  const r = removeConsumedNotifications(current, consumed);
  // Only ONE copy of the read line is removed; the second (unread) survives.
  assert.equal(r.remainder, '[room] bot: other\n[room] bot: ping\n');
  assert.equal(r.consumedLines, 1);
});

// --- ackNotificationFile (file-level) ----------------------------------------

test('ackNotificationFile: REGRESSION — poller append between read and ack survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-ack-test-'));
  const notifyFile = join(dir, 'new-messages.txt');
  try {
    // Agent reads (room_list_new captures this content)...
    const consumed = '[room] alice: task A\n[room] bob: task B\n';
    writeFileSync(notifyFile, consumed);
    // ...poller races in and appends BEFORE the agent acks (the 2026-07-08
    // incident shape: an owner instruction landed in this window)...
    appendFileSync(notifyFile, '[room] petrus: send all 3\n');
    // ...agent acks what it read.
    const r = ackNotificationFile(notifyFile, consumed);
    assert.equal(r.consumedLines, 2);
    assert.equal(r.preservedLines, 1);
    // The late line MUST still be in the file, unread but not lost.
    assert.equal(readFileSync(notifyFile, 'utf8'), '[room] petrus: send all 3\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ackNotificationFile: no prior read (null) keeps legacy clear-all contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-ack-test-'));
  const notifyFile = join(dir, 'new-messages.txt');
  try {
    writeFileSync(notifyFile, '[room] a: x\n[room] b: y\n');
    const r = ackNotificationFile(notifyFile, null);
    assert.equal(r.mode, 'all');
    assert.equal(readFileSync(notifyFile, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ackNotificationFile: missing notification file is a no-op ack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-ack-test-'));
  const notifyFile = join(dir, 'does-not-exist.txt');
  try {
    const r = ackNotificationFile(notifyFile, '[room] a: x\n');
    assert.equal(r.consumedLines, 0);
    assert.equal(r.preservedLines, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end stdio regression: room_list_new → append → room_ack ---------

function bootMcp(configPath) {
  const child = spawn('node', [BIN, '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (b) => {
    buf += b.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const settle = waiters.get(msg.id);
      if (settle) { waiters.delete(msg.id); settle(msg); }
    }
  });
  let nextId = 100;
  const request = (method, params) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++;
      waiters.set(id, resolvePromise);
      setTimeout(() => {
        if (waiters.delete(id)) rejectPromise(new Error(`timeout waiting for ${method} (id ${id})`));
      }, 10000).unref();
      child.stdin.write(rpc({ jsonrpc: '2.0', id, method, params }));
    });
  child.stdin.write(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }));
  child.stdin.write(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const close = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  };
  return { request, close };
}

test('iak-mcp.mjs REGRESSION: room_ack clears only what room_list_new returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-mcp-test-'));
  const cfgPath = join(dir, 'config.json');
  const notifyFile = join(dir, 'new-messages.txt');
  writeFileSync(cfgPath, JSON.stringify({
    poller: { notification_file: notifyFile },
    tmux: { allow: [], default_session: 't' },
  }));
  writeFileSync(notifyFile, '[room] alice: first\n[room] bob: second\n');
  const { request, close } = bootMcp(cfgPath);
  try {
    const listed = await request('tools/call', { name: 'room_list_new', arguments: {} });
    assert.match(listed.result.content[0].text, /alice: first/);
    // Poller races in between the read and the ack.
    appendFileSync(notifyFile, '[room] petrus: send all 3\n');
    const acked = await request('tools/call', { name: 'room_ack', arguments: {} });
    assert.match(acked.result.content[0].text, /preserved/);
    assert.equal(readFileSync(notifyFile, 'utf8'), '[room] petrus: send all 3\n');
    // Second read+ack drains the file completely.
    const listed2 = await request('tools/call', { name: 'room_list_new', arguments: {} });
    assert.match(listed2.result.content[0].text, /send all 3/);
    await request('tools/call', { name: 'room_ack', arguments: {} });
    assert.equal(readFileSync(notifyFile, 'utf8'), '');
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
