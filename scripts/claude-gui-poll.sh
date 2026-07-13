#!/usr/bin/env bash
# claude-gui-poll.sh — poll GroupMind rooms + DMs for Claude Code desktop app
# Runs in tmux via launchd. Wakes the GUI via osascript on new messages.
#
# Required env: IAK_API_KEY
# Optional env: SELF_HANDLE (default @claudemm), ROOM, POLL_INTERVAL, etc.
#
# Setup: see examples/claude-gui-launchd.plist and README

set -euo pipefail

API_KEY="${IAK_API_KEY:-}"
ROOM="${ROOM:-thinkoff-development}"
SELF_HANDLE="${SELF_HANDLE:-@claudemm}"
BASE_URL="${BASE_URL:-https://groupmind.one/api/v1}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
FETCH_LIMIT="${FETCH_LIMIT:-20}"
SEEN_IDS_FILE="${SEEN_IDS_FILE:-/tmp/claude-gui-seen-ids.txt}"
WAKE_SCRIPT="${WAKE_SCRIPT:-$(dirname "$0")/claude-gui-wake.sh}"
NUDGE_TEXT="${NUDGE_TEXT:-check rooms}"
WAKE_COOLDOWN_SEC="${WAKE_COOLDOWN_SEC:-45}"
LAST_WAKE_FILE="${LAST_WAKE_FILE:-/tmp/claude-gui-last-wake.txt}"
NEW_FILE="${NEW_FILE:-/tmp/iak-new-messages.txt}"
# Timestamp of the last SUCCESSFUL wake: retries only fire for content newer
# than this, so a session that is still starting up isn't re-nudged forever.
WAKE_OK_FILE="${WAKE_OK_FILE:-/tmp/claude-gui-wake-ok.txt}"

[[ -z "$API_KEY" ]] && { echo "ERROR: Set IAK_API_KEY" >&2; exit 1; }

can_wake_now() {
    local now=$(date +%s) last=0
    [[ -f "$LAST_WAKE_FILE" ]] && last="$(cat "$LAST_WAKE_FILE" 2>/dev/null || echo 0)"
    [[ ! "$last" =~ ^[0-9]+$ ]] && last=0
    (( now - last >= WAKE_COOLDOWN_SEC )) && { echo "$now" > "$LAST_WAKE_FILE"; return 0; }
    return 1
}

do_wake() {
    # Ack-after-success (codex acceptance gate, #29 blocker 3): do NOT
    # swallow a failed wake - report it so the caller loop retries while
    # content is pending. Bodies are durable in $NEW_FILE, so a failed
    # wake delays delivery, never loses it.
    [[ -x "$WAKE_SCRIPT" ]] || return 0
    can_wake_now || return 0
    if ! "$WAKE_SCRIPT" "$NUDGE_TEXT" 2>/dev/null; then
        echo "[$(date +%H:%M:%S)] wake NOT DELIVERED - retrying next cycle"
        return 1
    fi
    return 0
}

parse_msgs='
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data if isinstance(data, list) else data.get("messages", data.get("data", []))
    for m in msgs:
        mid = m.get("id", "")
        mfrom = m.get("from", "?")
        mbody = (m.get("body", "") or "").replace("\n", " ").replace("\t", " ")
        print(f"{mid}\t{mfrom}\t{mbody}")
except Exception: pass
'

process_messages() {
    local source="$1" response="$2" count=0
    while IFS=$'\t' read -r msg_id msg_from msg_body; do
        [[ -z "$msg_id" ]] && continue
        [[ "$msg_from" == "$SELF_HANDLE" || "$msg_from" == "${SELF_HANDLE#@}" ]] && {
            grep -qF "$msg_id" "$SEEN_IDS_FILE" || echo "$msg_id" >> "$SEEN_IDS_FILE"; continue; }
        grep -qF "$msg_id" "$SEEN_IDS_FILE" && continue
        echo "$msg_id" >> "$SEEN_IDS_FILE"
        count=$((count + 1))
        echo "[$(date +%H:%M:%S)] $source ${msg_from}: ${msg_body:0:120}"
        printf '[%s] [%s] %s: %s\n' "$(date -u +%FT%TZ)" "$source" "$msg_from" "${msg_body:0:600}" >> "$NEW_FILE"
    done < <(echo "$response" | python3 -c "$parse_msgs" 2>/dev/null)
    echo $count
}

touch "$SEEN_IDS_FILE" "$NEW_FILE" "$LAST_WAKE_FILE"
[[ ! -s "$LAST_WAKE_FILE" ]] && echo 0 > "$LAST_WAKE_FILE"
echo "[claude-gui] Polling $ROOM every ${POLL_INTERVAL}s | Self: $SELF_HANDLE | Wake: $WAKE_SCRIPT"

while true; do
    room_resp=$(curl -sS --connect-timeout 5 --max-time 20 -H "X-API-Key: $API_KEY" \
        "$BASE_URL/rooms/$ROOM/messages?limit=$FETCH_LIMIT" 2>/dev/null) || room_resp=""
    [[ -n "$room_resp" ]] && n=$(process_messages "$ROOM" "$room_resp")

    dm_resp=$(curl -sS --connect-timeout 5 --max-time 20 -H "X-API-Key: $API_KEY" \
        "$BASE_URL/messages?to=$SELF_HANDLE&limit=$FETCH_LIMIT" 2>/dev/null) || dm_resp=""
    [[ -n "$dm_resp" ]] && n=$(process_messages "DM" "$dm_resp")

    # Retry the wake on every cycle while undelivered content is pending
    # (durable retry, #29 blocker 3) - not only on cycles with new IDs.
    # B1 (claudemm gate review on #30): under set -e a bare `do_wake`
    # returning 1 as the last command TERMINATES the poller - the shipped
    # plist has KeepAlive=false, so one failed wake would kill the wake
    # path permanently. Tolerate the failure; the retry is state-driven.
    # Post-success re-nudge guard: only retry when NEW_FILE has content
    # NEWER than the last successful wake, else a slow-to-start session
    # gets re-nudged every cycle after a wake that already worked.
    if [[ -s "$NEW_FILE" ]]; then
        if [[ ! -f "$WAKE_OK_FILE" || "$NEW_FILE" -nt "$WAKE_OK_FILE" ]]; then
            if do_wake; then
                touch "$WAKE_OK_FILE"
            fi
        fi
    fi

    sleep "$POLL_INTERVAL"
done
