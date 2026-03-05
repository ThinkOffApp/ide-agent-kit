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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; max-width: 900px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 4px; font-size: 1.4em; }
  .subtitle { color: #8b949e; margin-bottom: 20px; font-size: 0.85em; }
  .view-toggle { margin-bottom: 16px; }
  .view-toggle button { padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d; background: #161b22; color: #8b949e; cursor: pointer; margin-right: 4px; font-size: 0.85em; }
  .view-toggle button.active { color: #c9d1d9; border-color: #58a6ff; background: #1c2333; }
  .section { margin-bottom: 24px; }
  .section-header { font-size: 1.1em; font-weight: bold; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #30363d; }
  .section-header.review { color: #d29922; }
  .section-header.ready { color: #3fb950; }
  .section-header.pipeline { color: #58a6ff; }
  .task-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
  .task-card.recommended { border-left: 3px solid #3fb950; }
  .task-card.to_review, .task-card.proposed { border-left: 3px solid #d29922; }
  .task-card.discarded { border-left: 3px solid #f85149; opacity: 0.6; }
  .task-card.drafted { border-left: 3px solid #bc8cff; }
  .task-card.to_install { border-left: 3px solid #3fb950; }
  .task-card.active { border-left: 3px solid #58a6ff; }
  .task-card.queued { border-left: 3px solid #8b949e; }
  .task-card.installed { border-left: 3px solid #3fb950; opacity: 0.8; }
  .task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .task-title { font-weight: bold; flex: 1; }
  .task-title.recommended { color: #3fb950; }
  .task-title.to_review, .task-title.proposed { color: #d29922; }
  .task-title.discarded { color: #f85149; }
  .task-meta { color: #8b949e; font-size: 0.8em; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75em; font-weight: bold; display: inline-block; margin-left: 4px; }
  .badge.feature { background: #1f6feb; color: #fff; }
  .badge.bug { background: #f85149; color: #fff; }
  .badge.approve { background: #238636; color: #fff; }
  .badge.reject { background: #da3633; color: #fff; }
  .badge.changes_requested { background: #d29922; color: #0d1117; }
  .badge.escalated { background: #f85149; color: #fff; }
  .badge.status { background: #30363d; color: #c9d1d9; }
  .votes, .reviews { margin-top: 4px; font-size: 0.85em; }
  .votes span, .reviews span { margin-right: 8px; }
  .agent-tag { color: #58a6ff; }
  .empty { color: #8b949e; padding: 16px; text-align: center; font-style: italic; }
  .collapsed { display: none; }
  .toggle-link { color: #8b949e; font-size: 0.8em; cursor: pointer; text-decoration: underline; margin-left: 8px; }
  .stats-bar { display: flex; gap: 16px; margin-bottom: 20px; font-size: 0.85em; color: #8b949e; }
  .stats-bar .num { font-weight: bold; color: #c9d1d9; }
  .refresh { color: #484f58; font-size: 0.7em; margin-top: 16px; }
  /* Detailed tab view */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8em; border: 1px solid #30363d; background: #161b22; color: #8b949e; }
  .tab.active { color: #c9d1d9; border-color: #58a6ff; background: #1c2333; }
  .tab .count { margin-left: 4px; font-size: 0.85em; color: #484f58; }
</style>
</head>
<body>
<h1>Mission Control</h1>
<p class="subtitle">IDE Agent Kit — team-relay</p>
<div class="view-toggle">
  <button id="btn-main" class="active" onclick="setView('main')">Main</button>
  <button id="btn-detail" onclick="setView('detail')">Detailed</button>
</div>
<div class="stats-bar" id="stats"></div>
<div id="main-view"></div>
<div id="detail-view" style="display:none"></div>
<p class="refresh">Auto-refreshes every 5s</p>
<script>
let view = 'main';
let currentTab = 'proposed';
let discardedVisible = false;
const TAB_ORDER = ['proposed','recommended','to_review','discarded','queued','active','drafted','to_install','installed','done'];
const TAB_LABELS = {proposed:'To Review',recommended:'Recommended',to_review:'To Review',discarded:'Discarded',queued:'Queued',active:'Active',drafted:'Drafted',to_install:'To Install',installed:'Installed',done:'Done'};

function setView(v) {
  view = v;
  document.getElementById('btn-main').className = v==='main'?'active':'';
  document.getElementById('btn-detail').className = v==='detail'?'active':'';
  document.getElementById('main-view').style.display = v==='main'?'block':'none';
  document.getElementById('detail-view').style.display = v==='detail'?'block':'none';
  load();
}

function taskCard(task) {
  const statusClass = task.status;
  const titleClass = ['recommended','to_review','proposed','discarded'].includes(task.status) ? 'task-title '+task.status : 'task-title';
  let html = '<div class="task-card '+statusClass+'">';
  html += '<div class="task-header"><span class="'+titleClass+'">'+task.title+'</span>';
  html += '<span class="badge '+task.type+'">'+task.type+'</span>';
  if (task.escalated) html += '<span class="badge escalated">escalated</span>';
  if (['queued','active','drafted','to_install','installed','done'].includes(task.status)) {
    html += '<span class="badge status">'+task.status.replace('_',' ')+'</span>';
  }
  html += '</div>';
  html += '<div class="task-meta"><span class="agent-tag">@'+task.agent+'</span> &middot; '+task.id+' &middot; '+task.updated.slice(0,16)+'</div>';
  if (Object.keys(task.votes||{}).length > 0) {
    html += '<div class="votes">Votes: ';
    for (const [a,v] of Object.entries(task.votes)) {
      html += '<span><span class="agent-tag">@'+a+'</span> <span class="badge '+v+'">'+v+'</span></span>';
    }
    html += '</div>';
  }
  if (Object.keys(task.reviews||{}).length > 0) {
    html += '<div class="reviews">Reviews (round '+task.review_round+'): ';
    for (const [a,v] of Object.entries(task.reviews)) {
      html += '<span><span class="agent-tag">@'+a+'</span> <span class="badge '+v+'">'+v.replace('_',' ')+'</span></span>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function load() {
  const data = await fetch('/api/status').then(r=>r.json());
  // Stats bar
  document.getElementById('stats').innerHTML =
    '<span>Review: <span class="num">'+(data.tabs.proposed.length+data.tabs.recommended.length+data.tabs.to_review.length)+'</span></span>'+
    '<span>Ready: <span class="num">'+(data.tabs.drafted.length+data.tabs.to_install.length)+'</span></span>'+
    '<span>Active: <span class="num">'+data.active+'</span></span>'+
    '<span>Queued: <span class="num">'+data.queued+'</span></span>'+
    '<span>Total: <span class="num">'+data.total+'</span></span>';

  if (view === 'main') renderMain(data);
  else renderDetail(data);
}

function renderMain(data) {
  let html = '';
  // Section 1: Review (recommended first, then to_review + proposed, discarded collapsed)
  const reviewItems = [...data.tabs.recommended, ...data.tabs.to_review, ...data.tabs.proposed];
  const discardedItems = data.tabs.discarded;
  html += '<div class="section"><div class="section-header review">Review &middot; '+reviewItems.length+' items</div>';
  if (reviewItems.length === 0) html += '<div class="empty">Nothing to review</div>';
  for (const t of reviewItems) html += taskCard(t);
  if (discardedItems.length > 0) {
    html += '<span class="toggle-link" onclick="discardedVisible=!discardedVisible;load()">'+
      (discardedVisible?'Hide':'Show')+' '+discardedItems.length+' discarded</span>';
    if (discardedVisible) for (const t of discardedItems) html += taskCard(t);
  }
  html += '</div>';

  // Section 2: Ready (drafted, to_install)
  const readyItems = [...data.tabs.drafted, ...data.tabs.to_install];
  html += '<div class="section"><div class="section-header ready">Ready &middot; '+readyItems.length+' items</div>';
  if (readyItems.length === 0) html += '<div class="empty">Nothing ready for review or install</div>';
  for (const t of readyItems) html += taskCard(t);
  html += '</div>';

  // Pipeline (active, queued, installed — collapsed)
  const pipelineItems = [...data.tabs.active, ...data.tabs.queued];
  const doneItems = [...data.tabs.installed, ...data.tabs.done];
  if (pipelineItems.length > 0 || doneItems.length > 0) {
    html += '<div class="section"><div class="section-header pipeline">Pipeline &middot; '+pipelineItems.length+' in progress</div>';
    for (const t of pipelineItems) html += taskCard(t);
    if (doneItems.length > 0) {
      html += '<span class="toggle-link" onclick="document.getElementById(\\'done-list\\').classList.toggle(\\'collapsed\\');load()">'+doneItems.length+' completed</span>';
      html += '<div id="done-list" class="collapsed">';
      for (const t of doneItems) html += taskCard(t);
      html += '</div>';
    }
    html += '</div>';
  }
  document.getElementById('main-view').innerHTML = html;
}

function renderDetail(data) {
  let html = '<div class="tabs">';
  for (const t of TAB_ORDER) {
    const count = (data.tabs[t]||[]).length;
    const cls = t === currentTab ? 'tab active' : 'tab';
    html += '<div class="'+cls+'" onclick="currentTab=\\''+t+'\\';load()">'+TAB_LABELS[t]+'<span class="count">'+count+'</span></div>';
  }
  html += '</div>';
  const items = data.tabs[currentTab]||[];
  if (items.length === 0) html += '<div class="empty">No tasks in this tab</div>';
  for (const t of items) html += taskCard(t);
  document.getElementById('detail-view').innerHTML = html;
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
