// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Both historical import paths must resolve to the SAME objects. The trees
// were full copies that drifted (27 Aug 2026): the CLI imported the stale
// team-relay copy, so fixes in src/adapters/ never reached the running
// poller. Identity (===) here means a fork cannot happen silently again.
import { groupmindAdapter as canonical } from '../src/adapters/groupmind.mjs';
import { groupmindAdapter as viaTeamRelay } from '../src/team-relay/adapters/groupmind.mjs';
import { UnifiedPoller as CanonicalPoller } from '../src/unified-poller.mjs';
import { UnifiedPoller as TeamRelayPoller } from '../src/team-relay/unified-poller.mjs';
import { discordAdapter as discordA } from '../src/adapters/discord.mjs';
import { discordAdapter as discordB } from '../src/team-relay/adapters/discord.mjs';
import { xforAdapter as xforA } from '../src/adapters/xfor.mjs';
import { xforAdapter as xforB } from '../src/team-relay/adapters/xfor.mjs';
import { commentsAdapter as commentsA } from '../src/adapters/comments.mjs';
import { commentsAdapter as commentsB } from '../src/team-relay/adapters/comments.mjs';

describe('single adapter tree', () => {
  it('team-relay paths are identity re-exports of the canonical tree', () => {
    assert.equal(viaTeamRelay, canonical, 'groupmind adapter forked');
    assert.equal(TeamRelayPoller, CanonicalPoller, 'UnifiedPoller forked');
    assert.equal(discordB, discordA, 'discord adapter forked');
    assert.equal(xforB, xforA, 'xfor adapter forked');
    assert.equal(commentsB, commentsA, 'comments adapter forked');
  });

  it('the CLI-visible adapter carries the reply-context fix', () => {
    // The precise failure this PR kills: reply handling merged into
    // src/adapters/ while the CLI ran a copy without it.
    const ev = viaTeamRelay.normalize(
      { id: 'b', from: 'petrus', body: 'spec this', reply_to: { id: 'a', from: '@x', body: 'target' }, _room: 'r' },
      { poller: { handle: '@test' } }
    );
    assert.equal(ev.payload.reply_to, 'a');
    assert.equal(ev.payload.reply_target.from, '@x');
  });
});
