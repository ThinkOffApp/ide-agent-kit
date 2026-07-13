#!/usr/bin/env bash

# Never type over the human (petrus 2026-07-13: "tmux should not write if i
# am writing!"). Skip this nudge cycle unless the machine is human-idle.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# WAIT for an idle window rather than skipping: by the time this script runs
# the poller has marked the message seen, so skipping would consume it
# undelivered. Exit 1 on timeout so the caller's failure path applies.
if ! "$REPO_ROOT/tools/human-idle-guard.sh" --wait 300; then
    echo "nudge aborted: human continuously active" >&2
    exit 1
fi

set -euo pipefail

APP_NAME="${IAK_GEMINI_APP_NAME:-Claude}"
PROMPT_TEXT="${IAK_NUDGE_TEXT:-check room and respond if there is something you should comment on}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found" >&2
  exit 1
fi

GUARD="$REPO_ROOT/tools/human-idle-guard.sh"

osascript - "$APP_NAME" "$PROMPT_TEXT" "$GUARD" <<'APPLESCRIPT'
-- Point-of-injection recheck (codex acceptance gate, #29 blocker 1): the
-- focus loop below burns up to 7.5s after the entry guard passed; the human
-- can return in that window. Re-verify fresh human-idle immediately before
-- the FIRST injection. Fail closed. (No recheck after our own keystrokes -
-- they reset HIDIdleTime and would always false-abort.)
on idleOk(guardPath)
  try
    do shell script "IDLE_THRESHOLD_S=5 " & quoted form of guardPath
    return true
  on error
    return false
  end try
end idleOk

on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv
  set guardPath to item 3 of argv

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
    if not idleOk(guardPath) then
      error "gui_nudge: human active at pre-Enter (prompt already typed)" number 86
    end if
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
  -- Use `open -a` first: it forces a launch + focus more reliably than
  -- AppleScript's `activate` when the app is hidden/minimized or another
  -- app is holding focus (full-screen, Mission Control, modal).
  try
    do shell script "open -a " & quoted form of appName
  end try
  tell application appName to activate
  delay 0.3

  -- Bumped 5x0.2s (1s budget) to 15x0.5s (7.5s budget). Stuck-poller
  -- incidents on 2026-05-04 traced to ABORTs that cleared on the very
  -- next nudge — the activate path needs more time when the user is
  -- across spaces or in another full-screen window.
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
    -- Throw an AppleScript error so osascript exits non-zero and the
    -- outer wake.sh can distinguish 'failed silently' from 'nudge sent'.
    -- Without this the previous code did `return`, osascript exited 0,
    -- and wake.sh logged 'nudge sent' for what was actually a no-op.
    -- Confirmed bite on 2026-05-05 (3+ hours of silent ABORTs).
    error "gui_nudge could not bring " & appName & " to front" number 100
  end if

  if not idleOk(guardPath) then
    error "gui_nudge: human active at pre-keystroke (after focus loop)" number 86
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
