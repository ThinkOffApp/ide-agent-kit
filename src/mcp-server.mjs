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
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { assertRoomVoice } from './responder-lock.mjs';
import { isMainModule } from './common/entrypoint.mjs';
import { defaultCallbackBase,
  createIntent,
  decideIntent,
  waitForDecision,
  listIntents,
  startConfirmationsServer,
  startChatReplyPoller,
  configureActionStatusPush,
  makeGroupmindAnnouncer,
  makeCodewatchAnnouncer,
  composeAnnouncers,
} from './confirmations.mjs';
import { probeAndOffer, describeExclusion, resolveModelRegistryPath } from './model-selection.mjs';
import { resolveCallerHost } from '../packages/user-intent-kit/src/model-capacity.js';

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

// Gate daemons (startConfirmationsServer / iak-mcp-daemon) enforce their
// auth_token on EVERY endpoint, /wake included — a caller without the bearer
// header gets 401 {"ok":false,"error":"unauthorized"} even for a plain nudge.
// Resolve this machine's copy of the fleet token: the token file first
// (~/.config/iak-gate.token, overridable via IAK_GATE_TOKEN_FILE), then the
// IAK_GATE_TOKEN env var. Returns '' when neither exists so open daemons keep
// working unauthenticated. Callers re-resolve per request rather than caching
// at boot — a token rotation must not leave a long-lived MCP session sending
// a stale credential (the poller stale-key incident shape).
export function resolveGateToken({ env = process.env } = {}) {
  const tokenFile = env.IAK_GATE_TOKEN_FILE || join(homedir(), '.config', 'iak-gate.token');
  try {
    const fromFile = readFileSync(tokenFile, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* no token file */ }
  return typeof env.IAK_GATE_TOKEN === 'string' ? env.IAK_GATE_TOKEN.trim() : '';
}

export function gateAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// The fleet gate token must never travel to a caller-influenced destination:
// tool args are reachable from untrusted input (room messages, web pages, PR
// text can steer a wake_remote call), so an arbitrary gateUrl + bearer header
// is a token-exfiltration path (claudemm, PR #52 review). Trusted hosts are
// where fleet daemons can actually live: loopback, RFC1918 LAN ranges, the
// tailnet CGNAT range, and .local mDNS names. Anything else still gets the
// wake — just unauthenticated, the same graceful degradation open daemons
// already rely on.
export function isTrustedGateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.local')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                       // loopback
  if (a === 10) return true;                        // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;          // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // tailnet CGNAT
  return false;
}

// Auth headers for a request to `url`: bearer only when the destination host
// is trusted, {} otherwise (and {} on any unparseable URL).
export function gateAuthHeadersFor(url, token = resolveGateToken()) {
  try {
    if (!isTrustedGateHost(new URL(url).hostname)) return {};
  } catch {
    return {};
  }
  return gateAuthHeaders(token);
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

// React to a room message instead of posting "agreed" as its own message.
//
// Added 2026-09-18 after petrus: "everybody saying they agree with emojis takes
// zero space, with messages at least one page ... i cant find answers to my
// questions as id need to scroll 30 pages". Agreement was costing him a screen
// each time, and the only way to react was raw HTTP, which agents that talk to
// the room exclusively through this server could not do at all.
//
// The room slug MUST be in the path. /messages/{id}/react and any /reactions
// spelling 404, and three agents read those 404s as "the product has no
// reactions" while he was using them daily.
async function reactToRoomMessage({ config, room, messageId, emoji, remove }) {
  const roomCfg = configuredRoomApi(config, { room });
  if (!roomCfg.apiKey) throw new Error('room_react: missing poller.api_key or intent.apiKey');
  if (!roomCfg.room) throw new Error('room_react: room is required');
  if (!messageId) throw new Error('room_react: message_id is required');
  if (!emoji) throw new Error('room_react: emoji is required');
  const url = `${roomCfg.baseUrl}/rooms/${encodeURIComponent(roomCfg.room)}/messages/${encodeURIComponent(messageId)}/react`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...roomHeaders(roomCfg.apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(remove ? { emoji, remove: true } : { emoji }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`room_react: HTTP ${res.status} — ${text}`);
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

// --- notification ack (consumed-only) ---------------------------------------
//
// room_ack used to blank the whole notification file. Anything the poller
// appended between the agent's last room_list_new read and the ack was wiped
// unread (real incident 2026-07-08: an owner instruction sat 5 hours unseen).
// The fix: room_list_new remembers the exact bytes it returned; room_ack
// removes ONLY those bytes and preserves anything appended since.

function countNotificationLines(raw) {
  if (!raw) return 0;
  return raw.split('\n').filter((l) => l.trim().length > 0).length;
}

export function removeConsumedNotifications(currentRaw, consumedRaw) {
  // Compute what should remain in the notification file after acking exactly
  // the content a prior room_list_new returned.
  //
  // Fast path: the pollers only ever append, so the consumed content is
  // normally still a byte-prefix of the current file — drop that prefix.
  // Fallback: if the file was rewritten in between (manual edit, rotation),
  // drop consumed lines by exact match (multiset semantics) and keep the rest.
  const current = currentRaw || '';
  const consumed = consumedRaw || '';
  if (!consumed.trim()) {
    // Last read saw an empty file — nothing was consumed, nothing to remove.
    return { remainder: current, consumedLines: 0, mode: 'noop' };
  }
  if (current.startsWith(consumed)) {
    return {
      remainder: current.slice(consumed.length),
      consumedLines: countNotificationLines(consumed),
      mode: 'prefix',
    };
  }
  const pending = new Map();
  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue;
    pending.set(line, (pending.get(line) || 0) + 1);
  }
  const kept = [];
  let removed = 0;
  for (const line of current.split('\n')) {
    if (line.trim() && (pending.get(line) || 0) > 0) {
      pending.set(line, pending.get(line) - 1);
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return { remainder: kept.join('\n'), consumedLines: removed, mode: 'lines' };
}

function atomicWriteNotify(notifyFile, content) {
  // Temp-file + rename in the same directory so readers never observe a
  // half-written file. The pollers re-open the path on every appendFileSync,
  // so appends after the rename land in the new file; the read→rename window
  // inside a single ack is microseconds (vs the old read→think→truncate
  // window of minutes). tail -F watchers see the rename as a rotation and
  // re-open; the IAK Monitor/hook patterns re-read the whole file anyway.
  let mode;
  try {
    mode = statSync(notifyFile).mode & 0o777;
  } catch {
    // File missing — default mode is fine.
  }
  const tmp = `${notifyFile}.ack-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, content, mode != null ? { mode } : undefined);
  renameSync(tmp, notifyFile);
}

export function ackNotificationFile(notifyFile, consumedRaw) {
  // consumedRaw === null → no room_list_new recorded this session: legacy
  // clear-everything behavior (kept for cold callers, inherently racy).
  // Otherwise remove only the consumed content; late arrivals survive.
  let current = '';
  try {
    current = readFileSync(notifyFile, 'utf8');
  } catch {
    current = ''; // missing file == already empty
  }
  if (consumedRaw == null) {
    // No room_list_new this session. The old behaviour was to blank the file
    // anyway and return a sentence advising against it. A warning that still
    // performs the destructive act is not a guard: it destroys unread messages
    // and tells you afterwards. Two agents on this fleet hit it in one day.
    //
    // Clearing an EMPTY file is harmless, so that still succeeds as a no-op.
    // Clearing a file with unread lines in it is refused, and the refusal names
    // the one command that makes the ack safe.
    const pending = countNotificationLines(current);
    if (pending === 0) {
      return { mode: 'noop', consumedLines: 0, preservedLines: 0 };
    }
    return {
      mode: 'refused',
      consumedLines: 0,
      preservedLines: pending,
      error:
        `REFUSING to ack: ${pending} unread line(s) in ${notifyFile} and no room_list_new ` +
        'was recorded this session, so there is nothing to ack AGAINST. Blanking the file ' +
        'here would discard messages nobody has read — that is exactly how an owner ' +
        'instruction sat unseen for five hours on 2026-07-08.\n' +
        'Call room_list_new first, act on what it returns, then room_ack: it removes only ' +
        'those lines and preserves anything the poller appended meanwhile.',
    };
  }
  const { remainder, consumedLines, mode } = removeConsumedNotifications(current, consumedRaw);
  if (remainder !== current) atomicWriteNotify(notifyFile, remainder);
  return { mode, consumedLines, preservedLines: countNotificationLines(remainder) };
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
      callbackBase: defaultCallbackBase(confirmCfg),
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
  // The local daemon enforces the same bearer gate when its auth_token is
  // set; our own config value is authoritative for it, with the fleet token
  // as fallback.
  const daemonAuthHeaders = () => gateAuthHeaders(confirmCfg.auth_token || resolveGateToken());
  let daemonAvailable = false;
  try {
    const probe = await fetch(`${daemonBase}/intents`, {
      method: 'GET',
      headers: daemonAuthHeaders(),
      signal: AbortSignal.timeout(500),
    });
    daemonAvailable = probe.ok;
  } catch { /* not running */ }

  let confirmServer = null;
  if (daemonAvailable) {
    process.stderr.write(
      `[iak-mcp] confirmations: forwarding to live daemon at ${daemonBase}\n`
    );
  } else if (confirmEnabled) {
    const wakeScript = confirmCfg.wake_script || confirmCfg.wakeScript ||
      config?.poller?.wake_script || config?.poller?.nudge_command || config?.wake?.script_path ||
      join(__pkgDir, 'scripts', 'claude-gui-wake.sh');
    confirmServer = startConfirmationsServer({
      port: daemonPort,
      host: confirmCfg.host || '127.0.0.1',
      authToken: confirmCfg.auth_token || '',
      receiptsPath: config?.receipts?.path,
      announce,
      wakeScript,
      sessions: confirmCfg.sessions,
    });
    process.stderr.write(
      `[iak-mcp] confirmations: enabled on ${daemonBase} (in-process) — channels: ${Object.keys(announcerMap).join(', ')}\n`
    );
    // Route room "/approve <id>" / "/deny <id>" taps (the CodeWatch buttons) to
    // the in-process intent registry. Without this the buttons render but a tap
    // never settles the intent. Only start when this process holds the intents
    // (groupmind channel configured + serving in-process, not forwarding).
    if (announcerMap.groupmind) {
      startChatReplyPoller({
        apiKey: config.poller.api_key,
        room: confirmCfg.room,
        owners: confirmCfg.owners || ['petrus', 'petrus-boox'],
      });
      process.stderr.write(
        `[iak-mcp] chat-reply poller: watching room "${confirmCfg.room}" every 5s\n`
      );
      // Mirror intent/action transitions to the central action_status store
      // (antfarm PR #43) so CodeWatch buttons render durable state off-LAN.
      const { apiKey: pushKey, baseUrl: pushBase } = configuredRoomApi(config);
      if (configureActionStatusPush({
        apiKey: pushKey,
        baseUrl: pushBase,
        log: (m) => process.stderr.write(m + '\n'),
      })) {
        process.stderr.write('[iak-mcp] action-status push: enabled (durable off-LAN button state)\n');
      }
    }
  } else {
    process.stderr.write(
      '[iak-mcp] confirmations: disabled — set mcp.confirmations.room (+ poller.api_key) and/or mcp.confirmations.codewatch_gate_url\n'
    );
  }

  // Per-session memory of what the last room_list_new returned, keyed by
  // notification file path. room_ack uses it to clear only consumed lines.
  const lastRoomListNew = new Map();

  const tools = [
    {
      name: 'room_list_new',
      description: 'List new messages from the notification file.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'room_ack',
      description:
        'Acknowledge the messages returned by the last room_list_new. Only those lines are ' +
        'removed from the notification file; anything appended since that read is preserved.',
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
        'agent-to-agent coordination (e.g. claudemm has a question that needs claudemb). ' +
        'Token-protected daemons are handled automatically: the request carries ' +
        'Authorization: Bearer <token> from ~/.config/iak-gate.token (or IAK_GATE_TOKEN_FILE / ' +
        'IAK_GATE_TOKEN env) when one exists; without a token the request stays unauthenticated.',
      inputSchema: {
        type: 'object',
        properties: {
          gateUrl: { type: 'string', description: 'Base URL of the remote IAK daemon, e.g. http://mini:8788 - a stable tailnet/VPN/DNS name, not a LAN IP (a LAN IP only resolves on the network it was configured on and fails silently elsewhere).' },
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
        name: 'request_choice',
        description:
          'Ask the user to PICK ONE of several options. Same lifecycle as request_confirmation ' +
          '(posts to the configured channels and BLOCKS until the user answers or the timeout ' +
          'expires) but renders one button per option instead of Approve/Deny, and returns ' +
          '{decision: "<the chosen option>"}. The option list is an allow-list: the user cannot ' +
          'answer with anything else. Use it for a model picker, a branch picker, any "which one?" ' +
          'question. Needs at least two distinct options; for a yes/no use request_confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The question. Keep it short — it fits in a watch notification.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'The choices, one button each. At least two, each on one line. The label IS the answer, so label them with the value you want back.',
            },
            session: { type: 'string', description: 'tmux session that triggered the request, for context. Optional.' },
            channels: {
              type: 'array',
              items: { type: 'string', enum: ['groupmind', 'codewatch'] },
              description: 'Which channels to post to. Default: all configured channels.',
            },
            timeoutSec: { type: 'number', description: 'How long to wait before returning timeout. Default 600 (10 min).', default: 600 },
            fromHandle: { type: 'string', description: 'Originating agent handle for attribution, e.g. @CodexMB.' },
          },
          required: ['prompt', 'options'],
        },
      },
      {
        name: 'request_model_choice',
        description:
          'Probe the model registry (config/models.json, or the path given) for entries that are ' +
          'actually UP right now, and ask the user to pick one — the daemon-side equivalent of ' +
          'running `bin/model-picker.mjs` by hand. Raises a CHOICE intent exactly like ' +
          'request_choice (one button per usable entry, BLOCKS until decided or the timeout ' +
          'expires). This tool ITSELF ONLY RETURNS THE DECISION ({decision: "<entry id>"}) — it ' +
          'never writes ~/.iak/model-selection.json or confirms an apply succeeded. WHETHER THE ' +
          'DECISION IS ACTUALLY APPLIED DEPENDS ENTIRELY ON WHETHER A DAEMON IS RUNNING: with a ' +
          'live iak-mcp-daemon, the intent is tagged so the daemon re-probes the chosen entry and ' +
          'applies it (writes the selection file, or refuses if the entry is no longer usable) the ' +
          'instant it is decided — check the daemon log or poll list_intents / the selection file to ' +
          'confirm that happened. WITHOUT a running daemon (the in-process fallback), the decision ' +
          'is returned but is NOT APPLIED — no selection file is written, by this tool or anything ' +
          'else; the caller is responsible for acting on the returned decision itself. ' +
          'Returns {outcome:"none-up", excluded} without raising anything if nothing in the ' +
          'registry is usable.',
        inputSchema: {
          type: 'object',
          properties: {
            registryPath: { type: 'string', description: 'Path to the model registry JSON. Default: config/models.json next to this checkout.' },
            callerHost: { type: 'string', description: 'Host whose network the probe describes. Default: this machine, auto-resolved.' },
            allowLan: { type: 'boolean', description: 'Offer LAN-only registry entries too. Default false.' },
            session: { type: 'string', description: 'tmux session that triggered the request, for context. Optional.' },
            channels: {
              type: 'array',
              items: { type: 'string', enum: ['groupmind', 'codewatch'] },
              description: 'Which channels to post to. Default: all configured channels.',
            },
            timeoutSec: { type: 'number', description: 'How long to wait for a decision before returning timeout. Default 600 (10 min).', default: 600 },
            fromHandle: { type: 'string', description: 'Originating agent handle for attribution, e.g. @CodexMB.' },
          },
        },
      },
      {
        name: 'list_intents',
        description: 'List every confirmation intent the server knows about (pending, decided, recent). Each row carries `announceSummary` (the human-readable line), `announceState` and a per-channel `announcements` map, so a pending intent nobody was successfully asked about is distinguishable from one waiting on a human. `posted` means the channel ACCEPTED the message and is not evidence anyone saw it; `failed` and `skipped` mean it is known not to have gone out; `unreported` and `attempting` mean the outcome is UNKNOWN - do not report those as delivered or as failed; `unknown` means the intent predates this record. A mixed result is worded "posted to 1 channel, unknown for 1", never "posted to 1 of 2".',
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
        name: 'room_react',
        description:
          'React to a room message with an emoji INSTEAD of posting a message that says the same thing. ' +
          'Agreement, acknowledgement and "me too" are reactions, never posts: a reaction costs the human ' +
          'reader no scrolling, a message costs a screen. Convention: ✅ agreed/done, 👀 taking it, ' +
          '⚠️ blocked or a problem, 📩 detail sent by DM. Still post when you have a question, an answer, ' +
          'or something broken or finished to report.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'id of the room message to react to (from room_recent).' },
            emoji: { type: 'string', description: 'The emoji, e.g. "✅".' },
            room: { type: 'string', description: 'Room slug. Defaults to mcp.confirmations.room or first poller room.' },
            remove: { type: 'boolean', description: 'Remove this reaction instead of adding it.', default: false },
          },
          required: ['message_id', 'emoji'],
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
          let raw = '';
          try {
            raw = readFileSync(notifyFile, 'utf8');
          } catch {
            raw = '';
          }
          // Remember exactly what this read returned so room_ack clears only
          // these bytes — lines the poller appends after this point survive.
          lastRoomListNew.set(notifyFile, raw);
          const content = raw.trim();
          if (!content) return ok('No new messages.');
          return ok(content);
        }
        case 'room_ack': {
          const notifyFile = config?.poller?.notification_file || '/tmp/iak-new-messages.txt';
          try {
            const consumedRaw = lastRoomListNew.has(notifyFile) ? lastRoomListNew.get(notifyFile) : null;
            const result = ackNotificationFile(notifyFile, consumedRaw);
            lastRoomListNew.delete(notifyFile);
            if (result.mode === 'refused') {
              return ok(result.error);
            }
            if (result.mode === 'noop' && result.consumedLines === 0 && result.preservedLines === 0) {
              return ok('Nothing to acknowledge — the notification file is already empty.');
            }
            if (result.preservedLines > 0) {
              return ok(
                `Acknowledged ${result.consumedLines} read message line(s); ` +
                  `${result.preservedLines} line(s) arrived after the last room_list_new and were preserved — ` +
                  'call room_list_new again to see them.'
              );
            }
            return ok(`Acknowledged ${result.consumedLines} read message line(s).`);
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
              headers: { 'Content-Type': 'application/json', ...gateAuthHeadersFor(args.gateUrl) },
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
          // #42: a PASSIVE session (another live session holds the machine's
          // room-responder lock) is refused here even if it ignores its
          // injected instructions. Read-only room tools stay available.
          const voice = assertRoomVoice({ config });
          if (!voice.allowed) return err(`room_post refused: ${voice.reason}`);
          const posted = await postRoomMessage({
            config,
            room: args.room,
            body: args.body,
            fromHandle: args.fromHandle || args.from_handle,
          });
          return ok(JSON.stringify(posted, null, 2));
        }
        case 'room_react': {
          if (!roomToolsEnabled) return err('room_react: room API is not configured.');
          // Deliberately NOT behind assertRoomVoice: a reaction is not the
          // machine speaking, it is an acknowledgement, and a passive session
          // being unable to react is what pushes it into posting a message.
          try {
            const reacted = await reactToRoomMessage({
              config,
              room: args.room,
              messageId: args.message_id || args.messageId,
              emoji: args.emoji,
              remove: args.remove === true,
            });
            return ok(JSON.stringify(reacted, null, 2));
          } catch (e) {
            return err(String(e.message || e));
          }
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
          const voice = assertRoomVoice({ config });
          if (!voice.allowed) return err(`alert_recipient refused: ${voice.reason}`);
          const handle = String(args.handle).startsWith('@') ? String(args.handle) : `@${args.handle}`;
          const posted = await postRoomMessage({
            config,
            room: args.room,
            body: `${handle} ${args.body}`,
            fromHandle: args.fromHandle || args.from_handle,
          });
          return ok(JSON.stringify(posted, null, 2));
        }
        case 'request_choice':
        case 'request_confirmation': {
          if (!confirmEnabled && !daemonAvailable) return err(`${name}: confirmations not configured. Set mcp.confirmations.room (+ poller.api_key) and/or codewatch_gate_url.`);
          if (!args.prompt) return err(`${name}: prompt is required`);
          // Validate HERE rather than letting the daemon or createIntent throw:
          // the caller is an agent composing a picker, and "needs at least two
          // distinct options" is only useful if it names which call was wrong.
          let options;
          if (name === 'request_choice') {
            if (!Array.isArray(args.options)) return err('request_choice: options must be an array of strings');
            options = [...new Set(args.options.map((o) => String(o).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean))];
            if (options.length < 2) return err('request_choice: needs at least two distinct options; use request_confirmation for yes/no');
          }
          const timeoutSec = Math.max(1, Math.min(86400, args.timeoutSec || 600));

          // Daemon mode: forward to the running iak-mcp-daemon so the intent
          // is in the SHARED registry that CodeWatch and the chat-reply
          // poller see. This is the production path when a daemon is up.
          if (daemonAvailable) {
            const createRes = await fetch(`${daemonBase}/intent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...daemonAuthHeaders() },
              body: JSON.stringify({
                prompt: args.prompt,
                options,
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
                const list = await (await fetch(`${daemonBase}/intents`, { headers: daemonAuthHeaders() })).json();
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
            options,
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
        case 'request_model_choice': {
          if (!confirmEnabled && !daemonAvailable) return err('request_model_choice: confirmations not configured. Set mcp.confirmations.room (+ poller.api_key) and/or codewatch_gate_url.');
          // resolveModelRegistryPath() is the SAME resolver
          // bin/iak-mcp-daemon.mjs uses to decide what applyChoice() re-probes
          // (mcp.confirmations.model_registry, one shared key) - reading a
          // different key here is what let a custom registry path make the
          // offer and the apply disagree.
          const registryPath = typeof args.registryPath === 'string' && args.registryPath
            ? args.registryPath
            : resolveModelRegistryPath(config, __pkgDir);
          const callerHost = typeof args.callerHost === 'string' && args.callerHost
            ? args.callerHost
            : await resolveCallerHost();
          let offer;
          try {
            ({ offer } = await probeAndOffer({ registryPath, callerHost, allowLan: Boolean(args.allowLan) }));
          } catch (e) {
            return err(`request_model_choice: ${e.message}`);
          }
          if (!offer.options.length) {
            return ok(JSON.stringify({ outcome: 'none-up', excluded: offer.excluded.map(describeExclusion) }, null, 2));
          }
          const timeoutSec = Math.max(1, Math.min(86400, args.timeoutSec || 600));
          // What was actually shown for each offered option, so a handler
          // applying long after (a different process, possibly minutes
          // later) can tell whether the box now names a different model -
          // see applyChoice()'s modelChanged.
          const offeredModels = Object.fromEntries(offer.offered.map((r) => [r.id, r.models[0]]));

          // Same daemon-forward / in-process split as request_choice, plus
          // kind: 'model' so decideIntent() fires the daemon's model-apply
          // hook (bin/iak-mcp-daemon.mjs) the instant this is decided,
          // regardless of which channel the tap arrives on.
          if (daemonAvailable) {
            const createRes = await fetch(`${daemonBase}/intent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...daemonAuthHeaders() },
              body: JSON.stringify({
                prompt: offer.prompt,
                options: offer.options,
                session: args.session,
                kind: 'model',
                offeredModels,
                channels: Array.isArray(args.channels) ? args.channels : undefined,
                from_handle: confirmationFromHandle(args, config),
              }),
            });
            const created = await createRes.json();
            if (!created.ok) return err(`daemon createIntent: ${created.error}`);
            const id = created.id;
            const deadline = Date.now() + timeoutSec * 1000;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                const list = await (await fetch(`${daemonBase}/intents`, { headers: daemonAuthHeaders() })).json();
                const found = list.find((i) => i.id === id);
                if (found && found.status === 'decided') {
                  return ok(JSON.stringify({ id, decision: found.decision }, null, 2));
                }
              } catch { /* retry */ }
            }
            return ok(JSON.stringify({ id, status: 'timeout', timeoutSec }, null, 2));
          }

          // In-process fallback (no daemon). Nothing applies the decision in
          // this mode - there is no long-running process for a kind handler
          // to be registered on - so the caller (or approve_intent/
          // deny_intent) is responsible for acting on the returned decision.
          const channels = Array.isArray(args.channels) && args.channels.length > 0
            ? args.channels.filter((c) => announcerMap[c])
            : Object.keys(announcerMap);
          const id = await createIntent({
            prompt: offer.prompt,
            options: offer.options,
            kind: 'model',
            offeredModels,
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
if (isMainModule(import.meta.url)) {
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
