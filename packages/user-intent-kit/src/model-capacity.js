// SPDX-License-Identifier: AGPL-3.0-only
//
// model-capacity.js - is this fleet model actually usable RIGHT NOW?
//
// Standalone. packages/user-intent-kit/src/model-discovery.js, on the
// unmerged branch codex/discover-served-models, covers local-endpoint
// discovery; the two should be reconciled when that branch merges. Nothing
// here imports it. Its URL policy shape was read for reference only.
//
// What a switcher needs that a discovery heartbeat does not: a REGISTRY of
// remote boxes addressed by tailnet name, a CAPACITY reading taken from the
// box itself, a PATH reading for the network between here and there, and no
// cache at all. Callers probe at switch time.
//
// Four states, and they must never collapse into each other:
//
//   UNREACHABLE  the name does not resolve, or the TCP connect fails, or
//                nothing answered inside the budget. We learned nothing about
//                the server, so we must not claim it is down.
//   DOWN         something answered on that port, and it is not serving
//                models: an error status, unparseable JSON, or an empty list.
//   BUSY         it serves models, but the box reports a live exclusive job,
//                or free memory below the threshold. Switching here would
//                either fail to load or trample somebody's run.
//   UP           it serves models and the box has room.
//
// CAPACITY AND PATH ARE DIFFERENT AXES. An idle box across a bad link is
// still the wrong choice, so the path is never folded into the state: it is
// reported beside it as { path, p90Ms, jitterMs } and the switcher shows both.
//
// THEY ALSO HAVE DIFFERENT SCOPE, and this is the part that bites. Capacity
// is a property of the TARGET: asus1 has 117 GiB free no matter who asks, so
// that reading may be shared and reused. Path is a property of the PEER PAIR.
// Measured tonight: M5 and mini sit behind the same Helsinki router, and at
// 03:20 M5 had a direct path to Berlin while mini had been relayed
// continuously since 02:22. Same target, same building, opposite answers.
//
// Therefore every result is stamped with `from`, the host that took the
// measurement, and a path/latency reading must never be cached or shared
// across hosts. The registry carries no path field at all - only the probe
// has one, only at probe time, and only for the caller that ran it. A
// switcher must run this ON THE HOST THAT WILL CONSUME THE MODEL.
//
// LATENCY IS NEVER ONE NUMBER. Measured Helsinki mini to Berlin asus1 over 55
// minutes: rtt min 63 ms, mean 167 ms, stddev 96 ms, and the direct path
// appeared twice, briefly, in the whole window. A single sample is wrong most
// of the time and the 35 ms direct case is not the case to design for. So the
// probe takes several samples spread over a couple of seconds and reports a
// HIGH percentile (p90) plus the spread, and assumes relayed until tailscale
// says otherwise.
//
// "Empty" is never "down" one level up either: if the ssh step fails we still
// report the HTTP state, with freeMemGiB: null and capacityUnknown: true. A
// probe that cannot tell must say it cannot tell rather than report a
// comfortable default. Same for the path: `unknown`, never an assumed
// `direct`.

import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';

export const STATES = Object.freeze(['UP', 'BUSY', 'DOWN', 'UNREACHABLE']);
export const KINDS = Object.freeze(['openai', 'vllm', 'lmstudio']);
export const SHARING = Object.freeze(['exclusive', 'shared']);

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_FREE_MEM_THRESHOLD_GIB = 8;
export const DEFAULT_LATENCY_SAMPLES = 5;
export const DEFAULT_LATENCY_SPREAD_MS = 2000;
export const PATHS = Object.freeze(['direct', 'relayed', 'unknown']);
const TAILSCALE_PING_TIMEOUT_MS = 3000;

/** Who is asking. Stamped on every result, because path readings are per peer pair. */
export function defaultCallerHost() {
  return String(hostname() || 'unknown').replace(/\.(local|lan|box|home|fritz\.box)\.?$/i, '');
}

/**
 * The caller's name AS THE FLEET KNOWS IT. os.hostname() returns whatever the
 * local router handed out - "Petruss-MBP.box" in Berlin - which nobody else
 * can match to a peer. The tailnet name is the one that means something to
 * the other end of the path being measured. Falls back to the local hostname.
 */
export async function resolveCallerHost({ exec = defaultExec } = {}) {
  try {
    const result = await exec(['tailscale', 'status', '--json'], { timeoutMs: TAILSCALE_PING_TIMEOUT_MS });
    if (result?.code === 0) {
      const dns = JSON.parse(result.stdout)?.Self?.DNSName;
      const short = String(dns || '').split('.')[0].trim();
      if (short) return short;
    }
  } catch { /* fall through: a missing tailscale is not an error here */ }
  return defaultCallerHost();
}

// Fields that describe the MEASUREMENT, not the target. A registry file that
// carries one is stale by construction: it was true for whoever wrote it.
const MEASUREMENT_ONLY_FIELDS = Object.freeze(['path', 'latencyMs', 'p90Ms', 'jitterMs', 'freeMemGiB', 'state']);

// Command names that mean "this box is taken". Matched against the process
// NAME (basename of argv[0]), never against the whole command line, so that a
// path component like /var/grid/logs cannot fake a running job.
const EXCLUSIVE_PROCESS_NAMES = Object.freeze(['grid', 'cgpt', 'Grid', 'ltx', 'LTX']);
// ...plus a python running out of an ltx25 virtualenv, which is how the LTX
// video jobs actually appear in the process table.
const LTX25_VENV_PYTHON = /(^|\/)ltx25\/(bin\/)?python[0-9.]*$/;

// One remote read per entry: two round trips would double the 5s connect cost
// and blow the per-entry budget. Markers keep the answers separable, and the
// trailing `true` keeps a no-match pgrep (exit 1) from failing the read.
//
// Both memory instruments run unconditionally rather than `nvidia-smi || free`.
// An ASUS Ascent GX10 taught us why: nvidia-smi there exits 0 and prints
// "[N/A], [N/A]", because Grace Blackwell memory is unified and has no
// discrete per-GPU figure. A shell-level `||` never fires on that, so the
// fallback has to be chosen by the parser looking at the output, not by the
// remote shell looking at an exit code.
const REMOTE_SCRIPT = [
  'echo __GPU__',
  'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null',
  'echo __SYS__',
  'free -g 2>/dev/null',
  'echo __PROC__',
  "pgrep -fl 'grid|cgpt|Grid|ltx|LTX|ltx25' 2>/dev/null",
  'echo __END__',
  'true',
].join('; ');

export class RegistryError extends Error {
  constructor(message) { super(message); this.name = 'RegistryError'; }
}

// --- registry --------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * A private LAN address, or null. See config/models.README.md for why these
 * are refused: the MacBook travels, and 192.168.1.50 means different hardware
 * in Helsinki than it does in Berlin - with no error to read, just answers
 * from a stranger's box.
 */
export function lanIpReason(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(h)) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return '10.x';
  if (a === 192 && b === 168) return '192.168.x';
  if (a === 172 && b >= 16 && b <= 31) return '172.16.x - 172.31.x';
  return null;
}

function requireString(entry, field, index) {
  const value = entry?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RegistryError(`registry entry #${index + 1}: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validate a parsed registry. Accepts `{ models: [...] }` or a bare array.
 * Throws RegistryError with a message an operator can act on.
 */
export function loadRegistry(source, { allowLan = false } = {}) {
  const rows = Array.isArray(source) ? source : source?.models;
  if (!Array.isArray(rows)) {
    throw new RegistryError('registry must be a JSON array, or an object with a "models" array');
  }
  if (rows.length === 0) throw new RegistryError('registry is empty - nothing to probe');
  const seen = new Set();
  return rows.map((raw, i) => {
    const id = requireString(raw, 'id', i);
    if (seen.has(id)) throw new RegistryError(`registry entry #${i + 1}: duplicate id "${id}"`);
    seen.add(id);
    const host = requireString(raw, 'host', i);
    const kind = requireString(raw, 'kind', i);
    if (!KINDS.includes(kind)) {
      throw new RegistryError(`registry entry "${id}": kind "${kind}" must be one of ${KINDS.join(', ')}`);
    }
    const port = raw.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RegistryError(`registry entry "${id}": port must be an integer 1-65535, got ${JSON.stringify(port)}`);
    }
    const sharing = raw.sharing === undefined ? 'shared' : raw.sharing;
    if (!SHARING.includes(sharing)) {
      throw new RegistryError(`registry entry "${id}": sharing "${sharing}" must be one of ${SHARING.join(', ')}`);
    }
    for (const field of MEASUREMENT_ONLY_FIELDS) {
      if (raw[field] !== undefined) {
        throw new RegistryError(
          `registry entry "${id}": remove "${field}". That is a measurement, not a property of the box, ` +
          'and the probe produces it fresh at probe time. Path and latency in particular are per peer pair - ' +
          'two hosts behind the same router can be direct and relayed to the same target at the same moment - ' +
          'so a value written into the registry is wrong for every caller except the one who wrote it.');
      }
    }
    const lan = lanIpReason(host);
    if (lan && !allowLan) {
      throw new RegistryError(
        `registry entry "${id}": host "${host}" is a private LAN address (${lan}). ` +
        'The registry must use tailnet MagicDNS names (e.g. "asus1") or tailnet IPs (100.x), ' +
        'so the same entry reaches the same box from Helsinki and from Berlin. ' +
        'A LAN IP resolves to different hardware on a different network, silently. ' +
        'Pass --allow-lan for a deliberate single-site run.');
    }
    return {
      id, host, port, kind, sharing,
      box: typeof raw.box === 'string' ? raw.box : null,
      owner: typeof raw.owner === 'string' ? raw.owner : null,
      lanOverride: Boolean(lan),
    };
  });
}

export async function readRegistryFile(path, options = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new RegistryError(`cannot read registry ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RegistryError(`registry ${path} is not valid JSON: ${err.message}`);
  }
  return loadRegistry(parsed, options);
}

// --- HTTP probe ------------------------------------------------------------

// Errors that mean "we never got to speak to a server". Anything else that
// throws after a connection is a DOWN, not an UNREACHABLE.
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EHOSTDOWN', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

// Node's fetch wraps the real cause: the outer error is a bare TypeError, and
// the errno that names the fault (ENOTFOUND, ECONNREFUSED) is one or two
// `cause` levels down. Keep the two apart so the reason string can quote the
// specific code rather than the useless outer "TypeError".
function errorCodes(err) {
  const codes = [], names = [];
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e.code) codes.push(String(e.code));
    if (e.name) names.push(String(e.name));
  }
  return { codes, names, all: [...codes, ...names], best: codes[0] || names[0] || null };
}

export function modelsPath(kind) {
  return kind === 'lmstudio' ? '/api/v1/models' : '/v1/models';
}

/** One GET of the model list. Never sends credentials, never follows a redirect. */
async function singleGet(entry, { fetchImpl, timeoutMs, now }) {
  const started = now();
  const bracket = entry.host.includes(':') && !entry.host.startsWith('[') ? `[${entry.host}]` : entry.host;
  const url = `http://${bracket}:${entry.port}${modelsPath(entry.kind)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const { codes, all, best } = errorCodes(err);
    const rttMs = Math.max(0, now() - started);
    const hit = codes.find(c => UNREACHABLE_CODES.has(c)) || all.find(c => UNREACHABLE_CODES.has(c));
    if (hit) {
      return { http: 'UNREACHABLE', models: [], rttMs, reason: `connect failed (${hit})` };
    }
    if (all.includes('TimeoutError') || all.includes('AbortError')) {
      return { http: 'UNREACHABLE', models: [], rttMs, reason: `no response within ${timeoutMs} ms` };
    }
    // Reached something and it misbehaved (redirect refusal, TLS, protocol).
    return { http: 'DOWN', models: [], rttMs, reason: `request failed (${best || err.message})` };
  }
  if (!response.ok) {
    return {
      http: 'DOWN', models: [], rttMs: Math.max(0, now() - started),
      reason: `GET ${modelsPath(entry.kind)} returned HTTP ${response.status}`,
    };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return {
      http: 'DOWN', models: [], rttMs: Math.max(0, now() - started),
      reason: `GET ${modelsPath(entry.kind)} returned unparseable JSON`,
    };
  }
  const rttMs = Math.max(0, now() - started);
  const rows = entry.kind === 'lmstudio' ? data?.models : data?.data;
  if (!Array.isArray(rows)) {
    return { http: 'DOWN', models: [], rttMs, reason: `GET ${modelsPath(entry.kind)} had no model list` };
  }
  // LM Studio lists downloaded models too; only loaded instances can serve.
  const ids = entry.kind === 'lmstudio'
    ? rows.filter(m => m?.type === 'llm' && Array.isArray(m.loaded_instances))
      .flatMap(m => m.loaded_instances.map(i => i?.id))
    : rows.map(m => m?.id);
  const models = ids.filter(id => typeof id === 'string' && id.trim());
  if (!models.length) {
    return { http: 'DOWN', models: [], rttMs, reason: 'endpoint answered but lists no loaded model' };
  }
  return { http: 'OK', models, rttMs, reason: null };
}


// --- latency: several samples, a high percentile, and the spread ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** p-th percentile, nearest-rank, of an unsorted sample array. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** Population stddev, the spread the switcher has to survive. */
export function stddev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

export function summariseLatency(samples) {
  const clean = samples.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!clean.length) {
    return { samples: 0, p90Ms: null, medianMs: null, minMs: null, jitterMs: null, singleSample: false };
  }
  const round = v => (v === null ? null : Math.round(v * 10) / 10);
  return {
    samples: clean.length,
    p90Ms: round(percentile(clean, 90)),
    medianMs: round(percentile(clean, 50)),
    minMs: round(Math.min(...clean)),
    // One sample has no spread. Say so rather than printing a confident 0.
    jitterMs: round(stddev(clean)),
    singleSample: clean.length === 1,
  };
}

/**
 * The model-list GET, sampled. The first call decides the HTTP state and the
 * model list; the rest exist only to measure the path, because one sample of
 * a relayed tailnet hop is wrong most of the time (stddev 96 ms on the
 * measured Helsinki-Berlin link). Sampling stops early if the first call did
 * not reach a server, and it never eats into the ssh budget: the window is
 * clamped so the whole entry still fits inside timeoutMs.
 */
async function probeHttp(entry, { fetchImpl, timeoutMs, now, latencySamples, latencySpreadMs }) {
  const first = await singleGet(entry, { fetchImpl, timeoutMs, now });
  // How long a refused connection took to bounce is not a round trip to a
  // server, so it is not a latency sample. A DOWN endpoint DID answer, and
  // its response time is real, so that one counts.
  const samples = first.http === 'UNREACHABLE' ? [] : [first.rttMs];
  const wantMore = first.http !== 'UNREACHABLE' && latencySamples > 1;
  const window = Math.min(latencySpreadMs, Math.max(0, timeoutMs - Math.max(1500, first.rttMs * 2)));
  if (wantMore && window > 0) {
    const gap = window / (latencySamples - 1);
    const deadline = now() + window;
    for (let i = 1; i < latencySamples && now() < deadline; i++) {
      await sleep(Math.max(0, Math.min(gap, deadline - now())));
      const again = await singleGet(entry, { fetchImpl, timeoutMs: Math.max(250, timeoutMs), now });
      // A later sample that fails is a real observation of the link, but it
      // must not silently rewrite the state the first sample established.
      if (again.http === 'OK') samples.push(again.rttMs);
    }
  }
  const latency = summariseLatency(samples);
  return { ...first, samples, latency, latencyMs: latency.p90Ms };
}

// --- path: direct or relayed, and never guessed ---------------------------

/**
 * Read `tailscale ping -c 1 <host>`. "via DERP(hel)" is a relayed hop through
 * a Tailscale relay; "via 1.2.3.4:41641" is a direct WireGuard path. Anything
 * else, including no tailscale binary at all, is `unknown` - never `direct`.
 */
export function parseTailscalePath(stdout) {
  const text = String(stdout || '');
  if (/via\s+DERP\(/i.test(text)) return 'relayed';
  if (/via\s+(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d+/i.test(text)) return 'direct';
  return 'unknown';
}

export function tailscalePingArgv(host) {
  return ['tailscale', 'ping', '-c', '1', host];
}

async function probePath(entry, { exec }) {
  if (LOOPBACK.has(entry.host.replace(/^\[|\]$/g, ''))) {
    return { path: 'unknown', pathReason: 'loopback, no tailnet path to measure' };
  }
  let result;
  try {
    result = await exec(tailscalePingArgv(entry.host), { timeoutMs: TAILSCALE_PING_TIMEOUT_MS });
  } catch (err) {
    return { path: 'unknown', pathReason: `tailscale ping failed (${err.message})` };
  }
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  const path = parseTailscalePath(text);
  if (path === 'unknown') {
    const why = text.split('\n').map(l => l.trim()).filter(Boolean)[0] || `exit ${result?.code}`;
    return { path, pathReason: `tailscale did not say (${why})` };
  }
  return { path, pathReason: null };
}

// --- capacity probe --------------------------------------------------------

export function defaultExec(argv, { timeoutMs } = {}) {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || err?.message || ''),
      }));
  });
}

export function sshArgv(host, { connectTimeoutSec = 5 } = {}) {
  return ['ssh', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutSec}`, host, REMOTE_SCRIPT];
}

function section(stdout, start, end) {
  const from = stdout.indexOf(start);
  if (from < 0) return null;
  const to = stdout.indexOf(end, from);
  return stdout.slice(from + start.length, to < 0 ? undefined : to).trim();
}

/**
 * Free GiB from either instrument. nvidia-smi gives "used, total" in MiB per
 * GPU and we sum the free across them; `free -g` gives the "available" column,
 * which is the number that actually predicts whether a load succeeds.
 */
export function parseFreeMemGiB(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const gpu = lines.filter(l => /^\d+\s*,\s*\d+$/.test(l));
  if (gpu.length) {
    const freeMiB = gpu.reduce((sum, l) => {
      const [used, total] = l.split(',').map(n => Number(n.trim()));
      return sum + Math.max(0, total - used);
    }, 0);
    return Math.round((freeMiB / 1024) * 10) / 10;
  }
  const mem = lines.find(l => /^Mem:/i.test(l));
  if (mem) {
    const cols = mem.split(/\s+/).slice(1).map(Number);
    // total used free shared buff/cache available
    const available = cols.length >= 6 ? cols[5] : cols[2];
    return Number.isFinite(available) ? available : null;
  }
  return null;
}

/** pgrep -fl lines in, the first line that proves an exclusive job out. */
export function findExclusiveProcess(text) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!m) continue;
    const cmdline = m[2].trim();
    const argv0 = cmdline.split(/\s+/)[0];
    const name = argv0.split('/').pop();
    if (EXCLUSIVE_PROCESS_NAMES.includes(name)) return { pid: Number(m[1]), name, cmdline };
    if (LTX25_VENV_PYTHON.test(argv0)) return { pid: Number(m[1]), name: 'ltx25 venv python', cmdline };
  }
  return null;
}

async function probeCapacity(entry, { exec, timeoutMs }) {
  const argv = sshArgv(entry.host);
  let result;
  try {
    result = await exec(argv, { timeoutMs });
  } catch (err) {
    return { capacityUnknown: true, freeMemGiB: null, busy: null, note: `ssh failed (${err.message})` };
  }
  if (!result || result.code !== 0) {
    const why = (result?.stderr || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || `exit ${result?.code}`;
    return { capacityUnknown: true, freeMemGiB: null, busy: null, note: `ssh failed: ${why}` };
  }
  const stdout = String(result.stdout || '');
  const gpuText = section(stdout, '__GPU__', '__SYS__');
  const sysText = section(stdout, '__SYS__', '__PROC__');
  const procText = section(stdout, '__PROC__', '__END__');
  if (procText === null || (gpuText === null && sysText === null)) {
    return { capacityUnknown: true, freeMemGiB: null, busy: null, note: 'ssh returned no readable capacity block' };
  }
  const gpuFree = parseFreeMemGiB(gpuText);
  const freeMemGiB = gpuFree === null ? parseFreeMemGiB(sysText) : gpuFree;
  const busy = findExclusiveProcess(procText);
  if (freeMemGiB === null) {
    // pgrep worked but neither memory instrument gave a usable number: a Mac
    // has no free(1), and a unified-memory box prints nvidia-smi "[N/A]".
    return { capacityUnknown: true, freeMemGiB, busy, note: 'no usable nvidia-smi or free(1) reading on that box' };
  }
  return { capacityUnknown: false, freeMemGiB, busy, source: gpuFree === null ? 'free' : 'nvidia-smi', note: null };
}

// --- the probe ------------------------------------------------------------

function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Probe every registry entry in parallel. Resolves in timeoutMs plus change,
 * whatever the fleet does: each entry is raced against its own deadline.
 *
 * @param {Array} registry   output of loadRegistry()
 * @param {object} options   { fetchImpl, exec, now, timeoutMs, freeMemThresholdGiB }
 * @returns {Promise<Array>} one result per entry, same order
 */
export async function probeModels(registry, {
  fetchImpl = fetch,
  exec = defaultExec,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  freeMemThresholdGiB = DEFAULT_FREE_MEM_THRESHOLD_GIB,
  latencySamples = DEFAULT_LATENCY_SAMPLES,
  latencySpreadMs = DEFAULT_LATENCY_SPREAD_MS,
  callerHost = defaultCallerHost(),
} = {}) {
  const entries = Array.isArray(registry) ? registry : loadRegistry(registry);
  const options = {
    fetchImpl, exec, now, timeoutMs, freeMemThresholdGiB, latencySamples, latencySpreadMs, callerHost,
  };
  return Promise.all(entries.map(entry => probeOne(entry, options)));
}

async function probeOne(entry, {
  fetchImpl, exec, now, timeoutMs, freeMemThresholdGiB, latencySamples, latencySpreadMs, callerHost,
}) {
  const base = {
    id: entry.id, host: entry.host, port: entry.port, kind: entry.kind,
    box: entry.box ?? null, sharing: entry.sharing ?? 'shared', owner: entry.owner ?? null,
  };
  // Three axes, measured together, EACH WITH ITS OWN DEADLINE. One shared
  // deadline looked simpler and was wrong: a live run against four fleet
  // boxes had ssh and `tailscale ping` contending, the entry hit the shared
  // deadline, and its fallback overwrote an HTTP result that had already come
  // back ECONNREFUSED - turning a precise "nothing is listening on that port"
  // into a vague "no response within 8000 ms". A slow reading on one axis
  // must never erase a finished reading on another.
  //
  // They still run in parallel, so the entry as a whole stays inside
  // timeoutMs. Each is worth knowing even when another fails: the capacity of
  // a box whose server is DOWN tells you whether to bother starting it, and
  // the path tells you whether it is worth reaching for at all.
  const pathBudget = Math.min(timeoutMs, TAILSCALE_PING_TIMEOUT_MS + 500);
  const [http, capacity, pathInfo] = await Promise.all([
    withDeadline(
      probeHttp(entry, { fetchImpl, timeoutMs, now, latencySamples, latencySpreadMs }).catch(err => ({
        http: 'DOWN', models: [], latencyMs: null, latency: summariseLatency([]), reason: `probe error: ${err.message}`,
      })),
      timeoutMs,
      { http: 'UNREACHABLE', models: [], latencyMs: null, latency: summariseLatency([]),
        reason: `no response within ${timeoutMs} ms` }),
    withDeadline(
      probeCapacity(entry, { exec, timeoutMs }).catch(err => ({
        capacityUnknown: true, freeMemGiB: null, busy: null, note: `ssh error: ${err.message}`,
      })),
      timeoutMs,
      { capacityUnknown: true, freeMemGiB: null, busy: null, note: `capacity read exceeded ${timeoutMs} ms` }),
    withDeadline(
      probePath(entry, { exec }).catch(err => ({ path: 'unknown', pathReason: `path probe error: ${err.message}` })),
      pathBudget,
      { path: 'unknown', pathReason: `path read exceeded ${pathBudget} ms` }),
  ]);

  let state;
  let busyReason = null;
  let reason;
  if (http.http === 'UNREACHABLE') {
    state = 'UNREACHABLE';
    reason = http.reason;
  } else if (http.http === 'DOWN') {
    state = 'DOWN';
    reason = http.reason;
  } else if (capacity.busy) {
    state = 'BUSY';
    busyReason = `exclusive job running: ${capacity.busy.name} (pid ${capacity.busy.pid})`;
    reason = busyReason;
  } else if (!capacity.capacityUnknown && capacity.freeMemGiB < freeMemThresholdGiB) {
    state = 'BUSY';
    busyReason = `only ${capacity.freeMemGiB} GiB free, threshold ${freeMemThresholdGiB} GiB`;
    reason = busyReason;
  } else {
    state = 'UP';
    reason = `${http.models.length} model${http.models.length === 1 ? '' : 's'} served`;
  }
  // Never let a failed capacity read, or a single latency sample, read as a
  // clean bill of health.
  if (capacity.capacityUnknown && (state === 'UP' || state === 'BUSY')) {
    reason = `${reason}; capacity unknown (${capacity.note})`;
  }
  if (http.latency?.singleSample && (state === 'UP' || state === 'BUSY')) {
    reason = `${reason}; latency from 1 sample only, spread unmeasured`;
  }
  return {
    ...base,
    state,
    models: http.models,
    // p90 of the samples, not a lucky single ping. Rank on this.
    latencyMs: http.latencyMs ?? null,
    p90Ms: http.latency?.p90Ms ?? null,
    medianMs: http.latency?.medianMs ?? null,
    minMs: http.latency?.minMs ?? null,
    jitterMs: http.latency?.jitterMs ?? null,
    latencySamples: http.latency?.samples ?? 0,
    // Stamped so a result can never be mistaken for one taken elsewhere.
    // Capacity below is per target and may be shared; these two are not.
    from: callerHost,
    pathScope: 'per-caller-host',
    path: pathInfo.path,
    pathReason: pathInfo.pathReason ?? null,
    freeMemGiB: capacity.freeMemGiB,
    capacityUnknown: capacity.capacityUnknown,
    busyReason,
    reason,
    checkedAt: new Date(now()).toISOString(),
  };
}
