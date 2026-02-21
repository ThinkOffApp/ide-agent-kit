#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { tmuxRun } from '../src/tmux-runner.mjs';
import { tailReceipts } from '../src/receipt.mjs';
import { startWebhookServer } from '../src/webhook-server.mjs';
import { emitJson } from '../src/emit.mjs';

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

  ide-agent-kit init [--ide <claude-code|codex|cursor|vscode|gemini>]
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

  if (command === 'init') {
    const opts = parseKV(args, 'init');
    const ide = opts.ide || 'claude-code';
    await initIdeConfig(ide);
    return;
  }

  console.error(`Unknown command: ${command} ${subcommand || ''}`);
  usage();
  process.exit(1);
}

async function initIdeConfig(ide) {
  const { writeFileSync, existsSync, mkdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  const configs = {
    'claude-code': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          allow: ['npm test', 'npm run build', 'pytest', 'git status', 'git diff']
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' }
      },
      notes: `# Claude Code IDE Agent Kit config
# Runner uses a dedicated tmux session (iak-runner) to avoid conflicting with your IDE
# Add commands to tmux.allow to permit them
# Set github.webhook_secret to verify inbound webhooks`
    },
    'codex': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          allow: ['npm test', 'npm run build', 'pytest', 'git status', 'git diff']
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' }
      },
      notes: `# Codex IDE Agent Kit config
# For Codex: auto-approve can be configured via Codex's own settings
# This module handles the webhook + tmux layer underneath`
    },
    'cursor': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          allow: ['npm test', 'npm run build', 'pytest', 'git status', 'git diff']
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' }
      },
      notes: `# Cursor IDE Agent Kit config
# Cursor agents can invoke tmux runner via CLI or consume the webhook queue`
    },
    'vscode': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'iak-runner',
          allow: ['npm test', 'npm run build', 'pytest', 'git status', 'git diff']
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' }
      },
      notes: `# VS Code IDE Agent Kit config
# VS Code extensions or Copilot agents can consume the queue file and invoke tmux runner`
    },
    'gemini': {
      filename: 'ide-agent-kit.json',
      config: {
        listen: { host: '127.0.0.1', port: 8787 },
        queue: { path: './ide-agent-queue.jsonl' },
        receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
        tmux: {
          default_session: 'gemini',
          allow: ['npm test', 'npm run build', 'pytest', 'git status', 'git diff']
        },
        github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment'] },
        outbound: { default_webhook_url: '' }
      },
      notes: `# Gemini IDE Agent Kit config
# Fast path via webhook push model or fallback loop via 'gemini' tmux session.
# Broaden 'tmux.allow' for read/build tasks to reduce manual 'yes' clicking,
# but keep destructive actions behind manual IDE approval barriers.`
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
