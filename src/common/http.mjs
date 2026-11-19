// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTTP JSON GET with optional token in a header. No child process.
 * Thrown messages never include header values (a bad token can make fetch
 * reject with the whole Authorization value in TypeError.message).
 */
export function publicFetchErrorMessage(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  if (/^HTTP \d+$/.test(m)) return m;
  if (m === 'request timed out') return m;
  return 'request failed';
}

export async function fetchJson(url, { token, timeoutMs = 15000, headers = {} } = {}) {
  try {
    const h = { Accept: 'application/json', 'User-Agent': 'ide-agent-kit', ...headers };
    if (token) h.Authorization = `token ${token}`;
    const res = await fetch(String(url), {
      headers: h,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    const name = e && e.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('request timed out');
    const m = e && typeof e.message === 'string' ? e.message : '';
    if (/^HTTP \d+$/.test(m)) throw e;
    throw new Error('request failed');
  }
}
