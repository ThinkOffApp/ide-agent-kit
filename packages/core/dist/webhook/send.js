// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Send a webhook POST with JSON payload.
 * Generic function replacing the three near-identical webhook senders in antfarm.
 */
export async function sendWebhook(url, payload, opts) {
    const timeout = opts?.timeout ?? 10000;
    const userAgent = opts?.userAgent ?? 'ThinkOff-Webhook/1.0';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        return { ok: response.ok, status: response.status };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : 'unknown error';
        console.error(`[webhook] ${url} failed: ${message}`);
        return { ok: false, error: message };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Extract @mentions from message content.
 * Ported from antfarm's extractMentions.
 */
export function extractMentions(content) {
    const matches = content.match(/@[\w-]+/g);
    return matches ? [...new Set(matches)] : [];
}
const STALE_PROCESSING_MINUTES = 5;
/**
 * Recover items stuck in 'processing' status (worker crashed mid-flight).
 * Resets them to 'failed' so the next processWebhookQueue cycle picks them up.
 */
export async function recoverStaleProcessing(supabase, staleMinutes = STALE_PROCESSING_MINUTES) {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
    // Match processing items where last_attempt_at is stale OR null (first attempt crash)
    const { data, error } = await supabase
        .from('webhook_queue')
        .update({ status: 'failed', last_error: 'stale processing recovery' })
        .eq('status', 'processing')
        .or(`last_attempt_at.lt.${cutoff},last_attempt_at.is.null`)
        .select('id');
    if (error) {
        console.error('[webhook] stale recovery error:', error);
        return 0;
    }
    if (data && data.length > 0) {
        console.log(`[webhook] recovered ${data.length} stale processing item(s)`);
    }
    return data?.length ?? 0;
}
/**
 * Process pending webhook queue items with retry.
 * Reads from the shared webhook_queue table, fires each, updates status.
 */
export async function processWebhookQueue(supabase, opts) {
    const batchSize = opts?.batchSize ?? 10;
    const maxAttempts = opts?.maxAttempts ?? 5;
    // Recover any items stuck in 'processing' from a previous crashed run
    await recoverStaleProcessing(supabase);
    // Atomic claim: update status to 'processing' and return claimed rows in one operation.
    // Uses Supabase's update().select() which maps to UPDATE ... RETURNING.
    const { data: items } = await supabase
        .from('webhook_queue')
        .update({ status: 'processing', last_attempt_at: new Date().toISOString() })
        .in('status', ['pending', 'failed'])
        .lt('attempts', maxAttempts)
        .order('last_attempt_at', { ascending: true, nullsFirst: true })
        .limit(batchSize)
        .select('*');
    if (!items || items.length === 0) {
        return { processed: 0, delivered: 0, failed: 0 };
    }
    let delivered = 0;
    let failed = 0;
    const results = await Promise.allSettled(items.map(async (item) => {
        const result = await sendWebhook(item.url, item.payload, opts);
        if (result.ok) {
            delivered++;
            await supabase
                .from('webhook_queue')
                .update({
                status: 'delivered',
                attempts: item.attempts + 1,
                last_attempt_at: new Date().toISOString(),
            })
                .eq('id', item.id);
        }
        else {
            failed++;
            await supabase
                .from('webhook_queue')
                .update({
                status: 'failed',
                attempts: item.attempts + 1,
                last_attempt_at: new Date().toISOString(),
                last_error: result.error || `HTTP ${result.status}`,
            })
                .eq('id', item.id);
        }
    }));
    return { processed: results.length, delivered, failed };
}
