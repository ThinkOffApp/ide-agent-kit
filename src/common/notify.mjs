// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Shared notification utilities for all platform pollers.
 * Supports tmux nudge and notification file delivery.
 */

export function nudgeTmux(session, text) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`);
  } catch {
    return false;
  }
  try {
    execSync(`tmux send-keys -t ${JSON.stringify(session)} -l ${JSON.stringify(text)}`);
    execSync('sleep 0.3');
    execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`);
    return true;
  } catch {
    return false;
  }
}

export function writeNotification(notifyFile, lines) {
  if (lines.length === 0) return;
  appendFileSync(notifyFile, lines.join('\n') + '\n');
}

export function readAndClearNotifications(notifyFile) {
  try {
    const content = readFileSync(notifyFile, 'utf8').trim();
    if (!content) return [];
    writeFileSync(notifyFile, '');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
