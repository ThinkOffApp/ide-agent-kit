import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLinearEvent,
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

  it('falls back through assignee, creator, then unknown', () => {
    assert.equal(buildLinearEvent(issue()).actor.login, 'Petrus');
    assert.equal(buildLinearEvent(issue({ assignee: null })).actor.login, 'claudemm');
    assert.equal(
      buildLinearEvent(issue({ assignee: null, creator: null })).actor.login,
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
});
