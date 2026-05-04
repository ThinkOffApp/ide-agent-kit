import { NOTIFY_FILE_DEFAULT, SEEN_FILE_DEFAULT, QUEUE_PATH_DEFAULT } from '../common/constants.mjs';
import { enrichEvent } from './enrichment.mjs';
// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nudgeCommand } from '../utils.mjs';

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




function loadSeenIds(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveSeenIds(path, ids) {
  // Keep last 1000 IDs to prevent unbounded growth
  const arr = [...ids].slice(-1000);
  writeFileSync(path, arr.join('\n') + '\n');
}

const DM_SEEN_FILE_DEFAULT = '/tmp/iak-dm-seen-ids.txt';

function normalizeHandle(handle) {
  if (typeof handle !== 'string') return '';
  const trimmed = handle.trim();
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
    return true;
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

export async function startRoomPoller({ rooms, apiKey, handle, interval, config, sessionOpt }) {
  const seenFile = config?.poller?.seen_file || SEEN_FILE_DEFAULT;
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = sessionOpt || config?.tmux?.ide_session || config?.tmux?.default_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';
  const nudgeMode = config?.poller?.nudge_mode || 'tmux';
  const nudgeCommandText = config?.poller?.nudge_command || '';
  const pollInterval = parsePositiveInt(interval || config?.poller?.interval_sec, 30);
  const selfHandle = normalizeHandle(handle || config?.poller?.handle || '@unknown');
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

  // Seed: mark current messages as seen on first run
  if (seen.size === 0) {
    console.log(`  seeding seen IDs from current messages...`);
    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey, 50);
      for (const m of msgs) {
        if (m.id) seen.add(m.id);
      }
    }
    saveSeenIds(seenFile, seen);
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
    let newCount = 0;
    const newMessages = [];
    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey);
      for (const m of msgs) {
        const mid = m.id;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);

        const sender = m.from || m.sender || '?';
        const normalizedSender = normalizeHandle(sender);
        // Skip own messages
        if (normalizedSender === selfHandle) continue;

        const body = (m.body || '').slice(0, 500);
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
          payload: { body, room },
          intent: null,
          memory_context: null,
          enrichment_errors: []
        };
        const event = await enrichEvent(rawEvent, config);
        appendFileSync(queuePath, JSON.stringify(event) + '\n');

        // Collect for notification file
        const line = `[${ts.slice(0, 19)}] [${room}] ${sender}: ${body.replace(/\n/g, ' ').slice(0, 200)}`;
        newMessages.push(line);
        newCount++;

        console.log(`  [${ts.slice(0, 19)}] ${sender} in ${room}: ${body.slice(0, 80)}...`);
      }
    }

    saveSeenIds(seenFile, seen);

    if (newCount > 0) {
      // Primary: write to notification file (always works)
      appendNotifications(notifyFile, newMessages);
      const nudged = triggerNudge({ nudgeMode, nudgeCommandText, nudgeText, session });
      console.log(`  ${newCount} new message(s) → notified${nudged ? ' + nudge' : ''}`);
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
      const newMessages = [];
      const directMessages = await fetchDirectMessages(dmApiKey, dmLimit);
      for (const message of directMessages) {
        if (!isRelevantDirectMessage(message, { selfHandle: dmHandle, humanOnly: dmHumanOnly })) continue;
        const mid = message.id;
        if (!mid || dmSeen.has(mid)) continue;
        dmSeen.add(mid);

        const sender = normalizeHandle(message.from || message.sender) || '?';
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

        console.log(`  [${ts.slice(0, 19)}] ${sender} DM -> ${recipient}: ${body.slice(0, 80)}...`);
      }

      saveSeenIds(dmSeenFile, dmSeen);

      if (newCount > 0) {
        appendNotifications(dmNotifyFile, newMessages);
        const nudged = triggerNudge({ nudgeMode, nudgeCommandText, nudgeText, session });
        console.log(`  ${newCount} new direct message(s) → notified${nudged ? ' + nudge' : ''}`);
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
