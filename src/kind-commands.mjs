// SPDX-License-Identifier: AGPL-3.0-only
//
// Config-driven "run a command when a CHOICE of this kind is decided".
//
// The model picker (registerKindHandler('model', ...) in bin/iak-mcp-daemon.mjs)
// is one hand-written consumer of a decided choice. This is the generic one: an
// operator maps a kind to an argv template in config, raises a choice card with
// that kind, and the owner's tap runs the command and gets its tail back as a
// reply to the card. First user: switching the DGX Spark pair between GLM
// serving and media jobs (asus1:~/spark-mode.sh) from the phone.
//
//   "mcp": { "confirmations": {
//     "kind_commands": {
//       "spark-mode": ["ssh", "asus1", "~/spark-mode.sh", "{decision}"],
//       "other-kind": { "argv": ["..."], "timeout_sec": 120 }
//     },
//     "kind_command_timeout_sec": 1800
//   } }
//
// Safety rules, each one tested in test/kind-commands.test.mjs:
//  - NO SHELL. The template is an argv array and is spawned directly; the
//    decision is substituted INTO array elements, so whatever a label contains
//    it stays inside the one element it was placed in.
//  - The decision is re-checked against the intent's own declared options here,
//    although decideIntent() already refuses anything else. A value that was
//    not offered never reaches spawn().
//  - Only the OWNER's tap runs a command. canDecide() lets a team lead settle
//    ordinary intents; a lead picking "media" would stop a model server under
//    everyone, so a lead-decided kind command is refused and said so in the room.
//  - One run per kind at a time: a second tap while the first command is still
//    running is refused (reported), never queued behind it.
//  - A timeout kills the whole process group (TERM, then KILL after a grace)
//    and the reply says it was killed, never "exit null".

import { spawn } from 'node:child_process';

export const DEFAULT_KIND_COMMAND_TIMEOUT_SEC = 1800;
export const TAIL_LINES = 10;
const KILL_GRACE_MS = 5000;
const MAX_BUFFER_CHARS = 64 * 1024;
const RESERVED_KINDS = new Set(['model']); // has its own hand-written handler

/** Normalise mcp.confirmations.kind_commands into
 *  Map(kind -> {argv: string[], timeoutMs}). Malformed entries are skipped and
 *  reported through `warn`, never guessed at. */
export function kindCommandsFrom(cc = {}, { warn = () => {} } = {}) {
  const out = new Map();
  const raw = cc?.kind_commands;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const defSec = Number(cc.kind_command_timeout_sec) > 0
    ? Number(cc.kind_command_timeout_sec) : DEFAULT_KIND_COMMAND_TIMEOUT_SEC;
  for (const [kind, spec] of Object.entries(raw)) {
    if (RESERVED_KINDS.has(kind)) { warn(`kind_commands: "${kind}" is reserved (built-in handler), ignored`); continue; }
    const argv = Array.isArray(spec) ? spec : spec?.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string') || !argv[0]) {
      warn(`kind_commands: "${kind}" needs a non-empty argv array of strings, ignored`);
      continue;
    }
    const sec = !Array.isArray(spec) && Number(spec?.timeout_sec) > 0 ? Number(spec.timeout_sec) : defSec;
    out.set(kind, { argv: [...argv], timeoutMs: sec * 1000 });
  }
  return out;
}

/** Substitute {decision} inside each argv element. Never joins, never splits:
 *  the result has exactly as many elements as the template. */
export function buildArgv(template, decision) {
  return template.map((a) => a.split('{decision}').join(String(decision)));
}

/** Spawn argv (no shell), merge stdout+stderr, keep the tail, enforce the
 *  timeout on the whole process group. Resolves, never rejects. */
export function runKindCommand(argv, { timeoutMs = DEFAULT_KIND_COMMAND_TIMEOUT_SEC * 1000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let buf = '';
    let timedOut = false;
    let settled = false;
    const keep = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_BUFFER_CHARS) buf = buf.slice(-MAX_BUFFER_CHARS);
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: e.message, tail: '', durationMs: 0 });
      return;
    }
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    let graceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...res, timedOut, tail: tailLines(buf, TAIL_LINES), durationMs: Date.now() - started });
    };
    child.on('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

export function tailLines(text, n = TAIL_LINES) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** The room reply for a finished run. Plain text, no em dashes, output in a
 *  code block with any fence inside the output defused. */
export function formatKindReply({ kind, decision, result, timeoutMs }) {
  let head;
  if (result.spawnError) head = `${kind} -> ${decision}: FAILED to start (${result.spawnError})`;
  else if (result.timedOut) head = `${kind} -> ${decision}: KILLED after the ${fmtDuration(timeoutMs)} timeout`;
  else if (result.code === 0) head = `${kind} -> ${decision}: done in ${fmtDuration(result.durationMs)} (exit 0)`;
  else head = `${kind} -> ${decision}: FAILED in ${fmtDuration(result.durationMs)} (${result.code === null ? `signal ${result.signal}` : `exit ${result.code}`})`;
  const tail = (result.tail || '').replace(/```/g, "'''");
  return tail ? `${head}\n\`\`\`\n${tail}\n\`\`\`` : `${head}\n(no output)`;
}

/** Post `body` to the room, threaded under the card when its message id is
 *  known. Returns true on a 2xx; never throws (a failed reply is logged, the
 *  command already ran). */
export async function postRoomReply({ apiKey, room, body, replyTo, baseUrl = 'https://groupmind.one/api/v1', fetchImpl = fetch, log = () => {} }) {
  if (!apiKey || !room) { log(`kind command reply not posted (no room api key/room):\n${body}`); return false; }
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(replyTo ? { room, body, reply_to: String(replyTo) } : { room, body }),
    });
    if (!res.ok) { log(`kind command reply: room POST returned ${res.status}`); return false; }
    return true;
  } catch (e) {
    log(`kind command reply failed: ${e?.message || e}`);
    return false;
  }
}

/** Build the registerKindHandler() handler for one configured kind.
 *  `getIntent` and `post` are injected so tests run without a room. */
export function makeKindCommandHandler({ kind, argv, timeoutMs, getIntent, post, log = () => {}, run = runKindCommand }) {
  let running = null;
  return async ({ id, decision }) => {
    const intent = getIntent(id);
    const replyTo = intent?.announcements?.groupmind?.messageId || null;
    const say = (body) => post({ body, replyTo });
    const options = Array.isArray(intent?.options) ? intent.options : [];
    if (!options.includes(decision)) {
      // decideIntent() already refuses a value that was not offered; this is
      // the second lock on the same door, because the next line spawns.
      log(`kind ${kind} intent ${id}: decision "${decision}" not in options, NOT run`);
      await say(`${kind}: "${decision}" is not one of the offered options; nothing was run`);
      return { ran: false, reason: 'not-an-option' };
    }
    if (intent?.decidedByRole !== 'owner') {
      log(`kind ${kind} intent ${id}: decided by ${intent?.decidedBy} (${intent?.decidedByRole}), NOT run`);
      await say(`${kind} -> ${decision}: not run, decided by ${intent?.decidedBy || 'unknown'}; only the owner's tap runs a command`);
      return { ran: false, reason: 'not-owner' };
    }
    if (running) {
      log(`kind ${kind} intent ${id}: previous run (${running}) still going, NOT run`);
      await say(`${kind} -> ${decision}: not run, the previous ${kind} command (card ${running}) is still running`);
      return { ran: false, reason: 'busy' };
    }
    const cmd = buildArgv(argv, decision);
    running = id;
    log(`kind ${kind} intent ${id}: running ${JSON.stringify(cmd)} (timeout ${Math.round(timeoutMs / 1000)}s)`);
    await say(`${kind} -> ${decision}: started (${cmd.join(' ')})`);
    let result;
    try {
      result = await run(cmd, { timeoutMs });
    } finally {
      running = null;
    }
    log(`kind ${kind} intent ${id}: ${result.timedOut ? 'timed out, killed' : `exit ${result.code}`}`);
    await say(formatKindReply({ kind, decision, result, timeoutMs }));
    return { ran: true, argv: cmd, result };
  };
}

/** Register one handler per configured kind. Returns the kinds registered. */
export function registerKindCommands({ cc, registerKindHandler, getIntent, post, log = () => {}, warn = log, run }) {
  const kinds = kindCommandsFrom(cc, { warn });
  for (const [kind, { argv, timeoutMs }] of kinds) {
    registerKindHandler(kind, makeKindCommandHandler({ kind, argv, timeoutMs, getIntent, post, log, run }));
  }
  return [...kinds.keys()];
}
