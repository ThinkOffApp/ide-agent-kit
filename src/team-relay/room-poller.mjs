import { NOTIFY_FILE_DEFAULT, SEEN_FILE_DEFAULT, QUEUE_PATH_DEFAULT } from '../common/constants.mjs';
import { enrichEvent } from './enrichment.mjs';
import { nudgeTmux, nudgeCommand } from './common/notify.mjs';
// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Room Poller — polls Ant Farm rooms and notifies IDE agent of new messages.
 * Works for any IDE agent (Claude Code, Codex, Gemini, Cursor).
 * No webhooks required — just an API key.
 *
 * Notification delivery (in order of priority):
 *   1. Notification file (always) — human-readable file that the IDE agent reads
 *   2. tmux nudge (optional) — types "check rooms" into a tmux session
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

export async function startRoomPoller({ rooms, apiKey, handle, interval, config }) {
  const seenFile = config?.poller?.seen_file || SEEN_FILE_DEFAULT;
  const notifyFile = config?.poller?.notification_file || NOTIFY_FILE_DEFAULT;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = config?.tmux?.ide_session || config?.tmux?.default_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';
  const pollInterval = interval || config?.poller?.interval_sec || 30;
  const selfHandle = handle || config?.poller?.handle || '@unknown';

  console.log(`Room poller started`);
  console.log(`  rooms: ${rooms.join(', ')}`);
  console.log(`  handle: ${selfHandle} (messages from self are ignored)`);
  console.log(`  interval: ${pollInterval}s`);
  console.log(`  notification file: ${notifyFile}`);
  console.log(`  tmux session: ${session} (optional)`);
  console.log(`  seen file: ${seenFile}`);
  console.log(`  queue: ${queuePath}`);

  const seen = loadSeenIds(seenFile);

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
        // Skip own messages
        if (sender === selfHandle || sender === selfHandle.replace('@', '')) continue;

        const body = (m.body || '').slice(0, 500);
        const ts = m.created_at || new Date().toISOString();

        // Write to structured queue
        const rawEvent = {
          trace_id: randomUUID(),
          event_id: mid,
          source: 'antfarm',
          kind: 'antfarm.message.created',
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
      appendFileSync(notifyFile, newMessages.join('\n') + '\n');

      // Secondary: try command nudge (GUI) or fallback to tmux nudge
      const nudgeCmd = config?.tmux?.nudge_command;
      let nudged = false;
      let nudgeType = '';
      if (nudgeCmd) {
        nudged = nudgeCommand(nudgeCmd, { text: nudgeText, session });
        if (nudged) nudgeType = ' + gui nudge';
      } else {
        nudged = nudgeTmux(session, nudgeText);
        if (nudged) nudgeType = ' + tmux nudge';
      }
      console.log(`  ${newCount} new message(s) → notified${nudgeType}`);
    }
  }

  // Initial poll
  await poll();

  // Start interval
  const timer = setInterval(poll, pollInterval * 1000);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nPoller stopped.');
    clearInterval(timer);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });

  return timer;
}
