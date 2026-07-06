#!/usr/bin/env node
// webhook-wake.mjs — GroupMind webhook receiver that wakes the local agent.
//
// The ThinkOff/GroupMind platform can push new-message webhooks per agent
// (PUT /api/v1/agents/me/webhook). This receiver is the low-latency
// "doorbell": on a valid POST it fires the existing wake script
// (claudemb-wake.sh) which nudges the IDE session; the room poller and
// Claude Code hooks still deliver the message bodies as before, so this
// only removes the poll latency and adds no second content path.
//
// Security: listens on 127.0.0.1 only (expose via cloudflared tunnel),
// requires the shared secret as the URL path segment, wake-only semantics
// (no payload is executed or echoed anywhere), 10 wakes/min rate limit.
//
// Env: WEBHOOK_WAKE_SECRET (required), WEBHOOK_WAKE_PORT (default 8790),
//      WEBHOOK_WAKE_SCRIPT (default ../scripts/claudemb-wake.sh),
//      WEBHOOK_WAKE_SELF (default "@claudeMB" — skip own messages)
import http from 'node:http';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SECRET = process.env.WEBHOOK_WAKE_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('WEBHOOK_WAKE_SECRET missing or too short (>=16 chars)');
  process.exit(2);
}
const PORT = Number(process.env.WEBHOOK_WAKE_PORT || 8790);
const SELF = (process.env.WEBHOOK_WAKE_SELF || '@claudeMB').toLowerCase();
const WAKE = process.env.WEBHOOK_WAKE_SCRIPT ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'claudemb-wake.sh');
const LOG = '/tmp/webhook-wake.log';

const log = (line) => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(LOG, entry); } catch {}
  process.stdout.write(entry);
};

let wakeTimes = [];
const rateLimited = () => {
  const now = Date.now();
  wakeTimes = wakeTimes.filter((t) => now - t < 60_000);
  if (wakeTimes.length >= 10) return true;
  wakeTimes.push(now);
  return false;
};

const server = http.createServer((req, res) => {
  const ok = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(body); };
  if (req.method !== 'POST' || req.url !== `/hook/${SECRET}`) {
    log(`reject ${req.method} ${req.url?.slice(0, 32)}...`);
    return ok(404, 'not found');
  }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on('end', () => {
    ok(200, 'ok');
    let from = '', body = '', room = '';
    try {
      const p = JSON.parse(raw);
      from = String(p.from ?? p.sender ?? p.handle ?? '');
      body = String(p.body ?? p.message ?? p.text ?? '');
      room = String(p.room ?? p.room_slug ?? '');
    } catch { /* non-JSON payload: still wake */ }
    log(`event room=${room} from=${from} bytes=${raw.length} body=${body.slice(0, 120).replace(/\n/g, ' ')}`);
    if (from.toLowerCase() === SELF) return log('skip: own message');
    if (rateLimited()) return log('skip: rate limited');
    execFile('bash', [WAKE, 'check rooms'], { timeout: 30_000 }, (err) =>
      log(err ? `wake error: ${err.message}` : 'wake fired'));
  });
});
server.listen(PORT, '127.0.0.1', () => log(`webhook-wake listening on 127.0.0.1:${PORT}`));
