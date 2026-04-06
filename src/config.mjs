// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8787 },
  queue: { path: './ide-agent-queue.jsonl' },
  receipts: { path: './ide-agent-receipts.jsonl', stdout_tail_lines: 80 },
  tmux: { default_session: 'iak-runner', ide_session: 'claude', nudge_text: 'check rooms', allow: [] },
  poller: {
    rooms: '',
    handle: '',
    interval_sec: 30,
    seen_file: '/tmp/iak-seen-ids.txt',
    api_key: '',
    nudge_mode: 'tmux',
    nudge_command: ''
  },
  dm_poller: {
    enabled: false,
    handle: '',
    interval_sec: 30,
    seen_file: '/tmp/iak-dm-seen-ids.txt',
    api_key: '',
    human_only: false,
    limit: 100
  },
  github: { webhook_secret: '', event_kinds: ['pull_request', 'issue_comment', 'check_suite', 'workflow_run'] },
  outbound: { default_webhook_url: '' },
  rate_limit: { message_interval_sec: 30 },
  automation: {
    rules: [],
    seen_file: '/tmp/iak-automation-seen.txt',
    interval_sec: 30,
    cooldown_sec: 5,
    first_match_only: true
  },
  comments: {
    moltbook: { posts: [], base_url: 'https://www.moltbook.com' },
    github: { repos: [], token: '' },
    interval_sec: 120,
    seen_file: '/tmp/iak-comment-seen.txt'
  },
  discord: {
    channels: [],
    interval_sec: 30,
    seen_file: '/tmp/iak-discord-seen.txt',
    self_id: '',
    skip_bots: false
  },
  acp: {
    enabled: false,
    token: '',
    allowed_agents: [],
    allowed_harnesses: [],
    session_timeout_sec: 3600,
    max_concurrent_sessions: 5,
    receipt_all_actions: true,
    max_messages_per_session: 200,
    sessions_file: '/tmp/iak-acp-sessions.json'
  },
  background: {
    enabled: false,
    interval_sec: 3600,
    recent_window_sec: 7200,
    max_events: 100,
    sidecar_dir: '~/.iak/consolidation',
    lock_file: '/tmp/iak-background.lock',
    timeouts: {
      light_sec: 60,
      rem_sec: 120,
      deep_sec: 120
    }
  }
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
    poller: { ...DEFAULT_CONFIG.poller, ...raw.poller },
    dm_poller: { ...DEFAULT_CONFIG.dm_poller, ...raw.dm_poller },
    github: { ...DEFAULT_CONFIG.github, ...raw.github },
    outbound: { ...DEFAULT_CONFIG.outbound, ...raw.outbound },
    rate_limit: { ...DEFAULT_CONFIG.rate_limit, ...raw.rate_limit },
    automation: { ...DEFAULT_CONFIG.automation, ...raw.automation, rules: raw.automation?.rules || [] },
    comments: {
      ...DEFAULT_CONFIG.comments,
      ...raw.comments,
      moltbook: { ...DEFAULT_CONFIG.comments.moltbook, ...raw.comments?.moltbook },
      github: { ...DEFAULT_CONFIG.comments.github, ...raw.comments?.github }
    },
    discord: { ...DEFAULT_CONFIG.discord, ...raw.discord },
    acp: { ...DEFAULT_CONFIG.acp, ...raw.acp },
    background: {
      ...DEFAULT_CONFIG.background,
      ...raw.background,
      timeouts: {
        ...DEFAULT_CONFIG.background.timeouts,
        ...raw.background?.timeouts
      }
    },
    openclaw: raw.openclaw || {}
  };
}
