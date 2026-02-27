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

wait
