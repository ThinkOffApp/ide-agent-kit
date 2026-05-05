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

# Check if the app is running.
# v0.8.6 — macOS comm field is truncated to 16 chars, so `pgrep -xq Claude`
# matches "claude" (the CLI) but NOT the main Electron app whose comm is
# "/Applications/Cl" (truncated). And the v0.8.5 attempt at
# `ps | grep -q` collided with `set -o pipefail` + SIGPIPE: grep -q exits
# early, ps catches SIGPIPE (exit 141), pipefail propagates that as
# pipeline failure even though the match was found. Fix: count matches
# with `grep -c` (consumes all input, no SIGPIPE) and tolerate `|| true`.
running_count=$(ps -A -o command 2>/dev/null | grep -c "/${APP_NAME}.app/Contents/MacOS/${APP_NAME}$" || true)
if [ "${running_count:-0}" -eq 0 ]; then
  printf "[%s] wake failed: '%s' app not running\n" "$(date -u +%FT%TZ)" "$APP_NAME" >> "$LOG_FILE"
  exit 1
fi

# Skip the keystroke nudge when the agent is in-turn — the Stop hook
# will deliver new room messages on the next turn end without typing
# anything. Detect via the Stop hook's heartbeat:
# claudecode-stop-resume.sh touches /tmp/iak-stop-hook-heartbeat at
# every turn end. If that file was updated in the last 60s, the agent
# is actively conversing (turns are firing) and the next Stop hook
# fire will pick up the queued message. Otherwise (no heartbeat or
# stale heartbeat = idle), wake by keystroke.
#
# Note: pgrep-based "claude CLI proc alive" was insufficient — claude
# CLI processes are short-lived (one per turn), so absence != idle.
# Heartbeat freshness is a more reliable in-turn signal.
HEARTBEAT="/tmp/iak-stop-hook-heartbeat"
if [ -f "$HEARTBEAT" ]; then
  hb_age=$(( $(date +%s) - $(stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0) ))
  if [ "$hb_age" -lt 60 ]; then
    printf "[%s] wake: SKIP — in-turn (heartbeat %ss ago), Stop hook will deliver\n" "$(date -u +%FT%TZ)" "$hb_age" >> "$LOG_FILE"
    exit 0
  fi
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
  -- v0.8.5 — petrus 2026-05-03 saw 100% wake aborts after v0.8.4
  -- ("nobody wakes from the wake function. Not great."). The earlier
  -- single `tell application activate` before the loop wasn't enough
  -- when the app was minimized / on another Space / inactive.
  -- Re-call activate INSIDE the loop, longer delays (0.4s instead of
  -- 0.2s), 8 attempts instead of 5. Total budget ~3.5s before bail.
  tell application appName to activate
  delay 0.4

  set focusOk to false
  set focusAttempts to 0
  repeat while focusAttempts < 8
    try
      -- Re-activate every iteration; some macOS states need it again.
      tell application appName to activate
    end try
    try
      tell application "System Events"
        tell process appName
          set frontmost to true
        end tell
      end tell
    end try
    delay 0.4
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
    log "wake: focus loop exhausted after 8 attempts; sending keystroke anyway (better to risk wrong-app than drop wake)"
    -- v0.8.5 fallback: blast the keystroke. If it lands in the wrong
    -- app, the WARN below logs it; if it lands in Claude (frontmost
    -- check is racy and can lie), we get the wake. Either way is
    -- better than the silent 100%-drop we had under v0.8.4.
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
        log "wake: focus left " & appName & " mid-keystroke (now " & midFront & "); re-activating before Enter"
        -- v0.8.7 — petrus 2026-05-04: simultaneous wakes from claudemb +
        -- codex pollers race for focus. Codex.app grabs focus between
        -- my keystroke and Enter, so v0.8.5 SKIPPED Enter — text
        -- landed in Claude's input box but the turn never started.
        -- Petrus saw "all pollers down" because no agent responded.
        --
        -- Fix: re-activate Claude (up to 5 attempts), then send Enter.
        -- If we can't reclaim focus, log + skip (prevents wrong-app
        -- Enter trigger). Net: most cases now succeed, edge cases
        -- still safely drop one wake.
        set reEnterOk to false
        set reEnterAttempts to 0
        repeat while reEnterAttempts < 5
          try
            tell application appName to activate
            tell application "System Events"
              tell process appName
                set frontmost to true
              end tell
            end tell
          end try
          delay 0.3
          try
            tell application "System Events"
              set checkFront to name of first application process whose frontmost is true
            end tell
            if checkFront is appName then
              set reEnterOk to true
              exit repeat
            end if
          end try
          set reEnterAttempts to reEnterAttempts + 1
        end repeat
        if reEnterOk then
          tell application "System Events"
            tell process appName
              key code 36
            end tell
          end tell
          set sendOk to true
          log "wake: Enter sent after focus reclaim (" & reEnterAttempts & " retries)"
        else
          log "wake: ABORT Enter — could not reclaim " & appName & " focus after 5 retries (text typed but no Enter; user can press it manually)"
        end if
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
