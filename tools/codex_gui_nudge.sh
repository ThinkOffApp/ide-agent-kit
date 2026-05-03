#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${IAK_CODEX_APP_NAME:-Codex}"
PROMPT_TEXT="${IAK_NUDGE_TEXT:-check room and respond [codex]}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found" >&2
  exit 1
fi

osascript - "$APP_NAME" "$PROMPT_TEXT" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv

  -- v0.7.3 — process-targeted keystroke (matches scripts/claudemb-wake.sh
  -- and tools/gemini_gui_nudge.sh). The old System Events.keystroke routes
  -- to whichever process is frontmost at execution time and silently lands
  -- in the wrong app if focus contention beats the activation delay.
  tell application appName to activate
  delay 0.3
  try
    tell application "System Events"
      tell process appName
        set frontmost to true
        keystroke promptText
      end tell
    end tell
    delay 0.25
    tell application "System Events"
      tell process appName
        key code 36
      end tell
    end tell
  on error errMsg number errNum
    log "gui_nudge: keystroke failed — " & errNum & " " & errMsg
  end try
end run
APPLESCRIPT
