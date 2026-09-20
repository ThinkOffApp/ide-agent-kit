// SPDX-License-Identifier: AGPL-3.0

/**
 * "Available and fits" - the second-strongest claim a device card can make
 * about a model, and the first one this fleet could not previously express.
 *
 * THE CLAIMS, IN DECREASING ORDER OF PROOF
 *
 *   SERVED         a live /v1/models listing names it. served-model.js does
 *                  this, and it is the only claim that means "you can send it
 *                  a request right now".
 *   FITS_NOW       the bytes are on this disk, all of them, and the weights
 *                  plus a KV reserve fit in the memory that is ACTUALLY
 *                  AVAILABLE on this box right now. Nothing has to be
 *                  stopped. THIS is "available and fits".
 *   FITS_IF_FREED  complete on disk, inside the box's total budget, but NOT
 *                  alongside what is resident right now. A weaker claim, and
 *                  it is only honest because it names the cost: how many GB
 *                  have to come back, and what is holding them.
 *   MANUAL         a human typed the name into INTENT_DEVICE_MODEL. Proven by
 *                  nothing, and it must never render as any of the above.
 *
 * They are ranked, not blended: `rank()` returns exactly one state per model
 * per box, SERVED always beats every disk-derived state for the same box, and
 * a name that is only a setting stays MANUAL no matter how plausible it looks.
 *
 * WHY "FITS" IS TWO STATES AND NOT A BOOLEAN. Comparing a model against the
 * machine's TOTAL budget silently assumes the operator will quit whatever else
 * is running. Measured here on 20 Sep 2026: a 107.5 GiB Metal budget with
 * 49.9 GiB resident, 45.9 GiB actually available, and a 75.3 GiB model. That
 * model fits the BOX and does not fit TODAY, and collapsing those two into one
 * green chip is the same class of overclaim as publishing a typed-in model
 * name as loaded - which is the exact defect this feature exists to prevent.
 * A state that means "fits if freed" but renders as "fits" is a bug.
 *
 * WHAT COUNTS AS AVAILABLE, AND WHY RECLAIMABLE CACHE DOES
 *
 * The live figure is AVAILABLE memory, never free memory, for the reason
 * host-telemetry.js gives: free pages exclude the cache the OS hands back on
 * demand, so a machine with plenty reads as 95% used. Nothing in this file
 * reads free memory on its own.
 *
 * Which instrument says so is platform-specific and was checked rather than
 * assumed. Linux's `MemAvailable` means exactly this, so Linux reuses
 * host-telemetry's `availableMemBytes` unchanged. macOS's side of that
 * accessor is `memory_pressure`, and it does NOT mean this: measured here, it
 * reported 86% free on a box with 34.8 GB of active pages and a 17.2 GiB VM
 * resident, because it counts running applications as free. Taking it would
 * make FITS_NOW true for anything that fits the box at all - a fit state that
 * cannot come out negative, which is not a check. So darwin reads `vm_stat`'s
 * reclaimable counters by name instead (see parseVmStatAvailable).
 *
 * So clean file cache and other reclaimable pages DO count toward FITS_NOW:
 * the kernel returns them without a human doing anything, so counting them
 * assumes no operator behaviour at all. A resident VM does NOT count - the
 * 17.2 GiB colima VM on this MacBook comes back only if somebody stops it,
 * and assuming that is precisely the "some apps can be put on pause" overclaim
 * being removed here. That is the whole line: reclaimable-by-the-kernel is
 * available; reclaimable-by-a-human is a shortfall with a price tag on it.
 *
 * THE OMIT-NOT-FAKE CONTRACT CARRIES OVER from served-model.js. Every failure
 * resolves to a state that is NOT a positive fit claim, with no default, no
 * last-known-good and no optimistic guess:
 *
 *   budget unmeasurable   -> BUDGET_UNKNOWN, never "fits". An unmeasurable
 *                            must never become a positive claim. This is the
 *                            single most important rule in the file.
 *   headroom unmeasurable -> HEADROOM_UNKNOWN. We know it fits the box; we do
 *                            NOT therefore know it fits right now, and we do
 *                            not get to assert the negative either.
 *   download in flight    -> INCOMPLETE, until every shard is on disk. A
 *                            half-downloaded model reporting "available and
 *                            fits" is the exact defect this feature prevents.
 *   weights too big       -> TOO_LARGE. Still worth showing: the operator
 *                            learns the box has the bytes and lacks the room.
 *   nothing on disk       -> ABSENT.
 *
 * The BOX axis (what Metal or the driver will ever hand a process) and the
 * TODAY axis (what is free of it right now) are reported side by side and
 * neither is folded into the other - the same separation model-capacity.js
 * keeps between capacity and path, for the same reason.
 */

import { readdir, readFile, lstat, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

import { defaultSources } from './host-telemetry.js';

/** Bytes per GB, base 10 - the unit the fleet already publishes. */
const BYTES_PER_GB = 1e9;

/**
 * How much of the budget is reserved for everything that is not weights.
 *
 * WHY 15%, and why a fraction rather than a fixed number. A loaded model needs
 * its weights plus a KV cache, activations, and the framework's own buffers,
 * and only the weights are a file on disk. The KV cache dominates the rest and
 * scales with layers x KV heads x head dim x context, so it scales roughly
 * with the model, which is why the reserve is a fraction rather than a
 * constant.
 *
 * Arithmetic for the fraction, on a model this fleet actually runs:
 * Qwen3-4B-Instruct has 36 layers and 8 KV heads of 128 dims, so at fp16 one
 * token of KV costs 36 x 2 (K and V) x 8 x 128 x 2 B = 147 KB. On this
 * MacBook's measured 115.4 GB budget, 15% is 17.3 GB, i.e. about 117k tokens
 * of cache for that geometry - a full long-context window, not a token of
 * politeness. On a small box the fraction would reserve too little, hence the
 * floor below.
 *
 * It is deliberately NOT tuned per model: we have the file sizes, not the
 * architecture, and a per-model estimate we cannot verify would be a guess
 * dressed as a measurement. One documented reserve that is honest about being
 * a reserve beats a precise-looking number that is not.
 */
export const KV_CACHE_HEADROOM_FRACTION = 0.15;

/**
 * The reserve never drops below this, whatever the budget is. A 4 GB budget
 * would otherwise reserve 600 MB, which no model server has been able to work
 * inside.
 */
export const MIN_HEADROOM_BYTES = 2 * BYTES_PER_GB;

/** Bytes of the budget that weights may NOT use. */
export function headroomBytes(budgetBytes) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return MIN_HEADROOM_BYTES;
  return Math.max(budgetBytes * KV_CACHE_HEADROOM_FRACTION, MIN_HEADROOM_BYTES);
}

/**
 * Where a budget figure came from. Published beside the number, because
 * "115.4 GB from Metal's recommended working set" and "115.4 GB because
 * somebody set an env var" are different grades of the same claim.
 */
export const BUDGET_SOURCES = Object.freeze({
  /** mlx: Metal's max_recommended_working_set_size. The real ceiling. */
  METAL: 'metal-recommended-working-set',
  /** sysctl iogpu.wired_limit_mb, when an operator has raised it explicitly. */
  IOGPU_LIMIT: 'iogpu-wired-limit',
  /** nvidia-smi memory.total for the largest single GPU. */
  NVIDIA_VRAM: 'nvidia-vram',
  /** INTENT_MODEL_BUDGET_GB. The operator's word; still better than a guess. */
  OPERATOR: 'operator-declared',
  /** We could not measure it. NOT a number, and never "fits". */
  UNKNOWN: 'unknown',
});

/** The states a (box, model) pair can be in. Exactly one applies. */
export const AVAILABILITY = Object.freeze({
  /** A live listing names it. Outranks everything below. */
  SERVED: 'served',
  /** Complete on disk and it fits in what is free RIGHT NOW. */
  FITS_NOW: 'fits-now',
  /** Complete on disk, fits the box, not alongside what is resident today. */
  FITS_IF_FREED: 'fits-if-freed',
  /** Complete on disk, fits the box, and this box cannot say what is free. */
  HEADROOM_UNKNOWN: 'headroom-unknown',
  /** Complete on disk; this box cannot say what its budget is. */
  BUDGET_UNKNOWN: 'budget-unknown',
  /** Complete on disk, will not fit here even with the box emptied. */
  TOO_LARGE: 'too-large',
  /** Bytes on disk, not all of them. Never a fit claim. */
  INCOMPLETE: 'incomplete',
  /** A human typed the name. Proven by nothing. */
  MANUAL: 'manual',
  /** Not on this disk at all. */
  ABSENT: 'absent',
});

/**
 * What a card says. Kept here rather than in the renderer so that every
 * surface - dashboard, CLI, log line - uses the same words for the same
 * evidence, and so that FITS_IF_FREED never gets paraphrased into "fits".
 * The fits-if-freed line is a stem: `rank()` appends the price.
 */
export const LABELS = Object.freeze({
  [AVAILABILITY.SERVED]: 'serving',
  [AVAILABILITY.FITS_NOW]: 'available and fits',
  [AVAILABILITY.FITS_IF_FREED]: 'available, fits only after freeing memory',
  [AVAILABILITY.HEADROOM_UNKNOWN]: 'available, current headroom unknown',
  [AVAILABILITY.BUDGET_UNKNOWN]: 'on disk, memory budget unknown',
  [AVAILABILITY.TOO_LARGE]: 'on disk, too large for this box',
  [AVAILABILITY.INCOMPLETE]: 'on disk, incomplete',
  [AVAILABILITY.MANUAL]: 'configured name, unverified',
  [AVAILABILITY.ABSENT]: 'not on this box',
});

/** Ranking, strongest claim first. `byStrength` and `heartbeatFields` use it. */
const STRENGTH = Object.freeze([
  AVAILABILITY.SERVED,
  AVAILABILITY.FITS_NOW,
  AVAILABILITY.FITS_IF_FREED,
  AVAILABILITY.HEADROOM_UNKNOWN,
  AVAILABILITY.BUDGET_UNKNOWN,
  AVAILABILITY.TOO_LARGE,
  AVAILABILITY.INCOMPLETE,
  AVAILABILITY.MANUAL,
  AVAILABILITY.ABSENT,
]);

/** File extensions that are model weights and therefore load into memory. */
const WEIGHT_EXT = /\.(safetensors|gguf|bin|pth|pt|npz)$/i;

/** `model-00003-of-00030.safetensors`, `Qwen-Q4_K_M-00001-of-00009.gguf`. */
const SHARD_OF = /^(.*)-(\d{5})-of-(\d{5})\.(safetensors|gguf|bin)$/i;

/** `model-00003.safetensors` - MLX repos number shards without a total. */
const SHARD_BARE = /^(.*)-(\d{5})\.(safetensors|gguf|bin)$/i;

// --- the memory budget: the BOX axis ---------------------------------------

/** Run a command for a fact Node will not give us. Failure is an empty string. */
function defaultRun(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

/** `115448725504` (or a float) from mlx's device_info. */
export function parseMlxWorkingSet(text) {
  const n = Number(String(text ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * `iogpu.wired_limit_mb: 0` or a bare `0`.
 *
 * Zero means "system default", which is a POLICY, not a number: the kernel
 * picks it from installed RAM by a rule Apple does not publish and has changed
 * between releases. So zero resolves to null - no budget - rather than to a
 * fraction of hw.memsize that we would be inventing. Inventing it is exactly
 * how an unmeasurable becomes a confident "fits".
 */
export function parseWiredLimitMb(text) {
  const m = /(-?\d+)\s*$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const mb = Number(m[1]);
  return Number.isFinite(mb) && mb > 0 ? mb : null;
}

/**
 * MiB totals from `nvidia-smi --query-gpu=memory.total`, one line per GPU.
 *
 * The LARGEST single GPU wins, never the sum. Summing would assume the model
 * is sharded across devices, which depends on how the server is launched and
 * is not something a disk scan can see. The conservative reading is the one a
 * single-device load would get.
 */
export function parseNvidiaTotalMib(text) {
  const values = String(text ?? '')
    .split('\n')
    .map(line => Number(String(line).replace(/[^\d.]/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  return values.length ? Math.max(...values) : null;
}

/**
 * How much memory a model may occupy on this box at most, and how we know.
 *
 * Order, strongest evidence first:
 *   macOS   mlx's Metal working set -> a raised iogpu.wired_limit_mb
 *   Linux   nvidia-smi VRAM
 *   either  INTENT_MODEL_BUDGET_GB, for a box whose instruments we cannot read
 *
 * Nothing falls through to installed RAM. On Apple Silicon the ceiling is
 * Metal's recommended working set, well under hw.memsize (measured on this
 * MacBook: 115.4 GB of 137.4 GB), and on an NVIDIA box system RAM has nothing
 * to do with what fits in VRAM. A budget taken from installed RAM would say
 * "fits" for models that cannot load.
 *
 * @returns {Promise<{bytes: number|null, source: string, note: string|null}>}
 */
export async function measureMemoryBudget({
  platform = process.platform,
  env = process.env,
  run = defaultRun,
} = {}) {
  const declared = Number(env?.INTENT_MODEL_BUDGET_GB);

  if (platform === 'darwin') {
    const mlx = parseMlxWorkingSet(await run('/usr/bin/env', [
      'python3', '-c',
      "import mlx.core as mx; print(mx.device_info()['max_recommended_working_set_size'])",
    ]));
    if (mlx) return { bytes: mlx, source: BUDGET_SOURCES.METAL, note: null };

    const mb = parseWiredLimitMb(await run('/usr/sbin/sysctl', ['iogpu.wired_limit_mb']));
    if (mb) {
      return {
        bytes: mb * 1024 * 1024,
        source: BUDGET_SOURCES.IOGPU_LIMIT,
        note: 'from an explicitly raised iogpu.wired_limit_mb',
      };
    }
  }

  if (platform === 'linux') {
    const mib = parseNvidiaTotalMib(await run('nvidia-smi', [
      '--query-gpu=memory.total', '--format=csv,noheader,nounits',
    ]));
    if (mib) {
      return {
        bytes: mib * 1024 * 1024,
        source: BUDGET_SOURCES.NVIDIA_VRAM,
        note: 'largest single GPU; not a sum',
      };
    }
  }

  if (Number.isFinite(declared) && declared > 0) {
    return {
      bytes: declared * BYTES_PER_GB,
      source: BUDGET_SOURCES.OPERATOR,
      note: 'INTENT_MODEL_BUDGET_GB - an operator statement, not a measurement',
    };
  }

  return {
    bytes: null,
    source: BUDGET_SOURCES.UNKNOWN,
    note: platform === 'darwin'
      ? 'no mlx to ask, and iogpu.wired_limit_mb is 0 (system default, an unpublished policy rather than a figure)'
      : 'no GPU instrument answered and INTENT_MODEL_BUDGET_GB is unset',
  };
}

// --- what is free of it today: the TODAY axis ------------------------------

/**
 * The biggest single thing holding memory, so "free 30 GB" can say from what.
 *
 * ATTRIBUTION, NOT ACCOUNTING. RSS counts shared pages against every process
 * that maps them, so these numbers do not sum to anything meaningful and this
 * one is reported as a hint beside the shortfall, never subtracted from it.
 * One name an operator recognises - `com.apple.Virtualization.VirtualMachine`,
 * 17.2 GiB on this MacBook - turns an abstract number into an action.
 */
export function largestFromPs(text) {
  let best = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    if (!best || bytes > best.bytes) best = { name: basename(m[2]), bytes };
  }
  return best;
}

export async function measureLargestConsumer({
  platform = process.platform,
  run = defaultRun,
} = {}) {
  // The maximum is taken here rather than trusted from a sort flag: macOS
  // `ps -m` orders by virtual size, so the first line of it is routinely a
  // 1.6 GB Python while an 18 GB VM sits further down. A "largest consumer"
  // that is not the largest consumer is worse than none.
  const argv = platform === 'darwin' ? ['-Ao', 'rss=,comm='] : ['-eo', 'rss=,comm='];
  return largestFromPs(await run('/bin/ps', argv, { timeoutMs: 4000 }));
}

/**
 * Bytes a new process could claim, from `vm_stat`'s named page counters.
 *
 * WHY NOT `memory_pressure`, WHICH IS WHAT host-telemetry PUBLISHES. Measured
 * on this MacBook, 20 Sep 2026: `memory_pressure` reported 86% free while
 * `vm_stat` showed 34.8 GB of ACTIVE pages and a 17.2 GiB VM resident. Its
 * "System-wide memory free percentage" counts everything that is not wired or
 * compressed, so it counts running applications as free. Using it here would
 * make FITS_NOW true for anything that fits the box at all, and a fit state
 * that cannot come out negative is not a check.
 *
 * So the figure is built from the counters that are reclaimable WITHOUT a
 * human doing anything:
 *
 *   free         nobody has it
 *   speculative  read-ahead file cache, dropped on demand
 *   purgeable    volatile allocations the kernel may discard at will
 *
 * and deliberately excludes active and inactive anonymous pages (an app must
 * be quit), wired pages (the kernel will not yield them) and compressed pages
 * (already paid for). It also excludes file-backed inactive pages that are not
 * speculative, which ARE reclaimable - so this reading UNDERSTATES what is
 * available, and understating is the safe direction for a claim that must
 * never overstate.
 *
 * This is not the free-memory mistake host-telemetry.js warns about. That
 * warning is against counting only free pages and thereby reporting a
 * cache-rich machine as full; this figure adds the reclaimable cache back in,
 * by name, which is exactly what the warning asks for.
 */
export function parseVmStatAvailable(text) {
  const body = String(text ?? '');
  const pageSize = Number((body.match(/page size of (\d+)/) || [])[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const pages = name => {
    const m = new RegExp(`^Pages ${name}:\\s*(\\d+)`, 'm').exec(body);
    return m ? Number(m[1]) : null;
  };

  const free = pages('free');
  if (!Number.isFinite(free)) return null;
  const speculative = pages('speculative') ?? 0;
  const purgeable = pages('purgeable') ?? 0;
  return (free + speculative + purgeable) * pageSize;
}

/**
 * How much memory a model could actually claim right now.
 *
 * AVAILABLE memory, never free memory - the rule host-telemetry.js
 * establishes and the reason it gives: free pages exclude the cache the OS
 * hands back on demand, so free memory says "no" on a machine with plenty.
 *
 * On Linux that is `MemAvailable`, which means precisely this, so the reading
 * comes straight from host-telemetry's own `availableMemBytes` rather than a
 * second implementation that could drift from what the heartbeat publishes.
 * On macOS the same accessor is backed by `memory_pressure`, which counts
 * running applications as free (see parseVmStatAvailable) and cannot carry a
 * fit claim, so darwin reads `vm_stat`'s reclaimable counters instead.
 *
 * Capped at the budget, because the budget is a ceiling: a Mac reporting more
 * available RAM than Metal will ever hand a process has not thereby raised
 * what Metal will hand a process.
 *
 * @returns {{bytes: number|null, note: string|null, holder: object|null}}
 */
export async function measureAvailableNow({
  platform = process.platform,
  sources = defaultSources,
  run = defaultRun,
  budgetBytes = null,
} = {}) {
  let raw = null;
  try {
    const value = platform === 'darwin'
      ? parseVmStatAvailable(await run('/usr/bin/vm_stat', [], { timeoutMs: 4000 }))
      : sources.availableMemBytes?.();
    if (Number.isFinite(value) && value > 0) raw = value;
  } catch {
    raw = null;
  }

  if (raw === null) {
    return {
      bytes: null,
      note: 'no available-memory reading on this box; current headroom is unknown, which is not the same as zero',
      holder: null,
    };
  }

  const capped = Number.isFinite(budgetBytes) && budgetBytes > 0 ? Math.min(raw, budgetBytes) : raw;
  let holder = null;
  try {
    holder = await measureLargestConsumer({ platform, run });
  } catch {
    holder = null;
  }

  return {
    bytes: capped,
    note: capped < raw ? 'available memory exceeds the memory budget; capped at the budget' : null,
    holder,
  };
}

/**
 * Both axes at once.
 *
 * @returns {Promise<{budget: object, now: object}>}
 */
export async function measureMemory({
  platform = process.platform,
  env = process.env,
  sources = defaultSources,
  run = defaultRun,
} = {}) {
  const budget = await measureMemoryBudget({ platform, env, run });
  const now = await measureAvailableNow({ platform, sources, run, budgetBytes: budget.bytes });
  return { budget, now };
}

/**
 * The fit verdict for one weight size, on both axes.
 *
 * Note the strictness on the box axis: equality with the budget is NOT a fit.
 * A model whose weights exactly equal the budget leaves nothing for the KV
 * cache, so it loads and then dies on the first request - the worst possible
 * time to find out.
 *
 * Two shortfalls come back, and they are different questions:
 *   `weightsShortfallBytes`  what must be returned for the weights alone. The
 *                            floor, and the number an operator recognises as
 *                            "the model is this much bigger than my free RAM".
 *   `shortfallBytes`         what must be returned to also leave the KV
 *                            reserve, i.e. to actually SERVE it. The honest
 *                            headline, and always the larger of the two.
 *
 * @returns {{state: string, needBytes: number|null, usableBytes: number|null,
 *            shortfallBytes: number|null, weightsShortfallBytes: number|null}}
 */
export function classifyFit(weightBytes, budgetBytes, availableNowBytes = null) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    return {
      state: AVAILABILITY.BUDGET_UNKNOWN,
      needBytes: null,
      usableBytes: null,
      shortfallBytes: null,
      weightsShortfallBytes: null,
    };
  }

  const headroom = headroomBytes(budgetBytes);
  const usableBytes = budgetBytes - headroom;
  const needBytes = weightBytes + headroom;

  if (weightBytes > usableBytes) {
    return {
      state: AVAILABILITY.TOO_LARGE,
      needBytes,
      usableBytes,
      shortfallBytes: null,
      weightsShortfallBytes: null,
    };
  }

  if (!Number.isFinite(availableNowBytes) || availableNowBytes < 0) {
    return {
      state: AVAILABILITY.HEADROOM_UNKNOWN,
      needBytes,
      usableBytes,
      shortfallBytes: null,
      weightsShortfallBytes: null,
    };
  }

  if (needBytes <= availableNowBytes) {
    return {
      state: AVAILABILITY.FITS_NOW,
      needBytes,
      usableBytes,
      shortfallBytes: 0,
      weightsShortfallBytes: 0,
    };
  }

  return {
    state: AVAILABILITY.FITS_IF_FREED,
    needBytes,
    usableBytes,
    shortfallBytes: needBytes - availableNowBytes,
    weightsShortfallBytes: Math.max(0, weightBytes - availableNowBytes),
  };
}

// --- finding the bytes -----------------------------------------------------

/**
 * `models--RepublicOfKorokke--Qwen3-4B-Instruct-2507-mlx-mxfp4` ->
 * `RepublicOfKorokke/Qwen3-4B-Instruct-2507-mlx-mxfp4`.
 *
 * HuggingFace encodes the single `/` of a repo id as `--`, and a model NAME
 * may itself contain `--`, so only the FIRST separator after the prefix is a
 * slash. Splitting on every `--` mangles half the fleet's repos.
 */
export function repoIdFromCacheDir(dirName) {
  const name = String(dirName ?? '');
  if (!name.startsWith('models--')) return null;
  const rest = name.slice('models--'.length);
  const idx = rest.indexOf('--');
  if (idx <= 0) return rest || null;
  return `${rest.slice(0, idx)}/${rest.slice(idx + 2)}`;
}

/**
 * Which shards are missing from a set of weight file names, if we can tell.
 *
 * Two naming conventions, and the second is the one that catches a download in
 * flight after its `.incomplete` markers have gone:
 *
 *   `-00003-of-00030` states the total, so the answer is arithmetic.
 *   `-00003` alone (MLX's convention) does not, so the rule is contiguity:
 *     1..max with no gaps. A repo mid-download has gaps - this machine's
 *     Qwen3.8-Flash-Next snapshot was missing 00019, 00025 and 00027 while
 *     the rest were on disk. A published repo with a genuine gap would be
 *     misread as incomplete, and that is the direction to be wrong in.
 *
 * @returns {string[]} human-readable complaints; empty means nothing missing
 */
export function missingShards(fileNames) {
  const complaints = [];
  const groups = new Map();

  for (const name of fileNames) {
    const of = SHARD_OF.exec(name);
    if (of) {
      const key = `${of[1]}.${of[4].toLowerCase()}|of`;
      const g = groups.get(key) || { total: Number(of[3]), seen: new Set(), key };
      g.seen.add(Number(of[2]));
      groups.set(key, g);
      continue;
    }
    const bare = SHARD_BARE.exec(name);
    if (bare) {
      const key = `${bare[1]}.${bare[3].toLowerCase()}|bare`;
      const g = groups.get(key) || { total: 0, seen: new Set(), key };
      g.seen.add(Number(bare[2]));
      g.total = Math.max(g.total, Number(bare[2]));
      groups.set(key, g);
    }
  }

  for (const g of groups.values()) {
    const gaps = [];
    for (let i = 1; i <= g.total; i += 1) if (!g.seen.has(i)) gaps.push(i);
    if (gaps.length) {
      const which = gaps.slice(0, 5).map(n => String(n).padStart(5, '0')).join(', ');
      complaints.push(
        `${gaps.length} of ${g.total} shards missing (${which}${gaps.length > 5 ? ', ...' : ''})`
      );
    }
  }
  return complaints;
}

/** Bytes of a snapshot entry, following the symlink into `blobs/`. */
async function sizeOfEntry(path, seen) {
  const link = await lstat(path);
  if (link.isSymbolicLink()) {
    let target;
    try {
      target = await stat(path);
    } catch {
      // A snapshot symlink with no blob behind it. `huggingface_hub` creates
      // the link when the download of that file starts, so a dangling one is
      // a file in flight - never a file present.
      return { bytes: 0, dangling: true };
    }
    const key = `${target.dev}:${target.ino}`;
    if (seen.has(key)) return { bytes: 0, dangling: false };
    seen.add(key);
    return { bytes: target.size, dangling: false };
  }
  if (!link.isFile()) return { bytes: 0, dangling: false };
  const key = `${link.dev}:${link.ino}`;
  if (seen.has(key)) return { bytes: 0, dangling: false };
  seen.add(key);
  return { bytes: link.size, dangling: false };
}

/**
 * One `models--org--name` directory in the hub cache, sized and checked.
 *
 * SIZING IS DEDUPED BY INODE, and that is not a micro-optimisation. Every file
 * in `snapshots/<sha>/` is a symlink into `blobs/`, so a traversal that does
 * not follow them reads 0, and one that follows them without deduping
 * double-counts anything two snapshots share. Deduping by (dev, ino) is what
 * `du` does, and the sizes this produces were checked against `du -sh` on this
 * machine's real cache.
 *
 * @returns {Promise<object|null>} null when the directory holds no weights
 */
export async function scanRepoDir(dir, { repoId = repoIdFromCacheDir(basename(dir)) } = {}) {
  const reasons = [];

  // The pointer huggingface_hub itself follows. A cache with several snapshots
  // and no ref is a repo we cannot resolve to one revision, so we take the
  // newest and say so rather than silently picking one.
  let sha = null;
  try {
    sha = (await readFile(join(dir, 'refs', 'main'), 'utf8')).trim();
  } catch {
    sha = null;
  }

  let snapshots = [];
  try {
    snapshots = (await readdir(join(dir, 'snapshots'), { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return null;
  }
  if (!snapshots.length) return null;

  if (!sha || !snapshots.includes(sha)) {
    if (snapshots.length > 1) reasons.push('several snapshots and no readable refs/main; sized the newest');
    const stamped = await Promise.all(snapshots.map(async name => {
      try {
        return { name, at: (await stat(join(dir, 'snapshots', name))).mtimeMs };
      } catch {
        return { name, at: 0 };
      }
    }));
    stamped.sort((a, b) => b.at - a.at);
    sha = stamped[0].name;
  }

  const snapDir = join(dir, 'snapshots', sha);
  let entries = [];
  try {
    entries = await readdir(snapDir);
  } catch {
    return null;
  }

  const seen = new Set();
  const weightFiles = [];
  let weightBytes = 0;
  let totalBytes = 0;
  let dangling = 0;

  for (const name of entries) {
    const { bytes, dangling: isDangling } = await sizeOfEntry(join(snapDir, name), seen);
    if (isDangling) {
      dangling += 1;
      if (WEIGHT_EXT.test(name)) weightFiles.push(name);
      continue;
    }
    totalBytes += bytes;
    if (WEIGHT_EXT.test(name)) {
      weightFiles.push(name);
      weightBytes += bytes;
    }
  }

  if (!weightFiles.length) return null;

  // A blob still being written. This is the loudest signal and the cheapest:
  // huggingface_hub writes `<sha>.incomplete` next to the finished blobs and
  // renames on completion. ANY of them means "this repo is in flight", which
  // can outlive the download if a marker is orphaned - a stale INCOMPLETE is a
  // boring bug, a false "available and fits" is the one this feature prevents.
  try {
    const blobs = await readdir(join(dir, 'blobs'));
    const partial = blobs.filter(n => n.endsWith('.incomplete'));
    if (partial.length) reasons.push(`${partial.length} blob(s) still downloading`);
  } catch {
    // No blobs directory: an unusual but not dishonest cache layout.
  }

  if (dangling) reasons.push(`${dangling} file(s) linked but not yet downloaded`);

  reasons.push(...missingShards(weightFiles));

  // The index states both the file list and the total weight size, so it can
  // catch a shard that is present but short.
  const indexName = entries.find(n => /\.index\.json$/i.test(n));
  if (indexName) {
    try {
      const index = JSON.parse(await readFile(join(snapDir, indexName), 'utf8'));
      const wanted = new Set(Object.values(index?.weight_map ?? {}));
      const have = new Set(weightFiles);
      const absent = [...wanted].filter(n => !have.has(n));
      if (absent.length) reasons.push(`${indexName} names ${absent.length} file(s) that are not here`);
      const stated = Number(index?.metadata?.total_size);
      if (Number.isFinite(stated) && stated > 0 && weightBytes < stated) {
        reasons.push(`weights are ${fmtGb(weightBytes)} but the index states ${fmtGb(stated)}`);
      }
    } catch {
      reasons.push(`${indexName} is unreadable`);
    }
  }

  return {
    repoId,
    dir,
    revision: sha,
    weightBytes,
    totalBytes,
    weightFiles: weightFiles.sort(),
    complete: reasons.length === 0,
    reasons,
  };
}

/** A loose `*.gguf` in a plain directory is a model in its own right. */
async function scanLooseDir(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  const seen = new Set();
  const ggufs = entries.filter(e => !e.isDirectory() && /\.gguf$/i.test(e.name)).map(e => e.name);
  const gaps = missingShards(ggufs);

  for (const name of ggufs) {
    const shard = SHARD_OF.exec(name) || SHARD_BARE.exec(name);
    // Shards of one model are one model: the first shard carries the group's
    // total so the fit is judged against the whole thing, not a slice of it.
    if (shard && Number(shard[2]) !== 1) continue;

    const { bytes, dangling } = await sizeOfEntry(join(dir, name), seen);
    const reasons = [...gaps];
    if (dangling) reasons.push('file is a broken link');

    let weightBytes = bytes;
    if (shard) {
      for (const sibling of ggufs) {
        if (sibling === name) continue;
        const sib = SHARD_OF.exec(sibling) || SHARD_BARE.exec(sibling);
        if (sib && sib[1] === shard[1]) {
          const got = await sizeOfEntry(join(dir, sibling), seen);
          weightBytes += got.bytes;
        }
      }
    }

    out.push({
      repoId: shard ? shard[1] : name.replace(/\.gguf$/i, ''),
      dir,
      revision: null,
      weightBytes,
      totalBytes: weightBytes,
      weightFiles: [name],
      complete: reasons.length === 0,
      reasons,
    });
  }
  return out;
}

/**
 * Where to look for weights. The hub cache is the default because it is where
 * everything on this fleet lands, but GGUF files live wherever whoever
 * downloaded them put them, so the list is configurable rather than a layout
 * baked into the source.
 *
 * INTENT_MODEL_DIRS is a colon-separated list and REPLACES the defaults, so an
 * operator with an external drive is not stuck also scanning a home directory
 * that has nothing in it.
 */
export function defaultSearchRoots(env = process.env, home = homedir()) {
  const configured = String(env?.INTENT_MODEL_DIRS ?? '').trim();
  if (configured) {
    return configured.split(':').map(s => s.trim()).filter(Boolean)
      .map(p => (p.startsWith('~/') ? join(home, p.slice(2)) : p));
  }
  const hub = String(env?.HF_HUB_CACHE ?? '').trim()
    || (env?.HF_HOME ? join(String(env.HF_HOME), 'hub') : join(home, '.cache', 'huggingface', 'hub'));
  return [hub, join(home, 'models'), join(home, '.lmstudio', 'models')];
}

/**
 * Every model this box has bytes for. Never throws: an unreadable directory
 * contributes nothing rather than failing the scan, because a scan that dies
 * on one bad path reports a whole box as empty.
 */
export async function scanLocalModels({ roots = defaultSearchRoots() } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('models--')) continue;
      try {
        const repo = await scanRepoDir(join(root, entry.name));
        if (repo) found.push(repo);
      } catch {
        // One unreadable repo is not a reason to report the box as bare.
      }
    }
    try {
      found.push(...await scanLooseDir(root));
    } catch {
      // Same.
    }
  }
  return found;
}

// --- putting the axes together ---------------------------------------------

/**
 * The one state for one model on this box.
 *
 * PRECEDENCE IS THE POINT. A model a server is listing is SERVED even when it
 * is also on disk and also fits: the stronger claim is the true one, and
 * showing "available" beside a running server understates it and sends an
 * operator to start something already started. Below that, whatever the disk
 * says beats a configured name, and a configured name the disk cannot
 * corroborate stays MANUAL forever.
 *
 * @param {object} args
 * @param {string} args.repoId
 * @param {Iterable<string>} [args.servedIds] - ids from a live /v1/models
 * @param {object|null} [args.onDisk] - a scanLocalModels entry, or null
 * @param {{bytes: number|null, source: string, note: string|null}} [args.budget]
 * @param {{bytes: number|null, holder: object|null}} [args.now]
 * @param {boolean} [args.manual] - the name came from INTENT_DEVICE_MODEL
 */
export function rank({ repoId, servedIds = [], onDisk = null, budget = null, now = null, manual = false }) {
  const served = new Set([...servedIds].map(s => String(s).trim()).filter(Boolean));
  const base = {
    model: repoId,
    sizeGb: onDisk ? round1(onDisk.weightBytes / BYTES_PER_GB) : undefined,
    budgetGb: Number.isFinite(budget?.bytes) ? round1(budget.bytes / BYTES_PER_GB) : undefined,
    budgetSource: budget?.source ?? BUDGET_SOURCES.UNKNOWN,
    availableNowGb: Number.isFinite(now?.bytes) ? round1(now.bytes / BYTES_PER_GB) : undefined,
  };

  if (served.has(repoId)) {
    return { ...base, state: AVAILABILITY.SERVED, label: LABELS[AVAILABILITY.SERVED], reason: null };
  }

  if (onDisk) {
    if (!onDisk.complete) {
      return {
        ...base,
        state: AVAILABILITY.INCOMPLETE,
        label: LABELS[AVAILABILITY.INCOMPLETE],
        reason: onDisk.reasons.join('; '),
      };
    }

    const fit = classifyFit(onDisk.weightBytes, budget?.bytes, now?.bytes);
    const out = { ...base, state: fit.state, label: LABELS[fit.state], reason: null };

    if (fit.state === AVAILABILITY.BUDGET_UNKNOWN) {
      out.reason = budget?.note ?? 'no memory budget could be measured on this box';
      return out;
    }
    if (fit.state === AVAILABILITY.TOO_LARGE) {
      out.reason = `weights ${fmtGb(onDisk.weightBytes)} exceed the ${fmtGb(fit.usableBytes)} left after KV headroom`;
      return out;
    }
    if (fit.state === AVAILABILITY.HEADROOM_UNKNOWN) {
      out.reason = `${fmtGb(onDisk.weightBytes)} on disk and inside a ${fmtGb(fit.usableBytes)} usable budget, `
        + `${now?.note ?? 'this box reports no available-memory figure'}`;
      return out;
    }
    if (fit.state === AVAILABILITY.FITS_NOW) {
      out.needsGb = 0;
      out.reason = `${fmtGb(onDisk.weightBytes)} on disk, verified complete, and ${fmtGb(now.bytes)} `
        + `available now against a ${fmtGb(fit.needBytes)} requirement`;
      return out;
    }

    // FITS_IF_FREED. The cost is the point: a chip that cannot name it is a
    // grey chip that reads as a failure, which is what this state replaces.
    out.needsGb = round1(fit.shortfallBytes / BYTES_PER_GB);
    out.weightsNeedGb = round1(fit.weightsShortfallBytes / BYTES_PER_GB);
    out.label = `${LABELS[AVAILABILITY.FITS_IF_FREED]} (${out.needsGb} GB)`;
    out.reason = `${fmtGb(onDisk.weightBytes)} on disk fits the box, but only ${fmtGb(now.bytes)} is available now: `
      + `${fmtGb(fit.weightsShortfallBytes)} must come back for the weights alone, `
      + `${fmtGb(fit.shortfallBytes)} to also leave KV headroom`
      + (now?.holder ? `; largest single consumer is ${now.holder.name} at ${fmtGb(now.holder.bytes)}` : '');
    if (now?.holder) out.holder = { name: now.holder.name, gb: round1(now.holder.bytes / BYTES_PER_GB) };
    return out;
  }

  if (manual) {
    return {
      ...base,
      state: AVAILABILITY.MANUAL,
      label: LABELS[AVAILABILITY.MANUAL],
      reason: 'a configured name with no bytes and no server behind it',
    };
  }

  return { ...base, state: AVAILABILITY.ABSENT, label: LABELS[AVAILABILITY.ABSENT], reason: null };
}

/** Strongest first, then biggest first. For a list a human reads top-down. */
export function byStrength(a, b) {
  const d = STRENGTH.indexOf(a.state) - STRENGTH.indexOf(b.state);
  return d !== 0 ? d : (b.sizeGb ?? 0) - (a.sizeGb ?? 0);
}

/**
 * Every model this box has an opinion about, ranked.
 *
 * A served id on no disk we scanned still appears, as SERVED: a running server
 * is proof enough, and a model loaded from a path outside the search roots is
 * a configuration detail, not a reason to drop the strongest claim we have.
 */
export async function describeLocalModels({
  servedIds = [],
  manualName = null,
  roots = defaultSearchRoots(),
  budget,
  now,
  platform = process.platform,
  env = process.env,
  sources = defaultSources,
  run = defaultRun,
} = {}) {
  let measuredBudget = budget;
  let measuredNow = now;
  if (!measuredBudget || !measuredNow) {
    const both = await measureMemory({ platform, env, sources, run });
    measuredBudget = measuredBudget ?? both.budget;
    measuredNow = measuredNow ?? both.now;
  }

  const onDisk = await scanLocalModels({ roots });
  const byId = new Map(onDisk.map(m => [m.repoId, m]));

  const ids = new Set([...byId.keys(), ...[...servedIds].map(s => String(s).trim()).filter(Boolean)]);
  if (manualName) ids.add(String(manualName).trim());

  const models = [...ids].map(repoId => rank({
    repoId,
    servedIds,
    onDisk: byId.get(repoId) ?? null,
    budget: measuredBudget,
    now: measuredNow,
    manual: manualName ? String(manualName).trim() === repoId : false,
  }));

  models.sort(byStrength);
  return { budget: measuredBudget, now: measuredNow, models };
}

/**
 * The heartbeat's extra fields, and the contract they carry.
 *
 * `model` keeps its existing meaning - SERVED, nothing else - so a dashboard
 * that has never heard of this file cannot start rendering a weaker claim as a
 * stronger one. `model_available` is the separate, weaker field, published for
 * a model that is complete on disk and fits the box. `model_state` names which
 * of the two fit claims it is, and `model_needs_gb` carries the price of the
 * weaker one as a NUMBER, so a card can say "needs 45.5 GB back" instead of
 * going grey.
 *
 * `model_needs_gb` is the full requirement, weights AND the KV reserve, since
 * that is what it costs to actually serve the thing. The weights-only floor
 * stays in the detailed record for a UI that wants both.
 *
 * Nothing here emits a placeholder: a box with no opinion publishes no keys.
 */
export function heartbeatFields(models) {
  const best = [...(models ?? [])].sort(byStrength)[0];
  if (!best) return {};

  if (best.state === AVAILABILITY.SERVED) return { model_state: best.state };

  if (best.state === AVAILABILITY.FITS_NOW) {
    return { model_state: best.state, model_available: best.model, model_needs_gb: 0 };
  }

  if (best.state === AVAILABILITY.FITS_IF_FREED) {
    return {
      model_state: best.state,
      model_available: best.model,
      model_needs_gb: best.needsGb,
      ...(best.holder ? { model_held_by: best.holder.name } : {}),
    };
  }

  return { model_state: best.state };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmtGb(bytes) {
  return `${round1(bytes / BYTES_PER_GB)} GB`;
}

/**
 * A cached, self-expiring availability reading, shaped exactly like
 * ServedModelProbe for the same reason: `current()` is synchronous and never
 * touches the disk, so the heartbeat can call it every 30 s, and `refresh()`
 * is the only thing that does I/O and never throws. A scan of a 19 GB cache is
 * cheap but not free, and a heartbeat that can be delayed by a disk is a
 * machine that can vanish from the dashboard because of a model.
 */
export class ModelAvailabilityProbe {
  #opts;
  #now;
  #intervalMs;
  #staleAfterMs;
  #timer = null;
  #last = null;
  #inFlight = null;

  /** Slower than the served-model probe: a download finishing is not urgent. */
  static DEFAULT_INTERVAL_MS = 900000;

  constructor({ now = () => Date.now(), intervalMs, staleAfterMs, ...opts } = {}) {
    this.#opts = opts;
    this.#now = now;
    const fromEnv = Number(opts.env?.INTENT_MODEL_SCAN_MS);
    this.#intervalMs = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : ModelAvailabilityProbe.DEFAULT_INTERVAL_MS);
    this.#staleAfterMs = Number.isFinite(staleAfterMs) && staleAfterMs > 0
      ? staleAfterMs
      : this.#intervalMs * 3;
  }

  /**
   * The last scan, if it is still current. An expired one publishes nothing -
   * the memory picture it was built from has moved on, and a stale "fits now"
   * is a claim about a machine that no longer exists.
   */
  lastResult() {
    if (!this.#last) return { budget: null, now: null, models: [] };
    if (this.#now() - this.#last.at > this.#staleAfterMs) return { budget: null, now: null, models: [] };
    return this.#last.value;
  }

  /** What the heartbeat merges in. Never a placeholder. */
  current() {
    return heartbeatFields(this.lastResult().models);
  }

  async refresh(extra = {}) {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      let value = { budget: null, now: null, models: [] };
      try {
        value = await describeLocalModels({ ...this.#opts, ...extra });
      } catch {
        // A scan that throws reports nothing, not a stale or hopeful answer.
      }
      this.#last = { value, at: this.#now() };
      return value;
    })().finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }

  start() {
    this.stop();
    this.refresh().catch(() => {});
    this.#timer = setInterval(() => { this.refresh().catch(() => {}); }, this.#intervalMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
