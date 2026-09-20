# config/models.json - the fleet model registry

JSON has no comments, so the annotations for `models.example.json` live here.
Copy the example to `config/models.json` and edit it; `config/models.json` is
the file `bin/model-capacity.mjs` reads by default.

```json
{ "models": [ { "id": ..., "host": ..., "port": ..., "kind": ..., "box": ..., "sharing": ..., "owner": ..., "auth": ..., "keyFile": ... } ] }
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
| `auth`    | no  | `none` \| `bearer`, default `none` (or `bearer` when `keyFile` is set). `bearer` means: send `Authorization: Bearer <token>` on the model-list GET, if a token can be resolved for this entry. |
| `keyFile` | no  | **A PATH** to a file containing the token, nothing else. `~` is expanded. Implies `auth: "bearer"`. The probe warns if the file is group or world readable, and refuses a value that looks like a pasted token rather than a path. |

**No credentials, ever, as values.** `key`, `apiKey`, `api_key`, `token`,
`apiToken`, `accessToken`, `bearer`, `bearerToken`, `secret`, `password`,
`authorization`, `credentials` and `headers` are refused by the loader with a
message saying what to do instead. This file is shared, it is committed, and
the repository is public: a token written here is published rather than
configured. Name a `keyFile` and keep the token outside the repo, `chmod 600`.

## Credentials

Some endpoints need a bearer token. The GLM server on `asus1:8888` is one: it
answers `401 {"error":"Unauthorized"}` to an unauthenticated `GET /v1/models`,
while the same request with `Authorization: Bearer <token>` returns its model
list. So the probe sends the header when it has a token FOR THAT ENTRY, and
sends nothing when it does not.

Three sources, first hit wins:

1. the entry's own `keyFile` (a path)
2. env `LLM_API_KEY_FILE` (a path)
3. env `LLM_API_KEY` (a value - it works, and the probe warns, because an
   environment value is inherited by every child process)

A `keyFile` that is configured but unreadable does **not** fall through to the
environment. Silently substituting a different credential for the one the
entry named would make "which key was refused?" unanswerable; instead the run
reports `needs auth: no key configured for this entry; cannot read key file
<path> (ENOENT)`.

Nothing the probe prints contains the token. The result carries `keySource`
(`entry keyFile` / `env LLM_API_KEY_FILE` / `env LLM_API_KEY`) and `authState`
(`no-key` / `rejected` / `sent` / `open`), which say where a key came from and
what the server did with it, and can never carry the key itself.

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

Measured on 20 Sep 2026, the same two addresses for the same GLM box:

| from | `asus1:8888` | `192.168.0.45:8888` |
| ---- | ------------ | ------------------- |
| MacBook, Berlin (same flat as the box) | answers | answers - it is on that LAN |
| mini, Helsinki | answers | **no route** |

`192.168.0.45` is not a wrong address. It is a *Berlin* address, and it stops
being an address at all the moment the laptop moves. `asus1` keeps working
from both cities, which is the entire argument.

Loopback (`127.0.0.1`, `localhost`, `[::1]`) is allowed and is not a LAN IP for
this purpose: it means "the box the switcher is running on", which is equally
true in both cities.

`--allow-lan` exists for a deliberate single-site run (bringing a new box up
before it is on the tailnet). It is not a default and the CLI says so on every
run that uses it.

## `~/.iak/model-selection.json` - what the picker writes

`bin/model-picker.mjs` probes this registry, offers every entry that is UP as
one button on the phone, and writes the tapped one here:

```json
{
  "selectedId": "glm53-asus",
  "baseUrl": "http://asus1:8888/v1",
  "model": "GLM-5.3-Flash-EXL3",
  "keyFile": "~/.iak/glm53_asus_api_key.txt",
  "selectedAt": "2026-09-20T07:16:47.600Z",
  "selectedFrom": "mb"
}
```

Three things about that file, each of which is a rule and not a detail:

* `keyFile` is a PATH, exactly as the registry carries it. The token is never
  read, resolved or written by the picker, so this file can be copied around
  and quoted in a room without leaking anything. Consumers read the file
  themselves.
* `selectedFrom` names the host that probed. Path and latency are per peer
  pair, so a selection made on one box is not evidence about another.
* An entry whose `keyFile` cannot be read is never selected, even when it is
  the only one answering. vLLM and llama.cpp serve `/v1/models` without auth,
  so such a box looks healthy to the probe and refuses the first real request;
  the probe reports it as `keyBlocked` and the picker excludes it by name.
* With exactly one usable entry there is nothing to choose between, so the
  picker applies it without asking (after the same re-probe) unless it is
  already selected. `--require-choice` turns that back into a refusal.
* `selectedAt` is the time of the RE-PROBE, not of the offer. The picker
  probes the chosen entry again when the answer arrives and refuses to apply
  an entry that stopped being UP while the human was deciding, which means the
  previous selection survives a box that filled up mid-question.
