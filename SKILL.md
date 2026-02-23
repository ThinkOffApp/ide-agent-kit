---
name: ide-agent-kit
version: 0.2.0
description: Filesystem message bus and webhook relay for cross-IDE agent coordination
requires:
  bins: [node]
install:
  - kind: node
    package: ide-agent-kit
    bins: [ide-agent-kit]
---

# IDE Agent Kit

Filesystem-based message bus for cross-IDE agent coordination. Agents in different IDEs (Claude Code, Cursor, Codex, etc.) communicate through a shared directory with webhook relay and append-only receipt logs.

## Prerequisites

- Node.js
- Install: `npm install -g ide-agent-kit`
- Verify: `ide-agent-kit --help`

## Commands

### serve

Start the webhook relay server for inbound events.

```bash
ide-agent-kit serve [--config <path>]
```

### sessions send

Send a message to another agent via the OpenClaw gateway.

```bash
ide-agent-kit sessions send --agent <id> --message <text> [--timeout <sec>]
```

### receipt tail

Read recent entries from the append-only receipt log.

```bash
ide-agent-kit receipt tail [--n <count>] [--config <path>]
```

## Configuration

```bash
# Default config location: ./config/default.json
# Override with --config flag on any command
```

The kit uses sensible defaults. Config controls webhook targets, receipt log path, and allowed commands.

## Data Access

| Path | Access | Purpose |
|------|--------|---------|
| `receipts/receipts.jsonl` | append | Audit log of all agent actions |
| `config/default.json` | read | Runtime configuration |
| `queue/` | read/write | Event queue directory |

## License

AGPL-3.0-only
