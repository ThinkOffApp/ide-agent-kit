// SPDX-License-Identifier: AGPL-3.0-only
import { createClient } from '@supabase/supabase-js';
/**
 * Create a Supabase service-role client that bypasses RLS.
 * Only use in server-side API routes, NEVER in client code.
 *
 * Usage:
 *   import { createServiceSupabase } from '@thinkoff/core/supabase';
 *   const supabase = createServiceSupabase();
 */
export function createServiceSupabase() {
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}
