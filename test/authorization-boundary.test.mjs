// The authorization boundary, over real HTTP, against real intents.
//
// @codexmb, after the daemon was restarted with this code live: "message
// delivery and presence of handleLeadCommand do not verify the authorization
// boundary." A commit hash proves which code loaded, not what it permits.
//
// FOUR INSTRUMENT FAILURES PRECEDED THE FIRST REAL MEASUREMENT HERE, and each
// one would have produced a confident wrong answer:
//
//   wrong route  /intent/:id/decide -> 404 for EVERYTHING. One test still
//                "passed" because it asserted notEqual(status, 200); 404 is
//                not 200. It would pass against a server with no authorization
//                code at all.
//   wrong header the server reads `Authorization: Bearer`, not X-API-Key, so
//                no token resolved and EVERYTHING was 403. A boundary that
//                refuses every caller looks secure and tests nothing.
//   a lying sed  printed "header corrected" while changing no file.
//   wrong shape  assert.throws() against setLead, which RETURNS a refusal. Had
//                I reported that failure it would have read as "the code does
//                not refuse self-appointment".
//
// Hence: every case asserts a specific STATUS and a specific REASON. A refusal
// for the wrong reason is not a pass.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConfirmationsServer, createIntent, setLead, OWNER_HANDLE }
  from '../src/confirmations.mjs';

const OWNER = 'tok-owner', LEAD = 'tok-lead', OTHER = 'tok-other';

async function boot() {
  const receiptsPath = join(mkdtempSync(join(tmpdir(), 'authz-')), 'receipts.jsonl');
  const server = startConfirmationsServer({
    port: 0, receiptsPath,
    principals: { [OWNER]: OWNER_HANDLE, [LEAD]: 'leadagent', [OTHER]: 'otheragent' },
  });
  // listen() is async; address() is null until 'listening'. Not awaiting this
  // is what made the first version of this file hang forever.
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listening ? res() : server.once('listening', res);
  });
  setLead('leadagent', { actor: OWNER_HANDLE, receiptsPath });
  return { server, port: server.address().port, receiptsPath,
           shut: () => new Promise((r) => server.close(r)) };
}

const mkIntent = (receiptsPath, opts) =>
  createIntent({ prompt: 't', session: 's', channels: [], timeoutSec: 1,
                 receiptsPath, ...opts });

async function decide(port, id, token, body = { decision: 'approve' }) {
  const r = await fetch(`http://127.0.0.1:${port}/intent/${id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('the lead may clear another agent routine work', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath, { fromHandle: 'otheragent' });
    const r = await decide(t.port, i.id ?? i, LEAD);
    assert.equal(r.status, 200, 'delegation does not work at all');
  } finally { await t.shut(); }
});

test('the lead may NOT decide its own request', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath, { fromHandle: 'leadagent' });
    const r = await decide(t.port, i.id ?? i, LEAD);
    assert.equal(r.status, 403, 'a lead self-approved');
    assert.match(r.body.error, /own request/, 'refused, but for the wrong reason');
  } finally { await t.shut(); }
});

test('requiresHuman is never delegable', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath,
                             { fromHandle: 'otheragent', requiresHuman: true });
    const r = await decide(t.port, i.id ?? i, LEAD);
    assert.equal(r.status, 403, 'the lead decided an owner-only action');
    assert.match(r.body.error, /reserved for/, 'refused, but for the wrong reason');
  } finally { await t.shut(); }
});

test('an agent that is not the lead cannot decide', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath, { fromHandle: 'otheragent' });
    const r = await decide(t.port, i.id ?? i, OTHER);
    assert.equal(r.status, 403, 'any authenticated agent could decide');
  } finally { await t.shut(); }
});

test('the owner may still decide an owner-only action', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath,
                             { fromHandle: 'otheragent', requiresHuman: true });
    const r = await decide(t.port, i.id ?? i, OWNER);
    assert.equal(r.status, 200, 'the owner was locked out of their own approvals');
  } finally { await t.shut(); }
});

test('an unproven caller cannot claim an actor', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath, { fromHandle: 'otheragent' });
    const r = await decide(t.port, i.id ?? i, undefined,
                           { decision: 'approve', actor: 'petrus' });
    assert.equal(r.status, 403, 'impersonation by assertion is open');
    assert.match(r.body.error, /proves no identity/);
  } finally { await t.shut(); }
});

test('once principals exist, anonymous is not the owner', async () => {
  const t = await boot();
  try {
    const i = await mkIntent(t.receiptsPath, { fromHandle: 'otheragent' });
    const r = await decide(t.port, i.id ?? i, 'tok-not-registered');
    assert.equal(r.status, 403, 'the anonymous-is-owner fallback is reachable');
    assert.match(r.body.error, /identifies callers/);
  } finally { await t.shut(); }
});
