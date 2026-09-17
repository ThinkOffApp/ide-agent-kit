// SPDX-License-Identifier: AGPL-3.0
import { readFile } from 'node:fs/promises';

/** Local, read-only model discovery. Never uses the intent API credential. */
export function createModelDiscovery({ env = process.env, fetchImpl = fetch,
  readKey = path => readFile(path, 'utf8'), now = () => Date.now(), cacheMs = 60000 } = {}) {
  let cached, last = -Infinity, pending;
  const explicit = env.INTENT_MODEL_SERVER_URL;
  const kind = env.INTENT_MODEL_SERVER_KIND || 'openai';
  const endpoints = explicit ? [{ url: explicit, kind }] : [
    { url: 'http://127.0.0.1:1234', kind: 'lmstudio' },
    ...[8080, 8000, 8888].map(port => ({ url: `http://127.0.0.1:${port}`, kind: 'openai' })),
  ];
  async function probe(endpoint) {
    try {
      const url = new URL(endpoint.url);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash ||
          !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
        return { status: 'invalid_config' };
      }
      if (!['openai', 'lmstudio'].includes(endpoint.kind)) return { status: 'invalid_config' };
      const headers = {};
      if (explicit && env.INTENT_MODEL_SERVER_KEY_FILE) {
        headers.Authorization = `Bearer ${(await readKey(env.INTENT_MODEL_SERVER_KEY_FILE)).trim()}`;
      }
      const suffix = endpoint.kind === 'lmstudio' ? '/api/v1/models' : '/v1/models';
      const response = await fetchImpl(url.href.replace(/\/$/, '') + suffix, {
        headers, redirect: 'error', signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return { status: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unknown' };
      const data = await response.json();
      const rows = endpoint.kind === 'lmstudio' ? data.models : data.data;
      if (!Array.isArray(rows)) return { status: 'unknown' };
      // LM Studio's OpenAI list includes downloaded/JIT models: use loaded instances.
      if (endpoint.kind === 'lmstudio' && rows.some(m => !m || !Array.isArray(m.loaded_instances))) return { status: 'unknown' };
      const ids = endpoint.kind === 'lmstudio'
        ? rows.filter(m => m.type === 'llm').flatMap(m => m.loaded_instances.map(i => i.id))
        : rows.map(m => m?.id);
      if (ids.some(id => typeof id !== 'string' || !id.trim())) return { status: 'unknown' };
      return { status: ids.length ? (endpoint.kind === 'lmstudio' ? 'loaded' : 'advertised') : 'none',
        ids, source: endpoint.kind };
    } catch { return { status: 'unknown' }; }
  }
  async function discover() {
    const results = await Promise.all(endpoints.map(probe));
    const good = results.filter(r => r.ids?.length);
    const models = [...new Set(good.flatMap(r => r.ids))].sort();
    const allKnown = results.every(r => Array.isArray(r.ids));
    let status = models.length ? (good.every(r => r.status === 'loaded') ? 'loaded' : 'advertised')
      : allKnown ? 'none' : results.some(r => r.status === 'unauthorized') ? 'unauthorized' : 'unknown';
    let source = good.length ? [...new Set(good.map(r => r.source))].join(',') : null;
    let model = models.length ? models.join(', ') : null;
    if (!model && status !== 'none' && env.INTENT_DEVICE_MODEL?.trim()) {
      model = `${env.INTENT_DEVICE_MODEL.trim()} (manual)`;
      source = 'manual';
      // Keep the failure cause separately; never turn a configured label into live proof.
      status = `manual:${status}`;
    }
    return { model, models, model_status: status, model_source: source,
      model_checked_at: new Date(now()).toISOString() };
  }
  return async () => {
    if (cached && now() >= last && now() - last < cacheMs) return structuredClone(cached);
    if (!pending) pending = discover().then(value => { cached = value; last = now(); return value; })
      .finally(() => { pending = undefined; });
    return structuredClone(await pending);
  };
}
