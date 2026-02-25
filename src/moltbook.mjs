// SPDX-License-Identifier: AGPL-3.0-only

import { request as httpsRequest } from 'node:https';

/**
 * Moltbook — Post to Moltbook social platform for AI agents.
 *
 * Config (in ide-agent-kit.json):
 *   moltbook.api_key  — Moltbook API key (X-API-Key header)
 *   moltbook.base_url — Base URL (default: https://www.moltbook.com)
 *
 * Flow:
 *   1. POST /api/v1/posts with content → returns challenge (math verification)
 *   2. Solve the challenge
 *   3. POST /api/v1/verify with verification_code + answer → publishes the post
 */

const DEFAULT_BASE_URL = 'https://www.moltbook.com';

function moltbookFetch(baseUrl, path, method, apiKey, body = null) {
  const url = new URL(path, baseUrl);

  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      }
    };

    const req = httpsRequest(url, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Solve a simple math challenge string like "What is 7 + 3?"
 * Returns the numeric answer as a string, or null if unparseable.
 */
function solveChallenge(challengeText) {
  if (!challengeText) return null;

  // Try to extract "X op Y" patterns
  const match = challengeText.match(/(-?\d+)\s*([+\-*/×÷])\s*(-?\d+)/);
  if (!match) return null;

  const a = parseInt(match[1], 10);
  const op = match[2];
  const b = parseInt(match[3], 10);

  let result;
  switch (op) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '*': case '×': result = a * b; break;
    case '/': case '÷': result = b !== 0 ? a / b : null; break;
    default: return null;
  }

  return result != null ? String(result) : null;
}

/**
 * Create a post on Moltbook with auto-verification.
 *
 * @param {object} config - IDE Agent Kit config
 * @param {object} params - { content, submolt?, title? }
 * @returns {object} - { ok, data, url? } or { ok: false, error }
 */
export async function moltbookPost(config, params) {
  const apiKey = params.apiKey || config?.moltbook?.api_key;
  const baseUrl = config?.moltbook?.base_url || DEFAULT_BASE_URL;

  if (!apiKey) {
    return { ok: false, error: 'No Moltbook API key. Set moltbook.api_key in config or pass --api-key.' };
  }
  if (!params.content) {
    return { ok: false, error: 'Content is required.' };
  }

  const postBody = { content: params.content };
  if (params.submolt) postBody.submolt = params.submolt;
  if (params.title) postBody.title = params.title;

  // Step 1: Create post (may return challenge)
  const postRes = await moltbookFetch(baseUrl, '/api/v1/posts', 'POST', apiKey, postBody);

  if (postRes.status === 403) {
    return { ok: false, error: postRes.data?.message || 'Forbidden — key may need claiming at /claim' };
  }

  // If post succeeded directly (no challenge)
  if (postRes.status === 200 || postRes.status === 201) {
    const postId = postRes.data?.id || postRes.data?.post?.id;
    return {
      ok: true,
      data: postRes.data,
      url: postId ? `${baseUrl}/post/${postId}` : null
    };
  }

  // Step 2: Handle challenge-verify flow
  const challenge = postRes.data?.challenge || postRes.data?.verification_challenge;
  const verificationCode = postRes.data?.verification_code;

  if (!challenge && !verificationCode) {
    // Unknown response — return as-is
    return {
      ok: postRes.status < 400,
      data: postRes.data,
      error: postRes.status >= 400 ? (postRes.data?.message || `HTTP ${postRes.status}`) : undefined
    };
  }

  // Solve the math challenge
  const answer = solveChallenge(challenge);
  if (!answer) {
    return {
      ok: false,
      error: `Could not solve challenge: "${challenge}"`,
      data: postRes.data
    };
  }

  // Step 3: Verify
  const verifyRes = await moltbookFetch(baseUrl, '/api/v1/verify', 'POST', apiKey, {
    verification_code: verificationCode,
    answer
  });

  if (verifyRes.status >= 400) {
    return {
      ok: false,
      error: verifyRes.data?.message || `Verify failed: HTTP ${verifyRes.status}`,
      data: verifyRes.data
    };
  }

  const postId = verifyRes.data?.id || verifyRes.data?.post?.id || postRes.data?.id;
  return {
    ok: true,
    data: verifyRes.data,
    url: postId ? `${baseUrl}/post/${postId}` : null
  };
}

/**
 * Read recent posts from Moltbook feed.
 *
 * @param {object} config - IDE Agent Kit config
 * @param {object} params - { limit?, submolt?, cursor? }
 * @returns {object} - { ok, data }
 */
export async function moltbookFeed(config, params = {}) {
  const apiKey = params.apiKey || config?.moltbook?.api_key || '';
  const baseUrl = config?.moltbook?.base_url || DEFAULT_BASE_URL;
  const limit = params.limit || 10;

  let path = `/api/v1/posts?limit=${limit}`;
  if (params.submolt) path += `&submolt=${encodeURIComponent(params.submolt)}`;
  if (params.cursor) path += `&cursor=${encodeURIComponent(params.cursor)}`;

  const res = await moltbookFetch(baseUrl, path, 'GET', apiKey);

  if (res.status >= 400) {
    return { ok: false, error: res.data?.message || `HTTP ${res.status}` };
  }

  return { ok: true, data: res.data };
}
