// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomHistory, threadSuffix, previousSuffix, stateOfPlayLine, ownLastPostLine } from '../src/common/room-history.mjs';
import { resolveReplyTargets } from '../src/common/reply-context.mjs';
import { seedRoom } from '../src/team-relay/room-poller.mjs';

const R = 'thinkoff-development';
function msg(id, from, body, created_at, reply_to) {
  return { id, from, body, created_at, reply_to };
}
function fresh() {
  return new RoomHistory(join(mkdtempSync(join(tmpdir(), 'iak-hist-')), 'h.json'), { maxPerRoom: 5 });
}

describe('room-history (issue #90: the thread, not the window)', () => {
  it('remembers across polls, persists, dedupes by id and caps per room', () => {
    const h = fresh();
    h.remember(R, [msg('a', 'petrus', 'one', '2026-09-01T19:00:00Z')]);
    h.remember(R, [msg('a', 'petrus', 'one edited', '2026-09-01T19:00:00Z'), msg('b', '@x', 'two', '2026-09-01T19:01:00Z')]);
    assert.equal(h.get(R, 'a').body, 'one edited');
    assert.ok(h.save());
    const again = new RoomHistory(h.path);
    assert.equal(again.get(R, 'b').from, '@x');
    for (let i = 0; i < 10; i++) h.remember(R, [msg('m' + i, '@x', 'n' + i, `2026-09-01T20:0${i}:00Z`.slice(0, 20))]);
    assert.equal(h.rooms[R].length, 5);
    assert.equal(h.get(R, 'a'), null, 'oldest evicted');
  });

  it('resolves a reply target older than the fetch window via lookup', () => {
    const h = fresh();
    // poll 1: the parent passes by
    h.remember(R, [msg('card', '@claudeMB', 'Card v2 for your review, nothing published by me. Changes: M5 solo column re-measured...', '2026-09-01T15:46:19Z')]);
    // poll 2: only the reply is in the window
    const batch = [msg('reply', 'petrus', 'Yeah you have a new card which I cant post', '2026-09-01T19:04:46Z', 'card')];
    resolveReplyTargets(batch, (id) => h.get(R, id));
    assert.equal(batch[0]._replyTarget.from, '@claudeMB');
    assert.ok(batch[0]._replyTarget.body.startsWith('Card v2 for your review'));
    const suffix = threadSuffix(h, R, batch[0]);
    assert.ok(suffix.includes('in reply to @claudeMB (15:46)'), suffix);
    assert.ok(suffix.includes('Card v2 for your review, nothing published by me'), suffix);
    assert.ok(!suffix.includes('\n'), 'single line by contract');
  });

  it('walks the chain above the parent, bounded, and stays single-line', () => {
    const h = fresh();
    h.remember(R, [
      msg('g', 'petrus', 'grand\nparent', '2026-09-01T10:00:00Z'),
      msg('p', '@x', 'parent', '2026-09-01T10:01:00Z', 'g'),
      msg('c', 'petrus', 'child', '2026-09-01T10:02:00Z', 'p')
    ]);
    const s = threadSuffix(h, R, h.get(R, 'c') && { id: 'c', from: 'petrus', reply_to: 'p', _replyToId: 'p' });
    assert.ok(s.includes('in reply to @x (10:01): "parent"'), s);
    assert.ok(s.includes('⤷⤷ petrus: "grand parent"'), s);
    assert.ok(!s.includes('\n'));
  });

  it('falls back to the unresolved marker when nobody knows the target', () => {
    const h = fresh();
    const s = threadSuffix(h, R, { id: 'z', reply_to: 'ghost', _replyToId: 'ghost' });
    assert.ok(s.includes('target ghost not in recent window'), s);
  });

  it("gives the asker's previous message, not the reply target, and skips self", () => {
    const h = fresh();
    h.remember(R, [
      msg('p1', 'petrus', 'I found only these what more shall i order', '2026-09-01T20:56:03Z'),
      msg('a1', '@claudeMB', 'Found on the table...', '2026-09-01T20:59:15Z'),
      msg('p2', 'petrus', 'I reorder this one?', '2026-09-01T21:14:53Z')
    ]);
    const m = { id: 'p2', from: 'petrus', created_at: '2026-09-01T21:14:53Z' };
    const s = previousSuffix(h, R, m);
    assert.ok(s.includes("petrus's previous message (20:56)"), s);
    assert.ok(s.includes('what more shall i order'), s);
    assert.equal(previousSuffix(h, R, { id: 'p1', from: 'petrus', created_at: '2026-09-01T20:56:03Z' }), '');
  });

  it('collects state: lines, dedupes, caps, renders one line', () => {
    const h = fresh();
    h.remember(R, [
      msg('s1', '@claudeMB', 'state: "card" means the benchmark table v2, not hardware', '2026-09-01T19:37:00Z'),
      msg('n1', 'hermes', 'Got it, I cannot see the card either', '2026-09-01T19:38:00Z'),
      msg('s2', '@claudemm', 'Settled: BIOS carve fix waits for Petrus in Helsinki', '2026-09-01T19:40:00Z'),
      msg('s3', 'petrus', 'state: "card" means the benchmark table v2, not hardware', '2026-09-01T19:41:00Z')
    ]);
    const e = h.stateEntries(R);
    assert.equal(e.length, 2, 'duplicate text collapsed');
    // newest occurrence of a duplicate wins, entries are oldest-first
    assert.deepEqual(e.map((x) => x.text), [
      'BIOS carve fix waits for Petrus in Helsinki',
      '"card" means the benchmark table v2, not hardware'
    ]);
    assert.equal(e[1].from, 'petrus', 'the newest sender of the duplicated fact');
    const line = stateOfPlayLine(h, R, '2026-09-01T20:00:00Z');
    assert.ok(line.startsWith(`[2026-09-01T20:00:00] [${R}] STATE OF PLAY: `), line);
    assert.ok(line.includes('BIOS carve fix waits for Petrus in Helsinki (claudemm)'), line);
    assert.ok(!line.includes('\n'));
    assert.equal(stateOfPlayLine(fresh(), R), '');
  });

  it("renders the agent's own last post when recent, nothing when stale or absent", () => {
    const h = fresh();
    h.remember(R, [msg('o1', '@claudeMB', 'PR 24 is ready to merge', '2026-09-01T21:36:24Z')]);
    const line = ownLastPostLine(h, R, '@claudemb', '2026-09-01T21:50:00Z');
    assert.ok(line.includes('YOUR LAST POST HERE (21:36): "PR 24 is ready to merge"'), line);
    assert.equal(ownLastPostLine(h, R, '@claudemb', '2026-09-02T09:00:00Z'), '', 'older than two hours');
    assert.equal(ownLastPostLine(h, R, '@nobody', '2026-09-01T21:50:00Z'), '');
  });
});


describe('first-run seed keeps the thread (codexmb, PR #92)', () => {
  it('seeded messages are both seen and remembered, so a reply to one resolves on the next poll', () => {
    const h = fresh();
    const seen = new Set();
    const seeded = [
      msg('old1', '@claudeMB', 'Card v2 for your review', '2026-09-01T15:46:19Z'),
      msg('old2', 'petrus', 'But these people get 15 tps?', '2026-09-01T18:53:35Z')
    ];
    assert.equal(seedRoom({ seen, history: h, room: R, msgs: seeded }), 2);
    assert.ok(seen.has('old1') && seen.has('old2'));
    assert.equal(seedRoom({ seen, history: h, room: R, msgs: seeded }), 0, 'idempotent');
    // next poll: only the reply is in the window
    const batch = [msg('new', 'petrus', 'you have a new card which I cant post', '2026-09-01T19:04:46Z', 'old1')];
    resolveReplyTargets(batch, (id) => h.get(R, id));
    assert.equal(batch[0]._replyTarget.from, '@claudeMB');
    assert.ok(threadSuffix(h, R, batch[0]).includes('Card v2 for your review'));
  });
});
