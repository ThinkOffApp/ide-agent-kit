import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

// Minimal Ant Farm API poller for the IDE Agent Kit
// Runs standalone and appends new messages to the shared queue file

const config = {
    apiKey: process.env.ANTFARM_API_KEY,
    rooms: ['thinkoff-development', 'feature-admin-planning'],
    queuePath: './ide-agent-queue.jsonl',
    pollIntervalMs: 30000, // 30s
    botHandles: ['@claudemm', '@ether', '@geminiMB', '@antigravity', '@sallygp'] // ignore ours
};

const lastSeen = {}; // room -> last message id

function fetchMessages(room) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'antfarm.world',
            path: `/api/v1/rooms/${room}/messages?limit=20`,
            method: 'GET',
            headers: { 'X-API-Key': config.apiKey }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`API Error: ${res.statusCode}`));
                try { resolve(JSON.parse(data).messages.reverse()); } // oldest first
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function processRoom(room) {
    fetchMessages(room).then(messages => {
        let newMessages = [];
        if (!lastSeen[room]) {
            // First run: just save latest ID, don't queue
            if (messages.length > 0) lastSeen[room] = messages[messages.length - 1].id;
            return;
        }

        const lastIdx = messages.findIndex(m => m.id === lastSeen[room]);
        if (lastIdx !== -1) {
            newMessages = messages.slice(lastIdx + 1);
        } else {
            newMessages = messages; // all new?
        }

        if (newMessages.length > 0) {
            lastSeen[room] = newMessages[newMessages.length - 1].id;
            newMessages.forEach(msg => {
                if (config.botHandles.includes(msg.from)) return; // skip bots

                const event = {
                    trace_id: randomUUID(),
                    event_id: msg.id,
                    source: 'antfarm',
                    kind: 'antfarm.message.created',
                    timestamp: new Date().toISOString(),
                    room: room,
                    actor: { login: msg.from, name: msg.from_name },
                    payload: { body: msg.body }
                };
                appendFileSync(config.queuePath, JSON.stringify(event) + '\n');
                console.log(`[${event.timestamp}] Queued Ant Farm message in ${room} from ${msg.from}`);
            });
        }
    }).catch(err => console.error(`[Poll Error in ${room}]:`, err.message));
}

function start() {
    if (!config.apiKey) {
        console.error('Error: ANTFARM_API_KEY environment variable is required');
        process.exit(1);
    }
    console.log(`Starting Ant Farm Poller for IDE Agent Kit...`);
    console.log(`Rooms: ${config.rooms.join(', ')}`);
    console.log(`Interval: ${config.pollIntervalMs}ms`);
    console.log(`Queue: ${config.queuePath}`);

    const tick = () => config.rooms.forEach(processRoom);
    tick(); // run once immediately
    setInterval(tick, config.pollIntervalMs);
}

start();
