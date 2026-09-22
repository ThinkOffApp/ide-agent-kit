// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests the WIRING gap the 2026-09-22 switcher audit found: bin/model-picker.mjs
// could raise and apply a choice, but nothing invoked it when a CHOICE intent
// settled from a channel that was not the CLI itself (a CodeWatch tap, a
// GroupMind web tap, the chat-reply poller). The fix is the `kind` tag on
// createIntent() plus registerKindHandler()/the decideIntent() hook in
// src/confirmations.mjs, and applyChoice() in src/model-selection.mjs.
//
// These tests exercise that wiring end to end - create a `kind: "model"`
// intent, decide it, and assert the REGISTERED HANDLER actually ran and did
// the right thing - not just applyChoice() in isolation. Each one is built so
// that removing the decideIntent() hook (the wiring, not the logic) makes it
// fail: the handler would simply never fire, `calls`/`result` would stay
// empty, and the assertions on them would fail loudly rather than passing
// vacuously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createIntent, decideIntent, registerKindHandler, unregisterKindHandler,
  pendingKindHandler, getIntent, _resetForTests,
} from '../src/confirmations.mjs';
import { applyChoice, OUTCOMES } from '../src/model-selection.mjs';

const CALLER_HOST = 'test-host';

function fakeRegistry() {
  return [
    { id: 'box-a', host: '10.0.0.1', port: 8000, kind: 'vllm', keyFile: null },
    { id: 'box-b', host: '10.0.0.2', port: 8000, kind: 'vllm', keyFile: null },
  ];
}

// A probe whose UP/DOWN answer per entry id is controlled by the test, so the
// SAME entry can be UP when the intent was raised and DOWN when the handler
// re-probes it at apply time - the exact gap applyChoice exists to catch.
function makeProbe(states) {
  return async (entries) => entries.map((e) => {
    const state = states[e.id] ?? 'UP';
    if (state !== 'UP') {
      return { id: e.id, state, reason: 'test-forced-down', checkedAt: new Date().toISOString() };
    }
    return {
      id: e.id, state: 'UP', reason: null, checkedAt: new Date().toISOString(),
      models: [`${e.id}-model`], freeMemGiB: 10, p90Ms: 5, jitterMs: 1, keyBlocked: false,
    };
  });
}

async function withSelectionPath(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iak-model-selection-test-'));
  try {
    await fn(join(dir, 'model-selection.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('decideIntent fires the registered "model" kind handler, which writes the selection when the choice is still UP', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    const states = { 'box-a': 'UP', 'box-b': 'UP' };
    const calls = [];
    // This mirrors, in shape, what bin/iak-mcp-daemon.mjs registers at
    // startup: re-probe the chosen entry and write the selection file.
    registerKindHandler('model', async ({ id, decision }) => {
      const result = await applyChoice({
        registry: fakeRegistry(),
        selectionPath,
        entryId: decision,
        callerHost: CALLER_HOST,
        intentId: id,
        probeImpl: makeProbe(states),
      });
      calls.push(result);
    });
    try {
      const id = await createIntent({
        prompt: 'Which model should test-host use?',
        options: ['box-a', 'box-b'],
        kind: 'model',
        announce: async () => {},
      });
      assert.equal(getIntent(id).kind, 'model');

      const decided = decideIntent(id, 'box-b');
      assert.equal(decided.ok, true);

      // decideIntent() itself is synchronous and does not await the handler
      // (a slow apply must not hold up a CodeWatch tap's HTTP response) -
      // tests await the promise it stashed instead.
      await pendingKindHandler(id);

      assert.equal(calls.length, 1, 'the model kind handler did not run at all - decideIntent is not wired to it');
      assert.equal(calls[0].outcome, OUTCOMES.APPLIED);
      assert.equal(calls[0].selection.selectedId, 'box-b');

      const written = JSON.parse(await readFile(selectionPath, 'utf8'));
      assert.equal(written.selectedId, 'box-b');
      assert.equal(written.model, 'box-b-model');
      assert.equal(written.selectedFrom, CALLER_HOST);
    } finally {
      unregisterKindHandler('model');
    }
  });
});

test('a model choice that went DOWN between offer and tap writes nothing and records the refusal', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    // box-b was UP when the intent was raised (that is why it is one of the
    // two options below) but by the time the tap lands and the handler
    // re-probes it, it has gone down.
    const states = { 'box-a': 'UP', 'box-b': 'DOWN' };
    let result;
    registerKindHandler('model', async ({ id, decision }) => {
      result = await applyChoice({
        registry: fakeRegistry(),
        selectionPath,
        entryId: decision,
        callerHost: CALLER_HOST,
        intentId: id,
        offeredState: 'UP',
        probeImpl: makeProbe(states),
      });
    });
    try {
      const id = await createIntent({
        prompt: 'Which model should test-host use?',
        options: ['box-a', 'box-b'],
        kind: 'model',
        announce: async () => {},
      });
      decideIntent(id, 'box-b');
      await pendingKindHandler(id);

      assert.ok(result, 'the model kind handler did not run at all - decideIntent is not wired to it');
      assert.equal(result.outcome, OUTCOMES.CHANGED_SINCE_OFFER);
      assert.match(result.error, /box-b was UP when offered and is DOWN now/);

      // Nothing was written: no selection file exists at all (this is a
      // fresh temp dir, so "nothing" and "unchanged" are the same file
      // read - readFile itself refuses).
      await assert.rejects(() => readFile(selectionPath, 'utf8'), /ENOENT/);
    } finally {
      unregisterKindHandler('model');
    }
  });
});

test('negative control: a non-model CHOICE intent triggers no apply', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    let called = 0;
    registerKindHandler('model', async () => { called += 1; });
    try {
      // Same shape as a model choice - a multi-option request_choice - but
      // with no kind tag, e.g. an ordinary branch or PR picker.
      const id = await createIntent({
        prompt: 'Which branch should we deploy?',
        options: ['main', 'feat/x'],
        announce: async () => {},
      });
      assert.equal(getIntent(id).kind, null);

      const decided = decideIntent(id, 'main');
      assert.equal(decided.ok, true);

      // No handler promise was ever stashed for this intent...
      assert.equal(pendingKindHandler(id), null);
      // ...and give a wrongly-unfiltered hook a tick to fire before asserting
      // it did not.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(called, 0, 'the model kind handler ran for an intent with no (or a different) kind');

      await assert.rejects(() => readFile(selectionPath, 'utf8'), /ENOENT/);
    } finally {
      unregisterKindHandler('model');
    }
  });
});
