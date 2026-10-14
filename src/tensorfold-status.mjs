// SPDX-License-Identifier: AGPL-3.0-only
//
// tensorfold-status - every TensorFold server in the model registry, read
// NOW with GET /health, GET /metrics and GET /v1/slide/graph, for
// `ide-agent-kit tensorfold-status`.
//
// The reading itself lives in packages/user-intent-kit/src/tensorfold-status.js,
// because the device heartbeat (uik-daemon, `ide-agent-kit intent daemon`)
// publishes the same object and must not depend on IAK. This file only finds
// the registry, runs one read and renders it for a person or for --json.
//
// One-shot: tok/s needs two samples, so the read-out says "needs two samples"
// rather than printing 0. The heartbeat keeps the previous sample and does
// publish a rate.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegistryFile, RegistryError, resolveCallerHost } from '../packages/user-intent-kit/src/model-capacity.js';
import { collectTensorFoldStatus, STATUS_SCHEMA } from '../packages/user-intent-kit/src/tensorfold-status.js';
import { discoverTensorFoldEngines } from '../packages/user-intent-kit/src/tensorfold-discovery.js';
import { resolveModelRegistryPath } from './model-selection.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(path) {
  const s = String(path).trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

/**
 * Which registry to read: --registry, then INTENT_TENSORFOLD_REGISTRY (the
 * file the heartbeat reads, so the CLI shows what the card will show), then
 * the same path the model picker uses (mcp.confirmations.model_registry, or
 * config/models.json in this checkout).
 */
export function resolveTensorFoldRegistryPath({ cliPath, env = process.env, config = {}, rootDir = ROOT } = {}) {
  if (typeof cliPath === 'string' && cliPath.trim()) return expandHome(cliPath);
  const fromEnv = typeof env.INTENT_TENSORFOLD_REGISTRY === 'string' ? env.INTENT_TENSORFOLD_REGISTRY.trim() : '';
  if (fromEnv && !['0', 'off', 'false', 'no'].includes(fromEnv.toLowerCase())) return expandHome(fromEnv);
  return resolveModelRegistryPath(config, rootDir);
}

const show = v => (v === null || v === undefined ? 'unknown' : String(v));
const num = (v, unit = '') => (v === null || v === undefined ? 'unknown' : `${v}${unit}`);
const pct = v => (v === null || v === undefined ? 'unknown' : `${Math.round(v * 100)}%`);

function livingLine(lw) {
  if (lw.available === false) return 'not available (no /v1/slide/graph; serve with --slide)';
  if (lw.available === null) return 'unknown';
  return `${lw.facts} facts, ${lw.learned} learned, ${lw.learning} learning now`;
}

function metricsLine(state) {
  return {
    ok: 'ok',
    auth_required: 'auth required',
    auth_rejected: 'key refused',
    unavailable: 'unavailable',
  }[state] ?? state;
}

/** One server, several short lines. Plain words, nothing derived silently. */
export function formatServer(s) {
  const where = `${s.host}:${s.port}`;
  const how = s.source === 'detected' ? 'auto-detected' : (s.source === 'discovered' ? 'discovered running' : null);
  const tags = [how, s.app].filter(Boolean).join(', ');
  const head = `${s.id ?? where}  ${where}  ${s.reachable ? 'reachable' : 'UNREACHABLE'}${tags ? `  (${tags})` : ''}`;
  const lines = [head];
  if (s.reason) lines.push(`  note: ${s.reason}`);
  const fromArgs = s.model_source === 'args' ? ' (from its command line)' : '';
  if (!s.reachable) {
    if (s.model) lines.push(`  model: ${s.model}${fromArgs}`);
    return lines.join('\n');
  }
  const warming = s.warming === null ? 'unknown' : (s.warming ? 'yes' : 'no');
  lines.push(`  model: ${show(s.model)}${fromArgs}   warming: ${warming}`);
  lines.push(`  version: ${show(s.version)}   backend: ${show(s.backend)}   device: ${show(s.device)}`);
  const footprint = s.memory.footprint_gb === null ? '' : `, process footprint ${s.memory.footprint_gb} GB`;
  lines.push(`  memory: ${num(s.memory.used_gb, ' GB')} used, ${num(s.memory.peak_gb, ' GB')} peak, ${num(s.memory.budget_gb, ' GB')} budget${footprint}`);
  lines.push(`  requests: ${num(s.requests.running)} running, ${num(s.requests.waiting)} waiting   ` +
    `tokens since start: ${num(s.tokens.prompt_total)} prompt, ${num(s.tokens.generation_total)} generated`);
  const rate = s.tok_s === null ? 'needs two samples (the heartbeat publishes it)' : `${s.tok_s} over ${s.tok_s_window_s} s`;
  const decode = s.decode_tok_s === null ? '' : `   server decode: ${s.decode_tok_s} tok/s`;
  lines.push(`  tok/s: ${rate}${decode}`);
  const acceptance = s.draft.acceptance === null ? 'n/a' : pct(s.draft.acceptance);
  lines.push(`  draft: ${num(s.draft.drafted)} drafted, ${num(s.draft.accepted)} accepted, acceptance ${acceptance}   ` +
    `ttft p50: ${s.ttft_p50_s === null ? 'n/a' : `${s.ttft_p50_s} s`}   kv cache: ${pct(s.kv_cache_usage)}`);
  lines.push(`  living weights: ${livingLine(s.living_weights)}   metrics: ${metricsLine(s.metrics)}`);
  return lines.join('\n');
}

export function formatReport(report) {
  const discovery = { ok: 'running engines discovered', off: 'discovery off', unavailable: 'discovery UNAVAILABLE' }[report.discovery] ?? report.discovery;
  const out = [`TensorFold servers in ${report.registry} plus this machine's processes (${discovery}; read from ${report.from} at ${report.checked_at}, GET only):`];
  if (report.registry_error) out.push(`Registry not read: ${report.registry_error}`);
  if (report.discovery_error) out.push(`Discovery failed: ${report.discovery_error}`);
  if (!report.servers.length) out.push('none found.');
  for (const s of report.servers) out.push('', formatServer(s));
  if (report.skipped.length) {
    out.push('', 'Not TensorFold or not checked:');
    for (const k of report.skipped) out.push(`  ${k.id}: ${k.reason}`);
  }
  return out.join('\n');
}

/**
 * Run one read. Returns {exitCode, report, text}. Exit 0 when it ran
 * (unreachable servers are reported, not fatal). Exit 2 when the registry
 * could not be read and it was required: named with --registry or
 * INTENT_TENSORFOLD_REGISTRY, or discovery is off. A default registry path
 * that does not exist is not an error while discovery can still find
 * engines; the report says the registry was not read.
 */
export async function runTensorFoldStatus({
  registryPath,
  registryRequired = true,
  discover = true,
  discoverImpl = discoverTensorFoldEngines,
  scope = 'all',
  json = false,
  fetchImpl,
  timeoutMs,
  now = () => Date.now(),
  callerHost,
  readRegistry = readRegistryFile,
} = {}) {
  let entries = [];
  let registryError = null;
  try {
    entries = await readRegistry(registryPath);
  } catch (err) {
    const message = err instanceof RegistryError ? err.message : `cannot read registry ${registryPath}: ${err.message}`;
    if (registryRequired || !discover) {
      return { exitCode: 2, report: null, text: `Error: ${message}\nSee config/models.README.md for the registry format.` };
    }
    registryError = message;
  }
  let discovered = null;
  let discoveryError = null;
  if (discover) {
    const found = await discoverImpl().catch(() => ({ ok: false, error: 'process scan failed', engines: [] }));
    discovered = found.engines ?? [];
    if (!found.ok) discoveryError = found.error || 'process scan failed';
  }
  const { servers, skipped } = await collectTensorFoldStatus(entries, {
    scope, now, discovered,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const report = {
    schema: STATUS_SCHEMA,
    registry: registryPath,
    from: callerHost ?? await resolveCallerHost(),
    checked_at: new Date(now()).toISOString(),
    scope,
    discovery: !discover ? 'off' : (discoveryError ? 'unavailable' : 'ok'),
    ...(registryError ? { registry_error: registryError } : {}),
    ...(discoveryError ? { discovery_error: discoveryError } : {}),
    servers,
    skipped,
  };
  return { exitCode: 0, report, text: json ? JSON.stringify(report, null, 2) : formatReport(report) };
}
