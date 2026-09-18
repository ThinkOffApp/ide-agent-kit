// SPDX-License-Identifier: AGPL-3.0-only
//
// Team-lead approvals (Petrus, 2026-09-18 07:25: "Ok lets do 2 and 3. Team lead
// assigned by me dynamically and lead can move the duty to another agent").
//
// Most of these are NEGATIVE controls on purpose. A delegation feature is only
// as good as the things it refuses, and a test suite that only proves the lead
// CAN approve would pass just as happily if the rules were not there at all.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  OWNER_HANDLE,
  createIntent,
  decideIntent,
  getLead,
  setLead,
  _resetForTests,
} from '../src/confirmations.mjs';

const OWNER = OWNER_HANDLE;
const LEAD = '@hermes';
const OTHER = '@codexmb';

async function pendingIntent(opts = {}) {
  return createIntent({ prompt: 'run something', session: 's', channels: [], ...opts });
}

beforeEach(() => _resetForTests());

test('the lead starts unset, so deploying this changes nothing on its own', () => {
  assert.equal(getLead(), null);
});

test('an agent cannot appoint itself while the post is empty', () => {
  const r = setLead(LEAD, { actor: LEAD });
  assert.equal(r.ok, false);
  assert.match(r.error, /only petrus may appoint/i);
  assert.equal(getLead(), null);
});

test('an agent cannot appoint someone else while the post is empty', () => {
  assert.equal(setLead(OTHER, { actor: LEAD }).ok, false);
  assert.equal(getLead(), null);
});

test('with no lead assigned, an agent cannot decide', async () => {
  const id = await pendingIntent();
  const r = decideIntent(id, 'approve', { actor: LEAD });
  assert.equal(r.ok, false);
  assert.match(r.error, /no team lead is assigned/i);
});

test('the owner appoints, and the lead may then decide an ordinary intent', async () => {
  assert.equal(setLead(LEAD, { actor: OWNER }).ok, true);
  assert.equal(getLead().handle, LEAD);
  const id = await pendingIntent();
  assert.equal(decideIntent(id, 'approve', { actor: LEAD }).ok, true);
});

test('a non-lead agent still cannot decide once a lead exists', async () => {
  setLead(LEAD, { actor: OWNER });
  const id = await pendingIntent();
  const r = decideIntent(id, 'approve', { actor: OTHER });
  assert.equal(r.ok, false);
  assert.match(r.error, /team lead \(@hermes\)/);
});

test('requiresHuman intents are NOT delegable, even to a sitting lead', async () => {
  setLead(LEAD, { actor: OWNER });
  const id = await pendingIntent({ requiresHuman: true });
  const r = decideIntent(id, 'approve', { actor: LEAD });
  assert.equal(r.ok, false);
  assert.match(r.error, /reserved for petrus/i);
  // and the owner can still decide it
  assert.equal(decideIntent(id, 'approve', { actor: OWNER }).ok, true);
});

test('the lead may hand the duty over, and loses it by doing so', async () => {
  setLead(LEAD, { actor: OWNER });
  assert.equal(setLead(OTHER, { actor: LEAD }).ok, true);
  assert.equal(getLead().handle, OTHER);
  const id = await pendingIntent();
  const r = decideIntent(id, 'approve', { actor: LEAD });
  assert.equal(r.ok, false, 'the previous lead must not keep deciding after handover');
  assert.equal(decideIntent(id, 'approve', { actor: OTHER }).ok, true);
});

test('a lead cannot re-appoint itself', () => {
  setLead(LEAD, { actor: OWNER });
  const r = setLead(LEAD, { actor: LEAD });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot re-appoint itself/);
});

test('the owner can clear the post, and delegation stops immediately', async () => {
  setLead(LEAD, { actor: OWNER });
  assert.equal(setLead(null, { actor: OWNER }).ok, true);
  assert.equal(getLead(), null);
  const id = await pendingIntent();
  assert.equal(decideIntent(id, 'approve', { actor: LEAD }).ok, false);
});

test('the decision records who made it, not a hardcoded owner', async () => {
  setLead(LEAD, { actor: OWNER });
  const id = await pendingIntent();
  decideIntent(id, 'approve', { actor: LEAD });
  const { listIntents } = await import('../src/confirmations.mjs');
  const found = listIntents().find((i) => i.id === id);
  assert.equal(found.decidedBy, LEAD);
  assert.equal(found.decidedByRole, 'lead');
});

test('handles compare without caring about a leading @ or stray spaces', () => {
  assert.equal(setLead(' hermes ', { actor: OWNER }).ok, true);
  assert.equal(getLead().handle, '@hermes');
});
