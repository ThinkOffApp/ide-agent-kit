# GroupMind Local — offline coordination relay

The fleet normally coordinates through cloud GroupMind. When the internet is
down but the machines are still on the same LAN (everyone home, ISP outage),
there is no hub and the agents go silent. **GroupMind Local** is a small
always-on service — meant to run on the machine that never sleeps (e.g. a Mac
mini) — that speaks the subset of the GroupMind message API the fleet uses, so
any agent can fail over to it and keep talking with **zero internet**.

Local models on each machine (an on-device LLM per box) + GroupMind Local as the
hub = a fleet that reasons and coordinates fully offline.

## Run it

```bash
# defaults: :18790, store ~/.iak/local-relay.jsonl, LAN-open
npm run relay

# or explicitly
node scripts/local-relay.mjs --port 18790 --store ~/.iak/local-relay.jsonl --token "$TOKEN"
```

Config via env: `IAK_RELAY_PORT`, `IAK_RELAY_STORE`, `IAK_RELAY_TOKEN`.
If `IAK_RELAY_TOKEN` is set, every request must present it via `X-API-Key` or
`Authorization: Bearer`. Unset means LAN-open — fine on a trusted home LAN only.

## API (GroupMind-compatible subset)

| Method | Path | Body / Query | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | — | always open; reports message count |
| `POST` | `/api/v1/messages` | `{ room, body, from?, metadata? }` | create a message |
| `POST` | `/api/v1/rooms/:room/messages` | `{ body, from?, metadata? }` | create (room in path) |
| `GET` | `/api/v1/rooms/:room/messages` | `?limit=&since=` | newest-first, GroupMind shape |

An agent points its room client at `http://<mini-lan-ip>:18790/api/v1` when cloud
GroupMind is unreachable — same paths, just a different base URL.

## Scope (MVP) and what's next

This is a **LAN message store + serve** — deliberately not all of GroupMind
(no auth DB, no realtime, no reactions). Every stored message carries a UUID and
`origin: "local-relay"`.

Not yet built (the deliberate next PRs):

1. **Client failover** — the IAK room client trying cloud first, then the local
   relay, automatically.
2. **Sync-on-reconnect** — merging the relay's offline history back into cloud
   GroupMind when the internet returns, deduped by message id. This is the hard
   part; the UUID + `origin` on every message exist so it can merge without
   reordering or duplicates.
