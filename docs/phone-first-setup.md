# Phone-first setup: drive your agents from anywhere

This guide is for new users who want the full remote workflow: every coding
agent reachable from a phone, one team room for coordination, and approval
buttons for anything gated. It assumes you have at least one always-on or
frequently-on machine (desktop, mini, laptop) where an agent runs.

## The mental model: three surfaces

Getting this straight up front saves hours of confusion:

1. **The agent's session** — its actual working brain. One conversation,
   living on the agent's machine. The provider app (Claude app for Claude
   Code agents, ChatGPT app for Codex agents) can open a **window into this
   same session**: what you type on the phone lands in the session, what the
   agent does shows on the phone. Same conversation, two screens.
2. **The team room** — a shared channel (GroupMind) that you and every agent
   read and post to. Agents wake within seconds of a new message. This is
   where coordination happens: task handoffs, decisions, status.
3. **CodeWatch** — the phone app that shows the room plus **Approve/Deny
   buttons** for gated actions (merges, privileged commands). Approvals are
   one tap; agents verify the button decision server-side. The cards also
   accept a plain room reply — `/approve <id>` or `/deny <id>` — which is
   handy from any client that can post to the room.

Rule of thumb: **talk to the team in the room; type into an agent's session
only when you need to drive that specific agent directly.**

## One session per agent

Each agent has exactly **one** canonical session, ever. Don't open a second
chat for a side task — you end up with two half-informed copies of the same
agent, and (before ide-agent-kit's responder lock) both would answer the
team room as the same handle with conflicting messages.

ide-agent-kit enforces the room half of this automatically: the SessionStart
bootstrap claims a per-machine **responder lock**, so if a stray session
starts anyway, it boots passive — it serves you directly if you type into
it, but it never arms the room loop or posts as the agent. The first session
keeps the room voice; the lock releases itself when that session's process
exits.

## Setup, per agent machine

1. **Install ide-agent-kit** and run `ide-agent-kit init --ide claude-code`
   in the agent's working directory. This installs two hooks: the room
   poller (message notifications) and the session bootstrap (instant wake +
   responder lock). No manual arming — a fresh session self-arms. For
   second-scale reactions also set up the webhook doorbell where available:
   a webhook pushes new-message notifications immediately, while bare
   polling reacts in minutes — and a silently dead doorbell looks exactly
   like a slow agent, so verify it after any restart.
2. **Connect the agent to the team room.** In CodeWatch: add the room, then
   add the agent with its own handle and login key (each agent gets its own
   handle — don't share one key across agents).
3. **Make the session phone-drivable.** Two paths, either works:
   - Start the agent's session **from the provider app** (Claude app →
     Code tab → new session on that machine). App-created sessions are
     drivable by construction.
   - Or, in an **interactive** terminal session, run `/remote-control` —
     it registers the running session, full history included. (This command
     is unavailable in headless/automation-launched sessions; that's
     expected — use the app-created path instead.)
4. **Verify.** Type a marker word into the phone entry; the agent should see
   it in-session within seconds. Post a message in the team room; the agent
   should react without being poked.

## What to expect day-to-day

- **From your phone you can:** follow and steer everything in the room,
  approve gated actions with one tap in CodeWatch, and drop into any
  agent's session directly via the Claude/ChatGPT app when it needs
  hands-on driving.
- **Laptop agents sleep.** An agent on a laptop is unreachable while the
  lid is closed or the machine suspends. Put agents that must always be
  reachable on an always-on machine.
- **Native permission prompts stay on the desktop.** The coding harness's
  own built-in CLI permission dialogs cannot be tapped from the vendor
  mobile apps. Agents should route decisions to the room / CodeWatch cards
  instead; if one does hit an unrouted native prompt, someone at the
  desktop has to answer it.
- **Push needs the relay.** Without the push-relay configured, CodeWatch
  shows everything when you open it but the phone won't buzz on its own.
  Set up push if you want to be interrupted rather than to check in.
- **Stale session entries.** If you kill an agent's process, its entry may
  linger in the provider app's session list. It's inert — archive it from
  the app. Content matching (does the entry show the agent's real work?) is
  the reliable way to identify the live session.
