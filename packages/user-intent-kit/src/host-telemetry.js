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
 */

import { readFileSync, readdirSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';

/** Plausible CPU die temperatures. Outside this, assume the sensor lied. */
const TEMP_MIN_C = 1;
const TEMP_MAX_C = 150;

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
function readLoad() {
  const count = cpus()?.length;
  const [oneMinute] = loadavg();

  // Windows has no load average; Node reports [0, 0, 0] there. That is an
  // absent sensor, not an idle machine, so report nothing at all.
  if (platform() === 'win32' || !Number.isFinite(oneMinute)) return {};

  const out = { load_1m: Math.round(oneMinute * 100) / 100 };
  if (Number.isFinite(count) && count > 0) {
    out.cpu_count = count;
    out.load_pct = Math.round((oneMinute / count) * 100);
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
function readLinuxTempC() {
  let hottest;
  let zones;
  try {
    zones = readdirSync('/sys/class/thermal').filter((z) => z.startsWith('thermal_zone'));
  } catch {
    return undefined;
  }

  for (const zone of zones) {
    try {
      const milli = Number(readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim());
      const celsius = milli / 1000;
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
 * @returns {object} only the fields that were readable
 */
export function collectHostTelemetry({ machine } = {}) {
  const host = {};
  if (machine) host.machine = machine;

  try {
    Object.assign(host, readLoad());
  } catch {
    // Load is best-effort like everything else here.
  }

  if (platform() === 'linux') {
    try {
      const tempC = readLinuxTempC();
      if (tempC !== undefined) host.temp_c = tempC;
    } catch {
      // No thermal zones exposed; publish without a temperature.
    }
  }

  return host;
}
