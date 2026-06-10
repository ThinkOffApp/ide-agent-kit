#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0

/**
 * Example: integrate user-intent-kit with IDE Agent Kit.
 *
 * Run alongside your IAK rooms watch process.
 * Publishes agent status and desktop state to the intent API.
 *
 * Usage:
 *   export INTENT_API_KEY=xfb_your_key
 *   export INTENT_USER_ID=petrus
 *   export INTENT_AGENT_HANDLE=@claudemm
 *   node examples/iak-integration.js
 */

import { IntentClient, IAKAdapter, DesktopAdapter } from '../src/index.js';

const baseUrl = process.env.INTENT_API_BASE || 'https://antfarm.world/api/v1';
const apiKey = process.env.INTENT_API_KEY;
const userId = process.env.INTENT_USER_ID;
const agentHandle = process.env.INTENT_AGENT_HANDLE || '@claudemm';
const deviceId = process.env.INTENT_DEVICE_ID || 'macmini';

if (!apiKey || !userId) {
  console.error('Missing INTENT_API_KEY or INTENT_USER_ID');
  process.exit(1);
}

// Intent client for this device
const client = new IntentClient({
  baseUrl,
  apiKey,
  userId,
  deviceId,
});

// IAK adapter for agent status
const iak = new IAKAdapter(client, { agentHandle });

// Desktop adapter for active window detection
const desktop = new DesktopAdapter(client, { pollIntervalMs: 30000 });

// Start publishing desktop state + heartbeat
desktop.start();
console.log(`Desktop adapter started for device: ${deviceId}`);

// Publish agent as active
await iak.publishStatus({ status: 'active', currentTask: null });
console.log(`Agent ${agentHandle} published as active`);

// Example: check before nudging
const suppress = await iak.shouldSuppressNudge();
console.log(`Suppress nudges: ${suppress}`);

const hint = await iak.getResponseHint();
console.log(`Response hint:`, hint);

// Keep running. The DesktopAdapter's internal setInterval is intentionally
// unref'd so library embedders can exit cleanly — we add a referenced
// keep-alive here so this example works as a long-running process.
console.log('Running... (Ctrl+C to stop)');
const keepAlive = setInterval(() => {}, 1 << 30);
process.on('SIGINT', async () => {
  clearInterval(keepAlive);
  desktop.stop();
  await iak.publishStatus({ status: 'offline', currentTask: null }).catch(() => {});
  console.log('Stopped.');
  process.exit(0);
});
