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
//   serving                          a live /v1/models listing names it
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
import { probeServedModels } from '../packages/user-intent-kit/src/model-capacity.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const endpointArg = argv[argv.indexOf('--endpoint') + 1];
const env = argv.includes('--endpoint') && endpointArg && !endpointArg.startsWith('--')
  ? { ...process.env, INTENT_MODEL_ENDPOINT: endpointArg }
  : process.env;

/** What a local server says it has loaded. Absent is absent, never assumed. */
async function servedIds() {
  let entry;
  try {
    entry = servedModelEntry(env);
  } catch (err) {
    console.error(`model-available: not probing a server - ${err.message}`);
    return [];
  }
  if (!entry) return [];
  try {
    const result = await probeServedModels(entry, { timeoutMs: 4000, env });
    return result?.http === 'OK' && Array.isArray(result.models) ? result.models : [];
  } catch {
    return [];
  }
}

const roots = defaultSearchRoots(env);
const served = await servedIds();
const { budget, now, models } = await describeLocalModels({
  servedIds: served,
  manualName: (env.INTENT_DEVICE_MODEL || '').trim() || null,
  roots,
  env,
});

if (asJson) {
  console.log(JSON.stringify({ budget, now, roots, served, models }, null, 2));
} else {
  const gb = b => `${(b / 1e9).toFixed(1)} GB`;
  console.log(`memory budget: ${budget.bytes ? gb(budget.bytes) : 'unknown'} (${budget.source})`);
  if (budget.note) console.log(`               ${budget.note}`);
  console.log(`available now: ${now?.bytes ? gb(now.bytes) : 'unknown'}${now?.holder ? `  (largest consumer: ${now.holder.name}, ${gb(now.holder.bytes)})` : ''}`);
  if (now?.note) console.log(`               ${now.note}`);
  console.log(`search roots:  ${roots.join(', ')}`);
  console.log('');
  for (const m of models) {
    const size = m.sizeGb === undefined ? '        ?' : `${m.sizeGb.toFixed(1)} GB`.padStart(9);
    console.log(`${m.label.padEnd(46)} ${size}  ${m.model}`);
    if (m.reason) console.log(`${''.padEnd(46)}            ${m.reason}`);
  }
  if (!models.length) console.log('(no models found and no server answering)');
}

// A non-zero exit would make this unusable in a pipeline that just wants the
// picture, so an empty fleet is still a successful run. The states carry the
// bad news; the exit code is not a second, quieter channel for it.
process.exitCode = 0;
