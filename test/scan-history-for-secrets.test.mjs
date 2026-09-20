// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for scripts/scan-history-for-secrets.mjs.
//
// A scanner that cannot fail is worse than no scanner: it turns an unchecked
// push into a blessed one. So the tests here are mostly about proving the tool
// is CAPABLE of saying no - it finds a deleted secret, it refuses to call a
// shallow clone clean, it refuses to call an unreadable object clean - and one
// test proves it is capable of saying yes, because a scanner that always fails
// gets switched off within a week.
//
// Every fixture secret is synthetic and assembled at runtime from harmless
// pieces (see synthetic()), so this test file never itself contains a
// credential-shaped string. This repo is public; a "fake" key in a fixture is
// still a key-shaped thing in a public clone, and it would also be found by
// the scanner scanning its own repo, forever.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(repoRoot, 'scripts', 'scan-history-for-secrets.mjs');
const stageableScanner = path.join(repoRoot, 'scripts', 'check-stageable-secrets.mjs');

const EXIT = { CLEAN: 0, FOUND: 1, USAGE: 2, INCOMPLETE: 3, SHALLOW: 4 };

// Global/system git config is neutralised so a developer's core.hooksPath,
// commit.gpgsign or init.defaultBranch cannot reach into these fixtures.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'iak test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'iak test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  // realpathSync: macOS tmpdir() is behind /var -> /private/var, and git
  // reports its own resolved toplevel.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-q', '-m', message]);
}

function newRepo(prefix) {
  const dir = tempDir(prefix);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

/**
 * A credential-SHAPED string that is obviously not a credential, assembled at
 * runtime so the literal never appears in this file or in the repo.
 */
function synthetic(marker) {
  return ['sk', 'TESTONLY', marker, '0'.repeat(16)].join('-');
}

function runScanner(args) {
  return spawnSync('node', [scanner, ...args], { encoding: 'utf8', env: GIT_ENV });
}

// ---------------------------------------------------------------------------
// The test this tool exists for.
// ---------------------------------------------------------------------------

test('finds a secret that was committed and then DELETED in a later commit', () => {
  const dir = newRepo('iak-hist-deleted-');
  const secret = synthetic('DELETED');

  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  commitAll(dir, 'initial');

  writeFileSync(path.join(dir, 'leaked-config.json'), `{\n  "key": "${secret}"\n}\n`);
  commitAll(dir, 'oops');

  rmSync(path.join(dir, 'leaked-config.json'));
  commitAll(dir, 'remove the config again');

  // Sanity: the working tree is clean now, which is exactly why the
  // working-tree scanner cannot see this and this one must.
  assert.equal(git(dir, ['status', '--porcelain']).trim(), '');
  assert.ok(!readFileSync(path.join(dir, 'README.md'), 'utf8').includes(secret));

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.FOUND, `expected FOUND, got ${r.status}: ${r.stderr}`);

  const report = JSON.parse(r.stdout);
  assert.equal(report.verdict, 'found');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'leaked-config.json');
  assert.equal(report.findings[0].rule, 'OpenAI-style secret key');
  assert.match(report.findings[0].blob, /^[0-9a-f]{40}$/);
  // The commit is attributed, so a human can go and look in private.
  assert.match(report.findings[0].commit, /^[0-9a-f]{40}$/);
  assert.equal(git(dir, ['log', '--format=%s', '-1', report.findings[0].commit]).trim(), 'oops');
  assert.equal(report.examined.commits, 3);
});

test('no matched value appears in stdout, stderr or the JSON', () => {
  const dir = newRepo('iak-hist-noleak-');
  const secret = synthetic('NOPRINT');
  writeFileSync(path.join(dir, 'leaked-config.json'), `api_key = "${secret}"\n`);
  commitAll(dir, 'oops');
  rmSync(path.join(dir, 'leaked-config.json'));
  commitAll(dir, 'delete it');

  for (const args of [[dir], [dir, '--json']]) {
    const r = runScanner(args);
    assert.equal(r.status, EXIT.FOUND, `expected FOUND for ${args.join(' ')}`);
    const blob = `${r.stdout}\n${r.stderr}`;
    // The whole value, obviously...
    assert.ok(!blob.includes(secret), `value leaked into output of ${args.join(' ')}`);
    // ...and no prefix of it either. A "redacted" first-six-characters hint is
    // still six characters of a live key in a CI transcript.
    for (let n = 8; n <= secret.length; n++) {
      assert.ok(!blob.includes(secret.slice(0, n)), `${n}-char prefix leaked`);
    }
    assert.ok(!blob.includes('TESTONLY'), 'a distinctive fragment of the value leaked');
    // ...but it did tell us where to look.
    assert.ok(blob.includes('leaked-config.json'), 'the finding must still be actionable');
  }
});

// ---------------------------------------------------------------------------
// It must also be able to say yes.
// ---------------------------------------------------------------------------

test('a genuinely clean repo exits 0', () => {
  const dir = newRepo('iak-hist-clean-');
  writeFileSync(path.join(dir, 'README.md'), '# nothing to see\n');
  commitAll(dir, 'initial');
  writeFileSync(path.join(dir, 'app.mjs'), 'export const answer = 42;\n');
  commitAll(dir, 'code');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.CLEAN, `expected CLEAN, got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.verdict, 'clean');
  assert.equal(report.findings.length, 0);
  assert.equal(report.shallow, false);
  assert.equal(report.examined.commits, 2);
  // README.md (unchanged, so one blob) + app.mjs.
  assert.equal(report.examined.blobsExamined, 2, 'must say how many blobs it actually read');
});

// ---------------------------------------------------------------------------
// Fail-closed: not-checked is never reported as clean.
// ---------------------------------------------------------------------------

test('a shallow clone is reported shallow and does NOT exit clean', () => {
  const origin = newRepo('iak-hist-origin-');
  const secret = synthetic('SHALLOW');
  writeFileSync(path.join(origin, 'README.md'), '# fixture\n');
  commitAll(origin, 'initial');
  writeFileSync(path.join(origin, 'leaked-config.json'), `key=${secret}\n`);
  commitAll(origin, 'oops');
  rmSync(path.join(origin, 'leaked-config.json'));
  commitAll(origin, 'delete it');
  writeFileSync(path.join(origin, 'app.mjs'), 'export const ok = true;\n');
  commitAll(origin, 'more work');

  const parent = tempDir('iak-hist-shallow-');
  const clone = path.join(parent, 'clone');
  git(parent, ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);

  const r = runScanner([clone, '--json']);
  // The fetched tip really is clean. That is precisely the trap: the leak is
  // in the commits --depth cut off, and "clean" here would be a lie.
  assert.notEqual(r.status, EXIT.CLEAN, 'a shallow clone must never exit clean');
  assert.equal(r.status, EXIT.SHALLOW);
  const report = JSON.parse(r.stdout);
  assert.equal(report.shallow, true);
  assert.equal(report.verdict, 'shallow');
  assert.equal(report.findings.length, 0, 'the truncated history really did hide it');

  const human = runScanner([clone]);
  assert.equal(human.status, EXIT.SHALLOW);
  assert.match(human.stderr, /SHALLOW CLONE/);
  assert.match(human.stderr, /unshallow/);

  // And the same history, unshallowed, is caught.
  git(clone, ['fetch', '-q', '--unshallow']);
  const after = runScanner([clone, '--json']);
  assert.equal(after.status, EXIT.FOUND, 'the full history holds the deleted secret');
  assert.equal(JSON.parse(after.stdout).findings[0].path, 'leaked-config.json');
});

test('a genuinely undecodable object is could-not-complete, never clean', () => {
  const dir = newRepo('iak-hist-binary-');
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  // Invalid UTF-8 byte sequences, NOT merely a NUL: 0xff/0xfe cannot start a
  // UTF-8 sequence, and 0xc3 here is a truncated two-byte lead. These really
  // cannot be read as text, so they cannot be claimed as checked.
  writeFileSync(path.join(dir, 'latin.dat'), Buffer.from([0xff, 0xfe, 0x41, 0x42]));
  writeFileSync(path.join(dir, 'truncated.dat'), Buffer.from([0x41, 0xc3]));
  commitAll(dir, 'binary things');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.INCOMPLETE, `expected INCOMPLETE, got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.examined.blobsUnexamined, 2);
  const reasons = Object.fromEntries(report.unexamined.map((u) => [u.path, u.reason]));
  assert.equal(reasons['latin.dat'], 'invalid-utf8');
  assert.equal(reasons['truncated.dat'], 'invalid-utf8');

  const human = runScanner([dir]);
  assert.equal(human.status, EXIT.INCOMPLETE);
  assert.match(human.stderr, /COULD NOT COMPLETE/);
  assert.ok(!/^PASS/m.test(human.stdout), '"could not check" must never render as a pass');
});

test('a stray NUL in valid UTF-8 is SCANNED, not refused as binary', () => {
  // Regression for a real miss. bin/iak-pending.mjs in this repo's history
  // carries exactly one NUL, 12,684 bytes in, as a deliberate field separator
  // between a host and an id - NUL cannot occur in either, so neither half can
  // forge a collision. The file is valid UTF-8, `node --check` passes, and it
  // is 26 kB of readable JavaScript. The first version of this scanner refused
  // to look at any of it and called that could-not-complete, so a key sitting
  // after that byte would have been missed AND the miss would have been
  // reported as a scanning error rather than a finding.
  const dir = newRepo('iak-hist-nul-');
  const secret = synthetic('AFTERNUL');
  const body = Buffer.concat([
    Buffer.from('export function itemKey(item) { return `${item.host}'),
    Buffer.from([0x00]),
    Buffer.from(`\${item.id}\`; }\n\n// leaked below the separator\nconst apiKey = "${secret}";\n`),
  ]);
  writeFileSync(path.join(dir, 'pending.mjs'), body);
  commitAll(dir, 'a NUL separator and, later in the same file, a key');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.FOUND,
    `a file that decodes must be scanned, not refused; got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.verdict, 'found');
  assert.equal(report.unexamined.length, 0, 'a decodable file must not count as unexamined');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'pending.mjs');
  // The match is AFTER the NUL, which is the whole point.
  assert.ok(body.indexOf(Buffer.from(secret)) > body.indexOf(0),
    'fixture must place the secret after the NUL');

  // And the value still never appears in the output.
  assert.ok(!`${r.stdout}${r.stderr}`.includes('TESTONLY'));
});

test('a blob over the size cap is unexamined, not passed', () => {
  const dir = newRepo('iak-hist-big-');
  writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(4096));
  commitAll(dir, 'big file');

  const r = runScanner([dir, '--max-bytes=1024', '--json']);
  assert.equal(r.status, EXIT.INCOMPLETE);
  const report = JSON.parse(r.stdout);
  assert.equal(report.unexamined.find((u) => u.path === 'big.txt').reason, 'over-size-cap');
});

test('an exhausted time budget is could-not-complete, never clean', () => {
  const dir = newRepo('iak-hist-timeout-');
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  commitAll(dir, 'initial');

  // A budget this small is guaranteed to be gone before the first git call.
  const r = spawnSync('node', [scanner, dir, '--max-seconds=0.001', '--json'],
    { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, EXIT.INCOMPLETE, `expected INCOMPLETE, got ${r.status}: ${r.stderr}`);
  assert.notEqual(JSON.parse(r.stdout).verdict, 'clean');
});

test('a findable secret still wins over a shallow or incomplete verdict', () => {
  const dir = newRepo('iak-hist-precedence-');
  const secret = synthetic('PRECEDENCE');
  writeFileSync(path.join(dir, 'leaked-config.json'), `key=${secret}\n`);
  writeFileSync(path.join(dir, 'payload.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  commitAll(dir, 'both at once');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.FOUND);
  const report = JSON.parse(r.stdout);
  assert.equal(report.verdict, 'found');
  assert.equal(report.unexamined.length, 1, 'the unreadable blob is still reported');
});

test('a one-commit snapshot repo is told it proved almost nothing', () => {
  const dir = newRepo('iak-hist-snapshot-');
  writeFileSync(path.join(dir, 'README.md'), '# snapshot\n');
  commitAll(dir, 'snapshot');

  const r = runScanner([dir]);
  assert.equal(r.status, EXIT.CLEAN);
  assert.match(r.stdout, /1 commits/);
  assert.match(r.stdout, /DEPTH:/);
});

test('a path that is not a git repository is a usage error, not a pass', () => {
  const dir = tempDir('iak-hist-notrepo-');
  mkdirSync(path.join(dir, 'sub'));
  const r = runScanner([path.join(dir, 'sub'), '--json']);
  assert.equal(r.status, EXIT.USAGE);
  assert.equal(JSON.parse(r.stdout).verdict, 'usage');

  const bad = runScanner(['--nonsense-flag']);
  assert.equal(bad.status, EXIT.USAGE);
});

test('--help documents every exit code', () => {
  const r = runScanner(['--help']);
  assert.equal(r.status, 0);
  for (const line of [/^\s*0\s+clean/m, /^\s*1\s+found/m, /^\s*2\s+usage/m,
    /^\s*3\s+incomplete/m, /^\s*4\s+shallow/m]) {
    assert.match(r.stdout, line);
  }
});

// ---------------------------------------------------------------------------
// The two scanners must not drift apart.
// ---------------------------------------------------------------------------

test('both scanners use the same pattern list (fails if the lists diverge)', () => {
  const history = spawnSync('node', [scanner, '--print-rules'], { encoding: 'utf8', env: GIT_ENV });
  const staged = spawnSync('node', [stageableScanner, '--print-rules'],
    { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV });
  assert.equal(history.status, 0, history.stderr);
  assert.equal(staged.status, 0, staged.stderr);
  assert.ok(history.stdout.trim().length > 0, 'the rule list must not be empty');
  assert.equal(history.stdout, staged.stdout,
    'the history scanner and the stageable-file scanner disagree about what a secret looks like');

  // A runtime comparison alone would still pass if someone copy-pasted the
  // list into one of the scripts, so also assert neither owns a private copy.
  for (const file of [scanner, stageableScanner]) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /from '\.\.\/src\/secret-patterns\.mjs'/,
      `${path.basename(file)} must import the shared patterns`);
    assert.ok(!/^\s*(?:export\s+)?const\s+\w*PATTERNS\s*=\s*\[/m.test(src),
      `${path.basename(file)} declares its own pattern list - that is the drift this test exists to stop`);
  }
});
