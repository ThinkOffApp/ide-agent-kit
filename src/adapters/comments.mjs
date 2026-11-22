// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { fetchJson } from '../common/http.mjs';

/**
 * Comments adapter — polls Moltbook posts and GitHub issues/discussions
 * for new comments. Composite adapter covering two sources.
 */

async function fetchMoltbookComments(postId, baseUrl = 'https://www.moltbook.com') {
  try {
    const root = String(baseUrl || 'https://www.moltbook.com').replace(/\/$/, '');
    const data = await fetchJson(`${root}/api/v1/posts/${encodeURIComponent(postId)}/comments`);
    return Array.isArray(data) ? data : (data.comments || []);
  } catch (e) {
    console.error(`  moltbook ${String(postId).slice(0, 8)} failed: ${e.message}`);
    return [];
  }
}

async function fetchGitHubComments(owner, repo, number, type = 'issues', token = '') {
  const endpoint = type === 'discussion'
    ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/discussions/${encodeURIComponent(number)}/comments`
    : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`;
  try {
    const data = await fetchJson(`${endpoint}?per_page=50&sort=created&direction=desc`, { token });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error(`  github ${owner}/${repo}#${number} failed: ${e.message}`);
    return [];
  }
}

async function fetchGitHubIssues(owner, repo, token = '') {
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&sort=updated&direction=desc&per_page=10`,
      { token },
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export const commentsAdapter = {
  name: 'comments',

  async fetch(config) {
    const commentsCfg = config?.comments || {};
    const all = [];

    // Moltbook comments
    const moltbookCfg = commentsCfg.moltbook || {};
    const posts = moltbookCfg.posts || [];
    const moltBaseUrl = moltbookCfg.base_url || 'https://www.moltbook.com';

    for (const postId of posts) {
      const comments = await fetchMoltbookComments(postId, moltBaseUrl);
      for (const c of comments) {
        c._source = 'moltbook';
        c._postId = postId;
        c._baseUrl = moltBaseUrl;
      }
      all.push(...comments);
    }

    // GitHub comments
    const githubCfg = commentsCfg.github || {};
    const repos = githubCfg.repos || [];
    const ghToken = githubCfg.token || '';

    for (const repoCfg of repos) {
      const { owner, repo, type } = repoCfg;

      if (repoCfg.number) {
        const comments = await fetchGitHubComments(owner, repo, repoCfg.number, type, ghToken);
        for (const c of comments) {
          c._source = 'github';
          c._owner = owner;
          c._repo = repo;
          c._number = repoCfg.number;
          c._type = type || 'issues';
        }
        all.push(...comments);
      } else if (type === 'issues') {
        const issues = await fetchGitHubIssues(owner, repo, ghToken);
        for (const issue of issues) {
          if (!issue.comments || issue.comments === 0) continue;
          const comments = await fetchGitHubComments(owner, repo, issue.number, 'issues', ghToken);
          for (const c of comments) {
            c._source = 'github';
            c._owner = owner;
            c._repo = repo;
            c._number = issue.number;
            c._type = 'issues';
          }
          all.push(...comments);
        }
      }
    }

    return all;
  },

  getKey(msg) {
    const cid = msg.id || '';
    if (!cid) return null;
    if (msg._source === 'moltbook') return `moltbook:${cid}`;
    if (msg._source === 'github') return `github:${msg._owner}/${msg._repo}:${cid}`;
    return `comment:${cid}`;
  },

  shouldSkip() {
    return false;
  },

  normalize(msg) {
    if (msg._source === 'moltbook') {
      const author = typeof msg.author === 'object' ? msg.author?.name : (msg.author || '?');
      return {
        trace_id: randomUUID(),
        event_id: msg.id,
        source: 'moltbook',
        kind: 'moltbook.comment.created',
        timestamp: msg.created_at || msg.createdAt || new Date().toISOString(),
        actor: { login: author },
        payload: {
          body: (msg.body || msg.content || '').slice(0, 500),
          post_id: msg._postId,
          comment_id: msg.id,
          url: `${msg._baseUrl}/post/${msg._postId}#comment-${msg.id}`
        }
      };
    }

    // GitHub
    return {
      trace_id: randomUUID(),
      event_id: String(msg.id),
      source: 'github',
      kind: `github.${msg._type}.comment.created`,
      timestamp: msg.created_at || new Date().toISOString(),
      actor: { login: msg.user?.login || '?' },
      payload: {
        body: (msg.body || '').slice(0, 500),
        repo: `${msg._owner}/${msg._repo}`,
        number: msg._number,
        comment_id: String(msg.id),
        url: msg.html_url || `https://github.com/${msg._owner}/${msg._repo}/issues/${msg._number}`
      }
    };
  },

  formatLine(event) {
    const ts = (event.timestamp || '').slice(0, 19);
    const sender = event.actor?.login || '?';
    const body = (event.payload?.body || '').replace(/\n/g, ' ').slice(0, 200);
    if (event.source === 'moltbook') {
      return `[${ts}] [moltbook/${event.payload?.post_id?.slice(0, 8)}] ${sender}: ${body}`;
    }
    return `[${ts}] [${event.payload?.repo}#${event.payload?.number}] ${sender}: ${body}`;
  }
};
