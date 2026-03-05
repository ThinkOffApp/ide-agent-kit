// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Task Queue — agent task lifecycle with voting and code review governance.
 *
 * Lifecycle (tabs):
 *   proposed → recommended|to_review|discarded → queued → active → drafted → to_install → installed
 *
 * Voting: agents vote approve/reject on proposed items.
 *   3+ approve → recommended (green)
 *   3+ reject  → discarded (red)
 *   mixed      → to_review (yellow, needs human input)
 *
 * Code review: after drafting, 2+ non-implementer reviews needed.
 *   Reviewers flag issues or approve. Too many rounds → escalate.
 *
 * Bugs: skip voting, go straight to queued→active→installed.
 */

const DEFAULT_FILE = '.iak-tasks.json';
const VOTE_THRESHOLD = 3;
const REVIEW_THRESHOLD = 2;
const MAX_REVIEW_ROUNDS = 3;

const STATUSES = ['proposed', 'recommended', 'to_review', 'discarded', 'queued', 'active', 'drafted', 'to_install', 'installed', 'done', 'failed', 'cancelled'];

let tasksFile = DEFAULT_FILE;
let tasks = {};

export function initTaskQueue(filePath) {
  tasksFile = filePath || DEFAULT_FILE;
  if (existsSync(tasksFile)) {
    try {
      tasks = JSON.parse(readFileSync(tasksFile, 'utf8'));
    } catch {
      tasks = {};
    }
  }
}

function save() {
  writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}

export function addTask(agent, title, { priority = 0, type = 'feature', hotfix = false } = {}) {
  const id = randomUUID().slice(0, 8);
  // Hotfix bugs skip review and go straight to active
  // Regular bugs and features start as proposed (need review)
  const status = (type === 'bug' && hotfix) ? 'active' : 'proposed';
  tasks[id] = {
    id,
    agent,
    title,
    type,               // 'feature' | 'bug'
    hotfix: hotfix || false,
    status,
    priority,
    votes: {},          // { agentId: 'approve'|'reject' }
    reviews: {},        // { agentId: 'approve'|'changes_requested' }
    review_round: 0,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    result: null
  };
  save();
  return tasks[id];
}

export function vote(taskId, agentId, decision) {
  if (!tasks[taskId]) return null;
  if (!['approve', 'reject'].includes(decision)) return null;
  tasks[taskId].votes[agentId] = decision;
  tasks[taskId].updated = new Date().toISOString();
  // Auto-transition based on vote counts
  const approves = Object.values(tasks[taskId].votes).filter(v => v === 'approve').length;
  const rejects = Object.values(tasks[taskId].votes).filter(v => v === 'reject').length;
  if (rejects >= VOTE_THRESHOLD) {
    tasks[taskId].status = 'discarded';
  } else if (approves >= VOTE_THRESHOLD) {
    tasks[taskId].status = 'recommended';
  } else if (Object.keys(tasks[taskId].votes).length >= VOTE_THRESHOLD) {
    tasks[taskId].status = 'to_review';
  }
  save();
  return tasks[taskId];
}

export function queueTask(taskId) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'queued';
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function startTask(taskId) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'active';
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function draftTask(taskId) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'drafted';
  tasks[taskId].review_round = (tasks[taskId].review_round || 0) + 1;
  tasks[taskId].reviews = {};  // reset reviews for new round
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function reviewTask(taskId, reviewerId, decision) {
  if (!tasks[taskId]) return null;
  if (reviewerId === tasks[taskId].agent) return null;  // can't review own work
  if (!['approve', 'changes_requested'].includes(decision)) return null;
  tasks[taskId].reviews[reviewerId] = decision;
  tasks[taskId].updated = new Date().toISOString();
  // Check if enough approvals
  const approvals = Object.values(tasks[taskId].reviews).filter(v => v === 'approve').length;
  const changes = Object.values(tasks[taskId].reviews).filter(v => v === 'changes_requested').length;
  if (approvals >= REVIEW_THRESHOLD && changes === 0) {
    tasks[taskId].status = 'to_install';
  }
  // Too many rounds → stays in drafted with escalation flag
  if (tasks[taskId].review_round >= MAX_REVIEW_ROUNDS && changes > 0) {
    tasks[taskId].escalated = true;
  }
  save();
  return tasks[taskId];
}

export function installTask(taskId) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'installed';
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function completeTask(taskId, result = null) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'done';
  tasks[taskId].result = result;
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function failTask(taskId, reason = null) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'failed';
  tasks[taskId].result = reason;
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function cancelTask(taskId) {
  if (!tasks[taskId]) return null;
  tasks[taskId].status = 'cancelled';
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function setStatus(taskId, status) {
  if (!tasks[taskId]) return null;
  if (!STATUSES.includes(status)) return null;
  tasks[taskId].status = status;
  tasks[taskId].updated = new Date().toISOString();
  save();
  return tasks[taskId];
}

export function getTask(taskId) {
  return tasks[taskId] || null;
}

export function listTasks({ agent, status } = {}) {
  let result = Object.values(tasks);
  if (agent) result = result.filter(t => t.agent === agent);
  if (status) result = result.filter(t => t.status === status);
  result.sort((a, b) => b.priority - a.priority || new Date(a.created) - new Date(b.created));
  return result;
}

export function nextTask(agent) {
  const queued = listTasks({ agent, status: 'queued' });
  return queued[0] || null;
}

export function agentStatus(agent) {
  const all = listTasks({ agent });
  const current = all.find(t => t.status === 'active') || null;
  return {
    agent,
    current,
    proposed: all.filter(t => t.status === 'proposed').length,
    queued: all.filter(t => t.status === 'queued').length,
    active: all.filter(t => t.status === 'active').length,
    drafted: all.filter(t => t.status === 'drafted').length,
    installed: all.filter(t => t.status === 'installed').length,
    done: all.filter(t => t.status === 'done').length,
    failed: all.filter(t => t.status === 'failed').length,
    next: all.find(t => t.status === 'queued') || null
  };
}

export function missionControlData() {
  const allTasks = Object.values(tasks);
  const agents = [...new Set(allTasks.map(t => t.agent))];
  const tabs = {};
  for (const s of STATUSES) {
    tabs[s] = allTasks.filter(t => t.status === s);
  }
  return {
    agents: agents.map(a => agentStatus(a)),
    tabs,
    total: allTasks.length,
    active: allTasks.filter(t => t.status === 'active').length,
    queued: allTasks.filter(t => t.status === 'queued').length,
    proposed: allTasks.filter(t => t.status === 'proposed').length
  };
}
