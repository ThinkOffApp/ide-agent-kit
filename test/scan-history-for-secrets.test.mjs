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
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Entry points must not be silent through a symlink.
//
// The failure this guards against is SILENCE: the script starts, the
// run-only-if-invoked-directly guard evaluates false because node realpaths
// import.meta.url and never realpaths process.argv[1], main() is skipped, and
// node exits 0. For a security tool exit 0 means clean, so it blesses a repo it
// never looked at. macOS /tmp IS a symlink to /private/tmp, so this fires for
// every scratch dir, every worktree under /tmp and every ~/bin symlink.
// ---------------------------------------------------------------------------

/** Strip the one field that legitimately differs between two runs. */
function stableReport(stdout) {
  const report = JSON.parse(stdout);
  delete report.durationMs;
  delete report.examined.bytesExamined;
  return report;
}

test('the history scanner behaves identically through a symlinked path', () => {
  const fixture = newRepo('iak-hist-symlink-');
  const secret = synthetic('SYMLINK');
  writeFileSync(path.join(fixture, 'leaked-config.json'), `key=${secret}\n`);
  commitAll(fixture, 'oops');
  rmSync(path.join(fixture, 'leaked-config.json'));
  commitAll(fixture, 'delete it');

  // A real symlink made here, rather than relying on /tmp being one.
  const linkDir = tempDir('iak-hist-linkroot-');
  const linkedRepo = path.join(linkDir, 'repo-link');
  symlinkSync(repoRoot, linkedRepo);
  const linkedScanner = path.join(linkedRepo, 'scripts', 'scan-history-for-secrets.mjs');

  const direct = spawnSync('node', [scanner, fixture, '--json'], { encoding: 'utf8', env: GIT_ENV });
  const linked = spawnSync('node', [linkedScanner, fixture, '--json'], { encoding: 'utf8', env: GIT_ENV });

  assert.ok(linked.stdout.length > 0,
    'a scanner invoked through a symlink must not silently produce nothing');
  assert.equal(linked.status, direct.status,
    `exit code differs through a symlink: ${linked.status} vs ${direct.status}`);
  assert.equal(linked.status, EXIT.FOUND, 'and it must still be the FOUND it would report directly');
  assert.deepEqual(stableReport(linked.stdout), stableReport(direct.stdout));

  // The same trap, one level down: the file itself symlinked into a ~/bin.
  const binLink = path.join(linkDir, 'scan-history');
  symlinkSync(scanner, binLink);
  const viaBin = spawnSync('node', [binLink, fixture, '--json'], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(viaBin.status, EXIT.FOUND, 'a ~/bin-style symlink to the script must still run it');
  assert.deepEqual(stableReport(viaBin.stdout), stableReport(direct.stdout));

  // --help too: the original bug made even that produce nothing.
  const help = spawnSync('node', [linkedScanner, '--help'], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /EXIT CODES/);
});

test('the pre-commit secret gate fires through a symlinked path', () => {
  // If check-stageable-secrets.mjs no-ops, a commit carrying a credential walks
  // straight through the hook. Same assertion, because the same trap applies.
  const fixture = newRepo('iak-stage-symlink-');
  writeFileSync(path.join(fixture, 'README.md'), '# fixture\n');
  commitAll(fixture, 'initial');
  writeFileSync(path.join(fixture, 'creds.json'), `{ "api_key": "${synthetic('STAGED')}" }\n`);

  const linkDir = tempDir('iak-stage-linkroot-');
  const linkedRepo = path.join(linkDir, 'repo-link');
  symlinkSync(repoRoot, linkedRepo);

  const run = (script) => spawnSync('node', [script], { cwd: fixture, encoding: 'utf8', env: GIT_ENV });
  const direct = run(stageableScanner);
  const linked = run(path.join(linkedRepo, 'scripts', 'check-stageable-secrets.mjs'));

  assert.equal(direct.status, 1, 'the gate must fire on a stageable credential at all');
  assert.equal(linked.status, direct.status,
    'the pre-commit gate is a no-op through a symlink: a credential would pass the hook');
  assert.equal(linked.stdout, direct.stdout);
  assert.equal(linked.stderr, direct.stderr);
  assert.ok(!`${linked.stdout}${linked.stderr}`.includes('TESTONLY'), 'and it still prints no value');
});

test('no entry point hand-rolls the main-module comparison', () => {
  // We found this bug three times in one day by tripping over instances one at
  // a time. This is the sweep, kept.
  //
  // The rule is PROXIMITY, not "the file mentions isMainModule somewhere": a
  // first version of this test only checked the latter, and it passed happily
  // when the guard was reverted to the broken comparison while the (now unused)
  // import stayed behind. A check that cannot fail is not a check.
  //
  // The correct idiom never names process.argv[1] at the call site - the only
  // place that does is the shared helper.
  const helper = path.join('src', 'common', 'entrypoint.mjs'); // the one implementation
  const offenders = [];
  for (const dir of ['bin', 'scripts', 'src']) {
    for (const name of readdirSync(path.join(repoRoot, dir))) {
      if (!/\.(mjs|js|cjs)$/.test(name)) continue;
      const rel = path.join(dir, name);
      if (rel === helper) continue;
      // Drop whole-line comments before looking: this file's own header quotes
      // the broken idiom on purpose, and a doc comment is not an entry point.
      // Lines with code plus a trailing comment are still scanned, so the
      // check errs towards flagging rather than towards silence.
      const src = readFileSync(path.join(repoRoot, rel), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join(' ')
        .replace(/\s+/g, ' ');
      for (let at = src.indexOf('process.argv[1]'); at !== -1; at = src.indexOf('process.argv[1]', at + 1)) {
        const window = src.slice(Math.max(0, at - 200), at + 200);
        if (/import\.meta\.url|fileURLToPath|pathToFileURL/.test(window)) {
          offenders.push(rel);
          break;
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these compare argv[1] against import.meta.url themselves, so they no-op through a symlink: ${offenders.join(', ')}`);
});

test('the scanner CLI has no main-module guard at all', () => {
  // Structural, not behavioural: the safest guard is the one that is not there.
  const src = readFileSync(scanner, 'utf8');
  assert.ok(!/if\s*\([^)]*import\.meta\.url[^)]*\)\s*(\{|main\(\))/.test(src),
    'the entry point must call main() unconditionally');
  assert.match(src, /^main\(\);$/m);
});

test('isMainModule resolves symlinks on both sides', () => {
  const dir = tempDir('iak-ismain-');
  const real = path.join(dir, 'real-entry.mjs');
  writeFileSync(real, [
    "import { isMainModule } from " + JSON.stringify(path.join(repoRoot, 'src/common/entrypoint.mjs')) + ";",
    'process.stdout.write(isMainModule(import.meta.url) ? "MAIN" : "NOT-MAIN");',
  ].join('\n'));
  const link = path.join(dir, 'linked-entry.mjs');
  symlinkSync(real, link);

  assert.equal(spawnSync('node', [real], { encoding: 'utf8' }).stdout, 'MAIN');
  assert.equal(spawnSync('node', [link], { encoding: 'utf8' }).stdout, 'MAIN',
    'a symlinked entry point is still the main module');

  // And it must still say NOT-MAIN when actually imported.
  const importer = path.join(dir, 'importer.mjs');
  writeFileSync(importer, `import ${JSON.stringify(link)};\n`);
  assert.equal(spawnSync('node', [importer], { encoding: 'utf8' }).stdout, 'NOT-MAIN');
});

// ---------------------------------------------------------------------------
// JWTs. A Supabase service_role key is a JWT, and this scanner had no JWT rule:
// it reported "clean" on a repo whose only credential was a non-expiring
// full-access production database key. Claims are reported, the token never is.
// ---------------------------------------------------------------------------

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/**
 * A synthetic JWT. Nothing is signed: the signature segment is a fixed,
 * obviously-fake string, and every ref/sub is a TESTONLY placeholder. Never
 * paste a real token into a fixture in a public repo, including one you just
 * found somewhere else.
 */
function syntheticJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const signature = ['TESTONLY', 'not', 'a', 'real', 'signature', '0'.repeat(20)].join('-');
  return `${b64url(header)}.${b64url(payload)}.${signature}`;
}

const LIVE_SERVICE_ROLE = {
  iss: 'supabase',
  ref: 'TESTONLYPROJECTREF',
  role: 'service_role',
  iat: 1700000000,
  exp: 2085000000, // 2036
};

test('a repo whose ONLY credential is a service_role JWT is FOUND, not clean', () => {
  const dir = newRepo('iak-hist-jwt-');
  writeFileSync(path.join(dir, 'test_fetch.js'),
    `const SUPABASE_KEY = "${syntheticJwt(LIVE_SERVICE_ROLE)}";\n`);
  commitAll(dir, 'add a fetch test');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.FOUND,
    `a service_role JWT must not read as clean; got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'test_fetch.js');
  assert.match(report.findings[0].rule, /JWT/);
});

test('JWT claims are reported and the token is not', () => {
  const dir = newRepo('iak-hist-jwtclaims-');
  const token = syntheticJwt(LIVE_SERVICE_ROLE);
  writeFileSync(path.join(dir, 'client.js'), `const key = "${token}";\n`);
  commitAll(dir, 'client');

  for (const args of [[dir], [dir, '--json']]) {
    const r = runScanner(args);
    assert.equal(r.status, EXIT.FOUND);
    const output = `${r.stdout}\n${r.stderr}`;

    // The claims, which are what make the hit triageable.
    assert.ok(output.includes('service_role'), `role claim missing from ${args.join(' ')}`);
    assert.ok(output.includes('supabase'), 'iss claim missing');
    assert.ok(output.includes('TESTONLYPROJECTREF'), 'ref claim missing');

    // The token, which must never appear - whole, prefixed or segmented.
    assert.ok(!output.includes(token), 'the token leaked');
    for (let n = 8; n <= token.length; n++) {
      assert.ok(!output.includes(token.slice(0, n)), `${n}-char token prefix leaked`);
    }
    for (const segment of token.split('.')) {
      assert.ok(!output.includes(segment), 'a token segment leaked');
    }
  }

  const detail = JSON.parse(runScanner([dir, '--json']).stdout).findings[0].detail;
  assert.equal(detail.claims.role, 'service_role');
  assert.equal(detail.expired, false);
  assert.match(detail.expiresAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(detail.daysRemaining > 0);
  assert.ok(!JSON.stringify(detail).includes(token.split('.')[2]), 'the signature must not be in the JSON');
});

test('an expired JWT is reported and distinguished from a live one', () => {
  const dir = newRepo('iak-hist-jwtexp-');
  writeFileSync(path.join(dir, 'old.js'),
    `const stale = "${syntheticJwt({ ...LIVE_SERVICE_ROLE, exp: 1500000000 })}";\n`); // 2017
  writeFileSync(path.join(dir, 'new.js'),
    `const live = "${syntheticJwt(LIVE_SERVICE_ROLE)}";\n`);
  writeFileSync(path.join(dir, 'forever.js'),
    `const forever = "${syntheticJwt({ iss: 'supabase', ref: 'TESTONLYREF2', role: 'anon' })}";\n`);
  commitAll(dir, 'three tokens');

  const report = JSON.parse(runScanner([dir, '--json']).stdout);
  const byPath = Object.fromEntries(report.findings.map((f) => [f.path, f.detail]));
  assert.equal(byPath['old.js'].expired, true, 'an expired token must be marked expired');
  assert.equal(byPath['new.js'].expired, false);
  assert.equal(byPath['forever.js'].noExpiry, true, 'no exp claim is worse news, not better');

  // All three are still findings: an expired credential is a different
  // conversation, not a non-event.
  assert.equal(report.findings.length, 3);
  const human = runScanner([dir]);
  assert.match(human.stderr, /EXPIRED/);
  assert.match(human.stderr, /LIVE until/);
  assert.match(human.stderr, /NO EXPIRY CLAIM/);
});

test('a malformed eyJ-prefixed string does not crash the scanner', () => {
  const dir = newRepo('iak-hist-jwtjunk-');
  // base64 of any JSON object starts "eyJ", so eyJ-prefixed non-JWTs exist.
  writeFileSync(path.join(dir, 'junk.txt'), [
    `${b64url({ hello: 'world' })}.${'!'.repeat(20)}.${'?'.repeat(20)}`,
    `${b64url({ alg: 'HS256' })}.${'Zm9vYmFy'.repeat(3)}x.${'0'.repeat(30)}`,
    'eyJ' + 'A'.repeat(40),
    `${b64url({ alg: 'none' })}.${b64url({ exp: 'not-a-number' })}.${'0'.repeat(30)}`,
  ].join('\n') + '\n');
  commitAll(dir, 'junk');

  const r = runScanner([dir, '--json']);
  assert.ok([EXIT.CLEAN, EXIT.FOUND].includes(r.status),
    `must not crash or report incomplete; got ${r.status}: ${r.stderr}`);
  assert.doesNotThrow(() => JSON.parse(r.stdout), 'the JSON report must still be valid');
  assert.equal(JSON.parse(r.stdout).errors.length, 0);
});

test('every format the bash pre-commit hook knows is also caught here', () => {
  // The JWT miss happened because this list was ported from .githooks/pre-commit
  // and the port silently dropped four formats. Capability test, one synthetic
  // sample per format, all assembled at runtime so no credential-shaped literal
  // sits in this file.
  const samples = {
    'GroupMind agent key': 'xfb_' + 'a0'.repeat(20),
    'GroupMind room key': 'antfarm_' + 'T0'.repeat(20),
    'Anthropic API key': ['sk', 'ant', 'TESTONLY' + '0'.repeat(20)].join('-'),
    'OpenAI-style secret key': ['sk', 'TESTONLY' + '0'.repeat(20)].join('-'),
    'Google API key': 'AIza' + 'T0'.repeat(18),
    'GitHub token': 'ghp_' + 'T0'.repeat(20),
    'GitHub fine-grained PAT': 'github_pat_' + 'T0'.repeat(30),
    'xAI API key': 'xai-' + 'T0'.repeat(12),
    'Moltbook secret key': 'moltbook_sk_' + 'T0'.repeat(12),
    'AgentMail key': 'am_' + 'te_' + 'a0'.repeat(22),
    'Discord bot token': 'MT' + 'T0'.repeat(12) + '.' + 'TESTON' + '.' + 'T0'.repeat(15),
    'JWT (Supabase / Auth0 / Firebase style)': syntheticJwt(LIVE_SERVICE_ROLE),
    // Split so this file holds no credential-shaped literal, same as the rest:
    // the repo's own pre-commit hook blocks the intact header, correctly.
    'private key': '-----BEGIN RSA ' + 'PRIVATE' + ' KEY-----',
  };

  const dir = newRepo('iak-hist-formats-');
  for (const [label, sample] of Object.entries(samples)) {
    writeFileSync(path.join(dir, `${label.replace(/[^a-z0-9]+/gi, '-')}.txt`), `value = ${sample}\n`);
  }
  commitAll(dir, 'one of each');

  const report = JSON.parse(runScanner([dir, '--json']).stdout);
  const found = new Set(report.findings.map((f) => f.rule));
  const missed = Object.keys(samples).filter((label) => !found.has(label));
  assert.deepEqual(missed, [], `formats no rule catches: ${missed.join(', ')}`);
});

test('two different credentials in one blob are both reported', () => {
  // A rule high in the list used to shadow everything below it in the same
  // blob, which is a silent partial miss.
  const dir = newRepo('iak-hist-shadow-');
  writeFileSync(path.join(dir, 'both.js'),
    `const a = "${['sk', 'TESTONLY', '0'.repeat(16)].join('-')}";\n`
    + `const b = "${syntheticJwt(LIVE_SERVICE_ROLE)}";\n`);
  commitAll(dir, 'two credentials, one file');

  const report = JSON.parse(runScanner([dir, '--json']).stdout);
  const rules = report.findings.map((f) => f.rule).sort();
  assert.equal(rules.length, 2, `expected both rules to fire, got: ${rules.join(', ')}`);
  assert.ok(rules.some((r) => /JWT/.test(r)));
  assert.ok(rules.some((r) => /OpenAI/.test(r)));
});

// ---------------------------------------------------------------------------
// An encoding problem must never suppress a match.
//
// Regression for a false PASS this branch introduced and codexmb's security
// review of #123 caught: after the decode-not-sniff change, the stageable gate
// SKIPPED any file that failed strict UTF-8 decoding, so a file holding a plain
// ASCII credential beside one stray 0xff byte reported PASS - while the
// pre-branch baseline at 9b8aa8c reported FAIL on the same file. The fix for a
// could-not-check-reads-as-clean bug had reintroduced the same bug one file
// over.
// ---------------------------------------------------------------------------

test('the stageable gate still finds an ASCII credential beside an invalid byte', () => {
  // codexmb's fixture, exactly: config.txt, ASCII dummy credential, one 0xff.
  const dir = newRepo('iak-stage-lossy-');
  writeFileSync(path.join(dir, 'config.txt'), Buffer.concat([
    Buffer.from('# notes\n'),
    Buffer.from(`api_key = "${synthetic('LOSSY')}"\n`),
    Buffer.from([0xff]),
    Buffer.from('\ntrailing ascii\n'),
  ]));

  const r = spawnSync('node', [stageableScanner], { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 1,
    'a stray byte must not hide a credential from the commit gate');
  assert.match(r.stderr, /config\.txt/);
  assert.match(r.stderr, /OpenAI-style secret key/);
  // The operator is told the decode was lossy rather than it being swallowed.
  assert.match(r.stderr, /not valid UTF-8/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('TESTONLY'), 'and still no value printed');
});

test('the history scanner finds an ASCII credential in an undecodable blob AND reports it unexamined', () => {
  const dir = newRepo('iak-hist-lossy-');
  writeFileSync(path.join(dir, 'config.dat'), Buffer.concat([
    Buffer.from(`api_key = "${synthetic('LOSSYBLOB')}"\n`),
    Buffer.from([0xff, 0xfe]),
  ]));
  commitAll(dir, 'a credential in bytes that do not decode');

  const r = runScanner([dir, '--json']);
  assert.equal(r.status, EXIT.FOUND, `expected FOUND, got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  // Both claims, and they are not in tension: the ASCII was read, the bytes
  // as a whole were not.
  assert.equal(report.findings.length, 1, 'the credential must still be found');
  assert.equal(report.findings[0].path, 'config.dat');
  assert.equal(report.unexamined.length, 1, 'and the blob is still not fully examined');
  assert.equal(report.unexamined[0].reason, 'invalid-utf8');
  assert.ok(!`${r.stdout}${r.stderr}`.includes('TESTONLY'));
});

test('a media extension cannot hide text content from the scan', () => {
  // The filename is whatever git handed us: rev-list --objects names a blob
  // once, so identical content committed as both notes.txt and logo.png arrives
  // under one name, and the extension filter used to decide the blob's fate
  // from that accident.
  const dir = newRepo('iak-hist-alias-');
  const body = `key = "${synthetic('ALIAS')}"\n`;
  writeFileSync(path.join(dir, 'a-alias.png'), body); // sorts first, wins the name
  writeFileSync(path.join(dir, 'z-real.txt'), body);
  commitAll(dir, 'same content at two paths');

  const report = JSON.parse(runScanner([dir, '--json']).stdout);
  assert.equal(report.findings.length, 1, 'text content named .png must still be scanned');
  assert.equal(report.examined.blobsSkippedBinaryMedia, 0);

  // ...while a real binary image is still skipped quietly, not reported as a
  // scanning failure. Otherwise every repo with an icon exits could-not-complete.
  const imageDir = newRepo('iak-hist-realpng-');
  writeFileSync(path.join(imageDir, 'logo.png'),
    Buffer.from('89504e470d0a1a0a0000000d49484452ffd8ffe000104a46', 'hex'));
  commitAll(imageDir, 'an actual image');
  const imageReport = JSON.parse(runScanner([imageDir, '--json']).stdout);
  assert.equal(imageReport.examined.blobsSkippedBinaryMedia, 1);
  assert.equal(imageReport.unexamined.length, 0);
  assert.equal(imageReport.verdict, 'clean');
});
