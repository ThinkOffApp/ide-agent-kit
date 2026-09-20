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
//
// CREDENTIALS, AND WHY 401 IS THREE ANSWERS AND NOT ONE.
//
// The first version of this file sent `accept: application/json` and nothing
// else, and its comment said "never sends credentials" as though that were a
// virtue. Then it met a real server. The GLM endpoint on asus1:8888 requires
// `Authorization: Bearer <token>`, so every run reported
// `DOWN ... HTTP 401` - with a key configured and without one, byte for byte
// the same line. A check whose two arms cannot differ is not a check, and
// this one was sending an operator to restart a server that was serving fine.
//
// So a 401 or 403 now resolves to one of two DIFFERENT verdicts, and the
// difference is the thing the operator has to act on:
//
//   no token available   "needs auth: no key configured for this entry"
//                        -> configure a key. The server is probably healthy.
//   token was sent       "auth rejected: key present but refused"
//                        -> the key is wrong, expired, or for another box.
//
// Both are DOWN, because neither can serve us a model right now, and both say
// which of the two repairs to attempt.
//
// CREDENTIALS ARE PATHS, NEVER VALUES. config/models.json is shared, is
// committed, and this repository is public. A token written into it is
// published the moment somebody clones. So the registry may carry
// `auth: "bearer"` and `keyFile` - a PATH to a file holding the token - and
// loadRegistry REFUSES any entry with a field named `key`, `token`, `apiKey`,
// `bearer`, `secret`, `headers` and the rest of that family. The rejection is
// the same mechanism that already refuses measurement fields, for the same
// reason: some things must not live in that file.
//
// Resolution order for one entry, first hit wins:
//   1. the entry's own `keyFile` (mode-checked: warns if group/world readable)
//   2. env LLM_API_KEY_FILE   (a path)
//   3. env LLM_API_KEY        (a value, and it says so - an env value is
//                              visible to every child process)
//
// The token is read in-process and goes straight into one request header. It
// is never interpolated into a reason, a note, a warning, a thrown error or
// any field of the result. `keySource` names WHERE a token came from; nothing
// anywhere reports WHAT it was.

import { execFile } from 'node:child_process';
import { hostname, homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const STATES = Object.freeze(['UP', 'BUSY', 'DOWN', 'UNREACHABLE']);
export const KINDS = Object.freeze(['openai', 'vllm', 'lmstudio']);
export const SHARING = Object.freeze(['exclusive', 'shared']);
export const AUTH_MODES = Object.freeze(['none', 'bearer']);

// The two verdicts a 401/403 splits into. Exported because the CLI, the tests
// and any switcher UI must all say the same words for the same fault.
export const AUTH_MISSING_REASON = 'needs auth: no key configured for this entry';
export const AUTH_REJECTED_REASON = 'auth rejected: key present but refused';

/** Where a token came from. Never what it was. */
export const KEY_SOURCES = Object.freeze({
  ENTRY_FILE: 'entry keyFile',
  ENV_FILE: 'env LLM_API_KEY_FILE',
  ENV_VALUE: 'env LLM_API_KEY',
});

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

// Fields that would carry a credential BY VALUE. Refused outright: this file
// is shared and committed, and the repository is public, so a token in it is
// published rather than configured. `keyFile` (a path) is the supported way.
// `headers` is in the list because an arbitrary header bag is just a slower
// way to write `Authorization: Bearer ...` into the registry.
const CREDENTIAL_VALUE_FIELDS = Object.freeze([
  'key', 'apiKey', 'api_key', 'apikey', 'token', 'apiToken', 'api_token',
  'accessToken', 'access_token', 'bearer', 'bearerToken', 'bearer_token',
  'secret', 'apiSecret', 'password', 'passwd', 'authorization', 'auth_token',
  'credential', 'credentials', 'headers',
]);

// A `keyFile` with no path separator in it that looks like a token rather than
// a filename. The whole point of keyFile is that it is a PATH, so pasting the
// token there has to fail loudly instead of being read as a relative filename
// and reported as ENOENT.
const LOOKS_LIKE_A_TOKEN = /^(sk-|sk_|xfb_|antfarm_|ghp_|github_pat_|Bearer\s)|^[A-Za-z0-9+/_-]{40,}={0,2}$/;

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
    for (const field of CREDENTIAL_VALUE_FIELDS) {
      if (raw[field] !== undefined) {
        throw new RegistryError(
          `registry entry "${id}": remove "${field}". A credential is never a VALUE in this file - it is ` +
          'shared, it is committed, and the repository is public, so a token written here is published ' +
          'rather than configured. Set "auth": "bearer" and point "keyFile" at a PATH to a file holding ' +
          'the token (mode 0600), or set LLM_API_KEY_FILE / LLM_API_KEY in the environment instead.');
      }
    }
    const auth = raw.auth === undefined ? (raw.keyFile === undefined ? 'none' : 'bearer') : raw.auth;
    if (!AUTH_MODES.includes(auth)) {
      throw new RegistryError(`registry entry "${id}": auth "${auth}" must be one of ${AUTH_MODES.join(', ')}`);
    }
    let keyFile = null;
    if (raw.keyFile !== undefined) {
      if (typeof raw.keyFile !== 'string' || !raw.keyFile.trim()) {
        throw new RegistryError(`registry entry "${id}": "keyFile" must be a non-empty string path`);
      }
      keyFile = raw.keyFile.trim();
      if (!keyFile.includes('/') && LOOKS_LIKE_A_TOKEN.test(keyFile)) {
        throw new RegistryError(
          `registry entry "${id}": "keyFile" must be a PATH to a file containing the token, not the token ` +
          'itself. Write the token to a file, chmod 600 it, and put that path here.');
      }
      if (auth === 'none') {
        throw new RegistryError(
          `registry entry "${id}": "keyFile" is set but "auth" is "none", so the key would never be sent. ` +
          'Set "auth": "bearer", or drop the keyFile.');
      }
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
      id, host, port, kind, sharing, auth, keyFile,
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

// --- credentials -----------------------------------------------------------

function expandHome(path) {
  const s = String(path);
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

/**
 * Read a token out of a file. Returns the token, where it came from, and a
 * warning about the file's MODE - never anything derived from the contents.
 *
 * A key file the whole machine can read is a key that has already leaked, so
 * a group/world-readable mode is reported rather than silently accepted. It
 * is a warning and not a refusal: the operator, not this probe, decides
 * whether a throwaway local credential is worth a run.
 */
async function readKeyFile(rawPath, keySource, { readFileImpl, statImpl }) {
  const path = expandHome(rawPath);
  let warning = null;
  try {
    const perm = (await statImpl(path)).mode & 0o777;
    if (perm & 0o077) {
      warning = `key file ${path} is mode 0${perm.toString(8).padStart(3, '0')} - readable beyond its owner; chmod 600 it`;
    }
  } catch { /* an unreadable file is reported by the read below, with a better message */ }
  let text;
  try {
    text = await readFileImpl(path, 'utf8');
  } catch (err) {
    return { token: null, keySource: null, keyBlocked: true, keyWarning: `cannot read key file ${path} (${err.code || err.message})` };
  }
  // .trim() and then never touched again: not logged, not returned, not
  // interpolated into any message on any path out of this function.
  const token = text.trim();
  if (!token) {
    return { token: null, keySource: null, keyBlocked: true, keyWarning: `key file ${path} is empty` };
  }
  return { token, keySource, keyBlocked: false, keyWarning: warning };
}

const NO_TOKEN = Object.freeze({ token: null, keySource: null, keyBlocked: false, keyWarning: null });

/**
 * The token for one entry, or none. Sources in priority order, first hit
 * wins: the entry's `keyFile`, then env `LLM_API_KEY_FILE` (a path), then env
 * `LLM_API_KEY` (a value).
 *
 * A keyFile that is configured but unreadable does NOT fall through to the
 * environment. Quietly substituting a different credential for the one the
 * operator named would make "which key was refused?" unanswerable.
 */
export async function resolveEntryToken(entry, {
  env = process.env, readFileImpl = readFile, statImpl = stat,
} = {}) {
  const auth = entry?.auth ?? (entry?.keyFile ? 'bearer' : 'none');
  if (auth !== 'bearer') return { ...NO_TOKEN, auth };
  const io = { readFileImpl, statImpl };
  if (entry?.keyFile) {
    return { ...(await readKeyFile(entry.keyFile, KEY_SOURCES.ENTRY_FILE, io)), auth };
  }
  const envPath = typeof env?.LLM_API_KEY_FILE === 'string' ? env.LLM_API_KEY_FILE.trim() : '';
  if (envPath) {
    return { ...(await readKeyFile(envPath, KEY_SOURCES.ENV_FILE, io)), auth };
  }
  const envValue = typeof env?.LLM_API_KEY === 'string' ? env.LLM_API_KEY.trim() : '';
  if (envValue) {
    return {
      token: envValue, keySource: KEY_SOURCES.ENV_VALUE, keyBlocked: false, auth,
      keyWarning: 'LLM_API_KEY holds the token as an environment VALUE, which every child process inherits; ' +
        'prefer LLM_API_KEY_FILE pointing at a 0600 file',
    };
  }
  return { ...NO_TOKEN, auth };
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

/**
 * One GET of the model list.
 *
 * Sends `Authorization: Bearer <token>` when a token was resolved for this
 * entry and nothing at all when one was not, which is what makes the two runs
 * distinguishable. Still NEVER follows a redirect: a 302 is an unknown
 * destination, and following one would hand this header to it.
 */
async function singleGet(entry, { fetchImpl, timeoutMs, now, token }) {
  const started = now();
  const bracket = entry.host.includes(':') && !entry.host.startsWith('[') ? `[${entry.host}]` : entry.host;
  const url = `http://${bracket}:${entry.port}${modelsPath(entry.kind)}`;
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const { codes, all, best } = errorCodes(err);
    const rttMs = Math.max(0, now() - started);
    const hit = codes.find(c => UNREACHABLE_CODES.has(c)) || all.find(c => UNREACHABLE_CODES.has(c));
    if (hit) {
      return { http: 'UNREACHABLE', models: [], rttMs, httpStatus: null, authState: null, reason: `connect failed (${hit})` };
    }
    if (all.includes('TimeoutError') || all.includes('AbortError')) {
      return { http: 'UNREACHABLE', models: [], rttMs, httpStatus: null, authState: null, reason: `no response within ${timeoutMs} ms` };
    }
    // Reached something and it misbehaved (redirect refusal, TLS, protocol).
    return { http: 'DOWN', models: [], rttMs, httpStatus: null, authState: null, reason: `request failed (${best || err.message})` };
  }
  // An auth failure is its own fault, with its own repair. Which repair
  // depends entirely on whether we had a key to offer, so the verdict does
  // too - the whole reason this branch exists.
  if (response.status === 401 || response.status === 403) {
    return {
      http: 'DOWN', models: [], rttMs: Math.max(0, now() - started),
      httpStatus: response.status,
      authState: token ? 'rejected' : 'no-key',
      reason: token ? AUTH_REJECTED_REASON : AUTH_MISSING_REASON,
    };
  }
  if (!response.ok) {
    return {
      http: 'DOWN', models: [], rttMs: Math.max(0, now() - started),
      httpStatus: response.status,
      authState: null,
      reason: `GET ${modelsPath(entry.kind)} returned HTTP ${response.status}`,
    };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return {
      http: 'DOWN', models: [], rttMs: Math.max(0, now() - started),
      httpStatus: response.status, authState: token ? 'sent' : 'open',
      reason: `GET ${modelsPath(entry.kind)} returned unparseable JSON`,
    };
  }
  const rttMs = Math.max(0, now() - started);
  const rows = entry.kind === 'lmstudio' ? data?.models : data?.data;
  if (!Array.isArray(rows)) {
    return {
      http: 'DOWN', models: [], rttMs, httpStatus: response.status, authState: token ? 'sent' : 'open',
      reason: `GET ${modelsPath(entry.kind)} had no model list`,
    };
  }
  // LM Studio lists downloaded models too; only loaded instances can serve.
  const ids = entry.kind === 'lmstudio'
    ? rows.filter(m => m?.type === 'llm' && Array.isArray(m.loaded_instances))
      .flatMap(m => m.loaded_instances.map(i => i?.id))
    : rows.map(m => m?.id);
  const models = ids.filter(id => typeof id === 'string' && id.trim());
  if (!models.length) {
    return {
      http: 'DOWN', models: [], rttMs, httpStatus: response.status, authState: token ? 'sent' : 'open',
      reason: 'endpoint answered but lists no loaded model',
    };
  }
  return { http: 'OK', models, rttMs, httpStatus: response.status, authState: token ? 'sent' : 'open', reason: null };
}


/**
 * ONE model-list GET, with this entry's credential resolved the usual way.
 *
 * The switcher wants four axes and pays for them: five samples for a p90, an
 * ssh round trip for free memory, a `tailscale ping` for the path. A device
 * heartbeat asking "what is THIS box serving?" wants exactly one of those
 * readings, from a server on loopback where latency and path are not
 * questions, and it asks on every poll - so it must not pay the other three.
 *
 * So this is the whole probe for that caller, and deliberately a re-export of
 * the same `singleGet` rather than a second implementation: same auth header
 * rules, same refusal to follow a redirect, same 401-splits-into-two verdict,
 * same per-kind parsing of the model list. A second prober would drift from
 * this one silently, and the first thing it would drift on is the thing that
 * matters most here - which answers count as "it named a model".
 *
 * Returns `singleGet`'s result plus the credential PROVENANCE (`auth`,
 * `keySource`, `keyBlocked`, `keyWarning`). Never the token itself.
 *
 * @param {object} entry  a loadRegistry() entry
 * @returns {Promise<{http: 'OK'|'DOWN'|'UNREACHABLE', models: string[],
 *   httpStatus: number|null, authState: string|null, reason: string|null}>}
 */
export async function probeServedModels(entry, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const credential = await resolveEntryToken(entry, { env });
  const result = await singleGet(entry, { fetchImpl, timeoutMs, now, token: credential.token });
  return {
    ...result,
    auth: credential.auth,
    keySource: credential.keySource,
    keyBlocked: Boolean(credential.keyBlocked),
    keyWarning: credential.keyWarning ?? null,
  };
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
async function probeHttp(entry, { fetchImpl, timeoutMs, now, latencySamples, latencySpreadMs, token }) {
  const first = await singleGet(entry, { fetchImpl, timeoutMs, now, token });
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
      const again = await singleGet(entry, { fetchImpl, timeoutMs: Math.max(250, timeoutMs), now, token });
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
  env = process.env,
} = {}) {
  const entries = Array.isArray(registry) ? registry : loadRegistry(registry);
  const options = {
    fetchImpl, exec, now, timeoutMs, freeMemThresholdGiB, latencySamples, latencySpreadMs, callerHost, env,
  };
  return Promise.all(entries.map(entry => probeOne(entry, options)));
}

async function probeOne(entry, {
  fetchImpl, exec, now, timeoutMs, freeMemThresholdGiB, latencySamples, latencySpreadMs, callerHost, env,
}) {
  const base = {
    id: entry.id, host: entry.host, port: entry.port, kind: entry.kind,
    box: entry.box ?? null, sharing: entry.sharing ?? 'shared', owner: entry.owner ?? null,
  };
  // Resolved once per entry, before the samples, so five GETs do not open the
  // key file five times. `credential` never leaves this function: only the
  // header built from it does, and only `keySource` describes it afterwards.
  const credential = await resolveEntryToken(entry, { env });
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
      probeHttp(entry, { fetchImpl, timeoutMs, now, latencySamples, latencySpreadMs, token: credential.token }).catch(err => ({
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
  // A key that was CONFIGURED and could not be read changes the verdict - the
  // entry reports "no key configured" while a keyFile sits right there in the
  // registry - so that one goes into the reason rather than only into a
  // warning field. A mode warning does not change the verdict and stays out
  // of the reason, where it would push the real fault off the line.
  if (credential.keyBlocked) {
    reason = `${reason}; ${credential.keyWarning}`;
  }
  return {
    ...base,
    state,
    models: http.models,
    // What we offered and what came back. Never the token: `keySource` says
    // which of the three sources it came from, `authState` says what the
    // server did with it, and neither can contain a secret.
    auth: credential.auth,
    keySource: credential.keySource,
    keyWarning: credential.keyWarning ?? null,
    // A credential that was CONFIGURED and could not be read. It already
    // shows up inside `reason`, but a consumer that has to decide whether an
    // entry is usable must not have to parse prose to find out: a switcher
    // that offers a key-blocked box offers one that will 401 the moment it is
    // used, and against a server that serves /v1/models unauthenticated
    // (vLLM's default, llama.cpp's default) nothing else in this result says
    // so. Reported as its own boolean for exactly that reader.
    keyBlocked: Boolean(credential.keyBlocked),
    authState: http.authState ?? null,
    httpStatus: http.httpStatus ?? null,
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

/** Where a generation probe posts. The chat route every OpenAI clone has. */
export function generationPath(kind) {
  return kind === 'lmstudio' ? '/api/v1/chat/completions' : '/v1/chat/completions';
}

/**
 * ONE tiny generation, because a model list is not evidence that anything is
 * loaded.
 *
 * WHY THIS EXISTS, measured in production 20 Sep 2026. `mlx_lm server`
 * enumerates the local HuggingFace cache in `/v1/models`. A 75 GiB model that
 * was still downloading, and whose architecture that build could not even
 * load, appeared in the listing; the reporter believed it and a dashboard
 * announced the MacBook was serving it. The server process was 2.3 GiB RSS
 * with a small model, and a generation request answered
 * `Model type qwen4_exp not supported`.
 *
 * So a listing proves that some files exist on disk - the same grade of
 * evidence as a directory scan - and the ONLY thing that proves a model is
 * loaded is that it generated. One token is enough, and one token is all this
 * asks for.
 *
 * It is not free: it costs compute on somebody's box, and against a server
 * that has NOT loaded the model it may cause it to try. That is why the
 * caller is expected to keep it switched off by default, rate limit it, and
 * refuse candidates that are incomplete or would not fit - see
 * ServedModelProbe, which does all three.
 *
 * Credentials resolve exactly as they do for the listing: `resolveEntryToken`,
 * a path never a value, and the token goes into one header and nowhere else.
 *
 * @returns {Promise<{generated: boolean, model: string|null, reason: string|null,
 *   httpStatus: number|null, rttMs: number}>}
 */
export async function probeGeneration(entry, {
  modelId,
  fetchImpl = fetch,
  timeoutMs = 5000,
  now = () => Date.now(),
  env = process.env,
  maxTokens = 1,
} = {}) {
  const started = now();
  const fail = (reason, httpStatus = null) => ({
    generated: false, model: null, reason, httpStatus, rttMs: Math.max(0, now() - started),
  });

  if (!modelId || typeof modelId !== 'string') return fail('no model id to ask about');

  const credential = await resolveEntryToken(entry, { env });
  const bracket = entry.host.includes(':') && !entry.host.startsWith('[') ? `[${entry.host}]` : entry.host;
  const url = `http://${bracket}:${entry.port}${generationPath(entry.kind)}`;
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (credential.token) headers.authorization = `Bearer ${credential.token}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
    });
  } catch (err) {
    const { all, best } = errorCodes(err);
    if (all.includes('TimeoutError') || all.includes('AbortError')) {
      // A model that has to be loaded before it can answer will blow this
      // budget. That is a degrade, never a promote: we still do not know it
      // is loaded, which is the only question being asked.
      return fail(`no token within ${timeoutMs} ms`);
    }
    return fail(`generation request failed (${best || err.message})`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      const message = body?.error?.message ?? body?.error ?? body?.detail;
      if (typeof message === 'string') detail = `: ${message.slice(0, 200)}`;
    } catch {
      // A server that cannot even describe its own failure still failed.
    }
    return fail(`generation returned HTTP ${response.status}${detail}`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return fail('generation returned unparseable JSON', response.status);
  }

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!choice) return fail('generation returned no choices', response.status);

  // The id is taken from the ANSWER, not from what we asked for. On a server
  // holding several models that is the only thing that names the one which
  // actually ran; when it says nothing, the id we asked about stands.
  const answered = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : modelId;
  return { generated: true, model: answered, reason: null, httpStatus: response.status, rttMs: Math.max(0, now() - started) };
}
