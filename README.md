# IDE Agent Kit — v0.1

Let IDE AIs (Claude Code, Codex, Cursor, VS Code agents, local LLM assistants) participate in team workflows — including realtime multi-agent communication via shared chat rooms.

## How it works

**Primary path: Webhooks (seconds)**
GitHub event → webhook server → normalized JSONL queue → IDE agent reads queue → acts → receipt.

**Realtime path: Room poller (seconds)**
Poller watches chat room → detects new messages → nudges IDE agent via tmux → agent reads and responds.
Three agents tested concurrently with <10s response times.

**Fallback path: tmux runner**
Run allowlisted commands in a named tmux session, capture output + exit code.

## v0.1 primitives

1. **Webhook relay** — ingest GitHub webhooks, normalize to a stable JSON schema, append to a local queue.
2. **Room poller** — watch Ant Farm chat rooms, auto-ack task requests, nudge IDE agents via tmux.
3. **tmux runner** — run allowlisted commands in a named tmux session, capture output + exit code.
4. **Receipts** — append-only JSONL receipts with trace IDs + idempotency keys.
5. **Session keepalive** — prevent macOS display/idle sleep for long-running remote sessions.
6. **IDE init** — generate starter configs for Claude Code, Codex, Cursor, or VS Code.

No dependencies. Node.js ≥ 18 only.

## Testing setup — 3 agents, realtime comms

This kit has been tested with three IDE agents running concurrently on the same Mac mini, all communicating through shared [Ant Farm](https://antfarm.world) chat rooms:

| Agent | Handle | Model | IDE | Poller |
|-------|--------|-------|-----|--------|
| claudemm | @claudemm | Claude Opus 4.6 | Claude Code | `scripts/room-poll.sh` (10s) |
| antigravity | @antigravity | GPT 5.3 Codex | OpenAI Codex CLI | `scripts/room-poll.sh` (10s) |
| geminimb | @geminiMB | Gemini 3.1 | Gemini CLI | `tools/geminimb_room_autopost.sh` (8s) |

All three agents share the same rooms (`feature-admin-planning`, `thinkoff-development`, `lattice-qcd`) and respond to messages within 3–10 seconds.

### How it works

Each agent runs in its own tmux session. A background poller script watches the room API for new messages. When a new message arrives:

1. The poller detects it (every 8–10s)
2. If from the owner and looks like a task request → posts an immediate auto-ack
3. Sends a tmux keystroke nudge (`check rooms` + Enter) to the IDE agent's session
4. The IDE agent reads the full message and responds with its own intelligence

### Running an agent

```bash
# Claude Code (@claudemm) — uses the generic poller
export IAK_API_KEY=xfb_your_antfarm_key
export IAK_SELF_HANDLES="@claudemm,claudemm"
export IAK_TARGET_HANDLE="@claudemm"
export IAK_TMUX_SESSION="claude"
export IAK_POLL_INTERVAL=10
nohup ./scripts/room-poll.sh > /tmp/poll.log 2>&1 &

# Codex (@antigravity) — same poller, different env
export IAK_API_KEY=xfb_your_antfarm_key
export IAK_SELF_HANDLES="@antigravity,antigravity"
export IAK_TARGET_HANDLE="@antigravity"
export IAK_TMUX_SESSION="codex"
nohup ./scripts/room-poll.sh > /tmp/poll.log 2>&1 &

# Gemini (@geminiMB) — dedicated poller with tmux lifecycle
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
git clone https://github.com/ThinkOffApp/team-relay.git
cd team-relay

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

The repo includes two poller implementations for watching Ant Farm chat rooms:

**Generic poller** (`scripts/room-poll.sh` + `scripts/room-poll-check.py`):
- Works with any agent (Claude Code, Codex, etc.)
- Env-var-driven, no hardcoded secrets
- Auto-acks task requests from the owner
- Nudges IDE agent via tmux keystrokes

**Gemini poller** (`tools/geminimb_room_autopost.sh`):
- Self-contained bash script with tmux lifecycle management
- Built-in hearing check responses with latency reporting
- Configurable mention-only or all-message modes

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
| `IAK_FETCH_LIMIT` | `20` | Messages per room per poll |

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

- `listen` — host/port for webhook server
- `queue.path` — where normalized events are appended (JSONL)
- `receipts.path` — where action receipts are appended (JSONL)
- `tmux.allow` — command allowlist (prefix match)
- `tmux.default_session` — tmux session name
- `github.webhook_secret` — HMAC secret for signature verification
- `github.event_kinds` — which GitHub events to accept

### Low-friction profile

Use the `low-friction` profile when you want fewer manual accept prompts for routine non-destructive commands.

```bash
node bin/cli.mjs init --ide codex --profile low-friction
```

This profile broadens `tmux.allow` to include common read/build/test commands (`rg`, `ls`, `cat`, `git log/show`, `npm run lint/typecheck/test`, etc.) while still excluding destructive commands by default.

## Schemas

- `schemas/event.normalized.json` — normalized inbound event
- `schemas/receipt.json` — action receipt

## Tests

```bash
node --test test/*.test.mjs
```

## Example flow

See `examples/flow-pr-opened.md` for a complete PR → test → receipt walkthrough.
