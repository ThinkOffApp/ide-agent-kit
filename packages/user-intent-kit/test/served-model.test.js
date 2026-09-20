// SPDX-License-Identifier: AGPL-3.0

/**
 * The reporter that says which LLM a machine is serving.
 *
 * Every assertion here is about a WRONG NAME rather than a missing one. The
 * field ends up in a public screenshot, so "published nothing" is a pass and
 * "published something plausible" is the bug.
 *
 * The fetch is always a fake. A suite that needed a model server running
 * would pass on one machine and be skipped everywhere else, which is the same
 * as not testing the thing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ServedModelProbe,
  servedModelEntry,
  parseEndpoint,
  readVerdict,
  VERDICTS,
  DEFAULT_ENDPOINT,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_GENERATION_MIN_MS,
} from '../src/served-model.js';
import { loadRegistry, generationEvidence, probeGeneration } from '../src/model-capacity.js';
import { DesktopAdapter } from '../src/adapters/desktop.js';
import { collectHostTelemetry } from '../src/host-telemetry.js';

// --- fakes -----------------------------------------------------------------

/**
 * A server that answers `/v1/models` with these ids, and - unless told
 * otherwise - answers a generation request with one token.
 *
 * `generates: false` is the September 2026 incident in a fake: the listing is
 * honest about what is in the cache and the model cannot actually run.
 */
function serving(ids, { status = 200, requireAuth = false, generates = true, genError = 'Model type qwen4_exp not supported' } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET', headers: options?.headers ?? {} });
    const authed = Boolean(options?.headers?.authorization);
    if (requireAuth && !authed) {
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    }
    if (status !== 200) {
      return { ok: false, status, json: async () => ({}) };
    }
    if (options?.method === 'POST') {
      if (!generates) {
        return { ok: false, status: 400, json: async () => ({ error: { message: genError } }) };
      }
      const asked = JSON.parse(options.body).model;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: asked, choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }] }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ object: 'list', data: ids.map(id => ({ id })) }) };
  };
  impl.calls = calls;
  return impl;
}

/** A probe allowed to spend a token, with the rate limit out of the way. */
function provingProbe(fetchImpl, extraEnv = {}, opts = {}) {
  return probeFor(fetchImpl, extraEnv, { generate: true, generateMinMs: 0, ...opts });
}

/** Nothing listening on that port, the way Node's fetch reports it. */
function refusing() {
  return async () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    throw err;
  };
}

function env(extra = {}) {
  return { INTENT_MODEL_ENDPOINT: '127.0.0.1:8080', ...extra };
}

function probeFor(fetchImpl, extraEnv = {}, opts = {}) {
  const e = env(extraEnv);
  return new ServedModelProbe({ entry: servedModelEntry(e), env: e, fetchImpl, ...opts });
}

// --- THE CONTRACT: a machine serving nothing publishes no `model` key ------

test('a machine with nothing listening publishes no model key at all', async () => {
  const probe = probeFor(refusing());
  await probe.refresh();

  assert.equal(probe.current(), undefined);
  assert.equal(probe.lastResult().verdict, VERDICTS.NO_SERVER);

  // Not null, not '', not absent-from-the-object-but-present-in-JSON. The
  // dashboard reads `slot['model'] ?? host['model']`, so a null would render
  // as a label just as loudly as a wrong name would.
  const host = collectHostTelemetry({ machine: 'macbook', model: probe.current(), sources: macSources() });
  assert.ok(!('model' in host), `published a model key: ${JSON.stringify(host.model)}`);
  assert.equal(JSON.stringify(host).includes('"model"'), false);
});

test('an endpoint that answers but lists nothing loaded publishes no model', async () => {
  const probe = probeFor(serving([]));
  await probe.refresh();
  assert.equal(probe.current(), undefined);
  assert.equal(probe.lastResult().verdict, VERDICTS.IDLE);
});

// --- THE CONTROL: this suite can fail --------------------------------------
//
// A "publishes nothing" assertion passes just as happily against a reporter
// that is wired to nothing at all, which is precisely the defect this change
// fixes - finished code nobody connected. So the same code path must be shown
// PRODUCING a name under the opposite input. Run in one test, against one
// probe, so a wiring break fails here rather than quietly halving the suite.

test('CONTROL: the same path that publishes nothing when idle publishes the id when served', async () => {
  const idle = provingProbe(serving([]));
  await idle.refresh();
  assert.equal(idle.current(), undefined, 'idle arm must produce no name');

  const live = provingProbe(serving(['GLM-5.3-Flash-EXL3']));
  await live.refresh();
  assert.equal(live.current(), 'GLM-5.3-Flash-EXL3', 'live arm must produce the name');

  const host = collectHostTelemetry({ machine: 'asus1', model: live.current(), sources: macSources() });
  assert.equal(host.model, 'GLM-5.3-Flash-EXL3');
});

// --- verbatim --------------------------------------------------------------

test("a live endpoint's reported id is published verbatim", async () => {
  // Real ids from the fleet, plus the shapes that tempt prettifying: a slash
  // path, a colon tag, a quantisation suffix.
  for (const id of [
    'GLM-5.3-Flash-EXL3',
    'gpt-oss:20b',
    'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    'Mia-AiLab/GLM-5.3-Flash-EXL3-TR3-4bpw',
  ]) {
    const probe = provingProbe(serving([id]));
    await probe.refresh();
    assert.equal(probe.current(), id, `mangled ${id}`);
  }
});

test('a server listing several models names NONE of them', async () => {
  // It used to name the first, which is a coin toss printed as a reading: a
  // server listing two models cannot have both resident, so neither id is
  // "the" served model. Joining them produced a string that is no model's id
  // and that string reached a dashboard.
  const probe = provingProbe(serving(['first-model', 'second-model']));
  await probe.refresh();

  assert.equal(probe.current(), undefined);
  assert.deepEqual(probe.listed(), ['first-model', 'second-model']);
  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.match(probe.lastResult().reason, /2 models listed/);

  // And nothing was asked to generate: naming one of several would be a
  // guess, and on a server that loads on demand it is an instruction to load.
  assert.equal(serving(['a', 'b']).calls.length, 0);
});

// --- 401: serving something, and we still do not name it -------------------

test('a 401 does not become a fabricated name', async () => {
  const probe = probeFor(serving(['secret-model'], { requireAuth: true }));
  await probe.refresh();

  const seen = probe.lastResult();
  assert.equal(seen.verdict, VERDICTS.AUTH_BLOCKED);
  assert.equal(seen.model, undefined);
  // It IS reachable - something rejected us - and that distinction is what
  // tells an operator to configure a key rather than restart a server.
  assert.equal(seen.reachedServer, true);

  const host = collectHostTelemetry({ machine: 'm5', model: probe.current(), sources: macSources() });
  assert.ok(!('model' in host), 'a 401 produced a label');
});

test('no placeholder word ever reaches the payload', async () => {
  const forbidden = /unknown|n\/?a$|none|unauthori[sz]ed|pending|error|\*\*\*|null/i;
  for (const fetchImpl of [refusing(), serving([]), serving(['x'], { requireAuth: true }), serving([], { status: 500 })]) {
    const probe = probeFor(fetchImpl);
    await probe.refresh();
    const value = probe.current();
    assert.ok(value === undefined || !forbidden.test(value), `placeholder published: ${value}`);
  }
});

test('a configured key file turns the same 401 into a real name', async () => {
  // The fail-then-pass control for the AUTH path specifically: identical
  // server, identical probe, the only difference is a key. Without this the
  // "401 publishes nothing" test would also pass against a probe that never
  // sends an Authorization header at all.
  const dir = mkdtempSync(join(tmpdir(), 'uik-key-'));
  const keyFile = join(dir, 'token.txt');
  writeFileSync(keyFile, 'test-token-value\n');
  chmodSync(keyFile, 0o600);

  const server = serving(['GLM-5.3-Flash-EXL3'], { requireAuth: true });

  const without = probeFor(server);
  await without.refresh();
  assert.equal(without.current(), undefined);

  const withKey = provingProbe(server, { INTENT_MODEL_KEY_FILE: keyFile });
  await withKey.refresh();
  assert.equal(withKey.current(), 'GLM-5.3-Flash-EXL3');

  // The generation request carried the same header. A probe that authenticated
  // its listing and then posted a prompt without a token would 401 here.
  const posted = server.calls.find(c => c.method === 'POST');
  assert.ok(posted?.headers?.authorization, 'generation went out unauthenticated');

  // And the token itself is never anywhere in what we would publish.
  assert.equal(JSON.stringify(withKey.lastResult()).includes('test-token-value'), false);
  assert.equal(withKey.describe().includes('test-token-value'), false);
});

// --- the heartbeat survives the probe --------------------------------------

test('the device still reports its vitals when the model probe throws', async () => {
  const exploding = async () => { throw new Error('probe is broken'); };
  const probe = probeFor(exploding);

  // refresh() must resolve, not reject: the daemon does not await it, so a
  // rejection here is an unhandled rejection in a long-running process.
  const reading = await probe.refresh();
  assert.equal(reading.model, undefined);
  assert.equal(probe.current(), undefined);

  const host = collectHostTelemetry({ machine: 'macbook', kind: 'macbook', model: probe.current(), sources: macSources() });
  assert.ok(!('model' in host));
  // The vitals - the thing that makes the machine appear on the dashboard at
  // all - are untouched. Losing a whole machine because its LLM died is the
  // worse bug.
  assert.equal(host.machine, 'macbook');
  assert.equal(host.kind, 'macbook');
  assert.equal(host.load_pct, 45);
  assert.equal(host.mem_total_gb, 16);
});

test('a heartbeat publishes before the probe has answered anything', async () => {
  let release;
  const blocked = new Promise(r => { release = r; });
  const hanging = async () => { await blocked; throw new Error('never'); };

  const probe = probeFor(hanging);
  const patched = [];
  const client = {
    deviceId: 'macbook',
    patchDevice: async (state) => { patched.push(state); },
    startHeartbeat() {}, stopHeartbeat() {},
  };
  const desktop = new DesktopAdapter(client, { machine: 'macbook', modelProbe: probe, pollIntervalMs: 1e9 });

  // The whole point: this awaits nothing on the network.
  await desktop.publishState();
  desktop.stop();
  release();

  assert.equal(patched.length, 1);
  assert.ok(!('model' in patched[0]), 'published a model before the probe answered');
  assert.equal(typeof patched[0].screen_active, 'boolean');
});

// --- a reading that outlives its evidence ----------------------------------

test('a stale reading expires instead of being republished forever', async () => {
  let clock = 1_000_000;
  const probe = provingProbe(serving(['GLM-5.3-Flash-EXL3']), {}, {
    now: () => clock,
    intervalMs: 1000,
    staleAfterMs: 3000,
  });
  await probe.refresh();
  assert.equal(probe.current(), 'GLM-5.3-Flash-EXL3');

  clock += 2999;
  assert.equal(probe.current(), 'GLM-5.3-Flash-EXL3', 'expired a reading that was still current');

  clock += 2;
  assert.equal(probe.current(), undefined, 'served a label with no live evidence behind it');
  assert.equal(probe.lastResult().verdict, VERDICTS.NO_SERVER);
});

test('a server that stops serving drops the label on the next probe', async () => {
  let ids = ['GLM-5.3-Flash-EXL3'];
  const probe = provingProbe(async (url, options) => (options?.method === 'POST'
    ? { ok: true, status: 200, json: async () => ({ model: ids[0], choices: [{ message: { content: 'hi' } }] }) }
    : { ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ id })) }) }));

  await probe.refresh();
  assert.equal(probe.current(), 'GLM-5.3-Flash-EXL3');

  ids = [];
  await probe.refresh();
  assert.equal(probe.current(), undefined, 'kept a name after the server stopped serving it');
});

test('a model swap is reported, not frozen at the first answer', async () => {
  let ids = ['model-a'];
  const probe = provingProbe(async (url, options) => (options?.method === 'POST'
    ? { ok: true, status: 200, json: async () => ({ model: ids[0], choices: [{ message: { content: 'hi' } }] }) }
    : { ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ id })) }) }));
  await probe.refresh();
  assert.equal(probe.current(), 'model-a');
  ids = ['model-b'];
  await probe.refresh();
  assert.equal(probe.current(), 'model-b');
});

// --- detection outranks configuration --------------------------------------

test('a live answer beats INTENT_DEVICE_MODEL', async () => {
  const probe = provingProbe(serving(['GLM-5.3-Flash-EXL3']));
  await probe.refresh();
  const state = await stateFrom({ modelProbe: probe, model: 'whatever-was-configured-last-march' });
  assert.equal(state.model, 'GLM-5.3-Flash-EXL3');
});

test('a reachable endpoint serving nothing suppresses the configured name', async () => {
  const probe = probeFor(serving([]));
  await probe.refresh();
  const state = await stateFrom({ modelProbe: probe, model: 'stale-name' });
  assert.ok(!('model' in state), `published a setting the endpoint contradicts: ${state.model}`);
});

test('a 401 suppresses the configured name too', async () => {
  const probe = probeFor(serving(['x'], { requireAuth: true }));
  await probe.refresh();
  const state = await stateFrom({ modelProbe: probe, model: 'stale-name' });
  assert.ok(!('model' in state), `published an unverifiable setting: ${state.model}`);
});

test('with nothing listening the operator\'s own statement still stands', async () => {
  // Nothing answered, so nothing contradicts them. INTENT_DEVICE_MODEL is
  // documented for exactly this box - one with no endpoint to ask.
  const probe = probeFor(refusing());
  await probe.refresh();
  const state = await stateFrom({ modelProbe: probe, model: 'declared-by-hand' });
  assert.equal(state.model, 'declared-by-hand');
});

test('passing modelProbe: null leaves the old configured behaviour exactly as it was', async () => {
  const state = await stateFrom({ modelProbe: null, model: 'declared-by-hand' });
  assert.equal(state.model, 'declared-by-hand');
});

// --- endpoint configuration ------------------------------------------------

test('the default endpoint is a loaded-server port, not Ollama\'s catalogue port', () => {
  // Measured 20 Sep 2026: Ollama on 11434 lists gpt-oss:20b from /v1/models
  // while /api/ps reports nothing resident. Defaulting there would label an
  // idle MacBook with a model it is not running.
  assert.equal(DEFAULT_ENDPOINT, '127.0.0.1:8080');
  assert.ok(!DEFAULT_ENDPOINT.includes('11434'));
  const entry = servedModelEntry({});
  assert.equal(entry.host, '127.0.0.1');
  assert.equal(entry.port, 8080);
  assert.equal(entry.kind, 'openai');
});

test('the probe runs on its own timer, slower than the 30 s heartbeat', () => {
  assert.ok(DEFAULT_PROBE_INTERVAL_MS > 30000, 'probe would run on every heartbeat');
  assert.equal(DEFAULT_PROBE_INTERVAL_MS, 300000);
});

test('endpoints parse in the forms an operator will actually write', () => {
  assert.deepEqual(parseEndpoint('asus1:8888'), { host: 'asus1', port: 8888 });
  assert.deepEqual(parseEndpoint('http://asus1:8888'), { host: 'asus1', port: 8888 });
  assert.deepEqual(parseEndpoint('http://asus1:8888/v1/models'), { host: 'asus1', port: 8888 });
  assert.deepEqual(parseEndpoint('  127.0.0.1:8080  '), { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(parseEndpoint('[::1]:8080'), { host: '::1', port: 8080 });
  for (const bad of ['', '   ', 'host:0', 'host:70000', 'host:abc']) {
    assert.equal(parseEndpoint(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the probe can be switched off entirely', async () => {
  for (const off of ['off', '0', 'none', 'OFF']) {
    assert.equal(servedModelEntry({ INTENT_MODEL_ENDPOINT: off }), null, `${off} did not disable`);
  }
  const probe = new ServedModelProbe({ env: { INTENT_MODEL_ENDPOINT: 'off' }, fetchImpl: serving(['x']) });
  assert.equal(probe.enabled, false);
  await probe.refresh();
  assert.equal(probe.current(), undefined);
  assert.equal(probe.describe(), 'disabled');
});

// --- secrets are paths, never values ---------------------------------------

// Token-SHAPED, and built at runtime rather than written out: a literal that
// looks like a credential trips this repository's own pre-commit secret scan,
// which is working exactly as intended.
const TOKEN_SHAPED = `${'a1b2c3d4'.repeat(6)}`;

test('a token pasted where a PATH belongs is refused, not sent', () => {
  assert.throws(
    () => servedModelEntry({ INTENT_MODEL_KEY_FILE: TOKEN_SHAPED }),
    /must be a PATH/,
  );
});

test('a bad key configuration disables the probe rather than killing the daemon', async () => {
  const probe = new ServedModelProbe({
    env: { INTENT_MODEL_ENDPOINT: '127.0.0.1:8080', INTENT_MODEL_KEY_FILE: TOKEN_SHAPED },
    fetchImpl: serving(['x']),
  });
  assert.equal(probe.enabled, false);
  assert.equal(probe.current(), undefined);
  const state = await stateFrom({ modelProbe: probe, model: undefined });
  assert.ok(!('model' in state));
  assert.equal(typeof state.screen_active, 'boolean');
});

// --- verdict mapping, directly ---------------------------------------------

test('readVerdict never invents a model from a result that has none', () => {
  const cases = [
    [{ http: 'UNREACHABLE', models: [] }, VERDICTS.NO_SERVER],
    [{ http: 'DOWN', models: [], httpStatus: 500 }, VERDICTS.IDLE],
    [{ http: 'DOWN', models: [], httpStatus: 401 }, VERDICTS.AUTH_BLOCKED],
    [{ http: 'DOWN', models: [], httpStatus: 403 }, VERDICTS.AUTH_BLOCKED],
    [{ http: 'OK', models: [] }, VERDICTS.NO_SERVER],
    [{ http: 'OK', models: ['  '] }, VERDICTS.NO_SERVER],
    [undefined, VERDICTS.NO_SERVER],
    // A listing is its own verdict now, and it is NOT a served name.
    [{ http: 'OK', models: ['a-real-id'] }, VERDICTS.LISTED],
  ];
  for (const [result, verdict] of cases) {
    const read = readVerdict(result);
    assert.equal(read.verdict, verdict, JSON.stringify(result));
    assert.equal(read.model, undefined, `invented a model from ${JSON.stringify(result)}`);
  }
  // The id is still taken verbatim - it just travels in `listed`, not `model`.
  assert.deepEqual(readVerdict({ http: 'OK', models: [' padded-id '] }).listed, ['padded-id']);
});

// --- A LISTING IS NOT A LOADING -------------------------------------------
// Measured in production 20 Sep 2026: mlx_lm enumerates the HuggingFace cache,
// so a 75 GiB model that was still downloading was listed by a server holding
// a 2.3 GiB one, and the dashboard said the MacBook was serving it.

test('a server listing a model it has not loaded does NOT report it as served', async () => {
  // The incident exactly: the listing is honest about what is in the cache,
  // and the model cannot run.
  const probe = probeFor(serving(['ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit'], { generates: false }));
  await probe.refresh();

  assert.equal(probe.current(), undefined, 'published a served name from a listing alone');
  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.deepEqual(probe.listed(), ['ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit']);

  // And it must not reach the heartbeat's `model` either.
  const state = await stateFrom({ modelProbe: probe });
  assert.ok(!('model' in state), `a listing reached the model field: ${state.model}`);
});

test('the generation default is split by trust, not by on and off', async () => {
  // LOOPBACK, nobody said: this box's own server, so one token is spent and a
  // card may honestly say serving.
  const own = serving(['a-model']);
  const local = probeFor(own);
  await local.refresh();
  assert.equal(local.generates, true);
  assert.equal(local.lastResult().verdict, VERDICTS.GENERATED);
  assert.ok(own.calls.some(c => c.method === 'POST'));

  // NOT LOOPBACK, nobody said: may be somebody else's compute, may bill per
  // token, may be a load-on-demand server where asking IS loading.
  const theirs = serving(['a-model']);
  const [entry] = loadRegistry([{ id: 'remote', host: '10.0.0.5', port: 8080, kind: 'openai' }], { allowLan: true });
  const remote = new ServedModelProbe({ entry, env: {}, fetchImpl: theirs, generateMinMs: 0 });
  await remote.refresh();
  assert.equal(remote.generates, false);
  assert.equal(remote.lastResult().verdict, VERDICTS.LISTED);
  assert.ok(!theirs.calls.some(c => c.method === 'POST'), 'spent somebody else\'s compute unasked');

  // An explicit word wins in BOTH directions, including on loopback.
  const muted = serving(['a-model']);
  const off = probeFor(muted, { INTENT_MODEL_GENERATE: 'off' });
  await off.refresh();
  assert.equal(off.generates, false);
  assert.equal(off.lastResult().verdict, VERDICTS.LISTED);
  assert.ok(!muted.calls.some(c => c.method === 'POST'));

  // ...and a named remote that was explicitly enabled may be asked.
  const named = serving(['a-model']);
  const opted = probeFor(named, { INTENT_MODEL_GENERATE: '1', INTENT_MODEL_ENDPOINT: '10.0.0.5:8080' }, { generateMinMs: 0 });
  await opted.refresh();
  assert.equal(opted.generates, true);
  assert.equal(opted.lastResult().verdict, VERDICTS.GENERATED);
});

test('where generation is disabled the honest reading is listed, never serving', async () => {
  const probe = probeFor(serving(['a-model']), { INTENT_MODEL_GENERATE: '0' });
  await probe.refresh();

  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.equal(probe.current(), undefined, 'a disabled probe must not promote a listing');
  assert.deepEqual(probe.listed(), ['a-model']);

  const state = await stateFrom({ modelProbe: probe });
  assert.ok(!('model' in state));
});

test('a generation that errors DEGRADES to listed, never promotes to served', async () => {
  // The exact failure from the incident: the listing is fine, the model
  // cannot load, and the error says so.
  const probe = provingProbe(serving(['ddalcu/Qwen3.8-Flash-Next'], { generates: false }));
  await probe.refresh();

  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.equal(probe.current(), undefined);
  assert.match(probe.lastResult().reason, /qwen4_exp not supported/);
});

test('a generation that times out degrades too', async () => {
  const probe = provingProbe(async (url, options) => {
    if (options?.method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'slow-model' }] }) };
    }
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  await probe.refresh();
  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.equal(probe.current(), undefined);
  assert.match(probe.lastResult().reason, /no token within/);
});

test('the generation probe is rate limited hard', async () => {
  let clock = 1_000_000;
  const fetchImpl = serving(['a-model']);
  const probe = probeFor(fetchImpl, { INTENT_MODEL_GENERATE: '1' }, { now: () => clock, staleAfterMs: 10 ** 9 });

  await probe.refresh();
  assert.equal(probe.lastResult().verdict, VERDICTS.GENERATED);
  const spent = fetchImpl.calls.filter(c => c.method === 'POST').length;
  assert.equal(spent, 1);

  // A second beat one second later must not spend another forward pass.
  clock += 1000;
  await probe.refresh();
  assert.equal(fetchImpl.calls.filter(c => c.method === 'POST').length, 1, 'ignored the rate limit');

  // Past the floor, it may ask again.
  clock += DEFAULT_GENERATION_MIN_MS;
  await probe.refresh();
  assert.equal(fetchImpl.calls.filter(c => c.method === 'POST').length, 2);
});

test('a remote endpoint nobody configured is never asked to generate', async () => {
  const fetchImpl = serving(['a-model']);
  // No INTENT_MODEL_ENDPOINT in the environment: this entry was built by hand,
  // so the operator never named this host.
  const [entry] = loadRegistry([{ id: 'local', host: '10.0.0.5', port: 8080, kind: 'openai' }], { allowLan: true });
  const probe = new ServedModelProbe({
    entry, env: { INTENT_MODEL_GENERATE: '1' }, fetchImpl, generateMinMs: 0,
  });
  await probe.refresh();

  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.ok(!fetchImpl.calls.some(c => c.method === 'POST'), 'posted a prompt to a host nobody named');
});

test('a guard can refuse a candidate before any token is spent', async () => {
  const fetchImpl = serving(['half-downloaded-model']);
  const probe = probeFor(fetchImpl, { INTENT_MODEL_GENERATE: '1' }, {
    generateMinMs: 0,
    // The daemon wires this to the disk scan: an incomplete or oversized
    // model is never asked to generate, because asking would load it.
    guard: () => false,
  });
  await probe.refresh();

  assert.equal(probe.lastResult().verdict, VERDICTS.LISTED);
  assert.ok(!fetchImpl.calls.some(c => c.method === 'POST'));
  assert.match(probe.lastResult().reason, /bytes on disk do not support it/);
});

// --- helpers ---------------------------------------------------------------

/**
 * A Mac's sensors, faked. The real ones report whatever box runs the suite,
 * and half these assertions are about exact vitals surviving a broken probe.
 */
function macSources() {
  return {
    platform: () => 'darwin',
    loadavg: () => [4.5, 4.0, 3.5],
    cpuCount: () => 10,
    totalMemBytes: () => 16e9,
    freeMemBytes: () => 4e9,
    availableMemBytes: () => 12e9,
    run: () => '',
    listProcessCommandLines: () => [],
    listThermalZones: () => [],
    readThermalZone: () => '',
    readThermalCriticalMilli: () => '',
  };
}

/** One heartbeat payload from a DesktopAdapter with a fake client. */
async function stateFrom(opts) {
  const patched = [];
  const client = {
    deviceId: 'testbox',
    patchDevice: async (state) => { patched.push(state); },
    startHeartbeat() {}, stopHeartbeat() {},
  };
  const desktop = new DesktopAdapter(client, { machine: 'testbox', pollIntervalMs: 1e9, ...opts });
  await desktop.publishState();
  desktop.stop();
  return patched[0];
}


// --- A PROBE THAT CANNOT SUCCEED ------------------------------------------
//
// Measured on this machine against a freshly loaded Qwen3.8-27B-8bit: the
// model spent its whole token budget inside a reasoning block and returned
// EMPTY content. On any thinking model - most current ones - a small cap
// does that every time, so a verdict keyed on visible `content` could never
// come out true there. It would degrade to LISTED forever, and the failure
// would be invisible, because degrading is exactly what the probe is meant
// to do when something goes wrong.

/** The real captured response, not a plausible-looking invention. */
const REASONING_RESPONSE = Object.freeze({
  model: 'mlx-community/Qwen3.8-27B-8bit',
  usage: { completion_tokens: 40, prompt_tokens: 12 },
  choices: [{
    message: {
      role: 'assistant',
      content: '',
      reasoning: 'The user is asking me to reply with exactly the word "ALIVE"...',
    },
    finish_reason: 'length',
  }],
});

/** The same model given room: visible content, and the thinking split out. */
const FINISHED_RESPONSE = Object.freeze({
  model: 'mlx-community/Qwen3.8-27B-8bit',
  usage: { completion_tokens: 6, prompt_tokens: 12 },
  choices: [{
    message: { role: 'assistant', content: 'ALIVE', reasoning: 'The user wants one word.' },
    finish_reason: 'stop',
  }],
});

test('empty content with 40 tokens and finish_reason length is GENERATED', () => {
  const evidence = generationEvidence(REASONING_RESPONSE);
  assert.equal(evidence.generated, true, 'a reasoning model was recorded as not serving');
  assert.equal(evidence.tokens, 40);
  assert.equal(evidence.via, 'usage');

  // Hitting the cap means it was still generating when we stopped it.
  assert.equal(REASONING_RESPONSE.choices[0].finish_reason, 'length');
  assert.equal(REASONING_RESPONSE.choices[0].message.content, '', 'the fixture must have empty content or it pins nothing');
});

test('zero completion tokens is NOT generated, however well-formed the answer', () => {
  const evidence = generationEvidence({
    model: 'x',
    usage: { completion_tokens: 0, prompt_tokens: 12 },
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  });
  assert.equal(evidence.generated, false);
  assert.equal(evidence.tokens, 0);

  // The negative has to stay reachable. An earlier version of this check
  // accepted the mere presence of a `choices` array, which would have called
  // this a loaded model.
  assert.equal(generationEvidence({ choices: [{}] }).generated, false);
  assert.equal(generationEvidence({ choices: [] }).generated, false);
  assert.equal(generationEvidence({}).generated, false);
});

test('a response carrying only a reasoning field is GENERATED', () => {
  // No `usage` at all, so the text is the only evidence there is - and none
  // of it is visible content.
  for (const field of ['reasoning', 'reasoning_content', 'thinking']) {
    const evidence = generationEvidence({
      model: 'x',
      choices: [{ message: { role: 'assistant', content: '', [field]: 'weighing the options' }, finish_reason: 'length' }],
    });
    assert.equal(evidence.generated, true, `${field} was not accepted as evidence`);
    assert.equal(evidence.via, field);
  }
});

test('visible content still counts, with or without a usage block', () => {
  assert.equal(generationEvidence(FINISHED_RESPONSE).via, 'usage');
  assert.equal(generationEvidence({ choices: [{ message: { content: 'ALIVE' } }] }).via, 'content');
  // Whitespace is not a token anybody wrote.
  assert.equal(generationEvidence({ choices: [{ message: { content: '   ' } }] }).generated, false);
});

test('CONTROL: the probe can actually succeed against a reasoning model', async () => {
  // The positive arm. Without it the suite would pass just as happily against
  // a probe that always degrades, which is the exact defect being fixed.
  const [entry] = loadRegistry([{ id: 'local', host: '127.0.0.1', port: 8080, kind: 'openai' }], { allowLan: true });

  const thinking = await probeGeneration(entry, {
    modelId: 'mlx-community/Qwen3.8-27B-8bit',
    env: {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => REASONING_RESPONSE }),
  });
  assert.equal(thinking.generated, true);
  assert.equal(thinking.model, 'mlx-community/Qwen3.8-27B-8bit');
  assert.equal(thinking.tokens, 40);

  // ...and the same path still refuses a server that produced nothing.
  const silent = await probeGeneration(entry, {
    modelId: 'x',
    env: {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ usage: { completion_tokens: 0 }, choices: [{ message: { content: '' } }] }),
    }),
  });
  assert.equal(silent.generated, false, 'idle arm must not produce a proof');
  assert.match(silent.reason, /produced no tokens/);
});

test('a reasoning model reaches GENERATED through the whole probe', async () => {
  // End to end, through ServedModelProbe: listing, guard, generation, verdict.
  const probe = provingProbe(async (url, options) => (options?.method === 'POST'
    ? { ok: true, status: 200, json: async () => REASONING_RESPONSE }
    : { ok: true, status: 200, json: async () => ({ data: [{ id: 'mlx-community/Qwen3.8-27B-8bit' }] }) }));
  await probe.refresh();

  assert.equal(probe.lastResult().verdict, VERDICTS.GENERATED);
  assert.equal(probe.current(), 'mlx-community/Qwen3.8-27B-8bit');
});

test('the token cap does not decide the verdict', async () => {
  // Whatever the cap is, the answer comes from what came back.
  let asked = null;
  const [entry] = loadRegistry([{ id: 'local', host: '127.0.0.1', port: 8080, kind: 'openai' }], { allowLan: true });
  await probeGeneration(entry, {
    modelId: 'x',
    env: {},
    fetchImpl: async (url, options) => {
      asked = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => REASONING_RESPONSE };
    },
  });
  assert.ok(asked.max_tokens > 0 && asked.max_tokens <= 32, 'the cap must stay small: this spends real compute');
});
