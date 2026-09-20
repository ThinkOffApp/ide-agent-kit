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
// "serving". Only a returned token proves a model is loaded.
//
// The generation probe's default is split by trust: ON for a loopback
// endpoint, which is this box's own server and where one token every five
// minutes costs nothing worth counting, and OFF for anything else, which may
// be somebody else's compute, may bill per token, and may be a load-on-demand
// server where asking IS loading. --generate and --no-generate override it.
// Where it is off, the honest reading is `listed`, never `serving`.
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
import { ServedModelProbe } from '../packages/user-intent-kit/src/served-model.js';
import { ModelAvailabilityProbe } from '../packages/user-intent-kit/src/model-availability.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const endpointArg = argv[argv.indexOf('--endpoint') + 1];
const env = argv.includes('--endpoint') && endpointArg && !endpointArg.startsWith('--')
  ? { ...process.env, INTENT_MODEL_ENDPOINT: endpointArg }
  : process.env;

const roots = defaultSearchRoots(env);

// Exactly the wiring the daemon uses, so this prints what a card would say.
// The disk scan runs FIRST because it is the served probe's veto: a model that
// is incomplete or would not fit is never asked to generate, since asking a
// load-on-demand server for a token is how you make it load one.
const scan = new ModelAvailabilityProbe({ roots, env });
await scan.refresh();

const probeEnv = { ...env };
if (argv.includes('--generate')) probeEnv.INTENT_MODEL_GENERATE = '1';
if (argv.includes('--no-generate')) probeEnv.INTENT_MODEL_GENERATE = '0';

let probe = null;
try {
  probe = new ServedModelProbe({ env: probeEnv, guard: id => scan.couldLoad(id) });
  await probe.refresh();
} catch (err) {
  console.error(`model-available: not probing a server - ${err.message}`);
}

const listed = probe?.listed() ?? [];
const proved = probe?.current();
const served = proved ? [proved] : [];
const verdict = probe?.lastResult() ?? null;

const { budget, now, models } = await describeLocalModels({
  servedIds: served,
  listedIds: listed,
  manualName: (env.INTENT_DEVICE_MODEL || '').trim() || null,
  roots,
  env,
});

if (asJson) {
  console.log(JSON.stringify({ budget, now, roots, listed, served, verdict, models }, null, 2));
} else {
  const gb = b => `${(b / 1e9).toFixed(1)} GB`;
  console.log(`memory budget: ${budget.bytes ? gb(budget.bytes) : 'unknown'} (${budget.source})`);
  if (budget.note) console.log(`               ${budget.note}`);
  console.log(`available now: ${now?.bytes ? gb(now.bytes) : 'unknown'}${now?.holder ? `  (largest consumer: ${now.holder.name}, ${gb(now.holder.bytes)})` : ''}`);
  if (now?.note) console.log(`               ${now.note}`);
  console.log(`search roots:  ${roots.join(', ')}`);
  console.log(`listed by server: ${listed.length ? listed.join(', ') : '(none)'}`);
  console.log(`generation probe: ${probe?.generates ? 'on' : 'off'}${probe ? ` (${probe.describe()})` : ''}`);
  if (listed.length && !proved) {
    const why = verdict?.reason ? `: ${verdict.reason}` : '';
    console.log(`               a listing is not a loading; nothing here is shown to be loaded${why}`);
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
