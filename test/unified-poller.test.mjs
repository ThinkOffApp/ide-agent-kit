// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedPoller } from '../src/unified-poller.mjs';
import { groupmindAdapter } from '../src/adapters/groupmind.mjs';
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

  it('creates a poller with groupmind adapter', () => {
    const config = { poller: { rooms: [], api_key: 'test', handle: '@test' } };
    const poller = new UnifiedPoller(groupmindAdapter, config);
    assert.equal(poller.adapter.name, 'groupmind');
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
  it('groupmind adapter has required methods', () => {
    assert.equal(typeof groupmindAdapter.fetch, 'function');
    assert.equal(typeof groupmindAdapter.getKey, 'function');
    assert.equal(typeof groupmindAdapter.shouldSkip, 'function');
    assert.equal(typeof groupmindAdapter.normalize, 'function');
    assert.equal(typeof groupmindAdapter.formatLine, 'function');
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

  it('groupmind adapter returns empty with no rooms', async () => {
    const result = await groupmindAdapter.fetch({ poller: { rooms: [] } });
    assert.deepEqual(result, []);
  });

  it('groupmind adapter skips self messages', () => {
    const config = { poller: { handle: '@claudemm' } };
    assert.equal(groupmindAdapter.shouldSkip({ from: '@claudemm' }, config), true);
    assert.equal(groupmindAdapter.shouldSkip({ from: 'claudemm' }, config), true);
    assert.equal(groupmindAdapter.shouldSkip({ from: 'petrus' }, config), false);
  });

  it('discord adapter skips self messages', () => {
    const config = { discord: { self_id: '123' } };
    assert.equal(discordAdapter.shouldSkip({ author: { id: '123' } }, config), true);
    assert.equal(discordAdapter.shouldSkip({ author: { id: '456' } }, config), false);
  });

  it('groupmind adapter normalizes messages', () => {
    const msg = { id: 'msg1', from: 'petrus', body: 'hello', created_at: '2026-01-01T00:00:00Z', _room: 'test-room' };
    const event = groupmindAdapter.normalize(msg, {});
    assert.equal(event.source, 'groupmind');
    assert.equal(event.kind, 'groupmind.message.created');
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

describe('groupmind reply targets', () => {
  // A reply's meaning lives in its target (Aug 27 2026: "spec this" was
  // interpreted by guess because every agent surface dropped reply_to).
  const target = { id: 'aaa', from: '@claudeMB', body: 'the AgentOS fleet message', created_at: '2026-08-27T08:06:00Z' };
  const reply = { id: 'bbb', from: 'petrus', body: 'Great! Please spec this.', reply_to: 'aaa', created_at: '2026-08-27T08:41:00Z', _room: 'thinkoff-development' };

  it('normalize carries reply_to and resolved reply_target', () => {
    const withTarget = { ...reply, _replyTarget: { from: target.from, body: target.body } };
    const ev = groupmindAdapter.normalize(withTarget, { poller: { handle: '@test' } });
    assert.equal(ev.payload.reply_to, 'aaa');
    assert.equal(ev.payload.reply_target.from, '@claudeMB');
  });

  it('formatLine shows the resolved reply target', () => {
    const withTarget = { ...reply, _replyTarget: { from: target.from, body: target.body } };
    const ev = groupmindAdapter.normalize(withTarget, { poller: { handle: '@test' } });
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(line.includes('in reply to @claudeMB'), line);
    assert.ok(line.includes('the AgentOS fleet message'), line);
    assert.ok(!line.includes('\n'), 'single line: ' + JSON.stringify(line));
  });

  it('formatLine marks an unresolved reply as a reply, never freestanding', () => {
    const ev = groupmindAdapter.normalize(reply, { poller: { handle: '@test' } });
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(line.includes('a reply'), line);
    assert.ok(line.includes('bbb') === false, 'target id, not own id');
    assert.ok(line.includes('aaa'), line);
  });

  it('non-replies keep the plain single-line format', () => {
    const ev = groupmindAdapter.normalize(target, { poller: { handle: '@test' } });
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(!line.includes('reply'), line);
    assert.ok(!line.includes('\n'), line);
  });
});

describe('groupmind reply_to polymorphism and single-line format', () => {
  // reply_to arrives as a bare id string OR as { id, from, body } depending on
  // the client. Found reviewing #70 (merged before the fix): the object form
  // printed "[object Object]". And formatLine must stay ONE physical line —
  // notification readers split on newlines, so a two-line entry became two
  // half-events.
  it('object-form reply_to resolves and payload carries the id string', () => {
    const reply = { id: 'bbb', from: 'petrus', body: 'spec this', created_at: '2026-08-27T08:41:00Z',
      reply_to: { id: 'aaa', from: '@claudeMB', body: 'the AgentOS fleet message' },
      _replyTarget: { from: '@claudeMB', body: 'the AgentOS fleet message' }, _replyToId: 'aaa' };
    const ev = groupmindAdapter.normalize(reply, { poller: { handle: '@test' } });
    assert.equal(ev.payload.reply_to, 'aaa');
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(!line.includes('[object Object]'), line);
    assert.ok(!line.includes('\n'), 'must be one physical line: ' + JSON.stringify(line));
    assert.ok(line.includes('in reply to @claudeMB'), line);
  });

  it('object-form outside the window never prints [object Object] and stays one line', () => {
    const reply = { id: 'bbb', from: 'petrus', body: 'spec this', created_at: '2026-08-27T08:41:00Z',
      reply_to: { id: 'zzz' }, _replyToId: 'zzz' };
    const ev = groupmindAdapter.normalize(reply, { poller: { handle: '@test' } });
    assert.equal(ev.payload.reply_to, 'zzz');
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(!line.includes('[object Object]'), line);
    assert.ok(!line.includes('\n'), line);
    assert.ok(line.includes('zzz'), line);
  });

  it('string-form reply with resolved target is one line with the annotation inline', () => {
    const reply = { id: 'bbb', from: 'petrus', body: 'Great! Please spec this.', created_at: '2026-08-27T08:41:00Z',
      reply_to: 'aaa', _replyToId: 'aaa',
      _replyTarget: { from: '@claudeMB', body: 'the AgentOS fleet message' } };
    const ev = groupmindAdapter.normalize(reply, { poller: { handle: '@test' } });
    const line = groupmindAdapter.formatLine(ev);
    assert.ok(!line.includes('\n'), line);
    assert.ok(line.includes('in reply to @claudeMB'), line);
  });
});
