import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session Keepalive — prevents macOS display sleep and terminal freezes
 * for IDE agents running over VNC / remote sessions.
 *
 * Two mechanisms:
 *   1. caffeinate -d -i -s  — prevents display + idle + system sleep
 *   2. stdout heartbeat     — periodic output to keep terminal buffer alive
 *
 * CLI:
 *   ide-agent-kit keepalive start [--heartbeat-sec <n>] [--pid-file <path>]
 *   ide-agent-kit keepalive stop
 *   ide-agent-kit keepalive status
 */

const DEFAULT_PID_FILE = '/tmp/ide-agent-kit-keepalive.json';

/**
 * Start caffeinate and optional heartbeat.
 */
export function keepaliveStart(config, options = {}) {
  const pidFile = options.pidFile || config?.keepalive?.pidFile || DEFAULT_PID_FILE;
  const heartbeatSec = options.heartbeatSec || config?.keepalive?.heartbeatSec || 0;

  // Check if already running
  const existing = keepaliveStatus(config, options);
  if (existing.caffeinate?.alive) {
    return { ok: true, action: 'already-running', ...existing };
  }

  // Start caffeinate -d (display) -i (idle) -s (system)
  let caffeinatePid = null;
  try {
    const child = spawn('caffeinate', ['-d', '-i', '-s'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    caffeinatePid = child.pid;
  } catch (e) {
    return { ok: false, error: `caffeinate failed: ${e.message}` };
  }

  // Write PID file
  const state = {
    caffeinate: { pid: caffeinatePid, startedAt: new Date().toISOString() },
    heartbeat: null
  };

  // Start heartbeat if requested
  if (heartbeatSec > 0) {
    const hbChild = spawn(process.execPath, ['-e', `
      setInterval(() => {
        process.stdout.write('');
      }, ${heartbeatSec * 1000});
    `], {
      detached: true,
      stdio: 'ignore'
    });
    hbChild.unref();
    state.heartbeat = { pid: hbChild.pid, intervalSec: heartbeatSec, startedAt: new Date().toISOString() };
  }

  writeFileSync(pidFile, JSON.stringify(state, null, 2));
  return { ok: true, action: 'started', pidFile, ...state };
}

/**
 * Stop caffeinate and heartbeat.
 */
export function keepaliveStop(config, options = {}) {
  const pidFile = options.pidFile || config?.keepalive?.pidFile || DEFAULT_PID_FILE;

  if (!existsSync(pidFile)) {
    return { ok: true, action: 'not-running' };
  }

  let state;
  try {
    state = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return { ok: false, error: 'corrupt pid file' };
  }

  const killed = [];

  if (state.caffeinate?.pid) {
    try { process.kill(state.caffeinate.pid, 'SIGTERM'); killed.push('caffeinate'); } catch { /* already dead */ }
  }
  if (state.heartbeat?.pid) {
    try { process.kill(state.heartbeat.pid, 'SIGTERM'); killed.push('heartbeat'); } catch { /* already dead */ }
  }

  try { execSync(`rm -f ${pidFile}`); } catch { /* ignore */ }
  return { ok: true, action: 'stopped', killed };
}

/**
 * Check keepalive status.
 */
export function keepaliveStatus(config, options = {}) {
  const pidFile = options.pidFile || config?.keepalive?.pidFile || DEFAULT_PID_FILE;

  // Check for any caffeinate process (including ones started outside this tool)
  let systemCaffeinate = [];
  try {
    const ps = execSync("ps -eo pid,args | grep 'caffeinate' | grep -v grep", { encoding: 'utf8' });
    systemCaffeinate = ps.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return { pid: parseInt(parts[0]), args: parts.slice(1).join(' ') };
    });
  } catch { /* none running */ }

  // Check PID file state
  let managed = null;
  if (existsSync(pidFile)) {
    try {
      managed = JSON.parse(readFileSync(pidFile, 'utf8'));
      // Verify processes are alive
      if (managed.caffeinate?.pid) {
        try { process.kill(managed.caffeinate.pid, 0); managed.caffeinate.alive = true; }
        catch { managed.caffeinate.alive = false; }
      }
      if (managed.heartbeat?.pid) {
        try { process.kill(managed.heartbeat.pid, 0); managed.heartbeat.alive = true; }
        catch { managed.heartbeat.alive = false; }
      }
    } catch { managed = null; }
  }

  // Check macOS power settings
  let pmset = {};
  try {
    const raw = execSync('pmset -g custom 2>/dev/null', { encoding: 'utf8' });
    const displayMatch = raw.match(/displaysleep\s+(\d+)/);
    const sleepMatch = raw.match(/\bsleep\s+(\d+)/);
    pmset = {
      displaysleep: displayMatch ? parseInt(displayMatch[1]) : null,
      sleep: sleepMatch ? parseInt(sleepMatch[1]) : null
    };
  } catch { /* not macOS or pmset unavailable */ }

  return {
    caffeinate: managed?.caffeinate || (systemCaffeinate.length > 0 ? { pid: systemCaffeinate[0].pid, alive: true, external: true } : null),
    heartbeat: managed?.heartbeat || null,
    systemCaffeinateProcesses: systemCaffeinate,
    pmset,
    pidFile
  };
}
