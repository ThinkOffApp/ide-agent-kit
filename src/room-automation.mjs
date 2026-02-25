// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createReceipt, appendReceipt } from './receipt.mjs';

/**
 * Room Automation — rule-based automation triggered by Ant Farm room messages.
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
  const url = `https://antfarm.world/api/v1/rooms/${room}/messages?limit=${limit}`;
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

function postMessage(room, body, apiKey) {
  const payload = JSON.stringify({ room, body });
  try {
    execSync(
      `curl -sS -X POST "https://antfarm.world/api/v1/messages" -H "X-API-Key: ${apiKey}" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`,
      { timeout: 15000 }
    );
    return true;
  } catch (e) {
    console.error(`  post failed: ${e.message}`);
    return false;
  }
}

/**
 * Check if a message matches a rule's conditions.
 */
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
function executeAction(action, msg, apiKey, config) {
  const startedAt = new Date().toISOString();
  const room = msg.room || '';

  // Template substitution for action fields
  const sub = (str) => (str || '')
    .replace(/\$\{room\}/g, room)
    .replace(/\$\{sender\}/g, msg.user?.handle || msg.from || '?')
    .replace(/\$\{body\}/g, (msg.body || '').slice(0, 200));

  if (action.type === 'post') {
    const targetRoom = sub(action.room) || room;
    const body = sub(action.body);
    const ok = postMessage(targetRoom, body, apiKey);
    return createReceipt({
      actor: { name: config?.poller?.handle || 'ide-agent-kit', kind: 'automation' },
      action: `post to ${targetRoom}`,
      status: ok ? 'ok' : 'error',
      notes: ok ? `Posted: ${body.slice(0, 100)}` : 'Post failed',
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
export async function startRoomAutomation({ rooms, apiKey, handle, interval, config }) {
  const rules = config?.automation?.rules || [];
  const seenFile = config?.automation?.seen_file || SEEN_FILE_DEFAULT;
  const receiptPath = config?.receipts?.path || './ide-agent-receipts.jsonl';
  const pollInterval = interval || config?.automation?.interval_sec || 30;
  const selfHandle = (handle || config?.poller?.handle || '@unknown').replace('@', '');
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

    for (const room of rooms) {
      const msgs = fetchRoomMessages(room, apiKey);
      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);

        // Skip own messages
        const sender = (m.user?.handle || m.from || m.sender || '').replace('@', '');
        if (sender === selfHandle) continue;

        // Attach room for rule matching
        m.room = room;

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
          const receipt = executeAction(rule.action, m, apiKey, config);
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
