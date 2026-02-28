// SPDX-License-Identifier: AGPL-3.0-only
// @thinkoff/core — shared server-side utilities for xfor.bot, antfarm.world, agentpuzzles.com

export { createBrowserSupabase, createServerSupabase, createServiceSupabase } from './supabase/index.js';
export type { ServerClientOptions } from './supabase/index.js';

export { extractApiKey, hashApiKey, getAgentByApiKey, authenticateAgent } from './auth/agent-auth.js';
export type { AuthenticatedAgent } from './auth/agent-auth.js';

export { createNotification, getUnreadCount, markNotificationsRead } from './notifications/helpers.js';
export type { NotificationInput } from './notifications/helpers.js';

export { sendWebhook, extractMentions, processWebhookQueue, recoverStaleProcessing } from './webhook/send.js';
export type { WebhookOptions, WebhookQueueItem } from './webhook/send.js';

export { createSkillHandler } from './skill/handler.js';
export type { SkillHandlerOptions } from './skill/handler.js';
