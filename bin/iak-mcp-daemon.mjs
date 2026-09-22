#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Long-running daemon flavor of the MCP confirmation flow. Keeps the HTTP
// listener up + watches the configured GroupMind room for `/approve <id>` and
// `/deny <id>` quick-reply messages and routes them to the local
// /intent/:id/decision endpoint.
//
// Used together with the MCP server: an MCP client triggers
// request_confirmation which posts to the room with an intent id; the user
// replies "/approve abc12345" from the watch / chat; this daemon catches the
// reply and POSTs it to the same HTTP listener that the MCP tool is waiting
// on; the MCP tool resolves with {decision: "approve"}.
//
// Run: node bin/iak-mcp-daemon.mjs [--config path/to/config.json]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { defaultCallbackBase,
  startConfirmationsServer,
  startChatReplyPoller,
  configureActionStatusPush,
  createIntent,
  makeGroupmindAnnouncer,
  makeCodewatchAnnouncer,
  composeAnnouncers,
  registerKindHandler,
} from '../src/confirmations.mjs';
import { applyChoice, resolveModelRegistryPath, resolveModelSelectionPath } from '../src/model-selection.mjs';
import { resolveCallerHost } from '../packages/user-intent-kit/src/model-capacity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let configPath;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--config' && argv[i + 1]) { configPath = argv[i + 1]; i++; }
}
const config = await loadConfig(configPath);
const cc = config?.mcp?.confirmations || {};
if (!cc.room && !cc.codewatch_gate_url) {
  process.stderr.write('[iak-mcp-daemon] no mcp.confirmations channels configured — exiting\n');
  process.exit(2);
}

// Build the announcer map up-front so the HTTP server can use it for
// externally-created intents (POST /intent).
const apiKey = config?.poller?.api_key;
const room = cc.room;

const serverAnnouncerMap = {};
const callbackBase = defaultCallbackBase(cc, undefined, (pick, all) => {
  if (!pick) console.log('[iak-mcp-daemon] callback_base: no LAN IPv4 found, cards will link to 127.0.0.1');
  else console.log(`[iak-mcp-daemon] callback_base: ${pick.address} on ${pick.name}` + (all.length > 1 ? ` (also ${all.slice(1).map((c) => `${c.address}@${c.name}`).join(', ')})` : ''));
});
if (cc.room && apiKey) {
  serverAnnouncerMap.groupmind = makeGroupmindAnnouncer({
    apiKey, room: cc.room, callbackBase,
    // Per-agent author attribution: configure
    // `mcp.confirmations.api_keys` as { "@CodexMB": "xfb_...", ... }
    // and forwarding daemons that include `from_handle` in POST /intent
    // bodies will have their announcement authored by that agent.
    apiKeys: cc.api_keys || {},
  });
}
if (cc.codewatch_gate_url) {
  serverAnnouncerMap.codewatch = makeCodewatchAnnouncer({
    gateUrl: cc.codewatch_gate_url, gateToken: cc.codewatch_gate_token,
  });
}
const serverAnnounce = composeAnnouncers(serverAnnouncerMap);

// Wire the picker's apply step to the ONE place every decision path already
// funnels through (decideIntent, inside src/confirmations.mjs) instead of the
// daemon having to notice a decided model intent itself. Whether the tap
// arrived via CodeWatch's /intent/:id/decision POST, the GroupMind
// chat-reply poller below, or a manual approve_intent/deny_intent call, this
// fires once, here, on this box. bin/model-picker.mjs's OWN raise-and-wait
// flow does NOT tag its intents with kind: "model" (see src/model-selection.mjs),
// so a `model-picker.mjs` run against this daemon applies via its own
// in-process re-probe exactly as before, and this hook only fires for
// choices raised WITHOUT the CLI (request_model_choice, or any future
// caller) — never both, so a tap is never applied twice.
// resolveModelRegistryPath/resolveModelSelectionPath are the SAME functions
// src/mcp-server.mjs's request_model_choice calls to decide what to probe and
// offer - both read mcp.confirmations.model_registry /
// .model_selection_path off the same config shape, so a custom path
// configured once is seen identically by the offer and the apply. Reading
// the key at two different nesting levels in two files was the exact bug
// this replaced: a custom registry would silently offer from one file and
// apply against another.
const modelRegistryPath = resolveModelRegistryPath(config, ROOT);
const modelSelectionPath = resolveModelSelectionPath(config);
registerKindHandler('model', async ({ id, decision, offeredModels }) => {
  const callerHost = await resolveCallerHost();
  const offeredModel = offeredModels?.[decision] ?? null;
  const result = await applyChoice({
    registryPath: modelRegistryPath,
    selectionPath: modelSelectionPath,
    entryId: decision,
    callerHost,
    intentId: id,
    offeredModel,
  });
  if (result.outcome === 'applied' || result.outcome === 'applied-sole-up') {
    const changedNote = result.modelChanged
      ? ` [model changed since offer: ${result.modelChanged.offered} -> ${result.modelChanged.applied}]`
      : '';
    console.log(`[iak-mcp-daemon] model choice ${id}: applied ${result.selection.selectedId} -> ${result.selection.baseUrl} (model=${result.selection.model})${changedNote}`);
  } else {
    console.warn(`[iak-mcp-daemon] model choice ${id}: NOT applied (${result.outcome})${result.error ? ` — ${result.error}` : ''}`);
  }
});

// Start the HTTP listener first so any decisions can settle.
// Wake script: defaults to scripts/claudemb-wake.sh in this repo.
// Override via mcp.confirmations.wake_script in config.
const wakeScript = cc.wake_script ||
  new URL('../scripts/claudemb-wake.sh', import.meta.url).pathname;

startConfirmationsServer({
  port: cc.port || 8788,
  host: cc.host || '127.0.0.1',
  authToken: cc.auth_token || '',
  receiptsPath: config?.receipts?.path,
  announce: serverAnnounce,
  wakeScript,
  sessions: cc.sessions,
});
console.log(`[iak-mcp-daemon] HTTP listener on http://${cc.host || '127.0.0.1'}:${cc.port || 8788} (POST /intent enabled: ${Object.keys(serverAnnouncerMap).join(',') || 'no announcers'})`);

// Chat-reply poller: watch the configured GroupMind room for "/approve <id>"
// and "/deny <id>" messages and route them to the local intent endpoint.
if (!apiKey) {
  console.warn('[iak-mcp-daemon] poller.api_key missing — chat-reply poller disabled');
} else if (!room) {
  console.warn('[iak-mcp-daemon] mcp.confirmations.room missing — chat-reply poller disabled');
} else {
  // Poll cadence is a COST decision, not a detail: at the old hard-wired 5000 ms
  // this one poller made 17,280 requests a day per device, and the host bills per
  // invocation (2026-09-12: the fleet's Vercel bill passed 200 USD/month, ~99% of
  // it request volume). The adjacent poller.interval_sec key already existed in
  // config and was silently ignored here. Default is unchanged so nobody's
  // latency moves without them asking.
  // Two different jobs share this one loop, and they want opposite things.
  // Reading the room is paid for per request. Carrying petrus's /approve tap is
  // the only interval in the fleet a HUMAN feels: 30 seconds after tapping
  // Approve reads as broken, not thrifty (claudeMB on PR #101). So the gate gets
  // its own key and falls back to the cheap one, then to the old default — which
  // means nobody's latency moves unless they set something.
  const pollerIntervalMs = Math.max(1000, Number(
    config?.mcp?.confirmations?.interval_sec
    ?? config?.poller?.interval_sec
    ?? 5) * 1000);
  startChatReplyPoller({
    apiKey, room, intervalMs: pollerIntervalMs,
    // Exact owner identities allowed to settle intents (config, with the
    // fleet's known surfaces as the default). Every surface the owner taps
    // from must be listed — an unlisted one gets a VISIBLE rejection reply,
    // never silence.
    owners: config?.mcp?.confirmations?.owners || ['petrus', 'petrus-boox'],
    log: (msg) => console.log(`[iak-mcp-daemon] ${msg}`),
  });
  console.log(`[iak-mcp-daemon] chat-reply poller watching room "${room}" every ${pollerIntervalMs / 1000}s`);
  // Mirror every intent/action transition to the central action_status store
  // (antfarm PR #43) so CodeWatch renders durable button state off-LAN.
  const pushBase = config?.groupmind?.base_url || config?.groupmind?.baseUrl || 'https://groupmind.one/api/v1';
  if (configureActionStatusPush({
    apiKey, baseUrl: pushBase,
    log: (msg) => console.log(`[iak-mcp-daemon] ${msg}`),
  })) {
    console.log('[iak-mcp-daemon] action-status push: enabled (durable off-LAN button state)');
  }
}

// Codewatch path: just announce when a message arrives at /push (not implemented
// here, would route through CodexMB's watch-gate.py — see PR #8).

// Manual ping: prove the round-trip by creating one demo intent on first run if
// --demo is passed.
if (argv.includes('--demo')) {
  const announcerMap = {};
  if (cc.room && apiKey) {
    announcerMap.groupmind = makeGroupmindAnnouncer({
      apiKey, room: cc.room, callbackBase: defaultCallbackBase(cc),
    });
  }
  if (cc.codewatch_gate_url) {
    announcerMap.codewatch = makeCodewatchAnnouncer({
      gateUrl: cc.codewatch_gate_url, gateToken: cc.codewatch_gate_token,
    });
  }
  const announce = composeAnnouncers(announcerMap);
  const id = await createIntent({
    prompt: 'iak-mcp-daemon demo: approve to confirm the round-trip works.',
    session: 'demo',
    channels: Object.keys(announcerMap),
    announce,
    receiptsPath: config?.receipts?.path,
  });
  console.log(`[iak-mcp-daemon] demo intent created: id=${id}`);
}

// Keep the process alive.
process.stdin.resume();

// The chat-reply poller now lives in src/confirmations.mjs (startChatReplyPoller)
// so the in-process MCP confirmations server can run it too. See the import above.
