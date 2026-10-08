// SPDX-License-Identifier: AGPL-3.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSwitcher, normalizeModelName } from '../src/model-switcher.js';
import { IntentClient } from '../src/client.js';
import { DesktopAdapter } from '../src/adapters/desktop.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'uik-switch-test-'));
  const f = {
    now: Date.parse('2026-01-01T00:00:00Z'), posts: [], reports: [], reads: 0,
    registry: { models: [{ name: 'next', fits: true, size_gb: 12, path: '/private/model', params_label: '20B' }], running: 'old', state: 'ready' },
    request: null, postStatus: 200, postBody: '{"ok":true}', failPatch: null,
  };
  const chooser = createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/api/models') { f.reads++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(f.registry)); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    f.posts.push(JSON.parse(body));
    assert.equal(req.url, '/api/model');
    res.writeHead(f.postStatus); res.end(f.postBody);
  });
  const intent = createServer(async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'fake-test-key');
    assert.equal(req.url, '/api/v1/intent/test-user/test-box/switch');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ request: f.request })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const report = JSON.parse(body); f.reports.push(report);
    if (f.failPatch === report.status) { res.writeHead(503); res.end('{}'); return; }
    assert.equal(report.id, f.request.id);
    f.request = { ...f.request, ...report };
    res.end(JSON.stringify({ request: f.request }));
  });
  await Promise.all([new Promise(r => chooser.listen(0, '127.0.0.1', r)), new Promise(r => intent.listen(0, '127.0.0.1', r))]);
  t.after(async () => {
    chooser.closeAllConnections(); intent.closeAllConnections();
    await Promise.all([new Promise(r => chooser.close(r)), new Promise(r => intent.close(r))]);
    await rm(dir, { recursive: true, force: true });
  });
  f.client = new IntentClient({ baseUrl: `http://127.0.0.1:${intent.address().port}/api/v1`, apiKey: 'fake-test-key', userId: 'test-user', deviceId: 'test-box' });
  f.warnings = [];
  f.options = { chooserUrl: `http://127.0.0.1:${chooser.address().port}`, stateFile: join(dir, 'state.json'), brainOf: 'test-brain', now: () => f.now, warn: message => f.warnings.push(message) };
  f.newSwitcher = () => new ModelSwitcher(f.client, f.options);
  f.pending = (extra = {}) => { f.request = { id: 'request-1', model: 'next', requested_at: new Date(f.now).toISOString(), status: 'pending', ...extra }; };
  return f;
}

test('disabled is network-free and publishes no chooser fields', async () => {
  const s = new ModelSwitcher({}, { chooserUrl: '', fetchImpl: () => { throw new Error('network'); } });
  assert.deepEqual(await s.refresh(), {}); await s.poll(); s.start(); s.stop();
});

test('catalog fields are explicit, sanitized, and cleared on outage', async t => {
  const f = await fixture(t), s = f.newSwitcher();
  assert.deepEqual(await s.refresh(), { model_catalog: [{ name: 'next', fits: true, size_gb: 12, params_label: '20B' }], model: 'old', model_state: 'ready', brain_of: 'test-brain' });
  f.registry = { models: 'invalid', state: 'ready' };
  assert.deepEqual(await s.refresh(), { model_catalog: [], model: null, model_state: 'down', brain_of: 'test-brain' });
});

test('real fake HTTP services: dispatch once, wait for ready AND matching model, then done', async t => {
  const f = await fixture(t), s = f.newSwitcher(); f.pending();
  await s.poll(); assert.deepEqual(f.posts, [{ name: 'next' }]);
  assert.equal(f.request.status, 'running');
  f.registry.state = 'loading'; f.registry.running = 'next'; await s.poll();
  assert.equal(f.request.status, 'running');
  f.registry.state = 'ready'; f.registry.running = 'old'; await s.poll();
  assert.equal(f.request.status, 'running');
  f.registry.running = '/models/next-00001-of-00002.gguf'; await s.poll();
  assert.equal(f.request.status, 'done'); await s.poll();
  assert.equal(f.posts.length, 1);
});

for (const [label, extra, status] of [
  ['unknown local model', { model: 'server-only' }, 'failed'],
  ['old pending', { requested_at: '2025-12-31T23:49:59Z' }, 'expired'],
  ['invalid timestamp', { requested_at: 'garbage' }, 'expired'],
  ['server-expired', { status: 'expired' }, 'expired'],
]) test(`rejects ${label} without chooser POST`, async t => {
  const f = await fixture(t); f.pending(extra); await f.newSwitcher().poll();
  assert.equal(f.request.status, status); assert.equal(f.posts.length, 0);
});

test('local fits must be true, even if web offered it', async t => {
  const f = await fixture(t); f.registry.models[0].fits = false; f.pending();
  await f.newSwitcher().poll(); assert.equal(f.request.status, 'failed'); assert.equal(f.posts.length, 0);
});

test('409 chooser body is relayed unchanged', async t => {
  const f = await fixture(t); f.pending(); f.postStatus = 409; f.postBody = '{"ok":false,"error":"busy — wait"}';
  await f.newSwitcher().poll(); assert.equal(f.request.status, 'failed'); assert.equal(f.request.detail, f.postBody);
});

test('restart with persisted dispatch reconciles without POST replay', async t => {
  const f = await fixture(t); f.pending(); await f.newSwitcher().poll();
  const s = f.newSwitcher(); await s.poll(); assert.equal(f.posts.length, 1);
  f.registry.running = 'next'; await s.poll(); assert.equal(f.request.status, 'done');
});

test('failed running PATCH prevents dispatch, restart does not dispatch pending claim', async t => {
  const f = await fixture(t); f.pending(); f.failPatch = 'running';
  await assert.rejects(f.newSwitcher().poll()); assert.equal(f.posts.length, 0);
  f.failPatch = null; await f.newSwitcher().poll();
  assert.equal(f.request.status, 'failed'); assert.equal(f.posts.length, 0);
});

test('terminal report failure retries the report, not the selection', async t => {
  const f = await fixture(t); f.pending(); const s = f.newSwitcher(); await s.poll();
  f.registry.running = 'next'; f.failPatch = 'done'; await assert.rejects(s.poll());
  f.failPatch = null; await f.newSwitcher().poll();
  assert.equal(f.request.status, 'done'); assert.equal(f.posts.length, 1);
});

test('timeout closes request, even with a down chooser', async t => {
  const f = await fixture(t); f.pending(); const s = f.newSwitcher(); await s.poll();
  f.now += 900000; f.registry = {}; await s.poll();
  assert.equal(f.request.status, 'failed'); assert.match(f.request.detail, /Timed out/); assert.equal(f.posts.length, 1);
});

test('unreadable/corrupt state fails closed; overlapping polls dispatch once', async t => {
  const f = await fixture(t); f.pending();
  await writeFile(f.options.stateFile, 'broken');
  await assert.rejects(f.newSwitcher().poll()); assert.equal(f.posts.length, 0);
  await rm(f.options.stateFile); const s = f.newSwitcher();
  await Promise.all([s.poll(), s.poll(), s.poll()]); assert.equal(f.posts.length, 1);
  const state = JSON.parse(await readFile(f.options.stateFile, 'utf8'));
  assert.equal(state.records['request-1'].status, 'dispatched');
});

test('unknown running request is not adopted or dispatched', async t => {
  const f = await fixture(t); f.pending({ status: 'running' }); await f.newSwitcher().poll();
  assert.equal(f.posts.length, 0); assert.equal(f.reports.length, 0);
});

test('normalization strips only basename, gguf and numeric shard suffix', () => {
  assert.equal(normalizeModelName('/models/My-Model-00001-of-00003.gguf'), 'My-Model');
  assert.equal(normalizeModelName('My-Model'), 'My-Model');
});

test('already ready model completes without chooser POST', async t => {
  const f = await fixture(t); f.pending(); f.registry.running = '/models/next-00001-of-00003.gguf';
  await f.newSwitcher().poll();
  assert.equal(f.request.status, 'done'); assert.equal(f.request.detail, 'already running');
  assert.equal(f.posts.length, 0);
});

test('normalized catalog match dispatches the LOCAL canonical name', async t => {
  const f = await fixture(t); f.pending({ model: '/models/next-00001-of-00003.gguf' });
  await f.newSwitcher().poll(); assert.deepEqual(f.posts, [{ name: 'next' }]);
});

test('ambiguous normalized names fail closed', async t => {
  const f = await fixture(t); f.pending(); f.registry.models.push({ name: 'next.gguf', fits: true });
  await f.newSwitcher().poll(); assert.equal(f.request.status, 'failed'); assert.equal(f.posts.length, 0);
});

test('warnings rate-limit corrupt state and dead chooser, without raw error content', async t => {
  const f = await fixture(t); f.pending(); const s = f.newSwitcher();
  await writeFile(f.options.stateFile, 'secret-example-bad-json');
  await assert.rejects(s.poll()); await assert.rejects(s.poll());
  assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /state file unreadable or corrupt/);
  assert.ok(!f.warnings[0].includes('secret-example'));
  f.now += 300000; await assert.rejects(s.poll()); assert.equal(f.warnings.length, 2);
  const other = f.newSwitcher(); f.registry = {};
  await other.refresh(); await other.refresh();
  assert.equal(f.warnings.length, 3); assert.match(f.warnings[2], /local chooser unavailable/);
});

test('uncertain POST response reconciles on restart without replay', async t => {
  const f = await fixture(t); f.pending();
  const s = new ModelSwitcher(f.client, { ...f.options, fetchImpl: async (url, opts) => {
    const result = await fetch(url, opts);
    if (opts.method === 'POST') throw new Error('response lost after side effect');
    return result;
  } });
  await s.poll(); assert.equal(f.posts.length, 1);
  f.registry.running = 'next'; await f.newSwitcher().poll();
  assert.equal(f.request.status, 'done'); assert.equal(f.posts.length, 1);
});

test('desktop chooser fields override stale static/probe labels and uses no generation probe', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = []; let generationStarts = 0, switchStarts = 0;
  let fields = { model_catalog: [{ name: 'next' }], model: 'next', model_state: 'ready', brain_of: 'brain' };
  const switcher = { enabled: true, refresh: async () => fields, start() { switchStarts++; }, stop() {} };
  const adapter = new DesktopAdapter({ patchDevice: async x => sent.push(x) }, {
    modelSwitcher: switcher, model: 'stale-static', availabilityProbe: null,
    modelProbe: { start() { generationStarts++; }, stop() {}, lastResult() { return { model: 'stale-probe' }; } },
  });
  adapter.start(); await new Promise(r => setImmediate(r));
  assert.equal(generationStarts, 0); assert.equal(switchStarts, 1);
  assert.equal(sent[0].model, 'next');
  fields = { model_catalog: [], model: null, model_state: 'down', brain_of: '' };
  t.mock.timers.tick(30000); await new Promise(r => setImmediate(r));
  adapter.stop(); assert.equal(sent.length, 2);
  for (const key of ['model_catalog', 'model', 'model_state', 'brain_of']) assert.deepEqual(sent[1][key], fields[key]);
});
