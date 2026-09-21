// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync,
  existsSync, readFileSync, utimesSync, lstatSync, readdirSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  planRun, applyRun, discoverCandidates, loadKeepList, computeHardlinkGroups,
  validateTarget, copyUnitPureNode
} from '../src/model-tidy.mjs';

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

  it('skips a whole hardlink set if either member is not idle', () => {
    const { home, keepFile, hardlinkA, hardlinkB } = buildFixture();
    touch(join(hardlinkB, 'file.bin'), daysAgo(1)); // make B recent

    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: dockerNotInUse,
      diskFreeBytes: fixedDiskFree
    });

    const selectedPaths = plan.selected.map(r => r.path);
    assert.ok(!selectedPaths.includes(hardlinkA));
    assert.ok(!selectedPaths.includes(hardlinkB));
    const skippedA = plan.skipped.find(r => r.path === hardlinkA);
    assert.match(skippedA.reason, /hardlink set/);
  });

  it('treats ~/.cache/huggingface as in-use when docker is unreadable', () => {
    const { home, keepFile, idleRoot } = buildFixture();
    const plan = planRun({
      home,
      keepFile,
      minIdleDays: 14,
      listProcessUsers: noProcessUsers,
      listDockerBindUsers: () => ({ available: false, inUse: false, reason: 'permission denied' }),
      diskFreeBytes: fixedDiskFree
    });
    const skippedIdle = plan.skipped.find(r => r.path === idleRoot);
    assert.ok(skippedIdle, 'HF cache dir should be fail-safe skipped when docker is unreadable');
    assert.match(skippedIdle.reason, /docker not readable/);
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
});
