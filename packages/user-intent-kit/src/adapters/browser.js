// SPDX-License-Identifier: AGPL-3.0

/**
 * Browser Adapter - for web dashboards showing live intent state.
 *
 * Polls the intent API and emits updates via a callback.
 * Works in browsers and Node.js.
 */
export class BrowserAdapter {
  #client;
  #pollTimer;
  #pollIntervalMs;
  #onUpdate;

  /**
   * @param {import('../client.js').IntentClient} client
   * @param {object} opts
   * @param {function} opts.onUpdate - callback(intentState) on each poll
   * @param {number} [opts.pollIntervalMs=5000]
   */
  constructor(client, { onUpdate, pollIntervalMs = 5000 }) {
    this.#client = client;
    this.#onUpdate = onUpdate;
    this.#pollIntervalMs = pollIntervalMs;
    this.#pollTimer = null;
  }

  async poll() {
    try {
      const intent = await this.#client.getIntent();
      this.#onUpdate(intent);
    } catch {
      // Poll failure, skip
    }
  }

  start() {
    this.stop();
    this.poll(); // Immediate first poll
    this.#pollTimer = setInterval(() => this.poll(), this.#pollIntervalMs);
    if (this.#pollTimer.unref) this.#pollTimer.unref();
  }

  stop() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }
}
