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

# Durable-retry marker (codex acceptance gate, #29 blocker 3): the check
# script advances its seen-set when it reports NEW, so a skipped/failed
# nudge would otherwise be consumed-but-never-delivered. Persist the
# pending state and keep retrying until a nudge fully lands.
PENDING_FILE="${IAK_NUDGE_PENDING_FILE:-/tmp/iak_nudge_pending}"
GUARD="${IAK_IDLE_GUARD:-$SCRIPT_DIR/../tools/human-idle-guard.sh}"

while true; do
    HAS_NEW=$(python3 "$CHECK_SCRIPT" 2>"$ERR_LOG")
    echo "[$(date -u +%FT%TZ)] Poll result: $HAS_NEW"

    if [ "$HAS_NEW" = "NEW" ]; then
        touch "$PENDING_FILE"
    fi

    if [ -f "$PENDING_FILE" ]; then
        if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
            # Never type over the human (petrus 2026-07-13): tmux send-keys
            # lands in the pane regardless of window focus, so if the human
            # is typing in that terminal this shreds their input. Guard
            # before EACH injection; a skipped nudge stays pending and
            # retries next cycle.
            if ! "$GUARD"; then
                echo "[$(date -u +%FT%TZ)] nudge deferred: human active - retrying next cycle"
            else
                # Pin the pane id BEFORE typing (#30 gate, medium): if the
                # human switches the session's active pane between our
                # keystrokes, session-targeted Enter/C-u would land in THEIR
                # pane - C-u would wipe their input line. All three
                # injections target the same resolved pane.
                PANE_ID="$(tmux display-message -p -t "$TMUX_SESSION" '#{pane_id}' 2>/dev/null || true)"
                if [ -z "$PANE_ID" ]; then
                    echo "[$(date -u +%FT%TZ)] nudge deferred: cannot resolve pane id"
                else
                    tmux send-keys -t "$PANE_ID" -l "$NUDGE_TEXT"
                    sleep 0.3
                    if "$GUARD"; then
                        tmux send-keys -t "$PANE_ID" Enter
                        rm -f "$PENDING_FILE"
                        echo "[$(date -u +%FT%TZ)] Sent short nudge"
                    else
                        # Human became active in the 300ms window: withhold
                        # Enter rather than firing it into their flow, and
                        # erase the nudge text we typed (C-u clears OUR
                        # pinned pane's input line) so the retry doesn't
                        # double-type it.
                        tmux send-keys -t "$PANE_ID" C-u
                        echo "[$(date -u +%FT%TZ)] Enter withheld: human became active mid-nudge; input line cleared"
                    fi
                fi
            fi
        else
            echo "[$(date -u +%FT%TZ)] tmux session not found: $TMUX_SESSION"
        fi
    fi

    sleep "$POLL_INTERVAL"
done
