// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleKey, isSelfSender, resolveSelfHandle } from '../src/common/handles.mjs';
import { groupmindAdapter } from '../src/adapters/groupmind.mjs';
import { xforAdapter } from '../src/adapters/xfor.mjs';

describe('handles', () => {
  it('handleKey normalizes case, whitespace, and leading @', () => {
    assert.equal(handleKey('@claudeMB'), 'claudemb');
    assert.equal(handleKey(' claudeMB '), 'claudemb');
    assert.equal(handleKey('@claudemb'), 'claudemb');
    assert.equal(handleKey(''), '');
    assert.equal(handleKey(undefined), '');
  });

  it('matches the registered casing against a lowercase config handle', () => {
    // The masked-bug case: registered handle is @claudeMB (capital MB),
    // config holds @claudemb, and GroupMind returns the registered casing
    // in message `from` fields.
    assert.equal(isSelfSender('@claudeMB', '@claudemb'), true);
    assert.equal(isSelfSender('claudeMB', '@claudemb'), true);
    assert.equal(isSelfSender('@claudemb', '@claudeMB'), true);
  });

  it('does not match other agents', () => {
    assert.equal(isSelfSender('@claudemm', '@claudemb'), false);
    assert.equal(isSelfSender('@petrus', '@claudemb'), false);
  });

  it('never matches when the self handle is empty', () => {
    assert.equal(isSelfSender('@anyone', ''), false);
    assert.equal(isSelfSender('', ''), false);
  });

  it('resolveSelfHandle prefers the IAK_SELF_HANDLE env override', () => {
    process.env.IAK_SELF_HANDLE = '@override';
    try {
      assert.equal(
        resolveSelfHandle({ explicit: '@cli', config: { poller: { handle: '@cfg' } } }),
        '@override'
      );
    } finally {
      delete process.env.IAK_SELF_HANDLE;
    }
  });

  it('resolveSelfHandle falls back explicit → config → @unknown', () => {
    delete process.env.IAK_SELF_HANDLE;
    assert.equal(
      resolveSelfHandle({ explicit: '@cli', config: { poller: { handle: '@cfg' } } }),
      '@cli'
    );
    assert.equal(resolveSelfHandle({ config: { poller: { handle: '@cfg' } } }), '@cfg');
    assert.equal(resolveSelfHandle({}), '@unknown');
  });
});

describe('adapter self-skip', () => {
  it('groupmind shouldSkip is case-insensitive', () => {
    const config = { poller: { handle: '@claudemb' } };
    assert.equal(groupmindAdapter.shouldSkip({ from: '@claudeMB' }, config), true);
    assert.equal(groupmindAdapter.shouldSkip({ from: 'claudeMB' }, config), true);
    assert.equal(groupmindAdapter.shouldSkip({ from: '@petrus' }, config), false);
  });

  it('groupmind shouldSkip honors the IAK_SELF_HANDLE env override', () => {
    process.env.IAK_SELF_HANDLE = '@claudeMB';
    try {
      assert.equal(groupmindAdapter.shouldSkip({ from: '@claudemb' }, {}), true);
      assert.equal(groupmindAdapter.shouldSkip({ from: '@claudemm' }, {}), false);
    } finally {
      delete process.env.IAK_SELF_HANDLE;
    }
  });

  it('xfor shouldSkip is case-insensitive', () => {
    const config = { xfor: { handle: '@ClaudeMB' } };
    assert.equal(xforAdapter.shouldSkip({ author: { handle: '@claudemb' } }, config), true);
    assert.equal(xforAdapter.shouldSkip({ author: { handle: '@other' } }, config), false);
    // No configured handle → never skip
    assert.equal(xforAdapter.shouldSkip({ author: { handle: '@claudemb' } }, {}), false);
  });
});
