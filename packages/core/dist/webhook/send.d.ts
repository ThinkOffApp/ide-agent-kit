import type { SupabaseClient } from '@supabase/supabase-js';
export interface WebhookOptions {
    /** Timeout in ms. Default: 10000. */
    timeout?: number;
    /** User-Agent header. Default: 'ThinkOff-Webhook/1.0'. */
    userAgent?: string;
}
/**
 * Send a webhook POST with JSON payload.
 * Generic function replacing the three near-identical webhook senders in antfarm.
 */
export declare function sendWebhook<T = unknown>(url: string, payload: T, opts?: WebhookOptions): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
}>;
/**
 * Extract @mentions from message content.
 * Ported from antfarm's extractMentions.
 */
export declare function extractMentions(content: string): string[];
export interface WebhookQueueItem {
    id: string;
    url: string;
    payload: unknown;
    status: string;
    attempts: number;
}
/**
 * Recover items stuck in 'processing' status (worker crashed mid-flight).
 * Resets them to 'failed' so the next processWebhookQueue cycle picks them up.
 */
export declare function recoverStaleProcessing(supabase: SupabaseClient, staleMinutes?: number): Promise<number>;
/**
 * Process pending webhook queue items with retry.
 * Reads from the shared webhook_queue table, fires each, updates status.
 */
export declare function processWebhookQueue(supabase: SupabaseClient, opts?: WebhookOptions & {
    batchSize?: number;
    maxAttempts?: number;
}): Promise<{
    processed: number;
    delivered: number;
    failed: number;
}>;
