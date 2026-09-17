// SPDX-License-Identifier: AGPL-3.0

import { execSync, execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/** Idle longer than this and the user is not at this machine. */
const IDLE_AFTER_SEC = 300;
import { collectHostTelemetry } from '../host-telemetry.js';
import { ServedModelProbe } from '../served-model.js';
import { ModelAvailabilityProbe } from '../model-availability.js';
import { StatePublisher } from '../state-publisher.js';

/**
 * Desktop Adapter - detects active window and context on macOS.
 * Publishes desktop device state to intent API.
 *
 * Currently macOS only (uses osascript for active window detection).
 * Linux support planned for a future release.
 */
export class DesktopAdapter {
  #client;
  #pollTimer;
  #machine;
  #kind;
  #model;
  #modelProbe;
  #availabilityProbe;
  #pollIntervalMs;
  #publisher;

  /**
   * @param {import('../client.js').IntentClient} client
   * @param {object} [opts]
   * @param {number} [opts.pollIntervalMs=30000] - How often to publish state
   * @param {string} [opts.model] - the operator's statement of what this box
   *   serves. A LAST RESORT: see #servedModel().
   * @param {import('../served-model.js').ServedModelProbe|null} [opts.modelProbe]
   *   - asks a local endpoint what it is actually serving. Pass null to turn
   *   the probe off entirely; omit it for the environment's configuration.
   * @param {import('../model-availability.js').ModelAvailabilityProbe|null} [opts.availabilityProbe]
   *   - what this box has on disk and could fit. Publishes the WEAKER claim,
   *   in its own fields; pass null to turn the disk scan off entirely.
   */
  constructor(client, {
    pollIntervalMs = 30000, machine, kind, model, modelProbe, availabilityProbe,
  } = {}) {
    this.#client = client;
    this.#machine = machine ?? client?.deviceId ?? undefined;
    this.#kind = kind;
    this.#model = model;
    // Order matters: the served-model probe's generation guard is wired to
    // the disk scan, so the scan has to exist first. Without the guard a probe
    // could ask a server to generate with a model that is half downloaded,
    // and on a server that loads on demand that request IS a load.
    this.#availabilityProbe = availabilityProbe === undefined
      ? new ModelAvailabilityProbe()
      : availabilityProbe;
    const scan = this.#availabilityProbe;
    this.#modelProbe = modelProbe === undefined
      ? new ServedModelProbe({ guard: id => scan?.couldLoad(id) ?? false })
      : modelProbe;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Invalid pollIntervalMs');
    // One timer owns both telemetry and liveness. Default server device TTL is 90s.
    this.#pollIntervalMs = Math.min(pollIntervalMs, 60000);
    this.#publisher = new StatePublisher(fields => this.#client.patchDevice(fields), {
      refreshMs: this.#pollIntervalMs,
    });
    this.#pollTimer = null;
  }

  /**
   * Which model name, if any, goes into this heartbeat.
   *
   * A SERVER THAT ANSWERED OUTRANKS A SETTING, including when what it
   * answered is "nothing". The three cases:
   *
   *   named        publish it, verbatim.
   *   reached, unnamed   (401, or serving nothing) - publish NO model, and
   *                do not fall back to `model`. We have live evidence about
   *                that port and the configured name is either contradicted
   *                by it or unverifiable against it. A guess on a public
   *                dashboard is the failure this whole change exists to
   *                avoid; a blank field is not.
   *   no server    nothing is listening, so there is nothing to contradict
   *                the operator. `INTENT_DEVICE_MODEL` is documented for
   *                exactly this box - one that cannot be asked - so their
   *                word stands, and on Linux collectHostTelemetry still
   *                falls through to the running llama-server's own argv.
   *
   * Synchronous and network-free by construction: the probe caches, and a
   * heartbeat must go out whether or not the model probe is healthy.
   */
  #servedModel() {
    if (!this.#modelProbe) return this.#model;
    const seen = this.#modelProbe.lastResult();
    if (seen?.model) return seen.model;
    if (seen?.reachedServer) return undefined;
    return this.#model;
  }

  /**
   * What the endpoint merely ADVERTISES, in its own keys.
   *
   * A listing is not a loading - `mlx_lm` lists the whole HuggingFace cache -
   * so this can never reach `model`. One id is named; several are counted and
   * none is named, because a server listing several cannot have them all
   * resident and picking one would be a coin toss printed as a fact.
   */
  #listedModels() {
    const listed = this.#modelProbe?.listed?.() ?? [];
    if (!listed.length) return {};
    if (listed.length === 1) return { model_listed: listed[0], model_listed_count: 1 };
    return { model_listed_count: listed.length };
  }

  /**
   * Detect current desktop context and publish to intent API.
   */
  async publishState() {
    const state = this.#detectState();
    await this.#publisher.publish({ ...state, ttl_sec: 90 });
  }

  /**
   * Start background polling: detect + publish state on interval.
   */
  start() {
    this.stop();
    // Publish immediately
    this.publishState().catch(() => {});
    // Started AFTER the first publish and never awaited, so the machine
    // appears on the dashboard at once with whatever vitals it has, label or
    // no label. The first probe fills the label in for the next beat.
    this.#modelProbe?.start();
    // Same contract, slower timer: the scan is disk-bound, so it never runs on
    // the heartbeat's path and the first beat goes out without waiting for it.
    this.#availabilityProbe?.start();
    // this.#client.startHeartbeat() removed: the StatePublisher's own
    // refreshMs timer now re-sends the last state as the liveness beat, so a
    // second heartbeat mechanism only doubled the writes (c0ed66d, 18 Sep 2026).
    this.#pollTimer = setInterval(() => {
      this.publishState().catch(() => {});
    }, this.#pollIntervalMs);
    if (this.#pollTimer.unref) this.#pollTimer.unref();
  }

  stop() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#modelProbe?.stop();
    this.#availabilityProbe?.stop();
  }

  /**
   * Seconds since the user last touched this machine, or undefined if the OS
   * will not say. macOS keeps it in the HID system as nanoseconds.
   */
  #idleSeconds() {
    if (platform() !== 'darwin') return undefined;
    try {
      const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ns = Number((out.match(/"HIDIdleTime"\s*=\s*(\d+)/) || [])[1]);
      return Number.isFinite(ns) ? Math.round(ns / 1e9) : undefined;
    } catch {
      return undefined;
    }
  }

  #detectState() {
    // Vitals ride along with the desktop card so a machine's row shows what it
    // is and how it is doing, the same fields the Pi publishes — otherwise a
    // Mac appears in the fleet as a name and nothing else.
    const idleSec = this.#idleSeconds();

    // `screen_active` used to be hardcoded true. The derived state picks the
    // most recently updated device whose screen is active as the one the user
    // is on, and this daemon republishes every 30s — so an unattended Mac
    // always won, and the dashboard told Petrus he was working at the Mac mini
    // while he was on his phone. It had been untouched for 18 hours.
    const active = idleSec === undefined ? true : idleSec < IDLE_AFTER_SEC;

    const state = {
      screen_active: active,
      context: active ? 'active' : 'idle',
      ...(idleSec === undefined ? {} : { idle_sec: idleSec }),
      ...collectHostTelemetry({ machine: this.#machine, kind: this.#kind, model: this.#servedModel() }),
      // The weaker claim, in its OWN keys. `model` still means served and
      // nothing else, so a dashboard that has never heard of availability
      // cannot start rendering "this box could run it" as "this box is
      // running it". Empty when there is nothing measured to say.
      ...this.#listedModels(),
      ...(this.#availabilityProbe?.current() ?? {}),
    };

    try {
      if (platform() === 'darwin') {
        const app = execSync(
          `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        state.active_app = app.toLowerCase();

        // Infer context from active app — but only when someone is actually
        // at the machine. A frontmost editor on a box nobody has touched since
        // yesterday is not "coding".
        if (state.screen_active) {
          if (['zoom', 'microsoft teams', 'google meet', 'facetime', 'webex'].some(a => state.active_app.includes(a))) {
            state.context = 'meeting';
          } else if (['claude', 'codex', 'terminal', 'iterm', 'warp', 'code', 'cursor'].some(a => state.active_app.includes(a))) {
            state.context = 'coding';
          }
        }
      }
    } catch {
      // Detection failed, keep defaults
    }

    return state;
  }
}
