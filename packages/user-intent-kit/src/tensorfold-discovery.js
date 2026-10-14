// SPDX-License-Identifier: AGPL-3.0-only
//
// tensorfold-discovery.js - which TensorFold engines are running on THIS
// machine right now, found from the process table, so a server started on a
// port nobody wrote down still gets a card.
//
// The case that made this necessary: TensorFold Studio (the macOS app) starts
// its own `tensorfold-native serve ... --port <random>` and picks a new free
// loopback port on every launch. A registry entry cannot name it.
//
// WHAT IS READ, AND WHAT IS NOT.
//
//   * Command lines of this user's processes only: `ps -U <uid> -o pid=,args=`
//     on macOS (one exec, about 50 ms), /proc/<pid>/cmdline on Linux (no exec;
//     `comm` is checked first so only candidate processes have their argv
//     read). Never `ps -E`, never /proc/<pid>/environ: an engine's key may be
//     in its environment (TensorFold Studio passes it as TENSORFOLD_API_KEY),
//     and reading another process's environment to get a key it was not given
//     is taking a credential, not reading a status.
//   * `--api-key` values on a command line are never kept: the parser records
//     only that one was there. A key is read only from a file the engine was
//     pointed at with `--api-key-file`, in the engine's own format.
//   * `lsof` only when the command line has no usable `--port` (absent or 0),
//     and only for that pid's listening TCP sockets.
//   * Nothing here prints a command line. The raw process table never leaves
//     this module; only the fields below do.
//
// Never throws: a failed scan is {ok: false, error} and an empty list, and
// the caller says so on the card instead of showing no servers as if none ran.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { isAbsolute } from 'node:path';

/** The engine's own defaults (cli_args.py and zig/src/server/cli.zig). */
export const DEFAULT_ENGINE_HOST = '127.0.0.1';
export const DEFAULT_ENGINE_PORT = 8080;
export const STUDIO_APP_NAME = 'TensorFold Studio';

const BINARY_NAMES = new Set(['tensorfold-native', 'tensorfold']);
// TensorFold Studio runs the engine it bundles from inside the app.
const STUDIO_BINARY = /\.app\/Contents\/Resources\/engine\/bin\/tensorfold-native$/;
// Linux truncates `comm` to 15 characters: "tensorfold-nati".
const CANDIDATE_COMM = /^(tensorfold|python)/i;
// Flags whose value matters here. Everything else on the line is ignored.
const WANTED = new Set(['--host', '--port', '--name', '--api-key-file', '--slide']);

function basename(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1);
}

/**
 * Group the words after `serve` into a positional (the model) and flags.
 * `exact` is true for a real argv array (Linux): each flag takes at most the
 * next element. For a joined `ps` line (macOS) a value runs until the next
 * `--flag`, so a path with spaces in it ("Application Support") survives.
 */
function groupArgs(words, exact) {
  const flags = new Map();
  const positional = [];
  let current = null;
  let seenFlag = false;
  let keyOnArgv = false;
  for (const word of words) {
    if (word.startsWith('--')) {
      seenFlag = true;
      const eq = word.indexOf('=');
      const name = eq > 0 ? word.slice(0, eq) : word;
      if (name === '--api-key') keyOnArgv = true;
      // A key on the command line is noted and dropped, never stored.
      if (name === '--api-key') { current = { name, values: null }; continue; }
      current = { name, values: eq > 0 ? [word.slice(eq + 1)] : [] };
      if (WANTED.has(name) && !flags.has(name)) flags.set(name, current);
      if (eq > 0) current = null;
      continue;
    }
    if (current) {
      if (current.values !== null && (!exact || current.values.length === 0)) current.values.push(word);
      if (exact) current = null;
      continue;
    }
    if (!seenFlag) positional.push(word);
  }
  const value = name => {
    const f = flags.get(name);
    return f && f.values && f.values.length ? f.values.join(' ') : null;
  };
  return {
    model: positional.length ? positional.join(' ') : null,
    host: value('--host'),
    port: value('--port'),
    name: value('--name'),
    apiKeyFile: value('--api-key-file'),
    slide: flags.has('--slide'),
    keyOnArgv,
  };
}

/** "models--Owner--Name/snapshots/<sha>" (the Hugging Face cache) -> "Owner/Name". */
export function repoFromPath(path) {
  const m = /(?:^|\/)models--([A-Za-z0-9][A-Za-z0-9._-]*?)--([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\/|$)/.exec(String(path || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

function finishEngine(pid, binary, g) {
  const port = g.port !== null && /^\d{1,5}$/.test(g.port) ? Number(g.port) : null;
  // What the server calls itself (--name) first, as its /health would; then
  // the model argument as a repo id, or the repo a cache path belongs to.
  const repoId = g.model && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(g.model) ? g.model : null;
  const model = g.name || repoId || repoFromPath(g.model) || (g.model ? basename(g.model.replace(/\/+$/, '')) : null);
  return {
    pid,
    binary,
    app: STUDIO_BINARY.test(binary) ? STUDIO_APP_NAME : null,
    listenHost: g.host,
    port: port && port <= 65535 ? port : null,
    name: g.name,
    model: model ? model.slice(0, 200) : null,
    apiKeyFile: g.apiKeyFile,
    keyOnArgv: g.keyOnArgv,
    slide: g.slide,
  };
}

/** An exact argv array (Linux /proc) into an engine, or null when it is not `tensorfold serve`. */
export function parseServeArgv(pid, argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length - 1; i++) {
    if (!BINARY_NAMES.has(basename(argv[i])) || argv[i + 1] !== 'serve') continue;
    // argv[0] is the engine itself, or a Python interpreter running the
    // `tensorfold` entry script or `-m tensorfold`.
    const viaPython = i > 0 && /^python/i.test(basename(argv[0])) && basename(argv[i]) === 'tensorfold';
    if (i !== 0 && !viaPython) continue;
    return finishEngine(pid, argv[i], groupArgs(argv.slice(i + 2), true));
  }
  return null;
}

/** One `ps -o args=` line (macOS) into an engine, or null when it is not `tensorfold serve`. */
export function parseServeLine(pid, line) {
  const text = String(line || '');
  const m = /(^|\/|-m )(tensorfold-native|tensorfold) serve(?= |$)/.exec(text);
  if (!m) return null;
  const prefix = text.slice(0, m.index + m[1].length);
  // The word before must be the engine's own path (ending in "/"), nothing,
  // or `python -m`. An editor or `grep tensorfold serve` has none of these.
  if (prefix && !prefix.endsWith('/') && !prefix.endsWith('-m ')) return null;
  const binary = `${prefix}${m[2]}`;
  const rest = text.slice(m.index + m[0].length).trim();
  return finishEngine(pid, binary, groupArgs(rest ? rest.split(/\s+/) : [], false));
}

/** `ps -o pid=,args=` output into [{pid, args}]. */
export function parsePsOutput(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (m) out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

/** `lsof -Fn` lines ("n127.0.0.1:54635", "n*:8080", "n[::1]:8080") into [{host, port}]. */
export function parseLsofListen(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.startsWith('n')) continue;
    const m = /^n(\*|\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(raw.trim());
    if (m) out.push({ host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
  }
  return out;
}

/** Where to connect for a listen address: a wildcard means this machine's loopback. */
export function connectHost(listenHost) {
  const h = String(listenHost ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h || h === '*' || h === '0.0.0.0') return DEFAULT_ENGINE_HOST;
  if (h === '::') return '::1';
  return h;
}

function run(command, args, { timeoutMs = 3000, maxBuffer = 8 << 20 } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer, env: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } },
      (err, stdout) => resolve({ ok: !err || Boolean(stdout), stdout: String(stdout || ''), error: err }));
  });
}

/** macOS (and any ps that takes -U/-ww/-o): this user's processes. */
async function processesFromPs({ exec = run, uid = process.getuid?.() } = {}) {
  const args = uid === undefined ? ['-ww', '-x', '-o', 'pid=,args='] : ['-ww', '-U', String(uid), '-o', 'pid=,args='];
  const r = await exec('ps', args);
  if (!r.ok) throw new Error(`ps failed (${r.error?.code || 'error'})`);
  return parsePsOutput(r.stdout).map(p => parseServeLine(p.pid, p.args)).filter(Boolean);
}

/** Linux: /proc, this user's processes, argv exactly as the kernel holds it. */
async function processesFromProc({ procRoot = '/proc', uid = process.getuid?.(), fs = { readdir, readFile, stat } } = {}) {
  const engines = [];
  for (const entry of await fs.readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (uid !== undefined && (await fs.stat(`${procRoot}/${entry}`)).uid !== uid) continue;
      const comm = String(await fs.readFile(`${procRoot}/${entry}/comm`, 'utf8')).trim();
      if (!CANDIDATE_COMM.test(comm)) continue;
      const argv = String(await fs.readFile(`${procRoot}/${entry}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const engine = parseServeArgv(Number(entry), argv);
      if (engine) engines.push(engine);
    } catch {
      // Exited between readdir and read, or not ours: nothing to report.
    }
  }
  return engines;
}

/** {socket, available}: `available` is false when lsof itself could not run. */
async function listeningSocket(pid, exec) {
  const r = await exec('lsof', ['-nP', '-w', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeoutMs: 3000 });
  const socket = parseLsofListen(r.stdout)[0] ?? null;
  const missing = r.error && (r.error.code === 'ENOENT' || r.error.code === 'EACCES');
  return { socket, available: !missing };
}

/**
 * Every TensorFold engine this user runs on this machine.
 *
 * @returns {Promise<{ok: boolean, error: string|null, engines: Array<{pid, host, port, name, model,
 *   app, apiKeyFile, keyOnArgv, slide, portFrom}>}>}
 */
export async function discoverTensorFoldEngines({
  platform = osPlatform(),
  exec = run,
  uid = process.getuid?.(),
  procRoot = '/proc',
  fs,
} = {}) {
  let found;
  try {
    found = platform === 'linux'
      ? await processesFromProc({ procRoot, uid, ...(fs ? { fs } : {}) })
      : await processesFromPs({ exec, uid });
  } catch (err) {
    return { ok: false, error: String(err?.message || 'process scan failed').slice(0, 120), engines: [] };
  }
  const engines = [];
  const ports = new Set();
  for (const e of found) {
    let port = e.port;
    let host = e.listenHost;
    let portFrom = 'args';
    // No usable --port (absent, or 0 for "any free port"): ask the socket.
    // A process lsof can see with no listening socket is not serving (still
    // loading, or not an engine at all), so it is left out until it listens.
    // Only when lsof itself cannot run does the engine's documented default
    // port stand in.
    if (port === null) {
      const { socket, available } = await listeningSocket(e.pid, exec).catch(() => ({ socket: null, available: false }));
      if (socket) {
        port = socket.port;
        host = host ?? socket.host;
        portFrom = 'socket';
      } else if (!available) {
        port = DEFAULT_ENGINE_PORT;
        portFrom = 'default';
      } else {
        continue;
      }
    }
    if (ports.has(port)) continue; // one card per port
    ports.add(port);
    engines.push({
      pid: e.pid,
      host: connectHost(host ?? DEFAULT_ENGINE_HOST),
      port,
      portFrom,
      name: e.name,
      model: e.model,
      app: e.app,
      apiKeyFile: e.apiKeyFile,
      keyOnArgv: e.keyOnArgv,
      slide: e.slide,
    });
  }
  return { ok: true, error: null, engines };
}

/** Whether a key file path from an engine's argv can be read without guessing its working directory. */
export function usableKeyFilePath(path) {
  return typeof path === 'string' && isAbsolute(path);
}
