// SPDX-License-Identifier: AGPL-3.0

import { collectHostTelemetry } from '../host-telemetry.js';

/**
 * IAK Adapter - integrates user-intent-kit with IDE Agent Kit.
 *
 * Publishes: active agent, current task, tmux session status, host vitals.
 * Subscribes: user availability (suppress nudges during meetings).
 */
export class IAKAdapter {
  #client;
  #agentHandle;
  #machine;

  /**
   * @param {import('../client.js').IntentClient} client
   * @param {object} opts
   * @param {string} opts.agentHandle - e.g. "@claudemm"
   * @param {string} [opts.machine] - stable device name published in host vitals
   */
  constructor(client, { agentHandle, machine }) {
    this.#client = client;
    this.#agentHandle = agentHandle;
    this.#machine = machine;
  }

  /**
   * Publish current agent status to intent state.
   * Call this on each room poll cycle.
   *
   * `host` carries the machine's vitals as an object. It was previously a bare
   * string on some publishers, which gave the dashboard nowhere to put a
   * temperature or a load figure.
   */
  async publishStatus({ status = 'active', currentTask = null }) {
    const name = this.#agentHandle.replace(/^@/, '');
    await this.#client.patchAgent(name, {
      status,
      last_task: currentTask,
      host: collectHostTelemetry({ machine: this.#machine }),
    });
  }

  /**
   * Check if nudges should be suppressed (user in meeting, DND, etc).
   */
  async shouldSuppressNudge() {
    const derived = await this.#client.getDerived();
    return derived.urgency_mode === 'emergency-only';
  }

  /**
   * Check if user is in a meeting (text-only mode).
   */
  async isUserInMeeting() {
    return this.#client.isInMeeting();
  }

  /**
   * Get response length hint based on current device + profile.
   */
  async getResponseHint() {
    const intent = await this.#client.getIntent();
    const derived = intent.derived || {};
    const device = derived.preferred_device || 'desktop';

    if (device === 'watch') {
      return { maxLength: 100, style: 'ultra-brief', codeBlocks: false };
    }
    if (derived.urgency_mode === 'text-only') {
      return { maxLength: 200, style: 'brief', codeBlocks: false };
    }
    return { maxLength: null, style: 'normal', codeBlocks: true };
  }
}
