// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomArchive, groupmindPageFetcher, redactSecrets, redactMessage } from '../src/room-archive.mjs';
import { archivableRooms, roomSearchTool } from '../src/mcp-server.mjs';

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

  // codexmb's review of #137 (1 Oct 2026): each reproduction below failed on f318eb0.
  it('heals a gap left when the page budget ran out before reaching the archive', async () => {
    const room = fakeRoom(700);
    const a = new RoomArchive(R, { dir: dir() });
    a.add(room.all.slice(0, 100));                       // archive holds m0..m99
    const first = await a.sync(room.fetchPage, { maxPages: 5 });
    assert.equal(first.total, 600);                      // m200..m699 + m0..m99: m100..m199 missing
    assert.equal(first.gapPending, true, 'the hole is reported, not hidden');
    const second = await a.sync(room.fetchPage, { maxPages: 5 });
    assert.equal(second.total, 700, 'the next sync fills m100..m199');
    assert.equal(second.gapPending, false);
    assert.ok(a.byId.has('m150'));
  });

  it('keeps every open gap when a second budget exhaustion happens before the first heals', async () => {
    const all = fakeRoom(1300).all;                      // codexmb's re-review reproduction
    let visible = 700;
    const fetchPage = async ({ before } = {}) => {
      const pool = all.slice(0, visible);
      const older = before ? pool.filter((m) => m.created_at < before) : pool;
      return older.slice(-100).reverse();
    };
    const a = new RoomArchive(R, { dir: dir() });
    a.add(all.slice(0, 100));
    assert.equal((await a.sync(fetchPage, { maxPages: 5 })).total, 600);
    visible = 1300;
    const second = await a.sync(fetchPage, { maxPages: 5 });
    assert.equal(second.gapPending, true);
    let r = second;
    for (let i = 0; i < 5 && r.gapPending; i++) r = await a.sync(fetchPage, { maxPages: 5 });
    assert.equal(r.total, 1300, 'both holes healed');
    assert.ok(a.byId.has('m150') && a.byId.has('m750'));
    assert.equal(r.gapPending, false);
  });

  it('records the gap before appending, so a failure after page 1 cannot lose the hole', async () => {
    const d = dir();
    const room = fakeRoom(700);                          // codexmb's third reproduction
    const a = new RoomArchive(R, { dir: d });
    a.add(room.all.slice(0, 100));
    let calls = 0;
    const flaky = async (args) => { if (++calls === 2) throw new Error('ECONNRESET'); return room.fetchPage(args); };
    await assert.rejects(a.sync(flaky, { maxPages: 5 }), /ECONNRESET/);
    const b = new RoomArchive(R, { dir: d });            // reload, as after a restart
    let r;
    for (let i = 0; i < 4; i++) { r = await b.sync(room.fetchPage, { maxPages: 5 }); if (!r.gapPending) break; }
    assert.equal(r.total, 700);
    assert.ok(b.byId.has('m150'));
    assert.equal(r.gapPending, false);
  });

  it('a crash while healing a gap never skips the page it was fetching', async () => {
    const d = dir();
    const room = fakeRoom(700);
    const a = new RoomArchive(R, { dir: d });
    a.add(room.all.slice(0, 100));
    await a.sync(room.fetchPage, { maxPages: 5 });        // leaves the m100..m199 gap
    const b = new RoomArchive(R, { dir: d });
    const realAdd = b.add.bind(b);
    let n = 0;
    b.add = (list) => { if (++n === 2) throw new Error('crash mid-heal'); return realAdd(list); };
    await assert.rejects(b.sync(room.fetchPage, { maxPages: 5 }), /crash mid-heal/);
    const c = new RoomArchive(R, { dir: d });
    let r;
    for (let i = 0; i < 4; i++) { r = await c.sync(room.fetchPage, { maxPages: 5 }); if (!r.gapPending) break; }
    assert.equal(r.total, 700);
    assert.ok(c.byId.has('m150'));
  });

  it('a crash between saving a fresh page and advancing the gap never loses that page (stage 1)', async () => {
    const d = dir();
    const room = fakeRoom(700);                          // codexmb's fourth reproduction
    const a = new RoomArchive(R, { dir: d });
    a.add(room.all.slice(0, 100));
    const realAdd = a.add.bind(a);
    let n = 0;
    a.add = (list) => { if (++n === 2) throw new Error('crash before page 2 is saved'); return realAdd(list); };
    await assert.rejects(a.sync(room.fetchPage, { maxPages: 5 }), /crash/);
    const b = new RoomArchive(R, { dir: d });
    let r;
    for (let i = 0; i < 6; i++) { r = await b.sync(room.fetchPage, { maxPages: 5 }); if (!r.gapPending && r.total === 700) break; }
    assert.equal(r.total, 700);
    assert.ok(b.byId.has('m550'));
  });

  it('a crash after a healing page is saved but before the cursor moves never closes the gap early', async () => {
    const d = dir();
    const room = fakeRoom(1000);
    const a = new RoomArchive(R, { dir: d });
    a.add(room.all.slice(0, 100));
    await a.sync(room.fetchPage, { maxPages: 3 });        // archive m700..m999 + m0..m99, gap m100..m699
    const b = new RoomArchive(R, { dir: d });
    const realSave = b.saveState.bind(b);
    let saves = 0;
    b.saveState = (st) => { if (++saves === 1) throw new Error('crash after the page was saved'); return realSave(st); };
    await assert.rejects(b.sync(room.fetchPage, { maxPages: 5 }), /crash/);
    const c = new RoomArchive(R, { dir: d });
    let r;
    for (let i = 0; i < 8; i++) { r = await c.sync(room.fetchPage, { maxPages: 5 }); if (!r.gapPending && r.total === 1000) break; }
    assert.equal(r.total, 1000, 're-fetching an archived page did not close the gap');
    assert.ok(c.byId.has('m150'));
  });

  it('recovers the full room after a crash at ANY page-save or state-save point', async () => {
    // Exhaustive: crash at every add() and every saveState() call of a gap-producing workload,
    // restart, and require the whole room. One test instead of one per review finding.
    for (const what of ['add', 'saveState']) {
      for (let k = 1; k <= 14; k++) {
        const d = dir();
        const room = fakeRoom(900);
        const seed = new RoomArchive(R, { dir: d });
        seed.add(room.all.slice(0, 100));
        const a = new RoomArchive(R, { dir: d });
        const real = a[what].bind(a);
        let n = 0;
        a[what] = (...args) => { if (++n === k) throw new Error(`crash at ${what} #${k}`); return real(...args); };
        try { await a.sync(room.fetchPage, { maxPages: 3 }); await a.sync(room.fetchPage, { maxPages: 3 }); } catch { /* crashed */ }
        const b = new RoomArchive(R, { dir: d });
        let r;
        for (let i = 0; i < 12; i++) { r = await b.sync(room.fetchPage, { maxPages: 3 }); if (!r.gapPending && r.total === 900) break; }
        assert.equal(r.total, 900, `crash at ${what} #${k} lost messages`);
      }
    }
  });

  it('a budget of one page still heals a gap, alternating with the newest end (after a reload)', async () => {
    const d = dir();
    const room = fakeRoom(700);                          // codexmb: maxPages 1 never reached healing
    const a = new RoomArchive(R, { dir: d });
    a.add(room.all.slice(0, 100));
    assert.equal((await a.sync(room.fetchPage, { maxPages: 5 })).gapPending, true);
    const b = new RoomArchive(R, { dir: d });
    let r;
    for (let i = 0; i < 30; i++) { r = await b.sync(room.fetchPage, { maxPages: 1 }); if (!r.gapPending) break; }
    assert.equal(r.gapPending, false);
    assert.equal(r.total, 700);
    room.push({ id: 'late', created_at: '2026-09-03T00:00:00+00:00', from: 'petrus', body: 'after healing' });
    await b.sync(room.fetchPage, { maxPages: 1 });
    assert.ok(b.byId.has('late'), 'and the newest end is still served');
  });

  it('keeps the next record after a crash left a torn last line', () => {
    const d = dir();
    const a = new RoomArchive(R, { dir: d });
    a.add([{ id: 'id1', created_at: '2026-09-01T00:00:01+00:00', body: 'one' }]);
    appendFileSync(a.path, '{"id":"torn","bo');           // crash mid-write, no newline
    const b = new RoomArchive(R, { dir: d });
    b.add([{ id: 'id2', created_at: '2026-09-01T00:00:02+00:00', body: 'two' }]);
    const c = new RoomArchive(R, { dir: d });
    assert.ok(c.byId.has('id1') && c.byId.has('id2'), 'id2 was not glued onto the fragment');
    assert.equal(c.size, 2);
  });

  it('redacts every string field it returns, not only the body', () => {
    const tok = `ghp_${'c'.repeat(36)}`;
    const r = redactMessage({ id: 'x', body: 'fine', from_name: tok, file_url: `https://f.test/${tok}`, image_url: tok, file_name: tok });
    assert.doesNotMatch(JSON.stringify(r.message), /ghp_c/);
    assert.equal(r.kinds.length, 4);
    assert.equal(r.message.body, 'fine');
  });

  it('keeps the archive owner-only, and tightens an existing world-readable file', () => {
    const d = dir();
    const a = new RoomArchive(R, { dir: d });
    a.add([{ id: 'p1', created_at: '2026-09-01T00:00:01+00:00', body: 'private' }]);
    assert.equal(statSync(a.path).mode & 0o777, 0o600);
    assert.equal(statSync(d).mode & 0o777, 0o700);
    chmodSync(a.path, 0o644);                             // as an older version left it
    chmodSync(d, 0o755);
    new RoomArchive(R, { dir: d });                       // loading an old 0644 archive tightens it
    assert.equal(statSync(a.path).mode & 0o777, 0o600);
    assert.equal(statSync(d).mode & 0o777, 0o700);
  });

  it('marks access refusals so callers stop returning archived text (401/403/404)', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
    try {
      const f = groupmindPageFetcher({ baseUrl: 'https://example.test/api/v1', apiKey: 'k', room: R });
      await assert.rejects(f({ limit: 1 }), (e) => e.status === 403);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('room_search access policy, end to end through roomSearchTool (codexmb re-review)', () => {
  const cfg = (d) => ({ poller: { rooms: [R], api_key: 'k' }, groupmind: { base_url: 'https://example.test/api/v1' }, room_archive: { dir: d } });
  async function withFetch(fake, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try { return await fn(); } finally { globalThis.fetch = real; }
  }
  const page = (msgs) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ messages: msgs }) });
  const refused = (status) => async () => ({ ok: false, status, text: async () => 'no' });
  const seed = [{ id: 's1', created_at: '2026-09-01T00:00:01+00:00', from: 'petrus', body: 'the secret plan' }];

  for (const status of [401, 403, 404]) {
    it(`returns no archived text when the server answers ${status}, with sync on or off`, async () => {
      const d = dir();
      await withFetch(page(seed), () => roomSearchTool(cfg(d), { query: 'secret plan' }));
      for (const sync of [true, false]) {
        const r = await withFetch(refused(status), () => roomSearchTool(cfg(d), { query: 'secret plan', sync }));
        assert.match(r.error, new RegExp(`HTTP ${status}`));
        assert.equal(r.payload, undefined);
        assert.doesNotMatch(JSON.stringify(r), /secret plan"/);
      }
    });
  }

  it('returns the archive, labelled stale, when the server cannot be reached', async () => {
    const d = dir();
    await withFetch(page(seed), () => roomSearchTool(cfg(d), { query: 'secret plan' }));
    const r = await withFetch(async () => { throw new Error('ECONNRESET'); }, () => roomSearchTool(cfg(d), { query: 'secret plan' }));
    assert.equal(r.payload.matched, 1);
    assert.match(r.payload.synced.note, /last successful sync/);
  });

  it('refuses a room that is not in this config, before any request', async () => {
    let calls = 0;
    const r = await withFetch(async () => { calls++; return page([])(); }, () => roomSearchTool(cfg(dir()), { query: 'x', room: 'someone-elses-room' }));
    assert.match(r.error, /not one of this agent's configured rooms/);
    assert.equal(calls, 0);
  });
});
