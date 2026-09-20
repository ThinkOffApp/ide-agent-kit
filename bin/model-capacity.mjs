#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// model-capacity - every model endpoint in the fleet registry, one line each,
// measured NOW.
//
// THIS IS WHAT THE SWITCHER CALLS AT SWITCH TIME. Never from a cache, never
// from a file somebody wrote earlier, never from a daemon's last heartbeat.
// The module it wraps (packages/user-intent-kit/src/model-capacity.js) has no
// cache on purpose. "The endpoint answered a minute ago" does not mean the
// box has memory free now, and it certainly does not mean nobody started an
// LTX render in between. Probe, then switch.
//
// Three facts shape the output, all learned the hard way:
//
//   * "unreachable" and "serving nothing" must never render the same way.
//     They call for opposite actions - fix the network, or start the server -
//     so they are separate states and every entry prints exactly one line
//     every run. Silence is impossible here.
//   * A capacity reading we could not take is printed as `free=?`, not as 0
//     and not as a comfortable default. A check that cannot fail is not a
//     check. The same goes for the path: `unknown`, never an assumed
//     `direct`.
//   * The latency column is a p90 over several samples with the spread beside
//     it, never one ping. Helsinki to Berlin measured min 63 / mean 167 /
//     stddev 96 ms over 55 minutes, relayed nearly the whole time. A single
//     sample of that link is wrong most of the time, and CAPACITY AND PATH
//     ARE SEPARATE AXES: an idle box on a bad path is still a bad switch, so
//     both are printed and neither is folded into the state.
//
// RUN THIS ON THE HOST THAT WILL CONSUME THE MODEL. Path and latency are per
// peer pair, not per target: M5 and mini sit behind the same Helsinki router
// and at 03:20 tonight M5 was direct to Berlin while mini had been relayed
// since 02:22. Running the probe on a phone, a relay, or a convenient always
// on box and handing the answer to a different host reports the wrong path.
// Every line is stamped with the host that measured it, in the header.
//
// Usage:
//   bin/model-capacity.mjs [--registry PATH] [--json] [--timeout MS]
//                          [--free-threshold GIB] [--samples N] [--allow-lan]
//
// Default registry: config/models.json (see config/models.README.md).
//
// Exit codes: 0 = every entry answered, 2 = usage or registry error,
// 3 = at least one entry was UNREACHABLE (the output still says which).
// Matches scripts/lead-desk.py, which learned the same lesson about silence.

import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probeModels, readRegistryFile, RegistryError, resolveCallerHost,
  DEFAULT_TIMEOUT_MS, DEFAULT_FREE_MEM_THRESHOLD_GIB, DEFAULT_LATENCY_SAMPLES,
} from '../packages/user-intent-kit/src/model-capacity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      registry: { type: 'string' },
      json: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      'free-threshold': { type: 'string' },
      samples: { type: 'string' },
      'allow-lan': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  process.stderr.write(`model-capacity: ${err.message}\n`);
  process.exit(2);
}

if (opts.help) {
  process.stdout.write(
    'Usage: model-capacity.mjs [--registry PATH] [--json] [--timeout MS] [--free-threshold GIB] [--samples N] [--allow-lan]\n' +
    'Exit 0 all answered, 2 usage/registry error, 3 at least one UNREACHABLE.\n');
  process.exit(0);
}

function positiveNumber(raw, flag) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`model-capacity: --${flag} must be a positive number, got ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return n;
}

const registryPath = opts.registry || join(ROOT, 'config', 'models.json');
const timeoutMs = positiveNumber(opts.timeout, 'timeout') ?? DEFAULT_TIMEOUT_MS;
const freeMemThresholdGiB = positiveNumber(opts['free-threshold'], 'free-threshold') ?? DEFAULT_FREE_MEM_THRESHOLD_GIB;
const latencySamples = positiveNumber(opts.samples, 'samples') ?? DEFAULT_LATENCY_SAMPLES;

let registry;
try {
  registry = await readRegistryFile(registryPath, { allowLan: opts['allow-lan'] });
} catch (err) {
  if (err instanceof RegistryError) {
    process.stderr.write(`model-capacity: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

if (opts['allow-lan'] && registry.some(e => e.lanOverride)) {
  const hosts = registry.filter(e => e.lanOverride).map(e => `${e.id} (${e.host})`).join(', ');
  process.stderr.write(
    `model-capacity: --allow-lan in effect for ${hosts}. ` +
    'These entries only resolve on one network - they will reach the wrong box, or nothing, from anywhere else.\n');
}

const callerHost = await resolveCallerHost();
const results = await probeModels(registry, { timeoutMs, freeMemThresholdGiB, latencySamples, callerHost });

if (opts.json) {
  process.stdout.write(JSON.stringify({
    registry: registryPath,
    probedAt: new Date().toISOString(),
    from: callerHost,
    pathScope: 'per-caller-host',
    timeoutMs,
    freeMemThresholdGiB,
    latencySamples,
    results,
  }, null, 2) + '\n');
} else {
  // Name the measuring host: the same registry probed from mini and from M5
  // can legitimately disagree about the path to the same box.
  process.stdout.write(
    `# probed from ${callerHost} at ${new Date().toISOString()} - ` +
    'path and latency are per caller host, capacity is per target\n');
  const idWidth = Math.max(2, ...results.map(r => r.id.length));
  const addrWidth = Math.max(4, ...results.map(r => `${r.host}:${r.port}`.length));
  for (const r of results) {
    const free = r.freeMemGiB === null ? 'free=?   GiB' : `free=${String(r.freeMemGiB).padStart(4)} GiB`;
    // p90 with the spread beside it. One number would be a lie on a relayed
    // link, so an unmeasured spread prints as +-? rather than as +-0.
    const p90 = r.p90Ms === null ? '  ?' : String(Math.round(r.p90Ms)).padStart(4);
    const jitter = r.jitterMs === null ? '?' : String(Math.round(r.jitterMs));
    const latency = `p90=${p90} ms +-${jitter.padEnd(3)} n=${r.latencySamples}`;
    process.stdout.write([
      r.id.padEnd(idWidth),
      r.state.padEnd(11),
      `${r.host}:${r.port}`.padEnd(addrWidth),
      free,
      latency,
      r.path.padEnd(8),
      r.reason || '',
    ].join('  ').trimEnd() + '\n');
  }
}

process.exit(results.some(r => r.state === 'UNREACHABLE') ? 3 : 0);
