// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';
import { initTaskQueue, addTask, startTask, completeTask, failTask, cancelTask, queueTask, draftTask, installTask, vote, reviewTask, setStatus, listTasks, getTask, missionControlData } from './task-queue.mjs';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control — IDE Agent Kit</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 4px; font-size: 1.4em; }
  .subtitle { color: #8b949e; margin-bottom: 20px; font-size: 0.85em; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 800px) { .columns { grid-template-columns: 1fr; } }
  .column { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; min-height: 200px; }
  .column-header { font-size: 1.1em; font-weight: bold; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
  .column-header.proposals { color: #d29922; }
  .column-header.implementation { color: #58a6ff; }
  .column-count { font-size: 0.8em; font-weight: normal; color: #8b949e; }
  .group { margin-bottom: 14px; }
  .group-label { font-size: 0.75em; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; margin-bottom: 6px; }
  .group-label.recommended { color: #3fb950; }
  .group-label.to_review { color: #d29922; }
  .group-label.discarded { color: #f85149; }
  .group-label.queued { color: #8b949e; }
  .group-label.active { color: #58a6ff; }
  .group-label.drafted { color: #bc8cff; }
  .group-label.to_install { color: #3fb950; }
  .group-label.installed { color: #3fb950; }
  .task-card { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .task-card.recommended { border-left: 3px solid #3fb950; }
  .task-card.to_review, .task-card.proposed { border-left: 3px solid #d29922; }
  .task-card.discarded { border-left: 3px solid #f85149; opacity: 0.5; }
  .task-card.queued { border-left: 3px solid #8b949e; }
  .task-card.active { border-left: 3px solid #58a6ff; }
  .task-card.drafted { border-left: 3px solid #bc8cff; }
  .task-card.to_install { border-left: 3px solid #3fb950; }
  .task-card.installed { border-left: 3px solid #3fb950; opacity: 0.7; }
  .task-header { display: flex; justify-content: space-between; align-items: center; }
  .task-title { font-weight: bold; font-size: 0.9em; flex: 1; }
  .task-title.recommended { color: #3fb950; }
  .task-title.to_review, .task-title.proposed { color: #d29922; }
  .task-title.discarded { color: #f85149; }
  .task-meta { color: #8b949e; font-size: 0.75em; margin-top: 2px; }
  .badge { padding: 1px 7px; border-radius: 10px; font-size: 0.7em; font-weight: bold; display: inline-block; margin-left: 4px; }
  .badge.feature { background: #1f6feb; color: #fff; }
  .badge.bug { background: #f85149; color: #fff; }
  .badge.approve { background: #238636; color: #fff; }
  .badge.reject { background: #da3633; color: #fff; }
  .badge.changes_requested { background: #d29922; color: #0d1117; }
  .badge.escalated { background: #f85149; color: #fff; }
  .votes, .reviews { margin-top: 3px; font-size: 0.8em; }
  .votes span, .reviews span { margin-right: 6px; }
  .agent-tag { color: #58a6ff; }
  .empty { color: #484f58; padding: 12px; text-align: center; font-style: italic; font-size: 0.85em; }
  .toggle-link { color: #8b949e; font-size: 0.75em; cursor: pointer; text-decoration: underline; }
  .collapsed { display: none; }
  .bugs-section { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }
  .bugs-section.clear { border-color: #238636; }
  .bugs-header { font-size: 1.1em; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
  .bugs-header.clear { color: #3fb950; }
  .bugs-header.active { color: #f85149; }
  .bugs-ok { color: #3fb950; font-size: 0.9em; padding: 8px 0; }
  .refresh { color: #484f58; font-size: 0.7em; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<h1>Mission Control</h1>
<p class="subtitle">IDE Agent Kit — team-relay</p>
<div id="bugs-banner"></div>
<div class="columns" id="app"><div class="empty">Loading...</div></div>
<p class="refresh">Auto-refreshes every 5s</p>
<script>
let showDiscarded = false;

function taskCard(task) {
  const titleCls = ['recommended','to_review','proposed','discarded'].includes(task.status) ? 'task-title '+task.status : 'task-title';
  let h = '<div class="task-card '+task.status+'">';
  h += '<div class="task-header"><span class="'+titleCls+'">'+task.title+'</span>';
  h += '<span class="badge '+task.type+'">'+task.type+'</span>';
  if (task.escalated) h += '<span class="badge escalated">!</span>';
  h += '</div>';
  h += '<div class="task-meta"><span class="agent-tag">@'+task.agent+'</span> &middot; '+task.id+'</div>';
  if (Object.keys(task.votes||{}).length > 0) {
    h += '<div class="votes">';
    for (const [a,v] of Object.entries(task.votes)) {
      h += '<span><span class="agent-tag">@'+a+'</span> <span class="badge '+v+'">'+v+'</span></span>';
    }
    h += '</div>';
  }
  if (Object.keys(task.reviews||{}).length > 0) {
    h += '<div class="reviews">Round '+task.review_round+': ';
    for (const [a,v] of Object.entries(task.reviews)) {
      h += '<span><span class="agent-tag">@'+a+'</span> <span class="badge '+v+'">'+(v==='changes_requested'?'changes':v)+'</span></span>';
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function renderGroup(label, cls, items) {
  if (items.length === 0) return '';
  let h = '<div class="group"><div class="group-label '+cls+'">'+label+' ('+items.length+')</div>';
  for (const t of items) h += taskCard(t);
  h += '</div>';
  return h;
}

async function load() {
  const data = await fetch('/api/status').then(r=>r.json());
  const tabs = data.tabs;
  const allTasks = await fetch('/api/tasks').then(r=>r.json());
  const bugs = allTasks.filter(t => t.type === 'bug');
  const activeBugs = bugs.filter(t => !['done','installed','cancelled'].includes(t.status));

  // Bugs banner
  let bugsHtml = '';
  if (activeBugs.length === 0) {
    bugsHtml = '<div class="bugs-section clear"><div class="bugs-header clear">Bugs</div><div class="bugs-ok">Zero known bugs active</div></div>';
  } else {
    bugsHtml = '<div class="bugs-section"><div class="bugs-header active">Bugs <span class="column-count">'+activeBugs.length+' active</span></div>';
    for (const t of activeBugs) bugsHtml += taskCard(t);
    bugsHtml += '</div>';
  }
  document.getElementById('bugs-banner').innerHTML = bugsHtml;

  let left = '', right = '';

  // LEFT: Proposals
  const reviewItems = [...tabs.proposed, ...tabs.to_review];
  left += renderGroup('Recommended', 'recommended', tabs.recommended);
  left += renderGroup('To Review', 'to_review', reviewItems);
  if (tabs.discarded.length > 0) {
    left += '<span class="toggle-link" onclick="showDiscarded=!showDiscarded;load()">'+(showDiscarded?'Hide':'Show')+' '+tabs.discarded.length+' discarded</span>';
    if (showDiscarded) left += renderGroup('Discarded', 'discarded', tabs.discarded);
  }
  if (!left) left = '<div class="empty">No proposals</div>';

  // RIGHT: Implementation
  right += renderGroup('Active', 'active', tabs.active);
  right += renderGroup('Queued', 'queued', tabs.queued);
  right += renderGroup('Drafted', 'drafted', tabs.drafted);
  right += renderGroup('To Install', 'to_install', tabs.to_install);
  right += renderGroup('Installed / Running', 'installed', tabs.installed);
  if (tabs.done.length > 0) {
    right += '<span class="toggle-link" onclick="document.getElementById(\\'done-list\\').classList.toggle(\\'collapsed\\')">'+tabs.done.length+' completed</span>';
    right += '<div id="done-list" class="collapsed">'+renderGroup('Done', 'installed', tabs.done)+'</div>';
  }
  if (!right) right = '<div class="empty">No implementation work</div>';

  const proposalCount = tabs.recommended.length + reviewItems.length + tabs.discarded.length;
  const implCount = tabs.active.length + tabs.queued.length + tabs.drafted.length + tabs.to_install.length + tabs.installed.length + tabs.done.length;

  document.getElementById('app').innerHTML =
    '<div class="column"><div class="column-header proposals">Proposals <span class="column-count">'+proposalCount+'</span></div>'+left+'</div>'+
    '<div class="column"><div class="column-header implementation">Implementation <span class="column-count">'+implCount+'</span></div>'+right+'</div>';
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;

export function startMissionControl(config, port = 4800) {
  const tasksFile = config?.tasks?.file || '.iak-tasks.json';
  initTaskQueue(tasksFile);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(missionControlData()));
      return;
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      const agent = url.searchParams.get('agent');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listTasks({ status, agent })));
      return;
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { agent, title, priority, type } = JSON.parse(body);
          const task = addTask(agent, title, { priority: priority || 0, type: type || 'feature' });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(task));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(\w+)$/);
    if (actionMatch && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const [, taskId, action] = actionMatch;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}

        let task;
        switch (action) {
          case 'vote': task = vote(taskId, parsed.agent, parsed.decision); break;
          case 'queue': task = queueTask(taskId); break;
          case 'start': task = startTask(taskId); break;
          case 'draft': task = draftTask(taskId); break;
          case 'review': task = reviewTask(taskId, parsed.reviewer, parsed.decision); break;
          case 'install': task = installTask(taskId); break;
          case 'done': task = completeTask(taskId, parsed.result); break;
          case 'fail': task = failTask(taskId, parsed.reason); break;
          case 'cancel': task = cancelTask(taskId); break;
          case 'status': task = setStatus(taskId, parsed.status); break;
          default:
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown action: ' + action }));
            return;
        }

        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Task not found or invalid params' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      });
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = getTask(taskMatch[1]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Mission Control: http://127.0.0.1:${port}/`);
  });

  return server;
}
