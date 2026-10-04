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
 * Crash safety, precisely: tests inject an exception at every page save and every state save
 * and require a full recovery. That covers a process dying between those steps; it is NOT a
 * power-loss / fsync guarantee (writes are not fsynced). Offline, search serves the archive
 * labelled stale; a server refusal (401/403/404) serves nothing. State files written before
 * gaps carried `until` keep the older id-based stop for those gaps.
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
    let newestKnown = null;
    for (const m of this.byId.values()) if (!newestKnown || String(m.created_at) > newestKnown) newestKnown = String(m.created_at);
    const state = this.loadState();
    // A gap is { before, until }: messages older than `before` and newer than `until` are missing.
    // `until` (the newest message of the archived block below the hole) is fixed when the gap is
    // opened, so healing stops by TIME. Stopping on "met an id I already have" was wrong: a crash
    // after a page was saved but before its cursor moved makes the next run re-fetch that page,
    // see known ids, and close the gap with the hole below still open (codexmb, reviews of #137).
    // Older state files stored bare cursors; those keep the id-based stop (until: null).
    const legacy = [...(Array.isArray(state.gaps) ? state.gaps : []), ...(state.gapCursor ? [state.gapCursor] : [])];
    state.gaps = legacy.map((g) => (typeof g === 'string' ? { before: g, until: null } : g)).filter((g) => g && g.before);
    delete state.gapCursor;
    let pages = 0, added = 0, before;
    let reachedStart = false;
    const oldestOf = (page) => page.reduce((a, m) => (!a || String(m.created_at) < String(a.created_at) ? m : a), null);
    const save = () => this.saveState(state);
    const removeGap = (g) => { state.gaps = state.gaps.filter((x) => x !== g); save(); };

    // Budget: with gaps pending, keep one page per call for healing (budget >= 2), or alternate
    // newest and healing calls (budget 1), so a tiny budget can never starve a hole forever.
    let p1Budget = maxPages;
    if (state.gaps.length) {
      if (maxPages >= 2) p1Budget = maxPages - 1;
      else { p1Budget = state.healTurn ? 0 : 1; state.healTurn = !state.healTurn; }
    }

    // 1) newest end. The gap under fresh pages is OPENED before the first page is saved (the hole
    //    lies below it); it is ADVANCED only after each further page is safely on disk.
    let p1 = null;
    while (pages < p1Budget) {
      const page = await fetchPage({ before });
      pages++;
      if (!page.length) { reachedStart = true; if (p1) removeGap(p1); p1 = null; break; }
      const overlaps = page.some((m) => m && known.has(m.id));
      const o = oldestOf(page);
      if (before && o.created_at === before) break;     // the server ignored before=: stop, do not loop
      const opensGap = !overlaps && known.size > 0 && page.length >= 100;
      if (opensGap && !p1) { p1 = { before: o.created_at, until: newestKnown }; state.gaps.push(p1); save(); }
      added += this.add(page);
      if (opensGap && p1.before !== o.created_at) { p1.before = o.created_at; save(); }
      before = o.created_at;
      if (page.length < 100) { reachedStart = true; if (p1) removeGap(p1); p1 = null; break; }
      if (overlaps) { if (p1) removeGap(p1); p1 = null; break; }
    }

    // 2) heal pending gaps, newest first. Each page is saved BEFORE the cursor moves; a crash in
    //    between re-fetches the page (appends are idempotent) and the time-based stop is unaffected.
    for (const g of [...state.gaps].sort((a, b) => String(b.before).localeCompare(String(a.before)))) {
      if (g === p1) continue;                            // opened by this run at the budget's end
      while (pages < maxPages) {
        const page = await fetchPage({ before: g.before });
        pages++;
        if (!page.length) { removeGap(g); reachedStart = true; break; }
        const o = oldestOf(page);
        if (o.created_at === g.before) break;            // ignored before=: keep the gap recorded
        added += this.add(page);
        const closed = g.until ? String(o.created_at) <= g.until : page.some((m) => m && known.has(m.id));
        if (closed) { removeGap(g); break; }
        if (page.length < 100) { removeGap(g); reachedStart = true; break; }
        g.before = o.created_at;
        save();
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
