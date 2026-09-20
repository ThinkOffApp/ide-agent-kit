#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0

/**
 * uik-daemon — persistent UIK adapter runner.
 *
 * Publishes desktop state and agent heartbeats to the intent API.
 * Intended to be launched via launchd/systemd/tmux as a long-running
 * background daemon.
 *
 * Environment:
 *   INTENT_API_BASE    (default: https://groupmind.one/api/v1)
 *   INTENT_API_KEY     required
 *   INTENT_USER_ID     required
 *   INTENT_AGENT_HANDLE  default: @agent
 *   INTENT_DEVICE_ID     default: hostname
 *   INTENT_DEVICE_KIND   default: unset - the row's type label in the
 *                        devices view (mac-mini, car-pi, linux-server).
 *                        Without it a row renders with a blank type,
 *                        which is how the M5 first appeared (2026-08-29).
 *   INTENT_MODEL_ENDPOINT default: 127.0.0.1:8080 - a local
 *                        OpenAI-compatible server, asked on its own timer
 *                        what it is serving; whatever it names goes on the
 *                        device card VERBATIM. Nothing listening, or a
 *                        server listing nothing loaded, publishes no model
 *                        field at all - the dashboard renders a card
 *                        without a label, which is the honest picture. Set
 *                        to `off` to disable the probe.
 *                        NOT Ollama's 11434 by default: its /v1/models is
 *                        the PULLED catalogue, so it names a model on a
 *                        machine running none (measured 20 Sep 2026).
 *   INTENT_MODEL_KIND    default: openai - openai | vllm | lmstudio, only
 *                        to pick the models path LM Studio spells
 *                        differently.
 *   INTENT_MODEL_KEY_FILE default: unset - a PATH to a file holding the
 *                        bearer token, never the token itself. Without it
 *                        an endpoint that wants auth answers 401, and a
 *                        401 publishes NO model: that box is serving
 *                        something we cannot name, and a placeholder on a
 *                        public dashboard is worse than a blank field.
 *   INTENT_MODEL_PROBE_MS default: 300000 - the probe's own interval,
 *                        deliberately slower than POLL_INTERVAL_MS. The
 *                        heartbeat reads a cached value and never waits on
 *                        the model endpoint, so a dead LLM costs a label
 *                        and never a whole machine.
 *   INTENT_DEVICE_MODEL  default: unset - the operator's statement of what
 *                        this box serves. LAST RESORT: it applies only
 *                        when nothing answered the probe, because a server
 *                        that answered has just told us the truth and a
 *                        setting can only be stale. On Linux a running
 *                        llama-server's own argv is still read on every
 *                        poll when neither of the two above produced a
 *                        name.
 *   INTENT_DEVICE_PUBLISH default: 1 - set to 0 on a SECONDARY daemon (a
 *                        second agent's presence beat on the same machine)
 *                        so exactly one daemon owns the device row; two
 *                        writers race and the row flickers, which is how
 *                        the MacBook "disappeared" (2026-08-29).
 *   POLL_INTERVAL_MS     default: 30000
 */

import { hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { IntentClient, IAKAdapter, DesktopAdapter, ServedModelProbe, defaultSearchRoots } from '../src/index.js';

const baseUrl = process.env.INTENT_API_BASE || 'https://groupmind.one/api/v1';
const apiKey = process.env.INTENT_API_KEY;
const userId = process.env.INTENT_USER_ID;
const agentHandle = process.env.INTENT_AGENT_HANDLE || '@agent';
const deviceId = process.env.INTENT_DEVICE_ID || hostname();
const deviceKind = process.env.INTENT_DEVICE_KIND || undefined;
const deviceModel = process.env.INTENT_DEVICE_MODEL || undefined;
const modelProbe = new ServedModelProbe();
const publishDevice = process.env.INTENT_DEVICE_PUBLISH !== '0';
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 30000);

if (!apiKey || !userId) {
  console.error('uik-daemon: INTENT_API_KEY and INTENT_USER_ID required');
  process.exit(1);
}

// The single most common misconfiguration (hit twice on 2026-07-31 alone,
// including 27 silent days on one machine): the AGENT handle placed in
// INTENT_USER_ID. The API accepts any string and silently creates a new
// user document, so the daemon "works" while the real dashboard stays
// stale. Warn loudly; do not exit, in case someone genuinely named their
// user after an agent.
if (userId.toLowerCase() === agentHandle.replace(/^@/, '').toLowerCase()) {
  console.error(
    `uik-daemon: WARNING - INTENT_USER_ID (${userId}) equals the agent handle. ` +
    'INTENT_USER_ID must be the human user whose dashboard these heartbeats feed; ' +
    'heartbeats are likely going to the wrong document.'
  );
}

const client = new IntentClient({ baseUrl, apiKey, userId, deviceId });
const iak = new IAKAdapter(client, { agentHandle, machine: deviceId });
const desktop = new DesktopAdapter(client, {
  pollIntervalMs, machine: deviceId, kind: deviceKind, model: deviceModel, modelProbe,
});

if (publishDevice) desktop.start();

// Re-publish agent status on the same interval as the desktop heartbeat,
// otherwise the agent slot expires after its TTL while the device stays
// fresh — caught dogfooding on 2026-04-08.
// Optional honesty gate: when INTENT_AGENT_GATE_CMD is set, the agent
// beat only publishes while that command exits 0 (e.g. `launchctl list
// com.example.agent-supervisor`). Without it, a daemon on a timer reports
// an agent as active forever, even when the agent process is long dead.
const gateCmd = process.env.INTENT_AGENT_GATE_CMD || null;
function gateOpen() {
  if (!gateCmd) return true;
  try { execSync(gateCmd, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (gateOpen()) await iak.publishStatus({ status: 'active', currentTask: null });

const agentTimer = setInterval(() => {
  if (!gateOpen()) return;
  iak.publishStatus({ status: 'active', currentTask: null }).catch(() => {});
}, pollIntervalMs);

console.log(`uik-daemon: device=${deviceId} agent=${agentHandle} interval=${pollIntervalMs}ms`);
// Which endpoint the model label comes from, so a blank label on the
// dashboard can be traced to a port rather than guessed at. Never a token:
// describe() reports only that a keyFile is configured.
console.log(`uik-daemon: model probe -> ${modelProbe.describe()}`);
// And where the weaker claim comes from. A card reading "available and fits"
// should be traceable to a directory somebody can list, not to a guess.
console.log(`uik-daemon: model scan  -> ${defaultSearchRoots().join(', ')}`);

const shutdown = async (sig) => {
  console.log(`uik-daemon: ${sig}, shutting down`);
  clearInterval(agentTimer);
  desktop.stop();
  await iak.publishStatus({ status: 'offline', currentTask: null }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the event loop alive
setInterval(() => {}, 1 << 30);
