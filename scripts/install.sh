#!/usr/bin/env bash
# IAK one-shot installer for macOS and Linux.
#
# Run from a fresh terminal:
#   curl -fsSL https://raw.githubusercontent.com/ThinkOffApp/ide-agent-kit/main/scripts/install.sh | bash
#
# Idempotent — safe to re-run. Never installs a package without printing the
# exact command first, and never runs an unattended sudo install when there is
# no TTY (i.e. under `curl | bash`): it prints what to run and exits non-zero.
#
# What it does:
#   1. Detects the platform (uname -s) and a package manager (brew on macOS;
#      apt-get / dnf / pacman / zypper on Linux), then verifies prereqs
#      (node 20+, npm, git, tmux) and offers to install the missing ones.
#   2. Clones the repo to ~/ide-agent-kit (or pulls latest if already there).
#   3. npm install.
#   4. Writes a starter config to ide-agent-kit.json. Two listeners: the
#      webhook server on 127.0.0.1:8787 (`listen`, local only) and the
#      confirmation daemon on 0.0.0.0:8788 (`mcp.confirmations`, LAN-reachable
#      so a phone running CodeWatch can reach it). Skips if config already
#      exists.
#   5. Installs the check-rooms / stop-resume / session-bootstrap hooks into
#      ~/.claude/settings.json (backed up to settings.json.bak before any
#      change). Skips registrations already present.
#   6. Starts the daemon in a tmux session named "iak-mcp".
#   7. Prints the LAN URL the user should paste into CodeWatch.
#
# Does NOT:
#   - Generate any signing keys.
#   - Touch macOS Accessibility permissions (user must grant manually
#     for the osascript wake to work — the script prints the System
#     Settings deep-link). The osascript GUI-wake path is macOS-only;
#     on Linux the portable Stop-hook resume path is used instead.
#   - Install Claude Code itself.
#
# Environment overrides:
#   IAK_INSTALL_DIR     where to clone (default ~/ide-agent-kit)
#   IAK_TMUX_SESSION    daemon tmux session name (default iak-mcp)
#   IAK_DRY_RUN=1       print the platform + prereq plan and exit 0, touching
#                       nothing. Use this to inspect what would happen.
#   IAK_ASSUME_YES=1    allow package installs without a TTY confirmation.
#                       Required for `curl | bash` to install anything.
#   IAK_NODE_MAJOR      node major to install from NodeSource (default 22)
#   IAK_NODE_SOURCE     on Debian/Ubuntu: "nodesource" (default) or "distro".
#                       The distro `nodejs` package is too old on current
#                       Ubuntu (24.04 ships 18.x; we need 20+), so the
#                       default routes through NodeSource. See below.
#   IAK_INSTALL_WATCHDOG=1  install the peer-wake watchdog (macOS only)

set -euo pipefail

REPO="https://github.com/ThinkOffApp/ide-agent-kit.git"
INSTALL_DIR="${IAK_INSTALL_DIR:-$HOME/ide-agent-kit}"
TMUX_SESSION="${IAK_TMUX_SESSION:-iak-mcp}"
NODE_MIN_MAJOR=20
NODE_INSTALL_MAJOR="${IAK_NODE_MAJOR:-22}"
DRY_RUN="${IAK_DRY_RUN:-0}"
ASSUME_YES="${IAK_ASSUME_YES:-0}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red() { printf "\033[31m%s\033[0m\n" "$*" >&2; }

bold "ide-agent-kit one-shot installer"
echo

# ---------------------------------------------------------------------------
# 1. platform + package manager detection
# ---------------------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
PKG=""

case "$OS" in
  Darwin)
    PLATFORM_LABEL="macOS (Darwin)"
    if command -v brew >/dev/null 2>&1; then PKG="brew"; fi
    ;;
  Linux)
    PLATFORM_LABEL="Linux"
    for m in apt-get dnf pacman zypper; do
      if command -v "$m" >/dev/null 2>&1; then PKG="$m"; break; fi
    done
    ;;
  *)
    red "Unsupported platform: 'uname -s' reported '$OS'."
    red "This installer supports macOS (Darwin) and Linux only."
    red ""
    red "Install these yourself and then run the daemon by hand:"
    red "  node ${NODE_MIN_MAJOR}+, npm, git, tmux"
    red "  git clone $REPO $INSTALL_DIR"
    red "  cd $INSTALL_DIR && npm install && node bin/iak-mcp-daemon.mjs"
    exit 1
    ;;
esac

echo "Platform: $PLATFORM_LABEL"
if [ -n "$PKG" ]; then
  echo "Package manager: $PKG"
else
  echo "Package manager: none detected"
fi

# Are we able to prompt? `curl | bash` gives us no TTY on stdin, which is
# exactly when an unattended sudo install would be least welcome.
if [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi

# sudo is needed for every Linux package manager unless we are already root.
SUDO=""
HAVE_PRIVS=1
if [ "$OS" != "Darwin" ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo "
  else
    HAVE_PRIVS=0
  fi
fi
# Piping into a root shell: "sudo -E bash -" as a user, plain "bash -" as root.
# ${SUDO}-E would expand to a bare "-E" when SUDO is empty.
if [ -n "$SUDO" ]; then SUDO_PIPE="sudo -E bash -"; else SUDO_PIPE="bash -"; fi
# apt's debconf will prompt (tzdata, etc.). Under `curl | bash` stdin IS the
# script, so a prompting child silently swallows the rest of the installer and
# we exit 0 having done half the job. Belt and braces: DEBIAN_FRONTEND, plus
# every plan command runs with stdin closed (see the exec loop below).
APT="${SUDO}env DEBIAN_FRONTEND=noninteractive apt-get"

# ---------------------------------------------------------------------------
# 2. prereq detection
# ---------------------------------------------------------------------------
# Package names differ per manager. Keep this table honest: an entry that is a
# guess is worse than no entry, because the install fails halfway.
pkg_name() {
  case "$1:$2" in
    brew:git) echo git ;;
    brew:tmux) echo tmux ;;
    brew:qrencode) echo qrencode ;;
    apt-get:git) echo git ;;
    apt-get:tmux) echo tmux ;;
    apt-get:qrencode) echo qrencode ;;
    dnf:git) echo git ;;
    dnf:tmux) echo tmux ;;
    dnf:qrencode) echo qrencode ;;
    pacman:git) echo git ;;
    pacman:tmux) echo tmux ;;
    pacman:qrencode) echo qrencode ;;
    zypper:git) echo git ;;
    zypper:tmux) echo tmux ;;
    zypper:qrencode) echo qrencode ;;
    *) echo "$2" ;;
  esac
}

# What WE run (may carry the noninteractive env wrapper).
# pkg_install_hint below is what we TELL the user to type.
pkg_install_prefix() {
  case "$1" in
    brew)    echo "brew install" ;;
    apt-get) echo "$APT install -y" ;;
    dnf)     echo "${SUDO}dnf install -y" ;;
    pacman)  echo "${SUDO}pacman -S --needed --noconfirm" ;;
    zypper)  echo "${SUDO}zypper --non-interactive install" ;;
    *)       echo "" ;;
  esac
}

pkg_install_hint() {
  case "$1" in
    brew)    echo "brew install" ;;
    apt-get) echo "${SUDO}apt-get install -y" ;;
    dnf)     echo "${SUDO}dnf install -y" ;;
    pacman)  echo "${SUDO}pacman -S --needed" ;;
    zypper)  echo "${SUDO}zypper install" ;;
    *)       echo "" ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

NEED_NODE=0
NEED_TOOLS=()
node_ok || NEED_NODE=1
command -v npm >/dev/null 2>&1 || NEED_NODE=1
command -v git >/dev/null 2>&1 || NEED_TOOLS+=(git)
command -v tmux >/dev/null 2>&1 || NEED_TOOLS+=(tmux)

# Build the exact command list we would run, so we can show it before running.
PLAN=()
if [ "$NEED_NODE" = 1 ] || [ "${#NEED_TOOLS[@]}" -gt 0 ]; then
  if [ -z "$PKG" ]; then
    red "Missing prereqs and no supported package manager was found."
    red ""
    if [ "$OS" = "Darwin" ]; then
      red "Install Homebrew (https://brew.sh), then re-run this installer."
    else
      red "Looked for: apt-get, dnf, pacman, zypper — none are on PATH."
    fi
    red ""
    red "Install these by hand, then re-run:"
    [ "$NEED_NODE" = 1 ] && red "  node ${NODE_MIN_MAJOR}+ and npm   (https://nodejs.org/en/download)"
    for t in "${NEED_TOOLS[@]:-}"; do [ -n "$t" ] && red "  $t"; done
    exit 1
  fi

  if [ "$HAVE_PRIVS" = 0 ]; then
    red "Missing prereqs need a package install, but this user is not root and"
    red "sudo is not available."
    red ""
    red "Run as root, or install by hand:"
    [ "$NEED_NODE" = 1 ] && red "  node ${NODE_MIN_MAJOR}+ and npm"
    for t in "${NEED_TOOLS[@]:-}"; do [ -n "$t" ] && red "  $t"; done
    exit 1
  fi

  if [ "$PKG" = "apt-get" ]; then
    PLAN+=("$APT update")
  fi

  if [ "${#NEED_TOOLS[@]}" -gt 0 ]; then
    names=""
    for t in "${NEED_TOOLS[@]}"; do names="$names $(pkg_name "$PKG" "$t")"; done
    PLAN+=("$(pkg_install_prefix "$PKG")$names")
  fi

  if [ "$NEED_NODE" = 1 ]; then
    case "$PKG" in
      brew)
        PLAN+=("brew install node")
        ;;
      apt-get)
        # Debian/Ubuntu's own `nodejs` package is routinely far below our
        # floor — Ubuntu 24.04's candidate is 18.19.1, and we need 20+. So
        # the default is NodeSource's official apt repo, which is a
        # third-party script we pipe to a root shell. We say so out loud
        # rather than doing it quietly. Override with IAK_NODE_SOURCE=distro
        # if your apt really does carry node 20+ (e.g. Debian trixie).
        if [ "${IAK_NODE_SOURCE:-nodesource}" = "distro" ]; then
          PLAN+=("$APT install -y nodejs npm")
        else
          NODE_VIA_NODESOURCE=1
          PLAN+=("$APT install -y ca-certificates curl gnupg")
          PLAN+=("curl -fsSL https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | $SUDO_PIPE")
          PLAN+=("$APT install -y nodejs")
        fi
        ;;
      dnf)
        PLAN+=("${SUDO}dnf install -y nodejs npm")
        ;;
      pacman)
        PLAN+=("${SUDO}pacman -S --needed --noconfirm nodejs npm")
        ;;
      zypper)
        PLAN+=("${SUDO}zypper --non-interactive install nodejs${NODE_INSTALL_MAJOR} npm${NODE_INSTALL_MAJOR}")
        ;;
    esac
  fi
fi

if [ "${#PLAN[@]}" -eq 0 ]; then
  green "Prereqs OK: node $(node -v), npm $(npm -v), git, tmux."
else
  yellow "Missing prereqs. This installer wants to run:"
  echo
  for cmd in "${PLAN[@]}"; do echo "    $cmd"; done
  echo
  if [ -n "$SUDO" ]; then
    yellow "Those lines use sudo — they change system packages and will ask for"
    yellow "your password."
  fi
  if [ "${NODE_VIA_NODESOURCE:-0}" = 1 ]; then
    yellow "Heads up: one of those lines pipes a script from deb.nodesource.com"
    yellow "into a root shell. That is NodeSource's official Node.js apt setup."
    yellow "If you would rather not, install node ${NODE_MIN_MAJOR}+ yourself (nvm, or"
    yellow "IAK_NODE_SOURCE=distro if your distro carries a new enough node) and"
    yellow "re-run this installer."
  fi
  echo
fi

if [ "$DRY_RUN" = "1" ]; then
  echo
  bold "IAK_DRY_RUN=1 — stopping here. Nothing was installed or changed."
  echo "Would clone to:   $INSTALL_DIR"
  echo "Would wire hooks: $HOME/.claude/settings.json"
  echo "Would start tmux: $TMUX_SESSION"
  exit 0
fi

if [ "${#PLAN[@]}" -gt 0 ]; then
  if [ "$ASSUME_YES" != "1" ]; then
    if [ "$INTERACTIVE" != "1" ]; then
      red "Not running those: there is no TTY to confirm on (you piped this"
      red "script into bash, so stdin is the script itself)."
      red ""
      red "Run the lines above yourself, then re-run the installer. Or, if you"
      red "have read them and want this installer to run them unattended:"
      red ""
      red "  curl -fsSL ${REPO%.git}/raw/main/scripts/install.sh -o iak-install.sh"
      red "  less iak-install.sh    # read it"
      red "  IAK_ASSUME_YES=1 bash iak-install.sh"
      exit 1
    fi
    printf "Run them now? [y/N] "
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS]) ;;
      *) red "Aborted. Nothing was installed."; exit 1 ;;
    esac
  fi
  for cmd in "${PLAN[@]}"; do
    yellow "+ $cmd"
    # </dev/null is load-bearing: under `curl | bash` our own stdin is the
    # remaining script text, and any package manager that prompts would read
    # it and truncate the install.
    bash -c "$cmd" </dev/null
  done
fi

# Re-verify rather than assume the installs did what we wanted.
if ! node_ok; then
  red "node is still missing or below ${NODE_MIN_MAJOR} after the install step."
  if command -v node >/dev/null 2>&1; then red "  found: $(node -v)"; fi
  red "Install node ${NODE_MIN_MAJOR}+ manually (https://nodejs.org/en/download) and re-run."
  exit 1
fi
for t in npm git tmux; do
  if ! command -v "$t" >/dev/null 2>&1; then
    red "$t is still missing after the install step. Install it and re-run."
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 3. clone or pull
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  yellow "$INSTALL_DIR exists; pulling latest"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  yellow "Cloning $REPO into $INSTALL_DIR"
  git clone "$REPO" "$INSTALL_DIR"
fi

# ---------------------------------------------------------------------------
# 4. npm install
# ---------------------------------------------------------------------------
(cd "$INSTALL_DIR" && npm install --silent)

# ---------------------------------------------------------------------------
# 5. starter config
# ---------------------------------------------------------------------------
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
  echo "  - poller.api_key: your agent's GroupMind key. Signed in at"
  echo "      https://groupmind.one/agents -> + Add agent (copy the one-time key),"
  echo "    or self-register without signing in:"
  echo "      $INSTALL_DIR/docs/AGENT-ONBOARDING.md (section 1)"
  echo "  - mcp.confirmations.room: the room slug to watch (e.g. my-room)"
  echo "  - mcp.confirmations.callback_base: http://<your-LAN-IP>:8788"
  echo
fi

# ---------------------------------------------------------------------------
# 6. Claude Code hook wiring
# ---------------------------------------------------------------------------
SETTINGS="$HOME/.claude/settings.json"
SCRIPTS_DIR="$INSTALL_DIR/scripts"
# First-time installs may predate Claude Code ever writing settings.json -
# create a minimal file so fresh users still get the hooks (self-arming is
# the whole point; codex review, #33).
if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  printf '{}\n' > "$SETTINGS"
  yellow "Created minimal $SETTINGS (did not exist yet)"
fi
yellow "Wiring UserPromptSubmit + Stop + SessionStart hooks in $SETTINGS"
# This used to be a python3 heredoc. A stock ubuntu:24.04 has no python3, so
# that made the installer need a second language runtime it never declared as
# a prereq. node 20+ is already guaranteed by this point, so use it.
HOOK_JS="$(mktemp "${TMPDIR:-/tmp}/iak-hooks.XXXXXX")"
cat > "$HOOK_JS" <<'JS'
const fs = require('fs');
const [settingsPath, scriptsDir] = process.argv.slice(2);
let data;
try {
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  data = raw ? JSON.parse(raw) : {};
} catch (err) {
  console.error('Could not parse ' + settingsPath + ': ' + err.message);
  console.error('Fix or move that file, then re-run the installer.');
  process.exit(1);
}
if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {};
if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) data.hooks = {};
let changed = false;
function ensureHook(event, command, timeout) {
  if (!Array.isArray(data.hooks[event])) data.hooks[event] = [];
  for (const entry of data.hooks[event]) {
    for (const hook of (entry && entry.hooks) || []) {
      if (hook && hook.command === command) return;
    }
  }
  const hook = { type: 'command', command };
  if (timeout !== undefined) hook.timeout = timeout;
  data.hooks[event].push({ matcher: '', hooks: [hook] });
  changed = true;
}
ensureHook('UserPromptSubmit', `bash ${scriptsDir}/check-rooms-hook.sh`);
ensureHook('Stop', `bash ${scriptsDir}/claudecode-stop-resume.sh`);
// Self-arming room agent: on every session start (startup/resume/compact) the
// hook injects instructions to re-arm the notification-file Monitor, read any
// backlog, and keep the self-paced room loop running.
ensureHook('SessionStart', `bash ${scriptsDir}/session-bootstrap.sh`, 10);
if (changed) {
  fs.copyFileSync(settingsPath, settingsPath + '.bak');
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
  console.log('Hooks installed.');
} else {
  console.log('Hooks already present.');
}
JS
node "$HOOK_JS" "$SETTINGS" "$SCRIPTS_DIR"
rm -f "$HOOK_JS"

# ---------------------------------------------------------------------------
# 7. start daemon in tmux
# ---------------------------------------------------------------------------
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  yellow "Restarting daemon in tmux session $TMUX_SESSION"
  tmux kill-session -t "$TMUX_SESSION"
fi
tmux new-session -d -s "$TMUX_SESSION" \
  "cd $INSTALL_DIR && node bin/iak-mcp-daemon.mjs"
sleep 2
# The daemon exits immediately if mcp.confirmations has no room configured,
# which is exactly the state of a freshly written starter config. Check
# instead of printing "Daemon: tmux session 'iak-mcp'" over an empty tmux.
DAEMON_UP=0
tmux has-session -t "$TMUX_SESSION" 2>/dev/null && DAEMON_UP=1

# 7b. Optional: peer-wake team-watchdog (opt-in; needs a roster).
# OFF by default — enable with IAK_INSTALL_WATCHDOG=1. Revives sleeping
# colleagues whose IDEs run on THIS machine; see README "Peer wake".
if [ "${IAK_INSTALL_WATCHDOG:-0}" = "1" ]; then
  if [ "$OS" != "Darwin" ]; then
    # The watchdog itself (scripts/team-watchdog.mjs) is plain node, but the
    # only supervisor wired up here is a launchd LaunchAgent, which does not
    # exist off macOS. A systemd unit is not written yet — say so instead of
    # pretending.
    yellow "IAK_INSTALL_WATCHDOG=1 ignored: the watchdog supervisor is a launchd"
    yellow "LaunchAgent and this is not macOS. Run it under your own supervisor:"
    echo "    node $INSTALL_DIR/scripts/team-watchdog.mjs"
    echo "  (roster: $INSTALL_DIR/config/watchdog-roster.json)"
  else
    ROSTER_FILE="$INSTALL_DIR/config/watchdog-roster.json"
    if [ ! -f "$ROSTER_FILE" ]; then
      yellow "IAK_INSTALL_WATCHDOG=1 but no roster at $ROSTER_FILE — skipping."
      echo "  Create one from the example, then re-run with IAK_INSTALL_WATCHDOG=1:"
      echo "    sed \"s|REPLACE_WITH_IAK_ROOT|$INSTALL_DIR|g\" \\"
      echo "      $INSTALL_DIR/config/watchdog-roster.example.json > $ROSTER_FILE"
      echo "    # then edit handles/paths for the agents whose IDEs run on THIS Mac"
    else
      LA_DIR="$HOME/Library/LaunchAgents"
      PLIST="$LA_DIR/com.thinkoff.iak-team-watchdog.plist"
      mkdir -p "$LA_DIR"
      sed "s|REPLACE_WITH_IAK_ROOT|$INSTALL_DIR|g" \
        "$INSTALL_DIR/examples/team-watchdog-launchd.plist" > "$PLIST"
      yellow "Installed peer-wake watchdog LaunchAgent → $PLIST"
      if launchctl list 2>/dev/null | grep -q com.thinkoff.iak-team-watchdog; then
        echo "  Already loaded. Reload after edits:"
        echo "    launchctl unload \"$PLIST\" && launchctl load \"$PLIST\""
      elif launchctl load "$PLIST" 2>/dev/null; then
        green "  Loaded (KeepAlive; reads $ROSTER_FILE)."
      else
        yellow "  Load it manually: launchctl load \"$PLIST\""
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 8. report
# ---------------------------------------------------------------------------
lan_ip() {
  if [ "$OS" = "Darwin" ]; then
    ipconfig getifaddr en0 2>/dev/null && return 0
    ipconfig getifaddr en1 2>/dev/null && return 0
  else
    # Ask the routing table which source address would be used to reach the
    # outside world. Works without any interface being named en0.
    if command -v ip >/dev/null 2>&1; then
      ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i+1); exit }}' \
        | grep . && return 0
    fi
    if command -v hostname >/dev/null 2>&1; then
      hostname -I 2>/dev/null | awk '{print $1}' | grep . && return 0
    fi
  fi
  echo "127.0.0.1"
}
LAN_IP="$(lan_ip)"
LAN_URL="http://${LAN_IP}:8788"

echo
green "Installed."
echo
if [ "$DAEMON_UP" = 1 ]; then
  bold "Daemon: running in tmux session '$TMUX_SESSION'"
  echo "  - logs: tmux attach -t $TMUX_SESSION"
  echo "  - listener: $LAN_URL"
else
  yellow "Daemon: NOT running."
  echo "  It exited straight away, which is what happens when the config has no"
  echo "  channel configured yet. Fill these in, then re-run this installer"
  echo "  (or: tmux new -d -s $TMUX_SESSION 'cd $INSTALL_DIR && node bin/iak-mcp-daemon.mjs'):"
  echo "    - $CONFIG → poller.api_key"
  echo "    - $CONFIG → mcp.confirmations.room"
  echo "  To see why it exited:"
  echo "    cd $INSTALL_DIR && node bin/iak-mcp-daemon.mjs"
  echo "  Once running it listens on: $LAN_URL"
fi
if [ "$LAN_IP" = "127.0.0.1" ]; then
  echo
  yellow "Could not work out this machine's LAN IP, so the URL above is loopback"
  yellow "and your phone will NOT reach it. Find the real address and use that:"
  if [ "$OS" = "Darwin" ]; then
    echo "    ipconfig getifaddr en0"
  else
    echo "    ip -4 addr show scope global"
  fi
fi
echo
bold "CodeWatch on phone — pair via QR or manual paste:"
echo "  - URL: $LAN_URL"
echo
if command -v qrencode >/dev/null 2>&1; then
  echo "Scan from CodeWatch (Account tab → Scan Pairing QR):"
  echo
  qrencode -t UTF8 "$LAN_URL"
  echo
else
  if [ -n "$PKG" ]; then
    yellow "Tip: $(pkg_install_hint "$PKG") $(pkg_name "$PKG" qrencode)  →  re-run installer to get a scannable QR for CodeWatch pairing."
  else
    yellow "Tip: install qrencode  →  re-run installer to get a scannable QR for CodeWatch pairing."
  fi
fi
echo
if [ "$OS" = "Darwin" ]; then
  bold "macOS Accessibility (one-time, for osascript-based desktop-app wake):"
  echo "  - System Settings → Privacy & Security → Accessibility"
  echo "  - Add: /usr/bin/osascript (or whatever process runs the daemon — usually iTerm/Terminal/tmux)"
else
  bold "Wake path on Linux:"
  echo "  - The osascript GUI-wake scripts are macOS-only and do nothing here."
  echo "  - The Stop-hook resume path (claudecode-stop-resume.sh, wired above)"
  echo "    is portable and is what delivers room messages on this box."
fi
echo
bold "Edit your config:"
echo "  - $CONFIG"
echo "  - poller.api_key + mcp.confirmations.room are required for chat-reply support"
echo "  - for your agent to hear its rooms, also set poller.rooms + poller.handle, then:"
echo "      cd $INSTALL_DIR && node bin/cli.mjs rooms watch"
echo "  - step by step: $INSTALL_DIR/README.md (Quick Start)"
