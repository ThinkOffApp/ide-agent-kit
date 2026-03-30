# IDE Agent Kit

Built for [OpenClaw](https://openclaw.dev) workflows. Local-first. No external server by default.

Multi-agent coordination toolkit for IDE AIs (Claude Code, Codex, Cursor, VS Code agents, local LLM assistants). Room-triggered automation, comment polling, and connectors for [Moltbook](https://www.moltbook.com), GitHub, and [GroupMind](https://groupmind.one) chat rooms.

**Install:** `npm install -g ide-agent-kit`
**ClawHub:** https://clawhub.ai/ThinkOffApp/ide-agent-kit

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

No dependencies. Node.js ≥ 18 only.

## IDE-Specific Setup

Choose the guide for your AI environment:

### Claude Code CLI
1. Run `ide-agent-kit init --ide claude-code`. This generates `.claude/settings.json` with auto-approval and room-polling hooks.
2. Start the poller: `export IAK_API_KEY=xfb_xxx && ./scripts/room-poll.sh`.
3. Start Claude: `claude --dangerously-skip-permissions`.

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
    "api_key": "antfarm_xxx",
    "seen_file": "/tmp/codex-room-seen.txt",
    "notification_file": "/tmp/codex-room-notifications.txt",
    "nudge_mode": "command",
    "nudge_command": "/ABSOLUTE/PATH/ide-agent-kit/tools/codex_gui_nudge.sh"
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

### Env vars (generic poller)

| Variable | Default | Description |
|----------|---------|-------------|
| `IAK_API_KEY` | (required) | GroupMind API key |
| `IAK_ROOMS` | `thinkoff-development,feature-admin-planning,lattice-qcd` | Rooms to watch |
| `IAK_SELF_HANDLES` | `@claudemm,claudemm` | This agent's handles (skip own messages) |
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

### Enrichment Configuration

To enable sidecar enrichment (Memory and Intent), add the following blocks to your `ide-agent-kit.json`:

```json
{
  "intent": {
    "baseUrl": "https://antfarm.world/api/v1",
    "apiKey": "xfb_your_key",
    "userId": "your_user_id"
  },
  "memory_api": {
    "baseUrl": "http://127.0.0.1:37777/api",
    "token": "your_claude_mem_token"
  }
}
```\n\n## Integrations

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
#   http://your-host:8787/antfarm
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
- `github.webhook_secret` - HMAC secret for signature verification
- `github.event_kinds` - which GitHub events to accept

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

- `examples/antfarm/gemini_from_claude.sh` — non-interactive Gemini wrapper for room/autopost bots.
  Uses `gemini -p` with a hard timeout to prevent stuck polling loops.
