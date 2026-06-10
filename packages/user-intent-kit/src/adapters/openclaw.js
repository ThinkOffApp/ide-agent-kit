// SPDX-License-Identifier: AGPL-3.0

/**
 * OpenClaw Adapter - pre-response hook for intent-aware bot responses.
 *
 * Reads profile + intent before each bot response and returns
 * a system prompt modifier that adapts output to user context.
 */
export class OpenClawAdapter {
  #client;

  /**
   * @param {import('../client.js').IntentClient} client
   */
  constructor(client) {
    this.#client = client;
  }

  /**
   * Pre-response hook. Call before generating a bot response.
   * Returns a system prompt modifier string based on user context.
   */
  async getPromptModifier() {
    let intent, profile;
    try {
      [intent, profile] = await Promise.all([
        this.#client.getIntent(),
        this.#client.getProfile().catch(() => null),
      ]);
    } catch {
      return ''; // Intent API unavailable, don't modify
    }

    const derived = intent.derived || {};
    const agentPrefs = profile?.agent_prefs || {};
    const userPrefs = profile?.preferences || {};
    const parts = [];

    // Device context
    if (derived.preferred_device === 'watch') {
      parts.push('User is reading on a smartwatch. Keep response under 2 sentences. No code blocks.');
    }

    // Meeting mode
    if (derived.suppress_audio) {
      parts.push('User is in a meeting. Text only, be concise.');
    }

    // Response style preference (lives under preferences, not agent_prefs)
    if (userPrefs.response_style === 'brief') {
      parts.push('User prefers brief responses.');
    }

    // Max length
    if (agentPrefs.max_response_length) {
      parts.push(`Keep response under ${agentPrefs.max_response_length} characters.`);
    }

    // Emergency only mode
    if (derived.urgency_mode === 'emergency-only') {
      parts.push('User is in DND mode. Only respond to urgent/emergency requests.');
    }

    return parts.join(' ');
  }

  /**
   * Publish bot agent status after starting a task.
   */
  async publishBotStatus(agentName, { status, task }) {
    await this.#client.patchAgent(agentName, {
      status,
      last_task: task,
    });
  }
}
