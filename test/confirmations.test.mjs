// SPDX-License-Identifier: AGPL-3.0-only

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntent,
  decideIntent,
  getIntent,
  waitForDecision,
  listIntents,
  startConfirmationsServer,
  startChatReplyPoller,
  composeAnnouncers,
  defaultCallbackBase,
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

test('GET /intents?status=pending returns only open intents, and rejects unknown values', async () => {
  // The queue used to return every intent ever created regardless of the
  // status asked for, so petrus's phone showed a list that only grew and he
  // re-tapped things that had settled hours earlier. On 2026-08-30 one such
  // re-tap was an echo of a migration fix that had already run - executing it
  // again would have killed a healthy rsync mid-copy.
  _resetForTests();
  const openId = await createIntent({ prompt: 'still open', announce: async () => {} });
  const doneId = await createIntent({ prompt: 'already settled', announce: async () => {} });
  decideIntent(doneId, 'approve');

  const server = startConfirmationsServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.listening ? r() : server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const all = await (await fetch(`${base}/intents`)).json();
    assert.equal(all.length, 2, 'no filter still returns everything');

    const pending = await (await fetch(`${base}/intents?status=pending`)).json();
    assert.deepEqual(pending.map((i) => i.id), [openId], 'only the open one');

    const decided = await (await fetch(`${base}/intents?status=decided`)).json();
    assert.deepEqual(decided.map((i) => i.id), [doneId]);

    const bad = await fetch(`${base}/intents?status=banana`);
    assert.equal(bad.status, 400, 'an unknown filter must fail loudly, not list everything');
  } finally {
    server.close();
  }
});

test('defaultCallbackBase: explicit callback_base wins, loopback stays loopback, wildcard picks a LAN address', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en5: [{ address: '169.254.10.7', family: 'IPv4', internal: false }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.50.241', family: 'IPv4', internal: false },
    ],
  };
  assert.equal(defaultCallbackBase({ callback_base: 'http://gate.example:9000/' }, ifaces), 'http://gate.example:9000');
  assert.equal(defaultCallbackBase({}, ifaces), 'http://127.0.0.1:8788');
  assert.equal(defaultCallbackBase({ host: '127.0.0.1', port: 9001 }, ifaces), 'http://127.0.0.1:9001');
  assert.equal(defaultCallbackBase({ host: 'localhost' }, ifaces), 'http://127.0.0.1:8788');
  assert.equal(defaultCallbackBase({ host: '0.0.0.0' }, ifaces), 'http://192.168.50.241:8788');
  assert.equal(defaultCallbackBase({ host: '0.0.0.0', port: 8790 }, { lo0: ifaces.lo0 }), 'http://127.0.0.1:8790');
  assert.equal(defaultCallbackBase({ host: '192.168.50.5' }, ifaces), 'http://192.168.50.5:8788');
});

test('defaultCallbackBase: virtual interfaces and enumeration order do not win over the LAN', () => {
  const ifaces = {
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.97.140.13', family: 'IPv4', internal: false }],
    en0: [{ address: '192.168.50.241', family: 'IPv4', internal: false }],
  };
  assert.equal(defaultCallbackBase({ host: '0.0.0.0' }, ifaces), 'http://192.168.50.241:8788');
  // a real LAN on 10/8 still beats a physical interface on a public range
  const tenNet = {
    eth1: [{ address: '203.0.113.5', family: 'IPv4', internal: false }],
    eth0: [{ address: '10.1.2.3', family: 'IPv4', internal: false }],
  };
  assert.equal(defaultCallbackBase({ host: '0.0.0.0' }, tenNet), 'http://10.1.2.3:8788');
  // only virtual interfaces present: nothing plausible, fall back to loopback
  assert.equal(defaultCallbackBase({ host: '0.0.0.0' }, { docker0: ifaces.docker0, utun3: ifaces.utun3 }), 'http://127.0.0.1:8788');
  // explicit interface selection wins over the policy, even for a "virtual" name
  assert.equal(defaultCallbackBase({ host: '0.0.0.0', callback_interface: 'tailscale0' }, ifaces), 'http://100.97.140.13:8788');
  // the pick and its alternatives are reported for logging
  let seen;
  defaultCallbackBase({ host: '0.0.0.0' }, ifaces, (pick, all) => { seen = { pick, all }; });
  assert.equal(seen.pick.name, 'en0');
  assert.deepEqual(seen.all.map((c) => c.name), ['en0']);
});

test('defaultCallbackBase: a bound IPv6 host is preserved and bracketed', () => {
  const ifaces = { en0: [{ address: '192.168.50.241', family: 'IPv4', internal: false }] };
  assert.equal(defaultCallbackBase({ host: '::1' }, ifaces), 'http://[::1]:8788');
  assert.equal(defaultCallbackBase({ host: 'fd00::123', port: 8790 }, ifaces), 'http://[fd00::123]:8790');
  // the v6 wildcard still advertises a LAN IPv4, which is what phones dial
  assert.equal(defaultCallbackBase({ host: '::' }, ifaces), 'http://192.168.50.241:8788');
});

// --- choice intents ---------------------------------------------------------
// A choice intent is how a multi-option button (a model picker, a branch
// picker) exists at all. Before it, `decideIntent` validated against a fixed
// approve/deny vocabulary BEFORE looking the intent up, so no other answer
// could ever be legal.

test('a choice intent announces one button per option and spells out the typed form', async () => {
  _resetForTests();
  const announced = [];
  const id = await createIntent({
    prompt: 'Which model for session abc?',
    options: ['claude-opus-5', 'claude-sonnet-5'],
    announce: async (a) => announced.push(a),
  });
  assert.equal(announced.length, 1);
  assert.deepEqual(announced[0].options, ['claude-opus-5', 'claude-sonnet-5']);
  // and it is readable back off the intent, so the requester can map an answer
  assert.deepEqual(getIntent(id).options, ['claude-opus-5', 'claude-sonnet-5']);
});

test('an option list is an allow-list: an undeclared value is refused', async () => {
  _resetForTests();
  const id = await createIntent({
    prompt: 'pick', options: ['sonnet', 'opus'], announce: async () => {},
  });
  // the negative control - this is the whole point of validating against the
  // intent rather than accepting whatever tail the message carried
  const bad = decideIntent(id, 'claude-opus-4-1');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not an option/);
  assert.equal(getIntent(id).status, 'pending');
  // approve/deny are NOT a back door into a choice intent either
  assert.equal(decideIntent(id, 'approve').ok, false);
  // the declared spelling is what gets stored, whatever casing arrived
  const good = decideIntent(id, '  OPUS ');
  assert.equal(good.ok, true);
  assert.equal(getIntent(id).decision, 'opus');
});

test('a plain confirmation still refuses anything but approve/deny', async () => {
  _resetForTests();
  const id = await createIntent({ prompt: 'plain', announce: async () => {} });
  const r = decideIntent(id, 'sonnet');
  assert.equal(r.ok, false);
  assert.match(r.error, /approve/);
  assert.equal(decideIntent(id, 'approve').ok, true);
});

test('createIntent refuses a choice that cannot be a choice', async () => {
  _resetForTests();
  await assert.rejects(
    () => createIntent({ prompt: 'p', options: ['only-one'], announce: async () => {} }),
    /at least two/,
  );
  // duplicates collapse, so two labels that differ only by whitespace are one
  await assert.rejects(
    () => createIntent({ prompt: 'p', options: ['a', ' a '], announce: async () => {} }),
    /at least two/,
  );
});

test('chat-reply poller settles a choice from /choose and logs the value', async () => {
  _resetForTests();
  const id = await createIntent({
    prompt: 'pick a model', options: ['claude-opus-5', 'claude-sonnet-5'],
    announce: async () => {},
  });
  const batches = [
    { messages: [] },
    { messages: [
      // an agent must not be able to answer it, same gate as approve/deny
      { id: 'c0', from: '@ether', body: `/choose ${id} claude-opus-5`, isHuman: false },
      { id: 'c1', from: 'petrus', body: `/choose ${id} claude-sonnet-5`, isHuman: true },
    ] },
  ];
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') return { ok: true, json: async () => ({}) };
    const batch = batches[Math.min(call++, batches.length - 1)];
    return { ok: true, json: async () => batch };
  };
  const lines = [];
  const handle = startChatReplyPoller({
    apiKey: 'k', room: 'r', intervalMs: 10, owners: ['petrus'], log: (m) => lines.push(m),
  });
  try { await new Promise((r) => setTimeout(r, 120)); }
  finally { clearInterval(handle); globalThis.fetch = originalFetch; }

  const settled = getIntent(id);
  assert.equal(settled.status, 'decided');
  assert.equal(settled.decision, 'claude-sonnet-5');
  const joined = lines.join('\n');
  assert.match(joined, new RegExp(`/choose ${id} claude-sonnet-5 from petrus: settled`));
  assert.match(joined, /ether.*not the owner/i);
});

test('HTTP POST /intent carries options, and a bad option list is 400 not 500', async () => {
  _resetForTests();
  const ok = await fetch(`http://127.0.0.1:${TEST_PORT}/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'pick a model', options: ['opus', 'sonnet'] }),
  });
  assert.equal(ok.status, 201);
  const { id } = await ok.json();
  assert.deepEqual(getIntent(id).options, ['opus', 'sonnet']);

  // Caller errors must not present as daemon faults - a 500 sends someone
  // looking in the daemon for a typo in their own request.
  const notArray = await fetch(`http://127.0.0.1:${TEST_PORT}/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'p', options: 'opus' }),
  });
  assert.equal(notArray.status, 400);

  const tooFew = await fetch(`http://127.0.0.1:${TEST_PORT}/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'p', options: ['only-one'] }),
  });
  assert.equal(tooFew.status, 400);

  // and an intent with NO options is still a plain confirmation
  const plain = await fetch(`http://127.0.0.1:${TEST_PORT}/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'plain' }),
  });
  assert.equal(plain.status, 201);
  assert.equal(getIntent((await plain.json()).id).options, null);
});
