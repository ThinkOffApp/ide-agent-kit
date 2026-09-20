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
} from '../src/served-model.js';
import { DesktopAdapter } from '../src/adapters/desktop.js';
import { collectHostTelemetry } from '../src/host-telemetry.js';

// --- fakes -----------------------------------------------------------------

/** A server that answers `/v1/models` with these ids. */
function serving(ids, { status = 200, requireAuth = false } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? {} });
    const authed = Boolean(options?.headers?.authorization);
    if (requireAuth && !authed) {
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    }
    if (status !== 200) {
      return { ok: false, status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ object: 'list', data: ids.map(id => ({ id })) }) };
  };
  impl.calls = calls;
  return impl;
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
  const idle = probeFor(serving([]));
  await idle.refresh();
  assert.equal(idle.current(), undefined, 'idle arm must produce no name');

  const live = probeFor(serving(['GLM-5.3-Flash-EXL3']));
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
    const probe = probeFor(serving([id]));
    await probe.refresh();
    assert.equal(probe.current(), id, `mangled ${id}`);
  }
});

test('a server listing several models names one of them, never a joined string', async () => {
  const probe = probeFor(serving(['first-model', 'second-model']));
  await probe.refresh();
  assert.equal(probe.current(), 'first-model');
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

  const withKey = probeFor(server, { INTENT_MODEL_KEY_FILE: keyFile });
  await withKey.refresh();
  assert.equal(withKey.current(), 'GLM-5.3-Flash-EXL3');

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
  const probe = probeFor(serving(['GLM-5.3-Flash-EXL3']), {}, {
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
  const probe = probeFor(async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ id })) }) }));

  await probe.refresh();
  assert.equal(probe.current(), 'GLM-5.3-Flash-EXL3');

  ids = [];
  await probe.refresh();
  assert.equal(probe.current(), undefined, 'kept a name after the server stopped serving it');
});

test('a model swap is reported, not frozen at the first answer', async () => {
  let ids = ['model-a'];
  const probe = probeFor(async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ id })) }) }));
  await probe.refresh();
  assert.equal(probe.current(), 'model-a');
  ids = ['model-b'];
  await probe.refresh();
  assert.equal(probe.current(), 'model-b');
});

// --- detection outranks configuration --------------------------------------

test('a live answer beats INTENT_DEVICE_MODEL', async () => {
  const probe = probeFor(serving(['GLM-5.3-Flash-EXL3']));
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
  ];
  for (const [result, verdict] of cases) {
    const read = readVerdict(result);
    assert.equal(read.verdict, verdict, JSON.stringify(result));
    assert.equal(read.model, undefined, `invented a model from ${JSON.stringify(result)}`);
  }
  assert.equal(readVerdict({ http: 'OK', models: [' padded-id '] }).model, 'padded-id');
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
