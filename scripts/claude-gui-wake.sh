#!/usr/bin/env bash

# Never type over the human (petrus 2026-07-13: "tmux should not write if i
# am writing!"). Skip this nudge cycle unless the machine is human-idle.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# WAIT for an idle window rather than skipping: by the time this script runs
# the poller has marked the message seen, so skipping would consume it
# undelivered. Exit 1 on timeout so the caller's failure path applies.
if ! "$REPO_ROOT/tools/human-idle-guard.sh" --wait 300; then
    echo "nudge aborted: human continuously active" >&2
    exit 1
fi

# claude-gui-wake.sh — wake Claude Code desktop app via osascript
# Requires: Accessibility permission for /Applications/Claude.app
set -euo pipefail
MSG="${1:-check rooms}"
LOCK="/tmp/claude-gui-wake.lock"
LOG="${CLAUDE_GUI_WAKE_LOG:-/tmp/claude-gui-wake.log}"
NUDGE="${NUDGE_SCRIPT:-$(dirname "$0")/../tools/gemini_gui_nudge.sh}"
mkdir "$LOCK" 2>/dev/null || exit 0
trap "rmdir \"$LOCK\"" EXIT
# Exit contract (#30 gate, medium): a failed nudge must exit non-zero so the
# poller's ack-after-success retry applies - the old version logged 'failed'
# and exited 0, silently consuming the wake.
rc=0
{ printf "[%s] wake: %s\n" "$(date -u +%FT%TZ)" "$MSG"
  if IAK_NUDGE_TEXT="$MSG" "$NUDGE" 2>&1; then
    printf "[%s] sent\n" "$(date -u +%FT%TZ)"
  else
    rc=1
    printf "[%s] NOT DELIVERED (human active or focus failure) - caller retries\n" "$(date -u +%FT%TZ)"
  fi
} >> "$LOG" 2>&1
exit "$rc"
