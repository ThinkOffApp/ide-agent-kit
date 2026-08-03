// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Careful hook wiring for Claude Code settings.json.
 *
 * Mirrors the merge semantics of scripts/install.sh's ensure_hook():
 * a hook is considered installed when ANY entry for the event already
 * carries a hook with the exact same command string. Unrelated hooks,
 * permissions, and unknown keys are never touched.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Ensure settings.hooks[event] contains a {type:'command', command} hook.
 * Mutates the given settings object. Returns true when something changed.
 */
export function ensureHookCommand(settings, event, command, { timeout, matcher = '' } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('settings must be a plain object');
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const entries = settings.hooks[event];
  for (const entry of entries) {
    const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
    if (inner.some((h) => h && h.command === command)) return false;
  }
  const hook = { type: 'command', command };
  if (Number.isFinite(timeout)) hook.timeout = timeout;
  // matcher scopes which tools trigger the hook. '' = all tools (default,
  // for session-lifecycle events like SessionStart that have no tool). A tool
  // name (e.g. "AskUserQuestion") means the hook only spawns for that tool,
  // not on every tool call.
  entries.push({ matcher, hooks: [hook] });
  return true;
}

/**
 * File-level wrapper: read settingsPath (or start from {}), merge the hook,
 * and write back only when something changed. Before the first write to a
 * pre-existing file a backup is taken next to it (settings.json.bak — repo
 * convention). Idempotent: re-running yields changed:false, no write, no
 * new backup.
 *
 * Returns { changed, existed, backupPath }.
 */
export function ensureHookInSettingsFile(settingsPath, event, command, opts = {}) {
  let settings = {};
  const existed = existsSync(settingsPath);
  if (existed) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  }
  const changed = ensureHookCommand(settings, event, command, opts);
  let backupPath = null;
  if (changed) {
    if (existed) {
      backupPath = `${settingsPath}.bak`;
      copyFileSync(settingsPath, backupPath);
    } else {
      mkdirSync(dirname(settingsPath), { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return { changed, existed, backupPath };
}
