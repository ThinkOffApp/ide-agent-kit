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
  -- v0.8.3 — verify-BEFORE-keystroke loop. See claudemb-wake.sh for
  -- the rationale. tl;dr: post-hoc warning was useless because the
  -- wrong-app keystroke had already happened. Now we abort without
  -- typing if we can't make the target frontmost.
  tell application appName to activate
  delay 0.3

  set focusOk to false
  set focusAttempts to 0
  repeat while focusAttempts < 5
    try
      tell application "System Events"
        tell process appName
          set frontmost to true
        end tell
      end tell
    end try
    delay 0.2
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
    log "gui_nudge: ABORT — could not bring " & appName & " to front after 5 attempts"
    return
  end if

  try
    tell application "System Events"
      tell process appName
        keystroke promptText
      end tell
    end tell
    delay 0.25
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
