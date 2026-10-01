// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomArchive, groupmindPageFetcher, redactSecrets } from '../src/room-archive.mjs';
import { archivableRooms } from '../src/mcp-server.mjs';

const R = 'thinkoff-development';
const dir = () => mkdtempSync(join(tmpdir(), 'iak-archive-'));

// A fake room of n messages, m0 oldest. Pages are newest-first, at most 100, strictly before `before`.
function fakeRoom(n, { ignoreBefore = false } = {}) {
  const all = Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString().replace('Z', '+00:00'),
    from: i % 3 === 0 ? 'petrus' : '@claudeMB',
    body: i === 7 ? 'the 5 inch display is pretty cool' : `message number ${i}`,
  }));
  let calls = 0;
  const fetchPage = async ({ before } = {}) => {
    calls++;
    const older = ignoreBefore || !before ? all : all.filter((m) => m.created_at < before);
    return older.slice(-100).reverse();
  };
  return { all, fetchPage, calls: () => calls, push: (m) => all.push(m) };
}

describe('room archive (petrus 1 Oct 2026: "index the room so you have a memory")', () => {
  it('backfills the whole room through before= pages and knows it reached the start', async () => {
    const room = fakeRoom(250);
    const a = new RoomArchive(R, { dir: dir() });
    const r = await a.sync(room.fetchPage, { maxPages: 10, backfill: true });
    assert.equal(r.total, 250);
    assert.equal(r.reachedStart, true);
    assert.equal(r.oldest, room.all[0].created_at);
  });

  it('an incremental sync stops at the first page with nothing new', async () => {
    const room = fakeRoom(250);
    const a = new RoomArchive(R, { dir: dir() });
    await a.sync(room.fetchPage, { maxPages: 10, backfill: true });
    room.push({ id: 'new1', created_at: '2026-09-02T00:00:00+00:00', from: 'petrus', body: 'fresh' });
    const before = room.calls();
    const r = await a.sync(room.fetchPage, { maxPages: 10 });
    assert.equal(r.added, 1);
    assert.equal(room.calls() - before, 1, 'one page was enough');
  });

  it('does not loop when the server ignores before= (it answers the same newest page)', async () => {
    const room = fakeRoom(300, { ignoreBefore: true });
    const a = new RoomArchive(R, { dir: dir() });
    const r = await a.sync(room.fetchPage, { maxPages: 50, backfill: true });
    assert.ok(r.pages <= 3, `stopped early, used ${r.pages} pages`);
    assert.equal(r.total, 100);
    assert.equal(r.reachedStart, false, 'and does not claim the start was reached');
  });

  it('searches all words, regex, author and date, newest first, and reports its scope', async () => {
    const room = fakeRoom(50);
    const a = new RoomArchive(R, { dir: dir() });
    await a.sync(room.fetchPage, { maxPages: 5, backfill: true });
    assert.equal(a.search('5 inch display').matched, 1);
    assert.equal(a.search('display 5 INCH').matched, 1, 'word order and case do not matter');
    assert.equal(a.search('inch keyboard').matched, 0, 'every word must appear');
    assert.equal(a.search('number [0-9]$', { regex: true }).matched, 9);
    const byPetrus = a.search('message', { from: '@petrus' });
    assert.ok(byPetrus.hits.every((m) => m.from === 'petrus'));
    const late = a.search('message', { since: room.all[45].created_at });
    assert.equal(late.matched, 5);
    const s = a.search('message', { limit: 3 });
    assert.equal(s.shown, 3);
    assert.ok(s.hits[0].created_at > s.hits[1].created_at, 'newest first');
    assert.equal(s.scope.messages, 50);
    assert.equal(s.scope.oldest, room.all[0].created_at);
  });

  it('persists, dedupes by id on reload, keeps an edit, and survives a torn last line', async () => {
    const d = dir();
    const room = fakeRoom(20);
    const a = new RoomArchive(R, { dir: d });
    await a.sync(room.fetchPage, { maxPages: 2, backfill: true });
    assert.equal(a.add(room.all.slice(0, 5)), 0, 'already archived');
    assert.equal(a.add([{ ...room.all[3], body: 'edited' }]), 1);
    appendFileSync(a.path, '{"id":"torn","bo');
    const b = new RoomArchive(R, { dir: d });
    assert.equal(b.size, 20);
    assert.equal(b.search('edited').matched, 1);
    assert.match(readFileSync(a.path, 'utf8'), /"id":"m0"/);
  });

  it('refuses a room slug that could escape the archive directory', () => {
    assert.throws(() => new RoomArchive('../etc', { dir: dir() }), /bad room slug/);
  });

  it('redacts credential-looking values for output and says which kinds', () => {
    const r = redactSecrets(`token antfarm_${'a'.repeat(40)} and ghp_${'b'.repeat(36)}`);
    assert.doesNotMatch(r.text, /antfarm_a|ghp_b/);
    assert.deepEqual(r.kinds.sort(), ['GitHub token', 'GroupMind room key']);
    assert.deepEqual(redactSecrets('nothing secret here').kinds, []);
  });

  it('archives only the rooms this agent is configured for', () => {
    assert.deepEqual(archivableRooms({ poller: { rooms: ['a', 'b'] }, mcp: { confirmations: { room: 'c' } } }).sort(), ['a', 'b', 'c']);
    assert.deepEqual(archivableRooms({}), []);
  });

  it('encodes the "+00:00" timestamp in before= (an unencoded + becomes a space and the server answers 500)', async () => {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: true, text: async () => '{"messages":[]}' }; };
    try {
      const f = groupmindPageFetcher({ baseUrl: 'https://example.test/api/v1', apiKey: 'k', room: R });
      await f({ before: '2026-09-30T23:59:01.918981+00:00' });
    } finally {
      globalThis.fetch = real;
    }
    assert.match(seen[0], /before=2026-09-30T23%3A59%3A01\.918981%2B00%3A00/);
    assert.match(seen[0], /limit=100/);
  });
});
