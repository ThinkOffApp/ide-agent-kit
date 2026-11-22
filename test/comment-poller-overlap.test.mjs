// Overlapping async polls must not deliver the same comment twice.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCommentPoller } from '../src/comment-poller.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'iak-comment-overlap-'));
const origFetch = globalThis.fetch;
const origLog = console.log;

after(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  rmSync(tmp, { recursive: true, force: true });
});

test('slow fetch plus short interval delivers a new comment once', async () => {
  let calls = 0;
  console.log = () => {};
  globalThis.fetch = async () => {
    const n = ++calls;
    if (n === 1) return { ok: true, json: async () => [] };
    await delay(65);
    return {
      ok: true,
      json: async () => [{ id: 123, body: 'review fixture', user: { login: 'fixture' } }],
    };
  };

  const queuePath = join(tmp, 'queue.jsonl');
  const handle = await startCommentPoller({
    interval: 0.015,
    config: {
      queue: { path: queuePath },
      tmux: { ide_session: '-invalid' },
      comments: {
        seen_file: join(tmp, 'seen.txt'),
        github: {
          token: 'fake',
          repos: [{ owner: 'example', repo: 'repo', number: 1, type: 'issues' }],
        },
      },
    },
  });

  await delay(200);
  handle.stop();
  await delay(80);

  let rows = [];
  try {
    rows = readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    rows = [];
  }
  assert.equal(rows.filter((r) => r.comment_id === '123').length, 1);
});
