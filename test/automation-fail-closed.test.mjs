// Seeding must FAIL CLOSED.
//
// @codexmb, reviewing the published module: "First-run fetch failures return []
// and seeding proceeds, allowing the first successful poll to treat historical
// messages as new." On a path that can execute /lead or /approve, a dropped
// packet at startup could replay privileged history.
//
// The linchpin is that a failed read is DISTINGUISHABLE from an empty room.
// Everything above it -- the `ready` gate, the retry, refusing to dispatch --
// depends on this one function returning null rather than [].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchRoomMessages } from '../src/room-automation.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { return await run(port); } finally { await new Promise((r) => server.close(r)); }
}

test('an HTTP error is null, NOT an empty room', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const out = await fetchRoomMessages('r', 'k');
    assert.equal(out, null, 'a 500 must not look like "the room is quiet"');
  } finally { globalThis.fetch = realFetch; }
});

test('a network failure is null, NOT an empty room', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    assert.equal(await fetchRoomMessages('r', 'k'), null);
  } finally { globalThis.fetch = realFetch; }
});

test('a genuinely empty room is [], which is different', async () => {
  // The positive control. Without it, a function that always returned null
  // would pass both tests above and break the product completely.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    assert.deepEqual(await fetchRoomMessages('r', 'k'), [], 'an empty room is an answer, not a failure');
  } finally { globalThis.fetch = realFetch; }
});

test('messages come back when the room has them', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'a' }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    assert.deepEqual(await fetchRoomMessages('r', 'k'), [{ id: 'a' }]);
  } finally { globalThis.fetch = realFetch; }
});

test('the API key travels in a header, never on a command line', async () => {
  // It used to be interpolated into `curl -H "X-API-Key: ${apiKey}"` under
  // execSync, which puts the credential in the process table for anyone running
  // ps -- and this repo's own rule is that keys never go inline in a shell.
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [], sawKey: req.headers['x-api-key'] }));
  }, async (port) => {
    let seenHeader = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seenHeader = init?.headers?.['X-API-Key']; return realFetch(`http://127.0.0.1:${port}/`, init); };
    try {
      await fetchRoomMessages('r', 'secret-key-value');
      assert.equal(seenHeader, 'secret-key-value', 'the key must be passed as a header');
    } finally { globalThis.fetch = realFetch; }
  });
});
