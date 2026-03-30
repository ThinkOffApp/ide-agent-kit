#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { runSanityCheck } from '../src/common/check.mjs';

// --- team-relay (generic room/comms) ---
import { tailReceipts } from '../src/team-relay/receipt.mjs';
import { startWebhookServer } from '../src/team-relay/webhook-server.mjs';
import { emitJson } from '../src/team-relay/emit.mjs';
import { startRoomPoller, checkRoomMessages } from '../src/team-relay/room-poller.mjs';
import { memoryList, memoryGet, memorySet, memoryAppend, memoryDelete, memorySearch } from '../src/team-relay/memory.mjs';
import { moltbookPost, moltbookFeed } from '../src/team-relay/moltbook.mjs';
import { startRoomAutomation } from '../src/team-relay/room-automation.mjs';
import { pollDiscord, startDiscordPoller } from '../src/team-relay/discord-poller.mjs';
import { UnifiedPoller } from '../src/team-relay/unified-poller.mjs';
import { antfarmAdapter } from '../src/team-relay/adapters/antfarm.mjs';
import { discordAdapter } from '../src/team-relay/adapters/discord.mjs';
import { xforAdapter } from '../src/team-relay/adapters/xfor.mjs';
import { commentsAdapter } from '../src/team-relay/adapters/comments.mjs';
import { isEnabled as acpIsEnabled, createSession as acpCreate, sendToSession as acpSend, closeSession as acpClose, getSession as acpGet, listSessions as acpList } from '../src/team-relay/acp-sessions.mjs';
import { initTaskQueue, addTask, startTask, completeTask, failTask, cancelTask, queueTask, draftTask, installTask, vote, reviewTask, setStatus, listTasks, nextTask, missionControlData } from '../src/team-relay/task-queue.mjs';
import { startMissionControl } from '../src/team-relay/mission-control.mjs';
// --- ide-specific ---
import { tmuxRun } from '../src/ide/tmux-runner.mjs';
import { watchQueue } from '../src/ide/watch.mjs';
import { pollComments, startCommentPoller } from '../src/ide/comment-poller.mjs';
// --- openclaw (shared) ---
import { triggerAgent, healthCheck, healthDeep, agentsList, configGet, configPatch, gatewayRestart } from '../src/openclaw-gateway.mjs';
import { sessionsSend, sessionsSpawn, sessionsList, sessionsHistory, sessionsStatus } from '../src/openclaw-sessions.mjs';
import { execApprovalRequest, execApprovalWait, execApprovalResolve, execApprovalList } from '../src/openclaw-exec.mjs';
import { listHooks, createForwarderHook, deleteHook } from '../src/openclaw-hooks.mjs';
import { cronList, cronAdd, cronRemove, cronRun, cronStatus } from '../src/openclaw-cron.mjs';
import { keepaliveStart, keepaliveStop, keepaliveStatus } from '../src/session-keepalive.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function usage() {
  console.log(`IDE Agent Kit v${pkg.version}

Usage:
  ide-agent-kit check [--config <path>] [--json]
    Run environment and configuration sanity check.
  ide-agent-kit check [--config <path>] [--json]
    Run environment and configuration sanity check.
  ide-agent-kit serve [--config <path>]
    Start webhook relay server for inbound GitHub events.

  ide-agent-kit tmux run --cmd <command> [--session <name>] [--cwd <path>] [--timeout-sec <sec>] [--config <path>]
    Run an allowlisted command in a tmux session. Captures output + exit code, appends receipt.

  ide-agent-kit emit --to <url> --json <file>
    POST a receipt or event JSON to a webhook target.

  ide-agent-kit receipt tail [--n <count>] [--config <path>]
    Print the last N receipts as JSON.

  ide-agent-kit watch [--config <path>]
    Watch the event queue and nudge IDE tmux session on new events.

  ide-agent-kit rooms check [--config <path>]
    Read and display new room messages from the notification file, then clear it.
    This is the primary way to retrieve messages from the poller.

  ide-agent-kit rooms watch [--config <path>]
    Long-running room poller. Writes new messages to a notification file and
    optional tmux nudge. Uses rooms/apiKey/handle from config.poller section.

  ide-agent-kit poll --rooms <room1,room2> --api-key <key> --handle <@handle> [--interval <sec>] [--config <path>]
    (Legacy) Poll Ant Farm rooms with explicit CLI args. Prefer "rooms watch".

  ide-agent-kit memory <list|get|set|append|delete|search> [options]
    Manage agent memory (local or OpenClaw backend).
    --backend local|openclaw  --agent <name>  --key <topic>  --value <text>
    search: --query <text> [--max-results <n>] [--min-score <n>]

  ide-agent-kit gateway <health|health-deep|agents|config-get|config-patch|trigger|wake> [options]
    OpenClaw gateway operations.
    trigger: --agent <id> --message <text> [--model <model>] [--timeout <sec>]
    wake:    --text <text> [--mode now|next-heartbeat]
    config-patch: --patch <json>

  ide-agent-kit sessions <list|send|spawn|history|status> [options]
    Agent-to-agent communication via OpenClaw gateway.
    send:    --agent <id> --message <text> [--timeout <sec>]
    spawn:   --task <text> [--agent <id>] [--model <model>] [--mode run|session]
    list:    [--kinds main,group,cron] [--limit <n>] [--active-minutes <n>]
    history: --session-key <key> [--limit <n>]
    status:  --session-key <key>

  ide-agent-kit exec <list|request|resolve> [options]
    Execution approval governance (integrates with thinkoff-judge-core).
    list:    [--agent <id>] [--status pending|resolved|all]
    request: --command <cmd> [--agent <id>] [--cwd <path>]
    resolve: --request-id <id> --decision <allow-once|allow-always|deny> [--reason <text>]

  ide-agent-kit hooks <list|create|delete> [options]
    OpenClaw event hook management.
    list:   [--agent <name>]
    create: --name <hook-name> --events <evt1,evt2> --webhook-url <url> [--agent <name>]
    delete: --name <hook-name> [--agent <name>]

  ide-agent-kit cron <list|add|remove|run|status> [options]
    OpenClaw scheduled task management.
    list:   List all cron jobs
    add:    --name <name> --task <text> --schedule <cron-expr|interval-ms> [--agent <id>] [--mode main|isolated]
    remove: --job-id <id>
    run:    --job-id <id>  (trigger immediate execution)
    status: Show cron system status

  ide-agent-kit keepalive <start|stop|status> [options]
    Prevent macOS display sleep and terminal freezes for VNC/remote sessions.
    start:  Start caffeinate -d -i -s [--heartbeat-sec <n>] [--pid-file <path>]
    stop:   Stop managed caffeinate + heartbeat processes
    status: Show keepalive state, system caffeinate procs, and pmset settings

  ide-agent-kit moltbook <post|feed> [options]
    Moltbook social platform integration.
    post:  --content <text> [--submolt <name>] [--title <text>] [--api-key <key>]
    feed:  [--limit <n>] [--submolt <name>]

  ide-agent-kit automate --rooms <room1,room2> --api-key <key> --handle <@handle> [--interval <sec>] [--config <path>]
    Run rule-based automation on room messages.
    Rules are defined in config under automation.rules.

  ide-agent-kit comments <poll|watch> [options]
    Poll Moltbook posts and GitHub issues/discussions for new comments.
    poll:   One-shot poll, print new comments as JSON.
    watch:  Long-running poller with tmux nudge on new comments.
    Config: comments.moltbook.posts, comments.github.repos

  ide-agent-kit discord <poll|watch> [options]
    Poll Discord channels via OpenClaw CLI for new messages.
    poll:   One-shot poll, print new messages.
    watch:  Long-running poller with tmux nudge on new messages.
    Config: discord.channels, discord.interval_sec, discord.self_id

  ide-agent-kit xfor <poll|watch> [options]
    Poll xfor.bot for new posts and notifications.
    poll:   One-shot poll, print new events.
    watch:  Long-running poller.
    Config: xfor.api_key, xfor.handle, xfor.interval_sec

  ide-agent-kit platform <watch|status> [--adapters antfarm,discord,xfor,comments] [--config <path>]
    Unified platform poller — runs multiple adapters in one process.
    watch:  Start all adapters (or selected via --adapters).
    status: Show which adapters are configured.

  ide-agent-kit acp <spawn|list|status|send|close> [options]
    Agent Client Protocol (ACP) session management. Locked internal mode.
    spawn:  --agent <handle> --task <text> [--harness <id>] [--mode one-shot|persistent]
    list:   [--status active|closed|expired]
    status: --session <id>
    send:   --session <id> --body <text> [--from <handle>]
    close:  --session <id> [--reason <text>]
    Config: acp.enabled, acp.token, acp.allowed_agents, acp.allowed_harnesses

  ide-agent-kit init [--ide <claude-code|codex|cursor|vscode|gemini>] [--profile <balanced|low-friction>]
    Generate starter config for your IDE.
`);
}

function parseKV(args, after) {
  const opts = {};
  let i = args.indexOf(after) + 1;
  if (i === 0) i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      opts[key] = val;
    }
    i++;
  }
  return opts;
}

function gwOpts(opts) {
  return {
    home: opts.home, ssh: opts.ssh, bin: opts.bin
  };
}

async function main() {
  if (command === 'check') {
    const opts = parseKV(args, 'check');
    const config = loadConfig(opts.config);
    const { runSanityCheck } = await import('../src/common/check.mjs');
    const results = await runSanityCheck(config);

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('Running IDE Agent Kit sanity check...\n');
      results.forEach(r => {
        const icon = r.status === 'ok' ? 'âœ…' : (r.status === 'warn' ? 'âš ' : 'â Œ');
        console.log(`${icon} ${r.name}: ${r.detail}`);
      });
      console.log('\nCheck complete.');
    }

    const hasFailures = results.some(r => r.status === 'fail');
    if (hasFailures) {
      process.exit(1);
    }
    return;
  }
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  if (command === 'serve') {
    const opts = parseKV(args, 'serve');
    const config = loadConfig(opts.config);
    startWebhookServer(config, (event) => {
      console.log(`Event queued: ${event.kind} (${event.trace_id})`);
    });
    return;
  }

  if (command === 'tmux' && subcommand === 'run') {
    const opts = parseKV(args, 'run');
    if (!opts.cmd) {
      console.error('Error: --cmd is required');
      process.exit(1);
    }
    const config = loadConfig(opts.config);
    const receipt = await tmuxRun({
      session: opts.session,
      cmd: opts.cmd,
      cwd: opts.cwd,
      timeoutSec: opts['timeout-sec'] ? parseInt(opts['timeout-sec']) : undefined,
      config
    });
    console.log(JSON.stringify(receipt, null, 2));
    process.exit(receipt.status === 'ok' ? 0 : 1);
  }

  if (command === 'emit') {
    const opts = parseKV(args, 'emit');
    if (!opts.to || !opts.json) {
      console.error('Error: --to <url> and --json <file> are required');
      process.exit(1);
    }
    try {
      const result = await emitJson(opts.to, opts.json);
      console.log(`Emitted to ${opts.to}: ${result.status}`);
      if (result.status >= 400) {
        console.error(result.body);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Emit failed: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'receipt' && subcommand === 'tail') {
    const opts = parseKV(args, 'tail');
    const config = loadConfig(opts.config);
    const n = opts.n ? parseInt(opts.n) : 5;
    const receipts = tailReceipts(config.receipts.path, n);
    if (receipts.length === 0) {
      console.log('No receipts found.');
    } else {
      receipts.forEach(r => console.log(JSON.stringify(r)));
    }
    return;
  }

  if (command === 'watch') {
    const opts = parseKV(args, 'watch');
    const config = loadConfig(opts.config);
    watchQueue(config, (event) => {
      const src = event.source || '?';
      const actor = event.actor?.login || '?';
      const room = event.room || '';
      console.log(`  → ${src} event from ${actor}${room ? ' in ' + room : ''}`);
    });
    process.on('SIGINT', () => { console.log('\nStopping watcher.'); process.exit(0); });
    return;
  }

  // ── Rooms ──────────────────────────────────────────────
  if (command === 'rooms') {
    const opts = parseKV(args, subcommand || 'rooms');
    const config = loadConfig(opts.config);

    if (subcommand === 'check') {
      const messages = checkRoomMessages(config);
      if (messages.length === 0) {
        console.log('No new room messages.');
      } else {
        console.log(`${messages.length} new message(s):\n`);
        for (const line of messages) {
          console.log(line);
        }
      }
      return;
    }

    if (subcommand === 'watch') {
      const rawRooms = config?.poller?.rooms;
      const pollerRooms = Array.isArray(rawRooms) ? rawRooms : (typeof rawRooms === 'string' ? rawRooms.split(',').map(s=>s.trim()) : null);
      const pollerApiKey = config?.poller?.api_key || config?.poller?.apiKey || config?.intent?.apiKey || process.env.ANTIGRAVITY_API_KEY;
      const pollerHandle = config?.poller?.handle;
      if (!pollerRooms || !pollerApiKey || !pollerHandle) {
        console.error('Error: poller.rooms, poller.api_key, and poller.handle must be set in config');
        process.exit(1);
      }
      await startRoomPoller({
        rooms: pollerRooms,
        apiKey: pollerApiKey,
        handle: pollerHandle,
        interval: opts.interval ? parseInt(opts.interval) : undefined,
        config
      });
      return;
    }

    console.error('Usage: ide-agent-kit rooms <check|watch> [--config <path>]');
    process.exit(1);
  }

  // ── Legacy Poll (prefer "rooms watch") ────────────────
  if (command === 'poll') {
    const opts = parseKV(args, 'poll');
    if (!opts.rooms || !opts['api-key'] || !opts.handle) {
      console.error('Error: --rooms, --api-key, and --handle are required');
      console.error('Example: ide-agent-kit poll --rooms thinkoff-development,feature-admin-planning --api-key <key> --handle @claudemm');
      process.exit(1);
    }
    const config = loadConfig(opts.config);
    await startRoomPoller({
      rooms: opts.rooms.split(','),
      apiKey: opts['api-key'],
      handle: opts.handle,
      interval: opts.interval ? parseInt(opts.interval) : undefined,
      config
    });
    return;
  }

  // ── Memory ──────────────────────────────────────────────
  if (command === 'memory') {
    const opts = parseKV(args, subcommand || 'memory');
    const config = loadConfig(opts.config);
    const memOpts = { backend: opts.backend, agent: opts.agent };

    if (subcommand === 'list') {
      const entries = memoryList(config, memOpts);
      if (entries.length === 0) {
        console.log('No memory entries. Use "ide-agent-kit memory set --key <topic> --value <text>" to create one.');
      } else {
        entries.forEach(e => console.log(`  ${e.key} (${e.size} bytes)`));
      }
      return;
    }
    if (subcommand === 'get') {
      if (!opts.key) { console.error('Error: --key is required'); process.exit(1); }
      const result = memoryGet(config, opts.key, memOpts);
      if (result.error) { console.error(`Not found: ${opts.key}`); process.exit(1); }
      console.log(result.content);
      return;
    }
    if (subcommand === 'set') {
      if (!opts.key || !opts.value) { console.error('Error: --key and --value are required'); process.exit(1); }
      const result = memorySet(config, opts.key, opts.value, memOpts);
      console.log(`Set ${result.key} (${result.size} bytes) → ${result.path}`);
      return;
    }
    if (subcommand === 'append') {
      if (!opts.key || !opts.value) { console.error('Error: --key and --value are required'); process.exit(1); }
      const result = memoryAppend(config, opts.key, opts.value, memOpts);
      console.log(`Appended to ${result.key} (${result.size} bytes) → ${result.path}`);
      return;
    }
    if (subcommand === 'delete') {
      if (!opts.key) { console.error('Error: --key is required'); process.exit(1); }
      const result = memoryDelete(config, opts.key, memOpts);
      console.log(`${result.action}: ${result.key}`);
      return;
    }
    if (subcommand === 'search') {
      if (!opts.query) { console.error('Error: --query is required'); process.exit(1); }
      const result = memorySearch(config, opts.query, {
        ...memOpts,
        ...gwOpts(opts),
        maxResults: opts['max-results'] ? parseInt(opts['max-results']) : undefined,
        minScore: opts['min-score'] ? parseFloat(opts['min-score']) : undefined
      });
      if (!result.ok) { console.error(`Search failed: ${result.error}`); process.exit(1); }
      if (result.results.length === 0) {
        console.log('No results found.');
      } else {
        result.results.forEach(r => {
          console.log(`  [${(r.score || 0).toFixed(3)}] ${r.path || '?'}:${r.line || '?'}`);
          if (r.snippet) console.log(`    ${r.snippet.slice(0, 120)}`);
        });
      }
      return;
    }
    console.error('Usage: ide-agent-kit memory <list|get|set|append|delete|search> [options]');
    process.exit(1);
  }

  // ── Gateway ─────────────────────────────────────────────
  if (command === 'gateway') {
    const opts = parseKV(args, subcommand || 'gateway');
    const config = loadConfig(opts.config);
    const gw = gwOpts(opts);

    if (subcommand === 'health') {
      const result = await healthCheck(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'health-deep') {
      const result = await healthDeep(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'agents') {
      const result = await agentsList(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'config-get') {
      const result = await configGet(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'config-patch') {
      if (!opts.patch) { console.error('Error: --patch <json> is required'); process.exit(1); }
      const patch = JSON.parse(opts.patch);
      const result = await configPatch(config, patch, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'trigger') {
      if (!opts.agent || !opts.message) { console.error('Error: --agent and --message are required'); process.exit(1); }
      const result = await triggerAgent(config, {
        agentId: opts.agent,
        message: opts.message,
        model: opts.model,
        timeoutSeconds: opts.timeout ? parseInt(opts.timeout) : undefined
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'restart') {
      const result = await gatewayRestart(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    console.error('Usage: ide-agent-kit gateway <health|health-deep|agents|config-get|config-patch|trigger|restart>');
    process.exit(1);
  }

  // ── Sessions ────────────────────────────────────────────
  if (command === 'sessions') {
    const opts = parseKV(args, subcommand || 'sessions');
    const config = loadConfig(opts.config);
    const gw = gwOpts(opts);

    if (subcommand === 'list') {
      const result = await sessionsList(config, {
        kinds: opts.kinds ? opts.kinds.split(',') : undefined,
        limit: opts.limit ? parseInt(opts.limit) : undefined,
        activeMinutes: opts['active-minutes'] ? parseInt(opts['active-minutes']) : undefined,
        messageLimit: opts['message-limit'] !== undefined ? parseInt(opts['message-limit']) : undefined
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'send') {
      if (!opts.agent || !opts.message) { console.error('Error: --agent and --message are required'); process.exit(1); }
      const result = await sessionsSend(config, {
        agentId: opts.agent,
        message: opts.message,
        timeoutSeconds: opts.timeout ? parseInt(opts.timeout) : undefined
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'spawn') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const result = await sessionsSpawn(config, {
        task: opts.task,
        agentId: opts.agent,
        model: opts.model,
        mode: opts.mode,
        runTimeoutSeconds: opts.timeout ? parseInt(opts.timeout) : undefined
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'history') {
      if (!opts['session-key']) { console.error('Error: --session-key is required'); process.exit(1); }
      const result = await sessionsHistory(config, {
        sessionKey: opts['session-key'],
        limit: opts.limit ? parseInt(opts.limit) : undefined
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'status') {
      if (!opts['session-key']) { console.error('Error: --session-key is required'); process.exit(1); }
      const result = await sessionsStatus(config, { sessionKey: opts['session-key'] }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    console.error('Usage: ide-agent-kit sessions <list|send|spawn|history|status>');
    process.exit(1);
  }

  // ── Exec Approvals ──────────────────────────────────────
  if (command === 'exec') {
    const opts = parseKV(args, subcommand || 'exec');
    const config = loadConfig(opts.config);
    const gw = gwOpts(opts);

    if (subcommand === 'list') {
      const result = await execApprovalList(config, {
        agentId: opts.agent,
        status: opts.status
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'request') {
      if (!opts.command) { console.error('Error: --command is required'); process.exit(1); }
      const result = await execApprovalRequest(config, {
        command: opts.command,
        agentId: opts.agent,
        cwd: opts.cwd
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'resolve') {
      if (!opts['request-id'] || !opts.decision) { console.error('Error: --request-id and --decision are required'); process.exit(1); }
      const result = await execApprovalResolve(config, {
        requestId: opts['request-id'],
        decision: opts.decision,
        reason: opts.reason
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    console.error('Usage: ide-agent-kit exec <list|request|resolve>');
    process.exit(1);
  }

  // ── Hooks ───────────────────────────────────────────────
  if (command === 'hooks') {
    const opts = parseKV(args, subcommand || 'hooks');
    const config = loadConfig(opts.config);

    if (subcommand === 'list') {
      const hooks = listHooks(config, { agent: opts.agent });
      if (hooks.length === 0) {
        console.log('No hooks installed.');
      } else {
        hooks.forEach(h => {
          console.log(`  ${h.name} (${h.scope}) events: ${(h.events || []).join(', ') || '?'}`);
        });
      }
      return;
    }
    if (subcommand === 'create') {
      if (!opts.name || !opts.events || !opts['webhook-url']) {
        console.error('Error: --name, --events, and --webhook-url are required');
        process.exit(1);
      }
      const result = createForwarderHook(config, {
        name: opts.name,
        events: opts.events.split(','),
        webhookUrl: opts['webhook-url'],
        agent: opts.agent
      });
      console.log(`Created hook: ${result.name} → ${result.path}`);
      console.log(`  Events: ${result.events.join(', ')}`);
      console.log(`  Forwards to: ${result.webhookUrl}`);
      return;
    }
    if (subcommand === 'delete') {
      if (!opts.name) { console.error('Error: --name is required'); process.exit(1); }
      const result = deleteHook(config, { name: opts.name, agent: opts.agent });
      console.log(`${result.action}: ${result.name}`);
      return;
    }
    console.error('Usage: ide-agent-kit hooks <list|create|delete>');
    process.exit(1);
  }

  // ── Cron ────────────────────────────────────────────────
  if (command === 'cron') {
    const opts = parseKV(args, subcommand || 'cron');
    const config = loadConfig(opts.config);
    const gw = gwOpts(opts);

    if (subcommand === 'list') {
      const result = await cronList(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'add') {
      if (!opts.name || !opts.task || !opts.schedule) {
        console.error('Error: --name, --task, and --schedule are required');
        process.exit(1);
      }
      // Parse schedule: could be cron expr or interval ms
      let schedule;
      if (/^\d+$/.test(opts.schedule)) {
        schedule = { every: parseInt(opts.schedule) };
      } else if (opts.schedule.includes(' ')) {
        schedule = { cron: opts.schedule };
      } else {
        schedule = { at: opts.schedule };
      }
      const result = await cronAdd(config, {
        name: opts.name,
        task: opts.task,
        schedule,
        agentId: opts.agent,
        mode: opts.mode
      }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'remove') {
      if (!opts['job-id']) { console.error('Error: --job-id is required'); process.exit(1); }
      const result = await cronRemove(config, { jobId: opts['job-id'] }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'run') {
      if (!opts['job-id']) { console.error('Error: --job-id is required'); process.exit(1); }
      const result = await cronRun(config, { jobId: opts['job-id'] }, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    if (subcommand === 'status') {
      const result = await cronStatus(config, gw);
      console.log(JSON.stringify(result.data || result, null, 2));
      return;
    }
    console.error('Usage: ide-agent-kit cron <list|add|remove|run|status>');
    process.exit(1);
  }

  // ── Keepalive ──────────────────────────────────────────
  if (command === 'keepalive') {
    const opts = parseKV(args, subcommand || 'keepalive');
    const config = loadConfig(opts.config);
    const kaOpts = { pidFile: opts['pid-file'], heartbeatSec: opts['heartbeat-sec'] ? parseInt(opts['heartbeat-sec']) : undefined };

    if (subcommand === 'start') {
      const result = keepaliveStart(config, kaOpts);
      if (!result.ok) { console.error(`Failed: ${result.error}`); process.exit(1); }
      if (result.action === 'already-running') {
        console.log(`Keepalive already running (caffeinate PID ${result.caffeinate?.pid})`);
      } else {
        console.log(`Keepalive started:`);
        console.log(`  caffeinate PID: ${result.caffeinate?.pid}`);
        if (result.heartbeat) console.log(`  heartbeat PID: ${result.heartbeat.pid} (every ${result.heartbeat.intervalSec}s)`);
      }
      return;
    }
    if (subcommand === 'stop') {
      const result = keepaliveStop(config, kaOpts);
      if (result.action === 'not-running') {
        console.log('Keepalive not running.');
      } else {
        console.log(`Stopped: ${result.killed.join(', ')}`);
      }
      return;
    }
    if (subcommand === 'status') {
      const result = keepaliveStatus(config, kaOpts);
      console.log('Keepalive status:');
      if (result.caffeinate) {
        const src = result.caffeinate.external ? ' (external)' : ' (managed)';
        console.log(`  caffeinate: PID ${result.caffeinate.pid} alive=${result.caffeinate.alive}${src}`);
      } else {
        console.log('  caffeinate: not running');
      }
      if (result.heartbeat) {
        console.log(`  heartbeat: PID ${result.heartbeat.pid} alive=${result.heartbeat.alive} interval=${result.heartbeat.intervalSec}s`);
      }
      if (result.pmset.displaysleep != null) {
        console.log(`  displaysleep: ${result.pmset.displaysleep} min${result.pmset.displaysleep === 0 ? ' (never)' : ''}`);
      }
      if (result.pmset.sleep != null) {
        console.log(`  system sleep: ${result.pmset.sleep} min${result.pmset.sleep === 0 ? ' (never)' : ''}`);
      }
      if (result.systemCaffeinateProcesses.length > 1) {
        console.log(`  note: ${result.systemCaffeinateProcesses.length} caffeinate processes running`);
      }
      return;
    }
    console.error('Usage: ide-agent-kit keepalive <start|stop|status>');
    process.exit(1);
  }

  // ── Moltbook ──────────────────────────────────────────
  if (command === 'moltbook') {
    const opts = parseKV(args, subcommand || 'moltbook');
    const config = loadConfig(opts.config);

    if (subcommand === 'post') {
      if (!opts.content) { console.error('Error: --content is required'); process.exit(1); }
      const result = await moltbookPost(config, {
        content: opts.content,
        submolt: opts.submolt,
        title: opts.title,
        apiKey: opts['api-key']
      });
      if (!result.ok) {
        console.error(`Post failed: ${result.error}`);
        process.exit(1);
      }
      console.log(JSON.stringify(result.data, null, 2));
      if (result.url) console.log(`URL: ${result.url}`);
      return;
    }
    if (subcommand === 'feed') {
      const result = await moltbookFeed(config, {
        limit: opts.limit ? parseInt(opts.limit) : undefined,
        submolt: opts.submolt,
        apiKey: opts['api-key']
      });
      if (!result.ok) {
        console.error(`Feed failed: ${result.error}`);
        process.exit(1);
      }
      const posts = result.data?.posts || [];
      if (posts.length === 0) {
        console.log('No posts found.');
      } else {
        posts.forEach(p => {
          const author = p.author?.name || '?';
          const date = (p.created_at || '').slice(0, 19);
          console.log(`[${date}] @${author}: ${(p.content || '').slice(0, 120)}`);
          if (p.id) console.log(`  https://www.moltbook.com/post/${p.id}`);
          console.log();
        });
      }
      return;
    }
    console.error('Usage: ide-agent-kit moltbook <post|feed>');
    process.exit(1);
  }

  // ── Room Automation ─────────────────────────────────────
  if (command === 'automate') {
    const opts = parseKV(args, 'automate');
    if (!opts.rooms || !opts['api-key'] || !opts.handle) {
      console.error('Error: --rooms, --api-key, and --handle are required');
      console.error('Example: ide-agent-kit automate --rooms thinkoff-development --api-key <key> --handle @claudemm');
      process.exit(1);
    }
    const config = loadConfig(opts.config);
    await startRoomAutomation({
      rooms: opts.rooms.split(','),
      apiKey: opts['api-key'],
      handle: opts.handle,
      interval: opts.interval ? parseInt(opts.interval) : undefined,
      config
    });
    return;
  }

  // ── Comment Poller ─────────────────────────────────────
  if (command === 'comments') {
    const opts = parseKV(args, subcommand || 'comments');
    const config = loadConfig(opts.config);

    if (subcommand === 'poll') {
      const comments = pollComments(config);
      if (comments.length === 0) {
        console.log('No new comments.');
      } else {
        for (const c of comments) {
          const sourceLabel = c.source === 'moltbook'
            ? `moltbook/${c.post_id?.slice(0, 8)}`
            : `${c.repo}#${c.number}`;
          console.log(`@${c.author} on ${sourceLabel}: ${c.body.slice(0, 120)}`);
          if (c.url) console.log(`  ${c.url}`);
          console.log();
        }
      }
      return;
    }
    if (subcommand === 'watch') {
      await startCommentPoller({
        config,
        interval: opts.interval ? parseInt(opts.interval) : undefined
      });
      return;
    }
    console.error('Usage: ide-agent-kit comments <poll|watch>');
    process.exit(1);
  }

  // ── Discord Poller ─────────────────────────────────────
  if (command === 'discord') {
    const opts = parseKV(args, subcommand || 'discord');
    const config = loadConfig(opts.config);

    if (subcommand === 'poll') {
      const messages = pollDiscord(config);
      if (messages.length === 0) {
        console.log('No new Discord messages.');
      } else {
        for (const m of messages) {
          console.log(`@${m.actor.login} in ${m.channel}: ${m.payload.body.slice(0, 120)}`);
          console.log();
        }
      }
      return;
    }
    if (subcommand === 'watch') {
      await startDiscordPoller({
        config,
        interval: opts.interval ? parseInt(opts.interval) : undefined
      });
      return;
    }
    console.error('Usage: ide-agent-kit discord <poll|watch>');
    process.exit(1);
  }

  // ── xfor Poller ──────────────────────────────────────
  if (command === 'xfor') {
    const opts = parseKV(args, subcommand || 'xfor');
    const config = loadConfig(opts.config);

    if (subcommand === 'poll') {
      const poller = new UnifiedPoller(xforAdapter, config);
      const events = await poller.poll();
      if (events.length === 0) {
        console.log('No new xfor events.');
      } else {
        for (const e of events) {
          console.log(`@${e.actor.login} [${e.kind}]: ${e.payload.body.slice(0, 120)}`);
          if (e.payload.url) console.log(`  ${e.payload.url}`);
          console.log();
        }
      }
      return;
    }
    if (subcommand === 'watch') {
      const poller = new UnifiedPoller(xforAdapter, config);
      await poller.start();
      return;
    }
    console.error('Usage: ide-agent-kit xfor <poll|watch>');
    process.exit(1);
  }

  // ── Platform (Unified Poller) ──────────────────────
  if (command === 'platform') {
    const opts = parseKV(args, subcommand || 'platform');
    const config = loadConfig(opts.config);

    if (subcommand === 'watch') {
      const adapterNames = (opts.adapters || 'antfarm,discord,comments,xfor').split(',');
      const adapterMap = { antfarm: antfarmAdapter, discord: discordAdapter, xfor: xforAdapter, comments: commentsAdapter };
      const pollers = [];

      for (const name of adapterNames) {
        const adapter = adapterMap[name.trim()];
        if (!adapter) {
          console.error(`Unknown adapter: ${name}. Available: ${Object.keys(adapterMap).join(', ')}`);
          continue;
        }
        const poller = new UnifiedPoller(adapter, config);
        pollers.push(poller);
      }

      console.log(`Platform watcher started with adapters: ${adapterNames.join(', ')}`);

      const shutdown = () => {
        console.log('\nPlatform watcher stopped.');
        for (const p of pollers) p.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // start() handles seed, initial poll, and interval internally
      for (const p of pollers) {
        await p.start();
      }
      return;
    }

    if (subcommand === 'status') {
      const adapterMap = { antfarm: antfarmAdapter, discord: discordAdapter, xfor: xforAdapter, comments: commentsAdapter };
      console.log('Platform adapters:');
      for (const [name, adapter] of Object.entries(adapterMap)) {
        const cfgKey = name === 'antfarm' ? 'poller' : name;
        const hasCfg = !!(config?.[cfgKey]);
        console.log(`  ${name}: ${hasCfg ? 'configured' : 'not configured'}`);
      }
      return;
    }

    console.error('Usage: ide-agent-kit platform <watch|status> [--adapters antfarm,discord,xfor,comments]');
    process.exit(1);
  }

  // ── ACP (Agent Client Protocol) ───────────────────────
  if (command === 'acp') {
    const opts = parseKV(args, subcommand || 'acp');
    const config = loadConfig(opts.config);

    if (!acpIsEnabled(config)) {
      console.error('ACP is not enabled. Set acp.enabled=true and acp.token in your config.');
      process.exit(1);
    }

    if (subcommand === 'spawn') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const result = acpCreate(config, {
        agentId: opts.agent,
        task: opts.task,
        harnessId: opts.harness,
        mode: opts.mode || 'one-shot'
      });
      if (!result.ok) {
        console.error(`ACP spawn failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`ACP session created:`);
      console.log(`  ID: ${result.session.id}`);
      console.log(`  Agent: ${result.session.agent_id || 'none'}`);
      console.log(`  Task: ${result.session.task}`);
      console.log(`  Mode: ${result.session.mode}`);
      console.log(`  Status: ${result.session.status}`);
      return;
    }

    if (subcommand === 'list') {
      const result = acpList(config, { status: opts.status });
      if (result.sessions.length === 0) {
        console.log('No ACP sessions.');
      } else {
        console.log(`${result.count} session(s):\n`);
        for (const s of result.sessions) {
          const age = s.created_at ? s.created_at.slice(0, 19) : '?';
          console.log(`  ${s.id.slice(0, 8)}  ${s.status.padEnd(8)}  ${(s.agent_id || '-').padEnd(15)}  ${s.message_count} msgs  ${age}  ${(s.task || '').slice(0, 50)}`);
        }
      }
      return;
    }

    if (subcommand === 'status') {
      if (!opts.session) { console.error('Error: --session is required'); process.exit(1); }
      const result = acpGet(config, opts.session);
      if (!result.ok) {
        console.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
      console.log(JSON.stringify(result.session, null, 2));
      return;
    }

    if (subcommand === 'send') {
      if (!opts.session || !opts.body) { console.error('Error: --session and --body are required'); process.exit(1); }
      const result = acpSend(config, opts.session, {
        from: opts.from,
        body: opts.body,
        role: opts.role || 'user'
      });
      if (!result.ok) {
        console.error(`Send failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Message sent to session ${opts.session.slice(0, 8)}`);
      console.log(`  Message ID: ${result.message.id}`);
      return;
    }

    if (subcommand === 'close') {
      if (!opts.session) { console.error('Error: --session is required'); process.exit(1); }
      const result = acpClose(config, opts.session, { reason: opts.reason });
      if (!result.ok) {
        console.error(`Close failed: ${result.error}`);
        process.exit(1);
      }
      console.log(`Session ${opts.session.slice(0, 8)} closed.`);
      return;
    }

    console.error('Usage: ide-agent-kit acp <spawn|list|status|send|close>');
    process.exit(1);
  }

  // ── Tasks / Mission Control ─────────────────────────
  if (command === 'tasks') {
    const opts = parseKV(args, subcommand || 'tasks');
    const config = loadConfig(opts.config);
    const tasksFile = config.tasks?.file || '.iak-tasks.json';
    initTaskQueue(tasksFile);

    if (subcommand === 'add') {
      if (!opts.agent || !opts.title) { console.error('Error: --agent and --title are required'); process.exit(1); }
      const task = addTask(opts.agent, opts.title, { priority: parseInt(opts.priority || '0', 10), type: opts.type || 'feature' });
      console.log(`Task added: ${task.id}  [${task.type}]  ${task.agent}  ${task.title}  (${task.status})`);
      return;
    }

    if (subcommand === 'vote') {
      if (!opts.task || !opts.agent || !opts.decision) { console.error('Error: --task, --agent, and --decision (approve|reject) are required'); process.exit(1); }
      const task = vote(opts.task, opts.agent, opts.decision);
      if (!task) { console.error('Task not found or invalid decision'); process.exit(1); }
      const approves = Object.values(task.votes).filter(v => v === 'approve').length;
      const rejects = Object.values(task.votes).filter(v => v === 'reject').length;
      console.log(`Vote recorded: ${opts.agent} → ${opts.decision}  [${approves} approve, ${rejects} reject]  Status: ${task.status}`);
      return;
    }

    if (subcommand === 'queue') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = queueTask(opts.task);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} queued: ${task.title}`);
      return;
    }

    if (subcommand === 'start') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = startTask(opts.task);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} active: ${task.title}`);
      return;
    }

    if (subcommand === 'draft') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = draftTask(opts.task);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} drafted (review round ${task.review_round}): ${task.title}`);
      return;
    }

    if (subcommand === 'review') {
      if (!opts.task || !opts.reviewer || !opts.decision) { console.error('Error: --task, --reviewer, and --decision (approve|changes_requested) are required'); process.exit(1); }
      const task = reviewTask(opts.task, opts.reviewer, opts.decision);
      if (!task) { console.error('Task not found, self-review, or invalid decision'); process.exit(1); }
      const approvals = Object.values(task.reviews).filter(v => v === 'approve').length;
      console.log(`Review: ${opts.reviewer} → ${opts.decision}  [${approvals} approvals]  Status: ${task.status}`);
      return;
    }

    if (subcommand === 'install') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = installTask(opts.task);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} installed: ${task.title}`);
      return;
    }

    if (subcommand === 'done') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = completeTask(opts.task, opts.result || null);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} completed: ${task.title}`);
      return;
    }

    if (subcommand === 'fail') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = failTask(opts.task, opts.reason || null);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} failed: ${task.title}`);
      return;
    }

    if (subcommand === 'cancel') {
      if (!opts.task) { console.error('Error: --task is required'); process.exit(1); }
      const task = cancelTask(opts.task);
      if (!task) { console.error('Task not found'); process.exit(1); }
      console.log(`Task ${task.id} cancelled`);
      return;
    }

    if (subcommand === 'next') {
      if (!opts.agent) { console.error('Error: --agent is required'); process.exit(1); }
      const task = nextTask(opts.agent);
      if (!task) { console.log(`No queued tasks for ${opts.agent}`); return; }
      console.log(`Next task: ${task.id}  ${task.title}  (priority: ${task.priority})`);
      return;
    }

    if (subcommand === 'status' || !subcommand || subcommand === 'list') {
      const data = missionControlData();
      if (data.total === 0) { console.log('No tasks.'); return; }
      console.log(`Mission Control: ${data.active} active, ${data.queued} queued, ${data.proposed} proposed, ${data.total} total\n`);
      for (const a of data.agents) {
        const current = a.current ? `→ ${a.current.title}` : '(idle)';
        console.log(`  ${a.agent.padEnd(15)} ${current}  [${a.queued}q ${a.drafted}d ${a.installed}i ${a.done}✓ ${a.failed}✗]`);
      }
      return;
    }

    if (subcommand === 'serve') {
      const port = parseInt(opts.port || '4800', 10);
      startMissionControl(config, port);
      return;
    }

    console.error('Usage: ide-agent-kit tasks <add|vote|queue|start|draft|review|install|done|fail|cancel|next|status|serve>');
    process.exit(1);
  }

  if (command === 'init') {
    const opts = parseKV(args, 'init');
    const ide = opts.ide; // Auto-detect if undefined
    const profile = opts.profile || opts.friction || 'balanced';
    await initIdeConfig(ide, profile);
    return;
  }

  console.error(`Unknown command: ${command} ${subcommand || ''}`);
  usage();
  process.exit(1);
}

async function initIdeConfig(ide, profile = 'balanced') {
  const { writeFileSync, existsSync, mkdirSync, readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  let targetIde = ide;
  if (!targetIde) {
    console.log('No --ide specified. Attempting to auto-detect environment...');
    const cwd = process.cwd();
    
    if (existsSync(resolve(cwd, '.claude'))) {
      targetIde = 'claude-code';
    } else if (existsSync(resolve(cwd, 'codex.json'))) {
      targetIde = 'codex';
    } else if (existsSync(resolve(cwd, '.cursor')) || existsSync(resolve(cwd, '.cursorrules'))) {
      targetIde = 'cursor';
    } else if (existsSync(resolve(cwd, '.vscode'))) {
      targetIde = 'vscode';
    } else if (existsSync(resolve(cwd, 'gemini-config.json'))) {
      targetIde = 'gemini';
    }

    if (targetIde) {
      console.log(`Detected environment: ${targetIde}`);
    } else {
      console.log('Could not auto-detect environment. Defaulting to: claude-code');
      targetIde = 'claude-code';
    }
  }


  let hasClaudeMem = false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('claude-mem --version', { stdio: 'ignore' });
    hasClaudeMem = true;
  } catch {}

  const defaultAllow = ['npm test', 'npm run build', 'pytest', 'git status', 'git diff'];
  const lowFrictionAllow = [
    ...defaultAllow,
    'npm run lint',
    'npm run typecheck',
    'npm run test',
    'npm run test:',
    'node --test',
    'python3 -m pytest',
    'python -m pytest',
    'rg',
    'ls',
    'cat',
    'sed',
    'awk',
    'jq',
    'git log',
    'git show',
    'git branch',
    'git fetch',
    'git pull --ff-only'
  ];

  const normalizedProfile = profile === 'low' ? 'low-friction' : profile;
  if (!['balanced', 'low-friction'].includes(normalizedProfile)) {
    console.error(`Unknown profile: ${profile}. Choose from: balanced, low-friction`);
    process.exit(1);
  }
  const allowForProfile = normalizedProfile === 'low-friction' ? lowFrictionAllow : defaultAllow;

  const configs = {
    'claude-code': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Claude Code IDE Agent Kit config
# Runner uses a dedicated tmux session (iak-runner) to avoid conflicting with your IDE
# Add commands to tmux.allow to permit them
# Set github.webhook_secret to verify inbound webhooks
# Set openclaw.token to connect to your OpenClaw gateway
# Profile: ${normalizedProfile}
#
# To run with full auto-approval (no permission prompts):
#   claude --dangerously-skip-permissions
#
# Or use the generated .claude/settings.json for granular control.
# WARNING: --dangerously-skip-permissions skips ALL safety prompts.
# Only use in trusted environments with bounded agent tasks.`
    },
    'codex': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Codex IDE Agent Kit config
# For Codex: auto-approve can be configured via Codex's own settings
# This module handles the webhook + tmux layer underneath
# Profile: ${normalizedProfile}`
    },
    'cursor': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Cursor IDE Agent Kit config
# Cursor agents can invoke tmux runner via CLI or consume the webhook queue
# Profile: ${normalizedProfile}`
    },
    'vscode': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# VS Code IDE Agent Kit config
# VS Code extensions or Copilot agents can consume the queue file and invoke tmux runner
# Profile: ${normalizedProfile}`
    },
    'gemini': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Gemini IDE Agent Kit config
# Fast path via webhook push model or fallback loop via 'gemini' tmux session.
# Broaden 'tmux.allow' for read/build tasks to reduce manual 'yes' clicking,
# but keep destructive actions behind manual IDE approval barriers.
# Profile: ${normalizedProfile}`
    },
    'antigravity': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          ide_session: 'claude',
          nudge_text: 'check rooms',
          allow: allowForProfile
        },
        memory: {
          dir: './memory',
          backend: 'local'
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Antigravity IDE Agent Kit config
# Antigravity does not use tmux for nudging. New messages are delivered via
# the notification file (/tmp/iak-new-messages.txt) which the agent reads
# on a cron or hook interval.
#
# Recommended setup:
#   1. In your ~/.claude/settings.json, set up a CronCreate or UserPromptSubmit
#      hook that periodically checks /tmp/iak-new-messages.txt
#   2. Or add to MEMORY.md: "Check /tmp/iak-new-messages.txt on each prompt"
#   3. The room poller writes new messages to the notification file automatically
#   4. tmux nudge is still attempted as a fallback if a tmux session exists
#
# Profile: ${normalizedProfile}`
    }
  };

  const preset = configs[targetIde];
  if (!preset) {
    console.error(`Unknown IDE: ${targetIde}. Choose from: ${Object.keys(configs).join(', ')}`);
    process.exit(1);
  }

  const outPath = resolve(preset.filename);
  if (existsSync(outPath)) {
    console.log(`Config already exists: ${outPath}`);
    return;
  }

  writeFileSync(outPath, JSON.stringify(preset.config, null, 2) + '\n');
  console.log(`Created ${outPath} for ${targetIde}`);
  console.log(preset.notes);
  if (!hasClaudeMem) {
    console.warn('\nâš  WARNING: claude-mem is not installed. Hooks will be generated but will fail until you run: npm install -g claude-mem');
  }

  // Generate check-rooms hook script
  if (['claude-code', 'antigravity'].includes(targetIde)) {
    const scriptsDir = resolve('.claude', 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    const hookScript = resolve(scriptsDir, 'check-rooms.sh');
    if (!existsSync(hookScript)) {
      writeFileSync(hookScript, `#!/bin/bash
# Hook: check for new room messages and inject them into the session
MSG_FILE="/tmp/iak-new-messages.txt"
if [ -s "$MSG_FILE" ]; then
    echo ""
    echo "=== NEW ROOM MESSAGES ==="
    cat "$MSG_FILE"
    echo "========================="
    > "$MSG_FILE"
fi
`);
      const { chmodSync } = await import('node:fs');
      chmodSync(hookScript, 0o755);
      console.log(`Created ${hookScript}`);
    }
  }

  // Generate IDE-specific permission settings
  if (targetIde === 'claude-code') {
    const claudeDir = resolve('.claude');
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = resolve('.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      const scriptsDir = resolve('.claude', 'scripts');
      const hookScriptPath = resolve(scriptsDir, 'check-rooms.sh');
      const promptHooks = [
        {
          type: 'command',
          command: `bash ${hookScriptPath}`,
        }
      ];
      const sessionHooks = [];

      if (hasClaudeMem) {
        promptHooks.push({
          type: 'command',
          command: 'claude-mem hook user-message',
        });
        sessionHooks.push({
          type: 'command',
          command: 'claude-mem hook session-init',
        });
      }

      const settings = {
        permissions: {
          allow: [
            'Bash(*)',
            'Read',
            'Edit',
            'Write',
            'Glob',
            'Grep',
            'WebFetch',
            'WebSearch',
            'Agent',
            'Skill',
          ],
          defaultMode: 'bypassPermissions',
        },
        skipDangerousModePermissionPrompt: true,
        hooks: {
          UserPromptSubmit: promptHooks,
        },
      };

      if (sessionHooks.length > 0) {
        settings.hooks.SessionInit = sessionHooks;
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`Created ${settingsPath} with auto-approve + room polling hook (profile: ${normalizedProfile})`);
    } else {
      console.log(`Claude Code settings already exist: ${settingsPath}`);
    }
  }

  if (targetIde === 'antigravity') {
    const claudeDir = resolve('.claude');
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = resolve('.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      const scriptsDir = resolve('.claude', 'scripts');
      const hookScriptPath = resolve(scriptsDir, 'check-rooms.sh');
      const promptHooks = [
        {
          type: 'command',
          command: `bash ${hookScriptPath}`,
        }
      ];
      const sessionHooks = [];

      if (hasClaudeMem) {
        promptHooks.push({
          type: 'command',
          command: 'claude-mem hook user-message',
        });
        sessionHooks.push({
          type: 'command',
          command: 'claude-mem hook session-init',
        });
      }

      const settings = {
        permissions: {
          allow: [
            'Bash(*)',
            'Read',
            'Edit',
            'Write',
            'Glob',
            'Grep',
            'WebFetch',
            'WebSearch',
            'Agent',
            'Skill',
            'NotebookEdit',
          ],
          defaultMode: 'bypassPermissions',
        },
        skipDangerousModePermissionPrompt: true,
        hooks: {
          UserPromptSubmit: promptHooks,
        },
      };

      if (sessionHooks.length > 0) {
        settings.hooks.SessionInit = sessionHooks;
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`Created ${settingsPath} with Antigravity auto-approve + room polling hook (profile: ${normalizedProfile})`);
    } else {
      console.log(`Claude Code settings already exist: ${settingsPath}`);
    }
  }

  if (targetIde === 'codex') {
    const codexPath = resolve('codex.json');
    if (!existsSync(codexPath)) {
      const codexSettings = {
        approvalPolicy: normalizedProfile === 'low-friction' ? 'on-request' : 'unless-allow-listed',
        sandboxMode: 'workspace-write'
      };
      writeFileSync(codexPath, JSON.stringify(codexSettings, null, 2) + '\n');
      console.log(`Created ${codexPath} with Codex approval settings (profile: ${normalizedProfile})`);
    }
  }
}

  

main().catch(e => {
  console.error(e);
  process.exit(1);
});
