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
# Single-responder guard: only ONE session per notification file may act as
# the room responder. Without it, every fresh session on the machine (a
# second interactive `claude`, a remote-control shell, a stray automation
# launch) boots the same instructions and answers the room as the same
# handle — duplicate, conflicting posts (bit the fleet on 2026-07-16). The
# first session claims a lock file; later sessions get PASSIVE instructions
# (serve the user directly, stay out of the room). The lock carries the
# owner's pid + session id: it is reclaimed by the same session on
# resume/compact and stolen automatically once the owner process is dead.
# Any failure in the lock mechanics degrades to ACTIVE (status quo) — a
# rare duplicate voice beats a machine with no room responder at all.
#
# Configuration (first match wins):
#   notification file : $IAK_NEW_FILE, else config poller.notification_file,
#                       else /tmp/iak-new-messages.txt (poller default)
#   agent handle      : $IAK_HANDLE, else config poller.handle (cosmetic)
#   fallback interval : $IAK_BOOTSTRAP_FALLBACK_SEC (default 1500 seconds)
#   responder lock    : $IAK_RESPONDER_LOCK (path, or "off" to disable),
#                       else <notification file>.responder.lock
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
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('session_id',''))
except Exception: print('')" 2>/dev/null || true)

# --- single-responder lock -------------------------------------------------
# ROLE ends up ACTIVE (full bootstrap) or PASSIVE (stand down); see header.
LOCK_FILE="${IAK_RESPONDER_LOCK:-${NEWMSG_FILE}.responder.lock}"
ROLE="active"
LOCK_PID=""
LOCK_SID=""
LOCK_HELD=""

pid_alive() {
    [ -n "$1" ] || return 1
    case "$1" in (*[!0-9]*|'') return 1;; esac
    kill -0 "$1" 2>/dev/null
}

write_lock() {
    # Best-effort atomic replace; failure leaves ROLE=active (fail open).
    local tmp="${LOCK_FILE}.$$"
    {
        printf 'pid=%s\n' "$PPID"
        printf 'sid=%s\n' "$SESSION_ID"
        printf 'claimed_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
    } > "$tmp" 2>/dev/null && mv -f "$tmp" "$LOCK_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}

if [ "$LOCK_FILE" != "off" ]; then
    if [ -f "$LOCK_FILE" ]; then
        LOCK_PID=$(sed -n 's/^pid=//p' "$LOCK_FILE" 2>/dev/null | head -1)
        LOCK_SID=$(sed -n 's/^sid=//p' "$LOCK_FILE" 2>/dev/null | head -1)
        if [ -n "$SESSION_ID" ] && [ "$LOCK_SID" = "$SESSION_ID" ]; then
            write_lock   # same session resuming: refresh pid
        elif [ "$LOCK_PID" = "$PPID" ]; then
            write_lock   # same process (e.g. compact): keep ownership
        elif pid_alive "$LOCK_PID"; then
            ROLE="passive"
        else
            write_lock   # owner died without cleanup: steal the stale lock
        fi
    else
        write_lock
    fi
    [ "$ROLE" = "active" ] && LOCK_HELD="$LOCK_FILE"
fi

BACKLOG=""
if [ -s "$NEWMSG_FILE" ]; then
    BACKLOG=$(wc -l < "$NEWMSG_FILE" | tr -d ' ')
fi

if [ "$ROLE" = "passive" ]; then
    CTX="IAK room-agent bootstrap${HANDLE:+ for ${HANDLE}} — PASSIVE (injected by SessionStart hook): another live session already holds this machine's room-responder role for ${NEWMSG_FILE} (owner pid ${LOCK_PID}${LOCK_SID:+, session ${LOCK_SID}}; lock ${LOCK_FILE}).
1. Do NOT arm a Monitor on ${NEWMSG_FILE}, do NOT run the room loop, and do NOT answer room messages${HANDLE:+ as ${HANDLE}} — two sessions answering as one handle produces duplicate, conflicting posts.
2. Serve the user's direct requests in this session normally; reading the room for context is fine, responding to it is not.
3. Take over ONLY if the user explicitly asks this session to become the room responder: delete ${LOCK_FILE}, then follow the standard bootstrap (Monitor + backlog + '/loop check rooms')."
else
    CTX="IAK room-agent bootstrap${HANDLE:+ for ${HANDLE}} (injected by SessionStart hook — do this without being asked):
1. If TaskList shows no running Monitor watching ${NEWMSG_FILE}, arm one now: Monitor(command: \"tail -F -n 0 ${NEWMSG_FILE} 2>/dev/null\", persistent: true). Never arm a duplicate.
2. Backlog: ${BACKLOG:-0} unconsumed line(s) in ${NEWMSG_FILE}. If >0: read the messages (prefer the IAK MCP room_list_new tool), act on them, then ack with the IAK MCP room_ack tool - it removes ONLY what you read, so a message the poller appends mid-ack survives. Only if the IAK MCP tools are unavailable this session, fall back to reading the file directly and clearing it (: > ${NEWMSG_FILE}), re-checking immediately after for lines that arrived during the clear.
3. Operate as the self-paced room loop ('/loop check rooms' semantics): after handling room work, keep a fallback ScheduleWakeup armed (~${FALLBACK_SEC}s) with prompt '/loop check rooms'. The Monitor is the primary wake signal.
4. Session source: ${SOURCE:-unknown}. On 'compact' the Monitor usually survived — verify via TaskList instead of re-arming blindly.${LOCK_HELD:+
5. You hold the room-responder lock (${LOCK_HELD}): this session is the machine's ONLY room voice. The lock goes stale automatically when this session's process exits — never delete it while active.}"
fi

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
