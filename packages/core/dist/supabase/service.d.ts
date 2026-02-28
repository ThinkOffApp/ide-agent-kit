/**
 * Create a Supabase service-role client that bypasses RLS.
 * Only use in server-side API routes, NEVER in client code.
 *
 * Usage:
 *   import { createServiceSupabase } from '@thinkoff/core/supabase';
 *   const supabase = createServiceSupabase();
 */
export declare function createServiceSupabase(): import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any>;
