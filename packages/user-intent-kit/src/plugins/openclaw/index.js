// SPDX-License-Identifier: AGPL-3.0

/**
 * OpenClaw plugin for user-intent-kit.
 *
 * Hooks into before_prompt_build to inject user context into the system prompt.
 * Hooks into message_sending to adapt response based on device/modality.
 * Publishes agent status on session_start/agent_end.
 */

import { IntentClient } from '../../client.js';
import { OpenClawAdapter } from '../../adapters/openclaw.js';

export default function register(api) {
  const config = api.pluginConfig || {};
  const { apiBaseUrl, apiKey, userId, timeoutMs = 5000 } = config;

  if (!apiBaseUrl || !apiKey || !userId) {
    api.logger.warn('user-intent plugin: missing apiBaseUrl, apiKey, or userId in config. Disabled.');
    return;
  }

  const client = new IntentClient({
    baseUrl: apiBaseUrl,
    apiKey,
    userId,
    timeoutMs,
  });

  const adapter = new OpenClawAdapter(client);

  // Cache intent state per turn to avoid multiple API calls
  let cachedModifier = null;
  let cachedAt = 0;
  const CACHE_TTL_MS = 10000;

  async function getModifier() {
    const now = Date.now();
    if (cachedModifier !== null && (now - cachedAt) < CACHE_TTL_MS) {
      return cachedModifier;
    }
    try {
      cachedModifier = await adapter.getPromptModifier();
      cachedAt = now;
    } catch (err) {
      api.logger.debug(`user-intent: failed to get modifier: ${err.message}`);
      cachedModifier = '';
      cachedAt = now;
    }
    return cachedModifier;
  }

  // Inject user context into system prompt before each response
  api.on('before_prompt_build', async () => {
    const modifier = await getModifier();
    if (!modifier) return {};
    return {
      prependContext: `[User Intent] ${modifier}`,
    };
  }, { priority: 10 });

  // Publish agent status when a session starts
  api.on('session_start', async () => {
    const agentName = api.name || api.id || 'unknown';
    try {
      await adapter.publishBotStatus(agentName, {
        status: 'active',
        task: 'session started',
      });
    } catch {
      // Non-critical
    }
  });

  // Publish idle status when agent turn ends
  api.on('agent_end', async () => {
    const agentName = api.name || api.id || 'unknown';
    cachedModifier = null; // Invalidate cache between turns
    try {
      await adapter.publishBotStatus(agentName, {
        status: 'idle',
        task: null,
      });
    } catch {
      // Non-critical
    }
  });

  api.logger.info(`user-intent plugin loaded for user: ${userId}`);
}
