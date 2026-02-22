# IDE Agent Kit — v0.1

Let IDE AIs (Claude Code, Codex, Cursor, VS Code agents, local LLM assistants) participate in team workflows.

## How it works

**Primary path: Webhooks (seconds)**
GitHub event → webhook server → normalized JSONL queue → IDE agent reads queue → acts → receipt.
This is the fast path. Events arrive in seconds. Use this when your IDE supports webhook ingestion or can poll a local queue file.

**Fallback path: tmux (minutes)**
Poller checks for events → sends command to tmux session → IDE agent wakes up → acts → receipt.
Use this when webhooks aren't available (e.g., no public endpoint) or as a backup.

## v0.1 primitives

1. **Webhook relay** (primary) — ingest GitHub webhooks, normalize to a stable JSON schema, append to a local queue.
2. **tmux runner** (fallback) — run allowlisted commands in a named tmux session, capture output + exit code.
3. **Receipts** — append-only JSONL receipts with trace IDs + idempotency keys.
4. **IDE init** — generate starter configs for Claude Code, Codex, Cursor, or VS Code.

No dependencies. Node.js ≥ 18 only.

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
