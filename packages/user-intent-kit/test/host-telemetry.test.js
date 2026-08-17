// SPDX-License-Identifier: AGPL-3.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'node:os';

import { collectHostTelemetry } from '../src/host-telemetry.js';

test('never publishes a placeholder for a sensor it could not read', () => {
  const host = collectHostTelemetry({ machine: 'test-box' });

  // The whole contract. A zero here renders in the dashboard as a real
  // reading, so an unreadable sensor must leave the key absent entirely.
  for (const [key, value] of Object.entries(host)) {
    assert.notEqual(value, null, `${key} published as null`);
    assert.notEqual(value, undefined, `${key} published as undefined`);
  }
  assert.ok(!('temp_c' in host) || typeof host.temp_c === 'number');
  assert.ok(!('watts_w' in host) || typeof host.watts_w === 'number');
});

test('passes the machine name through', () => {
  assert.equal(collectHostTelemetry({ machine: 'mac-mini' }).machine, 'mac-mini');
});

test('omits the machine name rather than inventing one', () => {
  assert.ok(!('machine' in collectHostTelemetry()));
});

test('normalises load against core count so devices are comparable', () => {
  const host = collectHostTelemetry();
  if (!('load_pct' in host)) return; // platform without load average

  assert.ok(Number.isFinite(host.cpu_count) && host.cpu_count > 0);
  assert.ok(Number.isFinite(host.load_1m) && host.load_1m >= 0);
  assert.ok(host.load_pct >= 0);

  // 1.8 on a 10-core box is ~18%, on a 4-core Pi ~45%: the percentage is the
  // only figure that means the same thing on every device in the fleet.
  const expected = Math.round((host.load_1m / host.cpu_count) * 100);
  assert.equal(host.load_pct, expected);
});

test('reports a plausible temperature or none at all', () => {
  const host = collectHostTelemetry();
  if ('temp_c' in host) {
    assert.ok(host.temp_c > 0 && host.temp_c <= 150, `implausible temp ${host.temp_c}`);
  }
});

test('macOS omits temperature rather than reporting zero', { skip: platform() !== 'darwin' }, () => {
  // powermetrics needs root and the daemon deliberately does not use sudo, so
  // a Mac has no temperature to publish. It must be absent, not 0.
  const host = collectHostTelemetry({ machine: 'mac-mini' });
  assert.ok(!('temp_c' in host), 'macOS published a temperature it cannot read');
  assert.ok('load_1m' in host, 'macOS should still publish load');
});

test('does not throw when the host exposes nothing useful', () => {
  assert.doesNotThrow(() => collectHostTelemetry({}));
});
