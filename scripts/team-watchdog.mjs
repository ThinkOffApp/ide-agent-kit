#!/usr/bin/env node
// team-watchdog (claudeMB / MacBook) — keep the team alive in the room.
//
// Runs in the ALWAYS-ON layer (launchd / tmux), independent of any agent IDE.
// Every INTERVAL it reads the room, computes each roster agent's last-seen, and
// wakes any that has gone quiet too long: POST <gate>/wake (if reachable) + an
// @mention nudge their poller catches. Rate-limited so it never spams.
//
// DRY_RUN=1  -> detect + log only, NO room posts / wakes (safe before Tailscale
//               to the Mini is up, since unreachable agents would just get spam).
// Flip to active (unset DRY_RUN) once `tailscale up` is done on the Mini.
//
// Env: ANTFARM_KEY (defaults to claudeMB posting key), ROOM, STALE_MIN,
//      COOLDOWN_MIN, INTERVAL_MIN, MAX_NUDGES.

const API   = 'https://antfarm.world/api/v1';
const KEY   = process.env.ANTFARM_KEY || JSON.parse(readFileSync('/Users/petrus/ide-agent-kit/config/macbook.json','utf8')).poller.api_key;
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

const SELF = 'claudemb';
// ether + hermes are set to mention_only (Jul 5 2026, after the overnight
// flood): the ONLY thing that makes them talk is being @mentioned, so a
// watchdog nudge to them re-creates the exact noise petrus complained about.
// Watch only the agents that should be autonomously live in the room.
const ROSTER = [
  { handle: '@claudemm',    gate: 'http://100.97.140.13:8788' },
  // codex ADDED with a silent LOCAL wake (Jul 13 2026): its webhook-wake tunnel
  // died silently Jul 9-12 and nobody noticed for three days. The watchdog is
  // the backstop: if @codexmb goes quiet, run the local GUI nudge directly -
  // never a room post (same lesson as antigravity below).
  { handle: '@codexmb',     localWake: '/Users/petrus/ide-agent-kit/tools/codex_gui_nudge.sh' },
  // antigravity REMOVED from room-nudging (petrus, Jul 5 2026: "your
  // antigravity checks are spamming the room pls stop them"). It is gateless,
  // so the only way to nudge it was a room @mention every ~48min, which read
  // as spam. It runs on this MacBook, so if death-detection is wanted later,
  // do it via a silent local process check, never a room post.
];

// State persists to a file so it survives one-shot (StartInterval) runs and
// sleep/wake. In-process setTimeout pauses when the Mac sleeps, so the watchdog
// runs as a launchd StartInterval one-shot (ONCE=1) instead of a long loop.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
const STATE_FILE = '/tmp/team-watchdog-state.json';
let state = {};
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
function saveState() { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} }

async function getMessages() {
  const r = await fetch(`${API}/rooms/${ROOM}/messages?limit=80`, { headers: { 'X-API-Key': KEY }, signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  return d.messages || [];
}
async function postRoom(body) {
  if (DRY) { console.log('[dry] would post:', body); return; }
  await fetch(`${API}/messages`, { method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ room: ROOM, body }), signal: AbortSignal.timeout(15000) });
}
async function wakeGate(gate) {
  if (!gate) return false;
  try {
    const r = await fetch(`${gate}/wake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'check rooms' }), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}
function wakeLocal(script) {
  // Local GUI nudge for same-machine agents (codex). Silent by contract:
  // success or failure, we log and never room-post.
  if (!script) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('bash', [script], { timeout: 30_000 }, (err) => resolve(!err));
  });
}
function lastSeen(msgs, handle) {
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

async function tick() {
  const msgs = await getMessages();
  const now = Date.now();
  const toNudge = [];
  for (const a of ROSTER) {
    const seen = lastSeen(msgs, a.handle);
    const ageMin = seen ? Math.round((now - seen) / 60000) : Infinity;
    const st = (state[a.handle] ||= { lastNudge: 0, misses: 0, silentWakes: 0 });
    const stale = (now - (seen || 0)) > STALE_MS;
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
    await postRoom(`${mentions} [team-watchdog] you have gone quiet - check rooms and reply here. (${detail}; auto from claudeMB)`);
  }
  saveState();
  console.log(new Date().toISOString(), `checked ${ROSTER.length}`, toNudge.length ? `nudged: ${toNudge.map(n=>n.handle).join(',')}` : 'all healthy/cooling');
}

(async () => {
  console.log(`team-watchdog up. DRY_RUN=${DRY} stale=${STALE_MS/60000}m cooldown=${COOLDOWN_MS/60000}m interval=${INTERVAL_MS/60000}m`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('tick error:', e.message); }
    if (process.env.ONCE === '1') break;
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();
