// SPDX-License-Identifier: AGPL-3.0-only
//
// The ONE list of credential shapes this repo scans for.
//
// It used to live inside scripts/check-stageable-secrets.mjs. It was lifted
// out when scripts/scan-history-for-secrets.mjs was added, because the
// alternative was two lists: one for "what would `git add -A` stage" and one
// for "what is sitting in reachable history". Two lists is not two scanners,
// it is one scanner and one decoy - the day somebody adds a new key format to
// the list they happen to be looking at, the other one keeps passing and keeps
// looking healthy while missing the exact shape that was just added.
//
// That is the same defect the header of check-stageable-secrets.mjs describes:
// the rule that existed stayed correct, so nothing looked broken, and it was
// always the sibling nobody thought to name. So: one list, imported by both,
// with a test that fails if either grows a private copy.
//
// NOTE the deliberate asymmetry: matchSecret() returns WHERE and WHICH RULE,
// never the matched text. Callers that cannot print the value cannot leak it
// into a CI log, a terminal scrollback or a chat message, and "the scanner
// printed the secret" is a real failure mode, not a theoretical one.
//
// (.githooks/pre-commit carries a third, bash-native list. It cannot import
// this module - it is dependency-free grep by design so it works in a clone
// with no node_modules. Unifying those two is a separate change.)

// Shapes worth stopping for. Deliberately narrow: a scanner that cries wolf
// gets disabled, and a disabled scanner is worse than none. Every pattern
// here is a real credential format we use or plausibly would.
export const SECRET_PATTERNS = [
  [/xfb_[a-f0-9]{32,}/i, 'GroupMind agent key'],
  [/antfarm_[A-Za-z0-9]{32,}/, 'GroupMind room key'],
  // sk-ant- BEFORE the general sk- rule: the broad one also matches an
  // Anthropic key and would mislabel it, and a wrong label sends someone
  // rotating the wrong credential.
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style secret key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{50,}/, 'GitHub fine-grained PAT'],
  [/xai-[A-Za-z0-9]{20,}/, 'xAI API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i,
    'assigned secret-looking value'],
];

// Binaries and media produce noise, not credentials. A blob skipped by this
// rule is NOT examined - both scanners report the count so a reader can tell
// "we looked at everything" from "we looked at everything we could read".
export const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|aab|apk|keystore|jks|woff2?|ttf|mp[34]|mov|wav)$/i;

// Above this, a blob is not scanned. It is reported as unexamined rather than
// silently passed: "too big to check" is not "checked and clean".
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Find the first credential-shaped thing in `text`.
 *
 * Returns null, or { label, line, length } - deliberately WITHOUT the matched
 * text. Every caller reports a location and a rule name, so no caller is ever
 * one console.log away from copying a live key into a public log.
 */
export function matchSecret(text) {
  for (const [re, label] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return {
        label,
        line: text.slice(0, m.index).split('\n').length,
        length: m[0].length,
      };
    }
  }
  return null;
}

/**
 * Decode `buf` as text, or return null if it genuinely is not UTF-8.
 *
 * NOT a NUL check. Those are two different questions and conflating them cost
 * us a real scan: bin/iak-pending.mjs carries ONE NUL byte, 12,684 bytes in,
 * as a deliberate field separator between a host and an id (NUL cannot occur
 * in either, so neither component can forge a collision). The file is valid
 * UTF-8, `node --check` passes, and it is 26 kB of perfectly readable
 * JavaScript. The old "contains a NUL, therefore binary" rule refused to look
 * at any of it and reported could-not-complete - so a credential sitting after
 * that byte would have been missed, and the miss would have been dressed up as
 * a scanning error rather than a finding.
 *
 * The only thing that justifies refusing to scan is bytes that do not decode.
 * TextDecoder in fatal mode answers exactly that question and nothing else.
 */
export function decodeUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Rule names in order. Used by --print-rules in both scanners. */
export function ruleLabels() {
  return SECRET_PATTERNS.map(([, label]) => label);
}
