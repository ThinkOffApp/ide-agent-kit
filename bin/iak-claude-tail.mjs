#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Tails Claude Code transcript JSONL files and forwards user/assistant
// messages to the IAK daemon's /ide-chat/<handle> endpoint, so CodeWatch
// can render the IDE conversation as a per-handle channel.
//
// Run:  node bin/iak-claude-tail.mjs
//
// Env:
//   IAK_HANDLE          (default: @claudemm) — handle this tail represents
//   IAK_DAEMON_URL      (default: http://127.0.0.1:8788)
//   IAK_DAEMON_TOKEN    (default: contents of IAK_DAEMON_TOKEN_FILE) — Bearer
//   IAK_DAEMON_TOKEN_FILE (default: ~/.config/iak-gate.token)
//   IAK_TAIL_INTERVAL   (default: 2000) — poll interval in ms
//   IAK_PROJECTS_DIR    (default: ~/.claude/projects)
//   IAK_TAIL_INCLUDE_TOOLS (default: 0) — 1 to include tool_use / tool_result
//   IAK_TAIL_MAX_TEXT   (default: 4000) — clamp text length per event

import { readdir, stat, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HANDLE = process.env.IAK_HANDLE || '@claudemm';
const DAEMON_URL = (process.env.IAK_DAEMON_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
// The daemon requires a Bearer token on every route since the :8788 auth
// hardening — without it this tail 401s silently and the IDE channel in
// CodeWatch stays empty. Token from env, else the standard gate token file.
const DAEMON_TOKEN = process.env.IAK_DAEMON_TOKEN || (() => {
  const file = process.env.IAK_DAEMON_TOKEN_FILE || join(homedir(), '.config', 'iak-gate.token');
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
})();
const POLL_MS = parseInt(process.env.IAK_TAIL_INTERVAL || '2000', 10);
const PROJECTS_DIR = process.env.IAK_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const INCLUDE_TOOLS = process.env.IAK_TAIL_INCLUDE_TOOLS === '1';
const MAX_TEXT = parseInt(process.env.IAK_TAIL_MAX_TEXT || '4000', 10);
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRIME_BYTES = 64 * 1024;

const positions = new Map();

async function findActiveSessions() {
  const out = [];
  let projects;
  try {
    projects = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projDir = join(PROJECTS_DIR, p.name);
    let files;
    try { files = await readdir(projDir); } catch { continue; }
    let latest = null;
    let latestMtime = 0;
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(projDir, f);
      try {
        const s = await stat(full);
        if (s.mtimeMs > latestMtime) {
          latestMtime = s.mtimeMs;
          latest = full;
        }
      } catch {}
    }
    if (latest && now - latestMtime < ACTIVE_WINDOW_MS) {
      out.push({ path: latest, project: p.name, mtimeMs: latestMtime });
    }
  }
  return out;
}

async function readNewLines(path) {
  let s;
  try { s = await stat(path); } catch { return []; }
  let startPos = positions.get(path);
  if (startPos === undefined) {
    // Prime: only read the tail of the file on first encounter so we
    // don't replay history when the script (re)starts.
    startPos = Math.max(0, s.size - PRIME_BYTES);
  }
  if (s.size <= startPos) return [];
  let fh;
  try { fh = await open(path, 'r'); } catch { return []; }
  try {
    const buf = Buffer.alloc(s.size - startPos);
    await fh.read(buf, 0, buf.length, startPos);
    positions.set(path, s.size);
    let text = buf.toString('utf-8');
    // If we primed mid-line, drop the partial leading line.
    if (startPos > 0 && !text.startsWith('{')) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split('\n').filter(Boolean);
  } finally {
    await fh.close();
  }
}

function extractEvent(obj, sessionId) {
  const t = obj.type;
  if (!['user', 'assistant'].includes(t)) return null;
  const msg = obj.message || {};
  let content = msg.content;
  let toolCalls = [];
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c !== 'object' || c === null) {
        parts.push(String(c));
      } else if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'tool_use') {
        if (INCLUDE_TOOLS) {
          toolCalls.push({ name: c.name, input: c.input });
          parts.push(`[tool_use ${c.name}]`);
        }
      } else if (c.type === 'tool_result') {
        if (INCLUDE_TOOLS) {
          parts.push(`[tool_result] ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content).slice(0, 200)}`);
        }
      }
    }
    content = parts.join('\n').trim();
  } else if (typeof content !== 'string') {
    content = String(content ?? '');
  }
  if (!content && toolCalls.length === 0) return null;
  return {
    handle: HANDLE,
    role: t,
    text: content.slice(0, MAX_TEXT),
    ts: obj.timestamp || new Date().toISOString(),
    session_id: sessionId || obj.sessionId || null,
    tool_calls: INCLUDE_TOOLS && toolCalls.length ? toolCalls : undefined,
  };
}

async function postEvent(event) {
  try {
    const res = await fetch(`${DAEMON_URL}/ide-chat/${encodeURIComponent(HANDLE)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DAEMON_TOKEN ? { Authorization: `Bearer ${DAEMON_TOKEN}` } : {}),
      },
      body: JSON.stringify(event),
    });
    if (res.status === 401) {
      console.warn('[iak-claude-tail] daemon 401 — set IAK_DAEMON_TOKEN or IAK_DAEMON_TOKEN_FILE (default ~/.config/iak-gate.token)');
    } else if (!res.ok && res.status !== 404) {
      console.warn(`[iak-claude-tail] daemon ${res.status} on POST /ide-chat`);
    }
  } catch (e) {
    console.warn(`[iak-claude-tail] post failed: ${e.message}`);
  }
}

async function poll() {
  const sessions = await findActiveSessions();
  for (const sess of sessions) {
    const lines = await readNewLines(sess.path);
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const event = extractEvent(obj, obj.sessionId);
      if (event) await postEvent(event);
    }
  }
}

console.log(`[iak-claude-tail] handle=${HANDLE} daemon=${DAEMON_URL} dir=${PROJECTS_DIR} interval=${POLL_MS}ms tools=${INCLUDE_TOOLS}`);
poll();
setInterval(poll, POLL_MS);
