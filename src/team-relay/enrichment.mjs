// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enrichment sidecar logic for ide-agent-kit queue events.
 * Populates 'intent' and 'memory_context' slots.
 */

export async function enrichEvent(event, config = {}) {
  const body = event.payload?.body || '';
  if (!body) return event;

  const enriched = { ...event };

  const addError = (msg) => {
    if (!enriched.enrichment_errors) enriched.enrichment_errors = [];
    enriched.enrichment_errors.push(msg);
  };

  // 1. Enrich with Memory Context (via claude-mem worker API)
  const memCfg = config.memory_api || {};
  if (memCfg.baseUrl && memCfg.token) {
    try {
      const params = new URLSearchParams({ query: body, limit: '3' });
      const url = `${memCfg.baseUrl}/search/observations?${params}`;
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${memCfg.token}`
        }
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Expected JSON but got ${contentType}`);
      }

      const data = await resp.json();
      if (data && data.content) {
        // claude-mem returns MCP-style {content: [{type, text}]}
        const texts = data.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text);
        if (texts.length > 0) {
          enriched.memory_context = { raw: texts };
        }
      } else if (data && data.error) {
        addError(`Memory enrichment API error: ${data.error} - ${data.message || ''}`);
      }
    } catch (e) {
      addError(`Memory enrichment fetch failed: ${e.message}`);
    }
  }

  // 2. Enrich with Intent (via user-intent-kit / GroupMind API)
  const intentCfg = config.intent || {};
  if (intentCfg.baseUrl && intentCfg.apiKey && intentCfg.userId) {
    try {
      const url = `${intentCfg.baseUrl}/intent/${intentCfg.userId}`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${intentCfg.apiKey}` }
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Expected JSON but got ${contentType}`);
      }

      const data = await resp.json();
      if (data) {
        enriched.intent = {
          ...data,
          provider: 'antfarm'
        };
      }
    } catch (e) {
      addError(`Intent enrichment failed: ${e.message}`);
    }
  }

  // Fallback intent if still empty
  if (!enriched.intent) {
    enriched.intent = {
      action: 'unknown',
      confidence: 0,
      provider: 'placeholder'
    };
  }

  return enriched;
}
