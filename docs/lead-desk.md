# Lead desk

A cheap, transferable work environment for whichever agent is holding the lead
on any machine. Deterministic scripts poll and classify, two small subagents do
the judgement, and the expensive lead session only ever reads a digest.

Nothing here writes. The desk never settles an intent, never posts to a room and
never restarts a service.

Substitute your own values for `<HANDLE>`, `<HOST>` and `<ROOM>`. There are no
personal paths below; every path is relative to the repo root.

## 1. Start the watcher

One poll, to see where the fleet stands:

```
python3 scripts/lead-desk.py --once --daemon local=http://127.0.0.1:8788 --daemon mini=http://<HOST>:8788
```

Then leave this running under a tail-style monitor for the rest of the shift. It
prints only changes, flushes every line, and needs no key:

```
python3 scripts/lead-desk.py --watch 20 --daemon local=http://127.0.0.1:8788 --daemon mini=http://<HOST>:8788 2>&1 | tee -a /tmp/lead-desk.log
```

Watch the `/tmp/lead-desk.log` tail from the lead session rather than re-running
the script: a poll you have to remember to run is a poll you will forget.

Machine consumers add `--json` (a JSON document for `--once`, one JSON object per
event for `--watch`).

### What each line means

| Line | Meaning |
| --- | --- |
| `NAME  ID  CLASS  <first 100 chars>` | one pending intent |
| `NAME  empty` | the daemon answered, queue is empty |
| `NAME  UNREACHABLE  <reason>` | the daemon did not answer, and the reason says why |
| `... [CLIPPED?]` | the prompt already looks truncated at the source, go read the daemon |
| `<ts>  NEW  ...` | watch: an intent appeared |
| `<ts>  DONE  NAME  ID  CLASS  <decision>` | watch: an intent left pending |
| `<ts>  DONE  ... vanished (daemon restart?)` | watch: the intent disappeared without a decision |
| `<ts>  UP  NAME  N pending` / `<ts>  DOWN  NAME  <reason>` | watch: reachability flipped |

Exit codes: `0` every daemon answered, `2` usage error, `3` at least one daemon
was unreachable.

`empty` and `UNREACHABLE` are never interchangeable. If you ever see a daemon
produce no line at all, the tool is broken, not the queue.

## 2. Classification table

Rules live in a table at the top of `scripts/lead-desk.py`. Add a row to extend
it. Classification is a **lower bound**: when two rules match, the more
restrictive class wins, and when you are unsure, escalate.

| Class | Matches | Who may settle it |
| --- | --- | --- |
| `AUTH-PATH` | patches to `confirmations.mjs`, `principals`, `decideIntent`, the approval gate | owner only |
| `DESTRUCTIVE` | `rm -rf` / `rm -f`, `git push --force`, `git reset --hard`, drop/truncate/delete, `bootout`, `pkill`, `kill -9`, restarting a daemon | owner only |
| `CREDENTIAL` | token, key, secret, password, `ownerSet`, `auth_token`, `.env` | owner only |
| `PAID` | deploy to prod, purchase, buy, order, billing, invoice | owner only |
| `LEAD-OK` | nothing above matched | the lead |

`AUTH-PATH` outranks `DESTRUCTIVE` because a patch to the gate compromises every
future check, not just the command in front of you.

## 3. The two subagents

**`lead-triage`** (sonnet) judges one intent. Give it the line from the watcher
plus the full prompt from the daemon. It returns exactly three lines - `class:`,
`would decide:`, `because:` - and answers `escalate to owner` for every
`DESTRUCTIVE`, `CREDENTIAL`, `PAID` and `AUTH-PATH` regardless of its own view.

```
Use the lead-triage subagent on this packet: local  i_8f21  DESTRUCTIVE  sudo rm -rf ./node_modules
```

**`room-steward`** (haiku) reads the last N messages of `<ROOM>` and flags
breaches: a message over 1500 characters, method or debugging detail that
belonged in a DM, re-litigating a number whose disagreement is under 5 percent
or under 2x, and two agents posting the same conclusion within 60 seconds. It
outputs `WHO  RULE  <draft nudge>` per breach or `clean`. It never posts; the
lead sends the nudge.

```
Use the room-steward subagent on the last 30 messages of <ROOM>
```

## 4. Standing rules

1. **Destructive, credential, paid and auth-path always go to the owner.** The
   lead settles `LEAD-OK` and nothing else. No exceptions for "it is obviously
   fine", and no batching four escalations into one ask.
2. **Never restart a daemon with a non-empty queue.** Pending intents are an
   in-memory `Map` in `src/confirmations.mjs` (`const intents = new Map()`), so
   a restart destroys every pending approval silently and the owner's phone
   keeps showing buttons that now settle nothing. Run `--once` first; restart
   only on `empty`, and only if you were asked to.
3. **Read the daemon, not the room card.** Confirmation cards are clipped at
   about 300 characters on at least one host, so the card is not the command
   being approved. `/intents` `prompt` is the full text. A `[CLIPPED?]` tag
   means even that text looks cut, so go find the original before deciding.
4. **A 200 is not a settlement.** A POST that returns 200 proves the request was
   delivered, not that the intent settled. Confirm the outcome by watching the
   intent leave pending in `--watch`, not by the status code of the send.
5. **Unreachable is a finding, not a blank.** When a host shows `UNREACHABLE`,
   say so plainly with the reason and the timestamp. Never report an unreachable
   daemon as a quiet queue, and never describe a host as down without saying
   when you measured it.

## 5. Tests

```
python3 test/lead_desk_test.py
```

Note: `python3 -m unittest test/lead_desk_test.py` cannot load this file. The
runner turns that path into the module name `test.lead-desk.test`, and
`unittest discover` skips any filename that is not a valid Python identifier, so
it reports `NO TESTS RAN` rather than an error. Run the file directly.
