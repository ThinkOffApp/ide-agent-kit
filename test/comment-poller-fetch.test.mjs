// Comment pollers must GET with fetch, token in a header, no child process.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollComments } from '../src/comment-poller.mjs';
import { pollComments as idePollComments } from '../src/ide/comment-poller.mjs';
import { commentsAdapter } from '../src/adapters/comments.mjs';
import { nudgeTmux as fromUtils } from '../src/utils.mjs';
import { nudgeTmux as fromNotify } from '../src/common/notify.mjs';

const SECRET = 'test-github-token';
let seenFile;
let tmp;
let origFetch;
const calls = [];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'iak-comment-fetch-'));
  seenFile = join(tmp, 'seen.txt');
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: { ...(opts.headers || {}) } });
    return {
      ok: true,
      json: async () => [],
    };
  };
});

after(() => {
  globalThis.fetch = origFetch;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('utils.nudgeTmux is the shared helper', () => {
  assert.equal(fromUtils, fromNotify);
});

test('ide/comment-poller re-exports the canonical poller', () => {
  assert.equal(idePollComments, pollComments);
});

test('GitHub poll puts the token in a header and never on a command line', async () => {
  calls.length = 0;
  const comments = await pollComments({
    comments: {
      github: {
        token: SECRET,
        repos: [{ owner: 'ThinkOffApp', repo: 'ide-agent-kit', number: 1, type: 'issues' }],
      },
      seen_file: seenFile,
    },
  });
  assert.deepEqual(comments, []);
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(c.headers.Authorization, `token ${SECRET}`);
    assert.equal(c.url.includes(SECRET), false);
  }
  const pollerSrc = readFileSync(new URL('../src/comment-poller.mjs', import.meta.url), 'utf8');
  const ideSrc = readFileSync(new URL('../src/ide/comment-poller.mjs', import.meta.url), 'utf8');
  const adapterSrc = readFileSync(new URL('../src/adapters/comments.mjs', import.meta.url), 'utf8');
  for (const src of [pollerSrc, ideSrc, adapterSrc]) {
    assert.equal(src.includes('execSync'), false);
    assert.equal(/\bcurl\b/.test(src), false);
  }
});

test('comments adapter uses the same header, no child process', async () => {
  calls.length = 0;
  const rows = await commentsAdapter.fetch({
    comments: {
      github: {
        token: SECRET,
        repos: [{ owner: 'ThinkOffApp', repo: 'ide-agent-kit', number: 1, type: 'issues' }],
      },
    },
  });
  assert.deepEqual(rows, []);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].headers.Authorization, `token ${SECRET}`);
});
