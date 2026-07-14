#!/usr/bin/env bash
# IAK one-shot installer for macOS.
#
# Run from a fresh terminal:
#   curl -fsSL https://raw.githubusercontent.com/ThinkOffApp/ide-agent-kit/main/scripts/install.sh | bash
#
# Idempotent — safe to re-run. Prompts before any destructive action.
#
# What it does:
#   1. Verifies prereqs (node 20+, git, tmux). Installs missing ones via brew if available.
#   2. Clones the repo to ~/ide-agent-kit (or pulls latest if already there).
#   3. npm install.
#   4. Writes a starter config to ide-agent-kit.json with sensible defaults
#      (PORT 8788, host 0.0.0.0 so phone on LAN can reach it). Skips if
#      config already exists.
#   5. Installs ~/.claude/scripts/check-rooms-hook.sh + claudemb-poll/wake
#      shims and registers the UserPromptSubmit + Stop + SessionStart hooks
#      in ~/.claude/settings.json (backed up to settings.json.bak before any
#      change). Skips registrations already present.
#   6. Starts the daemon in a tmux session named "iak-mcp".
#   7. Prints the LAN URL the user should paste into CodeWatch.
#
# Does NOT:
#   - Generate any signing keys.
#   - Touch macOS Accessibility permissions (user must grant manually
#     for the osascript wake to work — the script prints the System
#     Settings deep-link).
#   - Install Claude Code itself.

set -euo pipefail

REPO="https://github.com/ThinkOffApp/ide-agent-kit.git"
INSTALL_DIR="${IAK_INSTALL_DIR:-$HOME/ide-agent-kit}"
TMUX_SESSION="${IAK_TMUX_SESSION:-iak-mcp}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red() { printf "\033[31m%s\033[0m\n" "$*" >&2; }

bold "ide-agent-kit one-shot installer"
echo

# 1. prereqs
need_brew=()
command -v node >/dev/null || need_brew+=(node)
command -v git >/dev/null || need_brew+=(git)
command -v tmux >/dev/null || need_brew+=(tmux)

if [ "${#need_brew[@]}" -gt 0 ]; then
  if command -v brew >/dev/null; then
    yellow "Installing missing prereqs via brew: ${need_brew[*]}"
    brew install "${need_brew[@]}"
  else
    red "Missing: ${need_brew[*]}. Install Homebrew (https://brew.sh) first, then re-run."
    exit 1
  fi
fi

NODE_MAJOR=$(node -v | sed 's/^v//; s/\..*//')
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "node $NODE_MAJOR is too old; need 20+. brew upgrade node."
  exit 1
fi

# 2. clone or pull
if [ -d "$INSTALL_DIR/.git" ]; then
  yellow "$INSTALL_DIR exists; pulling latest"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  yellow "Cloning $REPO into $INSTALL_DIR"
  git clone "$REPO" "$INSTALL_DIR"
fi

# 3. npm install
(cd "$INSTALL_DIR" && npm install --silent)

# 4. starter config
CONFIG="$INSTALL_DIR/ide-agent-kit.json"
if [ ! -f "$CONFIG" ]; then
  yellow "Writing starter config to $CONFIG"
  cat > "$CONFIG" <<EOF
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "queue": { "path": "./ide-agent-queue.jsonl" },
  "receipts": { "path": "./ide-agent-receipts.jsonl", "stdout_tail_lines": 80 },
  "tmux": {
    "default_session": "iak-runner",
    "ide_session": "claude",
    "nudge_text": "check rooms",
    "allow": ["npm test", "npm run build", "git status", "git diff"]
  },
  "github": { "webhook_secret": "", "event_kinds": ["pull_request", "issue_comment"] },
  "outbound": { "default_webhook_url": "" },
  "openclaw": { "host": "127.0.0.1", "port": 18791, "token": "" },
  "poller": { "api_key": "" },
  "mcp": {
    "sessions": ["claude"],
    "confirmations": {
      "port": 8788,
      "host": "0.0.0.0",
      "room": "",
      "callback_base": ""
    }
  }
}
EOF
  bold "EDIT THIS FILE before starting the daemon:"
  echo "  - poller.api_key: your GroupMind API key (https://groupmind.one/agents)"
  echo "  - mcp.confirmations.room: the room slug to watch (e.g. thinkoff-development)"
  echo "  - mcp.confirmations.callback_base: http://<your-LAN-IP>:8788"
  echo
fi

# 5. Claude Code hook wiring
SETTINGS="$HOME/.claude/settings.json"
SCRIPTS_DIR="$INSTALL_DIR/scripts"
if [ -f "$SETTINGS" ]; then
  yellow "Wiring UserPromptSubmit + Stop + SessionStart hooks in $SETTINGS"
  python3 - "$SETTINGS" "$SCRIPTS_DIR" <<'PY'
import json, shutil, sys, os
settings_path, scripts_dir = sys.argv[1], sys.argv[2]
data = json.load(open(settings_path))
data.setdefault("hooks", {})
def ensure_hook(event, cmd, timeout=None):
    arr = data["hooks"].setdefault(event, [])
    for entry in arr:
        for h in entry.get("hooks", []):
            if h.get("command") == cmd: return False
    hook = {"type":"command","command":cmd}
    if timeout is not None: hook["timeout"] = timeout
    arr.append({"matcher":"","hooks":[hook]})
    return True
changed = False
changed |= ensure_hook("UserPromptSubmit", f"bash {scripts_dir}/check-rooms-hook.sh")
changed |= ensure_hook("Stop", f"bash {scripts_dir}/claudecode-stop-resume.sh")
# Self-arming room agent: on every session start (startup/resume/compact) the
# hook injects instructions to re-arm the notification-file Monitor, read any
# backlog, and keep the self-paced room loop running — no manual
# "/loop check rooms" needed after a restart.
changed |= ensure_hook("SessionStart", f"bash {scripts_dir}/session-bootstrap.sh", timeout=10)
if changed:
    shutil.copyfile(settings_path, settings_path + ".bak")
    json.dump(data, open(settings_path,"w"), indent=2)
    print("Hooks installed.")
else:
    print("Hooks already present.")
PY
else
  yellow "No ~/.claude/settings.json yet — skipping hook wiring. Re-run after first Claude Code launch."
fi

# 6. start daemon in tmux
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  yellow "Restarting daemon in tmux session $TMUX_SESSION"
  tmux kill-session -t "$TMUX_SESSION"
fi
tmux new-session -d -s "$TMUX_SESSION" \
  "cd $INSTALL_DIR && node bin/iak-mcp-daemon.mjs"
sleep 2

# 7. report
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
LAN_URL="http://${LAN_IP}:8788"
echo
green "Installed."
echo
bold "Daemon: tmux session '$TMUX_SESSION'"
echo "  - logs: tmux attach -t $TMUX_SESSION"
echo "  - listener: $LAN_URL"
echo
bold "CodeWatch on phone — pair via QR or manual paste:"
echo "  - URL: $LAN_URL"
echo
# Print a scannable QR if qrencode is available. Install with: brew install qrencode
if command -v qrencode >/dev/null 2>&1; then
  echo "Scan from CodeWatch (Account tab → Scan Pairing QR):"
  echo
  qrencode -t UTF8 "$LAN_URL"
  echo
else
  yellow "Tip: brew install qrencode  →  re-run installer to get a scannable QR for CodeWatch pairing."
fi
echo
bold "macOS Accessibility (one-time, for osascript-based desktop-app wake):"
echo "  - System Settings → Privacy & Security → Accessibility"
echo "  - Add: /usr/bin/osascript (or whatever process runs the daemon — usually iTerm/Terminal/tmux)"
echo
bold "Edit your config:"
echo "  - $CONFIG"
echo "  - poller.api_key + mcp.confirmations.room are required for chat-reply support"
