// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Discord adapter — polls Discord channels via OpenClaw CLI.
 */

const OC_DEFAULTS = {
  home: '/Users/family/openclaw',
  bin: '/opt/homebrew/bin/openclaw',
  ssh: 'family@localhost'
};

function resolveOC(config) {
  const oc = config?.openclaw || {};
  return {
    home: oc.home || OC_DEFAULTS.home,
    bin: oc.bin || OC_DEFAULTS.bin,
    ssh: oc.ssh || OC_DEFAULTS.ssh
  };
}

export const discordAdapter = {
  name: 'discord',

  async fetch(config) {
    const discordCfg = config?.discord || {};
    const channels = discordCfg.channels || [];
    const oc = resolveOC(config);
    const all = [];

    for (const ch of channels) {
      const channelId = typeof ch === 'string' ? ch : ch.id;
      const channelName = typeof ch === 'string' ? ch : (ch.name || ch.id);
      const envPrefix = `export PATH=/opt/homebrew/bin:$PATH && export OPENCLAW_HOME=${oc.home}`;
      const ocCmd = `${oc.bin} message read --channel discord --target ${channelId} --limit 20 --json`;
      try {
        let result;
        if (oc.ssh) {
          result = execFileSync('ssh', [oc.ssh, `${envPrefix} && ${ocCmd}`], {
            encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
          });
        } else {
          result = execFileSync(oc.bin, [
            'message', 'read', '--channel', 'discord', '--target', channelId, '--limit', '20', '--json'
          ], {
            encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, OPENCLAW_HOME: oc.home }
          });
        }
        const data = JSON.parse(result);
        if (!data?.payload?.ok) continue;
        const msgs = data.payload.messages || [];
        for (const m of msgs) {
          m._channelName = channelName;
          m._channelId = channelId;
        }
        all.push(...msgs);
      } catch (e) {
        console.error(`  discord fetch ${channelName} failed: ${e.message?.slice(0, 120) || 'unknown error'}`);
      }
    }
    return all;
  },

  getKey(msg) {
    return msg.id ? `discord:${msg.id}` : null;
  },

  shouldSkip(msg, config) {
    const selfId = config?.discord?.self_id || '';
    const skipBots = config?.discord?.skip_bots || false;
    if (selfId && msg.author?.id === selfId) return true;
    if (skipBots && msg.author?.bot) return true;
    return false;
  },

  normalize(msg) {
    return {
      trace_id: randomUUID(),
      event_id: msg.id,
      source: 'discord',
      kind: 'discord.message.created',
      timestamp: msg.timestamp || new Date().toISOString(),
      channel: msg._channelName,
      actor: { login: msg.author?.username || '?' },
      payload: { body: (msg.content || '').slice(0, 500), channel_id: msg._channelId }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const channel = event.channel || '';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    return `[${ts}] [discord/${channel}] ${sender}: ${body}`;
  }
};
