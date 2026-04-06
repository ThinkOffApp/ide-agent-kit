// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isRelevantDirectMessage } from '../src/team-relay/room-poller.mjs';

describe('room-poller direct messages', () => {
  it('accepts a new DM addressed to the configured handle', () => {
    const message = {
      id: 'dm-1',
      from: '@petrus',
      to: '@CodexMB',
      type: 'dm',
      metadata: { user: { id: 'user-1' } }
    };

    assert.equal(isRelevantDirectMessage(message, { selfHandle: '@CodexMB' }), true);
  });

  it('rejects messages sent by self', () => {
    const message = {
      id: 'dm-2',
      from: '@CodexMB',
      to: '@CodexMB',
      type: 'dm'
    };

    assert.equal(isRelevantDirectMessage(message, { selfHandle: '@CodexMB' }), false);
  });

  it('rejects DMs addressed to another recipient', () => {
    const message = {
      id: 'dm-3',
      from: '@petrus',
      to: '@SomeoneElse',
      type: 'dm'
    };

    assert.equal(isRelevantDirectMessage(message, { selfHandle: '@CodexMB' }), false);
  });

  it('can require human-authored DMs', () => {
    const botMessage = {
      id: 'dm-4',
      from: '@antigravity',
      to: '@CodexMB',
      type: 'dm',
      metadata: { dm: { to_user_id: 'user-1' } }
    };

    assert.equal(isRelevantDirectMessage(botMessage, { selfHandle: '@CodexMB', humanOnly: true }), false);
    assert.equal(isRelevantDirectMessage(botMessage, { selfHandle: '@CodexMB', humanOnly: false }), true);
  });
});
