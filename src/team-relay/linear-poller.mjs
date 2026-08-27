/**
 * Linear issue feed.
 *
 * Puts Linear issues on the same rails GitHub PRs already ride: this emits the
 * exact event shape webhook-server.mjs produces, so every consumer downstream
 * (CodeWatch included) treats a Linear issue like any other event and needs no
 * special case.
 *
 * Polling, not a webhook, and that is deliberate. A webhook needs a stable
 * public URL, and this fleet reaches the outside through a tunnel whose URL
 * rotates on every restart. A webhook would die silently at each rotation and
 * nobody would notice until issues quietly stopped arriving. Polling owns its
 * own liveness: no inbound URL, nothing to re-point, and a failed poll is
 * visible in the log immediately. Issue tracking does not need sub-minute
 * latency, so the trade costs nothing that matters.
 *
 * Read-only by construction. It holds a Linear API key and never calls a
 * mutation, so the worst a bug here can do is emit a wrong event.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LINEAR_API = 'https://api.linear.app/graphql';
const DEFAULT_TOKEN_FILE = join(homedir(), '.config', 'linear.token');
const DEFAULT_INTERVAL_MS = 120000;

/**
 * The token comes from a file, never from config or argv.
 *
 * Anything on a command line reaches a process list and a shell history, and on
 * this fleet the precommand gate has posted a command into the room and leaked
 * a key exactly that way. A path in config is safe to commit; a key is not.
 */
export function readLinearToken(tokenFile = DEFAULT_TOKEN_FILE) {
  try {
    const raw = readFileSync(tokenFile, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

async function linearQuery(token, query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`linear http ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`linear: ${body.errors[0].message}`);
  return body.data;
}

const ISSUES_QUERY = `
  query($since: DateTimeOrDuration!, $first: Int!) {
    issues(
      filter: { updatedAt: { gt: $since } }
      orderBy: updatedAt
      first: $first
    ) {
      nodes {
        id identifier title url priority createdAt updatedAt
        state { name type }
        assignee { displayName }
        creator { displayName }
        team { key }
      }
    }
  }`;

/**
 * An issue is "new" when it has not been updated since it was created. Linear
 * has no created/updated event split on this query, and comparing the two
 * timestamps is more reliable than remembering which ids we have seen: a state
 * store can be lost, but the issue's own timestamps cannot.
 *
 * On actor.login, which is deliberately narrow (found by @codexmb reviewing
 * PR #69): for a CREATED issue the creator really is the actor. For an UPDATED
 * one we do not know who made the change. The assignee is a tempting stand-in
 * and is wrong: an issue assigned to Petrus and edited by an agent would be
 * attributed to Petrus, and "who did what" is the whole reason this feed
 * exists. Linear's issue history would carry the real actor, but it comes back
 * empty for issues created through an API token, so it cannot be relied on.
 *
 * So an update reports 'unknown' rather than a plausible lie. The assignee and
 * creator still travel in the payload, where they are labelled as what they
 * actually are.
 */
export function buildLinearEvent(issue) {
  const isNew = issue.createdAt === issue.updatedAt;
  const creator = issue.creator?.displayName || null;
  const assignee = issue.assignee?.displayName || null;
  return {
    trace_id: randomUUID(),
    source: 'linear',
    kind: isNew ? 'linear.issue.created' : 'linear.issue.updated',
    timestamp: issue.updatedAt,
    actor: { login: isNew ? creator || 'unknown' : 'unknown' },
    refs: {
      issue_url: issue.url,
      issue_identifier: issue.identifier,
      team: issue.team?.key
    },
    payload: {
      title: (issue.title || '').slice(0, 300),
      state: issue.state?.name,
      state_type: issue.state?.type,
      priority: issue.priority,
      assignee,
      creator
    }
  };
}

/**
 * Poll for issues changed since `since`, emit one event each, and return the
 * newest updatedAt seen so the caller can advance its cursor.
 *
 * The cursor moves ONLY past issues actually emitted. If onEvent throws, the
 * cursor stays put and that issue is retried next tick, because losing an
 * update silently is worse than emitting it twice.
 */
export async function pollOnce(token, since, onEvent, { first = 50 } = {}) {
  const data = await linearQuery(token, ISSUES_QUERY, { since, first });
  const nodes = data?.issues?.nodes || [];
  let cursor = since;
  for (const issue of nodes) {
    const event = buildLinearEvent(issue);
    if (onEvent) await onEvent(event);
    if (issue.updatedAt > cursor) cursor = issue.updatedAt;
  }
  return { cursor, count: nodes.length };
}

export function startLinearPoller(config = {}, onEvent) {
  const tokenFile = config.token_file || DEFAULT_TOKEN_FILE;
  const intervalMs = config.interval_ms || DEFAULT_INTERVAL_MS;
  const token = readLinearToken(tokenFile);

  if (!token) {
    // Absent config is not an error: most installs have no Linear at all, and a
    // relay must not fail to start because an optional feed is unconfigured.
    console.log(`[linear] no token at ${tokenFile}, feed disabled`);
    return { stop() {} };
  }

  // Start from now, not from the beginning of time. On a cold start every open
  // issue looks updated, and without this the first tick replays the entire
  // backlog into the room at once.
  let cursor = config.since || new Date().toISOString();
  let timer = null;
  let stopped = false;

  async function tick() {
    try {
      const { cursor: next, count } = await pollOnce(token, cursor, onEvent);
      if (count > 0) console.log(`[linear] ${count} issue(s) since ${cursor}`);
      cursor = next;
    } catch (err) {
      // Keep polling. A transient Linear outage or a rotated key must not kill
      // the relay; the log says what happened and the next tick retries.
      console.error(`[linear] poll failed: ${err.message}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  console.log(`[linear] feed on, polling every ${Math.round(intervalMs / 1000)}s`);
  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
