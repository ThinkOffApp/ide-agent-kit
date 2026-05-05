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

# Architecture (per petrus 2026-05-04 / 2026-05-05):
#   - Poller still fires the keystroke wake from idle (cold start only).
#   - Once awake, the agent fetches via MCP tools (room_recent etc).
#   - This hook bridges those: if IAK MCP is registered for Claude
#     Code, inject a HINT pointing the agent at room_recent. If not
#     registered yet, fall back to dumping file contents inline so
#     the agent still sees the messages this turn.
CLAUDE_CONFIG="${HOME}/.claude.json"
mcp_registered=0
if [ -f "$CLAUDE_CONFIG" ] && grep -q '"ide-agent-kit"' "$CLAUDE_CONFIG" 2>/dev/null; then
    mcp_registered=1
fi

if [ "$mcp_registered" -eq 1 ]; then
    # MCP path: hint the agent to use mcp__ide-agent-kit__room_recent.
    # Don't paste file contents — keeps prompt clean and forces the
    # MCP tool path. Truncate the file so future hook fires don't
    # re-emit the same hint forever.
    n_lines=$(wc -l < "$MSG_FILE" 2>/dev/null | tr -d ' ' || echo 0)
    {
        echo ""
        echo "=== NEW ROOM MESSAGES (MCP fetch) ==="
        echo "$n_lines line(s) of new room activity available."
        echo "Call mcp__ide-agent-kit__room_recent with limit=10 to see them, then mcp__ide-agent-kit__room_post to reply."
        echo "Do NOT shell to curl/python for room I/O — use MCP tools."
        echo "====================================="
    } >&2
    : > "$MSG_FILE"
    exit 2
fi

# Fallback path: MCP not registered → dump file contents directly so
# the agent at least sees the messages.
{
    echo ""
    echo "=== NEW ROOM MESSAGES ==="
    cat "$MSG_FILE"
    echo "========================="
} >&2
: > "$MSG_FILE"
exit 2
