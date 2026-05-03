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

  -- v0.8.2 — skip the wake ONLY when the user is actively typing
  -- (text already in the prompt input), not just because they have
  -- Claude.app focused. v0.7.5 used frontmost-app as the proxy and
  -- over-fired: skipped wake every time the user was reading the
  -- room with Claude.app focused, making the agent look offline.
  --
  -- Precise check: query the actual text-area content via accessibility
  -- and skip only when non-empty. Try/silent on failure so unknown
  -- accessibility hierarchies don't block wakes.
  set userIsTyping to false
  set promptAlreadyTyped to false
  try
    tell application "System Events"
      tell process appName
        -- Walk the typical Electron / Claude.app prompt path. If the
        -- accessibility tree shape differs, the inner gets fail and we
        -- fall through to the wake (correct default).
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
    -- accessibility node not found at expected path — assume not typing,
    -- fire the wake. Better to risk a rare mid-typing garble than to
    -- silently drop every wake forever.
  end try
  if promptAlreadyTyped then
    log "wake: prompt already typed - sending Enter"
    tell application "System Events"
      tell process appName
        set frontmost to true
        key code 36
      end tell
    end tell
    return
  end if
  if userIsTyping then
    log "wake: skipped — user is typing in " & appName
    return
  end if

  -- v0.8.3 — verify-BEFORE-keystroke loop. The previous version did
  -- `tell process to set frontmost + keystroke` in one block, then
  -- LOGGED a warning when post-hoc frontmost check disagreed. But the
  -- keystroke had already gone to the wrong app (13/239 = 5.4% routed
  -- to Codex over the last day, silently lost). petrus called this
  -- out: "i can see the latest check room prompts came more than 1 hr
  -- ago for all of you ... fixing this is now top priority".
  --
  -- New approach: ACTIVATE → SET FRONTMOST → VERIFY → only then
  -- keystroke. Retry up to 5 times. If we can't make Claude frontmost,
  -- BAIL (don't type into the wrong app). The next poll cycle will
  -- retry naturally; better to drop one wake than to spam Codex.
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
    log "wake: ABORT — could not bring " & appName & " to front after 5 attempts (refusing to type into wrong app)"
    -- Restore focus and bail before keystroking.
    try
      tell application frontApp to activate
    end try
    return
  end if

  -- Now we're sure Claude is frontmost. Keystroke.
  -- v0.7.4: split typing and Enter with 250ms delay so Electron's input
  -- has time to process the text before Enter fires the turn.
  set sendOk to false
  try
    tell application "System Events"
      tell process appName
        keystroke promptText
      end tell
    end tell
    delay 0.25
    -- Re-verify focus before pressing Enter. Some apps grab focus
    -- mid-typing (Slack notifications, etc.) and Enter can fire in the
    -- wrong app even when typing landed correctly.
    try
      tell application "System Events"
        set midFront to name of first application process whose frontmost is true
      end tell
      if midFront is not appName then
        log "wake: WARN — focus left " & appName & " mid-keystroke (now " & midFront & "); skipping Enter to avoid wrong-app trigger"
      else
        tell application "System Events"
          tell process appName
            key code 36
          end tell
        end tell
        set sendOk to true
      end if
    end try
  on error errMsg number errNum
    log "wake: keystroke failed — " & errNum & " " & errMsg
    if errNum is 1002 then
      log "wake: HINT — accessibility permission revoked. System Settings → Privacy & Security → Accessibility → toggle osascript / Terminal off+on."
    end if
  end try

  delay 0.2
  -- Restore focus to whatever the user was actually in.
  tell application frontApp to activate
end run
APPLESCRIPT
  printf "[%s] wake: nudge sent, focus restored\n" "$(date -u +%FT%TZ)"
} >> "$LOG_FILE" 2>&1
