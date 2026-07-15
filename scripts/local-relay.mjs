#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// iak-local-relay — IAK's offline coordination hub.
//
// The fleet normally coordinates through cloud GroupMind (Vercel). When the
// internet is down but the machines are still on the same LAN (e.g. everyone
// home, ISP outage), there is no hub and the agents go silent. This is a small
// always-on service — meant to run on the Mac mini, the machine that never
// sleeps — that speaks the SUBSET of GroupMind's message API the fleet uses, so
// an agent can fail over to `http://<mini-lan-ip>:<port>/api/v1` and keep
// talking with zero internet.
//
// Scope (MVP): a LAN message store + serve. It is NOT the whole of GroupMind
// (no auth DB, no realtime, no reactions) and it does NOT yet reconcile its
// offline history back into cloud GroupMind when the internet returns — that
// sync-on-reconnect step (merge by message id) is the deliberate next PR. Every
// message it stores carries a UUID + `origin: "local-relay"` so that future
// sync can dedup and merge without reordering.
//
// Zero runtime deps (built-in http/fs/crypto only), matching the rest of IAK.
//
// Routes:
//   GET  /health
//   POST /api/v1/messages                      { room, body, from?, metadata? }
//   POST /api/v1/rooms/:room/messages          { body, from?, metadata? }
//   GET  /api/v1/rooms/:room/messages?limit=&since=
//
// Auth: if IAK_RELAY_TOKEN is set, every request must present it via X-API-Key
// or `Authorization: Bearer`. If unset, the relay is LAN-open (it logs one
// warning) — acceptable on a trusted home LAN, not on an untrusted network.
//
// Config (env or startRelay() args): IAK_RELAY_PORT (default 18790),
// IAK_RELAY_STORE (default ~/.iak/local-relay.jsonl), IAK_RELAY_TOKEN.

import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_PORT = 18790;
const DEFAULT_STORE = join(homedir(), '.iak', 'local-relay.jsonl');
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_BODY_BYTES = 256 * 1024; // reject absurd payloads

function readMessages(storePath) {
  if (!existsSync(storePath)) return [];
  const out = [];
  for (const line of readFileSync(storePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a corrupt line, never crash a read */ }
  }
  return out;
}

function appendMessage(storePath, msg) {
  mkdirSync(dirname(storePath), { recursive: true });
  appendFileSync(storePath, JSON.stringify(msg) + '\n');
}

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Build a stored message from an incoming create request. Returns { msg } or
// { error } for a validation failure.
function buildMessage({ room, body, from, metadata }) {
  if (!room || typeof room !== 'string') return { error: 'room is required' };
  if (!body || typeof body !== 'string') return { error: 'body is required' };
  return {
    msg: {
      id: randomUUID(),
      room,
      from: typeof from === 'string' && from ? from : 'unknown',
      body,
      metadata: metadata ?? null,
      created_at: new Date().toISOString(),
      origin: 'local-relay',
    },
  };
}

/**
 * Start the relay. Returns the http.Server (already listening).
 * @param {{port?:number, storePath?:string, token?:string, logger?:(m:string)=>void}} opts
 */
export function startRelay(opts = {}) {
  const envPort = Number(process.env.IAK_RELAY_PORT);
  const port = opts.port ?? (Number.isFinite(envPort) ? envPort : DEFAULT_PORT);
  const storePath = opts.storePath ?? process.env.IAK_RELAY_STORE ?? DEFAULT_STORE;
  const token = opts.token ?? process.env.IAK_RELAY_TOKEN ?? '';
  const log = opts.logger ?? ((m) => process.stderr.write(`[iak-local-relay] ${m}\n`));

  if (!token) log('WARNING: no IAK_RELAY_TOKEN set — relay is LAN-open (fine on a trusted home LAN only).');

  function authorized(req) {
    if (!token) return true;
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    return req.headers['x-api-key'] === token || bearer === token;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, service: 'iak-local-relay', messages: readMessages(storePath).length });
      }

      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

      // GET /api/v1/rooms/:room/messages
      const getMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/);
      if (req.method === 'GET' && getMatch) {
        const room = decodeURIComponent(getMatch[1]);
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT), MAX_LIMIT);
        const since = url.searchParams.get('since');
        let msgs = readMessages(storePath).filter((m) => m.room === room);
        if (since) msgs = msgs.filter((m) => m.created_at > since);
        // JSONL append order IS chronological, so it orders even messages that
        // share a millisecond timestamp. Take the last `limit` (newest) and
        // reverse to newest-first, matching GroupMind's shape.
        const messages = msgs.slice(-limit).reverse();
        return send(res, 200, { messages, count: messages.length });
      }

      // POST /api/v1/messages  { room, body, ... }
      if (req.method === 'POST' && path === '/api/v1/messages') {
        const b = await readJsonBody(req);
        const { msg, error } = buildMessage({ room: b.room, body: b.body, from: b.from, metadata: b.metadata });
        if (error) return send(res, 400, { error });
        appendMessage(storePath, msg);
        return send(res, 201, msg);
      }

      // POST /api/v1/rooms/:room/messages  { body, ... }
      const postMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/);
      if (req.method === 'POST' && postMatch) {
        const room = decodeURIComponent(postMatch[1]);
        const b = await readJsonBody(req);
        const { msg, error } = buildMessage({ room, body: b.body, from: b.from, metadata: b.metadata });
        if (error) return send(res, 400, { error });
        appendMessage(storePath, msg);
        return send(res, 201, msg);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = /payload too large/.test(err?.message) ? 413 : /invalid JSON/.test(err?.message) ? 400 : 500;
      return send(res, status, { error: err?.message || 'internal error' });
    }
  });

  server.listen(port, () => log(`listening on :${port}  store=${storePath}`));
  return server;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };
  startRelay({
    port: Number(arg('--port')) || undefined,
    storePath: arg('--store'),
    token: arg('--token'),
  });
}
