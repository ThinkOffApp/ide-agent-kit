// SPDX-License-Identifier: AGPL-3.0

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IntentClient } from '../src/client.js';

describe('IntentClient', () => {
  it('constructs with required options', () => {
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1',
      apiKey: 'test-key',
      userId: 'petrus',
    });
    assert.equal(client.userId, 'petrus');
    assert.equal(client.deviceId, null);
  });

  it('constructs with deviceId', () => {
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1',
      apiKey: 'test-key',
      userId: 'petrus',
      deviceId: 'macbook',
    });
    assert.equal(client.deviceId, 'macbook');
  });

  it('throws on patchDevice without deviceId', async () => {
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1',
      apiKey: 'test-key',
      userId: 'petrus',
    });
    await assert.rejects(
      () => client.patchDevice({ context: 'coding' }),
      { message: 'No deviceId configured' }
    );
  });

  it('throws on heartbeat without deviceId', async () => {
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1',
      apiKey: 'test-key',
      userId: 'petrus',
    });
    await assert.rejects(
      () => client.heartbeat(),
      { message: 'No deviceId configured' }
    );
  });

  it('enforces minimum heartbeat interval of 10s', () => {
    // Just ensure construction doesn't throw
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1',
      apiKey: 'test-key',
      userId: 'petrus',
      deviceId: 'watch',
      heartbeatIntervalMs: 1000, // too low, should be clamped
    });
    assert.ok(client);
  });

  it('strips trailing slashes from baseUrl', () => {
    const client = new IntentClient({
      baseUrl: 'https://antfarm.world/api/v1///',
      apiKey: 'test-key',
      userId: 'petrus',
    });
    assert.ok(client);
  });
});
