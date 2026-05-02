#!/bin/bash
# UserPromptSubmit hook for Claude Code (desktop app or CLI).
#
# Reads new room messages dropped by claudemb-poll.sh into
# /tmp/iak-new-messages.txt and prepends them to whatever the user typed.
# Then clears the file so the same messages aren't injected again.
#
# Wire it into ~/.claude/settings.json:
#
#   {
#     "hooks": {
#       "UserPromptSubmit": [
#         {
#           "matcher": "",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "bash /path/to/check-rooms-hook.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }

MSG_FILE="${IAK_NEW_FILE:-/tmp/iak-new-messages.txt}"
if [ -s "$MSG_FILE" ]; then
    echo ""
    echo "=== NEW ROOM MESSAGES ==="
    cat "$MSG_FILE"
    echo "========================="
    : > "$MSG_FILE"
fi
