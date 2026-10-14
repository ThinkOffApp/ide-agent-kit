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
// A COMMAND LINE IS A CLAIM, NOT CONFIGURATION. Any process this user runs
// can put any words in its argv, so nothing here acts on argv alone:
//
//   * What the process IS comes from the kernel: the executable `lsof -d txt`
//     reports on macOS (`ps` `comm` is argv[0] there, so it can be faked), and
//     /proc/<pid>/exe on Linux. It must be `tensorfold-native`, or a Python
//     interpreter whose next words are `-m tensorfold serve` or an absolute
//     `.../tensorfold serve` entry script. `printf .../tensorfold-native serve`
//     is printf.
//   * Where it is read comes from its own listening sockets, never from
//     `--host`: a TCP socket the pid holds in LISTEN state on a loopback or
//     wildcard address, connected to on loopback. A `--port` must be one of
//     those sockets; with no `--port` the pid must listen on exactly one port.
//     An engine that listens only on another address, does not listen where
//     it says, or cannot be checked is not returned (fail closed), and the
//     reason is in `skipped`.
//   * Keys: none are read here, and the status reader never reads a key file
//     a command line names (`--api-key-file`); only that one was given is
//     kept, so the card can say how to supply it. A key comes only from a
//     registry entry the user wrote.
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
//     only that one was there.
//   * For each candidate only: two `lsof` calls on macOS (its executable, its
//     listening TCP sockets); /proc/<pid>/exe, its fd links and
//     /proc/<pid>/net/tcp{,6} on Linux.
//   * Nothing here prints a command line. The raw process table never leaves
//     this module; only the fields below do.
//
// Never throws: a failed scan is {ok: false, error} and an empty list, and
// the caller says so on the card instead of showing no servers as if none ran.

import { execFile } from 'node:child_process';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { isAbsolute } from 'node:path';

/** The engine's own defaults (cli_args.py and zig/src/server/cli.zig). */
export const DEFAULT_ENGINE_HOST = '127.0.0.1';
export const DEFAULT_ENGINE_PORT = 8080;
export const STUDIO_APP_NAME = 'TensorFold Studio';

const NATIVE_BINARY = 'tensorfold-native';
const PYTHON_BINARY = /^python[0-9.]*$/i;
// TensorFold Studio runs the engine it bundles from inside the app.
const STUDIO_BINARY = /\.app\/Contents\/Resources\/engine\/bin\/tensorfold-native$/;
// Linux truncates `comm` to 15 characters: "tensorfold-nati".
const CANDIDATE_COMM = /^(tensorfold|python)/i;
// A `ps` line worth asking the kernel about. Only a prefilter: the decision
// is made against the real executable.
const CANDIDATE_LINE = /(^|\/|-m )(tensorfold-native|tensorfold) serve(?= |$)/;
// Flags whose value matters here. Everything else on the line is ignored.
const WANTED = new Set(['--port', '--name', '--api-key-file', '--slide']);

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
    port: value('--port'),
    name: value('--name'),
    apiKeyFile: flags.has('--api-key-file'),
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
    // 0 means "any free port": the socket decides, as with no --port.
    port: port && port <= 65535 ? port : null,
    name: g.name,
    model: model ? model.slice(0, 200) : null,
    apiKeyFile: g.apiKeyFile,
    keyOnArgv: g.keyOnArgv,
    slide: g.slide,
  };
}

/**
 * An exact argv array (Linux /proc) and the process's real executable into
 * an engine, or null when it is not `tensorfold serve`. argv[0] is not
 * trusted for identity: `exe` is.
 */
export function parseServeArgv(pid, argv, exe) {
  if (!Array.isArray(argv) || typeof exe !== 'string' || !isAbsolute(exe)) return null;
  const binary = basename(exe);
  if (binary === NATIVE_BINARY) {
    return argv[1] === 'serve' ? finishEngine(pid, exe, groupArgs(argv.slice(2), true)) : null;
  }
  if (!PYTHON_BINARY.test(binary)) return null;
  if (argv[1] === '-m' && argv[2] === 'tensorfold' && argv[3] === 'serve') {
    return finishEngine(pid, exe, groupArgs(argv.slice(4), true));
  }
  if (isAbsolute(argv[1] || '') && basename(argv[1]) === 'tensorfold' && argv[2] === 'serve') {
    return finishEngine(pid, exe, groupArgs(argv.slice(3), true));
  }
  return null;
}

/**
 * One `ps -o args=` line (macOS) and the process's real executable into an
 * engine, or null when it is not `tensorfold serve`. The line is argv joined
 * with spaces, so argv[0] is found by matching the executable's own path
 * (which may contain spaces, as Studio's does) or as one word.
 */
export function parseServeLine(pid, line, exe) {
  const text = String(line || '');
  if (typeof exe !== 'string' || !isAbsolute(exe)) return null;
  const binary = basename(exe);
  let rest;
  if (text === exe || text.startsWith(`${exe} `)) rest = text.slice(exe.length + 1);
  else rest = text.slice(text.indexOf(' ') + 1 || text.length);
  const argv0 = text.slice(0, text.length - rest.length).trim();
  if (binary === NATIVE_BINARY) {
    if (argv0 !== exe && basename(argv0) !== NATIVE_BINARY) return null;
    const m = /^serve(?: |$)/.exec(rest);
    return m ? finishEngine(pid, exe, groupArgs(splitWords(rest.slice(m[0].length)), false)) : null;
  }
  if (!PYTHON_BINARY.test(binary)) return null;
  if (argv0 !== exe && !PYTHON_BINARY.test(basename(argv0))) return null;
  const m = /^(?:-m tensorfold|\/\S*\/tensorfold) serve(?: |$)/.exec(rest);
  return m ? finishEngine(pid, exe, groupArgs(splitWords(rest.slice(m[0].length)), false)) : null;
}

function splitWords(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/) : [];
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

/** `lsof -d txt -Fn`: the first name is the process's executable. */
export function parseLsofExecutable(text) {
  for (const raw of String(text || '').split('\n')) {
    if (raw.startsWith('n')) return raw.slice(1) || null;
  }
  return null;
}

function hexToIpv4(hex) {
  // /proc/net/tcp holds the address as one little-endian 32-bit word.
  const b = hex.match(/../g).map(x => parseInt(x, 16)).reverse();
  return b.join('.');
}

function hexToIpv6(hex) {
  // Four little-endian 32-bit words.
  const bytes = [];
  for (let w = 0; w < 4; w++) bytes.push(...hex.slice(w * 8, w * 8 + 8).match(/../g).reverse());
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(bytes[i] + bytes[i + 1], 16).toString(16));
  const full = groups.join(':');
  if (full === '0:0:0:0:0:0:0:0') return '::';
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  if (full.startsWith('0:0:0:0:0:ffff:')) {
    const v4 = bytes.slice(12).map(x => parseInt(x, 16)).join('.');
    return `::ffff:${v4}`;
  }
  return full;
}

/**
 * /proc/<pid>/net/tcp or tcp6 text into the LISTEN sockets whose inode is in
 * `inodes`: [{host, port}].
 */
export function parseProcNetTcp(text, inodes, v6 = false) {
  const out = [];
  for (const raw of String(text || '').split('\n').slice(1)) {
    const f = raw.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A' || !inodes.has(f[9])) continue;
    const [addr, port] = f[1].split(':');
    if (!addr || !port || addr.length !== (v6 ? 32 : 8)) continue;
    out.push({ host: v6 ? hexToIpv6(addr) : hexToIpv4(addr), port: parseInt(port, 16) });
  }
  return out;
}

/**
 * Where to connect for a listen address, or null when it is not reachable on
 * loopback: a wildcard means this machine's loopback; any other address is
 * not read.
 */
export function connectHost(listenHost) {
  const h = String(listenHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '*' || h === '0.0.0.0') return DEFAULT_ENGINE_HOST;
  if (h === '::' || h === '::1') return '::1';
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return v4;
  return null;
}

/**
 * The one socket to read an engine at, from the sockets its pid listens on.
 * Returns {host, port, portFrom} or {reason}; `quiet` marks a reason that is
 * not worth a line on the card (an engine still loading its model).
 */
export function chooseSocket(engine, sockets) {
  const usable = sockets
    .map(s => ({ host: connectHost(s.host), port: s.port }))
    .filter(s => s.host !== null && Number.isInteger(s.port) && s.port > 0);
  // IPv4 loopback first: what a wildcard socket and most clients use.
  usable.sort((a, b) => Number(a.host.includes(':')) - Number(b.host.includes(':')));
  if (engine.port !== null) {
    const match = usable.find(s => s.port === engine.port);
    if (match) return { ...match, portFrom: 'args' };
    return sockets.length
      ? { reason: `does not listen on its --port ${engine.port} on a loopback address; not read` }
      : { reason: `not listening on its --port ${engine.port} yet`, quiet: true };
  }
  const ports = [...new Set(usable.map(s => s.port))];
  if (ports.length === 1) return { ...usable[0], portFrom: 'socket' };
  if (ports.length > 1) return { reason: `listens on ${ports.length} ports and names none with --port; not read` };
  return sockets.length
    ? { reason: 'listens only on non-loopback addresses; not read' }
    : { reason: 'not listening yet', quiet: true };
}

function run(command, args, { timeoutMs = 3000, maxBuffer = 8 << 20 } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer, env: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } },
      (err, stdout) => resolve({ ok: !err || Boolean(stdout), stdout: String(stdout || ''), error: err }));
  });
}

class VerifyUnavailable extends Error {}

function lsofMissing(r) {
  return r.error && (r.error.code === 'ENOENT' || r.error.code === 'EACCES');
}

/** macOS: the pid's real executable and listening TCP sockets, from lsof. */
async function inspectWithLsof(pid, exec) {
  const exeOut = await exec('lsof', ['-nP', '-w', '-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeoutMs: 3000 });
  if (lsofMissing(exeOut)) throw new VerifyUnavailable(`lsof unavailable (${exeOut.error.code})`);
  const exe = parseLsofExecutable(exeOut.stdout);
  if (!exe) return { exe: null, sockets: [] }; // exited, or not ours to look at
  const sockOut = await exec('lsof', ['-nP', '-w', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeoutMs: 3000 });
  if (lsofMissing(sockOut)) throw new VerifyUnavailable(`lsof unavailable (${sockOut.error.code})`);
  return { exe, sockets: parseLsofListen(sockOut.stdout) };
}

/** macOS (and any ps that takes -U/-ww/-o): this user's processes. */
async function processesFromPs({ exec = run, uid = process.getuid?.() } = {}) {
  const args = uid === undefined ? ['-ww', '-x', '-o', 'pid=,args='] : ['-ww', '-U', String(uid), '-o', 'pid=,args='];
  const r = await exec('ps', args);
  if (!r.ok) throw new Error(`ps failed (${r.error?.code || 'error'})`);
  const found = [];
  for (const p of parsePsOutput(r.stdout)) {
    if (!CANDIDATE_LINE.test(p.args)) continue;
    const { exe, sockets } = await inspectWithLsof(p.pid, exec);
    const engine = parseServeLine(p.pid, p.args, exe);
    if (engine) found.push({ engine, sockets });
  }
  return found;
}

/** Linux: the LISTEN sockets a pid holds, from its fd links and its net namespace's tcp tables. */
async function socketsFromProc(base, fs) {
  const inodes = new Set();
  for (const fd of await fs.readdir(`${base}/fd`)) {
    const link = await fs.readlink(`${base}/fd/${fd}`).catch(() => '');
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (m) inodes.add(m[1]);
  }
  if (!inodes.size) return [];
  const sockets = [];
  for (const [file, v6] of [['tcp', false], ['tcp6', true]]) {
    const text = await fs.readFile(`${base}/net/${file}`, 'utf8').catch(() => '');
    sockets.push(...parseProcNetTcp(text, inodes, v6));
  }
  return sockets;
}

/** Linux: /proc, this user's processes, argv exactly as the kernel holds it. */
async function processesFromProc({ procRoot = '/proc', uid = process.getuid?.(), fs = { readdir, readFile, readlink, stat } } = {}) {
  const found = [];
  for (const entry of await fs.readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const base = `${procRoot}/${entry}`;
    try {
      if (uid !== undefined && (await fs.stat(base)).uid !== uid) continue;
      const comm = String(await fs.readFile(`${base}/comm`, 'utf8')).trim();
      if (!CANDIDATE_COMM.test(comm)) continue;
      const exe = await fs.readlink(`${base}/exe`);
      const argv = String(await fs.readFile(`${base}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const engine = parseServeArgv(Number(entry), argv, exe);
      if (!engine) continue;
      let sockets;
      try {
        sockets = await socketsFromProc(base, fs);
      } catch (err) {
        found.push({ engine, sockets: [], unverifiable: `cannot read its sockets (${err?.code || 'error'})` });
        continue;
      }
      found.push({ engine, sockets });
    } catch {
      // Exited between readdir and read, or not ours: nothing to report.
    }
  }
  return found;
}

/**
 * Every TensorFold engine this user runs on this machine, each at a loopback
 * socket its own pid listens on.
 *
 * @returns {Promise<{ok: boolean, error: string|null,
 *   engines: Array<{pid, host, port, portFrom, name, model, app, apiKeyFile, keyOnArgv, slide}>,
 *   skipped: Array<{pid, model, reason}>}>}
 *   `apiKeyFile` is a boolean: whether the engine was started with one.
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
    // Without a way to check what a process is and where it listens, no
    // engine is reported rather than any engine trusted on its word.
    const why = err instanceof VerifyUnavailable ? `cannot verify engines: ${err.message}` : err?.message;
    return { ok: false, error: String(why || 'process scan failed').slice(0, 120), engines: [], skipped: [] };
  }
  const engines = [];
  const skipped = [];
  const ports = new Set();
  for (const { engine: e, sockets, unverifiable } of found) {
    const choice = unverifiable ? { reason: unverifiable } : chooseSocket(e, sockets);
    if (choice.reason) {
      if (!choice.quiet) skipped.push({ pid: e.pid, model: e.model, reason: choice.reason });
      continue;
    }
    if (ports.has(choice.port)) continue; // one card per port
    ports.add(choice.port);
    engines.push({
      pid: e.pid,
      host: choice.host,
      port: choice.port,
      portFrom: choice.portFrom,
      name: e.name,
      model: e.model,
      app: e.app,
      apiKeyFile: e.apiKeyFile,
      keyOnArgv: e.keyOnArgv,
      slide: e.slide,
    });
  }
  return { ok: true, error: null, engines, skipped };
}
