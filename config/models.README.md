# config/models.json - the fleet model registry

JSON has no comments, so the annotations for `models.example.json` live here.
Copy the example to `config/models.json` and edit it; `config/models.json` is
the file `bin/model-capacity.mjs` reads by default.

```json
{ "models": [ { "id": ..., "host": ..., "port": ..., "kind": ..., "box": ..., "sharing": ..., "owner": ... } ] }
```

A bare top-level array is also accepted.

## Fields

| field     | required | meaning |
| --------- | -------- | ------- |
| `id`      | yes | Stable, unique name the switcher shows and the operator types. Not the model weights' name - one box can serve several, and `GET /v1/models` reports those separately. |
| `host`    | yes | **Tailnet MagicDNS name** (`asus1`, `mini`) or tailnet IP (`100.x.y.z`). See the rule below. |
| `port`    | yes | Integer 1-65535. The OpenAI-style HTTP port, not the ssh port. |
| `kind`    | yes | `openai` \| `vllm` \| `lmstudio`. Decides which list endpoint is called: `lmstudio` uses `/api/v1/models` and counts only loaded instances, the other two use `/v1/models`. |
| `box`     | no  | Free text for humans: which machine, where it lives. Shown in `--json`, never probed. |
| `sharing` | no  | `exclusive` \| `shared`, default `shared`. Advisory metadata for the switcher's ranking. The probe applies the same BUSY rules to both - it is documented in `docs/model-capacity.md` rather than silently inferred. |
| `owner`   | no  | Handle of whoever to ask before taking the box. |

**No measurement fields.** `path`, `latencyMs`, `p90Ms`, `jitterMs`,
`freeMemGiB` and `state` are refused by the loader. They are things the probe
finds out at probe time, and path and latency in particular are per peer pair:
two hosts behind the same router were in opposite path states to the same
Berlin box at the same moment. A value written into this shared file is wrong
for every caller except the one who wrote it.

## The rule: tailnet names, never LAN IPs

`host` must not be a private LAN address. The loader rejects `10.x.x.x`,
`192.168.x.x` and `172.16.x.x` - `172.31.x.x` with an explicit message, unless
`--allow-lan` is passed.

Why: the MacBook this switcher runs from travels. The same registry file has to
resolve the same physical box from the Helsinki home base and from the Berlin
flat. A LAN IP is only meaningful on one of those two networks, and - worse - a
`192.168.1.50` written in Berlin can silently resolve to somebody else's
hardware in Helsinki. There is no error to read in that case, just wrong
answers from a stranger's machine.

A tailnet MagicDNS name resolves to the same box over WireGuard from either
place, or from a hotel, and carries its own encryption and authentication.
That is also why plain `http://` is acceptable here: this probe dials only the
tailnet or loopback, never an arbitrary URL. (`model-discovery.js`, on the
unmerged branch `codex/discover-served-models`, covers local-endpoint discovery
and demands `https://` or loopback because it does dial arbitrary URLs. The two
are independent and should be reconciled when that branch merges.)

Loopback (`127.0.0.1`, `localhost`, `[::1]`) is allowed and is not a LAN IP for
this purpose: it means "the box the switcher is running on", which is equally
true in both cities.

`--allow-lan` exists for a deliberate single-site run (bringing a new box up
before it is on the tailnet). It is not a default and the CLI says so on every
run that uses it.
