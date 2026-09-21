# model-tidy

Moves idle local LLM model directories off a full internal drive onto a
target mount (external SSD / NAS share), leaving a symlink behind so every
path that already points at the model — a docker bind mount, a script, a
shell alias — keeps working without edits.

Built for the asus1/asus2 GPU boxes (single NVMe, running near-full),
serving models with vLLM in docker containers bind-mounting
`~/.cache/huggingface`.

## Why Node, not a shell/Python script

The repo is Node-only ("No dependencies. Node.js >= 18 only.", per the main
README) and every other host-side tool here (`src/session-keepalive.mjs`,
`src/room-automation.mjs`, etc.) follows that pattern: logic in
`src/<name>.mjs`, a thin CLI wrapper in `bin/`, tests under `test/` using
`node:test` with `mkdtempSync`/`afterEach` cleanup. `model-tidy` follows the
same shape (`src/model-tidy.mjs` + `bin/model-tidy.mjs` +
`test/model-tidy.test.mjs`) rather than introducing Python or a new shell
tool family. There is no existing systemd pattern in this repo (it ships
macOS launchd `.plist` files for its own daemons), but the target hosts are
Ubuntu, so `systemd/model-tidy.{service,timer}` are new but self-contained
units, not wired into the macOS installer.

One deliberate deviation from the spec's suggested implementation: the copy
step is a small hand-written recursive Node copy
(`copyUnitPureNode` in `src/model-tidy.mjs`), not a shelled-out `rsync`.
Reasons:
- Keeps the zero-dependency, Node-only posture consistent with the rest of
  the repo — no assumption that `rsync` is installed or that its flags
  behave identically across the dev machine, CI, and asus1/asus2.
- `rsync -H` only preserves a hardlink relationship between files that are
  named in the *same* `rsync` invocation. The pure-Node copy tracks a
  `dev:ino -> target path` map explicitly across every member of a
  hardlink unit and calls `fs.linkSync` for repeats — the same safety
  property, verified directly by a test rather than relying on `rsync`
  flag behavior.
- It makes the apply tests deterministic on any machine (no dependency on
  `rsync` being present, or on its exact hardlink/`--checksum` semantics).

Byte-for-byte verification (size + SHA-256 of every regular file, plus
symlink-target and file-count comparison) happens after the copy and before
any deletion, which is the same safety bar the spec's `rsync
--checksum-after` approach targets.

## Modes

### `plan` (default) — read-only, never touches disk

```
node bin/model-tidy.mjs plan [options]
```

Prints, for every discovered candidate:
- `[move]` — would be moved, with its size and unit reason
- `[skip]` — would NOT be moved, with the specific reason (see Selection
  rules below)

...then a one-line summary with real GiB sizes (bytes / 2^30) and a
"free before -> ~free after" estimate, and writes a JSON record to the log
dir (`--log-dir`, default `~/.cache/ide-agent-kit/model-tidy-logs/`).

### `apply` — only with `--apply --target </mount/path>`

```
node bin/model-tidy.mjs apply --apply --target /mnt/model-archive [options]
```

Refuses immediately, before touching anything, unless `--target`:
- exists and is a directory
- is writable
- is on a **different filesystem device** than `--home` (checked via
  `stat().dev`, not by path string — a bind mount of the same device would
  still be refused)

For each selected unit (a single directory, or a whole hardlink set moved
together):
1. Copy every file into `--target`, preserving the relative-to-home path,
   symlinks, and hardlink relationships.
2. Verify every file: same relative paths, same symlink targets, same byte
   size AND SHA-256 for every regular file.
3. Only if verification passed for every file in the unit: delete the
   source directory (`fs.rmSync`, not a shell `rm -rf`) and replace it with
   a symlink to the target copy.
4. Re-verify: the symlink resolves (`realpathSync`) to the target copy.

**Any failure at steps 1-2 leaves the source completely untouched** — the
delete in step 3 only ever runs after verification has already passed for
every file in that unit. A failure for one unit does not roll back units
that already succeeded earlier in the same run, but the process still
exits non-zero and prints exactly which unit failed and why.

## Selection rules (in order, each with an explicit reason string)

1. **KEEP list** — anything matching `--keep-file` (path or glob, `~`
   expanded, `#` comments) is always skipped. See
   `config/model-tidy.keep.example`.
2. **In use by a process** — skipped if:
   - any process has one of the model's files open under `/proc/*/fd`, or
   - a recognized serving process's command line references the path
     (`vllm`, `llama-server`, `llama.cpp`, `sglang`, `exllama`, `tabby`,
     `ollama`, `mlx`, `text-generation`).
   Off Linux (no `/proc`), this check reports `checked: false` rather than
   silently passing — see "Not verified" below.
3. **Bind-mounted into a running docker container** — reads
   `docker inspect` of every running container's `Mounts`; if the
   candidate path is the mount source (or under it), it's in use.
   **Fail-safe:** if `docker` is not installed or not readable, the WHOLE
   of `~/.cache/huggingface` is treated as in-use and the run says so —
   nothing outside that tree is blanket-skipped by this rule.
4. **Too recent** — skipped if the newest mtime of any real file in the
   directory is within `--min-idle-days` (default 14).
5. **Already tidied** — skipped if the candidate is already a symlink.
6. **Hardlink sets move as one unit** — candidates are grouped by shared
   `dev:ino` across different candidate roots. A group is selected only if
   *every* member independently passed rules 1-5; otherwise every member is
   skipped with a reason naming which member failed and why (moving one
   copy of a hardlinked pair to another filesystem breaks the hardlink and
   doubles disk use — this is the whole point of the rule).

Remaining candidates are sorted by size (desc) and capped by `--max-gb`
(whole units only — a unit is either fully included in this run's budget or
fully deferred to the next run).

## Candidate discovery

- `~/.cache/huggingface/hub/models--*` — the whole `models--X` directory is
  one unit (its `snapshots/<rev>/*` symlinks point into `blobs/`; moving a
  snapshot without its blobs breaks it).
- `~/models/*` — each top-level entry is one unit.
- Ad-hoc project directories: a heuristic. A top-level entry under `--home`
  is a candidate if it (or an immediate subdirectory, e.g. `.../model`)
  contains a model marker: `config.json`, `tokenizer*.json`, or a file
  ending in `.safetensors`, `.gguf`, `.bin`, `.pt`, `.pth`, `.exl2`,
  `.exl3`, `.awq`, or `.gptq`. This is NOT exhaustive — see "Not verified".

## Reporting

- `plan` and `apply` both print a one-line summary suitable for pasting
  into the room, and write a JSON record per run to `--log-dir`
  (default `~/.cache/ide-agent-kit/model-tidy-logs/<date>.jsonl`).
- `--report-to-room --room <name> [--config <path>]` posts that summary
  line via the same `groupmind.one` POST the rest of this repo uses
  (`src/room-automation.mjs`'s `postMessage`). **Off by default.** Needs an
  API key: `IAK_API_KEY` env var, or `poller.api_key` from `--config`'s
  JSON.

## Scheduling — systemd user timer (Linux, nightly, plan-only by default)

Units are in `systemd/`. They are **not installed by this PR** — the owner
installs them explicitly on each box:

```
mkdir -p ~/.config/systemd/user && cp systemd/model-tidy.service systemd/model-tidy.timer ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now model-tidy.timer
```

The shipped `model-tidy.service` runs `plan` only — it never moves anything
until the `ExecStart` line is edited to add `apply --apply --target ...`,
which the unit's own comments call out explicitly. Do this only after
reviewing several plan runs' logs.

Check it fired: `systemctl --user list-timers model-tidy.timer` and
`journalctl --user -u model-tidy.service`.

## `--dry-run-remote <host>`

```
node bin/model-tidy.mjs --dry-run-remote asus1 [--remote-home /home/petrus]
```

SSHes to `<host>`, checks for `node` there, and if found, `scp`s
`bin/model-tidy.mjs` + `src/model-tidy.mjs` into a throwaway
`/tmp/.model-tidy-dryrun-*` directory, runs `plan` there (read-only, no
`--apply`), prints the output, then `ssh`es back to `rm -rf` **only that
throwaway directory it just created** (never model data). If `node` is not
found on the remote, it refuses and tells you to install Node >= 18 first —
it never attempts to install anything itself.

## Safety invariants

- `plan` mode makes zero filesystem writes anywhere. It's the default.
- `apply` requires both `--apply` AND `--target <path>` — neither alone is
  enough.
- `--target` must be an existing, writable directory on a different
  filesystem device than `--home`, or apply refuses before touching
  anything.
- A source directory is only ever deleted after its copy has been verified
  byte-for-byte (size + SHA-256) at the target. There is no code path that
  deletes before verifying.
- Deletion uses `fs.rmSync` (Node), never a shell `rm -rf`.
- A hardlink set moves as a unit or not at all — never partially.
- KEEP-listed paths are never touched by either mode.
- `--report-to-room` and any nightly `apply` are both opt-in and off by
  default.

## Not verified

- **Never run against a real machine except `--dry-run-remote` in plan
  mode.** No `apply` run has ever executed outside the test fixtures in
  this PR.
- `asus1` / `asus2` have no `node` binary installed (checked via SSH during
  this PR's review, read-only: `ssh asus1 command -v node` /
  `ssh asus2 command -v node`, both empty). `--dry-run-remote` against both
  hosts therefore stops at that check and prints an install instruction —
  it does not, and did not, run the actual plan logic on either box. Real
  candidate discovery, HF-cache sizing, docker-mount detection, and
  process-scanning on asus1/asus2 are unverified until Node is installed
  there (the owner's call, not done as part of this change).
- The ad-hoc project-directory heuristic (marker files at the top level or
  one level deep) is written to match the two examples in the brief
  (`~/DeepSeek-v4.1-Flash-EXL3-2x-DGX-Sparks/`,
  `~/GLM-5.3-Flash-EXL3-2x-DGX-Sparks/model`) but has not been run against
  the real directory layout on either box.
- The `/proc/*/fd` and cmdline process-in-use check only runs meaningfully
  on Linux; it degrades to `checked:false` (not "confirmed idle") off
  Linux, but that degraded path itself is only exercised by this dev
  machine being macOS, not by a real Linux box lacking `/proc` access.
- `docker inspect`'s exact `Mounts[].Source` string format was assumed from
  documented docker behavior, not confirmed against the actual
  vLLM/docker-compose setup on asus1/asus2.
- No real hardlinked pair between `~/models/*` and the HF cache has been
  inspected on either box — the fixture in `test/model-tidy.test.mjs`
  constructs a synthetic one via `fs.linkSync`.
