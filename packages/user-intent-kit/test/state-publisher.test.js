import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/state-publisher.js';
import { DesktopAdapter } from '../src/adapters/desktop.js';

test('unchanged agent status: 30s sampling yields 720 writes/day, not 2880', async () => {
  let now = 0, count = 0;
  const p = new StatePublisher(async () => count++, { refreshMs: 120000, now: () => now });
  for (; now < 86400000; now += 30000) await p.publish({ status: 'active' });
  assert.equal(count, 720);
});
test('task and offline transitions publish immediately', async () => {
  const sent = [];
  const p = new StatePublisher(async s => sent.push(s), { refreshMs: 120000, now: () => 0 });
  await p.publish({ status: 'active', task: null });
  await p.publish({ status: 'active', task: 'new' });
  await p.publish({ status: 'offline', task: null });
  assert.equal(sent.length, 3);
});
test('failed refresh is retried without advancing successful checkpoint', async () => {
  let tries = 0;
  const p = new StatePublisher(async () => { if (++tries === 1) throw Error('offline'); }, { refreshMs: 60000 });
  await assert.rejects(p.publish({ a: 1 }));
  await p.publish({ a: 1 });
  assert.equal(tries, 2);
});
test('in-flight changes coalesce to the latest state without concurrent writes', async () => {
  const sent = []; let release;
  const p = new StatePublisher(async s => {
    sent.push(s);
    if (sent.length === 1) await new Promise(r => { release = r; });
  }, { refreshMs: 60000 });
  const first = p.publish({ n: 1 });
  p.publish({ n: 2 });
  const last = p.publish({ n: 3 });
  release(); await first; await last;
  assert.deepEqual(sent, [{ n: 1 }, { n: 3 }]);
});
test('desktop uses one bounded timer, not an independent heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let patches = 0, beats = 0;
  const a = new DesktopAdapter({ patchDevice: async s => { patches++; assert.equal(s.ttl_sec, 90); },
    startHeartbeat: () => beats++, stopHeartbeat() {} }, { pollIntervalMs: 120000 });
  let samples = 0;
  a.publishState = async () => { samples++; };
  a.start(); await new Promise(r => setImmediate(r));
  assert.equal(samples, 1); assert.equal(beats, 0);
  t.mock.timers.tick(60000); await new Promise(r => setImmediate(r));
  assert.equal(samples, 2); // bounded detection with old 120-second setting
  a.stop();
});
test('invalid refresh intervals are rejected', () => {
  for (const n of [0, -1, NaN, Infinity]) assert.throws(() => new StatePublisher(async () => {}, { refreshMs: n }));
});
