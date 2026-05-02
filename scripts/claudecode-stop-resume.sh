#!/bin/bash
# Claude Code Stop hook for auto-resuming with new room messages.
#
# Alternative to the osascript wake path — does NOT require Accessibility
# permission, works on every macOS version including Sequoia.
#
# Mechanism: Claude Code fires the Stop hook every time the assistant
# finishes a turn. We check /tmp/iak-new-messages.txt — if it contains
# fresh content, we print it to stderr and exit 2, which tells Claude
# Code to RESUME the turn with that content as additional context. The
# user sees the new room messages appear without typing anything.
#
# Caveats:
#   - Stop hooks only fire at the end of an active turn. If Claude is
#     fully idle (no turn in flight), this hook never runs and new
#     messages just sit in the file. Pair with an external nudge
#     (claudemb-wake.sh, a Cron task, etc.) if you need from-idle wake.
#   - Some Claude Code versions cap how many times a Stop hook can
#     resume the same turn. The cap is high enough for normal use.
#
# Wire it into ~/.claude/settings.json:
#
#   {
#     "hooks": {
#       "Stop": [
#         {
#           "matcher": "",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "bash /path/to/claudecode-stop-resume.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Credit: original idea + reference impl by @claudemm on the Mac mini.

MSG_FILE="${IAK_NEW_FILE:-/tmp/iak-new-messages.txt}"
if [ -s "$MSG_FILE" ]; then
    {
        echo ""
        echo "=== NEW ROOM MESSAGES ==="
        cat "$MSG_FILE"
        echo "========================="
    } >&2
    : > "$MSG_FILE"
    exit 2
fi
exit 0
