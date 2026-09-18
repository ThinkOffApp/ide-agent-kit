// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createReceipt, appendReceipt } from './receipt.mjs';
import { canSend, markSent } from './rate-limiter.mjs';
import { shouldSuppressNudge } from './intent.mjs';
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

function saveSeenIds(path, ids) {
  const arr = [...ids].slice(-2000);
  writeFileSync(path, arr.join('\n') + '\n');
}

function fetchRoomMessages(room, apiKey, limit = 20) {
  const url = `https://groupmind.one/api/v1/rooms/${room}/messages?limit=${limit}`;
  try {
    const result = execSync(
      `curl -sS -H "X-API-Key: ${apiKey}" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    return data.messages || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(`  fetch ${room} failed: ${e.message}`);
    return [];
  }
}

function postMessage(room, body, apiKey, config) {
  if (isAckOnly(body)) {
    console.log(`  ack-only message filtered, skipping post to ${room}: ${body.slice(0, 60)}`);
    return false;
  }
  if (!canSend(config)) {
    console.log(`  rate-limited (${config?.rate_limit?.message_interval_sec || 30}s interval), skipping post to ${room}`);
    return false;
  }
  const payload = JSON.stringify({ room, body });
  try {
    execSync(
      `curl -sS -X POST "https://groupmind.one/api/v1/messages" -H "X-API-Key: ${apiKey}" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`,
      { timeout: 15000 }
    );
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

async function callDaemon(daemonUrl, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${daemonUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
export async function handleLeadCommand(msg, { daemonUrl, ownerHandle = 'petrus' } = {}) {
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
    });
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
// `muted` is petrus's emergency-only mode, resolved once per poll cycle by the
// caller (shouldSuppressNudge is async; this function is not).
//
// The carve-out is the point, and it is the same one the room and DM pollers
// already make: HIS OWN MESSAGES ALWAYS GET AN ANSWER. Emergency-only exists to
// silence agent chatter, not to make the room stop answering the person typing
// in it -- a withheld reply to a command he just sent is indistinguishable from
// a crash, which is a failure this repo keeps rediscovering.
function executeAction(action, msg, apiKey, config, muted = false) {
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
    const ownerHandle = String(config?.poller?.owner_handle || 'petrus').replace(/^@+/, '').toLowerCase();
    const sender = String(msg.user?.handle || msg.from || msg.sender || '').replace(/^@+/, '').toLowerCase();
    if (muted && sender !== ownerHandle) {
      console.log(`  emergency-only: skipping self-initiated post to ${targetRoom} (trigger from ${sender || '?'})`);
      return createReceipt({
        actor: { name: config?.poller?.handle || 'ide-agent-kit', kind: 'automation' },
        action: `post to ${targetRoom}`,
        status: 'suppressed',
        notes: 'emergency-only mode: agent-triggered post withheld',
        startedAt,
      });
    }
    const ok = postMessage(targetRoom, body, apiKey, config);
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

  // Seed on first run
  if (seen.size === 0) {
    console.log(`  seeding seen IDs...`);
    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey, 50);
      for (const m of msgs) {
        if (m.id) seen.add(m.id);
      }
    }
    saveSeenIds(seenFile, seen);
    console.log(`  seeded ${seen.size} IDs`);
  }

  async function poll() {
    let actionsRun = 0;
    const now = Date.now();
    // Resolved ONCE per cycle, not per message: shouldSuppressNudge hits the
    // intent API, and doing it per message would turn one poll into dozens of
    // calls. Fails open (false) on any error, same as the pollers -- a broken
    // presence lookup must never silence the room.
    const muted = await shouldSuppressNudge(config);
    if (muted) console.log('  emergency-only: agent-triggered posts withheld; his own still answered');

    for (const room of rooms) {
      const msgs = fetchRoomMessages(room, apiKey);
      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);

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
          postMessage(room, leadReply, apiKey, config);
          appendReceipt(receiptPath, createReceipt({
            actor: { name: 'automation', kind: 'command' },
            action: `/lead from ${m.user?.handle || m.from || '?'}`,
            status: 'completed',
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
          const receipt = executeAction(rule.action, m, apiKey, config, muted);
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

  // Initial poll
  await poll();

  // Start interval
  const timer = setInterval(poll, pollInterval * 1000);

  process.on('SIGINT', () => {
    console.log('\nAutomation stopped.');
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });

  return timer;
}

// Exported for tests only: the mute carve-out is the kind of logic that must
// be provable, not eyeballed, because both of its failure modes are silent.
export { executeAction as executeActionForTest };
