// SPDX-License-Identifier: AGPL-3.0-only

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

function expandHome(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readQueueEvents(queuePath) {
  if (!existsSync(queuePath)) return [];
  return readFileSync(queuePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(Boolean);
}

function toMillis(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function latestSidecarPath(sidecarDir) {
  if (!existsSync(sidecarDir)) return null;
  const files = readdirSync(sidecarDir)
    .filter(name => name.endsWith('.json'))
    .map(name => ({
      name,
      path: join(sidecarDir, name),
      mtime: statSync(join(sidecarDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path || null;
}

function loadLatestWindowEnd(sidecarDir) {
  const latest = latestSidecarPath(sidecarDir);
  if (!latest) return null;
  try {
    const data = JSON.parse(readFileSync(latest, 'utf8'));
    return data.window_end || null;
  } catch {
    return null;
  }
}

function summarizeBody(body, max = 160) {
  return (body || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildLightOutput(events) {
  return {
    items: events.map(event => ({
      event_id: event.event_id,
      timestamp: event.timestamp,
      room: event.room || null,
      actor: event.actor?.login || null,
      kind: event.kind || null,
      body: summarizeBody(event.payload?.body || ''),
      source: event.source || null
    }))
  };
}

function buildRemOutput(items) {
  const roomCounts = new Map();
  const actorCounts = new Map();
  const openThreads = [];
  const followUps = [];

  for (const item of items) {
    if (item.room) roomCounts.set(item.room, (roomCounts.get(item.room) || 0) + 1);
    if (item.actor) actorCounts.set(item.actor, (actorCounts.get(item.actor) || 0) + 1);
    if (/\?$/.test(item.body) || /\b(please|pls|can you|could you|need to|todo|follow up)\b/i.test(item.body)) {
      openThreads.push({
        event_id: item.event_id,
        room: item.room,
        actor: item.actor,
        snippet: item.body
      });
    }
    if (/\b(review|implement|fix|update|verify|test|ship|push)\b/i.test(item.body)) {
      followUps.push({
        event_id: item.event_id,
        room: item.room,
        actor: item.actor,
        snippet: item.body
      });
    }
  }

  const themes = [];
  for (const [room, count] of roomCounts.entries()) {
    themes.push({ type: 'room', label: room, count });
  }
  for (const [actor, count] of actorCounts.entries()) {
    themes.push({ type: 'actor', label: actor, count });
  }

  themes.sort((a, b) => b.count - a.count);
  return {
    themes: themes.slice(0, 10),
    open_threads: openThreads.slice(0, 20),
    follow_ups: followUps.slice(0, 20)
  };
}

function buildDeepOutput(remOutput) {
  const facts = [];
  const decisions = [];

  for (const item of remOutput.follow_ups || []) {
    if (/\bREADME\b/i.test(item.snippet) || /\bconfig\b/i.test(item.snippet) || /\bCLI\b/i.test(item.snippet)) {
      facts.push({
        source_event_id: item.event_id,
        statement: item.snippet
      });
    }
  }

  for (const item of remOutput.open_threads || []) {
    if (/\bshould\b|\bplan\b|\buse\b|\bkeep\b/i.test(item.snippet)) {
      decisions.push({
        source_event_id: item.event_id,
        statement: item.snippet
      });
    }
  }

  return { facts: facts.slice(0, 20), decisions: decisions.slice(0, 20) };
}

function writeDeepLedger(sidecarDir, payload) {
  const ledgerPath = join(sidecarDir, 'deep-memory.jsonl');
  if ((payload.facts?.length || 0) === 0 && (payload.decisions?.length || 0) === 0) {
    return null;
  }
  appendFileSync(ledgerPath, JSON.stringify(payload) + '\n');
  return ledgerPath;
}

function makeSidecar({ phase, runId, status, windowStart, windowEnd, sourceEventIds, output, artifactPath, durationMs, errorMessage }) {
  return {
    phase,
    run_id: runId,
    status,
    window_start: windowStart,
    window_end: windowEnd,
    source_event_ids: sourceEventIds,
    output,
    artifact_path: artifactPath || null,
    duration_ms: durationMs,
    error_message: errorMessage || null
  };
}

function writeSidecar(sidecarDir, runId, phase, sidecar) {
  const path = join(sidecarDir, `${runId}-${phase}.json`);
  writeFileSync(path, JSON.stringify(sidecar, null, 2) + '\n');
  return path;
}

function withLock(lockFile, fn) {
  ensureDir(dirname(lockFile));
  let fd;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, error: 'Background run already in progress' };
    }
    throw error;
  }

  try {
    return fn();
  } finally {
    try {
      if (fd) closeSync(fd);
      unlinkSync(lockFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

function runPhase(phase, fn, timeoutSec) {
  const started = Date.now();
  try {
    const result = fn();
    const durationMs = Date.now() - started;
    const status = durationMs > timeoutSec * 1000 ? 'timed_out' : 'ok';
    return { ...result, status, durationMs };
  } catch (error) {
    return { status: 'error', durationMs: Date.now() - started, errorMessage: error.message };
  }
}

export function backgroundStatus(config) {
  const sidecarDir = resolve(expandHome(config.background?.sidecar_dir || '~/.iak/consolidation'));
  const lockFile = resolve(expandHome(config.background?.lock_file || '/tmp/iak-background.lock'));
  const latest = latestSidecarPath(sidecarDir);
  return {
    enabled: !!config.background?.enabled,
    lock_active: existsSync(lockFile),
    sidecar_dir: sidecarDir,
    latest_sidecar: latest
  };
}

/**
 * Fetch live UIK state to decide whether dreaming is allowed.
 * Returns { allowed, lightOnly, state, reason } or null on failure.
 */
export async function fetchIntentGate(config) {
  const intent = config.intent || {};
  if (!intent.baseUrl || !intent.apiKey || !intent.userId) return null;

  const url = `${intent.baseUrl.replace(/\/+$/, '')}/intent/${intent.userId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': intent.apiKey },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const derived = data.derived || {};

    const state = derived.overall_state || 'unknown';
    const urgency = derived.urgency_mode || 'normal';
    const reachability = derived.reachability_mode || 'unknown';

    // Emergency-only: no dreaming at all
    if (urgency === 'emergency-only') {
      return { allowed: false, lightOnly: false, state, reason: 'urgency is emergency-only' };
    }

    // Active desktop/focus work: light only
    if (state === 'working' && (reachability === 'desktop' || reachability === 'mobile_full_focus')) {
      return { allowed: true, lightOnly: true, state, reason: 'active work session, light only' };
    }

    // Meeting, outdoors, exercising: light only
    if (['meeting_people', 'outdoors', 'exercising'].includes(state)) {
      return { allowed: true, lightOnly: true, state, reason: `${state}, light only` };
    }

    // Sleeping, resting, unknown, transitioning: full dreaming
    return { allowed: true, lightOnly: false, state, reason: `${state}, full dreaming allowed` };
  } catch {
    clearTimeout(timer);
    return null; // On failure, don't block (allow run)
  }
}

export function runBackground(config, options = {}) {
  const background = config.background || {};
  const queuePath = resolve(config.queue?.path || './ide-agent-queue.jsonl');
  const sidecarDir = resolve(expandHome(background.sidecar_dir || '~/.iak/consolidation'));
  const lockFile = resolve(expandHome(background.lock_file || '/tmp/iak-background.lock'));
  const now = options.now ? new Date(options.now) : new Date();
  const runId = options.runId || randomUUID();
  const intentGate = options.intentGate || null; // Pre-fetched gate result

  ensureDir(sidecarDir);

  // If intent gate says not allowed, exit early
  if (intentGate && !intentGate.allowed) {
    return { ok: false, skipped: true, reason: intentGate.reason, state: intentGate.state };
  }

  return withLock(lockFile, () => {
    const latestWindowEnd = loadLatestWindowEnd(sidecarDir);
    const windowEnd = now.toISOString();
    const windowStartDate = new Date(now.getTime() - (background.recent_window_sec || 7200) * 1000);
    const windowStart = windowStartDate.toISOString();

    const queueEvents = readQueueEvents(queuePath)
      .filter(event => toMillis(event.timestamp) >= toMillis(windowStart))
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))
      .slice(0, background.max_events || 100);

    const hasNewEvents = !latestWindowEnd || queueEvents.some(event => toMillis(event.timestamp) > toMillis(latestWindowEnd));

    const phasePaths = [];

    const lightResult = runPhase('light', () => {
      if (!hasNewEvents) {
        return {
          sourceEventIds: [],
          output: { items: [] }
        };
      }
      return {
        sourceEventIds: queueEvents.map(event => event.event_id).filter(Boolean),
        output: buildLightOutput(queueEvents)
      };
    }, background.timeouts?.light_sec || 60);

    const lightStatus = !hasNewEvents ? 'skipped' : lightResult.status;
    phasePaths.push(writeSidecar(sidecarDir, runId, 'light', makeSidecar({
      phase: 'light',
      runId,
      status: lightStatus,
      windowStart,
      windowEnd,
      sourceEventIds: lightResult.sourceEventIds || [],
      output: lightResult.output || { items: [] },
      artifactPath: null,
      durationMs: lightResult.durationMs,
      errorMessage: lightResult.errorMessage
    })));

    const stagedItems = lightResult.output?.items || [];
    const lightOnly = intentGate?.lightOnly || false;
    const remResult = runPhase('REM', () => ({
      sourceEventIds: stagedItems.map(item => item.event_id),
      output: buildRemOutput(stagedItems)
    }), background.timeouts?.rem_sec || 120);
    const remStatus = lightOnly ? 'skipped_light_only' : stagedItems.length === 0 ? 'skipped' : remResult.status;
    phasePaths.push(writeSidecar(sidecarDir, runId, 'REM', makeSidecar({
      phase: 'REM',
      runId,
      status: remStatus,
      windowStart,
      windowEnd,
      sourceEventIds: remResult.sourceEventIds || [],
      output: remResult.output || { themes: [], open_threads: [], follow_ups: [] },
      artifactPath: null,
      durationMs: remResult.durationMs,
      errorMessage: remResult.errorMessage
    })));

    const remOutput = remResult.output || { themes: [], open_threads: [], follow_ups: [] };
    const hasDurableItems = !lightOnly && ((remOutput.follow_ups?.length || 0) > 0 || (remOutput.open_threads?.length || 0) > 0);
    const deepResult = runPhase('deep', () => {
      const output = buildDeepOutput(remOutput);
      const artifactPath = writeDeepLedger(sidecarDir, output);
      return {
        sourceEventIds: [
          ...(remOutput.follow_ups || []).map(item => item.event_id),
          ...(remOutput.open_threads || []).map(item => item.event_id)
        ],
        output,
        artifactPath
      };
    }, background.timeouts?.deep_sec || 120);
    const deepStatus = hasDurableItems ? deepResult.status : 'skipped';
    phasePaths.push(writeSidecar(sidecarDir, runId, 'deep', makeSidecar({
      phase: 'deep',
      runId,
      status: deepStatus,
      windowStart,
      windowEnd,
      sourceEventIds: deepResult.sourceEventIds || [],
      output: deepResult.output || { facts: [], decisions: [] },
      artifactPath: deepResult.artifactPath || null,
      durationMs: deepResult.durationMs,
      errorMessage: deepResult.errorMessage
    })));

    return {
      ok: true,
      run_id: runId,
      window_start: windowStart,
      window_end: windowEnd,
      sidecars: phasePaths
    };
  });
}
