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
// FOUR RULES SHAPE EVERY LINE BELOW.
//
// 1. RE-PROBE AT APPLY TIME, NOT ONLY AT OFFER TIME. This is the reason the
//    program exists in this shape. The gap between raising the intent and the
//    tap is human-sized: minutes, sometimes an hour. In that window a box
//    fills up, somebody starts an LTX render, a server gets restarted. A
//    picker that writes whatever was UP when it asked is a picker that writes
//    a stale fact with a fresh timestamp on it. So the chosen entry is probed
//    AGAIN when the answer arrives, and an entry that is no longer UP is NOT
//    applied: the previous selection survives untouched and the report says
//    what changed and when each reading was taken.
//
// 2. THE LABEL IS THE ANSWER, SO THE LABEL IS THE ID. createIntent treats the
//    option list as an allow-list: `/choose <id> <label>` is refused unless
//    the label matches one it declared. That guarantee is only worth anything
//    if a returned label maps back to exactly one registry entry, so the
//    labels are entry ids and nothing else - no "glm53-asus (8 GiB free)",
//    which would round-trip as a string that matches no entry. The human
//    detail lives in the PROMPT, where it can be as long as it needs to be.
//
// 3. A KEY IS A PATH, NEVER A VALUE. The selection file is read by the rest of
//    the fleet and gets copied around, quoted in rooms and pasted into
//    issues. It carries `keyFile` - the PATH from the registry entry - and the
//    token is never read, never resolved and never written here. The probe
//    module holds the same line for config/models.json, for the same reason.
//
// 4. EVERY REFUSAL SAYS WHICH REFUSAL IT IS. "No registry file", "the registry
//    loaded and nothing in it is UP", "the daemon is not answering" and "we
//    asked and nobody tapped" are four different faults with four different
//    repairs, and folding them into one "no model available" sends an operator
//    looking in the wrong place. In particular, a fleet that is entirely
//    UNREACHABLE is a NETWORK fault and must never be rendered as "none
//    available": the zero-UP report names every entry and the state it was in.
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
//                        [--allow-lan] [--dry-run] [--json]
//
// Exit codes:
//   0  a selection was applied, or --dry-run printed an offer
//   2  usage error, or no readable registry
//   3  the registry loaded and no entry is UP (the report says what each was)
//   4  the intent daemon is not answering
//   5  the intent timed out with no answer (previous selection untouched)
//   6  the chosen entry was no longer UP at apply time (previous selection
//      untouched)

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

import {
  probeModels, readRegistryFile, RegistryError, resolveCallerHost,
  DEFAULT_TIMEOUT_MS, DEFAULT_FREE_MEM_THRESHOLD_GIB, DEFAULT_LATENCY_SAMPLES,
} from '../packages/user-intent-kit/src/model-capacity.js';
import { resolveGateToken, gateAuthHeaders } from '../src/mcp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DAEMON_BASE = 'http://127.0.0.1:8788';
export const DEFAULT_SELECTION_PATH = join(homedir(), '.iak', 'model-selection.json');
export const DEFAULT_CHOICE_TIMEOUT_SEC = 600;
export const DEFAULT_POLL_MS = 1000;

// One outcome per exit path. Exported so the tests, the JSON output and any
// caller that wraps this all name the same fault the same way.
export const OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  DRY_RUN: 'dry-run',
  NO_REGISTRY: 'no-registry',
  NONE_UP: 'none-up',
  ONLY_ONE_UP: 'only-one-up',
  DAEMON_UNREACHABLE: 'daemon-unreachable',
  TIMEOUT: 'timeout',
  CHANGED_SINCE_OFFER: 'changed-since-offer',
});

export const EXIT_CODES = Object.freeze({
  [OUTCOMES.APPLIED]: 0,
  [OUTCOMES.DRY_RUN]: 0,
  [OUTCOMES.NO_REGISTRY]: 2,
  [OUTCOMES.NONE_UP]: 3,
  [OUTCOMES.ONLY_ONE_UP]: 3,
  [OUTCOMES.DAEMON_UNREACHABLE]: 4,
  [OUTCOMES.TIMEOUT]: 5,
  [OUTCOMES.CHANGED_SINCE_OFFER]: 6,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- shaping the offer -----------------------------------------------------

/**
 * The OpenAI-style base URL a client should point at. The probe asks
 * /v1/models (or /api/v1/models on LM Studio), so the base is that path minus
 * the trailing `models` - which is exactly what an OpenAI client wants.
 */
export function baseUrlFor(entry) {
  const bracket = entry.host.includes(':') && !entry.host.startsWith('[') ? `[${entry.host}]` : entry.host;
  return `http://${bracket}:${entry.port}${entry.kind === 'lmstudio' ? '/api/v1' : '/v1'}`;
}

function gib(value) {
  return value === null || value === undefined ? 'free unknown' : `${value} GiB free`;
}

function latency(result) {
  if (result.p90Ms === null || result.p90Ms === undefined) return 'latency unknown';
  const jitter = result.jitterMs === null || result.jitterMs === undefined ? '?' : Math.round(result.jitterMs);
  return `p90 ${Math.round(result.p90Ms)} ms +-${jitter}`;
}

/**
 * The human line for one UP entry. Everything a person needs to choose
 * between boxes goes here, because none of it can go in the label: the label
 * has to round-trip as an id.
 */
export function describeOffer(result) {
  const model = result.models?.[0] || 'model unknown';
  const extra = result.models?.length > 1 ? ` (+${result.models.length - 1} more)` : '';
  return `${result.id} - ${model}${extra}, ${gib(result.freeMemGiB)}, ${latency(result)}, ${result.path}`;
}

/** The line for an entry we are NOT offering, and why. Never silence. */
export function describeExclusion(result) {
  return `${result.id} ${result.state}: ${result.reason || 'no reason given'}`;
}

/**
 * Split a probe run into what can be offered and what cannot, and build the
 * prompt. The excluded entries are named IN THE PROMPT, not only in a log: a
 * picker that shows two buttons out of four, with no word about the other
 * two, teaches its user that the fleet is smaller than it is.
 */
export function buildOffer(results, { callerHost = 'unknown', now = () => Date.now() } = {}) {
  const up = results.filter(r => r.state === 'UP');
  const excluded = results.filter(r => r.state !== 'UP');
  const options = up.map(r => r.id);
  const lines = [
    `Which model should ${callerHost} use?`,
    ...up.map(r => describeOffer(r)),
  ];
  if (excluded.length) {
    lines.push(`Not offered: ${excluded.map(describeExclusion).join('; ')}`);
  }
  lines.push(`Probed from ${callerHost} at ${new Date(now()).toISOString()}; re-checked before it is applied.`);
  return { options, offered: up, excluded, prompt: lines.join('\n') };
}

// --- the selection file ----------------------------------------------------

/**
 * What the fleet reads. `keyFile` is a PATH copied from the registry entry -
 * this program never opens it, so no token can reach this file even by
 * accident.
 */
export function buildSelection(entry, result, { callerHost, now = () => Date.now() }) {
  return {
    selectedId: entry.id,
    baseUrl: baseUrlFor(entry),
    model: result.models?.[0] ?? null,
    keyFile: entry.keyFile ?? null,
    selectedAt: new Date(now()).toISOString(),
    selectedFrom: callerHost,
  };
}

export async function readSelection(path, { readFileImpl = readFile } = {}) {
  try {
    return JSON.parse(await readFileImpl(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write via a temp file and rename, because a half-written selection file is
 * read by other processes as a broken config rather than as an interrupted
 * write.
 */
export async function writeSelection(path, selection, {
  writeFileImpl = writeFile, mkdirImpl = mkdir, renameImpl = rename,
} = {}) {
  const text = JSON.stringify(selection, null, 2) + '\n';
  await mkdirImpl(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFileImpl(tmp, text, { mode: 0o600 });
  await renameImpl(tmp, path);
  return text;
}

// --- the intent ------------------------------------------------------------

/**
 * Raise a CHOICE intent on the daemon and wait for the tap, exactly the way
 * request_choice does in src/mcp-server.mjs: POST /intent, then poll
 * /intents until the row says decided. The daemon is the shared registry that
 * CodeWatch and the chat-reply poller both see, so this is the path that puts
 * buttons on the phone.
 *
 * Returns {status: 'decided'|'timeout'|'unreachable'|'refused'}. A daemon that
 * is not there is its own answer, never a silent fall back to some other way
 * of asking - the operator has to know nobody was asked.
 */
export async function raiseChoice({
  daemonBase = DEFAULT_DAEMON_BASE,
  prompt,
  options,
  session = 'model-picker',
  fromHandle,
  timeoutSec = DEFAULT_CHOICE_TIMEOUT_SEC,
  pollMs = DEFAULT_POLL_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
  headers = gateAuthHeaders(resolveGateToken()),
} = {}) {
  let created;
  try {
    const res = await fetchImpl(`${daemonBase}/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ prompt, options, session, from_handle: fromHandle }),
    });
    created = await res.json();
  } catch (err) {
    return { status: 'unreachable', error: `${daemonBase} did not answer POST /intent (${err.message})` };
  }
  if (!created?.ok || !created.id) {
    return { status: 'refused', error: `daemon refused the intent: ${created?.error || 'no id returned'}` };
  }
  const id = created.id;
  const deadline = now() + timeoutSec * 1000;
  while (now() < deadline) {
    await sleep(pollMs);
    try {
      const list = await (await fetchImpl(`${daemonBase}/intents`, { headers })).json();
      const found = Array.isArray(list) ? list.find(i => i.id === id) : null;
      if (found && found.status === 'decided') {
        return { status: 'decided', id, decision: found.decision };
      }
    } catch { /* a dropped poll is not a decision; keep asking until the deadline */ }
  }
  return { status: 'timeout', id };
}

/** Is the daemon there at all? Same 500 ms probe the MCP server uses. */
export async function daemonIsUp({ daemonBase = DEFAULT_DAEMON_BASE, fetchImpl = fetch, headers = {} } = {}) {
  try {
    const res = await fetchImpl(`${daemonBase}/intents`, {
      method: 'GET', headers, signal: AbortSignal.timeout(500),
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

// --- the flow --------------------------------------------------------------

/**
 * Probe, offer, wait, RE-PROBE, apply. Every dependency is injectable so the
 * tests can move the fleet between the offer and the answer, which is the one
 * thing this program exists to survive.
 */
export async function pickModel({
  registryPath,
  selectionPath = DEFAULT_SELECTION_PATH,
  daemonBase = DEFAULT_DAEMON_BASE,
  allowLan = false,
  dryRun = false,
  timeoutSec = DEFAULT_CHOICE_TIMEOUT_SEC,
  pollMs = DEFAULT_POLL_MS,
  probeOptions = {},
  callerHost = 'unknown',
  fromHandle,
  now = () => Date.now(),
  // Injectable seams.
  readRegistryImpl = readRegistryFile,
  probeImpl = probeModels,
  raiseChoiceImpl = raiseChoice,
  daemonIsUpImpl = daemonIsUp,
  readSelectionImpl = readSelection,
  writeSelectionImpl = writeSelection,
  fetchImpl = fetch,
  headers,
} = {}) {
  let registry;
  try {
    registry = await readRegistryImpl(registryPath, { allowLan });
  } catch (err) {
    if (err instanceof RegistryError) {
      return { outcome: OUTCOMES.NO_REGISTRY, registryPath, error: err.message };
    }
    throw err;
  }

  const results = await probeImpl(registry, { ...probeOptions, callerHost });
  const offer = buildOffer(results, { callerHost, now });
  const previous = await readSelectionImpl(selectionPath);

  if (!offer.options.length) {
    return {
      outcome: OUTCOMES.NONE_UP,
      registryPath, previous,
      // Every entry, with the state it was in. An all-UNREACHABLE fleet is a
      // network fault, not an empty fleet, and the two must not read alike.
      states: results.map(r => ({ id: r.id, state: r.state, reason: r.reason })),
      excluded: offer.excluded.map(describeExclusion),
    };
  }

  if (dryRun) {
    return {
      outcome: OUTCOMES.DRY_RUN,
      registryPath, previous,
      options: offer.options,
      prompt: offer.prompt,
      offered: offer.offered.map(describeOffer),
      excluded: offer.excluded.map(describeExclusion),
    };
  }

  // A one-button choice is not a choice, and createIntent refuses it. Say so
  // as its own outcome rather than letting the daemon answer 400 into a
  // message about option arrays: the operator's problem is the fleet, not the
  // request body.
  if (offer.options.length < 2) {
    return {
      outcome: OUTCOMES.ONLY_ONE_UP,
      registryPath, previous,
      options: offer.options,
      offered: offer.offered.map(describeOffer),
      excluded: offer.excluded.map(describeExclusion),
    };
  }

  if (!(await daemonIsUpImpl({ daemonBase, fetchImpl, headers }))) {
    return {
      outcome: OUTCOMES.DAEMON_UNREACHABLE,
      registryPath, previous, daemonBase,
      options: offer.options,
      error: `no intent daemon answering at ${daemonBase} - nobody was asked, so nothing was changed`,
    };
  }

  const answer = await raiseChoiceImpl({
    daemonBase, prompt: offer.prompt, options: offer.options,
    timeoutSec, pollMs, fetchImpl, now, fromHandle, headers,
  });

  if (answer.status === 'unreachable' || answer.status === 'refused') {
    return {
      outcome: OUTCOMES.DAEMON_UNREACHABLE,
      registryPath, previous, daemonBase, options: offer.options, error: answer.error,
    };
  }
  if (answer.status !== 'decided') {
    return {
      outcome: OUTCOMES.TIMEOUT,
      registryPath, previous, intentId: answer.id, timeoutSec,
      options: offer.options,
    };
  }

  // The allow-list held at the daemon, so this should always hit. It is
  // checked anyway: the whole point of labelling with ids is that the mapping
  // back is exact, and an unmappable label must fail loudly rather than write
  // a selection for a box nobody picked.
  const entry = registry.find(e => e.id === answer.decision);
  if (!entry) {
    return {
      outcome: OUTCOMES.CHANGED_SINCE_OFFER,
      registryPath, previous, intentId: answer.id, chosenId: answer.decision,
      error: `"${answer.decision}" matches no registry entry - not applying`,
    };
  }

  // THE POINT OF THIS PROGRAM. The offer reading is now as old as the human
  // took to tap. Take a fresh one for the chosen entry before writing
  // anything.
  const [recheck] = await probeImpl([entry], { ...probeOptions, callerHost });
  const before = results.find(r => r.id === entry.id);
  if (recheck.state !== 'UP') {
    return {
      outcome: OUTCOMES.CHANGED_SINCE_OFFER,
      registryPath, previous, intentId: answer.id, chosenId: entry.id,
      offeredState: before?.state ?? null,
      offeredReason: before?.reason ?? null,
      currentState: recheck.state,
      currentReason: recheck.reason,
      recheckedAt: recheck.checkedAt,
      error: `${entry.id} was ${before?.state ?? 'UP'} when offered and is ${recheck.state} now (${recheck.reason}) - previous selection left as it was`,
    };
  }

  const selection = buildSelection(entry, recheck, { callerHost, now });
  await writeSelectionImpl(selectionPath, selection);
  return {
    outcome: OUTCOMES.APPLIED,
    registryPath, selectionPath, previous, selection,
    intentId: answer.id,
    chosenId: entry.id,
    recheckedAt: recheck.checkedAt,
  };
}

// --- rendering -------------------------------------------------------------

export function renderOutcome(outcome, { json = false } = {}) {
  if (json) return JSON.stringify(outcome, null, 2) + '\n';
  const o = outcome.outcome;
  const lines = [];
  if (o === OUTCOMES.NO_REGISTRY) {
    lines.push(`model-picker: no usable registry at ${outcome.registryPath}`);
    lines.push(`  ${outcome.error}`);
    lines.push('  Copy config/models.example.json to config/models.json and list the boxes by tailnet name.');
  } else if (o === OUTCOMES.NONE_UP) {
    lines.push('model-picker: the registry loaded and nothing in it is UP right now.');
    lines.push('  This is not "no models exist" - here is what each entry was:');
    for (const s of outcome.states) lines.push(`    ${s.id} ${s.state}: ${s.reason}`);
    lines.push('  Nothing was offered and nothing was changed.');
  } else if (o === OUTCOMES.ONLY_ONE_UP) {
    lines.push(`model-picker: only one entry is UP (${outcome.options[0]}), so there is nothing to pick between.`);
    for (const line of outcome.offered) lines.push(`    ${line}`);
    for (const line of outcome.excluded) lines.push(`    not offered: ${line}`);
    lines.push('  A one-button choice is not a choice, so no intent was raised and nothing was changed.');
  } else if (o === OUTCOMES.DRY_RUN) {
    lines.push('model-picker --dry-run: this is what would be offered, no intent raised.');
    lines.push('  Options (these exact strings are the buttons, and the answer):');
    for (const id of outcome.options) lines.push(`    ${id}`);
    lines.push('  Prompt:');
    for (const line of outcome.prompt.split('\n')) lines.push(`    ${line}`);
    if (!outcome.excluded.length) lines.push('  Nothing excluded: every entry is UP.');
  } else if (o === OUTCOMES.DAEMON_UNREACHABLE) {
    lines.push(`model-picker: ${outcome.error}`);
    lines.push('  Start the intent daemon (bin/iak-mcp-daemon.mjs) and run this again.');
    lines.push(`  Previous selection left as it was: ${outcome.previous?.selectedId ?? 'none'}`);
  } else if (o === OUTCOMES.TIMEOUT) {
    lines.push(`model-picker: intent ${outcome.intentId} went ${outcome.timeoutSec}s with no answer.`);
    lines.push(`  Nobody chose, so nothing was written. Previous selection left as it was: ${outcome.previous?.selectedId ?? 'none'}`);
  } else if (o === OUTCOMES.CHANGED_SINCE_OFFER) {
    lines.push(`model-picker: NOT applying ${outcome.chosenId}.`);
    lines.push(`  ${outcome.error}`);
    lines.push(`  Previous selection left as it was: ${outcome.previous?.selectedId ?? 'none'}`);
    lines.push('  Run again to pick from a fresh probe.');
  } else if (o === OUTCOMES.APPLIED) {
    const s = outcome.selection;
    lines.push(`model-picker: selected ${s.selectedId}`);
    lines.push(`  was:  ${outcome.previous?.selectedId ?? 'nothing selected'}`);
    lines.push(`  now:  ${s.selectedId}  ${s.baseUrl}  model=${s.model}`);
    lines.push(`  keyFile: ${s.keyFile ?? 'none (this endpoint needs no key)'}`);
    lines.push(`  re-probed UP at ${outcome.recheckedAt} before writing`);
    lines.push(`  written to ${outcome.selectionPath}`);
  }
  return lines.join('\n') + '\n';
}

// --- CLI -------------------------------------------------------------------

function positiveNumber(raw, flag) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`model-picker: --${flag} must be a positive number, got ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return n;
}

export async function main(argv = process.argv.slice(2)) {
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
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`model-picker: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(
      'Usage: model-picker.mjs [--registry PATH] [--selection PATH] [--daemon URL]\n' +
      '                        [--timeout-sec N] [--probe-timeout MS] [--free-threshold GIB]\n' +
      '                        [--samples N] [--allow-lan] [--dry-run] [--json]\n' +
      'Exit 0 applied or dry-run, 2 usage/registry, 3 nothing UP, 4 no daemon,\n' +
      '5 no answer before the timeout, 6 the chosen box changed before it could be applied.\n');
    return 0;
  }

  const outcome = await pickModel({
    registryPath: opts.registry || join(ROOT, 'config', 'models.json'),
    selectionPath: opts.selection || DEFAULT_SELECTION_PATH,
    daemonBase: opts.daemon || DEFAULT_DAEMON_BASE,
    allowLan: opts['allow-lan'],
    dryRun: opts['dry-run'],
    timeoutSec: positiveNumber(opts['timeout-sec'], 'timeout-sec') ?? DEFAULT_CHOICE_TIMEOUT_SEC,
    probeOptions: {
      timeoutMs: positiveNumber(opts['probe-timeout'], 'probe-timeout') ?? DEFAULT_TIMEOUT_MS,
      freeMemThresholdGiB: positiveNumber(opts['free-threshold'], 'free-threshold') ?? DEFAULT_FREE_MEM_THRESHOLD_GIB,
      latencySamples: positiveNumber(opts.samples, 'samples') ?? DEFAULT_LATENCY_SAMPLES,
    },
    callerHost: await resolveCallerHost(),
    headers: gateAuthHeaders(resolveGateToken()),
  });

  const text = renderOutcome(outcome, { json: opts.json });
  const code = EXIT_CODES[outcome.outcome] ?? 1;
  (code === 0 ? process.stdout : process.stderr).write(text);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
