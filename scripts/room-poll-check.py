#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-only

"""Check for new Ant Farm room messages, optionally post focused auto-acks, append inbox file."""

import json
import os
import re
import subprocess
import sys
from typing import Iterable, List, Set

BASE_URL = os.getenv("IAK_BASE_URL", "https://antfarm.world/api/v1").rstrip("/")
API_KEY = os.getenv("IAK_API_KEY") or os.getenv("ANTIGRAVITY_API_KEY", "")
ROOMS = [r.strip() for r in os.getenv(
    "IAK_ROOMS", "thinkoff-development,feature-admin-planning,lattice-qcd"
).split(",") if r.strip()]
MY_HANDLES = tuple(
    h.strip() for h in os.getenv("IAK_SELF_HANDLES", "@claudemm,claudemm").split(",") if h.strip()
)
OWNER_HANDLE = os.getenv("IAK_OWNER_HANDLE", "petrus").lower()
TARGET_HANDLE = os.getenv("IAK_TARGET_HANDLE", "@claudemm")
SEEN_FILE = os.getenv("IAK_SEEN_FILE", "/tmp/iak_seen_ids.txt")
ACKED_FILE = os.getenv("IAK_ACKED_FILE", "/tmp/iak_acked_ids.txt")
NEW_FILE = os.getenv("IAK_NEW_FILE", "/tmp/iak_new_messages.txt")
FETCH_LIMIT = int(os.getenv("IAK_FETCH_LIMIT", "20"))
ACK_ENABLED = os.getenv("IAK_ACK_ENABLED", "1").lower() not in ("0", "false", "no")
# Listen modes: "all" = every message, "humans" = skip bot messages,
# "tagged" = only when @mentioned, "owner" = only from owner
LISTEN_MODE = os.getenv("IAK_LISTEN_MODE", "all").lower()
BOT_HANDLES = tuple(
    h.strip() for h in os.getenv(
        "IAK_BOT_HANDLES", ""
    ).split(",") if h.strip()
)

TASK_HINTS = (
    "can you", "please", "need to", "check", "fix", "update", "review",
    "run", "deploy", "implement", "test", "restart", "install", "respond",
    "post", "pull", "push", "merge"
)


def _load_id_set(path: str) -> Set[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()


def _save_id_set(path: str, values: Iterable[str], keep_last: int = 1000) -> None:
    tail = list(values)[-keep_last:]
    with open(path, "w", encoding="utf-8") as f:
        for v in tail:
            f.write(v + "\n")


def _extract_mentions(text: str) -> List[str]:
    return [m.lower() for m in re.findall(r"@([a-zA-Z0-9_.-]+)", text or "")]


def _is_bot(handle: str, author_handle: str) -> bool:
    """Heuristic: a sender is a bot if its handle starts with @ or is in BOT_HANDLES."""
    h = str(author_handle or handle or "").lower().lstrip("@")
    if BOT_HANDLES and h in {b.lower().lstrip("@") for b in BOT_HANDLES}:
        return True
    # Ant Farm bot handles typically start with @
    if str(handle).startswith("@"):
        return True
    return False


def _passes_listen_filter(handle: str, author_handle: str, body: str) -> bool:
    """Return True if this message should be forwarded based on LISTEN_MODE."""
    if LISTEN_MODE == "all":
        return True
    if LISTEN_MODE == "humans":
        return not _is_bot(handle, author_handle)
    if LISTEN_MODE == "tagged":
        my_short = {h.lower().lstrip("@") for h in MY_HANDLES}
        mentions = _extract_mentions(body)
        return any(m in my_short for m in mentions)
    if LISTEN_MODE == "owner":
        return OWNER_HANDLE in str(author_handle).lower() or OWNER_HANDLE in str(handle).lower()
    # Unknown mode, default to all
    return True


def _message_targets_me(body: str) -> bool:
    mentions = _extract_mentions(body)
    my_short = {h.lower().lstrip("@") for h in MY_HANDLES}
    if mentions:
        return any(m in my_short for m in mentions)
    # If no explicit mentions, treat owner imperatives as potentially addressed to current agent.
    return True


def _looks_like_task_request(body: str) -> bool:
    text = (body or "").strip().lower()
    if not text:
        return False
    return any(hint in text for hint in TASK_HINTS)


def _should_ack(handle: str, author_handle: str, body: str) -> bool:
    from_owner = OWNER_HANDLE in str(author_handle).lower() or OWNER_HANDLE in str(handle).lower()
    if not from_owner:
        return False
    if not _message_targets_me(body):
        return False
    return _looks_like_task_request(body)


def _post_ack(room: str, text: str) -> None:
    payload = json.dumps({"room": room, "body": text})
    subprocess.run(
        [
            "curl", "-sS", "-X", "POST", f"{BASE_URL}/messages",
            "-H", f"Authorization: Bearer {API_KEY}",
            "-H", "Content-Type: application/json",
            "-d", payload,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def _fetch_room_messages(room: str) -> List[dict]:
    result = subprocess.run(
        [
            "curl", "-sS", "-H", f"Authorization: Bearer {API_KEY}",
            f"{BASE_URL}/rooms/{room}/messages?limit={FETCH_LIMIT}",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if not result.stdout.strip():
        return []
    data = json.loads(result.stdout, strict=False)
    return data.get("messages", data if isinstance(data, list) else [])


def main() -> int:
    if not API_KEY:
        print("ERROR: IAK_API_KEY or ANTIGRAVITY_API_KEY is required", file=sys.stderr)
        print("NONE")
        return 0

    seen = _load_id_set(SEEN_FILE)
    acked = _load_id_set(ACKED_FILE)
    new_msgs: List[str] = []

    for room in ROOMS:
        msgs = _fetch_room_messages(room)
        for msg in msgs:
            mid = str(msg.get("id", "")).strip()
            if not mid or mid in seen:
                continue
            seen.add(mid)

            handle = str(msg.get("from", "?"))
            author_handle = str(msg.get("author", {}).get("handle", handle))
            # Always skip own messages
            if author_handle in MY_HANDLES or handle in MY_HANDLES:
                continue

            body = str(msg.get("body", ""))[:1000]
            ts = str(msg.get("created_at", ""))[:19]

            # Apply listen mode filter
            if not _passes_listen_filter(handle, author_handle, body):
                continue

            new_msgs.append(f"[{ts}] [{room}] {author_handle}: {body[:400]}")

            if ACK_ENABLED and mid not in acked and _should_ack(handle, author_handle, body):
                _post_ack(
                    room,
                    f"@{OWNER_HANDLE} [{TARGET_HANDLE.lstrip('@')}] starting now. "
                    "I will report back when finished with results."
                )
                acked.add(mid)

    _save_id_set(SEEN_FILE, seen, keep_last=1000)
    _save_id_set(ACKED_FILE, acked, keep_last=1000)

    if new_msgs:
        with open(NEW_FILE, "a", encoding="utf-8") as f:
            for nm in reversed(new_msgs):
                f.write(nm + "\n---\n")
        print("NEW")
    else:
        print("NONE")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print("NONE")
        raise SystemExit(0)
