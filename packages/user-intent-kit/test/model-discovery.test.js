import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelDiscovery } from '../src/model-discovery.js';
const env = { INTENT_MODEL_SERVER_URL: 'http://127.0.0.1:8888' };
const ok = data => ({ ok: true, json: async () => data });
test('OpenAI compatible server advertises all IDs without claiming loaded state', async () => {
  const probe = createModelDiscovery({ env, fetchImpl: async () => ok({ data: [{ id: 'glm' }, { id: 'qwen' }] }) });
  const r = await probe(); assert.equal(r.model, 'glm, qwen'); assert.equal(r.model_status, 'advertised');
});
test('LM Studio only lists loaded LLM instances, not downloaded models/embeddings', async () => {
  const probe = createModelDiscovery({ env: { ...env, INTENT_MODEL_SERVER_KIND: 'lmstudio' },
    fetchImpl: async url => { assert.ok(url.endsWith('/api/v1/models')); return ok({ models: [
      { type: 'llm', loaded_instances: [{ id: 'loaded' }] },
      { type: 'llm', loaded_instances: [] }, { type: 'embedding', loaded_instances: [{ id: 'embed' }] },
    ] }); } });
  assert.equal((await probe()).model, 'loaded');
});
test('authorized empty list clears previous model and does not revive manual label', async () => {
  const p = createModelDiscovery({ env: { ...env, INTENT_DEVICE_MODEL: 'old' }, fetchImpl: async () => ok({ data: [] }) });
  const r = await p(); assert.equal(r.model, null); assert.equal(r.model_status, 'none');
});
test('auth failure clears prior live model; manual fallback is explicitly labelled', async () => {
  let now = 0, calls = 0;
  const p = createModelDiscovery({ env, now: () => now, fetchImpl: async () => ++calls === 1
    ? ok({ data: [{ id: 'live' }] }) : { ok: false, status: 401 } });
  assert.equal((await p()).model, 'live'); now = 61000;
  const r = await p(); assert.equal(r.model, null); assert.equal(r.model_status, 'unauthorized');
  const manual = createModelDiscovery({ env: { ...env, INTENT_DEVICE_MODEL: 'typed' }, fetchImpl: async () => { throw Error('offline'); } });
  assert.equal((await manual()).model, 'typed (manual)');
});
test('server key is bound to explicit endpoint, redirects disabled, never uses intent key', async () => {
  let requests = 0;
  const p = createModelDiscovery({ env: { ...env, INTENT_API_KEY: 'never-send', INTENT_MODEL_SERVER_KEY_FILE: '/server-key' },
    readKey: async path => { assert.equal(path, '/server-key'); return 'server-only'; },
    fetchImpl: async (url, opts) => { requests++; assert.equal(opts.headers.Authorization, 'Bearer server-only');
      assert.equal(opts.redirect, 'error'); return ok({ data: [] }); } });
  await Promise.all([p(), p()]); await p(); assert.equal(requests, 1);
  const auto = createModelDiscovery({ env: { INTENT_API_KEY: 'never-send', INTENT_MODEL_SERVER_KEY_FILE: '/server-key' },
    readKey: async () => { throw Error('must not read'); }, fetchImpl: async (_, opts) => {
      assert.deepEqual(opts.headers, {}); throw Error('offline'); } });
  await auto();
});
test('unsafe URLs and malformed payloads fail unknown, not no-model', async () => {
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'file:///tmp/x']) {
    const p = createModelDiscovery({ env: { INTENT_MODEL_SERVER_URL: url }, fetchImpl: async () => { assert.fail('unsafe fetch'); } });
    assert.equal((await p()).model, null);
  }
  const p = createModelDiscovery({ env, fetchImpl: async () => ok({ data: [{}] }) });
  assert.equal((await p()).model_status, 'unknown');
});
