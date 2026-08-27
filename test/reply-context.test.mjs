// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replyIdOf, embeddedTargetOf, resolveReplyTargets, replyAnnotation } from '../src/common/reply-context.mjs';

describe('reply-context (shared by both pollers)', () => {
  it('replyIdOf handles string, object, and absent forms', () => {
    assert.equal(replyIdOf('abc'), 'abc');
    assert.equal(replyIdOf({ id: 'abc', from: 'x' }), 'abc');
    assert.equal(replyIdOf({ id: 123 }), '123');
    assert.equal(typeof replyIdOf({ id: 123 }), 'string');
    assert.equal(replyIdOf(null), null);
    assert.equal(replyIdOf(undefined), null);
    assert.equal(replyIdOf(''), null);
    assert.equal(replyIdOf({}), null);
  });

  it('embeddedTargetOf extracts from the rich object form only', () => {
    assert.deepEqual(embeddedTargetOf({ id: 'a', from: '@x', body: 'hello' }), { from: '@x', body: 'hello' });
    assert.equal(embeddedTargetOf('a'), null);
    assert.equal(embeddedTargetOf({ id: 'a' }), null);
  });

  it('resolveReplyTargets resolves in-batch targets', () => {
    const msgs = [
      { id: 'aaa', from: '@claudeMB', body: 'the fleet message' },
      { id: 'bbb', from: 'petrus', body: 'spec this', reply_to: 'aaa' }
    ];
    resolveReplyTargets(msgs);
    assert.equal(msgs[1]._replyToId, 'aaa');
    assert.equal(msgs[1]._replyTarget.from, '@claudeMB');
  });

  it('resolveReplyTargets falls back to the embedded object outside the window', () => {
    const msgs = [
      { id: 'bbb', from: 'petrus', body: 'spec this', reply_to: { id: 'old1', from: '@claudeMB', body: 'ancient message' } }
    ];
    resolveReplyTargets(msgs);
    assert.equal(msgs[0]._replyToId, 'old1');
    assert.equal(msgs[0]._replyTarget.body, 'ancient message');
  });

  it('replyAnnotation is single-line and empty for non-replies', () => {
    assert.equal(replyAnnotation(null, null), '');
    const resolved = replyAnnotation('aaa', { from: '@x', body: 'multi\nline\nbody' });
    assert.ok(resolved.includes('in reply to @x'));
    assert.ok(!resolved.includes('\n'), resolved);
    const unresolved = replyAnnotation('aaa', null);
    assert.ok(unresolved.includes('aaa'));
    assert.ok(!unresolved.includes('\n'), unresolved);
  });
});
