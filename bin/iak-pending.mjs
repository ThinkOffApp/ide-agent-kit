#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// iak-pending - "what is still waiting on me", across the whole fleet.
//
// WHY THIS EXISTS
// ---------------
// Every approval request already posts to the room correctly, at the moment it
// is raised. Nothing is broken. The problem is that a room is a stream: a card
// is visible for a few minutes and then it scrolls away, and once it has
// scrolled away it is functionally lost. On 2026-09-20 four approval requests
// sat pending on a single machine for up to 9.2 hours that way, and the owner
// asked "what were the approvals pending me" twice in one night because there
// was no surface anywhere that could answer it. A stream is not a queue. This
// is the queue.
//
// THREE RULES THIS TOOL IS BUILT AROUND
// -------------------------------------
// 1. AGE IS THE POINT. A 9-hour-old approval and a 2-minute-old approval are
//    different things and must never render the same. Oldest goes first, at the
//    top, with the age in the left column where it cannot be missed.
//
// 2. EMPTY IS NOT ERROR. A daemon we could not reach must NEVER be folded into
//    "nothing pending". "I could not ask" and "the answer is none" are
//    different answers, and this repo has shipped the first one disguised as
//    the second before. Unreachable hosts get their own explicit section, and
//    if EVERY host is unreachable the exit code says so loudly - that state is
//    emphatically not "you are all clear".
//
// 3. NEVER NAG. A bot that repeats itself is worse than no bot. --room is safe
//    to put on a timer: --older-than hides anything that is not genuinely
//    stale, and a small state ledger means an item is announced at most once
//    per escalation. When that ledger is missing or corrupt the tool degrades
//    to SILENCE, never to a storm. See selectAnnouncements().
//
// USAGE: iak-pending [--json] [--room] [--older-than <dur>] ... (--help)
//
// Secrets: the daemon gate token is resolved by the existing helper
// (resolveGateToken / gateAuthHeadersFor in src/mcp-server.mjs) and is sent
// only to hosts that helper already trusts. It is never printed, never logged
// and never placed in argv.

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { gateAuthHeadersFor } from '../src/mcp-server.mjs';
import { lanIpReason } from '../packages/user-intent-kit/src/model-capacity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 5000;
const ROOM_API_BASE = process.env.IAK_ROOM_API_BASE || 'https://groupmind.one/api/v1';

// --- exit codes -------------------------------------------------------------
//
// Four distinct states, in precedence order. The precedence matters: a list
// assembled from hosts that did not all answer is an INCOMPLETE list, and a
// caller must be able to tell that apart from a complete one, so reachability
// outranks "something is pending". The full picture is always in --json.
export const EXIT = {
  NONE_PENDING: 0,    // every host answered, and not one of them has anything waiting
  PENDING: 10,        // every host answered, and at least one item is waiting
  SOME_UNREACHABLE: 11, // at least one host could not be asked: the list is incomplete
  NONE_REACHABLE: 12,   // NO host could be asked: there is no list, and this is not "all clear"
};

export const STATE_VERSION = 1;

/** Default ledger location. Overridable with --state-file / IAK_PENDING_STATE_FILE. */
export function defaultStateFile(env = process.env) {
  if (env.IAK_PENDING_STATE_FILE) return env.IAK_PENDING_STATE_FILE;
  return join(env.HOME || homedir(), '.iak', 'pending-announced.json');
}

// --- duration + age ---------------------------------------------------------

/**
 * "90m" / "2h" / "45s" / "1d" / "3600" (bare number = seconds) -> seconds.
 * Returns null for anything unparseable, so the caller can refuse rather than
 * guess a threshold - a misread threshold is either a storm or a silence.
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  return n * mult;
}

/** Human age. Coarse on purpose: "9h 12m" reads as alarming, "33120s" does not. */
export function formatAge(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'age unknown';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// --- hosts ------------------------------------------------------------------

/**
 * The roster of peer daemons, same source the watchdog uses:
 * IAK_WATCHDOG_ROSTER (inline JSON) or IAK_WATCHDOG_ROSTER_FILE (default
 * config/watchdog-roster.json). Absent roster = local daemon only, which is
 * the correct answer for a single-machine install, not an error.
 */
export function loadRoster(env = process.env) {
  const inline = env.IAK_WATCHDOG_ROSTER;
  if (inline) {
    try {
      const parsed = JSON.parse(inline);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  const file = env.IAK_WATCHDOG_ROSTER_FILE || join(ROOT, 'config', 'watchdog-roster.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Every daemon the fleet knows about: this machine's, plus each roster entry
 * that has a `gate`. Roster rows with no gate are agents whose wake path is a
 * room mention; they host no intent registry, so there is nothing to ask.
 *
 * A gate naming ANOTHER machine must use a stable name. 192.168.1.50 is a
 * different box in Helsinki than it is in Berlin and the MacBook travels, so a
 * LAN literal is refused here rather than silently answered by a stranger's
 * daemon. Refused hosts are still carried through as blocked hosts: they show
 * up in the unreachable section, because "I refused to ask" is one more way of
 * not knowing, and it must not read as "nothing pending".
 */
export function resolveHosts({ config = {}, roster = [], daemon = null } = {}) {
  const cc = config?.mcp?.confirmations || {};
  const host = cc.host && cc.host !== '0.0.0.0' ? cc.host : '127.0.0.1';
  const localBase = String(daemon || `http://${host}:${cc.port || 8788}`).replace(/\/+$/, '');
  const hosts = [{ label: 'local', base: localBase, blocked: null }];
  const seen = new Set([localBase]);

  for (const entry of roster) {
    const gate = typeof entry?.gate === 'string' ? entry.gate.trim().replace(/\/+$/, '') : '';
    if (!gate) continue;
    const label = String(entry?.handle || gate);
    let hostname;
    try { hostname = new URL(gate).hostname; } catch {
      hosts.push({ label, base: gate, blocked: 'gate is not a URL' });
      continue;
    }
    const lan = lanIpReason(hostname);
    if (lan) {
      hosts.push({
        label, base: gate,
        blocked: `refused: gate is a LAN IP (${lan}). Use a stable name for another machine.`,
      });
      continue;
    }
    if (seen.has(gate)) continue;
    seen.add(gate);
    hosts.push({ label, base: gate, blocked: null });
  }
  return hosts;
}

// --- probing ----------------------------------------------------------------

function normaliseItem(raw, hostLabel, hostBase, now) {
  const createdAt = Number(raw?.createdAt);
  const hasAge = Number.isFinite(createdAt) && createdAt > 0;
  return {
    host: hostLabel,
    base: hostBase,
    id: String(raw?.id ?? ''),
    prompt: typeof raw?.prompt === 'string' ? raw.prompt : '',
    session: raw?.session ?? null,
    options: Array.isArray(raw?.options) && raw.options.length ? raw.options : null,
    createdAt: hasAge ? createdAt : null,
    // An intent with no usable timestamp has an age we cannot compute. It is
    // reported as unknown rather than as zero: calling it fresh is exactly the
    // under-report this tool exists to prevent.
    ageSec: hasAge ? Math.max(0, Math.round((now - createdAt) / 1000)) : null,
  };
}

/**
 * Ask one daemon for its pending intents.
 *
 * Returns {ok:true, items} or {ok:false, reason} - never a bare empty list on
 * failure. Every failure path here has to produce a reason string, because the
 * caller renders unreachable hosts as their own lines and an empty reason would
 * put us right back to an error that looks like an all-clear.
 */
export async function probeHost(host, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() } = {}) {
  const base = { label: host.label, base: host.base };
  if (host.blocked) return { ...base, ok: false, asked: false, reason: host.blocked };

  const url = `${host.base}/intents?status=pending`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: gateAuthHeadersFor(host.base),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `no answer in ${timeoutMs}ms` : (e?.cause?.code || e?.code || e?.message || String(e));
    return { ...base, ok: false, asked: true, reason: `unreachable: ${why}` };
  }
  if (res.status === 401 || res.status === 403) {
    // Deliberately says nothing about the token itself beyond whether one was
    // offered. The value never appears in output.
    const offered = Object.keys(gateAuthHeadersFor(host.base)).length > 0;
    return {
      ...base, ok: false, asked: true,
      reason: offered
        ? `HTTP ${res.status}: daemon rejected this machine's gate token`
        : `HTTP ${res.status}: daemon requires a gate token and none was sent to this host`,
    };
  }
  if (!res.ok) return { ...base, ok: false, asked: true, reason: `HTTP ${res.status}` };

  let body;
  try { body = await res.json(); } catch { return { ...base, ok: false, asked: true, reason: 'daemon answered with unparseable JSON' }; }
  if (!Array.isArray(body)) return { ...base, ok: false, asked: true, reason: 'daemon answered with a non-list body' };

  // ?status=pending is asked for AND re-checked here. An older daemon that does
  // not know the filter returns its whole history, decided intents included,
  // and a decided intent in this list is a phantom the owner would re-answer.
  const items = body
    .filter((i) => i && i.status === 'pending')
    .map((i) => normaliseItem(i, host.label, host.base, now));
  return { ...base, ok: true, asked: true, items };
}

/** Oldest first. Unknown age sorts to the very top: it might be the oldest. */
export function byOldestFirst(a, b) {
  if (a.ageSec === null && b.ageSec === null) return String(a.id).localeCompare(String(b.id));
  if (a.ageSec === null) return -1;
  if (b.ageSec === null) return 1;
  if (b.ageSec !== a.ageSec) return b.ageSec - a.ageSec;
  return String(a.id).localeCompare(String(b.id));
}

/** Ask every host, in parallel, and assemble the answer. */
export async function collectPending({ hosts, fetchImpl, timeoutMs, now = Date.now() } = {}) {
  const results = await Promise.all(hosts.map((h) => probeHost(h, { fetchImpl, timeoutMs, now })));
  const reached = results.filter((r) => r.ok);
  const unreachable = results.filter((r) => !r.ok).map(({ label, base, reason, asked }) => ({ label, base, reason, asked }));
  const items = reached.flatMap((r) => r.items).sort(byOldestFirst);
  return { now, items, unreachable, hostCount: hosts.length, reachedCount: reached.length };
}

/** Keep only items at or past the threshold. Boundary is inclusive: age == threshold counts. */
export function filterByAge(items, thresholdSec) {
  if (!thresholdSec) return items;
  // Unknown age survives the filter. We cannot prove it is fresh, and the
  // failure mode we care about is dropping something that was waiting.
  return items.filter((i) => i.ageSec === null || i.ageSec >= thresholdSec);
}

export function exitCodeFor({ items = [], unreachable = [], hostCount = 0 } = {}) {
  if (hostCount > 0 && unreachable.length >= hostCount) return EXIT.NONE_REACHABLE;
  if (unreachable.length > 0) return EXIT.SOME_UNREACHABLE;
  return items.length ? EXIT.PENDING : EXIT.NONE_PENDING;
}

// --- anti-nag ---------------------------------------------------------------

export function itemKey(item) {
  return `${item.host} ${item.id}`;
}

/**
 * Escalation level for an item: 0 below the threshold, then 1 at the threshold
 * and one more each time the age DOUBLES past it. With --older-than 1h an item
 * is announced at 1h, 2h, 4h and 8h and at no other moment, so the 9.2-hour
 * approval that started this would have produced four posts across a night
 * rather than one every timer tick.
 */
export function escalationLevel(ageSec, thresholdSec) {
  if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return 1;
  if (ageSec === null || !Number.isFinite(ageSec)) return 1; // unknown age: announce once, never escalate
  if (ageSec < thresholdSec) return 0;
  return Math.floor(Math.log2(ageSec / thresholdSec)) + 1;
}

/**
 * Read the ledger. Returns {ok:true, state} or {ok:false, reason} - a missing
 * file and a corrupt file are both "we do not know what was already said", and
 * both are handled by selectAnnouncements the same way: silence.
 */
export function loadAnnounceState(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return { ok: false, reason: e?.code === 'ENOENT' ? 'missing' : `unreadable (${e?.code || e?.message})` }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'corrupt (not JSON)' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'corrupt (not an object)' };
  if (parsed.version !== STATE_VERSION) return { ok: false, reason: `corrupt (unknown version ${parsed.version})` };
  const announced = parsed.announced;
  if (!announced || typeof announced !== 'object' || Array.isArray(announced)) return { ok: false, reason: 'corrupt (no announced map)' };
  return { ok: true, state: parsed };
}

/** Atomic write, so a crash mid-write cannot leave a half file that reads as corrupt-then-storm. */
export function saveAnnounceState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/**
 * Decide what, if anything, is new enough news to say out loud.
 *
 * An item is announced only when its escalation level is above whatever level
 * the ledger last recorded for it, so a timer running every five minutes says
 * nothing on the second tick.
 *
 * WHEN THE LEDGER IS MISSING OR CORRUPT we announce NOTHING and instead seed
 * the ledger with the current levels. The alternative - treating "no record" as
 * "never announced" - turns one deleted file into a post for every pending item
 * on the fleet at once, which is the exact behaviour that makes people mute a
 * bot. A single missed escalation is cheap; a storm is not.
 *
 * The rebuilt ledger contains only currently-pending items, so decided ones are
 * pruned on every run and the file cannot grow without bound.
 */
export function selectAnnouncements({ items = [], thresholdSec = 0, stateLoad = { ok: false, reason: 'missing' }, now = Date.now() } = {}) {
  const previous = stateLoad.ok ? stateLoad.state.announced : {};
  const announced = {};
  const announce = [];
  for (const item of items) {
    const key = itemKey(item);
    const level = escalationLevel(item.ageSec, thresholdSec);
    if (level <= 0) continue; // below threshold: not stale yet, not ledger business
    announced[key] = { level, at: now };
    const prev = Number(previous[key]?.level) || 0;
    if (level > prev) announce.push(item);
  }
  if (!stateLoad.ok) {
    return { announce: [], nextState: { version: STATE_VERSION, announced }, silencedBecause: stateLoad.reason };
  }
  return { announce, nextState: { version: STATE_VERSION, announced }, silencedBecause: null };
}

// --- rendering --------------------------------------------------------------

function clip(text, max) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function renderText({ items, unreachable, hostCount, reachedCount, thresholdSec = 0 }) {
  const lines = [];
  const scope = thresholdSec ? ` older than ${formatAge(thresholdSec)}` : '';
  if (items.length) {
    lines.push(`WAITING ON YOU${scope} - ${items.length} item${items.length === 1 ? '' : 's'}, OLDEST FIRST:`);
    lines.push('');
    const width = Math.max(...items.map((i) => formatAge(i.ageSec).length));
    for (const i of items) {
      lines.push(`  ${formatAge(i.ageSec).padStart(width)}  ${i.host}  ${i.id}  ${clip(i.prompt, 72)}`);
    }
  } else if (reachedCount > 0) {
    lines.push(`Nothing pending${scope} on ${reachedCount} of ${hostCount} host${hostCount === 1 ? '' : 's'}.`);
  }

  if (unreachable.length) {
    lines.push('');
    lines.push(`COULD NOT ASK ${unreachable.length} of ${hostCount} host${hostCount === 1 ? '' : 's'} - anything waiting there is NOT in the list above:`);
    for (const u of unreachable) lines.push(`  ${u.label}  ${u.base}  ${u.reason}`);
    if (reachedCount === 0) {
      lines.push('');
      lines.push('NO host answered. This is not "you are all clear" - it is "nobody could be asked".');
    }
  }
  return lines.join('\n');
}

export function renderRoomBody({ items, unreachable, hostCount, reachedCount, thresholdSec }) {
  const lines = [`Still waiting on you (nothing newer than ${formatAge(thresholdSec)}), oldest first:`];
  for (const i of items) lines.push(`- ${formatAge(i.ageSec)} - ${i.host} - \`${i.id}\` - ${clip(i.prompt, 90)}`);
  if (unreachable.length) {
    lines.push('');
    lines.push(`Could not reach ${unreachable.length} of ${hostCount} host${hostCount === 1 ? '' : 's'} (${unreachable.map((u) => u.label).join(', ')}), so anything waiting there is not listed.`);
    if (reachedCount === 0) lines.push('No host answered at all, so this is not an all-clear.');
  }
  return lines.join('\n');
}

// --- CLI --------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { json: false, room: false, help: false, olderThan: null, daemon: null, config: null, stateFile: null, roomName: null, timeoutMs: DEFAULT_TIMEOUT_MS, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') out.json = true;
    else if (a === '--room') out.room = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--older-than') out.olderThan = next();
    else if (a === '--daemon' || a === '--gate') out.daemon = next();
    else if (a === '--config') out.config = next();
    else if (a === '--state-file') out.stateFile = next();
    else if (a === '--room-name') out.roomName = next();
    else if (a === '--timeout-sec') out.timeoutMs = Math.max(1, Number(next()) || 5) * 1000;
    else { out.error = `unknown argument: ${a}`; break; }
  }
  return out;
}

export const HELP = `iak-pending - what is still waiting on the owner, across the fleet.

Asks every daemon the fleet knows about (this machine's, plus every roster
entry with a "gate") for its PENDING intents, and prints them oldest first.
A room card scrolls away in minutes; this is the surface that still remembers.

USAGE
  iak-pending [options]

OPTIONS
  --older-than <dur>   Only report items at least this old. Inclusive at the
                       boundary. Suffixes s/m/h/d, bare number = seconds.
  --json               Machine-readable output on stdout.
  --room               Post a summary to the GroupMind room (see ANTI-NAG).
  --room-name <room>   Room for --room. Default: mcp.confirmations.room.
  --daemon <url>       Override this machine's daemon base URL.
  --config <path>      Config file. Default: ide-agent-kit.json.
  --state-file <path>  Anti-nag ledger. Default: ~/.iak/pending-announced.json
                       (or IAK_PENDING_STATE_FILE).
  --timeout-sec <n>    Per-host probe timeout. Default 5.
  -h, --help           This text.

EXIT CODES
  0   Nothing pending, and EVERY host answered. Only this code means all clear.
  10  At least one item is waiting, and every host answered.
  11  At least one host could not be asked. The list you got is INCOMPLETE,
      whether or not it had items in it - that is why this outranks 10.
  12  NO host could be asked. There is no list at all. This is emphatically
      not "you are all clear".
  2   Bad usage.
  Precedence: 12 > 11 > 10 > 0. --json always carries the full picture.

EMPTY IS NOT ERROR
  A host we could not reach is printed as its own line under COULD NOT ASK and
  is never folded into "nothing pending". A refused host counts too: a gate
  naming another machine by LAN IP is refused rather than probed, because
  192.168.x means different hardware in different buildings.

ANTI-NAG
  --room is safe on a timer. Only items past --older-than are considered, and
  each is announced at most once per escalation: once at the threshold, then
  once more each time its age doubles (1h, 2h, 4h, 8h with --older-than 1h).
  The ledger of what has been said lives in the --state-file, is written
  atomically BEFORE the post goes out, and holds only currently-pending items
  so decided ones are pruned every run.
  If that ledger is MISSING or CORRUPT, --room posts NOTHING and rebuilds it
  from the current state. Treating "no record" as "never announced" would post
  every pending item on the fleet at once the first time the file is lost, and
  a storm is worse than a missed escalation.
  If the ledger cannot be WRITTEN, nothing is posted either: without a durable
  record there is no way to promise the next run stays quiet.
  --room does not post about unreachable hosts on its own (a flapping daemon
  would be its own storm). Exit codes 11 and 12 are the signal for that.

SECRETS
  The gate token is read by the shared resolver (~/.iak gate token file or
  IAK_GATE_TOKEN), is sent only to hosts that resolver already trusts, and is
  never printed and never passed on the command line.
`;

async function postRoom({ apiKey, room, body }) {
  const res = await fetch(`${ROOM_API_BASE}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`room post failed: HTTP ${res.status}`);
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = console.log, errOut = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.help) { out(HELP); return 0; }
  if (args.error) { errOut(args.error); errOut(HELP); return 2; }

  let thresholdSec = 0;
  if (args.olderThan !== null && args.olderThan !== undefined) {
    thresholdSec = parseDuration(args.olderThan);
    if (thresholdSec === null) { errOut(`--older-than: cannot parse "${args.olderThan}" (try 90m, 2h, 45s, 1d)`); return 2; }
  }
  if (args.room && !thresholdSec) { errOut('--room requires --older-than: posting every pending item on every tick is the nagging this tool refuses to do.'); return 2; }

  let config = {};
  try { config = loadConfig(args.config || env.IAK_CONFIG || undefined); }
  catch (e) { errOut(`config: ${e.message}`); return 2; }

  const hosts = resolveHosts({ config, roster: loadRoster(env), daemon: args.daemon });
  const result = await collectPending({ hosts, timeoutMs: args.timeoutMs });
  const items = filterByAge(result.items, thresholdSec);
  const view = { ...result, items, thresholdSec };
  const code = exitCodeFor(view);

  if (args.json) {
    out(JSON.stringify({
      generated_at: new Date(result.now).toISOString(),
      older_than_sec: thresholdSec || null,
      host_count: result.hostCount,
      reached_count: result.reachedCount,
      pending: items.map((i) => ({
        host: i.host, id: i.id, prompt: i.prompt, session: i.session, options: i.options,
        created_at: i.createdAt ? new Date(i.createdAt).toISOString() : null,
        age_sec: i.ageSec, age: formatAge(i.ageSec),
      })),
      unreachable: result.unreachable.map((u) => ({ host: u.label, base: u.base, asked: u.asked, reason: u.reason })),
      exit_code: code,
    }, null, 2));
  } else {
    out(renderText(view));
  }

  if (args.room) {
    const statePath = args.stateFile || defaultStateFile(env);
    const stateLoad = loadAnnounceState(statePath);
    const picked = selectAnnouncements({ items, thresholdSec, stateLoad, now: result.now });
    const saved = saveAnnounceState(statePath, picked.nextState);
    if (!saved) {
      errOut(`anti-nag: could not write ${statePath}; posting nothing (no ledger, no promise to stay quiet next run)`);
    } else if (picked.silencedBecause) {
      errOut(`anti-nag: ledger ${picked.silencedBecause}; rebuilt it and posted nothing this run`);
    } else if (picked.announce.length) {
      const apiKey = config?.poller?.api_key || env.GROUPMIND_KEY || env.ANTFARM_KEY;
      const room = args.roomName || config?.mcp?.confirmations?.room || String(config?.poller?.rooms || '').split(',')[0].trim();
      if (!apiKey || !room) {
        errOut('--room: no api key (poller.api_key) or no room (mcp.confirmations.room / --room-name)');
      } else {
        try {
          await postRoom({ apiKey, room, body: renderRoomBody({ ...view, items: picked.announce }) });
        } catch (e) { errOut(e.message); }
      }
    }
  }
  return code;
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`iak-pending: ${e?.message || e}`);
    process.exitCode = 2;
  });
}
