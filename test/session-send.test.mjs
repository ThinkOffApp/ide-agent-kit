// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { deliverToSession, listSessionAgents } from '../src/session-send.mjs';
import { startConfirmationsServer } from '../src/confirmations.mjs';

const tempPaths = [];
const servers = [];
let savedPath = null;

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iak-send-')));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (tempPaths.length > 0) rmSync(tempPaths.pop(), { recursive: true, force: true });
  while (servers.length > 0) servers.pop().close();
  if (savedPath !== null) { process.env.PATH = savedPath; savedPath = null; }
});

/** Stub executable that appends its argv to a log file. */
function stubScript(dir, name, logName) {
  const log = join(dir, logName);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function listenEphemeral(opts) {
  const server = startConfirmationsServer({ port: 0, host: '127.0.0.1', ...opts });
  servers.push(server);
  return new Promise((resolvePromise) => {
    server.on('listening', () => resolvePromise({ server, port: server.address().port }));
  });
}

describe('deliverToSession', () => {
  it('validates input and config', async () => {
    const sessions = { agents: { known: { adapter: 'wake' } } };
    assert.equal((await deliverToSession(sessions, '', { text: 'x' })).status, 400);
    assert.equal((await deliverToSession(sessions, 'known', { text: '' })).status, 400);
    assert.equal((await deliverToSession(sessions, 'known', { text: 'y'.repeat(4001) })).status, 400);
    assert.equal((await deliverToSession(sessions, 'nope', { text: 'x' })).status, 404);
    // known agent, but adapter lacks its required field:
    assert.equal((await deliverToSession(sessions, 'known', { text: 'x' })).status, 503);
    assert.equal((await deliverToSession({ agents: { a: {} } }, 'a', { text: 'x' })).status, 503);
  });

  it('wake adapter spawns the script with the message, prefixing provenance', async () => {
    const dir = tempDir();
    const { path, log } = stubScript(dir, 'wake.sh', 'wake.log');
    const sessions = { agents: { mm: { adapter: 'wake', script: path } } };
    const res = await deliverToSession(sessions, 'mm', { text: 'hello there', from: 'petrus' });
    assert.equal(res.status, 202);
    assert.equal(res.deliveredVia, 'wake');
    assert.ok(await waitFor(() => existsSync(log)), 'script ran');
    assert.equal(readFileSync(log, 'utf8').trim(), '[from petrus] hello there');
  });

  it('gui adapter runs the idle guard before the script', async () => {
    const dir = tempDir();
    const guardLog = join(dir, 'guard.log');
    const guard = join(dir, 'guard.sh');
    // Guard records its invocation; script records guard-log existence so
    // ordering is provable from the script side.
    writeFileSync(guard, `#!/bin/bash\necho "guard $*" > ${JSON.stringify(guardLog)}\n`);
    chmodSync(guard, 0o755);
    const scriptLog = join(dir, 'script.log');
    const script = join(dir, 'inject.sh');
    writeFileSync(script, `#!/bin/bash\nprintf 'guard_ran=%s msg=%s\\n' "$([ -f ${JSON.stringify(guardLog)} ] && echo yes || echo no)" "$1" > ${JSON.stringify(scriptLog)}\n`);
    chmodSync(script, 0o755);
    const sessions = { agents: { mb: { adapter: 'gui', script, idle_guard: guard } } };
    const res = await deliverToSession(sessions, 'mb', { text: 'drive this' });
    assert.equal(res.status, 202);
    assert.ok(await waitFor(() => existsSync(scriptLog)), 'script ran');
    assert.match(readFileSync(scriptLog, 'utf8'), /guard_ran=yes msg=drive this/);
    assert.match(readFileSync(guardLog, 'utf8'), /--wait/);
  });

  it('tmux adapter sends the literal text then Enter', async () => {
    const dir = tempDir();
    const { log } = stubScript(dir, 'tmux', 'tmux.log');
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH}`;
    const sessions = { agents: { sally: { adapter: 'tmux', tmux_session: 'sally-sess' } } };
    const res = await deliverToSession(sessions, 'sally', { text: 'status?' });
    assert.equal(res.status, 202);
    assert.equal(res.deliveredVia, 'tmux');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /send-keys -t sally-sess -l status\?/);
    assert.match(calls[1], /send-keys -t sally-sess C-m/);
  });

  it('forward adapter relays to a peer daemon and reports the peer verdict', async () => {
    const dir = tempDir();
    const { path, log } = stubScript(dir, 'peer-wake.sh', 'peer.log');
    const { port } = await listenEphemeral({
      authToken: 'peer-secret',
      sessions: { agents: { mb: { adapter: 'wake', script: path } } },
    });
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'peer-secret\n');
    const sessions = {
      agents: { mb: { adapter: 'forward', peer: `http://127.0.0.1:${port}`, token_file: tokenFile } },
    };
    const res = await deliverToSession(sessions, 'mb', { text: 'relay me', from: 'petrus' });
    assert.equal(res.status, 202, JSON.stringify(res));
    assert.match(res.deliveredVia, /^forward:/);
    assert.ok(await waitFor(() => existsSync(log)), 'peer script ran');
    // provenance prefixed exactly once, by the peer that owns the adapter:
    assert.equal(readFileSync(log, 'utf8').trim(), '[from petrus] relay me');
  });

  it('forward adapter surfaces an unreachable peer as 502', async () => {
    const sessions = { agents: { mb: { adapter: 'forward', peer: 'http://127.0.0.1:1' } } };
    const res = await deliverToSession(sessions, 'mb', { text: 'x' });
    assert.equal(res.status, 502);
    assert.match(res.error, /peer/);
  });

  it('refuses to forward past the hop limit (loop guard)', async () => {
    const sessions = { agents: { mb: { adapter: 'forward', peer: 'http://127.0.0.1:1' } } };
    const res = await deliverToSession(sessions, 'mb', { text: 'x', hops: 1 });
    assert.equal(res.status, 508);
    assert.match(res.error, /hop limit/);
  });

  it('a self-pointing peer terminates after one hop instead of looping', async () => {
    // Daemon whose only route for 'mb' forwards to ITSELF. The first hop
    // re-enters with hops=1, the inner forward refuses (508), the outer
    // reports 502 — two requests total, no recursion.
    const dir = tempDir();
    const sessions = { agents: { mb: { adapter: 'forward', peer: 'SELF' } } };
    const { port } = await listenEphemeral({
      authToken: '', // forward carries no token here; keep the peer open
      receiptsPath: join(dir, 'receipts.jsonl'),
      sessions,
    });
    sessions.agents.mb.peer = `http://127.0.0.1:${port}`;
    const resp = await fetch(`http://127.0.0.1:${port}/sessions/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'mb', text: 'loop me' }),
    });
    assert.equal(resp.status, 502);
    assert.match((await resp.json()).error, /hop limit/);
  });

  it('a peer answering bare 200 without ok:true is NOT a delivery', async () => {
    const bare = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    servers.push(bare);
    await new Promise((r) => bare.listen(0, '127.0.0.1', r));
    const sessions = {
      agents: { mb: { adapter: 'forward', peer: `http://127.0.0.1:${bare.address().port}` } },
    };
    const res = await deliverToSession(sessions, 'mb', { text: 'x' });
    assert.equal(res.status, 502);
    assert.match(res.error, /unexpected response 200/);
  });

  it('rejects an oversized or non-string from', async () => {
    const sessions = { agents: { mm: { adapter: 'wake', script: '/bin/true' } } };
    assert.equal((await deliverToSession(sessions, 'mm', { text: 'x', from: 'f'.repeat(201) })).status, 400);
    assert.equal((await deliverToSession(sessions, 'mm', { text: 'x', from: 42 })).status, 400);
  });

  it('reports async adapter failures through onAsyncError', async () => {
    const failures = [];
    const dir = tempDir();
    const bad = join(dir, 'fail.sh');
    writeFileSync(bad, '#!/bin/bash\nexit 1\n');
    chmodSync(bad, 0o755);
    const sessions = { agents: { mm: { adapter: 'wake', script: bad } } };
    const res = await deliverToSession(sessions, 'mm', {
      text: 'x', onAsyncError: (e) => failures.push(e.message),
    });
    assert.equal(res.status, 202); // accepted-async by design
    assert.ok(await waitFor(() => failures.length > 0), 'failure reported');
    assert.match(failures[0], /exited 1/);
  });
});

describe('sessions HTTP routes', () => {
  it('POST /sessions/send delivers and GET /sessions/agents lists the picker', async () => {
    const dir = tempDir();
    const { path, log } = stubScript(dir, 'wake.sh', 'wake.log');
    const { port } = await listenEphemeral({
      authToken: 'tok',
      receiptsPath: join(dir, 'receipts.jsonl'),
      sessions: { agents: { mm: { adapter: 'wake', script: path } } },
    });
    const headers = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

    const list = await fetch(`http://127.0.0.1:${port}/sessions/agents`, { headers });
    assert.deepEqual(await list.json(), { agents: [{ name: 'mm', adapter: 'wake' }] });

    const send = await fetch(`http://127.0.0.1:${port}/sessions/send`, {
      method: 'POST', headers, body: JSON.stringify({ agent: 'mm', text: 'via http' }),
    });
    assert.equal(send.status, 202);
    assert.deepEqual(await send.json(), { ok: true, agent: 'mm', deliveredVia: 'wake' });
    assert.ok(await waitFor(() => existsSync(log)));
    // receipt written:
    assert.ok(await waitFor(() => existsSync(join(dir, 'receipts.jsonl'))));
    assert.match(readFileSync(join(dir, 'receipts.jsonl'), 'utf8'), /"kind":"sessions.send"/);
  });

  it('is 503 when sessions are not configured and 401 without the token', async () => {
    const { port } = await listenEphemeral({ authToken: 'tok' });
    const noAuth = await fetch(`http://127.0.0.1:${port}/sessions/send`, {
      method: 'POST', body: JSON.stringify({ agent: 'x', text: 'y' }),
    });
    assert.equal(noAuth.status, 401);
    const noCfg = await fetch(`http://127.0.0.1:${port}/sessions/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'x', text: 'y' }),
    });
    assert.equal(noCfg.status, 503);
  });

  it('rejects oversized request bodies with 413', async () => {
    const { port } = await listenEphemeral({
      sessions: { agents: { mm: { adapter: 'wake', script: '/bin/true' } } },
    });
    const resp = await fetch(`http://127.0.0.1:${port}/sessions/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'mm', text: 'x', padding: 'p'.repeat(100 * 1024) }),
    }).catch(() => null);
    // Depending on timing the server may destroy the socket mid-upload
    // (fetch rejects) or answer 413 — both prove the cap.
    if (resp) assert.equal(resp.status, 413);
  });
});

describe('listSessionAgents', () => {
  it('reflects config and tolerates absence', () => {
    assert.deepEqual(listSessionAgents(undefined), []);
    assert.deepEqual(listSessionAgents({ agents: { a: { adapter: 'tmux' }, b: {} } }), [
      { name: 'a', adapter: 'tmux' },
      { name: 'b', adapter: 'unconfigured' },
    ]);
  });
});
