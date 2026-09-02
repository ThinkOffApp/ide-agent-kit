import { NOTIFY_FILE_DEFAULT, SEEN_FILE_DEFAULT, QUEUE_PATH_DEFAULT } from '../common/constants.mjs';
import { loadSeenIds, saveSeenIds as saveSeenIdsShared } from '../common/seen-ids.mjs';
import { enrichEvent } from './enrichment.mjs';
// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nudgeCommand } from '../utils.mjs';
import { shouldSuppressNudge } from '../intent.mjs';
import { resolveSelfHandle } from '../common/handles.mjs';
import { resolveReplyTargets, replyAnnotation } from '../common/reply-context.mjs';
import { RoomHistory, threadSuffix, previousSuffix, stateOfPlayLine, ownLastPostLine } from '../common/room-history.mjs';

/**
 * Room Poller — polls GroupMind rooms and notifies IDE agent of new messages.
 * Works for any IDE agent (Claude Code, Codex, Gemini, Cursor).
 * No webhooks required — just an API key.
 *
 * Notification delivery (in order of priority):
 *   1. Notification file (always) — human-readable file that the IDE agent reads
 *   2. Optional nudge path (tmux/command/none)
 *
 * The IDE agent calls `rooms check` to read and clear the notification file.
 *
 * Usage:
 *   ide-agent-kit rooms watch --config <path>
 *   ide-agent-kit rooms check --config <path>
 */




// Seen-state comes from the shared module (atomic + fsynced, issue #90).
// The marker is written after EACH handled message below, never once per
// batch: a batch can hold a task that runs for an hour, and a restart inside
// it replayed a whole day on the M5 (2026-09-01).
// 20000, not 1000: the cap is global across rooms, and thinkoff-development
// alone produces >1000 messages between restarts, so the quiet rooms' last
// ids fell off the end of the file and EVERY restart replayed months-old
// messages as new (2026-09-02: 80+ replayed lines from four rooms).
const SEEN_CAP = 20000;
const saveSeenIds = (path, ids) => saveSeenIdsShared(path, ids, SEEN_CAP);

const DM_SEEN_FILE_DEFAULT = '/tmp/iak-dm-seen-ids.txt';

function normalizeHandle(handle) {
  if (typeof handle !== 'string') return '';
  // Lowercased for comparison: GroupMind returns the handle's REGISTERED
  // casing in `from` fields (e.g. '@claudeMB') while configs usually hold
  // '@claudemb'. Handles are case-insensitive identities; a case-sensitive
  // compare let every self-post back into the wake pipeline.
  const trimmed = handle.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function appendNotifications(path, lines) {
  if (lines.length === 0) return;
  appendFileSync(path, lines.join('\n') + '\n');
}

function triggerNudge({ nudgeMode, nudgeCommandText, nudgeText, session }) {
  if (nudgeMode === 'command') {
    return nudgeCommand(nudgeCommandText, { text: nudgeText, session });
  }
  if (nudgeMode === 'none') {
    return false;
  }
  return nudgeTmux(session, nudgeText);
}

export function isRelevantDirectMessage(message, { selfHandle, humanOnly = false } = {}) {
  if (!message || message.type !== 'dm' || !message.id) return false;
  const sender = normalizeHandle(message.from || message.sender);
  const recipient = normalizeHandle(message.to);
  const expectedRecipient = normalizeHandle(selfHandle);
  if (!sender || !recipient || !expectedRecipient) return false;
  if (recipient !== expectedRecipient) return false;
  if (sender === expectedRecipient) return false;
  if (humanOnly && !message?.metadata?.user) return false;
  return true;
}

function nudgeTmux(session, text) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`);
  } catch {
    return false;
  }
  try {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} -l ${JSON.stringify(text)}`);
    execSync('sleep 0.3');
    execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`);
    return true;
  } catch {
    return false;
  }
}

async function fetchRoomMessages(room, apiKey, limit = 10) {
  const url = `https://groupmind.one/api/v1/rooms/${room}/messages?limit=${limit}`;
  try {
    const result = execSync(
      `curl -sS -4 -H "X-API-Key: ${apiKey}" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    return data.messages || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(`  fetch ${room} failed: ${e.message}`);
    return [];
  }
}

async function fetchDirectMessages(apiKey, limit = 100) {
  const url = `https://groupmind.one/api/v1/messages?limit=${limit}`;
  try {
    const result = execSync(
      `curl -sS -4 -H "X-API-Key: ${apiKey}" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    return data.messages || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(`  fetch direct messages failed: ${e.message}`);
    return [];
  }
}

/**
 * Read and clear the notification file. Returns array of message lines.
 * This is the primary way the IDE agent retrieves new messages.
 */
export function checkRoomMessages(config) {
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  try {
    const content = readFileSync(notifyFile, 'utf8').trim();
    if (!content) return [];
    // Clear the file after reading
    writeFileSync(notifyFile, '');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const HEARTBEAT_FILE_DEFAULT = '/tmp/iak-poller.heartbeat';

// The poller's liveness signal for everything that must not act while it is
// down: the GUI nudge (a nudge with no seen-state re-answers every open
// mention) and the supervisor's one-time alert. A crash-looping launchd job
// leaves no other trace a script can read (issue #86). This is the module the
// CLI actually runs - src/room-poller.mjs is the unimported legacy copy
// (codex review of PR #87 caught the heartbeat landing there first).
export function writeHeartbeat(path) {
  try {
    writeFileSync(path, new Date().toISOString() + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * First-run seed for one room: every current message is marked seen (do not
 * answer the backlog) AND stored in the history (do not lose the thread when
 * the next poll replies to one of them). Exported for the regression test.
 */
export function seedRoom({ seen, history, room, msgs }) {
  let added = 0;
  for (const m of msgs || []) {
    if (m && m.id && !seen.has(m.id)) { seen.add(m.id); added++; }
  }
  if (history && typeof history.remember === 'function') history.remember(room, msgs || []);
  return added;
}

export async function startRoomPoller({ rooms, apiKey, handle, interval, config, sessionOpt }) {
  const seenFile = config?.poller?.seen_file || SEEN_FILE_DEFAULT;
  const heartbeatFile = config?.poller?.heartbeat_file || HEARTBEAT_FILE_DEFAULT;
  // Belt for the same replay: a message first seen when it is already older
  // than this is remembered but never notified or queued. Nobody wants a
  // March question re-delivered in September, whatever the seen-file lost.
  const maxAgeSec = parsePositiveInt(config?.poller?.max_age_sec, 6 * 3600);
  // Per-room message history: resolves reply targets older than the fetch
  // window, supplies the asker's previous message, the agent's own last post
  // and the room's "state:" facts (issue #90). One file per poller.
  const historyFile = config?.poller?.history_file || seenFile.replace(/\.txt$/, '') + '-history.json';
  const fetchLimit = parsePositiveInt(config?.poller?.fetch_limit, 25);
  const history = new RoomHistory(historyFile);
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = sessionOpt || config?.tmux?.ide_session || config?.tmux?.default_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';
  const nudgeMode = config?.poller?.nudge_mode || 'tmux';
  const nudgeCommandText = config?.poller?.nudge_command || '';
  const pollInterval = parsePositiveInt(interval || config?.poller?.interval_sec, 30);
  const selfHandle = normalizeHandle(resolveSelfHandle({ explicit: handle, config }));
  // The human owner's handle. Messages from the owner ALWAYS nudge, even in
  // emergency-only mode — a message from the user is itself the priority signal;
  // emergency-only is meant to mute agent/fleet chatter, not the user's own words.
  const ownerHandle = normalizeHandle(config?.poller?.owner_handle || 'petrus');
  // Nudge throttle: (1) only owner messages or @-mentions of this agent fire a
  // nudge — other fleet traffic just lands in the notification file and gets
  // read on the next natural wake; (2) a cooldown collapses rapid-fire messages
  // into one wake, since the agent reads ALL pending messages once woken.
  const nudgeCooldownSec = parsePositiveInt(config?.poller?.nudge_cooldown_sec, 90);
  let lastNudgeAt = 0;
  function nudgeGate(hasPriority) {
    if (!hasPriority) return { fire: false, why: 'no owner/mention in batch' };
    const now = Date.now();
    if (now - lastNudgeAt < nudgeCooldownSec * 1000) {
      return { fire: false, why: `cooldown ${nudgeCooldownSec}s` };
    }
    lastNudgeAt = now;
    return { fire: true, why: '' };
  }
  const dmCfg = config?.dm_poller || {};
  const dmEnabled = dmCfg.enabled === true;
  const dmHandle = normalizeHandle(dmCfg.handle || selfHandle);
  const dmSeenFile = dmCfg.seen_file || DM_SEEN_FILE_DEFAULT;
  const dmNotifyFile = dmCfg.notification_file || notifyFile;
  const dmPollInterval = parsePositiveInt(dmCfg.interval_sec, pollInterval);
  const dmApiKey = dmCfg.api_key || dmCfg.apiKey || config?.poller?.api_key || config?.poller?.apiKey || apiKey;
  const dmHumanOnly = dmCfg.human_only === true;
  const dmLimit = parsePositiveInt(dmCfg.limit, 100);

  console.log(`Room poller started`);
  console.log(`  rooms: ${rooms.join(', ')}`);
  console.log(`  handle: ${selfHandle} (messages from self are ignored)`);
  console.log(`  interval: ${pollInterval}s`);
  console.log(`  notification file: ${notifyFile}`);
  console.log(`  nudge mode: ${nudgeMode}`);
  if (nudgeMode === 'tmux') {
    console.log(`  tmux session: ${session} (optional)`);
  } else if (nudgeMode === 'command') {
    console.log(`  nudge command: ${nudgeCommandText || '(missing)'}`);
  }
  console.log(`  seen file: ${seenFile}`);
  console.log(`  heartbeat: ${heartbeatFile}`);
  console.log(`  max age: ${maxAgeSec}s (older first-seen messages are remembered, not delivered)`);
  console.log(`  history: ${historyFile} (fetch ${fetchLimit}/poll)`);
  if (dmEnabled) {
    console.log(`  direct messages: enabled`);
    console.log(`    dm handle: ${dmHandle}`);
    console.log(`    dm interval: ${dmPollInterval}s`);
    console.log(`    dm seen file: ${dmSeenFile}`);
    console.log(`    dm notify file: ${dmNotifyFile}`);
    console.log(`    dm limit: ${dmLimit}`);
    console.log(`    dm human only: ${dmHumanOnly}`);
  }
  console.log(`  queue: ${queuePath}`);

  const seen = loadSeenIds(seenFile);
  const dmSeen = dmEnabled ? loadSeenIds(dmSeenFile) : new Set();

  // Seed: mark current messages as seen on first run, and REMEMBER them, so
  // a reply to one of these on the very next poll still gets its parent
  // (codexmb, PR #92 review: seeding without history lost first-run context).
  if (seen.size === 0) {
    console.log(`  seeding seen IDs from current messages...`);
    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey, 50);
      seedRoom({ seen, history, room, msgs });
    }
    saveSeenIds(seenFile, seen);
    history.save();
    console.log(`  seeded ${seen.size} IDs`);
  }

  if (dmEnabled && dmSeen.size === 0) {
    console.log(`  seeding seen IDs from current direct messages...`);
    const directMessages = await fetchDirectMessages(dmApiKey, dmLimit);
    for (const message of directMessages) {
      if (isRelevantDirectMessage(message, { selfHandle: dmHandle, humanOnly: dmHumanOnly })) {
        dmSeen.add(message.id);
      }
    }
    saveSeenIds(dmSeenFile, dmSeen);
    console.log(`  seeded ${dmSeen.size} DM IDs`);
  }

  let roomPollInFlight = false;
  let dmPollInFlight = false;

  async function pollRooms() {
    if (roomPollInFlight) return;
    roomPollInFlight = true;
    try {
    writeHeartbeat(heartbeatFile);
    let newCount = 0;
    let staleSkipped = 0;
    let hasOwnerMessage = false;
    let hasMention = false;
    const mentionNeedle = (selfHandle.startsWith('@') ? selfHandle : '@' + selfHandle).toLowerCase();
    const newMessages = [];
    for (const room of rooms) {
      let msgs = await fetchRoomMessages(room, apiKey, fetchLimit);
      history.remember(room, msgs);
      const lookup = (id) => history.get(room, id);
      resolveReplyTargets(msgs, lookup);
      // A reply whose target is older than both the window and our history:
      // one deeper fetch per room per poll, then resolve again.
      if (msgs.some((m) => m._replyToId && !m._replyTarget && !seen.has(m.id))) {
        const deeper = await fetchRoomMessages(room, apiKey, 100);
        if (deeper.length) {
          history.remember(room, deeper);
          resolveReplyTargets(msgs, lookup);
        }
      }
      const roomLines = [];
      let roomPriority = false;
      let roomHeaderWritten = false;
      for (const m of msgs) {
        const mid = m.id;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        const ageSec = (Date.now() - Date.parse(m.created_at || '')) / 1000;
        if (Number.isFinite(ageSec) && ageSec > maxAgeSec) {
          staleSkipped++;
          saveSeenIds(seenFile, seen);
          continue;
        }

        const sender = m.from || m.sender || '?';
        const normalizedSender = normalizeHandle(sender);
        // Skip own messages
        if (normalizedSender === selfHandle) continue;
        const mentionsSelf = (m.body || '').toLowerCase().includes(mentionNeedle);
        if (normalizedSender === ownerHandle) { hasOwnerMessage = true; roomPriority = true; }
        if (mentionsSelf) { hasMention = true; roomPriority = true; }
        // Context header (settled facts, our own last post) goes to the
        // notification file once per room, right before the first line that
        // makes this batch worth a wake - so the reader still sees header
        // then lines, while every line is on disk before its seen-marker
        // (#91 per-message durability on top of #92's thread context).
        if (roomPriority && !roomHeaderWritten) {
          roomHeaderWritten = true;
          const sop = stateOfPlayLine(history, room);
          if (sop) appendNotifications(notifyFile, [sop]);
          const own = ownLastPostLine(history, room, selfHandle);
          if (own) appendNotifications(notifyFile, [own]);
        }

        let body = (m.body || '').slice(0, 500);
        // Surface attachments (2026-07-19 lost-screenshot lesson): an
        // image/audio/file must never be invisible to the agent.
        if (m.image_url) body += ` [IMAGE ATTACHED: ${m.image_url}]`;
        if (m.audio_url) body += ` [AUDIO ATTACHED: ${m.audio_url}]`;
        if (m.file_url) body += ` [FILE ATTACHED: ${m.file_name || m.file_url}]`;
        const ts = m.created_at || new Date().toISOString();

        // Write to structured queue
        const rawEvent = {
          trace_id: randomUUID(),
          event_id: mid,
          source: 'groupmind',
          kind: 'groupmind.message.created',
          timestamp: ts,
          room,
          actor: { login: sender },
          payload: {
            body,
            room,
            reply_to: m._replyToId || null,
            reply_target: m._replyTarget || null
          },
          intent: null,
          memory_context: null,
          enrichment_errors: []
        };
        const event = await enrichEvent(rawEvent, config);
        appendFileSync(queuePath, JSON.stringify(event) + '\n');

        // Collect for notification file. ONE physical line per message
        // (readers split on \n and count lines), so the thread rides inside
        // the line: parent in full, chain above it, and for owner messages
        // or mentions the asker's previous message (issue #90).
        const thread = threadSuffix(history, room, m) || replyAnnotation(m._replyToId, m._replyTarget);
        const prev = (normalizedSender === ownerHandle || mentionsSelf) ? previousSuffix(history, room, m) : '';
        const line = `[${ts.slice(0, 19)}] [${room}] ${sender}: ${body.replace(/\n/g, ' ').slice(0, 400)}`
          + thread + prev;
        roomLines.push(line);
        newCount++;
        // Handled = queued + notified; only then is it safe to remember it.
        appendNotifications(notifyFile, [line]);
        saveSeenIds(seenFile, seen);

        console.log(`  [${ts.slice(0, 19)}] ${sender} in ${room}: ${body.slice(0, 80)}...`);
      }
      // Lines and the context header were written per message above;
      // newMessages only feeds the count/log below.
      newMessages.push(...roomLines);
    }

    saveSeenIds(seenFile, seen);
    history.save();
    if (staleSkipped > 0) console.log(`  ${staleSkipped} message(s) older than ${maxAgeSec}s marked seen without notifying`);

    if (newCount > 0) {
      // Notification lines were appended per message above.
      // Owner messages always qualify; agent @-mentions qualify unless the user
      // is in emergency-only mode (that mode exists to mute agent chatter).
      const mentionQualifies = hasMention && !hasOwnerMessage ? !(await shouldSuppressNudge(config)) : hasMention;
      const gate = nudgeGate(hasOwnerMessage || mentionQualifies);
      if (gate.fire) {
        const nudged = triggerNudge({ nudgeMode, nudgeCommandText, nudgeText, session });
        const why = hasOwnerMessage ? ' (owner message)' : ' (mention)';
        console.log(`  ${newCount} new message(s) → notified${nudged ? ' + nudge' : ''}${why}`);
      } else {
        console.log(`  ${newCount} new message(s) → notified, no nudge (${gate.why})`);
      }
    }
    } finally {
      roomPollInFlight = false;
    }
  }

  async function pollDirectMessages() {
    if (!dmEnabled || dmPollInFlight) return;
    dmPollInFlight = true;
    try {
      let newCount = 0;
      let hasOwnerMessage = false;
      const newMessages = [];
      const directMessages = await fetchDirectMessages(dmApiKey, dmLimit);
      for (const message of directMessages) {
        if (!isRelevantDirectMessage(message, { selfHandle: dmHandle, humanOnly: dmHumanOnly })) continue;
        const mid = message.id;
        if (!mid || dmSeen.has(mid)) continue;
        dmSeen.add(mid);

        const sender = normalizeHandle(message.from || message.sender) || '?';
        if (sender === ownerHandle) hasOwnerMessage = true;
        const recipient = normalizeHandle(message.to) || dmHandle;
        const body = (message.body || '').slice(0, 500);
        const ts = message.created_at || new Date().toISOString();

        const rawEvent = {
          trace_id: randomUUID(),
          event_id: mid,
          source: 'groupmind',
          kind: 'groupmind.dm.created',
          timestamp: ts,
          room: null,
          actor: { login: sender },
          payload: { body, type: 'dm', to: recipient },
          intent: null,
          memory_context: null,
          enrichment_errors: []
        };
        const event = await enrichEvent(rawEvent, config);
        appendFileSync(queuePath, JSON.stringify(event) + '\n');

        const line = `[${ts.slice(0, 19)}] [dm] ${sender} -> ${recipient}: ${body.replace(/\n/g, ' ').slice(0, 200)}`;
        newMessages.push(line);
        newCount++;
        appendNotifications(dmNotifyFile, [line]);
        saveSeenIds(dmSeenFile, dmSeen);

        console.log(`  [${ts.slice(0, 19)}] ${sender} DM -> ${recipient}: ${body.slice(0, 80)}...`);
      }

      saveSeenIds(dmSeenFile, dmSeen);

      if (newCount > 0) {
        // Notification lines were appended per message above.
        // DMs are addressed to this agent, so they inherently qualify; owner DMs
        // bypass emergency-only, other senders respect it. Cooldown still applies.
        const dmQualifies = hasOwnerMessage || !(await shouldSuppressNudge(config));
        const gate = nudgeGate(dmQualifies);
        if (gate.fire) {
          const nudged = triggerNudge({ nudgeMode, nudgeCommandText, nudgeText, session });
          const why = hasOwnerMessage ? ' (owner dm)' : ' (dm)';
          console.log(`  ${newCount} new direct message(s) → notified${nudged ? ' + nudge' : ''}${why}`);
        } else {
          console.log(`  ${newCount} new direct message(s) → notified, no nudge (${gate.why})`);
        }
      }
    } finally {
      dmPollInFlight = false;
    }
  }

  // Initial poll
  await pollRooms();
  await pollDirectMessages();

  // Start interval
  const roomTimer = setInterval(pollRooms, pollInterval * 1000);
  const dmTimer = dmEnabled ? setInterval(pollDirectMessages, dmPollInterval * 1000) : null;

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nPoller stopped.');
    clearInterval(roomTimer);
    if (dmTimer) clearInterval(dmTimer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(roomTimer);
    if (dmTimer) clearInterval(dmTimer);
    process.exit(0);
  });

  return { roomTimer, dmTimer };
}
