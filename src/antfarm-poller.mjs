import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const DEFAULT_POLL_SEC = 30;

export function pollAntFarm({ apiKey, rooms, seenFile, queuePath, onMessage }) {
  const seen = loadSeen(seenFile);
  let newCount = 0;

  for (const room of rooms) {
    try {
      const raw = execSync(
        `curl -sS -H "X-API-Key: ${apiKey}" "https://antfarm.world/api/v1/rooms/${room}/messages?limit=10"`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const data = JSON.parse(raw);
      const msgs = data.messages || (Array.isArray(data) ? data : []);

      for (const m of msgs) {
        const mid = m.id || '';
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);

        const handle = m.from || m.author?.handle || '?';
        const body = m.body || '';
        const ts = m.created_at || new Date().toISOString();

        // Append normalized event to queue
        const event = {
          trace_id: randomUUID(),
          event_id: mid,
          source: 'antfarm',
          kind: 'antfarm.message.created',
          timestamp: ts,
          room: room,
          actor: { login: handle },
          payload: { body: body.slice(0, 500), room }
        };
        appendFileSync(queuePath, JSON.stringify(event) + '\n');

        if (onMessage) onMessage(event);
        newCount++;
      }
    } catch (e) {
      console.error(`[antfarm-poller] Error polling ${room}: ${e.message}`);
    }
  }

  saveSeen(seenFile, seen);
  return newCount;
}

function loadSeen(path) {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf8').trim().split('\n').filter(Boolean));
}

function saveSeen(path, seen) {
  const ids = [...seen].slice(-500);
  writeFileSync(path, ids.join('\n') + '\n');
}

export function startPollerLoop({ apiKey, rooms, seenFile, queuePath, intervalSec, onMessage }) {
  const interval = (intervalSec || DEFAULT_POLL_SEC) * 1000;
  console.log(`[antfarm-poller] Polling ${rooms.join(', ')} every ${intervalSec || DEFAULT_POLL_SEC}s`);

  // Initial poll
  const n = pollAntFarm({ apiKey, rooms, seenFile, queuePath, onMessage });
  if (n > 0) console.log(`[antfarm-poller] ${n} new messages queued`);

  return setInterval(() => {
    const count = pollAntFarm({ apiKey, rooms, seenFile, queuePath, onMessage });
    if (count > 0) console.log(`[antfarm-poller] ${count} new messages queued`);
  }, interval);
}
