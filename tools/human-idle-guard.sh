#!/usr/bin/env bash
# Refuse to inject keystrokes while the human is actively using the machine.
# Petrus 2026-07-13: "tmux should not write if i am writing!" - GUI nudges
# were typing into his active window mid-sentence. Same silent-failure class
# as the lock-screen guard (IAK PR #28).
#
# Usage (top of any keystroke-injecting script):
#   "$(dirname "$0")/human-idle-guard.sh" || { echo "human active; skipping nudge" >&2; exit 0; }
#
# Exits 0 when the machine has been idle >= IDLE_THRESHOLD_S (default 60s),
# 1 when the human was active more recently (caller should SKIP the nudge),
# 0 with a warning if idle time cannot be determined... no: fail CLOSED -
# if we cannot tell, assume the human is active (exit 1). A skipped nudge
# retries on the next cycle; a keystroke into a human's sentence does not.
set -u
IDLE_THRESHOLD_S="${IDLE_THRESHOLD_S:-60}"

idle_ns=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')
if ! [[ "$idle_ns" =~ ^[0-9]+$ ]]; then
    echo "human-idle-guard: cannot read HIDIdleTime; failing closed (assume active)" >&2
    exit 1
fi
idle_s=$(( idle_ns / 1000000000 ))
if [ "$idle_s" -lt "$IDLE_THRESHOLD_S" ]; then
    echo "human-idle-guard: human input ${idle_s}s ago (< ${IDLE_THRESHOLD_S}s); skip nudge" >&2
    exit 1
fi
exit 0
