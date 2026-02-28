// SPDX-License-Identifier: AGPL-3.0-only
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
/**
 * Create a Supabase server client with cookie-based auth.
 * Works in Next.js App Router server components and route handlers.
 *
 * Usage:
 *   import { createServerSupabase } from '@thinkoff/core/supabase';
 *   const supabase = await createServerSupabase();
 *
 * With secure cookie enforcement (xfor pattern):
 *   const supabase = await createServerSupabase({ secureCookies: true });
 */
export async function createServerSupabase(opts) {
    const cookieStore = await cookies();
    return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                try {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        const finalOptions = opts?.secureCookies
                            ? {
                                ...options,
                                sameSite: 'lax',
                                secure: true,
                                maxAge: options?.maxAge ?? 60 * 60 * 24 * 365,
                            }
                            : options;
                        cookieStore.set(name, value, finalOptions);
                    });
                }
                catch {
                    // setAll called from Server Component — cookies are read-only
                }
            },
        },
    });
}
