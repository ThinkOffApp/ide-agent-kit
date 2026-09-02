// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-room message history for the pollers: the thread an agent needs to
 * understand a mention, kept locally and persisted across polls.
 *
 * Why (issue #90, 1-2 Sep 2026): a mention reached the agent with a
 * 100-character preview of its parent, or "target not in recent window" when
 * the parent was older than the 10-message fetch. hermes read "new card" as a
 * GPU because the messages that had settled "card = benchmark table" were
 * outside the window. The room API has no single-message fetch and ignores
 * pagination, but every poller already sees every message as it passes, so
 * remembering the last few hundred per room gives us: the full parent, the
 * reply chain above it, the asker's previous message, the agent's own last
 * post, and the room's settled facts ("state: ..." lines).
 *
 * File format: JSON { [room]: [ {id, from, body, created_at, reply_to} ] },
 * newest last, capped per room. One file per poller (next to seen_file).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { replyIdOf } from './reply-context.mjs';

const BODY_KEEP = 600;
export const STATE_PREFIX = /^\s*(?:state|settled)\s*:\s*(.+)$/i;

function oneLine(s, n) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function hhmm(ts) {
  const m = /T(\d{2}:\d{2})/.exec(ts || '');
  return m ? m[1] : '';
}

export class RoomHistory {
  constructor(path, { maxPerRoom = 400 } = {}) {
    this.path = path;
    this.maxPerRoom = maxPerRoom;
    this.rooms = {};
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (data && typeof data === 'object') this.rooms = data;
    } catch {
      this.rooms = {};
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.rooms));
      renameSync(tmp, this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Add or refresh a fetched batch. Idempotent; keeps newest-last order. */
  remember(room, msgs) {
    if (!room || !Array.isArray(msgs) || msgs.length === 0) return;
    const list = this.rooms[room] || [];
    const byId = new Map(list.map((m) => [m.id, m]));
    for (const m of msgs) {
      if (!m || !m.id) continue;
      byId.set(m.id, {
        id: m.id,
        from: m.from || m.sender || '?',
        body: oneLine(m.body, BODY_KEEP),
        created_at: m.created_at || '',
        reply_to: replyIdOf(m.reply_to),
        media: [m.image_url && 'image', m.audio_url && 'audio', m.file_url && 'file'].filter(Boolean)
      });
    }
    const merged = [...byId.values()].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    this.rooms[room] = merged.slice(-this.maxPerRoom);
  }

  get(room, id) {
    if (!room || !id) return null;
    return (this.rooms[room] || []).find((m) => m.id === id) || null;
  }

  /** The sender's latest message strictly before `beforeTs`, excluding ids. */
  previousFrom(room, sender, beforeTs, exclude = []) {
    const s = String(sender || '').toLowerCase().replace(/^@/, '');
    const list = this.rooms[room] || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (exclude.includes(m.id)) continue;
      if (beforeTs && (m.created_at || '') >= beforeTs) continue;
      if (String(m.from || '').toLowerCase().replace(/^@/, '') === s) return m;
    }
    return null;
  }

  /** This agent's own most recent post in the room, if within `withinMs`. */
  ownRecent(room, selfHandle, nowMs = Date.now(), withinMs = 2 * 3600 * 1000) {
    const m = this.previousFrom(room, selfHandle, null, []);
    if (!m) return null;
    const t = Date.parse(m.created_at || '');
    if (Number.isFinite(t) && nowMs - t > withinMs) return null;
    return m;
  }

  /**
   * Settled facts: any message whose body starts with "state:" or
   * "settled:" (case-insensitive), from anyone. Deduplicated on the text,
   * newest wins, at most `max` entries, oldest first.
   */
  stateEntries(room, max = 10) {
    const out = [];
    const seenText = new Set();
    const list = this.rooms[room] || [];
    for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
      const m = list[i];
      const hit = STATE_PREFIX.exec(m.body || '');
      if (!hit) continue;
      const text = oneLine(hit[1], 160);
      const key = text.toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);
      out.push({ from: m.from, created_at: m.created_at, text });
    }
    return out.reverse();
  }
}

/**
 * Single-line thread suffix for a message: the parent in full (well, 300
 * chars) with its author and time, then up to `maxChain` further ancestors
 * shorter. Falls back to the unresolved marker when neither the batch nor
 * the history knows the target. Single line by contract: the notification
 * file is one entry per physical line (see reply-context.mjs).
 */
export function threadSuffix(history, room, m, { maxChain = 2, firstLen = 300, chainLen = 150 } = {}) {
  const replyId = m._replyToId || replyIdOf(m.reply_to);
  if (!replyId) return '';
  let parent = history.get(room, replyId);
  let parts = [];
  if (parent) {
    parts.push(` ⤷ in reply to ${parent.from}${hhmm(parent.created_at) ? ' (' + hhmm(parent.created_at) + ')' : ''}: "${oneLine(parent.body, firstLen)}"`);
  } else if (m._replyTarget) {
    parts.push(` ⤷ in reply to ${m._replyTarget.from || '?'}: "${oneLine(m._replyTarget.body, firstLen)}"`);
  } else {
    return ` ⤷ a reply (target ${replyId} not in recent window)`;
  }
  let hops = 0;
  let cur = parent;
  while (cur && cur.reply_to && hops < maxChain) {
    const up = history.get(room, cur.reply_to);
    if (!up) break;
    parts.push(` ⤷⤷ ${up.from}: "${oneLine(up.body, chainLen)}"`);
    cur = up;
    hops++;
  }
  return parts.join('');
}

/**
 * The asker's previous message, when it is not already the reply target:
 * "what did this person say just before" is half the context of a follow-up.
 */
export function previousSuffix(history, room, m, { len = 200 } = {}) {
  const prev = history.previousFrom(room, m.from || m.sender, m.created_at, [m.id, m._replyToId].filter(Boolean));
  if (!prev) return '';
  return ` ⤷ ${prev.from}'s previous message${hhmm(prev.created_at) ? ' (' + hhmm(prev.created_at) + ')' : ''}: "${oneLine(prev.body, len)}"`;
}

/** One line per room per batch: the settled facts, or '' when there are none. */
export function stateOfPlayLine(history, room, nowIso = new Date().toISOString()) {
  const entries = history.stateEntries(room);
  if (entries.length === 0) return '';
  const body = entries.map((e) => `${e.text} (${String(e.from || '?').replace(/^@/, '')})`).join(' | ');
  return `[${nowIso.slice(0, 19)}] [${room}] STATE OF PLAY: ${body}`;
}

/** One line: what this agent itself last said here, so it does not re-answer. */
export function ownLastPostLine(history, room, selfHandle, nowIso = new Date().toISOString()) {
  const m = history.ownRecent(room, selfHandle, Date.parse(nowIso));
  if (!m) return '';
  return `[${nowIso.slice(0, 19)}] [${room}] YOUR LAST POST HERE (${hhmm(m.created_at)}): "${oneLine(m.body, 200)}"`;
}
