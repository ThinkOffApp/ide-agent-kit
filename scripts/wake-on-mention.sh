#!/usr/bin/env bash
# Scan a room message body for @<handle> mentions and fire POST /wake on
# every matching peer's IAK daemon URL. Sub-second cross-machine nudge
# instead of waiting for the target's room poll cycle.
#
# Usage:
#   wake-on-mention.sh "<message body>" [from-handle]
#
# Reads peer mapping from $IAK_CONFIG_JSON or default ide-agent-kit.json:
#
#   {
#     "mcp": {
#       "confirmations": {
#         "peers": {
#           "@claudemm": "http://192.168.50.105:8788",
#           "@CodexMB":  "http://192.168.50.105:8788"
#         }
#       }
#     }
#   }
#
# Env overrides:
#   IAK_PEERS_JSON     — JSON object overriding the config peers map
#   IAK_NUDGE_TEXT     — text to type into the woken IDE (default "check rooms")
#   IAK_WAKE_TIMEOUT   — seconds to wait per POST (default 3)
#   IAK_SELF_HANDLE    — skip mentions of self (avoids loop)

set -euo pipefail

CONFIG_JSON="${IAK_CONFIG_JSON:-/Users/petrus/ide-agent-kit/ide-agent-kit.json}"
NUDGE_TEXT="${IAK_NUDGE_TEXT:-check rooms}"
WAKE_TIMEOUT="${IAK_WAKE_TIMEOUT:-3}"
SELF_HANDLE="${IAK_SELF_HANDLE:-}"
LOG_FILE="${IAK_WAKE_LOG:-/tmp/iak-wake-on-mention.log}"

MSG="${1:-}"
FROM="${2:-unknown}"
if [ -z "$MSG" ]; then
    echo "usage: $0 \"<message body>\" [from-handle]" >&2
    exit 2
fi

# Read peer map: env override > config file.
peers_json="${IAK_PEERS_JSON:-}"
if [ -z "$peers_json" ] && [ -f "$CONFIG_JSON" ]; then
    peers_json="$(python3 - "$CONFIG_JSON" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    print(json.dumps(cfg.get("mcp", {}).get("confirmations", {}).get("peers", {})))
except Exception:
    print("{}")
PY
)"
fi
if [ -z "$peers_json" ] || [ "$peers_json" = "{}" ]; then
    # No peers configured — silent no-op.
    exit 0
fi

# Extract @<handle> tokens, dedupe, and look each up in the peer map.
# Then POST /wake to each match. Skip SELF_HANDLE.
python3 - "$MSG" "$FROM" "$peers_json" "$NUDGE_TEXT" "$WAKE_TIMEOUT" "$SELF_HANDLE" "$LOG_FILE" <<'PY'
import json, re, sys, time
import urllib.request

msg, frm, peers_json, text, timeout_s, self_handle, log_path = sys.argv[1:8]
timeout = float(timeout_s)
peers = json.loads(peers_json)

# Normalize keys to lowercase for case-insensitive matching.
peers_lower = { k.lower(): (k, v) for k, v in peers.items() }

# Find @<handle> tokens. Handles may include letters / digits / underscores / dashes / dots.
mentions = set(m.lower() for m in re.findall(r'@[A-Za-z0-9_.\-]+', msg))
mentions.discard(self_handle.lower())

if not mentions:
    sys.exit(0)

now = time.strftime("%FT%TZ", time.gmtime())
log = open(log_path, "a")

for h in mentions:
    if h not in peers_lower:
        continue
    canonical, gate_url = peers_lower[h]
    url = gate_url.rstrip("/") + "/wake"
    body = json.dumps({"text": text + f" (auto-wake from {frm} via @-mention)"}).encode()
    try:
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req, timeout=timeout)
        log.write(f"[{now}] wake-on-mention {canonical} → {url}: HTTP {resp.status}\n")
    except Exception as e:
        log.write(f"[{now}] wake-on-mention {canonical} → {url}: ERR {e}\n")
log.close()
PY
