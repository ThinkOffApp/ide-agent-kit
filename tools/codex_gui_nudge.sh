#!/usr/bin/env bash

# Never type over the human (petrus 2026-07-13: "tmux should not write if i
# am writing!"). Skip this nudge cycle unless the machine is human-idle.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Never nudge while the room poller is down. Without its seen-file the app
# reads the recent window cold and answers every mention that still looks
# open: three nudges produced five identical reviews on 2026-09-01 while the
# poller crash-looped under launchd (issue #86). The poller touches a
# heartbeat every cycle; stale or missing = down. Set IAK_POLLER_HEARTBEAT=off
# only for a setup that has no poller at all.
POLLER_HEARTBEAT="${IAK_POLLER_HEARTBEAT:-/tmp/iak-poller.heartbeat}"
POLLER_MAX_AGE="${IAK_POLLER_MAX_AGE_SEC:-180}"
NUDGE_LOG_EARLY="${IAK_CODEX_NUDGE_LOG:-/tmp/codex_gui_nudge.log}"
if [ "$POLLER_HEARTBEAT" != "off" ]; then
    if [ ! -f "$POLLER_HEARTBEAT" ]; then
        printf '[%s] codex_gui_nudge: ABORT poller down (no heartbeat at %s) - not nudging\n' "$(date -u +%FT%TZ)" "$POLLER_HEARTBEAT" >>"$NUDGE_LOG_EARLY"
        exit 1
    fi
    # GNU stat: -c %Y is the mtime; its -f is filesystem mode and prints a mount
    # point (codex review of PR #87). BSD/macOS stat has no -c, so it falls
    # through to -f %m. Anything non-numeric fails closed: no nudge.
    HB_MTIME=$(stat -c %Y "$POLLER_HEARTBEAT" 2>/dev/null || stat -f %m "$POLLER_HEARTBEAT" 2>/dev/null || echo "")
    case "$HB_MTIME" in
        ''|*[!0-9]*)
            printf '[%s] codex_gui_nudge: ABORT poller heartbeat mtime unreadable (%s) - not nudging\n' "$(date -u +%FT%TZ)" "${HB_MTIME:-empty}" >>"$NUDGE_LOG_EARLY"
            exit 1 ;;
    esac
    HB_AGE=$(( $(date +%s) - HB_MTIME ))
    if [ "$HB_AGE" -gt "$POLLER_MAX_AGE" ]; then
        printf '[%s] codex_gui_nudge: ABORT poller down (heartbeat %ss old, max %ss) - not nudging\n' "$(date -u +%FT%TZ)" "$HB_AGE" "$POLLER_MAX_AGE" >>"$NUDGE_LOG_EARLY"
        exit 1
    fi
fi
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
CLICLICK_BIN="${IAK_CLICLICK_BIN:-/opt/homebrew/bin/cliclick}"
PYTHON_BIN="${IAK_PYTHON_BIN:-/opt/homebrew/bin/python3}"
HUMAN_IDLE_SEC="${IAK_HUMAN_IDLE_SEC:-60}"
HUMAN_IDLE_CHECK="${IAK_HUMAN_IDLE_CHECK:-$(dirname "$0")/macos_human_idle.py}"

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not found" >&2
  exit 1
fi

printf '[%s] codex_gui_nudge: start app=%s text=%q\n' "$(date -u +%FT%TZ)" "$APP_NAME" "$PROMPT_TEXT" >>"$LOG_FILE"

# NEVER type into a locked screen: on a locked Mac the keystrokes land in the
# lock-screen password field and register as failed unlock attempts
# (claudemm review of IAK PR #28, confirmed Jul 13). Abort softly when locked
# or when the lock state cannot be determined.
LOCK_PY="$PYTHON_BIN"; [ -x "$LOCK_PY" ] || LOCK_PY="$(command -v python3 || true)"
if [ -n "$LOCK_PY" ]; then
  LOCK_STATE=$("$LOCK_PY" - <<'PY' 2>/dev/null || echo unknown
import Quartz
d = dict(Quartz.CGSessionCopyCurrentDictionary() or {})
print("locked" if d.get("CGSSessionScreenIsLocked", False) else "unlocked")
PY
)
else
  LOCK_STATE=unknown
fi
if [ "$LOCK_STATE" != "unlocked" ]; then
  printf '[%s] codex_gui_nudge: ABORT screen %s - refusing to type\n' "$(date -u +%FT%TZ)" "$LOCK_STATE" >>"$LOG_FILE"
  # M3 (#30 gate): abort = NOT delivered; exit 1 so the caller retries
  exit 1
fi

# GUI injection is a last-resort wake path. Never focus, click, paste, or press
# Enter while the human has used the keyboard or pointer in the last minute.
# Unknown idle state fails closed. Recheck immediately before each injection to
# close the race where the human starts typing while Codex is being focused.
require_human_idle() {
  local phase="$1" idle_seconds rc
  if [ ! -x "$LOCK_PY" ] || [ ! -f "$HUMAN_IDLE_CHECK" ]; then
    printf '[%s] codex_gui_nudge: ABORT human-idle check unavailable at %s\n' "$(date -u +%FT%TZ)" "$phase" >>"$LOG_FILE"
    return 1
  fi
  if idle_seconds=$("$LOCK_PY" "$HUMAN_IDLE_CHECK" "$HUMAN_IDLE_SEC" 2>/dev/null); then
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 1 ] && [ -n "$idle_seconds" ]; then
    printf '[%s] codex_gui_nudge: ABORT human active at %s (idle=%ss, required=%ss)\n' "$(date -u +%FT%TZ)" "$phase" "$idle_seconds" "$HUMAN_IDLE_SEC" >>"$LOG_FILE"
  else
    printf '[%s] codex_gui_nudge: ABORT human-idle state unknown at %s\n' "$(date -u +%FT%TZ)" "$phase" >>"$LOG_FILE"
  fi
  return 1
}

require_human_idle "wake start" || exit 1

# Prefer cliclick for background wakes. launchd's /usr/bin/osascript process is
# not necessarily granted Accessibility access even when Terminal is, while the
# already-approved cliclick binary can generate the click and keystrokes. Quartz
# window metadata gives stable coordinates without Accessibility/UI scripting.
if [ -x "$CLICLICK_BIN" ] && [ -x "$PYTHON_BIN" ] && "$PYTHON_BIN" -c 'import Quartz' >/dev/null 2>&1; then
  open -a "$APP_NAME"
  sleep 0.6
  # Guard: only type if the target app is actually FRONTMOST. cliclick clicks
  # window-relative coordinates, and when another window overlaps that point
  # (or focus shifts between open and click) the nudge text lands in whatever
  # is on top - observed leaking "check rooms [codex]" into a Claude Code CLI
  # on Jul 13. Abort softly instead.
  FRONT_APP=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || echo unknown)
  if [ "$FRONT_APP" != "$APP_NAME" ]; then
    printf '[%s] codex_gui_nudge: ABORT frontmost is %q not %q - refusing to type\n' "$(date -u +%FT%TZ)" "$FRONT_APP" "$APP_NAME" >>"$LOG_FILE"
    exit 1
  fi
  WINDOW_BOUNDS=$("$PYTHON_BIN" - "$APP_NAME" <<'PY'
import sys
import Quartz

app = sys.argv[1]
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID,
)
candidates = []
for window in windows:
    if window.get(Quartz.kCGWindowOwnerName) != app:
        continue
    if int(window.get(Quartz.kCGWindowLayer, 1)) != 0:
        continue
    bounds = window.get(Quartz.kCGWindowBounds, {})
    width = int(bounds.get('Width', 0))
    height = int(bounds.get('Height', 0))
    if width > 300 and height > 300:
        candidates.append((width * height, int(bounds['X']), int(bounds['Y']), width, height))
if candidates:
    _, x, y, width, height = max(candidates)
    print(x, y, width, height)
PY
)
  if read -r WIN_X WIN_Y WIN_W WIN_H <<<"$WINDOW_BOUNDS" && [ -n "${WIN_H:-}" ]; then
    CLICK_X=$((WIN_X + WIN_W / 2))
    CLICK_Y=$((WIN_Y + WIN_H - 72))
    require_human_idle "before cliclick injection" || exit 1
    if "$CLICLICK_BIN" -r -w 20 "c:${CLICK_X},${CLICK_Y}" "t:${PROMPT_TEXT}" kp:return; then
      printf '[%s] codex_gui_nudge: sent via cliclick x=%s y=%s\n' "$(date -u +%FT%TZ)" "$CLICK_X" "$CLICK_Y" >>"$LOG_FILE"
      exit 0
    fi
  fi
  printf '[%s] codex_gui_nudge: cliclick path unavailable; falling back to AppleScript\n' "$(date -u +%FT%TZ)" >>"$LOG_FILE"
fi

require_human_idle "before AppleScript wake" || exit 0

osascript - "$APP_NAME" "$PROMPT_TEXT" "$LOG_FILE" "$LOCK_PY" "$HUMAN_IDLE_CHECK" "$HUMAN_IDLE_SEC" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set promptText to item 2 of argv
  set logFile to item 3 of argv
  set pythonBin to item 4 of argv
  set idleCheck to item 5 of argv
  set idleThreshold to item 6 of argv

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

  if not my humanIsIdle(pythonBin, idleCheck, idleThreshold) then
    my writeLog(logFile, "ABORT human active or idle state unknown before AppleScript injection")
    return
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

on humanIsIdle(pythonBin, idleCheck, idleThreshold)
  try
    do shell script quoted form of pythonBin & " " & quoted form of idleCheck & " " & quoted form of idleThreshold
    return true
  on error
    return false
  end try
end humanIsIdle

on writeLog(logFile, msg)
  do shell script "printf '[%s] %s\\n' \"$(date -u +%FT%TZ)\" " & quoted form of ("codex_gui_nudge: " & msg) & " >> " & quoted form of logFile
end writeLog
APPLESCRIPT
