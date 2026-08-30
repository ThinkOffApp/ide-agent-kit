#!/bin/bash
# Start all ide-agent-kit services
# Used by LaunchAgent and manual startup

IAK_DIR="/Users/petrus/ide-agent-kit"
CONFIG="$IAK_DIR/config/dogfood.json"
NODE="/opt/homebrew/bin/node"
CLI="$IAK_DIR/bin/cli.mjs"

cd "$IAK_DIR"

# every background service, so the supervisor loop below can watch them all
PIDS=()

# Start each service
$NODE "$CLI" serve --config "$CONFIG" &
PIDS+=($!)
$NODE "$CLI" rooms watch --config "$CONFIG" &
PIDS+=($!)
$NODE "$CLI" comments watch --config "$CONFIG" &
PIDS+=($!)
$NODE "$CLI" discord watch --config "$CONFIG" &
PIDS+=($!)

# Confirmations daemon: holds :8788 AND runs the chat-reply poller that routes
# room /approve /deny taps (the CodeWatch Approve/Deny buttons) to the intent
# registry + action executors. Must be iak-mcp-daemon.mjs (not iak-mcp.mjs) —
# only the daemon flavor runs the poller, without which button taps never settle.
$NODE "$IAK_DIR/bin/iak-mcp-daemon.mjs" --config "$CONFIG" > "$IAK_DIR/logs/iak-confirm-daemon.log" 2>&1 &
PIDS+=($!)

# Exit as soon as ANY service dies, so launchd's KeepAlive restarts the whole
# stack. A bare `wait` returns only when EVERY child has exited, so a single
# dead service left this script running and launchd seeing a healthy job -
# 2026-08-30: the confirmations daemon died, nothing restarted it, and the
# room went silent until a human noticed and ran `launchctl kickstart`. That
# daemon holds :8788 and routes every Approve/Deny tap, so its death is the
# most expensive one here and was the least visible.
#
# `wait -n` would be the one-liner, but macOS ships bash 3.2 and does not have
# it. Polling with kill -0 works everywhere and costs nothing at this interval.
while :; do
    for pid in "${PIDS[@]}"; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "start-all: service $pid exited; stopping so launchd restarts the stack" >&2
            kill "${PIDS[@]}" 2>/dev/null
            exit 1
        fi
    done
    sleep 5
done
