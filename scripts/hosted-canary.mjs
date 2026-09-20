#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Prove the HOSTED groupmind.one still works, by using it.
//
// Why this exists: once the fleet moves into a local GroupMind, nobody opens
// groupmind.one for days at a time, and a broken hosted instance stops being
// noticed rather than stops happening. That is not hypothetical here - ThinkOff
// admin login was dead for MONTHS because a migration was never applied and
// nothing exercised the path. The repo has no CI at all, so today the only
// check on the hosted service is a human loading it in a browser.
//
// What it checks, and why a round trip rather than a ping: GET /health can be
// green while writes fail, and a write can succeed while reads serve stale or
// empty. So: POST a message with a nonce, then read it back and require the
// nonce. That covers write, read, auth and the database in one shot.
//
// Alerting follows scripts/poller-health-alert.mjs deliberately: ONE alert when
// it breaks, ONE all-clear when it returns, idempotent through a state file.
// A check that alerts every cycle gets muted, and a muted check is no check.
// (The shared alert logic should eventually be lifted out of both scripts;
// doing that surgery on a live alerting path was not worth it tonight.)
//
// Env: IAK_CANARY_KEY        required. Room API key. NEVER passed as argv - the
//                            precommand gate posts commands to the room and
//                            leaked a key that way once.
//      IAK_CANARY_ROOM       default 'canary'. Use a room nobody reads.
//      IAK_CANARY_BASE       default https://groupmind.one/api/v1
//      IAK_CANARY_ALERT_ROOM default thinkoff-development
//      IAK_CANARY_STATE      default /tmp/iak-hosted-canary.state
//      IAK_CANARY_TIMEOUT_MS default 20000
//
// Exit 0 healthy, 1 unhealthy, 2 misconfigured. Run it from cron or launchd.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

/** The message we post. A nonce, so reading it back proves OUR write landed
 *  rather than finding someone else's old row. */
export function canaryBody(nonce, now = new Date()) {
  return `canary ${nonce} ${now.toISOString()}`;
}

/** Decide from a round-trip result. Kept pure so the failure modes are
 *  testable without a network. */
export function classify({ posted, readBack, nonce }) {
  if (!posted) return { ok: false, reason: 'write failed' };
  if (!readBack) return { ok: false, reason: 'read failed' };
  if (!readBack.includes(nonce)) {
    // The dangerous case: both calls returned 200 and the data is not there.
    // A liveness ping would have called this healthy.
    return { ok: false, reason: 'wrote ok but could not read it back' };
  }
  return { ok: true, reason: 'round trip ok' };
}

async function jsonFetch(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, body: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function runCanary(env = process.env, deps = {}) {
  const key = env.IAK_CANARY_KEY;
  if (!key) return { configured: false, ok: false, reason: 'IAK_CANARY_KEY missing' };

  const base = (env.IAK_CANARY_BASE || 'https://groupmind.one/api/v1').replace(/\/+$/, '');
  const room = env.IAK_CANARY_ROOM || 'canary';
  const timeoutMs = Number(env.IAK_CANARY_TIMEOUT_MS || 20000);
  const fetchJson = deps.jsonFetch || jsonFetch;
  const nonce = (deps.newNonce || randomUUID)();
  const started = Date.now();

  const post = await fetchJson(
    `${base}/rooms/${encodeURIComponent(room)}/messages`,
    {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: canaryBody(nonce) }),
    },
    timeoutMs,
  );

  // Read back only if the write claimed success; reading after a failed write
  // tells us nothing new and doubles the load during an outage.
  let get = null;
  if (post.ok) {
    get = await fetchJson(
      `${base}/rooms/${encodeURIComponent(room)}/messages?limit=5`,
      { headers: { 'X-API-Key': key } },
      timeoutMs,
    );
  }

  const verdict = classify({
    posted: post.ok,
    readBack: get && get.ok ? get.body : null,
    nonce,
  });
  return {
    configured: true,
    ...verdict,
    ms: Date.now() - started,
    detail: post.ok ? (get ? `GET ${get.status}` : 'no read') : `POST ${post.status}: ${post.body.slice(0, 120)}`,
  };
}

/** One alert on the way down, one on the way back. Never repeat. */
export async function alertOnce(result, env = process.env, deps = {}) {
  const stateFile = env.IAK_CANARY_STATE || '/tmp/iak-hosted-canary.state';
  const alerted = existsSync(stateFile);
  const post = deps.postAlert || defaultPostAlert;

  if (!result.ok && !alerted) {
    await post(
      `⚠️ hosted groupmind.one canary FAILED: ${result.reason} (${result.detail || ''}). ` +
        `Nothing else watches the hosted instance; this is the only signal.`,
      env,
    );
    writeFileSync(stateFile, new Date().toISOString());
    return 'alerted';
  }
  if (result.ok && alerted) {
    const since = readFileSync(stateFile, 'utf8').trim();
    await post(`hosted groupmind.one canary recovered, round trip ${result.ms}ms (down since ${since}).`, env);
    unlinkSync(stateFile);
    return 'all-clear';
  }
  return 'no-change';
}

async function defaultPostAlert(text, env) {
  const base = (env.IAK_CANARY_BASE || 'https://groupmind.one/api/v1').replace(/\/+$/, '');
  const room = env.IAK_CANARY_ALERT_ROOM || 'thinkoff-development';
  await jsonFetch(
    `${base}/rooms/${encodeURIComponent(room)}/messages`,
    {
      method: 'POST',
      headers: { 'X-API-Key': env.IAK_CANARY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    },
    Number(env.IAK_CANARY_TIMEOUT_MS || 20000),
  );
}

async function main() {
  const result = await runCanary();
  if (!result.configured) {
    console.error(`hosted-canary: ${result.reason}`);
    process.exit(2);
  }
  const action = await alertOnce(result);
  console.log(`hosted-canary: ${result.ok ? 'OK' : 'FAIL'} ${result.reason} ${result.ms}ms (${action})`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
