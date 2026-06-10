# user-intent-kit

Cross-device user intent state for AI agents.

## What is user intent in AgentOS?

The [AgentOS paper](https://arxiv.org/abs/2603.08938) (Liu et al., 2026) proposes replacing traditional OS interfaces with an Agent Kernel that interprets user intent and orchestrates agents. Applications become composable skills. Natural language becomes the primary interface.

A key piece the paper describes but doesn't solve: **user intent state**. This is the real-time understanding of what the user is trying to do, what context they're in, and how agents should adapt. When you're in a meeting, your agents should know to keep responses short and silent. When you're coding, they can be verbose. When you're driving, voice-only.

## Why multi-device?

The AgentOS paper thinks from a single-machine perspective. But people use multiple devices: a laptop for work, a phone in their pocket, a smartwatch on their wrist. Each device has unique signals:

- **Watch:** wrist raise, heart rate, screen glance, calendar sync
- **Laptop:** active application, current task, IDE context
- **Phone:** location, motion (driving/walking/still), notification state

No single device sees the full picture. The watch knows you raised your wrist. The laptop knows you're in a Zoom call. The phone knows you're at the office. Combined, these signals tell agents exactly how to reach you and what kind of response is appropriate.

We searched for existing solutions to this problem. AIOS (agiresearch) has account-based sync but no per-device signal merging. Agent-Kernel (ZJU) distributes agents across machines but doesn't share user context between devices. Google's A2A protocol handles agent-to-agent communication but not user state. Anthropic's MCP handles tool context but not device signals. A few early attempts exist (fepvenancio/crdt-agent) but nothing production-ready.

So we built our own.

## Design choices

### Two-layer architecture: Profile + Intent

User state splits naturally into two layers with different update frequencies:

**User Profile** (static, changes rarely): birthdate, physical characteristics, preferences for UI/food/brands, quiet hours, response style. Read once when an agent starts, cached locally. Think of it as a config file for your agents.

**User Intent** (live, updates every few seconds): which device is active, what app is in the foreground, whether you're in a meeting, what task you're working on, which agents are busy. This is the real-time dashboard that agents check before every response.

Separating them avoids polling static data on every request and keeps the live layer lightweight.

### CRDT-ready, starting simple

CRDTs (Conflict-free Replicated Data Types) allow multiple devices to edit state independently, even offline, and merge automatically when they reconnect. This matters because a smartwatch loses Bluetooth connectivity regularly.

For v0, we start with a simpler approach: last-writer-wins (LWW) per device slot, with per-field timestamps. Each device owns its own slot and only writes to it, so conflicts don't happen in practice. The server merges by reading all device slots together.

If offline merge becomes a real need (e.g., watch accumulates sensor readings while disconnected), the storage layer can upgrade to Yjs CRDT documents without changing the client API.

### API design

The API follows REST conventions on GroupMind:

- `GET /api/v1/profile/{user_id}` - read static profile
- `GET /api/v1/intent/{user_id}` - read merged intent state across all devices
- `PATCH /api/v1/intent/{user_id}/{device_id}` - partial update to a device slot (no accidental field wipes)
- `PATCH /api/v1/intent/{user_id}/agents/{agent_name}` - publish agent status

The server computes a `derived` object from raw device signals. Agents read this derived state instead of parsing raw signals themselves. It has two layers:

**Coarse fields** (v0, stable): `urgency_mode` (`normal` / `text-only` / `emergency-only`), `available_modalities` (`read` / `listen` / `speak`), `preferred_device`, `suppress_audio`. Good for quick "can I talk?" and "which device?" questions.

**Two-level state model** (v0.2+): `overall_state` + `reachability_mode`. The overall state is a human-readable life mode: `working`, `resting`, `meeting_people`, `outdoors`, `exercising`, `sleeping`, `unknown`, `transitioning`. Inside each state, `reachability_mode` tells the agent how interruptible the user is right now (for example `desktop` / `mobile_full_focus` / `watch_only` / `do_not_disturb` / `emergency_only`). The two-level model lets agents separate "where is the user?" from "how hard is it to reach them?" - a user can be `working` but `do_not_disturb`, or `resting` but `mobile_relaxed`. Raw sensor signals (watch HR, screen state, calendar, active app) stay as evidence inputs and feed into this derivation, never as user-facing states themselves.

Client helpers cover both layers: `client.isInMeeting()`, `client.shouldSuppressAudio()`, `client.preferredDevice()` for the coarse fields, and `client.overallState()`, `client.reachabilityMode()`, `client.isDreamingAllowed()`, `client.isLightDreamingOnly()` for the two-level model. Background-work gating in [ide-agent-kit](https://github.com/ThinkOffApp/ide-agent-kit) uses `isDreamingAllowed` / `isLightDreamingOnly` to decide when to run consolidation phases.

Heartbeats keep device and agent slots alive on a 900s TTL. Stale slots are excluded from derived state computation and surface in `stale_devices` / `stale_agents` so other agents can detect offline peers. The server deduplicates heartbeats within 5s to prevent write churn. The bundled `uik-daemon` (see [Running as a daemon](#running-as-a-daemon)) re-publishes both device and agent state on a 30s `POLL_INTERVAL_MS` cadence so neither slot expires while the daemon is running.

Full API spec with error codes, auth model, and integration details is on the [thinkoff-development scratchpad](https://groupmind.one) (pad 3be0e08c).

## Install

```bash
npm install user-intent-kit
```

No dependencies. Node.js >= 18.

## Running as a daemon

The `uik-daemon` bin publishes desktop state and agent heartbeats to the intent API on a 30s interval. It is the recommended way to keep your device and agent slots live on the dashboard.

```bash
export INTENT_API_KEY=xfb_your_key
export INTENT_USER_ID=petrus
export INTENT_AGENT_HANDLE=@claudemb
export INTENT_DEVICE_ID=macbook
npx uik-daemon
```

For a persistent setup under launchd (macOS) or systemd (Linux), see `examples/claudemb-launchd.plist` and `examples/claudemb-daemon.sh` which mirror a working production deployment. The pattern is:

1. A LaunchAgent plist that spawns a detached tmux session (decouples the daemon from your login shell).
2. A shell wrapper that exports the required env vars and execs `node bin/uik-daemon.js`.
3. Bootstrap with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<agent>.uik.plist`.

> Note: The older `examples/iak-integration.js` is a one-shot demo and will exit once its setInterval timer is unref'd. Use `uik-daemon` for long-running deployments.

## Quick start

```js
import { IntentClient } from 'user-intent-kit';

const client = new IntentClient({
  baseUrl: 'https://groupmind.one/api/v1',
  apiKey: 'xfb_your_key',
  userId: 'petrus',
  deviceId: 'macbook',
});

// Read current intent state
const intent = await client.getIntent();
console.log(intent.derived.urgency_mode); // "text-only" if in meeting

// Publish device state
await client.patchDevice({ context: 'coding', active_app: 'claude-code' });

// Check before responding
if (await client.shouldSuppressAudio()) {
  // Text-only response
}

// Auto-heartbeat to keep device slot alive
client.startHeartbeat();
```

## Adapters

Platform-specific adapters wrap the core `IntentClient` with ergonomic helpers.

### Included adapters

#### [IDE Agent Kit](https://github.com/ThinkOffApp/ide-agent-kit) (Node.js)

For IDE-connected agents that poll rooms and respond to messages.

```js
import { IntentClient, IAKAdapter } from 'user-intent-kit';

const client = new IntentClient({ baseUrl, apiKey, userId });
const ideAgentKit = new IAKAdapter(client, { agentHandle: '@claudemm' });

await ideAgentKit.publishStatus({ status: 'active', currentTask: 'reviewing PR #5' });
if (await ideAgentKit.shouldSuppressNudge()) return;
const hint = await ideAgentKit.getResponseHint();
```

#### OpenClaw (Node.js)

For [OpenClaw](https://github.com/AntfarmFinancial/openclaw) bots. Generates system prompt modifiers based on user intent state.

```js
import { IntentClient, OpenClawAdapter } from 'user-intent-kit';

const client = new IntentClient({ baseUrl, apiKey, userId });
const oc = new OpenClawAdapter(client);

const modifier = await oc.getPromptModifier();
// "User is in a meeting. Text only, be concise."
await oc.publishBotStatus('sally', { status: 'busy', task: 'transcribing call' });
```

An OpenClaw plugin is also included at `src/plugins/openclaw/` that hooks into `before_prompt_build` to inject intent context automatically.

#### Desktop (Node.js, macOS)

Detects the active window and infers user context (meeting, coding, browsing). Publishes state automatically on an interval.

```js
import { IntentClient, DesktopAdapter } from 'user-intent-kit';

const client = new IntentClient({ baseUrl, apiKey, userId, deviceId: 'macbook' });
const desktop = new DesktopAdapter(client);
desktop.start(); // background polling + publishing
```

Currently macOS only (uses `osascript` for active window detection). Linux and Windows adapters are welcome contributions.

#### Browser (Node.js / browser)

For web dashboards showing live intent state. Polls the API and calls back on each update.

```js
import { BrowserAdapter } from 'user-intent-kit/adapters/browser';
import { IntentClient } from 'user-intent-kit';

const client = new IntentClient({ baseUrl, apiKey, userId });
const browser = new BrowserAdapter(client, {
  onUpdate: (intent) => renderDashboard(intent),
  pollIntervalMs: 5000,
});
browser.start();
```

#### CLI

Command-line tool for reading and writing intent state. Useful for scripts and debugging.

```bash
npm install -g user-intent-kit

export INTENT_API_BASE=https://groupmind.one/api/v1
export INTENT_API_KEY=xfb_your_key
export INTENT_USER_ID=petrus
export INTENT_DEVICE_ID=macbook

intent get                     # show full intent state
intent profile                 # show user profile
intent derived                 # show derived state only
intent patch context=coding    # update device state
intent heartbeat               # send heartbeat
```

#### Swift (watchOS / iOS / macOS)

Native Swift client with async/await. Includes a `WatchAdapter` for Apple Watch with alert mode detection.

```swift
let client = IntentClient(
    baseURL: URL(string: "https://groupmind.one/api/v1")!,
    apiKey: "xfb_your_key",
    userId: "petrus",
    deviceId: "apple-watch"
)

let adapter = WatchAdapter(client: client)
try await adapter.publishState(wristRaise: true, heartRate: 72)
let mode = try await adapter.alertMode() // .full, .textOnly, or .silent
```

See `swift/` for the SPM package. Targets watchOS 9+, iOS 16+, macOS 13+.

#### Kotlin (Wear OS / Android)

Kotlin client using coroutines and `HttpURLConnection` (no external dependencies). Includes a `WatchAdapter` for Wear OS smartwatches.

```kotlin
val client = IntentClient(
    baseUrl = "https://groupmind.one/api/v1",
    apiKey = "xfb_your_key",
    userId = "petrus",
    deviceId = "wear-os-watch"
)

val adapter = WatchAdapter(client)
adapter.publishState(wristRaise = true, heartRate = 72)
val mode = adapter.alertMode() // FULL, TEXT_ONLY, or SILENT
```

See `kotlin/` for the Gradle project.

#### Python

Zero-dependency Python client using `urllib.request`. Threading-based heartbeat.

```python
from user_intent_kit import IntentClient

client = IntentClient(
    base_url="https://groupmind.one/api/v1",
    api_key="xfb_your_key",
    user_id="petrus",
    device_id="server",
)

intent = client.get_intent()
print(intent["derived"]["urgency_mode"])

client.start_heartbeat()  # background thread
```

See `python/` for the package. Requires Python >= 3.9.

### Adapters we'd like to see

Community contributions welcome. Some ideas:

- **Linux Desktop** - X11/Wayland active window detection (similar to the macOS Desktop adapter)
- **Windows Desktop** - Win32 API for active window and focus tracking
- **Home Assistant** - Publish room presence, lighting state, and smart home context
- **Slack/Teams** - Detect meeting status, DND mode, presence from workplace chat
- **Calendar** - Feed upcoming events into intent state (busy, free, focus time)
- **Location** - Geofencing-based context (home, office, commuting)
- **Health sensors** - Continuous HR, stress level, sleep state from wearables
- **Vehicle** - CarPlay/Android Auto integration for driving context
- **Accessibility** - Screen reader state, magnification, input method preferences

To build an adapter: wrap `IntentClient`, call `patchDevice()` with your signals, and optionally read `getIntent()` to adapt behavior. See any included adapter for the pattern.

## Releases

Current: **v0.2.2** (2026-04-08). See [CHANGELOG.md](CHANGELOG.md) for the per-release changelog. The kit is not yet published on npm; install from source or via the GitHub repository URL until the first npm release lands.

Highlights since v0.1.0:
- **v0.2.0**: added `bin/uik-daemon.js`, the persistent background daemon that publishes device and agent heartbeats. Exposed as the `uik-daemon` npm bin and runnable via `npx uik-daemon`.
- **v0.2.1**: daemon docs in README (`Running as a daemon`). Fixed silent-exit in `examples/iak-integration.js` so the demo no longer terminates when its `setInterval` is unref'd.
- **v0.2.2**: `uik-daemon` now re-publishes agent status on the same `POLL_INTERVAL_MS` cadence as the desktop adapter heartbeat. Before this fix the agent slot would expire after its TTL even though the device slot stayed fresh. Caught while dogfooding on the Mac mini.

## License

AGPL-3.0
