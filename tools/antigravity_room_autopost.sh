#!/usr/bin/env bash
# antigravity_room_autopost.sh
# Automatic room responder for @antigravity.
# Responds to new room messages (mention-only by default).
#
# Usage:
#   ./tools/antigravity_room_autopost.sh
#   ./tools/antigravity_room_autopost.sh tmux
#   ./tools/antigravity_room_autopost.sh tmux stop
#   ./tools/antigravity_room_autopost.sh tmux status
#   ./tools/antigravity_room_autopost.sh tmux logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

API_KEY="$(grep "^ANTIGRAVITY_API_KEY=" "$ENV_FILE" | head -n1 | cut -d= -f2-)"
if [[ -z "${API_KEY:-}" ]]; then
  echo "ANTIGRAVITY_API_KEY is missing in $ENV_FILE"
  exit 1
fi

BASE_URL="https://antfarm.world/api/v1"
ROOMS_CSV="${ROOMS:-feature-admin-planning}"
POLL_INTERVAL="${POLL_INTERVAL:-8}"
FETCH_LIMIT="${FETCH_LIMIT:-30}"
SESSION="${SESSION:-antigravity-room-autopost}"
AGENT_HANDLE="@antigravity"
MENTION_ONLY="${MENTION_ONLY:-0}"   # 0 = inspect every room message; reply logic still applies
RESPOND_TO_HANDLE="${RESPOND_TO_HANDLE:-petrus}"
SOURCE_TAG="${SOURCE_TAG:-[ag-codex][tmux-ok]}"
SEEN_MAX="${SEEN_MAX:-500}"
PRIME_ON_START="${PRIME_ON_START:-0}"   # 1 = seed current room messages as seen on cold start
SMART_MODE="${SMART_MODE:-1}"           # 1 = use codex exec for real responses when possible
CODEX_WORKDIR="${CODEX_WORKDIR:-/Users/petrus/AndroidStudioProjects/ThinkOff}"
SMART_TIMEOUT_SEC="${SMART_TIMEOUT_SEC:-75}"
CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"
CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-workspace-write}"
MAX_REPLY_AGE_SEC="${MAX_REPLY_AGE_SEC:-900}"   # skip replying to stale backlog messages
SKIP_PRESTART_BACKLOG="${SKIP_PRESTART_BACKLOG:-1}"  # 1 = do not reply to messages older than process start
START_EPOCH="$(date +%s)"

SEEN_IDS_FILE="/tmp/antigravity_room_autopost_seen_ids.txt"
ACKED_IDS_FILE="/tmp/antigravity_room_autopost_acked_ids.txt"
LOCK_FILE="/tmp/antigravity_room_autopost.pid"

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
  response="$(curl -sS -H "Authorization: Bearer $API_KEY" "$BASE_URL/rooms/$room/messages?limit=50" 2>/dev/null || true)"
  [[ -z "$response" ]] && return 0
  echo "$response" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin, strict=False)
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

  if [[ "$lc" == *"do you hear me"* ]]; then
    if [[ "$lag_sec" =~ ^[0-9]+$ ]] && [[ "$lag_sec" -ge 0 ]]; then
      echo "@${from_handle#@} ${SOURCE_TAG} yes, hearing you. ${lag_sec}s from your message. path=tmux poller."
    else
      echo "@${from_handle#@} ${SOURCE_TAG} yes, hearing you. path=tmux poller."
    fi
    return 0
  fi
  if [[ "$lc" == *"webhook and/or tmux"* ]]; then
    echo "@${from_handle#@} ${SOURCE_TAG} path=tmux poller on this runtime."
    return 0
  fi

  # For direct owner task requests, only send canned ack when SMART_MODE is off.
  # In SMART_MODE, let build_smart_reply generate the actual response.
  if should_force_reply "$from_handle" "$body"; then
    if [[ "$SMART_MODE" != "1" ]] && [[ "$lc" != *"do you hear me"* && "$lc" != *"post time in seconds"* && "$lc" != *"report time in seconds"* && "$lc" != *"webhook and/or tmux"* && "$lc" != *"2/6"* ]]; then
      echo "@${from_handle#@} ${SOURCE_TAG} starting now (poller ack)."
      return 0
    fi
  fi

  # For normal conversation, avoid placeholder acknowledgements.
  # A human/manual response will be posted by codex when action is taken.
  echo ""
}

is_low_value_bot_ack() {
  local from_handle="$1"
  local body="$2"
  local lc
  lc="$(printf "%s" "$body" | tr '[:upper:]' '[:lower:]')"
  # Ignore common canned poller chatter to avoid ack loops.
  if [[ "$lc" == *"[tmux-ok]"* ]]; then
    return 0
  fi
  if [[ "$lc" == *"starting now"* && "$lc" == *"report back with results"* ]]; then
    return 0
  fi
  if [[ "$lc" == *"starting now (poller ack)"* ]]; then
    return 0
  fi
  # Ignore very short bot pings unless explicitly aimed at us.
  if [[ "$from_handle" == @* ]] && [[ ${#lc} -lt 48 ]] && [[ "$lc" != *"@antigravity"* ]] && [[ "$lc" != *"codex"* ]]; then
    return 0
  fi
  return 1
}

build_smart_reply() {
  local room="$1"
  local from_handle="$2"
  local body="$3"

  if [[ "$SMART_MODE" != "1" ]]; then
    echo ""
    return 0
  fi
  if ! command -v codex >/dev/null 2>&1; then
    echo ""
    return 0
  fi
  if is_low_value_bot_ack "$from_handle" "$body"; then
    echo ""
    return 0
  fi

  local out_file="/tmp/antigravity_codex_reply_last.txt"
  local prompt_file="/tmp/antigravity_codex_reply_prompt.txt"
  cat > "$prompt_file" <<EOF
You are @antigravity in a multi-agent engineering room.
Write one concise, concrete reply to the latest message.
If no reply is needed, output exactly: NO_REPLY

Rules:
- Be specific and actionable.
- Do not claim work is done unless explicitly stated in message.
- Avoid generic acknowledgements.
- Keep response under 110 words.

Room: $room
From: $from_handle
Message:
$body
EOF

  if ! python3 - <<'PY' "$prompt_file" "$out_file" "$CODEX_WORKDIR" "$SMART_TIMEOUT_SEC" "$CODEX_APPROVAL_POLICY" "$CODEX_SANDBOX_MODE" >/tmp/antigravity_codex_exec.log 2>&1
import subprocess, sys
prompt_file, out_file, workdir, timeout_s, approval_policy, sandbox_mode = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6]
prompt = open(prompt_file, "r", encoding="utf-8").read()
subprocess.run(
    ["codex", "exec", "--ephemeral", "-C", workdir, "-a", approval_policy, "-s", sandbox_mode, "--output-last-message", out_file, prompt],
    check=True,
    timeout=timeout_s,
)
PY
  then
    echo ""
    return 0
  fi

  local reply
  reply="$(tr '\n' ' ' < "$out_file" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
  if [[ -z "$reply" ]]; then
    echo ""
    return 0
  fi
  if [[ "$reply" == "NO_REPLY" ]]; then
    echo ""
    return 0
  fi
  echo "@${from_handle#@} [ag-codex] ${reply:0:900}"
}

build_force_fallback_reply() {
  local from_handle="$1"
  local body="$2"
  local lc
  lc="$(printf "%s" "$body" | tr '[:upper:]' '[:lower:]')"
  if ! should_force_reply "$from_handle" "$body"; then
    echo ""
    return 0
  fi
  if [[ "$lc" == *"stay up"* || "$lc" == *"off screen"* || "$lc" == *"keep polling"* || "$lc" == *"not responding"* ]]; then
    echo "@${from_handle#@} [ag-codex] applied. I am live in tmux poll mode and will keep polling every ${POLL_INTERVAL}s. I will post concrete action updates, not only ack."
    return 0
  fi
  echo "@${from_handle#@} [ag-codex] on it. Running this now and posting a concrete update shortly."
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

epoch_from_iso() {
  local ts="$1"
  python3 - "$ts" <<'PY'
import datetime, sys
ts = sys.argv[1]
try:
    dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    print(int(dt.timestamp()))
except Exception:
    print(-1)
PY
}

should_force_reply() {
  local from_handle="$1"
  local body="$2"
  local lc
  lc="$(printf "%s" "$body" | tr '[:upper:]' '[:lower:]')"
  if [[ "$from_handle" != "$RESPOND_TO_HANDLE" && "$from_handle" != "@$RESPOND_TO_HANDLE" ]]; then
    return 1
  fi
  if [[ "$lc" == *"do you hear me"* || "$lc" == *"report time in seconds"* || "$lc" == *"post time in seconds"* || "$lc" == *"webhook and/or tmux"* || "$lc" == *"2/6"* ]]; then
    return 0
  fi
  # If clearly addressed to another agent only, do not force.
  if [[ "$lc" == *"@claudemm"* || "$lc" == *"@geminimb"* || "$lc" == *" claudemm"* || "$lc" == *" geminimb"* ]]; then
    if [[ "$lc" != *"@antigravity"* && "$lc" != *"codex"* && "$lc" != *"all of you"* ]]; then
      return 1
    fi
  fi
  # Direct task requests aimed at antigravity/codex or the whole room.
  if [[ "$lc" == *"@antigravity"* || "$lc" == *"codex"* || "$lc" == *"all of you"* ]]; then
    if [[ "$lc" == *"can you"* || "$lc" == *"please"* || "$lc" == *"need to"* || "$lc" == *"check"* || "$lc" == *"fix"* || "$lc" == *"review"* || "$lc" == *"update"* || "$lc" == *"respond"* || "$lc" == *"deploy"* || "$lc" == *"test"* || "$lc" == *"repo files good"* || "$lc" == *"are the repo files good"* ]]; then
      return 0
    fi
  fi
  # Owner question-style follow-ups should also get a short start-ack.
  if [[ "$lc" == *"?"* ]]; then
    return 0
  fi
  # Owner imperatives commonly used in this room.
  if [[ "$lc" == *"can you"* || "$lc" == *"please"* || "$lc" == *"need to"* || "$lc" == *"check room"* || "$lc" == *"check messages"* || "$lc" == *"review repo"* || "$lc" == *"update room"* || "$lc" == *"post update"* || "$lc" == *"repo files good"* || "$lc" == *"are the repo files good"* ]]; then
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
    reply_body="$(build_smart_reply "$room" "$from_handle" "$src_body")"
  fi
  if [[ -z "$reply_body" ]]; then
    reply_body="$(build_force_fallback_reply "$from_handle" "$src_body")"
  fi
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
  posted_id="$(echo "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin, strict=False).get("id",""))' 2>/dev/null || true)"
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

# --- PID lock: prevent duplicate pollers ---
if [[ -f "$LOCK_FILE" ]]; then
  OLD_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Another antigravity poller already running (PID $OLD_PID). Exiting."
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"; exit 0' EXIT INT TERM

touch "$SEEN_IDS_FILE" "$ACKED_IDS_FILE"
IFS=',' read -r -a ROOMS_ARRAY <<< "$ROOMS_CSV"
if [[ "$PRIME_ON_START" == "1" ]] && [[ ! -s "$SEEN_IDS_FILE" ]]; then
  for raw_room in "${ROOMS_ARRAY[@]}"; do
    room="$(echo "$raw_room" | xargs)"
    [[ -z "$room" ]] && continue
    prime_seen_ids "$room"
  done
  echo "[antigravity-autopost] primed seen ids on cold start"
fi

echo "[antigravity-autopost] rooms=$ROOMS_CSV poll=${POLL_INTERVAL}s limit=${FETCH_LIMIT} mention_only=$MENTION_ONLY"
echo "[antigravity-autopost] seen=$SEEN_IDS_FILE acked=$ACKED_IDS_FILE"

while true; do
  for raw_room in "${ROOMS_ARRAY[@]}"; do
    room="$(echo "$raw_room" | xargs)"
    [[ -z "$room" ]] && continue

    response="$(curl -sS -H "Authorization: Bearer $API_KEY" "$BASE_URL/rooms/$room/messages?limit=$FETCH_LIMIT" 2>/dev/null || true)"
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
      if [[ "$SKIP_PRESTART_BACKLOG" == "1" ]]; then
        msg_epoch="$(epoch_from_iso "$created_at")"
        if [[ "$msg_epoch" =~ ^[0-9]+$ ]] && [[ "$msg_epoch" -gt 0 ]] && [[ "$msg_epoch" -lt "$START_EPOCH" ]]; then
          echo "[$(date +%H:%M:%S)] SKIP prestart room=$room msg=$msg_id"
          continue
        fi
      fi
      msg_age_sec="$(seconds_since_iso "$created_at")"
      if [[ "$msg_age_sec" =~ ^[0-9]+$ ]] && [[ "$msg_age_sec" -gt "$MAX_REPLY_AGE_SEC" ]]; then
        echo "[$(date +%H:%M:%S)] SKIP stale room=$room msg=$msg_id age=${msg_age_sec}s"
        continue
      fi
      if [[ "$MENTION_ONLY" == "1" && "$mentioned" != "1" ]] && ! should_force_reply "$from_handle" "$body_preview"; then
        continue
      fi

      post_reply "$room" "$from_handle" "$created_at" "$msg_key" "$body_preview" || true
    done < <(echo "$response" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin, strict=False)
except Exception:
    sys.exit(0)
for m in data.get("messages", []):
    mid = m.get("id", "")
    frm = m.get("from", "")
    created = m.get("created_at", "")
    body = (m.get("body", "") or "").replace("\n", " ").replace("\t", " ")
    mentioned = "1" if re.search(r"@antigravity\b", body, re.IGNORECASE) else "0"
    print(f"{mid}\t{frm}\t{created}\t{mentioned}\t{body}")
')
  done

  sleep "$POLL_INTERVAL"
done
