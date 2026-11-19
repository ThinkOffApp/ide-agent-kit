// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTTP JSON GET with optional token in a header. No child process.
 */
export async function fetchJson(url, { token, timeoutMs = 15000, headers = {} } = {}) {
  const h = { Accept: 'application/json', 'User-Agent': 'ide-agent-kit', ...headers };
  if (token) h.Authorization = `token ${token}`;
  const res = await fetch(String(url), {
    headers: h,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
