#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { tmuxRun } from '../src/tmux-runner.mjs';
import { tailReceipts } from '../src/receipt.mjs';
import { startWebhookServer } from '../src/webhook-server.mjs';
import { emitJson } from '../src/emit.mjs';
import { watchQueue } from '../src/watch.mjs';
import { startRoomPoller } from '../src/room-poller.mjs';
import { memoryList, memoryGet, memorySet, memoryAppend, memoryDelete } from '../src/memory.mjs';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

function usage() {
  console.log(`IDE Agent Kit v0.1

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
    Uses fs.watch for instant reaction (no polling delay).

  ide-agent-kit poll --rooms <room1,room2> --api-key <key> --handle <@handle> [--interval <sec>] [--config <path>]
    Poll Ant Farm rooms directly and nudge IDE tmux session on new messages.
    No webhooks required — works anywhere with curl and tmux.

  ide-agent-kit memory list [--config <path>]
    List all memory entries.

  ide-agent-kit memory get --key <topic> [--config <path>]
    Read a memory entry.

  ide-agent-kit memory set --key <topic> --value <text> [--config <path>]
    Write a memory entry (overwrites existing).

  ide-agent-kit memory append --key <topic> --value <text> [--config <path>]
    Append to a memory entry with timestamp.

  ide-agent-kit memory delete --key <topic> [--config <path>]
    Delete a memory entry.

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
    // Keep process alive
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
    console.error('Usage: ide-agent-kit memory <list|get|set|append|delete> [--backend local|openclaw] [--agent <name>] [options]');
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
        outbound: { default_webhook_url: '' }
      },
      notes: `# Claude Code IDE Agent Kit config
# Runner uses a dedicated tmux session (iak-runner) to avoid conflicting with your IDE
# Add commands to tmux.allow to permit them
# Set github.webhook_secret to verify inbound webhooks
# Profile: ${normalizedProfile}`
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
        outbound: { default_webhook_url: '' }
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
        outbound: { default_webhook_url: '' }
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
        outbound: { default_webhook_url: '' }
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
        outbound: { default_webhook_url: '' }
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
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
