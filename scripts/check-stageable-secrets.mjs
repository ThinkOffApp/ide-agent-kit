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
// Run: node scripts/check-stageable-secrets.mjs   (exit 1 on any finding)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// Shapes worth stopping for. Deliberately narrow: a scanner that cries wolf
// gets disabled, and a disabled scanner is worse than none. Every pattern
// here is a real credential format we use or plausibly would.
const PATTERNS = [
  [/xfb_[a-f0-9]{32,}/i, 'GroupMind agent key'],
  // sk-ant- BEFORE the general sk- rule: the broad one also matches an
  // Anthropic key and would mislabel it, and a wrong label sends someone
  // rotating the wrong credential.
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style secret key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{50,}/, 'GitHub fine-grained PAT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i,
    'assigned secret-looking value'],
];

// Binaries and lockfiles produce noise, not credentials.
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|aab|apk|keystore|jks|woff2?|ttf|mp[34]|mov|wav)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

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
  let text;
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // unreadable, gone, or a directory: not our problem
  }
  if (text.includes('\0')) return null; // binary
  for (const [re, label] of PATTERNS) {
    const m = text.match(re);
    if (m) {
      // Report WHERE and WHAT, never the value itself. This output ends up in
      // CI logs and terminal scrollback, and a scanner that prints the secret
      // it found has simply moved the leak.
      const line = text.slice(0, m.index).split('\n').length;
      return { label, line, hint: `${m[0].slice(0, 6)}…(${m[0].length} chars)` };
    }
  }
  return null;
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
  console.error(`      ${f.label} — ${f.hint}\n`);
}
console.error('These are NOT committed yet, and this repo is public.');
console.error('Fix by ignoring the file, not by deleting it — something may be using it:');
console.error('  echo "<path>" >> .git/info/exclude     # this machine, immediate');
console.error('  then add the pattern to .gitignore in a PR, so every user gets it.');
process.exit(1);
