#!/usr/bin/env bash
# claudemb_poll.sh — poll thinkoff-development room for new messages
# Runs in a tmux session; wakes the Claude session on new messages.

set -euo pipefail

CONFIG_JSON="${IAK_CONFIG_JSON:-/Users/petrus/AndroidStudioProjects/ThinkOff/ide-agent-kit-codex.json}"
read_json_value() {
    local path="$1"
    python3 - "$CONFIG_JSON" "$path" <<'PY'
import json, sys
cfg_path, dotted = sys.argv[1], sys.argv[2]
try:
    with open(cfg_path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
    cur = data
    for part in dotted.split('.'):
        cur = cur[part]
    if isinstance(cur, str):
        print(cur)
except Exception:
    pass
PY
}

CONFIG_API_KEY="$(read_json_value 'poller.api_key')"
CONFIG_NUDGE_TEXT="$(read_json_value 'tmux.nudge_text')"

API_KEY="${IAK_API_KEY:-${ANTIGRAVITY_API_KEY:-${CONFIG_API_KEY:-}}}"
ROOM="${ROOM:-thinkoff-development}"
BASE_URL="${BASE_URL:-https://antfarm.world/api/v1}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
FETCH_LIMIT="${FETCH_LIMIT:-20}"
HTTP_CONNECT_TIMEOUT_SEC="${HTTP_CONNECT_TIMEOUT_SEC:-5}"
HTTP_TIMEOUT_SEC="${HTTP_TIMEOUT_SEC:-20}"
SEEN_IDS_FILE="${SEEN_IDS_FILE:-/tmp/claudemb_seen_ids.txt}"
SESSION="${SESSION:-claudemb-poll}"
WAKE_SCRIPT="$(dirname "$0")/claudemb_wake.sh"
WAKE_SESSION="${CLAUDEMB_SESSION:-claude}"
NUDGE_TEXT="${IAK_NUDGE_TEXT:-${CONFIG_NUDGE_TEXT:-check rooms}}"
WAKE_COOLDOWN_SEC="${WAKE_COOLDOWN_SEC:-45}"
LAST_WAKE_FILE="${LAST_WAKE_FILE:-/tmp/claudemb_last_wake_epoch.txt}"
NEW_FILE="${IAK_NEW_FILE:-/tmp/iak-new-messages.txt}"
NEW_FILE_COMPAT="${IAK_NEW_FILE_COMPAT:-/tmp/iak_new_messages.txt}"

# --- tmux management ---
if [[ "${1:-}" == "tmux" ]]; then
    cmd="${2:-start}"
    case "$cmd" in
        stop)
            if tmux has-session -t "$SESSION" 2>/dev/null; then
                tmux kill-session -t "$SESSION"
                echo "Stopped $SESSION"
            else
                echo "$SESSION is not running"
            fi
            ;;
        status)
            if tmux has-session -t "$SESSION" 2>/dev/null; then
                echo "$SESSION is running ($(tmux list-panes -t "$SESSION" -F '#{pane_pid}'))"
            else
                echo "$SESSION is not running"
            fi
            ;;
        logs)
            if tmux has-session -t "$SESSION" 2>/dev/null; then
                tmux attach-session -t "$SESSION"
            else
                echo "$SESSION is not running"
                exit 1
            fi
            ;;
        start|"")
            if tmux has-session -t "$SESSION" 2>/dev/null; then
                echo "$SESSION already running — attaching"
                tmux attach-session -t "$SESSION"
                exit 0
            fi
            SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
            tmux new-session -d -s "$SESSION" "$SCRIPT_PATH"
            echo "Started $SESSION — polling $ROOM every ${POLL_INTERVAL}s"
            echo "Attach with: $0 tmux logs"
            ;;
        *)
            echo "Usage: $0 tmux {start|stop|status|logs}"
            exit 1
            ;;
    esac
    exit 0
fi

# --- helpers ---
can_wake_now() {
    local now last
    now="$(date +%s)"
    last=0
    if [[ -f "$LAST_WAKE_FILE" ]]; then
        last="$(cat "$LAST_WAKE_FILE" 2>/dev/null || echo 0)"
    fi
    if [[ ! "$last" =~ ^[0-9]+$ ]]; then
        last=0
    fi
    if (( now - last >= WAKE_COOLDOWN_SEC )); then
        echo "$now" > "$LAST_WAKE_FILE"
        return 0
    fi
    return 1
}

# --- polling loop ---
touch "$SEEN_IDS_FILE" "$NEW_FILE" "$NEW_FILE_COMPAT" "$LAST_WAKE_FILE"
if [[ ! -s "$LAST_WAKE_FILE" ]]; then
  echo 0 > "$LAST_WAKE_FILE"
fi

echo "[claudemb] Polling $ROOM every ${POLL_INTERVAL}s (limit=$FETCH_LIMIT)"
echo "[claudemb] Seen IDs file: $SEEN_IDS_FILE ($(wc -l < "$SEEN_IDS_FILE" | tr -d ' ') known)"
echo "[claudemb] Wake target session (exact): $WAKE_SESSION"
echo "[claudemb] Nudge text: $NUDGE_TEXT (cooldown=${WAKE_COOLDOWN_SEC}s)"
echo "[claudemb] New message files: $NEW_FILE and $NEW_FILE_COMPAT"
echo ""

while true; do
    response=$(curl -sS --connect-timeout "$HTTP_CONNECT_TIMEOUT_SEC" --max-time "$HTTP_TIMEOUT_SEC" -H "X-API-Key: $API_KEY" \
        "$BASE_URL/rooms/$ROOM/messages?limit=$FETCH_LIMIT" 2>&1) || {
        echo "[$(date +%H:%M:%S)] fetch error: $response"
        sleep "$POLL_INTERVAL"
        continue
    }

    new_count=0
    while IFS=$'\t' read -r msg_id msg_from msg_body; do
        [[ -z "$msg_id" ]] && continue
        if ! grep -qF "$msg_id" "$SEEN_IDS_FILE"; then
            echo "$msg_id" >> "$SEEN_IDS_FILE"
            new_count=$((new_count + 1))
            body_preview="${msg_body:0:120}"
            echo "[$(date +%H:%M:%S)] NEW  ${msg_from}: ${body_preview}"

            ts="$(date -u +%FT%TZ)"
            line="[${ts}] [${ROOM}] ${msg_from}: ${msg_body:0:600}"
            printf '%s\n---\n' "$line" >> "$NEW_FILE"
            printf '%s\n---\n' "$line" >> "$NEW_FILE_COMPAT"
        fi
    done < <(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for m in data.get('messages', []):
        mid = m.get('id', '')
        mfrom = m.get('from', '?')
        mbody = m.get('body', '').replace('\\n', ' ').replace('\\t', ' ')
        print(f'{mid}\\t{mfrom}\\t{mbody}')
except Exception:
    pass
" 2>/dev/null)

    if [[ $new_count -gt 0 ]]; then
        echo "[$(date +%H:%M:%S)] $new_count new message(s)"
        if [[ -x "$WAKE_SCRIPT" ]]; then
            if can_wake_now; then
                if ! CLAUDEMB_SESSION="$WAKE_SESSION" "$WAKE_SCRIPT" "$NUDGE_TEXT"; then
                    echo "[$(date +%H:%M:%S)] wake failed: target session '$WAKE_SESSION' not found (exact match required)"
                fi
            else
                echo "[$(date +%H:%M:%S)] wake skipped: cooldown active (${WAKE_COOLDOWN_SEC}s)"
            fi
        fi
        echo ""
    fi

    sleep "$POLL_INTERVAL"
done
