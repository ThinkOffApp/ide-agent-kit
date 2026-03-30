// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared constants for ide-agent-kit.
 * Centralized here to prevent path/filename drift between pollers and CLI.
 */

export const NOTIFY_FILE_DEFAULT = '/tmp/iak_new_messages.txt';
export const SEEN_FILE_DEFAULT = '/tmp/iak-seen-ids.txt';
export const QUEUE_PATH_DEFAULT = './ide-agent-queue.jsonl';
export const RECEIPTS_PATH_DEFAULT = './ide-agent-receipts.jsonl';

export const TMUX_SESSION_DEFAULT = 'iak-runner';
export const IDE_SESSION_DEFAULT = 'claude';
export const NUDGE_TEXT_DEFAULT = 'check rooms';
