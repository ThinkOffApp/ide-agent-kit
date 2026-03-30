// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTIFY_FILE_DEFAULT, SEEN_FILE_DEFAULT, QUEUE_PATH_DEFAULT } from './constants.mjs';

/**
 * Sanity check for ide-agent-kit environment and configuration.
 */
export async function runSanityCheck(config = {}) {
  const results = [];
  
  // 1. Check dependencies
  results.push(checkDependency('node', 'node --version'));
  results.push(checkDependency('tmux', 'tmux -V'));
  results.push(checkDependency('claude-mem', 'claude-mem --version', true));

  // 2. Check Paths & Artifacts
  results.push(checkPath('Notification File', config?.poller?.notification_file || NOTIFY_FILE_DEFAULT));
  results.push(checkPath('Seen IDs File', config?.poller?.seen_file || SEEN_FILE_DEFAULT));
  results.push(checkPath('Queue Path', config?.queue?.path || QUEUE_PATH_DEFAULT));

  // 3. Check Configuration
  if (config.poller) {
    results.push({ name: 'Poller Config', status: 'ok', detail: `Rooms: ${config.poller.rooms}` });
  } else {
    results.push({ name: 'Poller Config', status: 'warn', detail: 'No poller configuration found' });
  }

  // 4. Enrichment Backend
  if (config.memory?.backend === 'local') {
    const hasCLI = canRun('claude-mem --version');
    if (hasCLI) {
      results.push({ name: 'Memory Backend', status: 'ok', detail: 'Local claude-mem CLI found' });
    } else {
      results.push({ name: 'Memory Backend', status: 'warn', detail: 'Local memory enabled but claude-mem CLI not in PATH' });
    }
  }

  return results;
}

function checkDependency(name, cmd, optional = false) {
  try {
    const version = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return { name: `${name} binary`, status: 'ok', detail: version };
  } catch {
    return { 
      name: `${name} binary`, 
      status: optional ? 'warn' : 'fail', 
      detail: optional ? 'Not found (optional)' : 'Not found in PATH' 
    };
  }
}

function checkPath(name, path) {
  const absPath = resolve(path);
  if (existsSync(absPath)) {
    return { name, status: 'ok', detail: absPath };
  } else {
    return { name, status: 'warn', detail: `Does not exist: ${absPath}` };
  }
}

function canRun(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
