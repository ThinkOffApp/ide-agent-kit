// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserClient } from '@supabase/ssr';

/**
 * Create a Supabase browser client.
 * Works in all three platforms (xfor, antfarm, agentpuzzles).
 *
 * Usage:
 *   import { createBrowserSupabase } from '@thinkoff/core/supabase';
 *   const supabase = createBrowserSupabase();
 *
 * For typed clients, pass your Database generic:
 *   const supabase = createBrowserSupabase<Database>();
 */
export function createBrowserSupabase<T = unknown>() {
  return createBrowserClient<T>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
