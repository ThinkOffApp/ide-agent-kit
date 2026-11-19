// fetchJson must not throw or log header values when request construction fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJson, publicFetchErrorMessage } from '../src/common/http.mjs';
import { pollComments } from '../src/comment-poller.mjs';

const SENTINEL = 'REVIEW_FAKE_TOKEN\nMID';

test('invalid header value becomes request failed, without the token', async () => {
  await assert.rejects(
    () => fetchJson('https://example.invalid/x', { token: SENTINEL }),
    { message: 'request failed' },
  );
});

test('publicFetchErrorMessage strips unexpected text', () => {
  assert.equal(publicFetchErrorMessage(new Error('HTTP 401')), 'HTTP 401');
  assert.equal(publicFetchErrorMessage(new Error('request timed out')), 'request timed out');
  assert.equal(
    publicFetchErrorMessage(new Error(`Headers.append: "token ${SENTINEL}" is an invalid header value.`)),
    'request failed',
  );
});

test('comment poller log on a bad token does not contain the token', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'iak-http-token-'));
  const origError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    await pollComments({
      comments: {
        github: {
          token: SENTINEL,
          repos: [{ owner: 'example', repo: 'repo', number: 1, type: 'issues' }],
        },
        seen_file: join(tmp, 'seen.txt'),
      },
    });
  } finally {
    console.error = origError;
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(logs.length >= 1);
  for (const line of logs) {
    assert.equal(line.includes('REVIEW_FAKE_TOKEN'), false);
    assert.equal(line.includes('\nMID'), false);
    assert.match(line, /failed: request failed$/);
  }
});
