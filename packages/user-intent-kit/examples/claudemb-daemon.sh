#!/usr/bin/env bash
# claudemb_uik.sh — run the UIK adapters as a persistent daemon.
# Spawned by com.claudemb.uik LaunchAgent in a detached tmux session.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export INTENT_API_BASE="https://antfarm.world/api/v1"
export INTENT_API_KEY="${INTENT_API_KEY:-xfb_63eddebae1e4b50345a9ca246264654df7dbf8620d150a76e21dd790ab201c5c}"
export INTENT_USER_ID="${INTENT_USER_ID:-petrus}"
export INTENT_AGENT_HANDLE="${INTENT_AGENT_HANDLE:-@claudemb}"
export INTENT_DEVICE_ID="${INTENT_DEVICE_ID:-macbook}"

cd /Users/petrus/AndroidStudioProjects/user-intent-kit

# Use bin/uik-daemon.js (the persistent daemon entry point added in v0.2.0).
# Do NOT use examples/iak-integration.js here: it was originally a one-shot
# demo whose unref'd setInterval lets the process exit silently, which broke
# both @claudemb's MBP and @claudemm's mac-mini production daemons in
# dogfooding (see CHANGELOG 0.2.1).
exec /opt/homebrew/bin/node bin/uik-daemon.js >>/tmp/claudemb-uik.log 2>&1
