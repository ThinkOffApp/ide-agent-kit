// SPDX-License-Identifier: AGPL-3.0-only

/**
 * model-tidy — move idle local LLM model directories off a full internal
 * drive onto a target mount (external SSD / NAS), leaving a symlink behind
 * so every path that already points at the model keeps working.
 *
 * Two modes:
 *   plan  (default) — read-only. Lists what WOULD move, and why every other
 *                      candidate is skipped. Never touches disk.
 *   apply             — only runs with --apply AND --target <mount>. Copies
 *                      (verified byte-for-byte), then replaces the source
 *                      directory with a symlink to the copy via a crash-safe
 *                      rename/symlink/verify/cleanup sequence (swapToSymlink).
 *                      A failure at any step leaves the unit EITHER with its
 *                      original untouched (copy/verify failures, or a swap
 *                      failure that rolled back) OR with a working symlink
 *                      to a verified copy (a swap that completed) — never
 *                      neither, and never a bare deletion with no symlink.
 *
 * Zero external dependencies (Node >= 18 only), matching the rest of
 * ide-agent-kit. The copy step is a small hand-written recursive copy
 * (not a shelled-out `rsync`) specifically so that hardlink relationships
 * *within a moved unit* are recreated at the destination via fs.linkSync —
 * a plain recursive copy (or `cp -a` without `-H` semantics) would silently
 * double disk usage for a hardlinked model. See copyUnitPureNode().
 *
 * Selection rules run in this order, each producing an explicit reason.
 * Rules 2 and 3 are FAIL-CLOSED: if either check cannot be fully completed
 * for a candidate, it is skipped as unverified rather than treated as idle
 * on absence of evidence.
 *   1. KEEP list match                              -> always skipped
 *   2. open by a process, or referenced by a         -> skipped, "in use", or
 *      known serving process's command line             "in-use status unverified"
 *      if /proc can't be fully read for every pid       if unverifiable
 *   3. under (or containing) the bind-mount source    -> skipped, "in use", or
 *      of a RUNNING docker container; if docker is        "in-use status unverified"
 *      unreadable, EVERY candidate on the box is           if docker is unreadable
 *      unverified, not just the HF cache
 *   4. newest mtime within --min-idle-days            -> skipped, "too recent"
 *   5. already a symlink (previously tidied)          -> skipped, "already tidied"
 *   6. hardlink sets move as one unit: every member   -> skipped, "hardlinked to
 *      must independently clear rules 1-5 or the         <path>, which is not moving"
 *      whole set is skipped
 *
 * Remaining candidates are sorted by size (desc) and capped by --max-gb.
 */

import { spawnSync } from 'node:child_process';
import {
  readdirSync, lstatSync, existsSync, readFileSync, readlinkSync,
  realpathSync, symlinkSync, rmSync, mkdirSync, copyFileSync, linkSync,
  statSync, appendFileSync, constants as FS_CONSTANTS, accessSync, renameSync,
  openSync, writeSync, fsyncSync, closeSync, unlinkSync, readSync
} from 'node:fs';
import { join, relative, sep, isAbsolute, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

export const SERVING_PROCESS_NAMES = [
  'vllm', 'llama-server', 'llama.cpp', 'sglang', 'exllama',
  'tabby', 'ollama', 'mlx', 'text-generation'
];

const MODEL_MARKER_FILES = new Set(['config.json', 'tokenizer.json', 'tokenizer_config.json']);
const MODEL_MARKER_EXT = ['.safetensors', '.gguf', '.bin', '.pt', '.pth', '.exl2', '.exl3', '.awq', '.gptq'];
const AD_HOC_EXCLUDE = new Set([
  'Desktop', 'Downloads', 'Documents', 'Pictures', 'Movies', 'Music', 'Public',
  'node_modules', 'go', 'snap', 'models', '.cache', '.local', '.config',
  '.ssh', '.npm', '.cargo', '.rustup', '.docker', '.git'
]);

// ---------------------------------------------------------------------------
// Filesystem walking primitives
// ---------------------------------------------------------------------------

/** Recursively list regular files under root. Symlinks are NOT followed or
 * counted here (their target is counted when the target itself is walked,
 * e.g. HF cache blobs/ vs snapshots/ symlinks). Returns [] on any read error. */
export function walkFiles(root) {
  const results = [];
  function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        recurse(full);
        continue;
      }
      if (st.isFile()) {
        results.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, nlink: st.nlink });
      }
    }
  }
  recurse(root);
  return results;
}

/** Sum of real (non-symlink) file bytes under a directory. */
export function dirSizeBytes(path, filesCache) {
  const files = filesCache || walkFiles(path);
  return files.reduce((sum, f) => sum + f.size, 0);
}

/** Newest mtime (ms since epoch) of any real file under a directory. Falls
 * back to the directory's own mtime if it has no real files (e.g. an
 * all-symlink snapshots/ dir). */
export function newestMtimeMs(path, filesCache) {
  const files = filesCache || walkFiles(path);
  if (files.length === 0) {
    try {
      return lstatSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }
  return files.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
}

export function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function hasModelMarkers(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (MODEL_MARKER_FILES.has(name)) return true;
    if (MODEL_MARKER_EXT.some(ext => name.endsWith(ext))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/**
 * Discover model-directory candidates under a home directory:
 *   - ~/.cache/huggingface/hub/models--*  (whole dir is the unit; moving a
 *     snapshot without its blobs breaks it)
 *   - ~/models/*                          (each top-level entry is a unit)
 *   - ad-hoc project dirs: a top-level home entry (or its immediate `model`
 *     / marker-bearing subdir) that itself contains model marker files
 *     (config.json, tokenizer*.json, or a *.safetensors/*.gguf/... file).
 *     This is a heuristic, not exhaustive — see docs/model-tidy.md.
 */
export function discoverCandidates(home) {
  const candidates = [];
  const seen = new Set();

  function add(path, kind) {
    if (seen.has(path)) return;
    seen.add(path);
    candidates.push({ id: path, path, kind });
  }

  const hfHub = join(home, '.cache', 'huggingface', 'hub');
  if (existsSync(hfHub)) {
    for (const entry of safeReaddir(hfHub)) {
      if (isJournalSuffixed(entry)) continue;
      if (entry.startsWith('models--')) {
        add(join(hfHub, entry), 'hf-cache');
      }
    }
  }

  const modelsDir = join(home, 'models');
  if (existsSync(modelsDir)) {
    for (const entry of safeReaddir(modelsDir)) {
      if (isJournalSuffixed(entry)) continue;
      add(join(modelsDir, entry), 'models-dir');
    }
  }

  for (const entry of safeReaddir(home)) {
    if (entry.startsWith('.')) continue;
    if (isJournalSuffixed(entry)) continue;
    if (AD_HOC_EXCLUDE.has(entry)) continue;
    const full = join(home, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (hasModelMarkers(full)) {
      add(full, 'ad-hoc');
      continue;
    }
    // one level deep: e.g. ~/GLM-5.3-Flash-EXL3-2x-DGX-Sparks/model
    for (const child of safeReaddir(full)) {
      if (isJournalSuffixed(child)) continue;
      const childFull = join(full, child);
      let cst;
      try {
        cst = lstatSync(childFull);
      } catch {
        continue;
      }
      if (cst.isDirectory() && hasModelMarkers(childFull)) {
        add(childFull, 'ad-hoc');
      }
    }
  }

  return candidates;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// KEEP list
// ---------------------------------------------------------------------------

/** Load a KEEP list file: one path or glob per line, '#' comments, blank
 * lines ignored, leading '~' expanded to home. Missing file -> []. */
export function loadKeepList(keepFilePath, home = homedir()) {
  if (!keepFilePath || !existsSync(keepFilePath)) return [];
  const lines = readFileSync(keepFilePath, 'utf8').split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line.startsWith('~') ? join(home, line.slice(1).replace(/^\//, '')) : line);
  }
  return out;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** True if `path` is on the KEEP list — exact match, ancestor match (a
 * KEEP-listed directory contains this candidate), or glob match. */
export function matchesKeepList(path, keepEntries) {
  for (const entry of keepEntries) {
    if (entry.includes('*') || entry.includes('?')) {
      if (globToRegExp(entry).test(path)) return true;
      continue;
    }
    if (path === entry || path.startsWith(entry + sep) || entry.startsWith(path + sep)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process-in-use detection (Linux /proc)
// ---------------------------------------------------------------------------

/**
 * Detect processes using a path: (a) ANY process with the path open under
 * /proc/*\/fd, (b) a recognized serving process (vllm, ollama, ...) whose
 * command line references the path.
 *
 * Returns `{checked:false}` whenever the check could NOT be completed for
 * every process on the box — off Linux (no /proc), if /proc itself can't be
 * listed, or if even a single pid's fd directory or cmdline is unreadable
 * (a permission failure, not the process having simply exited mid-scan,
 * which is expected and not a failure). A permission failure on ONE pid
 * means we cannot rule out THAT pid holding any of our candidates open, so
 * it taints the whole result rather than being silently skipped — callers
 * MUST treat `checked:false` as "could not verify", never as "confirmed
 * idle".
 */
export function findProcessUsers(path, opts = {}) {
  const procRoot = opts.procRoot || '/proc';
  const doRealpath = opts.realpathSync || realpathSync; // test-only injection point for the exact fd-resolution boundary
  if (!existsSync(procRoot)) {
    return { checked: false, users: [], note: `${procRoot} not available (not Linux); process-in-use check skipped` };
  }
  let pids;
  try {
    pids = readdirSync(procRoot).filter(n => /^[0-9]+$/.test(n));
  } catch (e) {
    return { checked: false, users: [], note: `cannot list ${procRoot}: ${e.message}` };
  }
  const users = [];
  const unreadable = []; // [{pid, code}] — every pid whose check could not be completed
  for (const pid of pids) {
    let pidErrorCode = null; // first non-ENOENT error code seen for this pid, if any

    try {
      const fdDir = join(procRoot, pid, 'fd');
      let fds;
      try {
        fds = readdirSync(fdDir);
      } catch (e) {
        // ENOENT here means the process exited between the pid listing and
        // this read — a benign race, not a verification failure. Anything
        // else (EACCES/EPERM, or an unexpected error) means we genuinely
        // could not check this pid's open files, so this pid's check
        // fails closed.
        if (e.code !== 'ENOENT') pidErrorCode = e.code || 'UNKNOWN';
        fds = [];
      }
      for (const fd of fds) {
        try {
          const target = doRealpath(join(fdDir, fd));
          if (target === path || target.startsWith(path + sep)) {
            users.push({ pid, via: 'fd', target });
            break;
          }
        } catch (e) {
          // ENOENT: this one fd vanished mid-scan (closed, or the whole
          // process exited) — a benign race, not a verification failure.
          // EACCES/EPERM/anything else: we could not resolve this fd, so
          // we cannot rule it out — fail this pid's check closed.
          if (e.code !== 'ENOENT') pidErrorCode = pidErrorCode || e.code || 'UNKNOWN';
        }
      }
    } catch (e) {
      pidErrorCode = pidErrorCode || e.code || 'UNKNOWN';
    }

    try {
      const cmdline = readFileSync(join(procRoot, pid, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
      if (cmdline && cmdline.includes(path)) {
        const lower = cmdline.toLowerCase();
        const servingProcess = SERVING_PROCESS_NAMES.some(n => lower.includes(n));
        users.push({ pid, via: 'cmdline', cmdline: cmdline.slice(0, 200), servingProcess });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') pidErrorCode = pidErrorCode || e.code || 'UNKNOWN';
    }

    if (pidErrorCode) unreadable.push({ pid, code: pidErrorCode });
  }

  if (unreadable.length > 0) {
    const first = unreadable[0];
    const more = unreadable.length > 1 ? ` (+${unreadable.length - 1} more pid(s) also unreadable)` : '';
    return {
      checked: false,
      users,
      note: `${first.pid} ${first.code}${more} — cannot rule out ${unreadable.length === 1 ? 'that process' : 'those processes'} using this path`
    };
  }
  return { checked: true, users };
}

// ---------------------------------------------------------------------------
// Docker bind-mount detection
// ---------------------------------------------------------------------------

/**
 * Is `path` under, or does it CONTAIN, the bind-mount source of a RUNNING
 * docker container? Both directions matter: `path` under the mount source
 * means the whole candidate is served; the mount source under `path` means
 * moving `path` would carry an actively-mounted subdirectory away with it.
 * `{available:false}` means docker itself could not be queried — callers
 * must fail closed (see planRun: an unreadable docker means every
 * candidate on the box is treated as unverified, not just this one).
 */
export function findDockerBindUsers(path, opts = {}) {
  const dockerBin = opts.dockerBin || 'docker';
  const ps = spawnSync(dockerBin, ['ps', '-q'], { encoding: 'utf8', timeout: 10000 });
  if (ps.error || ps.status !== 0) {
    return { available: false, inUse: false, reason: `docker ps failed: ${ps.error?.message || ps.stderr?.trim() || `exit ${ps.status}`}` };
  }
  const ids = ps.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return { available: true, inUse: false, containers: [] };
  const inspect = spawnSync(dockerBin, ['inspect', ...ids], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (inspect.error || inspect.status !== 0) {
    return { available: false, inUse: false, reason: `docker inspect failed: ${inspect.error?.message || inspect.stderr?.trim() || `exit ${inspect.status}`}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch (e) {
    return { available: false, inUse: false, reason: `docker inspect returned unparseable JSON: ${e.message}` };
  }
  const hits = [];
  for (const c of parsed) {
    for (const m of c.Mounts || []) {
      if (m.Source && (path === m.Source || path.startsWith(m.Source + sep) || m.Source.startsWith(path + sep))) {
        hits.push({ container: (c.Name || '').replace(/^\//, '') || (c.Id || '').slice(0, 12), source: m.Source, destination: m.Destination });
      }
    }
  }
  return { available: true, inUse: hits.length > 0, containers: hits };
}

// ---------------------------------------------------------------------------
// Hardlink grouping
// ---------------------------------------------------------------------------

/**
 * Group candidates that share an inode (device+inode) across DIFFERENT
 * candidate roots into a single move unit. Returns a union-find lookup plus
 * a dedup'd byte size per unit (each shared inode counted once).
 */
export function computeHardlinkGroups(candidates) {
  const filesByCandidate = new Map();
  const inodeMap = new Map(); // "dev:ino" -> Set(candidateId)
  const inodeObservedCount = new Map(); // "dev:ino" -> how many file entries we actually found
  const inodeNlink = new Map(); // "dev:ino" -> st_nlink reported by the filesystem

  for (const c of candidates) {
    const files = walkFiles(c.path);
    filesByCandidate.set(c.id, files);
    for (const f of files) {
      const key = `${f.dev}:${f.ino}`;
      if (!inodeMap.has(key)) inodeMap.set(key, new Set());
      inodeMap.get(key).add(c.id);
      inodeObservedCount.set(key, (inodeObservedCount.get(key) || 0) + 1);
      inodeNlink.set(key, f.nlink);
    }
  }

  // Scanning wider cannot fully close this gap: st_nlink tells us how many
  // directory entries point at this inode SYSTEM-WIDE, including ones
  // completely outside any discovered candidate root (e.g. a manual backup
  // hardlink sitting directly under $HOME, above ~/models). If the number
  // of entries we actually found while walking the discovered candidates
  // is less than st_nlink, there is at least one more link we cannot see
  // and therefore cannot move safely — moving what we CAN see would still
  // break the invisible link and double disk usage. Every candidate that
  // owns such a file is flagged incomplete here; planRun turns this into a
  // skip reason with top priority, before any other rule.
  const incompleteReasonByCandidate = new Map();
  for (const c of candidates) {
    if (incompleteReasonByCandidate.has(c.id)) continue;
    for (const f of filesByCandidate.get(c.id)) {
      const key = `${f.dev}:${f.ino}`;
      const observed = inodeObservedCount.get(key);
      const nlink = inodeNlink.get(key);
      if (nlink > observed) {
        incompleteReasonByCandidate.set(
          c.id,
          `hardlinked ${nlink} times, only ${observed} links found under scanned roots; refusing incomplete set`
        );
        break;
      }
    }
  }

  const parent = new Map(candidates.map(c => [c.id, c.id]));
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const ids of inodeMap.values()) {
    if (ids.size > 1) {
      const arr = [...ids];
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
  }

  const groupMembers = new Map(); // groupId -> [candidateId]
  for (const c of candidates) {
    const g = find(c.id);
    if (!groupMembers.has(g)) groupMembers.set(g, []);
    groupMembers.get(g).push(c.id);
  }

  const groupSizeBytes = new Map();
  for (const [g, ids] of groupMembers) {
    const seenInode = new Set();
    let total = 0;
    for (const id of ids) {
      for (const f of filesByCandidate.get(id)) {
        const key = `${f.dev}:${f.ino}`;
        if (seenInode.has(key)) continue;
        seenInode.add(key);
        total += f.size;
      }
    }
    groupSizeBytes.set(g, total);
  }

  return { groupOf: id => find(id), groupMembers, groupSizeBytes, filesByCandidate, incompleteReasonByCandidate };
}

// ---------------------------------------------------------------------------
// Disk free space
// ---------------------------------------------------------------------------

/** Free bytes on the filesystem containing `path`, via `df -Pk`. Returns
 * null if `df` is unavailable or unparseable (caller should omit the
 * before/after line rather than print a wrong number). */
export function diskFreeBytes(path) {
  const res = spawnSync('df', ['-Pk', path], { encoding: 'utf8', timeout: 10000 });
  if (res.error || res.status !== 0) return null;
  const lines = res.stdout.trim().split('\n');
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) return null;
  return availKb * 1024;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function planRun(options = {}) {
  const home = options.home || homedir();
  const minIdleDays = options.minIdleDays ?? 14;
  const maxGb = options.maxGb ?? Infinity;
  const keepEntries = options.keepEntries || loadKeepList(options.keepFile, home);
  const listProcessUsers = options.listProcessUsers || findProcessUsers;
  const listDockerBindUsers = options.listDockerBindUsers || findDockerBindUsers;
  const getDiskFreeBytes = options.diskFreeBytes || diskFreeBytes;
  const nowMs = options.now ? options.now.getTime() : Date.now();
  const journalDir = options.journalDir || defaultJournalDir(home);

  // plan is READ-ONLY: it only DETECTS an interrupted apply from a previous
  // crash (via the journal) and reports it per unit below — it never
  // mutates anything. Only the explicit `recover` subcommand, or `apply`
  // itself, actually heals interrupted state.
  const detectFn = options.detect || detectInterruptedMoves;
  const interrupted = detectFn(home, { journalDir });
  const interruptedByPath = new Map(interrupted.filter(f => f.path).map(f => [f.path, f]));

  const rawCandidates = options.candidates || discoverCandidates(home);

  // An unreadable/stray journal record (missing, empty, truncated,
  // unparseable, or schema-invalid content) has `path: null` above — its
  // CONTENT can't tell us which candidate it was protecting. But its
  // FILENAME still encodes journalKey(sourcePath) (journalFilePath always
  // names a record that way), so recover ownership from the name: match
  // every unreadable/stray record's key against every currently
  // discovered candidate. A match refuses that specific candidate. Any
  // unreadable record whose filename doesn't match a current candidate at
  // all (an unparseable name, or a key with no current candidate) means
  // we cannot rule out that it was protecting something — fail closed
  // GLOBALLY rather than guess which unit, if any, needs protecting.
  const candidateKeyToPath = new Map();
  for (const c of rawCandidates) candidateKeyToPath.set(journalKey(c.path), c.path);

  const unresolvedJournalFiles = [];
  for (const finding of interrupted) {
    if (finding.path || !finding.journalFile) continue; // already attributable, or not a journal-file-shaped finding at all
    const key = extractJournalKeyFromFilename(finding.journalFile);
    const matchedPath = key ? candidateKeyToPath.get(key) : undefined;
    if (matchedPath) {
      interruptedByPath.set(matchedPath, {
        path: matchedPath,
        journalFile: finding.journalFile,
        status: 'interrupted',
        note: `interrupted move with unreadable journal record: ${finding.journalFile}`,
        exactReason: `interrupted move with unreadable journal record: ${finding.journalFile}`
      });
    } else {
      unresolvedJournalFiles.push(finding.journalFile);
    }
  }
  const globalJournalBlockReason = unresolvedJournalFiles.length > 0
    ? `unresolved journal state: ${unresolvedJournalFiles.join(', ')}; run recover, or resolve by hand`
    : null;

  const { groupOf, groupMembers, groupSizeBytes, filesByCandidate, incompleteReasonByCandidate } = computeHardlinkGroups(rawCandidates);

  const perCandidate = new Map();
  for (const c of rawCandidates) {
    let skipReason = null;

    // Rule 0, highest priority: a hardlink whose partner is invisible to
    // this scan (outside every discovered candidate root) is a filesystem
    // fact, not a policy choice — check it before KEEP/process/docker/etc.
    if (incompleteReasonByCandidate.has(c.id)) {
      skipReason = incompleteReasonByCandidate.get(c.id);
    } else if (matchesKeepList(c.path, keepEntries)) {
      skipReason = 'on KEEP list';
    } else if (isSymlink(c.path)) {
      skipReason = 'already a symlink (tidied)';
    } else {
      // Rules 2-3 (process / docker in-use) are fail-closed: if either
      // check could not be fully completed, we cannot prove the candidate
      // is idle, so it is skipped as unverified rather than allowed
      // through on absence of evidence. An unreadable docker taints EVERY
      // candidate on the box, not just the HF cache — a container could
      // bind-mount anything.
      const procResult = listProcessUsers(c.path);
      if (procResult.checked === false) {
        skipReason = `in-use status unverified: ${procResult.note || 'process check could not be completed'}`;
      } else {
        const fdHit = (procResult.users || []).find(u => u.via === 'fd');
        const cmdHit = (procResult.users || []).find(u => u.via === 'cmdline' && u.servingProcess);
        const hit = fdHit || cmdHit;
        if (hit) {
          skipReason = hit.via === 'fd'
            ? `in use: pid ${hit.pid} has a file open under this path`
            : `in use: pid ${hit.pid} serving process references this path (${hit.cmdline})`;
        } else {
          const dockerResult = listDockerBindUsers(c.path);
          if (dockerResult.available === false) {
            skipReason = `in-use status unverified: docker not readable (${dockerResult.reason})`;
          } else if (dockerResult.inUse) {
            const first = dockerResult.containers[0];
            skipReason = `in use: bind-mounted into running container ${first.container} (${first.source} -> ${first.destination})`;
          }
          if (!skipReason) {
            const files = filesByCandidate.get(c.id);
            const newest = newestMtimeMs(c.path, files);
            const ageDays = (nowMs - newest) / 86400000;
            if (ageDays < minIdleDays) {
              skipReason = `modified ${ageDays.toFixed(1)}d ago, newer than --min-idle-days ${minIdleDays}`;
            }
          }
        }
      }
    }

    perCandidate.set(c.id, {
      id: c.id,
      path: c.path,
      kind: c.kind,
      sizeBytes: dirSizeBytes(c.path, filesByCandidate.get(c.id)),
      skipReason
    });
  }

  const results = [];
  for (const [gid, memberIds] of groupMembers) {
    const members = memberIds.map(id => perCandidate.get(id));
    const failing = members.find(m => m.skipReason);
    const isHardlinkSet = memberIds.length > 1;
    if (failing) {
      for (const m of members) {
        results.push({
          ...m,
          groupId: gid,
          groupSizeBytes: groupSizeBytes.get(gid),
          selected: false,
          reason: isHardlinkSet && m.id !== failing.id
            ? `hardlinked to ${failing.path}, which is not moving (${failing.skipReason})`
            : m.skipReason
        });
      }
    } else {
      for (const m of members) {
        results.push({
          ...m,
          groupId: gid,
          groupSizeBytes: groupSizeBytes.get(gid),
          selected: true,
          reason: isHardlinkSet ? 'idle (hardlink set, all members idle)' : 'idle'
        });
      }
    }
  }

  // Cap by --max-gb: whole groups only, largest first.
  const maxBytes = maxGb === Infinity ? Infinity : maxGb * 2 ** 30;
  const idleGroupIds = [...new Set(results.filter(r => r.selected).map(r => r.groupId))]
    .sort((a, b) => groupSizeBytes.get(b) - groupSizeBytes.get(a));
  let runningTotal = 0;
  const cappedGroupIds = new Set();
  for (const gid of idleGroupIds) {
    const size = groupSizeBytes.get(gid);
    if (runningTotal + size <= maxBytes) {
      runningTotal += size;
    } else {
      cappedGroupIds.add(gid);
    }
  }
  for (const r of results) {
    if (r.selected && cappedGroupIds.has(r.groupId)) {
      r.selected = false;
      r.reason = `deferred: --max-gb ${maxGb} cap reached for this run`;
    }
  }

  // An interrupted move takes absolute priority over every other rule: it
  // is a filesystem fact discovered from the journal, not a policy choice,
  // and this unit must never be selected until 'recover' resolves it.
  // Override any existing result for this path, or synthesize one if the
  // unit's real directory is currently missing (mid-swap) so discovery
  // never saw it at all.
  for (const finding of interruptedByPath.values()) {
    const existingIdx = results.findIndex(r => r.path === finding.path);
    // A record recovered by filename-matching (GAP 1) already carries the
    // exact required reason text; a normal readable record still gets the
    // generic wrapper.
    const reason = finding.exactReason || `interrupted move found: ${finding.note}`;
    if (existingIdx >= 0) {
      results[existingIdx].selected = false;
      results[existingIdx].reason = reason;
    } else {
      results.push({
        id: finding.path,
        path: finding.path,
        kind: 'interrupted',
        sizeBytes: 0,
        groupId: finding.path,
        groupSizeBytes: 0,
        selected: false,
        reason
      });
    }
  }

  // GAP 1, global fail-closed: an unreadable/stray journal file whose
  // filename could not be matched to any current candidate means we
  // cannot rule out that it was protecting something — plan selects
  // NOTHING this run rather than guess. Candidates that already have a
  // more specific reason (KEEP, an unrelated in-use check, a matched
  // interrupted record, ...) keep that reason; only would-be-selected
  // candidates are overridden here.
  if (globalJournalBlockReason) {
    for (const r of results) {
      if (r.selected) {
        r.selected = false;
        r.reason = globalJournalBlockReason;
      }
    }
  }

  results.sort((a, b) => b.groupSizeBytes - a.groupSizeBytes || a.path.localeCompare(b.path));

  const selected = results.filter(r => r.selected);
  const skipped = results.filter(r => !r.selected);
  const selectedGroupIds = new Set(selected.map(r => r.groupId));
  const totalSelectedBytes = [...selectedGroupIds].reduce((sum, gid) => sum + groupSizeBytes.get(gid), 0);
  const unverifiedCount = skipped.filter(r => r.reason.includes('unverified')).length;

  const freeBeforeBytes = getDiskFreeBytes(home);
  const freeAfterEstimateBytes = freeBeforeBytes == null ? null : freeBeforeBytes + totalSelectedBytes;

  const freeLine = freeBeforeBytes == null
    ? 'free before/after: unknown (df unavailable)'
    : `free before/after: ${(freeBeforeBytes / 2 ** 30).toFixed(1)} GiB -> ~${(freeAfterEstimateBytes / 2 ** 30).toFixed(1)} GiB`;

  const interruptedLine = interrupted.length > 0
    ? ` ${interrupted.length} interrupted-move finding(s) detected (never mutated by plan — run 'recover' to resolve).`
    : '';
  const globalBlockLine = globalJournalBlockReason ? ` REFUSING TO SELECT ANYTHING THIS RUN: ${globalJournalBlockReason}` : '';
  const summaryLine = `model-tidy plan: ${selected.length} dir(s) in ${selectedGroupIds.size} unit(s), ` +
    `${(totalSelectedBytes / 2 ** 30).toFixed(1)} GiB movable to target, ${skipped.length} skipped ` +
    `(${unverifiedCount} unverified). ${freeLine}${interruptedLine}${globalBlockLine}`;

  return {
    home,
    minIdleDays,
    maxGb,
    interrupted,
    globalJournalBlockReason,
    selected,
    skipped,
    totalSelectedBytes,
    unverifiedCount,
    freeBeforeBytes,
    freeAfterEstimateBytes,
    freeLine,
    summaryLine,
    generatedAt: new Date(nowMs).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export const HASH_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB — bounded memory regardless of file size

/**
 * SHA-256 of a file's content with BOUNDED memory: reads in fixed-size
 * chunks via readSync into one reused buffer, never the whole file at
 * once via readFileSync. Model shards are routinely multi-GiB
 * (.safetensors/.gguf); loading one whole into a Buffer to hash it could
 * exhaust memory or exceed Node's Buffer size limit on some builds. Every
 * hashing call site in this file (manifest computation, manifest
 * verification, and rsync-style copy verification) goes through this one
 * function, so fixing it here fixes all of them.
 */
export function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = openSync(path, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
      if (bytesRead > 0) {
        hash.update(bytesRead === HASH_CHUNK_BYTES ? buffer : buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Pure-Node recursive copy of one or more source directories into
 * `targetRoot`, preserving relative-to-`home` layout, preserving symlinks
 * verbatim, and recreating hardlinks *within this call* (a shared
 * `inodeToTargetPath` map across all `sourceAbsPaths`) so a hardlinked unit
 * stays a hardlinked unit at the destination instead of doubling in size.
 */
export function copyUnitPureNode(sourceAbsPaths, home, targetRoot) {
  const inodeToTargetPath = new Map();

  function copyDir(srcDir, dstDir) {
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const s = join(srcDir, entry.name);
      const d = join(dstDir, entry.name);
      const lst = lstatSync(s);
      if (lst.isSymbolicLink()) {
        symlinkSync(readlinkSync(s), d);
      } else if (lst.isDirectory()) {
        copyDir(s, d);
      } else if (lst.isFile()) {
        const key = `${lst.dev}:${lst.ino}`;
        if (inodeToTargetPath.has(key)) {
          linkSync(inodeToTargetPath.get(key), d);
        } else {
          copyFileSync(s, d);
          inodeToTargetPath.set(key, d);
        }
      }
    }
  }

  for (const src of sourceAbsPaths) {
    const rel = relative(home, src);
    const dst = join(targetRoot, rel);
    copyDir(src, dst);
  }
}

/** Byte-for-byte verification: same set of relative paths, same symlink
 * targets, same file sizes AND sha256 for every regular file. */
export function verifyUnit(sourceAbsPaths, home, targetRoot) {
  const mismatches = [];
  for (const src of sourceAbsPaths) {
    const rel = relative(home, src);
    const dst = join(targetRoot, rel);
    const srcFiles = listAllEntries(src);
    for (const s of srcFiles) {
      const relToUnit = relative(src, s);
      const d = join(dst, relToUnit);
      const lst = lstatSync(s);
      if (!existsSync(d)) {
        mismatches.push({ path: s, reason: 'missing at target', target: d });
        continue;
      }
      const dlst = lstatSync(d);
      if (lst.isSymbolicLink()) {
        if (!dlst.isSymbolicLink() || readlinkSync(s) !== readlinkSync(d)) {
          mismatches.push({ path: s, reason: 'symlink target mismatch', target: d });
        }
      } else if (lst.isFile()) {
        if (!dlst.isFile()) {
          mismatches.push({ path: s, reason: 'not a regular file at target', target: d });
          continue;
        }
        if (lst.size !== dlst.size) {
          mismatches.push({ path: s, reason: `size mismatch (${lst.size} vs ${dlst.size})`, target: d });
          continue;
        }
        const srcHash = sha256File(s);
        const dstHash = sha256File(d);
        if (srcHash !== dstHash) {
          mismatches.push({ path: s, reason: 'checksum mismatch', target: d });
        }
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function listAllEntries(root) {
  const out = [];
  function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      out.push(full);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) recurse(full);
    }
  }
  recurse(root);
  return out;
}

/** Validate --target: must be an absolute path, must exist, be a directory,
 * be writable, and be on a different filesystem device than `home`. */
export function validateTarget(target, home) {
  if (!target) return { ok: false, error: '--target is required with --apply' };
  if (!isAbsolute(target)) return { ok: false, error: `--target ${target} must be an absolute path (a relative target makes the resulting symlink text ambiguous)` };
  if (!existsSync(target)) return { ok: false, error: `--target ${target} does not exist` };
  const st = statSync(target);
  if (!st.isDirectory()) return { ok: false, error: `--target ${target} is not a directory` };
  try {
    accessSync(target, FS_CONSTANTS.W_OK);
  } catch {
    return { ok: false, error: `--target ${target} is not writable` };
  }
  const homeSt = statSync(home);
  if (st.dev === homeSt.dev) {
    return { ok: false, error: `--target ${target} is on the same filesystem (dev ${st.dev}) as ${home}; refusing (must be a different mount)` };
  }
  return { ok: true };
}

const STAGING_SUFFIX = '.tidy-moving';
const LINK_SUFFIX = '.tidy-link';
const JOURNAL_SUBDIR = 'model-tidy-journal';

function isJournalSuffixed(name) {
  return name.endsWith(STAGING_SUFFIX) || name.endsWith(LINK_SUFFIX) || name.includes(QUARANTINE_SUFFIX_PREFIX);
}

function defaultJournalDir(home) {
  return join(home, '.cache', 'ide-agent-kit', JOURNAL_SUBDIR);
}

function journalKey(sourcePath) {
  return createHash('sha256').update(sourcePath).digest('hex');
}

function journalFilePath(journalDir, sourcePath) {
  return join(journalDir, `${journalKey(sourcePath)}.json`);
}

const JOURNAL_KEY_PATTERN = /^([0-9a-f]{64})\.json(?:\.tmp-.*)?$/;

/**
 * Recover ownership from a journal file's NAME alone — used when its
 * CONTENT can't be trusted (missing, empty, truncated, unparseable, or
 * schema-invalid). `journalFilePath` always names a record
 * `<journalKey(sourcePath)>.json` (or, for a stray in-flight write,
 * `...json.tmp-<pid>-<random>`), so the 64-hex-char key survives even
 * when the record's content doesn't. Returns null if the filename doesn't
 * match that shape at all (a genuinely unrecognizable file).
 */
function extractJournalKeyFromFilename(file) {
  const match = basename(file).match(JOURNAL_KEY_PATTERN);
  return match ? match[1] : null;
}

/** Minimal structural check for a parsed journal record. Anything that
 * doesn't match — including a record that parsed as valid JSON but isn't
 * actually one of ours (wrong shape) — is treated as unreadable, exactly
 * like a truncated or corrupt file. */
function isValidJournalRecordShape(record) {
  return !!record
    && typeof record === 'object'
    && typeof record.sourcePath === 'string' && record.sourcePath.length > 0
    && typeof record.stagedPath === 'string' && record.stagedPath.length > 0
    && typeof record.linkPath === 'string' && record.linkPath.length > 0
    && typeof record.targetPath === 'string' && record.targetPath.length > 0
    && Array.isArray(record.manifest)
    && typeof record.step === 'string' && record.step.length > 0;
}

/**
 * Write (or overwrite) the journal record for one unit, durably. Called
 * BEFORE the first filesystem mutation for a unit, and again after every
 * subsequent step, so the journal always reflects the furthest point
 * actually reached — including across a hard crash.
 *
 * A naive `open(file, 'w')` + write + fsync has its own crash window: a
 * kill between the truncating open and the write leaves an EMPTY or
 * PARTIAL record at the well-known path readers expect — which would
 * make a real, in-flight unit look like there's simply nothing to
 * recover. Instead: write the full content to a throwaway temp file in
 * the same directory, fsync THAT file, close it, atomically rename it
 * over the real path (a same-directory rename is atomic — readers either
 * see the old complete record or the new complete record, never a
 * partial one), then fsync the directory itself so the rename survives a
 * crash immediately after. On platforms where a directory can't be
 * opened for fsync, that failure is swallowed (the rename itself is still
 * safe there) — noted here in case it needs to change for a supported
 * platform where journal loss would matter.
 */
/**
 * Write one journal record durably — or refuse to claim it was written
 * durably at all. `opts.fsyncSync`/`opts.renameSync` are test-only
 * injection points (default to the real `fsyncSync`/`renameSync`);
 * `opts.platform` defaults to the real `process.platform` but is
 * injectable so tests can exercise the Linux-vs-other-platform rule
 * without actually running on both.
 *
 * On the supported target (Linux): ANY error from the temp-file fsync,
 * the rename into place, or the journal-directory fsync throws — the
 * caller aborts the unit before any source mutation that write was meant
 * to guard, and no claim of durability is ever made silently.
 *
 * On a non-Linux dev platform: the same is true EXCEPT for the directory
 * fsync specifically — `ENOTSUP` or `EINVAL` there (common on filesystems
 * or platforms that don't support fsync-ing a directory fd at all) is
 * tolerated, and the write still succeeds, but the returned
 * `durabilityNote` says so explicitly rather than silently pretending
 * durability was achieved. `EIO` and everything else still abort there
 * too — only that specific "this platform doesn't support the operation"
 * shape of failure is tolerated, never an I/O error.
 */
function writeJournalRecordSync(journalDir, record, opts = {}) {
  const doFsync = opts.fsyncSync || fsyncSync;
  const doRename = opts.renameSync || renameSync;
  const platform = opts.platform || process.platform;

  mkdirSync(journalDir, { recursive: true });
  const file = journalFilePath(journalDir, record.sourcePath);
  const tmpFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const data = JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2);

  const fd = openSync(tmpFile, 'w');
  try {
    writeSync(fd, data);
    try {
      doFsync(fd);
    } catch (e) {
      throw new Error(`journal write for ${file} aborted: could not fsync the temp file (${e.code || e.message})`);
    }
  } finally {
    closeSync(fd);
  }

  try {
    doRename(tmpFile, file);
  } catch (e) {
    throw new Error(`journal write for ${file} aborted: could not rename the temp file into place (${e.code || e.message})`);
  }

  let durabilityNote = null;
  try {
    const dirFd = openSync(journalDir, 'r');
    try {
      doFsync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (e) {
    const code = e.code || 'UNKNOWN';
    const tolerable = platform !== 'linux' && (code === 'ENOTSUP' || code === 'EINVAL');
    if (!tolerable) {
      const platformNote = platform === 'linux' ? ' (no durability claim can be made on the supported Linux target)' : '';
      throw new Error(`journal write for ${file} aborted: could not fsync the journal directory (${code})${platformNote}`);
    }
    durabilityNote = `durability degraded: ${code}`;
  }

  return { file, durabilityNote };
}

function removeJournalRecord(journalDir, sourcePath) {
  const file = journalFilePath(journalDir, sourcePath);
  try {
    rmSync(file);
  } catch {
    // already gone — fine
  }
}

/**
 * All journal records currently on disk. A record that is missing,
 * empty, truncated, fails to parse, or doesn't match the expected schema
 * is still returned — as `{record: null, corrupt: true, reason}` — so
 * callers report it rather than silently skip it or, worse, act on
 * whatever partial data it happens to contain. A leftover `.tmp-*` file
 * from an interrupted journal WRITE (crashed between creating the temp
 * file and the rename) is recognized by name and reported the same way;
 * it is never parsed as a record.
 */
function listJournalRecords(journalDir) {
  if (!existsSync(journalDir)) return [];
  const out = [];
  for (const name of safeReaddir(journalDir)) {
    const file = join(journalDir, name);
    if (name.includes('.tmp-')) {
      out.push({ file, record: null, corrupt: true, reason: 'stray incomplete journal write (a .tmp file left over from an interrupted write); never parsed as a record' });
      continue;
    }
    if (!name.endsWith('.json')) continue;

    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      out.push({ file, record: null, corrupt: true, reason: `journal file unreadable (${e.code || e.message})` });
      continue;
    }
    if (raw.length === 0) {
      out.push({ file, record: null, corrupt: true, reason: 'journal file is empty (zero bytes)' });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out.push({ file, record: null, corrupt: true, reason: `journal file is not valid JSON, likely truncated (${e.message})` });
      continue;
    }
    if (!isValidJournalRecordShape(parsed)) {
      out.push({ file, record: null, corrupt: true, reason: 'journal file does not match the expected record schema' });
      continue;
    }
    out.push({ file, record: parsed });
  }
  return out;
}

/** size + sha256 (files) / link target (symlinks) for every entry under
 * `rootDir`, relative to it. Directories are implied by their children's
 * relPaths and not recorded individually. */
function computeManifest(rootDir) {
  const manifest = [];
  for (const full of listAllEntries(rootDir)) {
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    const relPath = relative(rootDir, full);
    if (lst.isSymbolicLink()) {
      manifest.push({ relPath, type: 'symlink', linkTarget: readlinkSync(full) });
    } else if (lst.isFile()) {
      manifest.push({ relPath, type: 'file', size: lst.size, sha256: sha256File(full) });
    }
  }
  return manifest;
}

/** True only if every manifest entry exists under `rootDir` with matching
 * size+sha256 (files) or link target (symlinks). Used by recovery to
 * refuse to act on a journal record whose paths don't actually match what
 * it claims — see recoverInterruptedMoves(). */
function verifyManifest(rootDir, manifest) {
  for (const entry of manifest) {
    const full = join(rootDir, entry.relPath);
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      return false;
    }
    if (entry.type === 'symlink') {
      if (!lst.isSymbolicLink() || readlinkSync(full) !== entry.linkTarget) return false;
    } else {
      if (!lst.isFile() || lst.size !== entry.size || sha256File(full) !== entry.sha256) return false;
    }
  }
  return true;
}

/** Stricter than verifyManifest: every manifest entry must be present and
 * match AND there must be no extra file/symlink under `rootDir` beyond
 * what the manifest lists. Used specifically for the delete-the-staged-
 * original decision, where "the manifest's entries happen to be present"
 * is not enough — corrupted-but-additional content must also fail this. */
function manifestExactMatch(rootDir, manifest) {
  if (!existsSync(rootDir)) return false;
  if (!verifyManifest(rootDir, manifest)) return false;
  const manifestRelPaths = new Set(manifest.map(m => m.relPath));
  let actualCount = 0;
  for (const full of listAllEntries(rootDir)) {
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    if (!lst.isFile() && !lst.isSymbolicLink()) continue; // directories aren't in the manifest
    actualCount++;
    if (!manifestRelPaths.has(relative(rootDir, full))) return false; // extra, untracked entry
  }
  return actualCount === manifestRelPaths.size;
}

const QUARANTINE_SUFFIX_PREFIX = '.tidy-quarantine-';

/**
 * The ONLY place in this file allowed to delete OR rename away a staged
 * original. Called both from swapToSymlink's own final step (same run)
 * and from recovery (a later run) — one guarded function, one invariant,
 * everywhere a staged original could be discarded.
 *
 * Checks three independent facts, then follows an explicit 4-row decision
 * table — no single pass/fail collapse, because "the live path is fine"
 * and "the backup is fine" are NOT the same question, and conflating them
 * caused two different real data-loss bugs (see git history):
 *   targetOk    — every file under the journal's targetPath matches the
 *                 manifest by size + SHA-256, no extra or missing paths.
 *                 The link having been verified once, when it was
 *                 CREATED, is not evidence about the target's content
 *                 NOW — it can change afterwards (corruption, a second
 *                 process, disk issues).
 *   linkOk      — sourcePath is a symlink whose realpath resolves to
 *                 exactly the journal's recorded targetPath.
 *   stagedState — 'absent' (no staged copy exists — fine, nothing to
 *                 protect), 'matching' (exists and matches the manifest
 *                 exactly), or 'damaged' (exists but does not match).
 *
 * | # | targetOk && linkOk | stagedState        | Action |
 * |---|---------------------|---------------------|--------|
 * | 1 | true                | absent or matching  | complete: delete the staged copy if present, clear the journal. |
 * | 2 | true                | damaged             | the live path is correct and complete — PRESERVE it untouched. Do NOT delete the damaged staging; QUARANTINE it to `<sourcePath>.tidy-quarantine-<journalId>` and record that path in the journal (`step: 'completed-partial-staging-quarantined'`). Nothing is deleted. |
 * | 3 | false               | matching            | restore: remove a bad/half symlink at sourcePath if present, rename the staged copy back to sourcePath, verify it matches the manifest, journal `step: 'failed'`. |
 * | 4 | false               | absent or damaged   | nothing verified good anywhere — DELETE NOTHING, RENAME NOTHING, leave every path exactly as found, journal `step: 'failed-both-copies-damaged'` with the per-check reasons. |
 *
 * Row 1 and row 3 never delete/restore a staged copy that's merely
 * "absent" — there's nothing there to act on. Row 2 exists specifically
 * so a live, correct, already-in-use path is never sacrificed just
 * because its backup has a problem. Row 4 exists specifically so that,
 * when there is genuinely nothing good anywhere, this function refuses to
 * guess — it touches nothing rather than pick a side.
 */

/**
 * The ONLY way anything in this file removes a path it believes is a
 * symlink it created. `rmSync(..., {recursive:true})` on an assumed
 * symlink is dangerous: if that assumption is wrong — the path is
 * actually a real directory someone else put there, or a symlink
 * pointing somewhere unexpected — a recursive remove can delete an
 * entire directory tree that was never ours to touch. This helper
 * verifies before it ever unlinks anything, and never recurses:
 *
 *   1. lstatSync(path) — if it doesn't exist, or isn't a symlink at all
 *      (a real file or directory sitting where we expected a symlink),
 *      REFUSE. Touch nothing.
 *   2. its realpath must resolve to exactly `expectedTargetPath`'s own
 *      realpath — a symlink pointing somewhere else (tampered, or a
 *      coincidentally-named path from something unrelated) is REFUSED,
 *      not unlinked.
 *   3. only then: `unlinkSync(path)` — never `rmSync`, never recursive.
 *      A single unlink can only ever remove the one symlink entry itself,
 *      never anything reachable through it.
 *
 * Callers treat a refusal as "left alone, reported" — never a reason to
 * fall back to a more aggressive removal.
 */
function unlinkOwnedSymlink(path, expectedTargetPath) {
  let lst;
  try {
    lst = lstatSync(path);
  } catch (e) {
    return { ok: false, reason: `expected an owned symlink at ${path}, but it does not exist (${e.code || e.message})` };
  }
  if (!lst.isSymbolicLink()) {
    const kind = lst.isDirectory() ? 'a directory' : lst.isFile() ? 'a regular file' : 'a non-symlink entry';
    return { ok: false, reason: `expected an owned symlink at ${path}, found ${kind} instead — refusing to touch it` };
  }
  let real;
  try {
    real = realpathSync(path);
  } catch (e) {
    return { ok: false, reason: `symlink at ${path} could not be resolved (${e.code || e.message}) — refusing to touch it` };
  }
  let expectedReal;
  try {
    expectedReal = realpathSync(expectedTargetPath);
  } catch (e) {
    return { ok: false, reason: `recorded target ${expectedTargetPath} could not be resolved (${e.code || e.message}) — refusing to touch ${path}` };
  }
  if (real !== expectedReal) {
    return { ok: false, reason: `symlink at ${path} resolves to ${real}, not the recorded target ${expectedTargetPath} — refusing to touch it` };
  }
  try {
    unlinkSync(path);
  } catch (e) {
    return { ok: false, reason: `unlink of verified symlink ${path} failed (${e.code || e.message})` };
  }
  return { ok: true };
}

function finalizeSwapOrRestore(journalDir, record, opts = {}) {
  const { sourcePath, stagedPath, linkPath, targetPath, manifest } = record;

  const targetOk = manifestExactMatch(targetPath, manifest);

  let sourceLstat = null;
  try {
    sourceLstat = lstatSync(sourcePath);
  } catch {
    sourceLstat = null;
  }
  const srcExists = !!sourceLstat;
  const srcIsSymlink = !!(sourceLstat && sourceLstat.isSymbolicLink());
  const linkExists = existsSync(linkPath);

  // Is there a verifiably-correct symlink representing this unit's live
  // path — already placed at sourcePath, or still pending (unconsumed) at
  // linkPath? Either counts as "the link is fine"; WHICH one it is
  // determines whether completing the pending rename is even on the
  // table below (it only ever happens as part of executing row 1 or row
  // 2 — never speculatively, and never for row 3 or row 4).
  let linkOk = false;
  let linkLocation = null; // 'source' | 'pending' | null
  if (srcIsSymlink) {
    try {
      if (realpathSync(sourcePath) === realpathSync(targetPath)) {
        linkOk = true;
        linkLocation = 'source';
      }
    } catch {
      linkOk = false;
    }
  } else if (!srcExists && linkExists) {
    try {
      if (lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(targetPath)) {
        linkOk = true;
        linkLocation = 'pending';
      }
    } catch {
      linkOk = false;
    }
  }

  const stagedState = !existsSync(stagedPath)
    ? 'absent'
    : (manifestExactMatch(stagedPath, manifest) ? 'matching' : 'damaged');

  // Row 1: live path correct, and there's either nothing staged to worry
  // about or it matches too — complete normally. Only HERE does a
  // pending rename actually get completed.
  if (targetOk && linkOk && stagedState !== 'damaged') {
    if (linkLocation === 'pending') renameSync(linkPath, sourcePath);
    if (stagedState === 'matching') rmSync(stagedPath, { recursive: true });
    removeJournalRecord(journalDir, sourcePath);
    return { ok: true, row: 1 };
  }

  // Row 2: live path correct and complete, but the backup is damaged.
  // Preserve the live path exactly as-is (completing the pending rename
  // if needed, since the target+link half of this unit is fully
  // verified); never delete the damaged backup silently — quarantine it.
  if (targetOk && linkOk && stagedState === 'damaged') {
    if (linkLocation === 'pending') renameSync(linkPath, sourcePath);
    const quarantinePath = `${sourcePath}${QUARANTINE_SUFFIX_PREFIX}${journalKey(sourcePath)}`;
    const reason = 'the staged original was damaged (partial or corrupted content) but the live target and symlink are complete and correct; the live path was left untouched and the damaged staged copy was quarantined rather than deleted or silently trusted';
    renameSync(stagedPath, quarantinePath);
    const { durabilityNote } = writeJournalRecordSync(journalDir, { ...record, step: 'completed-partial-staging-quarantined', quarantinePath }, opts);
    return { ok: true, row: 2, quarantined: true, quarantinePath, reason, durabilityNotes: durabilityNote ? [durabilityNote] : [] };
  }

  const reasons = [];
  if (!targetOk) reasons.push('target content does not match the journaled manifest exactly (missing, extra, or corrupted files)');
  if (!linkOk) reasons.push('source is not a symlink whose realpath resolves exactly to the recorded target path');

  // Row 3: live path has a problem, but the staged original is intact —
  // restore from it. Clears away a bad symlink wherever it currently
  // sits (already at sourcePath, or still pending at linkPath) — but ONLY
  // via unlinkOwnedSymlink's verify-then-unlink, never a recursive
  // remove on an assumed symlink. If that verification refuses (the path
  // isn't actually a symlink, or resolves somewhere unexpected), row 3
  // itself refuses too: touch nothing further, report, journal 'failed'.
  if (stagedState === 'matching') {
    const reason = reasons.join('; ');

    let obstaclePath = null;
    if (srcIsSymlink) obstaclePath = sourcePath;
    else if (!srcExists && linkExists) obstaclePath = linkPath;
    // else: sourcePath holds something that's neither a verifiable
    // symlink nor absent-with-a-pending-link — nothing to clear first.

    if (obstaclePath) {
      const unlinkResult = unlinkOwnedSymlink(obstaclePath, targetPath);
      if (!unlinkResult.ok) {
        const combinedReason = `${reason}; additionally, could not safely clear the way for restore: ${unlinkResult.reason}`;
        try {
          writeJournalRecordSync(journalDir, { ...record, step: 'failed', failureReason: combinedReason }, opts);
        } catch {
          // best effort
        }
        return { ok: false, row: 3, reason: combinedReason, restored: false, refusedUnlink: true };
      }
    }

    let restored = false;
    if (!existsSync(sourcePath)) {
      try {
        renameSync(stagedPath, sourcePath);
        restored = manifestExactMatch(sourcePath, manifest);
      } catch {
        restored = false;
      }
    }
    // else: sourcePath still holds something unexpected (removal above
    // didn't apply) — leave both paths for manual inspection rather than
    // guess which is authoritative.
    try {
      writeJournalRecordSync(journalDir, { ...record, step: 'failed', failureReason: reason }, opts);
    } catch {
      // best effort — the reason is still returned to the caller either way
    }
    return { ok: false, row: 3, reason, restored };
  }

  // Row 4: nothing verified good anywhere (live path has a problem AND
  // the backup is absent or also damaged). DELETE NOTHING, RENAME
  // NOTHING — sourcePath, stagedPath, and linkPath are all left exactly
  // as found, including a still-pending, uncompleted rename. Report
  // loudly with every path so a human can recover by hand.
  reasons.push(stagedState === 'absent'
    ? 'no staged original exists to fall back on'
    : 'the staged original itself no longer matches the journaled manifest exactly');
  const reason = reasons.join('; ');
  try {
    writeJournalRecordSync(journalDir, { ...record, step: 'failed-both-copies-damaged', failureReason: reason }, opts);
  } catch {
    // best effort
  }
  return {
    ok: false,
    row: 4,
    reason,
    restored: false,
    untouched: true,
    paths: { sourcePath, stagedPath, linkPath, targetPath }
  };
}

/**
 * Swap one source directory for a symlink to its already-verified copy.
 *
 * A plain "delete then symlink" (or even "rename then symlink") has a
 * window where a hard crash (SIGKILL, power loss, OOM kill) — which a
 * try/catch cannot intercept, unlike a thrown JS exception — leaves NEITHER
 * the original NOR a symlink at `src`. To close that, the symlink is built
 * and verified at a side path BEFORE `src` is touched at all, and every
 * step (including this one) is journaled to `opts.journalDir` — fsynced —
 * BEFORE the step's filesystem mutation happens, so recovery always knows
 * the furthest point actually reached:
 *
 *   'pending' written -> symlink(dst, src+LINK_SUFFIX); verify it resolves
 *       [src untouched so far — a crash here leaves src exactly as it was]
 *   'linked'  written -> rename(src, src+STAGING_SUFFIX)        [atomic]
 *       [a crash here leaves the original at STAGING_SUFFIX, recoverable]
 *   'staged'  written -> rename(src+LINK_SUFFIX, src)           [atomic]
 *       [THE GAP: for this instant, neither a real directory nor a symlink
 *        exists at src — see the module docstring. A crash here needs
 *        recovery to finish this exact rename from the journal.]
 *   'swapped' written -> verify src resolves to dst again, remove staging
 *       [a crash here leaves a working symlink at src already — the only
 *        thing left undone is freeing the disk space, which recovery does]
 *   journal record removed once cleanup succeeds.
 *
 * This function itself does NOT roll back on a thrown (catchable) failure
 * — recovery is deliberately a separate, explicit, journal-validated step
 * (recoverInterruptedMoves, run via the `recover` subcommand or at the
 * start of `apply`), not an automatic side effect of error handling, so a
 * hard kill and a thrown exception are recovered the exact same way.
 */
function swapToSymlink(src, dst, opts = {}) {
  const doSymlink = opts.symlinkSync || symlinkSync;
  const staging = src + STAGING_SUFFIX;
  const link = src + LINK_SUFFIX;
  const journalDir = opts.journalDir;
  const journalOpts = { fsyncSync: opts.journalFsyncSync, renameSync: opts.journalRenameSync, platform: opts.platform };
  const durabilityNotes = [];
  function journalWrite(rec) {
    // GAP 2 (round 6): a failure here — temp-file fsync, rename into
    // place, or (on Linux) directory fsync — THROWS, which this function
    // does not catch, so it propagates to the caller and aborts the whole
    // unit before whatever mutation this write was meant to guard. Never
    // silently swallowed.
    const { durabilityNote } = writeJournalRecordSync(journalDir, rec, journalOpts);
    if (durabilityNote) durabilityNotes.push(durabilityNote);
  }

  if (existsSync(staging) || existsSync(link)) {
    throw new Error(`refusing to touch ${src}: a leftover ${existsSync(staging) ? staging : link} already exists from a previous run — run the 'recover' subcommand first`);
  }

  const manifest = computeManifest(src);
  const base = { sourcePath: src, stagedPath: staging, linkPath: link, targetPath: dst, manifest };

  journalWrite({ ...base, step: 'pending' }); // BEFORE any mutation — a failure here aborts with the source completely untouched
  if (opts.beforeLink) opts.beforeLink(); // test-only hook: simulate a crash here

  doSymlink(dst, link);
  let preSwapVerified = false;
  try {
    preSwapVerified = lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(dst);
  } catch {
    preSwapVerified = false;
  }
  if (!preSwapVerified) {
    // Clear the bad/half artifact at `link` — but only via the same
    // verify-then-unlink guard every other removal in this file uses, in
    // case `doSymlink` didn't actually create a symlink at all (e.g. a
    // real directory ended up there instead): never rmSync/recursive on
    // an assumption.
    const unlinkResult = unlinkOwnedSymlink(link, dst);
    if (unlinkResult.ok) {
      removeJournalRecord(journalDir, src);
      throw new Error(`pre-swap symlink verification failed for ${link}`);
    }
    const reason = `pre-swap symlink verification failed for ${link}, and it could not be safely removed: ${unlinkResult.reason}`;
    try {
      journalWrite({ ...base, step: 'failed', failureReason: reason });
    } catch {
      // best effort — the reason is still thrown below either way
    }
    throw new Error(reason);
  }
  journalWrite({ ...base, step: 'linked' }); // still before the first source mutation (the rename below)
  if (opts.afterLink) opts.afterLink(); // test-only hook: simulate a crash here

  renameSync(src, staging);
  journalWrite({ ...base, step: 'staged' });
  if (opts.afterStage) opts.afterStage(); // test-only hook: simulate a crash IN THE GAP between the two renames

  renameSync(link, src);
  journalWrite({ ...base, step: 'swapped' });
  if (opts.afterSwap) opts.afterSwap(); // test-only hook: simulate a crash here

  // The ONLY place a staged original is deleted, in this run or later via
  // recovery — see finalizeSwapOrRestore's docstring for the three checks.
  // "The link resolves to something" is deliberately not one of them.
  const result = finalizeSwapOrRestore(journalDir, base, journalOpts);
  if (!result.ok) {
    const outcome = result.row === 4
      ? 'left every path exactly as found (nothing verified good anywhere)'
      : `restored the staged original to ${src}`;
    throw new Error(`post-swap finalize refused to delete the staged original and ${outcome}: ${result.reason}`);
  }
  return { ...result, durabilityNotes: [...durabilityNotes, ...(result.durabilityNotes || [])] };
  // row 1: plain success. row 2: success, but carries {quarantined:true, quarantinePath, reason}.
}

/** Every location discoverCandidates() looks at, reused so detection and
 * recovery scan for stray *.tidy-moving/*.tidy-link siblings in exactly
 * the same places. */
function candidateParentDirs(home) {
  const dirs = new Set();
  const hfHub = join(home, '.cache', 'huggingface', 'hub');
  if (existsSync(hfHub)) dirs.add(hfHub);
  const modelsDir = join(home, 'models');
  if (existsSync(modelsDir)) dirs.add(modelsDir);
  dirs.add(home);
  for (const entry of safeReaddir(home)) {
    if (entry.startsWith('.')) continue;
    const full = join(home, entry);
    try {
      if (lstatSync(full).isDirectory()) dirs.add(full);
    } catch {
      // vanished between readdir and lstat — ignore
    }
  }
  return [...dirs];
}

function strayJournalSuffixedPaths(home, excludePaths) {
  const strays = [];
  for (const dir of candidateParentDirs(home)) {
    for (const name of safeReaddir(dir)) {
      if (!isJournalSuffixed(name)) continue;
      let src;
      if (name.includes(QUARANTINE_SUFFIX_PREFIX)) {
        // A quarantine dir represents itself (not some other "base" name
        // with a suffix stripped) — it's excluded by its own full path,
        // which is what a journal record's `quarantinePath` field holds.
        src = join(dir, name);
      } else {
        const base = name.endsWith(STAGING_SUFFIX) ? name.slice(0, -STAGING_SUFFIX.length) : name.slice(0, -LINK_SUFFIX.length);
        src = join(dir, base);
      }
      if (excludePaths.has(src)) continue;
      strays.push({ path: src, entryPath: join(dir, name) });
    }
  }
  return strays;
}

/**
 * READ-ONLY detection of interrupted `apply` swaps, for `plan`. Never
 * mutates anything. For every journal record found under
 * `home/.cache/ide-agent-kit/model-tidy-journal`, reports the step reached
 * and a human-readable description of the on-disk state, WITHOUT touching
 * it. Also reports (but never touches) any `*.tidy-moving` / `*.tidy-link`
 * sibling that has no matching journal record at all — those are not this
 * tool's to interpret; only recoverInterruptedMoves() (a separate, explicit,
 * mutating step) acts on journaled units, and only after validating them.
 */
export function detectInterruptedMoves(home, options = {}) {
  const journalDir = options.journalDir || defaultJournalDir(home);
  const findings = [];
  const journaledPaths = new Set();

  for (const { file, record, corrupt, reason } of listJournalRecords(journalDir)) {
    if (corrupt || !record) {
      findings.push({ path: null, journalFile: file, status: 'journal-unreadable', note: `journal file ${file} is unreadable: ${reason || 'unknown reason'} — the unit it may describe is left alone until this is resolved` });
      continue;
    }
    journaledPaths.add(record.sourcePath);
    if (record.quarantinePath) journaledPaths.add(record.quarantinePath);
    const srcExists = existsSync(record.sourcePath);
    let srcIsSymlink = false;
    try {
      srcIsSymlink = lstatSync(record.sourcePath).isSymbolicLink();
    } catch {
      // does not exist — srcIsSymlink stays false
    }
    const stagedExists = existsSync(record.stagedPath);
    const linkExists = existsSync(record.linkPath);
    findings.push({
      path: record.sourcePath,
      journalFile: file,
      step: record.step,
      status: 'interrupted',
      note: `journal step '${record.step}' — source ${srcExists ? (srcIsSymlink ? 'exists as a symlink' : 'exists as a real directory') : 'missing'}, ` +
        `staged copy ${stagedExists ? 'present' : 'absent'}, pending link ${linkExists ? 'present' : 'absent'}. Run the 'recover' subcommand to resolve.`
    });
  }

  for (const stray of strayJournalSuffixedPaths(home, journaledPaths)) {
    findings.push({
      path: stray.path,
      journalFile: null,
      status: 'orphan-no-journal',
      note: `found ${stray.entryPath} with no matching journal record — not this tool's to interpret, left alone`
    });
  }

  return findings;
}

/**
 * MUTATING recovery for interrupted `apply` swaps. Only runs from the
 * explicit `recover` subcommand, or at the very start of `apply` (i.e.
 * only when `--apply` was actually given — `plan` never calls this).
 *
 * Acts ONLY on units that have a journal record — a directory merely
 * *named* `*.tidy-moving` or `*.tidy-link` with no journal entry is never
 * touched, regardless of how it looks. For a journaled unit, validates
 * that whatever currently exists on disk (the source as a real directory,
 * and/or the staged copy) matches the journal's recorded manifest before
 * trusting the record enough to act; a mismatch is reported and left
 * alone rather than guessed at.
 */
export function recoverInterruptedMoves(home, options = {}) {
  const journalDir = options.journalDir || defaultJournalDir(home);
  const journalOpts = { fsyncSync: options.journalFsyncSync, renameSync: options.journalRenameSync, platform: options.platform };
  const recovered = [];
  const journaledPaths = new Set();

  for (const { file, record, corrupt, reason: unreadableReason } of listJournalRecords(journalDir)) {
    if (corrupt || !record) {
      recovered.push({ path: null, journalFile: file, action: 'left-alone', note: `journal file ${file} is unreadable: ${unreadableReason || 'unknown reason'} — left alone, never acted on` });
      continue;
    }
    const { sourcePath, stagedPath, linkPath, targetPath, manifest, step } = record;
    journaledPaths.add(sourcePath);
    if (record.quarantinePath) journaledPaths.add(record.quarantinePath);

    try {
      const srcExists = existsSync(sourcePath);
      let srcIsSymlink = false;
      try {
        srcIsSymlink = lstatSync(sourcePath).isSymbolicLink();
      } catch {
        // missing — srcIsSymlink stays false
      }
      const stagedExists = existsSync(stagedPath);
      const linkExists = existsSync(linkPath);

      // A symlink is either already in place, or one verified rename away
      // from being in place: the ONLY safe way to decide anything here —
      // including whether it's even safe to COMPLETE that pending rename
      // — is finalizeSwapOrRestore's own decision table (target manifest,
      // symlink realpath, staged manifest, all re-checked now). It is
      // NOT safe to complete the rename speculatively before that
      // decision: row 4 (nothing verified good anywhere) must rename
      // NOTHING, so finalizeSwapOrRestore performs the pending rename
      // itself, only inside the row-1/row-2 branches that decide it's
      // warranted.
      if ((srcExists && srcIsSymlink) || (!srcExists && stagedExists && linkExists)) {
        const result = finalizeSwapOrRestore(journalDir, record, journalOpts);
        if (result.ok && result.quarantined) {
          // Row 2: live path is correct and complete — preserved,
          // untouched. The damaged backup was quarantined, not deleted.
          // The journal record was just rewritten with this quarantine
          // path, so exclude it from the stray scan below too.
          journaledPaths.add(result.quarantinePath);
          recovered.push({
            path: sourcePath,
            journalFile: file,
            action: 'completed-partial-staging-quarantined',
            note: `${result.reason} (quarantined at ${result.quarantinePath})`
          });
        } else if (result.ok) {
          // Row 1.
          recovered.push({ path: sourcePath, journalFile: file, action: 'completed-swap-and-cleaned', note: 'completed the pending symlink swap (or finished cleanup of one already in place) and removed the staged original — target and symlink both re-verified against the journal manifest first' });
        } else if (result.row === 4) {
          // Row 4: nothing verified good anywhere — touched nothing.
          recovered.push({
            path: sourcePath,
            journalFile: file,
            action: 'left-alone-nothing-verified-good',
            note: `${result.reason} — every path left exactly as found (source: ${result.paths.sourcePath}, staged: ${result.paths.stagedPath}, target: ${result.paths.targetPath}); recover by hand`
          });
        } else {
          // Row 3.
          recovered.push({
            path: sourcePath,
            journalFile: file,
            action: result.restored ? 'restored-after-failed-verification' : 'left-alone-after-failed-verification',
            note: `refused to delete the staged original (${result.reason}); ${result.restored ? 'restored the original to the source path' : 'left current state for manual inspection'} and marked the journal record failed`
          });
        }
        continue;
      }

      // Below here, no symlink has ever been placed at sourcePath — the
      // delete-the-staged-original decision never applies, so the plainer
      // manifest checks are enough.
      const stagedOk = !stagedExists || verifyManifest(stagedPath, manifest);
      const srcOk = !srcExists || verifyManifest(sourcePath, manifest);
      if (!stagedOk || !srcOk) {
        recovered.push({ path: sourcePath, journalFile: file, action: 'left-alone', note: `on-disk content (step recorded as '${step}') does not match the journaled manifest; left alone for manual inspection` });
        continue;
      }

      if (!srcExists && stagedExists && !linkExists) {
        renameSync(stagedPath, sourcePath);
        removeJournalRecord(journalDir, sourcePath);
        recovered.push({ path: sourcePath, journalFile: file, action: 'restored-original', note: 'restored the original directory (no verified pending symlink existed to trust instead)' });
      } else if (srcExists && !srcIsSymlink && linkExists && !stagedExists) {
        const unlinkResult = unlinkOwnedSymlink(linkPath, targetPath);
        if (!unlinkResult.ok) {
          try {
            writeJournalRecordSync(journalDir, { ...record, step: 'failed', failureReason: unlinkResult.reason });
          } catch {
            // best effort
          }
          recovered.push({ path: sourcePath, journalFile: file, action: 'left-alone', note: `refused to remove the pending link (${unlinkResult.reason}); the original itself was never touched` });
          continue;
        }
        removeJournalRecord(journalDir, sourcePath);
        recovered.push({ path: sourcePath, journalFile: file, action: 'removed-stray-link', note: 'the original was never touched; removed the unused pending symlink' });
      } else if (srcExists && !srcIsSymlink && !linkExists && !stagedExists) {
        removeJournalRecord(journalDir, sourcePath);
        recovered.push({ path: sourcePath, journalFile: file, action: 'removed-stale-journal', note: 'the original was never touched; cleared the journal record' });
      } else {
        recovered.push({ path: sourcePath, journalFile: file, action: 'left-alone', note: `unrecognized on-disk state for a journaled unit (step='${step}'); left alone for manual inspection` });
      }
    } catch (e) {
      recovered.push({ path: sourcePath, journalFile: file, action: 'error', note: `recovery failed: ${e.message}` });
    }
  }

  for (const stray of strayJournalSuffixedPaths(home, journaledPaths)) {
    recovered.push({
      path: stray.path,
      journalFile: null,
      action: 'left-alone',
      note: `found ${stray.entryPath} with no matching journal record — not this tool's to touch`
    });
  }

  return recovered;
}

/**
 * Apply a plan: move every selected unit to `target`, unit by unit. Each
 * unit is copied, verified, and only THEN is its source directory swapped
 * for a symlink via swapToSymlink()'s journaled sequence (see its
 * docstring). A failure at copy or verify leaves the source fully in
 * place, untouched. Once the swap itself starts, the original data is
 * preserved and recoverable at every step; the original path is
 * unavailable for the instant between the two renames, and until recovery
 * runs if a crash lands there — it is not continuously available. One
 * unit's failure does not roll back units that already succeeded earlier
 * in the same run; the process still exits non-zero overall.
 *
 * Recovery (recoverInterruptedMoves) runs once, here, at the very start —
 * i.e. only when `--apply` was actually given. `planRun` never calls it;
 * `plan` only detects and reports interrupted state (detectInterruptedMoves)
 * without mutating anything.
 */
export function applyRun(options) {
  const { plan, target, home } = options;
  const copyFn = options.copyFn || copyUnitPureNode;
  const verifyFn = options.verifyFn || verifyUnit;
  const validateTargetFn = options.validateTarget || validateTarget;
  const symlinkFn = options.symlinkFn; // test-only injection; real default is symlinkSync inside swapToSymlink
  const recoverFn = options.recover || recoverInterruptedMoves;
  const journalDir = options.journalDir || defaultJournalDir(home);
  // GAP 2 (round 6) test-only injection points: the real journal fsync,
  // the real journal rename, and process.platform, all overridable so
  // tests can exercise the Linux-vs-other-platform durability rule
  // without branching on the real platform inside the test itself.
  const journalFsyncSync = options.journalFsyncSync;
  const journalRenameSync = options.journalRenameSync;
  const journalPlatform = options.platform;

  // GAP (round 8): this preflight MUST run before recoverFn below, not
  // after. Recovery is itself a mutation (it promotes valid interrupted
  // units to symlinks and deletes their staged originals), and the whole
  // point of this check is a GLOBAL refusal to mutate anything at all
  // while any journal file's content can't be trusted — including units
  // that recovery would otherwise have happily fixed. Running it after
  // recovery meant apply could report "unresolved journal state, refusing"
  // while having already mutated a perfectly valid unit moments earlier.
  // recoverInterruptedMoves never touches an unreadable/corrupt record
  // either way (it always reports and leaves those alone), so the set of
  // unreadable files this check sees is identical whether it runs before
  // or after recovery — only WHEN it's allowed to act differs.
  const preflightUnreadable = listJournalRecords(journalDir).filter(r => r.corrupt || !r.record);
  if (preflightUnreadable.length > 0) {
    const files = preflightUnreadable.map(r => r.file);
    const reason = `unresolved journal state: ${files.join(', ')}; run recover, or resolve by hand`;
    return { ok: false, error: reason, moved: [], errors: [{ error: reason }], recovered: [] };
  }

  // Self-heal any interrupted swap from a previous crash before this run's
  // own pre-checks and copy/verify/swap loop — see recoverInterruptedMoves.
  // Only reached here, in apply, never from planRun. Only reached at all
  // once the preflight above confirms every journal file is trustworthy.
  const recovered = recoverFn(home, { journalDir, journalFsyncSync, journalRenameSync, platform: journalPlatform });

  const validation = validateTargetFn(target, home);
  if (!validation.ok) {
    return { ok: false, error: validation.error, moved: [], errors: [{ error: validation.error }], recovered };
  }

  const byGroup = new Map();
  for (const r of plan.selected) {
    if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, []);
    byGroup.get(r.groupId).push(r);
  }

  const moved = [];
  const errors = [];
  const durabilityNotes = []; // any 'durability degraded: <code>' notes from journal writes during this run

  for (const [groupId, members] of byGroup) {
    const sourceAbsPaths = members.map(m => m.path);

    const leftover = sourceAbsPaths.filter(src => existsSync(src + STAGING_SUFFIX) || existsSync(src + LINK_SUFFIX));
    if (leftover.length > 0) {
      errors.push({
        groupId,
        paths: sourceAbsPaths,
        step: 'pre-check',
        error: `refusing: a leftover from a previous run still exists for ${leftover.join(', ')} — run the 'recover' subcommand first`
      });
      continue;
    }

    try {
      copyFn(sourceAbsPaths, home, target);
    } catch (e) {
      errors.push({ groupId, paths: sourceAbsPaths, step: 'copy', error: e.message });
      continue;
    }

    const verification = verifyFn(sourceAbsPaths, home, target);
    if (!verification.ok) {
      errors.push({ groupId, paths: sourceAbsPaths, step: 'verify', error: 'checksum/size verification failed', mismatches: verification.mismatches });
      continue; // source untouched — verification failed BEFORE any deletion
    }

    // Verification passed for the whole unit: safe to swap every member.
    let swapFailed = null;
    const swapped = [];
    for (const src of sourceAbsPaths) {
      const rel = relative(home, src);
      const dst = join(target, rel);
      try {
        const finalizeResult = swapToSymlink(src, dst, {
          symlinkSync: symlinkFn,
          journalDir,
          journalFsyncSync,
          journalRenameSync,
          platform: journalPlatform,
          beforeLink: options.beforeLink,
          afterLink: options.afterLink,
          afterStage: options.afterStage,
          afterSwap: options.afterSwap
        });
        const entry = { source: src, target: dst };
        if (finalizeResult && finalizeResult.quarantined) {
          entry.quarantined = true;
          entry.quarantinePath = finalizeResult.quarantinePath;
          entry.note = finalizeResult.reason;
        }
        if (finalizeResult && finalizeResult.durabilityNotes && finalizeResult.durabilityNotes.length > 0) {
          entry.durabilityNotes = finalizeResult.durabilityNotes;
          durabilityNotes.push(...finalizeResult.durabilityNotes);
        }
        swapped.push(entry);
      } catch (e) {
        swapFailed = { path: src, error: e.message };
        break;
      }
    }
    if (swapFailed) {
      errors.push({ groupId, paths: sourceAbsPaths, step: 'swap', error: swapFailed.error, partiallySwapped: swapped });
    } else {
      moved.push({ groupId, members: swapped, sizeBytes: members[0].groupSizeBytes });
    }
  }

  return { ok: errors.length === 0, moved, errors, recovered, durabilityNotes };
}

// ---------------------------------------------------------------------------
// JSON run log
// ---------------------------------------------------------------------------

export function writeRunLog(logDir, record) {
  mkdirSync(logDir, { recursive: true });
  const line = JSON.stringify(record) + '\n';
  const file = join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(file, line);
  return file;
}
