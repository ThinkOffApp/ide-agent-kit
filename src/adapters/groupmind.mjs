// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveSelfHandle, isSelfSender } from '../common/handles.mjs';
import { replyIdOf, embeddedTargetOf, resolveReplyTargets, replyAnnotation } from '../common/reply-context.mjs';

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
        resolveReplyTargets(msgs);
        for (const m of msgs) m._room = room;
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
    let body = (msg.body || '').slice(0, 500);
    // Surface every attachment kind. 2026-07-19: petrus posted a screenshot
    // that never reached the agent (bodies-only extraction) and got asked to
    // re-post it - an attachment must never be invisible.
    if (msg.image_url) body += ` [IMAGE ATTACHED: ${msg.image_url}]`;
    if (msg.audio_url) body += ` [AUDIO ATTACHED: ${msg.audio_url}]`;
    if (msg.file_url) body += ` [FILE ATTACHED: ${msg.file_name || msg.file_url}]`;
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
        // Shape-normalised here too, not only in fetch(): normalize() must
        // stay correct for callers that hand it a raw message directly.
        reply_to: replyIdOf(msg.reply_to),
        reply_target: msg._replyTarget || embeddedTargetOf(msg.reply_to)
      }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const room = event.room || '';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    const line = `[${ts}] [${room}] ${sender}: ${body}`;
    // Single physical line - the notification-file contract is one entry per
    // line (room_ack counts lines; codexmb reproduced overcounting on #70).
    return line + replyAnnotation(event.payload?.reply_to, event.payload?.reply_target);
  }
};
