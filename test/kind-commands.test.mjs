// SPDX-License-Identifier: AGPL-3.0-only
//
// mcp.confirmations.kind_commands: a decided CHOICE of a configured kind runs
// an argv (no shell) with the decision substituted, and reports back under the
// card. These go through the real createIntent -> decideIntent -> kind handler
// chokepoint and spawn real processes (node -e), so a regression in the wiring
// shows up here, not only in a unit of the helper.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createIntent,
  decideIntent,
  getIntent,
  registerKindHandler,
  unregisterKindHandler,
  pendingKindHandler,
  setLead,
  OWNER_HANDLE,
  _resetForTests,
} from '../src/confirmations.mjs';
import {
  registerKindCommands,
  kindCommandsFrom,
  buildArgv,
  makeKindCommandHandler,
} from '../src/kind-commands.mjs';

const NODE = process.execPath;
// node -e <script> <outFile> <decision>: writes the decision it received as argv[2].
const WRITE_ARG = "require('fs').writeFileSync(process.argv[1], process.argv[2]); console.log('wrote', process.argv[2])";

let dir;
let posts;
let registered;
const post = async (p) => { posts.push(p); return true; };

function setup(kindCommands, extra = {}) {
  registered = registerKindCommands({
    cc: { kind_commands: kindCommands, ...extra },
    registerKindHandler,
    getIntent,
    post,
  });
}

async function raise(kind, options, messageId = 'card-msg-1') {
  return createIntent({
    prompt: `pick for ${kind}`,
    options,
    kind,
    channels: ['groupmind'],
    announce: async ({ recordAnnouncement }) => {
      recordAnnouncement('groupmind', { status: 'posted', postedAt: Date.now(), messageId });
    },
  });
}

beforeEach(() => {
  _resetForTests();
  dir = mkdtempSync(join(tmpdir(), 'iak-kindcmd-'));
  posts = [];
  registered = [];
});
afterEach(() => {
  for (const k of registered) unregisterKindHandler(k);
});

test('a decided intent of a configured kind runs the argv with the decision substituted, and replies under the card', async () => {
  const out = join(dir, 'out.txt');
  setup({ 'spark-mode': [NODE, '-e', WRITE_ARG, out, '{decision}'] });
  const id = await raise('spark-mode', ['glm', 'media']);
  assert.equal(decideIntent(id, 'media').ok, true);
  const p = pendingKindHandler(id);
  assert.ok(p, 'a kind handler fired');
  await p;
  assert.equal(readFileSync(out, 'utf8'), 'media');
  assert.equal(posts.length, 2, 'a started line and a result line');
  assert.match(posts[0].body, /^spark-mode -> media: started/);
  assert.match(posts[1].body, /^spark-mode -> media: done in \d+s \(exit 0\)/);
  assert.match(posts[1].body, /wrote media/);
  assert.ok(posts.every((x) => x.replyTo === 'card-msg-1'), 'both replies thread under the card');
});

test('the decision stays ONE argv element, whatever it contains (no shell)', async () => {
  const out = join(dir, 'out.txt');
  const nasty = `x; touch ${join(dir, 'pwned')} $(touch ${join(dir, 'pwned2')})`;
  setup({ 'spark-mode': [NODE, '-e', WRITE_ARG, out, '{decision}'] });
  const id = await raise('spark-mode', [nasty, 'glm']);
  assert.equal(decideIntent(id, nasty).ok, true);
  await pendingKindHandler(id);
  assert.equal(readFileSync(out, 'utf8'), nasty, 'the label arrived verbatim as argv[2]');
  assert.deepEqual(readdirSync(dir).sort(), ['out.txt'], 'nothing was interpreted by a shell');
  assert.deepEqual(buildArgv(['a', 'pre-{decision}-post', '{decision}'], 'b c'), ['a', 'pre-b c-post', 'b c']);
});

test('a kind with no configured command runs nothing', async () => {
  const out = join(dir, 'out.txt');
  setup({ 'spark-mode': [NODE, '-e', WRITE_ARG, out, '{decision}'] });
  const id = await raise('some-other-kind', ['glm', 'media']);
  assert.equal(decideIntent(id, 'media').ok, true);
  assert.equal(pendingKindHandler(id), null, 'no handler fired');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(out), false);
  assert.equal(posts.length, 0);
});

test('a decision that is not an offered option never runs', async () => {
  const out = join(dir, 'out.txt');
  setup({ 'spark-mode': [NODE, '-e', WRITE_ARG, out, '{decision}'] });
  const id = await raise('spark-mode', ['glm', 'media']);
  // Upstream guarantee: decideIntent refuses it and fires nothing.
  const r = decideIntent(id, 'rm -rf');
  assert.equal(r.ok, false);
  assert.match(r.error, /not an option/);
  assert.equal(pendingKindHandler(id), null);
  assert.equal(getIntent(id).status, 'pending');
  // Second lock: the handler itself re-checks against the intent's options
  // before it spawns, even if it is somehow called with an unoffered value.
  let spawned = 0;
  const h = makeKindCommandHandler({
    kind: 'spark-mode', argv: [NODE, '-e', WRITE_ARG, out, '{decision}'], timeoutMs: 5000,
    getIntent: () => ({ options: ['glm', 'media'], decidedByRole: 'owner', announcements: {} }),
    post,
    run: async () => { spawned++; return { code: 0, tail: '' }; },
  });
  const res = await h({ id, decision: 'rm -rf' });
  assert.equal(res.ran, false);
  assert.equal(spawned, 0);
  assert.equal(existsSync(out), false);
  assert.match(posts.at(-1).body, /not one of the offered options; nothing was run/);
});

test('a command that exceeds the timeout is killed (whole process group) and reported', { timeout: 20000 }, async () => {
  const pids = join(dir, 'pids.txt');
  // Parent spawns a grandchild in the same process group, records both pids, then hangs.
  const HANG = "const {spawn}=require('child_process');"
    + "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"
    + "require('fs').writeFileSync(process.argv[1], process.pid+' '+g.pid);"
    + "console.log('hanging');setInterval(()=>{},1000)";
  setup({ slow: { argv: [NODE, '-e', HANG, pids], timeout_sec: 1 } });
  const id = await raise('slow', ['go', 'stay']);
  assert.equal(decideIntent(id, 'go').ok, true);
  const t0 = Date.now();
  await pendingKindHandler(id);
  assert.ok(Date.now() - t0 < 4000, 'TERM ended it right after the 1 s timeout, not the 5 s KILL grace');
  const result = posts.at(-1).body;
  assert.match(result, /^slow -> go: KILLED after the 1s timeout/);
  assert.match(result, /hanging/);
  const [p, g] = readFileSync(pids, 'utf8').split(' ').map(Number);
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of [p, g]) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} is gone`);
  }
});

test("a choice decided by the team lead, not the owner, does not run", async () => {
  const out = join(dir, 'out.txt');
  setup({ 'spark-mode': [NODE, '-e', WRITE_ARG, out, '{decision}'] });
  assert.equal(setLead('leadagent', { actor: OWNER_HANDLE }).ok, true);
  const id = await raise('spark-mode', ['glm', 'media']);
  const r = decideIntent(id, 'media', { actor: 'leadagent' });
  assert.equal(r.ok, true, 'the lead may settle a plain choice');
  await pendingKindHandler(id);
  assert.equal(existsSync(out), false, 'but the command did not run');
  assert.match(posts.at(-1).body, /not run, decided by @leadagent; only the owner's tap runs a command/);
});

test('a second tap while the same kind is still running is refused, not queued', async () => {
  const out = join(dir, 'out.txt');
  const SLOW_WRITE = "setTimeout(()=>{require('fs').appendFileSync(process.argv[1], process.argv[2]+'\\n')}, 800)";
  setup({ 'spark-mode': [NODE, '-e', SLOW_WRITE, out, '{decision}'] });
  const a = await raise('spark-mode', ['glm', 'media'], 'card-a');
  const b = await raise('spark-mode', ['glm', 'media'], 'card-b');
  assert.equal(decideIntent(a, 'media').ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(decideIntent(b, 'glm').ok, true);
  await Promise.all([pendingKindHandler(a), pendingKindHandler(b)]);
  assert.equal(readFileSync(out, 'utf8'), 'media\n', 'only the first ran');
  const refusal = posts.find((x) => x.replyTo === 'card-b');
  assert.match(refusal.body, /not run, the previous spark-mode command \(card [0-9a-f]+\) is still running/);
});

test('config: argv arrays and {argv, timeout_sec} accepted; "model" and malformed entries refused', () => {
  const warns = [];
  const m = kindCommandsFrom({
    kind_command_timeout_sec: 60,
    kind_commands: {
      a: ['echo', '{decision}'],
      b: { argv: ['echo'], timeout_sec: 5 },
      model: ['echo'],
      bad1: 'echo {decision}',
      bad2: [],
      bad3: ['echo', 3],
    },
  }, { warn: (w) => warns.push(w) });
  assert.deepEqual([...m.keys()], ['a', 'b']);
  assert.equal(m.get('a').timeoutMs, 60000);
  assert.equal(m.get('b').timeoutMs, 5000);
  assert.equal(warns.length, 4);
  assert.equal(kindCommandsFrom({}).size, 0);
  assert.equal(kindCommandsFrom({ kind_commands: { c: ['x'] } }).get('c').timeoutMs, 1800 * 1000, 'default 30 min');
});
