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

// Binary media used to be recognised by file extension here. That decided
// whether content got scanned from a name git handed us by chance, which let a
// credential hide in a blob whose first-seen path ended .png. Recognition is
// now by content: looksLikeBinaryMedia() below.

// Above this, a blob is not scanned. It is reported as unexamined rather than
// silently passed: "too big to check" is not "checked and clean".
export const MAX_BYTES = 2 * 1024 * 1024;

// WHAT MAY BE PRINTED FROM A JWT, AND WHY SO LITTLE.
//
// A JWT's claims are ATTACKER-CONTROLLED FREE TEXT. Anyone who can get a token
// into a scanned repo chooses what our report says, and this report exists to
// be shared: pasted into a ticket, handed to a reviewer, dropped in a room. An
// earlier version allowlisted claim NAMES and printed whatever string sat under
// them, under 65 characters. A reviewer put a synthetic secret in `iss` and it
// came back verbatim. An allowlist of names does not constrain values.
//
// So a value is printed only where the value itself is constrained to a
// vocabulary we defined:
//
//   alg, typ   the JWT spec's own registered names
//   role       the handful of roles these platforms define
//   exp/iat/nbf a number, rendered as a date
//   ref        ONLY when it is exactly 20 lowercase letters
//
// Everything else - iss, kid, aud, scope, and any claim we have not thought
// about - is reported as presence and length. "iss present, 42 chars" tells a
// human this token names an issuer and roughly how long it is, which is all
// triage needs, and it cannot carry a payload.
//
// The one argued exception is `ref`. It is the Supabase project identifier,
// it appears in the project's own public URL, it is not a credential, and it
// is the single field that answers "which project is this key for" - the
// difference between an alarming finding and an actionable one. It is printed
// only when it matches ^[a-z]{20}$ exactly, so the channel is 20 lowercase
// letters wide and carries nothing an attacker did not already have to encode
// into that shape. If that trade is not wanted, delete SUPABASE_REF_SHAPE and
// it degrades to presence-and-length like the rest.
const JWT_ALG_VOCABULARY = new Set([
  'HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512',
  'ES256', 'ES256K', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512',
  'EdDSA', 'none',
]);
const JWT_TYP_VOCABULARY = new Set(['JWT', 'at+jwt', 'at+JWT', 'JOSE', 'JOSE+JSON', 'dpop+jwt']);
const JWT_ROLE_VOCABULARY = new Set([
  'service_role', 'anon', 'authenticated', 'authenticator',
  'supabase_admin', 'admin', 'user', 'owner', 'editor', 'viewer', 'guest',
]);
const SUPABASE_REF_SHAPE = /^[a-z]{20}$/;
const JWT_TIMESTAMP_CLAIMS = ['exp', 'iat', 'nbf'];
// Reported by presence and length only. Listing them explicitly documents the
// decision; anything NOT in any list is treated the same way by default, which
// is the safe direction.
const JWT_OPAQUE_CLAIMS = ['kid', 'iss', 'aud', 'scope', 'sub', 'azp', 'jti'];

/** A value we chose to print, or a shape that carries nothing. */
const printable = (value) => ({ value: String(value) });
const opaque = (value) => ({ present: true, chars: String(value).length });

function describeClaim(name, value) {
  if (typeof value === 'object') return null; // arrays/objects: never dumped
  const text = String(value);
  if (name === 'alg') return JWT_ALG_VOCABULARY.has(text) ? printable(text) : opaque(text);
  if (name === 'typ') return JWT_TYP_VOCABULARY.has(text) ? printable(text) : opaque(text);
  if (name === 'role') return JWT_ROLE_VOCABULARY.has(text) ? printable(text) : opaque(text);
  if (name === 'ref') return SUPABASE_REF_SHAPE.test(text) ? printable(text) : opaque(text);
  if (JWT_TIMESTAMP_CLAIMS.includes(name)) {
    return typeof value === 'number' && Number.isFinite(value)
      ? printable(new Date(value * 1000).toISOString().slice(0, 10))
      : opaque(text);
  }
  return opaque(text);
}

const JWT_REPORTED_CLAIMS = [
  'alg', 'typ', 'role', 'ref', ...JWT_TIMESTAMP_CLAIMS, ...JWT_OPAQUE_CLAIMS,
];

/**
 * Render one claims map as a single line for humans. Shared so a finding reads
 * identically wherever it surfaces.
 */
export function renderClaims(claims) {
  const parts = Object.entries(claims).map(([name, claim]) => (
    claim.value !== undefined ? `${name}=${claim.value}` : `${name}=<present, ${claim.chars} chars>`
  ));
  return parts.join(' ') || '(none readable)';
}

/**
 * Decode a JWT's header and payload and describe them.
 *
 * Claims yes, token never - and only the constrained parts of the claims, see
 * the note above. The point is a report that is safe to share: it says what the
 * token CLAIMS to be (a service_role key for project x, exp 2036) without
 * republishing anything the token's author chose to write.
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
    for (const name of JWT_REPORTED_CLAIMS) {
      const value = source[name];
      if (value === undefined || value === null) continue;
      const described = describeClaim(name, value);
      if (described) claims[name] = described;
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

// Binary media recognised by CONTENT, never by filename.
//
// The filename is whatever git handed us - rev-list --objects names a blob once,
// under whichever path it met first - so a name must not decide whether content
// gets scanned. These are magic bytes: if we RECOGNISE the format we can skip it
// quietly, and if we do not, it is unexamined and says so.
const BINARY_MEDIA_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47],             // PNG
  [0xff, 0xd8, 0xff],                   // JPEG
  [0x47, 0x49, 0x46, 0x38],             // GIF8
  [0x25, 0x50, 0x44, 0x46],             // %PDF
  [0x50, 0x4b, 0x03, 0x04],             // ZIP / JAR / APK / AAB / docx
  [0x50, 0x4b, 0x05, 0x06],             // empty ZIP
  [0x1f, 0x8b],                         // gzip / tgz
  [0x77, 0x4f, 0x46, 0x46],             // wOFF
  [0x77, 0x4f, 0x46, 0x32],             // wOF2
  [0x00, 0x01, 0x00, 0x00],             // TTF
  [0x4f, 0x54, 0x54, 0x4f],             // OTTO
  [0x00, 0x00, 0x01, 0x00],             // ICO
  [0x52, 0x49, 0x46, 0x46],             // RIFF (wav/webp/avi)
  [0x49, 0x44, 0x33],                   // ID3 (mp3)
  [0xff, 0xfb],                         // mp3 frame
  [0x66, 0x4c, 0x61, 0x43],             // fLaC
];

/** True when the bytes ARE a recognised binary media format. */
export function looksLikeBinaryMedia(buf) {
  if (buf.length >= 12) {
    // ftyp box at offset 4: mp4 / mov / m4a
    if (buf.toString('latin1', 4, 8) === 'ftyp') return true;
  }
  return BINARY_MEDIA_MAGIC.some((magic) =>
    magic.length <= buf.length && magic.every((byte, i) => buf[i] === byte));
}

/**
 * Make a repo-controlled string safe to print.
 *
 * File paths are attacker-controlled free text too, and they end up in terminal
 * output: a path can carry ANSI escapes to repaint the report, a newline to
 * forge an extra finding line, or a carriage return to overwrite the verdict.
 * Control characters are replaced rather than dropped, so the presence of
 * something odd is visible instead of silently swallowed, and the result is
 * capped so one absurd path cannot flood a log.
 */
export function sanitizeForOutput(text, maxChars = 300) {
  const cleaned = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}...(${cleaned.length} chars)` : cleaned;
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
 * Decode `buf` for SCANNING. Always returns text.
 *
 * Returns { text, strict }. When the bytes are valid UTF-8, `text` is exact and
 * `strict` is true. When they are not, `text` is a lossy decode - every invalid
 * byte becomes U+FFFD and every ASCII byte survives untouched - and `strict` is
 * false.
 *
 * Why lossy rather than refusing: credential formats are ASCII, and a lossy
 * decode preserves ASCII byte for byte. Refusing the file instead is how the
 * stageable gate came to print PASS on a file holding a plain ASCII key next to
 * one stray 0xff. An encoding problem must never suppress a match - the caller
 * decides separately what a non-strict decode means for its verdict.
 */
export function decodeForScanning(buf) {
  const text = decodeUtf8(buf);
  if (text !== null) return { text, strict: true };
  return { text: Buffer.from(buf).toString('utf8'), strict: false };
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
