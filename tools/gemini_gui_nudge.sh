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
  -- v0.8.2 — skip wake only when user is actively typing (text in input),
  -- not just because target app is frontmost. v0.7.5 over-fired the skip.
  set userIsTyping to false
  set promptAlreadyTyped to false
  try
    tell application "System Events"
      tell process appName
        set existingText to value of text area 1 of group 1 of window 1
        if existingText is not "" and existingText is not missing value then
          if existingText is promptText then
            set promptAlreadyTyped to true
          else
            set userIsTyping to true
          end if
        end if
      end tell
    end tell
  on error
  end try
  if promptAlreadyTyped then
    log "gui_nudge: prompt already typed - sending Enter"
    tell application "System Events"
      tell process appName
        set frontmost to true
        key code 36
      end tell
    end tell
    return
  end if
  if userIsTyping then
    log "gui_nudge: skipped — user typing in " & appName
    return
  end if
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
