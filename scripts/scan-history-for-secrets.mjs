#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Scan REACHABLE GIT HISTORY for credentials - not the working tree.
//
// THE GAP THIS CLOSES. scripts/check-stageable-secrets.mjs reads files from
// disk and answers one question: "would `git add -A` stage a credential right
// now". That is a useful question and it is not this one. A key that was
// committed on Tuesday and deleted on Wednesday is gone from the working tree,
// gone from `git status`, gone from the file listing - and still sits in the
// pack file, one `git log -p` away from anyone who clones the repo. To the
// disk-reading scanner that repo looks spotless. It is not: it is leaking.
//
// This repo is PUBLIC, and a snapshot pushed into it is world-readable the
// instant it lands, with no private staging period in which to notice.
//
// WHAT IT DOES. Every blob reachable from every ref (`git rev-list
// --objects --all`), read through `git cat-file --batch`, matched against the
// SHARED pattern list in src/secret-patterns.mjs - shared so that the two
// scanners cannot drift apart, which is the house defect this repo already has
// a written-up history of.
//
// WHAT IT REFUSES TO DO.
//
//   1. It never prints a matched value, not partially, not redacted with a
//      prefix. Path + commit + rule name is enough to act on. A prefix is not
//      "safe", it is the first six characters of a live key in a CI log.
//
//   2. It never renders "I could not check" as "clean". An unreadable object,
//      a blob it cannot decode, a blob over the size cap, a timeout: all of
//      those exit 3 (could-not-complete), never 0. This is the single most
//      repeated bug in this codebase and it gets its own exit code.
//
//   3. It never calls a shallow clone clean. A `--depth` clone's history is
//      not absent, it is UNEXAMINED, and the blobs that were cut off are the
//      old ones - which is precisely where a deleted-but-reachable key lives.
//      Shallow exits 4 and says so at the top of the report.
//
//   4. It scans anything that DECODES. "Contains a NUL byte" is not the same
//      question as "is not text", and an early version of this file failed
//      that distinction: it refused 26 kB of valid UTF-8 JavaScript over one
//      NUL used as a field separator, and called the refusal an error instead
//      of scanning the other 26 kB. Fail-closed is about what you could not
//      read, not about bytes that merely look alarming.
//
//   5. It always says how much it looked at. A freshly created snapshot repo
//      has one commit; "history clean" after examining one commit is not
//      reassurance, it is the false confidence this tool exists to prevent.
//
// Run:  node scripts/scan-history-for-secrets.mjs [repo-path] [--json]
// Help: node scripts/scan-history-for-secrets.mjs --help

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_BYTES,
  SKIP_EXT,
  decodeUtf8,
  matchSecret,
  ruleLabels,
} from '../src/secret-patterns.mjs';

// Documented in --help. Verdict precedence when several apply:
// FOUND > INCOMPLETE > SHALLOW > CLEAN. Anything that is not a proven-clean
// full scan of a complete history is a non-zero exit.
const EXIT = {
  CLEAN: 0,
  FOUND: 1,
  USAGE: 2,
  INCOMPLETE: 3,
  SHALLOW: 4,
};

const DEFAULT_MAX_SECONDS = 600;

const HELP = `scan-history-for-secrets - look for credentials in reachable git history

USAGE
  node scripts/scan-history-for-secrets.mjs [repo-path] [options]

  repo-path   repository to scan (default: the current working directory).

OPTIONS
  --json              machine-readable report on stdout, nothing else on stdout
  --print-rules       print the rule names this build scans for, then exit 0
  --max-seconds=N     wall-clock budget (default ${DEFAULT_MAX_SECONDS}); exceeding it is
                      could-not-complete, NOT a pass
  --max-bytes=N       per-blob size cap (default ${MAX_BYTES}); a blob over the cap
                      is reported unexamined, NOT passed
  -h, --help          this text

WHAT IS SCANNED
  Every blob reachable from all refs (git rev-list --objects --all), including
  blobs whose file was deleted in a later commit. That is the whole point: a
  deleted secret is invisible to a working-tree scan and perfectly readable to
  anyone who clones the repo.

  Blobs whose path has a known binary media extension are skipped by policy and
  counted separately as NOT examined. Everything else is decoded as UTF-8 (in
  fatal mode - a stray NUL in otherwise valid text is scanned, not refused) and
  matched against the shared pattern list in src/secret-patterns.mjs - the same
  list scripts/check-stageable-secrets.mjs uses.

OUTPUT
  Findings report the blob path, the commit that introduced the blob, the blob
  sha and the rule name. The matched value is never printed, in any mode, not
  even truncated. Use the path and commit to inspect it yourself, in private.

EXIT CODES
  0  clean        every reachable blob was examined and nothing matched
  1  found        at least one match (report says where, never what)
  2  usage        bad arguments, or the path is not a git repository
  3  incomplete   something could not be checked: unreadable object, blob that
                  would not decode, blob over the size cap, git error, timeout.
                  This is NOT a pass. "I could not check" is its own answer.
  4  shallow      the clone is shallow (.git/shallow / --depth). The part that
                  was scanned may be clean; the part that was cut off is
                  unexamined, and unexamined is not clean.

  Precedence when several apply: 1 > 3 > 4 > 0.
`;

class Deadline {
  constructor(seconds) {
    this.limitMs = seconds * 1000;
    this.startedAt = Date.now();
  }
  remainingMs() {
    return this.limitMs - (Date.now() - this.startedAt);
  }
  check() {
    if (this.remainingMs() <= 0) {
      throw new Error(`time budget exceeded (${this.limitMs / 1000}s)`);
    }
  }
  elapsedMs() {
    return Date.now() - this.startedAt;
  }
}

/** Did this child process die on the clock rather than answer the question? */
function isTimeout(err) {
  if (!err) return false;
  if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') return true;
  return String(err.message ?? '').includes('time budget exceeded');
}

function makeGit(repo, deadline) {
  return function git(args, { input, encoding = 'utf8' } = {}) {
    deadline.check();
    return execFileSync('git', ['-C', repo, ...args], {
      // Buffer, not string: with encoding 'buffer' node refuses to encode a
      // string stdin, and the blob reader needs raw bytes back.
      input: typeof input === 'string' ? Buffer.from(input, 'utf8') : input,
      encoding,
      maxBuffer: 256 * 1024 * 1024,
      timeout: Math.max(1, deadline.remainingMs()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    json: false,
    help: false,
    printRules: false,
    maxSeconds: DEFAULT_MAX_SECONDS,
    maxBytes: MAX_BYTES,
  };
  let sawRepo = false;
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--print-rules') opts.printRules = true;
    else if (arg.startsWith('--max-seconds=')) {
      opts.maxSeconds = Number(arg.slice('--max-seconds='.length));
      if (!Number.isFinite(opts.maxSeconds) || opts.maxSeconds <= 0) {
        return { error: `bad --max-seconds: ${arg}` };
      }
    } else if (arg.startsWith('--max-bytes=')) {
      opts.maxBytes = Number(arg.slice('--max-bytes='.length));
      if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
        return { error: `bad --max-bytes: ${arg}` };
      }
    } else if (arg.startsWith('-')) {
      return { error: `unknown option: ${arg}` };
    } else if (sawRepo) {
      return { error: `unexpected extra argument: ${arg}` };
    } else {
      opts.repo = arg;
      sawRepo = true;
    }
  }
  return { opts };
}

/**
 * Reachable blobs, as [{ sha, path }]. `git rev-list --objects --all` emits
 * "<sha> <path>" for blobs and trees and a bare "<sha>" for commits; a blob
 * can appear at several paths, and the first one is enough to point a human at
 * the right place.
 */
function reachableObjects(git) {
  const out = git(['rev-list', '--objects', '--all']);
  const pathBySha = new Map();
  const order = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue; // commit or tag object: no path
    const sha = line.slice(0, sp);
    if (pathBySha.has(sha)) continue;
    pathBySha.set(sha, line.slice(sp + 1));
    order.push(sha);
  }
  return { pathBySha, order };
}

/** Split [{sha,size}] into chunks of roughly `budget` bytes for cat-file --batch. */
function chunkBySize(items, budget) {
  const chunks = [];
  let current = [];
  let total = 0;
  for (const item of items) {
    if (current.length > 0 && total + item.size > budget) {
      chunks.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += item.size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Read a chunk of blobs in one `git cat-file --batch` call and hand each
 * body to `onBlob`. The batch format is "<sha> <type> <size>\n<body>\n".
 */
function readBatch(git, shas, onBlob) {
  const buf = git(['cat-file', '--batch'], {
    input: shas.join('\n') + '\n',
    encoding: 'buffer',
  });
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) throw new Error('git cat-file --batch: truncated header');
    const header = buf.toString('utf8', at, nl);
    const parts = header.split(' ');
    if (parts.length < 3) {
      // "<sha> missing" - the object vanished between listing and reading.
      throw new Error(`git cat-file --batch: unreadable object (${header})`);
    }
    const [sha, , sizeStr] = parts;
    const size = Number(sizeStr);
    const start = nl + 1;
    const end = start + size;
    if (end > buf.length) throw new Error('git cat-file --batch: truncated body');
    onBlob(sha, buf.subarray(start, end));
    at = end + 1; // trailing newline
  }
}

/**
 * Decode a blob, or say why it cannot be scanned.
 *
 * Returns { text } or { reason }. The ONLY disqualifier is bytes that do not
 * decode as UTF-8: a lossy decode means we scanned something other than what
 * is stored, so "no match" would be a claim about the wrong bytes.
 *
 * A stray NUL is deliberately NOT a disqualifier, see decodeUtf8's note. A
 * file can hold a NUL as a field separator and still be 26 kB of readable
 * source that could carry a key - refusing it skips the scan AND mislabels the
 * skip as an error, which is the worst of both answers.
 */
function decodeBlob(body) {
  const text = decodeUtf8(body);
  return text === null ? { reason: 'invalid-utf8' } : { text };
}

/**
 * The commit that introduced a blob. Only ever called for findings, so the
 * cost of a --find-object walk is paid at most a handful of times.
 */
function introducingCommit(git, sha) {
  try {
    const out = git(['log', '--all', '--format=%H', '--find-object', sha]);
    const lines = out.split('\n').filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

function isShallow(git, repo) {
  let flagged = false;
  try {
    flagged = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    // older git: fall through to the file check
  }
  try {
    const gitDir = git(['rev-parse', '--absolute-git-dir']).trim();
    if (existsSync(path.join(gitDir, 'shallow'))) flagged = true;
  } catch {
    // handled by the caller's error path
  }
  return flagged;
}

function scanRepo(opts) {
  const deadline = new Deadline(opts.maxSeconds);
  const report = {
    tool: 'scan-history-for-secrets',
    repo: opts.repo,
    verdict: 'clean',
    exitCode: EXIT.CLEAN,
    shallow: false,
    examined: {
      commits: 0,
      refs: 0,
      blobsExamined: 0,
      bytesExamined: 0,
      blobsSkippedBinaryMedia: 0,
      blobsUnexamined: 0,
      blobsReachable: 0,
    },
    findings: [],
    unexamined: [],
    errors: [],
    durationMs: 0,
  };

  let repoRoot;
  const probe = makeGit(opts.repo, deadline);
  try {
    repoRoot = probe(['rev-parse', '--show-toplevel']).trim();
  } catch (err) {
    // A git that timed out has told us NOTHING about the path. Reporting that
    // as "not a git repository" would be a second-hand version of the bug this
    // tool is about: an unanswered question rendered as an answer.
    if (isTimeout(err)) throw err;
    return { report, usageError: `not a git repository: ${opts.repo}` };
  }
  report.repo = repoRoot;

  const git = makeGit(repoRoot, deadline);

  try {
    report.shallow = isShallow(git, repoRoot);
    report.examined.commits = Number(git(['rev-list', '--all', '--count']).trim()) || 0;
    report.examined.refs = git(['for-each-ref', '--format=%(refname)'])
      .split('\n').filter(Boolean).length;

    const { pathBySha, order } = reachableObjects(git);

    // One --batch-check pass gives type and size for everything, so the
    // expensive --batch read only ever asks for blobs we mean to scan.
    const checkOut = git(['cat-file', '--batch-check'], { input: order.join('\n') + '\n' });
    const blobs = [];
    for (const line of checkOut.split('\n')) {
      if (!line) continue;
      const [sha, type, sizeStr] = line.split(' ');
      if (type !== 'blob') continue;
      blobs.push({ sha, size: Number(sizeStr) || 0, path: pathBySha.get(sha) ?? '(unknown path)' });
    }
    report.examined.blobsReachable = blobs.length;

    const toRead = [];
    for (const blob of blobs) {
      if (SKIP_EXT.test(blob.path)) {
        report.examined.blobsSkippedBinaryMedia += 1;
        continue;
      }
      if (blob.size > opts.maxBytes) {
        report.unexamined.push({ path: blob.path, blob: blob.sha, reason: 'over-size-cap' });
        continue;
      }
      toRead.push(blob);
    }

    const bySha = new Map(toRead.map((b) => [b.sha, b]));
    for (const chunk of chunkBySize(toRead, 32 * 1024 * 1024)) {
      readBatch(git, chunk.map((b) => b.sha), (sha, body) => {
        const blob = bySha.get(sha);
        if (!blob) return;
        const { text, reason } = decodeBlob(body);
        if (reason) {
          report.unexamined.push({ path: blob.path, blob: sha, reason });
          return;
        }
        report.examined.blobsExamined += 1;
        report.examined.bytesExamined += body.length;
        const hit = matchSecret(text);
        if (hit) {
          // label + line + length only. The value stays in the repo, which is
          // the one place it is already.
          report.findings.push({
            rule: hit.label,
            path: blob.path,
            line: hit.line,
            blob: sha,
            commit: introducingCommit(git, sha),
          });
        }
      });
    }
  } catch (err) {
    report.errors.push(String(err && err.message ? err.message : err));
  }

  report.examined.blobsUnexamined = report.unexamined.length;
  report.durationMs = deadline.elapsedMs();

  if (report.findings.length > 0) {
    report.verdict = 'found';
    report.exitCode = EXIT.FOUND;
  } else if (report.errors.length > 0 || report.unexamined.length > 0) {
    report.verdict = 'incomplete';
    report.exitCode = EXIT.INCOMPLETE;
  } else if (report.shallow) {
    report.verdict = 'shallow';
    report.exitCode = EXIT.SHALLOW;
  } else {
    report.verdict = 'clean';
    report.exitCode = EXIT.CLEAN;
  }
  // A shallow repo is never a clean verdict, whatever else happened.
  if (report.shallow && report.verdict === 'clean') {
    report.verdict = 'shallow';
    report.exitCode = EXIT.SHALLOW;
  }
  return { report };
}

function printHuman(report) {
  const e = report.examined;
  const out = report.verdict === 'clean' ? console.log : console.error;

  if (report.shallow) {
    out('');
    out('  *** SHALLOW CLONE - THIS HISTORY WAS NOT FULLY EXAMINED ***');
    out('  Commits cut off by --depth were never fetched, so nothing here can');
    out('  speak for them. Re-run after: git fetch --unshallow');
    out('');
  }

  out(`repo:      ${report.repo}`);
  out(`examined:  ${e.commits} commits, ${e.refs} refs, ${e.blobsExamined} of ${e.blobsReachable} reachable blobs (${e.bytesExamined} bytes) in ${report.durationMs} ms`);
  if (e.blobsSkippedBinaryMedia > 0) {
    out(`skipped:   ${e.blobsSkippedBinaryMedia} binary media blob(s) by extension - NOT examined`);
  }
  if (e.commits <= 1) {
    out('DEPTH:     this history is 1 commit. A history scan of a fresh snapshot');
    out('           repo proves almost nothing - it has no deleted past to hide a key in.');
  }

  for (const u of report.unexamined) {
    out(`UNEXAMINED ${u.path}  [${u.reason}]  blob ${u.blob}`);
  }
  for (const err of report.errors) {
    out(`ERROR      ${err}`);
  }

  if (report.findings.length > 0) {
    out('');
    out(`FOUND: ${report.findings.length} credential-shaped blob(s) in reachable history.`);
    for (const f of report.findings) {
      out(`  ${f.path}:${f.line}`);
      out(`      rule:   ${f.rule}`);
      out(`      blob:   ${f.blob}`);
      out(`      commit: ${f.commit ?? '(not attributable to a single commit)'}`);
    }
    out('');
    out('The matched value is deliberately not printed. Inspect it yourself:');
    out('  git cat-file blob <blob>   # in private, not in CI output');
    out('');
    out('If it is live: ROTATE FIRST. This repo is public, so anyone who cloned');
    out('it already has the object - rewriting history does not un-leak it.');
  }

  switch (report.verdict) {
    case 'clean':
      out(`PASS: no credential-shaped data in ${e.blobsExamined} reachable blob(s).`);
      break;
    case 'incomplete':
      out('COULD NOT COMPLETE: part of this history was not checked. This is not a pass.');
      break;
    case 'shallow':
      out('SHALLOW: the fetched part looks clean. The unfetched part is unexamined.');
      break;
    default:
      break;
  }
}

function main() {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`${error}\n`);
    console.error(HELP);
    process.exit(EXIT.USAGE);
  }
  if (opts.help) {
    console.log(HELP);
    process.exit(EXIT.CLEAN);
  }
  if (opts.printRules) {
    console.log(ruleLabels().join('\n'));
    process.exit(EXIT.CLEAN);
  }

  let result;
  try {
    result = scanRepo(opts);
  } catch (err) {
    // Belt and braces: an unexpected throw is could-not-complete, never clean.
    const message = String(err && err.message ? err.message : err);
    if (opts.json) {
      console.log(JSON.stringify({
        tool: 'scan-history-for-secrets',
        repo: opts.repo,
        verdict: 'incomplete',
        exitCode: EXIT.INCOMPLETE,
        errors: [message],
      }, null, 2));
    } else {
      console.error(`COULD NOT COMPLETE: ${message}`);
    }
    process.exit(EXIT.INCOMPLETE);
  }

  if (result.usageError) {
    if (opts.json) {
      console.log(JSON.stringify({
        tool: 'scan-history-for-secrets',
        repo: opts.repo,
        verdict: 'usage',
        exitCode: EXIT.USAGE,
        errors: [result.usageError],
      }, null, 2));
    } else {
      console.error(`USAGE: ${result.usageError}`);
    }
    process.exit(EXIT.USAGE);
  }

  const { report } = result;
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exit(report.exitCode);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { EXIT, scanRepo };
