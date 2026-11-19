// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Replace global fetch for poller tests that used to stub curl on PATH.
 * decide(url, opts) returns the JSON body (already parsed).
 */
export function mockFetchByUrl(decide) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const payload = decide(String(url), opts);
    return {
      ok: true,
      json: async () => payload,
    };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

export function roomPayload(url, { seed, poll, dms = [] }) {
  if (url.includes('/rooms/')) {
    return url.includes('limit=50') ? seed : poll;
  }
  return dms;
}
