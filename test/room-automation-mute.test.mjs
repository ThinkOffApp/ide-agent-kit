// Emergency-only must silence agent chatter WITHOUT silencing replies to petrus.
//
// The two failures this guards are opposite, and getting one right by breaking
// the other is worse than the bug: agent-triggered posts should go quiet, and a
// reply to a command HE typed must always land, because a withheld answer is
// indistinguishable from a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// markSent() first, with a long rate-limit interval in the config, so canSend()
// is false for every case here and NO case reaches the network. Without this the
// "still answers petrus" case actually curls groupmind: 470 ms, flaky, and one
// typo away from posting test strings into his room. A suppressed result and a
// rate-limited result are both "not withheld by the mute gate", which is what
// these assertions are about.
const { markSent } = await import('../src/rate-limiter.mjs');
const OFFLINE = { poller: { owner_handle: 'petrus' }, rate_limit: { message_interval_sec: 3600 } };

const { executeActionForTest } = await import('../src/room-automation.mjs')
  .then((m) => ({ executeActionForTest: m.executeActionForTest }))
  .catch(() => ({ executeActionForTest: null }));

test('the mute gate is exported for testing', () => {
  assert.ok(executeActionForTest, 'executeAction must be reachable from a test');
});

test('emergency-only withholds an agent-triggered post', () => {
  const r = executeActionForTest(
    { type: 'post', body: 'chatter' },
    { from: '@somebot', body: 'hi' },
    'key', OFFLINE, true,
  );
  assert.equal(r.status, 'suppressed', 'agent-triggered post withheld');
});

markSent(); // burn the rate-limit budget: keeps every case below offline

test('emergency-only STILL answers petrus', () => {
  const r = executeActionForTest(
    { type: 'post', body: 'reply' },
    { from: 'petrus', body: '/lead status' },
    'key', OFFLINE, true,
  );
  assert.notEqual(r.status, 'suppressed', 'his own command must always get an answer');
});

test('normal mode posts for everyone (control)', () => {
  const r = executeActionForTest(
    { type: 'post', body: 'chatter' },
    { from: '@somebot', body: 'hi' },
    'key', OFFLINE, false,
  );
  assert.notEqual(r.status, 'suppressed', 'nothing is withheld when not muted');
});

test('the owner match ignores @ and case', () => {
  for (const who of ['@Petrus', 'PETRUS', '@petrus']) {
    const r = executeActionForTest(
      { type: 'post', body: 'reply' }, { from: who, body: 'x' },
      'key', { ...OFFLINE, poller: { owner_handle: '@Petrus' } }, true,
    );
    assert.notEqual(r.status, 'suppressed', `${who} must be recognised as the owner`);
  }
});
