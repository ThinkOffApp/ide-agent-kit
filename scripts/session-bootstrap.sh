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
# owner's pid + session id + process start time: it is reclaimed by the
# same session on resume/compact, and stolen automatically once the owner
# process is dead — start time is the identity check, so a recycled pid
# never masquerades as the owner. Initial claim is O_EXCL-atomic and every
# winner re-verifies after a short settle, so concurrent starts elect
# exactly one responder. Any failure in the lock mechanics degrades to
# ACTIVE (status quo) — a rare duplicate voice beats a machine with no
# room responder at all.
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
LOCK_PSTART=""
LOCK_HELD=""
SETTLE_SEC="${IAK_RESPONDER_SETTLE_SEC:-0.3}"

# Process start time doubles as an identity check: a recycled pid has a
# different start time, so a dead owner is never mistaken for alive. Using
# ps (not kill -0) also keeps a cross-user owner visible — kill -0 reports
# EPERM there, which must not read as "dead".
proc_lstart() {
    [ -n "${1:-}" ] || return 1
    case "$1" in (*[!0-9]*|'') return 1;; esac
    ps -p "$1" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' | head -1
}

read_lock() {
    LOCK_PID=$(sed -n 's/^pid=//p' "$LOCK_FILE" 2>/dev/null | head -1)
    LOCK_SID=$(sed -n 's/^sid=//p' "$LOCK_FILE" 2>/dev/null | head -1)
    LOCK_PSTART=$(sed -n 's/^pstart=//p' "$LOCK_FILE" 2>/dev/null | head -1)
}

owner_alive() {
    local now
    now=$(proc_lstart "$LOCK_PID") || return 1
    [ -n "$now" ] || return 1
    # Locks written before pstart existed carry no identity beyond the pid.
    [ -z "$LOCK_PSTART" ] || [ "$now" = "$LOCK_PSTART" ]
}

lock_content() {
    printf 'pid=%s\nsid=%s\npstart=%s\nclaimed_at=%s\n' \
        "$PPID" "$SESSION_ID" "$(proc_lstart "$PPID" || true)" \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
}

claim_atomic() {
    # O_CREAT|O_EXCL via noclobber: exactly one concurrent claimer wins.
    ( set -o noclobber; lock_content > "$LOCK_FILE" ) 2>/dev/null
}

claim_overwrite() {
    # Only for refreshing a lock this session already owns.
    local tmp="${LOCK_FILE}.$$"
    { lock_content > "$tmp" && mv -f "$tmp" "$LOCK_FILE"; } 2>/dev/null \
        || { rm -f "$tmp" 2>/dev/null; return 1; }
}

lost_claim_race() {
    # A failed claim only demotes us if somebody else really holds the
    # file; an unwritable directory is a mechanics failure -> fail open.
    [ -f "$LOCK_FILE" ] && ROLE="passive"
}

if [ "$LOCK_FILE" != "off" ]; then
    if [ -f "$LOCK_FILE" ]; then
        read_lock
        if [ -n "$SESSION_ID" ] && [ "$LOCK_SID" = "$SESSION_ID" ]; then
            claim_overwrite || true    # same session resuming: refresh pid
        elif [ -z "$SESSION_ID" ] && [ "$LOCK_PID" = "$PPID" ]; then
            # pid fallback ONLY when the harness passes no session id
            # (e.g. compact re-runs in the same process). With a session
            # id present the sid line is the sole reclaim identity —
            # sibling hook processes can legitimately share a parent pid.
            claim_overwrite || true
        elif owner_alive; then
            ROLE="passive"
        else
            rm -f "$LOCK_FILE" 2>/dev/null   # owner gone (or pid recycled)
            claim_atomic || lost_claim_race
        fi
    else
        claim_atomic || lost_claim_race
    fi

    if [ "$ROLE" = "active" ]; then
        # Post-claim verify: near-simultaneous steals can overwrite each
        # other; after a short settle whoever the lock names is the single
        # winner, everyone else demotes to PASSIVE (the machine still has
        # exactly one responder). An unreadable lock here is a mechanics
        # failure and stays ACTIVE.
        sleep "$SETTLE_SEC" 2>/dev/null || true
        read_lock
        if [ -n "$LOCK_PID" ] && [ "$LOCK_PID" != "$PPID" ]; then
            ROLE="passive"
        elif [ -n "$SESSION_ID" ] && [ -n "$LOCK_SID" ] && [ "$LOCK_SID" != "$SESSION_ID" ]; then
            ROLE="passive"
        else
            LOCK_HELD="$LOCK_FILE"
        fi
    else
        read_lock
    fi
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
