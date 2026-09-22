// SPDX-License-Identifier: AGPL-3.0-only
//
// The /lead chat command. Again mostly negative controls: this command decides
// who may approve shell commands on this machine, so what it REFUSES is the
// whole point. A suite proving only that petrus can appoint would pass just as
// happily if the sender check were missing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { handleLeadCommand } from '../src/room-automation.mjs';

let server;
let daemonUrl;
let lastPost = null;
let lead = null;

before(async () => {
  // A stand-in daemon: enough to prove the command reaches it with the right
  // body, without pulling the real confirmations server into this test.
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/lead') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lead, owner: 'petrus' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/lead') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        lastPost = JSON.parse(body);
        lead = lastPost.handle ? { handle: `@${lastPost.handle}`, assignedBy: lastPost.actor } : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lead }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  daemonUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const owner = body => ({ body, from: 'petrus', isHuman: true });
const agent = body => ({ body, from: '@codexmb', isHuman: false });

test('a message that is not /lead is not consumed', async () => {
  assert.equal(await handleLeadCommand(owner('deploy the thing'), { daemonUrl }), null);
  assert.equal(await handleLeadCommand(owner('the team lead should decide'), { daemonUrl }), null);
});

test('status is readable by anyone, including agents', async () => {
  lead = null;
  const reply = await handleLeadCommand(agent('/lead status'), { daemonUrl });
  assert.match(reply, /unset/i);
});

test('an AGENT cannot appoint anyone, including itself', async () => {
  lastPost = null;
  const reply = await handleLeadCommand(agent('/lead @codexmb'), { daemonUrl });
  assert.match(reply, /only petrus/i);
  assert.equal(lastPost, null, 'the daemon must never have been called');
});

test('a message merely CLAIMING to be from petrus is refused without the human flag', async () => {
  lastPost = null;
  const spoofed = { body: '/lead @codexmb', from: 'petrus', isHuman: false };
  const reply = await handleLeadCommand(spoofed, { daemonUrl });
  assert.match(reply, /only petrus/i);
  assert.equal(lastPost, null);
});

test('the owner can appoint, and the daemon is called with the right body', async () => {
  lastPost = null;
  const reply = await handleLeadCommand(owner('/lead @hermes'), { daemonUrl });
  assert.match(reply, /now @hermes/i);
  assert.deepEqual(lastPost, { handle: 'hermes', actor: 'petrus' });
});

test('the reply says the owner-only class still waits for him', async () => {
  const reply = await handleLeadCommand(owner('/lead @hermes'), { daemonUrl });
  assert.match(reply, /credential and paid actions still wait/i);
});

test('the owner can clear the post', async () => {
  await handleLeadCommand(owner('/lead @hermes'), { daemonUrl });
  const reply = await handleLeadCommand(owner('/lead clear'), { daemonUrl });
  assert.match(reply, /cleared/i);
  assert.equal(lastPost.handle, null);
});

test('a malformed handle is rejected before the daemon is touched', async () => {
  lastPost = null;
  const reply = await handleLeadCommand(owner('/lead somebody nice please!!'), { daemonUrl });
  assert.match(reply, /not a handle/i);
  assert.equal(lastPost, null);
});

test('a daemon that is down reports it instead of throwing', async () => {
  const reply = await handleLeadCommand(owner('/lead @hermes'), {
    daemonUrl: 'http://127.0.0.1:1',
  });
  assert.match(reply, /could not reach/i);
});

test('status does not report "unset" when the daemon lacks the route', async () => {
  // Petrus typed /lead status at 11:23 before the daemon had been restarted.
  // The first version answered "unset" — true-sounding, and produced by a 404.
  // An answer that cannot tell "nobody holds the post" from "this endpoint does
  // not exist" is the empty-list bug again, in a security-relevant place.
  const dead = createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${dead.address().port}`;
  try {
    const reply = await handleLeadCommand({ body: '/lead status', from: 'petrus', isHuman: true }, { daemonUrl: url });
    assert.match(reply, /not running here yet/i);
    assert.doesNotMatch(reply, /^Team lead: unset/);
  } finally {
    // Awaited, and in a finally: an unawaited close leaves the handle open if
    // the assertion throws, and a leaked listener is how a suite starts failing
    // once in three runs — which is worse than failing every time, because the
    // third flake is the one everybody stops reading.
    await new Promise(r => dead.close(r));
  }
});
