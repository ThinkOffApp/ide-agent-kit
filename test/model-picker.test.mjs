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
// NO TEST IN THIS FILE MAY REACH THE PRODUCTION DAEMON. Every call passes a
// daemonBase that belongs to a fixture: a loopback server started here, or a
// port that was bound and released. That is not a convention, it is enforced
// by pickModel/raiseChoice/daemonIsUp requiring the argument - a reviewer
// running a modified copy of this suite once escaped into the real daemon and
// queued a live question on the owner's phone, because the code under test
// had a default and the test relied on a branch not being taken. A suite whose
// safety depends on the code under test being correct is inverted.
//
// DUMMY_SECRET and DUMMY_GATE_TOKEN are made-up strings. They are planted in
// the environment, in a key file and in a gate-token file, and the suite
// asserts they reach neither the selection file, any rendered output, nor any
// request to an untrusted host. A fixture carrying a real credential would
// publish it: this repository is public.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main,
  pickModel,
  buildOffer,
  buildSelection,
  baseUrlFor,
  describeOffer,
  describeExclusion,
  offerability,
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
const DUMMY_GATE_TOKEN = 'gate-test-NOT-A-REAL-TOKEN-91b3ee';
const PICKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'model-picker.mjs');
const HOST = 'testbox';

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
    keyBlocked: false, keyWarning: null, capacityUnknown: false,
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
/** Only `id` is UP; everything else is DOWN. */
const ONLY = id => entries => entries.map(e => result(e.id, e.id === id ? 'UP' : 'DOWN'));

/**
 * A stand-in for the intent daemon: the two endpoints request_choice uses.
 * `decide` is called with the created intent and returns the label to answer
 * with, or null to leave it pending. `hangOnPoll` accepts the connection and
 * never answers, which is the shape that makes an unsignalled fetch immortal.
 */
async function fakeDaemon({ decide = () => null, pollsBeforeDecision = 1, refuse = null, hangOnPoll = false } = {}) {
  const created = [];
  const requests = [];
  const rows = new Map();
  const sockets = new Set();
  let polls = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
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
      if (hangOnPoll) return; // accepted, never answered
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
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    created,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise(r => server.close(r));
    },
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

/** A daemon address that is guaranteed not to answer. Never the real one. */
async function deadDaemon() {
  return `http://127.0.0.1:${await deadPort()}`;
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

async function seedPrevious(dir, selection = PREVIOUS) {
  const path = join(dir, 'model-selection.json');
  await writeFile(path, JSON.stringify(selection, null, 2) + '\n');
  return { path, before: await readFile(path) };
}

const REGISTRY_PATH = '/does/not/matter.json';
const readRegistryOk = async () => registry();

/** Defaults every pickModel call in this suite shares. Never a live daemon. */
async function pick(overrides = {}) {
  return pickModel({
    registryPath: REGISTRY_PATH,
    callerHost: HOST,
    daemonBase: overrides.daemonBase ?? await deadDaemon(),
    readRegistryImpl: readRegistryOk,
    ...overrides,
  });
}

// --- offering --------------------------------------------------------------

test('NEGATIVE CONTROL: only UP entries are offered, and the excluded ones are named with their state', () => {
  const results = [
    result('glm53-asus', 'UP'),
    result('asus1-vllm-qwen3-coder', 'BUSY'),
    result('mini-lmstudio', 'UNREACHABLE'),
  ];
  const offer = buildOffer(results, { callerHost: HOST });

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
  const offer = buildOffer([result('glm53-asus', 'UP')], { callerHost: HOST });
  assert.deepEqual(offer.options, ['glm53-asus']);
  assert.match(offer.prompt, /glm53-asus - glm53-asus-model, 40 GiB free, p90 220 ms \+-12, direct/);
  for (const label of offer.options) {
    assert.ok(!/\s/.test(label), `label ${JSON.stringify(label)} carries prose, so it cannot round-trip as an id`);
  }
});

test('P2-8 REGRESSION: an entry whose credential cannot be read is not offered, and says so', () => {
  // vLLM and llama.cpp serve /v1/models without auth, so this box answers
  // perfectly and reports UP. The probe knows the keyFile is unreadable.
  const blocked = result('glm53-asus', 'UP', {
    keyBlocked: true,
    keyWarning: 'cannot read key file /tmp/gone.txt (ENOENT)',
  });
  assert.equal(offerability(blocked).offerable, false);
  const offer = buildOffer([blocked, result('mini-lmstudio', 'UP')], { callerHost: HOST });
  assert.deepEqual(offer.options, ['mini-lmstudio']);
  assert.match(offer.prompt, /glm53-asus UP but its credential is unusable: cannot read key file/);
  assert.match(describeExclusion(blocked), /would refuse the first real request/);
});

test('P2-8 REGRESSION: a key-blocked entry is not applied even when it is the only UP one', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([entries => entries.map(e => result(e.id, 'UP', e.id === 'glm53-asus'
        ? { keyBlocked: true, keyWarning: 'cannot read key file /tmp/gone.txt (ENOENT)' }
        : { state: 'DOWN', models: [] }))]),
      daemonIsUpImpl: async () => { throw new Error('must not reach a daemon'); },
    });
    assert.equal(outcome.outcome, OUTCOMES.NONE_UP);
    assert.deepEqual(await readFile(path), before);
  });
});

test('a non-disqualifying warning is shown on an entry you CAN pick, not only on excluded ones', () => {
  const warned = result('glm53-asus', 'UP', {
    keyWarning: 'key file /tmp/k.txt is mode 0644 - readable beyond its owner; chmod 600 it',
    capacityUnknown: true,
    freeMemGiB: null,
  });
  const line = describeOffer(warned);
  assert.match(line, /WARNING key file .* mode 0644/);
  assert.match(line, /capacity unknown/);
  assert.match(line, /free unknown/);
});

test('an UP entry that named no model is refused rather than offered as "model unknown"', () => {
  const nameless = result('glm53-asus', 'UP', { models: [] });
  assert.equal(offerability(nameless).offerable, false);
  const offer = buildOffer([nameless, result('mini-lmstudio', 'UP')], { callerHost: HOST });
  assert.deepEqual(offer.options, ['mini-lmstudio']);
  assert.match(offer.prompt, /glm53-asus UP but named no model/);
  assert.ok(!/model unknown/.test(offer.prompt));
});

test('callerHost is required: a prompt may never say "unknown"', () => {
  assert.throws(() => buildOffer([result('glm53-asus', 'UP')], {}), /callerHost is required/);
  assert.rejects(() => pickModel({ registryPath: REGISTRY_PATH, daemonBase: 'http://127.0.0.1:1' }), /callerHost is required/);
});

test('an UNREACHABLE fleet reports UNREACHABLE per entry, never "none available"', async () => {
  const outcome = await pick({
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
  let touched = 0;
  const outcome = await pick({
    dryRun: true,
    probeImpl: stubProbe([entries => [result(entries[0].id, 'UP'), result(entries[1].id, 'BUSY'), result(entries[2].id, 'DOWN')]]),
    readSelectionImpl: async () => null,
    daemonIsUpImpl: async () => { touched += 1; return true; },
    raiseChoiceImpl: async () => { touched += 1; return { status: 'timeout' }; },
    writeSelectionImpl: async () => { throw new Error('a dry run must not write'); },
  });
  assert.equal(outcome.outcome, OUTCOMES.DRY_RUN);
  assert.equal(touched, 0);
  assert.deepEqual(outcome.options, ['glm53-asus']);
  assert.equal(EXIT_CODES[outcome.outcome], 0);
});

// --- the label is the answer ----------------------------------------------

test('the chosen id round-trips exactly through a real choice intent', async () => {
  const offer = buildOffer([result('glm53-asus', 'UP'), result('mini-lmstudio', 'UP')], { callerHost: HOST });
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

test('a decision that matches no entry at all is refused rather than applied', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([ALL_UP()]),
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'a-box-nobody-offered' }),
    });
    assert.equal(outcome.outcome, OUTCOMES.NOT_OFFERED);
    assert.match(outcome.error, /was not one of the options offered/);
    assert.deepEqual(await readFile(path), before);
  });
});

test('REGRESSION: a REAL registry id that was never offered is refused too', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    // mini-lmstudio is a genuine entry and was DOWN at probe time, so it was
    // never a button. A registry lookup would have accepted it; the
    // allow-list must not.
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([entries => entries.map(e => result(e.id, e.id === 'mini-lmstudio' ? 'DOWN' : 'UP'))]),
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'mini-lmstudio' }),
    });
    assert.equal(outcome.outcome, OUTCOMES.NOT_OFFERED);
    assert.equal(outcome.chosenId, 'mini-lmstudio');
    assert.equal(EXIT_CODES[outcome.outcome], 7);
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
    const outcome = await pick({
      selectionPath: path,
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
    const outcome = await pick({
      selectionPath: path,
      probeImpl,
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'glm53-asus' }),
      now: () => 1_700_000_100_000,
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
      selectedFrom: HOST,
    });
  });
});

test('a timeout leaves the previous selection byte-identical', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const daemon = await fakeDaemon({ decide: () => null });
    try {
      const outcome = await pick({
        selectionPath: path,
        daemonBase: daemon.base,
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

// --- P1-4: the write can fail AFTER the human has tapped -------------------

test('P1-4 REGRESSION: a failed write reports that the choice did not take effect, and does not crash', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([ALL_UP(), ALL_UP()]),
      daemonIsUpImpl: async () => true,
      raiseChoiceImpl: async () => ({ status: 'decided', id: 'i1', decision: 'glm53-asus' }),
      writeSelectionImpl: async () => {
        const err = new Error("EACCES: permission denied, mkdir '/nope'");
        err.code = 'EACCES';
        throw err;
      },
    });
    assert.equal(outcome.outcome, OUTCOMES.WRITE_FAILED);
    assert.equal(EXIT_CODES[outcome.outcome], 8);
    const text = renderOutcome(outcome);
    assert.match(text, /YOUR CHOICE DID NOT TAKE EFFECT/);
    assert.match(text, /still on mini-lmstudio/);
    assert.match(text, /the tap has to be repeated/);
    assert.deepEqual(await readFile(path), before);
  });
});

test('P1-4 REGRESSION: a real unwritable destination exits 8 through main(), not 1 with a stack trace', async () => {
  await withTmp(async (dir) => {
    // A real endpoint, a real probe, a real write attempt. The box is
    // loopback, so `ssh` cannot report capacity and the entry comes back UP
    // with "capacity unknown" - which is exactly the sole-usable-entry path,
    // so the human-facing apply runs without anybody needing to tap.
    const endpoint = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'loopback-model' }] }));
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const registryPath = join(dir, 'models.json');
    await writeFile(registryPath, JSON.stringify({
      models: [{ id: 'loopback-one', host: '127.0.0.1', port: endpoint.address().port, kind: 'openai' }],
    }));
    const out = [];
    const sink = { write: s => out.push(s) };
    try {
      // /dev/null is not a directory, so mkdir under it fails with ENOTDIR.
      const code = await main(
        ['--registry', registryPath, '--selection', '/dev/null/deeper/model-selection.json',
          '--daemon', await deadDaemon(), '--probe-timeout', '4000', '--samples', '1'],
        { stdout: sink, stderr: sink },
      );
      const text = out.join('');
      assert.equal(code, 8, `expected the documented write-failure code, got ${code} with: ${text}`);
      assert.match(text, /YOUR CHOICE DID NOT TAKE EFFECT/);
      assert.ok(!/at Object\.|at async /.test(text), 'a stack trace is not a message to a person');
    } finally {
      await new Promise(r => endpoint.close(r));
    }
  });
});

// --- credentials -----------------------------------------------------------

test('the written selection carries the keyFile PATH and no key material', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'model-selection.json');
    const keyFile = join(dir, 'glm-key.txt');
    await writeFile(keyFile, `${DUMMY_SECRET}\n`, { mode: 0o600 });
    const saved = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_API_KEY_FILE: process.env.LLM_API_KEY_FILE };
    process.env.LLM_API_KEY = DUMMY_SECRET;
    process.env.LLM_API_KEY_FILE = keyFile;
    try {
      const outcome = await pick({
        selectionPath: path,
        readRegistryImpl: async () => loadRegistry({
          models: [
            { id: 'glm53-asus', host: 'asus1', port: 8888, kind: 'openai', auth: 'bearer', keyFile },
            { id: 'mini-lmstudio', host: 'mini', port: 1234, kind: 'lmstudio' },
          ],
        }),
        probeImpl: stubProbe([ALL_UP(), ALL_UP()]),
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
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

test('P1-2 REGRESSION: the fleet gate token never travels to a daemon host outside the trusted set', async () => {
  await withTmp(async (dir) => {
    const tokenFile = join(dir, 'gate.token');
    await writeFile(tokenFile, `${DUMMY_GATE_TOKEN}\n`, { mode: 0o600 });
    const saved = process.env.IAK_GATE_TOKEN_FILE;
    process.env.IAK_GATE_TOKEN_FILE = tokenFile;
    try {
      const seen = [];
      const fetchImpl = async (url, options) => {
        seen.push({ url, headers: options?.headers || {} });
        return { ok: true, json: async () => ({ ok: true, id: 'i1' }) };
      };
      // An untrusted host: --daemon is an argument, and arguments arrive from
      // scripts, room messages and PR text.
      await raiseChoice({
        daemonBase: 'http://models.example.com:8788',
        prompt: 'p', options: ['a', 'b'], fetchImpl, timeoutSec: 0.05, pollMs: 10,
      });
      assert.ok(seen.length > 0);
      for (const { headers } of seen) {
        const values = JSON.stringify(headers);
        assert.ok(!/authorization/i.test(values), 'no Authorization header may go to an untrusted host');
        assert.ok(!values.includes(DUMMY_GATE_TOKEN), 'the gate token must not appear in any header');
      }

      // ...and loopback, where the fleet daemon actually lives, still gets it.
      const trusted = [];
      await raiseChoice({
        daemonBase: 'http://127.0.0.1:8788',
        prompt: 'p', options: ['a', 'b'], timeoutSec: 0.05, pollMs: 10,
        fetchImpl: async (url, options) => {
          trusted.push(options?.headers || {});
          return { ok: true, json: async () => ({ ok: true, id: 'i1' }) };
        },
      });
      assert.equal(trusted[0].Authorization, `Bearer ${DUMMY_GATE_TOKEN}`);
    } finally {
      if (saved === undefined) delete process.env.IAK_GATE_TOKEN_FILE; else process.env.IAK_GATE_TOKEN_FILE = saved;
    }
  });
});

// --- refusals, each its own ------------------------------------------------

test('a missing registry is its own refusal, naming the path', async () => {
  const outcome = await pick({ registryPath: join(tmpdir(), 'iak-no-such-registry.json'), readRegistryImpl: undefined });
  assert.equal(outcome.outcome, OUTCOMES.NO_REGISTRY);
  assert.match(renderOutcome(outcome), /no usable registry at .*iak-no-such-registry\.json/);
  assert.equal(EXIT_CODES[outcome.outcome], 2);
});

test('a daemon that is not answering is its own refusal, and writes nothing', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      daemonBase: await deadDaemon(),
      probeImpl: stubProbe([ALL_UP()]),
    });
    assert.equal(outcome.outcome, OUTCOMES.DAEMON_UNREACHABLE);
    assert.match(outcome.error, /nobody was asked, so nothing was changed/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(EXIT_CODES[outcome.outcome], 4);
  });
});

test('REGRESSION: a daemon that answers and REFUSES is not reported as "not answering"', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const daemon = await fakeDaemon({ refuse: 'options must be an array' });
    try {
      const outcome = await pick({
        selectionPath: path,
        daemonBase: daemon.base,
        probeImpl: stubProbe([ALL_UP()]),
        timeoutSec: 1, pollMs: 20,
      });
      assert.equal(outcome.outcome, OUTCOMES.DAEMON_REFUSED);
      assert.equal(EXIT_CODES[outcome.outcome], 9);
      const text = renderOutcome(outcome);
      assert.match(text, /is RUNNING - do not restart it/);
      assert.ok(!/Start the intent daemon/.test(text));
      assert.deepEqual(await readFile(path), before);
    } finally {
      await daemon.close();
    }
  });
});

test('every outcome has an exit code, and the distinct faults have DISTINCT codes', () => {
  for (const outcome of Object.values(OUTCOMES)) {
    assert.equal(typeof EXIT_CODES[outcome], 'number', `${outcome} has no exit code`);
  }
  // "The fleet is unreachable" and "the fleet is healthy with one model" must
  // not look the same to a wrapper script.
  assert.notEqual(EXIT_CODES[OUTCOMES.NONE_UP], EXIT_CODES[OUTCOMES.ONLY_ONE_UP]);
  assert.notEqual(EXIT_CODES[OUTCOMES.DAEMON_UNREACHABLE], EXIT_CODES[OUTCOMES.DAEMON_REFUSED]);
  assert.notEqual(EXIT_CODES[OUTCOMES.CHANGED_SINCE_OFFER], EXIT_CODES[OUTCOMES.NOT_OFFERED]);
  assert.notEqual(EXIT_CODES[OUTCOMES.WRITE_FAILED], EXIT_CODES[OUTCOMES.APPLIED]);
  const nonZero = Object.values(OUTCOMES).map(o => EXIT_CODES[o]).filter(c => c !== 0);
  assert.equal(new Set(nonZero).size, nonZero.length, 'two different faults share an exit code');
});

// --- one usable entry: a selection, not a dead end -------------------------

test('exactly one usable entry is applied without a question, after the same re-probe', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'model-selection.json');
    const probeImpl = stubProbe([ONLY('glm53-asus'), ALL_UP()]);
    const outcome = await pick({
      selectionPath: path,
      probeImpl,
      daemonIsUpImpl: async () => { throw new Error('nobody should be asked to choose between one thing'); },
    });
    assert.equal(outcome.outcome, OUTCOMES.APPLIED_SOLE);
    assert.equal(EXIT_CODES[outcome.outcome], 0);
    assert.equal(probeImpl.calls(), 2, 'skipping the QUESTION must never skip the re-probe');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).selectedId, 'glm53-asus');
    assert.match(renderOutcome(outcome), /only usable entry/);
  });
});

test('a fleet that shrank to one REPLACES a stale selection pointing at a dead box', async () => {
  await withTmp(async (dir) => {
    // The previous selection is mini-lmstudio, which is now DOWN. Refusing
    // here would preserve a selection we just measured as dead.
    const { path } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([ONLY('glm53-asus'), ALL_UP()]),
    });
    assert.equal(outcome.outcome, OUTCOMES.APPLIED_SOLE);
    assert.equal(outcome.previous.selectedId, 'mini-lmstudio');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).selectedId, 'glm53-asus');
  });
});

test('the sole usable entry being ALREADY selected is a no-op with exit 0, and touches nothing', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir, { ...PREVIOUS, selectedId: 'glm53-asus' });
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([ONLY('glm53-asus')]),
      writeSelectionImpl: async () => { throw new Error('nothing to write'); },
    });
    assert.equal(outcome.outcome, OUTCOMES.ALREADY_SELECTED);
    assert.equal(EXIT_CODES[outcome.outcome], 0);
    assert.deepEqual(await readFile(path), before);
  });
});

test('--require-choice refuses to apply a sole entry without a tap, with its own code', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      requireChoice: true,
      probeImpl: stubProbe([ONLY('glm53-asus')]),
    });
    assert.equal(outcome.outcome, OUTCOMES.ONLY_ONE_UP);
    assert.equal(EXIT_CODES[outcome.outcome], 10);
    assert.deepEqual(await readFile(path), before);
  });
});

test('a sole entry that stops being usable before the write is NOT applied', async () => {
  await withTmp(async (dir) => {
    const { path, before } = await seedPrevious(dir);
    const outcome = await pick({
      selectionPath: path,
      probeImpl: stubProbe([ONLY('glm53-asus'), entries => entries.map(e => result(e.id, 'BUSY'))]),
    });
    assert.equal(outcome.outcome, OUTCOMES.CHANGED_SINCE_OFFER);
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

test('P1-3 REGRESSION: every daemon request carries an AbortSignal', async () => {
  const seen = [];
  await raiseChoice({
    daemonBase: 'http://127.0.0.1:1',
    prompt: 'p', options: ['a', 'b'], timeoutSec: 0.2, pollMs: 10,
    fetchImpl: async (url, options) => {
      seen.push(options?.signal);
      return { ok: true, json: async () => (url.endsWith('/intent') ? { ok: true, id: 'i1' } : []) };
    },
  });
  assert.ok(seen.length >= 2, 'expected a POST and at least one poll');
  for (const signal of seen) {
    assert.ok(signal && typeof signal.aborted === 'boolean', 'a fetch without a signal can hang forever');
  }
});

test('P1-3 REGRESSION: --timeout-sec is enforced against a daemon that accepts and never answers', async () => {
  const daemon = await fakeDaemon({ hangOnPoll: true });
  try {
    const started = Date.now();
    const answer = await raiseChoice({
      daemonBase: daemon.base,
      prompt: 'p', options: ['a', 'b'],
      timeoutSec: 0.6, pollMs: 25, requestTimeoutMs: 150,
    });
    const elapsed = Date.now() - started;
    assert.equal(answer.status, 'timeout');
    assert.ok(elapsed < 5000, `the timeout must bound the wait, took ${elapsed} ms`);
  } finally {
    await daemon.close();
  }
});

test('P2-9 REGRESSION: there is no default daemon address to fall through to', async () => {
  await assert.rejects(() => pickModel({ registryPath: REGISTRY_PATH, callerHost: HOST }), /daemonBase is required/);
  await assert.rejects(() => raiseChoice({ prompt: 'p', options: ['a', 'b'] }), /daemonBase is required/);
  await assert.rejects(() => daemonIsUp({}), /daemonBase is required/);
});

test('daemonIsUp is false for a port nothing is listening on, true for the daemon', async () => {
  assert.equal(await daemonIsUp({ daemonBase: await deadDaemon() }), false);
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
      const outcome = await pick({
        selectionPath: path,
        daemonBase: daemon.base,
        probeImpl: stubProbe([ALL_UP(), ALL_UP()]),
        pollMs: 20,
        timeoutSec: 5,
      });
      assert.equal(outcome.outcome, OUTCOMES.APPLIED);
      assert.equal(outcome.selection.selectedId, 'glm53-asus');
      assert.match(daemon.created[0].prompt, /Which model should testbox use\?/);
      assert.deepEqual(daemon.created[0].options, ['glm53-asus', 'asus1-vllm-qwen3-coder', 'mini-lmstudio']);
      assert.match(renderOutcome(outcome), /re-probed usable at .* before writing/);
    } finally {
      await daemon.close();
    }
  });
});

// --- P1-1: the program must actually run ----------------------------------

test('P1-1 REGRESSION: invoked through a symlink, the CLI still runs and still reports', async () => {
  await withTmp(async (dir) => {
    // The documented way to get this on PATH is a ~/bin symlink, and macOS
    // /tmp is itself a symlink, so this is the ordinary case rather than an
    // exotic one.
    const link = join(dir, 'model-picker-link.mjs');
    await symlink(PICKER, link);
    const missing = join(dir, 'no-registry.json');
    const run = args => new Promise(resolve => {
      execFile(process.execPath, args, (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      });
    });
    const direct = await run([PICKER, '--registry', missing, '--dry-run', '--daemon', 'http://127.0.0.1:1']);
    const linked = await run([link, '--registry', missing, '--dry-run', '--daemon', 'http://127.0.0.1:1']);

    // Exit 0 with no output would be the old bug, and this file documents 0
    // as "a selection was applied".
    assert.equal(direct.code, 2);
    assert.equal(linked.code, 2, 'a symlinked invocation must not silently exit 0');
    assert.match(linked.stderr, /no usable registry/);
    assert.equal(linked.stderr, direct.stderr);
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
  const selection = buildSelection(glm, result('glm53-asus', 'UP'), { callerHost: HOST, now: () => 0 });
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
