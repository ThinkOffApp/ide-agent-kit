// SPDX-License-Identifier: AGPL-3.0

/** Change-triggered writes with a bounded refresh and one request in flight.
 * Only acknowledged writes advance the checkpoint. The latest queued state wins.
 * A monotonic clock avoids missed refreshes when the system clock moves backward.
 */
export class StatePublisher {
  #send; #refreshMs; #now; #lastKey; #lastAt = -Infinity;
  #pending; #running;
  constructor(send, { refreshMs, now = () => performance.now() }) {
    if (!Number.isFinite(refreshMs) || refreshMs <= 0) throw new Error('Invalid refreshMs');
    this.#send = send; this.#refreshMs = refreshMs; this.#now = now;
  }
  publish(state) {
    this.#pending = structuredClone(state);
    if (!this.#running) {
      this.#running = this.#drain().finally(() => { this.#running = undefined; });
    }
    return this.#running;
  }
  async #drain() {
    while (this.#pending) {
      const state = this.#pending;
      this.#pending = undefined;
      const key = JSON.stringify(state);
      if (key === this.#lastKey && this.#now() - this.#lastAt < this.#refreshMs) continue;
      await this.#send(state);
      this.#lastKey = key;
      this.#lastAt = this.#now();
    }
  }
}
