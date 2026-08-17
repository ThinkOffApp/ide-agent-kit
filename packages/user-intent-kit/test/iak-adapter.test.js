// SPDX-License-Identifier: AGPL-3.0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IAKAdapter } from '../src/adapters/iak.js';

/** Captures what the adapter would PATCH, without touching the network. */
function fakeClient({ deviceId = 'mac-mini' } = {}) {
  const patches = [];
  return {
    deviceId,
    patches,
    async patchAgent(name, fields) {
      patches.push({ name, fields });
    },
  };
}

test('a caller that omits machine still names its host', async () => {
  // src/intent.mjs constructs the adapter with only agentHandle. `host`
  // replaces the stored value wholesale, so publishing it without a machine
  // name would overwrite a known hostname with anonymous load readings.
  const client = fakeClient({ deviceId: 'mac-mini' });
  await new IAKAdapter(client, { agentHandle: '@claudemm' }).publishStatus({});

  const { host } = client.patches[0].fields;
  assert.equal(host.machine, 'mac-mini');
});

test('an explicit machine name wins over the client default', async () => {
  const client = fakeClient({ deviceId: 'from-client' });
  await new IAKAdapter(client, { agentHandle: '@a', machine: 'explicit' }).publishStatus({});

  assert.equal(client.patches[0].fields.host.machine, 'explicit');
});

test('a read-only client omits the machine rather than publishing null', async () => {
  const client = fakeClient({ deviceId: null });
  await new IAKAdapter(client, { agentHandle: '@a' }).publishStatus({});

  const { host } = client.patches[0].fields;
  assert.ok(!('machine' in host), 'published a machine key with no name behind it');
});

test('publishes host as an object, never a bare string', async () => {
  const client = fakeClient();
  await new IAKAdapter(client, { agentHandle: '@a' }).publishStatus({});

  const { host } = client.patches[0].fields;
  assert.equal(typeof host, 'object');
  assert.notEqual(host, null);
});

test('still publishes status and last_task alongside the vitals', async () => {
  const client = fakeClient();
  await new IAKAdapter(client, { agentHandle: '@claudemm' }).publishStatus({
    status: 'active',
    currentTask: 'reviewing',
  });

  const { name, fields } = client.patches[0];
  assert.equal(name, 'claudemm');
  assert.equal(fields.status, 'active');
  assert.equal(fields.last_task, 'reviewing');
});
