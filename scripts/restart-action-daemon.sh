#!/bin/bash
# Restart the MacBook IAK action daemon (:8788) so it loads the latest code,
# i.e. the action-gate deploy button (branch feat/daemon-actions-room-react:
# /actions/request + executeDeploySite for avai/clarity/codewatch-web).
#
# RUN BY PETRUS to ARM the deploy button. ClaudeMB is harness-blocked from
# starting the daemon itself (running the vercel --prod executor = self-grant),
# so this stays the human/executor lane's step. It only restarts the daemon;
# it never deploys.
#
# Targets ONLY the repo daemon (config .../ide-agent-kit/ide-agent-kit.json on
# :8788). It does NOT touch the CodeWatch Helper daemon (:8789, different config
# path), so phone approvals for petrus-home keep working.
#
# Usage:  bash scripts/restart-action-daemon.sh
set -e
IAK="/Users/petrus/ide-agent-kit"
NODE="/opt/homebrew/bin/node"

echo "[restart-action-daemon] stopping old :8788 action daemon (and its wrapper)…"
pkill -f 'ide-agent-kit/ide-agent-kit.json' 2>/dev/null || true
sleep 1

echo "[restart-action-daemon] starting new daemon with the latest code…"
cd "$IAK"
nohup "$NODE" bin/iak-mcp-daemon.mjs --config ide-agent-kit.json >/tmp/iak-actiongate.log 2>&1 &
sleep 2

code=$(curl -s --max-time 5 http://127.0.0.1:8788/intents -o /dev/null -w '%{http_code}' 2>/dev/null || echo "000")
echo "[restart-action-daemon] daemon HTTP $code on :8788 (200 = up)"
# Prove the new /actions endpoint exists (404 on a bogus nonce = route present;
# a hard connection error / 'not found' from the OLD daemon means code not loaded).
probe=$(curl -s --max-time 5 http://127.0.0.1:8788/actions/__probe__ -w ' [%{http_code}]' 2>/dev/null || echo "ERR")
echo "[restart-action-daemon] GET /actions/__probe__ -> $probe  (expected {\"ok\":false,\"error\":\"unknown action nonce\"} [404])"
echo "[restart-action-daemon] done. log: /tmp/iak-actiongate.log"
echo "Next: ClaudeMB runs  node scripts/action-request.mjs deploy_site --project avai --dry-run  then you tap Approve in CodeWatch."
