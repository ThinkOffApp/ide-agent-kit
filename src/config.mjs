import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8787 },
  queue: { path: './ide-agent-queue.jsonl' },
  receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
  tmux: { default_session: 'iak-runner', ide_session: 'claude', nudge_text: 'check rooms', allow: [] },
  github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment', 'check_suite', 'workflow_run'] },
  outbound: { default_webhook_url: '' }
};

export function loadConfig(configPath) {
  const p = resolve(configPath || 'ide-agent-kit.json');
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return {
    listen: { ...DEFAULT_CONFIG.listen, ...raw.listen },
    queue: { ...DEFAULT_CONFIG.queue, ...raw.queue },
    receipts: { ...DEFAULT_CONFIG.receipts, ...raw.receipts },
    tmux: { ...DEFAULT_CONFIG.tmux, ...raw.tmux },
    github: { ...DEFAULT_CONFIG.github, ...raw.github },
    outbound: { ...DEFAULT_CONFIG.outbound, ...raw.outbound }
  };
}
