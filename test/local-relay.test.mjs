import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
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
