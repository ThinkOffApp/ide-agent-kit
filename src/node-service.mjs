// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
const execute = promisify(execFile);

export function validateNode(c) {
  if (!c || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(c.id || '')) throw Error('Invalid node id');
  if (!/^@[a-z0-9_-]+$/i.test(c.handle || '')) throw Error('Invalid agent handle');
  if (!/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(c.host || '') || c.host.split('.').some(n => +n > 255)) throw Error('Bind host must be an explicit Tailscale IPv4 address');
  for (const k of ['keyFile', 'tokenFile', 'stateFile']) if (!c[k]?.startsWith('/')) throw Error(`${k} must be absolute`);
  for (const k of ['deliver', 'freshSession']) {
    if (!Array.isArray(c[k]) || !c[k].length || !c[k].every(x => typeof x === 'string' && !x.includes('\0')) || !c[k][0].startsWith('/')) throw Error(`${k} must be an absolute executable argv array`);
  }
  if (c.handle.toLowerCase() === '@deep' && !c.nodeTag) throw Error('Shared @deep requires an explicit nodeTag; prefer a distinct handle');
  if (c.nodeTag !== undefined && !/^\[node:[a-z0-9-]+\]$/.test(c.nodeTag)) throw Error('Invalid nodeTag');
  if (!Array.isArray(c.rooms) || !c.rooms.length || c.rooms.some(r => !/^[a-z0-9-]+$/.test(r))) throw Error('Invalid rooms');
  if (c.healthRoom && !c.rooms.includes(c.healthRoom)) throw Error('Health room must be watched');
  if (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)) throw Error('Invalid port');
  return c;
}
export async function runAdapter(argv, payload) {
  // Fixed argv only. Room bodies travel on stdin, never through a shell.
  const child = execute(argv[0], argv.slice(1), { timeout: 660000, maxBuffer: 65536 });
  child.child.stdin.end(JSON.stringify(payload));
  const { stdout } = await child;
  const result = JSON.parse(stdout);
  if (!['delivered', 'context_full', 'fresh'].includes(result.status)) throw Error('Invalid adapter receipt');
  return result;
}
export function createNode(c, { fetchImpl = fetch, adapter = runAdapter, save = null, now = Date.now, log = entry => console.error(JSON.stringify(entry)) } = {}) {
  validateNode(c);
  let state = { seen: [], pending: [], deadLetters: [], ready: false }, busy = false, lastError = null;
  const persist = async (...args) => {
    state.seen = state.seen.slice(-5000);
    if (save) return save(...args);
    const temporary = c.stateFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(c.stateFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, c.stateFile);
  };
  async function init() {
    try { state = JSON.parse(await readFile(c.stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    state.deadLetters ||= [];
    if (!Array.isArray(state.seen) || !Array.isArray(state.pending)) throw Error('Invalid delivery state');
  }
  async function tick() {
    if (busy) return false;
    busy = true;
    let stage = 'ack';
    try {
      try {
        const request = JSON.parse(await readFile(c.stateFile + '.ack', 'utf8'));
        if (!/^[a-z0-9-]+$/.test(request.id || '')) throw Error('InvalidAck');
        const archive = c.stateFile + '.attention-' + request.id + '.json';
        if (state.acknowledged !== request.id) {
          try { await writeFile(archive, JSON.stringify({deadLetters:state.deadLetters,skippedWindow:state.skippedWindow || null,acknowledgedAt:now()}), {mode:0o600,flag:'wx'}); }
          catch (e) { if (e.code !== 'EEXIST') throw e; }
          state.deadLetters=[]; delete state.skippedWindow; state.acknowledged=request.id;
          await persist(state); log({node:c.id,stage:'ack',errorClass:'AttentionArchived'});
        }
        await unlink(c.stateFile + '.ack');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      stage = 'read';
      const key = (await readFile(c.keyFile, 'utf8')).trim();
      for (const room of c.rooms) {
        const r = await fetchImpl(`https://groupmind.one/api/v1/rooms/${room}/messages?limit=100`, { headers: { Authorization: `Bearer ${key}`, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw Error(`Room read HTTP ${r.status}`);
        const { messages } = await r.json();
        if (!Array.isArray(messages) || messages.some(m => !m.id || typeof m.body !== 'string')) throw Error('Invalid room response');
        if (state.ready && messages.length >= 100 && !messages.some(m => state.seen.includes(m.id) || state.pending.some(p => p.id === m.id))) {
          state.gapFailures = (state.gapFailures || 0) + 1; await persist(state);
          if (state.gapFailures < 3) throw Error('CatchUpGap');
          state.skippedWindow = { room, oldest: messages.at(-1)?.id, newest: messages[0]?.id, at: now() };
          state.seen.push(...messages.map(m => m.id)); state.gapFailures = 0; await persist(state);
          log({stage:'read', errorClass:'CatchUpRebaseline', node:c.id});
        }
        for (const m of [...messages].reverse()) {
          if (state.seen.includes(m.id) || state.pending.some(p => p.id === m.id)) continue;
          const sender = typeof m.from === 'string' ? m.from : '';
          const mentioned = m.body.match(/@[a-z0-9_-]+/gi) || [];
          if (state.ready && sender.toLowerCase() !== c.handle.toLowerCase() && mentioned.some(h => h.toLowerCase() === c.handle.toLowerCase()) && (!c.nodeTag || m.body.includes(c.nodeTag))) state.pending.push({ ...m, room, from: sender });
          else state.seen.push(m.id);
        }
      }
      // First installation baselines room history; subsequent runs preserve pending work.
      state.ready = true;
      await persist(state);
      for (const message of [...state.pending]) {
        if ((message.retryAt || 0) > now()) continue;
        stage = 'delivery';
        try {
          let receipt = await adapter(c.deliver, { type: 'room_message', node: c.id, message, deliveryId: message.id });
          if (receipt.status === 'context_full') {
            stage = 'fresh';
            const fresh = await adapter(c.freshSession, { type: 'fresh_session', node: c.id, preservePending: true });
            if (fresh.status !== 'fresh') throw Error('FreshReceiptError');
            stage = 'delivery';
            receipt = await adapter(c.deliver, { type: 'room_message', node: c.id, message, deliveryId: message.id });
          }
          if (receipt.status !== 'delivered') throw Error('DeliveryReceiptError');
          state.pending = state.pending.filter(p => p.id !== message.id);
          state.seen.push(message.id);
        } catch {
          log({stage, errorClass:'AdapterFailure', node:c.id, deliveryId:message.id});
          message.attempts = (message.attempts || 0) + 1;
          message.retryAt = now() + 15000 * 2 ** (message.attempts - 1);
          if (message.attempts >= 3) {
            state.pending = state.pending.filter(p => p.id !== message.id);
            state.deadLetters.push(message); state.seen.push(message.id);
          }
        }
        state.seen = state.seen.slice(-5000); await persist(state);
      }
      lastError = state.pending.some(p => p.attempts) ? 'delivery_retry_pending' : null; return !lastError;
    } catch { lastError = 'poll_or_delivery_failed'; log({stage, errorClass:'NodeStageFailure', node:c.id}); return false; }
    finally { busy = false; }
  }
  const health = () => ({ node: c.id, status: lastError ? 'degraded' : state.ready ? 'ready' : 'starting', busy, pending: state.pending.length, attention:state.deadLetters.length + (state.skippedWindow ? 1 : 0), deadLetters:state.deadLetters.length, skippedWindow:state.skippedWindow || null, error: lastError });
  async function announce() {
    if (!c.healthRoom || busy) return;
    busy = true;
    try {
    const current = JSON.stringify({status:health().status,deadLetters:state.deadLetters.length,skipped:state.skippedWindow || null});
    if (state.announcedStatus === current) return;
    const key = (await readFile(c.keyFile, 'utf8')).trim();
    const response = await fetchImpl('https://groupmind.one/api/v1/messages', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: c.healthRoom, body: `IAK node ${c.id}: ${health().status}. Pending: ${state.pending.length}; dead letters: ${state.deadLetters.length}; skipped window: ${JSON.stringify(state.skippedWindow || null)}.`, client_message_id: `iak-node-${c.id}-${state.transition || 0}` }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error('Health publication failed');
    const result = await response.json(), message = result.message || result;
    if (message.from?.toLowerCase() !== c.handle.toLowerCase()) throw Error('Health sender mismatch');
    state.announcedStatus = current; state.transition = (state.transition || 0) + 1; await persist(state);
    } finally { busy = false; }
  }
  return { init, tick, health, announce };
}
export function wakeServer(node, token) {
  let lastWake = 0;
  return http.createServer((req, res) => {
    const provided = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(node.health())); return; }
    if (req.method === 'POST' && req.url === '/wake') {
      if (Date.now() - lastWake < 10000) { res.writeHead(429).end(); return; }
      lastWake = Date.now(); req.resume(); void node.tick(); res.writeHead(202).end(); return;
    }
    res.writeHead(404).end();
  });
}
export async function startNode(c) {
  const token = (await readFile(c.tokenFile, 'utf8')).trim();
  if (token.length < 32) throw Error('Wake token must contain at least 32 characters');
  const node = createNode(c); await node.init();
  const server = wakeServer(node, token);
  server.requestTimeout = 5000;
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(c.port || 8788, c.host, ok); });
  const poll = async () => { await node.tick(); try { await node.announce(); } catch { console.error(JSON.stringify({node:c.id,stage:'announce',errorClass:'HealthPublicationFailure'})); } };
  void poll();
  const timer = setInterval(() => void poll(), 15000);
  return { node, close: () => { clearInterval(timer); server.close(); } };
}
export function systemdUnit(configPath, executable, cliPath) {
  const quote = s => '"' + s.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  for (const p of [configPath, executable, cliPath]) if (!p.startsWith('/') || /[\r\n\0]/.test(p)) throw Error('Invalid service path');
  return `[Unit]\nDescription=IAK node room delivery and wake\nAfter=network-online.target\n[Service]\nExecStart=${[executable, cliPath, 'run', resolve(configPath)].map(quote).join(' ')}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n`;
}
