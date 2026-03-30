// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';

/**
 * Enrichment sidecar logic for ide-agent-kit queue events.
 * Populates 'intent' and 'memory_context' slots.
 */

export async function enrichEvent(event, config = {}) {
  const body = event.payload?.body || '';
  if (!body) return event;

  const enriched = { ...event };
  
  // 1. Enrich with Memory Context (via claude-mem)
  if (config.memory?.backend === 'local') {
    try {
      /* 
       * Temporarily disabled: 'claude-mem search' is not a valid global CLI command.
       * Awaiting proper option (b) integration using the claude-mem Node SDK/API module.
       * 
       * const searchCmd = `claude-mem search --query ${JSON.stringify(body)} --limit 3 --json`;
       * const result = execSync(searchCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
       */
       
      enriched.memory_context = null; // Bypass until Node API hook is written
      
    } catch (e) {
      if (!enriched.enrichment_errors) enriched.enrichment_errors = [];
      enriched.enrichment_errors.push(`Memory enrichment failed: ${e.message}`);
    }
  }

  // 2. Enrich with Intent (Stub/Placeholder for UIK)
  if (!enriched.intent) {
    enriched.intent = {
      action: 'unknown',
      confidence: 0,
      provider: 'placeholder'
    };
  }

  return enriched;
}
