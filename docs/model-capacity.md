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
| `DOWN` | something answered on that port and is not serving models: an error status, unparseable JSON, a refused redirect, or an empty list | start or fix the server on that box |
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

This module accepts plain `http://` because it dials only the tailnet or
loopback, never an arbitrary URL, and WireGuard already encrypts and
authenticates the hop. Loopback is allowed and is not treated as a LAN address
- "this box" means the same thing in both cities.

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
6. **Refuse a `BUSY` pick out loud, with its `busyReason`.** "asus1 is BUSY:
   exclusive job running: ltx (pid 4711)" tells the operator whether to wait or
   go ask `owner`. A bare "unavailable" does not.
7. **Treat `UNREACHABLE` as an alert, not a filter.** The CLI exits 3 when any
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
