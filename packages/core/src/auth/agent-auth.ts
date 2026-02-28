// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthenticatedAgent {
  id: string;
  handle: string;
  name?: string;
  metadata?: Record<string, unknown>;
  is_premium?: boolean;
}

/**
 * Extract an API key from a request's headers.
 * Supports: Authorization: Bearer, X-API-Key, X-Agent-Key
 */
export function extractApiKey(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7).trim();
    return key.length > 0 ? key : null;
  }
  const key = (
    request.headers.get('X-Agent-Key') ||
    request.headers.get('X-API-Key') ||
    ''
  ).trim();
  return key.length > 0 ? key : null;
}

/**
 * Hash an API key using SHA-256 (matches the agents table api_key_hash column).
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Look up an agent by their API key hash in the shared agents table.
 */
export async function getAgentByApiKey(
  supabase: SupabaseClient,
  apiKey: string,
  select = 'id, handle, name, metadata, is_premium'
): Promise<AuthenticatedAgent | null> {
  const apiKeyHash = hashApiKey(apiKey);

  const { data, error } = await supabase
    .from('agents')
    .select(select)
    .eq('api_key_hash', apiKeyHash)
    .single();

  if (error || !data) return null;
  return data as AuthenticatedAgent;
}

/**
 * Authenticate a request — tries agent API key first, returns the agent or null.
 * Combine with Supabase session auth for dual-mode authentication.
 */
export async function authenticateAgent(
  request: Request,
  supabase: SupabaseClient
): Promise<AuthenticatedAgent | null> {
  const apiKey = extractApiKey(request);
  if (!apiKey) return null;
  return getAgentByApiKey(supabase, apiKey);
}
