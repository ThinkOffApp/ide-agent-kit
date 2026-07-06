#!/bin/bash
# Start all ide-agent-kit services
# Used by LaunchAgent and manual startup

IAK_DIR="/Users/petrus/ide-agent-kit"
CONFIG="$IAK_DIR/config/dogfood.json"
NODE="/opt/homebrew/bin/node"
CLI="$IAK_DIR/bin/cli.mjs"

cd "$IAK_DIR"

# Start each service
$NODE "$CLI" serve --config "$CONFIG" &
$NODE "$CLI" rooms watch --config "$CONFIG" &
$NODE "$CLI" comments watch --config "$CONFIG" &
$NODE "$CLI" discord watch --config "$CONFIG" &

# Confirmations daemon: holds :8788 AND runs the chat-reply poller that routes
# room /approve /deny taps (the CodeWatch Approve/Deny buttons) to the intent
# registry + action executors. Must be iak-mcp-daemon.mjs (not iak-mcp.mjs) —
# only the daemon flavor runs the poller, without which button taps never settle.
$NODE "$IAK_DIR/bin/iak-mcp-daemon.mjs" --config "$CONFIG" > "$IAK_DIR/logs/iak-confirm-daemon.log" 2>&1 &

wait
