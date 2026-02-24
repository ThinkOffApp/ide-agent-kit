---
name: ide-agent-kit
version: 0.2.0
description: Filesystem message bus and webhook relay for cross-IDE agent coordination
requires:
  bins: [node]
  env: []
install:
  - kind: node
    package: ide-agent-kit
    bins: [ide-agent-kit]
env:
  - name: OPENCLAW_TOKEN
    description: OpenClaw gateway auth token. Required only for gateway/sessions commands.
    required: false
  - name: GITHUB_WEBHOOK_SECRET
    description: HMAC secret for verifying inbound GitHub webhooks. Required only when using serve with GitHub.
    required: false
  - name: ANTFARM_API_KEY
    description: Ant Farm API key for room polling. Required only for the poll command.
    required: false
---

# IDE Agent Kit

Filesystem-based message bus for cross-IDE agent coordination. Zero dependencies.

## Security Model

This skill operates in two tiers:

**Core (local-only, no credentials needed):**
- Local filesystem queue and receipt log — agents read/write files in the working directory
- `init`, `receipt tail`, `memory` (local backend), `keepalive` — no network, no secrets
- `serve` binds to `127.0.0.1` only by default — receives webhooks, writes to local queue

**Advanced (requires explicit opt-in and credentials):**
- `sessions`, `gateway` — talk to an OpenClaw gateway (requires `openclaw.token` in config)
- `poll` — connects to Ant Farm rooms (requires `--api-key` flag)
- `emit`, `hooks create` — POST data to external URLs you specify
- `tmux run`, `exec` — execute shell commands (restricted to an allowlist in config)

No advanced features activate without explicit configuration. The default `init` config has empty credential fields and a minimal command allowlist.

### Network behavior

| Command | Outbound connections | Inbound connections |
|---------|---------------------|---------------------|
| `init`, `receipt tail`, `memory` (local), `keepalive` | None | None |
| `serve` | None | localhost:8787 only (configurable) |
| `poll` | Ant Farm API (HTTPS) | None |
| `sessions`, `gateway` | OpenClaw gateway (localhost by default) | None |
| `emit` | User-specified URL | None |
| `hooks create` | User-specified webhook URL | None |

### Command execution

`tmux run` and `exec` only run commands listed in `tmux.allow` in your config. Default allowlist: `npm test`, `npm run build`, `pytest`, `git status`, `git diff`. Commands not on the list are rejected.

`exec` adds an approval flow: commands go through `exec request` → human/agent `exec resolve` before running.

## Quick Start

```bash
npm install -g ide-agent-kit
ide-agent-kit init --ide claude-code
```

Creates a local `ide-agent-kit.json` config. All credential fields are blank. Nothing connects to any server until you configure it.

## Connectivity Modes

Four modes that compose freely. Only mode 1 is active by default.

### 1. Local Filesystem Bus (default)

Agents on the same machine communicate through a shared queue directory and receipt log. No network, no server, no API keys.

- Queue: `./ide-agent-queue.jsonl`
- Receipts: `./ide-agent-receipts.jsonl`

### 2. Webhook Relay Server (optional)

Receives inbound webhooks from GitHub/GitLab and writes them to the local event queue.

```bash
ide-agent-kit serve [--config <path>]
```

Binds to `127.0.0.1:8787` by default. Set `github.webhook_secret` in config to verify signatures. Does not make outbound connections.

### 3. Ant Farm Room Polling (optional)

Connects to Ant Farm rooms for cross-machine coordination.

```bash
ide-agent-kit poll --rooms <room1,room2> --api-key <key> --handle <@handle> [--interval <sec>]
```

**Requires:** `--api-key` flag (Ant Farm API key). Rate-limited, default 120s interval.

### 4. GitHub Events (optional)

When `serve` is running, point a GitHub webhook at your relay URL. Translates PR/issue/CI events into local queue events.

**Requires:** `github.webhook_secret` in config to verify inbound signatures.

## Commands

### Core (local-only, no credentials)

| Command | Description |
|---------|-------------|
| `init [--ide <name>] [--profile <balanced\|low-friction>]` | Generate starter config |
| `receipt tail [--n <count>]` | Print last N receipts |
| `watch [--config <path>]` | Watch event queue, nudge IDE session on new events |
| `serve [--config <path>]` | Start webhook relay server (localhost only) |
| `memory list\|get\|set\|search` | Manage agent memory (local file backend) |
| `keepalive start\|stop\|status` | Prevent macOS sleep for remote sessions |

### Advanced (requires credentials or explicit config)

| Command | Requires | Description |
|---------|----------|-------------|
| `sessions send --agent <id> --message <text>` | `openclaw.token` | Send message to agent via gateway |
| `sessions spawn --task <text>` | `openclaw.token` | Spawn a new agent session |
| `sessions list\|history\|status` | `openclaw.token` | Query sessions |
| `gateway trigger\|health\|agents` | `openclaw.token` | Gateway operations |
| `poll --rooms <r> --api-key <k> --handle <h>` | Ant Farm API key | Poll rooms for messages |
| `emit --to <url> --json <file>` | None (user specifies target) | POST event JSON to a URL |
| `hooks create --webhook-url <url>` | None (user specifies target) | Create webhook forwarder |
| `tmux run --cmd <command>` | Allowlisted commands only | Run command in tmux, capture receipt |
| `exec request\|resolve\|list` | Allowlisted commands only | Execution approval workflow |
| `cron add\|list\|remove\|run\|status` | `openclaw.token` | Scheduled task management |

## Configuration

Generated by `ide-agent-kit init`. All credential fields default to empty.

| Field | Purpose | Default |
|-------|---------|---------|
| `listen.host` | Webhook server bind address | `127.0.0.1` |
| `listen.port` | Webhook server port | `8787` |
| `tmux.allow` | Allowlisted shell commands | `[npm test, npm run build, pytest, git status, git diff]` |
| `openclaw.token` | Gateway auth (advanced commands) | empty |
| `github.webhook_secret` | Verify GitHub webhooks | empty |

## Data Access

| Path | Access | Purpose |
|------|--------|---------|
| `ide-agent-receipts.jsonl` | append | Audit log of all agent actions |
| `ide-agent-queue.jsonl` | read/write | Event queue |
| `ide-agent-kit.json` | read | Runtime configuration (may contain secrets) |
| `memory/` | read/write | Local agent memory files |

## Source & Verification

- **npm:** https://www.npmjs.com/package/ide-agent-kit
- **Source:** https://github.com/ThinkOffApp/ide-agent-kit
- **Maintainer:** petruspennanen (npm), ThinkOffApp (GitHub)
- **License:** AGPL-3.0-only

The npm package contains no install scripts (`preinstall`/`postinstall`). All code is plain ESM JavaScript. Verify with `npm pack --dry-run` before installing.
