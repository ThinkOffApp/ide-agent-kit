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

  -- v0.7.2 — process-targeted keystroke (matches scripts/claudemb-wake.sh).
  --
  -- The old `tell application "System Events" to keystroke` routed to
  -- whichever process was frontmost at execution. If the target app
  -- didn't fully take focus during the activation delay, keystrokes
  -- landed in the user's actual foreground app with NO error logged.
  --
  -- Fix: bind the target via `tell process appName / set frontmost true`.
  tell application appName to activate
  delay 0.3
  try
    tell application "System Events"
      tell process appName
        set frontmost to true
        keystroke promptText
        key code 36
      end tell
    end tell
  on error errMsg number errNum
    log "gui_nudge: keystroke failed — " & errNum & " " & errMsg
  end try
end run
APPLESCRIPT
