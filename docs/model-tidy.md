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
0. Refuse if a `<source>.tidy-moving` directory already exists (see step 3)
   — that means a previous `apply` was interrupted mid-swap for this unit,
   and this run will not guess which of the two paths is authoritative.
1. Copy every file into `--target`, preserving the relative-to-home path,
   symlinks, and hardlink relationships.
2. Verify every file: same relative paths, same symlink targets, same byte
   size AND SHA-256 for every regular file.
3. Only if verification passed for every file in the unit, swap the source
   for a symlink via a crash-safe staged sequence:
   `rename(source, source + '.tidy-moving')` (atomic on the same
   filesystem) → `symlink(target-copy, source)` → verify the symlink
   resolves (`realpathSync`) to the target copy → remove
   `source + '.tidy-moving'`.
4. If anything in step 3 fails after the rename, the symlink (if partially
   created) is removed and `source + '.tidy-moving'` is renamed straight
   back to `source`, so the unit ends up exactly as it started.

**The safety claim is: a failure at any step leaves a unit's source EITHER
with its original completely untouched (any failure in steps 0-2, or a
step-3 failure that rolled back) OR with a working symlink to a verified
copy (a step-3 swap that completed) — never neither, and never deleted
without a verified copy existing both at the target and reachable through
the symlink.** A failure for one unit does not roll back units that already
succeeded earlier in the same run, but the process still exits non-zero and
prints exactly which unit failed, at which step, and why.

## Selection rules (in order, each with an explicit reason string)

1. **KEEP list** — anything matching `--keep-file` (path or glob, `~`
   expanded, `#` comments) is always skipped. See
   `config/model-tidy.keep.example`.
2. **In use by a process, or unverifiable** — skipped if:
   - any process has one of the model's files open under `/proc/*/fd`, or
   - a recognized serving process's command line references the path
     (`vllm`, `llama-server`, `llama.cpp`, `sglang`, `exllama`, `tabby`,
     `ollama`, `mlx`, `text-generation`).
   **Fail-closed:** this check has to succeed for *every* pid on the box to
   count as verified. Off Linux (no `/proc`), if `/proc` itself can't be
   listed, or if even one pid's `fd` directory or `cmdline` can't be read
   (a permission failure, not the process simply having exited mid-scan —
   that's a normal race and not a failure), the candidate is skipped with
   `in-use status unverified: <why>` rather than treated as idle for lack
   of evidence. In practice, on a typical non-root Linux host with other
   users' or root's processes running, this makes the tool quite
   conservative unless it runs with enough privilege to read every pid's
   `/proc` entry — that is intentional: an unreadable process is exactly
   the case where we cannot prove a model is idle.
3. **Bind-mounted into (or containing) the bind-mount source of a running
   docker container, or unverifiable** — reads `docker inspect` of every
   running container's `Mounts`; a candidate is in use if it is at or under
   a mount source, OR if a mount source is at or under the candidate (a
   container mounting a subdirectory of a larger candidate still makes
   that whole candidate unsafe to move). **Fail-closed:** if `docker` is
   not installed, not running, or its `ps`/`inspect` output can't be read,
   EVERY candidate on the box is skipped with `in-use status unverified:
   docker not readable: <why>` — not just `~/.cache/huggingface`. A
   container can bind-mount anything; only being able to enumerate every
   running container's mounts makes any candidate provably idle.
4. **Too recent** — skipped if the newest mtime of any real file in the
   directory is within `--min-idle-days` (default 14). The CLI rejects a
   non-finite or negative `--min-idle-days` up front (e.g. a typo like
   `--min-idle-days fourteen`) rather than let a stray `NaN` silently
   disable this check.
5. **Already tidied** — skipped if the candidate is already a symlink.
6. **Hardlink sets move as one unit** — candidates are grouped by shared
   `dev:ino`, scanning every discovered model root regardless of its own
   KEEP/in-use/recent status (so a hardlink to a KEEP-listed copy, or to a
   directory that's in use, is still detected). A group is selected only if
   *every* member independently passed rules 1-5; otherwise every member is
   skipped with `hardlinked to <path>, which is not moving (<path>'s own
   reason)` (moving one copy of a hardlinked pair to another filesystem
   breaks the hardlink and doubles disk use — this is the whole point of
   the rule).

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
- `--target` must be an absolute, existing, writable directory on a
  different filesystem device than `--home`, or apply refuses before
  touching anything.
- A source directory's original copy is only ever removed after (a) its
  copy has been verified byte-for-byte (size + SHA-256) at the target, and
  (b) the replacement symlink at the source has itself been created and
  verified to resolve to that copy. There is no code path that removes the
  original before both of those have happened — see the staged
  rename/symlink/verify/cleanup sequence above. A crash between the rename
  and the final cleanup leaves a `<source>.tidy-moving` directory, which a
  later `apply` run detects and refuses to touch until it's resolved by
  hand.
- A hardlink set moves as a unit or not at all — never partially — and the
  hardlink scan covers every discovered model root, not just the ones that
  already passed every other rule.
- Process- and docker-in-use checks are fail-closed: anything that could
  not be fully verified is treated as in-use, never as idle.
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
- **Practical consequence of the fail-closed process check, not verified
  on a real box:** on a typical multi-process Linux host, at least some
  pids (root's, other users', kernel-adjacent processes) will be
  unreadable to a non-root `model-tidy` process. As written, that makes
  EVERY run report every non-KEEP/non-tidied candidate as unverified unless
  `model-tidy` runs with enough privilege to read every pid's `/proc`
  entry, or unless asus1/asus2 turn out to be single-user boxes where
  `model-tidy`'s own user can read every relevant pid. This has not been
  checked against the real process list on either box, so it's unknown
  whether the tool would select anything at all there today.
- Two findings from the automated Codex review are known and NOT addressed
  in this pass (out of scope for the three defects above, tracked here
  instead of silently dropped): (1) `verifyUnit`'s checksum step
  (`sha256File`) reads each file whole via `readFileSync` rather than
  streaming — for real multi-GiB `.safetensors`/`.gguf` shards this could
  exhaust memory or exceed Node's Buffer limits, making `apply` fail at
  the verify step for large real models even though the copy itself
  succeeded; (2) there is no `lsof`-based fallback for the process-in-use
  check, only `/proc`.
