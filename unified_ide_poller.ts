import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

// CLI Arguments: node unified_poller.js --session <tmux_name> --handle <bot_handle>
const args = process.argv.slice(2);
const sessionArgIdx = args.indexOf('--session');
const handleArgIdx = args.indexOf('--handle');

if (sessionArgIdx === -1 || handleArgIdx === -1) {
    console.error('Usage: tsx unified_poller.ts --session <tmux_session_name> --handle <your_bot_handle>');
    process.exit(1);
}

const TMUX_SESSION = args[sessionArgIdx + 1];
const BOT_HANDLE = args[handleArgIdx + 1].toLowerCase();

console.log(`🚀 Starting Unified IDE Agent Kit Poller for [${BOT_HANDLE}] on tmux [${TMUX_SESSION}]`);

// Load environment variables (allows running from different paths)
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Stateful cache to prevent duplicate triggers (persisted to disk for safety across restarts)
const CACHE_FILE = path.join(process.cwd(), `.poller_cache_${BOT_HANDLE}.json`);
let lastSeenMessageId: string | null = null;
const ROOM_ID = '083b04cb-a227-44f1-8257-7db779d988f1'; // #feature-admin-planning

if (fs.existsSync(CACHE_FILE)) {
    try {
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        lastSeenMessageId = cache.lastSeenMessageId;
        console.log(`Loaded state: Last seen message UUID was ${lastSeenMessageId}`);
    } catch (e) {
        console.warn('Failed to parse cache file, starting fresh.');
    }
}

async function injectPrompt(body: string) {
    try {
        console.log(`⚡ Injecting prompt into tmux session: ${TMUX_SESSION}...`);

        // Check if tmux session actually exists first
        await execPromise(`tmux has-session -t ${TMUX_SESSION}`);

        // Inject the command (similar to Claude's approach)
        await execPromise(`tmux send-keys -t ${TMUX_SESSION} -l "check room"`);
        await execPromise(`sleep 0.3`);
        await execPromise(`tmux send-keys -t ${TMUX_SESSION} Enter`);

        console.log(`✅ successfully triggered ${BOT_HANDLE}!`);
    } catch (e) {
        console.warn(`⚠️ Warning: Tmux session '${TMUX_SESSION}' not found or unreachable. Ensure your IDE agent is active.`);
    }
}

async function pollRoom() {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .eq('room_id', ROOM_ID)
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.error('Error fetching latest message:', error);
            return;
        }

        if (data && data.length > 0) {
            const latestMsg = data[0];

            // Initialization: just set the watermark on first run
            if (!lastSeenMessageId) {
                lastSeenMessageId = latestMsg.id;
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastSeenMessageId }));
                console.log(`[INIT] Set watermark at msg ${lastSeenMessageId}`);
                return;
            }

            // If we found a genuinely new message
            if (latestMsg.id !== lastSeenMessageId) {
                lastSeenMessageId = latestMsg.id;
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastSeenMessageId }));

                const bodyStr = (latestMsg.body || "").toLowerCase();

                // Do not trigger on our own outbound messages to prevent infinite echo loops
                if (!bodyStr.includes(BOT_HANDLE)) {

                    // Unified Trigger Logic:
                    // Only wake up if the message contains our specific handle mention OR a generic "check room" broadcast
                    if (bodyStr.includes('check room') || bodyStr.includes(`@${BOT_HANDLE}`)) {
                        console.log(`[${new Date().toISOString()}] 🚨 Trigger matched: "${latestMsg.body}"`);
                        await injectPrompt(latestMsg.body);
                    } else {
                        console.log(`[${new Date().toISOString()}] Ignored irrelevant message: ${latestMsg.id}`);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Polling error:', e);
    }
}

// 8 second cadence is the sweet spot (blending Codex's speed with Claude's API safety)
setInterval(pollRoom, 8000);
console.log(`⏱️ Polling initialized (8s interval). Waiting for triggers...`);
