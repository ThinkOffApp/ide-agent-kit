import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mentions, sameHandle, generateReply, tick } from '../scripts/local-agent.mjs';

test('mentions detects @handle and ignores non-mentions', () => {
  assert.equal(mentions('hey @mm-local can you help', 'mm-local'), true);
  assert.equal(mentions('hey @mm-local can you help', '@mm-local'), true);
  assert.equal(mentions('MM-LOCAL please', 'mm-local'), true);
  assert.equal(mentions('talking about mm-locality here', 'mm-local'), false);
  assert.equal(mentions('nothing to see', 'mm-local'), false);
});

test('sameHandle is @- and case-insensitive', () => {
  assert.equal(sameHandle('@MM-Local', 'mm-local'), true);
  assert.equal(sameHandle('mm-local', '@mm-local'), true);
  assert.equal(sameHandle('@other', 'mm-local'), false);
});

test('generateReply POSTs to ollama /api/chat and returns the content', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '  hi from the local model  ' } }));
    });
  });
  server.listen(0);
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const out = await generateReply({ url, model: 'qwen3.6:27b', systemPrompt: 'be nice', context: '@p: hello' });
    assert.equal(out, 'hi from the local model'); // trimmed
    assert.equal(received.model, 'qwen3.6:27b');
    assert.equal(received.stream, false);
    assert.equal(received.messages[0].role, 'system');
    assert.equal(received.messages[1].content, '@p: hello');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('tick: skips history, then replies to a mention (not self, not non-mention)', async () => {
  const posts = [];
  const cfg = { room: 'r', handle: 'mm-local', ollama: { url: 'x', model: 'm' }, respondTo: 'mention' };
  const deps = {
    generate: async ({ context }) => `echo:${context}`,
    post: async (ep, room, body) => { posts.push({ room, body }); },
    log: () => {},
  };
  const state = { seen: new Set(), primed: false };

  // tick 1: one historical message that DOES mention us — must be skipped (priming)
  deps.read = async () => ({ ep: { baseUrl: 'x' }, messages: [{ id: '1', from: '@petrus', body: '@mm-local hi' }] });
  await tick(cfg, state, deps);
  assert.equal(posts.length, 0, 'history is not answered');

  // tick 2: a NEW mention -> reply; plus self + non-mention that must be ignored
  deps.read = async () => ({
    ep: { baseUrl: 'x' },
    messages: [ // newest-first, as the API returns
      { id: '4', from: '@other', body: 'unrelated chatter' },
      { id: '3', from: '@mm-local', body: '@mm-local self echo loop' },
      { id: '2', from: '@petrus', body: '@mm-local what is 2+2' },
      { id: '1', from: '@petrus', body: '@mm-local hi' },
    ],
  });
  await tick(cfg, state, deps);
  assert.equal(posts.length, 1, 'exactly one reply (the new mention)');
  assert.equal(posts[0].body, 'echo:@petrus: @mm-local what is 2+2');
});

test('tick: respondTo=all replies to any new non-self message', async () => {
  const posts = [];
  const cfg = { room: 'r', handle: 'mm-local', ollama: { url: 'x', model: 'm' }, respondTo: 'all' };
  const state = { seen: new Set(), primed: true }; // already primed
  const deps = {
    read: async () => ({ ep: { baseUrl: 'x' }, messages: [{ id: '9', from: '@petrus', body: 'no mention here' }] }),
    generate: async () => 'sure',
    post: async (ep, room, body) => { posts.push(body); },
    log: () => {},
  };
  await tick(cfg, state, deps);
  assert.equal(posts.length, 1);
});
