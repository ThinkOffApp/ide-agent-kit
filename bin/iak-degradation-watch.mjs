#!/usr/bin/env node
// iak-degradation-watch: alert when an IDE agent's session silently degrades.
//
// Born 2026-07-18: a room agent's Claude Code session slipped to a small
// fallback model (Haiku) with manual permission prompts while the owner was
// away. The degraded agent kept posting - looping on stale tasks, reposting
// completed instructions - and it cost an evening to diagnose because nothing
// surfaced the slip. Both signals are in the session transcript already:
// every assistant message carries `message.model`, and the session records
// `permissionMode` (bypassPermissions = auto-approve; default = manual
// prompts). This daemon watches transcripts on ITS machine and posts a room
// alert (CodeWatch pushes it) the moment either signal leaves the expected
// set. Run one instance per machine, under process supervision.
//
// Config (dogfood.json):
//   "degradation_watch": {
//     "interval_sec": 300,
//     "alert_room": "thinkoff-development",
//     "agents": [
//       { "name": "claudemm",
//         "transcript_dir": "/Users/petrus/.claude/projects/-Users-petrus",
//         "accepted_models": ["claude-fable-5", "claude-opus-4"],
//         "expected_permission_mode": "bypassPermissions" }
//     ]
//   }
// API key is reused from poller.api_key. Alerts fire immediately on first
// detection (a wrong model in the transcript is a fact, not a flap), with a
// 30-minute re-alert cooldown per agent+signal and a recovery note.
//
// Flags: --once (single tick, for tests/cron), --dry-run (print, don't post).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.IAK_CONFIG || join(ROOT, 'config', 'dogfood.json');
const API_BASE = process.env.IAK_ROOM_API_BASE || 'https://groupmind.one/api/v1';
const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');
const TAIL_BYTES = 128 * 1024;
const COOLDOWN_MS = 30 * 60 * 1000;

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const watch = cfg.degradation_watch;
  if (!watch || !Array.isArray(watch.agents) || watch.agents.length === 0) {
    throw new Error('config missing degradation_watch.agents');
  }
  const apiKey = watch.api_key || cfg.poller?.api_key;
  if (!apiKey) throw new Error('no api key (degradation_watch.api_key or poller.api_key)');
  return {
    intervalSec: watch.interval_sec || 300,
    alertRoom: watch.alert_room || 'thinkoff-development',
    agents: watch.agents,
    apiKey,
  };
}

function newestTranscript(dir) {
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best;
}

// Read the transcript tail and return the latest observed model and
// permissionMode. Lines are scanned oldest->newest so the last hit wins.
function latestSignals(path) {
  const size = statSync(path).size;
  const buf = readFileSync(path);
  const tail = size > TAIL_BYTES ? buf.subarray(size - TAIL_BYTES) : buf;
  let model = null;
  let permissionMode = null;
  for (const line of tail.toString('utf8').split('\n')) {
    if (!line.includes('"model"') && !line.includes('"permissionMode"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // first line may be partial
    const m = obj?.message;
    if (m && typeof m === 'object' && typeof m.model === 'string') model = m.model;
    if (typeof obj?.permissionMode === 'string') permissionMode = obj.permissionMode;
  }
  return { model, permissionMode };
}

async function postAlert(cfg, text) {
  if (DRY) { console.log('[dry-run] would post:', text); return; }
  const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(cfg.alertRoom)}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: text }),
  });
  if (!res.ok) console.error(`alert post failed: HTTP ${res.status}`);
}

// state[agent] = { model: {bad, lastAlert}, perm: {bad, lastAlert} }
const state = {};

function agentState(name) {
  if (!state[name]) {
    state[name] = {
      model: { bad: false, lastAlert: 0 },
      perm: { bad: false, lastAlert: 0 },
    };
  }
  return state[name];
}

async function checkSignal(cfg, agent, kind, isBad, badText, recoveredText) {
  const st = agentState(agent.name)[kind];
  const now = Date.now();
  if (isBad) {
    if (!st.bad || now - st.lastAlert > COOLDOWN_MS) {
      await postAlert(cfg, badText);
      st.lastAlert = now;
    }
    st.bad = true;
  } else {
    if (st.bad) await postAlert(cfg, recoveredText);
    st.bad = false;
  }
}

async function tick(cfg) {
  for (const agent of cfg.agents) {
    let signals;
    try {
      const newest = newestTranscript(agent.transcript_dir);
      if (!newest) continue;
      signals = latestSignals(newest.path);
    } catch (err) {
      console.error(`${agent.name}: ${err.message}`);
      continue;
    }

    const accepted = agent.accepted_models || [];
    // "<synthetic>" is the harness placeholder on synthetic turns (usage-limit
    // notices, injected system output) - not a real model slip. Alerting on it
    // spammed the room every cooldown while an agent sat at its usage limit
    // (petrus, 2026-07-20 00:58: "Claudemm you are spamming!").
    if (signals.model && accepted.length && signals.model !== '<synthetic>') {
      const ok = accepted.some((prefix) => signals.model.startsWith(prefix));
      await checkSignal(cfg, agent, 'model', !ok,
        `🟠 degradation watch: @${agent.name}'s session has SLIPPED to model "${signals.model}" ` +
        `(expected ${accepted.join(' or ')}). A degraded agent loops and misjudges - ` +
        `check the session before trusting its recent output.`,
        `🟢 degradation watch: @${agent.name} is back on an expected model (${signals.model}).`);
    }

    if (signals.permissionMode && agent.expected_permission_mode) {
      const ok = signals.permissionMode === agent.expected_permission_mode;
      await checkSignal(cfg, agent, 'perm', !ok,
        `🟠 degradation watch: @${agent.name}'s session permission mode is ` +
        `"${signals.permissionMode}" (expected ${agent.expected_permission_mode}). ` +
        `It may be stuck waiting on manual approval prompts nobody can see.`,
        `🟢 degradation watch: @${agent.name} permission mode restored ` +
        `(${signals.permissionMode}).`);
    }

    if (ONCE || DRY) {
      console.log(`${agent.name}: model=${signals.model} permissionMode=${signals.permissionMode}`);
    }
  }
}

const cfg = loadConfig();
if (ONCE) {
  await tick(cfg);
} else {
  console.log(`degradation watch up: ${cfg.agents.map(a => a.name).join(', ')} every ${cfg.intervalSec}s`);
  for (;;) {
    await tick(cfg);
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalSec * 1000));
  }
}
