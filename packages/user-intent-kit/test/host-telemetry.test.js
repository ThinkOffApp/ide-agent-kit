// SPDX-License-Identifier: AGPL-3.0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectHostTelemetry } from '../src/host-telemetry.js';

/**
 * Fake sensors. The real ones only report whatever the machine running the
 * suite happens to expose, so on a Mac the Linux thermal path would never run
 * and "tests pass" would say nothing about the Pi.
 */
function sources({ platform = 'linux', load = [1.8, 1.7, 1.6], cpuCount = 4, zones = {} } = {}) {
  return {
    platform: () => platform,
    loadavg: () => load,
    cpuCount: () => cpuCount,
    listThermalZones: () => Object.keys(zones),
    readThermalZone: (zone) => {
      const value = zones[zone];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

// --- the omit-not-zero contract, the whole point of this module ---

test('a sensor reading 0 is omitted, not published as a temperature', () => {
  const host = collectHostTelemetry({ sources: sources({ zones: { thermal_zone0: '0' } }) });
  assert.ok(!('temp_c' in host), 'published a 0 C reading as if it were real');
});

test('an implausible sensor reading is omitted rather than published', () => {
  for (const bogus of ['999000', '-40000', 'not-a-number', '']) {
    const host = collectHostTelemetry({ sources: sources({ zones: { thermal_zone0: bogus } }) });
    assert.ok(!('temp_c' in host), `published implausible reading ${bogus}`);
  }
});

test('no field is ever published as null or undefined', () => {
  const host = collectHostTelemetry({ machine: 'pi', sources: sources({ zones: { thermal_zone0: '43500' } }) });
  for (const [key, value] of Object.entries(host)) {
    assert.notEqual(value, null, `${key} published as null`);
    assert.notEqual(value, undefined, `${key} published as undefined`);
  }
});

// --- Linux thermal zones (the Pi) ---

test('publishes CPU temperature from the Linux thermal zones', () => {
  const host = collectHostTelemetry({ sources: sources({ zones: { thermal_zone0: '43500' } }) });
  assert.equal(host.temp_c, 43.5);
});

test('reports the hottest plausible zone, ignoring implausible ones', () => {
  const host = collectHostTelemetry({
    sources: sources({
      zones: { thermal_zone0: '43500', thermal_zone1: '51200', thermal_zone2: '999000' },
    }),
  });
  assert.equal(host.temp_c, 51.2);
});

test('an unreadable zone does not lose the readable ones', () => {
  const host = collectHostTelemetry({
    sources: sources({
      zones: { thermal_zone0: new Error('EACCES'), thermal_zone1: '47000' },
    }),
  });
  assert.equal(host.temp_c, 47);
});

test('a host with no thermal zones at all publishes no temperature', () => {
  const bare = sources();
  bare.listThermalZones = () => {
    throw new Error('ENOENT');
  };
  const host = collectHostTelemetry({ sources: bare });
  assert.ok(!('temp_c' in host));
  assert.ok('load_1m' in host, 'a missing thermal sensor must not suppress load');
});

// --- platform gates ---

test('macOS publishes load but never a temperature', () => {
  // powermetrics needs root and the daemon deliberately does not use sudo.
  const host = collectHostTelemetry({
    machine: 'mac-mini',
    sources: sources({ platform: 'darwin', zones: { thermal_zone0: '43500' } }),
  });
  assert.ok(!('temp_c' in host), 'macOS published a temperature it cannot read');
  assert.equal(host.load_1m, 1.8);
});

test('Windows reports no load rather than a fake zero', () => {
  const host = collectHostTelemetry({ sources: sources({ platform: 'win32', load: [0, 0, 0] }) });
  assert.ok(!('load_1m' in host), 'published Node\'s [0,0,0] placeholder as real load');
  assert.ok(!('load_pct' in host));
});

// --- load normalisation ---

test('normalises load against core count so devices are comparable', () => {
  // The same 1.8 load means something different on each box.
  const pi = collectHostTelemetry({ sources: sources({ cpuCount: 4 }) });
  const mini = collectHostTelemetry({ sources: sources({ cpuCount: 10 }) });

  assert.equal(pi.load_pct, 45);
  assert.equal(mini.load_pct, 18);
  assert.equal(pi.load_1m, mini.load_1m, 'raw load is identical; only the percentage separates them');
});

test('publishes raw load even when core count is unavailable', () => {
  const noCpus = sources();
  noCpus.cpuCount = () => undefined;
  const host = collectHostTelemetry({ sources: noCpus });
  assert.equal(host.load_1m, 1.8);
  assert.ok(!('load_pct' in host), 'cannot normalise without a core count');
  assert.ok(!('cpu_count' in host));
});

// --- misc contract ---

test('passes the machine name through', () => {
  assert.equal(collectHostTelemetry({ machine: 'mac-mini', sources: sources() }).machine, 'mac-mini');
});

test('omits the machine name rather than inventing one', () => {
  assert.ok(!('machine' in collectHostTelemetry({ sources: sources() })));
});

test('never throws, whatever the sensors do', () => {
  const hostile = {
    platform: () => 'linux',
    loadavg: () => {
      throw new Error('boom');
    },
    cpuCount: () => {
      throw new Error('boom');
    },
    listThermalZones: () => {
      throw new Error('boom');
    },
    readThermalZone: () => {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() => collectHostTelemetry({ machine: 'x', sources: hostile }));
  assert.deepEqual(collectHostTelemetry({ machine: 'x', sources: hostile }), { machine: 'x' });
});

test('works against the real machine without arguments', () => {
  assert.doesNotThrow(() => collectHostTelemetry());
});
