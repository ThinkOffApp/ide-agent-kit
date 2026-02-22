import { execSync } from 'node:child_process';

/**
 * OpenClaw Exec Approvals — Governance layer for agent command execution.
 *
 * Maps to OpenClaw's 3-layer safety interlock:
 *   Policy → Allowlist → User/Judge Approval
 *
 * Integration with thinkoff-judge-core:
 *   The judge module can act as an approval provider, where governance
 *   proposals become approval requests and judge verdicts become decisions.
 *
 * RPC methods:
 *   - exec.approval.request  — create an approval request
 *   - exec.approval.waitDecision — await decision on pending request
 *   - exec.approval.resolve  — resolve with allow/deny
 *   - exec.approval.list     — list pending approvals
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

async function rpc(config, method, params, options = {}, timeoutMs = 30000) {
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
 * Request approval for a command execution.
 *
 * @param {object} config
 * @param {object} params - { command, cwd?, agentId?, sessionKey?, security?, timeoutMs?, twoPhase? }
 * @param {object} options
 * @returns {object} { requestId, status }
 */
export async function execApprovalRequest(config, params, options = {}) {
  return rpc(config, 'exec.approval.request', {
    command: params.command,
    ...(params.cwd && { cwd: params.cwd }),
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.security && { security: params.security }),
    ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
    ...(params.twoPhase !== undefined && { twoPhase: params.twoPhase })
  }, options);
}

/**
 * Wait for a decision on a pending approval request.
 *
 * @param {object} config
 * @param {object} params - { requestId, timeoutMs? }
 * @param {object} options
 * @returns {object} { decision: 'allow-once'|'allow-always'|'deny', resolvedBy }
 */
export async function execApprovalWait(config, params, options = {}) {
  const timeout = params.timeoutMs || 60000;
  return rpc(config, 'exec.approval.waitDecision', {
    requestId: params.requestId,
    ...(params.timeoutMs && { timeoutMs: params.timeoutMs })
  }, options, timeout + 5000);
}

/**
 * Resolve a pending approval request.
 *
 * @param {object} config
 * @param {object} params - { requestId, decision ('allow-once'|'allow-always'|'deny'), reason? }
 * @param {object} options
 */
export async function execApprovalResolve(config, params, options = {}) {
  return rpc(config, 'exec.approval.resolve', {
    requestId: params.requestId,
    decision: params.decision,
    ...(params.reason && { reason: params.reason })
  }, options);
}

/**
 * List pending approval requests.
 *
 * @param {object} config
 * @param {object} params - { agentId?, status? ('pending'|'resolved'|'all') }
 * @param {object} options
 */
export async function execApprovalList(config, params = {}, options = {}) {
  return rpc(config, 'exec.approval.list', {
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.status && { status: params.status })
  }, options);
}
