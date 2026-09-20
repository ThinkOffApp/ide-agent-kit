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
//
// ORDER MATTERS: matchSecrets reports every rule that fires, but a value is
// labelled by the first rule that claims it, and a wrong label sends someone
// rotating the wrong credential. JWT goes first because a base64url segment
// can easily contain "sk-" or "AIza" by chance, while no sk-/AIza key contains
// a dotted JWT triple.
//
// PROVENANCE, worth reading before adding the next one. This list was lifted
// out of check-stageable-secrets.mjs and was supposed to be the single source
// of truth. It was not: .githooks/pre-commit had a bash list with FOUR formats
// this one lacked, and the port took two of them and quietly left the rest.
// One of the four was the JWT rule - and a Supabase service_role key is a JWT,
// so the scanner walked past a non-expiring full-access production database
// credential in a repo that was hours from being published. The rules were not
// wrong. They were incomplete, again, in exactly the way the header of
// check-stageable-secrets.mjs warns about. All four are here now.
export const SECRET_PATTERNS = [
  // header.payload.signature, base64url. Supabase, Auth0, Firebase and most
  // self-issued session tokens are this shape. describeJwt below turns a hit
  // into something a human can triage without ever seeing the token.
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT (Supabase / Auth0 / Firebase style)', describeJwt],
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
  [/moltbook_sk_[A-Za-z0-9]{20,}/, 'Moltbook secret key'],
  [/\bam_[a-z]{2}_[a-f0-9]{40,}/, 'AgentMail key'],
  [/MT[A-Za-z0-9]{22,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/, 'Discord bot token'],
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

// Claims that are safe to print: standard JWT metadata, never the token, never
// the signature, and never a custom claim we have not thought about. An
// allowlist rather than a denylist, because the interesting question - "is this
// a service_role key for production" - is answered by four well-known fields,
// and a custom claim could hold anything.
const JWT_CLAIM_ALLOWLIST = ['alg', 'typ', 'kid', 'iss', 'aud', 'role', 'ref', 'scope', 'iat', 'nbf', 'exp'];
const MAX_CLAIM_CHARS = 64;

/**
 * Decode a JWT's header and payload and describe them.
 *
 * Claims yes, token never. The claims are not the secret - they are metadata
 * anyone holding the token can read - and they are the whole difference between
 * "some JWT" and "a non-expiring service_role key for the production project".
 * Reporting them is what makes a hit triageable without anyone pasting the
 * credential into a terminal to find out what it is.
 *
 * Returns null for an eyJ-prefixed string that is not actually a JWT, which is
 * a thing that exists: base64 of any JSON object starts "eyJ".
 */
export function describeJwt(token) {
  const segments = String(token).split('.');
  if (segments.length < 2) return null;
  const decodeSegment = (seg) => {
    try {
      const json = Buffer.from(seg, 'base64url').toString('utf8');
      const value = JSON.parse(json);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const header = decodeSegment(segments[0]);
  const payload = decodeSegment(segments[1]);
  if (!header && !payload) return null;

  const claims = {};
  for (const source of [header, payload]) {
    if (!source) continue;
    for (const key of JWT_CLAIM_ALLOWLIST) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') continue; // arrays/objects: not worth dumping
      const text = String(value);
      claims[key] = text.length > MAX_CLAIM_CHARS
        ? `(value omitted: ${text.length} chars)`
        : text;
    }
  }

  const detail = { kind: 'jwt', decoded: true, claims };
  const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
  if (exp !== null) {
    const msLeft = exp * 1000 - Date.now();
    detail.expired = msLeft <= 0;
    detail.expiresAt = new Date(exp * 1000).toISOString().slice(0, 10);
    detail.daysRemaining = Math.round(msLeft / 86400000);
  } else {
    // No exp at all is worse news than a distant one, not better.
    detail.expired = false;
    detail.expiresAt = null;
    detail.daysRemaining = null;
    detail.noExpiry = true;
  }
  return detail;
}

/**
 * Every credential-shaped thing in `text`, one entry per rule that fires.
 *
 * Returns [{ label, line, length, detail? }] - deliberately WITHOUT the matched
 * text. Every caller reports a location and a rule name, so no caller is ever
 * one console.log away from copying a live key into a public log.
 *
 * Plural on purpose. It used to return only the first hit, which meant a rule
 * high in the list shadowed everything below it in the same blob: a file with
 * an API key on line 3 and a service_role JWT on line 40 reported one finding
 * and the reader had no idea the second one was there. Silent partial reporting
 * is the same family of bug as a silent miss.
 */
export function matchSecrets(text) {
  const hits = [];
  // Rule order, so the most specific rule claims a value first.
  for (const [re, label, detailOf] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    // One VALUE reported once. `const apiKey = "sk-..."` matches both the
    // OpenAI rule and the generic assigned-secret rule; reporting it twice is
    // noise, and noise is how a scanner gets switched off. Two credentials at
    // different places in the same blob do not overlap, so both survive.
    if (hits.some((h) => start < h.end && end > h.start)) continue;
    hits.push({
      label,
      line: text.slice(0, start).split('\n').length,
      length: m[0].length,
      start,
      end,
      // detailOf sees the matched value; whatever it returns is printed, so it
      // must return metadata only. describeJwt returns allowlisted claims.
      ...(detailOf ? { detail: detailOf(m[0]) } : {}),
    });
  }
  return hits.sort((a, b) => a.start - b.start).map(({ start, end, ...hit }) => hit);
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
