# OpenClaw Plugin Setup

## Install

Copy the plugin directory into your OpenClaw extensions:

```bash
cp -r src/plugins/openclaw ~/.openclaw/extensions/user-intent/
```

## Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "user-intent": {
        "enabled": true,
        "config": {
          "apiBaseUrl": "https://antfarm.world/api/v1",
          "apiKey": "xfb_your_key",
          "userId": "petrus",
          "timeoutMs": 5000
        }
      }
    }
  }
}
```

## What it does

The plugin hooks into the OpenClaw response flow:

1. **before_prompt_build**: reads user profile + live intent state, injects context like "User is in a meeting. Text only, be concise." into the system prompt.

2. **session_start**: publishes agent as "active" to the intent API so other devices know a bot is working.

3. **agent_end**: publishes agent as "idle" and invalidates the cached intent state.

All intent API calls have a 5s timeout and fail silently. If the intent API is down, bots respond normally without modification.
