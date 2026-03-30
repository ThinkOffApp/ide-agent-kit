// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { nudgeTmux, nudgeCommand } from './utils.mjs';

/**
 * Room Poller — polls Ant Farm rooms and notifies IDE agent of new messages.
 * Works for any IDE agent (Claude Code, Codex, Gemini, Cursor).
 * No webhooks required — just an API key.
 *
 * Notification delivery (in order of priority):
 *   1. Notification file (always) — human-readable file that the IDE agent reads
 *   2. Optional nudge path (tmux/command/none)
 *
 * The IDE agent calls `rooms check` to read and clear the notification file.
 */

const SEEN_FILE_DEFAULT = '/tmp/iak-seen-ids.txt';
const NOTIFY_FILE_DEFAULT = '/tmp/iak_new_messages.txt';

function loadSeenIds(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveSeenIds(path, ids) {
  const arr = [...ids].slice(-1000);
  writeFileSync(path, arr.join('\n') + '\n');
}

async function fetchRoomMessages(room, apiKey, limit = 10) {
  const url = `https://groupmind.one/api/v1/rooms/${room}/messages?limit=${limit}`;
  try {
    const result = execSync(
      `curl -sS -H "Authorization: Bearer ${apiKey}" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    return data.messages || (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error(`  fetch ${room} failed: ${e.message}`);
    return [];
  }
}

export function checkRoomMessages(config) {
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  try {
    const content = readFileSync(notifyFile, 'utf8').trim();
    if (!content) return [];
    writeFileSync(notifyFile, '');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function startRoomPoller({ rooms, apiKey, handle, interval, config }) {
  const seenFile = config?.poller?.seen_file || SEEN_FILE_DEFAULT;
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = config?.tmux?.ide_session || config?.tmux?.default_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';
  const nudgeMode = config?.poller?.nudge_mode || 'tmux';
  const nudgeCommandText = config?.poller?.nudge_command || '';
  const pollInterval = interval || config?.poller?.interval_sec || 30;
  const selfHandle = handle || config?.poller?.handle || '@unknown';

  console.log('Room poller started');
  console.log(`  rooms: ${rooms.join(', ')}`);
  console.log(`  handle: ${selfHandle} (messages from self are ignored)`);
  console.log(`  interval: ${pollInterval}s`);
  console.log(`  notification file: ${notifyFile}`);
  console.log(`  nudge mode: ${nudgeMode}`);
  if (nudgeMode === 'tmux') {
    console.log(`  tmux session: ${session}`);
  } else if (nudgeMode === 'command') {
    console.log(`  nudge command: ${nudgeCommandText || '(missing)'}`);
  }
  console.log(`  seen file: ${seenFile}`);
  console.log(`  queue: ${queuePath}`);
  console.log('  auto-ack: disabled (real replies only)');

  const seen = loadSeenIds(seenFile);

  if (seen.size === 0) {
    console.log('  seeding seen IDs from current messages...');
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
    let newCount = 0;
    const newMessages = [];
    for (const room of rooms) {
      const msgs = await fetchRoomMessages(room, apiKey);
      for (const m of msgs) {
        const mid = m.id;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);

        const sender = m.from || m.sender || '?';
        if (sender === selfHandle || sender === selfHandle.replace('@', '')) continue;

        const body = (m.body || '').slice(0, 500);
        const ts = m.created_at || new Date().toISOString();

        const event = {
          trace_id: randomUUID(),
          event_id: mid,
          source: 'antfarm',
          kind: 'antfarm.message.created',
          timestamp: ts,
          room,
          actor: { login: sender },
          payload: { body, room }
        };
        appendFileSync(queuePath, JSON.stringify(event) + '\n');

        const line = `[${ts.slice(0, 19)}] [${room}] ${sender}: ${body.replace(/\n/g, ' ').slice(0, 200)}`;
        newMessages.push(line);
        newCount++;

        console.log(`  [${ts.slice(0, 19)}] ${sender} in ${room}: ${body.slice(0, 80)}...`);
      }
    }

    saveSeenIds(seenFile, seen);

    if (newCount > 0) {
      appendFileSync(notifyFile, newMessages.join('\n') + '\n');

      let nudged = false;
      if (nudgeMode === 'command') {
        nudged = nudgeCommand(nudgeCommandText, { text: nudgeText, session });
      } else if (nudgeMode === 'none') {
        nudged = true;
      } else {
        nudged = nudgeTmux(session, nudgeText);
      }
      console.log(`  ${newCount} new message(s) → notified${nudged ? ' + nudged' : ''}`);
    }
  }

  await poll();
  const timer = setInterval(poll, pollInterval * 1000);

  const heartbeat = nudgeMode === 'tmux'
    ? setInterval(() => {
      try {
        execSync(`tmux send-keys -t ${JSON.stringify(session)} Escape`);
      } catch {
        // no-op
      }
    }, 4 * 60 * 1000)
    : null;

  process.on('SIGINT', () => {
    console.log('\nPoller stopped.');
    clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    process.exit(0);
  });

  return timer;
}
