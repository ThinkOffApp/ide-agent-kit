// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Room archive: a durable, searchable local copy of a GroupMind room's whole history.
 *
 * Why (petrus, 1 Oct 2026: "can you index the room so you have a memory here? add it to IAK"):
 * agents answer from whatever is in their context, and the room is far deeper than that. The
 * per-poller RoomHistory (src/common/room-history.mjs) keeps the last few hundred messages for
 * reply context; this archive keeps EVERYTHING it has seen, so "what did petrus say about the
 * display?" is a search, not a guess.
 *
 * Storage: one JSONL file per room (one message per line, append-only, deduped by id on load),
 * under `room_archive.dir` (default ~/.ide-agent-kit/room-archive). Nothing is ever deleted.
 *
 * Sync pages BACKWARDS with `before=<created_at>`: the room API returns newest-first pages of at
 * most 100 and ignores offset/page/until (they answer 200 with the same newest page, which looks
 * like success). The timestamp carries a "+00:00" offset, so it MUST be URL-encoded or the server
 * answers 500. An incremental sync stops at the first page that is entirely already-archived; a
 * backfill keeps going until the room's beginning or the page budget.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SECRET_PATTERNS } from './secret-patterns.mjs';

const KEEP = ['id', 'created_at', 'from', 'from_name', 'body', 'reply_to', 'image_url', 'file_url', 'file_name', 'isHuman'];

export function archiveDir(config = {}) {
  const dir = config?.room_archive?.dir || process.env.IAK_ROOM_ARCHIVE_DIR || join(homedir(), '.ide-agent-kit', 'room-archive');
  return dir.replace(/^~(?=\/|$)/, homedir());
}

function slim(m) {
  const out = {};
  for (const k of KEEP) if (m[k] !== undefined && m[k] !== null && m[k] !== '') out[k] = m[k];
  if (!out.from && m.user?.handle) out.from = m.user.handle;
  return out;
}

export class RoomArchive {
  constructor(room, { dir } = {}) {
    if (!room || /[\/\\]|\.\./.test(room)) throw new Error(`room archive: bad room slug ${JSON.stringify(room)}`);
    this.room = room;
    this.dir = dir || archiveDir();
    this.path = join(this.dir, `${room}.jsonl`);
    this.byId = new Map();
    this.load();
  }

  load() {
    this.byId.clear();
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m && m.id) this.byId.set(m.id, m);      // a later line for the same id wins (edits)
      } catch { /* a torn last line from a crash is skipped, not fatal */ }
    }
  }

  get size() { return this.byId.size; }

  /** Newest first. */
  messages() {
    return [...this.byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /** Append messages not yet archived (or whose body changed). Returns how many were new. */
  add(list) {
    const fresh = [];
    for (const raw of list || []) {
      if (!raw || !raw.id) continue;
      const m = slim(raw);
      const had = this.byId.get(m.id);
      if (had && had.body === m.body) continue;
      this.byId.set(m.id, m);
      fresh.push(m);
    }
    if (fresh.length) {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, fresh.map((m) => JSON.stringify(m)).join('\n') + '\n');
    }
    return fresh.filter((m) => m).length;
  }

  oldest() {
    let o = null;
    for (const m of this.byId.values()) if (!o || String(m.created_at) < String(o.created_at)) o = m;
    return o;
  }

  /**
   * Pull pages from the room. `fetchPage({before})` returns an array of messages (newest-first or
   * not; order is not trusted). Incremental by default: stops at the first page that adds nothing.
   * With `backfill`, continues from the archive's oldest message toward the room's beginning.
   */
  async sync(fetchPage, { maxPages = 50, backfill = false } = {}) {
    let pages = 0, added = 0, before;
    let reachedStart = false;
    // 1) newest end: walk back until a page brings nothing new
    while (pages < maxPages) {
      const page = await fetchPage({ before });
      pages++;
      if (!page.length) { reachedStart = true; break; }
      // A page that overlaps the archive means we have caught up with what is already stored.
      const overlaps = this.size > 0 && page.some((m) => m && this.byId.has(m.id));
      added += this.add(page);
      const oldestOnPage = page.reduce((a, m) => (!a || String(m.created_at) < String(a.created_at) ? m : a), null);
      before = oldestOnPage.created_at;
      if (page.length < 100) { reachedStart = true; break; }
      if (overlaps) break;
    }
    // 2) backfill: continue from the oldest archived message
    if (backfill && !reachedStart) {
      before = this.oldest()?.created_at;
      while (before && pages < maxPages) {
        const page = await fetchPage({ before });
        pages++;
        if (!page.length) { reachedStart = true; break; }
        added += this.add(page);
        const o = page.reduce((a, m) => (!a || String(m.created_at) < String(a.created_at) ? m : a), null);
        if (o.created_at === before) break;           // the server ignored before=: stop, do not loop
        before = o.created_at;
        if (page.length < 100) { reachedStart = true; break; }
      }
    }
    const oldest = this.oldest();
    return { room: this.room, added, total: this.size, pages, reachedStart, oldest: oldest?.created_at || null };
  }

  /**
   * Search. `query` words must ALL appear (case-insensitive) unless `regex` is set, in which case
   * `query` is a JavaScript regular expression (case-insensitive). Optional filters: from (handle,
   * with or without @), since/until (ISO prefixes). Newest first.
   */
  search(query, { regex = false, from, since, until, limit = 20 } = {}) {
    let test;
    if (regex) {
      const re = new RegExp(query, 'i');
      test = (s) => re.test(s);
    } else {
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      test = (s) => { const l = s.toLowerCase(); return words.every((w) => l.includes(w)); };
    }
    const who = from ? String(from).replace(/^@+/, '').toLowerCase() : null;
    const hits = [];
    let matched = 0;
    for (const m of this.messages()) {
      if (since && String(m.created_at) < since) continue;
      if (until && String(m.created_at) > until) continue;
      if (who && String(m.from || '').replace(/^@+/, '').toLowerCase() !== who) continue;
      if (!test(String(m.body || ''))) continue;
      matched++;
      if (hits.length < limit) hits.push(m);
    }
    const all = this.messages();
    return {
      room: this.room,
      matched,
      shown: hits.length,
      // Scope is part of the answer: 0 hits means "not in the archive", never "never said".
      scope: { messages: this.size, oldest: all.length ? all[all.length - 1].created_at : null, newest: all.length ? all[0].created_at : null },
      hits,
    };
  }
}

/** fetchPage for the GroupMind API: newest-first pages of up to 100, `before` URL-encoded. */
export function groupmindPageFetcher({ baseUrl, apiKey, room, timeoutMs = 15000 }) {
  return async ({ before } = {}) => {
    const q = new URLSearchParams({ limit: '100' });
    if (before) q.set('before', before);          // URLSearchParams encodes "+" as %2B
    const res = await fetch(`${baseUrl}/rooms/${encodeURIComponent(room)}/messages?${q}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`room archive: HTTP ${res.status} ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : (data.messages || []);
  };
}

/**
 * Replace credential-looking values in `text` with "[redacted: <kind>]" for tool output. The
 * archive itself keeps the room verbatim (it is evidence); only what is handed to a caller is
 * redacted, and the caller is told how many values were replaced and of which kinds, so a
 * redaction is never silent.
 */
export function redactSecrets(text) {
  let out = String(text || '');
  const kinds = [];
  for (const [re, label] of SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    out = out.replace(g, () => { kinds.push(label); return `[redacted: ${label}]`; });
  }
  return { text: out, kinds };
}
