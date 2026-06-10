// SPDX-License-Identifier: AGPL-3.0-only

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { intentConfig, intentClientFromConfig, shouldSuppressNudge, getIntentCached, clearIntentCache } from '../src/intent.mjs';
import { fetchIntentGate } from '../src/background.mjs';

const BASE_CONFIG = {
  intent: {
    baseUrl: 'https://example.test/api/v1',
    apiKey: 'k',
    userId: 'petrus'
  }
};

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

const realFetch = globalThis.fetch;

beforeEach(() => clearIntentCache());
afterEach(() => { globalThis.fetch = realFetch; });

// --- intentConfig ---

test('intentConfig returns null without required fields', () => {
  assert.equal(intentConfig({}), null);
  assert.equal(intentConfig({ intent: { baseUrl: 'x', apiKey: 'y' } }), null);
});

test('intentConfig accepts camelCase and snake_case keys', () => {
  const camel = intentConfig(BASE_CONFIG);
  assert.equal(camel.userId, 'petrus');
  assert.equal(camel.suppressNudges, true);

  const snake = intentConfig({
    intent: { base_url: 'https://example.test', api_key: 'k', user_id: 'u', suppress_nudges: false }
  });
  assert.equal(snake.userId, 'u');
  assert.equal(snake.suppressNudges, false);
});

test('intentConfig falls back to poller handle for agentHandle', () => {
  const cfg = intentConfig({ ...BASE_CONFIG, poller: { handle: '@claudemm' } });
  assert.equal(cfg.agentHandle, '@claudemm');
});

test('intentClientFromConfig returns null when unconfigured', () => {
  assert.equal(intentClientFromConfig({}), null);
  assert.ok(intentClientFromConfig(BASE_CONFIG));
});

// --- fetchIntentGate (now via embedded IntentClient) ---

test('fetchIntentGate blocks on emergency-only urgency', async () => {
  mockFetch(async () => jsonResponse({ derived: { overall_state: 'working', urgency_mode: 'emergency-only' } }));
  const gate = await fetchIntentGate(BASE_CONFIG);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /emergency-only/);
});

test('fetchIntentGate is light-only during active desktop work', async () => {
  mockFetch(async () => jsonResponse({ derived: { overall_state: 'working', reachability_mode: 'desktop' } }));
  const gate = await fetchIntentGate(BASE_CONFIG);
  assert.equal(gate.allowed, true);
  assert.equal(gate.lightOnly, true);
});

test('fetchIntentGate allows full dreaming when sleeping', async () => {
  mockFetch(async () => jsonResponse({ derived: { overall_state: 'sleeping' } }));
  const gate = await fetchIntentGate(BASE_CONFIG);
  assert.equal(gate.allowed, true);
  assert.equal(gate.lightOnly, false);
});

test('fetchIntentGate sends X-API-Key auth header', async () => {
  let seenHeaders;
  mockFetch(async (url, opts) => { seenHeaders = opts.headers; return jsonResponse({ derived: {} }); });
  await fetchIntentGate(BASE_CONFIG);
  assert.equal(seenHeaders['X-API-Key'], 'k');
});

test('fetchIntentGate returns null on API failure (fail-open)', async () => {
  mockFetch(async () => { throw new Error('network down'); });
  assert.equal(await fetchIntentGate(BASE_CONFIG), null);
  assert.equal(await fetchIntentGate({}), null);
});

// --- shouldSuppressNudge ---

test('shouldSuppressNudge true only in emergency-only mode', async () => {
  mockFetch(async () => jsonResponse({ derived: { urgency_mode: 'emergency-only' } }));
  assert.equal(await shouldSuppressNudge(BASE_CONFIG), true);

  clearIntentCache();
  mockFetch(async () => jsonResponse({ derived: { urgency_mode: 'normal' } }));
  assert.equal(await shouldSuppressNudge(BASE_CONFIG), false);
});

test('shouldSuppressNudge fails open on error and respects opt-out', async () => {
  mockFetch(async () => { throw new Error('network down'); });
  assert.equal(await shouldSuppressNudge(BASE_CONFIG), false);
  assert.equal(await shouldSuppressNudge({}), false);

  const optOut = { intent: { ...BASE_CONFIG.intent, suppress_nudges: false } };
  mockFetch(async () => jsonResponse({ derived: { urgency_mode: 'emergency-only' } }));
  assert.equal(await shouldSuppressNudge(optOut), false);
});

// --- getIntentCached ---

test('getIntentCached caches within TTL', async () => {
  let calls = 0;
  mockFetch(async () => { calls++; return jsonResponse({ derived: { overall_state: 'working' } }); });
  await getIntentCached(BASE_CONFIG);
  await getIntentCached(BASE_CONFIG);
  assert.equal(calls, 1);
});
