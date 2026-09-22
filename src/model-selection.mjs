// SPDX-License-Identifier: AGPL-3.0-only
//
// model-selection - the probe/offer/apply core of the model picker, shared by
// bin/model-picker.mjs (the CLI), bin/iak-mcp-daemon.mjs (applies a tap the
// instant the intent it raised is decided) and src/mcp-server.mjs
// (request_model_choice, for raising a choice without shelling out to the
// CLI). One implementation, because the daemon and the CLI must agree on
// EXACTLY what "apply" means or a tap can behave differently depending on
// which process happened to catch the decision.
//
// FIVE RULES SHAPE EVERY LINE BELOW. These were true when this code lived in
// bin/model-picker.mjs (PR #119) and do not change by moving file:
//
// 1. RE-PROBE AT APPLY TIME, NOT ONLY AT OFFER TIME. The gap between raising
//    the intent and the tap is human-sized: minutes, sometimes an hour. In
//    that window a box fills up, somebody starts a render, a server gets
//    restarted. A picker that writes whatever was UP when it asked is a
//    picker that writes a stale fact with a fresh timestamp on it. So the
//    chosen entry is probed AGAIN when the answer arrives (applyChoice, not
//    buildOffer), and an entry that is no longer UP is NOT applied: the
//    previous selection survives untouched.
//
// 2. THE LABEL IS THE ANSWER, SO THE LABEL IS THE ID. createIntent treats the
//    option list as an allow-list: `/choose <id> <label>` is refused unless
//    the label matches one it declared. The labels this module offers are
//    entry ids and nothing else - the human detail lives in the PROMPT.
//
// 3. A KEY IS A PATH, NEVER A VALUE. The selection file carries `keyFile` -
//    the PATH from the registry entry - and the token is never read, never
//    resolved and never written here.
//
// 4. EVERY REFUSAL SAYS WHICH REFUSAL IT IS, AND HAS ITS OWN OUTCOME. "No
//    registry file", "nothing is UP", "the chosen entry changed since it was
//    offered", "the write failed after the tap" are different faults with
//    different repairs and must not collapse into each other.
//
// 5. NOTHING THE OWNER READS MAY QUIETLY DEGRADE. A field we cannot fill is a
//    reason to refuse to offer that entry, not a word to fill it with.
//
// See bin/model-picker.mjs for the CLI (argument parsing, exit codes,
// human-readable rendering) built on top of this module.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';

import {
  probeModels, readRegistryFile, RegistryError,
} from '../packages/user-intent-kit/src/model-capacity.js';
// gateAuthHeadersFor, never gateAuthHeaders: the bearer goes out only to a
// host isTrustedGateHost() accepts. --daemon is an argument, arguments reach
// this program from scripts, room messages and PR text, and an arbitrary URL
// plus an unconditional Authorization header is a token-exfiltration path.
// That was fixed once already in PR #52; hand-rolling around the helper that
// exists to prevent it would re-open it. (Imported from mcp-server.mjs, which
// in turn imports probeAndOffer/applyChoice from this module for
// request_model_choice - the cycle is fine because both sides only touch the
// other's exports inside function bodies, never at module-evaluation time.)
import { gateAuthHeadersFor } from './mcp-server.mjs';

export { RegistryError };

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

// Both the daemon (applying a tap) and the MCP server (raising the choice
// via request_model_choice) need the SAME registry/selection paths, or a
// custom path configured for one silently means the other still reads the
// default - the offer would list what one file says is UP while the apply
// re-probes a different file entirely. One resolver, called from both
// bin/iak-mcp-daemon.mjs and src/mcp-server.mjs, is what makes "the same
// config key" durable against either side drifting on its own later.
export function resolveModelRegistryPath(config, rootDir) {
  return config?.mcp?.confirmations?.model_registry || join(rootDir, 'config', 'models.json');
}

export function resolveModelSelectionPath(config) {
  return config?.mcp?.confirmations?.model_selection_path || DEFAULT_SELECTION_PATH;
}

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
      `model-selection: ${name} is required and has no default. ` +
      'A default here would aim a live question (or a write) at whatever host happens to be at the default address.');
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

/**
 * Load the registry, probe every entry and build the offer in one call. This
 * is the "probe" half a caller needs to RAISE a choice (bin/model-picker.mjs
 * and request_model_choice both start here); the "apply" half lives in
 * applyChoice() below and only ever touches the ONE chosen entry.
 */
export async function probeAndOffer({
  registryPath,
  callerHost,
  allowLan = false,
  probeOptions = {},
  now = () => Date.now(),
  readRegistryImpl = readRegistryFile,
  probeImpl = probeModels,
} = {}) {
  required(callerHost, 'callerHost');
  const registry = await readRegistryImpl(registryPath, { allowLan });
  const results = await probeImpl(registry, { ...probeOptions, callerHost });
  const offer = buildOffer(results, { callerHost, now });
  return { registry, results, offer };
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
  kind,
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
      body: JSON.stringify({ prompt, options, session, kind, from_handle: fromHandle }),
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

// --- applying a chosen entry -------------------------------------------------

/**
 * THE POINT OF THIS MODULE. Re-probe the ONE chosen entry - never trust the
 * offer-time reading, which is now as old as the human took to tap - and
 * write the selection file only if it is still offerable. Used by:
 *   - pickModel() below, for the CLI's own raise-and-wait flow (`before` is
 *     the offer-time reading of this same probe run, so CHANGED_SINCE_OFFER
 *     can say what it was and what it is now);
 *   - bin/iak-mcp-daemon.mjs's kind-handler, fired by decideIntent() the
 *     moment a `kind: "model"` intent is decided from ANY channel (CodeWatch
 *     tap, GroupMind web tap, chat-reply poller). There is no offer-time
 *     reading in that path - the process applying the tap is not the one that
 *     raised the intent - so `offeredState`/`offeredReason` are omitted and
 *     the refusal message says "when offered" without naming a state.
 *
 * `registry` may be passed pre-loaded (pickModel already has one); otherwise
 * it is read from `registryPath`. An entryId no longer present in the
 * registry at all (removed, not merely down) is CHANGED_SINCE_OFFER too - the
 * repair is the same ("re-probe and ask again"), so it is not a seventh
 * outcome.
 */
export async function applyChoice({
  registry,
  registryPath,
  selectionPath = DEFAULT_SELECTION_PATH,
  entryId,
  callerHost,
  intentId = null,
  sole = false,
  offeredState = null,
  offeredReason = null,
  // The model name shown in the offer for this entry (from the same probe
  // reading that put it on a button), if known. Unlike offeredState, an
  // unexpected model at apply time does NOT refuse: the box answered, it is
  // UP, and refusing would leave the previous (possibly worse) selection in
  // place over a difference that is often benign (a server restart picked up
  // a newer weights file under the same port). It is instead recorded as
  // `modelChanged` on the outcome so nothing changes silently - see rule 5.
  offeredModel = null,
  probeOptions = {},
  now = () => Date.now(),
  readRegistryImpl = readRegistryFile,
  probeImpl = probeModels,
  readSelectionImpl = readSelection,
  writeSelectionImpl = writeSelection,
} = {}) {
  required(entryId, 'entryId');
  required(callerHost, 'callerHost');
  const reg = registry ?? await readRegistryImpl(registryPath, {});
  const previous = await readSelectionImpl(selectionPath);
  const entry = reg.find(e => e.id === entryId);
  if (!entry) {
    return {
      outcome: OUTCOMES.CHANGED_SINCE_OFFER,
      registryPath, previous, intentId, chosenId: entryId,
      offeredState, offeredReason,
      currentState: 'MISSING',
      currentReason: 'no longer in the registry',
      recheckedAt: new Date(now()).toISOString(),
      error: `${entryId} is no longer in the registry${registryPath ? ` at ${registryPath}` : ''} - previous selection left as it was`,
    };
  }
  // THE RE-PROBE. Everything above this line is bookkeeping; this line is why
  // the function exists.
  const [recheck] = await probeImpl([entry], { ...probeOptions, callerHost });
  const fresh = offerability(recheck);
  if (!fresh.offerable) {
    return {
      outcome: OUTCOMES.CHANGED_SINCE_OFFER,
      registryPath, previous, intentId, chosenId: entryId,
      offeredState, offeredReason,
      currentState: recheck.state,
      currentReason: fresh.why,
      recheckedAt: recheck.checkedAt,
      error: `${entryId} was ${offeredState ?? 'UP'} when offered and is ${recheck.state} now (${fresh.why}) - previous selection left as it was`,
    };
  }
  const selection = buildSelection(entry, recheck, { callerHost, now });
  // The box is UP and offerable - apply it regardless of which model it now
  // names. A refusal here would be OUTCOMES.CHANGED_SINCE_OFFER in spirit but
  // is not one: the entry did not go down, so the previous-selection-survives
  // repair ("run again to pick from a fresh probe") is the wrong one - the
  // fresh probe already ran, and the human's tap is still a real answer to
  // "which box". The difference is recorded, never hidden.
  const modelChanged = offeredModel && selection.model && offeredModel !== selection.model
    ? { offered: offeredModel, applied: selection.model }
    : null;
  try {
    await writeSelectionImpl(selectionPath, selection);
  } catch (err) {
    // The human already tapped. Telling them nothing, or telling them with a
    // stack trace, is the failure mode this branch exists to prevent.
    return {
      outcome: OUTCOMES.WRITE_FAILED,
      registryPath, selectionPath, previous, intentId, chosenId: entryId, selection,
      error: `could not write ${selectionPath}: ${err.message}`,
      ...(modelChanged ? { modelChanged } : {}),
    };
  }
  return {
    outcome: sole ? OUTCOMES.APPLIED_SOLE : OUTCOMES.APPLIED,
    registryPath, selectionPath, previous, selection,
    intentId, chosenId: entryId,
    recheckedAt: recheck.checkedAt,
    ...(modelChanged ? { modelChanged } : {}),
  };
}

// --- the flow ----------------------------------------------------------------

/**
 * Probe, offer, wait, RE-PROBE, apply. Every dependency is injectable so the
 * tests can move the fleet between the offer and the answer, which is the one
 * thing this module exists to survive.
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

  // Thin wrapper over applyChoice(): this flow already has `registry` loaded
  // and `results` from the offer-time probe, so it passes both through
  // instead of re-reading the registry and loses nothing that the standalone
  // (daemon) caller of applyChoice() does not have either.
  const apply = (entryId, { intentId = null, sole = false } = {}) => {
    const before = results.find(r => r.id === entryId);
    return applyChoice({
      registry, registryPath, selectionPath, entryId, callerHost, intentId, sole,
      offeredState: before?.state ?? null,
      offeredReason: before?.reason ?? null,
      offeredModel: before?.models?.[0] ?? null,
      probeOptions, now, probeImpl, readSelectionImpl, writeSelectionImpl,
    });
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
