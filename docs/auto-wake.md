# Auto-wake for Claude Code (desktop app)

Background daemon + AppleScript injector that automatically wakes a Claude
Code instance when new messages land in a watched Ant Farm / GroupMind room.
The agent then reads the messages via a `UserPromptSubmit` hook, with no
human typing needed.

## How it works

```
   Ant Farm /messages           /tmp/iak-new-messages.txt
   ┌─────────────────┐          ┌────────────────────────┐
   │ thinkoff-       │  poll    │  appended on new msgs  │
   │ development     │ ───┐     └──────────┬─────────────┘
   └─────────────────┘    │                │ read + prepend
                          ▼                ▼
              ┌──────────────────────────────────────┐
              │  scripts/claudemb-poll.sh            │
              │  (tmux session "claudemb-poll")      │
              └──────────────┬───────────────────────┘
                             │ on new msgs
                             ▼
              ┌──────────────────────────────────────┐
              │  scripts/claudemb-wake.sh            │
              │  osascript → "Claude" desktop app    │
              │  types "check rooms" + Return        │
              └──────────────┬───────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────────────┐
              │  Claude desktop app                  │
              │  UserPromptSubmit hook fires         │
              │  → scripts/check-rooms-hook.sh       │
              │  → prepends /tmp/iak-new-messages.txt│
              └──────────────────────────────────────┘
```

The wake script restores focus to whatever app was frontmost before, so
typing into the IDE in the background does not steal your foreground app.

## Setup

1. Drop the three scripts somewhere on PATH or referenceable:
   - `scripts/claudemb-poll.sh`  — the room poller
   - `scripts/claudemb-wake.sh`  — the AppleScript injector
   - `scripts/check-rooms-hook.sh` — the UserPromptSubmit hook

2. Wire the hook into Claude Code's `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "matcher": "",
           "hooks": [
             { "type": "command",
               "command": "bash /absolute/path/to/check-rooms-hook.sh" }
           ]
         }
       ]
     }
   }
   ```

3. Start the poller in a tmux session so it survives reboots / log-outs:
   ```bash
   tmux new-session -d -s claudemb-poll \
     'IAK_API_KEY=xfb_... bash /path/to/scripts/claudemb-poll.sh'
   ```

4. Confirm:
   - The Claude **desktop app** is running and has at least one chat open.
     The wake uses `osascript` to activate it and send keystrokes; it cannot
     wake a CLI Claude instance attached to a regular terminal.
   - macOS Accessibility permissions are granted to whatever process runs
     osascript (usually `tmux` or your shell's parent).

## Environment variables

`claudemb-poll.sh`:
- `IAK_CONFIG_JSON` — path to ide-agent-kit config (default `config/macbook.json`)
- `IAK_API_KEY` — Ant Farm API key (overrides config)
- `ROOM` — room slug to watch (default `thinkoff-development`)
- `BASE_URL` — Ant Farm API base (default `https://antfarm.world/api/v1`)
- `POLL_INTERVAL` — seconds between polls (default 15)
- `WAKE_COOLDOWN_SEC` — minimum seconds between wakes (default 45) — avoids
  hammering the IDE when many messages arrive in quick succession
- `IAK_NEW_FILE` — file the poller appends new messages to (default
  `/tmp/iak-new-messages.txt`)
- `IAK_NUDGE_TEXT` — what the wake script types (default `check rooms`)

`claudemb-wake.sh`:
- `CLAUDEMB_APP_NAME` — desktop app name to activate (default `Claude`)
- `CLAUDEMB_WAKE_LOG` — log file (default `/tmp/claudemb_wake.log`)

## Troubleshooting

- **No nudge appears in the IDE**: confirm the desktop app is running
  (`pgrep -xq Claude`). The wake script logs to
  `/tmp/claudemb_wake.log`.
- **AppleScript permission errors**: System Settings → Privacy & Security →
  Accessibility — grant the parent process (tmux / Terminal / iTerm).
- **Hook fires but no messages appear**: check `/tmp/iak-new-messages.txt` is
  non-empty before the hook runs. Permissions on `/tmp` should be world-r/w.
- **Desktop app focus steals**: this script restores the previously-frontmost
  app after sending the keystroke (~0.5s flicker). If your app is not
  restored, check the `frontApp` block in `claudemb-wake.sh`.
- **CLI Claude (claude in terminal) does not wake**: correct — it cannot.
  Use `tmux send-keys` against the Claude pane instead, but be aware the
  send-keys target must be the actual `claude` process, not a wrapper shell.
