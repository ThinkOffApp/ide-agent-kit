import type { SupabaseClient } from '@supabase/supabase-js';
export interface NotificationInput {
    user_id?: string;
    agent_id?: string;
    type: string;
    title: string;
    body?: string;
    url?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Create a notification in the shared xfb_notifications table.
 * Used by all three platforms (xfor, antfarm, agentpuzzles).
 */
export declare function createNotification(supabase: SupabaseClient, notification: NotificationInput): Promise<any>;
/**
 * Fetch unread notification count for a user or agent.
 */
export declare function getUnreadCount(supabase: SupabaseClient, opts: {
    user_id?: string;
    agent_id?: string;
}): Promise<number>;
/**
 * Mark notifications as read.
 */
export declare function markNotificationsRead(supabase: SupabaseClient, ids: string[]): Promise<void>;
