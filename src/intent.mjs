// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared user-intent-kit integration.
 *
 * user-intent-kit ships embedded at packages/user-intent-kit and this module
 * is the single place IAK constructs clients from config. Everything reads
 * the `intent` config block:
 *
 *   "intent": {
 *     "baseUrl": "https://groupmind.one/api/v1",
 *     "apiKey": "...",            // X-API-Key for the intent API
 *     "userId": "petrus",
 *     "deviceId": "mac-mini",     // optional, required only for writes
 *     "agentHandle": "@claudemm", // optional, for agent status publishing
 *     "suppress_nudges": true     // optional, default true when block present
 *   }
 *
 * snake_case variants (base_url, api_key, ...) are accepted because the rest
 * of the config file uses snake_case.
 *
 * All helpers fail open: missing config returns null, and API errors never
 * propagate out of the gate/suppression helpers.
 */

import { IntentClient, IAKAdapter } from 'user-intent-kit';

function pick(obj, camel, snake) {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

/** Normalized intent config, or null when the required fields are absent. */
export function intentConfig(config = {}) {
  const raw = config.intent || {};
  const baseUrl = pick(raw, 'baseUrl', 'base_url');
  const apiKey = pick(raw, 'apiKey', 'api_key');
  const userId = pick(raw, 'userId', 'user_id');
  if (!baseUrl || !apiKey || !userId) return null;
  return {
    baseUrl,
    apiKey,
    userId,
    deviceId: pick(raw, 'deviceId', 'device_id') || null,
    agentHandle: pick(raw, 'agentHandle', 'agent_handle') || config.poller?.handle || null,
    suppressNudges: pick(raw, 'suppressNudges', 'suppress_nudges') !== false,
  };
}

/** IntentClient built from config.intent, or null when not configured. */
export function intentClientFromConfig(config, { timeoutMs = 5000 } = {}) {
  const cfg = intentConfig(config);
  if (!cfg) return null;
  return new IntentClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    userId: cfg.userId,
    deviceId: cfg.deviceId || undefined,
    timeoutMs,
  });
}

/** IAKAdapter for agent status publishing, or null when not configured. */
export function iakAdapterFromConfig(config) {
  const cfg = intentConfig(config);
  if (!cfg || !cfg.agentHandle) return null;
  const client = intentClientFromConfig(config);
  return new IAKAdapter(client, { agentHandle: cfg.agentHandle });
}

// Short-lived cache so per-message callers (enrichment, nudge gating) don't
// hammer the intent API during poll bursts. Keyed per user+server.
const intentCache = new Map(); // key → { at, data }
const INTENT_CACHE_TTL_MS = 30000;

export function clearIntentCache() {
  intentCache.clear();
}

/**
 * Full intent document (devices + agents + derived) with a 30s cache.
 * Returns null when unconfigured or on API failure.
 */
export async function getIntentCached(config, { ttlMs = INTENT_CACHE_TTL_MS } = {}) {
  const cfg = intentConfig(config);
  if (!cfg) return null;
  const key = `${cfg.baseUrl}|${cfg.userId}`;
  const hit = intentCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const client = intentClientFromConfig(config);
  try {
    const data = await client.getIntent();
    intentCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

/**
 * Whether tmux/command nudges should be skipped right now (user in
 * emergency-only mode). Notification files are always written regardless;
 * this only gates the interruption. Fails open: any error → false.
 */
export async function shouldSuppressNudge(config) {
  const cfg = intentConfig(config);
  if (!cfg || !cfg.suppressNudges) return false;
  const intent = await getIntentCached(config);
  const derived = intent?.derived || {};
  return derived.urgency_mode === 'emergency-only';
}
