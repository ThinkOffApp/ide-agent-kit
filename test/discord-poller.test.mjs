// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pollDiscord, startDiscordPoller } from '../src/discord-poller.mjs';

describe('discord-poller', () => {
  it('exports pollDiscord function', () => {
    assert.equal(typeof pollDiscord, 'function');
  });

  it('exports startDiscordPoller function', () => {
    assert.equal(typeof startDiscordPoller, 'function');
  });

  it('pollDiscord returns empty array with no config', () => {
    const result = pollDiscord({});
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('pollDiscord returns empty array with empty channels', () => {
    const result = pollDiscord({
      discord: {
        channels: [],
        seen_file: '/tmp/iak-test-discord-seen.txt'
      }
    });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});
