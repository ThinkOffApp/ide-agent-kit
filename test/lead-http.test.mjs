// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP-LEVEL negative tests for team-lead delegation.
//
// WHY THESE EXIST SEPARATELY: my first suite called decideIntent() and
// setLead() directly, passing truthful actor strings. Every one passed while
// the HTTP boundary handed the actor straight out of the request body, so
// anybody who could reach the daemon could call themselves petrus. @codexmb
// reproduced that against a real daemon on 2026-09-18. A test that supplies
// its own identity cannot discover that identity is unauthenticated.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntent,
  getLead,
  listIntents,
  startConfirmationsServer,
  _resetForTests,
} from '../src/confirmations.mjs';

const LEAD_TOKEN = 'token-for-hermes';
const OTHER_TOKEN = 'token-for-codexmb';
const SHARED = 'shared-bearer-everyone-has';

let base;
let server;

before(async () => {
  server = startConfirmationsServer({
    port: 0,
    host: '127.0.0.1',
    authToken: SHARED,
    principals: { [LEAD_TOKEN]: '@hermes', [OTHER_TOKEN]: '@codexmb' },
    receiptsPath: '/tmp/iak-test-lead-http.jsonl',
    announce: async () => {},
  });
  await new Promise(r => server.listen ? server.listen(0, '127.0.0.1', r) : r());
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server?.close?.());

const post = (path, body, token = SHARED) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

test('a shared-token caller CANNOT appoint itself by claiming to be petrus', async () => {
  _resetForTests();
  const res = await post('/lead', { handle: 'codexmb', actor: 'petrus' });
  assert.equal(res.status, 403);
  assert.equal(getLead(), null, 'nobody may be appointed by a caller that proves nothing');
});

test('a per-agent token cannot appoint while the post is empty either', async () => {
  _resetForTests();
  const res = await post('/lead', { handle: 'hermes' }, LEAD_TOKEN);
  assert.equal(res.status, 403);
  assert.equal(getLead(), null);
});

test('omitting actor does not let an anonymous caller clear an owner-only intent', async () => {
  _resetForTests();
  const id = await createIntent({
    prompt: 'rm -rf $HOME', session: 's', channels: [], requiresHuman: true, announce: async () => {},
  });
  // Today's trust model: anonymous == owner, so this DOES settle — the point
  // is that it settles AS THE OWNER, and cannot be laundered into a lead
  // decision by naming one.
  const claimed = await post(`/intent/${id}/decision`, { decision: 'approve', actor: 'hermes' });
  assert.equal(claimed.status, 403, 'a claimed actor without proof must be refused outright');
  const found = listIntents().find(i => i.id === id);
  assert.equal(found.status, 'pending', 'the refused call must not have decided anything');
});

test('a proven non-lead principal cannot decide', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'ls', session: 's', channels: [], announce: async () => {} });
  const res = await post(`/intent/${id}/decision`, { decision: 'approve', actor: 'codexmb' }, OTHER_TOKEN);
  assert.equal(res.status, 403);
  assert.equal(listIntents().find(i => i.id === id).status, 'pending');
});

test('the decision receipt names the proven principal, not the claimed one', async () => {
  _resetForTests();
  // Appoint via the library (the owner path), then decide over HTTP as the lead.
  const { setLead } = await import('../src/confirmations.mjs');
  setLead('hermes', { actor: 'petrus' });
  const id = await createIntent({ prompt: 'ls', session: 's', channels: [], announce: async () => {} });
  // Claim to be petrus while holding hermes's token: the claim is ignored.
  const res = await post(`/intent/${id}/decision`, { decision: 'approve', actor: 'petrus' }, LEAD_TOKEN);
  assert.equal(res.status, 200);
  const found = listIntents().find(i => i.id === id);
  assert.equal(found.decidedBy, '@hermes');
  assert.equal(found.decidedByRole, 'lead');
});

test('a lead cannot approve its own request', async () => {
  _resetForTests();
  const { setLead } = await import('../src/confirmations.mjs');
  setLead('hermes', { actor: 'petrus' });
  const id = await createIntent({
    prompt: 'ls', session: 's', channels: [], fromHandle: '@hermes', announce: async () => {},
  });
  const res = await post(`/intent/${id}/decision`, { decision: 'approve' }, LEAD_TOKEN);
  assert.equal(res.status, 403);
  assert.equal(listIntents().find(i => i.id === id).status, 'pending');
});

test('a proven lead still cannot clear a requiresHuman intent', async () => {
  _resetForTests();
  const { setLead } = await import('../src/confirmations.mjs');
  setLead('hermes', { actor: 'petrus' });
  const id = await createIntent({
    prompt: 'cp ~/.ssh/id_ed25519 /tmp', session: 's', channels: [],
    requiresHuman: true, announce: async () => {},
  });
  const res = await post(`/intent/${id}/decision`, { decision: 'approve' }, LEAD_TOKEN);
  assert.equal(res.status, 403);
  assert.equal(listIntents().find(i => i.id === id).status, 'pending');
});

test('the shared token cannot approve what a proven lead was just refused', async () => {
  // @codexmb, 2026-09-18: the lead's own token got 403 on a requiresHuman
  // intent, then the SHARED token with no actor got 200 on the same one.
  // `principal || OWNER_HANDLE` handed the owner's authority to anyone who
  // omitted a field, so the boundary was bypassable by deleting `actor`.
  _resetForTests();
  const { setLead } = await import('../src/confirmations.mjs');
  setLead('hermes', { actor: 'petrus' });
  const id = await createIntent({
    prompt: 'cp ~/.ssh/id_ed25519 /tmp', session: 's', channels: [],
    requiresHuman: true, announce: async () => {},
  });
  const asLead = await post(`/intent/${id}/decision`, { decision: 'approve' }, LEAD_TOKEN);
  assert.equal(asLead.status, 403, 'a lead may not clear an owner-only intent');
  const anonymous = await post(`/intent/${id}/decision`, { decision: 'approve' });
  assert.equal(anonymous.status, 403, 'and neither may the same caller by omitting actor');
  assert.equal(listIntents().find(i => i.id === id).status, 'pending');
});

test('an ordinary intent is refused anonymously too once principals exist', async () => {
  // Not a special case for requiresHuman: a daemon that says it can identify
  // callers must identify them. Narrowing the refusal to owner-only intents
  // would leave the same hole one field away.
  _resetForTests();
  const id = await createIntent({ prompt: 'ls', session: 's', channels: [], announce: async () => {} });
  const res = await post(`/intent/${id}/decision`, { decision: 'approve' });
  assert.equal(res.status, 403);
  assert.equal(listIntents().find(i => i.id === id).status, 'pending');
});

test('LEGACY MODE: with no principals, anonymous still decides — Petrus is not locked out', async () => {
  // The other half of the branch above, and the one that matters to the human:
  // a daemon that has NOT been given per-agent tokens must behave exactly as it
  // does today, or his phone buttons stop working the moment this ships.
  // Proving only the refusal would leave that untested.
  _resetForTests();
  const legacy = startConfirmationsServer({
    port: 0, host: '127.0.0.1',
    receiptsPath: '/tmp/iak-test-lead-legacy.jsonl',
    announce: async () => {},
  });
  await new Promise(r => legacy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${legacy.address().port}`;
  try {
    const id = await createIntent({ prompt: 'ls', session: 's', channels: [], announce: async () => {} });
    const res = await fetch(`${url}/intent/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(res.status, 200, 'legacy anonymous approval must keep working');
    assert.equal(listIntents().find(i => i.id === id).decision, 'approve');
  } finally {
    await new Promise(r => legacy.close(r));
  }
});

test('LEGACY MODE: /lead still refuses, because delegation needs identity', async () => {
  _resetForTests();
  const legacy = startConfirmationsServer({
    port: 0, host: '127.0.0.1',
    receiptsPath: '/tmp/iak-test-lead-legacy.jsonl',
    announce: async () => {},
  });
  await new Promise(r => legacy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${legacy.address().port}`;
  try {
    const res = await fetch(`${url}/lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'hermes', actor: 'petrus' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no per-agent tokens/i);
  } finally {
    await new Promise(r => legacy.close(r));
  }
});
