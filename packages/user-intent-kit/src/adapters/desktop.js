// SPDX-License-Identifier: AGPL-3.0

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

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
  #pollIntervalMs;

  /**
   * @param {import('../client.js').IntentClient} client
   * @param {object} [opts]
   * @param {number} [opts.pollIntervalMs=30000] - How often to publish state
   */
  constructor(client, { pollIntervalMs = 30000 } = {}) {
    this.#client = client;
    this.#pollIntervalMs = pollIntervalMs;
    this.#pollTimer = null;
  }

  /**
   * Detect current desktop context and publish to intent API.
   */
  async publishState() {
    const state = this.#detectState();
    await this.#client.patchDevice(state);
  }

  /**
   * Start background polling: detect + publish state on interval.
   */
  start() {
    this.stop();
    // Publish immediately
    this.publishState().catch(() => {});
    this.#client.startHeartbeat();
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
    this.#client.stopHeartbeat();
  }

  #detectState() {
    const state = {
      screen_active: true,
      context: 'active',
    };

    try {
      if (platform() === 'darwin') {
        const app = execSync(
          `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        state.active_app = app.toLowerCase();

        // Infer context from active app
        if (['zoom', 'microsoft teams', 'google meet', 'facetime', 'webex'].some(a => state.active_app.includes(a))) {
          state.context = 'meeting';
        } else if (['claude', 'codex', 'terminal', 'iterm', 'warp', 'code', 'cursor'].some(a => state.active_app.includes(a))) {
          state.context = 'coding';
        }
      }
    } catch {
      // Detection failed, keep defaults
    }

    return state;
  }
}
