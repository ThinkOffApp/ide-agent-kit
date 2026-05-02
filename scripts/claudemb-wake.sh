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
  # v0.7.1 — process-targeted keystroke + verify-then-log fallback.
  #
  # The previous version used `tell application "System Events" to keystroke`
  # which routes to whichever process is frontmost at the moment of execution.
  # If Claude.app didn't fully take focus during the 0.3s delay (multi-window,
  # animations, focus contention), the keystroke landed in the user's actual
  # foreground app with NO error logged — a silent failure observed by
  # @claudemm on 2026-05-02 (~10 nudges sent, ~10 keystrokes lost).
  #
  # Fix: bind the keystroke target to the process explicitly via
  # `tell process "$APP_NAME"`. Then a post-keystroke verify check logs
  # WARN when frontmost app != target so we have a paper trail for any
  # remaining edge cases.
  osascript - "$APP_NAME" "$MSG" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv

  -- Remember which app has focus so we can restore it.
  tell application "System Events"
    set frontApp to name of first application process whose frontmost is true
  end tell

  -- Activate Claude.app first so it can receive the keystroke routing.
  tell application appName to activate
  delay 0.3

  -- Process-targeted keystroke — bound to Claude's process specifically.
  -- Safe even if focus contention briefly puts another app on top.
  set sendOk to false
  try
    tell application "System Events"
      tell process appName
        set frontmost to true
        keystroke promptText
        key code 36
      end tell
    end tell
    set sendOk to true
  on error errMsg number errNum
    log "wake: keystroke failed — " & errNum & " " & errMsg
  end try

  -- Verify the target app actually had focus at the end. Logged for
  -- diagnostics — we don't retry here to avoid double-typing.
  tell application "System Events"
    set finalFront to name of first application process whose frontmost is true
  end tell
  if sendOk and finalFront is not appName then
    log "wake: WARN — keystroke sent but final frontmost is " & finalFront & " (expected " & appName & ")"
  end if

  delay 0.2
  -- Restore focus to whatever the user was actually in.
  tell application frontApp to activate
end run
APPLESCRIPT
  printf "[%s] wake: nudge sent, focus restored\n" "$(date -u +%FT%TZ)"
} >> "$LOG_FILE" 2>&1
