#!/usr/bin/env bash
# SessionStart hook for Claude Code: IAK room-agent auto-bootstrap.
#
# Problem: after an IDE/CLI restart the agent sits idle until a human types
# "/loop check rooms" by hand. With this hook every fresh session self-arms:
#   1. a persistent Monitor on the poller's notification file (instant wake)
#   2. any backlog that arrived while no session was running gets read+acted on
#   3. the self-paced room loop, with a ScheduleWakeup fallback heartbeat
#
# It reads the hook input JSON on stdin (may include "source":
# startup|resume|compact) and emits hookSpecificOutput.additionalContext
# with suppressOutput, so the instructions are injected as session context.
# It never blocks session start: any failure degrades to no output + exit 0.
#
# Configuration (first match wins):
#   notification file : $IAK_NEW_FILE, else config poller.notification_file,
#                       else /tmp/iak-new-messages.txt (poller default)
#   agent handle      : $IAK_HANDLE, else config poller.handle (cosmetic)
#   fallback interval : $IAK_BOOTSTRAP_FALLBACK_SEC (default 1500 seconds)
#   config file       : $IAK_CONFIG_JSON, else ide-agent-kit.json next to the
#                       repo (scripts/..), else two levels up — which is the
#                       project root when `ide-agent-kit init` installed this
#                       script into <project>/.claude/scripts/.
#
# Wire it into ~/.claude/settings.json (scripts/install.sh and
# `ide-agent-kit init --ide claude-code` both do this automatically):
#
#   {
#     "hooks": {
#       "SessionStart": [
#         {
#           "matcher": "",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "bash /path/to/session-bootstrap.sh",
#               "timeout": 10
#             }
#           ]
#         }
#       ]
#     }
#   }
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# --- locate the IAK config (same convention as claudemb-poll.sh) ---
CONFIG_JSON="${IAK_CONFIG_JSON:-}"
if [ -z "$CONFIG_JSON" ]; then
    for candidate in "$SCRIPT_DIR/../ide-agent-kit.json" "$SCRIPT_DIR/../../ide-agent-kit.json"; do
        if [ -f "$candidate" ]; then
            CONFIG_JSON="$candidate"
            break
        fi
    done
fi

read_json_value() {
    local path="$1"
    [ -n "$CONFIG_JSON" ] && [ -f "$CONFIG_JSON" ] || return 0
    python3 - "$CONFIG_JSON" "$path" <<'PY' 2>/dev/null
import json, sys
cfg_path, dotted = sys.argv[1], sys.argv[2]
try:
    with open(cfg_path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
    cur = data
    for part in dotted.split('.'):
        cur = cur[part]
    if isinstance(cur, str) and cur:
        print(cur)
except Exception:
    pass
PY
}

CONFIG_NEW_FILE="$(read_json_value 'poller.notification_file')"
CONFIG_HANDLE="$(read_json_value 'poller.handle')"

NEWMSG_FILE="${IAK_NEW_FILE:-${CONFIG_NEW_FILE:-/tmp/iak-new-messages.txt}}"
HANDLE="${IAK_HANDLE:-${CONFIG_HANDLE:-}}"
FALLBACK_SEC="${IAK_BOOTSTRAP_FALLBACK_SEC:-1500}"

# Read hook input (may include "source": startup|resume|compact) — we only
# need it to soften the instruction on compact, where a Monitor usually
# already survives as a harness task.
INPUT=$(cat 2>/dev/null || true)
SOURCE=$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('source',''))
except Exception: print('')" 2>/dev/null || true)

BACKLOG=""
if [ -s "$NEWMSG_FILE" ]; then
    BACKLOG=$(wc -l < "$NEWMSG_FILE" | tr -d ' ')
fi

CTX="IAK room-agent bootstrap${HANDLE:+ for ${HANDLE}} (injected by SessionStart hook — do this without being asked):
1. If TaskList shows no running Monitor watching ${NEWMSG_FILE}, arm one now: Monitor(command: \"tail -F -n 0 ${NEWMSG_FILE} 2>/dev/null\", persistent: true). Never arm a duplicate.
2. Backlog: ${BACKLOG:-0} unconsumed line(s) in ${NEWMSG_FILE}. If >0, read the file, act on the messages, then clear it (: > ${NEWMSG_FILE}).
3. Operate as the self-paced room loop ('/loop check rooms' semantics): after handling room work, keep a fallback ScheduleWakeup armed (~${FALLBACK_SEC}s) with prompt '/loop check rooms'. The Monitor is the primary wake signal.
4. Session source: ${SOURCE:-unknown}. On 'compact' the Monitor usually survived — verify via TaskList instead of re-arming blindly."

python3 - "$CTX" <<'PYEOF' 2>/dev/null
import json, sys
print(json.dumps({
    "suppressOutput": True,
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": sys.argv[1],
    },
}))
PYEOF
exit 0
