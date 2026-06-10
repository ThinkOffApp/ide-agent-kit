#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0

/**
 * uik-daemon — persistent UIK adapter runner.
 *
 * Publishes desktop state and agent heartbeats to the intent API.
 * Intended to be launched via launchd/systemd/tmux as a long-running
 * background daemon.
 *
 * Environment:
 *   INTENT_API_BASE    (default: https://antfarm.world/api/v1)
 *   INTENT_API_KEY     required
 *   INTENT_USER_ID     required
 *   INTENT_AGENT_HANDLE  default: @agent
 *   INTENT_DEVICE_ID     default: hostname
 *   POLL_INTERVAL_MS     default: 30000
 */

import { hostname } from 'node:os';
import { IntentClient, IAKAdapter, DesktopAdapter } from '../src/index.js';

const baseUrl = process.env.INTENT_API_BASE || 'https://antfarm.world/api/v1';
const apiKey = process.env.INTENT_API_KEY;
const userId = process.env.INTENT_USER_ID;
const agentHandle = process.env.INTENT_AGENT_HANDLE || '@agent';
const deviceId = process.env.INTENT_DEVICE_ID || hostname();
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 30000);

if (!apiKey || !userId) {
  console.error('uik-daemon: INTENT_API_KEY and INTENT_USER_ID required');
  process.exit(1);
}

const client = new IntentClient({ baseUrl, apiKey, userId, deviceId });
const iak = new IAKAdapter(client, { agentHandle });
const desktop = new DesktopAdapter(client, { pollIntervalMs });

desktop.start();
await iak.publishStatus({ status: 'active', currentTask: null });

// Re-publish agent status on the same interval as the desktop heartbeat,
// otherwise the agent slot expires after its TTL while the device stays
// fresh — caught dogfooding on 2026-04-08.
const agentTimer = setInterval(() => {
  iak.publishStatus({ status: 'active', currentTask: null }).catch(() => {});
}, pollIntervalMs);

console.log(`uik-daemon: device=${deviceId} agent=${agentHandle} interval=${pollIntervalMs}ms`);

const shutdown = async (sig) => {
  console.log(`uik-daemon: ${sig}, shutting down`);
  clearInterval(agentTimer);
  desktop.stop();
  await iak.publishStatus({ status: 'offline', currentTask: null }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the event loop alive
setInterval(() => {}, 1 << 30);
