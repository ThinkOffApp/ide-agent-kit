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
export INTENT_USER_ID="claudemm"
export INTENT_AGENT_HANDLE="@claudemm"
export INTENT_DEVICE_ID="mac-mini"

exec node "$IAK_DIR/packages/user-intent-kit/bin/uik-daemon.js"
