// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';

/**
 * Shared seen-ID management for all platform pollers.
 * Prevents duplicate event processing across restarts.
 */

export function loadSeenIds(path, maxIds = 2000) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

// Atomic and durable: write a sibling temp file, fsync it, rename over the
// target. A poller that dies mid-write (or a box that loses power) never
// leaves a truncated seen-file behind - a truncated one reads as "nothing
// seen" and replays the whole window on restart, which is exactly what the
// M5 hermes poller did on 2026-09-01 (issue #90, item 1).
export function saveSeenIds(path, ids, maxIds = 2000) {
  const arr = [...ids].slice(-maxIds);
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, arr.join('\n') + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
