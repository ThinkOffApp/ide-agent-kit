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
  statSync, appendFileSync, constants as FS_CONSTANTS, accessSync, renameSync
} from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
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
        results.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
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
      if (entry.startsWith('models--')) {
        add(join(hfHub, entry), 'hf-cache');
      }
    }
  }

  const modelsDir = join(home, 'models');
  if (existsSync(modelsDir)) {
    for (const entry of safeReaddir(modelsDir)) {
      add(join(modelsDir, entry), 'models-dir');
    }
  }

  for (const entry of safeReaddir(home)) {
    if (entry.startsWith('.')) continue;
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
  const unreadablePids = [];
  for (const pid of pids) {
    let fdOk = true;
    try {
      const fdDir = join(procRoot, pid, 'fd');
      let fds;
      try {
        fds = readdirSync(fdDir);
      } catch (e) {
        // ENOENT here means the process exited between the pid listing and
        // this read — a benign race, not a verification failure. Anything
        // else (EACCES/EPERM, or an unexpected error) means we genuinely
        // could not check this pid's open files.
        if (e.code !== 'ENOENT') fdOk = false;
        fds = [];
      }
      for (const fd of fds) {
        try {
          const target = realpathSync(join(fdDir, fd));
          if (target === path || target.startsWith(path + sep)) {
            users.push({ pid, via: 'fd', target });
            break;
          }
        } catch {
          // this one fd vanished mid-scan (ENOENT) — not a verification failure
        }
      }
    } catch {
      fdOk = false;
    }

    let cmdlineOk = true;
    try {
      const cmdline = readFileSync(join(procRoot, pid, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
      if (cmdline && cmdline.includes(path)) {
        const lower = cmdline.toLowerCase();
        const servingProcess = SERVING_PROCESS_NAMES.some(n => lower.includes(n));
        users.push({ pid, via: 'cmdline', cmdline: cmdline.slice(0, 200), servingProcess });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') cmdlineOk = false;
    }

    if (!fdOk || !cmdlineOk) unreadablePids.push(pid);
  }

  if (unreadablePids.length > 0) {
    const shown = unreadablePids.slice(0, 5).join(', ');
    const more = unreadablePids.length > 5 ? `, +${unreadablePids.length - 5} more` : '';
    return {
      checked: false,
      users,
      note: `could not read /proc for pid(s) ${shown}${more} (permission denied) — cannot rule out those processes using this path`
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

  for (const c of candidates) {
    const files = walkFiles(c.path);
    filesByCandidate.set(c.id, files);
    for (const f of files) {
      const key = `${f.dev}:${f.ino}`;
      if (!inodeMap.has(key)) inodeMap.set(key, new Set());
      inodeMap.get(key).add(c.id);
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

  return { groupOf: id => find(id), groupMembers, groupSizeBytes, filesByCandidate };
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

  const rawCandidates = options.candidates || discoverCandidates(home);
  const { groupOf, groupMembers, groupSizeBytes, filesByCandidate } = computeHardlinkGroups(rawCandidates);

  const perCandidate = new Map();
  for (const c of rawCandidates) {
    let skipReason = null;

    if (matchesKeepList(c.path, keepEntries)) {
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

  const summaryLine = `model-tidy plan: ${selected.length} dir(s) in ${selectedGroupIds.size} unit(s), ` +
    `${(totalSelectedBytes / 2 ** 30).toFixed(1)} GiB movable to target, ${skipped.length} skipped ` +
    `(${unverifiedCount} unverified). ${freeLine}`;

  return {
    home,
    minIdleDays,
    maxGb,
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

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
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

/**
 * Swap one source directory for a symlink to its already-verified copy,
 * crash-safely:
 *
 *   rename(src, src + STAGING_SUFFIX)   [atomic, same filesystem]
 *   symlink(dst, src)
 *   verify src resolves to dst
 *   remove src + STAGING_SUFFIX
 *
 * A same-filesystem rename is atomic, so a crash at any point leaves EITHER
 * the original directory in place (still at its staging name, never lost)
 * OR a working symlink to the verified copy — never neither. If anything
 * after the rename fails, this function removes the half-made symlink (if
 * any) and renames the staging directory back to `src` before returning, so
 * the caller sees `src` exactly as it was on entry.
 */
function swapToSymlink(src, dst, opts = {}) {
  const doSymlink = opts.symlinkSync || symlinkSync;
  const staging = src + STAGING_SUFFIX;
  if (existsSync(staging)) {
    throw new Error(`refusing to touch ${src}: a leftover ${staging} from a previous interrupted apply already exists — resolve it manually (verify which of ${src}/${staging} is intact, then remove the other) before retrying`);
  }
  renameSync(src, staging);
  try {
    doSymlink(dst, src);
    const real = realpathSync(src);
    if (real !== realpathSync(dst) || !lstatSync(src).isSymbolicLink()) {
      throw new Error(`post-symlink verification failed for ${src}`);
    }
    rmSync(staging, { recursive: true });
  } catch (e) {
    // Roll back: remove any half-made symlink, then restore the original
    // from staging so the caller finds `src` exactly as it was.
    try {
      if (lstatSync(src).isSymbolicLink()) rmSync(src);
    } catch {
      // src may not exist at all if symlinkSync itself never ran — fine.
    }
    renameSync(staging, src);
    throw e;
  }
}

/**
 * Apply a plan: move every selected unit to `target`, unit by unit. Each
 * unit is copied, verified, and only THEN is its source directory swapped
 * for a symlink via swapToSymlink()'s rename/symlink/verify/cleanup
 * sequence. A failure at ANY step — copy, verify, or swap — leaves that
 * unit's source EITHER fully in place (copy/verify failures never touch
 * the source) OR replaced by a working symlink to a verified copy (a swap
 * failure rolls back to the original). There is no state in between. One
 * unit's failure does not roll back units that already succeeded earlier
 * in the same run; the process still exits non-zero overall.
 */
export function applyRun(options) {
  const { plan, target, home } = options;
  const copyFn = options.copyFn || copyUnitPureNode;
  const verifyFn = options.verifyFn || verifyUnit;
  const validateTargetFn = options.validateTarget || validateTarget;
  const symlinkFn = options.symlinkFn; // test-only injection; real default is symlinkSync inside swapToSymlink

  const validation = validateTargetFn(target, home);
  if (!validation.ok) {
    return { ok: false, error: validation.error, moved: [], errors: [{ error: validation.error }] };
  }

  const byGroup = new Map();
  for (const r of plan.selected) {
    if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, []);
    byGroup.get(r.groupId).push(r);
  }

  const moved = [];
  const errors = [];

  for (const [groupId, members] of byGroup) {
    const sourceAbsPaths = members.map(m => m.path);

    const leftoverStaging = sourceAbsPaths.filter(src => existsSync(src + STAGING_SUFFIX));
    if (leftoverStaging.length > 0) {
      errors.push({
        groupId,
        paths: sourceAbsPaths,
        step: 'pre-check',
        error: `refusing: ${leftoverStaging.map(p => `${p}${STAGING_SUFFIX}`).join(', ')} left over from a previous interrupted apply — resolve manually before retrying this unit`
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
        swapToSymlink(src, dst, { symlinkSync: symlinkFn });
        swapped.push({ source: src, target: dst });
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

  return { ok: errors.length === 0, moved, errors };
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
