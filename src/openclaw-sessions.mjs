import { execSync } from 'node:child_process';

/**
 * OpenClaw Sessions — Agent-to-agent communication via gateway RPC.
 *
 * Provides:
 *   - sessionsSend    — send message from one agent to another
 *   - sessionsSpawn   — spawn isolated sub-agent session
 *   - sessionsList    — list active sessions
 *   - sessionsHistory — fetch message history for a session
 *   - sessionsStatus  — check session reachability/context usage
 */

const DEFAULTS = {
  host: '127.0.0.1',
  port: 18791,
  token: ''
};

function resolveGateway(config, options = {}) {
  return {
    host: options.host || config?.openclaw?.host || DEFAULTS.host,
    port: options.port || config?.openclaw?.port || DEFAULTS.port,
    token: options.token || config?.openclaw?.token || DEFAULTS.token
  };
}

async function rpc(config, method, params, options = {}, timeoutMs = 60000) {
  const gw = resolveGateway(config, options);
  const url = `http://${gw.host}:${gw.port}/rpc`;
  const headers = { 'Content-Type': 'application/json' };
  if (gw.token) headers['Authorization'] = `Bearer ${gw.token}`;

  const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
  const body = JSON.stringify({ method, params });
  const bodyArg = `-d '${body.replace(/'/g, "'\\''")}'`;
  const cmd = `curl -sS -X POST ${headerArgs} ${bodyArg} "${url}"`;

  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: timeoutMs });
    try { return { ok: true, data: JSON.parse(result) }; }
    catch { return { ok: true, data: result.trim() }; }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Send a message to another agent's session.
 *
 * @param {object} config
 * @param {object} params - { agentId, message, sessionKey?, label?, timeoutSeconds? }
 * @param {object} options - gateway overrides
 * @returns {object} { runId, status, reply, sessionKey, delivery }
 */
export async function sessionsSend(config, params, options = {}) {
  return rpc(config, 'sessions.send', {
    agentId: params.agentId,
    message: params.message,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.label && { label: params.label }),
    ...(params.timeoutSeconds && { timeoutSeconds: params.timeoutSeconds })
  }, options, (params.timeoutSeconds || 30) * 1000 + 5000);
}

/**
 * Spawn an isolated sub-agent session.
 *
 * @param {object} config
 * @param {object} params - { task, agentId?, label?, model?, mode? ('run'|'session'), thinking?, runTimeoutSeconds?, cleanup? }
 * @param {object} options
 */
export async function sessionsSpawn(config, params, options = {}) {
  return rpc(config, 'sessions.spawn', {
    task: params.task,
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.label && { label: params.label }),
    ...(params.model && { model: params.model }),
    ...(params.mode && { mode: params.mode }),
    ...(params.thinking !== undefined && { thinking: params.thinking }),
    ...(params.runTimeoutSeconds && { runTimeoutSeconds: params.runTimeoutSeconds }),
    ...(params.cleanup !== undefined && { cleanup: params.cleanup })
  }, options, (params.runTimeoutSeconds || 60) * 1000 + 5000);
}

/**
 * List active sessions.
 *
 * @param {object} config
 * @param {object} params - { kinds?, limit?, activeMinutes?, messageLimit? }
 * @param {object} options
 */
export async function sessionsList(config, params = {}, options = {}) {
  return rpc(config, 'sessions.list', {
    ...(params.kinds && { kinds: params.kinds }),
    ...(params.limit && { limit: params.limit }),
    ...(params.activeMinutes && { activeMinutes: params.activeMinutes }),
    ...(params.messageLimit !== undefined && { messageLimit: params.messageLimit })
  }, options);
}

/**
 * Fetch message history for a session.
 *
 * @param {object} config
 * @param {object} params - { sessionKey, limit?, includeTools? }
 * @param {object} options
 */
export async function sessionsHistory(config, params, options = {}) {
  return rpc(config, 'sessions.history', {
    sessionKey: params.sessionKey,
    ...(params.limit && { limit: params.limit }),
    ...(params.includeTools !== undefined && { includeTools: params.includeTools })
  }, options);
}

/**
 * Check session status (reachability, context usage).
 *
 * @param {object} config
 * @param {object} params - { sessionKey }
 * @param {object} options
 */
export async function sessionsStatus(config, params, options = {}) {
  return rpc(config, 'session.status', {
    sessionKey: params.sessionKey
  }, options);
}
