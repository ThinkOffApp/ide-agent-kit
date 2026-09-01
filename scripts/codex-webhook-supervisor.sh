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
# The room poller's heartbeat (poller.heartbeat_file in the IAK config). The
# nudge refuses to type while it is stale, and the health alert below posts
# once when it goes stale and once when it returns (issue #86).
POLLER_HEARTBEAT="${IAK_POLLER_HEARTBEAT:-/tmp/iak-poller.heartbeat}"
POLLER_ERR_LOG="${IAK_POLLER_ERR_LOG:-/tmp/codexmb.poller.err}"
HEALTH_ALERT="$HOME/ide-agent-kit/scripts/poller-health-alert.mjs"

log(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

[ -s "$KEY_FILE" ] || { log "missing API key file: $KEY_FILE"; exit 2; }
[ -s "$SECRET_FILE" ] || { head -c 999 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 32 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
SECRET=$(cat "$SECRET_FILE")
KEY=$(tr -d '\n' < "$KEY_FILE")

# Match OUR receiver specifically, not any node process that happens to be
# listening on the port (codex review of IAK PR #28).
receiver_running(){
  local pid
  for pid in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -q "webhook-wake.mjs"; then
      return 0
    fi
  done
  return 1
}
start_receiver(){
  receiver_running || {
    # NODE_BIN must be resolved on its own line: if it sits at the end of the
    # env-assignment chain, the whole chain becomes an assignment-only
    # statement and node launches with NO env (receiver exits on missing
    # WEBHOOK_WAKE_SECRET, crash-looping every cycle).
    NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
    WEBHOOK_WAKE_SECRET="$SECRET" \
    WEBHOOK_WAKE_PORT="$PORT" \
    WEBHOOK_WAKE_SCRIPT="$WAKE" \
    WEBHOOK_WAKE_SELF="@codexmb" \
    WEBHOOK_WAKE_OWNER="petrus" \
    WEBHOOK_WAKE_MENTIONS="@codex,@codexmb" \
    WEBHOOK_WAKE_LOG="/tmp/codex-webhook-wake.log" \
    IAK_CODEX_APP_NAME="ChatGPT" \
    IAK_NUDGE_TEXT="check rooms [codex]" \
    IAK_POLLER_HEARTBEAT="$POLLER_HEARTBEAT" \
      "$NODE_BIN" "$RECEIVER" >>/tmp/codex-webhook-wake.log 2>&1 &
      sleep 1
      if kill -0 $! 2>/dev/null; then log "receiver started"; else log "receiver FAILED to start"; fi
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
  # Key travels via environment, never as a process argument visible in ps
  # (codex review of IAK PR #28).
  local hook="$1/hook/$SECRET"
  IAK_REG_KEY="$KEY" python3 -c "
import urllib.request,json,sys,os
req=urllib.request.Request('https://groupmind.one/api/v1/agents/me/webhook', data=json.dumps({'webhook_url':sys.argv[1]}).encode(), method='PUT')
req.add_header('X-API-Key', os.environ['IAK_REG_KEY'])
req.add_header('Content-Type', 'application/json')
print(urllib.request.urlopen(req, timeout=15).status)
" "$hook" 2>&1
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
poller_health(){
  [ -f "$HEALTH_ALERT" ] || return 0
  # Key via environment only (same rule as register()).
  IAK_ALERT_KEY="$KEY" IAK_POLLER_HEARTBEAT="$POLLER_HEARTBEAT" IAK_POLLER_ERR_LOG="$POLLER_ERR_LOG" \
  IAK_ALERT_LABEL="@codexmb room poller" \
    "$(command -v node || echo /usr/local/bin/node)" "$HEALTH_ALERT" >>"$LOG" 2>&1 || true
}

while true; do
  sleep "$INTERVAL"
  start_receiver
  poller_health
  if ! pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" >/dev/null; then
    log "cloudflared died; restarting"
    start_tunnel
    NEW=$(get_url)
    [ -n "$NEW" ] && { URL="$NEW"; result=$(register "$URL"); log "re-registered after restart $URL (http $result)"; }
    continue
  fi
  # Sustained flapping only: a single transient retry self-recovers and must
  # not trigger a restart + URL churn (codex review of IAK PR #28).
  if [ "$(tail -20 "$CF_LOG" 2>/dev/null | grep -c "Retrying connection")" -ge 3 ]; then
    log "tunnel flapping (3+ retries in recent log); forcing restart"
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
