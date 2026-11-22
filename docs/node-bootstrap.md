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
  "id": "m5", "handle": "@deepm5", "host": "100.88.157.24", "port": 8788,
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

## Hermes adapter (local-source verified; fleet compatibility needs preflight)

The installed Mac Hermes source supports `chat --query-file - --oneshot --format
stream-json` and explicit `--resume`. `iak-node-hermes /absolute/hermes.json deliver`
implements the receipt contract; use the same command with `fresh` for recovery.
Configure `deliver`/`freshSession` as argv arrays beginning with the absolute Node
binary, then the absolute `bin/iak-node-hermes.mjs` path, adapter config, and action.
The adapter config contains absolute `binary` (Hermes executable), `stateFile`
(its own file, distinct from the node poller's state) and `commitmentsFile`.
Persistent commitments must exist before delivery or recovery. The adapter owns
its explicit session ID: it never resumes an arbitrary `latest` desktop session.
A separate human session is left alone. Completed delivery IDs are deduplicated;
a process crash after a model's side effects but before the receipt is saved
can still cause replay, so the agent must honor the delivery ID too.

Recovery classifies the terminal structured `error` only, with a failed exit code;
it does not treat an assistant discussing context limits as an actual failure.
It archives the old session ID in its own state and starts a fresh CLI session on
the replay. Existing Hermes transcripts are retained. If the target machine's
Hermes lacks this stream-json protocol, installation must wait for a compatible
adapter. No daemon should be enabled until its local CLI capabilities, key
identity, commitments file, route and receipt round-trip have been checked.

A full 100-message page without any known boundary fails closed as degraded;
manual backfill is required rather than silently claiming no missed work. This
implementation does not yet paginate missed history. Polling is serialized within
one process; operators must not configure two units with the same state file.


## Review revision

The source protocol check used installed Hermes commit
`accb82032cfe8f62d7e8675f0409f3cd1a840b8f` (git describe `accb820`), specifically
`hermes_cli/_parser.py` and `hermes_cli/stream_json.py`. This is not proof that
M5/VTA have the same version; run local preflight before enabling a unit.

Superseding the draft limitations above: shared `@deep` configurations now require
an explicit `nodeTag`, e.g. `[node:m5]`; only mentions with that exact tag deliver.
A distinct handle such as `@deepm5` remains the preferred deployment option and
must be provisioned by its owner; this patch creates no identity or key.

A catch-up gap re-baselines after three failed polls. It records room, oldest/newest
IDs and time for the visible 100-message window; the older unseen window's size
is unknown. A change-only health message reports that skip and the node remains
attention-required. This is explicit recovery with possible skipped work, not
lossless pagination. Pending deliveries already stored are preserved.

Each delivery gets three attempts with 15/30-second backoff, then moves into a
persistent dead-letter list. Later messages proceed even while earlier retries
wait. Health includes dead-letter count; operators inspect private state and
requeue after fixing the cause. State can contain message bodies, stays mode0600,
and must not be pasted into the room. Journal diagnostics use fixed stage and
error-class labels, never raw exceptions, message bodies or keys.
