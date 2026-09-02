#!/bin/bash
# claudemm presence publisher (Mac mini). Reads the API key from the canonical
# config at start so key rotations self-heal — never hardcode keys here
# (the old xfb_63eddeba… key was hardcoded in publishers and silently 401'd
# for a day after the 2026-07-03 rotation).
set -euo pipefail
IAK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$IAK_DIR/config/dogfood.json"

export INTENT_API_BASE="$(python3 -c "import json;print(json.load(open('$CONFIG'))['intent']['baseUrl'])")"
export INTENT_API_KEY="$(python3 -c "import json;print(json.load(open('$CONFIG'))['intent']['apiKey'])")"
# The user whose dashboard these heartbeats feed - the HUMAN (config
# intent.userId = petrus), never the agent. With "claudemm" here the daemon
# fed a document nobody looks at while the Intent page listed claudemm as
# stale for weeks (petrus 2026-09-01: "also claudemm not visible on intent").
# uik-daemon warns about exactly this; the warning went to a log nobody read.
export INTENT_USER_ID="$(python3 -c "import json;print(json.load(open('$CONFIG'))['intent']['userId'])")"
export INTENT_AGENT_HANDLE="@claudemm"
export INTENT_DEVICE_ID="mac-mini"

# launchd starts this with a bare PATH (no Homebrew): resolve node explicitly
# or the job dies with "exec: node: not found" - which is what kept the
# publisher an orphan started by hand instead of a KeepAlive service.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
exec "$NODE_BIN" "$IAK_DIR/packages/user-intent-kit/bin/uik-daemon.js"
