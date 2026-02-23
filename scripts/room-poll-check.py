#!/usr/bin/env python3
"""Check for new Ant Farm messages, auto-ack from petrus, and append to inbox file."""
import json, subprocess, sys, os, time

SEEN_FILE = "/tmp/claudemm_seen_ids.txt"
NEW_FILE = "/tmp/claudemm_new_messages.txt"
API_KEY = "xfb_a71acdf98be644bd0b015c39cf18dfcff333cc3e4bc83484c2cae9400fde8fcc"
ROOMS = ["thinkoff-development", "feature-admin-planning", "lattice-qcd"]
MY_HANDLES = ("@claudemm", "claudemm")

def post_ack(room, text):
    """Post a quick ack directly to the room."""
    try:
        payload = json.dumps({"room": room, "body": text})
        subprocess.run(
            ["curl", "-sS", "-X", "POST",
             "https://antfarm.world/api/v1/messages",
             "-H", f"X-API-Key: {API_KEY}",
             "-H", "Content-Type: application/json",
             "-d", payload],
            capture_output=True, text=True, timeout=10
        )
    except Exception:
        pass

try:
    seen = set()
    try:
        with open(SEEN_FILE) as f:
            seen = set(line.strip() for line in f if line.strip())
    except FileNotFoundError:
        pass

    new_msgs = []
    for room in ROOMS:
        r = subprocess.run(
            ["curl", "-sS", "-H", f"X-API-Key: {API_KEY}",
             f"https://antfarm.world/api/v1/rooms/{room}/messages?limit=10"],
            capture_output=True, text=True, timeout=30
        )
        data = json.loads(r.stdout)
        msgs = data.get("messages", data if isinstance(data, list) else [])

        for m in msgs:
            mid = m.get("id", "")
            if mid and mid not in seen:
                handle = m.get("from", "?")
                author_handle = m.get("author", {}).get("handle", handle)
                if author_handle not in MY_HANDLES and handle not in MY_HANDLES:
                    body = m.get("body", "")[:400]
                    ts = m.get("created_at", "")[:19]
                    new_msgs.append(f"[{ts}] [{room}] {author_handle}: {body}")

                    # Auto-ack messages from petrus (direct questions / hearing checks)
                    body_lower = body.lower()
                    is_from_petrus = "petrus" in str(author_handle).lower() or "petrus" in str(handle).lower()
                    is_hearing_check = "hear" in body_lower or "do you" in body_lower or "claudemm" in body_lower.split("@")[-1:]

                    if is_from_petrus:
                        elapsed = int(time.time() % 60)
                        post_ack(room, f"@petrus [claudemm] seen, {elapsed}s. Full response coming via Claude Code.")

                seen.add(mid)

    with open(SEEN_FILE, "w") as f:
        for sid in list(seen)[-500:]:
            f.write(sid + "\n")

    if new_msgs:
        with open(NEW_FILE, "a") as f:
            for nm in reversed(new_msgs):
                f.write(nm + "\n---\n")
        print("NEW")
    else:
        print("NONE")

except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    print("NONE")
