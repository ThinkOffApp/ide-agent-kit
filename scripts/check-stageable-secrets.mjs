#!/usr/bin/env node
// Fail if `git add -A` would stage a credential.
//
// On 2026-08-03 we found live keys sitting unignored in PUBLIC repo clones on
// BOTH machines, within an hour of each other, and neither was caught by a
// rule:
//
//   MacBook   config/grok.env      `config/*.json` was scoped to .json
//   Mac mini  logs/start-all.out   `*.log` did not cover .out
//
// Both were fixed by adding the missing pattern. That is the wrong lesson.
// The rules were not wrong, they were INCOMPLETE, and the same day gave us a
// third instance of the identical shape (`*.bak.*` matched foo.bak.1 but not
// foo.bak) and a fourth in a different repo entirely. Each time the rule that
// existed stayed correct, so nothing looked broken — it was always the
// sibling nobody thought to name.
//
// You cannot enumerate your way out of that. The next one will be .out2, or
// .tmp, or a directory nobody has created yet. So this checks the OUTCOME
// rather than the filenames: whatever `git add -A` would actually stage, does
// any of it look like a credential?
//
// WHAT A PASS DOES AND DOES NOT MEAN. This asks git what is stageable, and
// git honours .git/info/exclude — which is machine-local and never committed.
// So a PASS means "nothing dangerous is stageable ON THIS MACHINE RIGHT NOW".
// It does NOT mean the repo's ignore rules are complete: a fresh clone, a new
// user, or CI has none of your local excludes, and if .gitignore is still
// missing the pattern then the same file is stageable there with nothing to
// warn them.
//
// Those are two different claims and conflating them is how both of today's
// leaks survived. Closing a hole with .git/info/exclude is the tourniquet;
// the .gitignore change is the fix. This script cannot tell you whether you
// did the second one. (Blind spot found by claudemm, who tested exactly this
// rather than taking the script at its word.)
//
// Run: node scripts/check-stageable-secrets.mjs   (exit 1 on any finding)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { MAX_BYTES, decodeForScanning, looksLikeBinaryMedia, matchSecrets, renderClaims, ruleLabels, sanitizeForOutput } from '../src/secret-patterns.mjs';

// The pattern list, the binary-extension skip list and the size cap now live
// in src/secret-patterns.mjs, shared with scripts/scan-history-for-secrets.mjs.
// They were moved there the day the history scanner was written, because the
// alternative was a second list - and a second list is how one of them rots
// unnoticed while still looking healthy. That is the same shape of mistake the
// note above describes. Do not re-introduce a local copy here; a test asserts
// that neither scanner has one.
//
// matchSecrets() returns rule names, lines and lengths, never the matched
// text. That is why the finding below no longer prints a 6-character prefix of
// the match: a prefix of a live key in a CI transcript is still a prefix of a
// live key.

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Exactly the set `git add -A` would stage: tracked-and-modified plus
// untracked-and-not-ignored. Asking git rather than reimplementing its ignore
// logic is the point — a hand-rolled matcher would inherit the same blind
// spots as the .gitignore rules that missed these files.
function stageableFiles() {
  const out = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    if (status.includes('R')) path = path.split(' -> ').pop(); // renames
    if (status === 'D ' || status === ' D') continue;          // going away
    files.push(path.replace(/^"|"$/g, ''));
  }
  return files;
}

// Files that had to be decoded lossily. Reported at the end: the ASCII scan is
// sound, but "this was not valid UTF-8" is something the operator should see
// rather than something the tool swallows.
const lossyFiles = [];

// A path is repo-controlled free text that this tool prints. It can carry ANSI
// escapes or a newline to forge output lines, and it can itself be a credential
// (keys/sk-live-xxx.txt), which printing would leak.
function safeFile(file) {
  const hits = matchSecrets(file);
  if (hits.length > 0) return `(path withheld: it matches ${hits[0].label})`;
  return sanitizeForOutput(file);
}

function scan(path) {
  // No extension check. The same filename-decides bug lives here: a stageable
  // foo.png holding an ASCII credential would have been skipped unread. Binary
  // media is recognised below, by its bytes.
  let bytes;
  try {
    if (statSync(path).size > MAX_BYTES) return [];
    bytes = readFileSync(path);
  } catch {
    return []; // unreadable, gone, or a directory: not our problem
  }
  // Read as bytes and decode for scanning. NOT "decode strictly, else skip":
  // that is what this file did for one commit, and it printed PASS on a file
  // holding a plain ASCII key beside a single stray 0xff byte - the baseline
  // scanner caught that file, so the encoding check made the gate WORSE. An
  // encoding problem must never suppress a match.
  //
  // Lossy is right here specifically. This scanner's job is to block a commit,
  // not to classify encodings; credential formats are ASCII and survive a lossy
  // decode byte for byte. Making an undecodable file exit non-zero instead was
  // the other option, and it was wrong for THIS tool: stageable binaries are
  // routine, blocking every commit that touches one gets the hook disabled, and
  // a disabled scanner is worse than none. The history scanner, which reports
  // rather than blocks, does mark such blobs could-not-complete AND scans them.
  const { text, strict } = decodeForScanning(bytes);
  if (!strict) {
    // Recognised image or archive: nothing to read, and nothing to warn about.
    if (looksLikeBinaryMedia(bytes)) return [];
    lossyFiles.push(path);
  }
  // Report WHERE and WHICH RULE, never the value itself. This output ends up
  // in CI logs and terminal scrollback, and a scanner that prints the secret it
  // found has simply moved the leak.
  return matchSecrets(text).map((hit) => ({
    label: hit.label,
    line: hit.line,
    hint: `${hit.length} chars, value not printed`,
    detail: hit.detail,
  }));
}

// Claims for a JWT hit: metadata only, never the token. Shared wording with
// the history scanner so a finding reads the same wherever it surfaces.
function describeDetail(detail) {
  if (!detail || detail.kind !== 'jwt') return '';
  const claims = renderClaims(detail.claims);
  let expiry;
  if (detail.noExpiry) expiry = 'NO EXPIRY CLAIM';
  else if (detail.expired) expiry = `EXPIRED ${detail.expiresAt}`;
  else expiry = `live until ${detail.expiresAt} (${detail.daysRemaining} days)`;
  return `claims: ${claims} | ${expiry}`;
}

// Shared with the history scanner; a test compares the two outputs so the
// lists cannot drift apart silently.
if (process.argv.includes('--print-rules')) {
  console.log(ruleLabels().join('\n'));
  process.exit(0);
}

const findings = [];
for (const f of stageableFiles()) {
  for (const hit of scan(f)) findings.push({ file: f, ...hit });
}

function reportLossy() {
  if (lossyFiles.length === 0) return;
  console.error(`NOTE: ${lossyFiles.length} stageable file(s) are not valid UTF-8 and were`);
  console.error('      scanned as ASCII. Credential shapes are ASCII, so this finds them,');
  console.error('      but text in another encoding would not have been read:');
  for (const f of lossyFiles.slice(0, 10)) console.error(`        ${safeFile(f)}`);
}

if (findings.length === 0) {
  reportLossy();
  console.log('PASS: nothing `git add -A` would stage looks like a credential.');
  process.exit(0);
}

reportLossy();

console.error(`FAIL: ${findings.length} stageable file(s) contain credential-shaped data\n`);
for (const f of findings) {
  console.error(`  ${safeFile(f.file)}:${f.line}`);
  console.error(`      ${f.label} - ${f.hint}`);
  if (f.detail) console.error(`      ${describeDetail(f.detail)}`);
  console.error('');
}
console.error('These are NOT committed yet, and this repo is public.');
console.error('Fix by ignoring the file, not by deleting it — something may be using it:');
console.error('  echo "<path>" >> .git/info/exclude     # this machine, immediate');
console.error('  then add the pattern to .gitignore in a PR, so every user gets it.');
process.exit(1);
