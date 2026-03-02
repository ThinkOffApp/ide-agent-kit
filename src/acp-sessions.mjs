// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/**
 * ACP Session Manager — manages Agent Client Protocol sessions with:
 * - Token-gated access
 * - Agent/harness allowlist enforcement
 * - Session lifecycle (create, send, close)
 * - Receipt logging on every action
 * - Timeout enforcement
 * - Max concurrent session limits
 */

function loadSessions(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(filePath, sessions) {
  writeFileSync(filePath, JSON.stringify(sessions, null, 2));
}

function logReceipt(receiptPath, data) {
  try {
    const receipt = {
      timestamp: new Date().toISOString(),
      source: 'acp',
      ...data
    };
    appendFileSync(receiptPath, JSON.stringify(receipt) + '\n');
  } catch { /* best-effort */ }
}

/**
 * Validate ACP token using constant-time comparison.
 */
export function validateToken(config, token) {
  const expected = config?.acp?.token;
  if (!expected || !token) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Check if ACP is enabled and properly configured.
 */
export function isEnabled(config) {
  return config?.acp?.enabled === true && !!config?.acp?.token;
}

/**
 * Check if an agent handle is in the allowlist.
 */
export function isAgentAllowed(config, agentHandle) {
  const allowed = config?.acp?.allowed_agents || [];
  if (allowed.length === 0) return false; // empty allowlist = deny all
  const normalized = agentHandle.startsWith('@') ? agentHandle : `@${agentHandle}`;
  return allowed.some(a => {
    const n = a.startsWith('@') ? a : `@${a}`;
    return n.toLowerCase() === normalized.toLowerCase();
  });
}

/**
 * Check if a harness ID is in the allowlist.
 */
export function isHarnessAllowed(config, harnessId) {
  const allowed = config?.acp?.allowed_harnesses || [];
  if (allowed.length === 0) return true; // empty harness list = allow all registered
  return allowed.includes(harnessId);
}

/**
 * Clean up expired sessions.
 */
function cleanExpired(sessions, timeoutSec) {
  const now = Date.now();
  const cutoff = timeoutSec * 1000;
  for (const [id, session] of Object.entries(sessions)) {
    if (session.status === 'closed') continue;
    const created = new Date(session.created_at).getTime();
    if (now - created > cutoff) {
      session.status = 'expired';
      session.closed_at = new Date().toISOString();
    }
  }
  return sessions;
}

/**
 * Create a new ACP session.
 */
export function createSession(config, { agentId, task, harnessId, threadId, mode }) {
  const acpCfg = config?.acp || {};
  const sessionsFile = acpCfg.sessions_file || '/tmp/iak-acp-sessions.json';
  const receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';
  const timeoutSec = acpCfg.session_timeout_sec || 3600;
  const maxSessions = acpCfg.max_concurrent_sessions || 5;

  // Load and clean sessions
  let sessions = loadSessions(sessionsFile);
  sessions = cleanExpired(sessions, timeoutSec);

  // Check concurrent limit
  const activeSessions = Object.values(sessions).filter(s =>
    s.status === 'active' || s.status === 'pending'
  );
  if (activeSessions.length >= maxSessions) {
    const result = { ok: false, error: `Max concurrent sessions (${maxSessions}) reached` };
    if (acpCfg.receipt_all_actions) {
      logReceipt(receiptPath, { action: 'acp.session.create', status: 'denied', reason: 'max_concurrent', agentId });
    }
    return result;
  }

  // Validate agent allowlist
  if (agentId && !isAgentAllowed(config, agentId)) {
    const result = { ok: false, error: `Agent ${agentId} not in ACP allowlist` };
    if (acpCfg.receipt_all_actions) {
      logReceipt(receiptPath, { action: 'acp.session.create', status: 'denied', reason: 'agent_not_allowed', agentId });
    }
    return result;
  }

  // Validate harness allowlist
  if (harnessId && !isHarnessAllowed(config, harnessId)) {
    const result = { ok: false, error: `Harness ${harnessId} not in ACP allowlist` };
    if (acpCfg.receipt_all_actions) {
      logReceipt(receiptPath, { action: 'acp.session.create', status: 'denied', reason: 'harness_not_allowed', harnessId });
    }
    return result;
  }

  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    agent_id: agentId || null,
    harness_id: harnessId || null,
    task: task || '',
    thread_id: threadId || null,
    mode: mode || 'one-shot',
    status: 'active',
    messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null
  };

  sessions[sessionId] = session;
  saveSessions(sessionsFile, sessions);

  if (acpCfg.receipt_all_actions) {
    logReceipt(receiptPath, {
      action: 'acp.session.create',
      status: 'ok',
      session_id: sessionId,
      agentId,
      harnessId,
      mode: session.mode
    });
  }

  return { ok: true, session };
}

/**
 * Send a message to an ACP session.
 */
export function sendToSession(config, sessionId, { from, body, role }) {
  const acpCfg = config?.acp || {};
  const sessionsFile = acpCfg.sessions_file || '/tmp/iak-acp-sessions.json';
  const receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';
  const timeoutSec = acpCfg.session_timeout_sec || 3600;

  let sessions = loadSessions(sessionsFile);
  sessions = cleanExpired(sessions, timeoutSec);

  const session = sessions[sessionId];
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }

  if (session.status !== 'active') {
    return { ok: false, error: `Session is ${session.status}` };
  }

  const message = {
    id: randomUUID(),
    from: from || 'unknown',
    role: role || 'user',
    body: body || '',
    created_at: new Date().toISOString()
  };

  session.messages.push(message);
  session.updated_at = new Date().toISOString();
  saveSessions(sessionsFile, sessions);

  if (acpCfg.receipt_all_actions) {
    logReceipt(receiptPath, {
      action: 'acp.session.send',
      status: 'ok',
      session_id: sessionId,
      message_id: message.id,
      from
    });
  }

  return { ok: true, message, session_id: sessionId };
}

/**
 * Close an ACP session.
 */
export function closeSession(config, sessionId, { reason } = {}) {
  const acpCfg = config?.acp || {};
  const sessionsFile = acpCfg.sessions_file || '/tmp/iak-acp-sessions.json';
  const receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';

  const sessions = loadSessions(sessionsFile);
  const session = sessions[sessionId];
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }

  session.status = 'closed';
  session.closed_at = new Date().toISOString();
  session.updated_at = new Date().toISOString();
  if (reason) session.close_reason = reason;

  saveSessions(sessionsFile, sessions);

  if (acpCfg.receipt_all_actions) {
    logReceipt(receiptPath, {
      action: 'acp.session.close',
      status: 'ok',
      session_id: sessionId,
      reason: reason || 'manual'
    });
  }

  return { ok: true, session };
}

/**
 * Get session details.
 */
export function getSession(config, sessionId) {
  const acpCfg = config?.acp || {};
  const sessionsFile = acpCfg.sessions_file || '/tmp/iak-acp-sessions.json';
  const timeoutSec = acpCfg.session_timeout_sec || 3600;

  let sessions = loadSessions(sessionsFile);
  sessions = cleanExpired(sessions, timeoutSec);

  const session = sessions[sessionId];
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }

  return { ok: true, session };
}

/**
 * List all ACP sessions, optionally filtered by status.
 */
export function listSessions(config, { status } = {}) {
  const acpCfg = config?.acp || {};
  const sessionsFile = acpCfg.sessions_file || '/tmp/iak-acp-sessions.json';
  const timeoutSec = acpCfg.session_timeout_sec || 3600;

  let sessions = loadSessions(sessionsFile);
  sessions = cleanExpired(sessions, timeoutSec);
  saveSessions(sessionsFile, sessions);

  let list = Object.values(sessions);
  if (status) {
    list = list.filter(s => s.status === status);
  }

  // Sort by created_at descending
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    ok: true,
    sessions: list.map(s => ({
      id: s.id,
      agent_id: s.agent_id,
      harness_id: s.harness_id,
      task: s.task,
      mode: s.mode,
      status: s.status,
      message_count: s.messages?.length || 0,
      created_at: s.created_at,
      updated_at: s.updated_at,
      closed_at: s.closed_at
    })),
    count: list.length
  };
}
