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
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                  1464197.',
    'Pages active:                                2126026.',
    'Pages inactive:                              1295757.',
    'Pages speculative:                           2334709.',
    'Pages wired down:                             465156.',
    'Pages purgeable:                               46008.',
  ].join('\n');

  const bytes = parseVmStatAvailable(vmStat);
  // free + speculative + purgeable. Reclaimable by the kernel, nobody quits
  // anything.
  assert.equal(bytes, (1464197 + 2334709 + 46008) * 16384);

  // Active pages are running applications and are NOT counted: that is the
  // difference between this and memory_pressure, which reported 86% free on
  // this very machine while 34.8 GB sat in active pages.
  assert.ok(bytes < (1464197 + 2334709 + 46008 + 2126026) * 16384);

  // And it is not bare free memory either - the cache the OS hands back is in
  // there, which is the rule host-telemetry.js sets out.
  assert.ok(bytes > 1464197 * 16384);
});

test('available memory is capped at the budget, because the budget is a ceiling', async () => {
  const now = await measureAvailableNow({
    platform: 'darwin',
    budgetBytes: 50 * GB,
    run: async (cmd) => (cmd.endsWith('vm_stat')
      ? 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100000000.\n'
      : ''),
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
