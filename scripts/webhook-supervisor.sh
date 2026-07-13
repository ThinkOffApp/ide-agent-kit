#!/usr/bin/env bash
# webhook-supervisor.sh — keep the @claudeMB webhook wake alive + self-healing.
#
# The cloudflared quick-tunnel URL is ephemeral (changes on restart/reboot), so
# a static registration rots. This supervisor owns the whole chain: it runs the
# local receiver, runs cloudflared, extracts the public URL, registers it with
# the platform (PUT /agents/me/webhook), and then every INTERVAL seconds checks
# that cloudflared is alive and the URL is unchanged — re-registering on any
# change and restarting cloudflared if it died. Run under launchd for reboot
# survival; the loop itself handles tunnel churn.
set -u

SECRET_FILE="$HOME/.iak-webhook-wake-secret"
CONFIG="$HOME/ide-agent-kit/config/macbook.json"
RECEIVER="$HOME/ide-agent-kit/scripts/webhook-wake.mjs"
PORT=8790
INTERVAL=60
CF_LOG=/tmp/cloudflared-webhook.log
LOG=/tmp/webhook-supervisor.log

log(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

[ -s "$SECRET_FILE" ] || { head -c 999 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 32 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
SECRET=$(cat "$SECRET_FILE")
KEY=$(python3 -c "import json;print(json.load(open('$CONFIG'))['poller']['api_key'])")

start_receiver(){ pgrep -f "webhook-wake.mjs" >/dev/null || { WEBHOOK_WAKE_SECRET="$SECRET" /usr/local/bin/node "$RECEIVER" >>/tmp/webhook-wake.log 2>&1 & log "receiver started"; }; }

start_tunnel(){ pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null; sleep 1; : > "$CF_LOG"; /opt/homebrew/bin/cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >>"$CF_LOG" 2>&1 & log "cloudflared started"; }

get_url(){ for i in $(seq 1 20); do u=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | head -1); [ -n "$u" ] && { echo "$u"; return; }; sleep 2; done; }

register(){ local hook="$1/hook/$SECRET"; python3 -c "
import urllib.request,json,sys
req=urllib.request.Request('https://antfarm.world/api/v1/agents/me/webhook',data=json.dumps({'webhook_url':sys.argv[1]}).encode(),method='PUT')
req.add_header('X-API-Key',sys.argv[2]);req.add_header('Content-Type','application/json')
print(urllib.request.urlopen(req,timeout=15).status)
" "$hook" "$KEY" 2>&1; }

log "supervisor start"
start_receiver
start_tunnel
URL=$(get_url); [ -z "$URL" ] && { log "no tunnel url; retrying next loop"; }
[ -n "$URL" ] && { r=$(register "$URL"); log "registered $URL (http $r)"; }

while true; do
  sleep "$INTERVAL"
  start_receiver
  if ! pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" >/dev/null; then
    log "cloudflared died; restarting"; start_tunnel; NEW=$(get_url)
    [ -n "$NEW" ] && { URL="$NEW"; r=$(register "$URL"); log "re-registered after restart $URL (http $r)"; }
    continue
  fi
  NEW=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | tail -1)
  if [ -n "$NEW" ] && [ "$NEW" != "$URL" ]; then
    URL="$NEW"; r=$(register "$URL"); log "url changed -> re-registered $URL (http $r)"
  fi
done
