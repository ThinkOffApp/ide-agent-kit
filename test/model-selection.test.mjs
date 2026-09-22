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
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIntent, decideIntent, registerKindHandler, unregisterKindHandler,
  pendingKindHandler, getIntent, _resetForTests,
} from '../src/confirmations.mjs';
import {
  applyChoice, OUTCOMES, DEFAULT_SELECTION_PATH,
  resolveModelRegistryPath, resolveModelSelectionPath,
} from '../src/model-selection.mjs';

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

// --- PR #130 review fixes ---------------------------------------------------
//
// (1) bin/iak-mcp-daemon.mjs read `cc.model_registry` (i.e.
// mcp.confirmations.model_registry) while src/mcp-server.mjs read
// `config.mcp.model_registry` - one level up, a DIFFERENT key. A custom
// registry path configured under mcp.confirmations would be picked up by the
// daemon's apply step and silently ignored by request_model_choice's offer
// step (or vice versa), so the two would probe different files without
// either side erroring. The fix is one resolver both call.

test('resolveModelRegistryPath: a custom path under mcp.confirmations is honoured; otherwise falls back to <root>/config/models.json', () => {
  const custom = '/wherever/models.json';
  const config = { mcp: { confirmations: { model_registry: custom } } };
  assert.equal(resolveModelRegistryPath(config, '/root'), custom);
  assert.equal(resolveModelRegistryPath({}, '/root'), join('/root', 'config', 'models.json'));
  // The bug this replaces: a value one level up (mcp.model_registry, not
  // mcp.confirmations.model_registry) must NOT be picked up - that was
  // src/mcp-server.mjs's actual mistake, and a resolver that tolerated it
  // would not have caught it.
  assert.equal(
    resolveModelRegistryPath({ mcp: { model_registry: custom } }, '/root'),
    join('/root', 'config', 'models.json'),
  );
});

test('resolveModelSelectionPath: a custom path under mcp.confirmations is honoured; otherwise DEFAULT_SELECTION_PATH', () => {
  const custom = '/wherever/model-selection.json';
  const config = { mcp: { confirmations: { model_selection_path: custom } } };
  assert.equal(resolveModelSelectionPath(config), custom);
  assert.equal(resolveModelSelectionPath({}), DEFAULT_SELECTION_PATH);
});

test('a custom registry path configured once resolves identically for both the daemon (apply) and the MCP tool (offer)', () => {
  // Same config object, same rootDir a real checkout would pass from either
  // file (both bin/iak-mcp-daemon.mjs's ROOT and src/mcp-server.mjs's
  // __pkgDir are dirname(dirname(fileURLToPath(import.meta.url))) of a file
  // one level under the repo root) - if either file read a different config
  // key, or joined a different root, this would diverge.
  const config = {
    mcp: { confirmations: { model_registry: '/fleet/models.json', model_selection_path: '/fleet/selection.json' } },
  };
  const rootDir = '/some/checkout';
  const fromDaemon = resolveModelRegistryPath(config, rootDir);
  const fromMcpServer = resolveModelRegistryPath(config, rootDir);
  assert.equal(fromDaemon, fromMcpServer);
  assert.equal(fromDaemon, '/fleet/models.json');

  // And with NO override, both still agree (on the default, joined against
  // whatever root each passes) - the resolver is what is shared, not merely
  // the happy-path value.
  assert.equal(resolveModelRegistryPath({}, rootDir), resolveModelRegistryPath({}, rootDir));

  // Structural check that both call sites actually use the shared resolver
  // for BOTH keys, rather than one of them quietly reading `cc.model_registry`
  // or `config.mcp.model_registry` directly again - a regression that would
  // reintroduce the exact two-different-files bug this test exists to catch,
  // without breaking anything above (both files would still individually
  // "work", just against different config keys).
  const daemonSrc = readFileSync(fileURLToPath(new URL('../bin/iak-mcp-daemon.mjs', import.meta.url)), 'utf8');
  const mcpServerSrc = readFileSync(fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url)), 'utf8');
  for (const src of [daemonSrc, mcpServerSrc]) {
    assert.match(src, /resolveModelRegistryPath\(/, 'expected resolveModelRegistryPath(...) to be called');
  }
  assert.match(daemonSrc, /resolveModelSelectionPath\(/, 'expected the daemon to resolve the selection path via the shared helper');
  // Neither file should read the registry/selection config keys any other way.
  assert.doesNotMatch(daemonSrc, /cc\.model_registry/);
  assert.doesNotMatch(mcpServerSrc, /config\?\.mcp\?\.model_registry\b/);
});

// (2) applyChoice() accepted a re-probed entry that was UP with ANY model
// name, never comparing it against what was actually shown in the offer. A
// box that is up but now serving a different model under the same id/port
// (a restart that picked up new weights, say) would apply silently - the
// written selection would look identical in shape to an ordinary apply, with
// nothing anywhere saying the model itself was not what was offered.

test('applyChoice still applies a box that is UP but now serves a different model, and reports modelChanged', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    const registry = fakeRegistry();
    // box-b answers UP both times, but with a different model at apply time
    // than the one the offer showed (offeredModel below) - e.g. the box
    // restarted onto different weights between the offer and the tap.
    const probeImpl = async (entries) => entries.map((e) => ({
      id: e.id, state: 'UP', reason: null, checkedAt: new Date().toISOString(),
      models: [e.id === 'box-b' ? 'box-b-model-v2' : `${e.id}-model`],
      freeMemGiB: 10, p90Ms: 5, jitterMs: 1, keyBlocked: false,
    }));

    const result = await applyChoice({
      registry,
      selectionPath,
      entryId: 'box-b',
      callerHost: CALLER_HOST,
      offeredState: 'UP',
      offeredModel: 'box-b-model-v1',
      probeImpl,
    });

    assert.equal(result.outcome, OUTCOMES.APPLIED);
    assert.deepEqual(result.modelChanged, { offered: 'box-b-model-v1', applied: 'box-b-model-v2' });

    // Still written - a model rename on an UP box is not a reason to refuse
    // the tap, only a reason to say so.
    const written = JSON.parse(await readFile(selectionPath, 'utf8'));
    assert.equal(written.selectedId, 'box-b');
    assert.equal(written.model, 'box-b-model-v2');
  });
});

test('applyChoice reports no modelChanged when the re-probed model matches what was offered', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    const result = await applyChoice({
      registry: fakeRegistry(),
      selectionPath,
      entryId: 'box-a',
      callerHost: CALLER_HOST,
      offeredState: 'UP',
      offeredModel: 'box-a-model',
      probeImpl: makeProbe({ 'box-a': 'UP' }),
    });
    assert.equal(result.outcome, OUTCOMES.APPLIED);
    assert.equal(result.modelChanged, undefined);
  });
});

test('the daemon threads the offer-time model name through the intent, so a decided model choice reports modelChanged end to end', async () => {
  _resetForTests();
  await withSelectionPath(async (selectionPath) => {
    let result;
    // Mirrors bin/iak-mcp-daemon.mjs's registerKindHandler('model', ...):
    // pull the offered model for the CHOSEN entry out of offeredModels
    // (as threaded through createIntent -> decideIntent's hook payload) and
    // pass it to applyChoice as offeredModel.
    registerKindHandler('model', async ({ decision, offeredModels }) => {
      result = await applyChoice({
        registry: fakeRegistry(),
        selectionPath,
        entryId: decision,
        callerHost: CALLER_HOST,
        offeredModel: offeredModels?.[decision] ?? null,
        probeImpl: async (entries) => entries.map((e) => ({
          id: e.id, state: 'UP', reason: null, checkedAt: new Date().toISOString(),
          models: [e.id === 'box-b' ? 'box-b-model-RESTARTED' : `${e.id}-model`],
          freeMemGiB: 10, p90Ms: 5, jitterMs: 1, keyBlocked: false,
        })),
      });
    });
    try {
      const id = await createIntent({
        prompt: 'Which model should test-host use?',
        options: ['box-a', 'box-b'],
        kind: 'model',
        // What request_model_choice records at raise time.
        offeredModels: { 'box-a': 'box-a-model', 'box-b': 'box-b-model' },
        announce: async () => {},
      });
      decideIntent(id, 'box-b');
      await pendingKindHandler(id);

      assert.ok(result, 'the model kind handler did not run - decideIntent is not wired to it');
      assert.equal(result.outcome, OUTCOMES.APPLIED);
      assert.deepEqual(result.modelChanged, { offered: 'box-b-model', applied: 'box-b-model-RESTARTED' });
    } finally {
      unregisterKindHandler('model');
    }
  });
});

// (3) request_model_choice's description must say plainly that without a
// running daemon, the decision is returned but NOT applied. This is
// documentation, not runtime behaviour, so the check is structural: read the
// tool definition's own description text back out of the source.

test('request_model_choice tool description states plainly that no daemon means the decision is returned but not applied', () => {
  const mcpServerSrc = readFileSync(fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url)), 'utf8');
  const start = mcpServerSrc.indexOf("name: 'request_model_choice'");
  assert.notEqual(start, -1, 'request_model_choice tool definition not found');
  const end = mcpServerSrc.indexOf('inputSchema:', start);
  const description = mcpServerSrc.slice(start, end);
  assert.match(description, /WITHOUT[^.]*daemon/i);
  assert.match(description, /NOT APPLI/i);
});
