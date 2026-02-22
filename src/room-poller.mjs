import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

// Minimal CLI argument parsing for ide-agent-kit poll
const args = process.argv.slice(2);
let rooms = '083b04cb-a227-44f1-8257-7db779d988f1';
let apiKey = '';
let handle = 'claudemm';
let interval = 30;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rooms' && args[i + 1]) rooms = args[++i];
    if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i];
    if (args[i] === '--handle' && args[i + 1]) handle = args[++i].replace('@', '');
    if (args[i] === '--interval' && args[i + 1]) interval = parseInt(args[++i], 10);
}

const CACHE_FILE = path.join(process.cwd(), `.poller_cache_${handle}.json`);
let lastSeenId = null;

if (fs.existsSync(CACHE_FILE)) {
    try {
        lastSeenId = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).lastSeenId;
    } catch (e) { }
}

async function poll() {
    console.log(`[${new Date().toISOString()}] Polling for ${handle}...`);

    // Simulate Claude's described Supabase REST API fetch without dependencies
    const url = `https://kujpkmvshnhtcawymgzt.supabase.co/rest/v1/messages?room_id=eq.${rooms}&order=created_at.desc&limit=1`;

    try {
        const response = await fetch(url, {
            headers: {
                'apikey': apiKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${apiKey || process.env.SUPABASE_SERVICE_ROLE_KEY}`
            }
        });

        if (!response.ok) return console.error('API Error:', response.status);

        const data = await response.json();

        if (data && data.length > 0) {
            const msg = data[0];

            if (!lastSeenId) {
                lastSeenId = msg.id;
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastSeenId }));
                return;
            }

            if (msg.id !== lastSeenId && !msg.body.includes(handle)) {
                lastSeenId = msg.id;
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastSeenId }));

                if (msg.body.toLowerCase().includes('check room') || msg.body.includes(`@${handle}`)) {
                    console.log('🚨 Injecting prompt into tmux...');
                    await execPromise(`tmux send-keys -t claude -l "check room"`);
                    await execPromise(`sleep 0.3`);
                    await execPromise(`tmux send-keys -t claude Enter`);
                }
            }
        }
    } catch (e) {
        console.error('Fetch error:', e.message);
    }
}

setInterval(poll, interval * 1000);
poll();
