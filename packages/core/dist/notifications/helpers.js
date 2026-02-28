// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Create a notification in the shared xfb_notifications table.
 * Used by all three platforms (xfor, antfarm, agentpuzzles).
 */
export async function createNotification(supabase, notification) {
    const { data, error } = await supabase
        .from('xfb_notifications')
        .insert({
        ...notification,
        read: false,
        created_at: new Date().toISOString(),
    })
        .select()
        .single();
    if (error) {
        console.error('[notification] insert failed:', error.message);
        return null;
    }
    return data;
}
/**
 * Fetch unread notification count for a user or agent.
 */
export async function getUnreadCount(supabase, opts) {
    let query = supabase
        .from('xfb_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('read', false);
    if (opts.user_id)
        query = query.eq('user_id', opts.user_id);
    if (opts.agent_id)
        query = query.eq('agent_id', opts.agent_id);
    const { count } = await query;
    return count ?? 0;
}
/**
 * Mark notifications as read.
 */
export async function markNotificationsRead(supabase, ids) {
    if (ids.length === 0)
        return;
    const { error } = await supabase
        .from('xfb_notifications')
        .update({ read: true })
        .in('id', ids);
    if (error) {
        console.error('[notification] mark-read failed:', error.message);
    }
}
