// SPDX-License-Identifier: AGPL-3.0

/**
 * Host vitals for the UIK agent record (CPU load, temperature, power).
 *
 * Contract: every field is OPTIONAL and a value we cannot read is OMITTED,
 * never zeroed. A zero renders in the dashboard as a real reading — an idle
 * box and an unreadable sensor must not look the same.
 *
 * Nothing here throws: telemetry is decoration on the heartbeat, so a failed
 * sensor read must never take the agent offline.
 *
 * The platform reads are injectable (`sources`) so the contract can be tested
 * on any machine. Without that, a suite running on macOS never exercises the
 * Linux thermal path at all, and "the tests pass" would mean only that they
 * passed on whichever box happened to run them.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';

/** Plausible CPU die temperatures. Outside this, assume the sensor lied. */
const TEMP_MIN_C = 1;
const TEMP_MAX_C = 150;

const THERMAL_ROOT = '/sys/class/thermal';

/** Bytes per GB, base 10 — matching the units already published by the fleet. */
const BYTES_PER_GB = 1e9;

/**
 * Run a command for a fact we cannot get from Node. Arguments are passed as
 * argv, never interpolated into a shell string, and a failure is just an
 * absent field.
 */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export const defaultSources = {
  platform: () => platform(),
  loadavg: () => loadavg(),
  cpuCount: () => cpus()?.length,
  totalMemBytes: () => totalmem(),
  freeMemBytes: () => freemem(),
  // The OS's own view of what a new process could actually get. macOS reports
  // it as a percentage; Linux exposes MemAvailable directly.
  availableMemBytes: () => {
    if (platform() === 'darwin') {
      const pct = Number((run('/usr/bin/memory_pressure', []).match(/free percentage:\s*(\d+)%/) || [])[1]);
      return Number.isFinite(pct) ? (totalmem() * pct) / 100 : undefined;
    }
    if (platform() === 'linux') {
      try {
        const kb = Number((readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s*(\d+)\s*kB/) || [])[1]);
        return Number.isFinite(kb) ? kb * 1024 : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  },
  run,
  listThermalZones: () => readdirSync(THERMAL_ROOT).filter((z) => z.startsWith('thermal_zone')),
  // argv of every process this user may read, Linux only. `comm` is checked
  // first so the 30 s poll reads one small file per process and the full
  // command line only for the handful that could be a model server.
  listProcessCommandLines: () => {
    if (platform() !== 'linux') return [];
    const out = [];
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (!MODEL_SERVER_COMM.test(comm)) continue;
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (argv.length) out.push(argv);
      } catch {
        // Gone or unreadable: not ours to report.
      }
    }
    return out;
  },
  readThermalZone: (zone) => readFileSync(`${THERMAL_ROOT}/${zone}/temp`, 'utf8'),
  // The zone's own critical trip point, in millidegrees, or '' when the zone
  // declares none. A zone advertises several trips (passive, hot, critical);
  // only 'critical' is the number a reading should be judged against.
  readThermalCriticalMilli: (zone) => {
    const dir = `${THERMAL_ROOT}/${zone}`;
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^trip_point_(\d+)_type$/);
      if (!m) continue;
      if (readFileSync(`${dir}/${entry}`, 'utf8').trim() !== 'critical') continue;
      return readFileSync(`${dir}/trip_point_${m[1]}_temp`, 'utf8');
    }
    return '';
  },
};

/**
 * Process names that serve a model and say which one on their command line.
 * llama.cpp's server takes the weights as `-m path.gguf`; that path is the
 * one honest source of "what is this box serving" — a config file can say
 * anything while the server runs something else.
 */
const MODEL_SERVER_COMM = /^llama-server/;

/** Multi-part GGUF files carry a shard suffix; the model is the stem. */
const GGUF_SHARD_SUFFIX = /-\d{5}-of-\d{5}(?=\.gguf$)/i;

/**
 * The served model's name from a model server's argv, or undefined.
 *
 * Exported for tests and for anything else that has a command line and wants
 * the same answer the heartbeat publishes.
 *
 * @param {string[]} argv
 * @returns {string|undefined} e.g. "Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf"
 */
export function modelFromCommandLine(argv) {
  if (!Array.isArray(argv) || !argv.length) return undefined;
  if (!MODEL_SERVER_COMM.test(basename(String(argv[0])))) return undefined;

  let path;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '-m' || arg === '--model') {
      path = argv[i + 1];
      break;
    }
    if (arg.startsWith('--model=')) {
      path = arg.slice('--model='.length);
      break;
    }
  }
  if (!path) return undefined;

  const name = basename(String(path)).replace(GGUF_SHARD_SUFFIX, '');
  return name || undefined;
}

/**
 * Which model this host is serving, if any.
 *
 * An explicit name always wins: the operator knows what a box is for even
 * when the server is between restarts. Otherwise, on Linux, the running
 * llama-server's own command line answers — it is read on every poll, so a
 * model swap shows within one heartbeat instead of freezing at the name the
 * daemon started with. A host serving nothing publishes no model at all,
 * per the omit-not-fake contract: an idle box and a box whose model we could
 * not read must look the same as each other, not the same as a box serving
 * something.
 *
 * @returns {string|undefined}
 */
function readModel(sources, explicit) {
  const given = typeof explicit === 'string' ? explicit.trim() : '';
  if (given) return given;

  if (sources.platform() !== 'linux') return undefined;
  const lines = sources.listProcessCommandLines?.() || [];
  for (const argv of lines) {
    const name = modelFromCommandLine(argv);
    if (name) return name;
  }
  return undefined;
}

/**
 * CPU load, normalised so devices of different sizes are comparable.
 *
 * Raw loadavg is meaningless across a fleet: 1.8 is ~18% of a 10-core M4 but
 * ~45% of a 4-core Pi. The dashboard compares boxes side by side, so it needs
 * the percentage, and we publish the raw figure alongside it for anyone who
 * wants the familiar number.
 *
 * @returns {{load_1m?: number, load_pct?: number, cpu_count?: number}}
 */
function readLoad(sources) {
  // Windows has no load average; Node reports [0, 0, 0] there. That is an
  // absent sensor, not an idle machine, so report nothing at all.
  if (sources.platform() === 'win32') return {};

  const [oneMinute] = sources.loadavg() || [];
  if (!Number.isFinite(oneMinute)) return {};

  const out = { load_1m: Math.round(oneMinute * 100) / 100 };

  const count = sources.cpuCount();
  if (Number.isFinite(count) && count > 0) {
    out.cpu_count = count;
    out.load_pct = Math.round((oneMinute / count) * 100);
  }
  return out;
}

/**
 * Installed and free memory, in GB (1e9 bytes, the unit the fleet already
 * publishes — a MacBook with 128 GiB reports 137.4).
 *
 * Deliberately no used-percentage. On macOS `freemem()` counts only genuinely
 * free pages and excludes the cache, which the OS will hand back on demand, so
 * a percentage derived from it reads as 95% used on a machine that is not
 * short of memory at all. Free and total are facts; the percentage would be an
 * alarm the numbers do not support.
 *
 * @returns {{mem_total_gb?: number, mem_free_gb?: number}}
 */
function readMemory(sources) {
  const out = {};
  const total = sources.totalMemBytes?.();
  const free = sources.freeMemBytes?.();

  if (Number.isFinite(total) && total > 0) {
    out.mem_total_gb = Math.round((total / BYTES_PER_GB) * 10) / 10;
  }
  if (Number.isFinite(free) && free >= 0) {
    out.mem_free_gb = Math.round((free / BYTES_PER_GB) * 10) / 10;
  }

  // What a new process could actually claim, which on macOS is nothing like
  // `mem_free_gb`: this Mac reports 1.3 GB free and ~17 GB available, because
  // the rest is cache the OS hands back on demand. Anything deciding whether a
  // model fits must use this figure — free memory would say no on a machine
  // with plenty.
  const avail = sources.availableMemBytes?.();
  if (Number.isFinite(avail) && avail >= 0) {
    out.mem_available_gb = Math.round((avail / BYTES_PER_GB) * 10) / 10;
  }
  return out;
}

/**
 * Hardware description never changes while the process runs, so it is read
 * once — but keyed by the sources object rather than module-global, or the
 * first caller's answer would be served to every later one regardless of what
 * it asked. (A module-level cache also made the function untestable: injected
 * sources were ignored once the real machine had populated it.)
 */
const hardwareCache = new WeakMap();

/**
 * What this machine is, in the words its own OS uses — "Apple M4 (Mac16,10)",
 * "Raspberry Pi 5 Model B". Purely descriptive; the dashboard shows it so a
 * card is identifiable without knowing the hostname convention.
 */
function readHardware(sources) {
  if (hardwareCache.has(sources)) return hardwareCache.get(sources);

  let hw = '';
  if (sources.platform() === 'darwin') {
    const chip = sources.run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']);
    const model = sources.run('/usr/sbin/sysctl', ['-n', 'hw.model']);
    hw = chip && model ? `${chip} (${model})` : chip || model;
  } else if (sources.platform() === 'linux') {
    // The Pi names itself here; \0-terminated, hence the trim.
    try {
      hw = readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
    } catch {
      hw = '';
    }
  }
  hardwareCache.set(sources, hw);
  return hw;
}

/**
 * Which way this host reaches the network, and at what address.
 *
 * Reported as the medium ("wifi" / "ethernet") plus the LAN address, so a
 * card shows how a machine is attached — the Pi is deliberately never on the
 * house wifi, and seeing that at a glance matters.
 *
 * No SSID: on current macOS that needs location permission, and a field that
 * works on one machine and silently fails on another is worse than no field.
 */
function readNetwork(sources) {
  const out = {};
  const os = sources.platform();

  if (os === 'darwin') {
    const iface = (sources.run('/sbin/route', ['-n', 'get', 'default']).match(/interface:\s*(\S+)/) || [])[1];
    if (!iface) return out;
    const ip = sources.run('/usr/sbin/ipconfig', ['getifaddr', iface]);
    if (ip) out.lan_ip = ip;
    // The Wi-Fi port maps to one device (often en1); anything else is wired.
    const ports = sources.run('/usr/sbin/networksetup', ['-listallhardwareports']);
    const wifiDev = (ports.match(/Hardware Port:\s*Wi-Fi\s*\nDevice:\s*(\S+)/) || [])[1];
    out.network = iface === wifiDev ? 'wifi' : 'ethernet';
  } else if (os === 'linux') {
    const iface = (sources.run('/sbin/ip', ['route', 'show', 'default']).match(/dev\s+(\S+)/) || [])[1];
    if (!iface) return out;
    const addr = sources.run('/sbin/ip', ['-4', '-o', 'addr', 'show', iface]);
    const ip = (addr.match(/inet\s+([\d.]+)/) || [])[1];
    if (ip) out.lan_ip = ip;
    try {
      readdirSync(`/sys/class/net/${iface}/wireless`);
      out.network = 'wifi';
    } catch {
      out.network = 'ethernet';
    }
  }
  return out;
}

/**
 * CPU temperature from the Linux thermal zones (Raspberry Pi and friends).
 *
 * sysfs reports millidegrees. A board exposes several zones and they do not
 * agree; the hottest plausible one is what "the CPU temperature" means to
 * someone reading a dashboard, so that is what we publish.
 *
 * @returns {number|undefined} degrees Celsius
 */
function readLinuxTempC(sources) {
  let zones;
  try {
    zones = sources.listThermalZones();
  } catch {
    return undefined;
  }

  let hottest;
  let hottestZone;
  for (const zone of zones || []) {
    try {
      const celsius = Number(String(sources.readThermalZone(zone)).trim()) / 1000;
      if (celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C) {
        if (hottest === undefined || celsius > hottest) {
          hottest = celsius;
          hottestZone = zone;
        }
      }
    } catch {
      // Unreadable zone: skip it, keep whatever the other zones gave us.
    }
  }
  if (hottest === undefined) return undefined;

  // The limit MUST come from the same zone as the reading. Pairing the
  // hottest zone's temperature with some other zone's critical point would
  // produce a headroom figure describing neither.
  let limitC;
  try {
    const raw = String(sources.readThermalCriticalMilli(hottestZone) ?? '').trim();
    const c = Number(raw) / 1000;
    // A critical point below the current reading, or outside plausible die
    // temperatures, is a broken table rather than an emergency.
    if (raw !== '' && Number.isFinite(c) && c > hottest && c <= TEMP_MAX_C) {
      limitC = Math.round(c * 10) / 10;
    }
  } catch {
    // No trip table: publish the reading without a limit.
  }

  return { tempC: Math.round(hottest * 10) / 10, limitC };
}

/**
 * Collect what this host can actually report.
 *
 * Temperature and power on macOS live behind `powermetrics`, which requires
 * root. We deliberately do not shell out to sudo from a long-running daemon,
 * so a Mac publishes load only until a privileged helper feeds it a reading.
 * That is why a Mac shows load but no temperature: the sensor is gated, not
 * missing.
 *
 * @param {object} [opts]
 * @param {string} [opts.machine] - stable device name (e.g. "mac-mini")
 * @param {string} [opts.kind] - role the fleet knows this box by ("car-pi",
 *   "mac-mini"); the Pi already publishes this, so Macs use the same word
 *   rather than inventing a second vocabulary for the same idea
 * @param {string} [opts.model] - what this box serves, when the operator
 *   states it; otherwise discovered from a running model server on Linux
 * @param {object} [opts.sources] - injectable sensor reads, for tests
 * @returns {object} only the fields that were readable
 */
export function collectHostTelemetry({ machine, kind, model, sources = defaultSources } = {}) {
  const host = {};
  if (machine) host.machine = machine;
  if (kind) host.kind = kind;

  try {
    Object.assign(host, readLoad(sources));
  } catch {
    // Load is best-effort like everything else here.
  }

  try {
    Object.assign(host, readMemory(sources));
  } catch {
    // Memory is best-effort too; publish whatever else we managed to read.
  }

  try {
    if (sources.platform() === 'linux') {
      const reading = readLinuxTempC(sources);
      if (reading !== undefined) {
        host.temp_c = reading.tempC;
        // Published so a dashboard can colour a temperature against THIS
        // machine's own limit instead of a guessed scale: 49 C is idle on a
        // box that trips at 104 and alarming on one that trips at 60. A host
        // that declares no critical point simply omits this, and the reader
        // falls back to its own default (petrus, 17 Sep 2026).
        if (reading.limitC !== undefined) host.temp_limit_c = reading.limitC;
      }
    }
  } catch {
    // No thermal zones exposed; publish without a temperature.
  }

  try {
    const hw = readHardware(sources);
    if (hw) host.hw = hw;
  } catch {
    // Descriptive only; never worth failing a heartbeat over.
  }

  try {
    Object.assign(host, readNetwork(sources));
  } catch {
    // Same: an unknown link is published as no link, not a wrong one.
  }

  try {
    const served = readModel(sources, model);
    if (served) host.model = served;
  } catch {
    // A box we cannot ask publishes no model, never a stale one.
  }

  return host;
}
