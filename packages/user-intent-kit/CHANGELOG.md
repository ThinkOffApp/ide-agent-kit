# Changelog

## Unreleased

### Added
- The device heartbeat now reports which LLM the machine is actually serving, as `model`. It is a live reading: `ServedModelProbe` asks a local OpenAI-compatible endpoint (`INTENT_MODEL_ENDPOINT`, default `127.0.0.1:8080`) and publishes the id it answers with, verbatim.
- `probeServedModels()` in `model-capacity.js` - one model-list GET with the existing credential rules, for callers that want the name and not the switcher's p90/free-memory/path readings.
- `INTENT_MODEL_KIND`, `INTENT_MODEL_KEY_FILE` (a **path**, never a token), `INTENT_MODEL_PROBE_MS`.

### Changed
- `INTENT_DEVICE_MODEL` is now a last resort rather than the first answer. A server that answered has just stated the truth; a setting can only be stale.

### Why
The dashboard has rendered this field since 17 Sep and the API has always accepted it - the publisher simply never put it in the payload. Detection rather than configuration because the failure that matters is a model name on a public screenshot that belongs to no running process: nothing serving, a 401, or a dead probe all publish **no `model` key at all**, never a placeholder.

## 0.2.0 (2026-04-07)

### Added
- `bin/uik-daemon.js` — persistent background daemon that publishes desktop state and agent heartbeats to the intent API. Exposed as `uik-daemon` bin, runnable via `npm run daemon` or `npx uik-daemon`.
- npm `bin` entry for `uik-daemon`.

### Why
Previously the DesktopAdapter and IAKAdapter existed as library code but nothing ran them as a long-lived process, so the intent dashboard showed every device and agent as stale. The daemon closes that gap.

### Deployment
Run under launchd (macOS), systemd (Linux), or a detached tmux session. Environment:
- `INTENT_API_KEY` (required)
- `INTENT_USER_ID` (required)
- `INTENT_AGENT_HANDLE` (default `@agent`)
- `INTENT_DEVICE_ID` (default hostname)
- `POLL_INTERVAL_MS` (default 30000)

See `examples/claudemb-launchd.plist` and `examples/claudemb-daemon.sh` for a working macOS setup.

## 0.1.0

Initial release: IntentClient + IAK/Desktop/OpenClaw adapters, 2-level derived state.

## 0.2.1 (2026-04-07)

### Fixed
- `examples/iak-integration.js` would silently exit once the DesktopAdapter's internal `setInterval` was unref'd, making it useless as a long-running daemon. Added a referenced keep-alive and clarified the comment.

### Docs
- README: new "Running as a daemon" section documenting `npx uik-daemon` and the launchd+tmux deployment pattern. Notes the example file is a one-shot demo; `uik-daemon` is the supported long-running path.

## 0.2.2 (2026-04-08)

### Fixed
- `uik-daemon` published the agent status only once at startup, so the agent slot went stale after its TTL while the device slot stayed fresh from the DesktopAdapter heartbeat. The daemon now re-publishes agent status on the same `POLL_INTERVAL_MS` cadence as the desktop adapter. Caught while dogfooding on the Mac mini.
