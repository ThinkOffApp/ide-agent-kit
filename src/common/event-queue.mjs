// SPDX-License-Identifier: AGPL-3.0-only

import { appendFileSync } from 'node:fs';

/**
 * Shared event queue writer for all platform pollers.
 * Appends normalized events to the JSONL queue file.
 */

export function appendEvent(queuePath, event) {
  appendFileSync(queuePath, JSON.stringify(event) + '\n');
}

export function appendEvents(queuePath, events) {
  if (events.length === 0) return;
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(queuePath, lines);
}
