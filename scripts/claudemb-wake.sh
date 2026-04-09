#!/usr/bin/env bash
# ClaudeMB wake-up script
# Sends a nudge keystroke into the Claude Code tmux session so it triggers
# the UserPromptSubmit hook and reads new room messages.

set -euo pipefail

WAKE_SESSION="${CLAUDEMB_SESSION:-claude}"
MSG="${1:-check rooms}"
LOCK="/tmp/claudemb_wake.lock"
LOG_FILE="${CLAUDEMB_WAKE_LOG:-/tmp/claudemb_wake.log}"

# Simple lock using mkdir (atomic on all systems)
if ! mkdir "$LOCK" 2>/dev/null; then
  # Lock exists, exit quietly
  exit 0
fi
trap "rmdir \"$LOCK\"" EXIT

if ! tmux has-session -t "$WAKE_SESSION" 2>/dev/null; then
  printf "[%s] wake failed: tmux session '%s' not found\n" "$(date -u +%FT%TZ)" "$WAKE_SESSION" >> "$LOG_FILE"
  exit 1
fi

{
  printf "[%s] wake: sending nudge to tmux session '%s': %s\n" "$(date -u +%FT%TZ)" "$WAKE_SESSION" "$MSG"
  tmux send-keys -t "$WAKE_SESSION" -l "$MSG"
  sleep 0.3
  tmux send-keys -t "$WAKE_SESSION" Enter
  printf "[%s] wake: nudge sent\n" "$(date -u +%FT%TZ)"
} >> "$LOG_FILE" 2>&1
