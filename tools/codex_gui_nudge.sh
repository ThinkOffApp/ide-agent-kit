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

APP_NAME="${IAK_CODEX_APP_NAME:-Codex}"
PROMPT_TEXT="${IAK_NUDGE_TEXT:-check room and respond [codex]}"
LOG_FILE="${IAK_CODEX_NUDGE_LOG:-/tmp/codex_gui_nudge.log}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found" >&2
  exit 1
fi

printf '[%s] codex_gui_nudge: start app=%s text=%q\n' "$(date -u +%FT%TZ)" "$APP_NAME" "$PROMPT_TEXT" >>"$LOG_FILE"

osascript - "$APP_NAME" "$PROMPT_TEXT" "$LOG_FILE" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv
  set logFile to item 3 of argv

  my writeLog(logFile, "applescript start")

  -- Current Codex desktop no longer exposes the prompt as
  -- `text area 1 of group 1 of window 1`; AX reports zero text areas.
  -- Use a guarded click near the bottom input and paste the nudge via
  -- clipboard instead of silently "succeeding" against a stale selector.
  try
    set oldClipboard to the clipboard
  on error
    set oldClipboard to ""
  end try

  try
    tell application appName to activate
  on error errMsg number errNum
    my writeLog(logFile, "activate failed " & errNum & " " & errMsg)
    error errMsg number errNum
  end try

  delay 0.3

  set focusOk to false
  repeat with attempt from 1 to 8
    try
      tell application appName to activate
    end try
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
  end repeat

  if not focusOk then
    my writeLog(logFile, "ABORT focus failed")
    error "could not focus " & appName number 1001
  end if

  try
    tell application "System Events"
      tell process appName
        set winPos to position of window 1
        set winSize to size of window 1
        set clickX to (item 1 of winPos) + ((item 1 of winSize) / 2)
        set clickY to (item 2 of winPos) + (item 2 of winSize) - 72
        click at {clickX, clickY}
      end tell
    end tell
    delay 0.15
    set the clipboard to promptText
    delay 0.05
    tell application "System Events"
      tell process appName
        keystroke "v" using command down
        delay 0.1
        key code 36
      end tell
    end tell
    delay 0.1
    set the clipboard to oldClipboard
    my writeLog(logFile, "sent")
  on error errMsg number errNum
    try
      set the clipboard to oldClipboard
    end try
    my writeLog(logFile, "failed " & errNum & " " & errMsg)
    if errNum is 1002 then
      my writeLog(logFile, "HINT accessibility permission revoked")
    end if
    error errMsg number errNum
  end try
end run

on writeLog(logFile, msg)
  do shell script "printf '[%s] %s\\n' \"$(date -u +%FT%TZ)\" " & quoted form of ("codex_gui_nudge: " & msg) & " >> " & quoted form of logFile
end writeLog
APPLESCRIPT
