#!/bin/bash

# SPDX-License-Identifier: AGPL-3.0-only

# Room poller wrapper - checks rooms and nudges tmux on new work.
# Uses a PID lock file to prevent duplicate instances.
set -u

TMUX_SESSION="${IAK_TMUX_SESSION:-claude}"
POLL_INTERVAL="${IAK_POLL_INTERVAL:-10}"
NUDGE_TEXT="${IAK_NUDGE_TEXT:-check rooms}"
SCRIPT_DIR="$(dirname "$0")"
CHECK_SCRIPT="${IAK_CHECK_SCRIPT:-$SCRIPT_DIR/room-poll-check.py}"
ERR_LOG="${IAK_ERR_LOG:-/tmp/iak_poll_err.log}"
LOCK_FILE="${IAK_LOCK_FILE:-/tmp/iak_poll.pid}"

# --- PID lock: prevent duplicate pollers ---
if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[$(date -u +%FT%TZ)] Another poller already running (PID $OLD_PID). Exiting."
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"

cleanup() {
    rm -f "$LOCK_FILE"
    exit 0
}
trap cleanup EXIT INT TERM

echo "[$(date -u +%FT%TZ)] Poller started (PID $$, interval ${POLL_INTERVAL}s)"
echo "[$(date -u +%FT%TZ)] check_script=${CHECK_SCRIPT} session=${TMUX_SESSION}"

if [ ! -f "$CHECK_SCRIPT" ]; then
    echo "[$(date -u +%FT%TZ)] ERROR: check script not found: $CHECK_SCRIPT"
    exit 1
fi

while true; do
    HAS_NEW=$(python3 "$CHECK_SCRIPT" 2>"$ERR_LOG")
    echo "[$(date -u +%FT%TZ)] Poll result: $HAS_NEW"

    if [ "$HAS_NEW" = "NEW" ]; then
        if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
            tmux send-keys -t "$TMUX_SESSION" -l "$NUDGE_TEXT"
            sleep 0.3
            tmux send-keys -t "$TMUX_SESSION" Enter
            echo "[$(date -u +%FT%TZ)] Sent short nudge"
        else
            echo "[$(date -u +%FT%TZ)] tmux session not found: $TMUX_SESSION"
        fi
    fi

    sleep "$POLL_INTERVAL"
done
