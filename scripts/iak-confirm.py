#!/usr/bin/env python3
"""iak-confirm.py - raise a CodeWatch Approve/Deny card and wait for the tap.

Generic confirmation flow (petrus 2026-07-06: "make it a button"): POSTs an
intent to the local IAK daemon, which announces it in the approval room with
Approve/Deny buttons on petrus's phone, then polls until decided.

This script only ASKS and REPORTS. It executes nothing.
Exit codes: 0 = approved, 1 = denied, 2 = timeout/error.

Usage: iak-confirm.py "Open cloudflared tunnel for webhook wake?" [ttl_sec]
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.getenv("IAK_CONFIRM_BASE", "http://127.0.0.1:8788")
SESSION = os.getenv("IAK_CONFIRM_SESSION", "claude-code-mb")


def _req(method, path, payload=None, timeout=10):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    prompt = sys.argv[1]
    ttl = int(sys.argv[2]) if len(sys.argv) > 2 else 240

    try:
        created = _req("POST", "/intent", {"prompt": prompt, "session": SESSION, "timeoutSec": ttl})
    except Exception as e:
        print(f"ERROR creating intent: {e}", file=sys.stderr)
        return 2
    intent_id = created.get("id")
    if not created.get("ok") or not intent_id:
        print(f"ERROR: daemon rejected intent: {created}", file=sys.stderr)
        return 2
    print(f"card raised: id={intent_id} prompt={prompt!r}", file=sys.stderr)

    deadline = time.time() + ttl
    while time.time() < deadline:
        time.sleep(3)
        try:
            intents = _req("GET", "/intents")
        except Exception:
            continue
        items = intents if isinstance(intents, list) else intents.get("intents", [])
        for i in items:
            if i.get("id") == intent_id:
                decision = (i.get("decision") or "").lower()
                if decision == "approve":
                    print("approved")
                    return 0
                if decision == "deny":
                    print("denied")
                    return 1
    print(f"timeout waiting for decision (id={intent_id})", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
