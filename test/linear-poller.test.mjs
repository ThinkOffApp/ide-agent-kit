import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLinearEvent,
  pollOnce,
  readLinearToken,
  startLinearPoller
} from '../src/team-relay/linear-poller.mjs';

const issue = (over = {}) => ({
  id: 'abc',
  identifier: 'THI-42',
  title: 'Something broke',
  url: 'https://linear.app/thinkoff/issue/THI-42/something-broke',
  priority: 2,
  createdAt: '2026-08-27T06:00:00.000Z',
  updatedAt: '2026-08-27T06:00:00.000Z',
  state: { name: 'Backlog', type: 'backlog' },
  assignee: { displayName: 'Petrus' },
  creator: { displayName: 'claudemm' },
  team: { key: 'THI' },
  ...over
});

describe('linear poller', () => {
  it('emits the same event shape the webhook server produces', () => {
    const e = buildLinearEvent(issue());
    // Consumers downstream switch on these keys. A Linear event that is missing
    // one would be dropped silently rather than loudly, so assert the contract.
    for (const key of ['trace_id', 'source', 'kind', 'timestamp', 'actor', 'refs', 'payload']) {
      assert.ok(key in e, `missing ${key}`);
    }
    assert.equal(e.source, 'linear');
    assert.equal(e.refs.issue_identifier, 'THI-42');
    assert.equal(e.payload.state, 'Backlog');
  });

  it('calls an unchanged issue created, and a touched one updated', () => {
    assert.equal(buildLinearEvent(issue()).kind, 'linear.issue.created');
    const touched = issue({ updatedAt: '2026-08-27T07:00:00.000Z' });
    assert.equal(buildLinearEvent(touched).kind, 'linear.issue.updated');
  });

  it('falls back to unknown when a created issue has no creator', () => {
    assert.equal(buildLinearEvent(issue()).actor.login, 'claudemm');
    assert.equal(
      buildLinearEvent(issue({ creator: null })).actor.login,
      'unknown'
    );
  });

  it('truncates a long title so one issue cannot flood the relay', () => {
    const e = buildLinearEvent(issue({ title: 'x'.repeat(5000) }));
    assert.equal(e.payload.title.length, 300);
  });

  it('returns null rather than throwing when the token file is absent', () => {
    assert.equal(readLinearToken(join(tmpdir(), 'definitely-not-here.token')), null);
  });

  it('reads a token from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linear-'));
    const f = join(dir, 'linear.token');
    writeFileSync(f, '  lin_api_example  \n');
    assert.equal(readLinearToken(f), 'lin_api_example');
  });

  it('reports an update actor as unknown rather than blaming the assignee', () => {
    // The assignee is not who made the change. Attributing an edit to whoever
    // happens to be assigned is the exact "who did what" error this feed exists
    // to avoid, so an update says unknown and puts the names in the payload.
    const touched = issue({ updatedAt: '2026-08-27T07:00:00.000Z' });
    const e = buildLinearEvent(touched);
    assert.equal(e.kind, 'linear.issue.updated');
    assert.equal(e.actor.login, 'unknown');
    assert.equal(e.payload.assignee, 'Petrus');
    assert.equal(e.payload.creator, 'claudemm');
  });

  it('credits the creator on a created issue, where it is genuinely the actor', () => {
    const e = buildLinearEvent(issue({ assignee: { displayName: 'Someone Else' } }));
    assert.equal(e.kind, 'linear.issue.created');
    assert.equal(e.actor.login, 'claudemm');
  });

  it('leaves the cursor unmoved when the consumer throws, so the issue retries', async () => {
    // Losing an update silently is worse than emitting it twice.
    const since = '2026-08-27T05:00:00.000Z';
    const nodes = [issue({ updatedAt: '2026-08-27T06:00:00.000Z' })];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { issues: { nodes } } })
    });
    try {
      await assert.rejects(
        () => pollOnce('tok', since, () => { throw new Error('consumer down'); }),
        /consumer down/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('is wired into `iak serve`, not just exported', async () => {
    // A poller nothing calls emits nothing. Assert the CLI actually starts it.
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../bin/cli.mjs', import.meta.url), 'utf8');
    assert.match(cli, /import \{ startLinearPoller \}/);
    assert.match(cli, /startLinearPoller\(/);
  });

  it('starts disabled instead of throwing when unconfigured', () => {
    // Most installs have no Linear. An optional feed must never stop the relay
    // from coming up.
    const handle = startLinearPoller(
      { token_file: join(tmpdir(), 'definitely-not-here.token') },
      () => {}
    );
    assert.equal(typeof handle.stop, 'function');
    handle.stop();
  });

  it('drains every page, so issues tied at a page boundary are not skipped forever', async () => {
    // The filter is strictly updatedAt > cursor. If a poll stopped at a page
    // boundary, any issue sharing that last timestamp would be excluded from
    // the NEXT poll too, and lost permanently rather than merely delayed.
    const tied = '2026-08-27T06:00:00.000Z';
    const page1 = [issue({ identifier: 'THI-1', updatedAt: tied })];
    const page2 = [issue({ identifier: 'THI-2', updatedAt: tied })];
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      call++;
      const first = call === 1;
      return {
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: first ? page1 : page2,
              pageInfo: { hasNextPage: first, endCursor: first ? 'cur1' : null }
            }
          }
        })
      };
    };
    try {
      const seen = [];
      const { count } = await pollOnce('tok', '2026-08-27T05:00:00.000Z', (e) => {
        seen.push(e.refs.issue_identifier);
      });
      assert.equal(count, 2);
      assert.deepEqual(seen, ['THI-1', 'THI-2']);
      assert.equal(call, 2, 'should have fetched the second page');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops at maxPages and holds the cursor so the next tick resumes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [issue({ updatedAt: '2026-08-27T06:00:00.000Z' })],
            pageInfo: { hasNextPage: true, endCursor: 'always-more' }
          }
        }
      })
    });
    try {
      const { count } = await pollOnce('tok', '2026-08-27T05:00:00.000Z', () => {}, { maxPages: 3 });
      assert.equal(count, 3, 'guard should stop the loop rather than spin');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats identical create/update timestamps as created, and any drift as updated', () => {
    // Documents the invariant codexmb asked about: the heuristic is equality on
    // the exact strings Linear returns. Sub-second drift means updated, which is
    // the safe direction: a real edit is never mislabelled as a creation.
    assert.equal(buildLinearEvent(issue()).kind, 'linear.issue.created');
    const drift = issue({ updatedAt: '2026-08-27T06:00:00.001Z' });
    assert.equal(buildLinearEvent(drift).kind, 'linear.issue.updated');
  });
});
