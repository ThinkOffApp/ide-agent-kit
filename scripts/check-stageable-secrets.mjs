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
import { MAX_BYTES, SKIP_EXT, decodeUtf8, matchSecret, ruleLabels } from '../src/secret-patterns.mjs';

// The pattern list, the binary-extension skip list and the size cap now live
// in src/secret-patterns.mjs, shared with scripts/scan-history-for-secrets.mjs.
// They were moved there the day the history scanner was written, because the
// alternative was a second list - and a second list is how one of them rots
// unnoticed while still looking healthy. That is the same shape of mistake the
// note above describes. Do not re-introduce a local copy here; a test asserts
// that neither scanner has one.
//
// matchSecret() returns a rule name, a line and a length, never the matched
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

function scan(path) {
  if (SKIP_EXT.test(path)) return null;
  let bytes;
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    bytes = readFileSync(path);
  } catch {
    return null; // unreadable, gone, or a directory: not our problem
  }
  // Read as bytes and decode strictly, rather than the old "readFileSync utf8
  // then look for a NUL". A NUL is not a proof of binary - bin/iak-pending.mjs
  // uses one as a field separator inside 26 kB of valid JavaScript - and the
  // lossy utf8 read could not tell a real binary from text anyway.
  const text = decodeUtf8(bytes);
  if (text === null) return null; // genuinely not text
  // Report WHERE and WHICH RULE, never the value itself. This output ends up
  // in CI logs and terminal scrollback, and a scanner that prints the secret it
  // found has simply moved the leak.
  const hit = matchSecret(text);
  if (!hit) return null;
  return { label: hit.label, line: hit.line, hint: `${hit.length} chars, value not printed` };
}

// Shared with the history scanner; a test compares the two outputs so the
// lists cannot drift apart silently.
if (process.argv.includes('--print-rules')) {
  console.log(ruleLabels().join('\n'));
  process.exit(0);
}

const findings = [];
for (const f of stageableFiles()) {
  const hit = scan(f);
  if (hit) findings.push({ file: f, ...hit });
}

if (findings.length === 0) {
  console.log('PASS: nothing `git add -A` would stage looks like a credential.');
  process.exit(0);
}

console.error(`FAIL: ${findings.length} stageable file(s) contain credential-shaped data\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`      ${f.label} - ${f.hint}\n`);
}
console.error('These are NOT committed yet, and this repo is public.');
console.error('Fix by ignoring the file, not by deleting it — something may be using it:');
console.error('  echo "<path>" >> .git/info/exclude     # this machine, immediate');
console.error('  then add the pattern to .gitignore in a PR, so every user gets it.');
process.exit(1);
