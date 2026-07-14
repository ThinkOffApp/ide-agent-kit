#!/usr/bin/env node
// team-watchdog — peer-wake watchdog: keep the team alive in the room.
//
// Runs in the ALWAYS-ON layer (launchd / tmux), independent of any agent IDE.
// Every INTERVAL it reads the room, computes each roster agent's last-seen, and
// wakes any that has gone quiet too long. Each roster entry picks ONE wake path:
//   - localWake: a SAME-MACHINE GUI wake script (idle-guarded) — the watchdog
//     on machine M can revive any agent whose IDE runs on M, even with no
//     network reachability. This is the "same-machine peer wake" primitive.
//   - gate: a cross-machine POST <gate>/wake to a peer daemon (reachable only
//     while that machine is awake and its receiver is running).
//   - neither: a room @mention nudge the agent's own poller catches.
// Rate-limited (cooldown + MAX_NUDGES) so it never spams the room.
//
// localWake targets MUST be idle-guarded scripts (they call tools/human-idle-guard.sh
// so they never type over an active human). The repo's claude-gui-wake.sh and
// tools/codex_gui_nudge.sh already do; any custom script you point localWake at must too.
//
// DRY_RUN=1  -> detect + log only, NO room posts / wakes (safe while peers are
//               unreachable, since they would otherwise just get spam).
//
// Env: GROUPMIND_KEY (or legacy ANTFARM_KEY), ROOM, STALE_MIN, COOLDOWN_MIN,
//      INTERVAL_MIN, MAX_NUDGES, WATCHDOG_SELF. Roster: IAK_WATCHDOG_ROSTER
//      (inline JSON) or IAK_WATCHDOG_ROSTER_FILE (default config/watchdog-roster.json).

// Every call site uses groupmind.one; antfarm.world is the dead legacy host.
export const API = 'https://groupmind.one/api/v1';
const HOME  = process.env.HOME || '';
const REPO  = process.env.IAK_ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// Resolved lazily so importing this module (e.g. from a test) never touches the
// config file. GROUPMIND_KEY is the current name; ANTFARM_KEY stays as a legacy alias.
let _key;
function KEY() {
  if (_key === undefined) {
    // Resolve the key from env, else the config the installer actually writes
    // (ide-agent-kit.json), falling back to the legacy config/macbook.json so
    // existing hand-wired setups keep working (codex review, #34: the opt-in
    // install only sets IAK_ROOT, so a macbook.json-only default threw every
    // tick on a fresh install).
    if (process.env.GROUPMIND_KEY || process.env.ANTFARM_KEY) {
      _key = process.env.GROUPMIND_KEY || process.env.ANTFARM_KEY;
    } else {
      const candidates = [
        process.env.IAK_CONFIG,
        `${REPO}/ide-agent-kit.json`,
        `${REPO}/config/macbook.json`,
      ].filter(Boolean);
      let found;
      for (const c of candidates) {
        try { found = JSON.parse(readFileSync(c, 'utf8'))?.poller?.api_key; } catch { /* next */ }
        if (found) break;
      }
      if (!found) throw new Error(`team-watchdog: no GROUPMIND_KEY and no poller.api_key in ${candidates.join(', ')}`);
      _key = found;
    }
  }
  return _key;
}
const ROOM  = process.env.ROOM || 'thinkoff-development';
const DRY   = process.env.DRY_RUN === '1';
const STALE_MS    = (Number(process.env.STALE_MIN)    || 20) * 60_000;
const COOLDOWN_MS = (Number(process.env.COOLDOWN_MIN) || 30) * 60_000;
const INTERVAL_MS = (Number(process.env.INTERVAL_MIN) || 5)  * 60_000;
const MAX_NUDGES  = Number(process.env.MAX_NUDGES) || 2;   // stop room-posting after N consecutive misses (avoid perma-spam)
// Gate-ack = liveness (claudemm, Jul 5 2026): a gated agent whose gate accepts
// the wake nudge is demonstrably alive and just got poked, so we NEVER room-nudge
// it - silence is an accepted state. Only a gateless agent (room @mention is its
// wake path) or an UNREACHABLE gate produces a room post.

const SELF = process.env.WATCHDOG_SELF || 'claudemb';
// ether + hermes are set to mention_only (Jul 5 2026, after the overnight
// flood): the ONLY thing that makes them talk is being @mentioned, so a
// watchdog nudge to them re-creates the exact noise petrus complained about.
// Watch only the agents that should be autonomously live in the room.
// Roster comes from config (gitignored) or env - a public repo must not
// hardcode tailnet IPs or machine paths (#30 gate, B3). File format:
// config/watchdog-roster.json = [{"handle":"@x","gate":"http://host:8788"},
// {"handle":"@y","localWake":"/abs/path.sh"}]
export function loadRoster() {
  const fromEnv = process.env.IAK_WATCHDOG_ROSTER;
  const file = process.env.IAK_WATCHDOG_ROSTER_FILE || `${REPO}/config/watchdog-roster.json`;
  try {
    if (fromEnv) return JSON.parse(fromEnv);
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`team-watchdog: no roster (set IAK_WATCHDOG_ROSTER or ${file}); nothing to watch`);
    return [];
  }
}
let ROSTER = [];
/* Historical roster notes (Jul 2026):
  // codex ADDED with a silent LOCAL wake (Jul 13 2026): its webhook-wake tunnel
  // died silently Jul 9-12 and nobody noticed for three days. The watchdog is
  // the backstop: if @codexmb goes quiet, run the local GUI nudge directly -
  // never a room post (same lesson as antigravity below).
  // antigravity REMOVED from room-nudging (petrus, Jul 5 2026: "your
  // antigravity checks are spamming the room pls stop them"). It is gateless,
  // so the only way to nudge it was a room @mention every ~48min, which read
  // as spam. It runs on this MacBook, so if death-detection is wanted later,
  // do it via a silent local process check, never a room post.
*/

// State persists to a file so it survives one-shot (StartInterval) runs and
// sleep/wake. In-process setTimeout pauses when the Mac sleeps, so the watchdog
// runs as a launchd StartInterval one-shot (ONCE=1) instead of a long loop.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const STATE_FILE = '/tmp/team-watchdog-state.json';
let state = {};
function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState() { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} }

async function getMessages() {
  const r = await fetch(`${API}/rooms/${ROOM}/messages?limit=80`, { headers: { 'X-API-Key': KEY() }, signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  return d.messages || [];
}
async function postRoom(body) {
  if (DRY) { console.log('[dry] would post:', body); return; }
  await fetch(`${API}/messages`, { method: 'POST', headers: { 'X-API-Key': KEY(), 'Content-Type': 'application/json' }, body: JSON.stringify({ room: ROOM, body }), signal: AbortSignal.timeout(15000) });
}
async function wakeGate(gate) {
  if (!gate) return false;
  try {
    // Gates may require Bearer auth (claudemm's :8788 does since Jul 8 - every
    // unauthenticated wake 401s, claudemm review of IAK PR #28). Token is read
    // from a private file, never committed, never logged.
    const headers = { 'Content-Type': 'application/json' };
    try {
      const tok = readFileSync(`${process.env.HOME}/.iak/gate_bearer`, 'utf8').trim();
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
    } catch {}
    const r = await fetch(`${gate}/wake`, { method: 'POST', headers, body: JSON.stringify({ text: 'check rooms' }), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}
function wakeLocal(script) {
  // Local GUI nudge for same-machine agents (codex). Silent by contract:
  // success or failure, we log and never room-post. Must pass the same env
  // the webhook supervisor uses: codex lives INSIDE ChatGPT.app (the default
  // app name "Codex" does not exist -> AppleScript focus ABORTs), and launchd
  // strips PATH so the helper binaries need absolute paths.
  if (!script) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('bash', [script], {
      timeout: 320_000, // wake waits up to 300s for human-idle (#30 gate, B2)
      env: {
        ...process.env,
        IAK_CODEX_APP_NAME: 'ChatGPT',
        IAK_NUDGE_TEXT: 'check rooms [codex]',
        IAK_CLICLICK_BIN: '/opt/homebrew/bin/cliclick',
        IAK_PYTHON_BIN: '/opt/homebrew/bin/python3',
      },
    }, (err) => resolve(!err));
  });
}
export function lastSeen(msgs, handle) {
  const h = handle.replace(/^@/, '').toLowerCase();
  let t = 0;
  for (const m of msgs) {
    if ((m.from || '').replace(/^@/, '').toLowerCase() === h) {
      const ts = Date.parse(m.created_at || 0);
      if (ts > t) t = ts;
    }
  }
  return t;
}
// Pure staleness helpers (exported for unit tests). `seen` is the epoch-ms
// timestamp from lastSeen(); 0 means "never seen" -> infinitely stale.
export function ageMinutes(seen, now) {
  return seen ? Math.round((now - seen) / 60000) : Infinity;
}
export function isStale(seen, now, staleMs) {
  return (now - (seen || 0)) > staleMs;
}

async function tick() {
  const msgs = await getMessages();
  const now = Date.now();
  const toNudge = [];
  for (const a of ROSTER) {
    const seen = lastSeen(msgs, a.handle);
    const ageMin = ageMinutes(seen, now);
    const st = (state[a.handle] ||= { lastNudge: 0, misses: 0, silentWakes: 0 });
    const stale = isStale(seen, now, STALE_MS);
    if (!stale) { st.misses = 0; st.silentWakes = 0; continue; }
    if (now - st.lastNudge < COOLDOWN_MS) continue;      // rate-limit
    if (st.misses >= MAX_NUDGES) { console.log(`${a.handle} still down (giving room a rest after ${st.misses} nudges)`); continue; }
    if (a.localWake) {
      // Same-machine agent: silent local nudge, never a room post.
      const poked = await wakeLocal(a.localWake);
      st.lastNudge = now;
      console.log(`${a.handle} quiet ${ageMin}m - local wake ${poked ? 'fired' : 'FAILED (check nudge log)'}`);
      continue;
    }
    const woke = await wakeGate(a.gate);
    if (woke) {
      // Gate accepted the wake = the agent process is alive AND just got poked.
      // Per the gate-ack=liveness contract (claudemm, Jul 5): silence is now an
      // ACCEPTED state, so we never escalate a gated+gate-acking agent to a room
      // nudge - that would just re-create the noise we removed, delayed. If a
      // session ever does wedge, delivering this very gate wake is what recovers
      // it (proven overnight), so the wake alone is the useful action. Stay
      // silent; only gate UNREACHABILITY (below) is a real can't-confirm signal.
      st.lastNudge = now;
      console.log(`${a.handle} silent but gate-woke (alive + poked) - no room nudge`);
      continue;
    }
    if (!a.gate) {
      // Local agent (no gate): the room @mention IS its wake path, so post.
      st.lastNudge = now; st.misses += 1;
      toNudge.push({ handle: a.handle, ageMin, wedged: false });
      continue;
    }
    // Gate present but unreachable (e.g. Mini tailscale down): a room nudge does
    // nothing but spam - log and skip until it is reachable.
    console.log(`${a.handle} unreachable (gate down) - skipping room nudge until reachable`);
  }
  if (toNudge.length) {
    const mentions = toNudge.map(n => n.handle).join(' ');
    const detail = toNudge.map(n => `${n.handle} quiet ${n.ageMin}m${n.wedged ? ' [gate woke but no post - possibly wedged]' : ''}`).join(', ');
    await postRoom(`${mentions} [team-watchdog] you have gone quiet - check rooms and reply here. (${detail}; auto from ${SELF})`);
  }
  saveState();
  console.log(new Date().toISOString(), `checked ${ROSTER.length}`, toNudge.length ? `nudged: ${toNudge.map(n=>n.handle).join(',')}` : 'all healthy/cooling');
}

async function run() {
  ROSTER = loadRoster();
  state = loadState();
  console.log(`team-watchdog up. DRY_RUN=${DRY} stale=${STALE_MS/60000}m cooldown=${COOLDOWN_MS/60000}m interval=${INTERVAL_MS/60000}m`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('tick error:', e.message); }
    if (process.env.ONCE === '1') break;
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

// Only run the loop when executed directly (node scripts/team-watchdog.mjs),
// never when imported by a test. Keeping import side-effect-free is what lets
// the pure helpers (loadRoster, lastSeen, ageMinutes, isStale) be unit-tested.
const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) run();
