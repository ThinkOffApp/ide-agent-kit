# Changelog

## Unreleased

### Added
- The device heartbeat now reports which LLM the machine is actually serving, as `model`. It is a live reading: `ServedModelProbe` asks a local OpenAI-compatible endpoint (`INTENT_MODEL_ENDPOINT`, default `127.0.0.1:8080`) and publishes the id it answers with, verbatim.
- `probeServedModels()` in `model-capacity.js` - one model-list GET with the existing credential rules, for callers that want the name and not the switcher's p90/free-memory/path readings.
- `INTENT_MODEL_KIND`, `INTENT_MODEL_KEY_FILE` (a **path**, never a token), `INTENT_MODEL_PROBE_MS`.
- A second, weaker and separately-labelled model claim: **available**. `model-availability.js` scans this box's model directories, verifies a download is complete, measures the memory budget, and publishes `model_state`, `model_available`, `model_needs_gb` and `model_held_by`. `model` still means SERVED and nothing else.
- `bin/model-available.mjs` - the same reading for a human, one line per model with its evidence.
- Two fit states, never one. `fits-now` means the weights plus a KV reserve fit in the memory available **right now**, nothing stopped. `fits-if-freed` means it fits the box but not alongside what is resident, and it must name its price in GB. A model compared only against the total budget silently assumes the operator will quit everything else.
- `INTENT_MODEL_DIRS` (colon-separated search roots), `INTENT_MODEL_BUDGET_GB` (an operator's budget for a box we cannot measure), `INTENT_MODEL_SCAN_MS`.

### Changed
- `INTENT_DEVICE_MODEL` is now a last resort rather than the first answer. A server that answered has just stated the truth; a setting can only be stale.

### Why
The dashboard has rendered this field since 17 Sep and the API has always accepted it - the publisher simply never put it in the payload. Detection rather than configuration because the failure that matters is a model name on a public screenshot that belongs to no running process: nothing serving, a 401, or a dead probe all publish **no `model` key at all**, never a placeholder.

The device chips could only say "a server is advertising this right now", so a box holding 75 GB of verified weights with nothing loaded rendered as blank - which undersells the fleet and tempts somebody into typing the model name into the config, publishing a claim that is not true. The repair is a weaker claim that is measured, not a stronger one that is not.

Three rules make it safe to publish. An undeterminable memory budget reports `budget-unknown` and **never** a positive fit: on Apple Silicon the ceiling is Metal's recommended working set (measured on the MacBook: 115.4 GB of 137.4 GB installed), and with no mlx to ask and `iogpu.wired_limit_mb` at 0 there is no figure, only an unpublished kernel policy. A partially downloaded model reports `incomplete` - `.incomplete` blobs, dangling snapshot links, shard gaps and the weight index are all checked, because a half-downloaded model reading "available and fits" is the exact defect this feature prevents. And a SERVED model always outranks an available one for the same box.

The live headroom comes from `vm_stat`'s reclaimable counters on macOS, not `memory_pressure`: measured here, the latter reported 86% free on a box with 34.8 GB of active pages and an 18.5 GB VM resident, because it counts running applications as free. Cache the kernel hands back counts toward `fits-now`; memory only a human can return does not.

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
