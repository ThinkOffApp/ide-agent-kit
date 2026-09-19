#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-only

"""lead-desk.py - every pending confirmation intent in the fleet, one line each.

Why this exists: the lead session is the expensive part of the loop, so the
polling and the first-pass classification belong in a deterministic script and
only the digest reaches the model.

Three facts about the intent queue shape this whole file:

  * Intents live in an in-memory Map (src/confirmations.mjs, `const intents =
    new Map()`). A daemon restart silently destroys every pending intent, so
    this tool only ever GETs. It never restarts a daemon, never decides an
    intent, never writes anything anywhere.
  * The room confirmation card is clipped at ~300 characters on one host, so
    the room text is NOT the command being approved. The daemon's /intents
    `prompt` field is the full text. Always read the daemon. A [CLIPPED?] hint
    on a line means the prompt we received already looks cut at the source.
  * "daemon unreachable" and "queue empty" must never render the same way. A
    check that cannot fail is not a check, so silence is impossible here: every
    daemon prints exactly one status line per poll, every poll, and an
    unreachable daemon prints UNREACHABLE with a reason.

Classification is a LOWER BOUND. When two rules match, the more restrictive
class wins, and a false escalation is a cheap mistake while a missed
DESTRUCTIVE is not.

Usage:
  lead-desk.py --once [--daemon NAME=URL ...] [--json]
  lead-desk.py --watch 20 [--daemon NAME=URL ...] [--json] [--max-polls N]

Exit codes: 0 = every daemon answered, 2 = usage error, 3 = at least one
daemon was unreachable (the output still says which, on its own line).
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_DAEMONS = ["local=http://127.0.0.1:8788"]
DEFAULT_TIMEOUT = 4.0

# Width the room confirmation card is clipped to on one host. Kept as a tuple
# so a second host with a different clip width is a one-token change.
CLIP_WIDTHS = (300,)
# Below this length a prompt that ends without punctuation is just a short
# prompt, not a truncated one, so the mid-token hint would be pure noise.
CLIP_SUSPECT_MIN = 280
EXCERPT_CHARS = 100

# --- classification table ---------------------------------------------------
#
# (CLASS, regex, why) - matched case-insensitively against the FULL prompt, not
# the excerpt. Add a row to extend; the class of a row decides its severity, not
# its position, so rows can go in any order.
#
# Severity order, most restrictive first. AUTH-PATH outranks DESTRUCTIVE
# because a patch to the gate compromises every future check, not just this
# one command.
CLASS_ORDER = ["AUTH-PATH", "DESTRUCTIVE", "CREDENTIAL", "PAID", "LEAD-OK"]

RULES = [
    # AUTH-PATH: anything that edits the approval gate or who may pass it.
    ("AUTH-PATH", r"confirmations\.mjs", "edits the confirmation gate source"),
    ("AUTH-PATH", r"\bprincipals?\b", "touches the allowed-principals list"),
    ("AUTH-PATH", r"\bdecideIntent\b", "touches intent settlement"),
    ("AUTH-PATH", r"\bauth\s*(logic|gate|path|check|bypass)\b", "auth logic"),
    ("AUTH-PATH", r"\bapprovals?\s+gate\b", "the approval gate"),

    # DESTRUCTIVE: irreversible, or takes a running service down.
    ("DESTRUCTIVE", r"\brm\s+-{1,2}[a-z-]*[rf]", "rm with -r/-f"),
    ("DESTRUCTIVE", r"\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b)", "force push"),
    ("DESTRUCTIVE", r"\bgit\s+reset\s+--hard\b", "discards working tree"),
    ("DESTRUCTIVE", r"\bgit\s+clean\s+-[a-z]*[fd]", "deletes untracked files"),
    ("DESTRUCTIVE", r"\bdrop\s+(table|database|schema|view|index|column|collection|bucket)\b", "drops stored data"),
    ("DESTRUCTIVE", r"\btruncate\b", "truncate"),
    ("DESTRUCTIVE", r"\bdeletes?\b|\bdeleting\b", "delete"),
    ("DESTRUCTIVE", r"\bbootout\b", "launchd bootout"),
    ("DESTRUCTIVE", r"\b(pkill|killall)\b", "kills processes by name"),
    ("DESTRUCTIVE", r"\bkill\s+-9\b", "SIGKILL"),
    ("DESTRUCTIVE", r"\bsystemctl\s+(stop|kill|disable)\b", "stops a service"),
    # A restart is destructive HERE specifically because pending intents are an
    # in-memory Map: restarting a daemon with a non-empty queue loses them all.
    ("DESTRUCTIVE", r"\brestart\b[^\n]*\b(daemon|service|launchagent|iak)\b", "restart drops in-memory intents"),

    # CREDENTIAL: a secret is in the blast radius.
    ("CREDENTIAL", r"\btokens?\b", "token"),
    ("CREDENTIAL", r"\bauth_token\b", "auth_token"),
    ("CREDENTIAL", r"\b(api[_-]?)?keys?\b", "key"),
    ("CREDENTIAL", r"\bsecrets?\b", "secret"),
    ("CREDENTIAL", r"\bpasswords?\b", "password"),
    ("CREDENTIAL", r"\bownerset\b", "ownerSet"),
    ("CREDENTIAL", r"\bcredentials?\b", "credential"),
    ("CREDENTIAL", r"\.env\b", ".env file"),

    # PAID: spends money or ships to production.
    ("PAID", r"\bdeploy\w*\b[^\n]*\bprod(uction)?\b", "deploy to prod"),
    ("PAID", r"\bprod(uction)?\b[^\n]*\bdeploy\w*\b", "deploy to prod"),
    ("PAID", r"\bpurchas\w*\b", "purchase"),
    ("PAID", r"\bbuy\b|\bbuying\b", "buy"),
    ("PAID", r"\border\b|\bordering\b", "order"),
    ("PAID", r"\bbilling\b|\binvoice\b|\bcheckout\b", "billing"),
]

_COMPILED = [(cls, re.compile(pat, re.IGNORECASE), why) for cls, pat, why in RULES]
_RANK = {cls: i for i, cls in enumerate(CLASS_ORDER)}

# The four classes a lead may never settle alone. Kept as data so the subagent
# definitions and docs can quote one source.
OWNER_ONLY = ("AUTH-PATH", "DESTRUCTIVE", "CREDENTIAL", "PAID")


def classify(prompt):
    """Return (CLASS, why). Most restrictive matching rule wins."""
    best = ("LEAD-OK", "no rule matched")
    text = prompt or ""
    for cls, rx, why in _COMPILED:
        if rx.search(text) and _RANK[cls] < _RANK[best[0]]:
            best = (cls, why)
    return best


def looks_clipped(prompt):
    """True when the prompt we were handed already looks truncated upstream.

    Two signals: the exact width the room card clips at, and a long prompt that
    stops without any sentence-ending punctuation (cut mid-token). This is a
    hint for the lead to go read the daemon, never a decision by itself.
    """
    text = prompt or ""
    if len(text) in CLIP_WIDTHS:
        return True
    stripped = text.rstrip()
    if stripped.endswith("...") or stripped.endswith("…"):
        return True
    if len(stripped) >= CLIP_SUSPECT_MIN and stripped[-1:] not in ('.', '!', '?', '"', "'", ')', ']', '}', '`'):
        return True
    return False


def excerpt(prompt, limit=EXCERPT_CHARS):
    """Collapse the prompt to one line and cut it to `limit` characters."""
    return re.sub(r"\s+", " ", prompt or "").strip()[:limit]


def is_pending(intent):
    """Pending unless the daemon says otherwise.

    Defensive on purpose: an intent with no status and no decision is shown
    rather than hidden, because the failure we can afford is an extra line.
    """
    status = intent.get("status")
    if status is None:
        return not intent.get("decision")
    return status == "pending"


# urllib consults the macOS system proxy configuration on every single call,
# which measured ~0.4s per request on this machine and means nothing for a
# localhost or tailnet daemon. An explicit empty ProxyHandler skips the lookup,
# which matters most in watch mode where we poll forever.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch_intents(url, timeout=DEFAULT_TIMEOUT, opener=_OPENER.open):
    """GET {url}/intents.

    Returns (list_of_intents, None) or (None, reason). A reason is always a
    short single-line string, because it has to fit on the UNREACHABLE line.
    Anything other than a clean 200 with a JSON array is a reason, never an
    empty list: a 404 from the wrong port must not read as a quiet queue.
    """
    target = url.rstrip("/") + "/intents"
    req = urllib.request.Request(target, method="GET", headers={"Accept": "application/json"})
    try:
        with opener(req, timeout=timeout) as resp:
            code = getattr(resp, "status", 200) or 200
            if code != 200:
                return None, "HTTP %s" % code
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return None, "HTTP %s" % e.code
    except urllib.error.URLError as e:
        return None, "%s" % (e.reason,)
    except TimeoutError:
        return None, "timeout after %gs" % timeout
    except Exception as e:  # socket errors, DNS, bad TLS, anything else
        return None, "%s: %s" % (type(e).__name__, e)

    try:
        data = json.loads(raw or "[]")
    except ValueError:
        return None, "malformed JSON from /intents"
    if isinstance(data, dict):
        data = data.get("intents", [])
    if not isinstance(data, list):
        return None, "unexpected /intents payload (%s, not a list)" % type(data).__name__
    return data, None


def poll_one(name, url, timeout=DEFAULT_TIMEOUT):
    """Poll one daemon into a plain dict. No printing, so watch and once share it."""
    intents, reason = fetch_intents(url, timeout=timeout)
    if reason is not None:
        return {"name": name, "url": url, "reachable": False, "reason": reason, "pending": []}
    pending = []
    for i in intents:
        if not isinstance(i, dict) or not is_pending(i):
            continue
        prompt = i.get("prompt") or ""
        cls, why = classify(prompt)
        pending.append({
            "daemon": name,
            "id": i.get("id"),
            "class": cls,
            "why": why,
            "clipped": looks_clipped(prompt),
            "prompt_excerpt": excerpt(prompt),
            "prompt_len": len(prompt),
            "session": i.get("session"),
            "createdAt": i.get("createdAt"),
            "owner_only": cls in OWNER_ONLY,
        })
    return {"name": name, "url": url, "reachable": True, "reason": None, "pending": pending}


def intent_line(row):
    """NAME  ID  CLASS  <excerpt>  [CLIPPED?]

    Four fixed columns so `grep DESTRUCTIVE` stays exact; the clip hint rides at
    the end of the line because it is a statement about the text, not the class.
    """
    line = "%s  %s  %s  %s" % (row["daemon"], row["id"], row["class"], row["prompt_excerpt"])
    if row["clipped"]:
        line += "  [CLIPPED?]"
    return line


def now_stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def emit(line, stream=sys.stdout):
    """Every line flushes: this is meant to sit under a tail-style monitor."""
    print(line, file=stream, flush=True)


def run_once(daemons, as_json=False, timeout=DEFAULT_TIMEOUT, out=sys.stdout):
    results = [poll_one(name, url, timeout=timeout) for name, url in daemons]
    if as_json:
        emit(json.dumps({"generated": now_stamp(), "daemons": results}), out)
    else:
        for r in results:
            if not r["reachable"]:
                emit("%s  UNREACHABLE  %s" % (r["name"], r["reason"]), out)
            elif not r["pending"]:
                emit("%s  empty" % r["name"], out)
            else:
                for row in r["pending"]:
                    emit(intent_line(row), out)
    return 3 if any(not r["reachable"] for r in results) else 0


def run_watch(daemons, interval, as_json=False, timeout=DEFAULT_TIMEOUT, max_polls=None, out=sys.stdout):
    """Emit only changes: new intents, intents leaving pending, up/down flips.

    The first poll is treated as a change from nothing-known and prints the
    current state. A watcher that prints nothing at startup is indistinguishable
    from a watcher that is broken.
    """
    # name -> {"reachable": bool|None, "pending": {id: row}}
    state = {name: {"reachable": None, "pending": {}} for name, _ in daemons}
    polls = 0
    while max_polls is None or polls < max_polls:
        polls += 1
        for name, url in daemons:
            prev = state[name]
            cur = poll_one(name, url, timeout=timeout)
            stamp = now_stamp()

            if not cur["reachable"]:
                # Do NOT settle the intents we were tracking: we do not know
                # what happened to them, and guessing a decision is worse than
                # saying the daemon is down.
                if prev["reachable"] is not False:
                    _event(out, as_json, stamp, {
                        "event": "DOWN", "daemon": name, "reason": cur["reason"],
                    }, "%s  DOWN  %s  %s" % (stamp, name, cur["reason"]))
                prev["reachable"] = False
                continue

            if prev["reachable"] is not True:
                _event(out, as_json, stamp, {
                    "event": "UP", "daemon": name, "pending": len(cur["pending"]),
                }, "%s  UP  %s  %d pending" % (stamp, name, len(cur["pending"])))
            prev["reachable"] = True

            now_map = {row["id"]: row for row in cur["pending"]}
            for iid, row in now_map.items():
                if iid not in prev["pending"]:
                    _event(out, as_json, stamp, dict(row, event="NEW"),
                           "%s  NEW  %s" % (stamp, intent_line(row)))
            for iid, row in list(prev["pending"].items()):
                if iid in now_map:
                    continue
                decision = _decision_for(cur, iid)
                _event(out, as_json, stamp, {
                    "event": "DONE", "daemon": name, "id": iid,
                    "class": row["class"], "decision": decision,
                }, "%s  DONE  %s  %s  %s  %s" % (stamp, name, iid, row["class"], decision))
            prev["pending"] = now_map

        if max_polls is None or polls < max_polls:
            time.sleep(interval)
    return 0


def _decision_for(polled, intent_id):
    """Read the decision off the daemon, or say plainly that we cannot.

    An intent that vanished entirely rather than settling is the in-memory Map
    signature: the daemon was probably restarted and the queue went with it.
    """
    intents, reason = fetch_intents(polled["url"])
    if reason is not None:
        return "decision-unknown (%s)" % reason
    for i in intents:
        if isinstance(i, dict) and i.get("id") == intent_id:
            return i.get("decision") or i.get("status") or "decided"
    return "vanished (daemon restart?)"


def _event(out, as_json, stamp, payload, text):
    if as_json:
        emit(json.dumps(dict(payload, ts=stamp)), out)
    else:
        emit(text, out)


def parse_daemon(spec):
    """NAME=URL. A bare URL is rejected: an unnamed column is unreadable."""
    if "=" not in spec:
        raise argparse.ArgumentTypeError("expected NAME=URL, got %r" % spec)
    name, url = spec.split("=", 1)
    name, url = name.strip(), url.strip()
    if not name or not url:
        raise argparse.ArgumentTypeError("expected NAME=URL, got %r" % spec)
    return (name, url)


def build_parser():
    p = argparse.ArgumentParser(
        prog="lead-desk.py",
        description="Pending confirmation intents across the fleet, classified.",
    )
    p.add_argument("--daemon", action="append", type=parse_daemon, metavar="NAME=URL",
                   help="repeatable; default %s" % DEFAULT_DAEMONS[0])
    p.add_argument("--once", action="store_true", help="single poll (default)")
    p.add_argument("--watch", type=float, metavar="SECONDS",
                   help="poll every SECONDS and emit only changes")
    p.add_argument("--json", action="store_true", dest="as_json",
                   help="JSON for --once, JSON lines for --watch")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                   help="per-request timeout, default %g" % DEFAULT_TIMEOUT)
    p.add_argument("--max-polls", type=int, default=None,
                   help="stop after N polls (bounded runs and tests)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    daemons = args.daemon or [parse_daemon(d) for d in DEFAULT_DAEMONS]
    if args.watch is not None:
        if args.watch <= 0:
            print("--watch needs a positive interval", file=sys.stderr)
            return 2
        return run_watch(daemons, args.watch, as_json=args.as_json,
                         timeout=args.timeout, max_polls=args.max_polls)
    return run_once(daemons, as_json=args.as_json, timeout=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
