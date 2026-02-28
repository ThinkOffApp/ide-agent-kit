// SPDX-License-Identifier: AGPL-3.0-only

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
export async function sendWebhook<T = unknown>(
  url: string,
  payload: T,
  opts?: WebhookOptions
): Promise<{ ok: boolean; status?: number; error?: string }> {
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
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    console.error(`[webhook] ${url} failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract @mentions from message content.
 * Ported from antfarm's extractMentions.
 */
export function extractMentions(content: string): string[] {
  const matches = content.match(/@[\w-]+/g);
  return matches ? [...new Set(matches)] : [];
}

export interface WebhookQueueItem {
  id: string;
  url: string;
  payload: unknown;
  status: string;
  attempts: number;
}

/**
 * Process pending webhook queue items with retry.
 * Reads from the shared webhook_queue table, fires each, updates status.
 */
export async function processWebhookQueue(
  supabase: SupabaseClient,
  opts?: WebhookOptions & { batchSize?: number; maxAttempts?: number }
): Promise<{ processed: number; delivered: number; failed: number }> {
  const batchSize = opts?.batchSize ?? 10;
  const maxAttempts = opts?.maxAttempts ?? 5;

  // Claim items atomically by setting status to 'processing' to prevent double-delivery
  const { data: items } = await supabase
    .from('webhook_queue')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lt('attempts', maxAttempts)
    .order('last_attempt_at', { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (!items || items.length === 0) {
    return { processed: 0, delivered: 0, failed: 0 };
  }

  // Claim batch — mark as processing so concurrent workers skip these
  const ids = items.map((item: WebhookQueueItem) => item.id);
  await supabase
    .from('webhook_queue')
    .update({ status: 'processing' })
    .in('id', ids);

  let delivered = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    items.map(async (item: WebhookQueueItem) => {
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
      } else {
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
    })
  );

  return { processed: results.length, delivered, failed };
}
