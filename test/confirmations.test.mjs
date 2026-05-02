// SPDX-License-Identifier: AGPL-3.0-only

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntent,
  decideIntent,
  waitForDecision,
  listIntents,
  startConfirmationsServer,
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
