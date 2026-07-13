#!/usr/bin/env bash
# Keep a dedicated GroupMind webhook registered for the @codexmb identity and
# wake the Codex desktop app immediately for Petrus messages or Codex mentions.
set -u

SECRET_FILE="$HOME/.iak-codex-webhook-secret"
# Key lives in a private dot-directory (chmod 600), path overridable via env.
# Never point this at a location inside a public repo's working tree.
KEY_FILE="${IAK_CODEX_KEY_FILE:-$HOME/.iak/codexmb_api_key.txt}"

# Single-instance guard: a second supervisor fights the first over the tunnel
# (kills its cloudflared, re-registers a different URL - claudemm review of
# IAK PR #28). Exit if another copy is already running.
for pid in $(pgrep -f "codex-webhook-supervisor.sh" 2>/dev/null); do
  if [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ]; then
    echo "another supervisor (pid $pid) is already running; exiting" >&2
    exit 0
  fi
done
RECEIVER="$HOME/ide-agent-kit/scripts/webhook-wake.mjs"
WAKE="$HOME/ide-agent-kit/tools/codex_gui_nudge.sh"
PORT=8791
INTERVAL=30
CF_LOG=/tmp/codex-cloudflared-webhook.log
LOG=/tmp/codex-webhook-supervisor.log

log(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

[ -s "$KEY_FILE" ] || { log "missing API key file: $KEY_FILE"; exit 2; }
[ -s "$SECRET_FILE" ] || { head -c 999 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 32 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
SECRET=$(cat "$SECRET_FILE")
KEY=$(tr -d '\n' < "$KEY_FILE")

receiver_running(){ lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -q node; }
start_receiver(){
  receiver_running || {
    WEBHOOK_WAKE_SECRET="$SECRET" \
    WEBHOOK_WAKE_PORT="$PORT" \
    WEBHOOK_WAKE_SCRIPT="$WAKE" \
    WEBHOOK_WAKE_SELF="@codexmb" \
    WEBHOOK_WAKE_OWNER="petrus" \
    WEBHOOK_WAKE_MENTIONS="@codex,@codexmb" \
    WEBHOOK_WAKE_LOG="/tmp/codex-webhook-wake.log" \
    IAK_CODEX_APP_NAME="ChatGPT" \
    IAK_NUDGE_TEXT="check rooms [codex]" \
      /usr/local/bin/node "$RECEIVER" >>/tmp/codex-webhook-wake.log 2>&1 &
    log "receiver started"
  }
}

start_tunnel(){
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null || true
  sleep 1
  : > "$CF_LOG"
  /opt/homebrew/bin/cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >>"$CF_LOG" 2>&1 &
  log "cloudflared started"
}

get_url(){
  local u
  for _ in $(seq 1 20); do
    u=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | head -1)
    [ -n "$u" ] && { echo "$u"; return; }
    sleep 2
  done
}

register(){
  local hook="$1/hook/$SECRET"
  python3 -c "
import urllib.request,json,sys
req=urllib.request.Request('https://groupmind.one/api/v1/agents/me/webhook', data=json.dumps({'webhook_url':sys.argv[1]}).encode(), method='PUT')
req.add_header('X-API-Key', sys.argv[2])
req.add_header('Content-Type', 'application/json')
print(urllib.request.urlopen(req, timeout=15).status)
" "$hook" "$KEY" 2>&1
}

log "supervisor start"
start_receiver
start_tunnel
URL=$(get_url)
[ -z "$URL" ] && log "no tunnel URL; retrying next loop"
[ -n "$URL" ] && { result=$(register "$URL"); log "registered $URL (http $result)"; }

# Jul 13 2026: quick tunnels can flap for days while the process stays alive
# (proven Jul 9-12: webhook events silently stopped, nothing re-registered).
# Belt and braces: force a tunnel restart when the log shows sustained retry
# errors, and re-register the current URL every REREGISTER_EVERY loops
# (the PUT is idempotent).
REREGISTER_EVERY="${REREGISTER_EVERY:-30}"
LOOPS=0
while true; do
  sleep "$INTERVAL"
  start_receiver
  if ! pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" >/dev/null; then
    log "cloudflared died; restarting"
    start_tunnel
    NEW=$(get_url)
    [ -n "$NEW" ] && { URL="$NEW"; result=$(register "$URL"); log "re-registered after restart $URL (http $result)"; }
    continue
  fi
  if tail -5 "$CF_LOG" 2>/dev/null | grep -q "Retrying connection"; then
    log "tunnel flapping (Retrying connection); forcing restart"
    start_tunnel
    NEW=$(get_url)
    [ -n "$NEW" ] && { URL="$NEW"; result=$(register "$URL"); log "re-registered after flap $URL (http $result)"; }
    continue
  fi
  NEW=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | tail -1)
  if [ -n "$NEW" ] && [ "$NEW" != "$URL" ]; then
    URL="$NEW"
    result=$(register "$URL")
    log "URL changed; re-registered $URL (http $result)"
  fi
  LOOPS=$((LOOPS + 1))
  if [ "$LOOPS" -ge "$REREGISTER_EVERY" ] && [ -n "$URL" ]; then
    LOOPS=0
    result=$(register "$URL")
    log "periodic re-register $URL (http $result)"
  fi
done
