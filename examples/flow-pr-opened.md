# Example flow: PR opened → task → tmux run → receipt

## 1) Inbound event
GitHub webhook: `pull_request` opened.

The webhook server (`ide-agent-kit serve`) verifies the signature, normalizes to `TeamRelayNormalizedEvent` ([schema](../schemas/event.normalized.json)), and appends one JSON line to the queue file (`queue.path`, default `./ide-agent-queue.jsonl`).

## 2) IDE agent picks up task
An IDE agent reads the queue file, sees a new event, and decides to run tests.

## 3) Execute via tmux
Command:

`ide-agent-kit tmux run --session ide-agent --cmd "npm test" --timeout-sec 120`

The runner:
- ensures the command is allowlisted
- runs it in the tmux session
- captures exit code and last N lines of stdout/stderr

## 4) Receipt
IDE Agent Kit appends a receipt JSON to the receipts file (`receipts.path`, default `./ide-agent-receipts.jsonl`).

Optionally emit it:

`ide-agent-kit emit --to <webhook-url> --json <receipt-file>`
