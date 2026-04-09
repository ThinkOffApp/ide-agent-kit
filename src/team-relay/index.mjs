// SPDX-License-Identifier: AGPL-3.0-only
// team-relay — generic room/comms modules for IDE Agent Kit

export { startRoomPoller, checkRoomMessages } from './room-poller.mjs';
export { startRoomAutomation } from './room-automation.mjs';
export { startWebhookServer } from './webhook-server.mjs';
export { pollDiscord, startDiscordPoller } from './discord-poller.mjs';
export { UnifiedPoller } from './unified-poller.mjs';
export { emitJson } from './emit.mjs';
export { tailReceipts, createReceipt, appendReceipt } from './receipt.mjs';
export { memoryList, memoryGet, memorySet, memoryAppend, memoryDelete, memorySearch } from './memory.mjs';
export { moltbookPost, moltbookFeed } from './moltbook.mjs';
export { canSend, waitUntilReady, markSent } from './rate-limiter.mjs';
export { isEnabled as acpIsEnabled, createSession, sendToSession, closeSession, getSession, listSessions } from './acp-sessions.mjs';

// Task Queue / Mission Control
export { initTaskQueue, addTask, startTask, completeTask, failTask, cancelTask, getTask, listTasks, nextTask, agentStatus, missionControlData } from './task-queue.mjs';

// Adapters
export { groupmindAdapter } from './adapters/groupmind.mjs';
export { discordAdapter } from './adapters/discord.mjs';
export { xforAdapter } from './adapters/xfor.mjs';
export { commentsAdapter } from './adapters/comments.mjs';
