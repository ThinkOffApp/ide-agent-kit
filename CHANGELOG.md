# Changelog

## 0.7.0 (2026-05-02)

### Added
- **MCP server** (`bin/iak-mcp.mjs`) exposing `wake_ide`, `list_sessions`, `wake_all`, `read_session`, `tmux_run`, plus a fail-closed allowlist gate for `tmux_run` so it is omitted from the tool list entirely when no `tmux.allow` is configured (PR #10, commits `1a3378e`, `ab1784e`).
- **`request_confirmation` MCP tool** + `iak-mcp-daemon` long-running flavor with HTTP listener + chat-reply poller. Agents can ask for explicit user approval over the room and over CodeWatch (`6dc0d57`, `62fd0bd`).
- **`POST /intent` endpoint** on the daemon — any caller (not just MCP tools) can create a confirmation intent. Used by the new PreToolUse Bash gate on the mini side (`1f63d80`).
- **`POST /wake` endpoint + `wake_remote` MCP tool** for cross-machine direct nudge between Claude Code instances. Spawns the configured wake script detached, returns 202 immediately (`c985b52`).
- **GroupMind announcements include `metadata.actions` + `metadata.intent_id`** so antfarm `messages/route.ts` can render inline Approve/Deny buttons (paired with `antfarm` PR #13) (`0f1c6d0`).
- **`scripts/claudecode-stop-resume.sh`** — Stop-hook auto-resume mechanism for the Claude Code desktop app, alternative to AppleScript wake when Accessibility permission is unavailable (`01b7180`).
- **`scripts/install.sh`** — one-shot macOS bootstrap. Brew prereqs, repo clone, npm install, starter config, hook wiring, tmux daemon start, prints LAN URL for CodeWatch (`1dfd456`, `95101b2`).
- **`docs/auto-wake.md`** — full setup guide for both AppleScript and Stop-hook auto-wake paths (`927c3d8`).
- **Configurable `mcp.sessions`** array replaces the fragile "scan every top-level config key for objects with a .session string" heuristic. Falls back to `tmux.ide_session` + `tmux.default_session`.
- **`read_session` MCP tool** for capturing tmux pane output after `wake_ide`.

### Changed
- Server version now read from `package.json` at module load time instead of hard-coded.
- `tmux_run` allowlist matcher kept the prefix-match semantics from prior releases; shell-chain bypass via `&&` and `;` remains a known limitation flagged by @CodexMB during PR #10 review. Argv-based allowlist semantics deferred to a follow-up release.

### Compatibility
- New `mcp.confirmations` config block (room, host, port). Daemon exits 2 if `mcp.confirmations.room` and `mcp.confirmations.codewatch_gate_url` are both unset.
- Existing configs without `mcp` block keep working — MCP server + daemon are opt-in.

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
