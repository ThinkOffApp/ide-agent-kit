// SPDX-License-Identifier: AGPL-3.0-only
//
// The picker's job is to be right about a fleet that moves while the human
// is deciding, so most of these tests are about the gap between the offer and
// the tap rather than about the happy path.
//
// Two of them are negative controls in the strict sense: break the line of
// code they are about and they must FAIL. They were proven that way (see the
// PR body), because a check that cannot fail is not a check.
//
// DUMMY_SECRET is a made-up string. It is planted in the environment and in a
// key file, and the suite asserts it reaches neither the selection file nor
// any rendered output. A fixture carrying a real key would publish it: this
// repository is public.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pickModel,
  buildOffer,
  buildSelection,
  baseUrlFor,
  describeOffer,
  raiseChoice,
  daemonIsUp,
  renderOutcome,
  readSelection,
  writeSelection,
  OUTCOMES,
  EXIT_CODES,
} from '../bin/model-picker.mjs';
import { loadRegistry } from '../packages/user-intent-kit/src/model-capacity.js';
import { createIntent, decideIntent, getIntent } from '../src/confirmations.mjs';

const DUMMY_SECRET = 'sk-test-NOT-A-REAL-KEY-6f1d9c2b4a';

// --- fixtures --------------------------------------------------------------

const REGISTRY_SOURCE = {
  models: [
    { id: 'glm53-asus', host: 'asus1', port: 8888, kind: 'openai', sharing: 'exclusive', auth: 'bearer', keyFile: '/tmp/iak-test-key.txt' },
    { id: 'asus1-vllm-qwen3-coder', host: 'asus1', port: 8000, kind: 'vllm', sharing: 'exclusive' },
    { id: 'mini-lmstudio', host: 'mini', port: 1234, kind: 'lmstudio', sharing: 'shared' },
  ],
};

const registry = () => loadRegistry(REGISTRY_SOURCE);

/** A probe result shaped like the real one, with only the fields the picker reads. */
function result(id, state, extra = {}) {
  const entry = registry().find(e => e.id === id);
  const reasons = {
    UP: '1 model served',
    BUSY: 'only 2.1 GiB free, threshold 8 GiB',
    DOWN: 'endpoint answered but lists no loaded model',
    UNREACHABLE: 'connect failed (ENOTFOUND)',
  };
  return {
    id, host: entry.host, port: entry.port, kind: entry.kind,
    state,
    models: state === 'UP' ? [`${id}-model`] : [],
    freeMemGiB: state === 'UP' ? 40 : 2.1,
    p90Ms: 220, jitterMs: 12, path: 'direct',
    reason: reasons[state],
    checkedAt: new Date(1_700_000_000_000).toISOString(),
    ...extra,
  };
}

/** A probe whose answer changes from call to call: the fleet moving under us. */
function stubProbe(steps) {
  let call = 0;
  const fn = async (entries) => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    return step(entries);
  };
  fn.calls = () => call;
  return fn;
}

const ALL_UP = () => entries => entries.map(e => result(e.id, 'UP'));

/**
 * A stand-in for the intent daemon: the two endpoints request_choice uses.
 * `decide` is called with the created intent and returns the label to answer
 * with, or null to leave it pending forever (the timeout case).
 */
async function fakeDaemon({ decide = () => null, pollsBeforeDecision = 1, refuse = null } = {}) {
  const created = [];
  const rows = new Map();
  let polls = 0;
  const server = createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/intent') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        created.push(payload);
        if (refuse) return json(400, { ok: false, error: refuse });
        const id = `i${created.length}`;
        rows.set(id, { id, prompt: payload.prompt, options: payload.options, status: 'pending', decision: null });
        json(201, { ok: true, id });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/intents') {
      polls += 1;
      for (const row of rows.values()) {
        if (row.status === 'pending' && polls > pollsBeforeDecision) {
          const answer = decide(row);
          if (answer !== null && answer !== undefined) {
            row.status = 'decided';
            row.decision = answer;
          }
        }
      }
      json(200, [...rows.values()].map(({ id, status, decision, prompt, options }) => ({ id, status, decision, prompt, options })));
      return;
    }
    json(404, { ok: false, error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    created,
    close: () => new Promise(r => server.close(r)),
  };
}

/** A port nothing is listening on: bind one, read it, give it back. */
async function deadPort() {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iak-picker-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PREVIOUS = {
  selectedId: 'mini-lmstudio',
  baseUrl: 'http://mini:1234/api/v1',
  model: 'previous-model',
  keyFile: null,
  selectedAt: '2026-09-01T00:00:00.000Z',
  selectedFrom: 'mini',
};

async function seedPrevious(dir) {
  const path = join(dir, 'model-selection.json');
  await writeFile(path, JSON.stringify(PREVIOUS, null, 2) + '\n');
  return { path, before: await readFile(path) };
}

const REGISTRY_PATH = '/does/not/matter.json';
const readRegistryOk = async () => registry();

// --- offering --------------------------------------------------------------

test('NEGATIVE CONTROL: only UP entries are offered, and the excluded ones are named with their state', () => {
  const results = [
    result('glm53-asus', 'UP'),
    result('asus1-vllm-qwen3-coder', 'BUSY'),
    result('mini-lmstudio', 'UNREACHABLE'),
  ];
  const offer = buildOffer(results, { callerHost: 'testbox' });

  assert.deepEqual(offer.options, ['glm53-asus']);
  // The user must be able to see WHY the other two are missing, in the thing
  // that reaches the phone - not only in a log on the machine that probed.
  assert.match(offer.prompt, /asus1-vllm-qwen3-coder BUSY: only 2\.1 GiB free/);
  assert.match(offer.prompt, /mini-lmstudio UNREACHABLE: connect failed \(ENOTFOUND\)/);
  // ...and a BUSY box must never appear as something you can pick.
  assert.ok(!offer.options.includes('asus1-vllm-qwen3-coder'));
  assert.ok(!offer.options.includes('mini-lmstudio'));
});

test('the human detail is in the prompt, never in a label', () => {
  const offer = buildOffer([result('glm53-asus', 'UP')], { callerHost: 'testbox' });
  assert.deepEqual(offer.options, ['glm53-asus']);
  assert.match(offer.prompt, /glm53-asus - glm53-asus-model, 40 GiB free, p90 220 ms \+-12, direct/);
  for (const label of offer.options) {
    assert.ok(!/\s/.test(label), `label ${JSON.stringify(label)} carries prose, so it cannot round-trip as an id`);
  }
});

test('an UNREACHABLE fleet reports UNREACHABLE per entry, never "none available"', async () => {
  const outcome = await pickModel({
    registryPath: REGISTRY_PATH,
    readRegistryImpl: readRegistryOk,
    probeImpl: stubProbe([entries => entries.map(e => result(e.id, 'UNREACHABLE'))]),
    readSelectionImpl: async () => null,
  });
  assert.equal(outcome.outcome, OUTCOMES.NONE_UP);
  assert.deepEqual(outcome.states.map(s => s.state), ['UNREACHABLE', 'UNREACHABLE', 'UNREACHABLE']);
  const text = renderOutcome(outcome);
  for (const id of ['glm53-asus', 'asus1-vllm-qwen3-coder', 'mini-lmstudio']) {
    assert.match(text, new RegExp(`${id} UNREACHABLE`));
  }
  assert.ok(!/none available/i.test(text));
  assert.equal(EXIT_CODES[outcome.outcome], 3);
});

test('--dry-run prints the offer and raises nothing', async () => {
  let raised = 0;
  const outcome = await pickModel({
    registryPath: REGISTRY_PATH,
    dryRun: true,
    readRegistryImpl: readRegistryOk,
    probeImpl: stubProbe([entries => [result(entries[0].id, 'UP'), result(entries[1].id, 'BUSY'), result(entries[2].id, 'DOWN')]]),
    readSelectionImpl: async () => null,
    daemonIsUpImpl: async () => { raised += 1; return true; },
    raiseChoiceImpl: async () => { raised += 1; return { status: 'timeout' }; },
    writeSelectionImpl: async () => { throw new Error('a dry run must not write'); },
  });
  assert.equal(outcome.outcome, OUTCOMES.DRY_RUN);
  assert.equal(raised, 0);
  assert.deepEqual(outcome.options, ['glm53-asus']);
  assert.equal(EXIT_CODES[outcome.outcome], 0);
});

// --- the label is the answer ----------------------------------------------

test('the chosen id round-trips exactly through a real choice intent', async () => {
  const offer = buildOffer([result('glm53-asus', 'UP'), result('mini-lmstudio', 'UP')], { callerHost: 'testbox' });
  const id = await createIntent({ prompt: offer.prompt, options: offer.options, channels: [] });

  // A decorated label - the shape a picker that put detail in the button
  // would produce - matches no entry and must not settle the intent.
  const decorated = decideIntent(id, 'glm53-asus - glm53-asus-model, 40 GiB free');
  assert.equal(decorated.ok, false);
  assert.match(decorated.error, /is not an option/);

  const chosen = decideIntent(id, 'glm53-asus');
  assert.equal(chosen.ok, true);
  const settled = getIntent(id);
  assert.equal(settled.decision, 'glm53-asus');
  // The returned label maps back to exactly one registry entry. That is the
  // whole reason the labels are ids.
  const matches = registry().filter(e => e.id === settled.decision);
  assert.equal(matches.length, 1);
});

test('a decision that matches no entry is refused rather than applied', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pickModel({
      registryPath: REGISTRY_PATH,
      selectionPath: path,
      readRegistryImpl: readRegistryOk,
      probeImpl: stubProbe([ALL_UP()]),
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'a-box-nobody-offered' }),
    });
    assert.equal(outcome.outcome, OUTCOMES.CHANGED_SINCE_OFFER);
    assert.match(outcome.error, /matches no registry entry/);
    assert.deepEqual(await readFile(path), before);
  });
});

// --- the gap between the offer and the tap --------------------------------

test('NEGATIVE CONTROL: an entry that goes BUSY between offer and answer is not applied, and the previous selection survives', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    // First probe: everything is UP, so glm53-asus is offered. Second probe -
    // the one taken when the tap arrives - says it filled up while we waited.
    const probeImpl = stubProbe([
      ALL_UP(),
      entries => entries.map(e => result(e.id, 'BUSY')),
    ]);
    const outcome = await pickModel({
      registryPath: REGISTRY_PATH,
      selectionPath: path,
      readRegistryImpl: readRegistryOk,
      probeImpl,
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'glm53-asus' }),
    });

    assert.equal(probeImpl.calls(), 2, 'the chosen entry must be probed AGAIN when the answer arrives');
    assert.equal(outcome.outcome, OUTCOMES.CHANGED_SINCE_OFFER);
    assert.equal(outcome.offeredState, 'UP');
    assert.equal(outcome.currentState, 'BUSY');
    assert.match(outcome.error, /was UP when offered and is BUSY now/);
    // The file is the thing that matters: not rewritten, not rewritten with
    // the same content, not touched at all.
    assert.deepEqual(await readFile(path), before);
    assert.equal(EXIT_CODES[outcome.outcome], 6);
  });
});

test('an entry that is still UP at apply time IS applied (the control for the control)', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'model-selection.json');
    const probeImpl = stubProbe([ALL_UP(), ALL_UP()]);
    const outcome = await pickModel({
      registryPath: REGISTRY_PATH,
      selectionPath: path,
      readRegistryImpl: readRegistryOk,
      probeImpl,
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'glm53-asus' }),
      now: () => 1_700_000_100_000,
      callerHost: 'testbox',
    });
    assert.equal(probeImpl.calls(), 2);
    assert.equal(outcome.outcome, OUTCOMES.APPLIED);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(written, {
      selectedId: 'glm53-asus',
      baseUrl: 'http://asus1:8888/v1',
      model: 'glm53-asus-model',
      keyFile: '/tmp/iak-test-key.txt',
      selectedAt: new Date(1_700_000_100_000).toISOString(),
      selectedFrom: 'testbox',
    });
  });
});

test('a timeout leaves the previous selection byte-identical', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const daemon = await fakeDaemon({ decide: () => null });
    try {
      const outcome = await pickModel({
        registryPath: REGISTRY_PATH,
        selectionPath: path,
        daemonBase: daemon.base,
        readRegistryImpl: readRegistryOk,
        probeImpl: stubProbe([ALL_UP()]),
        timeoutSec: 0.25,
        pollMs: 25,
      });
      assert.equal(outcome.outcome, OUTCOMES.TIMEOUT);
      assert.deepEqual(await readFile(path), before);
      assert.match(renderOutcome(outcome), /Previous selection left as it was: mini-lmstudio/);
      assert.equal(EXIT_CODES[outcome.outcome], 5);
    } finally {
      await daemon.close();
    }
  });
});

// --- credentials -----------------------------------------------------------

test('the written selection carries the keyFile PATH and no key material', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'model-selection.json');
    const keyFile = join(dir, 'glm-key.txt');
    await writeFile(keyFile, `${DUMMY_SECRET}\n`, { mode: 0o600 });
    const env = { ...process.env, LLM_API_KEY: DUMMY_SECRET, LLM_API_KEY_FILE: keyFile };
    const previousEnv = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_API_KEY_FILE: process.env.LLM_API_KEY_FILE };
    process.env.LLM_API_KEY = env.LLM_API_KEY;
    process.env.LLM_API_KEY_FILE = env.LLM_API_KEY_FILE;
    try {
      const outcome = await pickModel({
        registryPath: REGISTRY_PATH,
        selectionPath: path,
        readRegistryImpl: async () => loadRegistry({
          models: [
            { id: 'glm53-asus', host: 'asus1', port: 8888, kind: 'openai', auth: 'bearer', keyFile },
            { id: 'mini-lmstudio', host: 'mini', port: 1234, kind: 'lmstudio' },
          ],
        }),
        probeImpl: stubProbe([
          entries => entries.map(e => result(e.id, 'UP')),
          entries => entries.map(e => result(e.id, 'UP')),
        ]),
        daemonIsUpImpl: async () => true,
        raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'glm53-asus' }),
      });
      assert.equal(outcome.outcome, OUTCOMES.APPLIED);
      const text = await readFile(path, 'utf8');
      // The path is there...
      assert.match(text, new RegExp(keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // ...and the token that the path points at is not, even though it was
      // sitting in two environment variables while this ran.
      assert.ok(!text.includes(DUMMY_SECRET), 'the selection file must never contain key material');
      assert.ok(!renderOutcome(outcome).includes(DUMMY_SECRET));
      assert.ok(!renderOutcome(outcome, { json: true }).includes(DUMMY_SECRET));
    } finally {
      for (const [k, v] of Object.entries(previousEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

// --- refusals, each its own ------------------------------------------------

test('a missing registry is its own refusal, naming the path', async () => {
  const outcome = await pickModel({ registryPath: join(tmpdir(), 'iak-no-such-registry.json') });
  assert.equal(outcome.outcome, OUTCOMES.NO_REGISTRY);
  assert.match(renderOutcome(outcome), /no usable registry at .*iak-no-such-registry\.json/);
  assert.equal(EXIT_CODES[outcome.outcome], 2);
});

test('a daemon that is not answering is its own refusal, and writes nothing', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const port = await deadPort();
    const outcome = await pickModel({
      registryPath: REGISTRY_PATH,
      selectionPath: path,
      daemonBase: `http://127.0.0.1:${port}`,
      readRegistryImpl: readRegistryOk,
      probeImpl: stubProbe([ALL_UP()]),
    });
    assert.equal(outcome.outcome, OUTCOMES.DAEMON_UNREACHABLE);
    assert.match(outcome.error, /nobody was asked, so nothing was changed/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(EXIT_CODES[outcome.outcome], 4);
  });
});

test('one UP entry is refused as a choice rather than applied without a tap', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pickModel({
      registryPath: REGISTRY_PATH,
      selectionPath: path,
      readRegistryImpl: readRegistryOk,
      probeImpl: stubProbe([entries => [result(entries[0].id, 'UP'), result(entries[1].id, 'BUSY'), result(entries[2].id, 'DOWN')]]),
      daemonIsUpImpl: async () => { throw new Error('must not reach the daemon'); },
    });
    assert.equal(outcome.outcome, OUTCOMES.ONLY_ONE_UP);
    assert.deepEqual(await readFile(path), before);
  });
});

// --- the daemon round trip -------------------------------------------------

test('raiseChoice posts the options and returns the tapped label', async () => {
  const daemon = await fakeDaemon({ decide: row => row.options[1] });
  try {
    const answer = await raiseChoice({
      daemonBase: daemon.base,
      prompt: 'which one?',
      options: ['glm53-asus', 'mini-lmstudio'],
      pollMs: 20,
      timeoutSec: 5,
    });
    assert.equal(answer.status, 'decided');
    assert.equal(answer.decision, 'mini-lmstudio');
    assert.deepEqual(daemon.created[0].options, ['glm53-asus', 'mini-lmstudio']);
    assert.equal(daemon.created[0].session, 'model-picker');
  } finally {
    await daemon.close();
  }
});

test('a daemon that refuses the intent is reported, not retried into silence', async () => {
  const daemon = await fakeDaemon({ refuse: 'options must be an array' });
  try {
    const answer = await raiseChoice({ daemonBase: daemon.base, prompt: 'p', options: ['a', 'b'], pollMs: 20, timeoutSec: 1 });
    assert.equal(answer.status, 'refused');
    assert.match(answer.error, /options must be an array/);
  } finally {
    await daemon.close();
  }
});

test('daemonIsUp is false for a port nothing is listening on, true for the daemon', async () => {
  const port = await deadPort();
  assert.equal(await daemonIsUp({ daemonBase: `http://127.0.0.1:${port}` }), false);
  const daemon = await fakeDaemon({});
  try {
    assert.equal(await daemonIsUp({ daemonBase: daemon.base }), true);
  } finally {
    await daemon.close();
  }
});

test('the whole flow works against the HTTP daemon, from offer to written file', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'model-selection.json');
    const daemon = await fakeDaemon({ decide: row => row.options[0] });
    try {
      const outcome = await pickModel({
        registryPath: REGISTRY_PATH,
        selectionPath: path,
        daemonBase: daemon.base,
        readRegistryImpl: readRegistryOk,
        probeImpl: stubProbe([ALL_UP(), ALL_UP()]),
        pollMs: 20,
        timeoutSec: 5,
        callerHost: 'testbox',
      });
      assert.equal(outcome.outcome, OUTCOMES.APPLIED);
      assert.equal(outcome.selection.selectedId, 'glm53-asus');
      assert.match(daemon.created[0].prompt, /Which model should testbox use\?/);
      assert.deepEqual(daemon.created[0].options, ['glm53-asus', 'asus1-vllm-qwen3-coder', 'mini-lmstudio']);
      assert.match(renderOutcome(outcome), /re-probed UP at .* before writing/);
    } finally {
      await daemon.close();
    }
  });
});

// --- small pieces ----------------------------------------------------------

test('baseUrlFor speaks OpenAI for openai/vllm and LM Studio for lmstudio', () => {
  const [glm, vllm, lmstudio] = registry();
  assert.equal(baseUrlFor(glm), 'http://asus1:8888/v1');
  assert.equal(baseUrlFor(vllm), 'http://asus1:8000/v1');
  assert.equal(baseUrlFor(lmstudio), 'http://mini:1234/api/v1');
});

test('a capacity reading we could not take prints as unknown, never as 0 GiB', () => {
  const line = describeOffer(result('glm53-asus', 'UP', { freeMemGiB: null, p90Ms: null, jitterMs: null }));
  assert.match(line, /free unknown/);
  assert.match(line, /latency unknown/);
  assert.ok(!/0 GiB/.test(line));
});

test('buildSelection carries no field the registry did not have, and no token', () => {
  const [glm] = registry();
  const selection = buildSelection(glm, result('glm53-asus', 'UP'), { callerHost: 'testbox', now: () => 0 });
  assert.deepEqual(Object.keys(selection).sort(), ['baseUrl', 'keyFile', 'model', 'selectedAt', 'selectedFrom', 'selectedId']);
  assert.equal(selection.keyFile, '/tmp/iak-test-key.txt');
});

test('the selection file is written whole or not at all, and readSelection survives a missing one', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'nested', 'model-selection.json');
    assert.equal(await readSelection(path), null);
    await writeSelection(path, PREVIOUS);
    assert.deepEqual(await readSelection(path), PREVIOUS);
  });
});
