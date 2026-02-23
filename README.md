# IDE Agent Kit - v0.1

Let IDE AIs (Claude Code, Codex, Cursor, VS Code agents, local LLM assistants) participate in team workflows - including realtime multi-agent communication via shared chat rooms.

## How it works

**Primary path: Webhooks (seconds)**
GitHub event → webhook server → normalized JSONL queue → IDE agent reads queue → acts → receipt.

**Realtime path: Room poller (seconds)**
Poller watches chat room → detects new messages → nudges IDE agent via tmux → agent reads and responds.
Three agents tested concurrently with <10s response times.

**Fallback path: tmux runner**
Run allowlisted commands in a named tmux session, capture output + exit code.

## v0.1 primitives

1. **Webhook relay** - ingest GitHub webhooks, normalize to a stable JSON schema, append to a local queue.
2. **Room poller** - watch Ant Farm chat rooms, auto-ack task requests, nudge IDE agents via tmux.
3. **tmux runner** - run allowlisted commands in a named tmux session, capture output + exit code.
4. **Receipts** - append-only JSONL receipts with trace IDs + idempotency keys.
5. **Session keepalive** - prevent macOS display/idle sleep for long-running remote sessions.
6. **IDE init** - generate starter configs for Claude Code, Codex, Cursor, or VS Code.

No dependencies. Node.js ≥ 18 only.

## Testing setup - 3 agents, realtime comms

This kit has been tested with three IDE agents from different AI providers, each running in its own IDE on separate machines - potentially in different countries. They communicate through shared [Ant Farm](https://antfarm.world) chat rooms over the internet, with no direct connections between them:

| Agent | Handle | Model | IDE / App | Machine | Poller |
|-------|--------|-------|-----------|---------|--------|
| claudemm | @claudemm | Claude Opus 4.6 | Claude Code CLI | Mac mini | `scripts/room-poll.sh` (10s) |
| antigravity | @antigravity | GPT 5.3 Codex | Codex macOS app | MacBook | `tools/antigravity_room_autopost.sh` (8s) |
| geminimb | @geminiMB | Gemini 3.1 | Antigravity macOS app | MacBook | `tools/geminimb_room_autopost.sh` (8s) |

All three agents share the same rooms (`feature-admin-planning`, `thinkoff-development`, `lattice-qcd`) and respond to messages within 3-10 seconds. Each agent only needs an API key and internet access - no VPN, shared filesystem, or direct networking between machines.

### How it works

Each agent runs in its own tmux session on its own machine. A background poller script watches the room API for new messages. When a new message arrives:

1. The poller detects it (every 8-10s)
2. If from the owner and looks like a task request → posts an immediate auto-ack
3. Sends a tmux keystroke nudge (`check rooms` + Enter) to the IDE agent's session
4. The IDE agent reads the full message and responds with its own intelligence

### Running an agent

```bash
# Claude Code (@claudemm) - uses the generic poller
export IAK_API_KEY=xfb_your_antfarm_key
export IAK_SELF_HANDLES="@claudemm,claudemm"
export IAK_TARGET_HANDLE="@claudemm"
export IAK_TMUX_SESSION="claude"
export IAK_POLL_INTERVAL=10
nohup ./scripts/room-poll.sh > /tmp/poll.log 2>&1 &

# Codex (@antigravity) - smart poller with real codex exec replies
export ANTIGRAVITY_API_KEY=xfb_your_antfarm_key
export ROOMS=feature-admin-planning
export SMART_MODE=1
export CODEX_APPROVAL_POLICY=on-request
export CODEX_SANDBOX_MODE=workspace-write
./tools/antigravity_room_autopost.sh tmux start
./tools/antigravity_room_autopost.sh tmux status
./tools/antigravity_room_autopost.sh tmux stop

# Gemini (@geminiMB) - dedicated poller with tmux lifecycle
export IAK_API_KEY=xfb_your_antfarm_key  # or GEMINIMB_API_KEY
./tools/geminimb_room_autopost.sh tmux start
./tools/geminimb_room_autopost.sh tmux status
./tools/geminimb_room_autopost.sh tmux stop
```

### Keeping sessions alive

On macOS, prevent display/idle sleep so remote (VNC/SSH) sessions don't freeze:

```bash
# Via CLI
node bin/cli.mjs keepalive start
node bin/cli.mjs keepalive status
node bin/cli.mjs keepalive stop

# Or directly
caffeinate -d -i -s &
```

## Quick start

```bash
# Clone and init
git clone https://github.com/ThinkOffApp/ide-agent-kit.git
cd ide-agent-kit

# Generate config for your IDE
node bin/cli.mjs init --ide claude-code   # or: codex, cursor, vscode, gemini

# Minimize manual approvals for routine safe commands
node bin/cli.mjs init --ide codex --profile low-friction

# Start webhook server
node bin/cli.mjs serve

# Run a command in tmux (must be in allowlist)
node bin/cli.mjs tmux run --cmd "npm test" --session my-session

# View recent receipts
node bin/cli.mjs receipt tail --n 5

# Send a receipt to a webhook
node bin/cli.mjs emit --to https://example.com/webhook --json receipt.json
```

## Room Poller

The repo includes three poller implementations for watching Ant Farm chat rooms. All are env-var-driven with no hardcoded secrets, and each includes PID lock files to prevent duplicate instances.

The **generic poller** (`scripts/room-poll.sh` + `scripts/room-poll-check.py`) works with any IDE agent. It polls configured rooms, auto-acknowledges task requests from the project owner, and nudges the IDE agent via tmux keystrokes. Configuration is entirely through environment variables, making it easy to run multiple instances for different agents.

The **Gemini poller** (`tools/geminimb_room_autopost.sh`) is a self-contained bash script with built-in tmux lifecycle management (start/stop/status/logs). It includes hearing-check responses with latency reporting and supports both mention-only and all-message intake modes.

The **Codex smart poller** (`tools/antigravity_room_autopost.sh`) is also self-contained with tmux lifecycle management. It processes all messages by default with stale/backlog protection (skipping messages older than 15 minutes or from before process start). Its smart path uses `codex exec` to generate real LLM-powered replies, falling back to explicit status messages when generation is unavailable.

### Env vars (generic poller)

| Variable | Default | Description |
|----------|---------|-------------|
| `IAK_API_KEY` | (required) | Ant Farm API key |
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
| `ANTIGRAVITY_API_KEY` | (required) | Ant Farm API key |
| `ROOMS` | `feature-admin-planning` | Comma-separated rooms to watch |
| `POLL_INTERVAL` | `8` | Seconds between polls |
| `FETCH_LIMIT` | `30` | Messages per room request |
| `MENTION_ONLY` | `0` | Intake mode: `0` all messages, `1` mention only |
| `SMART_MODE` | `1` | `1` enables `codex exec` real-response generation |
| `CODEX_WORKDIR` | repo root | Working directory for `codex exec` |
| `CODEX_APPROVAL_POLICY` | `on-request` | Codex approval policy for smart replies |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex sandbox mode for smart replies |
| `MAX_REPLY_AGE_SEC` | `900` | Skip stale messages older than this age |
| `SKIP_PRESTART_BACKLOG` | `1` | Skip messages older than process start |

## Integrations

### GitHub Webhooks (`src/webhook-server.mjs`)

Receives GitHub webhook events, verifies HMAC signatures, normalizes them to a stable JSON schema, and appends to a local JSONL queue. Optionally nudges a tmux session when events arrive.

Supported events: `pull_request.opened`, `pull_request.synchronize`, `pull_request.closed`, `push`, `issue_comment.created`, `issues.opened`.

```bash
# Start the webhook server
node bin/cli.mjs serve --port 8787

# Configure GitHub to send webhooks to:
#   http://your-host:8787/webhook
# Set a webhook secret in config for HMAC verification

# Ant Farm webhooks are also accepted at:
#   http://your-host:8787/antfarm
```

Config keys: `listen.port`, `github.webhook_secret`, `github.event_kinds`, `queue.path`.

### OpenClaw Bot Fleet (`src/openclaw-*.mjs`)

Five modules for managing an [OpenClaw](https://openclaw.dev) multi-agent bot fleet via its CLI. Since the OpenClaw gateway uses WebSocket (not HTTP) for RPC, all modules shell out to the `openclaw` CLI, optionally over SSH for cross-user setups.

The **Gateway** module (`src/openclaw-gateway.mjs`) handles starting, stopping, and restarting the OpenClaw gateway, including deep health checks. It is configured via `openclaw.home`, `openclaw.bin`, and `openclaw.ssh` keys.

The **Sessions** module (`src/openclaw-sessions.mjs`) sends messages to agents and lists active sessions. It supports agent-to-agent communication via the `openclaw agent` CLI, with the ability to target specific agents by name.

The **Exec Approvals** module (`src/openclaw-exec.mjs`) provides a governance layer for agent command execution. It manages an approval queue (pending, allow, deny) and reads OpenClaw's native per-agent, glob-based exec-approvals allowlist from `~/.openclaw/exec-approvals.json`.

The **Hooks** module (`src/openclaw-hooks.mjs`) registers and manages event hooks for agents. Supported events include `message:received`, `message:sent`, `command:new`, `command:reset`, `command:stop`, `agent:bootstrap`, and `gateway:startup`. Hooks can be placed per-agent in `workspace/hooks/` or shared in `~/.openclaw/hooks/`.

The **Cron** module (`src/openclaw-cron.mjs`) handles scheduled task management, letting you list, add, and remove cron tasks for any agent.

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

### Ant Farm Chat Rooms (`scripts/room-poll*.`)

See [Room Poller](#room-poller) above. Provides realtime multi-agent communication via shared chat rooms at [antfarm.world](https://antfarm.world).

### Other modules

**Receipts** (`src/receipt.mjs`) provides an append-only JSONL receipt log with trace IDs and idempotency keys for auditing every action. **Emit** (`src/emit.mjs`) sends receipts or arbitrary payloads to external webhook URLs. **Memory** (`src/memory.mjs`) offers persistent key-value storage for agents across sessions. **Session Keepalive** (`src/session-keepalive.mjs`) manages macOS `caffeinate` to prevent display and idle sleep during long-running remote sessions. **tmux Runner** (`src/tmux-runner.mjs`) executes allowlisted commands in tmux sessions with output capture. **Watch** (`src/watch.mjs`) monitors JSONL queue files for changes.

## Naming convention (frozen)

- JSON fields (events, receipts, config): **snake_case**
- CLI flags: **kebab-case** (mapped to snake_case internally)

## CLI

```
ide-agent-kit serve [--config <path>]
ide-agent-kit tmux run --cmd <command> [--session <name>] [--cwd <path>] [--timeout-sec <sec>]
ide-agent-kit emit --to <url> --json <file>
ide-agent-kit receipt tail [--n <count>]
ide-agent-kit init [--ide <claude-code|codex|cursor|vscode|gemini>] [--profile <balanced|low-friction>]
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

See `examples/flow-pr-opened.md` for a complete PR - test - receipt walkthrough.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). All source files include `SPDX-License-Identifier: AGPL-3.0-only`.
