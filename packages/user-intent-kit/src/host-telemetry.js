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
  readThermalZone: (zone) => readFileSync(`${THERMAL_ROOT}/${zone}/temp`, 'utf8'),
};

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
  for (const zone of zones || []) {
    try {
      const celsius = Number(String(sources.readThermalZone(zone)).trim()) / 1000;
      if (celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C) {
        if (hottest === undefined || celsius > hottest) hottest = celsius;
      }
    } catch {
      // Unreadable zone: skip it, keep whatever the other zones gave us.
    }
  }
  return hottest === undefined ? undefined : Math.round(hottest * 10) / 10;
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
 * @param {object} [opts.sources] - injectable sensor reads, for tests
 * @returns {object} only the fields that were readable
 */
export function collectHostTelemetry({ machine, kind, sources = defaultSources } = {}) {
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
      const tempC = readLinuxTempC(sources);
      if (tempC !== undefined) host.temp_c = tempC;
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

  return host;
}
