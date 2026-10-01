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
 * under `room_archive.dir` (default ~/.ide-agent-kit/room-archive), directory 0700 and files 0600
 * (the room can hold private material). Nothing is ever deleted. A small <room>.state.json keeps
 * an unfinished sync's resume point, so a page budget that runs out never leaves a permanent gap.
 *
 * It is a SNAPSHOT: a message edited after it was archived (and older than the next sync's
 * overlap) and a deleted message are not reconciled. Search results say so.
 *
 * Sync pages BACKWARDS with `before=<created_at>`: the room API returns newest-first pages of at
 * most 100 and ignores offset/page/until (they answer 200 with the same newest page, which looks
 * like success). The timestamp carries a "+00:00" offset, so it MUST be URL-encoded or the server
 * answers 500. An incremental sync stops at the first page that is entirely already-archived; a
 * backfill keeps going until the room's beginning or the page budget.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
    this.statePath = join(this.dir, `${room}.state.json`);
    this.byId = new Map();
    this.load();
  }

  /** Owner-only directory and files, including ones an older version created 0755/0644. */
  ensurePrivate() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    for (const f of [this.path, this.statePath]) if (existsSync(f)) chmodSync(f, 0o600);
  }

  loadState() {
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) || {}; } catch { return {}; }
  }

  saveState(state) {
    this.ensurePrivate();
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  load() {
    this.byId.clear();
    if (!existsSync(this.path)) return;
    this.ensurePrivate();
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
      this.ensurePrivate();
      // A crash can leave a torn last line with no newline; appending straight after it would glue
      // the next record onto the fragment and lose it on reload. Close the fragment's line first.
      if (existsSync(this.path) && statSync(this.path).size > 0) {
        const fd = openSync(this.path, 'r');
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, statSync(this.path).size - 1);
        closeSync(fd);
        if (last[0] !== 0x0a) appendFileSync(this.path, '\n');
      }
      appendFileSync(this.path, fresh.map((m) => JSON.stringify(m)).join('\n') + '\n', { mode: 0o600 });
    }
    return fresh.length;
  }

  oldest() {
    let o = null;
    for (const m of this.byId.values()) if (!o || String(m.created_at) < String(o.created_at)) o = m;
    return o;
  }

  /**
   * Pull pages from the room. `fetchPage({before})` returns an array of messages (order not
   * trusted). Three walks, all within one page budget:
   *  1. newest end, back until a page overlaps what was archived BEFORE this run;
   *  2. a pending gap: if an earlier run spent its budget before reaching the archive, it saved
   *     where it stopped (state.gapCursor); continue from there until the older block is met;
   *  3. with `backfill`, from the archive's oldest message toward the room's first.
   * Returns gapPending when a gap is still open, so a caller knows the archive has a hole.
   */
  async sync(fetchPage, { maxPages = 50, backfill = false } = {}) {
    const known = new Set(this.byId.keys());
    const state = this.loadState();
    // Gaps are a LIST and are written to disk BEFORE the page that opens or extends them is
    // appended, so a crash or network error mid-sync never leaves archived pages above an
    // unrecorded hole (codexmb, re-reviews of #137). The old single-cursor format is migrated.
    state.gaps = [...new Set([...(Array.isArray(state.gaps) ? state.gaps : []), ...(state.gapCursor ? [state.gapCursor] : [])])];
    delete state.gapCursor;
    let pages = 0, added = 0, before;
    let reachedStart = false;
    const oldestOf = (page) => page.reduce((a, m) => (!a || String(m.created_at) < String(a.created_at) ? m : a), null);
    const setGap = (from, to) => {                     // replace gap `from` with `to` (null removes), persist
      const i = from ? state.gaps.indexOf(from) : -1;
      if (i >= 0) state.gaps.splice(i, 1);
      if (to) state.gaps.push(to);
      this.saveState(state);
    };

    // 1) newest end
    let p1gap = null;
    while (pages < maxPages) {
      const page = await fetchPage({ before });
      pages++;
      if (!page.length) { reachedStart = true; setGap(p1gap, null); p1gap = null; break; }
      const overlaps = page.some((m) => m && known.has(m.id));
      const o = oldestOf(page);
      if (before && o.created_at === before) break;     // the server ignored before=: stop, do not loop
      if (!overlaps && known.size > 0 && page.length >= 100) { setGap(p1gap, o.created_at); p1gap = o.created_at; }
      added += this.add(page);
      before = o.created_at;
      if (page.length < 100) { reachedStart = true; setGap(p1gap, null); p1gap = null; break; }
      if (overlaps) { setGap(p1gap, null); p1gap = null; break; }
    }

    // 2) heal pending gaps, newest first, persisting progress after every page. Opening a gap
    //    records it BEFORE the page is appended (the hole is below that page); healing appends
    //    BEFORE the cursor moves (the hole shrinks only once the page is safely on disk).
    for (const start of [...state.gaps].sort().reverse()) {
      let g = start;
      while (pages < maxPages) {
        const page = await fetchPage({ before: g });
        pages++;
        if (!page.length) { setGap(g, null); reachedStart = true; break; }
        const meets = page.some((m) => m && known.has(m.id));
        const o = oldestOf(page);
        if (o.created_at === g) break;                  // ignored before=: keep the gap recorded
        const next = meets || page.length < 100 ? null : o.created_at;
        // Append FIRST, then move the cursor: a crash in between re-fetches the same page (appends
        // are idempotent by id), whereas moving the cursor first would skip this page for good.
        added += this.add(page);
        setGap(g, next);
        if (!next) { if (page.length < 100 && !meets) reachedStart = true; break; }
        g = next;
      }
    }

    // 3) backfill toward the room's first message
    if (backfill && !reachedStart) {
      before = this.oldest()?.created_at;
      while (before && pages < maxPages) {
        const page = await fetchPage({ before });
        pages++;
        if (!page.length) { reachedStart = true; break; }
        added += this.add(page);
        const o = oldestOf(page);
        if (o.created_at === before) break;
        before = o.created_at;
        if (page.length < 100) { reachedStart = true; break; }
      }
    }
    this.saveState(state);
    const oldest = this.oldest();
    return { room: this.room, added, total: this.size, pages, reachedStart, gapPending: state.gaps.length > 0, gaps: state.gaps.length,
             oldest: oldest?.created_at || null };
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
  return async ({ before, limit = 100 } = {}) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', before);          // URLSearchParams encodes "+" as %2B
    const res = await fetch(`${baseUrl}/rooms/${encodeURIComponent(room)}/messages?${q}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`room archive: HTTP ${res.status} ${text.slice(0, 200)}`);
      e.status = res.status;                         // 401/403/404 = access refused, not a network blip
      throw e;
    }
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

/** Redact every string field of a message (body, from_name, file names and URLs), for output. */
export function redactMessage(m) {
  const kinds = [];
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      kinds.push(...r.kinds);
      out[k] = r.text;
    } else {
      out[k] = v;
    }
  }
  return { message: out, kinds };
}

/** HTTP statuses that mean "this agent may no longer read the room", as opposed to a network blip. */
export const ACCESS_REFUSED = new Set([401, 403, 404]);
