// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Global message rate limiter — enforces a minimum interval between
 * any two outbound messages across the entire IDE Agent Kit process.
 *
 * Config (in ide-agent-kit.json):
 *   rate_limit.message_interval_sec — minimum seconds between sends (default: 30)
 */

let lastMessageTime = 0;

function getIntervalMs(config) {
  return ((config?.rate_limit?.message_interval_sec ?? 30) * 1000);
}

export function canSend(config) {
  const interval = getIntervalMs(config);
  if (interval <= 0) return true;
  return Date.now() - lastMessageTime >= interval;
}

export function markSent() {
  lastMessageTime = Date.now();
}

export function msUntilReady(config) {
  const interval = getIntervalMs(config);
  if (interval <= 0) return 0;
  const elapsed = Date.now() - lastMessageTime;
  return Math.max(0, interval - elapsed);
}

export async function waitUntilReady(config) {
  const wait = msUntilReady(config);
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}
