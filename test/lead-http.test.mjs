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
