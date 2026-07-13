#!/usr/bin/env bash

# Never type over the human (petrus 2026-07-13: "tmux should not write if i
# am writing!"). Skip this nudge cycle unless the machine is human-idle.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! "$REPO_ROOT/tools/human-idle-guard.sh"; then
    echo "skipping nudge: human recently active" >&2
    exit 0
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
{ printf "[%s] wake: %s\n" "$(date -u +%FT%TZ)" "$MSG"
  IAK_NUDGE_TEXT="$MSG" "$NUDGE" 2>&1 && printf "[%s] sent\n" "$(date -u +%FT%TZ)" \
  || printf "[%s] failed\n" "$(date -u +%FT%TZ)"
} >> "$LOG" 2>&1
