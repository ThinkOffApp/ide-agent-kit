#!/bin/bash
# ClaudeMM room poller - polls every 2min, wakes Claude Code via tmux
TMUX_SESSION="claude"
POLL_INTERVAL=10
SCRIPT_DIR="$(dirname "$0")"
CHECK_SCRIPT="/Users/petrus/.claude/scripts/claudemm_poll_check.py"

echo "[$(date -u +%FT%TZ)] Poller started (PID $$, interval ${POLL_INTERVAL}s)"

while true; do
    HAS_NEW=$(python3 "$CHECK_SCRIPT" 2>/tmp/claudemm_poll_err.log)
    echo "[$(date -u +%FT%TZ)] Poll result: $HAS_NEW"

    if [ "$HAS_NEW" = "NEW" ]; then
        if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
            tmux send-keys -t "$TMUX_SESSION" -l "check rooms"
            sleep 0.3
            tmux send-keys -t "$TMUX_SESSION" Enter
            echo "[$(date -u +%FT%TZ)] Sent short nudge"
        fi
    fi

    sleep "$POLL_INTERVAL"
done
