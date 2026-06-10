#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0

/**
 * CLI for user-intent-kit.
 *
 * Usage:
 *   intent get                    - show current intent state
 *   intent profile                - show user profile
 *   intent patch <key>=<value>... - update device state
 *   intent heartbeat              - send heartbeat
 *   intent derived                - show derived state only
 *
 * Environment:
 *   INTENT_API_BASE  - API base URL (default: https://antfarm.world/api/v1)
 *   INTENT_API_KEY   - Ant Farm API key (required)
 *   INTENT_USER_ID   - User ID (required)
 *   INTENT_DEVICE_ID - Device ID for writes (required for patch/heartbeat)
 */

import { IntentClient } from '../src/client.js';

const baseUrl = process.env.INTENT_API_BASE || 'https://antfarm.world/api/v1';
const apiKey = process.env.INTENT_API_KEY;
const userId = process.env.INTENT_USER_ID;
const deviceId = process.env.INTENT_DEVICE_ID;

if (!apiKey || !userId) {
  console.error('Missing INTENT_API_KEY or INTENT_USER_ID environment variables');
  process.exit(1);
}

const client = new IntentClient({ baseUrl, apiKey, userId, deviceId });
const command = process.argv[2] || 'get';

try {
  switch (command) {
    case 'get': {
      const intent = await client.getIntent();
      console.log(JSON.stringify(intent, null, 2));
      break;
    }
    case 'profile': {
      const profile = await client.getProfile();
      console.log(JSON.stringify(profile, null, 2));
      break;
    }
    case 'derived': {
      const derived = await client.getDerived();
      console.log(JSON.stringify(derived, null, 2));
      break;
    }
    case 'patch': {
      const fields = {};
      for (const arg of process.argv.slice(3)) {
        const [key, ...rest] = arg.split('=');
        const value = rest.join('=');
        // Try to parse as JSON value, fall back to string
        try { fields[key] = JSON.parse(value); } catch { fields[key] = value; }
      }
      if (Object.keys(fields).length === 0) {
        console.error('Usage: intent patch key=value [key=value ...]');
        process.exit(1);
      }
      const result = await client.patchDevice(fields);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'heartbeat': {
      await client.heartbeat();
      console.log('OK');
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: get, profile, derived, patch, heartbeat');
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (err.status) console.error(`Status: ${err.status}`);
  if (err.body) console.error(`Body: ${err.body}`);
  process.exit(1);
}
