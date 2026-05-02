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
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// --- registry ---------------------------------------------------------------

// id -> {prompt, session, channels, status, createdAt, decidedAt, decision, resolvers}
const intents = new Map();

function postReceipt(receiptsPath, entry) {
  if (!receiptsPath) return;
  try {
    appendFileSync(receiptsPath, JSON.stringify(entry) + '\n');
  } catch {
    // never crash the bridge on a receipt write
  }
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
  }));
}

export function getIntent(id) {
  const i = intents.get(id);
  if (!i) return null;
  return {
    id,
    prompt: i.prompt,
    session: i.session,
    channels: i.channels,
    status: i.status,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt,
    decision: i.decision,
  };
}

// Decide an intent. Returns true if decided, false if id unknown or already
// decided. Idempotent for same decision; rejects different decision after
// settle.
export function decideIntent(id, decision, { receiptsPath } = {}) {
  if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, error: 'decision must be "approve" or "deny"' };
  }
  const i = intents.get(id);
  if (!i) return { ok: false, error: `unknown intent ${id}` };
  if (i.status !== 'pending') {
    if (i.decision === decision) return { ok: true, idempotent: true };
    return { ok: false, error: `intent ${id} already decided as ${i.decision}` };
  }
  i.status = 'decided';
  i.decision = decision;
  i.decidedAt = Date.now();
  postReceipt(receiptsPath, {
    kind: 'intent.decided', id, decision, decidedAt: i.decidedAt, prompt: i.prompt,
  });
  // Resolve waiters.
  for (const r of i.resolvers) {
    try { r({ decision, id }); } catch {}
  }
  i.resolvers = [];
  return { ok: true };
}

// Create + announce a confirmation intent. Returns intent id immediately.
// `announce` is an injectable side-effect (groupmindPost / codewatchPush) for
// testability — production code passes the real posters.
export async function createIntent({
  prompt,
  session,
  channels = ['groupmind'],
  timeoutSec = 600,
  announce = async () => {},
  receiptsPath,
}) {
  const id = randomUUID().slice(0, 8);
  const intent = {
    prompt,
    session,
    channels,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decision: null,
    resolvers: [],
    timeoutSec,
  };
  intents.set(id, intent);
  postReceipt(receiptsPath, {
    kind: 'intent.created', id, prompt, session, channels, createdAt: intent.createdAt,
  });
  // Side effects — never let an announce failure block the intent itself.
  try {
    await announce({ id, prompt, session, channels });
  } catch (e) {
    postReceipt(receiptsPath, {
      kind: 'intent.announce_failed', id, error: e.message,
    });
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

// --- HTTP listener ---------------------------------------------------------

// Tiny built-in HTTP server. POST /intent/:id/decision accepts the decision
// from any caller (Codewatch action, GroupMind reply poller, manual curl).
// Auth is a shared bearer token if configured; otherwise local-only by host bind.
export function startConfirmationsServer({
  port = 8788,
  host = '127.0.0.1',
  authToken = '',
  receiptsPath,
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listIntents()));
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
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(port, host);
  return server;
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
    const sig = intents.map(i => i.id + i.status).join('|');
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
      el.innerHTML =
        '<div class="prompt"></div>' +
        '<div class="meta"></div>' +
        (i.status === 'pending'
          ? '<div class="row"><div class="btn ok" data-d="approve">Approve</div><div class="btn no" data-d="deny">Deny</div></div>'
          : '<span class="pill ' + i.decision + '">' + i.decision + '</span>');
      el.querySelector('.prompt').textContent = i.prompt;
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
export function makeGroupmindAnnouncer({ apiKey, room, callbackBase }) {
  return async ({ id, prompt, session }) => {
    if (!apiKey || !room) return;
    const uiLink = callbackBase ? `${callbackBase}/` : null;
    const body =
      `[Confirmation needed] **${prompt}**\n` +
      `Target session: \`${session || '(none)'}\`\n` +
      (uiLink ? `Tap to decide: ${uiLink}\n` : '') +
      `Or reply: \`/approve ${id}\` · \`/deny ${id}\``;
    const data = JSON.stringify({ room, body });
    const req = await import('node:https');
    return new Promise((resolve, reject) => {
      const r = req.request(
        'https://groupmind.one/api/v1/messages',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey } },
        (res) => {
          // drain + resolve regardless; the message-id isn't useful here.
          res.resume();
          res.on('end', () => resolve());
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
    if (!gateUrl) return;
    const data = JSON.stringify({ id, prompt, session });
    const url = new URL(gateUrl);
    const lib = await import(url.protocol === 'https:' ? 'node:https' : 'node:http');
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (gateToken) headers.Authorization = `Bearer ${gateToken}`;
      const r = lib.request(gateUrl, { method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  };
}

// Fan-out: build a single announce function from per-channel announcers.
export function composeAnnouncers(map) {
  return async (intent) => {
    for (const ch of intent.channels) {
      const fn = map[ch];
      if (!fn) continue;
      try { await fn(intent); } catch (e) {
        // log but continue to other channels
        process.stderr.write(`[iak-mcp] announce ${ch} failed: ${e.message}\n`);
      }
    }
  };
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
