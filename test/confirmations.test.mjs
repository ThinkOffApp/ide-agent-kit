// SPDX-License-Identifier: AGPL-3.0-only

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntent,
  decideIntent,
  waitForDecision,
  listIntents,
  startConfirmationsServer,
  startChatReplyPoller,
  composeAnnouncers,
  _resetForTests,
} from '../src/confirmations.mjs';

// --- registry primitives ---------------------------------------------------

test('createIntent calls the announce hook with the new intent + a fresh id', async () => {
  _resetForTests();
  const seen = [];
  const id = await createIntent({
    prompt: 'Approve drop database?',
    session: 'claude',
    channels: ['groupmind'],
    announce: async (i) => seen.push(i),
  });
  assert.match(id, /^[0-9a-f]+$/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt, 'Approve drop database?');
  assert.equal(seen[0].session, 'claude');
  assert.deepEqual(seen[0].channels, ['groupmind']);
  assert.equal(seen[0].id, id);
});

test('decideIntent resolves a pending intent and rejects bad decisions', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  const bad = decideIntent(id, 'maybe');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /must be "approve" or "deny"/);
  const good = decideIntent(id, 'approve');
  assert.equal(good.ok, true);
});

test('decideIntent on unknown id reports error', () => {
  const r = decideIntent('does-not-exist', 'approve');
  assert.equal(r.ok, false);
});

test('decideIntent is idempotent for the same decision and rejects flip-flops', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  decideIntent(id, 'approve');
  const same = decideIntent(id, 'approve');
  assert.equal(same.ok, true);
  assert.equal(same.idempotent, true);
  const flip = decideIntent(id, 'deny');
  assert.equal(flip.ok, false);
  assert.match(flip.error, /already decided/);
});

test('waitForDecision resolves immediately when already decided', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  decideIntent(id, 'approve');
  const r = await waitForDecision(id, { timeoutMs: 50 });
  assert.equal(r.status, 'decided');
  assert.equal(r.decision, 'approve');
});

test('waitForDecision blocks until decideIntent settles', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  setTimeout(() => decideIntent(id, 'deny'), 30);
  const r = await waitForDecision(id, { timeoutMs: 500 });
  assert.equal(r.status, 'decided');
  assert.equal(r.decision, 'deny');
});

test('waitForDecision returns timeout if no decision before deadline', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  const r = await waitForDecision(id, { timeoutMs: 60 });
  assert.equal(r.status, 'timeout');
});

test('listIntents shows status transitions', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'something', announce: async () => {} });
  assert.equal(listIntents().length, 1);
  assert.equal(listIntents()[0].status, 'pending');
  decideIntent(id, 'approve');
  assert.equal(listIntents()[0].status, 'decided');
  assert.equal(listIntents()[0].decision, 'approve');
});

test('createIntent does NOT fail when announce throws', async () => {
  _resetForTests();
  const id = await createIntent({
    prompt: 'p',
    announce: async () => { throw new Error('chat down'); },
  });
  assert.match(id, /^[0-9a-f]+$/);
  assert.equal(listIntents()[0].status, 'pending');
});

// --- composeAnnouncers ------------------------------------------------------

test('composeAnnouncers fans out only to the channels in intent.channels', async () => {
  const calls = { groupmind: 0, codewatch: 0 };
  const announce = composeAnnouncers({
    groupmind: async () => { calls.groupmind++; },
    codewatch: async () => { calls.codewatch++; },
  });
  await announce({ id: 'x', prompt: 'p', channels: ['groupmind'] });
  assert.deepEqual(calls, { groupmind: 1, codewatch: 0 });
  await announce({ id: 'x', prompt: 'p', channels: ['groupmind', 'codewatch'] });
  assert.deepEqual(calls, { groupmind: 2, codewatch: 1 });
});

test('composeAnnouncers continues other channels when one throws', async () => {
  let okCalled = 0;
  const announce = composeAnnouncers({
    groupmind: async () => { throw new Error('chat 500'); },
    codewatch: async () => { okCalled++; },
  });
  await announce({ id: 'x', prompt: 'p', channels: ['groupmind', 'codewatch'] });
  assert.equal(okCalled, 1);
});

// --- HTTP listener ---------------------------------------------------------

let httpServer;
const TEST_PORT = 18788;

after(() => { try { httpServer?.close(); } catch {} });

test('HTTP /intent/:id/decision settles a pending intent end-to-end', async () => {
  _resetForTests();
  httpServer = startConfirmationsServer({ port: TEST_PORT, host: '127.0.0.1' });
  const id = await createIntent({ prompt: 'p', announce: async () => {} });
  // Wait in parallel with a HTTP POST that resolves it.
  const wait = waitForDecision(id, { timeoutMs: 1500 });
  await fetch(`http://127.0.0.1:${TEST_PORT}/intent/${id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  const r = await wait;
  assert.equal(r.status, 'decided');
  assert.equal(r.decision, 'approve');
});

test('HTTP rejects unknown intent + bad json + missing decision', async () => {
  _resetForTests();
  // Server already listening from previous test.
  const r1 = await fetch(`http://127.0.0.1:${TEST_PORT}/intent/missing/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(r1.status, 400);
  const r2 = await fetch(`http://127.0.0.1:${TEST_PORT}/intent/whatever/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assert.equal(r2.status, 400);
});

test('HTTP /intents lists current intents', async () => {
  _resetForTests();
  await createIntent({ prompt: 'one', announce: async () => {} });
  await createIntent({ prompt: 'two', announce: async () => {} });
  const r = await fetch(`http://127.0.0.1:${TEST_PORT}/intents`);
  const list = await r.json();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((i) => i.prompt).sort(), ['one', 'two']);
});

test('HTTP auth gate rejects missing/wrong bearer token when configured', async () => {
  _resetForTests();
  const port = TEST_PORT + 1;
  const srv = startConfirmationsServer({ port, host: '127.0.0.1', authToken: 's3cret' });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/intents`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/intents`, {
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);
    const right = await fetch(`http://127.0.0.1:${port}/intents`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    assert.equal(right.status, 200);
  } finally {
    srv.close();
  }
});


// --- owner allowlist (ported from the Mini fork, reviewed by codexmb) --------
//
// The guard decides WHOSE approvals count, so it is tested behaviourally:
// mocked room fetches drive the real poll loop and we watch which senders
// get to settle a real intent.

test('chat-reply poller: exact owners settle, lookalikes and agents do not', async () => {
  _resetForTests();
  const shortId = await createIntent({ prompt: 'test intent', announce: async () => {} });

  const batches = [
    { messages: [] }, // priming pass
    { messages: [
      // an agent that named itself to LOOK like an owner: must be rejected
      { id: 'm1', from: '@petrus-helper', body: `/approve ${shortId}`, isHuman: false },
      // a genuine configured owner surface: must settle
      { id: 'm2', from: '@petrus-boox', body: `/approve ${shortId}`, isHuman: false },
    ] },
  ];
  let call = 0;
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const lines = [];
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10,
    owners: ['petrus', 'petrus-boox'],
    log: (m) => lines.push(m),
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    clearInterval(handle);
    globalThis.fetch = originalFetch;
  }

  const joined = lines.join('\n');
  // the lookalike was refused BEFORE any settle attempt
  assert.match(joined, /petrus-helper.*not the owner/i);
  // the real owner surface settled the intent
  const settled = listIntents().find((i) => i.id === shortId);
  assert.equal(settled.status, 'decided');
  assert.equal(settled.decision, 'approve');
  // and the lookalike got NO settle: decision came from the m2 pass only
  assert.match(joined, new RegExp(`/approve ${shortId} from @petrus-boox: settled`));
});

test('chat-reply poller: prefix similarity earns a visible reply, never authority', async () => {
  _resetForTests();
  const intentId = await createIntent({ prompt: 'second intent', announce: async () => {} });
  const batches = [
    { messages: [] },
    { messages: [
      { id: 'p1', from: '@petrus-watch2', body: `/approve ${intentId}`, isHuman: false },
    ] },
  ];
  let call = 0;
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10,
    owners: ['petrus'],
    log: () => {},
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    clearInterval(handle);
    globalThis.fetch = originalFetch;
  }
  // still pending: the prefix lookalike had no authority
  const still = listIntents().find((i) => i.id === intentId);
  assert.equal(still.status, 'pending');
  // but because it LOOKS like an owner surface, a visible rejection was posted
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /NOT recorded/);
});


test('chat-reply poller: a human who is not a listed owner cannot settle, and is told visibly', async () => {
  // codexmb's merge-blocking finding on #76: isHuman proves A human, not THE
  // owner. An unlisted human must be refused — and must SEE the refusal,
  // because a person who tapped Approve and hears nothing assumes it landed.
  _resetForTests();
  const intentId = await createIntent({ prompt: 'guarded', announce: async () => {} });
  const batches = [
    { messages: [] },
    { messages: [
      { id: 'h1', from: 'marina', body: `/approve ${intentId}`, isHuman: true },
    ] },
  ];
  let call = 0;
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10,
    owners: ['petrus'],
    log: () => {},
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    clearInterval(handle);
    globalThis.fetch = originalFetch;
  }
  const still = listIntents().find((i) => i.id === intentId);
  assert.equal(still.status, 'pending', 'unlisted human must not settle');
  assert.equal(posts.length, 1, 'and must be told visibly');
  assert.match(posts[0].body, /NOT recorded/);
});

test('chat-reply poller: an explicitly empty owners list is lockdown — even the legacy owner cannot settle', async () => {
  // codexmb's follow-up finding on #76: `owners.length ? owners : [owner]`
  // silently replaced a deliberate [] (nobody settles from chat) with the
  // legacy petrus fallback. An empty array must be authoritative.
  _resetForTests();
  const intentId = await createIntent({ prompt: 'locked', announce: async () => {} });
  const batches = [
    { messages: [] },
    { messages: [
      { id: 'l1', from: 'petrus', body: `/approve ${intentId}`, isHuman: true },
    ] },
  ];
  let call = 0;
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10,
    owners: [],
    log: () => {},
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    clearInterval(handle);
    globalThis.fetch = originalFetch;
  }
  const still = listIntents().find((i) => i.id === intentId);
  assert.equal(still.status, 'pending', 'lockdown means nobody settles, petrus included');
  // isHuman sender still gets the visible refusal so the lockdown is discoverable
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /NOT recorded/);
});

test('chat-reply poller: an unknown intent id gets a log line, never a "NOT recorded" reply', async () => {
  // Two machines run this poller against the same room, each with its own
  // intent store. The one holding the intent settles it; every other one sees
  // an id it never created. Replying there tells the owner a working approval
  // failed — which is exactly what happened to petrus on 2026-08-30, twice,
  // and made him re-tap an approval that had already been recorded.
  _resetForTests();
  const batches = [
    { messages: [] },
    { messages: [
      { id: 'u1', from: 'petrus', body: '/approve deadbeef', isHuman: true },
    ] },
  ];
  let call = 0;
  const posts = [];
  const logs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10,
    owners: ['petrus'],
    log: (line) => logs.push(String(line)),
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    clearInterval(handle);
    globalThis.fetch = originalFetch;
  }
  assert.equal(posts.length, 0, 'an id this poller does not hold must not be declared missing to the owner');
  assert.ok(logs.some((l) => /unknown intent here/.test(l)), 'but it must still be logged locally');
});
