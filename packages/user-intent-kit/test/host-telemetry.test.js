// SPDX-License-Identifier: AGPL-3.0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectHostTelemetry, modelFromCommandLine } from '../src/host-telemetry.js';

/**
 * Fake sensors. The real ones only report whatever the machine running the
 * suite happens to expose, so on a Mac the Linux thermal path would never run
 * and "tests pass" would say nothing about the Pi.
 */
function sources({ platform = 'linux', load = [1.8, 1.7, 1.6], cpuCount = 4, zones = {},
                   totalMem = 16e9, freeMem = 4e9, availMem = 12e9, commands = {},
                   processes = [], trips = {} } = {}) {
  return {
    platform: () => platform,
    loadavg: () => load,
    cpuCount: () => cpuCount,
    totalMemBytes: () => totalMem,
    freeMemBytes: () => freeMem,
    availableMemBytes: () => availMem,
    run: (cmd, args) => {
      const key = `${cmd} ${(args || []).join(' ')}`;
      return (commands && commands[key]) || '';
    },
    listProcessCommandLines: () => {
      if (processes instanceof Error) throw processes;
      return processes;
    },
    listThermalZones: () => Object.keys(zones),
    readThermalZone: (zone) => {
      const value = zones[zone];
      if (value instanceof Error) throw value;
      return value;
    },
    readThermalCriticalMilli: (zone) => {
      const value = trips[zone];
      if (value instanceof Error) throw value;
      return value ?? '';
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

// --- memory ---

test('publishes installed and free memory in GB', () => {
  const host = collectHostTelemetry({ sources: sources({ totalMem: 25.8e9, freeMem: 1.2e9 }) });
  assert.equal(host.mem_total_gb, 25.8);
  assert.equal(host.mem_free_gb, 1.2);
});

test('publishes no used-percentage, which macOS free memory cannot support', () => {
  const host = collectHostTelemetry({ sources: sources() });
  assert.ok(!('mem_used_pct' in host), 'derived a usage figure from an unreliable free count');
});

test('zero free memory is a real reading, not a missing one', () => {
  const host = collectHostTelemetry({ sources: sources({ freeMem: 0 }) });
  assert.equal(host.mem_free_gb, 0);
});

test('omits memory when the host cannot report it', () => {
  const blind = sources();
  blind.totalMemBytes = () => undefined;
  blind.freeMemBytes = () => undefined;
  const host = collectHostTelemetry({ sources: blind });
  assert.ok(!('mem_total_gb' in host));
  assert.ok(!('mem_free_gb' in host));
  assert.ok('load_1m' in host, 'a missing memory reading must not suppress load');
});

test('memory survives a hostile sensor without throwing', () => {
  const hostile = sources();
  hostile.totalMemBytes = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => collectHostTelemetry({ sources: hostile }));
});

// --- hardware + network ---

test('describes Mac hardware from the OS, not from guesswork', () => {
  const host = collectHostTelemetry({ sources: sources({ platform: 'darwin', commands: {
    '/usr/sbin/sysctl -n machdep.cpu.brand_string': 'Apple M4',
    '/usr/sbin/sysctl -n hw.model': 'Mac16,10',
  }})});
  assert.equal(host.hw, 'Apple M4 (Mac16,10)');
});

test('reports a wired Mac as ethernet, not wifi', () => {
  const host = collectHostTelemetry({ sources: sources({ platform: 'darwin', commands: {
    '/sbin/route -n get default': '   interface: en0',
    '/usr/sbin/ipconfig getifaddr en0': '192.168.50.241',
    '/usr/sbin/networksetup -listallhardwareports': 'Hardware Port: Wi-Fi\nDevice: en1\n',
  }})});
  assert.equal(host.network, 'ethernet');
  assert.equal(host.lan_ip, '192.168.50.241');
});

test('reports a Mac on the wifi device as wifi', () => {
  const host = collectHostTelemetry({ sources: sources({ platform: 'darwin', commands: {
    '/sbin/route -n get default': '   interface: en1',
    '/usr/sbin/ipconfig getifaddr en1': '192.168.50.99',
    '/usr/sbin/networksetup -listallhardwareports': 'Hardware Port: Wi-Fi\nDevice: en1\n',
  }})});
  assert.equal(host.network, 'wifi');
});

test('omits hardware and network when the commands fail', () => {
  const host = collectHostTelemetry({ sources: sources({ platform: 'darwin', commands: {} })});
  assert.ok(!('hw' in host), 'invented a hardware description');
  assert.ok(!('network' in host), 'guessed a network medium');
  assert.ok(!('lan_ip' in host));
});

// --- available memory: the figure that decides whether a model fits ---

test('publishes available memory alongside free, not instead of it', () => {
  const host = collectHostTelemetry({ sources: sources({ freeMem: 1.3e9, availMem: 17.8e9 }) });
  assert.equal(host.mem_free_gb, 1.3);
  assert.equal(host.mem_available_gb, 17.8);
});

test('available is what a model-fits decision must use', () => {
  // A real Mac: 1.3 GB free, ~18 GB available. Deciding on free would refuse a
  // model the machine can hold comfortably.
  const host = collectHostTelemetry({ sources: sources({ totalMem: 25.8e9, freeMem: 1.3e9, availMem: 17.8e9 }) });
  assert.ok(host.mem_available_gb > host.mem_free_gb * 10, 'the gap is the whole point');
});

test('omits available when the OS will not say', () => {
  const blind = sources();
  blind.availableMemBytes = () => undefined;
  const host = collectHostTelemetry({ sources: blind });
  assert.ok(!('mem_available_gb' in host), 'guessed an availability figure');
  assert.ok('mem_total_gb' in host, 'and did not lose the rest');
});

test('zero available is a real reading', () => {
  const host = collectHostTelemetry({ sources: sources({ availMem: 0 }) });
  assert.equal(host.mem_available_gb, 0);
});

// --- served model (what the box is for, next to how it is doing) ---

const LLAMA = ['/home/petrus/llm/llama.cpp/build/bin/llama-server', '-m',
  '/home/petrus/llm/models/flash-next/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf',
  '--host', '0.0.0.0', '--port', '8080', '-c', '262144'];

test('reads the served model from a running llama-server on Linux', () => {
  const host = collectHostTelemetry({ sources: sources({ processes: [LLAMA] }) });
  assert.equal(host.model, 'Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf');
});

test('a single-file GGUF keeps its full name, extension included, like the Pi publishes', () => {
  const argv = ['llama-server', '--model', '/models/Ling-3.0-tiny-Q4_K_M.gguf'];
  assert.equal(modelFromCommandLine(argv), 'Ling-3.0-tiny-Q4_K_M.gguf');
  assert.equal(modelFromCommandLine(['llama-server', '--model=/models/a-b.gguf']), 'a-b.gguf');
});

test('an explicit model name wins over discovery', () => {
  const host = collectHostTelemetry({ model: ' gemma-4-local ', sources: sources({ processes: [LLAMA] }) });
  assert.equal(host.model, 'gemma-4-local');
});

test('a host serving nothing publishes no model, not an empty one', () => {
  for (const explicit of [undefined, '', '   ', 42]) {
    const host = collectHostTelemetry({ model: explicit, sources: sources({ processes: [] }) });
    assert.ok(!('model' in host), `published model for ${JSON.stringify(explicit)}`);
  }
});

test('only a model server counts; other processes with -m are ignored', () => {
  const others = [['/usr/bin/python3', '-m', 'http.server'], ['bash', '-c', 'llama-server -m x.gguf']];
  const host = collectHostTelemetry({ sources: sources({ processes: others }) });
  assert.ok(!('model' in host));
  assert.equal(modelFromCommandLine(['/opt/llama-server', '--port', '8080']), undefined);
  assert.equal(modelFromCommandLine([]), undefined);
});

test('macOS publishes only an explicit model; the process table is not consulted', () => {
  const mac = sources({ platform: 'darwin', processes: [LLAMA] });
  assert.ok(!('model' in collectHostTelemetry({ sources: mac })));
  assert.equal(collectHostTelemetry({ model: 'lmstudio:qwen', sources: mac }).model, 'lmstudio:qwen');
});

test('a hostile process table never takes the heartbeat down', () => {
  const host = collectHostTelemetry({ sources: sources({ processes: new Error('EACCES') }) });
  assert.ok(!('model' in host));
  assert.ok('load_1m' in host, 'lost the other vitals along with the model');
});

test('a voice stack with lower pids does not become the served model (VTA layout)', () => {
  // pid order: whisper, piper and a python -m all come before llama-server
  const table = [
    ['/opt/whisper/whisper-server', '-m', '/models/ggml-large-v3-turbo.bin', '--port', '8090'],
    ['/usr/bin/piper', '--model', '/models/fi_FI-harri-medium.onnx'],
    ['/usr/bin/python3', '-m', 'http.server'],
    LLAMA,
  ];
  const host = collectHostTelemetry({ sources: sources({ processes: table }) });
  assert.equal(host.model, 'Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf');
  // and with the model server gone, the voice stack still is not "the model"
  assert.ok(!('model' in collectHostTelemetry({ sources: sources({ processes: table.slice(0, 3) }) })));
});
// --- the machine's own limit, so a dashboard is not guessing a scale ---

test('publishes the critical trip point of the SAME zone the reading came from', () => {
  const host = collectHostTelemetry({
    sources: sources({
      zones: { thermal_zone0: '49000', thermal_zone1: '72000' },
      // zone1 is the hottest, so zone1's limit is the one that applies.
      trips: { thermal_zone0: '104000', thermal_zone1: '95000' },
    }),
  });
  assert.equal(host.temp_c, 72);
  assert.equal(host.temp_limit_c, 95, "paired the reading with another zone's limit");
});

test('a host that declares no critical point publishes a temperature and no limit', () => {
  const host = collectHostTelemetry({
    sources: sources({ zones: { thermal_zone0: '49000' }, trips: {} }),
  });
  assert.equal(host.temp_c, 49);
  assert.ok(!('temp_limit_c' in host), 'invented a limit the machine never declared');
});

test('an unreadable trip table costs the limit, never the temperature', () => {
  const host = collectHostTelemetry({
    sources: sources({
      zones: { thermal_zone0: '49000' },
      trips: { thermal_zone0: new Error('EACCES') },
    }),
  });
  assert.equal(host.temp_c, 49);
  assert.ok(!('temp_limit_c' in host));
});

test('a critical point is kept when the machine has REACHED it', () => {
  // The moment the limit matters most. An earlier cut dropped any critical
  // point at or below the reading as "a broken table", so a box sitting on
  // its trip published no limit at all and a reader fell back to a calmer
  // default. Crossing the critical trip is a protection event, not bad data.
  const at = collectHostTelemetry({
    sources: sources({ zones: { thermal_zone0: '100000' }, trips: { thermal_zone0: '100000' } }),
  });
  assert.equal(at.temp_c, 100);
  assert.equal(at.temp_limit_c, 100, 'dropped the limit at exactly the trip point');

  const over = collectHostTelemetry({
    sources: sources({ zones: { thermal_zone0: '105000' }, trips: { thermal_zone0: '100000' } }),
  });
  assert.equal(over.temp_c, 105);
  assert.equal(over.temp_limit_c, 100, 'dropped the limit on a box that is OVER it');
});

test('a nonsense critical point is dropped rather than published', () => {
  // Judged on the value alone: unparseable, empty, or hotter than any real
  // die. Deliberately NOT "below the current reading" - see the test above.
  for (const bad of ['900000', 'not-a-number', '']) {
    const host = collectHostTelemetry({
      sources: sources({ zones: { thermal_zone0: '49000' }, trips: { thermal_zone0: bad } }),
    });
    assert.equal(host.temp_c, 49, `temp lost for trip=${bad}`);
    assert.ok(!('temp_limit_c' in host), `published nonsense limit ${bad}`);
  }
});
