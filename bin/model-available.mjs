#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// model-available - what THIS box could serve, and how well we know it.
//
// The companion to bin/model-capacity.mjs, one axis over. model-capacity asks
// remote endpoints whether they can take a switch right now. This asks the
// local disk and the local GPU a narrower question: are the bytes here, all of
// them, and would they fit - today, or only after something is stopped?
//
// Every line states its evidence, and the states never collapse into each
// other:
//
//   serving                          it GENERATED a token when asked
//   available and fits               complete on disk, fits what is free NOW
//   available, fits only after       complete on disk, fits the box, not
//     freeing memory (N GB)            alongside what is resident today
//   available, current headroom      fits the box; this machine will not say
//     unknown                          what is free
//   on disk, memory budget unknown   we could not measure the ceiling
//   on disk, too large for this box  will not fit even with the box emptied
//   on disk, incomplete              a download in flight
//   configured name, unverified      a human typed it; proven by nothing
//
// A LISTING IS NOT A LOADING. `mlx_lm server` enumerates the local
// HuggingFace cache, so `/v1/models` naming a model proves only that some
// files exist - the same grade of evidence as the disk scan below it, and in
// September 2026 it put a still-downloading 75 GiB model on a dashboard as
// "serving". Only a returned token proves a model is loaded, so `serving`
// requires --generate. That probe is OFF by default: it spends a forward pass
// on somebody's box and can make a server load a model it had not loaded.
//
// TWO FIT STATES, NOT ONE. Comparing a model against the machine's total
// budget assumes the operator will quit whatever else is running. "Fits" is
// reserved for the claim that needs no such assumption; everything else has to
// name its price in GB.
//
// "Budget unknown" is never "fits". On Apple Silicon the ceiling is Metal's
// recommended working set, not installed RAM and not free memory; without mlx
// to ask and with iogpu.wired_limit_mb at 0 (system default, an unpublished
// policy), there is no number to report, and inventing one from hw.memsize is
// how an unmeasurable becomes a confident claim on a public dashboard.
//
//   node bin/model-available.mjs [--json] [--endpoint host:port]
//
// INTENT_MODEL_DIRS       colon-separated search roots (replaces the defaults)
// INTENT_MODEL_BUDGET_GB  an operator's budget, for a box we cannot measure

import {
  describeLocalModels,
  defaultSearchRoots,
} from '../packages/user-intent-kit/src/model-availability.js';
import { servedModelEntry } from '../packages/user-intent-kit/src/served-model.js';
import { probeServedModels, probeGeneration } from '../packages/user-intent-kit/src/model-capacity.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const wantGeneration = argv.includes('--generate');
const endpointArg = argv[argv.indexOf('--endpoint') + 1];
const env = argv.includes('--endpoint') && endpointArg && !endpointArg.startsWith('--')
  ? { ...process.env, INTENT_MODEL_ENDPOINT: endpointArg }
  : process.env;

/** What a local server ADVERTISES. Files on a disk somewhere, nothing more. */
async function listedIds() {
  let entry;
  try {
    entry = servedModelEntry(env);
  } catch (err) {
    console.error(`model-available: not probing a server - ${err.message}`);
    return { entry: null, listed: [] };
  }
  if (!entry) return { entry: null, listed: [] };
  try {
    const result = await probeServedModels(entry, { timeoutMs: 4000, env });
    const listed = result?.http === 'OK' && Array.isArray(result.models) ? result.models : [];
    return { entry, listed };
  } catch {
    return { entry, listed: [] };
  }
}

/**
 * Ask one model for one token. Only with --generate, and only when exactly one
 * model is listed: naming one of several would be a guess, and on a server
 * that loads on demand it would be an instruction to load it.
 */
async function provedIds(entry, listed) {
  if (!wantGeneration || !entry || listed.length !== 1) return [];
  const proof = await probeGeneration(entry, { modelId: listed[0], timeoutMs: 5000, env });
  if (!proof.generated) {
    console.error(`model-available: ${listed[0]} did not generate - ${proof.reason}`);
    return [];
  }
  return [proof.model];
}

const roots = defaultSearchRoots(env);
const { entry, listed } = await listedIds();
const served = await provedIds(entry, listed);
const { budget, now, models } = await describeLocalModels({
  servedIds: served,
  listedIds: listed,
  manualName: (env.INTENT_DEVICE_MODEL || '').trim() || null,
  roots,
  env,
});

if (asJson) {
  console.log(JSON.stringify({ budget, now, roots, listed, served, models }, null, 2));
} else {
  const gb = b => `${(b / 1e9).toFixed(1)} GB`;
  console.log(`memory budget: ${budget.bytes ? gb(budget.bytes) : 'unknown'} (${budget.source})`);
  if (budget.note) console.log(`               ${budget.note}`);
  console.log(`available now: ${now?.bytes ? gb(now.bytes) : 'unknown'}${now?.holder ? `  (largest consumer: ${now.holder.name}, ${gb(now.holder.bytes)})` : ''}`);
  if (now?.note) console.log(`               ${now.note}`);
  console.log(`search roots:  ${roots.join(', ')}`);
  console.log(`listed by server: ${listed.length ? listed.join(', ') : '(none)'}`);
  if (listed.length && !wantGeneration) {
    console.log('               a listing is not a loading; pass --generate to ask for a token');
  }
  console.log('');
  for (const m of models) {
    const size = m.sizeGb === undefined ? '        ?' : `${m.sizeGb.toFixed(1)} GB`.padStart(9);
    const params = m.paramsB === undefined
      ? ''
      : `  ${m.paramsB}B${m.paramsSource === 'name-unconfirmed' ? '?' : ''}`;
    console.log(`${m.label.padEnd(46)} ${size}${params.padEnd(8)}  ${m.model}`);
    if (m.reason) console.log(`${''.padEnd(46)}            ${m.reason}`);
  }
  if (!models.length) console.log('(no models found and no server answering)');
}

// A non-zero exit would make this unusable in a pipeline that just wants the
// picture, so an empty fleet is still a successful run. The states carry the
// bad news; the exit code is not a second, quieter channel for it.
process.exitCode = 0;
