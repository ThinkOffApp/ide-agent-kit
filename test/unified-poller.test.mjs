// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedPoller } from '../src/unified-poller.mjs';
import { antfarmAdapter } from '../src/adapters/antfarm.mjs';
import { discordAdapter } from '../src/adapters/discord.mjs';
import { xforAdapter } from '../src/adapters/xfor.mjs';
import { commentsAdapter } from '../src/adapters/comments.mjs';
import { loadSeenIds, saveSeenIds } from '../src/common/seen-ids.mjs';
import { nudgeTmux, readAndClearNotifications } from '../src/common/notify.mjs';
import { appendEvent, appendEvents } from '../src/common/event-queue.mjs';

describe('unified-poller', () => {
  it('exports UnifiedPoller class', () => {
    assert.equal(typeof UnifiedPoller, 'function');
  });

  it('creates a poller with antfarm adapter', () => {
    const config = { poller: { rooms: [], api_key: 'test', handle: '@test' } };
    const poller = new UnifiedPoller(antfarmAdapter, config);
    assert.equal(poller.adapter.name, 'antfarm');
  });

  it('creates a poller with discord adapter', () => {
    const config = { discord: { channels: [] } };
    const poller = new UnifiedPoller(discordAdapter, config);
    assert.equal(poller.adapter.name, 'discord');
  });

  it('creates a poller with xfor adapter', () => {
    const config = { xfor: { api_key: 'test', handle: '@test' } };
    const poller = new UnifiedPoller(xforAdapter, config);
    assert.equal(poller.adapter.name, 'xfor');
  });

  it('creates a poller with comments adapter', () => {
    const config = { comments: { moltbook: { posts: [] }, github: { repos: [] } } };
    const poller = new UnifiedPoller(commentsAdapter, config);
    assert.equal(poller.adapter.name, 'comments');
  });
});

describe('adapters', () => {
  it('antfarm adapter has required methods', () => {
    assert.equal(typeof antfarmAdapter.fetch, 'function');
    assert.equal(typeof antfarmAdapter.getKey, 'function');
    assert.equal(typeof antfarmAdapter.shouldSkip, 'function');
    assert.equal(typeof antfarmAdapter.normalize, 'function');
    assert.equal(typeof antfarmAdapter.formatLine, 'function');
  });

  it('discord adapter has required methods', () => {
    assert.equal(typeof discordAdapter.fetch, 'function');
    assert.equal(typeof discordAdapter.getKey, 'function');
    assert.equal(typeof discordAdapter.shouldSkip, 'function');
    assert.equal(typeof discordAdapter.normalize, 'function');
    assert.equal(typeof discordAdapter.formatLine, 'function');
  });

  it('xfor adapter has required methods', () => {
    assert.equal(typeof xforAdapter.fetch, 'function');
    assert.equal(typeof xforAdapter.getKey, 'function');
    assert.equal(typeof xforAdapter.shouldSkip, 'function');
    assert.equal(typeof xforAdapter.normalize, 'function');
    assert.equal(typeof xforAdapter.formatLine, 'function');
  });

  it('comments adapter has required methods', () => {
    assert.equal(typeof commentsAdapter.fetch, 'function');
    assert.equal(typeof commentsAdapter.getKey, 'function');
    assert.equal(typeof commentsAdapter.shouldSkip, 'function');
    assert.equal(typeof commentsAdapter.normalize, 'function');
    assert.equal(typeof commentsAdapter.formatLine, 'function');
  });

  it('xfor adapter returns empty with no api key', async () => {
    const result = await xforAdapter.fetch({});
    assert.deepEqual(result, []);
  });

  it('antfarm adapter returns empty with no rooms', async () => {
    const result = await antfarmAdapter.fetch({ poller: { rooms: [] } });
    assert.deepEqual(result, []);
  });

  it('antfarm adapter skips self messages', () => {
    const config = { poller: { handle: '@claudemm' } };
    assert.equal(antfarmAdapter.shouldSkip({ from: '@claudemm' }, config), true);
    assert.equal(antfarmAdapter.shouldSkip({ from: 'claudemm' }, config), true);
    assert.equal(antfarmAdapter.shouldSkip({ from: 'petrus' }, config), false);
  });

  it('discord adapter skips self messages', () => {
    const config = { discord: { self_id: '123' } };
    assert.equal(discordAdapter.shouldSkip({ author: { id: '123' } }, config), true);
    assert.equal(discordAdapter.shouldSkip({ author: { id: '456' } }, config), false);
  });

  it('antfarm adapter normalizes messages', () => {
    const msg = { id: 'msg1', from: 'petrus', body: 'hello', created_at: '2026-01-01T00:00:00Z', _room: 'test-room' };
    const event = antfarmAdapter.normalize(msg, {});
    assert.equal(event.source, 'antfarm');
    assert.equal(event.kind, 'antfarm.message.created');
    assert.equal(event.actor.login, 'petrus');
    assert.equal(event.payload.body, 'hello');
    assert.equal(event.room, 'test-room');
  });

  it('xfor adapter normalizes posts', () => {
    const msg = { id: 'post1', author: { handle: 'bot1' }, content: 'test post', created_at: '2026-01-01T00:00:00Z', _type: 'post' };
    const event = xforAdapter.normalize(msg);
    assert.equal(event.source, 'xfor');
    assert.equal(event.kind, 'xfor.post.created');
    assert.equal(event.actor.login, 'bot1');
  });
});

describe('common/seen-ids', () => {
  it('exports loadSeenIds and saveSeenIds', () => {
    assert.equal(typeof loadSeenIds, 'function');
    assert.equal(typeof saveSeenIds, 'function');
  });

  it('loadSeenIds returns empty set for missing file', () => {
    const ids = loadSeenIds('/tmp/nonexistent-iak-test-seen.txt');
    assert.equal(ids.size, 0);
  });
});

describe('common/notify', () => {
  it('exports nudgeTmux and readAndClearNotifications', () => {
    assert.equal(typeof nudgeTmux, 'function');
    assert.equal(typeof readAndClearNotifications, 'function');
  });
});

describe('common/event-queue', () => {
  it('exports appendEvent and appendEvents', () => {
    assert.equal(typeof appendEvent, 'function');
    assert.equal(typeof appendEvents, 'function');
  });
});
