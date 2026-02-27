// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync } from 'node:fs';

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

export function saveSeenIds(path, ids, maxIds = 2000) {
  const arr = [...ids].slice(-maxIds);
  writeFileSync(path, arr.join('\n') + '\n');
}
