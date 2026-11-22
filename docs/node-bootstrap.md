# Linux node service (draft; no fleet installation yet)

`iak-node plan /absolute/node.json` prints a user-service unit. `install` creates
that unit without overwriting an existing unit or starting it. The printed
systemctl command enables it; boot without login additionally needs user linger.
The service binds a configured Tailscale IPv4 address, never all interfaces.
Provide an existing per-agent GroupMind key file and a separate random wake token
file (at least 32 characters); keep both mode 0600. Tokens never appear in the unit.

Configuration example (paths must be adapted on the owning machine):

```json
{
  "id": "m5", "handle": "@deep", "host": "100.88.157.24", "port": 8788,
  "rooms": ["thinkoff-development"], "healthRoom": "thinkoff-development",
  "keyFile": "/home/petrus/.config/iak/groupmind.key",
  "tokenFile": "/home/petrus/.config/iak/wake.token",
  "stateFile": "/home/petrus/.local/state/iak/node.json",
  "deliver": ["/absolute/receipt-aware-agent-adapter", "deliver"],
  "freshSession": ["/absolute/receipt-aware-agent-adapter", "fresh"]
}
```

The runner-specific adapter is required; this change does **not** claim a
working Hermes deployment. It receives one JSON object on stdin, returns exactly
one JSON receipt on stdout, and exits successfully. Room text is never a shell
command. Delivery receives `type: room_message`, the complete message, node ID
and a stable `deliveryId`. Only return `status: delivered` after durable acceptance.
The runner must deduplicate delivery IDs. Return `context_full` for a measured
context-limit failure; the service invokes the fresh-session command once and
requires `status: fresh`, then retries that same pending message once. A further
failure stays pending. The fresh adapter must retain the previous transcript and
reload persistent commitments; it must not blindly delete session history.
An async wake/202 alone cannot prove delivery or detect a full context.

Initial startup baselines the latest 100 messages per watched room. Later polls
queue exact @handle mentions, skip self messages and retain unconfirmed deliveries
across service restarts. This is at-least-once delivery, not exactly-once execution;
keep one service per state file. Outages exceeding the API's 100-message window
can miss messages; pagination/catch-up is still required before deployment at
higher traffic. Shared handles across machines deliver to each configured node;
use distinct handles if tasks must target only one machine.

Authenticated `GET /health` reports local service state and pending count, not
model correctness. `POST /wake` triggers a poll, ignores request content, and is
rate limited. Both require `Authorization: Bearer <wake token>`. Optional room
health posts happen only when service state changes and verify the returned
sender. No periodic healthy check-ins. Remote offline alerts require an external
monitor: a dead process cannot announce its own death.

Tests: `node --test test/node-service.test.mjs`.
