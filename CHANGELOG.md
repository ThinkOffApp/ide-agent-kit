# Changelog

## Unreleased

### Fixed
- **Duplicate room-responder voices**: `session-bootstrap.sh` now enforces a single room responder per notification file via a lock file (`<notification file>.responder.lock`). The first session claims the lock and gets the full bootstrap; any later session on the same machine gets PASSIVE instructions (serve the user directly, never answer the room) instead of booting a second copy of the same handle. The lock stores the owner's pid + session id + process start time, so the owner reclaims it across resume/compact, a lock whose owner process died is stolen automatically, and a recycled pid never masquerades as the owner (adversarial review by @codexmb: initial claim is `O_EXCL`-atomic, aliveness uses `ps` so a cross-user EPERM never reads as dead, and every winner re-verifies ownership after a settle window so concurrent starts elect exactly one responder). Disable with `IAK_RESPONDER_LOCK=off`, relocate with `IAK_RESPONDER_LOCK=<path>`. Motivation: on 2026-07-16 a stray `claude rc` session on the Mac mini booted the same bootstrap and posted to the room as a second @claudemm, producing conflicting answers.

## 0.9.0 (2026-06-10)

### Added
- **user-intent-kit embedded**: the UIK repo now lives at `packages/user-intent-kit` (JS client + adapters + Python/Swift/Kotlin ports) and is wired in as a `file:` dependency. It remains independently publishable to npm.
- **`src/intent.mjs`**: single construction point for intent clients/adapters from the `intent` config block (camelCase and snake_case keys both accepted). Includes a 30s intent cache shared by enrichment and nudge gating.
- **`intent` CLI command**: `ide-agent-kit intent <get|profile|derived|state|patch|heartbeat|daemon>`. `state` shows the two-level state plus the background gate verdict; `daemon` is the embedded equivalent of `uik-daemon` driven by `config.intent.*` instead of env vars.
- **Nudge suppression in `rooms watch`**: when `config.intent` is set and the user's `urgency_mode` is `emergency-only`, the poller still writes notification files but skips the tmux/command nudge. Opt out with `intent.suppress_nudges: false`. Fails open on API errors.

### Fixed
- **Intent enrichment never worked**: `enrichment.mjs` authenticated with `Authorization: Bearer` but the intent API expects `X-API-Key`, so every event carried the placeholder intent and an enrichment error. Now uses the embedded IntentClient (correct auth) plus the shared cache, so message bursts no longer trigger one intent fetch per event.
- **`loadConfig` dropped the `intent`, `memory_api`, and `moltbook` blocks**: it rebuilds the config from an allowlist of known sections, and these three were missing — so intent gating, intent/memory enrichment, and moltbook config silently never received their settings through any CLI entry point. All three now pass through (with a regression test).

### Changed
- `fetchIntentGate` in `background.mjs` is built on the embedded IntentClient instead of a hand-rolled fetch. Same gate rules, same return shape, same fail-open behavior, same 5s timeout.
- `npm test` now also runs the embedded user-intent-kit test suite.

## 0.6.1 (2026-04-07)

### Docs
- README: new "Publishing state (the other side)" subsection under User Intent Kit, explaining that reading intent via IAK enrichment is only half the loop. Agents also need to publish their own slot heartbeats via `uik-daemon` from `user-intent-kit` >= 0.2.1. Without the daemon slots go stale and other agents treat them as offline.

## 0.6.0 (2026-04-07)

### Added
- **DM inbox polling** in the room watcher (merged from #9 codexmb/dm-poller-support). The poller now watches direct messages addressed to the agent handle in addition to room messages, writing them into the same notification file.
- **Background consolidation** first cut: light / REM / deep phases with sidecar state under `~/.iak/consolidation/` (`f80bd56`).
- **UIK intent gating** for background consolidation: checks `reachability_mode` and `suppress_audio` before scheduling deep phases, so heavy work only runs when the user is reachable (`e2be4a6`).
- Config documentation for the `dm_poller` block and a working `config/macbook.json` reference.

### Fixed
- `config/macbook.json` `dm_poller.api_key` was paired with the wrong handle in an earlier draft — fixed to use the correct @claudeMB key.

### Docs
- README: User Intent Kit section explaining UIK fields and agent usage (`3a46eae`).
- README: v0.5.0 memory payload shapes and verification commands (`59b8da6`).

### Compatibility
No breaking changes to config schema. `dm_poller` is additive; existing configs keep working.

## 0.5.0
Memory backend hooks, payload schema documentation.

## 0.4.0
Initial OpenClaw gateway integration.
