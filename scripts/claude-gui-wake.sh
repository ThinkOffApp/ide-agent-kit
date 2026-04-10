#!/usr/bin/env bash
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
