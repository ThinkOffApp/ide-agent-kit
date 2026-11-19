// SPDX-License-Identifier: AGPL-3.0-only

import { watch, readFileSync, statSync } from 'node:fs';
import { nudgeTmux } from './common/notify.mjs';

/**
 * Watch the queue JSONL file for new entries and trigger tmux nudge immediately.
 * This replaces slow polling with instant file-change detection.
 */
export function watchQueue(config, onNewEvent) {
  const queuePath = config.queue.path;
  const session = config.tmux?.ide_session || 'claude';
  const nudgeText = config.tmux?.nudge_text || 'check rooms';
  let lastSize = 0;

  try {
    lastSize = statSync(queuePath).size;
  } catch { /* file may not exist yet */ }

  console.log(`Watching ${queuePath} for new events...`);
  console.log(`  tmux nudge → session "${session}" with "${nudgeText}"`);

  // Use fs.watchFile for reliable cross-platform polling (works on all FS types)
  const watcher = watch(queuePath, { persistent: true }, (eventType) => {
    if (eventType !== 'change') return;

    let currentSize;
    try {
      currentSize = statSync(queuePath).size;
    } catch { return; }

    if (currentSize <= lastSize) {
      lastSize = currentSize;
      return;
    }

    // Read new content using byte offset for correct UTF-8 handling
    const buf = readFileSync(queuePath);
    const newBuf = buf.slice(lastSize);
    lastSize = currentSize;
    const newContent = newBuf.toString('utf8').trim();
    if (!newContent) return;
    const newLines = newContent.split('\n');

    if (newLines.length === 0) return;

    const events = [];
    for (const line of newLines) {
      try {
        events.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }

    if (events.length === 0) return;

    console.log(`[${new Date().toISOString()}] ${events.length} new event(s) in queue`);

    // Trigger callback for each event
    for (const event of events) {
      if (onNewEvent) onNewEvent(event);
    }

    // Nudge tmux session
    nudgeTmux(session, nudgeText);
  });

  return watcher;
}
