#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// model-picker - probe the fleet, offer the ones that are actually UP as
// buttons on the phone, and apply the tap.
//
// This is the last mile of the switcher. bin/model-capacity.mjs already
// answers "what is usable right now?" and src/confirmations.mjs already knows
// how to put a question in front of petrus as one button per option. Nothing
// joined the two, so the answer to "which model are we on?" was still a human
// editing a file on a laptop.
//
// The probe/offer/apply core (the five rules that shape it, the outcomes, the
// re-probe-at-apply-time discipline) lives in src/model-selection.mjs, so
// bin/iak-mcp-daemon.mjs can apply a tap WITHOUT a human running this CLI: the
// daemon calls the same applyChoice() this file calls, the instant a
// `kind: "model"` intent is decided, from whichever channel settled it. This
// file is now the CLI shell over that module: argument parsing, exit codes,
// and rendering a result for a terminal.
//
// ONE UP ENTRY IS A SELECTION, NOT A DEAD END. An earlier version refused to
// act when only one entry was UP, on the grounds that createIntent needs two
// options. That is an API constraint leaking into product behaviour, and it
// broke three real cases: a fresh box with no selection file (refusing at the
// moment there is nothing to protect), a fleet that shrank to one (where the
// refusal PRESERVES a selection pointing at a dead box), and anyone cloning
// this repo with a single machine, for whom the tool would never work. So a
// single UP entry is applied without a question, after the same re-probe,
// unless it is already selected (nothing to do) or --require-choice says the
// tap itself is the point.
//
// RUN THIS ON THE HOST THAT WILL CONSUME THE MODEL. Path and latency are per
// peer pair, so a picker run somewhere convenient and applied elsewhere picks
// on somebody else's network. The selection file records `selectedFrom` so a
// selection can never be mistaken for one made from another box.
//
// Usage:
//   bin/model-picker.mjs [--registry PATH] [--selection PATH] [--daemon URL]
//                        [--timeout-sec N] [--probe-timeout MS]
//                        [--free-threshold GIB] [--samples N]
//                        [--allow-lan] [--require-choice] [--dry-run] [--json]
//
// Exit codes:
//   0  a selection was applied, the single UP entry was already selected, or
//      --dry-run printed an offer
//   1  an unexpected fault (a stack trace is a bug report, not a state)
//   2  usage error, or no readable registry
//   3  the registry loaded and no entry is UP (the report says what each was)
//   4  the intent daemon is not answering
//   5  the intent timed out with no answer (previous selection untouched)
//   6  the chosen entry was no longer UP at apply time (previous selection
//      untouched)
//   7  the answer was not one of the options we offered (nothing applied)
//   8  the human tapped and the write FAILED (previous selection untouched,
//      and the report says the choice did not take effect)
//   9  the daemon answered and refused the intent (it is running; do not
//      restart it)
//  10  exactly one entry was UP and --require-choice forbade applying it
//      without a tap

import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveCallerHost,
  DEFAULT_TIMEOUT_MS, DEFAULT_FREE_MEM_THRESHOLD_GIB, DEFAULT_LATENCY_SAMPLES,
} from '../packages/user-intent-kit/src/model-capacity.js';
import { isMainModule } from '../src/common/entrypoint.mjs';
import {
  DEFAULT_DAEMON_BASE, DEFAULT_SELECTION_PATH, DEFAULT_CHOICE_TIMEOUT_SEC, DEFAULT_POLL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OUTCOMES, EXIT_CODES,
  baseUrlFor, offerability, describeOffer, describeExclusion, buildOffer, probeAndOffer,
  buildSelection, readSelection, writeSelection,
  raiseChoice, daemonIsUp, applyChoice,
  pickModel,
} from '../src/model-selection.mjs';

// Re-exported for backward compatibility: test/model-picker.test.mjs (and
// anything else in the repo) imports these names from this file. The
// implementations now live in src/model-selection.mjs; this is the same
// binding, not a copy.
export {
  DEFAULT_DAEMON_BASE, DEFAULT_SELECTION_PATH, DEFAULT_CHOICE_TIMEOUT_SEC, DEFAULT_POLL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OUTCOMES, EXIT_CODES,
  baseUrlFor, offerability, describeOffer, describeExclusion, buildOffer, probeAndOffer,
  buildSelection, readSelection, writeSelection,
  raiseChoice, daemonIsUp, applyChoice,
  pickModel,
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- rendering -------------------------------------------------------------

export function renderOutcome(outcome, { json = false } = {}) {
  if (json) return JSON.stringify(outcome, null, 2) + '\n';
  const o = outcome.outcome;
  const was = outcome.previous?.selectedId ?? 'none';
  const lines = [];
  if (o === OUTCOMES.NO_REGISTRY) {
    lines.push(`model-picker: no usable registry at ${outcome.registryPath}`);
    lines.push(`  ${outcome.error}`);
    lines.push('  Copy config/models.example.json to config/models.json and list the boxes by tailnet name.');
  } else if (o === OUTCOMES.NONE_UP) {
    lines.push('model-picker: the registry loaded and nothing in it is usable right now.');
    lines.push('  This is not "no models exist" - here is what each entry was:');
    for (const line of outcome.excluded) lines.push(`    ${line}`);
    lines.push('  Nothing was offered and nothing was changed.');
  } else if (o === OUTCOMES.ONLY_ONE_UP) {
    lines.push(`model-picker: only ${outcome.options[0]} is usable, and --require-choice forbids applying it without a tap.`);
    for (const line of outcome.offered) lines.push(`    ${line}`);
    for (const line of outcome.excluded) lines.push(`    not offered: ${line}`);
    lines.push('  Nothing was changed. Drop --require-choice to apply the sole usable entry.');
  } else if (o === OUTCOMES.ALREADY_SELECTED) {
    lines.push(`model-picker: ${outcome.chosenId} is the only usable entry and is already selected. Nothing to do.`);
    for (const line of outcome.offered) lines.push(`    ${line}`);
  } else if (o === OUTCOMES.DRY_RUN) {
    lines.push('model-picker --dry-run: this is what would be offered, no intent raised.');
    lines.push('  Options (these exact strings are the buttons, and the answer):');
    for (const id of outcome.options) lines.push(`    ${id}`);
    lines.push('  Prompt:');
    for (const line of outcome.prompt.split('\n')) lines.push(`    ${line}`);
    if (!outcome.excluded.length) lines.push('  Nothing excluded: every entry is usable.');
  } else if (o === OUTCOMES.DAEMON_UNREACHABLE) {
    lines.push(`model-picker: ${outcome.error}`);
    lines.push('  Start the intent daemon (bin/iak-mcp-daemon.mjs) and run this again.');
    lines.push(`  Previous selection left as it was: ${was}`);
  } else if (o === OUTCOMES.DAEMON_REFUSED) {
    lines.push(`model-picker: ${outcome.error}`);
    lines.push(`  The daemon at ${outcome.daemonBase} is RUNNING - do not restart it. The request was wrong, not the daemon.`);
    lines.push(`  Previous selection left as it was: ${was}`);
  } else if (o === OUTCOMES.TIMEOUT) {
    lines.push(`model-picker: intent ${outcome.intentId} went ${outcome.timeoutSec}s with no answer.`);
    lines.push(`  Nobody chose, so nothing was written. Previous selection left as it was: ${was}`);
  } else if (o === OUTCOMES.CHANGED_SINCE_OFFER) {
    lines.push(`model-picker: NOT applying ${outcome.chosenId}.`);
    lines.push(`  ${outcome.error}`);
    lines.push(`  Previous selection left as it was: ${was}`);
    lines.push('  Run again to pick from a fresh probe.');
  } else if (o === OUTCOMES.NOT_OFFERED) {
    lines.push(`model-picker: NOT applying ${outcome.chosenId}.`);
    lines.push(`  ${outcome.error}`);
    lines.push(`  Previous selection left as it was: ${was}`);
  } else if (o === OUTCOMES.WRITE_FAILED) {
    lines.push(`model-picker: YOUR CHOICE DID NOT TAKE EFFECT. ${outcome.chosenId} was picked and could not be saved.`);
    lines.push(`  ${outcome.error}`);
    lines.push(`  Nothing was changed: the fleet is still on ${was}.`);
    lines.push(`  Fix the path or its permissions and run this again - the tap has to be repeated.`);
  } else if (o === OUTCOMES.APPLIED || o === OUTCOMES.APPLIED_SOLE) {
    const s = outcome.selection;
    lines.push(`model-picker: selected ${s.selectedId}`);
    if (o === OUTCOMES.APPLIED_SOLE) {
      lines.push('  It was the only usable entry, so nobody was asked to choose between one thing.');
      if (outcome.soleReason) lines.push(`    ${outcome.soleReason}`);
    }
    lines.push(`  was:  ${outcome.previous?.selectedId ?? 'nothing selected'}`);
    lines.push(`  now:  ${s.selectedId}  ${s.baseUrl}  model=${s.model}`);
    lines.push(`  keyFile: ${s.keyFile ?? 'none (this endpoint needs no key)'}`);
    lines.push(`  re-probed usable at ${outcome.recheckedAt} before writing`);
    lines.push(`  written to ${outcome.selectionPath}`);
  }
  return lines.join('\n') + '\n';
}

// --- CLI -------------------------------------------------------------------

function positiveNumber(raw, flag) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error(`--${flag} must be a positive number, got ${JSON.stringify(raw)}`);
    err.usage = true;
    throw err;
  }
  return n;
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        registry: { type: 'string' },
        selection: { type: 'string' },
        daemon: { type: 'string' },
        'timeout-sec': { type: 'string' },
        'probe-timeout': { type: 'string' },
        'free-threshold': { type: 'string' },
        samples: { type: 'string' },
        'allow-lan': { type: 'boolean', default: false },
        'require-choice': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    stderr.write(`model-picker: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    stdout.write(
      'Usage: model-picker.mjs [--registry PATH] [--selection PATH] [--daemon URL]\n' +
      '                        [--timeout-sec N] [--probe-timeout MS] [--free-threshold GIB]\n' +
      '                        [--samples N] [--allow-lan] [--require-choice] [--dry-run] [--json]\n' +
      'Exit 0 applied / already selected / dry-run, 1 unexpected fault, 2 usage or registry,\n' +
      '3 nothing usable, 4 no daemon, 5 no answer before the timeout, 6 the chosen box changed,\n' +
      '7 the answer was not offered, 8 the write failed after the tap, 9 the daemon refused,\n' +
      '10 one entry usable and --require-choice given.\n');
    return 0;
  }

  // Everything below can throw: a bad flag, an unreadable home directory, a
  // probe that hits a Node bug. A stack trace on stderr with exit 1 tells the
  // person who just tapped a button nothing they can act on.
  try {
    const outcome = await pickModel({
      registryPath: opts.registry || join(ROOT, 'config', 'models.json'),
      selectionPath: opts.selection || DEFAULT_SELECTION_PATH,
      daemonBase: opts.daemon || DEFAULT_DAEMON_BASE,
      allowLan: opts['allow-lan'],
      dryRun: opts['dry-run'],
      requireChoice: opts['require-choice'],
      timeoutSec: positiveNumber(opts['timeout-sec'], 'timeout-sec') ?? DEFAULT_CHOICE_TIMEOUT_SEC,
      probeOptions: {
        timeoutMs: positiveNumber(opts['probe-timeout'], 'probe-timeout') ?? DEFAULT_TIMEOUT_MS,
        freeMemThresholdGiB: positiveNumber(opts['free-threshold'], 'free-threshold') ?? DEFAULT_FREE_MEM_THRESHOLD_GIB,
        latencySamples: positiveNumber(opts.samples, 'samples') ?? DEFAULT_LATENCY_SAMPLES,
      },
      callerHost: await resolveCallerHost(),
    });

    const text = renderOutcome(outcome, { json: opts.json });
    const code = EXIT_CODES[outcome.outcome] ?? 1;
    (code === 0 ? stdout : stderr).write(text);
    return code;
  } catch (err) {
    if (err?.usage) {
      stderr.write(`model-picker: ${err.message}\n`);
      return 2;
    }
    stderr.write(
      `model-picker: unexpected fault, nothing was changed: ${err?.message || err}\n` +
      '  This is a bug in the picker. Re-run with --json for the last state it reached.\n');
    return 1;
  }
}

// Only when run directly. The comparison lives in src/common/entrypoint.mjs,
// which realpaths both sides because import.meta.url is already resolved and
// process.argv[1] is not: a `~/bin` symlink (the documented way to put this on
// PATH) or macOS /tmp (itself a symlink) made a naive comparison false, so
// main() never ran and the program exited 0 - a code this file documents as
// "a selection was applied". One implementation, because this repo has got the
// idiom wrong three times in three different files.
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  process.exit(await main());
}
