#!/bin/bash
# Start all ide-agent-kit services. Used by the com.ide-agent-kit LaunchAgent
# (KeepAlive) and for manual startup.
#
# Hardened 2026-07-09 (Petrus "harden it" — the poller kept dying unsupervised
# and the fleet went silent):
#  - IDEMPOTENT: kills any prior instances first, so launchd can cleanly take
#    over running orphans without port/duplicate conflicts (start-all is not
#    idempotent by nature — plain `&` would double-start).
#  - RESTART-ON-ANY-DEATH: exits as soon as ANY one service dies, so launchd
#    KeepAlive restarts the WHOLE stack. The old `wait` only returned when ALL
#    children had exited, so a single dead poller (rooms watch → new-message
#    file → agent wakes) left everyone silently un-woken.
set -u

IAK_DIR="/Users/petrus/ide-agent-kit"
CONFIG="$IAK_DIR/config/dogfood.json"
NODE="/opt/homebrew/bin/node"
CLI="$IAK_DIR/bin/cli.mjs"

cd "$IAK_DIR"

# --- Idempotent cleanup ---------------------------------------------------
# Stop prior instances of exactly these services. NOTE: the patterns are
# specific — 'iak-mcp-daemon.mjs' does NOT match a Claude session's own
# 'iak-mcp.mjs' MCP server, so live agent sessions keep their tools.
for pat in \
  'cli.mjs serve' \
  'cli.mjs rooms watch' \
  'cli.mjs comments watch' \
  'cli.mjs discord watch' \
  'cli.mjs intent daemon' \
  'mini-vitals.sh' \
  'iak-mcp-daemon.mjs'; do
  pkill -f "$pat" 2>/dev/null || true
done
sleep 1

# --- Start each service, capturing PIDs -----------------------------------
pids=()
$NODE "$CLI" serve --config "$CONFIG" &                 pids+=($!)
$NODE "$CLI" rooms watch --config "$CONFIG" &           pids+=($!)
$NODE "$CLI" comments watch --config "$CONFIG" &        pids+=($!)
$NODE "$CLI" discord watch --config "$CONFIG" &         pids+=($!)

# Intent daemon: publishes THIS machine's device slot and the @claudemm agent
# slot, both on a 90s TTL. It was never in this script, so nothing restarted it
# after a reboot - the slots simply expired and the Mac mini vanished from
# GroupMind's Local devices and from the agent list (petrus, 2026-08-18:
# "Mini not showing in devices groupmind"). Supervised here like the rest, so a
# death now restarts the stack instead of silently un-registering the machine.
$NODE "$CLI" intent daemon --config "$CONFIG" \
  > "$IAK_DIR/logs/iak-intent-daemon.log" 2>&1 &        pids+=($!)

# Host facts for this machine's device slot. The DesktopAdapter publishes a thin
# slot on macOS, so the Mini showed almost nothing in CodeWatch's Local devices
# next to the Pi. Refreshes rather than patching once, because a frozen load
# figure under a "now" timestamp is worse than an absent one.
bash "$IAK_DIR/scripts/mini-vitals.sh" \
  > "$IAK_DIR/logs/mini-vitals.log" 2>&1 &                pids+=($!)

# Confirmations daemon: holds :8788 AND runs the chat-reply poller that routes
# room /approve /deny taps (the CodeWatch Approve/Deny buttons) to the intent
# registry + action executors. Must be iak-mcp-daemon.mjs (not iak-mcp.mjs) —
# only the daemon flavor runs the poller, without which button taps never settle.
$NODE "$IAK_DIR/bin/iak-mcp-daemon.mjs" --config "$CONFIG" \
  > "$IAK_DIR/logs/iak-confirm-daemon.log" 2>&1 &        pids+=($!)

# --- Watchdog: exit (→ launchd restarts the whole stack) if any service dies -
# bash 3.2 on macOS has no `wait -n`, so poll liveness every 5s.
while true; do
  for p in "${pids[@]}"; do
    if ! kill -0 "$p" 2>/dev/null; then
      echo "[start-all $(date -u +%FT%TZ)] service pid $p exited; restarting stack" >&2
      exit 1
    fi
  done
  sleep 5
done
