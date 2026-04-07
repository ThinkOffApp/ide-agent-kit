# Changelog

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
