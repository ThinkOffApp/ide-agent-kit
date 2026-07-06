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

# Heartbeat for the wake script: touch on every Stop hook fire so
# claudemb-wake.sh can distinguish 'in-turn' (recent heartbeat → skip
# keystroke wake, this hook will deliver) from 'idle' (stale heartbeat
# → keystroke wake is the only way to start a new turn).
touch "${IAK_STOP_HEARTBEAT:-/tmp/iak-stop-hook-heartbeat}" 2>/dev/null || true

if [ ! -s "$MSG_FILE" ]; then
    exit 0
fi

# Webhook-push delivery (petrus 2026-07-02): the poller writes the actual
# new-message bodies into $MSG_FILE and excludes our own posts, so we just
# inject them inline here. No "check rooms" fetch and no subagent — the
# message content arrives WITH the wake and the agent replies directly via
# mcp__ide-agent-kit__room_post. This replaces the old MCP-fetch hint that
# spawned a room_recent digest every single turn (the "check rooms" churn
# petrus asked to remove).
{
    echo ""
    echo "=== NEW ROOM MESSAGE(S) ==="
    cat "$MSG_FILE"
    echo "==========================="
    echo "^ Actual new inbound room messages (your own posts are filtered out by the poller). Reply in-room with mcp__ide-agent-kit__room_post only if a response is warranted. Do NOT fetch or poll — the content is right here."
} >&2
: > "$MSG_FILE"
exit 2
