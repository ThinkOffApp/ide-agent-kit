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
// This module is the ENGINE. It is pure: importing it starts nothing, and it
// has no argv parsing, no printing and no process.exit. The command line lives
// in scripts/scan-history-for-secrets.mjs, which is an entry point and only an
// entry point - it calls main() unconditionally, because a run-only-if guard
// that silently evaluates false is how a security tool comes to exit 0 without
// scanning anything.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_BYTES,
  SKIP_EXT,
  decodeUtf8,
  matchSecrets,
  ruleLabels,
} from '../src/secret-patterns.mjs';

// Documented in --help. Verdict precedence when several apply:
// FOUND > INCOMPLETE > SHALLOW > CLEAN. Anything that is not a proven-clean
// full scan of a complete history is a non-zero exit.
export const EXIT = {
  CLEAN: 0,
  FOUND: 1,
  USAGE: 2,
  INCOMPLETE: 3,
  SHALLOW: 4,
};

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

export function scanRepo(opts) {
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
        const hits = matchSecrets(text);
        if (hits.length > 0) {
          // One finding per rule that fired, not just the first: a rule high in
          // the list used to shadow everything below it in the same blob.
          const commit = introducingCommit(git, sha);
          for (const hit of hits) {
            // label + line + length only, plus safe metadata for rules that
            // can produce it (JWT claims). The value stays in the repo, which
            // is the one place it is already.
            report.findings.push({
              rule: hit.label,
              path: blob.path,
              line: hit.line,
              blob: sha,
              commit,
              ...(hit.detail ? { detail: hit.detail } : {}),
            });
          }
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
