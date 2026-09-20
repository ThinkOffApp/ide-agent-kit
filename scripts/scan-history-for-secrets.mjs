#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Command line for the reachable-history secret scanner. The engine, and the
// long explanation of what this exists for, live in src/history-scan.mjs.
//
// THIS FILE IS AN ENTRY POINT AND NOTHING ELSE. main() is called at the bottom
// with no guard around it, deliberately.
//
// The first version wrapped that call in the usual
//
//     if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
//
// which is broken through a symlink, because node always realpath-resolves
// import.meta.url and never resolves argv[1]. On macOS /tmp IS a symlink to
// /private/tmp, so running the scanner from any scratch dir, any worktree under
// /tmp, or a ~/bin symlink produced NO output and exit 0. For a security tool,
// exit 0 means clean. It blessed a repo it had not looked at.
//
// A guard here bought nothing - nothing imports this file - so the fix is not a
// better comparison, it is no comparison. Modules that genuinely need one use
// isMainModule() from src/common/entrypoint.mjs, which realpaths both sides.
//
// Run:  node scripts/scan-history-for-secrets.mjs [repo-path] [--json]
// Help: node scripts/scan-history-for-secrets.mjs --help

import { MAX_BYTES, renderClaims, ruleLabels } from '../src/secret-patterns.mjs';
import { EXIT, scanRepo } from '../src/history-scan.mjs';

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
  if (e.blobsExamined === 0 && e.blobsReachable > 0) {
    out('NOTHING SCANNED: 0 of the reachable blobs were read as text. Whatever this');
    out('           report says, it is not based on having looked at the content.');
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
      // Claims, never the token. What a JWT IS - service_role for which
      // project, expiring when - is the difference between "some JWT" and "a
      // non-expiring full-access production database credential", and it is
      // metadata, not the secret.
      if (f.detail && f.detail.kind === 'jwt') {
        // renderClaims prints a value only where the value is constrained to a
        // vocabulary we defined; everything else is presence and length. A
        // JWT's claims are free text chosen by whoever made the token.
        out(`      claims: ${renderClaims(f.detail.claims)}`);
        if (f.detail.noExpiry) out('      expiry: NO EXPIRY CLAIM - this token does not stop working');
        else if (f.detail.expired) out(`      expiry: EXPIRED ${f.detail.expiresAt}`);
        else out(`      expiry: LIVE until ${f.detail.expiresAt} (${f.detail.daysRemaining} days remaining)`);
      }
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

// No guard. See the header: this file is only ever run, never imported, and a
// guard that silently evaluates false is exactly how this tool once exited 0
// without scanning anything.
main();
