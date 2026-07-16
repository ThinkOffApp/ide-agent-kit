// SPDX-License-Identifier: AGPL-3.0-only
//
// send-to-session: deliver a text message as user input into a named
// agent's live session. This is the backend primitive behind CodeWatch's
// send box — the uniform way to drive ANY agent (desktop-app, tmux,
// or an agent owned by another machine's daemon) from the phone.
//
// Config block (ide-agent-kit.json / dogfood.json):
//
//   "sessions": {
//     "agents": {
//       "claudemm": { "adapter": "wake", "script": "/path/gui-wake.sh" },
//       "sally":    { "adapter": "tmux", "tmux_session": "sally" },
//       "claudemb": { "adapter": "forward", "peer": "http://192.168.50.x:8788",
//                     "token_file": "~/.config/iak-gate.token" },
//       // and on the OWNING machine's daemon:
//       // "claudemb": { "adapter": "gui", "script": "/path/gui-nudge.sh",
//       //               "idle_guard": "/path/human-idle-guard.sh" }
//     }
//   }
//
// Adapters:
//   wake    — spawn script with the text as its only argument (the /wake
//             pattern; the script owns focusing/typing/logging).
//   gui     — like wake, but when idle_guard is set the guard runs first
//             with --wait so injection never types over a human at the
//             keyboard.
//   tmux    — literal send-keys into the tmux session, then Enter.
//   forward — POST the same body to the owning machine's daemon.
//
// Delivery is accepted-async (202): spawn-based adapters detach, so a
// guard that waits minutes for the human to go idle never blocks the
// HTTP response.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const MAX_TEXT_LENGTH = 4000;
const MAX_FROM_LENGTH = 200;
const FORWARD_TIMEOUT_MS = 8000;
// One forward, ever: app → reachable daemon → owning daemon. The owning
// daemon must deliver locally; a second hop means a misconfigured peer
// chain (worst case a peer pointing back at itself), so it is refused
// instead of retried.
const MAX_FORWARD_HOPS = 1;
export const HOP_HEADER = 'x-iak-send-hops';

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p;
}

export function listSessionAgents(sessions) {
  const agents = (sessions && sessions.agents) || {};
  return Object.entries(agents).map(([name, cfg]) => ({
    name,
    adapter: (cfg && cfg.adapter) || 'unconfigured',
  }));
}

/**
 * Deliver `text` into the session of `agentName`.
 * Returns {ok, status, deliveredVia?|error?} — status is the HTTP code the
 * caller should use. Never throws.
 */
export async function deliverToSession(sessions, agentName, { text, from, hops = 0, onAsyncError } = {}) {
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return { ok: false, status: 400, error: 'missing agent' };
  }
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, status: 400, error: 'missing text' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, status: 400, error: `text too long (max ${MAX_TEXT_LENGTH})` };
  }
  if (from !== undefined && (typeof from !== 'string' || from.length > MAX_FROM_LENGTH)) {
    return { ok: false, status: 400, error: `from must be a string of at most ${MAX_FROM_LENGTH} characters` };
  }
  const cfg = sessions && sessions.agents && sessions.agents[agentName];
  if (!cfg) {
    return { ok: false, status: 404, error: 'unknown agent' };
  }

  const message = from ? `[from ${from}] ${text}` : text;
  // Delivery is accepted-async: a failure after the detached spawn cannot
  // change the already-sent 202, but it must not vanish either.
  const reportAsync = (e) => { try { onAsyncError?.(e); } catch { /* never throw */ } };

  switch (cfg.adapter) {
    case 'wake':
    case 'gui': {
      const script = expandHome(cfg.script);
      if (!script) return { ok: false, status: 503, error: 'no adapter configured' };
      try {
        let child;
        const guard = expandHome(cfg.idle_guard);
        if (guard) {
          // Chain through the human-idle guard so we never type over a
          // human. Everything passed as argv — no shell interpolation of
          // the message.
          child = spawn('bash', [
            '-c', '"$1" --wait && exec "$2" "$3"', '--', guard, script, message,
          ], { detached: true, stdio: 'ignore' });
        } else {
          child = spawn(script, [message], { detached: true, stdio: 'ignore' });
        }
        child.on('error', reportAsync);
        child.on('close', (code) => {
          if (code !== 0 && code !== null) reportAsync(new Error(`${cfg.adapter} adapter exited ${code}`));
        });
        child.unref();
        return { ok: true, status: 202, deliveredVia: cfg.adapter };
      } catch (e) {
        return { ok: false, status: 500, error: e.message || String(e) };
      }
    }
    case 'tmux': {
      const session = cfg.tmux_session;
      if (!session) return { ok: false, status: 503, error: 'no adapter configured' };
      try {
        // -l sends the message literally (no key-name interpretation),
        // then a separate Enter submits it as user input.
        await runOnce('tmux', ['send-keys', '-t', session, '-l', message]);
        await runOnce('tmux', ['send-keys', '-t', session, 'C-m']);
        return { ok: true, status: 202, deliveredVia: 'tmux' };
      } catch (e) {
        return { ok: false, status: 500, error: e.message || String(e) };
      }
    }
    case 'forward': {
      if (!cfg.peer) return { ok: false, status: 503, error: 'no adapter configured' };
      if (hops >= MAX_FORWARD_HOPS) {
        return { ok: false, status: 508, error: 'forward hop limit reached — peer chain is misconfigured (possible loop)' };
      }
      let token = cfg.token || '';
      if (!token && cfg.token_file) {
        try { token = readFileSync(expandHome(cfg.token_file), 'utf8').trim(); } catch { /* peer may be open */ }
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
        const resp = await fetch(`${cfg.peer.replace(/\/$/, '')}/sessions/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [HOP_HEADER]: String(hops + 1),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          // The peer daemon owns the final adapter; pass provenance through
          // untouched rather than double-prefixing.
          body: JSON.stringify({ agent: agentName, text, from }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await resp.json().catch(() => null);
        // Peer confirmation must be explicit: exactly 202 + ok:true. A bare
        // 200/204 or an unparseable body is NOT a delivery.
        if (resp.status !== 202 || !data || data.ok !== true) {
          return { ok: false, status: 502, error: `peer: ${(data && data.error) || `unexpected response ${resp.status}`}` };
        }
        return { ok: true, status: 202, deliveredVia: `forward:${data.deliveredVia || cfg.peer}` };
      } catch (e) {
        return { ok: false, status: 502, error: `peer unreachable: ${e.message || String(e)}` };
      }
    }
    default:
      return { ok: false, status: 503, error: 'no adapter configured' };
  }
}

function runOnce(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}
