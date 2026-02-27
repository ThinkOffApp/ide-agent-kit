// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * AntFarm adapter — polls Ant Farm rooms for new messages.
 */

export const antfarmAdapter = {
  name: 'antfarm',

  async fetch(config, opts = {}) {
    const poller = config?.poller || {};
    const rooms = poller.rooms || [];
    const apiKey = poller.api_key;
    const limit = opts.seed ? 50 : 10;
    const all = [];

    for (const room of rooms) {
      const url = `https://antfarm.world/api/v1/rooms/${room}/messages?limit=${limit}`;
      try {
        const result = execSync(
          `curl -sS -H "X-API-Key: ${apiKey}" "${url}"`,
          { encoding: 'utf8', timeout: 15000 }
        );
        const data = JSON.parse(result);
        const msgs = data.messages || (Array.isArray(data) ? data : []);
        for (const m of msgs) {
          m._room = room;
        }
        all.push(...msgs);
      } catch (e) {
        console.error(`  antfarm fetch ${room} failed: ${e.message}`);
      }
    }
    return all;
  },

  getKey(msg) {
    return msg.id || null;
  },

  shouldSkip(msg, config) {
    const selfHandle = config?.poller?.handle || '@unknown';
    const sender = msg.from || msg.sender || '?';
    return sender === selfHandle || sender === selfHandle.replace('@', '');
  },

  normalize(msg, config) {
    const sender = msg.from || msg.sender || '?';
    const body = (msg.body || '').slice(0, 500);
    const ts = msg.created_at || new Date().toISOString();
    const room = msg._room || '';

    return {
      trace_id: randomUUID(),
      event_id: msg.id,
      source: 'antfarm',
      kind: 'antfarm.message.created',
      timestamp: ts,
      room,
      actor: { login: sender },
      payload: { body, room }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const room = event.room || '';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    return `[${ts}] [${room}] ${sender}: ${body}`;
  }
};
