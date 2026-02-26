// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Discord Poller — polls Discord channels via OpenClaw CLI.
 *
 * Reads messages using `openclaw message read --channel discord` and writes
 * normalized events to the JSONL queue. Optionally nudges an IDE tmux session.
 *
 * Config (in ide-agent-kit.json under discord):
 *   {
 *     "channels": [
 *       { "id": "1474426061218386094", "name": "general" }
 *     ],
 *     "interval_sec": 30,
 *     "self_id": "1474422169470636134",
 *     "skip_bots": false,
 *     "seen_file": "/tmp/iak-discord-seen.txt"
 *   }
 *
 * Requires OpenClaw 2026.2.25+ with the Discord plugin enabled.
 */

const SEEN_FILE_DEFAULT = '/tmp/iak-discord-seen.txt';

const OC_DEFAULTS = {
  home: '/Users/family/openclaw',
  bin: '/opt/homebrew/bin/openclaw',
  ssh: 'family@localhost'
};

function loadSeenIds(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveSeenIds(path, ids) {
  const arr = [...ids].slice(-2000);
  writeFileSync(path, arr.join('\n') + '\n');
}

function nudgeTmux(session, text) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`);
  } catch {
    return false;
  }
  try {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} -l ${JSON.stringify(text)}`);
    execSync('sleep 0.3');
    execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`);
    return true;
  } catch {
    return false;
  }
}

function resolveOC(config) {
  const oc = config?.openclaw || {};
  return {
    home: oc.home || OC_DEFAULTS.home,
    bin: oc.bin || OC_DEFAULTS.bin,
    ssh: oc.ssh || OC_DEFAULTS.ssh
  };
}

function fetchDiscordMessages(channelId, oc, limit = 20) {
  const envPrefix = `export PATH=/opt/homebrew/bin:$PATH && export OPENCLAW_HOME=${oc.home}`;
  const ocCmd = `${oc.bin} message read --channel discord --target ${channelId} --limit ${limit} --json`;
  const cmd = oc.ssh
    ? `ssh ${oc.ssh} '${envPrefix} && ${ocCmd}'`
    : `${envPrefix} && ${ocCmd}`;
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    const data = JSON.parse(result);
    if (!data?.payload?.ok) return [];
    return data.payload.messages || [];
  } catch (e) {
    console.error(`  discord fetch ${channelId} failed: ${e.message?.slice(0, 120) || 'unknown error'}`);
    return [];
  }
}

/**
 * One-shot poll of all configured Discord channels.
 * Returns array of new message events.
 */
export function pollDiscord(config) {
  const discordCfg = config?.discord || {};
  const channels = discordCfg.channels || [];
  if (channels.length === 0) return [];

  const seen = loadSeenIds(discordCfg.seen_file || SEEN_FILE_DEFAULT);
  const selfId = discordCfg.self_id || '';
  const skipBots = discordCfg.skip_bots || false;
  const oc = resolveOC(config);
  const newMessages = [];

  for (const ch of channels) {
    const channelId = typeof ch === 'string' ? ch : ch.id;
    const channelName = typeof ch === 'string' ? ch : (ch.name || ch.id);
    const msgs = fetchDiscordMessages(channelId, oc);

    for (const m of msgs) {
      const mid = m.id;
      const key = `discord:${mid}`;
      if (!mid || seen.has(key)) continue;
      seen.add(key);

      // Skip own messages
      if (selfId && m.author?.id === selfId) continue;
      // Skip bot messages if configured
      if (skipBots && m.author?.bot) continue;

      newMessages.push({
        trace_id: randomUUID(),
        event_id: mid,
        source: 'discord',
        kind: 'discord.message.created',
        timestamp: m.timestamp || new Date().toISOString(),
        channel: channelName,
        actor: { login: m.author?.username || '?' },
        payload: { body: (m.content || '').slice(0, 500), channel_id: channelId }
      });
    }
  }

  saveSeenIds(discordCfg.seen_file || SEEN_FILE_DEFAULT, seen);
  return newMessages;
}

/**
 * Start the Discord poller as a long-running process.
 */
export async function startDiscordPoller({ config, interval }) {
  const discordCfg = config?.discord || {};
  const pollInterval = interval || discordCfg.interval_sec || 30;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = config?.tmux?.ide_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';
  const channels = discordCfg.channels || [];

  console.log(`Discord poller started`);
  console.log(`  channels: ${channels.map(c => typeof c === 'string' ? c : c.name || c.id).join(', ')}`);
  console.log(`  interval: ${pollInterval}s`);

  // Seed: mark current messages as seen on first run
  console.log(`  seeding existing messages...`);
  const initial = pollDiscord(config);
  console.log(`  seeded (${initial.length} messages marked as seen)`);

  async function poll() {
    const newMessages = pollDiscord(config);

    if (newMessages.length > 0) {
      for (const m of newMessages) {
        appendFileSync(queuePath, JSON.stringify(m) + '\n');
        console.log(`  NEW: @${m.actor.login} in ${m.channel}: ${m.payload.body.slice(0, 80)}`);
      }

      const nudged = nudgeTmux(session, nudgeText);
      console.log(`  ${newMessages.length} new message(s) → ${nudged ? 'nudged' : 'no tmux session'}`);
    }
  }

  const timer = setInterval(poll, pollInterval * 1000);

  process.on('SIGINT', () => {
    console.log('\nDiscord poller stopped.');
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });

  return timer;
}
