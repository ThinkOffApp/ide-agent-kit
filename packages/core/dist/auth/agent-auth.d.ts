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
export declare function extractApiKey(request: Request): string | null;
/**
 * Hash an API key using SHA-256 (matches the agents table api_key_hash column).
 */
export declare function hashApiKey(apiKey: string): string;
/**
 * Look up an agent by their API key hash in the shared agents table.
 */
export declare function getAgentByApiKey(supabase: SupabaseClient, apiKey: string, select?: string): Promise<AuthenticatedAgent | null>;
/**
 * Authenticate a request — tries agent API key first, returns the agent or null.
 * Combine with Supabase session auth for dual-mode authentication.
 */
export declare function authenticateAgent(request: Request, supabase: SupabaseClient): Promise<AuthenticatedAgent | null>;
