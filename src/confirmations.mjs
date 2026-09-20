// SPDX-License-Identifier: AGPL-3.0-only
//
// Confirmation registry for MCP-driven approval flows.
//
// An MCP client (e.g. an agent that wants user sign-off before destructive
// work) calls request_confirmation. The registry:
//   1. Generates a unique intent id.
//   2. Posts a confirmation prompt to the configured channels — currently
//      GroupMind (the rooms chat) with `/approve <id>` / `/deny <id>` quick
//      replies, and Codewatch via the CLAWWATCH_GATE Intent receiver
//      (CodexMB's PR #8 work) when configured.
//   3. Listens on an HTTP endpoint for the decision (POST /intent/:id/decision
//      with `{decision: "approve"|"deny"}`). Codewatch's notification action
//      buttons + a future GroupMind quick-reply poller both POST here.
//   4. Resolves the in-memory promise so the MCP tool returns synchronously.
//
// All state is in-memory (intents are short-lived, typically minutes). For
// audit, every transition is appended to receipts.

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { deliverToSession, listSessionAgents, HOP_HEADER } from './session-send.mjs';

// --- registry ---------------------------------------------------------------

// id -> {prompt, session, channels, status, createdAt, decidedAt, decision, resolvers}
const intents = new Map();

// ---------------------------------------------------------------------------
// DURABLE STATE
//
// `intents` used to live only in this process. A restart threw the queue away
// with no warning and nothing read it back, so every pending approval card
// silently became undecidable. That bit three times on 2026-09-19: restarts
// while wiring /lead wiped the queue, including an intent that was mid-review.
//
// Append-only JSONL replayed at boot. Append-only because a rewrite-in-place
// can truncate on a crash and take the whole queue with it -- that is the
// failure being removed, not relocated.
//
// Deliberately NOT persisted: `resolvers`. Those are live promise callbacks
// belonging to callers of waitForDecision that died with the old process; a
// replayed intent gets an empty list and a new caller can wait on it again.
// ---------------------------------------------------------------------------
let statePath = null;

function appendState(entry) {
  if (!statePath) return;
  try {
    appendFileSync(statePath, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Never let a persistence failure break the decision path: losing the
    // record is bad, refusing the approval is worse.
    process.stderr.write(`[confirmations] state append failed: ${e.message}\n`);
  }
}

/** Replay the log into memory. Last write wins per id. Returns a summary so a
 * caller can log what came back rather than assume it worked. */
export function loadPersistedState(path) {
  statePath = path || null;
  const summary = { intents: 0, skipped: 0 };
  if (!statePath || !existsSync(statePath)) return summary;
  let lines;
  try {
    lines = readFileSync(statePath, 'utf8').split('\n');
  } catch (e) {
    process.stderr.write(`[confirmations] state read failed: ${e.message}\n`);
    return summary;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    // A truncated final line is expected after a hard kill mid-append. Skip it
    // and keep the rest rather than discarding the whole queue.
    try { e = JSON.parse(line); } catch { summary.skipped += 1; continue; }
    if (e.kind === 'intent' && e.id && e.intent) {
      intents.set(e.id, { ...e.intent, resolvers: [] });
    }
    // NOTE: `kind: 'lead'` entries are written by the team-lead branch and are
    // ignored here on purpose. Main has no lead feature yet, so replaying one
    // would have nowhere to put it. Forward-compatible: an older log written
    // by that branch replays its intents cleanly and skips the lead rows.
  }
  summary.intents = intents.size;
  return summary;
}

/** Write an intent's current state. Called on create and on decide. */
function persistIntent(id, i) {
  if (!id || !i) return;
  // The id is the Map KEY, not a field on the intent, so it has to be written
  // explicitly. Without this the log looks perfectly healthy and replays
  // nothing -- found by the restart test, which is why it exists.
  const { resolvers, ...rest } = i;
  appendState({ kind: 'intent', id, intent: rest, at: Date.now() });
}
// nonce -> typed action request. Actions reuse the intent approval UI but run
// through a strict registry instead of arbitrary shell.
const actions = new Map();

const ACTION_REPOS = new Set([
  'ThinkOffApp/antfarm',
  'ThinkOffApp/xfor',
  'ThinkOffApp/codewatch-site',
  'ThinkOffApp/CodeWatch',
]);

const TERMINAL_ACTION_STATUSES = new Set(['merged', 'failed', 'denied', 'expired']);

function postReceipt(receiptsPath, entry) {
  if (!receiptsPath) return;
  try {
    appendFileSync(receiptsPath, JSON.stringify(entry) + '\n');
  } catch {
    // never crash the bridge on a receipt write
  }
}

// --- durable action-status mirror (antfarm PR #43) --------------------------
// Mirrors every intent/action transition to the central GroupMind action_status
// store (POST /api/v1/actions) so CodeWatch renders durable button state when
// the phone is off the LAN and can't reach this daemon's localhost /intents.
// Fire-and-forget: a push must never throw, block, or fail a decision.
let _actionStatusPush = null;
// Action vocab -> action_status lifecycle vocab. The DB enforces a monotonic
// rank (pending<processing<approved<denied<terminal), so we never push a state
// that would move a row backwards.
const ACTION_STATUS_MAP = { merged: 'completed', running: 'processing' };

export function configureActionStatusPush({ apiKey, baseUrl = 'https://groupmind.one/api/v1', log = () => {} }) {
  if (!apiKey) return false;
  const url = String(baseUrl).replace(/\/$/, '') + '/actions';
  _actionStatusPush = (intentId, status, fields = {}) => {
    if (!intentId || !status) return;
    const clean = {};
    for (const [k, v] of Object.entries(fields)) if (v != null) clean[k] = v;
    const body = JSON.stringify({ intent_id: intentId, status, ...clean });
    fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body,
    })
      .then((r) => { if (!r.ok) log(`[action-status] ${intentId}->${status} HTTP ${r.status}`); })
      .catch((e) => log(`[action-status] ${intentId}->${status} failed: ${e.message}`));
  };
  log(`[action-status] push enabled -> ${url}`);
  return true;
}

function pushStatus(intentId, rawStatus, fields = {}) {
  if (!_actionStatusPush) return;
  try {
    _actionStatusPush(intentId, ACTION_STATUS_MAP[rawStatus] || rawStatus, fields);
  } catch {
    // never let a status mirror disturb the gating path
  }
}

// --- announcement receipts --------------------------------------------------
//
// An intent used to record that it was CREATED and that it was DECIDED, and
// nothing at all about whether the card that ASKS the human ever reached
// anywhere. That left a pending intent with two readings that call for
// opposite reactions - the owner saw the card and has not answered yet, or the
// card never posted - and no way to tell them apart. Measured on a live daemon
// on 2026-09-20: four intents pending for up to 9.2 hours with
// `channels: ['groupmind']`, unanswerable from the record.
//
// WHAT A RECORD PROVES, EXACTLY. `postedAt` is the moment a channel's
// transport ACCEPTED the message (a 2xx from the room API), and `messageId` is
// the id that transport handed back. Neither one is evidence that the message
// rendered, that a notification fired, or that a human read it. There is
// deliberately no `deliveredAt` and no `seenAt` here: nothing in this process
// can observe either, and naming a field for something it does not measure is
// the exact overclaim this code exists to correct. A real read-receipt, if one
// ever exists, arrives from the phone as its own event and gets its own field.
//
// SHAPE. `intent.announcements` is a MAP keyed by channel name, so adding a
// channel adds a key and no consumer changes. Each entry:
//   {channel, status, attemptedAt, postedAt, messageId, error}
//
// STATES (`announceStateOf`), summarised across channels:
//   'unknown'    - the intent predates announcement receipts. It is NOT a
//                  claim that the card posted, and NOT a claim that it failed.
//   'none'       - no channels were asked for, so no card was ever meant to go.
//   'skipped'    - a channel was asked for but nothing was configured to post
//                  it. The card definitively did not go out.
//   'attempting' - a post was started and never settled (e.g. the process died
//                  mid-flight). Nothing proves it landed.
//   'unreported' - the announce hook returned without saying what happened.
//                  Absence of an error is not a success.
//   'posted'     - every attempted channel accepted the post. See above for
//                  what that does and does not prove.
//   'partial'    - some channels posted; the rest failed or are unknown.
//   'failed'     - it was attempted and nothing landed.
export const ANNOUNCE_STATES = [
  'unknown', 'none', 'skipped', 'attempting', 'unreported', 'posted', 'partial', 'failed',
];

/** Collapse an intent's per-channel announcement records into one readable
 * state. An intent with no `announcements` map at all is an OLD record: it
 * reads 'unknown', never 'posted' and never 'failed'. */
export function announceStateOf(intent) {
  const a = intent && intent.announcements;
  if (!a || typeof a !== 'object') return 'unknown';
  const statuses = Object.values(a).map((r) => (r && r.status) || 'unknown');
  if (statuses.length === 0) return 'none';
  const has = (s) => statuses.includes(s);
  if (statuses.every((v) => v === 'posted')) return 'posted';
  if (has('failed')) return has('posted') ? 'partial' : 'failed';
  // Any mix that includes a real post is 'partial'. Checked BEFORE the
  // unsettled states, because returning 'attempting' for posted+attempting
  // hides the channel that demonstrably landed - the summary word has to
  // cover every channel, not just the worst one.
  if (has('posted')) return 'partial';
  if (has('attempting')) return 'attempting';
  if (statuses.every((v) => v === 'skipped')) return 'skipped';
  return 'unreported';
}

// THE ONE HUMAN-READABLE SENTENCE. Every surface that shows a person what
// happened to the announcement renders this string: the HTML queue, the
// /intents payload, the MCP list_intents output. One function, so the wording
// cannot drift apart between them.
//
// The trap it exists to avoid: "posted to 1 of 2 channels" reads as though the
// second channel definitely did not arrive. When that second channel is
// 'unreported' or 'attempting', nobody knows whether it arrived, and the only
// true sentence says so. Longer is fine. Confident and wrong is not. The same
// rule the logic follows - an absence is not evidence in either direction -
// has to survive into the prose, or the three states were pointless.
//
// So: 'failed' and 'skipped' are countable as "did not go out" because both
// were OBSERVED. 'unreported' and 'attempting' are counted separately as
// unknown, and are never folded into either the posted side or the failed side.
export function announceSummaryLine(intent) {
  const state = announceStateOf(intent);
  if (state === 'unknown') return 'unknown: this intent predates announcement records';
  const a = (intent && intent.announcements) || {};
  const entries = Object.values(a);
  if (entries.length === 0) return 'no channels were asked';
  const count = (...want) => entries.filter((r) => want.includes((r && r.status) || '')).length;
  const posted = count('posted');
  const failed = count('failed');
  const unknown = count('unreported', 'attempting');
  const notSent = count('skipped');
  const parts = [];
  // The first clause carries the unit ("posted to 1 channel"); the rest are
  // bare counts ("unknown for 1"), so the sentence stays short enough for a
  // watch face without merging any two groups.
  const add = (label, n) => {
    if (!n) return;
    parts.push(parts.length === 0 ? `${label} ${n} ${n === 1 ? 'channel' : 'channels'}` : `${label} ${n}`);
  };
  add('posted to', posted);
  add('failed for', failed);
  // Never merged with either line above. This is the whole point.
  add('unknown for', unknown);
  add('not sent for', notSent);
  if (parts.length === 0) return 'no channels were asked';
  return parts.join(', ');
}

/** Public view of the announcement records: a copy, so a caller cannot edit
 * the registry through it. `null` for an old intent that has none. */
function announcementsView(i) {
  if (!i || !i.announcements) return null;
  const out = {};
  for (const [ch, r] of Object.entries(i.announcements)) out[ch] = { ...r };
  return out;
}

export function listIntents() {
  return [...intents.entries()].map(([id, i]) => ({
    id,
    prompt: i.prompt,
    session: i.session,
    channels: i.channels,
    status: i.status,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt,
    decision: i.decision,
    // Whether the asking card actually POSTED, per channel, plus the one-word
    // summary. This is what makes "pending because nobody answered yet"
    // distinguishable from "pending because nothing was ever sent".
    announceState: announceStateOf(i),
    // The sentence a person reads. Shipped in the payload rather than
    // re-worded by each client, so the phone, the HTML queue and the MCP
    // output cannot disagree about what is known.
    announceSummary: announceSummaryLine(i),
    announcements: announcementsView(i),
  }));
}

export function getIntent(id) {
  const i = intents.get(id);
  if (!i) return null;
  return {
    id,
    prompt: i.prompt,
    session: i.session,
    options: i.options || null,
    channels: i.channels,
    status: i.status,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt,
    decision: i.decision,
    announceState: announceStateOf(i),
    announceSummary: announceSummaryLine(i),
    announcements: announcementsView(i),
  };
}

// Decide an intent. Returns true if decided, false if id unknown or already
// decided. Idempotent for same decision; rejects different decision after
// settle.
export function decideIntent(id, rawDecision, { receiptsPath } = {}) {
  // Look the intent up BEFORE validating, because what counts as a legal
  // answer depends on the intent: a choice intent's legal answers are its own
  // declared options, and nothing else. Validating first against a fixed
  // approve/deny vocabulary is what made multi-option intents impossible.
  const i = intents.get(id);
  if (!i) return { ok: false, error: `unknown intent ${id}` };
  const options = Array.isArray(i.options) && i.options.length ? i.options : null;
  let decision = rawDecision;
  if (options) {
    // An option list is an allow-list, not a hint. `/choose <id> <anything>`
    // must never smuggle a value the requester did not offer, so match against
    // the declared options and store the DECLARED spelling - the requester
    // compares against the list it supplied, not against the phone's casing.
    const hit = options.find(
      (o) => String(o).toLowerCase() === String(rawDecision).trim().toLowerCase(),
    );
    if (!hit) {
      return { ok: false, error: `"${rawDecision}" is not an option for ${id}` };
    }
    decision = hit;
  } else if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, error: 'decision must be "approve" or "deny"' };
  }
  if (i.status !== 'pending') {
    if (i.decision === decision) return { ok: true, idempotent: true };
    return { ok: false, error: `intent ${id} already decided as ${i.decision}` };
  }
  i.status = 'decided';
  i.decision = decision;
  i.decidedAt = Date.now();
  persistIntent(id, i);
  postReceipt(receiptsPath, {
    kind: 'intent.decided', id, decision, decidedAt: i.decidedAt, prompt: i.prompt,
  });
  // Resolve waiters.
  for (const r of i.resolvers) {
    try { r({ decision, id }); } catch {}
  }
  i.resolvers = [];
  // A choice answers a QUESTION; it does not authorise a typed executor. The
  // branch below treats everything that is not 'deny' as an approval and runs
  // the bound action, so letting a choice reach it would make picking an
  // option execute whatever action happened to be attached. The requester
  // acts on the resolved value instead - it is the one that knows what the
  // options meant.
  const action = options ? null : [...actions.values()].find((a) => a.intentId === id);
  if (action) {
    if (decision === 'deny') {
      settleAction(action, {
        status: 'denied',
        actor: 'petrus',
        decided_at: new Date(i.decidedAt).toISOString(),
        ran_at: null,
        command: null,
        exit_code: null,
        output_summary: 'User denied the action.',
      }, { receiptsPath });
    } else {
      action.decided_at = new Date(i.decidedAt).toISOString();
      // An explicit human Approve overrides a soft TTL lapse. If the action
      // expired before the tap (e.g. petrus approved hours later), revive it
      // and execute anyway — the executor re-validates (gh pr view precheck),
      // so a stale-but-clean PR merges and a stale-conflicted one fails safely.
      // Without this, a late tap settles the intent but silently no-ops.
      if (action.status === 'expired') {
        action.status = 'pending';
        process.stderr.write(`[iak-mcp] action ${action.nonce}: approved after TTL lapse — executing on explicit approval\n`);
      }
      runApprovedAction(action, { receiptsPath }).catch((e) => {
        settleAction(action, {
          status: 'failed',
          actor: 'petrus',
          decided_at: action.decided_at,
          ran_at: new Date().toISOString(),
          command: action.command || null,
          exit_code: null,
          output_summary: e.message || String(e),
        }, { receiptsPath });
      });
    }
  } else {
    // Pure confirmation (no typed executor): the decision itself is terminal,
    // so mirror it directly. Typed actions instead mirror via runApprovedAction
    // (processing) and settleAction (completed/failed/denied/expired).
    // A settled choice is an affirmative outcome: the owner answered. The
    // status store enforces a monotonic rank, so a choice reports 'approved'
    // rather than inventing a state that could move a row backwards.
    pushStatus(id, (options || decision === 'approve') ? 'approved' : 'denied', {
      decision,
      approver: 'petrus',
      decided_at: new Date(i.decidedAt).toISOString(),
    });
  }
  return { ok: true };
}

// Create + announce a confirmation intent. Returns intent id immediately.
// `announce` is an injectable side-effect (groupmindPost / codewatchPush) for
// testability — production code passes the real posters.
export async function createIntent({
  prompt,
  session,
  options,     // optional string[]: turns this into a CHOICE intent whose legal
               // answers are exactly these labels, rendered as one button each
               // instead of Approve/Deny.
  channels = ['groupmind'],
  timeoutSec = 600,
  announce = async () => {},
  receiptsPath,
  fromHandle,  // optional originator handle (e.g. "@CodexMB") for per-agent
               // chat-author attribution; passed through to announcers.
}) {
  const id = randomUUID().slice(0, 8);
  // ROUTE-DEPENDENT CAP, verified on GroupMind origin/main 159b16b. This
  // announcer posts to the GENERIC /api/v1/messages route, which carries
  // `actions` inside caller metadata and does NOT cap it. The per-room route
  // is different: it reads a TOP-LEVEL `actions` and silently does
  // `.slice(0, 6)`, so anything announcing a choice through that route loses
  // option 7 onwards with no error - a picker that renders fewer buttons than
  // it accepts answers. No cap is imposed here because it would be wrong for
  // the route actually in use; if you move the announcer to the room route,
  // cap it there and keep declared options equal to rendered ones.
  const cleanOptions = Array.isArray(options)
    // One line each, no blanks, no duplicates: a label is posted verbatim as
    // `/choose <id> <label>`, so a newline would split the command.
    ? [...new Set(options.map((o) => String(o).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean))]
    : null;
  if (cleanOptions && cleanOptions.length < 2) {
    throw new Error('a choice intent needs at least two distinct options');
  }
  // `channels` is the list we will try. Normalise it once: everything below
  // reconciles the announcement records against exactly this list.
  const wantChannels = Array.isArray(channels) ? channels : [];
  const intent = {
    prompt,
    session,
    options: cleanOptions,
    channels,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decision: null,
    resolvers: [],
    timeoutSec,
    // Per-channel announcement records. Present-and-empty (this object) means
    // "recorded, nothing attempted yet"; ABSENT means an old intent from
    // before this existed, which reads as 'unknown'. The distinction is the
    // backward-compatibility rule, so do not drop this to save a few bytes.
    announcements: {},
  };
  intents.set(id, intent);
  persistIntent(id, intent);
  postReceipt(receiptsPath, {
    kind: 'intent.created', id, prompt, session, options: cleanOptions, channels, createdAt: intent.createdAt,
  });
  pushStatus(id, 'pending', { target_summary: prompt });
  // Record what happens to each channel's post. Handed DOWN to the announcer,
  // because the layer that knows a channel's result is the layer that must
  // report it: a fan-out that swallows a 401 and returns cleanly is how a
  // never-posted card came to look like a patiently pending one.
  const recordAnnouncement = (channel, patch = {}) => {
    if (!channel) return null;
    const prev = intent.announcements[channel] || {
      channel, status: 'attempting', attemptedAt: null, postedAt: null, messageId: null, error: null,
    };
    const next = { ...prev, ...patch, channel };
    intent.announcements[channel] = next;
    persistIntent(id, intent);
    if (next.status === 'posted') {
      // 'posted' = the channel ACCEPTED it. Not delivered, not seen.
      postReceipt(receiptsPath, {
        kind: 'intent.announced', id, channel, postedAt: next.postedAt, messageId: next.messageId,
      });
    } else if (next.status === 'failed') {
      postReceipt(receiptsPath, {
        kind: 'intent.announce_failed', id, channel, error: next.error,
      });
      // Loud on the way out as well as recorded on the intent. A failure that
      // only exists in a log file is the same bug one layer down.
      process.stderr.write(`[confirmations] intent ${id}: announce to ${channel} FAILED: ${next.error}\n`);
    } else if (next.status === 'unreported') {
      // Not a failure and not a success: nobody can say whether the card
      // landed. That is worth the same visibility, because it needs a human to
      // go and look.
      postReceipt(receiptsPath, {
        kind: 'intent.announce_unreported', id, channel, error: next.error || null,
      });
      process.stderr.write(`[confirmations] intent ${id}: announce to ${channel} UNREPORTED: ${next.error || 'announcer said nothing'}\n`);
    }
    return next;
  };

  // Side effects - never let an announce failure block the intent itself, and
  // never let one vanish either. The intent stays decidable; the outcome is
  // written onto it so a human or a monitor can find the ones nobody was asked
  // about.
  try {
    await announce({
      id, prompt, session, channels, fromHandle, options: cleanOptions, recordAnnouncement,
    });
  } catch (e) {
    // The hook threw as a whole (a composed announcer reports per channel and
    // does not reach here). This says the ANNOUNCE STEP broke. It does NOT say
    // what happened to any individual channel: the error may have come before
    // a channel was reached, or after its request was already accepted.
    //
    // So the unsettled channels read 'unreported' and carry the error, not
    // 'failed'. Recording a definite non-delivery we did not observe is the
    // same overclaim as recording a definite delivery we did not observe -
    // codexmb's second finding on #121, and the mirror image of the first.
    // The error is kept on the record, so the intent is still findable and
    // still does not read as a normal pending card.
    const msg = e.message || String(e);
    for (const ch of wantChannels) {
      const cur = intent.announcements[ch];
      if (!cur || cur.status === 'attempting') {
        recordAnnouncement(ch, {
          status: 'unreported',
          error: `announce step failed before this channel reported an outcome: ${msg}`,
          attemptedAt: (cur && cur.attemptedAt) || null,
        });
      }
    }
    postReceipt(receiptsPath, {
      kind: 'intent.announce_failed', id, error: msg,
    });
  }
  // A hook that returned without reporting a channel leaves no evidence either
  // way, so the channel reads 'unreported'. It must NOT read as posted: the
  // absence of an error is not a success.
  for (const ch of wantChannels) {
    const cur = intent.announcements[ch];
    if (!cur) {
      recordAnnouncement(ch, { status: 'unreported', error: 'announcer reported no outcome for this channel' });
    } else if (cur.status === 'attempting') {
      recordAnnouncement(ch, { status: 'unreported', error: 'announcer started a post and never reported the outcome' });
    }
  }
  return id;
}

// Wait for a decision on intent id. Resolves on decide or timeout.
export function waitForDecision(id, { timeoutMs }) {
  const i = intents.get(id);
  if (!i) return Promise.resolve({ status: 'unknown' });
  if (i.status === 'decided') {
    return Promise.resolve({ status: 'decided', decision: i.decision });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove this resolver from the list before resolving so a later
      // decideIntent doesn't try to resolve us twice.
      const idx = i.resolvers.indexOf(resolverWithCleanup);
      if (idx >= 0) i.resolvers.splice(idx, 1);
      resolve({ status: 'timeout' });
    }, timeoutMs);
    const resolverWithCleanup = (val) => {
      clearTimeout(timer);
      resolve({ status: 'decided', decision: val.decision });
    };
    i.resolvers.push(resolverWithCleanup);
  });
}

// --- typed action requests -------------------------------------------------

export async function createActionRequest({
  payload,
  announce = async () => {},
  receiptsPath,
}) {
  const normalized = validateActionPayload(payload);
  const nonce = normalized.nonce;
  if (actions.has(nonce)) {
    throw new Error(`action nonce already exists: ${nonce}`);
  }
  const prompt = actionPrompt(normalized);
  const intentId = await createIntent({
    prompt,
    session: normalized.type,
    channels: ['groupmind'],
    announce,
    receiptsPath,
    fromHandle: normalized.requested_by,
  });
  const action = {
    ...normalized,
    intentId,
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    ran_at: null,
    command: null,
    exit_code: null,
    output_summary: null,
  };
  actions.set(nonce, action);
  postReceipt(receiptsPath, {
    kind: 'action.created',
    nonce,
    intentId,
    type: action.type,
    target: action.target,
    requested_by: action.requested_by,
    created_at: action.created_at,
  });
  const expiresAtMs = Date.parse(action.expires_at);
  if (Number.isFinite(expiresAtMs)) {
    const timer = setTimeout(() => expireAction(nonce, { receiptsPath }), Math.max(0, expiresAtMs - Date.now()));
    if (typeof timer.unref === 'function') timer.unref();
  }
  return { ok: true, id: intentId, nonce, status: action.status };
}

export function getAction(nonce, { receiptsPath } = {}) {
  expireAction(nonce, { receiptsPath });
  const action = actions.get(nonce);
  if (!action) return null;
  return actionReceipt(action);
}

function validateActionPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('action payload must be an object');
  const type = payload.type;
  if (!['merge_pr', 'deploy_site', 'upload_play_internal', 'install_debug_apk'].includes(type)) {
    throw new Error(`unsupported action type: ${type}`);
  }
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('target must be an object');
  }
  const requestedBy = requireString(payload.requested_by, 'requested_by');
  const decisionRoom = requireString(payload.decision_room, 'decision_room');
  const receiptRoom = requireString(payload.receipt_room, 'receipt_room');
  const nonce = requireString(payload.nonce, 'nonce');
  const expiresAt = requireString(payload.expires_at, 'expires_at');
  const risk = requireString(payload.risk, 'risk');
  if (!['low', 'medium', 'high'].includes(risk)) throw new Error('risk must be low, medium, or high');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('expires_at must be a valid ISO timestamp');
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('expires_at is already expired');

  let cleanTarget;
  switch (type) {
    case 'merge_pr': {
      const repo = requireString(target.repo, 'target.repo');
      const base = requireString(target.base, 'target.base');
      const pr = Number(target.pr);
      if (!ACTION_REPOS.has(repo)) throw new Error(`repo not allowed: ${repo}`);
      if (base !== 'main') throw new Error('merge_pr base must be main');
      if (!Number.isInteger(pr) || pr <= 0) throw new Error('target.pr must be a positive integer');
      cleanTarget = { repo, pr, base };
      break;
    }
    case 'deploy_site': {
      const project = requireString(target.project, 'target.project');
      const ref = requireString(target.ref, 'target.ref');
      if (!['codewatch-web', 'groupmind'].includes(project)) throw new Error(`project not allowed: ${project}`);
      if (ref !== 'main') throw new Error('deploy_site ref must be main');
      cleanTarget = { project, ref };
      break;
    }
    case 'upload_play_internal': {
      const appId = requireString(target.app_id, 'target.app_id');
      const track = requireString(target.track, 'target.track');
      const versionCode = Number(target.version_code);
      if (appId !== '4975875542898959486') throw new Error('app_id not allowed');
      if (track !== 'internal') throw new Error('track must be internal');
      if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('version_code must be a positive integer');
      cleanTarget = { app_id: appId, track, version_code: versionCode };
      break;
    }
    case 'install_debug_apk': {
      const pkg = requireString(target.package, 'target.package');
      const device = requireString(target.device, 'target.device');
      const versionCode = Number(target.version_code);
      if (!/^com\.thinkoff\.[a-z0-9_.]+$/.test(pkg)) throw new Error('package must be a ThinkOff package');
      if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('version_code must be a positive integer');
      cleanTarget = { package: pkg, version_code: versionCode, device };
      break;
    }
    default:
      throw new Error(`unsupported action type: ${type}`);
  }

  return {
    type,
    target: cleanTarget,
    requested_by: requestedBy,
    decision_room: decisionRoom,
    receipt_room: receiptRoom,
    nonce,
    expires_at: expiresAt,
    risk,
  };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function actionPrompt(action) {
  switch (action.type) {
    case 'merge_pr':
      return `Merge ${action.target.repo}#${action.target.pr} into ${action.target.base}?`;
    case 'deploy_site':
      return `Deploy ${action.target.project} from ${action.target.ref}?`;
    case 'upload_play_internal':
      return `Upload CodeWatch build ${action.target.version_code} to Play Internal testing?`;
    case 'install_debug_apk':
      return `Install ${action.target.package} build ${action.target.version_code} on ${action.target.device}?`;
    default:
      return `Approve ${action.type}?`;
  }
}

function expireAction(nonce, { receiptsPath } = {}) {
  const action = actions.get(nonce);
  if (!action || TERMINAL_ACTION_STATUSES.has(action.status)) return;
  if (Date.parse(action.expires_at) > Date.now()) return;
  settleAction(action, {
    status: 'expired',
    actor: null,
    decided_at: null,
    ran_at: null,
    command: null,
    exit_code: null,
    output_summary: 'Approval expired before a decision.',
  }, { receiptsPath });
}

function settleAction(action, patch, { receiptsPath } = {}) {
  Object.assign(action, patch);
  postReceipt(receiptsPath, { kind: 'action.receipt', ...actionReceipt(action) });
  // Mirror the terminal/transition state to the durable store. ACTION_STATUS_MAP
  // translates merged->completed; denied/failed/expired/processing pass through.
  pushStatus(action.intentId, action.status, {
    actor: action.actor,
    decision: action.status === 'denied' ? 'deny' : undefined,
    receipt: action.output_summary,
    error: action.status === 'failed' ? action.output_summary : undefined,
    decided_at: action.decided_at,
    executed_at: action.ran_at,
  });
}

function actionReceipt(action) {
  return {
    nonce: action.nonce,
    id: action.intentId,
    type: action.type,
    target: action.target,
    status: action.status,
    command: action.command,
    exit_code: action.exit_code,
    output_summary: action.output_summary,
    actor: action.actor || null,
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    requested_by: action.requested_by,
    created_at: action.created_at,
    expires_at: action.expires_at,
  };
}

async function runApprovedAction(action, { receiptsPath } = {}) {
  if (action.status !== 'pending') return;
  action.status = 'running';
  action.actor = 'petrus';
  action.ran_at = new Date().toISOString();
  pushStatus(action.intentId, 'running', { actor: 'petrus', executed_at: action.ran_at });
  switch (action.type) {
    case 'merge_pr':
      await executeMergePr(action, { receiptsPath });
      break;
    default:
      settleAction(action, {
        status: 'failed',
        actor: 'petrus',
        decided_at: action.decided_at,
        ran_at: action.ran_at,
        command: null,
        exit_code: null,
        output_summary: `${action.type} executor is not implemented yet.`,
      }, { receiptsPath });
  }
}

async function executeMergePr(action, { receiptsPath } = {}) {
  const { repo, pr, base } = action.target;
  const viewCmd = [
    'gh', 'pr', 'view', String(pr),
    '--repo', repo,
    '--json', 'number,state,isDraft,baseRefName,mergeStateStatus,title,url',
  ];
  action.command = shellSummary(viewCmd);
  const view = await spawnCollect(viewCmd[0], viewCmd.slice(1));
  if (view.code !== 0) {
    settleAction(action, failure(action, view, 'PR validation failed'), { receiptsPath });
    return;
  }
  let info;
  try { info = JSON.parse(view.stdout); } catch {
    settleAction(action, failure(action, view, 'Could not parse gh pr view output'), { receiptsPath });
    return;
  }
  if (info.state !== 'OPEN') {
    settleAction(action, failure(action, view, `PR is not open: ${info.state}`), { receiptsPath });
    return;
  }
  if (info.isDraft) {
    settleAction(action, failure(action, view, 'PR is draft'), { receiptsPath });
    return;
  }
  if (info.baseRefName !== base) {
    settleAction(action, failure(action, view, `PR base is ${info.baseRefName}, expected ${base}`), { receiptsPath });
    return;
  }
  if (info.mergeStateStatus && ['BLOCKED', 'DIRTY'].includes(info.mergeStateStatus)) {
    settleAction(action, failure(action, view, `PR merge state is ${info.mergeStateStatus}`), { receiptsPath });
    return;
  }

  const mergeCmd = ['gh', 'pr', 'merge', String(pr), '--repo', repo, '--merge'];
  action.command = shellSummary(mergeCmd);
  const merged = await spawnCollect(mergeCmd[0], mergeCmd.slice(1));
  if (merged.code !== 0) {
    settleAction(action, failure(action, merged, 'gh pr merge failed'), { receiptsPath });
    return;
  }
  settleAction(action, {
    status: 'merged',
    actor: 'petrus',
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    command: action.command,
    exit_code: merged.code,
    output_summary: summarizeOutput(merged.stdout || merged.stderr || `${repo}#${pr} merged`),
  }, { receiptsPath });
}

function failure(action, result, prefix) {
  return {
    status: 'failed',
    actor: 'petrus',
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    command: action.command,
    exit_code: result.code,
    output_summary: `${prefix}: ${summarizeOutput(result.stderr || result.stdout)}`,
  };
}

function shellSummary(parts) {
  return parts.map((p) => /\s/.test(p) ? JSON.stringify(p) : p).join(' ');
}

function summarizeOutput(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function spawnCollect(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// --- HTTP listener ---------------------------------------------------------

// Tiny built-in HTTP server. POST /intent/:id/decision accepts the decision
// from any caller (Codewatch action, GroupMind reply poller, manual curl).
// Auth is a shared bearer token if configured; otherwise local-only by host bind.
export function startConfirmationsServer({
  port = 8788,
  host = '127.0.0.1',
  authToken = '',
  receiptsPath,
  announce, // optional: enables POST /intent to create new intents externally
  wakeScript, // optional: shell script path; enables POST /wake to nudge the local IDE
  sessions, // optional: {agents: {...}} enables POST /sessions/send + GET /sessions/agents
} = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Auth check (constant-time when token configured).
    if (authToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(got);
      const b = Buffer.from(authToken);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    const m = url.pathname.match(/^\/intent\/([^/]+)\/decision$/);
    if (req.method === 'POST' && m) {
      const id = m[1];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        const result = decideIntent(id, payload.decision, { receiptsPath });
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/intents') {
      // ?status=pending narrows the list. Without it the queue returns every
      // intent ever created, decided ones included, so the phone shows a list
      // that only grows - petrus re-taps items that settled hours ago because
      // they are still sitting there looking open. On 2026-08-30 one of those
      // re-taps was an echo of a migration fix that had already run; executing
      // it again would have killed a healthy rsync mid-copy.
      //
      // Unknown values return an error rather than silently listing everything:
      // a filter that quietly does nothing is how this went unnoticed.
      const want = url.searchParams.get('status');
      let out = listIntents();
      if (want !== null) {
        const allowed = new Set(['pending', 'decided']);
        if (!allowed.has(want)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: `unknown status '${want}' - use one of: ${[...allowed].join(', ')}`,
          }));
          return;
        }
        out = out.filter((i) => i.status === want);
      }
      // ?announce=<state> narrows by whether the ASKING CARD actually posted.
      // `?status=pending&announce=failed` is the query that answers the
      // question the record could not answer before: which of these are
      // waiting on a human, and which were never successfully asked. Same
      // rule as above - an unknown value is an error, because a filter that
      // quietly matches nothing is indistinguishable from a healthy queue.
      const wantAnnounce = url.searchParams.get('announce');
      if (wantAnnounce !== null) {
        if (!ANNOUNCE_STATES.includes(wantAnnounce)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: `unknown announce state '${wantAnnounce}' - use one of: ${ANNOUNCE_STATES.join(', ')}`,
          }));
          return;
        }
        out = out.filter((i) => i.announceState === wantAnnounce);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/actions/request') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        try {
          const result = await createActionRequest({
            payload,
            announce: announce || (async () => {}),
            receiptsPath,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    const actionMatch = url.pathname.match(/^\/actions\/([^/]+)$/);
    if (req.method === 'GET' && actionMatch) {
      const receipt = getAction(decodeURIComponent(actionMatch[1]), { receiptsPath });
      if (!receipt) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...receipt }));
      return;
    }
    // POST /intent — create a new pending intent. Body: {prompt, session, channels}.
    // Used by external callers (test scripts, MCP wrappers, etc.) to add intents
    // to the live registry without going through stdio MCP. Fires announcements
    // via whatever announcer was passed to startConfirmationsServer.
    if (req.method === 'POST' && url.pathname === '/intent') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        if (!payload.prompt || typeof payload.prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing prompt' }));
          return;
        }
        // A malformed option list is the CALLER's error, so answer 400 rather
        // than letting createIntent throw into the 500 branch below - a 500
        // reads as "the daemon is broken" and sends someone looking in the
        // wrong place for a typo in their own request.
        if (payload.options !== undefined && !Array.isArray(payload.options)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'options must be an array' }));
          return;
        }
        try {
          const id = await createIntent({
            prompt: payload.prompt,
            options: payload.options,
            session: payload.session || 'external',
            channels: Array.isArray(payload.channels) ? payload.channels : (announce ? ['groupmind'] : []),
            announce: announce || (async () => {}),
            receiptsPath,
            // Forwarding daemons (claudemm mini, Codex mini) include
            // `from_handle` so the GroupMind announcer authors the chat
            // post as the originating agent rather than the daemon owner.
            fromHandle: typeof payload.from_handle === 'string' ? payload.from_handle : undefined,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (e) {
          // createIntent rejects an option list that cannot be a choice
          // (fewer than two distinct labels). That is the caller's input, not
          // a daemon fault.
          const msg = e.message || String(e);
          res.writeHead(/at least two/.test(msg) ? 400 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
      return;
    }
    // Tiny mobile-first HTML UI: pending intents with Approve / Deny buttons.
    // Auto-refresh every 2s. Same origin, no auth (caller is the local LAN
    // unless authToken is set on the server, in which case the page is
    // unreachable without it). Renders fine on Wear OS browser + phone + Mac.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/intents.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderIntentsHtml());
      return;
    }
    // POST /wake — nudge the local IDE / desktop app. Body: {text?}.
    // Runs the configured wakeScript with the text as the only arg
    // (defaults to "check rooms"). Used by other agents to keep this
    // agent responsive without going through the room-poll roundtrip.
    if (req.method === 'POST' && url.pathname === '/wake') {
      if (!wakeScript) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'wake disabled — no wakeScript configured' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text = 'check rooms';
        try {
          const payload = JSON.parse(body || '{}');
          if (typeof payload.text === 'string' && payload.text.trim().length > 0) text = payload.text.trim();
        } catch { /* allow empty body */ }
        try {
          // Spawn detached; don't block the response. Wake script handles its own logging.
          const child = spawn(wakeScript, [text], { detached: true, stdio: 'ignore' });
          child.unref();
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, text }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    // POST /sessions/send — deliver text into a named agent's live session
    // (the CodeWatch send-box primitive). Body: {agent, text, from?}.
    // 202 = accepted for delivery (GUI adapters may wait on the human-idle
    // guard before typing). See src/session-send.mjs for adapters/config.
    if (req.method === 'POST' && url.pathname === '/sessions/send') {
      if (!sessions || !sessions.agents) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'sessions not configured' }));
        return;
      }
      let body = '';
      let overflow = false;
      req.on('data', (c) => {
        body += c;
        // 64 KiB is far beyond any legal payload (text caps at 4000 chars);
        // stop buffering hostile bodies instead of holding them in memory.
        if (body.length > 64 * 1024 && !overflow) {
          overflow = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'body too large' }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (overflow) return;
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        const hops = Math.max(0, Math.min(8, parseInt(req.headers[HOP_HEADER] || '0', 10) || 0));
        const result = await deliverToSession(sessions, payload.agent, {
          text: payload.text,
          from: payload.from,
          hops,
          onAsyncError: (e) => postReceipt(receiptsPath, {
            kind: 'sessions.send.async_error',
            agent: payload.agent,
            error: e.message || String(e),
            at: new Date().toISOString(),
          }),
        });
        postReceipt(receiptsPath, {
          kind: 'sessions.send',
          agent: payload.agent,
          from: payload.from || null,
          ok: result.ok,
          delivered_via: result.deliveredVia || null,
          error: result.error || null,
          at: new Date().toISOString(),
        });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.ok
          ? { ok: true, agent: payload.agent, deliveredVia: result.deliveredVia }
          : { ok: false, error: result.error }));
      });
      return;
    }
    // GET /sessions/agents — send-box target picker.
    if (req.method === 'GET' && url.pathname === '/sessions/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: listSessionAgents(sessions) }));
      return;
    }
    // POST /ide-chat/<handle>  body { role, text, ts, session_id, tool_calls? }
    // GET  /ide-chat/<handle>?since=<iso>  → { events: [...] }
    //
    // Per-handle in-memory ring buffer. Backs the IDE-chat-in-CodeWatch
    // feature — `bin/iak-claude-tail.mjs` tails ~/.claude/projects/*.jsonl
    // and POSTs each user/assistant message here; CodeWatch polls GET to
    // render the conversation as an IDE channel.
    const ideChatMatch = url.pathname.match(/^\/ide-chat\/([^/]+)$/);
    if (ideChatMatch) {
      const handle = decodeURIComponent(ideChatMatch[1]);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let payload;
          try { payload = JSON.parse(body); } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
          const event = appendIdeChatEvent(handle, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ts: event.ts }));
        });
        return;
      }
      if (req.method === 'GET') {
        const since = url.searchParams.get('since');
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        const events = listIdeChatEvents(handle, since, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events }));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(port, host);
  return server;
}

// In-memory IDE-chat ring buffer per handle. Bounded to keep memory flat
// even on long-running daemons. Persisted nowhere — restart drops history,
// CodeWatch will repopulate on next tail run.
const IDE_CHAT_MAX_PER_HANDLE = 500;
const ideChat = new Map(); // handle → array of events (oldest first)

export function appendIdeChatEvent(handle, raw) {
  const event = {
    role: raw.role || 'unknown',
    text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
    ts: raw.ts || new Date().toISOString(),
    session_id: raw.session_id || null,
    tool_calls: Array.isArray(raw.tool_calls) ? raw.tool_calls : undefined,
  };
  let buf = ideChat.get(handle);
  if (!buf) { buf = []; ideChat.set(handle, buf); }
  buf.push(event);
  if (buf.length > IDE_CHAT_MAX_PER_HANDLE) buf.splice(0, buf.length - IDE_CHAT_MAX_PER_HANDLE);
  return event;
}

export function listIdeChatEvents(handle, since, limit = 200) {
  const buf = ideChat.get(handle) || [];
  let filtered = buf;
  if (since) {
    filtered = buf.filter((e) => e.ts > since);
  }
  if (filtered.length > limit) filtered = filtered.slice(filtered.length - limit);
  return filtered;
}

// Tiny self-contained HTML UI for tap-to-approve. Inlined so the
// confirmations server has no external assets / templates to ship.
function renderIntentsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>IAK confirmations</title>
<style>
  :root { --bg:#0c0f17; --card:#141a26; --line:#2a3447; --text:#e9eef7; --muted:#8896ad; --accent:#22c55e; --warn:#f59e0b; --hot:#ef4444; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 12px; }
  h1 { font-size: 14px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .empty { color: var(--muted); padding: 18px 0; text-align: center; }
  .intent { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .prompt { font-weight: 600; margin-bottom: 4px; word-break: break-word; }
  .meta   { font-size: 11px; color: var(--muted); margin-bottom: 8px; font-variant-numeric: tabular-nums; word-break: break-word; }
  .row    { display: flex; gap: 6px; }
  .btn    { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--line); color: var(--text); background: #0f1627; font-weight: 700; text-align: center; user-select: none; cursor: pointer; }
  .btn.ok  { background: var(--accent); color: #06120a; border-color: var(--accent); }
  .btn.no  { background: var(--hot);    color: #fff;    border-color: var(--hot); }
  .decided { opacity: 0.55; }
  .decided .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .decided .pill.approve { background: var(--accent); color: #06120a; }
  .decided .pill.deny    { background: var(--hot); color: #fff; }
  .ann { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .ann.posted { background: rgba(34,197,94,0.15); color: var(--accent); }
  .ann.bad    { background: var(--hot); color: #fff; }
  .ann.iffy   { background: rgba(245,158,11,0.18); color: var(--warn); }
  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: rgba(20,26,38,0.95); border: 1px solid var(--line); padding: 6px 10px; border-radius: 6px; font-size: 11px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.on { opacity: 1; }
</style>
</head>
<body>
<h1>IAK confirmations</h1>
<div id="list"></div>
<div class="toast" id="toast"></div>
<script>
  const list = document.getElementById('list');
  const toast = document.getElementById('toast');
  let lastSig = '';
  function showToast(t) { toast.textContent = t; toast.classList.add('on'); setTimeout(() => toast.classList.remove('on'), 1800); }
  async function refresh() {
    let intents = [];
    try { intents = await (await fetch('/intents', { cache: 'no-store' })).json(); } catch { return; }
    intents.sort((a, b) => b.createdAt - a.createdAt);
    // The summary is part of the signature: within one state the wording can
    // still change (a second channel reporting, say), and a stale sentence is
    // exactly the kind of quiet overclaim this page is meant not to make.
    const sig = intents.map(i => i.id + i.status + (i.announceState || '') + (i.announceSummary || '')).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    list.innerHTML = '';
    if (intents.length === 0) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No intents yet. The next request_confirmation tool call will appear here.';
      list.appendChild(e);
      return;
    }
    for (const i of intents) {
      const el = document.createElement('div');
      el.className = 'intent' + (i.status === 'pending' ? '' : ' decided');
      const meta = [i.session ? 'session: ' + i.session : null, 'id: ' + i.id, 'channels: ' + (i.channels || []).join(', ')].filter(Boolean).join(' · ');
      // Announcement state, on the card itself. A pending intent that was
      // never successfully announced is not the same thing as one waiting on
      // a person, and the page used to render them identically.
      const ann = i.announceState || 'unknown';
      // Red only where the card is KNOWN not to have reached anyone (observed
      // failure, or nothing configured to send it). Everything unknown is
      // amber, including a partial: amber says "go and look", red would say
      // "it did not arrive", and that is a claim nobody here can make.
      const annClass = ann === 'posted' ? 'posted' : (ann === 'failed' || ann === 'skipped' ? 'bad' : 'iffy');
      // The sentence comes from the server (announceSummary) so this page
      // cannot word it more confidently than the record supports. It used to
      // build its own, which labelled EVERY non-posted state as a definite
      // non-delivery and so told the reader that an unknown channel had
      // certainly not arrived.
      // "posted" is the strongest word this page may use: the daemon knows
      // the channel accepted the message, and nothing beyond that about
      // whether it reached or was read by a person.
      const annText = 'announcement: ' + (i.announceSummary || 'unknown');
      el.innerHTML =
        '<div class="prompt"></div>' +
        '<div class="ann ' + annClass + '"></div>' +
        '<div class="meta"></div>' +
        (i.status === 'pending'
          ? '<div class="row"><div class="btn ok" data-d="approve">Approve</div><div class="btn no" data-d="deny">Deny</div></div>'
          : '<span class="pill ' + i.decision + '">' + i.decision + '</span>');
      el.querySelector('.prompt').textContent = i.prompt;
      el.querySelector('.ann').textContent = annText;
      el.querySelector('.meta').textContent = meta;
      for (const b of el.querySelectorAll('.btn')) {
        b.addEventListener('click', async () => {
          const decision = b.dataset.d;
          b.style.opacity = '0.5';
          try {
            const r = await fetch('/intent/' + i.id + '/decision', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision }),
            });
            const j = await r.json();
            showToast(j.ok ? decision + ' sent' : 'error: ' + (j.error || 'unknown'));
            lastSig = ''; refresh();
          } catch (e) {
            showToast('network error: ' + e.message);
            b.style.opacity = '1';
          }
        });
      }
      list.appendChild(el);
    }
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

// --- announcers ------------------------------------------------------------

// Post the intent prompt to a GroupMind room with quick-reply text the user
// can copy / type, and a curl example for the watch-gate. Idempotent (same
// id is harmless).
// The address other devices use to reach this daemon. An explicit
// `callback_base` always wins. Without one, a loopback-only listener can
// only be reached at its loopback address, and a listener bound to one
// concrete address is advertised at that address. A daemon bound to the
// wildcard (0.0.0.0 / ::) is meant to be reached from phones and tablets,
// and a 127.0.0.1 link in the room post goes nowhere from those, so we
// pick a LAN address on this host instead. Interface enumeration order is
// not a reachability order (docker0, VPN tunnels and VM bridges come
// first on many hosts), so the pick is a policy, not "the first one":
//   1. `callback_interface` in config, when set, and only that interface
//   2. skip interfaces whose name says virtual (docker, veth, br-, utun,
//      tun/tap, wg, tailscale, vbox/vmnet, lo)
//   3. prefer 192.168/16, then 10/8, then 172.16/12, then anything else
// The result is best-effort: it is the most plausible LAN address, not a
// proven-reachable one. Callers get the alternatives back via `onPick`
// so the choice can be logged at startup.
const VIRTUAL_IFACE = /^(docker|veth|br-|virbr|utun|tun|tap|wg|tailscale|ts|vboxnet|vmnet|vmenet|bridge|lo|awdl|llw)\d*/i;
function lanRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}
function formatHost(addr) {
  return addr.includes(':') ? `[${addr}]` : addr;
}
export function defaultCallbackBase(cc = {}, ifaces = networkInterfaces(), onPick = null) {
  if (cc.callback_base) return String(cc.callback_base).replace(/\/$/, '');
  const port = cc.port || 8788;
  const host = cc.host || '127.0.0.1';
  if (host === 'localhost') return `http://127.0.0.1:${port}`;
  if (host !== '0.0.0.0' && host !== '::') return `http://${formatHost(host)}:${port}`;
  const wanted = cc.callback_interface ? String(cc.callback_interface) : null;
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (wanted ? name !== wanted : VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs || []) {
      const v4 = a.family === 4 || a.family === 'IPv4';
      if (!v4 || a.internal || String(a.address).startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address, rank: lanRank(a.address) });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank);
  const pick = candidates[0] || null;
  if (onPick) onPick(pick, candidates);
  return pick ? `http://${pick.address}:${port}` : `http://127.0.0.1:${port}`;
}

export function makeGroupmindAnnouncer({ apiKey, room, callbackBase, apiKeys }) {
  // apiKeys: optional map of agent handle (e.g. "@claudemm") → API key.
  // When the intent payload includes `fromHandle`, the announcer uses
  // the matching key from this map so the chat post is authored by the
  // ORIGINATING agent rather than always by the daemon owner.
  // Falls back to the default `apiKey` when no match is found.
  return async ({ id, prompt, session, fromHandle, options }) => {
    // Not configured is not the same as posted. Say so, so the intent records
    // 'skipped' instead of a silent success.
    if (!apiKey || !room) return { skipped: true, reason: 'groupmind announcer has no api key or room configured' };
    // Per-agent key override.
    const effectiveKey = (fromHandle && apiKeys && apiKeys[fromHandle]) || apiKey;
    const uiLink = callbackBase ? `${callbackBase}/` : null;
    const opts = Array.isArray(options) && options.length ? options : null;
    // ALWAYS spell out the typed equivalent. The buttons need a client that
    // renders them, and a phone that cannot (or an older build) must still be
    // able to answer - otherwise a choice intent is unanswerable on exactly
    // the surface it was built for.
    const typed = opts
      ? opts.map((o) => `\`/choose ${id} ${o}\``).join(' · ')
      : `\`/approve ${id}\` · \`/deny ${id}\``;
    const body =
      `[${opts ? 'Choice needed' : 'Confirmation needed'}] **${prompt}**\n` +
      `Target session: \`${session || '(none)'}\`\n` +
      (uiLink ? `Tap to decide: ${uiLink}\n` : '') +
      `Or reply: ${typed}`;
    // Attach metadata so the GroupMind chat UI can render inline Approve/Deny
    // buttons. Frontend reads `metadata.actions` + `metadata.intent_id` and
    // POSTs `/approve <id>` (or `/deny <id>`) chat replies on tap, which the
    // chat-reply poller in iak-mcp-daemon catches and routes to the local
    // /intent/:id/decision endpoint. No new backend route needed.
    const metadata = {
      actions: opts || ['Approve', 'Deny'],
      intent_id: id,
      intent_prompt: prompt,
      intent_session: session || null,
    };
    const data = JSON.stringify({ room, body, metadata });
    const req = await import('node:https');
    return new Promise((resolve, reject) => {
      const r = req.request(
        'https://groupmind.one/api/v1/messages',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': effectiveKey } },
        (res) => {
          // This used to drain the body and resolve REGARDLESS of the status
          // code, so a 401 from a rotated key or a 402 from an unpaid invoice
          // announced nothing and reported success. A non-2xx is now a
          // failure, and the body is read because the message id lives in it.
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            const code = res.statusCode || 0;
            if (code < 200 || code >= 300) {
              reject(new Error(`groupmind POST /messages returned ${code}: ${raw.slice(0, 200)}`));
              return;
            }
            // The id of the message the ROOM ACCEPTED. It is not evidence that
            // anyone was notified, and it is certainly not evidence anyone
            // read it. Null when the response carries no id, which is honest:
            // accepted, no handle given back.
            let messageId = null;
            try {
              const j = JSON.parse(raw);
              const cand = (j && (j.id ?? (j.message && j.message.id) ?? (j.data && j.data.id))) ?? null;
              messageId = cand == null ? null : String(cand);
            } catch { /* a 2xx with an unparseable body is still accepted */ }
            resolve({ channel: 'groupmind', statusCode: code, messageId });
          });
          res.on('error', reject);
        }
      );
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  };
}

// Post the intent to the CLAWWATCH_GATE proxy (CodexMB's PR #8). The proxy
// then renders an Android interactive notification with Approve / Deny
// buttons that POST back to this server's /intent/:id/decision.
export function makeCodewatchAnnouncer({ gateUrl, gateToken }) {
  return async ({ id, prompt, session }) => {
    if (!gateUrl) return { skipped: true, reason: 'codewatch announcer has no gate url configured' };
    const data = JSON.stringify({ id, prompt, session });
    const url = new URL(gateUrl);
    const lib = await import(url.protocol === 'https:' ? 'node:https' : 'node:http');
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (gateToken) headers.Authorization = `Bearer ${gateToken}`;
      const r = lib.request(gateUrl, { method: 'POST', headers }, (res) => {
        // Same rule as the room announcer: a non-2xx from the gate is a failed
        // announcement, not a quiet success. The gate accepting the push is
        // still only that - the notification may never render on the phone.
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code < 200 || code >= 300) {
            reject(new Error(`codewatch gate returned ${code}: ${raw.slice(0, 200)}`));
            return;
          }
          let messageId = null;
          try {
            const j = JSON.parse(raw);
            const cand = (j && (j.id ?? (j.notification && j.notification.id))) ?? null;
            messageId = cand == null ? null : String(cand);
          } catch { /* accepted, no id */ }
          resolve({ channel: 'codewatch', statusCode: code, messageId });
        });
        res.on('error', reject);
      });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  };
}

// Fan-out: build a single announce function from per-channel announcers.
//
// This is the layer that knows WHICH channel produced which result, so it is
// the layer that reports the outcome back onto the intent through
// `recordAnnouncement`. It still continues to the other channels after a
// failure - one dead channel must not mute the rest - but the failure is now
// recorded rather than only logged.
//
// An announcer signals its result explicitly. There is no default outcome,
// because inferring one from silence is the bug this file exists to fix:
//   throw                              -> 'failed', with the message
//   {skipped: true, reason}            -> 'skipped', nothing posted, nothing broke
//   {messageId} / 2xx {statusCode}     -> 'posted', with the id when there is one
//   {posted: true}                     -> 'posted', for a channel with no id
//   anything else, including undefined -> 'unreported'
//
// That last line is the correction codexmb asked for on #121. Returning
// nothing used to read as a successful post, so an announcer that resolved
// early, returned undefined, or was misconfigured in a way nobody had thought
// of announced nothing and recorded a success - the same "we tried, so it
// landed" inference, one level up in the composition layer.
export function composeAnnouncers(map) {
  return async (intent) => {
    const record = typeof intent.recordAnnouncement === 'function'
      ? intent.recordAnnouncement
      // Older callers (and tests) may invoke the fan-out directly with no
      // recorder. Degrade to a no-op rather than throwing: losing the receipt
      // is bad, refusing to announce at all is worse.
      : () => {};
    for (const ch of intent.channels || []) {
      const fn = map[ch];
      if (!fn) {
        // Asked for, but nothing is wired to post it. The card definitively
        // did not go out, and "nothing configured" needs a different fix from
        // "the post failed", so the two are recorded differently.
        record(ch, {
          status: 'skipped', attemptedAt: null,
          error: `no announcer configured for channel '${ch}'`,
        });
        continue;
      }
      record(ch, { status: 'attempting', attemptedAt: Date.now() });
      try {
        const res = await fn(intent);
        if (res && res.skipped) {
          record(ch, { status: 'skipped', error: res.reason || 'announcer skipped this channel' });
          continue;
        }
        const rawId = res && (res.messageId != null ? res.messageId : res.id);
        const code = res && typeof res.statusCode === 'number' ? res.statusCode : null;
        // EVIDENCE, not absence of an error. 'posted' is claimed only when the
        // announcer handed back something that shows the channel accepted the
        // message: an id, a 2xx status, or an explicit flag.
        const accepted = rawId != null
          || (code !== null && code >= 200 && code < 300)
          || (res && res.posted === true);
        if (!accepted) {
          record(ch, {
            status: 'unreported',
            error: `announcer for '${ch}' returned no evidence of a post`,
          });
          continue;
        }
        record(ch, {
          // postedAt: the channel accepted it. Says nothing about a human.
          status: 'posted',
          postedAt: Date.now(),
          messageId: rawId == null ? null : String(rawId),
          error: null,
        });
      } catch (e) {
        record(ch, { status: 'failed', error: e.message || String(e) });
        process.stderr.write(`[iak-mcp] announce ${ch} failed: ${e.message}\n`);
      }
    }
  };
}

// --- chat-reply poller -------------------------------------------------------

// Watch a GroupMind room for "/approve <id>" / "/deny <id>" quick-reply
// messages (the CodeWatch Approve/Deny buttons POST these on tap) and route
// them to decideIntent() in-process. This is what makes a phone tap actually
// settle a pending intent. It used to live only in bin/iak-mcp-daemon.mjs, so
// the in-process MCP confirmations server never routed taps — buttons looked
// dead (intent stuck "pending" after Approve). Sharing it here lets both the
// standalone daemon and the in-process server run it from one source.
//
// Logs go to stderr only (stdout is the MCP stdio protocol channel — writing
// there would corrupt it). Returns the interval handle so callers can stop it.
// `owner` is the account handle decisions are accepted from. It also decides
// who is worth ANSWERING when a decision is rejected: see `ownerish` below.
// Defaulting it keeps existing callers behaving identically, but it is a
// `owners` is an EXPLICIT list of exact handles allowed to settle intents,
// deliberately not a prefix match: an agent can register any handle it likes,
// so `petrus-*` would let a fleet agent call itself "petrus-helper" and inherit
// approval authority — the precise attack this guard exists to stop. A list
// rather than one name because a person is not one handle: they are a laptop,
// a tablet and a watch (2026-08-03: a decision from the owner's own tablet,
// "@petrus-boox", was dropped in silence because this compared against the
// literal "petrus" — he tapped Approve on camera and nothing happened).
// Ported from the Mini's field-hardened fork (branch mini-local-fork-rescue),
// security-reviewed by codexmb 2026-08-27; `owner` kept as an alias so
// existing call sites keep working.
// NOTE on `intervalMs`: this default is a COST decision as much as a latency one.
// The host bills per request, so 5000 ms is 17,280 requests/day/device for this
// poller alone — the single largest source of our 2026-09 hosting bill. It is kept
// at 5000 for backward compatibility, but callers should pass a value explicitly;
// iak-mcp-daemon.mjs derives one from mcp.confirmations.interval_sec.
export function startChatReplyPoller({ apiKey, room, intervalMs = 5000, log, owners, owner = 'petrus' }) {
  if (!apiKey || !room) {
    process.stderr.write('[iak-mcp] chat-reply poller: missing apiKey or room — disabled\n');
    return null;
  }
  const ownerSet = new Set(
    // An array — INCLUDING an explicitly empty one — is authoritative: [] is
    // the lockdown config where nobody settles from chat. Only an absent /
    // non-array value falls back to the legacy single `owner`.
    (Array.isArray(owners) ? owners : [owner])
      .map((o) => String(o).replace(/^@/, '').toLowerCase())
  );
  const emit = log || ((msg) => process.stderr.write(`[iak-mcp] ${msg}\n`));
  const seen = new Set();
  let primed = false;
  // A dropped decision has to be VISIBLE, not merely logged. On 2026-08-03
  // petrus typed "/approve f2af1c66" from his tablet; the owner guard below
  // rejected it because that device posts as "@petrus-boox" rather than
  // "petrus", wrote one line to stderr, and left the intent pending. He saw
  // no error, assumed the approval had landed, and moved on — the approval
  // path failing in the one way it must never fail, silently. Every reject
  // branch now answers in the room. Costs one request per rejected message,
  // and `seen` guarantees that is once, not once per poll.
  //
  // No feedback loop: these replies never match the /approve|/deny regex
  // below, which is anchored at the start of the message.
  //
  // Backticks are stripped from interpolated handles: a handle is chosen by
  // whoever registered it, and these strings put it inside a markdown code
  // span, which one backtick would break out of.
  const reply = async (body) => {
    try {
      await fetch('https://groupmind.one/api/v1/messages', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, body }),
      });
    } catch (e) {
      // Never let a failed reply break the poll loop: not telling someone
      // their tap was rejected is bad, but dropping every later tap on the
      // floor because one POST failed is worse.
      emit(`reply failed: ${e.message}`);
    }
  };
  const poll = async () => {
    try {
      const url = `https://groupmind.one/api/v1/rooms/${encodeURIComponent(room)}/messages?limit=30`;
      const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
      if (!res.ok) return;
      const body = await res.json();
      const messages = body?.messages || [];
      for (const m of messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!primed) continue; // ignore historical messages on first pass
        const text = (m.body || '').trim();
        // `/choose <id> <value>` carries a value, so its tail is greedy where
        // approve/deny are anchored. Keep them one regex so a message can
        // never match both readings.
        const match = text.match(/^\/(approve|deny)\s+([a-f0-9]+)$/i)
          || text.match(/^\/(choose)\s+([a-f0-9]+)\s+(.+)$/i);
        if (!match) continue;
        // Only the human owner may settle intents. Fleet agents share the room
        // and one (hermes) auto-replied "/approve <id>" to a confirmation card,
        // which this poller happily executed — any agent could approve any
        // gated command. Agent senders carry a handle ("@ether", "hermes");
        // the owner posts as plain "petrus" (CodeWatch button taps included).
        const sender = String(m.from || '').replace(/^@/, '').toLowerCase();
        // Authorization: exact membership in the owners set, nothing else.
        // isHuman is server-derived and cannot be minted via an agent key,
        // but it only proves the sender is A human, not THE owner — any other
        // human member of the room would have inherited settle authority
        // through it (codexmb's merge-blocking finding on this PR). A human
        // whose tap is refused is told so visibly below; adding their handle
        // to owners is the fix, silence never is.
        if (!ownerSet.has(sender)) {
          emit(`${text} from ${m.from}: sender is not the owner — ignoring`);
          // Answer only senders who plausibly ARE the owner (`petrus`,
          // `petrus-boox`, a future `petrus-watch`). claudeMB's review caught
          // that replying to everything amplifies the very misbehaviour this
          // guard was written for: a fleet agent once retried `/approve` in a
          // loop, and answering each attempt would turn a silent log line into
          // the daemon spamming the room — which is petrus's phone notification
          // surface. Worse, a bot that retries on being told "not recorded"
          // ping-pongs forever, and no `seen` set stops that because every
          // round is a genuinely new message id.
          //
          // A human who tapped Approve needs to know it did not land. An agent
          // emitting a spurious `/approve` does not; the log line was always
          // the right answer for it.
          // "Plausibly the owner" for reply purposes only — NEVER for
          // authorization: prefix-matching authority is the petrus-helper hole.
          // Reply visibly to anyone who might actually be at a screen: a
          // sender that RESEMBLES an owner surface, or any server-verified
          // human. Agents emitting spurious /approve get the log line only.
          const ownerish = m.isHuman === true
            || [...ownerSet].some((o) => sender === o || sender.startsWith(`${o}-`));
          if (ownerish) {
            await reply(
              `\`${text}\` was NOT recorded — the intent is still pending. ` +
              `Only the account owner can settle intents, and this arrived from ` +
              `\`${String(m.from || '').replace(/`/g, '')}\`, which is not a ` +
              `recognised owner identity.`
            );
          }
          continue;
        }
        const verb = match[1].toLowerCase();
        // For /choose the answer is the tail, not the verb.
        const decision = verb === 'choose' ? match[3].trim() : verb;
        const id = match[2];
        const intent = getIntent(id);
        if (!intent) {
          // Log, but do NOT tell the owner it failed. More than one machine
          // runs this poller against the same room, and each keeps its OWN
          // intent store, so "unknown to me" does not mean unknown — the
          // poller that owns the intent settles it while every other poller
          // sees an id it has never heard of.
          //
          // 2026-08-30: petrus tapped Approve on 84967c40 and b69eaa2c. Both
          // were recorded and settled (decision=approve, seconds after the
          // tap) by the poller holding them, while a second poller posted
          // "was NOT recorded — no intent with that id" for each. He re-tapped
          // b69eaa2c because of that message and was told the same thing
          // again. A false failure is worse than silence: it makes a working
          // approval look broken and sends the owner round the loop.
          //
          // The genuinely-stale case loses its notice, which is the cheaper
          // error: nothing happens, and the pending list still shows the
          // truth. Restore a reply here only once a poller can tell "expired"
          // apart from "belongs to another poller".
          emit(`/${verb} ${id} from ${m.from}: unknown intent here, staying silent (another poller may own it)`);
          continue;
        }
        const r = decideIntent(id, decision);
        // Keep the approve/deny line byte-identical - it is asserted by the
        // suite and read by anyone grepping poller logs. Only /choose adds
        // its value, because for a choice the verb alone says nothing.
        const label = verb === 'choose' ? `/${verb} ${id} ${decision}` : `/${verb} ${id}`;
        emit(`${label} from ${m.from}: ${r.ok ? 'settled' : r.error}`);
      }
      primed = true;
    } catch (e) {
      emit(`chat-reply poll error: ${e.message}`);
    }
  };
  poll();
  return setInterval(poll, intervalMs);
}

// --- testing helpers ---------------------------------------------------------

// Reset all state. Used by the test suite between cases. Not exported via
// the package surface for production use.
export function _resetForTests() {
  for (const i of intents.values()) {
    for (const r of i.resolvers) {
      try { r({ decision: 'deny', id: '__reset__' }); } catch {}
    }
  }
  intents.clear();
}
