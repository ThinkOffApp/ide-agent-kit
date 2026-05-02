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
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(port, host);
  return server;
}

// --- announcers ------------------------------------------------------------

// Post the intent prompt to a GroupMind room with quick-reply text the user
// can copy / type, and a curl example for the watch-gate. Idempotent (same
// id is harmless).
export function makeGroupmindAnnouncer({ apiKey, room, callbackBase }) {
  return async ({ id, prompt, session }) => {
    if (!apiKey || !room) return;
    const body =
      `[Confirmation needed] **${prompt}**\n` +
      `Target session: \`${session || '(none)'}\`\n` +
      `Approve: \`/approve ${id}\` · Deny: \`/deny ${id}\`\n` +
      (callbackBase
        ? `Or: \`curl -X POST ${callbackBase}/intent/${id}/decision -H 'Content-Type: application/json' -d '{"decision":"approve"}'\``
        : '');
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
