// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync,
  existsSync, readFileSync, utimesSync, lstatSync, readdirSync, readlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  planRun, applyRun, discoverCandidates, loadKeepList, computeHardlinkGroups,
  validateTarget, copyUnitPureNode, recoverInterruptedMoves, detectInterruptedMoves,
  findProcessUsers, sha256File, HASH_CHUNK_BYTES
} from '../src/model-tidy.mjs';

const MODEL_TIDY_MODULE_URL = new URL('../src/model-tidy.mjs', import.meta.url).href;

/**
 * Run applyRun in a CHILD process with one option forced to hard-exit
 * (process.exit, not a throw — a try/catch in the parent's process cannot
 * intercept this, which is exactly the real-world crash swapToSymlink's
 * design has to survive: SIGKILL, OOM kill, power loss). Mirrors codexmb's
 * review probe technique verbatim: serialize the plan, embed an absolute
 * import URL, embed a literal crashing arrow function as one applyRun
 * option keyed by `crashOptionKey` ('symlinkFn', 'afterStage', or
 * 'afterSwap').
 */
function runApplyInChildWithCrash(plan, home, target, crashOptionKey) {
  const code = `import {applyRun} from ${JSON.stringify(MODEL_TIDY_MODULE_URL)}; applyRun({plan:${JSON.stringify(plan)},home:${JSON.stringify(home)},target:${JSON.stringify(target)},validateTarget:()=>({ok:true}),${crashOptionKey}:()=>process.exit(77)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
}

const tempPaths = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    rmSync(path, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

function writeFile(path, content = 'x'.repeat(1024)) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

function touch(path, when) {
  utimesSync(path, when, when);
}

/**
 * Build a fixture home tree:
 *   .cache/huggingface/hub/models--idle-model/       <- idle HF cache model (selected)
 *     blobs/<sha>                                      real file, old mtime
 *     snapshots/rev1/file.safetensors -> ../../blobs/<sha>   symlink
 *   .cache/huggingface/hub/models--recent-model/     <- too-recent, skipped
 *   .cache/huggingface/hub/models--already-tidied    <- already a symlink, skipped
 *   models/keep-me/                                   <- KEEP-listed, skipped
 *   models/hardlink-a/file.bin  <-hardlinked->  models/hardlink-b/file.bin
 *     (both old mtime; both must be selected together, as one unit)
 */
function buildFixture() {
  const home = tempDir('model-tidy-fixture-');
  const old = daysAgo(30);
  const recent = daysAgo(1);

  // idle HF cache model
  const idleRoot = join(home, '.cache/huggingface/hub/models--idle-model');
  const blobPath = join(idleRoot, 'blobs', 'abc123');
  writeFile(blobPath, 'idle-model-bytes'.repeat(100));
  touch(blobPath, old);
  mkdirSync(join(idleRoot, 'snapshots', 'rev1'), { recursive: true });
  symlinkSync(join('..', '..', 'blobs', 'abc123'), join(idleRoot, 'snapshots', 'rev1', 'model.safetensors'));

  // too-recent HF cache model
  const recentRoot = join(home, '.cache/huggingface/hub/models--recent-model');
  const recentBlob = join(recentRoot, 'blobs', 'def456');
  writeFile(recentBlob, 'recent-model-bytes'.repeat(100));
  touch(recentBlob, recent);

  // already-tidied: a symlink standing in for a models--* dir
  const tidiedTargetDir = join(home, '.cache', 'elsewhere-target');
  mkdirSync(tidiedTargetDir, { recursive: true });
  writeFile(join(tidiedTargetDir, 'blobs', 'file'), 'already moved');
  symlinkSync(tidiedTargetDir, join(home, '.cache/huggingface/hub', 'models--already-tidied'));

  // KEEP-listed dir under ~/models
  const keepRoot = join(home, 'models', 'keep-me');
  writeFile(join(keepRoot, 'weights.gguf'), 'keep-me-bytes'.repeat(100));
  touch(join(keepRoot, 'weights.gguf'), old);

  // hardlink pair under ~/models — must move together or not at all
  const hardlinkA = join(home, 'models', 'hardlink-a');
  const hardlinkB = join(home, 'models', 'hardlink-b');
  mkdirSync(hardlinkA, { recursive: true });
  mkdirSync(hardlinkB, { recursive: true });
  writeFile(join(hardlinkA, 'file.bin'), 'shared-hardlinked-bytes'.repeat(100));
  touch(join(hardlinkA, 'file.bin'), old);
  linkSync(join(hardlinkA, 'file.bin'), join(hardlinkB, 'file.bin'));

  const keepFile = join(home, 'model-tidy.keep');
  writeFileSync(keepFile, `${keepRoot}\n`);

  return { home, keepFile, idleRoot, recentRoot, keepRoot, hardlinkA, hardlinkB };
}

const noProcessUsers = () => ({ checked: true, users: [] });
const dockerNotInUse = () => ({ available: true, inUse: false, containers: [] });
const fixedDiskFree = () => 100 * 2 ** 30;

describe('discoverCandidates', () => {
  it('finds hf-cache, models-dir entries', () => {
    const { home } = buildFixture();
    const candidates = discoverCandidates(home);
    const paths = candidates.map(c => c.path);
    assert.ok(paths.some(p => p.endsWith('models--idle-model')));
    assert.ok(paths.some(p => p.endsWith('models--recent-model')));
    assert.ok(paths.some(p => p.endsWith('models--already-tidied')));
    assert.ok(paths.some(p => p.endsWith('keep-me')));
    assert.ok(paths.some(p => p.endsWith('hardlink-a')));
    assert.ok(paths.some(p => p.endsWith('hardlink-b')));
  });
});

describe('loadKeepList', () => {
  it('parses non-blank, non-comment lines', () => {
    const dir = tempDir('model-tidy-keep-');
    const f = join(dir, 'keep');
    writeFileSync(f, '# comment\n\n/some/path\n~/models/x\n');
    const entries = loadKeepList(f, '/home/petrus');
    assert.deepEqual(entries, ['/some/path', '/home/petrus/models/x']);
  });

  it('returns [] for a missing file', () => {
    assert.deepEqual(loadKeepList('/no/such/file', '/home/petrus'), []);
  });
});

describe('computeHardlinkGroups', () => {
  it('groups candidates that share an inode across different roots', () => {
    const { home, hardlinkA, hardlinkB, idleRoot } = buildFixture();
    const candidates = [
      { id: hardlinkA, path: hardlinkA },
      { id: hardlinkB, path: hardlinkB },
      { id: idleRoot, path: idleRoot }
    ];
    const { groupOf } = computeHardlinkGroups(candidates);
    assert.equal(groupOf(hardlinkA), groupOf(hardlinkB));
    assert.notEqual(groupOf(hardlinkA), groupOf(idleRoot));
  });
});

describe('planRun', () => {
  it('selects exactly the idle dir and the complete hardlink set, with correct skip reasons for everything else', () => {
    const { home, keepFile, idleRoot, recentRoot, keepRoot, hardlinkA, hardlinkB } = buildFixture();

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    const selectedPaths = plan.selected.map(r => r.path).sort();
    assert.deepEqual(selectedPaths, [hardlinkA, hardlinkB, idleRoot].sort());

    const byPath = new Map(plan.skipped.map(r => [r.path, r]));

    const tidied = [...byPath.keys()].find(p => p.endsWith('models--already-tidied'));
    assert.ok(tidied, 'already-tidied dir should be in skipped list');
    assert.match(byPath.get(tidied).reason, /already a symlink/);

    const recent = [...byPath.keys()].find(p => p === recentRoot);
    assert.ok(recent, 'recent dir should be in skipped list');
    assert.match(byPath.get(recent).reason, /min-idle-days/);

    const keep = [...byPath.keys()].find(p => p === keepRoot);
    assert.ok(keep, 'keep-listed dir should be in skipped list');
    assert.match(byPath.get(keep).reason, /KEEP list/);

    assert.equal(plan.selected.length, 3);
    assert.equal(plan.skipped.length, 3);
  });

  it('skips a whole hardlink set if either member is in use', () => {
    const { home, keepFile, hardlinkA, hardlinkB } = buildFixture();
    // Note: touching hardlinkB's file.bin mtime would also move hardlinkA's
    // mtime, since they are literally the same inode — that's not a useful
    // way to make just one member fail independently. Use a per-path check
    // (process-in-use) instead, which is genuinely independent per path.
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: (path) => (path === hardlinkB
        ? { checked: true, users: [{ pid: '9999', via: 'fd', target: join(path, 'file.bin') }] }
        : { checked: true, users: [] }),
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    const selectedPaths = plan.selected.map(r => r.path);
    assert.ok(!selectedPaths.includes(hardlinkA));
    assert.ok(!selectedPaths.includes(hardlinkB));
    const skippedA = plan.skipped.find(r => r.path === hardlinkA);
    assert.match(skippedA.reason, /hardlinked to .*which is not moving/);
    assert.match(skippedA.reason, /in use/);
    const skippedB = plan.skipped.find(r => r.path === hardlinkB);
    assert.match(skippedB.reason, /in use: pid 9999/);
  });

  it('fails closed for EVERY candidate on the box when docker is unreadable, not just the HF cache', () => {
    // Regression test for the fail-open defect: an unreadable docker used
    // to only fail-safe ~/.cache/huggingface, leaving ~/models/* and ad-hoc
    // dirs selectable even though a container could bind-mount anything.
    const { home, keepFile, idleRoot, recentRoot, keepRoot, hardlinkA } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: () => ({ available: false, inUse: false, reason: 'permission denied' }),
      diskFreeBytes: fixedDiskFree
    });

    assert.equal(plan.selected.length, 0, 'nothing should be selected while docker is unreadable');

    const skippedIdle = plan.skipped.find(r => r.path === idleRoot);
    assert.ok(skippedIdle);
    assert.match(skippedIdle.reason, /in-use status unverified: docker not readable/);

    // The bug: hardlinkA lives under ~/models, NOT under ~/.cache/huggingface.
    // It must ALSO be unverified now, box-wide.
    const skippedHardlinkA = plan.skipped.find(r => r.path === hardlinkA);
    assert.ok(skippedHardlinkA);
    assert.match(skippedHardlinkA.reason, /unverified/);

    // Rule priority is unchanged: KEEP list still wins before the docker
    // check is ever reached.
    const skippedKeep = plan.skipped.find(r => r.path === keepRoot);
    assert.match(skippedKeep.reason, /on KEEP list/);

    assert.match(plan.summaryLine, /\d+ unverified/);
    assert.ok(plan.unverifiedCount >= 3, `expected several unverified candidates, got ${plan.unverifiedCount}`);
  });

  it('positive control: with a readable process list and docker, the idle dir is still selected', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: () => ({ checked: true, users: [] }),
      listDockerBindUsers: () => ({ available: true, inUse: false, containers: [] }),
      diskFreeBytes: fixedDiskFree
    });
    const selectedIdle = plan.selected.find(r => r.path === idleRoot);
    assert.ok(selectedIdle, 'idle dir should be selected when everything is verifiably readable and idle');
    assert.equal(plan.unverifiedCount, 0);
  });

  it('fails closed when the process check cannot be fully completed (e.g. EACCES on one pid)', () => {
    const home = tempDir('model-tidy-unverified-');
    const idleA = join(home, 'models', 'idle-a');
    const idleB = join(home, 'models', 'idle-b');
    writeFile(join(idleA, 'weights.gguf'), 'a'.repeat(2048));
    writeFile(join(idleB, 'weights.gguf'), 'b'.repeat(2048));
    touch(join(idleA, 'weights.gguf'), daysAgo(30));
    touch(join(idleB, 'weights.gguf'), daysAgo(30));

    const plan = planRun({
      home,
      minIdleDays: 14,
      listProcessUsers: () => ({
        checked: false,
        users: [],
        note: 'could not read /proc for pid(s) 4242 (permission denied) — cannot rule out those processes using this path'
      }),
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    assert.equal(plan.selected.length, 0, 'nothing should be selected when process status cannot be verified');
    assert.equal(plan.skipped.length, 2);
    for (const r of plan.skipped) {
      assert.match(r.reason, /in-use status unverified: could not read \/proc/);
    }
    assert.match(plan.summaryLine, /2 unverified/);
    assert.equal(plan.unverifiedCount, 2);
  });

  it('skips a dir with an open file handle (simulated process check)', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: (path) => (path === idleRoot
        ? { checked: true, users: [{ pid: '4242', via: 'fd', target: join(path, 'blobs/abc123') }] }
        : { checked: true, users: [] }),
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    const skipped = plan.skipped.find(r => r.path === idleRoot);
    assert.ok(skipped);
    assert.match(skipped.reason, /in use: pid 4242/);
  });

  it('skips a dir bind-mounted into a running container', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: (path) => (path === idleRoot
        ? { available: true, inUse: true, containers: [{ container: 'vllm-serve', source: path, destination: '/root/.cache/huggingface' }] }
        : { available: true, inUse: false, containers: [] }),
      diskFreeBytes: fixedDiskFree
    });
    const skipped = plan.skipped.find(r => r.path === idleRoot);
    assert.ok(skipped);
    assert.match(skipped.reason, /bind-mounted into running container vllm-serve/);
  });

  it('caps total moved bytes by --max-gb, deferring smaller units', () => {
    const { home, keepFile } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      maxGb: 0, // too small for anything
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    assert.equal(plan.selected.length, 0);
    const deferred = plan.skipped.filter(r => /max-gb.*cap/.test(r.reason));
    assert.ok(deferred.length > 0);
  });

  it('skips an idle dir hardlinked to a KEEP-listed dir, even though both are otherwise idle-eligible', () => {
    // Regression test for hardlink-scan scope: the KEEP-listed copy lives
    // outside the plain "idle" candidate set (it's filtered out by the
    // KEEP rule), so the hardlink group it belongs to must still be
    // detected and the whole group skipped — never just the KEEP-listed
    // half, which would leave the idle-looking half free to move and
    // silently double disk usage.
    const { home, keepFile, idleRoot, keepRoot } = buildFixture();
    // Make idleRoot's blob and keepRoot's file share an inode.
    const idleBlobDir = join(idleRoot, 'blobs');
    const idleBlobName = readdirSync(idleBlobDir)[0];
    rmSync(join(keepRoot, 'weights.gguf'));
    linkSync(join(idleBlobDir, idleBlobName), join(keepRoot, 'weights.gguf'));

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    const selectedPaths = plan.selected.map(r => r.path);
    assert.ok(!selectedPaths.includes(idleRoot), 'idle dir must not move while hardlinked to a KEEP-listed copy');

    const skippedIdle = plan.skipped.find(r => r.path === idleRoot);
    assert.ok(skippedIdle);
    assert.match(skippedIdle.reason, /hardlinked to .*which is not moving/);
    assert.match(skippedIdle.reason, /on KEEP list/);
  });

  it('GAP 1 regression: refuses a candidate hardlinked to a file OUTSIDE every discovered root (codexmb probe, reproduced exactly)', () => {
    // Exact reproduction of the review's probe.mjs: link placed directly
    // under the fixture root, ABOVE home/models, so no discovered
    // candidate root ever contains that second path — scanning wider
    // cannot see it. Only comparing st_nlink against what we actually
    // observed can catch this.
    const root = tempDir('model-tidy-gap1-');
    const home = join(root, 'home');
    const src = join(home, 'models', 'idle');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'weights.gguf'), 'fixture-only');
    utimesSync(join(src, 'weights.gguf'), new Date(0), new Date(0));
    linkSync(join(src, 'weights.gguf'), join(root, 'outside-discovery.gguf'));

    const plan = planRun({
      home,
      listProcessUsers: () => ({ checked: true, users: [] }),
      listDockerBindUsers: () => ({ available: true, inUse: false, containers: [] }),
      diskFreeBytes: () => 0
    });

    assert.ok(!plan.selected.some(r => r.path === src), 'must not select a candidate with an invisible extra hardlink');
    const skipped = plan.skipped.find(r => r.path === src);
    assert.ok(skipped);
    assert.match(skipped.reason, /hardlinked 2 times, only 1 links found under scanned roots; refusing incomplete set/);
  });

  it('GAP 1 positive control: an idle dir whose hardlinks are ALL inside the scanned tree is still selected as a unit', () => {
    const { home, keepFile, hardlinkA, hardlinkB } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    const selectedPaths = plan.selected.map(r => r.path);
    assert.ok(selectedPaths.includes(hardlinkA));
    assert.ok(selectedPaths.includes(hardlinkB));
  });
});

// tmpdir()-based fixtures and their "target" dir are normally on the SAME
// filesystem on a dev box, so validateTarget()'s cross-filesystem refusal
// (tested for real below, with no mocking) would otherwise block every
// apply test here. The apply-flow tests inject a bypass for that one check
// so they can exercise copy/verify/symlink-swap in isolation; the
// cross-filesystem rule itself is covered by its own unmocked test.
const bypassCrossFsCheck = () => ({ ok: true });

describe('validateTarget', () => {
  it('refuses a target on the same filesystem as the source (real check, no mocking)', () => {
    const home = tempDir('model-tidy-home-');
    const target = tempDir('model-tidy-target-'); // same tmpfs as home on a dev box
    const result = validateTarget(target, home);
    assert.equal(result.ok, false);
    assert.match(result.error, /same filesystem/);
  });

  it('refuses a target that does not exist', () => {
    const home = tempDir('model-tidy-home-');
    const result = validateTarget(join(home, 'nonexistent'), home);
    assert.equal(result.ok, false);
  });
});

describe('applyRun', () => {
  it('copies, verifies, and replaces the source with a symlink for every selected unit', () => {
    const { home, keepFile, idleRoot, hardlinkA, hardlinkB } = buildFixture();
    const target = tempDir('model-tidy-target-');

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    const result = applyRun({ plan, target, home, validateTarget: bypassCrossFsCheck });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.moved.length, 2); // idle-model unit + hardlink unit

    for (const root of [idleRoot, hardlinkA, hardlinkB]) {
      assert.ok(lstatSync(root).isSymbolicLink(), `${root} should now be a symlink`);
    }

    // Content is reachable through the symlink and byte-identical.
    const blobViaSymlink = readdirSync(join(idleRoot, 'blobs'))[0];
    assert.ok(existsSync(join(idleRoot, 'blobs', blobViaSymlink)));

    // The hardlink relationship survived the move: both copies at the
    // target still share one inode (moving them independently would have
    // doubled disk usage, which is exactly what this guards against).
    const aStat = lstatSync(join(hardlinkA, 'file.bin'));
    const bStat = lstatSync(join(hardlinkB, 'file.bin'));
    assert.equal(aStat.ino, bStat.ino);
    assert.ok(aStat.nlink >= 2);
  });

  it('negative control: a corrupted target file makes apply refuse and leaves the source untouched', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const target = tempDir('model-tidy-target-');

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    // Isolate to just the idle-model unit for a focused assertion.
    plan.selected = plan.selected.filter(r => r.path === idleRoot);

    // Copy for real, then simulate corruption discovered after the copy
    // (e.g. a bad transfer / bitrot) by overwriting the blob at the target.
    function corruptAfterCopy(sourceAbsPaths, homeDir, targetRoot) {
      copyUnitPureNode(sourceAbsPaths, homeDir, targetRoot);
      for (const src of sourceAbsPaths) {
        const rel = src.slice(homeDir.length + 1);
        const targetBlobsDir = join(targetRoot, rel, 'blobs');
        if (existsSync(targetBlobsDir)) {
          const [blobName] = readdirSync(targetBlobsDir);
          const original = readFileSync(join(targetBlobsDir, blobName), 'utf8');
          // Same length as the original so this exercises the checksum
          // comparison specifically, not just the (cheaper) size check.
          writeFileSync(join(targetBlobsDir, blobName), 'X'.repeat(original.length));
        }
      }
    }

    const result = applyRun({
      plan,
      target,
      home,
      validateTarget: bypassCrossFsCheck,
      copyFn: corruptAfterCopy
    });

    assert.equal(result.ok, false);
    assert.equal(result.moved.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].step, 'verify');
    assert.ok(result.errors[0].mismatches.some(m => /checksum mismatch/.test(m.reason)));

    // Source must be completely untouched: still a real directory, not a
    // symlink, with its original (uncorrupted) content intact.
    assert.equal(lstatSync(idleRoot).isSymbolicLink(), false);
    assert.ok(existsSync(idleRoot));
    const blobDir = join(idleRoot, 'blobs');
    const [blobName] = readdirSync(blobDir);
    const content = readFileSync(join(blobDir, blobName), 'utf8');
    assert.equal(content, 'idle-model-bytes'.repeat(100));
  });

  it('crash-window negative control: if symlink creation fails after the source was staged, the source is restored byte-identical', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const target = tempDir('model-tidy-target-');

    const originalBlobName = readdirSync(join(idleRoot, 'blobs'))[0];
    const originalContent = readFileSync(join(idleRoot, 'blobs', originalBlobName), 'utf8');

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    plan.selected = plan.selected.filter(r => r.path === idleRoot);

    // Inject a failing symlink function (the same seam applyRun exposes
    // for copyFn/verifyFn/validateTarget) so swapToSymlink's real call
    // fails right after the real rename has already happened — the exact
    // crash window the fix closes.
    let callCount = 0;
    const failingSymlinkSync = () => {
      callCount++;
      throw new Error('simulated symlink failure (disk full / EIO / etc.)');
    };

    const result = applyRun({ plan, target, home, validateTarget: bypassCrossFsCheck, symlinkFn: failingSymlinkSync });
    assert.equal(result.ok, false);
    assert.equal(result.moved.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].step, 'swap');
    assert.ok(callCount > 0, 'the injected failing symlinkSync should have been invoked');

    // The source must be back at its original path, not a symlink, and
    // byte-identical — never left staged, never left half-swapped.
    assert.equal(existsSync(idleRoot), true);
    assert.equal(lstatSync(idleRoot).isSymbolicLink(), false);
    assert.equal(existsSync(idleRoot + '.tidy-moving'), false);
    const restoredContent = readFileSync(join(idleRoot, 'blobs', originalBlobName), 'utf8');
    assert.equal(restoredContent, originalContent);
  });

  it("refuses a unit with an UNJOURNALED leftover *.tidy-moving, without touching it (apply's own recovery pass only heals journaled units)", () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const target = tempDir('model-tidy-target-');
    const staging = `${idleRoot}.tidy-moving`;

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    plan.selected = plan.selected.filter(r => r.path === idleRoot);

    // Simulate a leftover with NO journal record at all (e.g. a directory
    // that just happens to be named like one of ours, or a journal file
    // that was separately lost). Recovery must never guess about this —
    // it should be reported and left alone, and apply's own pre-check
    // should then refuse the unit outright.
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'marker'), 'leftover-from-a-previous-crash');
    tempPaths.push(staging);

    let copyCalled = false;
    const result = applyRun({
      plan,
      target,
      home,
      validateTarget: bypassCrossFsCheck,
      copyFn: () => { copyCalled = true; }
    });

    assert.equal(result.ok, false);
    assert.equal(result.moved.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].step, 'pre-check');
    assert.match(result.errors[0].error, /leftover from a previous run/);
    assert.match(result.errors[0].error, /recover/);
    assert.equal(copyCalled, false, 'apply must refuse before even attempting to copy this unit');

    // Neither the original nor the leftover staging dir were touched.
    assert.ok(existsSync(idleRoot));
    assert.equal(lstatSync(idleRoot).isSymbolicLink(), false);
    assert.ok(existsSync(staging));
    assert.equal(readFileSync(join(staging, 'marker'), 'utf8'), 'leftover-from-a-previous-crash');
  });
});

describe('GAP 2: crash-safety across a hard process kill (not just a thrown exception)', () => {
  function buildSingleIdleFixture() {
    const home = tempDir('model-tidy-gap2-home-');
    const src = join(home, 'models', 'idle');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'weights.gguf'), 'gap2-fixture-bytes'.repeat(50));
    utimesSync(join(src, 'weights.gguf'), daysAgo(30), daysAgo(30));
    return { home, src };
  }

  function planFor(home) {
    return planRun({
      home,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
  }

  it("codexmb probe, kept verbatim: a hard crash during the symlink step leaves the original intact, and the invariant holds after one recovery pass", () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);
    assert.ok(plan.selected.some(r => r.path === src));

    const child = runApplyInChildWithCrash(plan, home, target, 'symlinkFn');
    assert.equal(child.status, 77);

    recoverInterruptedMoves(home);

    // codexmb's probe assertion, kept verbatim in spirit: after the crash
    // and one recovery pass, either the original path exists, or a
    // working symlink exists at src. Never neither.
    let srcIsWorkingSymlink = false;
    try {
      srcIsWorkingSymlink = lstatSync(src).isSymbolicLink() && existsSync(src);
    } catch {
      srcIsWorkingSymlink = false;
    }
    const originalPathExists = existsSync(src) && !srcIsWorkingSymlink;
    assert.ok(originalPathExists || srcIsWorkingSymlink, 'neither the original nor a working symlink exists at src');

    // This specific crash point happens before any rename, so nothing
    // should have moved at all: the original itself, untouched.
    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), false);
    assert.equal(existsSync(src + '.tidy-moving'), false);
    assert.equal(existsSync(src + '.tidy-link'), false);
  });

  it('a hard crash between the two renames is healed by completing the pending symlink swap', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
    assert.equal(child.status, 77);
    // Mid-crash snapshot: src renamed away, symlink not yet swapped in.
    assert.equal(existsSync(src), false);
    assert.ok(existsSync(`${src}.tidy-moving`));

    const recovered = recoverInterruptedMoves(home);
    assert.ok(recovered.some(r => r.path === src && r.action === 'completed-swap-and-cleaned'), JSON.stringify(recovered));

    assert.equal(existsSync(src), true, 'src must exist after recovery');
    assert.equal(lstatSync(src).isSymbolicLink(), true, 'src must be a working symlink after recovery');
    assert.equal(existsSync(`${src}.tidy-moving`), false, 'staged original should be fully cleaned up');
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
  });

  it('a hard crash after the second rename (before cleanup) is healed by finishing the cleanup', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterSwap');
    assert.equal(child.status, 77);
    // Mid-crash snapshot: the swap already completed structurally — src is
    // already a working symlink — only the old original's cleanup is
    // pending.
    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), true);
    assert.ok(existsSync(`${src}.tidy-moving`));

    const recovered = recoverInterruptedMoves(home);
    assert.ok(recovered.some(r => r.path === src && r.action === 'completed-swap-and-cleaned'), JSON.stringify(recovered));

    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), true);
    assert.equal(existsSync(`${src}.tidy-moving`), false, 'staged original should be cleaned up after recovery');
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
  });

  it('recovery is idempotent and a no-op on a healthy tree', () => {
    const { home } = buildSingleIdleFixture();
    const first = recoverInterruptedMoves(home);
    const second = recoverInterruptedMoves(home);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
  });

  it('a hard crash right after the link is verified, before either rename, is healed with the original untouched', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterLink');
    assert.equal(child.status, 77);
    assert.equal(existsSync(src), true, 'mid-crash: src untouched, no rename has happened yet');
    assert.equal(lstatSync(src).isSymbolicLink(), false);
    assert.ok(existsSync(`${src}.tidy-link`));

    const recovered = recoverInterruptedMoves(home);
    assert.ok(recovered.some(r => r.path === src && r.action === 'removed-stray-link'), JSON.stringify(recovered));

    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), false);
    assert.equal(existsSync(`${src}.tidy-link`), false);
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
  });

  function snapshotTree(root) {
    const snap = {};
    function recurse(dir) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) {
          snap[full] = { type: 'symlink', linkTarget: readlinkSync(full) };
        } else if (lst.isDirectory()) {
          recurse(full);
        } else if (lst.isFile()) {
          snap[full] = { type: 'file', size: lst.size, mtimeMs: lst.mtimeMs, sha256: sha256Sync(full) };
        }
      }
    }
    recurse(root);
    return snap;
  }
  function sha256Sync(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  it("AMENDMENT: plan is read-only — an interrupted move is reported per unit, and every byte on disk (full tree, sizes and mtimes) is untouched by plan", () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const firstPlan = planFor(home);
    const child = runApplyInChildWithCrash(firstPlan, home, target, 'afterStage');
    assert.equal(child.status, 77);
    assert.equal(existsSync(src), false, 'mid-crash sanity check: src is gone, staged+link exist');

    const before = snapshotTree(home);
    const plan = planFor(home);
    const after = snapshotTree(home);

    assert.deepEqual(after, before, 'plan must not change any byte on disk (sizes/mtimes of the full tree)');

    assert.ok(plan.interrupted.some(f => f.path === src), 'plan must report the interrupted move');
    const finding = plan.interrupted.find(f => f.path === src);
    assert.equal(finding.status, 'interrupted');
    assert.match(finding.note, /journal step 'staged'/);

    assert.ok(!plan.selected.some(r => r.path === src), 'the interrupted unit must never be selected');
    const skipped = plan.skipped.find(r => r.path === src);
    assert.ok(skipped, 'the interrupted unit must be reported in skipped, not silently dropped');
    assert.match(skipped.reason, /interrupted move found/);

    // Confirm it is really still interrupted (plan really did nothing) —
    // recovery, called separately, still has work to do.
    const recovered = recoverInterruptedMoves(home);
    assert.ok(recovered.some(r => r.path === src));
  });

  it('AMENDMENT: recovery acts only on journaled units — a directory literally named *.tidy-moving with NO journal record is never touched', () => {
    const { home } = buildSingleIdleFixture();
    const strayBase = join(home, 'models', 'someone-elses-thing');
    const stray = `${strayBase}.tidy-moving`;
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'not-ours.txt'), 'this directory is just named like one of ours, nothing to do with model-tidy');
    tempPaths.push(stray);
    const before = readFileSync(join(stray, 'not-ours.txt'), 'utf8');

    const recovered = recoverInterruptedMoves(home);

    assert.equal(existsSync(stray), true, 'the stray directory must still exist, completely untouched');
    assert.equal(readFileSync(join(stray, 'not-ours.txt'), 'utf8'), before);
    const finding = recovered.find(r => r.path === strayBase);
    assert.ok(finding, 'the stray must be reported');
    assert.equal(finding.action, 'left-alone');
    assert.match(finding.note, /no matching journal record/);
  });

  it('AMENDMENT / decision-table row 2: recovery never silently discards a staged original whose own content no longer matches the journal — with the live path (target + link) still correct, it quarantines rather than deletes or restores over the good symlink', () => {
    // NOTE: this scenario crashes 'afterStage' (between the two renames),
    // but since the pending link was already verified BEFORE it was ever
    // created, recovery completes that rename first — so by the time
    // finalizeSwapOrRestore runs, target and link are both fine. Only the
    // staged backup is damaged. That is row 2 of the decision table, not
    // row 3: an earlier version of this fix used to restore the tampered
    // staged copy over the good live symlink here, which was itself a
    // (milder) data-loss bug — see the round-3 fix.
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
    assert.equal(child.status, 77);
    const staging = `${src}.tidy-moving`;
    assert.ok(existsSync(staging));
    const goodContent = 'gap2-fixture-bytes'.repeat(50);

    // Tamper with the staged original so it no longer matches what the
    // journal recorded — recovery must not trust its own naming
    // convention over the manifest, and must not silently throw this
    // away just because a symlink elsewhere happens to resolve.
    writeFileSync(join(staging, 'weights.gguf'), 'TAMPERED-CONTENT-DOES-NOT-MATCH-MANIFEST');

    const recovered = recoverInterruptedMoves(home);
    const finding = recovered.find(r => r.path === src);
    assert.ok(finding);
    assert.equal(finding.action, 'completed-partial-staging-quarantined');
    assert.match(finding.note, /staged original was damaged/);

    // The live path must be preserved exactly as it was: a working
    // symlink to the good target.
    assert.equal(lstatSync(src).isSymbolicLink(), true, 'the live symlink must be preserved, not replaced with the tampered staged copy');
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), goodContent);

    // The damaged staging must not have been silently deleted: it must
    // now live at a quarantine path, still holding the tampered content
    // for a human to inspect — never lost.
    assert.equal(existsSync(staging), false, 'the staging path itself is gone (renamed to quarantine)');
    const quarantineDirs = readdirSync(join(home, 'models')).filter(n => n.includes('.tidy-quarantine-'));
    assert.equal(quarantineDirs.length, 1);
    const quarantinePath = join(home, 'models', quarantineDirs[0]);
    assert.equal(readFileSync(join(quarantinePath, 'weights.gguf'), 'utf8'), 'TAMPERED-CONTENT-DOES-NOT-MATCH-MANIFEST');
  });

  it("DATA-LOSS FIX, codexmb's round-2 probe kept verbatim: target corrupted after staging must not cost the last good original", () => {
    // Direct port of /tmp/codex-pr128-round2.pjlier/probe.mjs: a thrown
    // exception (not a hard kill) during afterStage interrupts the swap
    // with the original safely staged; the target is then corrupted
    // in-place; recovery must read GOOD from the source afterwards, never
    // BADD, and must never report success for a unit whose target was
    // corrupted.
    const home = tempDir('model-tidy-probe2-home-');
    const src = join(home, 'models', 'idle');
    const target = tempDir('model-tidy-probe2-target-');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'weights.gguf'), 'GOOD');
    utimesSync(join(src, 'weights.gguf'), new Date(0), new Date(0));

    const plan = planRun({
      home,
      listProcessUsers: () => ({ checked: true, users: [] }),
      listDockerBindUsers: () => ({ available: true, inUse: false, containers: [] }),
      diskFreeBytes: () => 0
    });

    const interrupted = applyRun({
      plan, target, home,
      validateTarget: () => ({ ok: true }),
      afterStage: () => { throw new Error('fixture interruption'); }
    });
    assert.equal(interrupted.ok, false, 'apply must report failure for the interrupted unit');

    // Corrupt the target after the interruption, exactly like the probe.
    writeFileSync(join(target, 'models', 'idle', 'weights.gguf'), 'BADD');

    const recovery = recoverInterruptedMoves(home);

    const sourceBytes = readFileSync(join(src, 'weights.gguf'), 'utf8');
    const stagedOriginalExists = existsSync(`${src}.tidy-moving`);

    // codexmb's exact probe assertions: source reads GOOD (never BADD),
    // and the unit is reported failed with the target flagged.
    assert.equal(sourceBytes, 'GOOD', 'source must read the last GOOD content, never the corrupted target content');
    // "staged original either restored to the source path or retained" —
    // both are acceptable; what's NOT acceptable is stagedOriginalExists
    // being false while sourceBytes came out wrong. Since sourceBytes is
    // confirmed GOOD above, either outcome for stagedOriginalExists is
    // fine as long as the unit was reported as failed, checked next.
    void stagedOriginalExists;

    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].path, src);
    assert.notEqual(recovery[0].action, 'completed-swap-and-cleaned', 'must never report success for a corrupted target');
    assert.match(recovery[0].note, /target content does not match the journaled manifest/);

    // Running recovery again must not somehow make it worse (idempotent
    // refusal, not idempotent data loss).
    const secondPass = recoverInterruptedMoves(home);
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'GOOD');
  });

  it('mirror case: target is fine but the source symlink points elsewhere — recover must not delete the staged original', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterSwap');
    assert.equal(child.status, 77);
    // Mid-crash: swap already completed correctly (src is a symlink to
    // the real target), staged original still pending cleanup.
    assert.equal(lstatSync(src).isSymbolicLink(), true);
    const staging = `${src}.tidy-moving`;
    assert.ok(existsSync(staging));
    const goodContent = readFileSync(join(src, 'weights.gguf'), 'utf8');

    // Simulate tampering: replace the correct symlink with one pointing
    // somewhere unrelated. The target itself, and the staged original,
    // are both still completely fine.
    const decoy = tempDir('model-tidy-gap2-decoy-');
    writeFileSync(join(decoy, 'weights.gguf'), 'DECOY-NOT-THE-REAL-TARGET');
    rmSync(src);
    symlinkSync(decoy, src);

    const recovered = recoverInterruptedMoves(home);
    assert.equal(recovered.length, 1, 'exactly one journaled unit is in play here');
    const match = recovered[0];
    assert.notEqual(match.action, 'completed-swap-and-cleaned', 'must never delete the staged original on the strength of an unrelated link resolving');
    assert.match(match.note, /source is not a symlink whose realpath resolves exactly to the recorded target path/);

    // The staged original must not have been discarded: it's back at src
    // (restored) or still sitting at the staging path — never gone.
    const restoredAtSrc = existsSync(src) && !lstatSync(src).isSymbolicLink() && readFileSync(join(src, 'weights.gguf'), 'utf8') === goodContent;
    const stillStaged = existsSync(staging) && readFileSync(join(staging, 'weights.gguf'), 'utf8') === goodContent;
    assert.ok(restoredAtSrc || stillStaged, 'the good staged original must survive, either restored to src or left at the staging path');
  });

  it('positive control: target and symlink both correct — recover completes the swap and cleans up', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
    assert.equal(child.status, 77);

    const recovered = recoverInterruptedMoves(home);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].action, 'completed-swap-and-cleaned');

    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), true);
    assert.equal(existsSync(`${src}.tidy-moving`), false);
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
  });

  it("the SAME corrupt-target scenario against apply's OWN final cleanup path, not only recover", () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);
    const targetFile = join(target, 'models', 'idle', 'weights.gguf');

    const result = applyRun({
      plan,
      target,
      home,
      validateTarget: bypassCrossFsCheck,
      afterSwap: () => {
        // Corrupt the target in the SAME run, right after the second
        // rename but before apply's own finalize step runs.
        writeFileSync(targetFile, 'CORRUPTED-DURING-THE-SAME-APPLY-RUN');
      }
    });

    assert.equal(result.ok, false, 'apply must report failure for this unit rather than silently succeed');
    assert.equal(result.moved.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].step, 'swap');
    assert.match(result.errors[0].error, /target content does not match the journaled manifest/);

    // The last good original must not have been lost: either restored to
    // src as a real directory, or still present at the staging path.
    const restoredAtSrc = existsSync(src) && !lstatSync(src).isSymbolicLink();
    const stillStaged = existsSync(`${src}.tidy-moving`);
    assert.ok(restoredAtSrc || stillStaged, 'the good original must survive apply refusing to finalize onto a corrupted target');
    if (restoredAtSrc) {
      assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
    }
  });

  it("decision-table row 3, reproducing codexmb's round-3 probe's own 'bad-target' scenario (afterSwap crash, not afterStage): a corrupted target still triggers restore-from-staged, never quarantine", () => {
    // Exact mechanics of round-3's probe: crash at afterSwap (src is
    // ALREADY a symlink, staged still pending cleanup), then corrupt the
    // target's content. linkOk only checks that the symlink's realpath
    // equals the recorded target PATH — it does not, and must not, imply
    // the target's CONTENT is still correct. targetOk must independently
    // fail here, landing on row 3 (restore), not row 1 or row 2.
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterSwap');
    assert.equal(child.status, 77);
    assert.equal(lstatSync(src).isSymbolicLink(), true, 'mid-crash: the swap already completed structurally');
    const staging = `${src}.tidy-moving`;
    assert.ok(existsSync(staging));

    writeFileSync(join(target, 'models', 'idle', 'weights.gguf'), 'BADD-TARGET-CONTENT');

    const recovered = recoverInterruptedMoves(home);
    const finding = recovered.find(r => r.path === src);
    assert.ok(finding);
    assert.equal(finding.action, 'restored-after-failed-verification');
    assert.match(finding.note, /target content does not match the journaled manifest/);

    assert.equal(lstatSync(src).isSymbolicLink(), false, 'row 3 restores the real directory, it does not quarantine or preserve a symlink to a corrupted target');
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
    assert.equal(existsSync(staging), false);
  });

  it('decision-table row 4: nothing verified good anywhere (target corrupted AND staging partial) — recovery deletes nothing, renames nothing, and leaves every path exactly as found', () => {
    const { home, src } = buildSingleIdleFixture();
    const target = tempDir('model-tidy-gap2-target-');
    const plan = planFor(home);

    const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
    assert.equal(child.status, 77);
    const staging = `${src}.tidy-moving`;
    assert.ok(existsSync(staging));

    // Damage BOTH copies: the target (live) and the staged backup.
    writeFileSync(join(target, 'models', 'idle', 'weights.gguf'), 'BADD-TARGET');
    rmSync(join(staging, 'weights.gguf'));

    // Snapshot only the DATA paths (source tree + target tree), not
    // model-tidy's own journal bookkeeping under home/.cache — the
    // journal is EXPECTED to record this failure (step
    // 'failed-both-copies-damaged'); what must stay byte-for-byte
    // unchanged is the actual model data.
    const snapshotData = () => ({ ...snapshotTree(join(home, 'models')), ...snapshotTree(target) });

    const before = snapshotData();
    const recovered = recoverInterruptedMoves(home);
    const after = snapshotData();

    assert.deepEqual(after, before, 'row 4 must delete nothing and rename nothing — every data path (sizes and content hashes) must be byte-for-byte unchanged');

    const finding = recovered.find(r => r.path === src);
    assert.ok(finding);
    assert.equal(finding.action, 'left-alone-nothing-verified-good');
    assert.match(finding.note, /target content does not match the journaled manifest/);
    assert.match(finding.note, /no staged original exists to fall back on|staged original itself no longer matches/);
    assert.match(finding.note, new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the report must name the affected paths so a human can recover by hand');

    // A second recovery pass must be equally inert — refusing is stable,
    // not just a one-time fluke.
    const secondPass = recoverInterruptedMoves(home);
    assert.deepEqual(snapshotData(), before);
    assert.equal(secondPass.find(r => r.path === src).action, 'left-alone-nothing-verified-good');
  });

  function journalDirFor(home) {
    return join(home, '.cache', 'ide-agent-kit', 'model-tidy-journal');
  }
  function findJournalFile(home) {
    const dir = journalDirFor(home);
    const names = readdirSync(dir).filter(n => n.endsWith('.json'));
    assert.equal(names.length, 1, `expected exactly one journal file, found ${names.length}: ${names.join(', ')}`);
    return join(dir, names[0]);
  }
  function snapshotData(home, target) {
    return { ...snapshotTree(join(home, 'models')), ...snapshotTree(target) };
  }

  describe('BLOCKER 1: never recursive-delete a path assumed to be a symlink (unlinkOwnedSymlink)', () => {
    it('site 1 (finalizeSwapOrRestore row 3, sourcePath obstacle): a REAL DIRECTORY with a sentinel file sitting where a symlink was expected is never touched', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan = planFor(home);

      // afterSwap: src is already a symlink, staged still pending cleanup.
      const child = runApplyInChildWithCrash(plan, home, target, 'afterSwap');
      assert.equal(child.status, 77);
      assert.equal(lstatSync(src).isSymbolicLink(), true);
      const staging = `${src}.tidy-moving`;
      assert.ok(existsSync(staging));

      // Force row 3/4 by corrupting the target, THEN replace src (the
      // symlink) with a real directory holding a sentinel file — as if
      // something else had put a real directory exactly where model-tidy
      // expected to find (and remove) its own symlink.
      writeFileSync(join(target, 'models', 'idle', 'weights.gguf'), 'BADD');
      rmSync(src);
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'SENTINEL.txt'), 'do not delete me');

      const before = snapshotData(home, target);
      const recovered = recoverInterruptedMoves(home);
      const after = snapshotData(home, target);

      assert.equal(existsSync(join(src, 'SENTINEL.txt')), true, 'the sentinel file must survive');
      assert.equal(readFileSync(join(src, 'SENTINEL.txt'), 'utf8'), 'do not delete me');
      assert.deepEqual(after, before, 'nothing on disk may change when a real directory sits where a symlink was expected');

      const finding = recovered.find(r => r.path === src);
      assert.ok(finding);
      assert.notEqual(finding.action, 'completed-swap-and-cleaned');
      assert.notEqual(finding.action, 'completed-partial-staging-quarantined');
    });

    it('site 2 (finalizeSwapOrRestore row 3, pending-link obstacle): a REAL DIRECTORY with a sentinel file at the .tidy-link path is refused, not recursively removed', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan = planFor(home);

      // afterStage: src missing, staged + pending link both present.
      const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
      assert.equal(child.status, 77);
      const staging = `${src}.tidy-moving`;
      const link = `${src}.tidy-link`;
      assert.ok(existsSync(staging));
      assert.equal(lstatSync(link).isSymbolicLink(), true);

      // Replace the verified pending link with a real directory + sentinel.
      rmSync(link);
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, 'SENTINEL.txt'), 'do not delete me');

      const before = snapshotData(home, target);
      const recovered = recoverInterruptedMoves(home);
      const after = snapshotData(home, target);

      assert.equal(existsSync(join(link, 'SENTINEL.txt')), true, 'the sentinel file must survive');
      assert.equal(readFileSync(join(link, 'SENTINEL.txt'), 'utf8'), 'do not delete me');
      assert.deepEqual(after, before, 'nothing on disk may change when a real directory sits where the pending link was expected');
      assert.equal(existsSync(staging), true, 'the staged original must still be there too — nothing was renamed');

      const finding = recovered.find(r => r.path === src);
      assert.ok(finding);
      assert.match(finding.note, /found a directory instead|expected an owned symlink/);
    });

    it('site 3 (recoverInterruptedMoves stray-link branch): a REAL DIRECTORY with a sentinel file at the .tidy-link path is refused, original untouched source survives', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan = planFor(home);

      // afterLink: src is STILL the real, untouched original; only a
      // verified pending link exists so far (crashed before the first
      // rename), so recovery routes through the "remove stray link, leave
      // the never-touched original alone" branch.
      const child = runApplyInChildWithCrash(plan, home, target, 'afterLink');
      assert.equal(child.status, 77);
      assert.equal(existsSync(src), true);
      assert.equal(lstatSync(src).isSymbolicLink(), false);
      const link = `${src}.tidy-link`;
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      const originalContent = readFileSync(join(src, 'weights.gguf'), 'utf8');

      rmSync(link);
      mkdirSync(link, { recursive: true });
      writeFileSync(join(link, 'SENTINEL.txt'), 'do not delete me');

      const before = snapshotData(home, target);
      const recovered = recoverInterruptedMoves(home);
      const after = snapshotData(home, target);

      assert.equal(existsSync(join(link, 'SENTINEL.txt')), true, 'the sentinel file must survive');
      assert.deepEqual(after, before, 'nothing on disk may change');
      assert.equal(existsSync(src), true);
      assert.equal(lstatSync(src).isSymbolicLink(), false);
      assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), originalContent, 'the original, never touched by the crash, must remain exactly as it was');

      const finding = recovered.find(r => r.path === src);
      assert.ok(finding);
      assert.equal(finding.action, 'left-alone');
      assert.match(finding.note, /found a directory instead|expected an owned symlink/);
    });

    it('a symlink at the pending-link path pointing somewhere OTHER than the recorded target must be refused, never unlinked', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan = planFor(home);

      const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
      assert.equal(child.status, 77);
      const staging = `${src}.tidy-moving`;
      const link = `${src}.tidy-link`;
      assert.ok(existsSync(staging));
      assert.equal(lstatSync(link).isSymbolicLink(), true);

      // Re-point the pending link at an unrelated decoy directory instead
      // of the journal's recorded target. The target itself stays GOOD.
      const decoy = tempDir('model-tidy-gap2-decoy-');
      writeFileSync(join(decoy, 'weights.gguf'), 'DECOY-NOT-THE-REAL-TARGET');
      rmSync(link);
      symlinkSync(decoy, link);

      const before = snapshotData(home, target);
      const recovered = recoverInterruptedMoves(home);
      const after = snapshotData(home, target);

      // The wrong-target symlink itself must survive, unlinked-not:
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(readlinkSync(link), decoy);
      assert.deepEqual(after, before, 'nothing on disk may change when the pending link points to the wrong place');
      assert.equal(existsSync(staging), true, 'the staged original must still be there — nothing was renamed');
      assert.equal(existsSync(src), false, 'src must still be missing — never populated from the wrong-target link');

      const finding = recovered.find(r => r.path === src);
      assert.ok(finding);
      assert.match(finding.note, /resolves to .*not the recorded target/);
    });
  });

  describe('BLOCKER 2: journal durability — unreadable journal records are reported and left alone, never acted on', () => {
    it('(a) a journal record truncated to HALF its bytes is reported unreadable by plan and recover, and every path is left unchanged', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan1 = planFor(home);
      const child = runApplyInChildWithCrash(plan1, home, target, 'afterStage');
      assert.equal(child.status, 77);

      const journalFile = findJournalFile(home);
      const original = readFileSync(journalFile, 'utf8');
      writeFileSync(journalFile, original.slice(0, Math.floor(original.length / 2)));

      const before = snapshotData(home, target);

      const plan2 = planFor(home);
      const finding = plan2.interrupted.find(f => f.journalFile === journalFile);
      assert.ok(finding, 'plan must report the unreadable journal file');
      assert.equal(finding.status, 'journal-unreadable');
      assert.match(finding.note, /truncated|not valid JSON/);

      assert.deepEqual(snapshotData(home, target), before, 'plan must not mutate anything, including for an unreadable journal');

      const recovered = recoverInterruptedMoves(home);
      const recoverFinding = recovered.find(r => r.journalFile === journalFile);
      assert.ok(recoverFinding);
      assert.equal(recoverFinding.action, 'left-alone');
      assert.match(recoverFinding.note, /unreadable/);

      assert.deepEqual(snapshotData(home, target), before, 'recover must not act on an unreadable journal record either');
    });

    it('(a) a journal record truncated to ZERO bytes (empty file) is reported unreadable, and every path is left unchanged', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan1 = planFor(home);
      const child = runApplyInChildWithCrash(plan1, home, target, 'afterStage');
      assert.equal(child.status, 77);

      const journalFile = findJournalFile(home);
      writeFileSync(journalFile, '');

      const before = snapshotData(home, target);

      const plan2 = planFor(home);
      const finding = plan2.interrupted.find(f => f.journalFile === journalFile);
      assert.ok(finding);
      assert.equal(finding.status, 'journal-unreadable');
      assert.match(finding.note, /empty/);
      assert.deepEqual(snapshotData(home, target), before);

      const recovered = recoverInterruptedMoves(home);
      const recoverFinding = recovered.find(r => r.journalFile === journalFile);
      assert.ok(recoverFinding);
      assert.equal(recoverFinding.action, 'left-alone');
      assert.match(recoverFinding.note, /unreadable/);
      assert.deepEqual(snapshotData(home, target), before);
    });

    it('(b) a stray .tmp-* journal file (left over from an interrupted journal WRITE) is never parsed as a record, and is reported', () => {
      const { home } = buildSingleIdleFixture();
      const journalDir = journalDirFor(home);
      mkdirSync(journalDir, { recursive: true });
      const strayTmp = join(journalDir, 'deadbeefdeadbeef.json.tmp-99999-abc123def456');
      writeFileSync(strayTmp, JSON.stringify({
        sourcePath: join(home, 'models', 'not-a-real-unit'),
        stagedPath: 'x', linkPath: 'y', targetPath: 'z', manifest: [], step: 'pending'
      }));

      const detected = detectInterruptedMoves(home);
      const detectedFinding = detected.find(f => f.journalFile === strayTmp);
      assert.ok(detectedFinding, 'plan-side detection must report the stray .tmp file');
      assert.match(detectedFinding.note, /incomplete journal write|\.tmp/);

      const recovered = recoverInterruptedMoves(home);
      const finding = recovered.find(r => r.journalFile === strayTmp);
      assert.ok(finding, 'recover must report the stray .tmp file too');
      assert.equal(finding.action, 'left-alone');
      assert.match(finding.note, /incomplete journal write|\.tmp/);
      assert.equal(finding.path, null, 'a stray .tmp write describes no confirmed unit — it was never parsed as a record');

      // Never touched: still sitting there exactly as it was.
      assert.equal(existsSync(strayTmp), true);
    });

    it('(c) positive control: a complete, valid journal record still drives recovery normally', () => {
      const { home, src } = buildSingleIdleFixture();
      const target = tempDir('model-tidy-gap2-target-');
      const plan = planFor(home);
      const child = runApplyInChildWithCrash(plan, home, target, 'afterStage');
      assert.equal(child.status, 77);

      const journalFile = findJournalFile(home);
      const parsed = JSON.parse(readFileSync(journalFile, 'utf8'));
      assert.equal(parsed.sourcePath, src, 'sanity: this is a real, complete, readable record');

      const detected = detectInterruptedMoves(home);
      assert.equal(detected.length, 1);
      assert.equal(detected[0].status, 'interrupted');

      const recovered = recoverInterruptedMoves(home);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].action, 'completed-swap-and-cleaned');
      assert.equal(lstatSync(src).isSymbolicLink(), true);
      assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'gap2-fixture-bytes'.repeat(50));
    });
  });
});

describe('ROUND 6 ITEM 1: findProcessUsers fails closed on a real read-boundary error, not on every race', () => {
  function buildFakeProcRoot() {
    const procRoot = tempDir('model-tidy-fakeproc-');
    mkdirSync(join(procRoot, '1234', 'fd'), { recursive: true });
    writeFileSync(join(procRoot, '1234', 'fd', '3'), '');
    writeFileSync(join(procRoot, '1234', 'cmdline'), 'unrelated-process\0--flag\0');
    return procRoot;
  }

  it('ENOENT at the fd-resolution boundary (fd vanished mid-scan) is ignorable — checked stays true, candidate remains selectable', () => {
    const procRoot = buildFakeProcRoot();
    const result = findProcessUsers('/some/candidate/path', {
      procRoot,
      realpathSync: () => {
        const e = new Error('no such file or directory');
        e.code = 'ENOENT';
        throw e;
      }
    });
    assert.equal(result.checked, true, 'ENOENT at the fd boundary must not fail the check closed');
    assert.equal(result.users.length, 0);
  });

  it('EACCES at the fd-resolution boundary marks that pid unverified and fails closed, naming the pid and the code', () => {
    const procRoot = buildFakeProcRoot();
    const result = findProcessUsers('/some/candidate/path', {
      procRoot,
      realpathSync: () => {
        const e = new Error('permission denied');
        e.code = 'EACCES';
        throw e;
      }
    });
    assert.equal(result.checked, false, 'EACCES at the fd boundary must fail the check closed');
    assert.match(result.note, /1234/, 'the note must name the pid');
    assert.match(result.note, /EACCES/, 'the note must name the error code');
  });

  it('positive control: with no read-boundary errors at all, the check completes normally', () => {
    const procRoot = buildFakeProcRoot();
    const result = findProcessUsers('/some/candidate/path', {
      procRoot,
      realpathSync: p => p // resolves to itself — never matches the candidate path, never throws
    });
    assert.equal(result.checked, true);
    assert.equal(result.users.length, 0);
  });

  it('end-to-end: planRun skips the candidate with a reason naming the pid and code when the process check is unverified', () => {
    const home = tempDir('model-tidy-r6-home-');
    const src = join(home, 'models', 'idle');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'weights.gguf'), 'x'.repeat(1024));
    utimesSync(join(src, 'weights.gguf'), daysAgo(30), daysAgo(30));

    const plan = planRun({
      home,
      minIdleDays: 14,
      listProcessUsers: () => ({ checked: false, users: [], note: '4242 EACCES — cannot rule out that process using this path' }),
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    const skipped = plan.skipped.find(r => r.path === src);
    assert.ok(skipped);
    assert.match(skipped.reason, /in-use status unverified: 4242 EACCES/);
  });
});

describe('ROUND 6 ITEM 2: sha256File hashes with bounded memory (streaming chunks), never a whole-file read', () => {
  it('hashes a file LARGER than the chunk size identically to a whole-buffer digest', () => {
    const dir = tempDir('model-tidy-hash-');
    const file = join(dir, 'big.bin');
    const size = HASH_CHUNK_BYTES + 3 * 1024 * 1024; // > 1 full chunk, plus a partial tail
    const content = randomBytes(size);
    writeFileSync(file, content);

    const streamed = sha256File(file);
    const wholeBuffer = createHash('sha256').update(content).digest('hex');
    assert.equal(streamed, wholeBuffer, 'the chunked hash must exactly match the whole-buffer hash');
  });

  it('never allocates a buffer larger than the chunk size while hashing (proves bounded memory, not a hidden readFileSync)', () => {
    const dir = tempDir('model-tidy-hash-');
    const file = join(dir, 'big2.bin');
    const size = HASH_CHUNK_BYTES * 2 + 12345; // several chunks, plus a partial tail
    const content = randomBytes(size);
    writeFileSync(file, content);

    const originalAllocUnsafe = Buffer.allocUnsafe;
    const originalAlloc = Buffer.alloc;
    const seenSizes = [];
    function guard(n) {
      seenSizes.push(n);
      if (n > HASH_CHUNK_BYTES) {
        Buffer.allocUnsafe = originalAllocUnsafe;
        Buffer.alloc = originalAlloc;
        throw new Error(`sha256File allocated ${n} bytes, more than the ${HASH_CHUNK_BYTES}-byte chunk limit — it read some or all of the file into memory at once`);
      }
    }
    Buffer.allocUnsafe = function (n) {
      guard(n);
      return originalAllocUnsafe.call(Buffer, n);
    };
    Buffer.alloc = function (n, ...rest) {
      guard(n);
      return originalAlloc.call(Buffer, n, ...rest);
    };

    let hash;
    try {
      hash = sha256File(file);
    } finally {
      Buffer.allocUnsafe = originalAllocUnsafe;
      Buffer.alloc = originalAlloc;
    }

    assert.equal(hash, createHash('sha256').update(content).digest('hex'));
    assert.ok(seenSizes.length >= 1, 'sanity: at least one allocation was observed');
    assert.ok(seenSizes.every(n => n <= HASH_CHUNK_BYTES), `every allocation must be <= ${HASH_CHUNK_BYTES} bytes; saw ${JSON.stringify(seenSizes)}`);
  });
});

describe('ROUND 6 ITEM 3: swapToSymlink pre-swap verification failure never recursively deletes an assumed symlink', () => {
  it('sentinel test: symlinkFn creates a REAL DIRECTORY at the link path instead of a symlink — it and a sentinel file inside it survive, apply fails, and the journal record says failed', () => {
    const home = tempDir('model-tidy-r6-item3-home-');
    const target = tempDir('model-tidy-r6-item3-target-');
    const src = join(home, 'models', 'idle');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'weights.gguf'), 'r6-item3-bytes'.repeat(50));
    utimesSync(join(src, 'weights.gguf'), daysAgo(30), daysAgo(30));

    const plan = planRun({
      home,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });
    assert.ok(plan.selected.some(r => r.path === src));

    const link = `${src}.tidy-link`;
    const result = applyRun({
      plan,
      target,
      home,
      validateTarget: bypassCrossFsCheck,
      symlinkFn: (dst, linkPath) => {
        // Simulate something creating a real directory exactly where
        // model-tidy expected to create — and, on verification failure,
        // remove — its own symlink.
        mkdirSync(linkPath, { recursive: true });
        writeFileSync(join(linkPath, 'SENTINEL.txt'), 'do not delete me');
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].step, 'swap');
    assert.match(result.errors[0].error, /pre-swap symlink verification failed/);
    assert.match(result.errors[0].error, /could not be safely removed/);

    // The directory and its sentinel file must survive, completely
    // untouched — never rmSync'd.
    assert.equal(existsSync(link), true);
    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(existsSync(join(link, 'SENTINEL.txt')), true);
    assert.equal(readFileSync(join(link, 'SENTINEL.txt'), 'utf8'), 'do not delete me');

    // The original source itself must also be untouched — swapToSymlink
    // never got past the pre-swap step, so nothing was ever renamed away.
    assert.equal(existsSync(src), true);
    assert.equal(lstatSync(src).isSymbolicLink(), false);
    assert.equal(readFileSync(join(src, 'weights.gguf'), 'utf8'), 'r6-item3-bytes'.repeat(50));

    // The journal record must say failed, not be silently cleared.
    const journalDir = join(home, '.cache', 'ide-agent-kit', 'model-tidy-journal');
    const names = readdirSync(journalDir).filter(n => n.endsWith('.json'));
    assert.equal(names.length, 1);
    const record = JSON.parse(readFileSync(join(journalDir, names[0]), 'utf8'));
    assert.equal(record.step, 'failed');
    assert.match(record.failureReason, /could not be safely removed/);
  });
});
