// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Self-handle resolution and comparison, shared by every poller that must
 * skip the agent's own posts.
 *
 * The comparison is case-insensitive and ignores a leading '@' on either
 * side. This is load-bearing: GroupMind returns the handle's REGISTERED
 * casing in message `from` fields (e.g. '@claudeMB') while configs usually
 * hold the lowercase form ('@claudemb'). A case-sensitive filter silently
 * passes every self-post, so each post the agent makes re-enters its own
 * wake pipeline as a "new message" and burns a wake turn (observed on the
 * MacBook poller, 2026-08-14).
 */

/** Normalize a handle for comparison: trim, drop leading '@', lowercase. */
export function handleKey(handle) {
  return String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Resolve the agent's own GroupMind handle.
 * Order: IAK_SELF_HANDLE env override, explicit value (CLI flag), then the
 * agent config (poller.handle).
 */
export function resolveSelfHandle({ explicit, config } = {}) {
  return process.env.IAK_SELF_HANDLE || explicit || config?.poller?.handle || '@unknown';
}

/** True when `sender` is the agent itself (case- and '@'-insensitive). */
export function isSelfSender(sender, selfHandle) {
  const key = handleKey(selfHandle);
  return key !== '' && handleKey(sender) === key;
}
