// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { pollComments, startCommentPoller } from '../src/comment-poller.mjs';

describe('comment-poller', () => {
  it('exports pollComments function', () => {
    assert.equal(typeof pollComments, 'function');
  });

  it('exports startCommentPoller function', () => {
    assert.equal(typeof startCommentPoller, 'function');
  });

  it('pollComments returns empty array with no config', async () => {
    const result = await pollComments({});
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('pollComments returns empty array with empty sources', async () => {
    const result = await pollComments({
      comments: {
        moltbook: { posts: [] },
        github: { repos: [] },
        seen_file: '/tmp/iak-test-comment-seen.txt'
      }
    });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});
