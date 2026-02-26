// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function nudgeTmux(session) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`);
    execSync(`tmux send-keys -t ${JSON.stringify(session)} -l "check rooms"`);
    setTimeout(() => {
      try { execSync(`tmux send-keys -t ${JSON.stringify(session)} Enter`); } catch {}
    }, 300);
  } catch {}
}

function verifyGitHubSignature(payload, signature, secret) {
  if (!secret) return true; // No secret configured = skip verification
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

function normalizeGitHubEvent(event, body) {
  const kind = buildKind(event, body);
  if (!kind) return null;

  const repo = body.repository || {};
  const sender = body.sender || {};

  const normalized = {
    trace_id: randomUUID(),
    event_id: body.delivery || randomUUID(),
    source: 'github',
    kind,
    timestamp: new Date().toISOString(),
    repo: {
      owner: repo.owner?.login || '',
      name: repo.name || '',
      full_name: repo.full_name || '',
      url: repo.html_url || ''
    },
    actor: {
      login: sender.login || '',
      url: sender.html_url || ''
    },
    refs: extractRefs(event, body),
    payload: extractMinPayload(event, body)
  };

  return normalized;
}

function buildKind(event, body) {
  const action = body.action || '';
  const map = {
    'pull_request.opened': 'github.pull_request.opened',
    'pull_request.synchronize': 'github.pull_request.synchronize',
    'issue_comment.created': 'github.issue_comment.created',
    'check_suite.completed': 'github.check_suite.completed',
    'workflow_run.completed': 'github.workflow_run.completed'
  };
  return map[`${event}.${action}`] || null;
}

function extractRefs(event, body) {
  const refs = {};
  if (body.pull_request) {
    refs.pull_request_url = body.pull_request.html_url;
    refs.head_sha = body.pull_request.head?.sha;
    refs.branch = body.pull_request.head?.ref;
  }
  if (body.issue) {
    refs.issue_url = body.issue.html_url;
  }
  if (body.comment) {
    refs.comment_url = body.comment.html_url;
  }
  return refs;
}

function extractMinPayload(event, body) {
  // Keep payload small — just title/body for PRs and comments
  const p = {};
  if (body.pull_request) {
    p.title = body.pull_request.title;
    p.number = body.pull_request.number;
  }
  if (body.issue) {
    p.issue_number = body.issue.number;
    p.issue_title = body.issue.title;
  }
  if (body.comment) {
    p.comment_body = (body.comment.body || '').slice(0, 500);
  }
  return p;
}

export function startWebhookServer(config, onEvent) {
  const { host, port } = config.listen;
  const secret = config.github.webhook_secret;
  const allowedEvents = config.github.event_kinds;
  const queuePath = config.queue.path;

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
      return;
    }

    // Ant Farm webhook endpoint
    if (req.method === 'POST' && req.url === '/antfarm') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }

      // Ant Farm sends nested objects: room can be {slug, name, id}, author can be {handle, name}
      const roomSlug = typeof body.room === 'object' ? (body.room?.slug || body.room?.name || '') : (body.room || '');
      const authorHandle = typeof body.author === 'object' ? (body.author?.handle || body.author?.name || '?') : (body.from || body.author || '?');
      const rawBody = body.body || body.message || body.content || '';
      const msgBody = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody) || '';

      const event = {
        trace_id: randomUUID(),
        event_id: body.id || randomUUID(),
        source: 'antfarm',
        kind: 'antfarm.message.created',
        timestamp: body.created_at || new Date().toISOString(),
        room: roomSlug,
        actor: { login: authorHandle },
        payload: { body: msgBody.slice(0, 500), room: roomSlug }
      };

      appendFileSync(queuePath, JSON.stringify(event) + '\n');
      if (onEvent) onEvent(event);
      console.log(`[${event.timestamp}] antfarm message from ${event.actor.login} in ${event.room} → queued`);

      // Wake up the IDE agent via tmux
      nudgeTmux(config.tmux?.ide_session || config.tmux?.default_session || 'claude');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued', trace_id: event.trace_id }));
      return;
    }

    // Discord webhook endpoint
    if (req.method === 'POST' && req.url === '/discord') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }

      const messages = body.payload?.messages || (body.messages ? body.messages : [body]);
      let queued = 0;

      for (const m of messages) {
        const event = {
          trace_id: randomUUID(),
          event_id: m.id || randomUUID(),
          source: 'discord',
          kind: 'discord.message.created',
          timestamp: m.timestamp || new Date().toISOString(),
          channel: m.channel_id || body.channel_id || '',
          actor: { login: m.author?.username || '?' },
          payload: { body: (m.content || '').slice(0, 500), channel_id: m.channel_id || '' }
        };

        appendFileSync(queuePath, JSON.stringify(event) + '\n');
        if (onEvent) onEvent(event);
        queued++;
      }

      console.log(`[${new Date().toISOString()}] discord webhook: ${queued} message(s) queued`);
      nudgeTmux(config.tmux?.ide_session || config.tmux?.default_session || 'claude');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued', count: queued }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Verify signature
    const sig = req.headers['x-hub-signature-256'];
    if (!verifyGitHubSignature(rawBody, sig, secret)) {
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    const event = req.headers['x-github-event'];
    if (!allowedEvents.includes(event)) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ignored', reason: `event ${event} not in allowlist` }));
      return;
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString());
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const normalized = normalizeGitHubEvent(event, body);
    if (!normalized) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ignored', reason: 'action not mapped' }));
      return;
    }

    // Append to queue
    appendFileSync(queuePath, JSON.stringify(normalized) + '\n');

    // Callback
    if (onEvent) onEvent(normalized);

    console.log(`[${normalized.timestamp}] ${normalized.kind} from ${normalized.actor.login} → queued`);

    // Nudge IDE agent
    nudgeTmux(config.tmux?.ide_session || config.tmux?.default_session || 'claude');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'queued', trace_id: normalized.trace_id }));
  });

  server.listen(port, host, () => {
    console.log(`IDE Agent Kit webhook server listening on ${host}:${port}`);
    console.log(`  POST /webhook  — GitHub webhook endpoint`);
    console.log(`  POST /antfarm  — Ant Farm webhook endpoint`);
    console.log(`  POST /discord  — Discord message webhook endpoint`);
    console.log(`  GET  /health   — Health check`);
    console.log(`  Queue: ${queuePath}`);
  });

  return server;
}
