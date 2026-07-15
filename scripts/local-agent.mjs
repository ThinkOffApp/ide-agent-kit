#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// iak-local-agent — put a local (Ollama) model into a GroupMind room.
//
// Runs a small poll loop: read the room, and when a message @mentions this
// agent's handle, prompt the local model over Ollama's HTTP API and post the
// reply back — so an on-device model becomes a first-class room participant.
//
// It fails over between endpoints: it reads/writes cloud GroupMind when the
// internet is up, and the LAN GroupMind Local relay when it isn't. Point mm and
// mb agents at the same relay, flip the net off, and the local pair keeps
// talking — no cloud, no API keys, models running on-device.
//
// Zero runtime deps (global fetch + built-ins), matching the rest of IAK.
//
// Config (via runAgent(config) or env for the CLI):
//   handle          this agent's @handle (it never replies to itself)
//   room            room slug
//   cloud           { baseUrl, apiKey }   cloud GroupMind (preferred when up)
//   relay           { baseUrl, token? }   LAN relay (failover)
//   ollama          { url, model }        e.g. http://127.0.0.1:11434, gpt-oss:20b
//   systemPrompt    persona / instructions for the model
//   respondTo       'mention' (default) or 'all'
//   pollMs          poll interval (default 4000)
//   maxContext      how many recent messages to feed the model (default 8)

const MENTION = (handle) => new RegExp(`(^|[^\\w])@?${handle.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

export function mentions(body, handle) {
  return MENTION(handle).test(String(body || ''));
}

export function sameHandle(a, b) {
  return String(a || '').replace(/^@/, '').toLowerCase() === String(b || '').replace(/^@/, '').toLowerCase();
}

// Ask the local Ollama model for a reply. Returns trimmed text ('' on empty).
export async function generateReply({ url, model, systemPrompt, context }) {
  const res = await fetch(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: context },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const d = await res.json();
  // Strip thinking-model output (<think>...</think>) so room replies read clean —
  // the fleet's local models (e.g. qwen3.6 MoE) are reasoning models.
  return String(d?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function headersFor(ep) {
  const h = { 'Content-Type': 'application/json' };
  const key = ep.apiKey || ep.token;
  if (key) { h['X-API-Key'] = key; h['Authorization'] = `Bearer ${key}`; }
  return h;
}

async function fetchMessages(ep, room, limit) {
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(room)}/messages?limit=${limit}`,
    { headers: headersFor(ep), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
  const d = await res.json();
  return d?.messages || [];
}

async function postMessage(ep, room, body) {
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/messages`,
    { method: 'POST', headers: headersFor(ep), body: JSON.stringify({ room, body }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`post HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// Try cloud first, fall back to relay. Returns { ep, messages } or null.
async function readWithFailover(cfg, log) {
  const eps = [cfg.cloud, cfg.relay].filter((e) => e && e.baseUrl);
  for (const ep of eps) {
    try {
      const messages = await fetchMessages(ep, cfg.room, cfg.limit);
      return { ep, messages };
    } catch (e) {
      log(`read via ${ep.baseUrl} failed (${e.message}); trying next`);
    }
  }
  return null;
}

// One poll cycle. `state` carries { seen:Set, primed:bool }. Injectable deps
// (read/generate/post) make it unit-testable without a live room or model.
export async function tick(cfg, state, deps) {
  const read = deps?.read || (() => readWithFailover(cfg, deps.log));
  const generate = deps?.generate || generateReply;
  const post = deps?.post || postMessage;
  const log = deps?.log || (() => {});

  const r = await read();
  if (!r || !r.messages) return;
  const chronological = [...r.messages].reverse(); // room returns newest-first
  for (const m of chronological) {
    if (state.seen.has(m.id)) continue;
    state.seen.add(m.id);
    if (!state.primed) continue;                       // ignore history on the first cycle
    if (sameHandle(m.from, cfg.handle)) continue;      // never reply to ourselves
    if ((cfg.respondTo || 'mention') === 'mention' && !mentions(m.body, cfg.handle)) continue;
    try {
      const context = `${m.from}: ${m.body}`;
      const reply = await generate({ ...cfg.ollama, systemPrompt: cfg.systemPrompt, context });
      if (reply) { await post(r.ep, cfg.room, reply); log(`replied to ${m.from} (${reply.length} chars)`); }
    } catch (e) {
      log(`reply failed for ${m.id}: ${e.message}`);
    }
  }
  state.primed = true;
}

export async function runAgent(cfg) {
  const log = cfg.logger || ((m) => process.stderr.write(`[iak-local-agent:${cfg.handle}] ${m}\n`));
  const full = { limit: cfg.maxContext || 8, pollMs: cfg.pollMs || 4000, ...cfg };
  const state = { seen: new Set(), primed: false };
  log(`up — model=${cfg.ollama?.model} room=${cfg.room} respondTo=${cfg.respondTo || 'mention'}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(full, state, { log }); } catch (e) { log(`tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, full.pollMs));
  }
}

// CLI: config from IAK dogfood config + env overrides.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const cfgPath = process.env.IAK_CONFIG || '/Users/petrus/ide-agent-kit/config/dogfood.json';
  let base = {};
  try { base = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* fall back to env */ }
  runAgent({
    handle: process.env.AGENT_HANDLE || 'mm-local',
    room: process.env.AGENT_ROOM || base?.poller?.room || base?.mcp?.confirmations?.room || 'thinkoff-development',
    cloud: { baseUrl: 'https://groupmind.one/api/v1', apiKey: process.env.AGENT_KEY || base?.poller?.api_key },
    relay: process.env.RELAY_URL ? { baseUrl: process.env.RELAY_URL, token: process.env.IAK_RELAY_TOKEN } : undefined,
    ollama: { url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model: process.env.OLLAMA_MODEL || 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q2_K_XL' },
    systemPrompt: process.env.AGENT_SYSTEM
      || `You are ${process.env.AGENT_HANDLE || 'mm-local'}, a local on-device model running on a Mac mini in the ThinkOff fleet room. Be concise and useful. You run fully offline via Ollama.`,
    respondTo: process.env.AGENT_RESPOND_TO || 'mention',
  });
}
