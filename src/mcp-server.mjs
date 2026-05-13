// SPDX-License-Identifier: AGPL-3.0-only
//
// MCP server for ide-agent-kit. Exposes tmux-backed "wake the IDE" primitives
// as MCP tools so any MCP-aware client (Claude Desktop / Code, Cursor,
// custom agents) can drive the IAK fleet without re-implementing the
// nudge / list / send-keys protocol.
//
// Tools exposed:
//   * wake_ide       — send a nudge string to a tmux session and press Enter
//   * list_sessions  — list all live tmux sessions on the host
//   * wake_all       — wake every configured IDE/agent session at once
//   * read_session   — capture-pane and return the last N lines of output
//   * tmux_run       — run an allowlisted command (mirrors `cli.mjs tmux run`)
//
// Security note: tmux_run is only registered when config.tmux.allow is a
// non-empty array or mcp.allow_unrestricted is explicitly true. Otherwise the
// tool is omitted entirely so an MCP client cannot turn it into an arbitrary
// shell over stdio. See decideTmuxRunMode().
//
// Transport: stdio. Compatible with Claude Desktop / Code MCP client config.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { nudgeTmux } from './common/notify.mjs';
import { tmuxRun } from './ide/tmux-runner.mjs';
import { loadConfig } from './config.mjs';
import {
  createIntent,
  decideIntent,
  waitForDecision,
  listIntents,
  startConfirmationsServer,
  makeGroupmindAnnouncer,
  makeCodewatchAnnouncer,
  composeAnnouncers,
} from './confirmations.mjs';

// Read package.json once at module load so the advertised server version
// tracks future package bumps without code edits.
const __pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
let SERVER_VERSION = '0.0.0';
try {
  SERVER_VERSION = JSON.parse(readFileSync(join(__pkgDir, 'package.json'), 'utf8')).version;
} catch {
  // leave default; not fatal
}

// --- helpers ----------------------------------------------------------------

function listTmuxSessions() {
  try {
    // Use a literal pipe as the field delimiter rather than \t — single-quoted
    // shell strings do NOT interpret \t, so tmux would receive a literal
    // backslash-t and emit it verbatim instead of a tab.
    const out = execSync(
      `tmux list-sessions -F '#{session_name}|#{?session_attached,attached,detached}|#{session_windows}'`,
      { encoding: 'utf8' }
    );
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, attached, windows] = line.split('|');
        return { name, attached: attached === 'attached', windows: parseInt(windows, 10) };
      });
  } catch {
    // tmux not running or no sessions
    return [];
  }
}

export function configuredAgentSessions(config) {
  // Sessions IAK explicitly knows about. Resolution order:
  //   1. config.mcp.sessions (explicit array of strings) — preferred.
  //   2. config.tmux.ide_session + config.tmux.default_session — fallback.
  // The previous "scan all top-level keys for objects with a .session string"
  // heuristic was dropped because it would silently pick up unrelated
  // future config keys (e.g. {sentry: {session: "warn"}}).
  const sessions = new Set();
  if (Array.isArray(config?.mcp?.sessions)) {
    for (const s of config.mcp.sessions) {
      if (typeof s === 'string' && s.length > 0) sessions.add(s);
    }
    return [...sessions];
  }
  if (config?.tmux?.ide_session) sessions.add(config.tmux.ide_session);
  if (config?.tmux?.default_session) sessions.add(config.tmux.default_session);
  return [...sessions];
}

export function confirmationFromHandle(args = {}, config = {}) {
  const explicit = args.fromHandle || args.from_handle;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const configured = config?.poller?.handle;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return undefined;
}

export function configuredRoomApi(config = {}, args = {}) {
  const confirmCfg = config?.mcp?.confirmations || {};
  const fromHandle = confirmationFromHandle(args, config);
  const apiKeys = confirmCfg.api_keys || {};
  const apiKey =
    args.apiKey ||
    args.api_key ||
    (fromHandle && apiKeys[fromHandle]) ||
    config?.poller?.api_key ||
    config?.poller?.apiKey ||
    config?.intent?.apiKey ||
    '';
  const room =
    args.room ||
    confirmCfg.room ||
    (Array.isArray(config?.poller?.rooms) ? config.poller.rooms[0] : '') ||
    '';
  const baseUrl =
    config?.groupmind?.base_url ||
    config?.groupmind?.baseUrl ||
    config?.intent?.baseUrl ||
    'https://groupmind.one/api/v1';
  return { apiKey, room, baseUrl: String(baseUrl).replace(/\/$/, ''), fromHandle };
}

export function roomApiConfigured(config = {}) {
  const { apiKey, room } = configuredRoomApi(config);
  return Boolean(apiKey && room);
}

function roomHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function postRoomMessage({ config, room, body, fromHandle }) {
  const roomCfg = configuredRoomApi(config, { room, fromHandle });
  if (!roomCfg.apiKey) throw new Error('room_post: missing poller.api_key or intent.apiKey');
  if (!roomCfg.room) throw new Error('room_post: room is required');
  if (!body || typeof body !== 'string') throw new Error('room_post: body is required');

  const res = await fetch(`${roomCfg.baseUrl}/messages`, {
    method: 'POST',
    headers: roomHeaders(roomCfg.apiKey),
    body: JSON.stringify({ room: roomCfg.room, body }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`room_post: HTTP ${res.status} — ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

async function fetchRoomMessages({ config, room, limit }) {
  const roomCfg = configuredRoomApi(config, { room });
  if (!roomCfg.apiKey) throw new Error('room_recent: missing poller.api_key or intent.apiKey');
  if (!roomCfg.room) throw new Error('room_recent: room is required');
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const url = `${roomCfg.baseUrl}/rooms/${encodeURIComponent(roomCfg.room)}/messages?limit=${safeLimit}`;
  const res = await fetch(url, {
    headers: roomHeaders(roomCfg.apiKey),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`room_recent: HTTP ${res.status} — ${text}`);
  return JSON.parse(text);
}

// Decides whether tmux_run should be exposed and why. Returns
// {enabled: boolean, reason: string} so the boot log can explain itself.
export function decideTmuxRunMode(config) {
  if (config?.mcp?.allow_unrestricted === true) {
    return { enabled: true, reason: 'mcp.allow_unrestricted=true (any command will run)' };
  }
  const allow = config?.tmux?.allow;
  if (Array.isArray(allow) && allow.length > 0) {
    return { enabled: true, reason: `tmux.allow has ${allow.length} pattern(s)` };
  }
  return {
    enabled: false,
    reason:
      'tmux.allow is missing or empty — refusing to expose tmux_run as an arbitrary shell. ' +
      'Set tmux.allow to a non-empty list, or mcp.allow_unrestricted=true to override.',
  };
}

export function captureTmuxPane(session, lines = 50) {
  // tmux capture-pane: -p print to stdout, -t target, -S start (-N = N lines back).
  // Returns last `lines` lines of the session's active pane.
  const safeLines = Math.max(1, Math.min(2000, parseInt(lines, 10) || 50));
  try {
    return execSync(
      `tmux capture-pane -p -t ${JSON.stringify(session)} -S -${safeLines}`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    throw new Error(`capture-pane failed for "${session}": ${e.message}`);
  }
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// --- server -----------------------------------------------------------------

export async function runMcpServer({ configPath } = {}) {
  let config = {};
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    // The MCP server should still start even if the config is missing — the
    // tools just degrade (wake_all won't know the configured sessions).
    process.stderr.write(`[iak-mcp] warning: config not loaded: ${e.message}\n`);
  }

  const server = new Server(
    { name: 'ide-agent-kit', version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  // Decide tmux_run exposure once at boot so the tool list is stable for the
  // session.
  const tmuxRunMode = decideTmuxRunMode(config);
  process.stderr.write(`[iak-mcp] tmux_run: ${tmuxRunMode.enabled ? 'enabled' : 'disabled'} — ${tmuxRunMode.reason}\n`);

  // Confirmation server — starts only when at least one channel is configured.
  // GroupMind needs (poller.api_key, mcp.confirmations.room); Codewatch needs
  // mcp.confirmations.codewatch_gate_url. Both optional.
  const confirmCfg = config?.mcp?.confirmations || {};
  const announcerMap = {};
  if (confirmCfg.room && config?.poller?.api_key) {
    announcerMap.groupmind = makeGroupmindAnnouncer({
      apiKey: config.poller.api_key,
      room: confirmCfg.room,
      callbackBase: confirmCfg.callback_base || `http://127.0.0.1:${confirmCfg.port || 8788}`,
    });
  }
  if (confirmCfg.codewatch_gate_url) {
    announcerMap.codewatch = makeCodewatchAnnouncer({
      gateUrl: confirmCfg.codewatch_gate_url,
      gateToken: confirmCfg.codewatch_gate_token,
    });
  }
  const announce = composeAnnouncers(announcerMap);
  const confirmEnabled = Object.keys(announcerMap).length > 0;
  const roomToolsEnabled = roomApiConfigured(config);

  // Try to detect a separately-running iak-mcp-daemon on the configured port.
  // When present, the MCP server forwards intent creation + decision polling
  // to the daemon's HTTP endpoints — this lets multiple MCP clients share a
  // single intent registry (one daemon, many agents). When absent, the MCP
  // server starts its own confirmations server in-process.
  const daemonHost = confirmCfg.host || '127.0.0.1';
  const daemonPort = confirmCfg.port || 8788;
  const daemonBase = `http://${daemonHost === '0.0.0.0' ? '127.0.0.1' : daemonHost}:${daemonPort}`;
  let daemonAvailable = false;
  try {
    const probe = await fetch(`${daemonBase}/intents`, { method: 'GET', signal: AbortSignal.timeout(500) });
    daemonAvailable = probe.ok;
  } catch { /* not running */ }

  let confirmServer = null;
  if (daemonAvailable) {
    process.stderr.write(
      `[iak-mcp] confirmations: forwarding to live daemon at ${daemonBase}\n`
    );
  } else if (confirmEnabled) {
    confirmServer = startConfirmationsServer({
      port: daemonPort,
      host: confirmCfg.host || '127.0.0.1',
      authToken: confirmCfg.auth_token || '',
      receiptsPath: config?.receipts?.path,
      announce,
      wakeScript: confirmCfg.wake_script || confirmCfg.wakeScript || config?.poller?.wake_script || config?.poller?.nudge_command || config?.wake?.script_path,
    });
    process.stderr.write(
      `[iak-mcp] confirmations: enabled on ${daemonBase} (in-process) — channels: ${Object.keys(announcerMap).join(', ')}\n`
    );
  } else {
    process.stderr.write(
      '[iak-mcp] confirmations: disabled — set mcp.confirmations.room (+ poller.api_key) and/or mcp.confirmations.codewatch_gate_url\n'
    );
  }

  const tools = [
    {
      name: 'room_list_new',
      description: 'List new messages from the notification file.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'room_ack',
      description: 'Clear the notification file, acknowledging that messages have been read.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wake_ide',
      description:
        'Wake an IDE / agent by sending a text nudge to its tmux session and pressing Enter. ' +
        'Use list_sessions first to discover available session names.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'tmux session name (e.g. "claude", "claudemb", "antigravity")' },
          text: { type: 'string', description: 'Text to type before pressing Enter. Default: "check rooms".', default: 'check rooms' },
        },
        required: ['session'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List every live tmux session on this host with attach state and window count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wake_all',
      description:
        'Send the same nudge to every IDE / agent session that IAK is configured to know about ' +
        '(via mcp.sessions in config, falling back to tmux.ide_session + tmux.default_session). ' +
        'Returns per-session success / failure.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Nudge text. Default: "check rooms".', default: 'check rooms' },
        },
      },
    },
    {
      name: 'wake_remote',
      description:
        'Wake a remote agent by POSTing to its IAK daemon /wake endpoint. The remote daemon ' +
        'runs its configured wake script (typically scripts/claudemb-wake.sh, an osascript ' +
        'injector for the Claude desktop app) so the remote agent gets a "check rooms" prompt ' +
        'within ~500ms regardless of room-poll cadence. Use this for direct cross-machine ' +
        'agent-to-agent coordination (e.g. claudemm has a question that needs claudemb).',
      inputSchema: {
        type: 'object',
        properties: {
          gateUrl: { type: 'string', description: 'Base URL of the remote IAK daemon, e.g. http://192.168.50.240:8788.' },
          text: { type: 'string', description: 'Nudge text. Default: "check rooms".', default: 'check rooms' },
        },
        required: ['gateUrl'],
      },
    },
    {
      name: 'read_session',
      description:
        'Capture the current visible content of a tmux session pane. Use this after wake_ide ' +
        'to see what the agent printed in response, or to inspect what an IDE is currently showing.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'tmux session name' },
          lines: { type: 'integer', description: 'How many lines back to capture (1..2000). Default 50.', default: 50 },
        },
        required: ['session'],
      },
    },
  ];
  if (confirmEnabled) {
    tools.push(
      {
        name: 'request_confirmation',
        description:
          'Ask the user for an Approve / Deny decision. Posts the prompt to the configured ' +
          'channels (GroupMind room, Codewatch notification) and BLOCKS until the user decides ' +
          'or the timeout expires. Returns {decision: "approve"|"deny"} on decide, ' +
          '{status: "timeout", id} on timeout. Use the id to follow up via approve_intent / deny_intent.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Human-readable question to show the user. Keep it short — fits in a watch notification.' },
            session: { type: 'string', description: 'tmux session that triggered the request, for context. Optional.' },
            channels: {
              type: 'array',
              items: { type: 'string', enum: ['groupmind', 'codewatch'] },
              description: 'Which channels to post to. Default: all configured channels.',
            },
            timeoutSec: { type: 'number', description: 'How long to wait for a decision before returning timeout. Default 600 (10 min).', default: 600 },
            fromHandle: {
              type: 'string',
              description: 'Originating agent handle for attribution, e.g. @CodexMB. Defaults to poller.handle from config.',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'list_intents',
        description: 'List every confirmation intent the server knows about (pending, decided, recent).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'approve_intent',
        description: 'Manually approve a pending intent by id (e.g. for an MCP-driven override).',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'deny_intent',
        description: 'Manually deny a pending intent by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      }
    );
  }
  if (roomToolsEnabled) {
    tools.push(
      {
        name: 'room_post',
        description:
          'Post a message to a configured GroupMind room directly through the IAK MCP server. ' +
          'Use this instead of shelling out to curl/python for low-latency room replies.',
        inputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string', description: 'Message body to post.' },
            room: { type: 'string', description: 'Room slug. Defaults to mcp.confirmations.room or first poller room.' },
            fromHandle: { type: 'string', description: 'Optional agent handle for per-agent API key attribution.' },
          },
          required: ['body'],
        },
      },
      {
        name: 'room_recent',
        description: 'Fetch recent messages from a configured GroupMind room without shelling out.',
        inputSchema: {
          type: 'object',
          properties: {
            room: { type: 'string', description: 'Room slug. Defaults to mcp.confirmations.room or first poller room.' },
            limit: { type: 'integer', description: 'Number of messages to fetch, 1..100. Default 20.', default: 20 },
          },
        },
      },
      {
        name: 'alert_recipient',
        description:
          'Alert a room recipient by posting an @mention message through GroupMind. ' +
          'This is the MCP-side recipient alert primitive; wake delivery remains the webhook/poller responsibility.',
        inputSchema: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: 'Recipient handle, with or without leading @.' },
            body: { type: 'string', description: 'Message body after the mention.' },
            room: { type: 'string', description: 'Room slug. Defaults to mcp.confirmations.room or first poller room.' },
            fromHandle: { type: 'string', description: 'Optional sender handle for per-agent API key attribution.' },
          },
          required: ['handle', 'body'],
        },
      }
    );
  }
  if (tmuxRunMode.enabled) {
    tools.push({
      name: 'tmux_run',
      description:
        'Run a command in a tmux session. Subject to the same allowlist as `ide-agent-kit tmux run`. ' +
        'Captures output and exit code, appends a receipt entry.',
      inputSchema: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Command to run (must match tmux.allow patterns in config)' },
          session: { type: 'string', description: 'tmux session name (defaults to config tmux.default_session)' },
          cwd: { type: 'string', description: 'Working directory' },
          timeoutSec: { type: 'number', description: 'Hard timeout in seconds', default: 60 },
        },
        required: ['cmd'],
      },
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};
    try {
      switch (name) {
        case 'room_list_new': {
          const notifyFile = config?.poller?.notification_file || '/tmp/iak-new-messages.txt';
          try {
            const content = readFileSync(notifyFile, 'utf8').trim();
            if (!content) return ok('No new messages.');
            return ok(content);
          } catch {
            return ok('No new messages.');
          }
        }
        case 'room_ack': {
          const notifyFile = config?.poller?.notification_file || '/tmp/iak-new-messages.txt';
          try {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(notifyFile, '');
            return ok('Acknowledged new messages.');
          } catch (e) {
            return err('Failed to ack: ' + e.message);
          }
        }
        case 'wake_ide': {
          if (!args.session) return err('wake_ide: session is required');
          const text = typeof args.text === 'string' ? args.text : 'check rooms';
          const success = nudgeTmux(args.session, text);
          return success
            ? ok(`Nudged ${args.session} with: ${JSON.stringify(text)}`)
            : err(`Could not nudge ${args.session} — session not found or tmux not running.`);
        }
        case 'list_sessions': {
          const sessions = listTmuxSessions();
          if (sessions.length === 0) return ok('No tmux sessions running.');
          const lines = sessions.map((s) => `  ${s.name}\t${s.attached ? 'attached' : 'detached'}\t${s.windows} window(s)`);
          return ok(`tmux sessions (${sessions.length}):\n${lines.join('\n')}`);
        }
        case 'wake_all': {
          const text = typeof args.text === 'string' ? args.text : 'check rooms';
          const targets = configuredAgentSessions(config);
          if (targets.length === 0) return ok('No agent sessions configured. Add one to config.tmux.ide_session.');
          const live = new Set(listTmuxSessions().map((s) => s.name));
          const results = targets.map((session) => {
            if (!live.has(session)) return { session, success: false, reason: 'not running' };
            return { session, success: nudgeTmux(session, text), reason: null };
          });
          const lines = results.map((r) =>
            r.success ? `  ✓ ${r.session}` : `  ✗ ${r.session}${r.reason ? ` (${r.reason})` : ''}`
          );
          return ok(`Woke with ${JSON.stringify(text)}:\n${lines.join('\n')}`);
        }
        case 'wake_remote': {
          if (!args.gateUrl) return err('wake_remote: gateUrl is required');
          const text = typeof args.text === 'string' ? args.text : 'check rooms';
          try {
            const res = await fetch(`${args.gateUrl}/wake`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(5000),
            });
            const body = await res.text();
            if (res.status >= 200 && res.status < 300) {
              return ok(`wake_remote ${args.gateUrl}: ${res.status} — ${body}`);
            }
            return err(`wake_remote ${args.gateUrl}: HTTP ${res.status} — ${body}`);
          } catch (e) {
            return err(`wake_remote ${args.gateUrl}: ${e.message || String(e)}`);
          }
        }
        case 'read_session': {
          if (!args.session) return err('read_session: session is required');
          try {
            const out = captureTmuxPane(args.session, args.lines);
            return ok(out);
          } catch (e) {
            return err(e.message);
          }
        }
        case 'room_post': {
          if (!roomToolsEnabled) return err('room_post: room API is not configured.');
          const posted = await postRoomMessage({
            config,
            room: args.room,
            body: args.body,
            fromHandle: args.fromHandle || args.from_handle,
          });
          return ok(JSON.stringify(posted, null, 2));
        }
        case 'room_recent': {
          if (!roomToolsEnabled) return err('room_recent: room API is not configured.');
          const recent = await fetchRoomMessages({ config, room: args.room, limit: args.limit });
          return ok(JSON.stringify(recent, null, 2));
        }
        case 'alert_recipient': {
          if (!roomToolsEnabled) return err('alert_recipient: room API is not configured.');
          if (!args.handle) return err('alert_recipient: handle is required');
          if (!args.body) return err('alert_recipient: body is required');
          const handle = String(args.handle).startsWith('@') ? String(args.handle) : `@${args.handle}`;
          const posted = await postRoomMessage({
            config,
            room: args.room,
            body: `${handle} ${args.body}`,
            fromHandle: args.fromHandle || args.from_handle,
          });
          return ok(JSON.stringify(posted, null, 2));
        }
        case 'request_confirmation': {
          if (!confirmEnabled && !daemonAvailable) return err('request_confirmation: confirmations not configured. Set mcp.confirmations.room (+ poller.api_key) and/or codewatch_gate_url.');
          if (!args.prompt) return err('request_confirmation: prompt is required');
          const timeoutSec = Math.max(1, Math.min(86400, args.timeoutSec || 600));

          // Daemon mode: forward to the running iak-mcp-daemon so the intent
          // is in the SHARED registry that CodeWatch and the chat-reply
          // poller see. This is the production path when a daemon is up.
          if (daemonAvailable) {
            const createRes = await fetch(`${daemonBase}/intent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: args.prompt,
                session: args.session,
                channels: Array.isArray(args.channels) ? args.channels : undefined,
                from_handle: confirmationFromHandle(args, config),
              }),
            });
            const created = await createRes.json();
            if (!created.ok) return err(`daemon createIntent: ${created.error}`);
            const id = created.id;
            // Poll for decision.
            const deadline = Date.now() + timeoutSec * 1000;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                const list = await (await fetch(`${daemonBase}/intents`)).json();
                const found = list.find((i) => i.id === id);
                if (found && found.status === 'decided') {
                  return ok(JSON.stringify({ id, decision: found.decision }, null, 2));
                }
              } catch { /* retry */ }
            }
            return ok(JSON.stringify({ id, status: 'timeout', timeoutSec }, null, 2));
          }

          // In-process fallback (no daemon).
          const channels = Array.isArray(args.channels) && args.channels.length > 0
            ? args.channels.filter((c) => announcerMap[c])
            : Object.keys(announcerMap);
          const id = await createIntent({
            prompt: args.prompt,
            session: args.session,
            channels,
            timeoutSec,
            announce,
            receiptsPath: config?.receipts?.path,
            fromHandle: confirmationFromHandle(args, config),
          });
          const result = await waitForDecision(id, { timeoutMs: timeoutSec * 1000 });
          if (result.status === 'decided') {
            return ok(JSON.stringify({ id, decision: result.decision }, null, 2));
          }
          return ok(JSON.stringify({ id, status: 'timeout', timeoutSec }, null, 2));
        }
        case 'list_intents': {
          if (!confirmEnabled) return err('list_intents: confirmations not configured.');
          return ok(JSON.stringify(listIntents(), null, 2));
        }
        case 'approve_intent': {
          if (!confirmEnabled) return err('approve_intent: confirmations not configured.');
          if (!args.id) return err('approve_intent: id is required');
          const r = decideIntent(args.id, 'approve', { receiptsPath: config?.receipts?.path });
          return r.ok ? ok(`Approved ${args.id}`) : err(r.error);
        }
        case 'deny_intent': {
          if (!confirmEnabled) return err('deny_intent: confirmations not configured.');
          if (!args.id) return err('deny_intent: id is required');
          const r = decideIntent(args.id, 'deny', { receiptsPath: config?.receipts?.path });
          return r.ok ? ok(`Denied ${args.id}`) : err(r.error);
        }
        case 'tmux_run': {
          if (!tmuxRunMode.enabled) {
            return err(`tmux_run is disabled in this MCP session: ${tmuxRunMode.reason}`);
          }
          if (!args.cmd) return err('tmux_run: cmd is required');
          const result = await tmuxRun({
            session: args.session,
            cmd: args.cmd,
            cwd: args.cwd,
            timeoutSec: args.timeoutSec || 60,
            config,
          });
          return ok(JSON.stringify(result, null, 2));
        }
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`${name} failed: ${e.message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[iak-mcp] ready on stdio\n');
}

// Run directly when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Allow --config <path> on the command line (mirrors other CLI subcommands).
  const argv = process.argv.slice(2);
  let configPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = argv[i + 1];
      i++;
    }
  }
  runMcpServer({ configPath }).catch((e) => {
    process.stderr.write(`[iak-mcp] fatal: ${e.message}\n`);
    process.exit(1);
  });
}
