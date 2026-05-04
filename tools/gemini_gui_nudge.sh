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
  -- v0.8.3 — verify-BEFORE-keystroke loop. Previous version did
  -- set-frontmost+keystroke in one block, then logged a warning if
  -- frontmost disagreed AFTER. But by then the keystroke had already
  -- gone to the wrong app. petrus saw silent wake drops because of
  -- this. New: ACTIVATE → SET FRONTMOST → VERIFY → keystroke. Bail
  -- without typing if we can't make target frontmost in 5 tries.
  do shell script "open -a " & quoted form of appName
  delay 0.3

  set focusOk to false
  set focusAttempts to 0
  repeat while focusAttempts < 15
    try
      tell application "System Events"
        tell process appName
          set frontmost to true
        end tell
      end tell
    end try
    delay 0.5
    try
      tell application "System Events"
        set checkFront to name of first application process whose frontmost is true
      end tell
      if checkFront is appName then
        set focusOk to true
        exit repeat
      end if
    end try
    set focusAttempts to focusAttempts + 1
  end repeat

  if not focusOk then
    log "gui_nudge: ABORT — could not bring " & appName & " to front after 15 attempts"
    return
  end if

  try
    tell application "System Events"
      tell process appName
        keystroke promptText
      end tell
    end tell
    delay 0.25
    -- Re-verify focus before pressing Enter to avoid wrong-app trigger.
    try
      tell application "System Events"
        set midFront to name of first application process whose frontmost is true
      end tell
      if midFront is not appName then
        log "gui_nudge: WARN — focus left " & appName & " mid-keystroke (now " & midFront & "); skipping Enter"
      else
        tell application "System Events"
          tell process appName
            key code 36
          end tell
        end tell
      end if
    end try
  on error errMsg number errNum
    log "gui_nudge: keystroke failed — " & errNum & " " & errMsg
    if errNum is 1002 then
      log "gui_nudge: HINT — accessibility permission revoked. Re-grant in System Settings → Privacy & Security → Accessibility."
    end if
  end try
end run
APPLESCRIPT
