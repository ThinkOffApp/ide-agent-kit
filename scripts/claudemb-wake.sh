#!/usr/bin/env bash
# ClaudeMB wake-up script
# Uses osascript to send a nudge into the Claude Code desktop app
# then restores focus to the previously active app (no focus steal).

set -euo pipefail

APP_NAME="${CLAUDEMB_APP_NAME:-Claude}"
MSG="${1:-check rooms}"
LOCK="/tmp/claudemb_wake.lock"
LOG_FILE="${CLAUDEMB_WAKE_LOG:-/tmp/claudemb_wake.log}"

# Simple lock using mkdir (atomic on all systems)
if ! mkdir "$LOCK" 2>/dev/null; then
  # Lock exists, exit quietly
  exit 0
fi
trap "rmdir \"$LOCK\"" EXIT

# Check if the app is running
if ! pgrep -xq "$APP_NAME"; then
  printf "[%s] wake failed: '%s' app not running\n" "$(date -u +%FT%TZ)" "$APP_NAME" >> "$LOG_FILE"
  exit 1
fi

{
  printf "[%s] wake: sending nudge to '%s' app (no focus steal): %s\n" "$(date -u +%FT%TZ)" "$APP_NAME" "$MSG"
  osascript - "$APP_NAME" "$MSG" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv

  -- Remember which app has focus
  tell application "System Events"
    set frontApp to name of first application process whose frontmost is true
  end tell

  -- Briefly activate Claude, send nudge
  tell application appName to activate
  delay 0.3
  tell application "System Events"
    keystroke promptText
    key code 36
  end tell
  delay 0.2

  -- Restore focus to the previous app
  tell application frontApp to activate
end run
APPLESCRIPT
  printf "[%s] wake: nudge sent, focus restored\n" "$(date -u +%FT%TZ)"
} >> "$LOG_FILE" 2>&1
