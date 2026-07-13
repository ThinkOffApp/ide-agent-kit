# IAK v0.10.0 — never type over the human (draft, cut after #30 merges)

Release theme: agents must never garble a human's typing, and a deferred
wake must never lose a message. Everything shipped here came out of the
2026-07-13 live incident where wake nudges typed into petrus's sentences.

## Highlights

### Keyboard safety (the headline)
- Human-idle guard (HIDIdleTime, fail-closed) gates every keystroke path;
  garbage/zero thresholds clamp to 60s and never authorize injection (#29).
- Point-of-injection rechecks inside both AppleScript wake heredocs and per
  focus-loop iteration, so a human returning mid-wake aborts the injection
  instead of being typed over or fought for focus (#30).
- Every abort restores the human's frontmost app; the "blast the keystroke
  anyway" fallback is gone (#30).
- Codex GUI nudge gates on lock screen, frontmost app, and 60s human idle,
  rechecked immediately before cliclick/AppleScript injection (#28).
- room-poll pins the tmux pane id so Enter/C-u can never land in a pane the
  human switched to (#30).

### Delivery that never loses a message
- Ack-after-success: wake scripts exit non-zero on any abort; all pollers
  retry every cycle while content is pending, using a last-successful-wake
  marker so an already-woken session is not re-nudged (#30).
- Poller no longer self-terminates on a failed wake under set -e (#30).
- Webhook/watchdog wake timeouts raised 30s -> 320s so they no longer kill
  the guard's legitimate idle wait mid-flight (#30).
- Wake-stack self-healing: launchd-supervised webhook receiver with health
  verification, PATH-resolved node (#28, #30).

### Hygiene & security
- Pre-commit secret scanner blocks public-repo key leaks (#27).
- team-watchdog roster is config/env-driven; no tailnet IPs or user paths in
  the repo; launchd plists parameterized (#30).
- Gate fixes: settled/annotated auto-allowed intents, GUI wake retry (#26).

### Tests
- +7 regression tests (threshold clamping, fail-closed idle reads,
  deferred-nudge retry-to-delivery, mid-nudge human arrival). Suite: 111.

## Upgrade notes
- `config/watchdog-roster.json` (gitignored) or `IAK_WATCHDOG_ROSTER` env now
  defines the watchdog roster; the old hardcoded roster is gone.
- Wake scripts may legitimately take up to ~5 min when a human is using the
  machine (idle wait): raise any external supervisor timeouts to >=320s.
- Copy `scripts/com.thinkoff.iak-codex-webhook.plist` with the
  REPLACE_WITH_IAK_ROOT substitution (see file header).

## Release mechanics (run after #30 merge)
1. git checkout main && git pull
2. npm version 0.10.0 (updates package.json + tag) or manual bump + `git tag v0.10.0`
3. npm test (expect 111 pass)
4. git push origin main --tags
5. gh release create v0.10.0 --title "v0.10.0 — never type over the human" --notes-file docs/release-v0.10.0-draft.md
6. Dogfood: this MacBook pulls the tag and restarts pollers/daemon from it.
