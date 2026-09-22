// SPDX-License-Identifier: AGPL-3.0-only
//
// petrus, 22 Sep 2026: "Stop these huge confirmation messages pls" - a Bash
// confirmation's prompt (question + pasted command) was going straight into
// the GroupMind room body, sometimes hundreds of characters of shell. These
// tests cover the shortening applied ONLY to that room body: the stored
// intent prompt, the CodeWatch push, and /intents must all keep the full
// text untouched (see the negative control at the bottom).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  ROOM_BODY_MAX,
  COMMAND_SNIPPET_MAX,
  shortRoomBody,
  buildGroupmindBody,
  createIntent,
  composeAnnouncers,
  makeCodewatchAnnouncer,
  _resetForTests,
} from '../src/confirmations.mjs';

// --- shortRoomBody: the pure transform ---------------------------------

test('shortRoomBody: a short single-line prompt passes through unchanged', () => {
  const prompt = 'Approve deploy to production?';
  assert.equal(shortRoomBody(prompt, {}), prompt);
});

test('shortRoomBody: a prompt whose first line is a question keeps that question verbatim', () => {
  const question = 'Approve Bash command on Mac mini?';
  const prompt = `${question}\ncd /Users/petrus && rm -rf build/`;
  const short = shortRoomBody(prompt, {});
  assert.ok(short.startsWith(question), 'the question must survive untouched, not trimmed or altered');
});

test('shortRoomBody: a 900-character command line is cut to the snippet cap with a pointer to CodeWatch', () => {
  const question = 'Approve Bash command on Mac mini?';
  const longLine = 'x'.repeat(900);
  const short = shortRoomBody(`${question}\n${longLine}`, {});
  assert.ok(short.length < ROOM_BODY_MAX, `short body (${short.length}) must be under ROOM_BODY_MAX`);
  assert.ok(short.startsWith(question), 'must still start with the first line');
  assert.match(short, /full command in CodeWatch/);
  const snippetLine = short.split('\n')[1];
  assert.ok(snippetLine.length <= COMMAND_SNIPPET_MAX, `command snippet (${snippetLine.length}) must respect COMMAND_SNIPPET_MAX`);
});

test('shortRoomBody: skips bare cd / echo / variable-assignment / comment lines to find the real command', () => {
  const question = 'Approve Bash command on Mac mini?';
  const prompt = [
    question,
    '#!/bin/bash',
    'cd /Users/petrus',
    'TOKEN=xyz789',
    'echo starting',
    'python3 deploy.py --target prod --force',
  ].join('\n');
  const short = shortRoomBody(prompt, {});
  assert.match(short, /python3 deploy\.py --target prod --force/, 'the first non-plumbing line must be the one shown');
  assert.doesNotMatch(short, /TOKEN=/, 'the bare assignment line must be skipped, not shown');
});

test('shortRoomBody: a compound line starting with cd/echo/assignment is NOT bare, and is kept', () => {
  // This is the real shape from the room card petrus complained about: a
  // single line that starts with `cd` but goes on to do the actual work.
  const question = 'Approve Bash command on Mac mini?';
  const prompt = `${question}\ncd /Users/petrus && KEY=$(python3 -c "print(1)") python3 - "$KEY" <<'PY'`;
  const short = shortRoomBody(prompt, {});
  assert.match(short, /^Approve Bash command on Mac mini\?\ncd \/Users\/petrus && KEY=/);
});

test('shortRoomBody: a choice card keeps every option label out of the shortening entirely', () => {
  const question = 'Which model should I switch to?';
  const longDescription = `${question}\n${'context '.repeat(200)}`;
  const options = ['gpt-5.1', 'claude-sonnet-5', 'gemini-3-pro'];
  const short = shortRoomBody(longDescription, { options });
  // shortRoomBody only returns the description block; the options themselves
  // are rendered by buildGroupmindBody's typed-reply line, never touched here.
  assert.ok(short.length < ROOM_BODY_MAX);
  assert.ok(short.startsWith(question));
});

test('shortRoomBody: when the options alone would meet or exceed the budget, the description is dropped', () => {
  const options = Array.from({ length: 40 }, (_, i) => `option-with-a-fairly-long-label-${i}`);
  assert.ok(options.join(' · ').length >= ROOM_BODY_MAX, 'test setup: options must already meet the budget');
  const short = shortRoomBody('Pick one of the following, a very long description follows here', { options });
  assert.equal(short, '', 'description must be dropped, not truncated into nonsense, once options alone fill the budget');
});

// --- buildGroupmindBody: the assembled room card -------------------------

test('buildGroupmindBody: a 900-char shell command yields a body under 600 chars that still opens with the question, and carries the intent id and every option label', () => {
  const id = 'intent-abc123';
  const question = 'Approve Bash command on Mac mini?';
  const longCommand = 'python3 - "$KEY" ' + 'x'.repeat(900) + ' <<\'PY\'';
  const prompt = `${question}\ncd /Users/petrus\n${longCommand}`;
  const body = buildGroupmindBody({ id, prompt, session: 'mac-mini-main', uiLink: 'http://127.0.0.1:8788/' });

  assert.ok(body.length < ROOM_BODY_MAX, `assembled body (${body.length} chars) must be under ${ROOM_BODY_MAX}`);
  assert.ok(body.startsWith(`[Confirmation needed] **${question}`), 'must open with the tag and the verbatim question');
  assert.ok(body.includes(id), 'the intent id must survive shortening (it is how a typed reply resolves)');
  assert.match(body, /full command in CodeWatch/);
});

test('buildGroupmindBody: a choice card keeps every option label as a typed-reply target', () => {
  const id = 'intent-choice-1';
  const options = ['gpt-5.1', 'claude-sonnet-5', 'gemini-3-pro'];
  const prompt = `Which model should I switch to?\n${'reasoning '.repeat(150)}`;
  const body = buildGroupmindBody({ id, prompt, session: 's1', uiLink: null, options });

  assert.ok(body.length < ROOM_BODY_MAX);
  for (const opt of options) {
    assert.ok(body.includes(opt), `option label "${opt}" must appear in the room body (it is a button)`);
    assert.ok(body.includes(`/choose ${id} ${opt}`), `typed-reply form for "${opt}" must be present`);
  }
});

// --- negative control: the fix must not "cheat" by truncating the source --

test('NEGATIVE CONTROL: the CodeWatch push still carries the full, untouched prompt', async () => {
  // If someone "fixes" the huge room cards by truncating the prompt at the
  // source (in createIntent / the MCP tool handler) instead of only in the
  // room body, this is the test that catches it: CodeWatch and /intents are
  // required to keep showing the full command, per the task. Revert the
  // buildGroupmindBody/shortRoomBody change and this test still passes,
  // because it exercises a channel the change never touches - see the
  // shortRoomBody tests above for the ones that DO fail on a revert.
  _resetForTests();
  const longPrompt = `Approve Bash command on Mac mini?\n${'x'.repeat(900)}`;
  let received = null;
  const gate = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cw-1' }));
    });
  });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  const gateUrl = `http://127.0.0.1:${gate.address().port}/gate`;
  try {
    const announce = composeAnnouncers({ codewatch: makeCodewatchAnnouncer({ gateUrl }) });
    await createIntent({ prompt: longPrompt, channels: ['codewatch'], announce });
    assert.ok(received, 'the gate must have received a push');
    assert.equal(received.prompt, longPrompt, 'CodeWatch push must carry the FULL, unshortened prompt');
  } finally {
    gate.close();
  }
});
