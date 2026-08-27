// SPDX-License-Identifier: AGPL-3.0-only
//
// Confirmation registry for MCP-driven approval flows.
//
// An MCP client (e.g. an agent that wants user sign-off before destructive
// work) calls request_confirmation. The registry:
//   1. Generates a unique intent id.
//   2. Posts a confirmation prompt to the configured channels — currently
//      GroupMind (the rooms chat) with `/approve <id>` / `/deny <id>` quick
//      replies, and Codewatch via the CLAWWATCH_GATE Intent receiver
//      (CodexMB's PR #8 work) when configured.
//   3. Listens on an HTTP endpoint for the decision (POST /intent/:id/decision
//      with `{decision: "approve"|"deny"}`). Codewatch's notification action
//      buttons + a future GroupMind quick-reply poller both POST here.
//   4. Resolves the in-memory promise so the MCP tool returns synchronously.
//
// All state is in-memory (intents are short-lived, typically minutes). For
// audit, every transition is appended to receipts.

import { createServer } from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { deliverToSession, listSessionAgents, HOP_HEADER } from './session-send.mjs';

// --- registry ---------------------------------------------------------------

// id -> {prompt, session, channels, status, createdAt, decidedAt, decision, resolvers}
const intents = new Map();
// nonce -> typed action request. Actions reuse the intent approval UI but run
// through a strict registry instead of arbitrary shell.
const actions = new Map();

const ACTION_REPOS = new Set([
  'ThinkOffApp/antfarm',
  'ThinkOffApp/xfor',
  'ThinkOffApp/codewatch-site',
  'ThinkOffApp/CodeWatch',
]);

const TERMINAL_ACTION_STATUSES = new Set(['merged', 'failed', 'denied', 'expired']);

function postReceipt(receiptsPath, entry) {
  if (!receiptsPath) return;
  try {
    appendFileSync(receiptsPath, JSON.stringify(entry) + '\n');
  } catch {
    // never crash the bridge on a receipt write
  }
}

// --- durable action-status mirror (antfarm PR #43) --------------------------
// Mirrors every intent/action transition to the central GroupMind action_status
// store (POST /api/v1/actions) so CodeWatch renders durable button state when
// the phone is off the LAN and can't reach this daemon's localhost /intents.
// Fire-and-forget: a push must never throw, block, or fail a decision.
let _actionStatusPush = null;
// Action vocab -> action_status lifecycle vocab. The DB enforces a monotonic
// rank (pending<processing<approved<denied<terminal), so we never push a state
// that would move a row backwards.
const ACTION_STATUS_MAP = { merged: 'completed', running: 'processing' };

export function configureActionStatusPush({ apiKey, baseUrl = 'https://groupmind.one/api/v1', log = () => {} }) {
  if (!apiKey) return false;
  const url = String(baseUrl).replace(/\/$/, '') + '/actions';
  _actionStatusPush = (intentId, status, fields = {}) => {
    if (!intentId || !status) return;
    const clean = {};
    for (const [k, v] of Object.entries(fields)) if (v != null) clean[k] = v;
    const body = JSON.stringify({ intent_id: intentId, status, ...clean });
    fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body,
    })
      .then((r) => { if (!r.ok) log(`[action-status] ${intentId}->${status} HTTP ${r.status}`); })
      .catch((e) => log(`[action-status] ${intentId}->${status} failed: ${e.message}`));
  };
  log(`[action-status] push enabled -> ${url}`);
  return true;
}

function pushStatus(intentId, rawStatus, fields = {}) {
  if (!_actionStatusPush) return;
  try {
    _actionStatusPush(intentId, ACTION_STATUS_MAP[rawStatus] || rawStatus, fields);
  } catch {
    // never let a status mirror disturb the gating path
  }
}

export function listIntents() {
  return [...intents.entries()].map(([id, i]) => ({
    id,
    prompt: i.prompt,
    session: i.session,
    channels: i.channels,
    status: i.status,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt,
    decision: i.decision,
  }));
}

export function getIntent(id) {
  const i = intents.get(id);
  if (!i) return null;
  return {
    id,
    prompt: i.prompt,
    session: i.session,
    channels: i.channels,
    status: i.status,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt,
    decision: i.decision,
  };
}

// Decide an intent. Returns true if decided, false if id unknown or already
// decided. Idempotent for same decision; rejects different decision after
// settle.
export function decideIntent(id, decision, { receiptsPath } = {}) {
  if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, error: 'decision must be "approve" or "deny"' };
  }
  const i = intents.get(id);
  if (!i) return { ok: false, error: `unknown intent ${id}` };
  if (i.status !== 'pending') {
    if (i.decision === decision) return { ok: true, idempotent: true };
    return { ok: false, error: `intent ${id} already decided as ${i.decision}` };
  }
  i.status = 'decided';
  i.decision = decision;
  i.decidedAt = Date.now();
  postReceipt(receiptsPath, {
    kind: 'intent.decided', id, decision, decidedAt: i.decidedAt, prompt: i.prompt,
  });
  // Resolve waiters.
  for (const r of i.resolvers) {
    try { r({ decision, id }); } catch {}
  }
  i.resolvers = [];
  const action = [...actions.values()].find((a) => a.intentId === id);
  if (action) {
    if (decision === 'deny') {
      settleAction(action, {
        status: 'denied',
        actor: 'petrus',
        decided_at: new Date(i.decidedAt).toISOString(),
        ran_at: null,
        command: null,
        exit_code: null,
        output_summary: 'User denied the action.',
      }, { receiptsPath });
    } else {
      action.decided_at = new Date(i.decidedAt).toISOString();
      // An explicit human Approve overrides a soft TTL lapse. If the action
      // expired before the tap (e.g. petrus approved hours later), revive it
      // and execute anyway — the executor re-validates (gh pr view precheck),
      // so a stale-but-clean PR merges and a stale-conflicted one fails safely.
      // Without this, a late tap settles the intent but silently no-ops.
      if (action.status === 'expired') {
        action.status = 'pending';
        process.stderr.write(`[iak-mcp] action ${action.nonce}: approved after TTL lapse — executing on explicit approval\n`);
      }
      runApprovedAction(action, { receiptsPath }).catch((e) => {
        settleAction(action, {
          status: 'failed',
          actor: 'petrus',
          decided_at: action.decided_at,
          ran_at: new Date().toISOString(),
          command: action.command || null,
          exit_code: null,
          output_summary: e.message || String(e),
        }, { receiptsPath });
      });
    }
  } else {
    // Pure confirmation (no typed executor): the decision itself is terminal,
    // so mirror it directly. Typed actions instead mirror via runApprovedAction
    // (processing) and settleAction (completed/failed/denied/expired).
    pushStatus(id, decision === 'approve' ? 'approved' : 'denied', {
      decision,
      approver: 'petrus',
      decided_at: new Date(i.decidedAt).toISOString(),
    });
  }
  return { ok: true };
}

// Create + announce a confirmation intent. Returns intent id immediately.
// `announce` is an injectable side-effect (groupmindPost / codewatchPush) for
// testability — production code passes the real posters.
export async function createIntent({
  prompt,
  session,
  channels = ['groupmind'],
  timeoutSec = 600,
  announce = async () => {},
  receiptsPath,
  fromHandle,  // optional originator handle (e.g. "@CodexMB") for per-agent
               // chat-author attribution; passed through to announcers.
}) {
  const id = randomUUID().slice(0, 8);
  const intent = {
    prompt,
    session,
    channels,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decision: null,
    resolvers: [],
    timeoutSec,
  };
  intents.set(id, intent);
  postReceipt(receiptsPath, {
    kind: 'intent.created', id, prompt, session, channels, createdAt: intent.createdAt,
  });
  pushStatus(id, 'pending', { target_summary: prompt });
  // Side effects — never let an announce failure block the intent itself.
  try {
    await announce({ id, prompt, session, channels, fromHandle });
  } catch (e) {
    postReceipt(receiptsPath, {
      kind: 'intent.announce_failed', id, error: e.message,
    });
  }
  return id;
}

// Wait for a decision on intent id. Resolves on decide or timeout.
export function waitForDecision(id, { timeoutMs }) {
  const i = intents.get(id);
  if (!i) return Promise.resolve({ status: 'unknown' });
  if (i.status === 'decided') {
    return Promise.resolve({ status: 'decided', decision: i.decision });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove this resolver from the list before resolving so a later
      // decideIntent doesn't try to resolve us twice.
      const idx = i.resolvers.indexOf(resolverWithCleanup);
      if (idx >= 0) i.resolvers.splice(idx, 1);
      resolve({ status: 'timeout' });
    }, timeoutMs);
    const resolverWithCleanup = (val) => {
      clearTimeout(timer);
      resolve({ status: 'decided', decision: val.decision });
    };
    i.resolvers.push(resolverWithCleanup);
  });
}

// --- typed action requests -------------------------------------------------

export async function createActionRequest({
  payload,
  announce = async () => {},
  receiptsPath,
}) {
  const normalized = validateActionPayload(payload);
  const nonce = normalized.nonce;
  if (actions.has(nonce)) {
    throw new Error(`action nonce already exists: ${nonce}`);
  }
  const prompt = actionPrompt(normalized);
  const intentId = await createIntent({
    prompt,
    session: normalized.type,
    channels: ['groupmind'],
    announce,
    receiptsPath,
    fromHandle: normalized.requested_by,
  });
  const action = {
    ...normalized,
    intentId,
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    ran_at: null,
    command: null,
    exit_code: null,
    output_summary: null,
  };
  actions.set(nonce, action);
  postReceipt(receiptsPath, {
    kind: 'action.created',
    nonce,
    intentId,
    type: action.type,
    target: action.target,
    requested_by: action.requested_by,
    created_at: action.created_at,
  });
  const expiresAtMs = Date.parse(action.expires_at);
  if (Number.isFinite(expiresAtMs)) {
    const timer = setTimeout(() => expireAction(nonce, { receiptsPath }), Math.max(0, expiresAtMs - Date.now()));
    if (typeof timer.unref === 'function') timer.unref();
  }
  return { ok: true, id: intentId, nonce, status: action.status };
}

export function getAction(nonce, { receiptsPath } = {}) {
  expireAction(nonce, { receiptsPath });
  const action = actions.get(nonce);
  if (!action) return null;
  return actionReceipt(action);
}

function validateActionPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('action payload must be an object');
  const type = payload.type;
  if (!['merge_pr', 'deploy_site', 'upload_play_internal', 'install_debug_apk'].includes(type)) {
    throw new Error(`unsupported action type: ${type}`);
  }
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('target must be an object');
  }
  const requestedBy = requireString(payload.requested_by, 'requested_by');
  const decisionRoom = requireString(payload.decision_room, 'decision_room');
  const receiptRoom = requireString(payload.receipt_room, 'receipt_room');
  const nonce = requireString(payload.nonce, 'nonce');
  const expiresAt = requireString(payload.expires_at, 'expires_at');
  const risk = requireString(payload.risk, 'risk');
  if (!['low', 'medium', 'high'].includes(risk)) throw new Error('risk must be low, medium, or high');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('expires_at must be a valid ISO timestamp');
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('expires_at is already expired');

  let cleanTarget;
  switch (type) {
    case 'merge_pr': {
      const repo = requireString(target.repo, 'target.repo');
      const base = requireString(target.base, 'target.base');
      const pr = Number(target.pr);
      if (!ACTION_REPOS.has(repo)) throw new Error(`repo not allowed: ${repo}`);
      if (base !== 'main') throw new Error('merge_pr base must be main');
      if (!Number.isInteger(pr) || pr <= 0) throw new Error('target.pr must be a positive integer');
      cleanTarget = { repo, pr, base };
      break;
    }
    case 'deploy_site': {
      const project = requireString(target.project, 'target.project');
      const ref = requireString(target.ref, 'target.ref');
      if (!['codewatch-web', 'groupmind'].includes(project)) throw new Error(`project not allowed: ${project}`);
      if (ref !== 'main') throw new Error('deploy_site ref must be main');
      cleanTarget = { project, ref };
      break;
    }
    case 'upload_play_internal': {
      const appId = requireString(target.app_id, 'target.app_id');
      const track = requireString(target.track, 'target.track');
      const versionCode = Number(target.version_code);
      if (appId !== '4975875542898959486') throw new Error('app_id not allowed');
      if (track !== 'internal') throw new Error('track must be internal');
      if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('version_code must be a positive integer');
      cleanTarget = { app_id: appId, track, version_code: versionCode };
      break;
    }
    case 'install_debug_apk': {
      const pkg = requireString(target.package, 'target.package');
      const device = requireString(target.device, 'target.device');
      const versionCode = Number(target.version_code);
      if (!/^com\.thinkoff\.[a-z0-9_.]+$/.test(pkg)) throw new Error('package must be a ThinkOff package');
      if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('version_code must be a positive integer');
      cleanTarget = { package: pkg, version_code: versionCode, device };
      break;
    }
    default:
      throw new Error(`unsupported action type: ${type}`);
  }

  return {
    type,
    target: cleanTarget,
    requested_by: requestedBy,
    decision_room: decisionRoom,
    receipt_room: receiptRoom,
    nonce,
    expires_at: expiresAt,
    risk,
  };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function actionPrompt(action) {
  switch (action.type) {
    case 'merge_pr':
      return `Merge ${action.target.repo}#${action.target.pr} into ${action.target.base}?`;
    case 'deploy_site':
      return `Deploy ${action.target.project} from ${action.target.ref}?`;
    case 'upload_play_internal':
      return `Upload CodeWatch build ${action.target.version_code} to Play Internal testing?`;
    case 'install_debug_apk':
      return `Install ${action.target.package} build ${action.target.version_code} on ${action.target.device}?`;
    default:
      return `Approve ${action.type}?`;
  }
}

function expireAction(nonce, { receiptsPath } = {}) {
  const action = actions.get(nonce);
  if (!action || TERMINAL_ACTION_STATUSES.has(action.status)) return;
  if (Date.parse(action.expires_at) > Date.now()) return;
  settleAction(action, {
    status: 'expired',
    actor: null,
    decided_at: null,
    ran_at: null,
    command: null,
    exit_code: null,
    output_summary: 'Approval expired before a decision.',
  }, { receiptsPath });
}

function settleAction(action, patch, { receiptsPath } = {}) {
  Object.assign(action, patch);
  postReceipt(receiptsPath, { kind: 'action.receipt', ...actionReceipt(action) });
  // Mirror the terminal/transition state to the durable store. ACTION_STATUS_MAP
  // translates merged->completed; denied/failed/expired/processing pass through.
  pushStatus(action.intentId, action.status, {
    actor: action.actor,
    decision: action.status === 'denied' ? 'deny' : undefined,
    receipt: action.output_summary,
    error: action.status === 'failed' ? action.output_summary : undefined,
    decided_at: action.decided_at,
    executed_at: action.ran_at,
  });
}

function actionReceipt(action) {
  return {
    nonce: action.nonce,
    id: action.intentId,
    type: action.type,
    target: action.target,
    status: action.status,
    command: action.command,
    exit_code: action.exit_code,
    output_summary: action.output_summary,
    actor: action.actor || null,
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    requested_by: action.requested_by,
    created_at: action.created_at,
    expires_at: action.expires_at,
  };
}

async function runApprovedAction(action, { receiptsPath } = {}) {
  if (action.status !== 'pending') return;
  action.status = 'running';
  action.actor = 'petrus';
  action.ran_at = new Date().toISOString();
  pushStatus(action.intentId, 'running', { actor: 'petrus', executed_at: action.ran_at });
  switch (action.type) {
    case 'merge_pr':
      await executeMergePr(action, { receiptsPath });
      break;
    default:
      settleAction(action, {
        status: 'failed',
        actor: 'petrus',
        decided_at: action.decided_at,
        ran_at: action.ran_at,
        command: null,
        exit_code: null,
        output_summary: `${action.type} executor is not implemented yet.`,
      }, { receiptsPath });
  }
}

async function executeMergePr(action, { receiptsPath } = {}) {
  const { repo, pr, base } = action.target;
  const viewCmd = [
    'gh', 'pr', 'view', String(pr),
    '--repo', repo,
    '--json', 'number,state,isDraft,baseRefName,mergeStateStatus,title,url',
  ];
  action.command = shellSummary(viewCmd);
  const view = await spawnCollect(viewCmd[0], viewCmd.slice(1));
  if (view.code !== 0) {
    settleAction(action, failure(action, view, 'PR validation failed'), { receiptsPath });
    return;
  }
  let info;
  try { info = JSON.parse(view.stdout); } catch {
    settleAction(action, failure(action, view, 'Could not parse gh pr view output'), { receiptsPath });
    return;
  }
  if (info.state !== 'OPEN') {
    settleAction(action, failure(action, view, `PR is not open: ${info.state}`), { receiptsPath });
    return;
  }
  if (info.isDraft) {
    settleAction(action, failure(action, view, 'PR is draft'), { receiptsPath });
    return;
  }
  if (info.baseRefName !== base) {
    settleAction(action, failure(action, view, `PR base is ${info.baseRefName}, expected ${base}`), { receiptsPath });
    return;
  }
  if (info.mergeStateStatus && ['BLOCKED', 'DIRTY'].includes(info.mergeStateStatus)) {
    settleAction(action, failure(action, view, `PR merge state is ${info.mergeStateStatus}`), { receiptsPath });
    return;
  }

  const mergeCmd = ['gh', 'pr', 'merge', String(pr), '--repo', repo, '--merge'];
  action.command = shellSummary(mergeCmd);
  const merged = await spawnCollect(mergeCmd[0], mergeCmd.slice(1));
  if (merged.code !== 0) {
    settleAction(action, failure(action, merged, 'gh pr merge failed'), { receiptsPath });
    return;
  }
  settleAction(action, {
    status: 'merged',
    actor: 'petrus',
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    command: action.command,
    exit_code: merged.code,
    output_summary: summarizeOutput(merged.stdout || merged.stderr || `${repo}#${pr} merged`),
  }, { receiptsPath });
}

function failure(action, result, prefix) {
  return {
    status: 'failed',
    actor: 'petrus',
    decided_at: action.decided_at,
    ran_at: action.ran_at,
    command: action.command,
    exit_code: result.code,
    output_summary: `${prefix}: ${summarizeOutput(result.stderr || result.stdout)}`,
  };
}

function shellSummary(parts) {
  return parts.map((p) => /\s/.test(p) ? JSON.stringify(p) : p).join(' ');
}

function summarizeOutput(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function spawnCollect(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// --- HTTP listener ---------------------------------------------------------

// Tiny built-in HTTP server. POST /intent/:id/decision accepts the decision
// from any caller (Codewatch action, GroupMind reply poller, manual curl).
// Auth is a shared bearer token if configured; otherwise local-only by host bind.
export function startConfirmationsServer({
  port = 8788,
  host = '127.0.0.1',
  authToken = '',
  receiptsPath,
  announce, // optional: enables POST /intent to create new intents externally
  wakeScript, // optional: shell script path; enables POST /wake to nudge the local IDE
  sessions, // optional: {agents: {...}} enables POST /sessions/send + GET /sessions/agents
} = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Auth check (constant-time when token configured).
    if (authToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(got);
      const b = Buffer.from(authToken);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    const m = url.pathname.match(/^\/intent\/([^/]+)\/decision$/);
    if (req.method === 'POST' && m) {
      const id = m[1];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        const result = decideIntent(id, payload.decision, { receiptsPath });
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/intents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listIntents()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/actions/request') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        try {
          const result = await createActionRequest({
            payload,
            announce: announce || (async () => {}),
            receiptsPath,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    const actionMatch = url.pathname.match(/^\/actions\/([^/]+)$/);
    if (req.method === 'GET' && actionMatch) {
      const receipt = getAction(decodeURIComponent(actionMatch[1]), { receiptsPath });
      if (!receipt) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...receipt }));
      return;
    }
    // POST /intent — create a new pending intent. Body: {prompt, session, channels}.
    // Used by external callers (test scripts, MCP wrappers, etc.) to add intents
    // to the live registry without going through stdio MCP. Fires announcements
    // via whatever announcer was passed to startConfirmationsServer.
    if (req.method === 'POST' && url.pathname === '/intent') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        if (!payload.prompt || typeof payload.prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing prompt' }));
          return;
        }
        try {
          const id = await createIntent({
            prompt: payload.prompt,
            session: payload.session || 'external',
            channels: Array.isArray(payload.channels) ? payload.channels : (announce ? ['groupmind'] : []),
            announce: announce || (async () => {}),
            receiptsPath,
            // Forwarding daemons (claudemm mini, Codex mini) include
            // `from_handle` so the GroupMind announcer authors the chat
            // post as the originating agent rather than the daemon owner.
            fromHandle: typeof payload.from_handle === 'string' ? payload.from_handle : undefined,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    // Tiny mobile-first HTML UI: pending intents with Approve / Deny buttons.
    // Auto-refresh every 2s. Same origin, no auth (caller is the local LAN
    // unless authToken is set on the server, in which case the page is
    // unreachable without it). Renders fine on Wear OS browser + phone + Mac.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/intents.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderIntentsHtml());
      return;
    }
    // POST /wake — nudge the local IDE / desktop app. Body: {text?}.
    // Runs the configured wakeScript with the text as the only arg
    // (defaults to "check rooms"). Used by other agents to keep this
    // agent responsive without going through the room-poll roundtrip.
    if (req.method === 'POST' && url.pathname === '/wake') {
      if (!wakeScript) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'wake disabled — no wakeScript configured' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text = 'check rooms';
        try {
          const payload = JSON.parse(body || '{}');
          if (typeof payload.text === 'string' && payload.text.trim().length > 0) text = payload.text.trim();
        } catch { /* allow empty body */ }
        try {
          // Spawn detached; don't block the response. Wake script handles its own logging.
          const child = spawn(wakeScript, [text], { detached: true, stdio: 'ignore' });
          child.unref();
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, text }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    // POST /sessions/send — deliver text into a named agent's live session
    // (the CodeWatch send-box primitive). Body: {agent, text, from?}.
    // 202 = accepted for delivery (GUI adapters may wait on the human-idle
    // guard before typing). See src/session-send.mjs for adapters/config.
    if (req.method === 'POST' && url.pathname === '/sessions/send') {
      if (!sessions || !sessions.agents) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'sessions not configured' }));
        return;
      }
      let body = '';
      let overflow = false;
      req.on('data', (c) => {
        body += c;
        // 64 KiB is far beyond any legal payload (text caps at 4000 chars);
        // stop buffering hostile bodies instead of holding them in memory.
        if (body.length > 64 * 1024 && !overflow) {
          overflow = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'body too large' }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (overflow) return;
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        const hops = Math.max(0, Math.min(8, parseInt(req.headers[HOP_HEADER] || '0', 10) || 0));
        const result = await deliverToSession(sessions, payload.agent, {
          text: payload.text,
          from: payload.from,
          hops,
          onAsyncError: (e) => postReceipt(receiptsPath, {
            kind: 'sessions.send.async_error',
            agent: payload.agent,
            error: e.message || String(e),
            at: new Date().toISOString(),
          }),
        });
        postReceipt(receiptsPath, {
          kind: 'sessions.send',
          agent: payload.agent,
          from: payload.from || null,
          ok: result.ok,
          delivered_via: result.deliveredVia || null,
          error: result.error || null,
          at: new Date().toISOString(),
        });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.ok
          ? { ok: true, agent: payload.agent, deliveredVia: result.deliveredVia }
          : { ok: false, error: result.error }));
      });
      return;
    }
    // GET /sessions/agents — send-box target picker.
    if (req.method === 'GET' && url.pathname === '/sessions/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: listSessionAgents(sessions) }));
      return;
    }
    // POST /ide-chat/<handle>  body { role, text, ts, session_id, tool_calls? }
    // GET  /ide-chat/<handle>?since=<iso>  → { events: [...] }
    //
    // Per-handle in-memory ring buffer. Backs the IDE-chat-in-CodeWatch
    // feature — `bin/iak-claude-tail.mjs` tails ~/.claude/projects/*.jsonl
    // and POSTs each user/assistant message here; CodeWatch polls GET to
    // render the conversation as an IDE channel.
    const ideChatMatch = url.pathname.match(/^\/ide-chat\/([^/]+)$/);
    if (ideChatMatch) {
      const handle = decodeURIComponent(ideChatMatch[1]);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let payload;
          try { payload = JSON.parse(body); } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
          const event = appendIdeChatEvent(handle, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ts: event.ts }));
        });
        return;
      }
      if (req.method === 'GET') {
        const since = url.searchParams.get('since');
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        const events = listIdeChatEvents(handle, since, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events }));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(port, host);
  return server;
}

// In-memory IDE-chat ring buffer per handle. Bounded to keep memory flat
// even on long-running daemons. Persisted nowhere — restart drops history,
// CodeWatch will repopulate on next tail run.
const IDE_CHAT_MAX_PER_HANDLE = 500;
const ideChat = new Map(); // handle → array of events (oldest first)

export function appendIdeChatEvent(handle, raw) {
  const event = {
    role: raw.role || 'unknown',
    text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
    ts: raw.ts || new Date().toISOString(),
    session_id: raw.session_id || null,
    tool_calls: Array.isArray(raw.tool_calls) ? raw.tool_calls : undefined,
  };
  let buf = ideChat.get(handle);
  if (!buf) { buf = []; ideChat.set(handle, buf); }
  buf.push(event);
  if (buf.length > IDE_CHAT_MAX_PER_HANDLE) buf.splice(0, buf.length - IDE_CHAT_MAX_PER_HANDLE);
  return event;
}

export function listIdeChatEvents(handle, since, limit = 200) {
  const buf = ideChat.get(handle) || [];
  let filtered = buf;
  if (since) {
    filtered = buf.filter((e) => e.ts > since);
  }
  if (filtered.length > limit) filtered = filtered.slice(filtered.length - limit);
  return filtered;
}

// Tiny self-contained HTML UI for tap-to-approve. Inlined so the
// confirmations server has no external assets / templates to ship.
function renderIntentsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>IAK confirmations</title>
<style>
  :root { --bg:#0c0f17; --card:#141a26; --line:#2a3447; --text:#e9eef7; --muted:#8896ad; --accent:#22c55e; --warn:#f59e0b; --hot:#ef4444; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 12px; }
  h1 { font-size: 14px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .empty { color: var(--muted); padding: 18px 0; text-align: center; }
  .intent { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .prompt { font-weight: 600; margin-bottom: 4px; word-break: break-word; }
  .meta   { font-size: 11px; color: var(--muted); margin-bottom: 8px; font-variant-numeric: tabular-nums; word-break: break-word; }
  .row    { display: flex; gap: 6px; }
  .btn    { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--line); color: var(--text); background: #0f1627; font-weight: 700; text-align: center; user-select: none; cursor: pointer; }
  .btn.ok  { background: var(--accent); color: #06120a; border-color: var(--accent); }
  .btn.no  { background: var(--hot);    color: #fff;    border-color: var(--hot); }
  .decided { opacity: 0.55; }
  .decided .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .decided .pill.approve { background: var(--accent); color: #06120a; }
  .decided .pill.deny    { background: var(--hot); color: #fff; }
  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: rgba(20,26,38,0.95); border: 1px solid var(--line); padding: 6px 10px; border-radius: 6px; font-size: 11px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.on { opacity: 1; }
</style>
</head>
<body>
<h1>IAK confirmations</h1>
<div id="list"></div>
<div class="toast" id="toast"></div>
<script>
  const list = document.getElementById('list');
  const toast = document.getElementById('toast');
  let lastSig = '';
  function showToast(t) { toast.textContent = t; toast.classList.add('on'); setTimeout(() => toast.classList.remove('on'), 1800); }
  async function refresh() {
    let intents = [];
    try { intents = await (await fetch('/intents', { cache: 'no-store' })).json(); } catch { return; }
    intents.sort((a, b) => b.createdAt - a.createdAt);
    const sig = intents.map(i => i.id + i.status).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    list.innerHTML = '';
    if (intents.length === 0) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No intents yet. The next request_confirmation tool call will appear here.';
      list.appendChild(e);
      return;
    }
    for (const i of intents) {
      const el = document.createElement('div');
      el.className = 'intent' + (i.status === 'pending' ? '' : ' decided');
      const meta = [i.session ? 'session: ' + i.session : null, 'id: ' + i.id, 'channels: ' + (i.channels || []).join(', ')].filter(Boolean).join(' · ');
      el.innerHTML =
        '<div class="prompt"></div>' +
        '<div class="meta"></div>' +
        (i.status === 'pending'
          ? '<div class="row"><div class="btn ok" data-d="approve">Approve</div><div class="btn no" data-d="deny">Deny</div></div>'
          : '<span class="pill ' + i.decision + '">' + i.decision + '</span>');
      el.querySelector('.prompt').textContent = i.prompt;
      el.querySelector('.meta').textContent = meta;
      for (const b of el.querySelectorAll('.btn')) {
        b.addEventListener('click', async () => {
          const decision = b.dataset.d;
          b.style.opacity = '0.5';
          try {
            const r = await fetch('/intent/' + i.id + '/decision', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision }),
            });
            const j = await r.json();
            showToast(j.ok ? decision + ' sent' : 'error: ' + (j.error || 'unknown'));
            lastSig = ''; refresh();
          } catch (e) {
            showToast('network error: ' + e.message);
            b.style.opacity = '1';
          }
        });
      }
      list.appendChild(el);
    }
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

// --- announcers ------------------------------------------------------------

// Post the intent prompt to a GroupMind room with quick-reply text the user
// can copy / type, and a curl example for the watch-gate. Idempotent (same
// id is harmless).
export function makeGroupmindAnnouncer({ apiKey, room, callbackBase, apiKeys }) {
  // apiKeys: optional map of agent handle (e.g. "@claudemm") → API key.
  // When the intent payload includes `fromHandle`, the announcer uses
  // the matching key from this map so the chat post is authored by the
  // ORIGINATING agent rather than always by the daemon owner.
  // Falls back to the default `apiKey` when no match is found.
  return async ({ id, prompt, session, fromHandle }) => {
    if (!apiKey || !room) return;
    // Per-agent key override.
    const effectiveKey = (fromHandle && apiKeys && apiKeys[fromHandle]) || apiKey;
    const uiLink = callbackBase ? `${callbackBase}/` : null;
    const body =
      `[Confirmation needed] **${prompt}**\n` +
      `Target session: \`${session || '(none)'}\`\n` +
      (uiLink ? `Tap to decide: ${uiLink}\n` : '') +
      `Or reply: \`/approve ${id}\` · \`/deny ${id}\``;
    // Attach metadata so the GroupMind chat UI can render inline Approve/Deny
    // buttons. Frontend reads `metadata.actions` + `metadata.intent_id` and
    // POSTs `/approve <id>` (or `/deny <id>`) chat replies on tap, which the
    // chat-reply poller in iak-mcp-daemon catches and routes to the local
    // /intent/:id/decision endpoint. No new backend route needed.
    const metadata = {
      actions: ['Approve', 'Deny'],
      intent_id: id,
      intent_prompt: prompt,
      intent_session: session || null,
    };
    const data = JSON.stringify({ room, body, metadata });
    const req = await import('node:https');
    return new Promise((resolve, reject) => {
      const r = req.request(
        'https://groupmind.one/api/v1/messages',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': effectiveKey } },
        (res) => {
          // drain + resolve regardless; the message-id isn't useful here.
          res.resume();
          res.on('end', () => resolve());
          res.on('error', reject);
        }
      );
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  };
}

// Post the intent to the CLAWWATCH_GATE proxy (CodexMB's PR #8). The proxy
// then renders an Android interactive notification with Approve / Deny
// buttons that POST back to this server's /intent/:id/decision.
export function makeCodewatchAnnouncer({ gateUrl, gateToken }) {
  return async ({ id, prompt, session }) => {
    if (!gateUrl) return;
    const data = JSON.stringify({ id, prompt, session });
    const url = new URL(gateUrl);
    const lib = await import(url.protocol === 'https:' ? 'node:https' : 'node:http');
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (gateToken) headers.Authorization = `Bearer ${gateToken}`;
      const r = lib.request(gateUrl, { method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  };
}

// Fan-out: build a single announce function from per-channel announcers.
export function composeAnnouncers(map) {
  return async (intent) => {
    for (const ch of intent.channels) {
      const fn = map[ch];
      if (!fn) continue;
      try { await fn(intent); } catch (e) {
        // log but continue to other channels
        process.stderr.write(`[iak-mcp] announce ${ch} failed: ${e.message}\n`);
      }
    }
  };
}

// --- chat-reply poller -------------------------------------------------------

// Watch a GroupMind room for "/approve <id>" / "/deny <id>" quick-reply
// messages (the CodeWatch Approve/Deny buttons POST these on tap) and route
// them to decideIntent() in-process. This is what makes a phone tap actually
// settle a pending intent. It used to live only in bin/iak-mcp-daemon.mjs, so
// the in-process MCP confirmations server never routed taps — buttons looked
// dead (intent stuck "pending" after Approve). Sharing it here lets both the
// standalone daemon and the in-process server run it from one source.
//
// Logs go to stderr only (stdout is the MCP stdio protocol channel — writing
// there would corrupt it). Returns the interval handle so callers can stop it.
// `owner` is the account handle decisions are accepted from. It also decides
// who is worth ANSWERING when a decision is rejected: see `ownerish` below.
// Defaulting it keeps existing callers behaving identically, but it is a
// `owners` is an EXPLICIT list of exact handles allowed to settle intents,
// deliberately not a prefix match: an agent can register any handle it likes,
// so `petrus-*` would let a fleet agent call itself "petrus-helper" and inherit
// approval authority — the precise attack this guard exists to stop. A list
// rather than one name because a person is not one handle: they are a laptop,
// a tablet and a watch (2026-08-03: a decision from the owner's own tablet,
// "@petrus-boox", was dropped in silence because this compared against the
// literal "petrus" — he tapped Approve on camera and nothing happened).
// Ported from the Mini's field-hardened fork (branch mini-local-fork-rescue),
// security-reviewed by codexmb 2026-08-27; `owner` kept as an alias so
// existing call sites keep working.
export function startChatReplyPoller({ apiKey, room, intervalMs = 5000, log, owners, owner = 'petrus' }) {
  if (!apiKey || !room) {
    process.stderr.write('[iak-mcp] chat-reply poller: missing apiKey or room — disabled\n');
    return null;
  }
  const ownerSet = new Set(
    (Array.isArray(owners) && owners.length ? owners : [owner])
      .map((o) => String(o).replace(/^@/, '').toLowerCase())
  );
  const emit = log || ((msg) => process.stderr.write(`[iak-mcp] ${msg}\n`));
  const seen = new Set();
  let primed = false;
  // A dropped decision has to be VISIBLE, not merely logged. On 2026-08-03
  // petrus typed "/approve f2af1c66" from his tablet; the owner guard below
  // rejected it because that device posts as "@petrus-boox" rather than
  // "petrus", wrote one line to stderr, and left the intent pending. He saw
  // no error, assumed the approval had landed, and moved on — the approval
  // path failing in the one way it must never fail, silently. Every reject
  // branch now answers in the room. Costs one request per rejected message,
  // and `seen` guarantees that is once, not once per poll.
  //
  // No feedback loop: these replies never match the /approve|/deny regex
  // below, which is anchored at the start of the message.
  //
  // Backticks are stripped from interpolated handles: a handle is chosen by
  // whoever registered it, and these strings put it inside a markdown code
  // span, which one backtick would break out of.
  const reply = async (body) => {
    try {
      await fetch('https://groupmind.one/api/v1/messages', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, body }),
      });
    } catch (e) {
      // Never let a failed reply break the poll loop: not telling someone
      // their tap was rejected is bad, but dropping every later tap on the
      // floor because one POST failed is worse.
      emit(`reply failed: ${e.message}`);
    }
  };
  const poll = async () => {
    try {
      const url = `https://groupmind.one/api/v1/rooms/${encodeURIComponent(room)}/messages?limit=30`;
      const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
      if (!res.ok) return;
      const body = await res.json();
      const messages = body?.messages || [];
      for (const m of messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!primed) continue; // ignore historical messages on first pass
        const text = (m.body || '').trim();
        const match = text.match(/^\/(approve|deny)\s+([a-f0-9]+)$/i);
        if (!match) continue;
        // Only the human owner may settle intents. Fleet agents share the room
        // and one (hermes) auto-replied "/approve <id>" to a confirmation card,
        // which this poller happily executed — any agent could approve any
        // gated command. Agent senders carry a handle ("@ether", "hermes");
        // the owner posts as plain "petrus" (CodeWatch button taps included).
        const sender = String(m.from || '').replace(/^@/, '').toLowerCase();
        // Authorization: exact membership in the owners set. The isHuman path
        // stays (codexmb 2026-08-27: it is SERVER-derived — set only when the
        // caller authenticated as a session user, never mintable via an agent
        // key). Residual, accepted knowingly: any human MEMBER of the room
        // could settle. Today the owner is the only human in the room; if that
        // changes, intersect this with ownerSet.
        if (!ownerSet.has(sender) && m.isHuman !== true) {
          emit(`${text} from ${m.from}: sender is not the owner — ignoring`);
          // Answer only senders who plausibly ARE the owner (`petrus`,
          // `petrus-boox`, a future `petrus-watch`). claudeMB's review caught
          // that replying to everything amplifies the very misbehaviour this
          // guard was written for: a fleet agent once retried `/approve` in a
          // loop, and answering each attempt would turn a silent log line into
          // the daemon spamming the room — which is petrus's phone notification
          // surface. Worse, a bot that retries on being told "not recorded"
          // ping-pongs forever, and no `seen` set stops that because every
          // round is a genuinely new message id.
          //
          // A human who tapped Approve needs to know it did not land. An agent
          // emitting a spurious `/approve` does not; the log line was always
          // the right answer for it.
          // "Plausibly the owner" for reply purposes only — NEVER for
          // authorization: prefix-matching authority is the petrus-helper hole.
          const ownerish = [...ownerSet].some((o) => sender === o || sender.startsWith(`${o}-`));
          if (ownerish) {
            await reply(
              `\`${text}\` was NOT recorded — the intent is still pending. ` +
              `Only the account owner can settle intents, and this arrived from ` +
              `\`${String(m.from || '').replace(/`/g, '')}\`, which is not a ` +
              `recognised owner identity.`
            );
          }
          continue;
        }
        const decision = match[1].toLowerCase();
        const id = match[2];
        const intent = getIntent(id);
        if (!intent) {
          emit(`/${decision} ${id} from ${m.from}: unknown intent, ignoring`);
          await reply(
            `\`/${decision} ${id}\` was NOT recorded — no intent with that id. ` +
            `It has probably expired or been settled already.`
          );
          continue;
        }
        const r = decideIntent(id, decision);
        emit(`/${decision} ${id} from ${m.from}: ${r.ok ? 'settled' : r.error}`);
      }
      primed = true;
    } catch (e) {
      emit(`chat-reply poll error: ${e.message}`);
    }
  };
  poll();
  return setInterval(poll, intervalMs);
}

// --- testing helpers ---------------------------------------------------------

// Reset all state. Used by the test suite between cases. Not exported via
// the package surface for production use.
export function _resetForTests() {
  for (const i of intents.values()) {
    for (const r of i.resolvers) {
      try { r({ decision: 'deny', id: '__reset__' }); } catch {}
    }
  }
  intents.clear();
}
