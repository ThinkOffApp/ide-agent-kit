// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveSelfHandle, isSelfSender } from '../common/handles.mjs';

/**
 * GroupMind adapter — polls GroupMind rooms for new messages.
 */

export const groupmindAdapter = {
  name: 'groupmind',

  async fetch(config, opts = {}) {
    const poller = config?.poller || {};
    const rooms = poller.rooms || [];
    const apiKey = poller.api_key;
    const limit = opts.seed ? 50 : 10;
    const all = [];

    for (const room of rooms) {
      const url = `https://groupmind.one/api/v1/rooms/${room}/messages?limit=${limit}`;
      try {
        const result = execFileSync('curl', ['-sS', '-H', `X-API-Key: ${apiKey}`, url], {
          encoding: 'utf8', timeout: 15000
        });
        const data = JSON.parse(result);
        const msgs = data.messages || (Array.isArray(data) ? data : []);
        // Resolve reply targets from the same batch: a fresh reply's target is
        // almost always within the last `limit` messages. Without this the
        // reply_to id survives but means nothing to a reader of the line.
        // (Aug 27 2026: petrus's "spec this" reply was interpreted by guess
        // because every agent-facing surface dropped the reply target.)
        const byId = new Map(msgs.map((m) => [m.id, m]));
        for (const m of msgs) {
          m._room = room;
          // reply_to is POLYMORPHIC: some clients POST a bare id string, others
          // the object form { id, from, body } the server also stores verbatim.
          // The object form used to miss the Map lookup and print
          // "[object Object]" in agent-facing lines — the richest form of the
          // data produced the worst output. Normalise before resolving.
          const rt = m.reply_to;
          const rtId = rt && typeof rt === 'object' ? rt.id : rt;
          if (rtId && byId.has(rtId)) {
            const t = byId.get(rtId);
            m._replyTarget = { from: t.from || t.sender || '?', body: (t.body || '').slice(0, 120) };
          } else if (rt && typeof rt === 'object' && (rt.from || rt.body)) {
            // Target outside the fetch window, but the object form carries it
            // inline — use what the sender gave us.
            m._replyTarget = { from: rt.from || '?', body: (rt.body || '').slice(0, 120) };
          }
          if (rtId) m._replyToId = rtId;
        }
        all.push(...msgs);
      } catch (e) {
        console.error(`  groupmind fetch ${room} failed: ${e.message}`);
      }
    }
    return all;
  },

  getKey(msg) {
    return msg.id || null;
  },

  shouldSkip(msg, config) {
    const selfHandle = resolveSelfHandle({ config });
    const sender = msg.from || msg.sender || '?';
    return isSelfSender(sender, selfHandle);
  },

  normalize(msg, config) {
    const sender = msg.from || msg.sender || '?';
    const body = (msg.body || '').slice(0, 500);
    const ts = msg.created_at || new Date().toISOString();
    const room = msg._room || '';

    return {
      trace_id: randomUUID(),
      event_id: msg.id,
      source: 'groupmind',
      kind: 'groupmind.message.created',
      timestamp: ts,
      room,
      actor: { login: sender },
      payload: {
        body,
        room,
        // A reply's meaning lives in its target - carry it, never drop it.
        // Always the id string whatever shape arrived on the wire, so
        // consumers never branch on client format.
        reply_to: msg._replyToId
          || (typeof msg.reply_to === 'object' ? (msg.reply_to?.id || null) : msg.reply_to)
          || null,
        reply_target: msg._replyTarget || null
      }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const room = event.room || '';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    const line = `[${ts}] [${room}] ${sender}: ${body}`;
    // ONE physical line, always. The notification file's readers split on
    // newlines (and room_ack can clear the file mid-write), so a two-line
    // entry became two half-events — one of them a freestanding "⤷" fragment.
    // Found in review of #70 after merge; the annotation now rides inline.
    const t = event.payload?.reply_target;
    if (t) {
      const snippet = (t.body || '').replace(/\n/g, ' ').slice(0, 100);
      return `${line}  ⤷ in reply to ${t.from}: "${snippet}"`;
    }
    if (event.payload?.reply_to) {
      // Target not in the fetch window — still say it IS a reply so nobody
      // interprets it as a freestanding statement.
      return `${line}  ⤷ a reply (target ${event.payload.reply_to} not in recent window)`;
    }
    return line;
  }
};
