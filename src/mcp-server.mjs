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

  const tools = [
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
        case 'read_session': {
          if (!args.session) return err('read_session: session is required');
          try {
            const out = captureTmuxPane(args.session, args.lines);
            return ok(out);
          } catch (e) {
            return err(e.message);
          }
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
