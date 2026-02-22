import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * File-based memory for IDE agents with two backends:
 *
 * Backend "local" (default):
 *   Stores markdown files in a local `memory/` directory.
 *   Good for IDE agents (Claude Code, Codex, Gemini, Cursor).
 *
 * Backend "openclaw":
 *   Reads/writes to OpenClaw agent workspace memory directories.
 *   Good for bots running on the OpenClaw gateway.
 *   Requires --agent <name> to resolve workspace path.
 *
 * CLI:
 *   ide-agent-kit memory list [--backend local|openclaw] [--agent <name>] [--config <path>]
 *   ide-agent-kit memory get --key <topic> [--backend ...] [--agent <name>]
 *   ide-agent-kit memory set --key <topic> --value <text> [--backend ...] [--agent <name>]
 *   ide-agent-kit memory append --key <topic> --value <text> [--backend ...] [--agent <name>]
 *   ide-agent-kit memory delete --key <topic> [--backend ...] [--agent <name>]
 */

const DEFAULT_MEMORY_DIR = './memory';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/Users/family/openclaw';
const OPENCLAW_DATA = process.env.OPENCLAW_DATA || '/Users/family/.openclaw';

function resolveMemoryDir(config, options = {}) {
  const backend = options.backend || config?.memory?.backend || 'local';

  if (backend === 'openclaw') {
    const agent = options.agent || config?.memory?.agent;
    if (!agent) {
      throw new Error('OpenClaw backend requires --agent <name> (e.g., sally, ether, haruka)');
    }
    // OpenClaw stores memory in workspace-{agent}/memory/
    const wsDir = join(OPENCLAW_DATA, `workspace-${agent}`, 'memory');
    if (!existsSync(wsDir)) {
      mkdirSync(wsDir, { recursive: true });
    }
    return wsDir;
  }

  // Local backend
  const dir = config?.memory?.dir || DEFAULT_MEMORY_DIR;
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
}

function keyToPath(memDir, key) {
  const safe = sanitizeKey(key);
  const filename = safe.endsWith('.md') ? safe : `${safe}.md`;
  return join(memDir, filename);
}

export function memoryList(config, options = {}) {
  const memDir = resolveMemoryDir(config, options);
  try {
    const files = readdirSync(memDir).filter(f => f.endsWith('.md'));
    return files.map(f => ({
      key: f.replace(/\.md$/, ''),
      path: join(memDir, f),
      size: (() => { try { return readFileSync(join(memDir, f), 'utf8').length; } catch { return 0; } })()
    }));
  } catch {
    return [];
  }
}

export function memoryGet(config, key, options = {}) {
  const memDir = resolveMemoryDir(config, options);
  const path = keyToPath(memDir, key);
  try {
    return { key, path, content: readFileSync(path, 'utf8') };
  } catch {
    return { key, path, content: null, error: 'not found' };
  }
}

export function memorySet(config, key, value, options = {}) {
  const memDir = resolveMemoryDir(config, options);
  const path = keyToPath(memDir, key);
  writeFileSync(path, value);
  return { key, path, action: 'set', size: value.length };
}

export function memoryAppend(config, key, value, options = {}) {
  const memDir = resolveMemoryDir(config, options);
  const path = keyToPath(memDir, key);
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch { /* new file */ }
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const entry = `${separator}\n## ${timestamp}\n\n${value}\n`;
  writeFileSync(path, existing + entry);
  return { key, path, action: 'append', size: (existing + entry).length };
}

export function memoryDelete(config, key, options = {}) {
  const memDir = resolveMemoryDir(config, options);
  const path = keyToPath(memDir, key);
  try {
    unlinkSync(path);
    return { key, path, action: 'deleted' };
  } catch {
    return { key, path, action: 'not found' };
  }
}
