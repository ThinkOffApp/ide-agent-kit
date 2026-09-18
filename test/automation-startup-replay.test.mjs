// Execution-level startup tests for the privileged dispatch path.
//
// Asked for by @codexmb: "cover existing-state/new-room startup, atomic
// persistence failure, and two concurrent processes with execution-level tests
// before calling privileged dispatch safe. Handle tests alone do not exercise
// poller startup/replay."
//
// These drive startRoomAutomation itself against a stub room server and count
// what it POSTS. A message that is never dispatched leaves no post; a replayed
// one leaves two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoomAutomation, __setApiBaseForTest } from '../src/room-automation.mjs';

// A stub GroupMind: serves whatever messages each room is configured with and
// records every POST, so "did it dispatch" is observed rather than inferred.
function stubRoom({ rooms, failRooms = new Set() }) {
  // failRooms is mutated between runs by the tests that need a room to break.
  const posts = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      let b = ''; req.on('data', c => (b += c));
      req.on('end', () => { posts.push(JSON.parse(b || '{}')); res.writeHead(200, {'Content-Type':'application/json'}); res.end('{}'); });
      return;
    }
    const m = url.pathname.match(/\/rooms\/([^/]+)\/messages/);
    const room = m && decodeURIComponent(m[1]);
    if (!room || failRooms.has(room)) { res.writeHead(500); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: rooms[room] || [] }));
  });
  return { server, posts };
}

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function cfg(dir, rooms, extra = {}) {
  return {
    poller: { owner_handle: 'petrus', handle: '@claudemm' },
    automation: {
      seen_file: join(dir, 'seen.txt'),
      interval_sec: 3600,          // one poll; the test drives it
      rules: [{ name: 'echo', match: { sender: 'petrus' }, action: { type: 'post', body: 'ack' } }],
      ...extra,
    },
    receipts: { path: join(dir, 'receipts.jsonl') },
    ...({}),
  };
}

const msg = (id, body) => ({ id, from: 'petrus', isHuman: true, body, folder: '', created_at: new Date().toISOString() });

test('a room ADDED after the seen-file exists is seeded, not replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iak-auto-'));
  const rooms = { alpha: [msg('a1', 'hello from alpha')], beta: [msg('b1', 'historical beta message')] };
  const { server, posts } = stubRoom({ rooms });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    // First run knows only alpha.
    const c1 = cfg(dir, ['alpha'], { api_base: base });
    const h1 = await startRoomAutomation({ rooms: ['alpha'], apiKey: 'k', handle: '@claudemm', config: c1, });
    h1?.stop?.();
    const afterFirst = posts.length;

    // beta is added later. Its history must NOT dispatch.
    const c2 = cfg(dir, ['alpha', 'beta'], { api_base: base });
    const h2 = await startRoomAutomation({ rooms: ['alpha', 'beta'], apiKey: 'k', handle: '@claudemm', config: c2, });
    h2?.stop?.();

    assert.equal(posts.length, afterFirst,
      `a newly added room replayed ${posts.length - afterFirst} historical message(s): ` +
      posts.slice(afterFirst).map(p => p.body).join(' | '));
    assert.ok(existsSync(join(dir, 'seen.txt.seeded')), 'the per-room seeded marker must exist');
    assert.match(readFileSync(join(dir, 'seen.txt.seeded'), 'utf8'), /beta/, 'beta must be recorded as seeded');
  } finally {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a room that cannot be read blocks dispatch entirely rather than guessing', async () => {
  // This test must DISCRIMINATE. An earlier version asserted "no posts" when a
  // room failed -- but with fail-open seeding there were no posts either, since
  // the same pass marked everything seen. It passed against the bug it was
  // written to catch. So: seed alpha first, then add a NEW alpha message that
  // WOULD dispatch, and make beta unreadable. Correct behaviour refuses to
  // dispatch anything while any room is unseeded; fail-open posts the new one.
  const dir = mkdtempSync(join(tmpdir(), 'iak-auto-'));
  const rooms = { alpha: [msg('a1', 'first')], beta: [msg('b1', 'beta history')] };
  const failRooms = new Set();
  const { server, posts } = stubRoom({ rooms, failRooms });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    // Run 1: alpha only, seeds cleanly, dispatches nothing.
    const h1 = await startRoomAutomation({ rooms: ['alpha'], apiKey: 'k', handle: '@claudemm',
      config: cfg(dir, ['alpha'], { api_base: base }) });
    h1?.stop?.();
    assert.deepEqual(posts, [], 'seeding alone must never dispatch');

    // Run 2: a genuinely new alpha message, and beta now unreadable.
    rooms.alpha.unshift(msg('a2', 'NEW and dispatchable'));
    failRooms.add('beta');
    const h2 = await startRoomAutomation({ rooms: ['alpha', 'beta'], apiKey: 'k', handle: '@claudemm',
      config: cfg(dir, ['alpha', 'beta'], { api_base: base }) });
    h2?.stop?.();
    assert.deepEqual(posts, [],
      'beta could not be seeded, so NOTHING may dispatch -- not even the readable room. ' +
      `Posted: ${posts.map(p => p.body).join(' | ')}`);
  } finally {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
