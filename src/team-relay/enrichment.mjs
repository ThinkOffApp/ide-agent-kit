// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enrichment sidecar logic for ide-agent-kit queue events.
 * Populates 'intent' and 'memory_context' slots.
 */

export async function enrichEvent(event, config = {}) {
  const body = event.payload?.body || '';
  if (!body) return event;

  const enriched = { ...event };
  if (!enriched.enrichment_errors) enriched.enrichment_errors = [];

  // 1. Enrich with Memory Context (via claude-mem worker API)
  const memCfg = config.memory_api || {};
  if (memCfg.baseUrl && memCfg.token) {
    try {
      const url = \`\${memCfg.baseUrl}/observations/search\`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${memCfg.token}\`
        },
        body: JSON.stringify({ query: body, limit: 3 })
      });
      
      const data = await resp.json();
      if (data && data.results) {
        enriched.memory_context = {
          recent_observations: data.results.map(r => ({
            snippet: r.snippet,
            path: r.path,
            score: r.score
          }))
        };
      } else if (data && data.error) {
        enriched.enrichment_errors.push(\`Memory enrichment API error: \${data.error} - \${data.message || ''}\`);
      }
    } catch (e) {
      enriched.enrichment_errors.push(\`Memory enrichment fetch failed: \${e.message}\`);
    }
  }

  // 2. Enrich with Intent (via user-intent-kit / Ant Farm API)
  const intentCfg = config.intent || {};
  if (intentCfg.baseUrl && intentCfg.apiKey && intentCfg.userId) {
    try {
      const url = \`\${intentCfg.baseUrl}/intent/\${intentCfg.userId}\`;
      const resp = await fetch(url, {
        headers: { 'X-API-Key': intentCfg.apiKey }
      });
      
      const data = await resp.json();
      if (data) {
        enriched.intent = {
          ...data,
          provider: 'antfarm'
        };
      }
    } catch (e) {
      enriched.enrichment_errors.push(\`Intent enrichment failed: \${e.message}\`);
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
