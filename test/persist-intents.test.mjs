// Durable intents across a restart.
//
// The lead-appointment case is at the bottom: since #131 the lead is state on
// main, and its row is written by setLead and replayed here.
//
// Written because on 2026-09-19 three daemon restarts silently wiped every
// pending intent AND the lead petrus had just appointed. The store was a bare
// `new Map()` with nothing read back at boot, so an approval card became
// undecidable and nobody was told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'iak-persist-'));
const statePath = join(dir, 'state.jsonl');

// Fresh module instance per "process", which is what a restart actually is.
async function boot(path) {
  const m = await import('../src/confirmations.mjs?v=' + Math.random());
  const summary = m.loadPersistedState(path);
  return { m, summary };
}

test('an intent survives a restart, with its decision', async () => {
  const a = await boot(statePath);
  const id = await a.m.createIntent({ prompt: 'benign test', session: 's', channels: [] });
  assert.ok(id, 'intent created');

  // Restart: a brand new module instance replays the log.
  const b = await boot(statePath);
  assert.equal(b.summary.intents, 1, 'one intent replayed');
  const after = b.m.listIntents().find((i) => i.id === id);
  assert.ok(after, 'the intent came back');
  assert.equal(after.status, 'pending', 'and it is still pending, so it can still be decided');
});

test('a decision survives a restart', async () => {
  const p2 = join(dir, 'state2.jsonl');
  const a = await boot(p2);
  const id = await a.m.createIntent({ prompt: 'decide me', session: 's', channels: [] });
  a.m.decideIntent(id, 'approve', { actor: 'petrus' });

  const b = await boot(p2);
  const after = b.m.listIntents().find((i) => i.id === id);
  assert.equal(after.status, 'decided');
  assert.equal(after.decision, 'approve', 'the decision replayed, not just the intent');
});

test('a truncated final line is skipped, the rest survives', async () => {
  const p4 = join(dir, 'state4.jsonl');
  const a = await boot(p4);
  await a.m.createIntent({ prompt: 'first', session: 's', channels: [] });
  // Simulate a hard kill mid-append: valid lines, then a partial one.
  writeFileSync(p4, readFileSync(p4, 'utf8') + '{"kind":"intent","intent":{"id":"trunc"');

  const b = await boot(p4);
  assert.equal(b.summary.skipped, 1, 'the partial line was skipped');
  assert.equal(b.summary.intents, 1, 'and the intact intent still loaded');
});

test('with no state path nothing is written — persistence is opt-in', async () => {
  const unused = join(dir, 'never.jsonl');
  const a = await boot(null);
  await a.m.createIntent({ prompt: 'no persistence', session: 's', channels: [] });
  assert.equal(existsSync(unused), false, 'no file appeared');
  assert.equal(a.summary.intents, 0, 'and loading nothing reports nothing');
});

test('the lead survives a restart, and a clear survives too', async () => {
  // claudeMB, review of #131: setLead wrote a receipt only, so every restart
  // vacated the post while the replay comment claimed lead rows were handled.
  const p5 = join(dir, 'state5.jsonl');
  const a = await boot(p5);
  const r = a.m.setLead('hermes', { actor: 'petrus' });
  assert.equal(r.ok, true, 'owner appoints');

  const b = await boot(p5);
  assert.equal(b.summary.lead, '@hermes', 'the summary names the replayed lead');
  assert.equal(b.m.getLead()?.handle, '@hermes', 'the lead came back after the restart');
  assert.equal(b.m.getLead()?.assignedBy, '@petrus', 'with who appointed it');

  b.m.setLead(null, { actor: 'petrus' });
  const c = await boot(p5);
  assert.equal(c.m.getLead(), null, 'a clear is the last row and wins on replay');
  assert.equal(c.summary.lead, null);
});
