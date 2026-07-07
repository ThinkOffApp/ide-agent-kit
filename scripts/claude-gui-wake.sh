#!/usr/bin/env bash
# claude-gui-wake.sh — wake Claude Code desktop app via osascript
# Requires: Accessibility permission for /Applications/Claude.app
# On failure (e.g. locked screen blocks bringing Claude to front), a detached
# retry loop re-attempts every 60s for up to 30 min — a failed nudge used to
# mean silence until the NEXT new message (2026-07-07 silent-hour incident).
set -euo pipefail
MSG="${1:-check rooms}"
LOCK="/tmp/claude-gui-wake.lock"
RETRY_LOCK="/tmp/claude-gui-wake.retry.lock"
LOG="${CLAUDE_GUI_WAKE_LOG:-/tmp/claude-gui-wake.log}"
NUDGE="${NUDGE_SCRIPT:-$(dirname "$0")/../tools/gemini_gui_nudge.sh}"
mkdir "$LOCK" 2>/dev/null || exit 0
trap "rmdir \"$LOCK\"" EXIT
{ printf "[%s] wake: %s\n" "$(date -u +%FT%TZ)" "$MSG"
  if IAK_NUDGE_TEXT="$MSG" "$NUDGE" 2>&1; then
    printf "[%s] sent\n" "$(date -u +%FT%TZ)"
  else
    printf "[%s] failed — starting 60s-interval retries (max 30)\n" "$(date -u +%FT%TZ)"
    if mkdir "$RETRY_LOCK" 2>/dev/null; then
      (
        trap "rmdir \"$RETRY_LOCK\"" EXIT
        for i in $(seq 1 30); do
          sleep 60
          if IAK_NUDGE_TEXT="$MSG" "$NUDGE" >>"$LOG" 2>&1; then
            printf "[%s] retry #%s sent\n" "$(date -u +%FT%TZ)" "$i" >>"$LOG"
            exit 0
          fi
        done
        printf "[%s] retries exhausted\n" "$(date -u +%FT%TZ)" >>"$LOG"
      ) &
      disown
    else
      printf "[%s] retry loop already active, piggybacking\n" "$(date -u +%FT%TZ)"
    fi
  fi
} >> "$LOG" 2>&1
