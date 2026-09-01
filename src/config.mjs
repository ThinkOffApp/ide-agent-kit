// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

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

// Secrets may be given as `<name>_file` instead of inline: the file's trimmed
// contents become `<name>`. A file reference is the safer default for a key
// (it never lands in a config that gets pasted into a room), and codex.json was
// written that way - which the CLI silently did not read, so its poller
// crash-looped 1134 times behind launchd KeepAlive (issue #86, 2026-09-01).
// An inline value wins when both are present; a missing file is an error with
// the path in it, never a silent empty key.
const SECRET_FILE_FIELDS = [
  ['poller', 'api_key'],
  ['dm_poller', 'api_key'],
  ['xfor', 'api_key'],
  ['intent', 'apiKey'],
  ['degradation_watch', 'api_key']
];

export function readSecretFile(path) {
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
  if (!existsSync(expanded)) throw new Error(`secret file not found: ${expanded}`);
  const value = readFileSync(expanded, 'utf8').trim();
  if (!value) throw new Error(`secret file is empty: ${expanded}`);
  return value;
}

export function resolveSecretFiles(cfg, fields = SECRET_FILE_FIELDS) {
  for (const [section, key] of fields) {
    const block = cfg?.[section];
    if (!block || typeof block !== 'object') continue;
    const fileKey = `${key === 'apiKey' ? 'api_key' : key}_file`;
    const file = block[fileKey];
    if (!file || block[key]) continue;
    block[key] = readSecretFile(file);
  }
  return cfg;
}

export function loadConfig(configPath) {
  const p = resolve(configPath || 'ide-agent-kit.json');
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return resolveSecretFiles({
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
    openclaw: raw.openclaw || {},
    // Pass-throughs for blocks consumed as-is elsewhere: src/intent.mjs +
    // enrichment (intent, memory_api), src/moltbook.mjs (moltbook),
    // src/mcp-server.mjs (mcp: sessions, allow_unrestricted).
    intent: raw.intent || {},
    memory_api: raw.memory_api || {},
    moltbook: raw.moltbook || {},
    mcp: raw.mcp || {},
    xfor: raw.xfor || {},
    degradation_watch: raw.degradation_watch || {}
  });
}
