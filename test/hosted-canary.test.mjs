// The hosted canary, and specifically the failure it exists to catch.
//
// A liveness ping calls a service healthy whenever it returns 200. The outage
// this is built for looked healthy by that standard: the app answered, and the
// thing behind it did not work. So the case that matters most below is
// "wrote ok but could not read it back" - two green HTTP calls, one broken
// service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryBody, classify, runCanary, alertOnce } from '../scripts/hosted-canary.mjs';

const NONCE = 'nonce-1234';

function envWith(extra = {}) {
  return { IAK_CANARY_KEY: 'test-key', IAK_CANARY_BASE: 'http://h/v1', ...extra };
}

test('a clean round trip is healthy', () => {
  assert.deepEqual(classify({ posted: true, readBack: `x ${NONCE} y`, nonce: NONCE }), {
    ok: true,
    reason: 'round trip ok',
  });
});

test('THE case a ping misses: both calls 200, the data is not there', () => {
  const v = classify({ posted: true, readBack: '{"messages":[]}', nonce: NONCE });
  assert.equal(v.ok, false);
  assert.match(v.reason, /could not read it back/);
});

test('write failure and read failure are distinguished, not merged', () => {
  assert.match(classify({ posted: false, readBack: null, nonce: NONCE }).reason, /write/);
  assert.match(classify({ posted: true, readBack: null, nonce: NONCE }).reason, /read/);
});

test('no key is misconfiguration, not an outage', async () => {
  const r = await runCanary({});
  assert.equal(r.configured, false);
  assert.match(r.reason, /IAK_CANARY_KEY/);
});

test('the key is sent as a header and never lands in a URL', async () => {
  const seen = [];
  const jsonFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, body: `[{"body":"canary ${NONCE}"}]` };
  };
  await runCanary(envWith(), { jsonFetch, newNonce: () => NONCE });
  for (const c of seen) {
    assert.ok(!c.url.includes('test-key'), 'key must never appear in a URL');
    assert.equal(c.init.headers['X-API-Key'], 'test-key');
  }
});

test('a failed write does NOT trigger a read (no extra load during an outage)', async () => {
  let calls = 0;
  const jsonFetch = async () => {
    calls += 1;
    return { ok: false, status: 500, body: 'boom' };
  };
  const r = await runCanary(envWith(), { jsonFetch, newNonce: () => NONCE });
  assert.equal(calls, 1, 'one call only');
  assert.equal(r.ok, false);
  assert.match(r.reason, /write/);
});

test('alerts ONCE on the way down and ONCE on the way back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  const state = join(dir, 'state');
  const env = envWith({ IAK_CANARY_STATE: state });
  const posts = [];
  const deps = { postAlert: async (t) => posts.push(t) };

  const bad = { ok: false, reason: 'write failed', detail: 'POST 500', ms: 10 };
  assert.equal(await alertOnce(bad, env, deps), 'alerted');
  assert.equal(await alertOnce(bad, env, deps), 'no-change', 'must not re-alert');
  assert.equal(await alertOnce(bad, env, deps), 'no-change');
  assert.equal(posts.length, 1, 'exactly one down-alert');

  const good = { ok: true, reason: 'round trip ok', ms: 120 };
  assert.equal(await alertOnce(good, env, deps), 'all-clear');
  assert.equal(await alertOnce(good, env, deps), 'no-change', 'must not repeat the all-clear');
  assert.equal(posts.length, 2);
  assert.match(posts[1], /recovered/);
  assert.ok(!existsSync(state), 'state cleared so the next outage alerts again');
});

test('a healthy run with no prior failure says nothing at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  const posts = [];
  const r = await alertOnce(
    { ok: true, reason: 'round trip ok', ms: 5 },
    envWith({ IAK_CANARY_STATE: join(dir, 'state') }),
    { postAlert: async (t) => posts.push(t) },
  );
  assert.equal(r, 'no-change');
  assert.equal(posts.length, 0, 'silence when nothing changed');
});

test('the down-alert names the outage window when it recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  const state = join(dir, 'state');
  writeFileSync(state, '2026-09-20T01:00:00.000Z');
  const posts = [];
  await alertOnce({ ok: true, reason: 'ok', ms: 7 }, envWith({ IAK_CANARY_STATE: state }), {
    postAlert: async (t) => posts.push(t),
  });
  assert.match(posts[0], /down since 2026-09-20T01:00:00.000Z/);
});

test('the posted body carries the nonce so the read-back proves OUR write', () => {
  assert.match(canaryBody(NONCE), new RegExp(NONCE));
});
