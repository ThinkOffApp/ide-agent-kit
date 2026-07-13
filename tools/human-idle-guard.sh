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
# A malformed or negative threshold must NOT authorize injection (codex
# review, #29: IDLE_THRESHOLD_S=not-a-number previously fell through to
# exit 0). Garbage -> the safe default.
if ! [[ "$IDLE_THRESHOLD_S" =~ ^[0-9]+$ ]] || [ "$IDLE_THRESHOLD_S" -eq 0 ]; then
    echo "human-idle-guard: invalid IDLE_THRESHOLD_S='$IDLE_THRESHOLD_S'; using 60" >&2
    IDLE_THRESHOLD_S=60
fi

idle_seconds() {
    local ns
    ns=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')
    [[ "$ns" =~ ^[0-9]+$ ]] || return 1
    echo $(( ns / 1000000000 ))
}

check_once() {
    local s
    if ! s=$(idle_seconds); then
        echo "human-idle-guard: cannot read HIDIdleTime; failing closed (assume active)" >&2
        return 1
    fi
    if [ "$s" -lt "$IDLE_THRESHOLD_S" ]; then
        echo "human-idle-guard: human input ${s}s ago (< ${IDLE_THRESHOLD_S}s)" >&2
        return 1
    fi
    return 0
}

# --wait [MAX_S]: poll until the idle window opens (default max 300s) so a
# nudge is DELAYED, never silently dropped - the poller has already marked
# the message seen by the time we run, so a skipped nudge would be a
# consumed-but-never-delivered message (codex review, #29). Timing out
# still exits 1 so the caller's existing failure path (retry/log) applies.
if [ "${1:-}" = "--wait" ]; then
    MAX_WAIT_S="${2:-300}"
    [[ "$MAX_WAIT_S" =~ ^[0-9]+$ ]] || MAX_WAIT_S=300
    waited=0
    while ! check_once; do
        if [ "$waited" -ge "$MAX_WAIT_S" ]; then
            echo "human-idle-guard: still active after ${MAX_WAIT_S}s; giving up" >&2
            exit 1
        fi
        sleep 2; waited=$(( waited + 2 ))
    done
    exit 0
fi

check_once
