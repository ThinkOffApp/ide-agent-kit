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

import { loadConfig } from '../src/config.mjs';
import {
  startConfirmationsServer,
  decideIntent,
  getIntent,
  createIntent,
  makeGroupmindAnnouncer,
  makeCodewatchAnnouncer,
  composeAnnouncers,
} from '../src/confirmations.mjs';

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
if (cc.room && apiKey) {
  serverAnnouncerMap.groupmind = makeGroupmindAnnouncer({
    apiKey, room: cc.room, callbackBase: cc.callback_base || `http://127.0.0.1:${cc.port || 8788}`,
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
});
console.log(`[iak-mcp-daemon] HTTP listener on http://${cc.host || '127.0.0.1'}:${cc.port || 8788} (POST /intent enabled: ${Object.keys(serverAnnouncerMap).join(',') || 'no announcers'})`);

// Chat-reply poller: watch the configured GroupMind room for "/approve <id>"
// and "/deny <id>" messages and route them to the local intent endpoint.
if (!apiKey) {
  console.warn('[iak-mcp-daemon] poller.api_key missing — chat-reply poller disabled');
} else if (!room) {
  console.warn('[iak-mcp-daemon] mcp.confirmations.room missing — chat-reply poller disabled');
} else {
  startChatReplyPoller({ apiKey, room, intervalMs: 5000 });
  console.log(`[iak-mcp-daemon] chat-reply poller watching room "${room}" every 5s`);
}

// Codewatch path: just announce when a message arrives at /push (not implemented
// here, would route through CodexMB's watch-gate.py — see PR #8).

// Manual ping: prove the round-trip by creating one demo intent on first run if
// --demo is passed.
if (argv.includes('--demo')) {
  const announcerMap = {};
  if (cc.room && apiKey) {
    announcerMap.groupmind = makeGroupmindAnnouncer({
      apiKey, room: cc.room, callbackBase: cc.callback_base || `http://127.0.0.1:${cc.port || 8788}`,
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

// --- helpers --------------------------------------------------------------

function startChatReplyPoller({ apiKey, room, intervalMs }) {
  const seen = new Set();
  let primed = false;
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
        const match = text.match(/^\/(approve|deny)\s+([a-f0-9]+)$/i);
        if (!match) continue;
        const decision = match[1].toLowerCase();
        const id = match[2];
        const intent = getIntent(id);
        if (!intent) {
          console.log(`[iak-mcp-daemon] /${decision} ${id} from ${m.from}: unknown intent, ignoring`);
          continue;
        }
        const r = decideIntent(id, decision);
        console.log(`[iak-mcp-daemon] /${decision} ${id} from ${m.from}: ${r.ok ? 'settled' : r.error}`);
      }
      primed = true;
    } catch (e) {
      console.warn(`[iak-mcp-daemon] poll error: ${e.message}`);
    }
  };
  poll();
  setInterval(poll, intervalMs);
}
