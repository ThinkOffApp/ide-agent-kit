// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nudgeTmux } from './common/notify.mjs';
import { fetchJson, publicFetchErrorMessage } from './common/http.mjs';

/**
 * Comment Poller — polls Moltbook posts and GitHub issues/discussions
 * for new comments. Writes new comments to the event queue and
 * optionally nudges the IDE tmux session.
 *
 * Config (in ide-agent-kit.json under comments):
 *   {
 *     "moltbook": {
 *       "posts": ["uuid1", "uuid2"],
 *       "base_url": "https://www.moltbook.com"
 *     },
 *     "github": {
 *       "repos": [
 *         { "owner": "ThinkOffApp", "repo": "ide-agent-kit", "type": "issues" },
 *         { "owner": "HKUDS", "repo": "nanobot", "number": 431, "type": "discussion" }
 *       ],
 *       "token": ""
 *     },
 *     "interval_sec": 120,
 *     "seen_file": "/tmp/iak-comment-seen.txt"
 *   }
 */

const SEEN_FILE_DEFAULT = '/tmp/iak-comment-seen.txt';

function loadSeenIds(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveSeenIds(path, ids) {
  const arr = [...ids].slice(-5000);
  writeFileSync(path, arr.join('\n') + '\n');
}

/**
 * Fetch comments for a Moltbook post.
 */
async function fetchMoltbookComments(postId, baseUrl = 'https://www.moltbook.com') {
  try {
    const root = String(baseUrl || 'https://www.moltbook.com').replace(/\/$/, '');
    const data = await fetchJson(`${root}/api/v1/posts/${encodeURIComponent(postId)}/comments`);
    return Array.isArray(data) ? data : (data.comments || []);
  } catch (e) {
    console.error(`  moltbook ${String(postId).slice(0, 8)} failed: ${publicFetchErrorMessage(e)}`);
    return [];
  }
}

/**
 * Fetch comments for a GitHub issue or discussion.
 */
async function fetchGitHubComments(owner, repo, number, type = 'issues', token = '') {
  const endpoint = type === 'discussion'
    ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/discussions/${encodeURIComponent(number)}/comments`
    : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`;
  try {
    const data = await fetchJson(`${endpoint}?per_page=50&sort=created&direction=desc`, { token });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error(`  github ${owner}/${repo}#${number} failed: ${publicFetchErrorMessage(e)}`);
    return [];
  }
}

/**
 * Fetch all open issues for a GitHub repo (to discover new comments).
 */
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

/**
 * Poll all configured sources for new comments.
 *
 * @returns {object[]} Array of new comment events
 */
export async function pollComments(config) {
  const commentsCfg = config?.comments || {};
  const seen = loadSeenIds(commentsCfg.seen_file || SEEN_FILE_DEFAULT);
  const newComments = [];

  // Poll Moltbook posts
  const moltbookCfg = commentsCfg.moltbook || {};
  const posts = moltbookCfg.posts || [];
  const moltBaseUrl = moltbookCfg.base_url || 'https://www.moltbook.com';

  for (const postId of posts) {
    const comments = await fetchMoltbookComments(postId, moltBaseUrl);
    for (const c of comments) {
      const cid = c.id || '';
      const key = `moltbook:${cid}`;
      if (!cid || seen.has(key)) continue;
      seen.add(key);

      const author = typeof c.author === 'object' ? c.author?.name : (c.author || '?');
      newComments.push({
        trace_id: randomUUID(),
        source: 'moltbook',
        kind: 'moltbook.comment.created',
        timestamp: c.created_at || c.createdAt || new Date().toISOString(),
        post_id: postId,
        comment_id: cid,
        author,
        body: (c.body || c.content || '').slice(0, 500),
        url: `${moltBaseUrl}/post/${postId}#comment-${cid}`
      });
    }
  }

  // Poll GitHub repos
  const githubCfg = commentsCfg.github || {};
  const repos = githubCfg.repos || [];
  const ghToken = githubCfg.token || '';

  for (const repoCfg of repos) {
    const { owner, repo, type } = repoCfg;

    if (repoCfg.number) {
      // Poll specific issue/discussion
      const comments = await fetchGitHubComments(owner, repo, repoCfg.number, type, ghToken);
      for (const c of comments) {
        const cid = String(c.id || '');
        const key = `github:${owner}/${repo}:${cid}`;
        if (!cid || seen.has(key)) continue;
        seen.add(key);

        newComments.push({
          trace_id: randomUUID(),
          source: 'github',
          kind: `github.${type || 'issues'}.comment.created`,
          timestamp: c.created_at || new Date().toISOString(),
          repo: `${owner}/${repo}`,
          number: repoCfg.number,
          comment_id: cid,
          author: c.user?.login || '?',
          body: (c.body || '').slice(0, 500),
          url: c.html_url || `https://github.com/${owner}/${repo}/issues/${repoCfg.number}`
        });
      }
    } else if (type === 'issues') {
      // Poll all open issues for new comments
      const issues = await fetchGitHubIssues(owner, repo, ghToken);
      for (const issue of issues) {
        if (!issue.comments || issue.comments === 0) continue;
        const comments = await fetchGitHubComments(owner, repo, issue.number, 'issues', ghToken);
        for (const c of comments) {
          const cid = String(c.id || '');
          const key = `github:${owner}/${repo}:${cid}`;
          if (!cid || seen.has(key)) continue;
          seen.add(key);

          newComments.push({
            trace_id: randomUUID(),
            source: 'github',
            kind: 'github.issues.comment.created',
            timestamp: c.created_at || new Date().toISOString(),
            repo: `${owner}/${repo}`,
            number: issue.number,
            comment_id: cid,
            author: c.user?.login || '?',
            body: (c.body || '').slice(0, 500),
            url: c.html_url || ''
          });
        }
      }
    }
  }

  saveSeenIds(commentsCfg.seen_file || SEEN_FILE_DEFAULT, seen);
  return newComments;
}

/**
 * Start the comment poller as a long-running process.
 */
export async function startCommentPoller({ config, interval }) {
  const commentsCfg = config?.comments || {};
  const pollInterval = interval || commentsCfg.interval_sec || 120;
  const queuePath = config?.queue?.path || './ide-agent-queue.jsonl';
  const session = config?.tmux?.ide_session || 'claude';
  const nudgeText = config?.tmux?.nudge_text || 'check rooms';

  const moltPosts = commentsCfg.moltbook?.posts || [];
  const ghRepos = commentsCfg.github?.repos || [];

  console.log(`Comment poller started`);
  console.log(`  moltbook posts: ${moltPosts.length}`);
  console.log(`  github repos: ${ghRepos.length}`);
  console.log(`  interval: ${pollInterval}s`);

  // Seed: do initial poll to mark existing comments as seen
  console.log(`  seeding existing comments...`);
  const initial = await pollComments(config);
  console.log(`  seeded (${initial.length} comments marked as seen)`);

  async function poll() {
    const newComments = await pollComments(config);

    if (newComments.length > 0) {
      for (const c of newComments) {
        appendFileSync(queuePath, JSON.stringify(c) + '\n');
        const sourceLabel = c.source === 'moltbook'
          ? `moltbook/${c.post_id?.slice(0, 8)}`
          : `${c.repo}#${c.number}`;
        console.log(`  NEW: @${c.author} on ${sourceLabel}: ${c.body.slice(0, 80)}`);
      }

      const nudged = nudgeTmux(session, nudgeText);
      console.log(`  ${newComments.length} new comment(s) → ${nudged ? 'nudged' : 'no tmux session'}`);
    }
  }

  // Schedule the next tick only after the current poll finishes. setInterval
  // started overlapping fetches once pollComments became async, and each tick
  // reloaded its own seen set, so the same comment was delivered more than once.
  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, pollInterval * 1000);
    }
  }

  timer = setTimeout(tick, pollInterval * 1000);

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  process.on('SIGINT', () => {
    console.log('\nComment poller stopped.');
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  return { stop };
}
