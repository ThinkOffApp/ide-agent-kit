// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reply-context helpers shared by every GroupMind message reader.
 *
 * A reply's meaning lives in its target (27 Aug 2026: "spec this" was
 * interpreted by guess because every agent-facing surface dropped reply_to).
 * Both pollers (unified adapter and the legacy team-relay room-poller) must
 * resolve and render reply context the SAME way, from this module, so the
 * two paths cannot drift apart.
 */

/**
 * reply_to is POLYMORPHIC: the server stores whatever the client POSTed -
 * a string id, or a rich { id, from, body } object (antfarm route.ts:412;
 * both shapes seen live 27 Aug 2026). Normalise before any use.
 */
export function replyIdOf(raw) {
  if (typeof raw === 'string' && raw) return raw;
  if (raw && typeof raw === 'object' && raw.id != null) return String(raw.id);
  return null;
}

/** The object form self-carries the target it points at. */
export function embeddedTargetOf(raw) {
  if (raw && typeof raw === 'object' && (raw.from || raw.body)) {
    return { from: raw.from || '?', body: (raw.body || '').slice(0, 120) };
  }
  return null;
}

/**
 * Resolve reply targets for a fetched batch: a fresh reply's target is
 * almost always within the same poll window. Falls back to the embedded
 * object form when the target is older than the window. Sets m._replyToId
 * and m._replyTarget in place; returns the batch for chaining.
 */
export function resolveReplyTargets(msgs, lookup) {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  for (const m of msgs) {
    const replyId = replyIdOf(m.reply_to);
    if (replyId) m._replyToId = replyId;
    if (!replyId) continue;
    let t = byId.get(replyId) || null;
    // Outside the poll window: ask the caller's history (issue #90). The
    // room API has no single-message fetch, so this is the only way an
    // older parent ever resolves.
    if (!t && typeof lookup === 'function') {
      try { t = lookup(replyId) || null; } catch { t = null; }
    }
    if (t) {
      m._replyTarget = { from: t.from || t.sender || '?', body: (t.body || '').slice(0, 300), created_at: t.created_at || '' };
    } else {
      const embedded = embeddedTargetOf(m.reply_to);
      if (embedded) m._replyTarget = embedded;
    }
  }
  return msgs;
}

/**
 * Inline, SINGLE-LINE annotation suffix ('' for non-replies).
 *
 * Single-line on purpose: the notification-file contract is one entry per
 * physical line (readers split on \n and room_ack counts lines), so a
 * two-line entry gets delivered as two detached entries and overcounted -
 * reproduced by codexmb on PR #70. An unresolved reply still says it IS a
 * reply, so nobody interprets it as a freestanding statement.
 */
export function replyAnnotation(replyToId, replyTarget) {
  if (replyTarget) {
    const from = replyTarget.from || '?';
    const snippet = (replyTarget.body || '').replace(/\n/g, ' ').slice(0, 100);
    return ` ⤷ in reply to ${from}: "${snippet}"`;
  }
  if (replyToId) {
    return ` ⤷ a reply (target ${replyToId} not in recent window)`;
  }
  return '';
}
