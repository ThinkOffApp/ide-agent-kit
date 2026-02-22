import { execSync } from 'node:child_process';

/**
 * OpenClaw Gateway Client — HTTP interface to the local OpenClaw gateway.
 *
 * Provides access to:
 *   - POST /hooks/agent  — trigger an isolated agent turn
 *   - POST /hooks/wake   — wake an agent's main session
 *   - GET  /health       — health check
 *   - RPC config.get / config.patch — read/modify gateway config
 *
 * All methods accept a `gateway` options object:
 *   { host, port, token }
 *
 * Default: localhost:18791 (matches our Mac mini setup).
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

function baseUrl(gw) {
  return `http://${gw.host}:${gw.port}`;
}

function authHeaders(gw) {
  const headers = { 'Content-Type': 'application/json' };
  if (gw.token) headers['Authorization'] = `Bearer ${gw.token}`;
  return headers;
}

async function gwFetch(url, method, body, gw, timeoutMs = 30000) {
  const headers = authHeaders(gw);
  const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
  const bodyArg = body ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : '';

  const cmd = `curl -sS -X ${method} ${headerArgs} ${bodyArg} "${url}"`;
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: timeoutMs });
    try {
      return { ok: true, data: JSON.parse(result) };
    } catch {
      return { ok: true, data: result.trim() };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * POST /hooks/agent — Run an isolated agent turn.
 * Returns 202 (async execution).
 *
 * @param {object} config - IDE Agent Kit config
 * @param {object} params - { message, agentId, sessionKey?, model?, thinking?, timeoutSeconds?, deliver?, channel?, to? }
 * @param {object} options - { host?, port?, token? }
 */
export async function triggerAgent(config, params, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/hooks/agent`;
  const body = {
    message: params.message,
    agentId: params.agentId,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.model && { model: params.model }),
    ...(params.thinking !== undefined && { thinking: params.thinking }),
    ...(params.timeoutSeconds && { timeoutSeconds: params.timeoutSeconds }),
    ...(params.deliver && { deliver: params.deliver }),
    ...(params.channel && { channel: params.channel }),
    ...(params.to && { to: params.to }),
    ...(params.wakeMode && { wakeMode: params.wakeMode })
  };
  return gwFetch(url, 'POST', body, gw);
}

/**
 * POST /hooks/wake — Enqueue a system event for the main session.
 *
 * @param {object} config
 * @param {object} params - { text, mode? ('now'|'next-heartbeat') }
 * @param {object} options
 */
export async function wakeAgent(config, params, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/hooks/wake`;
  const body = {
    text: params.text,
    ...(params.mode && { mode: params.mode })
  };
  return gwFetch(url, 'POST', body, gw);
}

/**
 * GET /health — Check gateway health.
 */
export async function healthCheck(config, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/health`;
  return gwFetch(url, 'GET', null, gw, 5000);
}

/**
 * RPC config.get — Read gateway configuration.
 */
export async function configGet(config, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/rpc`;
  return gwFetch(url, 'POST', { method: 'config.get', params: {} }, gw);
}

/**
 * RPC config.patch — Patch gateway configuration.
 */
export async function configPatch(config, patch, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/rpc`;
  return gwFetch(url, 'POST', { method: 'config.patch', params: { patch } }, gw);
}

/**
 * RPC agents.list — List all configured agents.
 */
export async function agentsList(config, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/rpc`;
  return gwFetch(url, 'POST', { method: 'agents.list', params: {} }, gw);
}

/**
 * RPC health.deep — Deep health check with channel status.
 */
export async function healthDeep(config, options = {}) {
  const gw = resolveGateway(config, options);
  const url = `${baseUrl(gw)}/rpc`;
  return gwFetch(url, 'POST', { method: 'health.deep', params: {} }, gw);
}
