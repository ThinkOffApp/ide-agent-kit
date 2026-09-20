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
// FIVE RULES SHAPE EVERY LINE BELOW.
//
// 1. RE-PROBE AT APPLY TIME, NOT ONLY AT OFFER TIME. This is the reason the
//    program exists in this shape. The gap between raising the intent and the
//    tap is human-sized: minutes, sometimes an hour. In that window a box
//    fills up, somebody starts an LTX render, a server gets restarted. A
//    picker that writes whatever was UP when it asked is a picker that writes
//    a stale fact with a fresh timestamp on it. So the chosen entry is probed
//    AGAIN when the answer arrives, and an entry that is no longer UP is NOT
//    applied: the previous selection survives untouched and the report says
//    what changed and when each reading was taken. The single-UP shortcut
//    below skips the QUESTION, never this probe.
//
// 2. THE LABEL IS THE ANSWER, SO THE LABEL IS THE ID. createIntent treats the
//    option list as an allow-list: `/choose <id> <label>` is refused unless
//    the label matches one it declared. That guarantee is only worth anything
//    if a returned label maps back to exactly one registry entry, so the
//    labels are entry ids and nothing else - no "glm53-asus (8 GiB free)",
//    which would round-trip as a string that matches no entry. The human
//    detail lives in the PROMPT, where it can be as long as it needs to be.
//    The answer is checked against THE OPTIONS WE OFFERED, not merely against
//    the registry: a daemon that returns a real id we never put on a button
//    is a bug or an attack, and either way it must not be applied.
//
// 3. A KEY IS A PATH, NEVER A VALUE. The selection file is read by the rest of
//    the fleet and gets copied around, quoted in rooms and pasted into
//    issues. It carries `keyFile` - the PATH from the registry entry - and the
//    token is never read, never resolved and never written here. The probe
//    module holds the same line for config/models.json, for the same reason.
//    The fleet GATE token obeys the same rule in the other direction: it goes
//    out only to a daemon on a host gateAuthHeadersFor() trusts, because
//    --daemon is an argument and an argument can come from anywhere.
//
// 4. EVERY REFUSAL SAYS WHICH REFUSAL IT IS, AND HAS ITS OWN EXIT CODE. "No
//    registry file", "the registry loaded and nothing in it is UP", "the
//    daemon is not answering", "the daemon answered and refused", "we asked
//    and nobody tapped" and "the write failed after the tap" are six
//    different faults with six different repairs. Folding any two of them
//    into one code moves the conflation this file exists to prevent down one
//    layer, into whatever script wraps it. In particular a fleet that is
//    entirely UNREACHABLE is a NETWORK fault and must never render, or exit,
//    the same way as a healthy fleet.
//
// 5. NOTHING THE OWNER READS MAY QUIETLY DEGRADE. The prompt is the only
//    thing in front of a person authorising a model switch, so there is no
//    "model unknown" and no "unknown" caller host: a field we cannot fill is
//    a reason to refuse to offer that entry, not a word to fill it with.
//    Measurements are different and say so out loud - "free unknown" is a
//    reading we could not take, and the entry says which.
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
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

import {
  probeModels, readRegistryFile, RegistryError, resolveCallerHost,
  DEFAULT_TIMEOUT_MS, DEFAULT_FREE_MEM_THRESHOLD_GIB, DEFAULT_LATENCY_SAMPLES,
} from '../packages/user-intent-kit/src/model-capacity.js';
// gateAuthHeadersFor, never gateAuthHeaders: the bearer goes out only to a
// host isTrustedGateHost() accepts. --daemon is an argument, arguments reach
// this program from scripts, room messages and PR text, and an arbitrary URL
// plus an unconditional Authorization header is a token-exfiltration path.
// That was fixed once already in PR #52; hand-rolling around the helper that
// exists to prevent it would re-open it.
import { gateAuthHeadersFor } from '../src/mcp-server.mjs';
import { isMainModule } from '../src/common/entrypoint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DAEMON_BASE = 'http://127.0.0.1:8788';
export const DEFAULT_SELECTION_PATH = join(homedir(), '.iak', 'model-selection.json');
export const DEFAULT_CHOICE_TIMEOUT_SEC = 600;
export const DEFAULT_POLL_MS = 1000;
// No single request to the daemon may outlive this. A socket that is accepted
// and then never answered - the ordinary shape after a laptop sleeps - leaves
// a fetch() without a signal pending forever, and a poll loop that never
// returns cannot enforce its own timeout.
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

// One outcome per exit path. Exported so the tests, the JSON output and any
// caller that wraps this all name the same fault the same way.
export const OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  APPLIED_SOLE: 'applied-sole-up',
  ALREADY_SELECTED: 'already-selected',
  DRY_RUN: 'dry-run',
  NO_REGISTRY: 'no-registry',
  NONE_UP: 'none-up',
  ONLY_ONE_UP: 'only-one-up',
  DAEMON_UNREACHABLE: 'daemon-unreachable',
  DAEMON_REFUSED: 'daemon-refused',
  TIMEOUT: 'timeout',
  CHANGED_SINCE_OFFER: 'changed-since-offer',
  NOT_OFFERED: 'not-offered',
  WRITE_FAILED: 'write-failed',
});

export const EXIT_CODES = Object.freeze({
  [OUTCOMES.APPLIED]: 0,
  [OUTCOMES.APPLIED_SOLE]: 0,
  [OUTCOMES.ALREADY_SELECTED]: 0,
  [OUTCOMES.DRY_RUN]: 0,
  [OUTCOMES.NO_REGISTRY]: 2,
  [OUTCOMES.NONE_UP]: 3,
  [OUTCOMES.DAEMON_UNREACHABLE]: 4,
  [OUTCOMES.TIMEOUT]: 5,
  [OUTCOMES.CHANGED_SINCE_OFFER]: 6,
  [OUTCOMES.NOT_OFFERED]: 7,
  [OUTCOMES.WRITE_FAILED]: 8,
  [OUTCOMES.DAEMON_REFUSED]: 9,
  [OUTCOMES.ONLY_ONE_UP]: 10,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new TypeError(
      `model-picker: ${name} is required and has no default. ` +
      'A default here would aim a live question at whatever host happens to be at the default address.');
  }
  return value;
}

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
 * Can this result become a button? UP is necessary and not sufficient.
 *
 * A key that was CONFIGURED and could not be read is the case that made this
 * a function rather than a comparison. vLLM and llama.cpp serve /v1/models
 * without auth by default, so a box whose keyFile is missing answers the
 * probe perfectly, reports UP, and then 401s the first real request. The
 * probe knows (`keyBlocked`); offering it anyway means the reading was taken
 * and thrown away.
 *
 * An UP entry that named no model is the other case: we would have to write a
 * `model` field we do not know, and a prompt line we cannot fill honestly.
 */
export function offerability(result) {
  if (result.state !== 'UP') return { offerable: false, why: `${result.state}: ${result.reason || 'no reason given'}` };
  if (result.keyBlocked) {
    return {
      offerable: false,
      why: `UP but its credential is unusable: ${result.keyWarning || 'key configured and unreadable'}. ` +
        'The endpoint answers without auth, so it looks healthy and would refuse the first real request.',
    };
  }
  if (!result.models?.[0]) {
    return { offerable: false, why: 'UP but named no model, so there is nothing to select' };
  }
  return { offerable: true, why: null };
}

/**
 * The human line for one offerable entry. Everything a person needs in order
 * to choose goes here, because none of it can go in the label: the label has
 * to round-trip as an id. A warning that does NOT disqualify the entry (a key
 * file readable beyond its owner, a capacity we could not read) belongs here
 * too - showing warnings only for the entries nobody can pick is backwards.
 */
export function describeOffer(result) {
  const extra = result.models.length > 1 ? ` (+${result.models.length - 1} more)` : '';
  const warning = result.keyWarning ? `, WARNING ${result.keyWarning}` : '';
  const unknownCapacity = result.capacityUnknown ? ', capacity unknown' : '';
  return `${result.id} - ${result.models[0]}${extra}, ${gib(result.freeMemGiB)}, ` +
    `${latency(result)}, ${result.path}${unknownCapacity}${warning}`;
}

/** The line for an entry we are NOT offering, and why. Never silence. */
export function describeExclusion(result) {
  return `${result.id} ${offerability(result).why}`;
}

/**
 * Split a probe run into what can be offered and what cannot, and build the
 * prompt. The excluded entries are named IN THE PROMPT, not only in a log: a
 * picker that shows two buttons out of four, with no word about the other
 * two, teaches its user that the fleet is smaller than it is.
 *
 * callerHost is required. It names the host whose network these readings
 * describe, and a prompt that says "which model should unknown use?" is a
 * question nobody can answer correctly.
 */
export function buildOffer(results, { callerHost, now = () => Date.now() } = {}) {
  required(callerHost, 'callerHost');
  const up = results.filter(r => offerability(r).offerable);
  const excluded = results.filter(r => !offerability(r).offerable);
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
  required(callerHost, 'callerHost');
  return {
    selectedId: entry.id,
    baseUrl: baseUrlFor(entry),
    model: result.models[0],
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
 * /intents until the row says decided.
 *
 * EVERY request carries an AbortSignal. Without one, a daemon that accepts
 * the connection and never answers - a half-open socket after a sleep, a
 * wedged handler - leaves the fetch pending forever, the loop never
 * re-evaluates its deadline, and --timeout-sec becomes decorative. The
 * per-request budget is also clamped to the time left, so the last poll
 * cannot overshoot the deadline it is there to enforce.
 *
 * Returns {status: 'decided'|'timeout'|'unreachable'|'refused'}. "The daemon
 * is not there" and "the daemon is there and said no" are different answers
 * with different repairs and never collapse into each other.
 */
export async function raiseChoice({
  daemonBase,
  prompt,
  options,
  session = 'model-picker',
  fromHandle,
  timeoutSec = DEFAULT_CHOICE_TIMEOUT_SEC,
  pollMs = DEFAULT_POLL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
  headers,
} = {}) {
  required(daemonBase, 'daemonBase');
  const auth = headers ?? gateAuthHeadersFor(daemonBase);
  const deadline = now() + timeoutSec * 1000;
  const budget = () => Math.max(1, Math.min(requestTimeoutMs, deadline - now()));
  let created;
  try {
    const res = await fetchImpl(`${daemonBase}/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ prompt, options, session, from_handle: fromHandle }),
      signal: AbortSignal.timeout(budget()),
    });
    created = await res.json();
  } catch (err) {
    return { status: 'unreachable', error: `${daemonBase} did not answer POST /intent (${err.message})` };
  }
  if (!created?.ok || !created.id) {
    return { status: 'refused', error: `the daemon answered and refused the intent: ${created?.error || 'no id returned'}` };
  }
  const id = created.id;
  while (now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    try {
      const res = await fetchImpl(`${daemonBase}/intents`, { headers: auth, signal: AbortSignal.timeout(budget()) });
      const list = await res.json();
      const found = Array.isArray(list) ? list.find(i => i.id === id) : null;
      if (found && found.status === 'decided') {
        return { status: 'decided', id, decision: found.decision };
      }
    } catch { /* a dropped or timed-out poll is not a decision; keep asking until the deadline */ }
  }
  return { status: 'timeout', id };
}

/** Is the daemon there at all? Same 500 ms probe the MCP server uses. */
export async function daemonIsUp({ daemonBase, fetchImpl = fetch, headers } = {}) {
  required(daemonBase, 'daemonBase');
  try {
    const res = await fetchImpl(`${daemonBase}/intents`, {
      method: 'GET',
      headers: headers ?? gateAuthHeadersFor(daemonBase),
      signal: AbortSignal.timeout(500),
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
 *
 * daemonBase and callerHost are REQUIRED and deliberately have no defaults. A
 * default daemon address means a caller that forgets one - or a code path
 * that falls through a branch it should not have - raises a real intent on
 * the owner's phone. That happened to a reviewer running this suite against a
 * modified copy: a test escaped into the production daemon and queued a live
 * question next to four genuine ones. A suite whose safety depends on the
 * code under test being correct is inverted; the default is what made that
 * possible, so the default is gone.
 */
export async function pickModel({
  registryPath,
  selectionPath = DEFAULT_SELECTION_PATH,
  daemonBase,
  callerHost,
  allowLan = false,
  dryRun = false,
  requireChoice = false,
  timeoutSec = DEFAULT_CHOICE_TIMEOUT_SEC,
  pollMs = DEFAULT_POLL_MS,
  probeOptions = {},
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
  required(daemonBase, 'daemonBase');
  required(callerHost, 'callerHost');

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
      states: results.map(r => ({ id: r.id, state: r.state, reason: r.reason, keyBlocked: Boolean(r.keyBlocked) })),
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

  const apply = async (entryId, { intentId = null, sole = false } = {}) => {
    const entry = registry.find(e => e.id === entryId);
    const before = results.find(r => r.id === entryId);
    // THE POINT OF THIS PROGRAM. The offer reading is now as old as the human
    // took to tap. Take a fresh one for the chosen entry before writing
    // anything. The single-UP path comes through here too: skipping the
    // question never means skipping the second reading.
    const [recheck] = await probeImpl([entry], { ...probeOptions, callerHost });
    const fresh = offerability(recheck);
    if (!fresh.offerable) {
      return {
        outcome: OUTCOMES.CHANGED_SINCE_OFFER,
        registryPath, previous, intentId, chosenId: entryId,
        offeredState: before?.state ?? null,
        offeredReason: before?.reason ?? null,
        currentState: recheck.state,
        currentReason: fresh.why,
        recheckedAt: recheck.checkedAt,
        error: `${entryId} was ${before?.state ?? 'UP'} when offered and is ${recheck.state} now (${fresh.why}) - previous selection left as it was`,
      };
    }
    const selection = buildSelection(entry, recheck, { callerHost, now });
    try {
      await writeSelectionImpl(selectionPath, selection);
    } catch (err) {
      // The human already tapped. Telling them nothing, or telling them with
      // a stack trace, is the failure mode this branch exists to prevent.
      return {
        outcome: OUTCOMES.WRITE_FAILED,
        registryPath, selectionPath, previous, intentId, chosenId: entryId, selection,
        error: `could not write ${selectionPath}: ${err.message}`,
      };
    }
    return {
      outcome: sole ? OUTCOMES.APPLIED_SOLE : OUTCOMES.APPLIED,
      registryPath, selectionPath, previous, selection,
      intentId, chosenId: entryId,
      recheckedAt: recheck.checkedAt,
    };
  };

  // Exactly one UP entry: there is nothing to pick BETWEEN, so asking is
  // theatre. Apply it (after the re-probe) when it is not already the
  // selection, because the alternative is leaving a selection that points at
  // a box we just measured as not UP.
  if (offer.options.length === 1) {
    const soleId = offer.options[0];
    if (requireChoice) {
      return {
        outcome: OUTCOMES.ONLY_ONE_UP,
        registryPath, previous, options: offer.options,
        offered: offer.offered.map(describeOffer),
        excluded: offer.excluded.map(describeExclusion),
      };
    }
    if (previous?.selectedId === soleId) {
      return {
        outcome: OUTCOMES.ALREADY_SELECTED,
        registryPath, previous, selectionPath, chosenId: soleId,
        offered: offer.offered.map(describeOffer),
        excluded: offer.excluded.map(describeExclusion),
      };
    }
    return { ...(await apply(soleId, { sole: true })), soleReason: offer.offered.map(describeOffer)[0] };
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

  if (answer.status === 'unreachable') {
    return {
      outcome: OUTCOMES.DAEMON_UNREACHABLE,
      registryPath, previous, daemonBase, options: offer.options, error: answer.error,
    };
  }
  if (answer.status === 'refused') {
    // The daemon is UP. Sending the operator to restart a healthy daemon is
    // the wrong repair, so this is its own outcome and its own exit code.
    return {
      outcome: OUTCOMES.DAEMON_REFUSED,
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

  // Against THE OPTIONS WE OFFERED, not against the registry. A registry
  // lookup accepts any id that exists, which lets a buggy or hostile daemon
  // hand back a box that was DOWN when we probed and never appeared on a
  // button. The allow-list is the security property; checking the weaker
  // thing while the comment claims the stronger one is how that gets lost.
  if (!offer.options.includes(answer.decision)) {
    return {
      outcome: OUTCOMES.NOT_OFFERED,
      registryPath, previous, intentId: answer.id, chosenId: answer.decision,
      options: offer.options,
      error: `"${answer.decision}" was not one of the options offered (${offer.options.join(', ')}) - not applying`,
    };
  }

  return apply(answer.decision, { intentId: answer.id });
}

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
