// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * xfor adapter — polls xfor.bot posts and notifications.
 *
 * API base: https://xfor.bot/api/v1
 * Auth: X-API-Key header
 */

function xforFetch(path, apiKey) {
  const url = `https://xfor.bot/api/v1${path}`;
  try {
    const result = execSync(
      `curl -sS -H "X-API-Key: ${apiKey}" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error(`  xfor fetch ${path} failed: ${e.message}`);
    return null;
  }
}

export const xforAdapter = {
  name: 'xfor',

  async fetch(config) {
    const xforCfg = config?.xfor || {};
    const apiKey = xforCfg.api_key;
    if (!apiKey) return [];

    const all = [];

    // Poll notifications (mentions, replies, likes, follows)
    const notifs = xforFetch('/notifications?unread=true', apiKey);
    if (notifs && Array.isArray(notifs)) {
      for (const n of notifs) {
        n._type = 'notification';
      }
      all.push(...notifs);
    } else if (notifs?.notifications) {
      for (const n of notifs.notifications) {
        n._type = 'notification';
      }
      all.push(...notifs.notifications);
    }

    // Poll recent posts from feed
    const feed = xforFetch('/posts', apiKey);
    if (feed && Array.isArray(feed)) {
      for (const p of feed) {
        p._type = 'post';
      }
      all.push(...feed);
    } else if (feed?.posts) {
      for (const p of feed.posts) {
        p._type = 'post';
      }
      all.push(...feed.posts);
    }

    return all;
  },

  getKey(msg) {
    const id = msg.id || msg.notification_id;
    if (!id) return null;
    return `xfor:${msg._type}:${id}`;
  },

  shouldSkip(msg, config) {
    const selfHandle = config?.xfor?.handle || '';
    if (!selfHandle) return false;
    const sender = msg.author?.handle || msg.from_handle || msg.handle || '';
    return sender === selfHandle || sender === selfHandle.replace('@', '');
  },

  normalize(msg) {
    const isNotif = msg._type === 'notification';
    const sender = msg.author?.handle || msg.author?.name || msg.from_handle || '?';
    const body = (msg.content || msg.message || msg.text || '').slice(0, 500);
    const ts = msg.created_at || msg.timestamp || new Date().toISOString();
    const postId = msg.id || msg.post_id || msg.reference_post_id || '';

    return {
      trace_id: randomUUID(),
      event_id: msg.id || msg.notification_id,
      source: 'xfor',
      kind: isNotif ? `xfor.notification.${msg.type || 'generic'}` : 'xfor.post.created',
      timestamp: ts,
      actor: { login: sender },
      payload: {
        body,
        post_id: postId,
        type: msg.type || msg._type,
        url: postId ? `https://xfor.bot/post/${postId}` : undefined
      }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    const kind = event.kind?.split('.').pop() || '';
    return `[${ts}] [xfor/${kind}] ${sender}: ${body}`;
  }
};
