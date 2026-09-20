# Model capacity: what the switcher must check before it switches

The fleet model switcher used to pick an endpoint from a list. A list cannot
tell you whether the box behind an entry has memory free, or whether somebody
is halfway through a render on it. This adds the missing check.

- Registry: `config/models.json` (schema and annotations: `config/models.README.md`)
- Probe: `packages/user-intent-kit/src/model-capacity.js`
- CLI: `bin/model-capacity.mjs`
- Tests: `test/model-capacity.test.mjs`

## The four states

Every entry resolves to exactly one, every run. They are deliberately four and
not two, because the operator action differs in each case.

| state | what was observed | what to do |
| ----- | ----------------- | ---------- |
| `UP` | `GET /v1/models` listed at least one model, and the box reports room | switch here |
| `BUSY` | the endpoint serves models, but the box has a live exclusive job or less free memory than the threshold (default 8 GiB) | do not switch; `busyReason` says which |
| `DOWN` | something answered on that port and is not serving models: an error status, unparseable JSON, a refused redirect, an empty list, or an auth failure | start or fix the server - or configure a key; the `reason` says which |
| `UNREACHABLE` | the name did not resolve, the TCP connect failed, or nothing answered inside the budget | fix the network, the tailnet, or the name |

These distinctions are the whole point of the file:

**"Empty" is never "down".** An endpoint that answers 200 with an empty model
list is `DOWN` - it is up as a process and useless as a model server, and the
fix is to load a model. But an endpoint we never reached is `UNREACHABLE`, not
`DOWN`, because we learned nothing about the server at all. Reporting the two
the same way sends somebody to ssh into a box that their laptop cannot route
to.

**A capacity reading we could not take is not a clean bill of health.** The
memory and process facts come over one `ssh -o BatchMode=yes -o ConnectTimeout=5`,
read-only, running `nvidia-smi --query-gpu=memory.used,memory.total
--format=csv,noheader,nounits`, `free -g` and `pgrep -fl`. If that ssh fails -
no key, box asleep, a Mac with neither memory instrument - the entry keeps its
HTTP state and gets `freeMemGiB: null`, `capacityUnknown: true`, and a reason
string saying so. The CLI prints `free=?`. It never prints 0, and it never
quietly prints a default. A check that cannot fail is not a check.

Both memory instruments run unconditionally and the PARSER picks, rather than
the remote shell doing `nvidia-smi || free -g`. asus1 taught us why: on an ASUS
Ascent GX10, nvidia-smi exits 0 and prints `[N/A], [N/A]`, because Grace
Blackwell memory is unified and has no discrete per-GPU figure. A shell-level
`||` never fires on a zero exit, so the box would have reported
`capacityUnknown` forever while `free -g` sat there with the right answer.

**One slow axis must not erase another axis's finished answer.** Each of the
three readings has its own deadline. A shared per-entry deadline looked simpler
and was wrong: in a live run against four fleet boxes, ssh and `tailscale ping`
contended, the entry hit the shared deadline, and the generic fallback
overwrote an HTTP result that had already come back `ECONNREFUSED` - turning a
precise "nothing is listening on that port" into a vague "no response within
8000 ms".

Busy processes are matched on the process NAME (basename of argv[0]): `grid`,
`cgpt`, `Grid`, `ltx`, `LTX`, plus a python running out of an `ltx25`
virtualenv. Matching the whole command line would mark every box with a
`/var/grid/logs` directory BUSY forever, so it does not.

`sharing: "exclusive" | "shared"` is metadata the switcher can rank on. The
probe applies the same BUSY rules to both, and this paragraph exists so that is
a documented decision rather than a silent one.

## Authentication: a 401 is three answers, not one

Found live at 04:18 on 20 Sep 2026. The probe sent `accept: application/json`
and nothing else, and its comment said "never sends credentials" as though that
settled the matter. The GLM server on `asus1:8888` requires
`Authorization: Bearer <token>`, so every run printed:

```
glm53-asus  DOWN  asus1:8888  ...  GET /v1/models returned HTTP 401
```

**with a key configured and without one, byte for byte the same line** - while
the server was serving perfectly. That is the shape of a check that cannot
fail: confident, well formatted, and incapable of telling its two cases apart.
It was also actively misleading, because `HTTP 401` reads as "go fix the
server" and the server was fine.

A 401 or 403 now resolves to one of two verdicts, chosen by whether a token was
available for that entry:

| observed | `state` | `authState` | `reason` | repair |
| -------- | ------- | ----------- | -------- | ------ |
| 401/403, no token available | `DOWN` | `no-key` | `needs auth: no key configured for this entry` | configure a key; the server is probably healthy |
| 401/403, token was sent | `DOWN` | `rejected` | `auth rejected: key present but refused` | the key is wrong, expired, or for another box |
| 200, token was sent | normal | `sent` | the ordinary UP / BUSY rules run | - |
| 200, no token (open server) | normal | `open` | the ordinary UP / BUSY rules run | - |

Both auth failures are `DOWN`, because neither can serve a model right now.
The state was never the informative part; the *repair* is, and the two repairs
are opposite.

`200` with a working key hands control straight back to the ordinary rules and
does not short-circuit into `UP`: a box whose key works and whose GPU is
halfway through an LTX render is still `BUSY`. There is a test for that, because
"the key worked" is exactly the kind of good news that invites a short-circuit.

### Credentials are paths, never values

`config/models.json` is shared, is committed, and this repository is public. A
token written into it is published rather than configured. So:

- The registry may carry `"auth": "bearer"` and `"keyFile": "<path>"`.
- `loadRegistry` **refuses** an entry with `key`, `apiKey`, `api_key`, `token`,
  `apiToken`, `accessToken`, `bearer`, `bearerToken`, `secret`, `password`,
  `authorization`, `credentials` or `headers` - the same mechanism that already
  refuses measurement fields, for the same reason: some things must not live in
  that file.
- A `keyFile` whose value looks like a pasted token rather than a path is
  refused too, instead of being read as a relative filename and reported as a
  missing file.

Resolution order for one entry, first hit wins:

1. the entry's `keyFile` (a path; `~` expanded)
2. env `LLM_API_KEY_FILE` (a path)
3. env `LLM_API_KEY` (a value - it works, and warns, because an environment
   value is inherited by every child process)

The key file's mode is checked: group or world readable produces a warning
naming the path, not a refusal - a throwaway local credential is the
operator's call, not the probe's. A `keyFile` that is configured but unreadable
does **not** fall through to the environment: substituting a different
credential for the one the entry named would make "which key was refused?"
unanswerable. That run reports `needs auth: no key configured for this entry;
cannot read key file <path> (ENOENT)`.

**The token never appears in any output.** Not in a reason, a warning, an
error, `--json`, or a test fixture - the tests use a dummy string and assert it
is absent from every output string, because a fixture with a real key in a
public repository is a published key. The result says `keySource` (`entry
keyFile` / `env LLM_API_KEY_FILE` / `env LLM_API_KEY`) and `authState`, which
describe the credential without being able to contain it.

The probe still **never follows a redirect**, and that matters more now than it
did: a `302` to an arbitrary host would otherwise be handed the Authorization
header. There is a test that a redirecting endpoint with a token configured is
hit exactly once.

### For integrators: budget for the reasoning field

Measured against `GLM-5.3-Flash-EXL3` on `asus1:8888`, 20 Sep 2026. The model
emits a `reasoning` field **before** any visible content, so a small
`max_tokens` is spent entirely on reasoning and the response comes back with:

```
"content": null, "finish_reason": "length"
```

That is not an empty answer, a broken endpoint or a bad prompt - it is the
budget running out before the visible part started. A health check or a
switcher smoke test that asks for `max_tokens: 8` will conclude the model is
broken every single time. Either budget for the reasoning tokens as well, or
disable reasoning server side. The capacity probe itself is unaffected: it only
calls `GET /v1/models` and never generates.

## Path and capacity are different axes

A box can be idle and still the wrong choice, because of the link to it. So
the probe reports the network separately from the state and never folds one
into the other:

| field | meaning |
| ----- | ------- |
| `from` | the host that took this measurement. Path and latency are only valid for that host |
| `pathScope` | always `per-caller-host`, as a reminder not to share the reading |
| `path` | `direct` \| `relayed` \| `unknown`, read from `tailscale ping -c 1 <host>`: `via DERP(...)` is a relay, `via <ip:port>` is a direct WireGuard path |
| `p90Ms` | 90th percentile of the model-list round trips |
| `jitterMs` | stddev of those samples, `null` when only one was taken |
| `minMs`, `medianMs`, `latencySamples` | the rest of the sample, for anyone who wants it |
| `latencyMs` | **the p90**, so callers using the plain field get the conservative number |

`path` is `unknown` when tailscale is absent or says nothing useful, and for a
loopback host where there is no tailnet path to measure. It is never assumed to
be `direct`.

### Path is per PEER PAIR. Run the probe on the consuming host.

Capacity is a property of the **target**: asus1 has 117 GiB free no matter who
asks, so that reading may be shared, cached, or fetched by a helper.

Path and latency are properties of the **pair**. Measured tonight: M5 and mini
sit behind the same Helsinki router, pointed at the same Berlin box. At 03:20
M5 had a direct path; mini had been relayed continuously since 02:22. Same
target, same building, same minute, opposite answers.

Three consequences, all enforced rather than merely documented:

1. **The probe measures from the host that will consume the model.** Every
   result carries `from: <hostname>` and `pathScope: "per-caller-host"`, and
   the CLI prints a `# probed from <host>` header. A result whose `from` is not
   the host about to load the model tells you nothing about that host's path.
2. **Never cache or share a path or latency reading across hosts.** Capacity
   may be shared; these may not. There is no cache in the module for exactly
   this reason.
3. **The registry carries no path field at all.** `loadRegistry` refuses an
   entry containing `path`, `latencyMs`, `p90Ms`, `jitterMs`, `freeMemGiB` or
   `state`, with a message saying why: a measurement written into a shared file
   was true for whoever wrote it and for nobody else.

**A switcher UI on the phone must trigger the probe on the executing host**,
not on the phone and not on a relay or a convenient always-on box. A phone on
cellular and a Mac on the flat's wifi are different peers with different paths
to the same GPU. Probing in the wrong place produces a confident, well
formatted, wrong answer - which is worse than no answer, because nothing in the
output looks broken. The `from` stamp is there so that mistake is visible.

### Why several samples and a high percentile

Measured Helsinki (mini) to Berlin (asus1), 55 minutes of continuous traffic:
**rtt min 63 ms, mean 167 ms, stddev 96 ms**, and the direct path appeared
exactly twice, briefly, in the whole window. Two consequences, both baked in:

- **Assume relayed.** The 35 ms direct case is real and rare. Designing around
  it would mean sizing every switch decision for a path that did not exist for
  54 of those 55 minutes.
- **One sample is wrong most of the time.** With that spread, a single ping
  lands anywhere from 63 to well past 300 ms, so the probe takes 5 samples
  spread over about 2 seconds and reports the p90 plus the stddev. A run that
  could only take one sample says so in its reason string and reports
  `jitterMs: null`, because printing a jitter of 0 would read as a rock-steady
  link, which is the one thing a single sample cannot show.

Sampling is clamped so the whole entry still fits inside `--timeout`, and
entries are probed in parallel.

## The LAN-IP rule, and why

`host` must be a tailnet MagicDNS name (`asus1`, `mini`) or a tailnet IP
(`100.x`). The loader refuses `10.x`, `192.168.x` and `172.16.x` - `172.31.x`
with a message naming the entry, unless `--allow-lan` is passed.

This is not tidiness. The MacBook that runs the switcher travels between the
Helsinki home base and Berlin. `192.168.1.50` is a different piece of hardware
on those two networks, and the failure is silent: no error, just a stranger's
box answering, or a model list from the wrong machine. A MagicDNS name resolves
to the same box over WireGuard from either flat, from a hotel, or from a phone
hotspot, with its own encryption and authentication on top.

### The live case, measured 20 Sep 2026

The same GLM box has two addresses: `asus1` (MagicDNS) and `192.168.0.45` (its
address on the Berlin flat's LAN). Both were tried from both cities:

| from | `asus1:8888` | `192.168.0.45:8888` |
| ---- | ------------ | ------------------- |
| MacBook, Berlin - same flat as the box | answers (401 without a key, model list with one) | answers; it is on that LAN |
| mini, Helsinki | answers | **no route at all** |

This is the rule with the abstraction taken out. `192.168.0.45` is not a typo
and not a dead box; it is a *Berlin* address that stops being an address when
the laptop moves, or when a teammate in Helsinki reads the same registry file.
And in Helsinki `192.168.0.45` is not merely absent - it is whatever that
subnet hands out there, which is how a registry entry ends up quietly probing
a stranger's hardware.

If a registry entry works for you and nobody else, check whether you are the
one person on the right LAN.

This module accepts plain `http://` because it dials only the tailnet or
loopback, never an arbitrary URL, and WireGuard already encrypts and
authenticates the hop. Loopback is allowed and is not treated as a LAN address
- "this box" means the same thing in both cities.

Over the tailnet the same hop also carries the bearer token, when an entry has
one. That is the other reason the LAN-IP rule is not tidiness: `http://` plus
an `Authorization` header is only acceptable because the hop underneath is
WireGuard to a box you own.

## How the switcher should use it

1. **Re-probe at switch time.** Call `bin/model-capacity.mjs --json`, or
   `probeModels()` directly, in the same action that performs the switch. The
   module has no cache on purpose. A result from a minute ago does not know
   about the render that started thirty seconds ago.
2. **Offer `UP` only.** `BUSY`, `DOWN` and `UNREACHABLE` are not choices.
3. **Probe from the host that will run the model.** Not the phone showing the
   picker. See "Path is per peer pair" above.
4. **Label each option with BOTH axes: free memory and the path.** Two `UP`
   entries differ by `freeMemGiB` and by `path` / `p90Ms` / `jitterMs`, and
   those are independent. Show `capacity unknown` rather than a number when
   `capacityUnknown` is true, and `path: unknown` rather than an assumed
   `direct`. A label reads like: `asus1 UP - 114 GiB free - relayed, p90 263
   ms +-96`.
5. **Rank on the p90, not the minimum.** `latencyMs` IS the p90 for exactly
   this reason. A box that is fast once and slow four times must not outrank a
   steady one.
6. **Show the two auth failures differently.** `authState: "no-key"` means
   "configure a key for this entry"; `authState: "rejected"` means "the key is
   wrong or expired". Collapsing them back into "401" undoes the fix. Never
   render the token: `keySource` is what a UI may show.
7. **Refuse a `BUSY` pick out loud, with its `busyReason`.** "asus1 is BUSY:
   exclusive job running: ltx (pid 4711)" tells the operator whether to wait or
   go ask `owner`. A bare "unavailable" does not.
8. **Treat `UNREACHABLE` as an alert, not a filter.** The CLI exits 3 when any
   entry is unreachable, matching `scripts/lead-desk.py`, so a wrapper can
   notice without parsing text.

## Relationship to model-discovery.js

This is **standalone**. `packages/user-intent-kit/src/model-discovery.js` lives
on the unmerged branch `codex/discover-served-models` and covers local-endpoint
discovery; the two should be reconciled when that branch merges. Nothing here
imports it, and no commit from that branch is included. Its URL policy shape
was read for reference only.

The pieces a switcher needs that a discovery heartbeat does not: remote entries
addressed by tailnet name, the capacity reading from the box itself, the path
reading for the link in between, the four-state vocabulary, and no cache.

The LM Studio handling is the one place the two will overlap on merge: LM
Studio's list includes downloaded and JIT models, so only `loaded_instances`
count as served. Both files know that; reconcile to one.

## Running it

```
node bin/model-capacity.mjs
```

```
node bin/model-capacity.mjs --registry /path/to/models.json --json
```

Flags: `--registry PATH`, `--json`, `--timeout MS` (default 8000, per entry,
entries run in parallel), `--free-threshold GIB` (default 8), `--samples N`
(default 5 latency samples), `--allow-lan`. Exit 0 all answered, 2 usage or
registry error, 3 at least one `UNREACHABLE`.
