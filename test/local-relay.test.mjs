import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startRelay } from '../scripts/local-relay.mjs';

// Start a relay on an ephemeral port with an isolated store, run fn, tear down.
async function withRelay(opts, fn) {
  const storePath = join(tmpdir(), `iak-relay-test-${randomUUID()}.jsonl`);
  const server = startRelay({ port: 0, storePath, logger: () => {}, ...opts });
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, storePath, headers: opts.token ? { 'X-API-Key': opts.token } : {} });
  } finally {
    server.close();
    await once(server, 'close');
    try { rmSync(storePath, { force: true }); } catch { /* ignore */ }
  }
}

const j = (h = {}) => ({ 'Content-Type': 'application/json', ...h });

test('health reports ok and message count', async () => {
  await withRelay({}, async ({ base }) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.service, 'iak-local-relay');
    assert.equal(d.messages, 0);
  });
});

test('POST /api/v1/messages stores and GET returns it (round trip)', async () => {
  await withRelay({}, async ({ base, headers }) => {
    const post = await fetch(`${base}/api/v1/messages`, {
      method: 'POST', headers: j(headers),
      body: JSON.stringify({ room: 'r1', body: 'hello', from: '@mm' }),
    });
    assert.equal(post.status, 201);
    const msg = await post.json();
    assert.ok(msg.id, 'has id');
    assert.equal(msg.room, 'r1');
    assert.equal(msg.from, '@mm');
    assert.equal(msg.body, 'hello');
    assert.equal(msg.origin, 'local-relay');
    assert.ok(msg.created_at, 'has created_at');

    const get = await fetch(`${base}/api/v1/rooms/r1/messages`, { headers });
    assert.equal(get.status, 200);
    const { messages, count } = await get.json();
    assert.equal(count, 1);
    assert.equal(messages[0].body, 'hello');
    assert.equal(messages[0].id, msg.id);
  });
});

test('POST /api/v1/rooms/:room/messages (path form) works and room filters', async () => {
  await withRelay({}, async ({ base, headers }) => {
    await fetch(`${base}/api/v1/rooms/alpha/messages`, {
      method: 'POST', headers: j(headers), body: JSON.stringify({ body: 'in-alpha' }),
    });
    await fetch(`${base}/api/v1/messages`, {
      method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'beta', body: 'in-beta' }),
    });
    const alpha = await (await fetch(`${base}/api/v1/rooms/alpha/messages`, { headers })).json();
    assert.equal(alpha.count, 1);
    assert.equal(alpha.messages[0].body, 'in-alpha');
    const beta = await (await fetch(`${base}/api/v1/rooms/beta/messages`, { headers })).json();
    assert.equal(beta.count, 1);
    assert.equal(beta.messages[0].body, 'in-beta');
  });
});

test('GET honors limit and returns newest-first', async () => {
  await withRelay({}, async ({ base, headers }) => {
    for (const n of [1, 2, 3]) {
      await fetch(`${base}/api/v1/messages`, {
        method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'r', body: `m${n}` }),
      });
    }
    const { messages, count } = await (await fetch(`${base}/api/v1/rooms/r/messages?limit=2`, { headers })).json();
    assert.equal(count, 2);
    assert.equal(messages[0].body, 'm3', 'newest first');
  });
});

test('POST without body is rejected 400', async () => {
  await withRelay({}, async ({ base, headers }) => {
    const r = await fetch(`${base}/api/v1/messages`, {
      method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'r' }),
    });
    assert.equal(r.status, 400);
  });
});

test('malformed JSON body is rejected 400 (never crashes)', async () => {
  await withRelay({}, async ({ base, headers }) => {
    const r = await fetch(`${base}/api/v1/messages`, { method: 'POST', headers: j(headers), body: 'not json' });
    assert.equal(r.status, 400);
  });
});

test('token auth: rejects missing/wrong key, accepts correct', async () => {
  await withRelay({ token: 'secret123' }, async ({ base }) => {
    const noKey = await fetch(`${base}/api/v1/rooms/r/messages`);
    assert.equal(noKey.status, 401);
    const wrong = await fetch(`${base}/api/v1/rooms/r/messages`, { headers: { 'X-API-Key': 'nope' } });
    assert.equal(wrong.status, 401);
    const right = await fetch(`${base}/api/v1/rooms/r/messages`, { headers: { 'X-API-Key': 'secret123' } });
    assert.equal(right.status, 200);
    // health stays open even with a token configured
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

test('unknown route is 404', async () => {
  await withRelay({}, async ({ base, headers }) => {
    const r = await fetch(`${base}/api/v1/nope`, { headers });
    assert.equal(r.status, 404);
  });
});

test('messages get a monotonic seq; after-cursor is a no-skip chronological feed', async () => {
  await withRelay({}, async ({ base, headers }) => {
    const posted = [];
    for (const n of [1, 2, 3, 4]) {
      const r = await fetch(`${base}/api/v1/messages`, {
        method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'c', body: `m${n}` }),
      });
      posted.push(await r.json());
    }
    // seq strictly increasing even when created_at collides in the same ms
    for (let i = 1; i < posted.length; i++) assert.ok(posted[i].seq > posted[i - 1].seq, 'seq increases');

    // cursor from 0: all four, oldest-first
    const all = await (await fetch(`${base}/api/v1/rooms/c/messages?after=0`, { headers })).json();
    assert.deepEqual(all.messages.map((m) => m.body), ['m1', 'm2', 'm3', 'm4']);

    // cursor from m2's seq: exactly m3, m4 — the same-ms skip that `since` alone would cause
    const after2 = await (await fetch(`${base}/api/v1/rooms/c/messages?after=${posted[1].seq}`, { headers })).json();
    assert.deepEqual(after2.messages.map((m) => m.body), ['m3', 'm4']);

    // cursor from the last seq: caught up, empty
    const afterLast = await (await fetch(`${base}/api/v1/rooms/c/messages?after=${posted[3].seq}`, { headers })).json();
    assert.equal(afterLast.count, 0);
  });
});

test('after-cursor honors limit and stays chronological (forward feed pages)', async () => {
  await withRelay({}, async ({ base, headers }) => {
    for (const n of [1, 2, 3, 4, 5]) {
      await fetch(`${base}/api/v1/messages`, {
        method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'c', body: `m${n}` }),
      });
    }
    const page = await (await fetch(`${base}/api/v1/rooms/c/messages?after=0&limit=2`, { headers })).json();
    assert.deepEqual(page.messages.map((m) => m.body), ['m1', 'm2'], 'oldest-first page from the cursor');
  });
});

test('after is authoritative over since (since must not re-drop same-ms messages)', async () => {
  await withRelay({}, async ({ base, headers }) => {
    for (const n of [1, 2, 3]) {
      await fetch(`${base}/api/v1/messages`, {
        method: 'POST', headers: j(headers), body: JSON.stringify({ room: 'c', body: `m${n}` }),
      });
    }
    // A future `since` would exclude everything on its own; with `after=0`
    // present it must be ignored, so all three still come back.
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await (await fetch(
      `${base}/api/v1/rooms/c/messages?after=0&since=${encodeURIComponent(future)}`, { headers })).json();
    assert.deepEqual(res.messages.map((m) => m.body), ['m1', 'm2', 'm3'], 'after wins; since ignored');
  });
});

test('rows written before seq existed still get a positional seq (upgrade compat)', async () => {
  const storePath = join(tmpdir(), `iak-relay-seed-${randomUUID()}.jsonl`);
  // Simulate a #37-era store: rows with NO seq field.
  const row = (id, body) => JSON.stringify({
    id, room: 'r', from: '@x', body, created_at: '2026-01-01T00:00:00.000Z', origin: 'local-relay',
  });
  writeFileSync(storePath, `${row('a', 'old1')}\n${row('b', 'old2')}\n`);
  const server = startRelay({ port: 0, storePath, logger: () => {} });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // after=0 must include BOTH pre-seq rows (not silently skip them)
    const feed = await (await fetch(`${base}/api/v1/rooms/r/messages?after=0`)).json();
    assert.deepEqual(feed.messages.map((m) => m.body), ['old1', 'old2']);
    assert.deepEqual(feed.messages.map((m) => m.seq), [1, 2], 'positional seq assigned to legacy rows');
    // a new POST continues the sequence past the seeded rows
    const posted = await (await fetch(`${base}/api/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'r', body: 'new' }),
    })).json();
    assert.equal(posted.seq, 3, 'new message continues after the seeded rows');
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(storePath, { force: true });
  }
});
