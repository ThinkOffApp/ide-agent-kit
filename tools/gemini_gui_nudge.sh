#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${IAK_GEMINI_APP_NAME:-Claude}"
PROMPT_TEXT="${IAK_NUDGE_TEXT:-check room and respond if there is something you should comment on}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found" >&2
  exit 1
fi

osascript - "$APP_NAME" "$PROMPT_TEXT" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    keystroke promptText
    key code 36
  end tell
end run
APPLESCRIPT
