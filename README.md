# IDE Agent Kit

Built for [OpenClaw](https://openclaw.dev) workflows. Local-first. No external server by default.

Multi-agent coordination toolkit for IDE AIs (Claude Code, Codex, Cursor, VS Code agents, local LLM assistants). Room-triggered automation, comment polling, and connectors for [Moltbook](https://www.moltbook.com), GitHub, and [GroupMind](https://groupmind.one) chat rooms.

**One-shot install (macOS):**
```bash
curl -fsSL https://raw.githubusercontent.com/ThinkOffApp/ide-agent-kit/main/scripts/install.sh | bash
```
Idempotent. Installs prereqs via brew, clones the repo, writes a starter
config, wires UserPromptSubmit + Stop hooks, starts the daemon, prints the
LAN URL to paste into CodeWatch — the mobile + watch companion (Play listing in review).

**Manual install:** `npm install -g ide-agent-kit`
**ClawHub:** https://clawhub.ai/ThinkOffApp/ide-agent-kit

## What's new in v0.10.1

v0.10.0 and v0.10.1 together target the three things that make a multi-agent IDE setup frustrating:

**1. Unresponsive agents — you shouldn't have to poke a sleeping IDE.**
- **Self-arming agents (v0.10.1):** every agent re-arms its own wake path on `SessionStart`, so it stays reachable after a restart instead of going dead until a human re-arms it.
- **Peer wake (v0.10.1):** a same-machine agent revives a stuck or sleeping colleague using computer control — no human in the loop. See [Peer Wake](#peer-wake-same-machine-agents-revive-sleeping-colleagues).
- **Lose-nothing delivery (v0.10.0):** a wake that can't land right now retries on the next cycle, and message bodies are held durably until truly delivered — so a message is never consumed-but-undelivered.

**2. Prompting instead of buttons — act by tapping, not typing.**
- Risky actions (deploys, merges, pushes, commands) surface as **Approve/Deny buttons** on your phone or watch via the confirmation gate, with durable off-LAN button state — so you approve with a tap instead of typing a prompt back to the agent.

**3. Typing over the human (v0.10.0).**
- A fail-closed hardware idle guard gates every keystroke a wake can inject, with a recheck at the moment of injection and focus restored on abort — agents never garble your typing.

First releases since June, with cross-model adversarial review on every change. 142 tests. CodeWatch 0.10.117 is the current companion build.

[v0.10.0 notes →](https://github.com/ThinkOffApp/ide-agent-kit/releases/tag/v0.10.0) · [v0.10.1 notes →](https://github.com/ThinkOffApp/ide-agent-kit/releases/tag/v0.10.1)

## Table of Contents

- [Key Integrations](#key-integrations)
- [How It Works](#how-it-works)
- [Features](#features)
- [Quick Start](#quick-start)
- [IDE-Specific Setup](#ide-specific-setup)
  - [Claude Code CLI](#claude-code-cli)
  - [Codex Desktop (macOS)](#codex-desktop-macos)
  - [Gemini / Antigravity](#gemini--antigravity)
  - [Cursor / VS Code](#cursor--vs-code)
- [Room Poller](#room-poller)
  - [Env Vars (Generic Poller)](#env-vars-generic-poller)
  - [Env Vars (Codex Smart Poller)](#env-vars-codex-smart-poller)
  - [Background Consolidation](#background-consolidation)
- [Peer Wake](#peer-wake-same-machine-agents-revive-sleeping-colleagues)
- [Integrations](#integrations)
  - [GitHub Webhooks](#github-webhooks-srcwebhook-servermjs)
  - [OpenClaw Bot Fleet](#openclaw-bot-fleet-srcopenclaw-mjs)
  - [Room Automation](#room-automation-srcroom-automationmjs)
  - [Comment Polling](#comment-polling-srccomment-pollermjs)
  - [Moltbook](#moltbook-srcmoltbookmjs)
  - [Discord Channels](#discord-channels-srcdiscord-pollermjs)
  - [ACP — Agent Client Protocol](#acp--agent-client-protocol-srcacp-sessionsmjs)
- [CLI Reference](#cli)
- [Config](#config)
- [Tests](#tests)

### Key integrations

- **OpenClaw** — manage bot fleet gateway, sessions, exec approvals, hooks, and cron via CLI
- **Moltbook** — post with challenge-verify flow, read feeds, poll comments
- **GitHub** — webhook ingestion, issue/discussion comment polling, reply connectors
- **GroupMind** — room polling, rule-based automation, multi-agent realtime chat

## How it works

IDE Agent Kit is a **message delivery and coordination layer**, not an autoresponder. It delivers messages to your real AI agent (Claude Code, Codex, Gemini, etc.) and lets the agent decide how to respond using its full intelligence, tools, and context. The kit never generates replies on behalf of your agent.

**What is a "fake autoresponder"?** A script that intercepts incoming messages and posts canned or template replies (e.g., "Got it, working on it!", "Thanks for the message!") without the actual AI agent ever seeing or processing the message. These create the illusion of an active agent while providing zero real value. Fake autoresponders are considered harmful in this project — they mislead users, pollute chat history, and undermine trust in agent communication. If you find one in your codebase, remove it.

**Primary path: Webhooks (seconds)**
GitHub event → webhook server → normalized JSONL queue → IDE agent reads queue → acts → receipt.

**Realtime path: Room poller (seconds)**
Poller watches chat room → detects new messages → nudges IDE agent via tmux → agent reads and responds with its own intelligence.
Three agents tested concurrently with <10s response times.

**Fallback path: tmux runner**
Run allowlisted commands in a named tmux session, capture output + exit code.

## Features

1. **Room automation** - rule-based matching (keyword, sender, room, regex) on GroupMind messages → bounded actions (post, exec, nudge) with receipts and cooldowns.
2. **Comment polling** - poll Moltbook posts and GitHub issues/discussions for new comments, write to event queue, nudge IDE agent.
3. **Moltbook connector** - post with challenge-verify flow, read feeds, comment polling.
4. **GitHub connector** - webhook ingestion with HMAC verification, issue/discussion comment polling.
5. **OpenClaw fleet management** - gateway health, agent sessions, exec approvals, hooks, cron — all via CLI.
6. **Room poller** - watch GroupMind chat rooms, auto-ack task requests, nudge IDE agents via tmux.
7. **Webhook relay** - ingest GitHub webhooks, normalize to a stable JSON schema, append to a local queue.
8. **tmux runner** - run allowlisted commands in a named tmux session, capture output + exit code.
9. **Receipts** - append-only JSONL receipts with trace IDs + idempotency keys.
10. **Session keepalive** - prevent macOS display/idle sleep for long-running remote sessions.
11. **IDE init** - generate starter configs for Claude Code, Codex, Cursor, or VS Code.
12. **ACP sessions** - Agent Client Protocol integration for internal agent orchestration with token-gated access, allowlists, and full receipt trail.
13. **Background consolidation** - optional `light / REM / deep` pass over recent queue items, with append-only sidecars and no effect on the foreground room loop by default.

No dependencies. Node.js ≥ 18 only.

## IDE-Specific Setup

Choose the guide for your AI environment:

### Claude Code CLI
1. Run `ide-agent-kit init --ide claude-code`. This generates `.claude/settings.json` with auto-approval, room-polling, and session-bootstrap hooks.
2. Start the poller: `export IAK_API_KEY=xfb_xxx && ./scripts/room-poll.sh`.
3. Start Claude: `claude --dangerously-skip-permissions`.

#### SessionStart auto-bootstrap (self-arming agents)

`init` (and `scripts/install.sh`) also wire `scripts/session-bootstrap.sh` as a
`SessionStart` hook. On every session start — fresh launch, resume, or
post-compaction — the hook injects instructions so the agent re-arms itself:
a persistent Monitor on the poller's notification file (instant wake), a read
of any backlog that piled up while no session was running, and the self-paced
room loop with a fallback `ScheduleWakeup`. No more typing `/loop check rooms`
by hand after a restart.

The hook is merged into an existing `settings.json` without touching unrelated
hooks (a `settings.json.bak` backup is taken first) and is deduplicated, so
re-running `init` or the installer never duplicates it. Overrides:
`IAK_NEW_FILE` (notification file, default `/tmp/iak-new-messages.txt` or
config `poller.notification_file`), `IAK_HANDLE` (agent handle, default config
`poller.handle`), `IAK_CONFIG_JSON` (config path), and
`IAK_BOOTSTRAP_FALLBACK_SEC` (fallback wakeup interval, default 1500s).

### Claude Code Desktop (macOS)

For the Claude Code desktop app (GUI, no tmux needed):

1. Run `ide-agent-kit init --ide claude-code`.
2. Copy the GUI poller scripts to your setup:
   - `scripts/claude-gui-poll.sh` — polls rooms and DMs every 15s, writes new messages to a notification file
   - `scripts/claude-gui-wake.sh` — sends an osascript keystroke to the Claude Code desktop app to wake it
3. Configure your `dogfood.json` (or equivalent) with `nudge_mode: "command"` and point `nudge_command` at `claude-gui-wake.sh`.
4. Start the poller: `node bin/cli.mjs rooms watch --config config/your-config.json`
5. Add a `UserPromptSubmit` hook in `.claude/settings.json` that reads the notification file and injects messages into context.

**macOS permissions required:**
- Privacy & Security → Accessibility: allow Terminal (or whichever app runs the poller)
- Privacy & Security → Automation: allow Terminal to control System Events

The wake script uses `osascript` to send a Return keystroke to the Claude Code app window, triggering the prompt submit hook which reads pending messages.

### Codex Desktop (macOS)
1. Run `ide-agent-kit init --ide codex`.
2. Configure `ide-agent-kit-codex.json` with your GroupMind API key.
3. Start the smart poller: `./tools/codex_room_autopost.sh tmux start`.
4. Use `codex_gui_nudge.sh` if you need GUI-only notification injection.

### Gemini / Antigravity App
1. Run `ide-agent-kit init --ide gemini`.
2. Enable the `memory` module in `ide-agent-kit.json`.
3. Start the poller: `./tools/geminimb_room_autopost.sh tmux start`.

### Cursor / VS Code
1. Run `ide-agent-kit init --ide cursor` or `--ide vscode`.
2. Configure the `ide-agent-kit.json` with your rooms and handles.
3. Start the watcher: `ide-agent-kit rooms watch`.

### Grok Build (and other non-Claude agents)

Grok Build has no Claude `SessionStart` hook. Copy
[`config/grok.example.json`](config/grok.example.json) → `config/grok.json`
(fill key + handle; never commit the live file), then:

1. **Poller:** `node bin/cli.mjs rooms watch --config config/grok.json`
   (run under tmux, e.g. session `grok-poll`).
2. **Wake path — pick one:**
   - **tmux nudge:** set `poller.nudge_mode: "tmux"` and run Grok **inside**
     the `tmux.ide_session` pane so send-keys hit the live TUI; or
   - **Grok-native loop:** inside the Grok session, arm
     `/loop 2m check rooms` (min 60s; auto-expires in 7 days).
3. Use a **per-agent** `notification_file` / `seen_file` (do not share
   Claude's `/tmp/iak-new-messages.txt`).

**Footgun:** `nudge_mode: "none"` only writes the notify file; the agent will
look dead until a human types `check room`. Full write-up:
[docs/grok-build.md](docs/grok-build.md).


## Room Poller

The repo includes three poller implementations for watching GroupMind chat rooms. All are env-var-driven with no hardcoded secrets, and each includes PID lock files to prevent duplicate instances.

The **generic poller** (`scripts/room-poll.sh` + `scripts/room-poll-check.py`) works with any IDE agent. It polls configured rooms, auto-acknowledges task requests from the project owner, and nudges the IDE agent via tmux keystrokes. Configuration is entirely through environment variables, making it easy to run multiple instances for different agents.

**Poll command (`ide-agent-kit poll`) nudge modes**:
- `poller.nudge_mode = "tmux"` (default): send `tmux send-keys`
- `poller.nudge_mode = "command"`: execute `poller.nudge_command` with `IAK_NUDGE_TEXT` in env (useful for GUI agents)
- `poller.nudge_mode = "none"`: queue-only polling, no nudge side effects

### Codex Desktop setup (macOS)

For Codex Desktop GUI (non-tmux) use command-mode nudging:

```json
{
  "poller": {
    "rooms": [
      "thinkoff-development",
      "feature-admin-planning",
      "lattice-qcd"
    ],
    "handle": "@CodexMB",
    "interval_sec": 60,
    "api_key": "groupmind_xxx",
    "seen_file": "/tmp/codex-room-seen.txt",
    "notification_file": "/tmp/codex-room-notifications.txt",
    "nudge_mode": "command",
    "nudge_command": "/ABSOLUTE/PATH/ide-agent-kit/tools/codex_gui_nudge.sh"
  },
  "dm_poller": {
    "enabled": true,
    "seen_file": "/tmp/codex-dm-seen.txt",
    "limit": 100,
    "human_only": false
  },
  "tmux": {
    "ide_session": "codex",
    "nudge_text": "check room and respond only if you have something relevant to say [codex]"
  }
}
```

Run:

```bash
node bin/cli.mjs rooms watch --config /ABSOLUTE/PATH/ide-agent-kit-codex.json
```

When `dm_poller.enabled` is set, the same watcher also polls `/api/v1/messages?limit=100`, keeps a separate DM seen-state file, and nudges on new `type: "dm"` rows addressed to your configured handle. DM notifications are appended to the normal notification file so existing `rooms check` and GUI-nudge flows continue to work.

There is also a ready-to-copy example at:

```bash
config/codex.desktop.example.json
```

macOS permissions required for GUI keystroke injection:
- Privacy & Security → Accessibility: allow Terminal/iTerm (whichever runs the poller)
- Privacy & Security → Automation: allow Terminal/iTerm to control `System Events`

The **Gemini poller** (`tools/geminimb_room_autopost.sh`) is a self-contained bash script with built-in tmux lifecycle management (start/stop/status/logs). It includes hearing-check responses with latency reporting and supports both mention-only and all-message intake modes.

The **Codex smart poller** (`tools/antigravity_room_autopost.sh`) is also self-contained with tmux lifecycle management. It processes all messages by default with stale/backlog protection (skipping messages older than 15 minutes or from before process start). Its smart path uses `codex exec` to generate real LLM-powered replies, falling back to explicit status messages when generation is unavailable.

The **Codex room-duty wrapper** (`tools/codex_room_autopost.sh`) reuses that same engine but sets Codex-friendly defaults for handle, session name, API-key lookup, and state files. Use it when you want Codex to keep polling assigned rooms without manual prompts.

### Background Consolidation

The first dogfoodable consolidation pass is now available behind a separate CLI entrypoint:

```bash
ide-agent-kit background status --config ide-agent-kit.json
ide-agent-kit background run --config ide-agent-kit.json
```

This is intentionally separate from `rooms watch`.

- Foreground room polling remains reactive.
- Background consolidation is opt-in.
- One run executes the three human-readable phases sequentially:
  - `light`
  - `REM`
  - `deep`
- The background job never auto-posts into rooms in this first cut.

What each phase does in the first implementation:

- `light`: reads the last 2 hours of queue events (hard cap 100), stages them into a short-term working set, and writes a sidecar.
- `REM`: synthesizes recurring themes, open threads, and follow-up candidates from the staged set, then writes a sidecar.
- `deep`: promotes only explicit durable facts and decisions into an append-only local memory ledger, then writes a sidecar.

Execution rules:

- Single background job only; no concurrency.
- Independent phase outcomes; one failure does not abort later phases.
- Skip rules:
  - `light`: skip if there are no new queue events since the previous run
  - `REM`: skip if `light` staged zero items
  - `deep`: skip if `REM` produced no durable facts or decisions

Default timeout set:

- `light = 60s`
- `REM = 120s`
- `deep = 120s`

Sidecar output:

- directory: `~/.iak/consolidation/`
- per-phase file pattern: `<run_id>-<phase>.json`
- durable deep-write ledger: `~/.iak/consolidation/deep-memory.jsonl`

Example config:

```json
{
  "background": {
    "enabled": false,
    "interval_sec": 3600,
    "recent_window_sec": 7200,
    "max_events": 100,
    "sidecar_dir": "~/.iak/consolidation",
    "lock_file": "/tmp/iak-background.lock",
    "timeouts": {
      "light_sec": 60,
      "rem_sec": 120,
      "deep_sec": 120
    }
  }
}
```

#### UIK gating (live intent check at run start)

When the `intent` config block is set, `background run` fetches live user-intent state before executing and decides whether to run fully, run only the `light` phase, or skip entirely. This prevents background consolidation from competing with active work sessions or waking the user during `emergency-only` urgency.

Gating rules (implemented in `fetchIntentGate`):

- `urgency_mode == "emergency-only"` → **skip entirely** (no phases run)
- `overall_state == "working"` with `reachability_mode == "desktop"` or `mobile_full_focus` → **light only** (skip REM and deep)
- `overall_state` in (`meeting_people`, `outdoors`, `exercising`) → **light only**
- `overall_state` in (`sleeping`, `resting`, `unknown`, `transitioning`) → **full dreaming** (all phases allowed)

Pass `--force` on the command line to bypass the gate and run all phases regardless of live intent:

```bash
ide-agent-kit background run --config ide-agent-kit.json --force
```

This integrates with [user-intent-kit](https://github.com/ThinkOffApp/user-intent-kit)'s two-level state model (`overall_state` + `reachability_mode`) and the bundled `uik-daemon` that publishes live state to the intent API.

### Env vars (generic poller)

| Variable | Default | Description |
|----------|---------|-------------|
| `IAK_API_KEY` | (required) | GroupMind API key |
| `IAK_ROOMS` | `thinkoff-development,feature-admin-planning,lattice-qcd` | Rooms to watch |
| `IAK_SELF_HANDLE` | `poller.handle` from config, else `@claudemm` | This agent's handle; its own posts are skipped **case-insensitively** ('@' optional). `IAK_SELF_HANDLES` (comma list) still accepted |
| `IAK_NEW_FILE` | `/tmp/iak-new-messages.txt` | Notification file this agent's poller and session hooks bind to. **Set a per-agent path on multi-agent machines** (e.g. `/tmp/iak-grok-new-messages.txt`): the room-responder lock derives from this file, so two agents sharing the default will fight over one voice and the loser's sessions go passive without warning |
| `IAK_TARGET_HANDLE` | `@claudemm` | Handle used in ack messages |
| `IAK_OWNER_HANDLE` | `petrus` | Only auto-ack from this user |
| `IAK_TMUX_SESSION` | `claude` | tmux session to nudge |
| `IAK_POLL_INTERVAL` | `10` | Seconds between polls |
| `IAK_ACK_ENABLED` | `1` | Auto-ack task requests (`1`/`0`) |
| `IAK_NUDGE_TEXT` | `check rooms` | Text sent to tmux on new messages |
| `IAK_LISTEN_MODE` | `all` | Filter: `all`, `humans`, `tagged`, or `owner` |
| `IAK_BOT_HANDLES` | (empty) | Comma-separated bot handles for `humans` mode |
| `IAK_FETCH_LIMIT` | `20` | Messages per room per poll |

### Env vars (Codex smart poller)

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTIGRAVITY_API_KEY` | (required unless another candidate is set) | GroupMind API key |
| `API_KEY_ENV_CANDIDATES` | `ANTIGRAVITY_API_KEY` | Comma-separated env vars checked for an API key |
| `AGENT_HANDLE` | `@antigravity` | Handle to treat as self and detect mentions for |
| `POLLER_NAME` | `antigravity` | Used in logs, tmux session defaults, and temp-state filenames |
| `ROOMS` | `thinkoff-development,feature-admin-planning,lattice-qcd` | Comma-separated rooms to watch |
| `POLL_INTERVAL` | `8` | Seconds between polls |
| `FETCH_LIMIT` | `30` | Messages per room request |
| `MENTION_ONLY` | `0` | Intake mode: `0` all messages, `1` mention only |
| `SMART_MODE` | `1` | `1` enables `codex exec` real-response generation |
| `STATE_PREFIX` | `antigravity` | Prefix for lock/seen/acked temp files so multiple pollers do not collide |
| `CODEX_WORKDIR` | repo root | Working directory for `codex exec` |
| `CODEX_APPROVAL_POLICY` | `on-request` | Codex approval policy for smart replies |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex sandbox mode for smart replies |
| `MAX_REPLY_AGE_SEC` | `900` | Skip stale messages older than this age |
| `SKIP_PRESTART_BACKLOG` | `1` | Skip messages older than process start |

### User Intent Kit (embedded)

The User Intent Kit (UIK) gives agents awareness of the user's current state and availability. As of v0.9.0 UIK lives inside this repo at `packages/user-intent-kit` (still published separately as `user-intent-kit` on npm, including the Python/Swift/Kotlin ports). IAK consumes it directly through `src/intent.mjs`, which builds clients from the `intent` config block:

```json
{
  "intent": {
    "baseUrl": "https://groupmind.one/api/v1",
    "apiKey": "<X-API-Key for the intent API>",
    "userId": "petrus",
    "deviceId": "mac-mini",
    "agentHandle": "@claudemm",
    "suppress_nudges": true
  }
}
```

Everything below activates automatically when this block is present (and stays inert when it is absent):

- **Background gating** — `background run` checks the live gate before each consolidation run (see UIK gating above).
- **Event enrichment** — incoming room/DM events get the full intent snapshot under the `intent` key, with a 30s cache so message bursts cost one API call, not one per event.
- **Nudge suppression** — `rooms watch` still writes every message to the notification file, but skips the tmux/command nudge while `derived.urgency_mode` is `emergency-only`. Set `"suppress_nudges": false` to opt out. All checks fail open: if the intent API is down, nudges behave as before.
- **`intent` CLI** — `ide-agent-kit intent <get|profile|derived|state|patch|heartbeat|daemon>` for inspecting and publishing state without a separate checkout.

When the optional enrichment sidecar is configured, it queries the Intent API on each incoming room message to fetch a real-time snapshot of the user's devices, active agents, and derived behavioral signals.

The intent payload includes:

- **`devices`** and **`agents`**: which devices and agent instances are currently online, along with their last-seen timestamps.
- **`stale_devices`** / **`stale_agents`**: devices and agents that have gone silent beyond their expected heartbeat window.
- **`derived.urgency_mode`**: computed urgency level (`normal`, `focus`, `emergency-only`) that agents can use to decide whether to interrupt the user or batch notifications.
- **`derived.available_modalities`**: what interaction channels are available right now (e.g. `["read"]`, `["read", "audio"]`), so agents can choose text vs voice vs visual output.
- **`derived.preferred_device`**: which device the user is most likely active on, or `null` if no device is clearly preferred.
- **`derived.suppress_audio`**: whether audio notifications should be suppressed based on current context.

Agents can use these signals to adapt their behavior. For example, an agent might skip posting a non-urgent status update when `urgency_mode` is `emergency-only`, or route output to text instead of audio when `suppress_audio` is true.

The intent data is fetched from the GroupMind API at `GET /intent/{userId}` and injected into queue events under the `intent` key with `provider: "groupmind"`.

#### Publishing state (the other side)

Reading the intent API is only half the loop. To keep your own device and agent slots alive on the dashboard, run the built-in publisher as a long-running background process:

```bash
ide-agent-kit intent daemon --config ide-agent-kit.json   # uses config.intent.*
npx uik-daemon   # standalone equivalent, INTENT_* env vars
```

The IDE Agent Kit and User Intent Kit are designed to be deployed together: IAK consumes the intent state for gating, UIK publishes your own heartbeats. Without the daemon your slot goes stale and other agents will treat you as offline.

UIK v0.2.2 or later recommended for the `uik-daemon` bin. v0.2.0 introduced the daemon, v0.2.1 fixed a silent-exit in the example file, and v0.2.2 added agent-status republish on the heartbeat cadence so the agent slot does not expire while the daemon is running. Pre-0.2.2 daemons publish device state correctly but the agent slot still goes stale after its TTL.

### Enrichment Configuration

To enable sidecar enrichment (Memory and Intent), add the following blocks to your `ide-agent-kit.json`:

```json
{
  "intent": {
    "baseUrl": "https://groupmind.one/api/v1",
    "apiKey": "groupmind_your_key",
    "userId": "your_user_id"
  },
  "memory_api": {
    "baseUrl": "http://127.0.0.1:37777/api",
    "token": "your_claude_mem_token"
  }
}
```

*Note: the enrichment path exists and works when configured, but it is still optional. If the `intent` block is absent, queue events fall back to a placeholder `intent` payload and no live UIK data is fetched.*

When enrichment is enabled, each queued room event can be expanded with:

- `intent`: the full JSON payload returned by `GET /intent/{userId}`, plus `provider: "groupmind"`.
- `memory_context.raw`: an array of text snippets returned by Claude-Mem search.
- `enrichment_errors`: fetch or schema problems encountered while calling either upstream service.

The current Claude-Mem context retrieval path is message-driven. For each incoming room message, the sidecar uses the message body as the search query and calls:

```text
GET {memory_api.baseUrl}/search/observations?query=<message body>&limit=3
Authorization: Bearer <memory_api.token>
```

The response is expected to be MCP-style JSON:

```json
{
  "content": [
    { "type": "text", "text": "..." }
  ]
}
```

All returned `content[]` entries with `type: "text"` are copied into `memory_context.raw`. This is how prior Claude-Mem observations are threaded back into queue events for downstream agents.

Example enriched event shape:

```json
{
  "kind": "groupmind.message.created",
  "payload": {
    "body": "can we ship the release notes today?",
    "room": "thinkoff-development"
  },
  "intent": {
    "user_id": "petrus",
    "derived": {
      "urgency_mode": "emergency-only"
    },
    "provider": "groupmind"
  },
  "memory_context": {
    "raw": [
      "Recent Claude-Mem observation text"
    ]
  },
  "enrichment_errors": []
}
```

### Verify Enrichment

Verify the two upstream integrations independently before debugging the poller:

```bash
# 1. Intent lookup should return HTTP 200 JSON
curl -i \
  -H "Authorization: Bearer groupmind_your_key" \
  "https://groupmind.one/api/v1/intent/your_user_id"

# 2. Claude-Mem lookup should return HTTP 200 JSON with a content[] array
curl -i \
  -H "Authorization: Bearer your_claude_mem_token" \
  "http://127.0.0.1:37777/api/search/observations?query=release%20notes&limit=3"
```

Latest local verification from the Petrus machine, dogfooded against `v0.6.1`:

- `GET /intent/petrus` returned `200` on `2026-04-08`, with `agents=[claudemb, claudemm]` and `devices=[macbook, mac-mini]` both active and zero stale slots after the UIK v0.2.2 deployment.
- `GET /api/search/observations?query=thinkoff&limit=3` returned `200` on `2026-03-31` (claude-mem path unchanged since v0.5.0).

## Peer wake (same-machine agents revive sleeping colleagues)

Pollers and webhooks wake an agent whose receiver is running. But when an agent's
IDE goes quiet — the session wedged, the tunnel died silently, the app lost focus —
nothing is listening to wake it. **Peer wake** closes that gap: a watchdog running
in the always-on layer of a machine can revive any agent whose IDE lives on the
**same machine**, driving its GUI directly with no network dependency.

`scripts/team-watchdog.mjs` is that watchdog. Every interval it reads the room,
computes each roster agent's last-seen timestamp, and for anyone that has gone
quiet past `STALE_MIN` it fires exactly one wake path — rate-limited by a cooldown
and an `MAX_NUDGES` cap so it never spams.

**The model — who can wake whom:**

```
machine M (always-on watchdog)
  ├─ localWake  → agent's IDE is ON machine M      → GUI-wake it directly,
  │                                                   works even with no network
  ├─ gate       → agent is on ANOTHER machine       → POST <gate>/wake to its
  │                                                   daemon — only lands if that
  │                                                   machine is awake + receiver up
  └─ (neither)  → gateless agent in the room         → room @mention its poller catches
```

A watchdog only *directly* revives agents whose IDE runs on its own machine
(`localWake`). Cross-machine wake (`gate`, the same primitive as the
[`wake_remote` MCP tool](#whats-new-in-v070)) still needs the target machine
awake and its receiver alive — a laptop that is *asleep* cannot be woken over the
network without Wake-on-LAN. That is the one thing peer wake cannot do; run a
watchdog **on each machine** so every agent has a local reviver.

**Roster format** — `config/watchdog-roster.json` (gitignored; it holds hosts and
machine paths). Copy [`config/watchdog-roster.example.json`](config/watchdog-roster.example.json)
and edit it for the agents that live on *this* machine. Each entry names one wake path:

```json
[
  { "handle": "@codex-on-this-mac",  "localWake": "/abs/path/ide-agent-kit/tools/codex_gui_nudge.sh" },
  { "handle": "@agent-elsewhere",    "gate": "http://192.168.0.9:8788" },
  { "handle": "@gateless-agent" }
]
```

The roster can also come from `IAK_WATCHDOG_ROSTER` (inline JSON) or
`IAK_WATCHDOG_ROSTER_FILE`. No roster → nothing to watch (the watchdog logs and
idles), so it is safe to run everywhere.

**Safety: never types over a human.** `localWake` GUI-types into the target app,
so every wake script the watchdog invokes routes through
[`tools/human-idle-guard.sh`](tools/human-idle-guard.sh): it refuses to inject
keystrokes unless the machine has been idle past `IDLE_THRESHOLD_S` (default 60s),
**fails closed** when idle state is unknown, and `--wait`s for an idle window
rather than dropping the nudge. The shipped wake scripts (`scripts/claude-gui-wake.sh`,
`tools/codex_gui_nudge.sh`) already call it (and also refuse to type into a locked
screen or a non-frontmost window). **Any custom script you point `localWake` at
MUST be idle-guarded too** — the watchdog runs it verbatim.

**Opt-in install (per machine).** The watchdog is off by default — it needs a
roster. Load it with launchd from the parameterized example:

```bash
# 1. create your roster from the example
sed "s|REPLACE_WITH_IAK_ROOT|$HOME/ide-agent-kit|g" \
  config/watchdog-roster.example.json > config/watchdog-roster.json
#    then edit handles/paths for the agents whose IDEs run on THIS Mac

# 2. install + load the LaunchAgent (KeepAlive; restarts if it exits)
sed "s|REPLACE_WITH_IAK_ROOT|$HOME/ide-agent-kit|g" \
  examples/team-watchdog-launchd.plist \
  > ~/Library/LaunchAgents/com.thinkoff.iak-team-watchdog.plist
launchctl load ~/Library/LaunchAgents/com.thinkoff.iak-team-watchdog.plist
```

Or let the installer do it: `IAK_INSTALL_WATCHDOG=1` makes `scripts/install.sh`
install the LaunchAgent (only if a roster exists). On a laptop that sleeps, prefer
the one-shot variant documented in the plist header (`ONCE=1` + `StartInterval`),
since the in-process interval timer stalls across sleep. Tunables (all env, all
optional): `STALE_MIN`, `COOLDOWN_MIN`, `INTERVAL_MIN`, `MAX_NUDGES`, `ROOM`,
`WATCHDOG_SELF`, `DRY_RUN` (detect + log only, no wakes/posts).

## Integrations

### MCP server (`src/mcp-server.mjs`)

Exposes IAK's tmux-backed wake / list / run primitives as MCP tools so any
MCP-aware client (Claude Desktop / Code, Cursor, custom agents) can drive the
agent fleet directly without re-implementing tmux send-keys.

Tools exposed (stdio transport):

| Tool            | Args                              | Notes |
|-----------------|-----------------------------------|-------|
| `wake_ide`      | `session`, `text?` (default `"check rooms"`) | Sends nudge text and presses Enter in the named tmux session. |
| `list_sessions` | (none)                            | Returns every live tmux session on the host with attach state + window count. |
| `wake_all`      | `text?` (default `"check rooms"`) | Sends the same nudge to every session IAK knows about (per-session pass/fail). Configure via `mcp.sessions: ["...", ...]`. Falls back to `tmux.ide_session` + `tmux.default_session`. |
| `read_session`  | `session`, `lines?` (default 50)  | `tmux capture-pane` of the named session — see what the agent printed in response to a `wake_ide`. |
| `tmux_run`      | `cmd`, `session?`, `cwd?`, `timeoutSec?` | Runs an allowlisted command in a tmux session. **Only registered when `tmux.allow` is non-empty or `mcp.allow_unrestricted: true` is set.** Otherwise omitted entirely from the tool list (fail-closed). Same allowlist as the CLI's `tmux run` subcommand. |

### MCP-specific config keys

Added to `ide-agent-kit.json` (or your own config path passed via `--config`):

```jsonc
{
  "mcp": {
    // Explicit list of sessions wake_all should target.
    // If omitted, falls back to [tmux.ide_session, tmux.default_session].
    "sessions": ["claudemb", "antigravity", "codex"],

    // Set true to expose tmux_run with NO allowlist filter — any command runs.
    // Default: false. Use only on a trusted host with a trusted MCP client.
    "allow_unrestricted": false,

    // User-confirmation flow (request_confirmation, list_intents,
    // approve_intent, deny_intent tools). Tools are only registered if at
    // least one channel below is configured.
    "confirmations": {
      "port": 8788,                    // HTTP port for /intent/:id/decision
      "host": "127.0.0.1",             // bind host (keep local unless tunneled)
      "auth_token": "",                // optional bearer for the HTTP endpoint
      "callback_base": "http://...",   // URL the watch / chat reach back on; defaults to http://host:port
      "room": "thinkoff-development",  // GroupMind room to post the prompt in (uses poller.api_key)
      "codewatch_gate_url": "http://family@localhost:18791/intent",
      "codewatch_gate_token": ""       // bearer for CLAWWATCH_GATE
    }
  }
}
```

### Confirmation flow (request_confirmation tool)

When `mcp.confirmations` is configured, four extra tools appear:

| Tool                  | Args                                              | Notes |
|-----------------------|---------------------------------------------------|-------|
| `request_confirmation`| `prompt`, `session?`, `channels?`, `timeoutSec?`, `fromHandle?` | Posts an Approve / Deny prompt to GroupMind and/or Codewatch and BLOCKS until user decides or timeout. Returns `{decision: "approve"\|"deny"}` or `{status: "timeout", id}`. `fromHandle` defaults to `poller.handle` for correct agent attribution. |
| `list_intents`        | (none)                                            | All intents — pending and recently decided. |
| `approve_intent`      | `id`                                              | Manually settle a pending intent (e.g. MCP override). |
| `deny_intent`         | `id`                                              |  |

Non-MCP agents can use the same shared confirmation daemon through the CLI:

```bash
node bin/cli.mjs confirm request \
  --config /path/to/ide-agent-kit.json \
  --prompt "Approve destructive command?" \
  --session codex \
  --channels groupmind \
  --from @CodexMB \
  --wait

node bin/cli.mjs confirm list --config /path/to/ide-agent-kit.json
```

The request command POSTs to the live daemon's `/intent` endpoint, so CodeWatch
polling `/intents` shows the confirmation in the matching IDE channel (for
example `session=codex...` maps to `@CodexMB`) and phone/watch Approve/Deny
buttons settle the same intent. `--wait` blocks until a decision or timeout.

End-to-end:
1. MCP-aware agent calls `request_confirmation({prompt: "Drop production DB?"})`.
2. The IAK MCP server posts to GroupMind room (`/approve <id>` / `/deny <id>` quick replies) and to the CLAWWATCH_GATE (Android interactive notification with Approve / Deny buttons that vibrate the watch).
3. User taps Approve / Deny on the watch — Codewatch's notification action POSTs to `http://<callback_base>/intent/<id>/decision` with `{decision: "approve"}`.
4. The MCP tool's blocking `request_confirmation` call resolves with the decision.
5. The agent proceeds (or doesn't) based on the decision.

Run standalone:

```bash
node bin/iak-mcp.mjs              # default config
node bin/iak-mcp.mjs --config /path/to/config.json
npm run mcp                       # via package.json script
```

Wire into Claude Desktop / Code:

```json
{
  "mcpServers": {
    "ide-agent-kit": {
      "command": "node",
      "args": ["/absolute/path/to/ide-agent-kit/bin/iak-mcp.mjs"]
    }
  }
}
```

After install: restart the MCP client. The four tools above appear in the tool
picker and can be called directly.

### GitHub Webhooks (`src/webhook-server.mjs`)

Receives GitHub webhook events, verifies HMAC signatures, normalizes them to a stable JSON schema, and appends to a local JSONL queue. Optionally nudges a tmux session when events arrive.

Supported events: `pull_request.opened`, `pull_request.synchronize`, `pull_request.closed`, `push`, `issue_comment.created`, `issues.opened`.

```bash
# Start the webhook server
node bin/cli.mjs serve --port 8787

# Configure GitHub to send webhooks to:
#   http://your-host:8787/webhook
# Set a webhook secret in config for HMAC verification

# GroupMind webhooks are also accepted at:
#   http://your-host:8787/groupmind
```

Config keys: `listen.port`, `github.webhook_secret`, `github.event_kinds`, `queue.path`.

### OpenClaw Bot Fleet (`src/openclaw-*.mjs`)

Five modules for managing an [OpenClaw](https://openclaw.dev) multi-agent bot fleet via its CLI. Since the OpenClaw gateway uses WebSocket (not HTTP) for RPC, all modules shell out to the `openclaw` CLI, optionally over SSH for cross-user setups.

**Why this matters:** OpenClaw agents run as long-lived processes with their own models, memory, and tool access. IDE Agent Kit bridges the gap between these agents and your IDE workflow — letting room messages trigger agent actions, receipts flow between agents, and fleet operations happen from a single CLI.

The **Gateway** module (`src/openclaw-gateway.mjs`) handles starting, stopping, and restarting the OpenClaw gateway, including deep health checks. Use it to ensure your fleet is running before triggering automations.

```bash
# Check gateway health
node bin/cli.mjs gateway health
node bin/cli.mjs gateway health-deep

# List active agents
node bin/cli.mjs gateway agents

# Restart gateway (e.g. after config change)
node bin/cli.mjs gateway config-patch --json '{"key": "value"}'
```

The **Sessions** module (`src/openclaw-sessions.mjs`) sends messages to agents and lists active sessions. Use it for agent-to-agent communication — for example, asking one agent to review another's work.

```bash
# Send a message to a specific agent
node bin/cli.mjs gateway trigger --agent ether --message "review PR #6"

# Wake all agents
node bin/cli.mjs gateway wake --text "new deployment ready" --mode now
```

The **Exec Approvals** module (`src/openclaw-exec.mjs`) provides a governance layer for agent command execution. It manages an approval queue (pending, allow, deny) and reads OpenClaw's native per-agent, glob-based exec-approvals allowlist from `~/.openclaw/exec-approvals.json`.

The **Hooks** module (`src/openclaw-hooks.mjs`) registers and manages event hooks for agents. Supported events include `message:received`, `message:sent`, `command:new`, `command:reset`, `command:stop`, `agent:bootstrap`, and `gateway:startup`. Hooks can be placed per-agent in `workspace/hooks/` or shared in `~/.openclaw/hooks/`.

The **Cron** module (`src/openclaw-cron.mjs`) handles scheduled task management, letting you list, add, and remove cron tasks for any agent.

```bash
# List cron jobs
node bin/cli.mjs cron list

# Add a scheduled poll
node bin/cli.mjs cron add --name "hourly-comments" --task "poll GitHub comments" --schedule "0 * * * *"
```

**Example: full OpenClaw + IDE Agent Kit workflow**

1. Room message arrives in GroupMind → room automation matches a rule
2. Rule triggers `gateway trigger --agent ether --message "deploy staging"`
3. Ether agent runs the deployment, writes a receipt
4. Receipt is appended to the JSONL log with trace ID
5. Comment poller detects a new GitHub comment on the deploy PR
6. IDE agent is nudged via tmux to review the comment

```bash
# OpenClaw config (in team-relay config file)
{
  "openclaw": {
    "home": "/path/to/openclaw",
    "bin": "/opt/homebrew/bin/openclaw",
    "ssh": "family@localhost"
  }
}
```

### Room Automation (`src/room-automation.mjs`)

Rule-based automation triggered by GroupMind room messages. Define match conditions (keyword, sender, room, regex, mention) and bounded actions (post to room, exec command, nudge tmux). Every action produces a receipt. Includes cooldowns and first-match-only mode to prevent cascading.

```bash
# Start automation engine
node bin/cli.mjs automate --rooms thinkoff-development --api-key $KEY --handle @mybot

# Rules in config (ide-agent-kit.json):
{
  "automation": {
    "rules": [
      { "name": "greet", "match": { "sender": "petrus", "keywords": ["hello"] }, "action": { "type": "post", "room": "${room}", "body": "Hello!" } },
      { "name": "deploy", "match": { "mention": "@mybot", "regex": "deploy|ship" }, "action": { "type": "nudge", "text": "check rooms" } }
    ]
  }
}
```

#### Multi-agent routing (the room as a tool bus)

The same `automation.rules` schema doubles as a per-agent permission table when each agent runs its own IAK instance with its own ruleset. A common multi-agent config:

```json
{
  "automation": {
    "rules": [
      { "name": "self-wake",       "match": { "mention": "@claudemb" },                                "action": { "type": "nudge", "text": "check rooms" } },
      { "name": "summarize-bus",   "match": { "mention": "@claudemb", "regex": "summari[sz]e|recap" }, "action": { "type": "exec",  "command": "node bin/cli.mjs summarize ${room}" } },
      { "name": "deploy-gate",     "match": { "sender": "petrus", "mention": "@claudemb", "regex": "deploy|ship|release" }, "action": { "type": "nudge", "text": "deploy current branch" } },
      { "name": "ignore-acks",     "match": { "mention": "@claudemb", "regex": "^(ok|thanks|got it)\\.?$" }, "action": { "type": "post", "body": "" } }
    ]
  }
}
```

Each rule scopes which messages reach which action: `match` filters on sender, room, mention, keywords, regex; `action.type` constrains the side-effect (`post` / `exec` / `nudge`). A message that matches no rule is ignored. To restrict an agent to read-only behaviour, drop all `exec` and `nudge` rules from its config and keep only `post` rules.

For ad-hoc multi-agent dispatch (one room, several agents responding to different mentions), give each agent's IAK instance rules keyed on its own `@handle`. The mention pattern in the body is the routing key; each agent reads the same room but acts on its own slice.

### Comment Polling (`src/comment-poller.mjs`)

Polls Moltbook posts and GitHub issues/discussions for new comments. Writes new comments to the event queue and optionally nudges the IDE tmux session.

```bash
# One-shot poll
node bin/cli.mjs comments poll --config ide-agent-kit.json

# Long-running watcher
node bin/cli.mjs comments watch --config ide-agent-kit.json

# Config:
{
  "comments": {
    "moltbook": { "posts": ["uuid1", "uuid2"] },
    "github": { "repos": [{ "owner": "org", "repo": "name", "type": "issues" }] },
    "interval_sec": 120
  }
}
```

### Moltbook (`src/moltbook.mjs`)

Post to [Moltbook](https://www.moltbook.com) with challenge-verify flow, read feeds, and poll comments. Supports submolt targeting and configurable base URLs.

```bash
# Post to Moltbook
node bin/cli.mjs moltbook post --content "Hello from my agent" --api-key $KEY

# Read feed
node bin/cli.mjs moltbook feed --limit 10
```

### GroupMind Chat Rooms (`scripts/room-poll*.`)

See [Room Poller](#room-poller) above. Provides realtime multi-agent communication via shared chat rooms at [groupmind.one](https://groupmind.one).

### Discord Channels (`src/discord-poller.mjs`)

Polls Discord channels for new messages via the OpenClaw CLI (`openclaw message read --channel discord`). Writes events to the JSONL queue with `source: "discord"` and `kind: "discord.message.created"`. The webhook server also accepts Discord events at `POST /discord`.

Requires OpenClaw 2026.2.25+ with the Discord plugin enabled.

```bash
# One-shot poll
node bin/cli.mjs discord poll --config ide-agent-kit.json

# Long-running watcher
node bin/cli.mjs discord watch --config ide-agent-kit.json
```

Config:
```json
{
  "discord": {
    "channels": [
      { "id": "1474426061218386094", "name": "general" }
    ],
    "interval_sec": 30,
    "self_id": "1474422169470636134",
    "skip_bots": false
  }
}
```

### ACP — Agent Client Protocol (`src/acp-sessions.mjs`)

Structured task orchestration for multi-agent teams. ACP adds session lifecycle on top of room-based chat: assign a task, track progress, close with receipts. Secure by default (disabled, token-gated, allowlisted, localhost-only).

```bash
# 1. Assign a task to an agent
node bin/cli.mjs acp spawn --agent @claudemm --task "Review PR #42"
# => Session created: a1b2c3d4

# 2. Add context mid-task
node bin/cli.mjs acp send --session a1b2c3d4 --body "Focus on auth changes" --from @ether

# 3. Check progress
node bin/cli.mjs acp list --status active

# 4. Close when done
node bin/cli.mjs acp close --session a1b2c3d4 --reason "merged"
```

Also available via `POST /acp` on the webhook server (token auth via `X-ACP-Token` header). Every action is receipted, including denied requests.

```json
{
  "acp": {
    "enabled": false,
    "token": "your-secret-token",
    "allowed_agents": ["@claudemm", "@ether"],
    "session_timeout_sec": 3600,
    "max_concurrent_sessions": 5,
    "sessions_file": "./data/acp-sessions.json"
  }
}
```

#### What ACP + IDE Agent Kit adds beyond standard ACP

Standard ACP is designed for 1 IDE controlling 1 agent via CLI. IDE Agent Kit extends this to production multi-agent teams:

1. **Multi-agent, multi-IDE** -- N agents across N IDEs (Claude Code, Codex, Gemini) on different machines, coordinated through shared rooms + ACP sessions.
2. **Cross-service message projections** -- ACP sessions tie into unified messaging across GroupMind, xfor, and AgentPuzzles. Task receipts are visible on all platforms.
3. **Room-aware context** -- ACP sessions reference room threads. Agents pick up tasks from ACP, discuss in rooms, close sessions with receipts linking back to the conversation.
4. **Operational policy layer** -- Token-gated allowlists, per-session message caps, timeout enforcement, and receipt trails on denied requests go beyond ACP's built-in permission modes.
5. **OpenClaw fleet bridge** -- ACP sessions can trigger OpenClaw gateway agents through the existing CLI. ACP handles task routing, OpenClaw agents handle execution.

ACP gives us the protocol. IDE Agent Kit gives us the multi-agent, multi-surface, receipted execution layer on top.

### Other modules

**Receipts** (`src/receipt.mjs`) provides an append-only JSONL receipt log with trace IDs and idempotency keys for auditing every action. **Emit** (`src/emit.mjs`) sends receipts or arbitrary payloads to external webhook URLs. **Memory** (`src/memory.mjs`) offers persistent key-value storage for agents across sessions. **Session Keepalive** (`src/session-keepalive.mjs`) manages macOS `caffeinate` to prevent display and idle sleep during long-running remote sessions. **tmux Runner** (`src/tmux-runner.mjs`) executes allowlisted commands in tmux sessions with output capture. **Watch** (`src/watch.mjs`) monitors JSONL queue files for changes.

## Naming convention (frozen)

- JSON fields (events, receipts, config): **snake_case**
- CLI flags: **kebab-case** (mapped to snake_case internally)

## CLI

```
ide-agent-kit serve [--config <path>]
ide-agent-kit automate --rooms <rooms> --api-key <key> --handle <@handle> [--interval <sec>]
ide-agent-kit comments <poll|watch> [--config <path>]
ide-agent-kit discord <poll|watch> [--interval <sec>] [--config <path>]
ide-agent-kit poll --rooms <rooms> --api-key <key> --handle <@handle> [--interval <sec>]
ide-agent-kit moltbook <post|feed> [--content <text>] [--api-key <key>]
ide-agent-kit tmux run --cmd <command> [--session <name>] [--cwd <path>] [--timeout-sec <sec>]
ide-agent-kit emit --to <url> --json <file>
ide-agent-kit receipt tail [--n <count>]
ide-agent-kit gateway <health|agents|trigger|wake> [options]
ide-agent-kit memory <list|get|set|append|delete|search> [options]
ide-agent-kit init [--ide <claude-code|codex|cursor|vscode|gemini>] [--profile <balanced|low-friction>]
ide-agent-kit acp <spawn|list|status|send|close> [options]
ide-agent-kit keepalive <start|stop|status> [--pid-file <path>] [--heartbeat-sec <sec>]
```

## Config

See `config/team-relay.example.json` for the full config shape. Key sections:

- `listen` - host/port for webhook server
- `queue.path` - where normalized events are appended (JSONL)
- `receipts.path` - where action receipts are appended (JSONL)
- `tmux.allow` - command allowlist (prefix match)
- `tmux.default_session` - tmux session name
- `tmux.nudge_text` - what the wake script types into the IDE (default `check rooms`)
- `tmux.ide_session` - tmux session name of your Claude Code (or other IDE) instance — `wake_ide` MCP tool targets this
- `github.webhook_secret` - HMAC secret for signature verification
- `github.event_kinds` - which GitHub events to accept
- `poller.api_key` - GroupMind API key used by the room poller + chat-reply poller in `iak-mcp-daemon`
- `poller.notification_file` - where the poller drops new messages for the IDE hooks (default `/tmp/iak-new-messages.txt`); also read by `scripts/session-bootstrap.sh`
- `poller.history_file` - per-room message history the poller keeps so a mention arrives with its thread: the full parent, the reply chain above it, the asker's previous message, the agent's own last post (default: next to `seen_file`, `<seen_file>-history.json`; 400 messages per room). `poller.fetch_limit` (default 25) is the per-poll window; a reply whose target is older triggers one deeper fetch.
- **State of play.** Any room message starting with `state:` or `settled:` is a settled fact ("state: card = the benchmark table v2, not hardware"). Every poller records them and, when a batch contains an owner message or a mention, prepends one `STATE OF PLAY` line for that room to the notification file, so agents answer the thread instead of re-deriving it (issue #90). Notification lines stay one physical line per message; the thread rides inside the line.
- `poller.handle` - the agent's room handle; `scripts/session-bootstrap.sh` uses it to label the bootstrap instructions
- `mcp.sessions` - list of tmux sessions `wake_all` MCP tool targets
- `mcp.confirmations` - confirmation registry settings (used by `iak-mcp-daemon`):
  - `port` - HTTP listener port (default `8788`); also serves the browser Approve/Deny UI at `/`
  - `host` - bind address (default `127.0.0.1`; use `0.0.0.0` for LAN-reachable so phones / watches / other Macs on the same wifi can hit `/intent`, `/wake`, `/intents`)
  - `room` - GroupMind room slug to post confirmation requests to (also where the chat-reply poller watches for `/approve <id>` and `/deny <id>`)
  - `callback_base` - public URL of this daemon (e.g. `http://192.168.50.240:8788`) — used in the chat post and as the link from the browser UI
  - `auth_token` - optional bearer token gating `POST /intent/:id/decision` and `POST /intent`
  - `wake_script` - path to the wake script; defaults to `scripts/claudemb-wake.sh` in the repo. Used by `POST /wake` and the `wake_remote` MCP tool
  - `peers` - map of `@handle` → daemon URL on a peer machine; the room poller's `wake-on-mention.sh` POSTs `/wake` to the matching peer when it sees `@handle` in a new room message. Example:
    ```json
    "peers": {
      "@claudemm": "http://192.168.50.241:8788",
      "@CodexMB":  "http://192.168.50.241:8788"
    }
    ```
  - `codewatch_gate_url` / `codewatch_gate_token` - legacy CodeWatch relay path (separate from the Wear OS bridge that ships in the CodeWatch Android app)

### Low-friction profile

Use the `low-friction` profile when you want fewer manual accept prompts for routine non-destructive commands.

```bash
node bin/cli.mjs init --ide codex --profile low-friction
```

This profile broadens `tmux.allow` to include common read/build/test commands (`rg`, `ls`, `cat`, `git log/show`, `npm run lint/typecheck/test`, etc.) while still excluding destructive commands by default.

## Schemas

- `schemas/event.normalized.json` - normalized inbound event
- `schemas/receipt.json` - action receipt

## Tests

```bash
node --test test/*.test.mjs
```

## Example flow

See `examples/flow-pr-opened.md` for a complete PR → test → receipt walkthrough.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for details.
All source files include `SPDX-License-Identifier: AGPL-3.0-only`.
Source code for this deployment is available at commit [be641cf](https://github.com/ThinkOffApp/team-relay/tree/be641cf).

## GroupMind Helpers

- `examples/flow-pr-opened.md` — example PR-opened event flow.
  Uses `gemini -p` with a hard timeout to prevent stuck polling loops.
