// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createReceipt, appendReceipt } from './receipt.mjs';
import { canSend, markSent } from './rate-limiter.mjs';
import { resolveSelfHandle, isSelfSender } from './common/handles.mjs';

// Ack-only messages are low-value and cause loops. Filter them out from automation posts.
const ACK_ONLY_PATTERNS = [
  'understood', 'agreed', 'proceed', 'perfect', 'exactly',
  'great', 'good', 'sounds good', 'will do', 'yes',
  'got it', 'noted', 'copy that', 'roger', 'acknowledged',
  'excellent', 'right', 'correct', 'ok', 'okay',
];

function isAckOnly(body) {
  const cleaned = (body || '').trim().replace(/[.!,]+$/, '').toLowerCase();
  if (cleaned.length >= 80) return false;
  return ACK_ONLY_PATTERNS.some(pat =>
    cleaned === pat || cleaned.startsWith(pat + ' ') || cleaned.startsWith(pat + '.') || cleaned.startsWith(pat + ',')
  );
}

/**
 * Room Automation — rule-based automation triggered by GroupMind room messages.
 *
 * Watch room messages, match against rules (keyword, sender, room, regex),
 * execute bounded actions, and write a receipt for every action taken.
 *
 * Rules config (in ide-agent-kit.json under automation.rules):
 *   [
 *     {
 *       "name": "greet-owner",
 *       "match": { "sender": "petrus", "keywords": ["hello", "hi"] },
 *       "action": { "type": "post", "room": "${room}", "body": "Hello! I am here." }
 *     },
 *     {
 *       "name": "poll-comments",
 *       "match": { "keywords": ["check comments", "poll comments"] },
 *       "action": { "type": "exec", "command": "node bin/cli.mjs comments poll" }
 *     },
 *     {
 *       "name": "catch-mention",
 *       "match": { "mention": "@claudemm", "regex": "deploy|ship|release" },
 *       "action": { "type": "nudge", "text": "check rooms" }
 *     }
 *   ]
 */

const SEEN_FILE_DEFAULT = '/tmp/iak-automation-seen.txt';

function loadSeenIds(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

// Write through a temp file and rename. A direct write that is interrupted
// leaves a truncated or empty seen-file, and an empty seen-file on the next
// start means every historical message is unseen again -- a crash during a
// routine save becomes a replay of privileged commands (@codexmb). rename(2)
// within a directory is atomic, so a reader sees the old file or the new one
// and never a half-written one.
function saveSeenIds(path, ids) {
  const arr = [...ids].slice(-2000);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, arr.join('\n') + '\n');
    renameSync(tmp, path);
  } catch (e) {
    // Losing the save is survivable; losing it SILENTLY is not, because the
    // consequence lands on the next startup as a replay.
    console.error(`  FAILED to persist seen ids to ${path}: ${e.message}`);
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Returns an array on success and NULL on failure. The difference matters: []
// for a failed fetch made "the room is quiet" and "I could not ask" identical,
// so seeding could complete on nothing and the first poll that DID succeed
// treated the whole history as new -- fail-open seeding on a dispatch path
// (@codexmb).
//
// The key also no longer goes through a shell: `curl -H "X-API-Key: ${key}"`
// under execSync puts the credential in the process table for anyone running ps.
export // The base is injectable ONLY so the startup/replay path can be exercised
// against a stub room server. @codexmb: "handle tests alone do not exercise
// poller startup/replay" -- and they cannot, if the host is hardcoded.
let API_BASE = 'https://groupmind.one/api/v1';
export function __setApiBaseForTest(base) { API_BASE = base || 'https://groupmind.one/api/v1'; }

export async function fetchRoomMessages(room, apiKey, limit = 20) {
  const url = `${API_BASE}/rooms/${encodeURIComponent(room)}/messages?limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`  fetch ${room} failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.messages || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(`  fetch ${room} failed: ${e.message}`);
    return null;
  }
}

async function postMessage(room, body, apiKey, config) {
  if (isAckOnly(body)) {
    console.log(`  ack-only message filtered, skipping post to ${room}: ${body.slice(0, 60)}`);
    return false;
  }
  if (!canSend(config)) {
    console.log(`  rate-limited (${config?.rate_limit?.message_interval_sec || 30}s interval), skipping post to ${room}`);
    return false;
  }
    // The old version shelled out to curl and returned true whenever curl exited
    // 0 -- which it does for a 500. A receipt then said "completed" for a message
    // that never reached the room (@codexmb). The status is checked now, and the
    // key no longer travels through a command line where ps can read it.
    try {
      const res = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, body }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`  post failed: HTTP ${res.status}`);
        return false;
      }
      markSent();
      return true;
    } catch (e) {
      console.error(`  post failed: ${e.message}`);
      return false;
    }
}

/**
 * Check if a message matches a rule's conditions.
 */
// ---------------------------------------------------------------------------
// /lead — the chat command Petrus asked for on 2026-09-18 07:25 ("Team lead
// assigned by me dynamically (chat command?)").
//
//   /lead @agent   appoint or transfer     /lead status   who holds it
//   /lead clear    vacate the post
//
// HANDLED HERE, NOT AS A CONFIGURABLE RULE, on purpose. Who may approve
// commands on this machine is not something that should be editable by adding
// an entry to a rules array in a JSON file — a rule that grants approval
// rights is a rule someone can write by accident.
//
// AUTHORISATION IS DOUBLE-KEYED: the sender must be the owner handle AND the
// message must be flagged as human. Either alone is too weak — agents post
// under their own handles with isHuman false, and a tapped action button
// arrives as `petrus` with isHuman false (see the action-button notes), so
// requiring both means neither an agent quoting this syntax nor a replayed
// button can appoint anyone. The daemon enforces the same rules again; this
// is the outer key, not the only one.
// ---------------------------------------------------------------------------

const LEAD_COMMAND_RE = /^\s*\/lead\b\s*(.*)$/i;

function parseLeadCommand(body) {
  // Read the FIRST LINE only. The original regex ran against the whole body
  // with no /m flag, so `$` demanded end-of-string and any second line made the
  // command invisible: @claudeMB's test message was "/lead status" followed by
  // a note to petrus, and it was silently ignored. Someone typing a command and
  // then a sentence has still typed a command.
  const lines = String(body || '').split('\n');
  const m = LEAD_COMMAND_RE.exec(lines[0] || '');
  if (!m) return null;
  const rest = (m[1] || '').trim();
  const hasMoreLines = lines.slice(1).join('').trim().length > 0;
  if (!rest || /^status$/i.test(rest)) return { op: 'status' };
  if (/^clear$/i.test(rest)) return { op: 'clear' };
  // STRICT on purpose: exactly one token, nothing trailing. Taking the first
  // word of "/lead somebody nice please" and appointing @somebody is a wrong
  // guess that hands command-approval rights to the wrong agent. When the
  // input is not unambiguous, refuse and say so.
  if (!/^@?[A-Za-z0-9_.-]+$/.test(rest)) return { op: 'invalid', handle: rest };
  // Appointing is a PRIVILEGE GRANT, so it stays maximally strict: the command
  // must be the whole message. Reading it out of the first line of a longer
  // post is how a quoted line becomes an appointment. Status and clear are
  // harmless reads and may carry trailing prose.
  if (hasMoreLines) return { op: 'not-alone', handle: rest };
  return { op: 'assign', handle: rest.replace(/^@+/, '') };
}

async function callDaemon(daemonUrl, path, { method = 'GET', body, token } = {}) {
  // `token` is the caller's PER-AGENT principal token. Without it the daemon
  // cannot tell who is asking, and POST /lead refuses outright ("delegation is
  // unavailable"). That refusal is correct and it is why /lead had never
  // worked end to end: this function attached no identity at all, so a
  // perfectly authorised owner command died at the last hop. Verified live
  // 2026-09-19: POST /lead -> 403, GET /lead -> 200.
  //
  // Omitted when unset, so a daemon with no principals configured behaves
  // exactly as before rather than sending an empty Bearer.
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${daemonUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, payload };
}

/**
 * Returns a reply string when the message was a /lead command, or null when it
 * was not one. Never throws: a daemon that is down must not stop the poller.
 */
export async function handleLeadCommand(msg, { daemonUrl, ownerHandle = 'petrus', principalToken } = {}) {
  const parsed = parseLeadCommand(msg.body || '');
  if (!parsed) return null;

  const sender = (msg.user?.handle || msg.from || msg.sender || '').replace(/^@+/, '').toLowerCase();
  const owner = ownerHandle.replace(/^@+/, '').toLowerCase();
  const fromOwner = sender === owner && msg.isHuman === true;

  try {
    if (parsed.op === 'status') {
      const { status, payload } = await callDaemon(daemonUrl, '/lead');
      // A daemon that does not KNOW about /lead answers 404, and reading that
      // as "unset" would be a false answer wearing a legitimate one — the same
      // failure shape as an empty list that is really a broken query. Say the
      // feature is not running instead.
      if (status === 404 || !payload?.ok) {
        return 'Team lead: this daemon does not have /lead — the feature is built but not '
          + 'running here yet (it needs a restart). Confirmations are owner-only meanwhile.';
      }
      const lead = payload.lead;
      return lead
        ? `Team lead: ${lead.handle} (assigned by ${lead.assignedBy}).`
        : 'Team lead: unset. Only the owner can decide confirmations, and only the owner can appoint a lead.';
    }
    if (parsed.op === 'not-alone') {
      // Say WHY. "@grok is not a handle" would be false and would send whoever
      // typed it looking for a typo that is not there.
      return `Appointing a lead has to be the whole message. Send just "/lead @${parsed.handle.replace(/^@+/, '')}" `
        + 'on its own, with nothing after it.';
    }
    if (parsed.op === 'invalid') {
      return `"${parsed.handle}" is not a handle. Use /lead @agent, /lead status or /lead clear.`;
    }
    if (!fromOwner) {
      // Say which key was missing rather than a flat refusal — a lead trying to
      // hand over from chat needs to know the daemon route exists for that.
      return `Only ${ownerHandle} can change the team lead from chat. A sitting lead may hand over via the daemon.`;
    }
    const { status, payload } = await callDaemon(daemonUrl, '/lead', {
      method: 'POST',
      body: { handle: parsed.op === 'clear' ? null : parsed.handle, actor: ownerHandle },
      token: principalToken,
    });
    // A 403 here is the daemon saying it cannot identify the caller, which is
    // a CONFIGURATION fault on this side, not a refusal of the user. Saying
    // "forbidden" would send petrus looking for a permission he already has.
    if (status === 403 && !principalToken) {
      return 'Team lead is not configured on this machine: the room poller has no '
        + 'principal token, so the daemon cannot tell that the request comes from it. '
        + 'Nothing was changed.';
    }
    if (payload?.ok) {
      return parsed.op === 'clear'
        ? 'Team lead cleared. Confirmations are owner-only again.'
        : `Team lead is now @${parsed.handle}. Destructive, credential and paid actions still wait for ${ownerHandle}.`;
    }
    return `Could not change the lead (${status}): ${payload?.error || 'no response'}`;
  } catch (e) {
    return `Could not reach the confirmations daemon: ${e.message}`;
  }
}

function matchesRule(msg, rule) {
  const match = rule.match || {};
  const body = (msg.body || '').toLowerCase();
  const sender = (msg.user?.handle || msg.from || msg.sender || '').toLowerCase();
  const room = msg.room || '';

  // Sender filter
  if (match.sender && !sender.includes(match.sender.toLowerCase())) return false;

  // Room filter
  if (match.room && room !== match.room) return false;

  // Keyword match (any keyword present)
  if (match.keywords && match.keywords.length > 0) {
    const hasKeyword = match.keywords.some(kw => body.includes(kw.toLowerCase()));
    if (!hasKeyword) return false;
  }

  // Mention match
  if (match.mention) {
    const mention = match.mention.toLowerCase().replace('@', '');
    if (!body.includes(`@${mention}`) && !body.includes(mention)) return false;
  }

  // Regex match
  if (match.regex) {
    try {
      const re = new RegExp(match.regex, 'i');
      if (!re.test(msg.body || '')) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Execute a rule action and return a receipt.
 */
async function executeAction(action, msg, apiKey, config) {
  const startedAt = new Date().toISOString();
  if (!action) {
    return createReceipt({
      actor: { name: 'automation', kind: 'unknown' },
      action: 'missing action block',
      status: 'skipped',
      startedAt,
    });
  }
  const room = msg.room || '';

  // Template substitution for action fields
  const sub = (str) => (str || '')
    .replace(/\$\{room\}/g, room)
    .replace(/\$\{sender\}/g, msg.user?.handle || msg.from || '?')
    .replace(/\$\{body\}/g, (msg.body || '').slice(0, 200));

  if (action.type === 'post') {
    const targetRoom = sub(action.room) || room;
    const body = sub(action.body);
    const ok = await postMessage(targetRoom, body, apiKey, config);
    return createReceipt({
      actor: { name: config?.poller?.handle || 'ide-agent-kit', kind: 'automation' },
      action: `post to ${targetRoom}`,
      status: ok ? 'ok' : 'rate-limited',
      notes: ok ? `Posted: ${body.slice(0, 100)}` : 'Rate-limited or post failed',
      startedAt,
    });
  }

  if (action.type === 'exec') {
    const cmd = sub(action.command);
    const timeout = action.timeout || 30000;
    try {
      const output = execSync(cmd, { encoding: 'utf8', timeout, cwd: action.cwd });
      return createReceipt({
        actor: { name: 'automation', kind: 'exec' },
        action: `exec: ${cmd.slice(0, 80)}`,
        status: 'ok',
        exitCode: 0,
        stdoutTail: output.slice(-500),
        startedAt,
      });
    } catch (e) {
      return createReceipt({
        actor: { name: 'automation', kind: 'exec' },
        action: `exec: ${cmd.slice(0, 80)}`,
        status: 'error',
        exitCode: e.status || 1,
        stderrTail: (e.stderr || e.message || '').slice(-500),
        startedAt,
      });
    }
  }

  if (action.type === 'nudge') {
    const session = config?.tmux?.ide_session || 'claude';
    const text = sub(action.text) || 'check rooms';
    try {
      execSync(`tmux send-keys -t ${JSON.stringify(session)} -l ${JSON.stringify(text)}`);
      execSync('sleep 0.3');
      execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`);
      return createReceipt({
        actor: { name: 'automation', kind: 'nudge' },
        action: `nudge tmux ${session}`,
        status: 'ok',
        notes: `Sent: ${text}`,
        startedAt,
      });
    } catch (e) {
      return createReceipt({
        actor: { name: 'automation', kind: 'nudge' },
        action: `nudge tmux ${session}`,
        status: 'error',
        notes: e.message,
        startedAt,
      });
    }
  }

  return createReceipt({
    actor: { name: 'automation', kind: 'unknown' },
    action: `unknown action type: ${action.type}`,
    status: 'skipped',
    startedAt,
  });
}

/**
 * Start the room automation engine.
 *
 * @param {object} opts - { rooms, apiKey, handle, interval, config, rules }
 */
export { isAckOnly };

export async function startRoomAutomation({ rooms, apiKey, handle, interval, config }) {
  const rules = config?.automation?.rules || [];
  const seenFile = config?.automation?.seen_file || SEEN_FILE_DEFAULT;
  const receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';
  const pollInterval = interval || config?.automation?.interval_sec || 30;
  const selfHandle = resolveSelfHandle({ explicit: handle, config });
  if (config?.automation?.api_base) __setApiBaseForTest(config.automation.api_base);
  const cooldownMs = (config?.automation?.cooldown_sec || 5) * 1000;

  console.log(`Room automation started`);
  console.log(`  rooms: ${rooms.join(', ')}`);
  console.log(`  rules: ${rules.length}`);
  console.log(`  interval: ${pollInterval}s`);
  console.log(`  cooldown: ${cooldownMs / 1000}s`);

  if (rules.length === 0) {
    console.log('  WARNING: No automation rules configured. Add rules to automation.rules in config.');
  }

  const seen = loadSeenIds(seenFile);
  const lastFired = new Map(); // rule name → timestamp

  // Seed on first run, and REFUSE TO DISPATCH if seeding could not complete.
  //
  // The old version treated a failed fetch as an empty room, so a transient
  // network error at startup produced a "successful" seed of nothing -- and the
  // first poll that worked then saw every historical message as new. On a path
  // that can execute /lead or /approve, that is a replay of privileged history
  // caused by a dropped packet (@codexmb).
  //
  // Dispatch is gated on `ready`. Seeding retries on the poll interval until it
  // succeeds; until then the loop executes nothing.
  // Seeding is per ROOM, not per process. `seen.size > 0` was enough to declare
  // the whole thing seeded, so adding a room to the list later meant its entire
  // history arrived as new and any historical /lead in it would dispatch
  // (@codexmb). The marker file records WHICH rooms have been seeded.
  const seededFile = `${seenFile}.seeded`;
  const seededRooms = new Set(
    (() => { try { return readFileSync(seededFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } })()
  );
  function markSeeded(room) {
    seededRooms.add(room);
    const tmp = `${seededFile}.tmp-${process.pid}`;
    try { writeFileSync(tmp, [...seededRooms].join('\n') + '\n'); renameSync(tmp, seededFile); }
    catch (e) { console.error(`  FAILED to record seeded rooms: ${e.message}`); try { unlinkSync(tmp); } catch {} throw e; }
  }
  // A pre-existing seen-file from before this marker existed counts as having
  // seeded the rooms configured at that time -- otherwise the upgrade itself
  // would replay them. New rooms added after this point still seed properly.
  if (seen.size > 0 && seededRooms.size === 0) {
    for (const room of rooms) seededRooms.add(room);
    try { markSeeded(rooms[0]); } catch {}
    console.log(`  existing seen-file adopted for ${rooms.length} room(s)`);
  }

  async function trySeed() {
    const pending = rooms.filter(r => !seededRooms.has(r));
    if (!pending.length) return true;
    console.log(`  seeding ${pending.length} room(s): ${pending.join(', ')}`);
    for (const room of pending) {
      const msgs = await fetchRoomMessages(room, apiKey, 50);
      if (msgs === null) {
        console.error(`  seeding ABORTED: could not read ${room}. Dispatch stays off until it succeeds.`);
        return false;
      }
      for (const m of msgs) if (m.id) seen.add(m.id);
      saveSeenIds(seenFile, seen);
      markSeeded(room);
      console.log(`  seeded ${room}; ${seen.size} ids known`);
    }
    return true;
  }
  let ready = await trySeed();

  async function poll() {
    let actionsRun = 0;
    const now = Date.now();

    if (!ready) {
      ready = await trySeed();
      if (!ready) return;   // still blind: execute nothing
    }

    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey);
      if (msgs === null) continue;   // could not read this room; do not guess
      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue;
        // Mark seen and PERSIST before acting. The old order saved once at the
        // end of the poll, so a crash between executing a command and saving
        // replayed it on restart (@codexmb). At-most-once is the right bias for
        // a privileged action: a missed /lead is a message petrus can send
        // again, a repeated one is an appointment he never made.
        seen.add(m.id);
        saveSeenIds(seenFile, seen);

        // Skip own messages (case-insensitive; see src/common/handles.mjs)
        const sender = m.user?.handle || m.from || m.sender || '';
        if (isSelfSender(sender, selfHandle)) continue;

        // Attach room for rule matching
        m.room = room;

        // /lead runs BEFORE the configurable rules and consumes the message.
        // It is a command about who may approve things, so it must not be
        // shadowed, cooled down or overridden by whatever is in the rules
        // array.
        const leadReply = await handleLeadCommand(m, {
          daemonUrl: config?.confirmations?.daemon_url || 'http://127.0.0.1:8788',
          ownerHandle: config?.poller?.owner_handle || 'petrus',
        });
        if (leadReply !== null) {
          const posted = await postMessage(room, leadReply, apiKey, config);
          if (!posted) {
            // A receipt that says "completed" for a reply nobody can see is
            // worse than no receipt: it is the silence petrus experienced,
            // recorded as a success (@codexmb).
            console.error('  /lead reply was NOT posted; not recording it as completed');
          }
          appendReceipt(receiptPath, createReceipt({
            actor: { name: 'automation', kind: 'command' },
            action: `/lead from ${m.user?.handle || m.from || '?'}`,
            // The status is what HAPPENED, not what was attempted. This said
            // 'completed' even when the post returned false, recording the exact
            // silence petrus hit as a success (@codexmb).
            status: posted ? 'completed' : 'failed',
            startedAt: new Date().toISOString(),
          }));
          actionsRun++;
          continue;
        }

        // Check each rule
        for (const rule of rules) {
          if (!matchesRule(m, rule)) continue;

          // Cooldown check
          const lastTime = lastFired.get(rule.name) || 0;
          if (now - lastTime < cooldownMs) {
            console.log(`  rule "${rule.name}" cooled down, skipping`);
            continue;
          }

          console.log(`  rule "${rule.name}" matched → ${rule.action?.type || '?'}`);
          const receipt = await executeAction(rule.action, m, apiKey, config);
          appendReceipt(receiptPath, receipt);
          lastFired.set(rule.name, now);
          actionsRun++;

          // Only fire first matching rule per message (avoid cascades)
          if (config?.automation?.first_match_only !== false) break;
        }
      }
    }

    saveSeenIds(seenFile, seen);

    if (actionsRun > 0) {
      console.log(`  ${actionsRun} automation action(s) executed`);
    }
  }

  // setInterval(poll) fired an async function and dropped the promise, so a
  // rejection inside a later poll went to unhandledRejection while the loop
  // carried on looking healthy -- the CLI's .catch only ever covered the FIRST
  // call (@codexmb). This schedules the next run only after the previous one
  // settles, and a failure is loud without stopping the loop.
  let stopped = false;
  let timer = null;
  const runLoop = async () => {
    if (stopped) return;
    try {
      await poll();
    } catch (e) {
      console.error(`  poll failed: ${e?.message || e}`);
      console.error('  automation continues; dispatch stays gated on a successful seed.');
    }
    if (!stopped) timer = setTimeout(runLoop, pollInterval * 1000);
  };
  await runLoop();

  process.on('SIGINT', () => {
    console.log('\nAutomation stopped.');
    stopped = true; if (timer) clearTimeout(timer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopped = true; if (timer) clearTimeout(timer);
    process.exit(0);
  });

  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
