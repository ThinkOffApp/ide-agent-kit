#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * model-tidy CLI.
 *
 *   model-tidy plan  [--home <dir>] [--keep-file <path>] [--min-idle-days N]
 *                     [--max-gb N] [--json] [--log-dir <dir>]
 *                     [--report-to-room] [--room <name>] [--config <path>]
 *
 *   model-tidy apply --apply --target </mount/path> [same options as plan]
 *
 *   model-tidy --dry-run-remote <host> [--remote-home <dir>]
 *     ssh's to <host> and runs `plan` there, read-only. Never copies,
 *     deletes, or symlinks anything. If the remote has no `node`, this
 *     refuses and exits non-zero rather than installing one.
 *
 * See docs/model-tidy.md for full documentation.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { planRun, applyRun, writeRunLog } from '../src/model-tidy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_LOG_DIR = join(homedir(), '.cache', 'ide-agent-kit', 'model-tidy-logs');
const DEFAULT_KEEP_FILE = join(homedir(), '.config', 'ide-agent-kit', 'model-tidy.keep');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function printPlan(plan, opts) {
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(plan.summaryLine);
  console.log('');
  console.log(`Would move (${plan.selected.length}):`);
  const printedGroups = new Set();
  for (const r of plan.selected) {
    const gib = (r.sizeBytes / 2 ** 30).toFixed(2);
    console.log(`  [move]  ${r.path}  (${gib} GiB, ${r.kind}) — ${r.reason}`);
    printedGroups.add(r.groupId);
  }
  console.log('');
  console.log(`Skipped (${plan.skipped.length}):`);
  for (const r of plan.skipped) {
    const gib = (r.sizeBytes / 2 ** 30).toFixed(2);
    console.log(`  [skip]  ${r.path}  (${gib} GiB, ${r.kind}) — ${r.reason}`);
  }
}

function reportToRoom(summaryLine, args) {
  const room = args.room;
  if (!room) {
    console.error('--report-to-room requires --room <name>');
    return false;
  }
  let apiKey = process.env.IAK_API_KEY;
  if (!apiKey && args.config && existsSync(args.config)) {
    try {
      const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
      apiKey = cfg?.poller?.api_key;
    } catch (e) {
      console.error(`could not read --config ${args.config}: ${e.message}`);
    }
  }
  if (!apiKey) {
    console.error('--report-to-room: no API key (set IAK_API_KEY or pass --config pointing at a poller config with poller.api_key)');
    return false;
  }
  const payload = JSON.stringify({ room, body: summaryLine });
  try {
    execFileSync('curl', ['-sS', '-X', 'POST', 'https://groupmind.one/api/v1/messages',
      '-H', `X-API-Key: ${apiKey}`, '-H', 'Content-Type: application/json', '-d', payload],
      { timeout: 15000 });
    return true;
  } catch (e) {
    console.error(`--report-to-room: post failed: ${e.message}`);
    return false;
  }
}

function runDryRunRemote(host, args) {
  console.log(`[dry-run-remote] checking node on ${host}...`);
  const check = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'command -v node'], { encoding: 'utf8' });
  if (check.status !== 0 || !check.stdout.trim()) {
    console.error(`[dry-run-remote] ${host}: node not found on remote. Refusing to install anything.`);
    console.error('[dry-run-remote] Install Node.js >= 18 on the remote host, then re-run --dry-run-remote.');
    return 1;
  }
  const nodeVersionOut = check.stdout.trim();
  console.log(`[dry-run-remote] ${host}: found node at ${nodeVersionOut}`);

  const remoteDir = `/tmp/.model-tidy-dryrun-${process.pid}-${Date.now()}`;
  console.log(`[dry-run-remote] copying tool to ${host}:${remoteDir} (temp, read-only run, self-cleaned)...`);
  const mkdir = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p '${remoteDir}/bin' '${remoteDir}/src'`], { encoding: 'utf8' });
  if (mkdir.status !== 0) {
    console.error(`[dry-run-remote] mkdir on remote failed: ${mkdir.stderr}`);
    return 1;
  }
  const scpBin = spawnSync('scp', ['-q', join(REPO_ROOT, 'bin', 'model-tidy.mjs'), `${host}:${remoteDir}/bin/model-tidy.mjs`], { encoding: 'utf8' });
  const scpSrc = spawnSync('scp', ['-q', join(REPO_ROOT, 'src', 'model-tidy.mjs'), `${host}:${remoteDir}/src/model-tidy.mjs`], { encoding: 'utf8' });
  if (scpBin.status !== 0 || scpSrc.status !== 0) {
    console.error(`[dry-run-remote] scp failed: ${scpBin.stderr || ''} ${scpSrc.stderr || ''}`);
    spawnSync('ssh', [host, `rm -rf '${remoteDir}'`]);
    return 1;
  }

  const remoteHome = args['remote-home'] || '$HOME';
  const remoteCmd = `node '${remoteDir}/bin/model-tidy.mjs' plan --home "${remoteHome}"`;
  console.log(`[dry-run-remote] running (read-only): ${remoteCmd}`);
  const run = spawnSync('ssh', ['-o', 'BatchMode=yes', host, remoteCmd], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  console.log(run.stdout || '');
  if (run.stderr) console.error(run.stderr);

  spawnSync('ssh', [host, `rm -rf '${remoteDir}'`]);
  console.log(`[dry-run-remote] cleaned up ${host}:${remoteDir}`);
  return run.status === 0 ? 0 : (run.status ?? 1);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const mode = args._[0] || (args.apply ? 'apply' : 'plan');

  if (args['dry-run-remote']) {
    process.exit(runDryRunRemote(args['dry-run-remote'], args));
    return;
  }

  const home = args.home || homedir();
  const keepFile = args['keep-file'] || (existsSync(DEFAULT_KEEP_FILE) ? DEFAULT_KEEP_FILE : undefined);
  const minIdleDays = args['min-idle-days'] !== undefined ? Number(args['min-idle-days']) : 14;
  if (!Number.isFinite(minIdleDays) || minIdleDays < 0) {
    console.error(`--min-idle-days must be a finite, non-negative number (got ${JSON.stringify(args['min-idle-days'])}) — refusing, since a NaN here would silently disable the freshness guard`);
    process.exit(2);
  }
  const maxGb = args['max-gb'] !== undefined ? Number(args['max-gb']) : Infinity;
  if (!Number.isFinite(maxGb) && args['max-gb'] !== undefined) {
    console.error(`--max-gb must be a finite number (got ${JSON.stringify(args['max-gb'])})`);
    process.exit(2);
  }
  const logDir = args['log-dir'] || DEFAULT_LOG_DIR;

  const plan = planRun({ home, keepFile, minIdleDays, maxGb });

  const logFile = writeRunLog(logDir, {
    mode,
    ...plan,
    argv
  });

  if (mode === 'plan') {
    printPlan(plan, args);
    console.log(`\n(log: ${logFile})`);
    if (args['report-to-room']) reportToRoom(plan.summaryLine, args);
    process.exit(0);
  }

  if (mode === 'apply') {
    if (!args.apply) {
      console.error('apply mode requires the explicit --apply flag');
      process.exit(2);
    }
    if (!args.target) {
      console.error('apply mode requires --target </mount/path>');
      process.exit(2);
    }
    printPlan(plan, args);
    const result = applyRun({ plan, target: args.target, home });
    writeRunLog(logDir, { mode: 'apply', target: args.target, ...result });
    if (!result.ok) {
      console.error('\napply FAILED for one or more units — sources for failed units were left untouched:');
      for (const err of result.errors) {
        console.error(`  [error] group ${err.groupId} (${err.step}): ${err.error}`);
      }
    }
    console.log(`\nmoved ${result.moved.length} unit(s), ${result.errors.length} error(s). (log dir: ${logDir})`);
    if (args['report-to-room']) {
      reportToRoom(`model-tidy apply: moved ${result.moved.length} unit(s), ${result.errors.length} error(s)`, args);
    }
    process.exit(result.ok ? 0 : 1);
  }

  console.error(`unknown mode: ${mode} (expected "plan" or "apply")`);
  process.exit(2);
}

main();
