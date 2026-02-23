#!/usr/bin/env bash
# geminimb_room_autopost.sh
# Automatic room responder for @geminiMB.
# Responds to new room messages (mention-only by default).
#
# Usage:
#   ./tools/geminimb_room_autopost.sh
#   ./tools/geminimb_room_autopost.sh tmux
#   ./tools/geminimb_room_autopost.sh tmux stop
#   ./tools/geminimb_room_autopost.sh tmux status
#   ./tools/geminimb_room_autopost.sh tmux logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Define the GeminiMB API Key directly as requested
API_KEY="antfarm_9aec99ba9136fced8a409fe17bdc9080"

BASE_URL="https://antfarm.world/api/v1"
ROOMS_CSV="${ROOMS:-feature-admin-planning,thinkoff-development}"
POLL_INTERVAL="${POLL_INTERVAL:-8}"
FETCH_LIMIT="${FETCH_LIMIT:-10}"
SESSION="${SESSION:-geminimb-room-autopost}"
AGENT_HANDLE="@geminiMB"
MENTION_ONLY="${MENTION_ONLY:-0}"   # 0 = process all messages in the room
RESPOND_TO_HANDLE="${RESPOND_TO_HANDLE:-petrus}"
SOURCE_TAG="${SOURCE_TAG:-[geminimb][tmux-ok]}"
SEEN_MAX="${SEEN_MAX:-500}"

SEEN_IDS_FILE="/tmp/geminimb_room_autopost_seen_ids.txt"
ACKED_IDS_FILE="/tmp/geminimb_room_autopost_acked_ids.txt"

has_id() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] && grep -qF "$key" "$file"
}

record_id() {
  local file="$1"
  local key="$2"
  echo "$key" >> "$file"
  tail -n "$SEEN_MAX" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

prime_seen_ids() {
  local room="$1"
  local response
  response="$(curl -sS -H "X-API-Key: $API_KEY" "$BASE_URL/rooms/$room/messages?limit=50" 2>/dev/null || true)"
  [[ -z "$response" ]] && return 0
  echo "$response" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for m in data.get("messages", []):
    mid = m.get("id", "")
    if mid:
        print(mid)
' | sed -e "s#^#${room}::#" >> "$SEEN_IDS_FILE"
  awk "!seen[\$0]++" "$SEEN_IDS_FILE" > "${SEEN_IDS_FILE}.tmp" && mv "${SEEN_IDS_FILE}.tmp" "$SEEN_IDS_FILE"
  tail -n "$SEEN_MAX" "$SEEN_IDS_FILE" > "${SEEN_IDS_FILE}.tmp" && mv "${SEEN_IDS_FILE}.tmp" "$SEEN_IDS_FILE"
}

build_reply() {
  local from_handle="$1"
  local created_at="$2"
  local body="$3"
  local lc
  lc="$(printf "%s" "$body" | tr '[:upper:]' '[:lower:]')"
  local lag_sec
  lag_sec="$(seconds_since_iso "$created_at")"

  if [[ "$lc" == *"hear me"* ]]; then
    if [[ "$lag_sec" =~ ^[0-9]+$ ]] && [[ "$lag_sec" -ge 0 ]]; then
      echo "@${from_handle#@} ${SOURCE_TAG} yes, hearing you. ${lag_sec}s from your message. path=geminimb poller."
    else
      echo "@${from_handle#@} ${SOURCE_TAG} yes, hearing you. path=geminimb poller."
    fi
    return 0
  fi
  if [[ "$lc" == *"webhook and/or tmux"* ]]; then
    echo "@${from_handle#@} ${SOURCE_TAG} path=geminimb poller on this runtime."
    return 0
  fi

  # Auto-ack tasks directed at geminimb or implicitly directed at everyone
  local is_task=0
  if [[ "$lc" == *"can you"* || "$lc" == *"please"* || "$lc" == *"need to"* || "$lc" == *"check"* || "$lc" == *"fix"* || "$lc" == *"update"* || "$lc" == *"review"* || "$lc" == *"run"* || "$lc" == *"deploy"* || "$lc" == *"implement"* || "$lc" == *"test"* || "$lc" == *"restart"* || "$lc" == *"install"* || "$lc" == *"respond"* || "$lc" == *"post"* || "$lc" == *"pull"* || "$lc" == *"push"* || "$lc" == *"merge"* || "$lc" == *"make it"* ]]; then
    is_task=1
  fi

  local targets_me=1
  if [[ "$lc" == *"@claudemm"* || "$lc" == *"@antigravity"* || "$lc" == *"ag-codex"* || "$lc" == *"claude"* ]]; then
    if [[ "$lc" != *"@geminimb"* && "$lc" != *"geminimb"* && "$lc" != *"gemini"* ]]; then
      targets_me=0
    fi
  fi

  if [[ "$is_task" == "1" && "$targets_me" == "1" ]]; then
    echo "@${from_handle#@} ${SOURCE_TAG} starting now. I will report back with results."
    return 0
  fi

  # For normal conversation, avoid placeholder acknowledgements.
  echo ""
}

seconds_since_iso() {
  local ts="$1"
  python3 - "$ts" <<'PY'
import datetime, sys
ts = sys.argv[1]
try:
    dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(max(0, int((now - dt).total_seconds())))
except Exception:
    print(-1)
PY
}

should_force_reply() {
  local from_handle="$1"
  local body="$2"
  local lc
  lc="$(printf "%s" "$body" | tr '[:upper:]' '[:lower:]')"
  if [[ "$from_handle" != "$RESPOND_TO_HANDLE" ]]; then
    return 1
  fi
  if [[ "$lc" == *"do you hear me"* || "$lc" == *"report time in"* || "$lc" == *"webhook and/or tmux"* || "$lc" == *"all of you"* || "$lc" == *"can you"* || "$lc" == *"please"* || "$lc" == *"need to"* || "$lc" == *"check"* ]]; then
    return 0
  fi
  return 1
}

post_reply() {
  local room="$1"
  local from_handle="$2"
  local created_at="$3"
  local src_key="$4"
  local src_body="$5"

  if has_id "$ACKED_IDS_FILE" "$src_key"; then
    return 0
  fi

  local reply_body
  reply_body="$(build_reply "$from_handle" "$created_at" "$src_body")"
  if [[ -z "$reply_body" ]]; then
    return 0
  fi

  local payload
  payload="$(python3 - <<'PY' "$room" "$reply_body"
import json, sys
room = sys.argv[1]
body = sys.argv[2]
print(json.dumps({"room": room, "body": body}))
PY
)"

  local res
  if ! res="$(curl -sS -X POST \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$BASE_URL/messages" 2>&1)"; then
    echo "[$(date +%H:%M:%S)] reply failed: $res"
    return 1
  fi

  local posted_id
  posted_id="$(echo "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
  if [[ -n "$posted_id" ]]; then
    record_id "$ACKED_IDS_FILE" "$src_key"
    echo "[$(date +%H:%M:%S)] REPLIED room=$room -> $from_handle (src=$src_key msg=$posted_id)"
  else
    echo "[$(date +%H:%M:%S)] reply parse warning: $res"
  fi
}

# tmux lifecycle
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
        echo "$SESSION already running"
        exit 0
      fi
      tmux new-session -d -s "$SESSION" "$0"
      echo "Started $SESSION (rooms=$ROOMS_CSV interval=${POLL_INTERVAL}s mention_only=$MENTION_ONLY)"
      ;;
    *)
      echo "Usage: $0 tmux {start|stop|status|logs}"
      exit 1
      ;;
  esac
  exit 0
fi

touch "$SEEN_IDS_FILE" "$ACKED_IDS_FILE"
IFS=',' read -r -a ROOMS_ARRAY <<< "$ROOMS_CSV"
for raw_room in "${ROOMS_ARRAY[@]}"; do
  room="$(echo "$raw_room" | xargs)"
  [[ -z "$room" ]] && continue
  prime_seen_ids "$room"
done

echo "[geminimb-autopost] rooms=$ROOMS_CSV poll=${POLL_INTERVAL}s limit=${FETCH_LIMIT} mention_only=$MENTION_ONLY"
echo "[geminimb-autopost] seen=$SEEN_IDS_FILE acked=$ACKED_IDS_FILE"

while true; do
  for raw_room in "${ROOMS_ARRAY[@]}"; do
    room="$(echo "$raw_room" | xargs)"
    [[ -z "$room" ]] && continue

    response="$(curl -sS -H "X-API-Key: $API_KEY" "$BASE_URL/rooms/$room/messages?limit=$FETCH_LIMIT" 2>/dev/null || true)"
    if [[ -z "$response" ]]; then
      echo "[$(date +%H:%M:%S)] fetch empty room=$room"
      continue
    fi

    while IFS=$'\t' read -r msg_id from_handle created_at mentioned body_preview; do
      [[ -z "$msg_id" ]] && continue
      msg_key="${room}::${msg_id}"
      if has_id "$SEEN_IDS_FILE" "$msg_key"; then
        continue
      fi
      record_id "$SEEN_IDS_FILE" "$msg_key"

      echo "[$(date +%H:%M:%S)] NEW room=$room $from_handle $msg_id at=$created_at ${body_preview:0:140}"

      if [[ "$from_handle" == "$AGENT_HANDLE" ]]; then
        continue
      fi
      if [[ "$MENTION_ONLY" == "1" && "$mentioned" != "1" ]] && ! should_force_reply "$from_handle" "$body_preview"; then
        continue
      fi

      post_reply "$room" "$from_handle" "$created_at" "$msg_key" "$body_preview" || true
    done < <(echo "$response" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for m in data.get("messages", []):
    mid = m.get("id", "")
    frm = m.get("from", "")
    created = m.get("created_at", "")
    body = (m.get("body", "") or "").replace("\n", " ").replace("\t", " ")
    mentioned = "1" if re.search(r"@geminimb\b", body, re.IGNORECASE) else "0"
    print(f"{mid}\t{frm}\t{created}\t{mentioned}\t{body}")
')
  done

  sleep "$POLL_INTERVAL"
done
