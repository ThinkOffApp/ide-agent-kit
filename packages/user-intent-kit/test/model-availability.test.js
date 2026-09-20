// SPDX-License-Identifier: AGPL-3.0

/**
 * "Available and fits" must never be the answer to a question we did not ask.
 *
 * Every assertion here is about an OVERCLAIM rather than a missing reading:
 * a half-downloaded model that reports available, a box that cannot measure
 * its own memory and says "fits" anyway, a model compared against the whole
 * machine as though nothing else were running, a typed-in name rendering like
 * a measured one. A test that only proves the happy path passes would let
 * every one of those through.
 *
 * The disk is a real temp directory built to look like a HuggingFace cache,
 * symlinks and all, because the symlink layout is where the sizing goes wrong.
 * The memory instruments are always fakes: a suite that needed mlx, a GPU or a
 * particular amount of free RAM would pass on one machine and be skipped
 * everywhere else, which is the same as not testing the thing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AVAILABILITY,
  BUDGET_SOURCES,
  KV_CACHE_HEADROOM_FRACTION,
  MIN_HEADROOM_BYTES,
  headroomBytes,
  classifyFit,
  rank,
  byStrength,
  heartbeatFields,
  repoIdFromCacheDir,
  missingShards,
  scanRepoDir,
  scanLocalModels,
  describeLocalModels,
  defaultSearchRoots,
  measureMemoryBudget,
  measureAvailableNow,
  parseMlxWorkingSet,
  parseWiredLimitMb,
  parseNvidiaTotalMib,
  parseVmStatAvailable,
  largestFromPs,
  PARAM_SOURCES,
  paramsFromName,
  paramsFromSafetensorsHeader,
  paramsFromGgufBuffer,
  readModelParams,
  ModelAvailabilityProbe,
} from '../src/model-availability.js';

const GiB = 1024 ** 3;
const GB = 1e9;

// --- the fixture the repo owner measured on this MacBook, 20 Sep 2026 -------
// Not invented, and the reason the fit model is two states rather than one.
const MACBOOK = Object.freeze({
  budget: 107.5 * GiB,       // Metal's recommended working set
  resident: 49.9 * GiB,      // in use right now
  available: 45.9 * GiB,     // free plus reclaimable
  model: 75.3 * GiB,         // ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit
  largestConsumer: 17.2 * GiB, // a colima VM
});

/** Installed RAM on that machine: 128 GiB, which the fleet prints as 137.4 GB. */
const INSTALLED = 137438953472;

/**
 * A vm_stat fixture built from the second set of numbers measured on the same
 * MacBook: page size 16384, 45.9 GiB in use, 80.9 GiB reclaimable. The page
 * counts below are exactly those totals.
 *
 * NOTE, and it is an open question rather than a resolved one: the two
 * fixtures in this file were handed over an hour apart and do not describe the
 * same moment - MACBOOK.available says 45.9 GiB free plus reclaimable, this
 * one says 45.9 GiB IN USE and 80.9 GiB reclaimable. Both are kept, deliberately
 * unaveraged: the first pins the fits-if-freed arithmetic that was signed off,
 * this one pins the parser.
 */
function vmStat({
  pageSize = 16384,
  free = 2_000_000,
  speculative = 3_301_862,
  purgeable = 0,
  active = 2_000_000,
  inactive = 500_000,
  wired = 300_000,
  compressor = 208_102,
  labels = {},
} = {}) {
  const l = {
    free: 'Pages free', speculative: 'Pages speculative', purgeable: 'Pages purgeable',
    active: 'Pages active', inactive: 'Pages inactive', wired: 'Pages wired down',
    compressor: 'Pages occupied by compressor', ...labels,
  };
  return [
    pageSize === null ? 'Mach Virtual Memory Statistics:' : `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
    `${l.free}: ${free}.`,
    `${l.active}: ${active}.`,
    `${l.inactive}: ${inactive}.`,
    `${l.speculative}: ${speculative}.`,
    `${l.wired}: ${wired}.`,
    `${l.purgeable}: ${purgeable}.`,
    `${l.compressor}: ${compressor}.`,
  ].join('\n');
}

// --- a real cache on disk --------------------------------------------------

const roots = [];

function cacheRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'uik-models-'));
  roots.push(dir);
  return dir;
}

/**
 * A `models--org--name` directory with the real layout: blobs holding the
 * bytes, snapshots holding symlinks into them. Anything that sizes a cache by
 * walking the snapshot without following links reads 0 here.
 */
function repo(root, id, { shards = [], blobExtras = [], index = null, size = 1024 } = {}) {
  const dir = join(root, `models--${id.replace('/', '--')}`);
  const blobs = join(dir, 'blobs');
  const sha = 'a'.repeat(40);
  const snap = join(dir, 'snapshots', sha);
  mkdirSync(blobs, { recursive: true });
  mkdirSync(snap, { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'refs', 'main'), sha);

  shards.forEach((name, i) => {
    const blob = `${String(i).padStart(2, '0')}${'b'.repeat(62)}`;
    writeFileSync(join(blobs, blob), Buffer.alloc(size));
    symlinkSync(join('..', '..', 'blobs', blob), join(snap, name));
  });
  for (const extra of blobExtras) writeFileSync(join(blobs, extra), Buffer.alloc(16));
  if (index) {
    const blob = 'i'.repeat(64);
    writeFileSync(join(blobs, blob), JSON.stringify(index));
    symlinkSync(join('..', '..', 'blobs', blob), join(snap, 'model.safetensors.index.json'));
  }
  return dir;
}

test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// --- THE CONTRACT: an unmeasurable budget is never a fit -------------------

test('a box that cannot measure its memory reports budget-unknown, never fits', () => {
  const fit = classifyFit(1 * GB, null, 500 * GB);
  assert.equal(fit.state, AVAILABILITY.BUDGET_UNKNOWN);
  assert.equal(fit.shortfallBytes, null);

  // Not fits-now, not fits-if-freed, not too-large. Even a one-byte model on a
  // box with limitless free memory: without a budget there is no claim to make.
  assert.notEqual(fit.state, AVAILABILITY.FITS_NOW);
  assert.notEqual(fit.state, AVAILABILITY.FITS_IF_FREED);
});

test('an unmeasurable macOS budget stays unknown instead of guessing from installed RAM', async () => {
  const budget = await measureMemoryBudget({
    platform: 'darwin',
    env: {},
    // No mlx, and the wired limit is 0, which means "system default" - a
    // policy, not a number.
    run: async (cmd) => (cmd.endsWith('sysctl') ? 'iogpu.wired_limit_mb: 0' : ''),
  });
  assert.equal(budget.bytes, null);
  assert.equal(budget.source, BUDGET_SOURCES.UNKNOWN);
  assert.match(budget.note, /system default/);
});

test('a model that is complete and fits the box but has no budget reads budget-unknown', () => {
  const out = rank({
    repoId: 'org/small',
    onDisk: { repoId: 'org/small', weightBytes: 2 * GB, complete: true, reasons: [] },
    budget: { bytes: null, source: BUDGET_SOURCES.UNKNOWN, note: 'nothing answered' },
    now: { bytes: 400 * GB, holder: null },
  });
  assert.equal(out.state, AVAILABILITY.BUDGET_UNKNOWN);
  assert.equal(out.label, 'on disk, memory budget unknown');
  assert.equal(out.needsGb, undefined);
});

// --- the budget itself -----------------------------------------------------

test('Metal recommended working set is the macOS budget, not installed RAM', async () => {
  const budget = await measureMemoryBudget({
    platform: 'darwin',
    env: {},
    run: async () => '115448725504',
  });
  assert.equal(budget.bytes, 115448725504);
  assert.equal(budget.source, BUDGET_SOURCES.METAL);
  // The machine has 137438953472 bytes installed. The budget is well under it,
  // and that gap is the whole reason this is not `totalmem()`.
  assert.ok(budget.bytes < 137438953472);
});

test('a raised iogpu.wired_limit_mb is used; a zero one is not', async () => {
  const raised = await measureMemoryBudget({
    platform: 'darwin',
    env: {},
    run: async (cmd) => (cmd.endsWith('sysctl') ? 'iogpu.wired_limit_mb: 120000' : ''),
  });
  assert.equal(raised.source, BUDGET_SOURCES.IOGPU_LIMIT);
  assert.equal(raised.bytes, 120000 * 1024 * 1024);

  assert.equal(parseWiredLimitMb('iogpu.wired_limit_mb: 0'), null);
  assert.equal(parseMlxWorkingSet(''), null);
  assert.equal(parseMlxWorkingSet('0'), null);
});

test('Linux takes the largest single GPU, never the sum', async () => {
  assert.equal(parseNvidiaTotalMib('81920\n81920\n'), 81920);
  const budget = await measureMemoryBudget({
    platform: 'linux',
    env: {},
    run: async () => '81920\n81920\n',
  });
  assert.equal(budget.source, BUDGET_SOURCES.NVIDIA_VRAM);
  assert.equal(budget.bytes, 81920 * 1024 * 1024);
  assert.match(budget.note, /not a sum/);
});

// --- the KV reserve --------------------------------------------------------

test('a model exactly equal to the budget does NOT fit', () => {
  const budget = 100 * GB;
  const fit = classifyFit(budget, budget, budget);
  assert.equal(fit.state, AVAILABILITY.TOO_LARGE);
});

test('the reserve is a fraction of the budget, with a floor', () => {
  assert.equal(headroomBytes(100 * GB), 100 * GB * KV_CACHE_HEADROOM_FRACTION);
  // 15% of 4 GB is 600 MB, which no server can work inside.
  assert.equal(headroomBytes(4 * GB), MIN_HEADROOM_BYTES);
});

test('the boundary is exact: usable fits, one byte more does not', () => {
  const budget = 100 * GB;
  const usable = budget - headroomBytes(budget);
  assert.equal(classifyFit(usable, budget, budget).state, AVAILABILITY.FITS_NOW);
  assert.equal(classifyFit(usable + 1, budget, budget).state, AVAILABILITY.TOO_LARGE);
});

// --- THE TWO FIT STATES, on the numbers measured from this MacBook ---------

test("the owner's measured MacBook: a 75.3 GiB model fits the box, not today", () => {
  const fit = classifyFit(MACBOOK.model, MACBOOK.budget, MACBOOK.available);

  assert.equal(fit.state, AVAILABILITY.FITS_IF_FREED);

  // "roughly 30 GB back" - the weights-alone floor the operator recognises.
  assert.equal(Math.round((fit.weightsShortfallBytes / GiB) * 10) / 10, 29.4);

  // And the honest headline: what it costs to actually SERVE it, KV included.
  assert.equal(Math.round((fit.shortfallBytes / GiB) * 10) / 10, 45.5);
  assert.ok(fit.shortfallBytes > fit.weightsShortfallBytes);
});

test('the same model on the same box becomes fits-now once the memory is back', () => {
  const freed = classifyFit(MACBOOK.model, MACBOOK.budget, 95 * GiB);
  assert.equal(freed.state, AVAILABILITY.FITS_NOW);
  assert.equal(freed.shortfallBytes, 0);
});

test('fits-if-freed always names its price, and never renders as "fits"', () => {
  const out = rank({
    repoId: 'ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit',
    onDisk: { repoId: 'x', weightBytes: MACBOOK.model, complete: true, reasons: [] },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: { name: 'colima', bytes: MACBOOK.largestConsumer } },
  });

  assert.equal(out.state, AVAILABILITY.FITS_IF_FREED);
  assert.ok(out.needsGb > 0, 'the cost is a number in the payload, not prose');
  assert.equal(out.holder.name, 'colima');
  assert.match(out.reason, /must come back/);

  // The label may say "available", but never bare "fits" - a chip that reads
  // as the strong claim is the bug this state exists to prevent.
  assert.match(out.label, /only after freeing memory/);
  assert.notEqual(out.label, 'available and fits');
});

test('"available and fits" is reserved for the claim that needs nothing stopped', () => {
  const out = rank({
    repoId: 'org/small',
    onDisk: { repoId: 'org/small', weightBytes: 2 * GB, complete: true, reasons: [] },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(out.state, AVAILABILITY.FITS_NOW);
  assert.equal(out.label, 'available and fits');
  assert.equal(out.needsGb, 0);
});

test('a model too large for the empty box is too-large, not fits-if-freed', () => {
  // No amount of quitting applications makes this one loadable, so offering a
  // number of GB to free would be advice that cannot work.
  const fit = classifyFit(200 * GiB, MACBOOK.budget, 1 * GiB);
  assert.equal(fit.state, AVAILABILITY.TOO_LARGE);
  assert.equal(fit.shortfallBytes, null);
});

// --- the live headroom instrument ------------------------------------------

test('available memory is reclaimable pages, not free pages and not memory_pressure', () => {
  const bytes = parseVmStatAvailable(vmStat(), INSTALLED);

  // free + speculative + purgeable: 80.9 GiB, reclaimable by the kernel with
  // nobody quitting anything.
  assert.equal(bytes, 86865707008);
  assert.equal(Math.round((bytes / GiB) * 10) / 10, 80.9);

  // Active pages are running applications and are NOT counted: that is the
  // difference between this and memory_pressure, which reported 86% free on
  // this very machine while 34.8 GB sat in active pages.
  assert.ok(bytes < INSTALLED);
  // In use is the sum of the app-held queues, 45.9 GiB, and NOT installed
  // minus available: vm_stat's queues account for 126.8 of the 128 GiB, and
  // quietly attributing the 1.2 GiB gap to either side would be inventing a
  // number to make two readings agree.
  const inUse = (2_000_000 + 500_000 + 300_000 + 208_102) * 16384;
  assert.equal(Math.round((inUse / GiB) * 10) / 10, 45.9);

  // And it is not bare free memory either - the cache the OS hands back is in
  // there, which is the rule host-telemetry.js sets out.
  assert.ok(bytes > 2_000_000 * 16384);
});

// --- THE PARSER MUST FAIL CLOSED -------------------------------------------
// A broken counter parser does not throw. It matches nothing, sums an empty
// set to zero, reports nothing in use, and green-lights every model on the box
// with a confident "fits now". Every case below must come back unknown.

test('a changed label format yields unknown, not infinite free memory', () => {
  const moved = vmStat({ labels: { free: 'Pages Free', speculative: 'Pages Speculative' } });
  assert.equal(parseVmStatAvailable(moved, INSTALLED), null);

  // And the state that follows from it is not a fit.
  assert.equal(classifyFit(2 * GB, 100 * GB, null).state, AVAILABILITY.HEADROOM_UNKNOWN);
});

test('empty vm_stat output yields unknown', () => {
  assert.equal(parseVmStatAvailable('', INSTALLED), null);
  assert.equal(parseVmStatAvailable(null, INSTALLED), null);
  assert.equal(parseVmStatAvailable('Mach Virtual Memory Statistics: (page size of 16384 bytes)', INSTALLED), null);
});

test('a missing page-size line yields unknown rather than an assumed 4096', () => {
  assert.equal(parseVmStatAvailable(vmStat({ pageSize: null }), INSTALLED), null);
});

test('the page size is read from the output, not hardcoded', () => {
  // The same page counts at 4096 describe a quarter of the memory. A
  // hardcoded 16384 would report 4x what the machine has.
  const small = parseVmStatAvailable(vmStat({ pageSize: 4096 }), INSTALLED / 4);
  assert.equal(small, 5_301_862 * 4096);
  assert.notEqual(small, 5_301_862 * 16384);
});

test('a reading that implies nothing is in use yields unknown', () => {
  // Every page free on a running macOS box is impossible; it is what a parser
  // that has lost the active/wired counters looks like from the outside.
  const allFree = vmStat({ free: 8_388_608, speculative: 0, purgeable: 0, active: 0, inactive: 0, wired: 0, compressor: 0 });
  assert.equal(parseVmStatAvailable(allFree, INSTALLED), null);
});

test('counters that do not account for installed RAM yield unknown', () => {
  // Half the machine missing from the queues means a counter was dropped, and
  // a plausible-looking number from a broken parse is the whole hazard.
  assert.equal(parseVmStatAvailable(vmStat(), INSTALLED * 2), null);
});

test('a Linux MemAvailable that cannot be read is unknown, never plenty', async () => {
  const now = await measureAvailableNow({
    platform: 'linux',
    sources: { availableMemBytes: () => undefined, totalMemBytes: () => INSTALLED },
  });
  assert.equal(now.bytes, null);
  assert.match(now.note, /unknown/);

  // A value above installed RAM means the field was misread.
  const absurd = await measureAvailableNow({
    platform: 'linux',
    sources: { availableMemBytes: () => INSTALLED * 2, totalMemBytes: () => INSTALLED },
  });
  assert.equal(absurd.bytes, null);
});

test('available memory is capped at the budget, because the budget is a ceiling', async () => {
  const now = await measureAvailableNow({
    platform: 'darwin',
    budgetBytes: 50 * GB,
    sources: { totalMemBytes: () => INSTALLED },
    run: async (cmd) => (cmd.endsWith('vm_stat') ? vmStat() : ''),
  });
  assert.equal(now.bytes, 50 * GB);
  assert.match(now.note, /capped at the budget/);
});

test('an unreadable memory picture is headroom-unknown, not zero and not a fit', async () => {
  const now = await measureAvailableNow({ platform: 'darwin', run: async () => '' });
  assert.equal(now.bytes, null);

  const fit = classifyFit(2 * GB, 100 * GB, null);
  assert.equal(fit.state, AVAILABILITY.HEADROOM_UNKNOWN);
  assert.equal(fit.shortfallBytes, null, 'we do not get to assert the negative either');
});

test('the largest consumer is the maximum, not whatever ps printed first', () => {
  // macOS `ps -m` orders by virtual size, so the real 18 GB holder is not the
  // first line. Trusting the order named a 1.6 GB Python as the culprit.
  const out = largestFromPs([
    '   1676768 /opt/homebrew/.../Python',
    '  18027600 /System/.../com.apple.Virtualization.VirtualMachine',
    '   1003200 /Applications/.../Google Chrome Helper',
  ].join('\n'));
  assert.equal(out.name, 'com.apple.Virtualization.VirtualMachine');
  assert.equal(out.bytes, 18027600 * 1024);
});

// --- bytes on disk ---------------------------------------------------------

test('a repo id keeps a name that contains its own double dash', () => {
  assert.equal(
    repoIdFromCacheDir('models--RepublicOfKorokke--Qwen3-4B-Instruct-2507-mlx-mxfp4'),
    'RepublicOfKorokke/Qwen3-4B-Instruct-2507-mlx-mxfp4'
  );
  assert.equal(repoIdFromCacheDir('models--org--weird--name'), 'org/weird--name');
  assert.equal(repoIdFromCacheDir('not-a-cache-dir'), null);
});

test('a snapshot of symlinks is sized from the blobs behind them, once each', async () => {
  const root = cacheRoot();
  const dir = repo(root, 'org/two-shards', {
    shards: ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors'],
    size: 4096,
  });
  const scan = await scanRepoDir(dir);

  // Not 0 (a walk that does not follow the links) and not 16384 (one that
  // follows them and double-counts a shared blob).
  assert.equal(scan.weightBytes, 8192);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.reasons, []);
});

test('a download in flight is INCOMPLETE and says why', async () => {
  const root = cacheRoot();
  const dir = repo(root, 'ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit', {
    shards: ['model-00001.safetensors', 'model-00002.safetensors', 'model-00004.safetensors'],
    blobExtras: ['deadbeef.incomplete'],
  });
  const scan = await scanRepoDir(dir);

  assert.equal(scan.complete, false);
  assert.match(scan.reasons.join('; '), /still downloading/);
  // Two independent signals, so losing either still catches it: the marker
  // file, and the hole at 00003 in MLX's un-totalled shard numbering.
  assert.match(scan.reasons.join('; '), /shards missing \(00003\)/);
});

test('an incomplete model can never be available, however well it would fit', () => {
  const out = rank({
    repoId: 'org/half',
    onDisk: { repoId: 'org/half', weightBytes: 1 * GB, complete: false, reasons: ['3 blob(s) still downloading'] },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.budget, holder: null },
  });
  assert.equal(out.state, AVAILABILITY.INCOMPLETE);
  assert.notEqual(out.state, AVAILABILITY.FITS_NOW);
  assert.equal(out.needsGb, undefined);
});

test('a shard set that states its own total is checked against it', () => {
  assert.deepEqual(missingShards(['model-00001-of-00002.safetensors']), [
    '1 of 2 shards missing (00002)',
  ]);
  assert.deepEqual(
    missingShards(['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']),
    []
  );
  // A single unsharded file makes no claim about totals and is not a gap.
  assert.deepEqual(missingShards(['model.safetensors']), []);
});

test('an index naming files that are not here marks the repo incomplete', async () => {
  const root = cacheRoot();
  const dir = repo(root, 'org/indexed', {
    shards: ['model.safetensors'],
    size: 2048,
    index: {
      metadata: { total_size: 99999999 },
      weight_map: { 'a.weight': 'model.safetensors', 'b.weight': 'model-00002.safetensors' },
    },
  });
  const scan = await scanRepoDir(dir);
  assert.equal(scan.complete, false);
  assert.match(scan.reasons.join('; '), /names 1 file\(s\) that are not here/);
  assert.match(scan.reasons.join('; '), /index states/);
});

test('a repo with no weight files is not a model at all', async () => {
  const root = cacheRoot();
  const dir = repo(root, 'org/config-only', { shards: ['config.json'] });
  assert.equal(await scanRepoDir(dir), null);
  assert.deepEqual(await scanLocalModels({ roots: [root] }), []);
});

// --- precedence ------------------------------------------------------------

test('SERVED outranks AVAILABLE for the same model on the same box', async () => {
  const root = cacheRoot();
  repo(root, 'org/loaded', { shards: ['model.safetensors'], size: 1024 });

  const { models } = await describeLocalModels({
    roots: [root],
    servedIds: ['org/loaded'],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });

  const entry = models.find(m => m.model === 'org/loaded');
  assert.equal(entry.state, AVAILABILITY.SERVED);
  assert.notEqual(entry.state, AVAILABILITY.FITS_NOW);
  assert.equal(heartbeatFields(models).model_available, undefined);
});

test('a typed-in name stays MANUAL and never borrows another model\'s evidence', async () => {
  const root = cacheRoot();
  repo(root, 'org/real', { shards: ['model.safetensors'], size: 1024 });

  const { models } = await describeLocalModels({
    roots: [root],
    manualName: 'someone/typed-this-in',
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });

  const typed = models.find(m => m.model === 'someone/typed-this-in');
  assert.equal(typed.state, AVAILABILITY.MANUAL);
  assert.equal(typed.sizeGb, undefined);
  // The real model on the same box is ranked above it, and its evidence does
  // not leak sideways onto the typed name.
  assert.ok(byStrength(models.find(m => m.model === 'org/real'), typed) < 0);
});

test('a served model on no disk we scanned is still SERVED', async () => {
  const { models } = await describeLocalModels({
    roots: [cacheRoot()],
    servedIds: ['elsewhere/loaded-from-a-path'],
    budget: { bytes: null, source: BUDGET_SOURCES.UNKNOWN },
    now: { bytes: null, holder: null },
  });
  assert.equal(models[0].state, AVAILABILITY.SERVED);
});

// --- what the heartbeat publishes ------------------------------------------

test('the heartbeat never puts an available model into the `model` field', () => {
  const fields = heartbeatFields([{
    model: 'org/big', state: AVAILABILITY.FITS_IF_FREED, needsGb: 45.5, holder: { name: 'colima', gb: 18.5 },
  }]);
  assert.equal(fields.model, undefined, '`model` means SERVED and nothing else');
  assert.equal(fields.model_available, 'org/big');
  assert.equal(fields.model_state, 'fits-if-freed');
  assert.equal(fields.model_needs_gb, 45.5);
  assert.equal(fields.model_held_by, 'colima');
});

test('a box with nothing to say publishes no keys at all', () => {
  assert.deepEqual(heartbeatFields([]), {});
  assert.deepEqual(heartbeatFields(undefined), {});
  // And a weak state publishes its state without ever naming a model.
  const weak = heartbeatFields([{ model: 'org/half', state: AVAILABILITY.INCOMPLETE }]);
  assert.equal(weak.model_available, undefined);
  assert.equal(weak.model_state, 'incomplete');
});

test('an expired scan publishes nothing rather than its old answer', async () => {
  let clock = 1000;
  const probe = new ModelAvailabilityProbe({
    now: () => clock,
    intervalMs: 1000,
    roots: [cacheRoot()],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
  });
  await probe.refresh({
    servedIds: ['org/loaded'],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(probe.current().model_state, 'served');

  clock += 10_000; // past staleAfterMs
  assert.deepEqual(probe.current(), {});
});

// --- search paths ----------------------------------------------------------

test('search roots are configurable and the default is not a single hardcoded layout', () => {
  const custom = defaultSearchRoots({ INTENT_MODEL_DIRS: '/a:/b' }, '/home/x');
  assert.deepEqual(custom, ['/a', '/b']);

  const fromHfHome = defaultSearchRoots({ HF_HOME: '/hf' }, '/home/x');
  assert.equal(fromHfHome[0], '/hf/hub');

  const fallback = defaultSearchRoots({}, '/home/x');
  assert.ok(fallback.length > 1, 'GGUF files do not all live in the hub cache');
  assert.equal(fallback[0], '/home/x/.cache/huggingface/hub');
});


// --- A LISTING IS NOT A LOADING -------------------------------------------

test('a model a server merely lists is ranked BELOW everything the disk says', async () => {
  // The September 2026 incident, end to end. mlx_lm advertised a model that
  // was still downloading; the disk knows better and the disk wins.
  const root = cacheRoot();
  repo(root, 'ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit', {
    shards: ['model-00001.safetensors', 'model-00003.safetensors'],
    blobExtras: ['deadbeef.incomplete'],
  });

  const { models } = await describeLocalModels({
    roots: [root],
    listedIds: ['ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit'],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });

  const entry = models.find(m => m.model.startsWith('ddalcu/'));
  assert.equal(entry.state, AVAILABILITY.INCOMPLETE);
  assert.notEqual(entry.state, AVAILABILITY.SERVED);
  assert.notEqual(entry.state, AVAILABILITY.LISTED);
  assert.equal(heartbeatFields(models).model_available, undefined);
});

test('a listed model with no bytes here is LISTED, and says the listing proves nothing', async () => {
  const { models } = await describeLocalModels({
    roots: [cacheRoot()],
    listedIds: ['elsewhere/advertised'],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(models[0].state, AVAILABILITY.LISTED);
  assert.match(models[0].reason, /nothing here proves it is loaded/);
  assert.equal(heartbeatFields(models).model_available, undefined);
});

test('a listing never outranks a model that actually generated', async () => {
  const root = cacheRoot();
  repo(root, 'org/loaded', { shards: ['model.safetensors'], size: 1024 });
  const { models } = await describeLocalModels({
    roots: [root],
    servedIds: ['org/loaded'],
    listedIds: ['org/loaded', 'org/merely-listed'],
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(models[0].model, 'org/loaded');
  assert.equal(models[0].state, AVAILABILITY.SERVED);
  assert.equal(models.find(m => m.model === 'org/merely-listed').state, AVAILABILITY.LISTED);
});

// --- how big is it, and do we actually know -------------------------------

test('parameters come from metadata, and a name is labelled as a guess', async () => {
  const header = {
    __metadata__: { format: 'pt' },
    'model.embed_tokens.weight': { dtype: 'BF16', shape: [1000, 64] },
    'model.layers.0.mlp.down_proj.weight': { dtype: 'BF16', shape: [64, 128] },
  };
  assert.equal(paramsFromSafetensorsHeader(header), 1000 * 64 + 64 * 128);

  // A name is a convention nobody enforces: read, but never as a count.
  assert.equal(paramsFromName('Qwen/Qwen3.8-27B'), 27e9);
  assert.equal(paramsFromName('google/gemma-3-4b-it'), 4e9);
  assert.equal(paramsFromName('org/no-size-here'), null);
  // `A3B` is an MoE's ACTIVE parameters, not the model's size.
  assert.equal(paramsFromName('Qwen/Qwen3-Coder-A3B-Instruct'), null);
});

test('a quantized weight is unpacked from its own scales, not from config.json', () => {
  // Measured on this MacBook. `Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`
  // declares a single `bits: 4` while mixing 4-bit and 8-bit tensors, and
  // trusting that declaration counted every 8-bit tensor twice - 133B for a
  // model that the scales put at 129B.
  const header = {
    // 8-bit: 4 values per uint32, so [16, 32] U32 holds 16 x 128.
    'a.weight': { dtype: 'U32', shape: [16, 32] },
    'a.scales': { dtype: 'BF16', shape: [16, 2] },
    'a.biases': { dtype: 'BF16', shape: [16, 2] },
  };
  // scales_last (2) x group_size (64) = 128 true columns.
  assert.equal(paramsFromSafetensorsHeader(header, { bits: 4, groupSize: 64 }), 16 * 128);
  // The declared bits alone would have said 8 values per word: 16 x 32 x 8.
  assert.notEqual(paramsFromSafetensorsHeader(header, { bits: 4, groupSize: 64 }), 16 * 32 * 8);

  // Scales and biases are descriptions of parameters, not parameters.
  assert.equal(paramsFromSafetensorsHeader({ 'a.scales': { dtype: 'BF16', shape: [16, 2] } }), null);
});

test('a GGUF file is counted from its own tensor table', () => {
  // Built to the spec here rather than measured: no real GGUF file was
  // available on this machine to check it against.
  const parts = [];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = v => { u64(v.length); parts.push(Buffer.from(v, 'utf8')); };

  parts.push(Buffer.from('GGUF', 'utf8'));
  u32(3);       // version
  u64(2);       // tensor count
  u64(1);       // kv count
  str('general.architecture');
  u32(8); str('qwen3');            // one string KV, to be skipped
  str('token_embd.weight'); u32(2); u64(1000); u64(64); u32(0); u64(0);
  str('blk.0.ffn_down.weight'); u32(2); u64(64); u64(128); u32(0); u64(4096);

  assert.equal(paramsFromGgufBuffer(Buffer.concat(parts)), 1000 * 64 + 64 * 128);
  assert.equal(paramsFromGgufBuffer(Buffer.from('not a gguf file at all!!')), null);
});

test('an index that states its own parameter count is believed over arithmetic', async () => {
  const root = cacheRoot();
  const dir = repo(root, 'org/stated', {
    shards: ['model.safetensors'],
    size: 2048,
    index: { metadata: { total_parameters: 4022468096 }, weight_map: { 'a.weight': 'model.safetensors' } },
  });
  const scan = await scanRepoDir(dir);
  assert.equal(scan.params, 4022468096);
  assert.equal(scan.paramsSource, PARAM_SOURCES.INDEX);
});

test('an incomplete download publishes NO parameter count', async () => {
  // Summing the shards that happen to have arrived gives a real number for a
  // model that does not exist yet - the same overclaim as calling it available.
  const out = rank({
    repoId: 'org/half',
    onDisk: {
      repoId: 'org/half', weightBytes: 30 * GB, complete: false,
      reasons: ['2 blob(s) still downloading'], params: 128.8e9, paramsSource: PARAM_SOURCES.SAFETENSORS,
    },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(out.state, AVAILABILITY.INCOMPLETE);
  assert.equal(out.paramsB, undefined);
  assert.equal(heartbeatFields([out]).model_params_b, undefined);
});

test('the heartbeat carries size and parameters, with their provenance', () => {
  const out = rank({
    repoId: 'Qwen/Qwen3.8-27B',
    onDisk: {
      repoId: 'Qwen/Qwen3.8-27B', weightBytes: 27.5 * GB, complete: true, reasons: [],
      params: 27.1e9, paramsSource: PARAM_SOURCES.SAFETENSORS,
    },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  const fields = heartbeatFields([out]);
  assert.equal(fields.model_size_gb, 27.5);
  assert.equal(fields.model_params_b, 27.1);
  assert.equal(fields.model_params_source, PARAM_SOURCES.SAFETENSORS);

  // A count nobody derived is omitted whole, never defaulted to the name.
  const bare = rank({
    repoId: 'org/anonymous',
    onDisk: { repoId: 'org/anonymous', weightBytes: 1 * GB, complete: true, reasons: [], params: null, paramsSource: null },
    budget: { bytes: MACBOOK.budget, source: BUDGET_SOURCES.METAL },
    now: { bytes: MACBOOK.available, holder: null },
  });
  assert.equal(heartbeatFields([bare]).model_params_b, undefined);
  assert.equal(heartbeatFields([bare]).model_size_gb, 1);
});

test('a name-derived count is published as unconfirmed, never as fact', async () => {
  const root = cacheRoot();
  // A GGUF shard set: the first file holds only its own tensors, so counting
  // them would give a fraction. The name is all there is, and it says so.
  const dir = repo(root, 'org/Some-27B-GGUF', { shards: ['weights-00001-of-00002.gguf', 'weights-00002-of-00002.gguf'] });
  const scan = await scanRepoDir(dir);
  assert.equal(scan.paramsSource, PARAM_SOURCES.NAME);
  assert.equal(scan.params, 27e9);
  assert.equal(PARAM_SOURCES.NAME, 'name-unconfirmed', 'the source must say so in its own name');
});
