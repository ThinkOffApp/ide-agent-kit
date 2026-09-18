// The /lead command path, against a RECORDING daemon rather than assumptions.
//
// Asked for by @codexmb after petrus got silence twice: "/health alone is
// insufficient ... exercise the real poller-to-handler path with controlled
// fixtures, including an old command and an agent-authored command ... preserve
// authenticated human identity checks; do not relax them to test".
//
// The property under test is not what the function RETURNS. It is whether a
// privileged request ever reaches the daemon. So the daemon here is a real
// server that records every request, and the unauthorised cases must leave it
// with nothing.
//
// This file's own history is the reason it is written that way. Its first
// version called handleLeadCommand({ msg, ... }) when the signature is
// (msg, { ... }), so every body was undefined, every call returned null, and
// four "the request is refused" tests passed against a function that had not
// been asked anything. Its second version asserted null for refusals, and
// failed -- because the handler refuses OUT LOUD, which is better than silence
// and was the correct behaviour all along. Assert the property, not the shape
// you expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleLeadCommand } from '../src/room-automation.mjs';

const OWNER = 'petrus';

async function withRecordingDaemon(run) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lead: null, owner: OWNER }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(url, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const msg = (o = {}) => ({ id: 'm1', from: OWNER, isHuman: true, body: '/lead status', room: 'r', ...o });

test('an AGENT-authored appointment never reaches the daemon', async () => {
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(
      msg({ from: '@claudemm', isHuman: false, body: '/lead @claudemm' }),
      { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, [], `an agent reached the daemon: ${seen.join(', ')}`);
    assert.match(String(out), /only petrus/i, 'and it must SAY it refused, not go quiet');
  });
});

test('owner handle with isHuman false -- a replayed button -- never reaches the daemon', async () => {
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(
      msg({ isHuman: false, body: '/lead @claudemm' }),
      { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, [], 'the owner handle alone must not be authorisation');
    assert.match(String(out), /only petrus/i);
  });
});

test('a human who is not the owner never reaches the daemon', async () => {
  await withRecordingDaemon(async (url, seen) => {
    await handleLeadCommand(
      msg({ from: 'someone-else', isHuman: true, body: '/lead @them' }),
      { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, []);
  });
});

test('prose is not a command: nothing is parsed, nothing is sent', async () => {
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(msg({ body: 'lead status please' }), { daemonUrl: url, ownerHandle: OWNER });
    assert.equal(out, null);
    assert.deepEqual(seen, []);
  });
});

test('the OWNER asking for status does reach the daemon, and reads its answer', async () => {
  // The positive control. Without one, every assertion above would also pass
  // against a handler that does nothing at all -- which is exactly how the
  // first version of this file "passed".
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(msg(), { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, ['GET /lead'], 'a genuine owner status must query the daemon');
    assert.match(String(out), /unset/i, 'and must report what the daemon said');
  });
});

test('an unreachable daemon is reported, never silently swallowed', async () => {
  // Silence is what petrus experienced twice. It must not be a normal outcome.
  const out = await handleLeadCommand(msg(), { daemonUrl: 'http://127.0.0.1:59999', ownerHandle: OWNER });
  assert.ok(out, 'a dead daemon must still produce something to say');
  assert.match(String(out), /could not reach|unavailable|error/i);
});

test('a command followed by prose is still a command (status)', async () => {
  // @claudeMB sent "/lead status" with a note underneath as an end-to-end test
  // and it was silently ignored: the regex ran against the whole body with no
  // /m flag, so a second line made `$` fail and the command invisible. Someone
  // who types a command and then a sentence has still typed a command.
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(
      msg({ from: '@claudeMB', isHuman: false, body: '/lead status\n\nnote to petrus: ignore this' }),
      { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, ['GET /lead'], 'the status read must still happen');
    assert.match(String(out), /unset/i);
  });
});

test('an APPOINTMENT with anything after it is refused, and says why', async () => {
  // Status tolerates trailing prose; granting a privilege does not. Reading an
  // appointment out of the first line of a longer post is how a quoted line
  // becomes a real grant.
  await withRecordingDaemon(async (url, seen) => {
    const out = await handleLeadCommand(
      msg({ body: '/lead @grok\nplease do this' }),
      { daemonUrl: url, ownerHandle: OWNER });
    assert.deepEqual(seen, [], 'nothing may reach the daemon');
    assert.match(String(out), /whole message/i, 'and the reason must be the real one');
    assert.doesNotMatch(String(out), /is not a handle/i, '"@grok is not a handle" would be false');
  });
});
