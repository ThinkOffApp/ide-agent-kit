import { execSync } from 'node:child_process';

/**
 * OpenClaw Cron — Scheduled task management via gateway RPC.
 *
 * Provides:
 *   - cronList   — list all cron jobs
 *   - cronAdd    — add a new scheduled job
 *   - cronUpdate — update an existing job
 *   - cronRemove — remove a job
 *   - cronRun    — trigger immediate execution
 *   - cronStatus — get cron system status
 *
 * Schedule types:
 *   - at: one-shot ISO 8601 timestamp
 *   - every: interval in milliseconds
 *   - cron: 5/6-field cron expression with timezone
 *
 * Session modes:
 *   - main: system event in main session
 *   - isolated: dedicated agent turn
 *
 * Delivery:
 *   - announce: direct channel output
 *   - webhook: POST to URL
 *   - none: silent
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
 * List all cron jobs.
 */
export async function cronList(config, options = {}) {
  return rpc(config, 'cron.list', {}, options);
}

/**
 * Add a new cron job.
 *
 * @param {object} config
 * @param {object} params - {
 *   name, task (message text),
 *   schedule: { at?, every?, cron?, timezone? },
 *   agentId?, mode? ('main'|'isolated'),
 *   deliver? ('announce'|'webhook'|'none'),
 *   webhookUrl?, enabled?
 * }
 */
export async function cronAdd(config, params, options = {}) {
  return rpc(config, 'cron.add', {
    name: params.name,
    task: params.task,
    schedule: params.schedule,
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.mode && { mode: params.mode }),
    ...(params.deliver && { deliver: params.deliver }),
    ...(params.webhookUrl && { webhookUrl: params.webhookUrl }),
    ...(params.enabled !== undefined && { enabled: params.enabled })
  }, options);
}

/**
 * Update an existing cron job.
 *
 * @param {object} config
 * @param {object} params - { jobId, ...fields to update }
 */
export async function cronUpdate(config, params, options = {}) {
  const { jobId, ...updates } = params;
  return rpc(config, 'cron.update', { jobId, ...updates }, options);
}

/**
 * Remove a cron job.
 */
export async function cronRemove(config, params, options = {}) {
  return rpc(config, 'cron.remove', { jobId: params.jobId }, options);
}

/**
 * Trigger immediate execution of a cron job.
 */
export async function cronRun(config, params, options = {}) {
  return rpc(config, 'cron.run', { jobId: params.jobId }, options);
}

/**
 * Get cron system status.
 */
export async function cronStatus(config, options = {}) {
  return rpc(config, 'cron.status', {}, options);
}
