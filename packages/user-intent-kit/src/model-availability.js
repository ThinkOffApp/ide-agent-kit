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
 *
 * EVERY UNKNOWN IN THIS FILE FAILS CLOSED. That is the one rule the rest is
 * built from, and every bug this module has been handed is a variant of an
 * unknown quietly rendering as a yes: an unreadable budget, an unparseable
 * memory figure, a model that is merely listed by a server, a download that
 * is 99% finished. None of them may become a positive claim.
 *
 * It is worth being concrete about why the arithmetic deserves as much
 * suspicion as the data source. A counter parser that matches NOTHING does
 * not throw - it produces an empty set of counters, which sums to zero, which
 * reads as "nothing is in use", which green-lights every model on the box
 * with a confident "fits now". That failure looks like arithmetic rather than
 * a bad instrument, which is what makes it worse than the memory_pressure
 * trap below. Hence parseVmStatAvailable refuses an empty parse, refuses a
 * missing page size, and cross-checks its own counters against installed RAM
 * before it will return a number at all.
 */

import { readdir, readFile, lstat, stat, open as openFile } from 'node:fs/promises';
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
  /**
   * It GENERATED a token. The only proof a model is loaded, and the only
   * state that outranks the disk.
   */
  SERVED: 'served',
  /**
   * A server's /v1/models names it and we know nothing else about it.
   *
   * Deliberately ranked BELOW every disk-derived state, which is the whole
   * lesson of 20 Sep 2026: `mlx_lm` lists the local HuggingFace cache, so a
   * listing is evidence that files exist - exactly what a directory scan
   * gives, with less detail. When the scan has anything to say about the same
   * model, the scan wins, which is why a listed-but-still-downloading model
   * reads as `incomplete` rather than as anything reassuring.
   */
  LISTED: 'listed',
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
  [AVAILABILITY.LISTED]: 'listed by a server, not shown to be loaded',
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
  AVAILABILITY.LISTED,
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
export function parseVmStatBreakdown(text, totalMemBytes = null) {
  const body = String(text ?? '');

  // The page size is STATED, never assumed: 16384 on Apple Silicon, 4096
  // elsewhere, and a hardcoded constant would be wrong by 4x on one of them.
  // A missing line is a parse failure, not a licence to guess.
  const pageSize = Number((body.match(/page size of (\d+)/) || [])[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const seen = new Map();
  const pages = (label) => {
    const m = new RegExp(`^Pages ${label}:\\s*(\\d+)`, 'm').exec(body);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    seen.set(label, n);
    return n;
  };

  const free = pages('free');
  const speculative = pages('speculative');
  const purgeable = pages('purgeable');
  const active = pages('active');
  const inactive = pages('inactive');
  const wired = pages('wired down');
  const compressorMatch = /^Pages occupied by compressor:\s*(\d+)/m.exec(body);
  const compressor = compressorMatch ? Number(compressorMatch[1]) : null;

  // An empty parse is an ERROR, not a machine with nothing in it. If the
  // labels move in a future macOS, or the regex is a character out, this is
  // the branch that must catch it - the alternative is a sum over an empty
  // set, reported as infinite free memory.
  if (!seen.size) return null;

  // Every counter the cross-check needs must be present. Matching three of
  // seven is a broken parser producing a plausible-looking number.
  if ([free, speculative, purgeable, active, inactive, wired, compressor].some(n => n === null)
    || !Number.isFinite(compressor)) {
    return null;
  }

  const gb = n => n * pageSize;

  // `purgeable` is a SUBSET of the active and inactive queues, so it is added
  // to what is claimable but never to the accounting total - counting it in
  // both would inflate the machine.
  const accounted = gb(free + active + inactive + speculative + wired + compressor);
  const inUse = gb(active + wired + compressor);

  // What a new allocation can have without anybody quitting anything, and
  // WITHOUT the kernel having to compress a running process's pages.
  const available = gb(free + speculative + purgeable);

  // The broader reading, which counts the inactive queue as reclaimable too.
  // Reported beside the conservative one rather than instead of it: inactive
  // holds both clean file-backed pages, which are dropped for free, and dirty
  // anonymous pages, which are COMPRESSED rather than returned - so the true
  // figure is somewhere between these two and vm_stat alone cannot say where.
  // FITS_NOW is judged on the conservative one, because a claim that must not
  // overstate takes the low end of a range it cannot narrow.
  const reclaimable = gb(free + inactive + speculative + purgeable);

  if (available <= 0) return null;

  if (Number.isFinite(totalMemBytes) && totalMemBytes > 0) {
    // THE CROSS-CHECK THAT WOULD HAVE CAUGHT THE BUG THIS GUARD EXISTS FOR.
    // A reclaimable figure that omitted the speculative queue understated
    // available memory by 59 GiB on this machine and nobody noticed, because
    // nothing compared the parts against the whole.
    //
    // The band is 5%, not 20%. Two independent measurements here accounted for
    // 99.1% and 99.2% of installed RAM, so 5% is five times the observed drift
    // - and 20% was uselessly loose: dropping the inactive queue (15% of this
    // box), wired (6%) or the compressor (6%) all sailed through it. A bucket
    // that happens to be near-empty at measurement time still cannot be caught
    // this way, but dropping a near-empty bucket also barely moves the answer.
    if (accounted < totalMemBytes * 0.95 || accounted > totalMemBytes * 1.05) return null;

    // Zero bytes in use on a running macOS box is impossible, and so is more
    // in use than the machine has. Either means the parse is wrong, and the
    // honest answer is unknown - never a fit.
    if (inUse <= 0 || inUse > totalMemBytes) return null;
    if (available > totalMemBytes) return null;
  }

  return { pageSize, available, reclaimable, inUse, accounted };
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
 * human doing anything and without compressing a running process:
 *
 *   free         nobody has it
 *   speculative  read-ahead file cache, dropped on demand
 *   purgeable    volatile allocations the kernel may discard at will
 *
 * and excludes active and wired pages (an app must be quit), compressed pages
 * (already paid for), and the inactive queue (part clean cache, part dirty
 * anonymous pages that are compressed rather than freed - see
 * parseVmStatBreakdown, which reports that broader figure separately).
 *
 * This is not the free-memory mistake host-telemetry.js warns about. That
 * warning is against counting only free pages and thereby reporting a
 * cache-rich machine as full; this figure adds the reclaimable cache back in,
 * by name, which is exactly what the warning asks for. Speculative pages are
 * 59 GiB of this box and omitting them is its own, opposite bug.
 */
export function parseVmStatAvailable(text, totalMemBytes = null) {
  return parseVmStatBreakdown(text, totalMemBytes)?.available ?? null;
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
  let total = null;
  try {
    const t = sources.totalMemBytes?.();
    if (Number.isFinite(t) && t > 0) total = t;
  } catch {
    total = null;
  }

  try {
    const value = platform === 'darwin'
      ? parseVmStatAvailable(await run('/usr/bin/vm_stat', [], { timeoutMs: 4000 }), total)
      : sources.availableMemBytes?.();
    // The same bounds guard the Linux path. A missing or unparseable
    // MemAvailable arrives here as undefined or NaN and must read as unknown,
    // never as plenty; a value above installed RAM means the field was
    // misread, and a machine with nothing in use does not exist.
    if (Number.isFinite(value) && value > 0
      && (total === null || (value <= total && total - value > 0))) {
      raw = value;
    }
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

// --- how big is the model, in parameters ----------------------------------

/**
 * Parameter counts, in decreasing order of proof - the same discipline the
 * rest of this file applies to fits.
 *
 *   INDEX      the producer wrote `metadata.total_parameters` into the
 *              safetensors index. Their own number for their own model.
 *   SAFETENSORS every tensor's shape, summed, with the packing undone for
 *              quantized weights. Arithmetic over real metadata.
 *   GGUF       every tensor's dims, summed, from the file's own tensor table.
 *   NAME       the digits in `Qwen3.8-27B`. A convention, not a measurement,
 *              and it is published as UNCONFIRMED or not at all.
 *
 * A repo whose name says 27B and whose metadata cannot confirm it reports
 * `name` as its source, so a dashboard can render the number differently from
 * one that was counted. Guessing is allowed; guessing silently is not.
 */
export const PARAM_SOURCES = Object.freeze({
  INDEX: 'index-metadata',
  SAFETENSORS: 'safetensors-header',
  GGUF: 'gguf-metadata',
  NAME: 'name-unconfirmed',
});

/** Tensors that describe other tensors, and are not themselves parameters. */
const NOT_PARAMETERS = /\.(scales|biases|zeros|g_idx|qzeros)$/;

/**
 * The JSON header of a safetensors file: an 8-byte little-endian length, then
 * that many bytes of JSON. Only the header is read - the weights behind it can
 * be 75 GB and are never touched.
 */
export async function readSafetensorsHeader(path) {
  let handle;
  try {
    handle = await openFile(path, 'r');
    const len = Buffer.alloc(8);
    await handle.read(len, 0, 8, 0);
    const size = Number(len.readBigUInt64LE(0));
    // A header larger than this is not a header we understand, and reading it
    // would be the beginning of reading the whole file into memory.
    if (!Number.isFinite(size) || size <= 0 || size > 100 * 1024 * 1024) return null;
    const json = Buffer.alloc(size);
    await handle.read(json, 0, size, 8);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Parameters described by one safetensors header.
 *
 * QUANTIZED WEIGHTS ARE PACKED, and a naive shape product undercounts them by
 * exactly the packing factor: MLX stores 4-bit weights as uint32 with eight
 * values per element, so a [2560, 320] U32 tensor holds 2560 x 2560
 * parameters, not 2560 x 320.
 *
 * THE PACKING FACTOR IS READ PER TENSOR, NOT TAKEN FROM config.json. This
 * machine holds `Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`, whose config
 * declares a single `bits: 4` while the repo, by its own name, mixes 4-bit and
 * 8-bit tensors. Trusting the declared value counted every 8-bit tensor at
 * twice its size and turned the model into a confident 133B.
 *
 * So the true inner dimension comes from the tensor's own `.scales`, which is
 * stored unpacked at one element per quantization group: `in = scales_last x
 * group_size`. That is arithmetic over the file's own metadata and it needs no
 * declaration to be right. Where there is no sibling `.scales`, the declared
 * bits are used, and where there is neither the tensor is counted as stored -
 * which undercounts, the safe direction for a number that must not inflate.
 */
export function paramsFromSafetensorsHeader(header, { bits = null, groupSize = null } = {}) {
  if (!header || typeof header !== 'object') return null;
  const declaredFactor = Number.isFinite(bits) && bits > 0 ? 32 / bits : 1;
  let total = 0;
  let counted = 0;

  const shapeOf = name => {
    const shape = header?.[name]?.shape;
    return Array.isArray(shape) && shape.length ? shape : null;
  };

  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    if (NOT_PARAMETERS.test(name)) continue;
    const shape = tensor?.shape;
    if (!Array.isArray(shape) || !shape.length) continue;
    for (const dim of shape) if (!Number.isFinite(dim) || dim < 0) return null;

    const leading = shape.slice(0, -1).reduce((a, b) => a * b, 1);
    const last = shape[shape.length - 1];

    if (String(tensor?.dtype).toUpperCase() === 'U32') {
      const scales = shapeOf(name.replace(/\.weight$/, '.scales'));
      if (scales && Number.isFinite(groupSize) && groupSize > 0) {
        total += leading * scales[scales.length - 1] * groupSize;
      } else {
        total += leading * last * declaredFactor;
      }
    } else {
      total += leading * last;
    }
    counted += 1;
  }
  return counted ? Math.round(total) : null;
}

const GGUF_MAGIC = 0x46554747; // "GGUF", little-endian

/**
 * Parameters from a GGUF file's own tensor table.
 *
 * GGUF states each tensor's true dimensions rather than its packed storage
 * shape, so the sum is the parameter count directly. Only the header region is
 * read; if the metadata is larger than the window, the answer is null and the
 * caller falls back rather than reading gigabytes to count them.
 */
export function paramsFromGgufBuffer(buf) {
  try {
    if (!buf || buf.length < 24 || buf.readUInt32LE(0) !== GGUF_MAGIC) return null;
    let off = 8;
    const u64 = () => { const v = Number(buf.readBigUInt64LE(off)); off += 8; return v; };
    const u32 = () => { const v = buf.readUInt32LE(off); off += 4; return v; };
    const str = () => { const n = u64(); const v = buf.toString('utf8', off, off + n); off += n; return v; };

    const tensorCount = u64();
    const kvCount = u64();
    if (!Number.isFinite(tensorCount) || tensorCount <= 0 || tensorCount > 1e6) return null;

    // Fixed widths for the scalar value types, by GGUF type id.
    const WIDTH = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const skipValue = (type) => {
      if (type === 8) { str(); return; }
      if (type === 9) {
        const itemType = u32();
        const n = u64();
        for (let i = 0; i < n; i += 1) skipValue(itemType);
        return;
      }
      const w = WIDTH[type];
      if (w === undefined) throw new Error(`unknown gguf type ${type}`);
      off += w;
    };

    for (let i = 0; i < kvCount; i += 1) {
      str();
      skipValue(u32());
      if (off > buf.length) return null;
    }

    let total = 0;
    for (let i = 0; i < tensorCount; i += 1) {
      str();
      const nDims = u32();
      if (!Number.isFinite(nDims) || nDims < 1 || nDims > 8) return null;
      let n = 1;
      for (let d = 0; d < nDims; d += 1) n *= u64();
      u32(); // ggml type
      u64(); // offset
      total += n;
      if (off > buf.length) return null;
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** Read enough of a GGUF file to reach the end of its tensor table. */
export async function paramsFromGgufFile(path, { window = 16 * 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await openFile(path, 'r');
    const buf = Buffer.alloc(window);
    const { bytesRead } = await handle.read(buf, 0, window, 0);
    return paramsFromGgufBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The parameter count a repo NAME claims: `Qwen3.8-27B`, `gemma-3-4b-it`.
 *
 * Returned only as a claim, never as a count. A name is a convention that
 * nobody enforces, it survives a repack into a different size, and it is the
 * exact kind of digit-scraping this feature was asked to prefer metadata over.
 */
export function paramsFromName(repoId) {
  const name = String(repoId ?? '').split('/').pop() ?? '';
  // Anchored to a separator so `Qwen3-4B` reads 4B and the `3` in `Qwen3` is
  // not mistaken for a size. A range like `A3B` (active params of an MoE) is
  // deliberately not matched: it is not the model's parameter count.
  const m = /(?:^|[-_.])(\d+(?:\.\d+)?)\s*[bB](?:[-_.]|$)/.exec(name);
  if (!m) return null;
  const billions = Number(m[1]);
  if (!Number.isFinite(billions) || billions <= 0 || billions > 100000) return null;
  return Math.round(billions * 1e9);
}

/**
 * How many parameters this snapshot holds, and how we know.
 *
 * @returns {Promise<{params: number|null, source: string|null}>}
 */
export async function readModelParams(snapDir, { entries = [], repoId = null } = {}) {
  let quantBits = null;
  let groupSize = null;
  try {
    const config = JSON.parse(await readFile(join(snapDir, 'config.json'), 'utf8'));
    const quant = config?.quantization ?? config?.quantization_config;
    const bits = Number(quant?.bits);
    const group = Number(quant?.group_size);
    if (Number.isFinite(bits) && bits > 0) quantBits = bits;
    if (Number.isFinite(group) && group > 0) groupSize = group;
  } catch {
    quantBits = null;
  }

  // 1. The producer's own number, if they wrote one down.
  const indexName = entries.find(n => /\.index\.json$/i.test(n));
  if (indexName) {
    try {
      const index = JSON.parse(await readFile(join(snapDir, indexName), 'utf8'));
      const stated = Number(index?.metadata?.total_parameters);
      if (Number.isFinite(stated) && stated > 0) {
        return { params: stated, source: PARAM_SOURCES.INDEX };
      }
    } catch {
      // Unreadable index; the tensors themselves still answer.
    }
  }

  // 2. Count the tensors. Every shard, because a sum over one is a fraction.
  const safetensors = entries.filter(n => /\.safetensors$/i.test(n));
  if (safetensors.length) {
    let total = 0;
    let ok = true;
    for (const name of safetensors) {
      const header = await readSafetensorsHeader(join(snapDir, name));
      const n = paramsFromSafetensorsHeader(header, { bits: quantBits, groupSize });
      if (n === null) { ok = false; break; }
      total += n;
    }
    if (ok && total > 0) return { params: total, source: PARAM_SOURCES.SAFETENSORS };
  }

  // 3. GGUF says so itself.
  const gguf = entries.find(n => /\.gguf$/i.test(n));
  if (gguf) {
    const n = await paramsFromGgufFile(join(snapDir, gguf));
    // A sharded GGUF's first file holds only its own tensors, so the count
    // would be a fraction of the model. Only an unsharded file answers here.
    if (n && !SHARD_OF.test(gguf) && !SHARD_BARE.test(gguf)) {
      return { params: n, source: PARAM_SOURCES.GGUF };
    }
  }

  // 4. What the name claims, clearly labelled as a claim.
  const named = paramsFromName(repoId);
  return named ? { params: named, source: PARAM_SOURCES.NAME } : { params: null, source: null };
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

  const { params, source: paramsSource } = await readModelParams(snapDir, { entries, repoId });

  return {
    repoId,
    dir,
    revision: sha,
    weightBytes,
    totalBytes,
    weightFiles: weightFiles.sort(),
    params,
    paramsSource,
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

    const repoId = shard ? shard[1] : name.replace(/\.gguf$/i, '');
    const params = shard ? paramsFromName(repoId) : await paramsFromGgufFile(join(dir, name));
    out.push({
      repoId,
      dir,
      revision: null,
      weightBytes,
      totalBytes: weightBytes,
      weightFiles: [name],
      params,
      paramsSource: params ? (shard ? PARAM_SOURCES.NAME : PARAM_SOURCES.GGUF) : null,
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
export function rank({
  repoId, servedIds = [], listedIds = [], onDisk = null, budget = null, now = null, manual = false,
}) {
  const served = new Set([...servedIds].map(s => String(s).trim()).filter(Boolean));
  const listed = new Set([...listedIds].map(s => String(s).trim()).filter(Boolean));
  const base = {
    model: repoId,
    sizeGb: onDisk ? round1(onDisk.weightBytes / BYTES_PER_GB) : undefined,
    // A chip reads "27B, 27.5 GB" rather than a bare repo name - but only
    // when the count came from somewhere. `paramsSource` says where, so a
    // number scraped off the name never renders like one that was counted.
    //
    // And never for an incomplete download. Summing the tensors of the shards
    // that happen to have arrived produces a real number for a model that
    // does not exist yet, which is the same overclaim as calling it available.
    ...(onDisk?.params && onDisk.complete
      ? { paramsB: round1(onDisk.params / 1e9), paramsSource: onDisk.paramsSource }
      : {}),
    budgetGb: Number.isFinite(budget?.bytes) ? round1(budget.bytes / BYTES_PER_GB) : undefined,
    budgetSource: budget?.source ?? BUDGET_SOURCES.UNKNOWN,
    availableNowGb: Number.isFinite(now?.bytes) ? round1(now.bytes / BYTES_PER_GB) : undefined,
  };

  if (served.has(repoId)) {
    return { ...base, state: AVAILABILITY.SERVED, label: LABELS[AVAILABILITY.SERVED], reason: null };
  }

  if (onDisk) {
    // The disk outranks a listing. A server advertising a half-downloaded
    // model does not make it more downloaded, and this branch is what stops
    // `mlx_lm`'s catalogue from ever reaching a card as anything reassuring.
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

  // Listed, and no bytes of it here to check. Weaker than anything the disk
  // could have said, which is why it is tested only after the disk.
  if (listed.has(repoId)) {
    return {
      ...base,
      state: AVAILABILITY.LISTED,
      label: LABELS[AVAILABILITY.LISTED],
      reason: 'a server advertises this id; nothing here proves it is loaded',
    };
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
  listedIds = [],
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

  const ids = new Set([
    ...byId.keys(),
    ...[...servedIds].map(s => String(s).trim()).filter(Boolean),
    ...[...listedIds].map(s => String(s).trim()).filter(Boolean),
  ]);
  if (manualName) ids.add(String(manualName).trim());

  const models = [...ids].map(repoId => rank({
    repoId,
    servedIds,
    listedIds,
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

  // Size and parameters travel with whatever the best state is, including a
  // served one: "27B, 27.5 GB" is useful on every card, and it is measured
  // from the disk either way. Omitted whole when not derived - a chip with no
  // number is better than a chip with a number nobody counted.
  const shape = {
    ...(best.sizeGb === undefined ? {} : { model_size_gb: best.sizeGb }),
    ...(best.paramsB === undefined ? {} : { model_params_b: best.paramsB, model_params_source: best.paramsSource }),
  };

  if (best.state === AVAILABILITY.SERVED) return { model_state: best.state, ...shape };

  if (best.state === AVAILABILITY.FITS_NOW) {
    return { model_state: best.state, model_available: best.model, model_needs_gb: 0, ...shape };
  }

  if (best.state === AVAILABILITY.FITS_IF_FREED) {
    return {
      model_state: best.state,
      model_available: best.model,
      model_needs_gb: best.needsGb,
      ...(best.holder ? { model_held_by: best.holder.name } : {}),
      ...shape,
    };
  }

  return { model_state: best.state, ...shape };
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

  /**
   * Would it be safe to ask this model to generate one token?
   *
   * The veto the served-model probe wires itself to. Asking a server to
   * generate names a model, and on a server that loads on demand naming it is
   * an instruction to load it - so the only safe candidate is one whose bytes
   * are all here and which fits the memory available right now. An incomplete
   * download, an oversized model, or a box that cannot measure itself all
   * answer false, which leaves the verdict at LISTED. Unknowns fail closed
   * here too.
   */
  couldLoad(modelId) {
    const id = String(modelId ?? '').trim();
    if (!id) return false;
    return this.lastResult().models.some(
      m => m.model === id && (m.state === AVAILABILITY.FITS_NOW || m.state === AVAILABILITY.SERVED)
    );
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
