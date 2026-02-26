#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { tmuxRun } from '../src/tmux-runner.mjs';
import { tailReceipts } from '../src/receipt.mjs';
import { startWebhookServer } from '../src/webhook-server.mjs';
import { emitJson } from '../src/emit.mjs';
import { watchQueue } from '../src/watch.mjs';
import { startRoomPoller } from '../src/room-poller.mjs';
import { memoryList, memoryGet, memorySet, memoryAppend, memoryDelete, memorySearch } from '../src/memory.mjs';
import { triggerAgent, healthCheck, healthDeep, agentsList, configGet, configPatch, gatewayRestart } from '../src/openclaw-gateway.mjs';
import { sessionsSend, sessionsSpawn, sessionsList, sessionsHistory, sessionsStatus } from '../src/openclaw-sessions.mjs';
import { execApprovalRequest, execApprovalWait, execApprovalResolve, execApprovalList } from '../src/openclaw-exec.mjs';
import { listHooks, createForwarderHook, deleteHook } from '../src/openclaw-hooks.mjs';
import { cronList, cronAdd, cronRemove, cronRun, cronStatus } from '../src/openclaw-cron.mjs';
import { keepaliveStart, keepaliveStop, keepaliveStatus } from '../src/session-keepalive.mjs';
import { moltbookPost, moltbookFeed } from '../src/moltbook.mjs';
import { startRoomAutomation } from '../src/room-automation.mjs';
import { pollComments, startCommentPoller } from '../src/comment-poller.mjs';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function usage() {
  console.log(`IDE Agent Kit v0.2

Usage:
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

  ide-agent-kit poll --rooms <room1,room2> --api-key <key> --handle <@handle> [--interval <sec>] [--config <path>]
    Poll Ant Farm rooms directly and nudge IDE tmux session on new messages.

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

  if (command === 'init') {
    const opts = parseKV(args, 'init');
    const ide = opts.ide || 'claude-code';
    const profile = opts.profile || opts.friction || 'balanced';
    await initIdeConfig(ide, profile);
    return;
  }

  console.error(`Unknown command: ${command} ${subcommand || ''}`);
  usage();
  process.exit(1);
}

async function initIdeConfig(ide, profile = 'balanced') {
  const { writeFileSync, existsSync, mkdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');

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
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' },
        openclaw: { host: '127.0.0.1', port: 18791, token: '' }
      },
      notes: `# Gemini IDE Agent Kit config
# Fast path via webhook push model or fallback loop via 'gemini' tmux session.
# Broaden 'tmux.allow' for read/build tasks to reduce manual 'yes' clicking,
# but keep destructive actions behind manual IDE approval barriers.
# Profile: ${normalizedProfile}`
    }
  };

  const preset = configs[ide];
  if (!preset) {
    console.error(`Unknown IDE: ${ide}. Choose from: ${Object.keys(configs).join(', ')}`);
    process.exit(1);
  }

  const outPath = resolve(preset.filename);
  if (existsSync(outPath)) {
    console.log(`Config already exists: ${outPath}`);
    return;
  }

  writeFileSync(outPath, JSON.stringify(preset.config, null, 2) + '\n');
  console.log(`Created ${outPath} for ${ide}`);
  console.log(preset.notes);

  // Generate IDE-specific permission settings
  if (ide === 'claude-code') {
    const claudeDir = resolve('.claude');
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    const settingsPath = resolve('.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      const defaultAllowedTools = [
        'Bash(node bin/cli.mjs *)',
        'Bash(node --test *)',
        'Bash(npm test*)',
        'Bash(npm run build*)',
        'Bash(npm run lint*)',
        'Bash(npm run typecheck*)',
        'Bash(git status*)',
        'Bash(git diff*)',
        'Bash(git log*)',
        'Bash(git show*)',
        'Bash(git branch*)',
        'Bash(git fetch*)',
        'Bash(gh api *)',
        'Bash(gh auth status*)',
        'Bash(gh search *)',
        'Bash(curl -sS *)',
        'Bash(lsof *)',
        'Bash(ps *)',
        'Bash(tail *)',
        'Bash(head *)',
        'Bash(wc *)',
        'Bash(cat *)',
        'Bash(ls *)',
        'Bash(python3 -c *)',
        'Bash(python3 -m pytest*)',
        'Bash(kill *)',
        'Bash(nohup *)',
      ];
      const lowFrictionAllowedTools = [
        ...defaultAllowedTools,
        'Bash(rg *)',
        'Bash(jq *)',
        'Bash(sed *)',
        'Bash(awk *)',
        'Bash(git pull --ff-only*)',
        'Bash(ssh family@localhost *)',
        'Bash(openclaw *)',
      ];
      const settings = {
        permissions: {
          allowedTools: normalizedProfile === 'low-friction' ? lowFrictionAllowedTools : defaultAllowedTools,
          dangerouslySkipPermissions: true
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`Created ${settingsPath} with auto-approved commands (profile: ${normalizedProfile})`);
    } else {
      console.log(`Claude Code settings already exist: ${settingsPath}`);
    }
  }

  if (ide === 'codex') {
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
