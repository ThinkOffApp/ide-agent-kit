#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// PreToolUse hook: block Claude Code's built-in AskUserQuestion modal.
//
// Why: AskUserQuestion opens a modal that HALTS the agent's whole session
// until answered, and it renders only on the machine's screen — invisible to
// a user who lives on their phone/watch. It also goes stale: a frozen agent
// can't notice the user already did the thing. On 2026-07-14 this caused a
// 9.5-hour invisible hang (an agent asked "merge these PRs?" via the modal;
// the user had already merged them from their phone, but the agent sat frozen
// behind a modal it couldn't see was stale).
//
// The discipline instead: questions go to the ROOM (or an IAK confirmation
// card that reaches the phone/watch as Approve/Deny), and the agent STAYS
// LIVE — keeps monitoring, keeps working, re-checks reality when the answer
// lands. Already-sanctioned low-risk work (CI-green + reviewed + approved)
// gets done, not asked about.
//
// Reads the PreToolUse payload on stdin. Denies only AskUserQuestion; every
// other tool passes through untouched. Fails OPEN (allows the tool) on any
// parse error so a malformed payload can never wedge the agent.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let toolName = '';
  try {
    toolName = JSON.parse(input || '{}').tool_name || '';
  } catch {
    process.exit(0); // fail open — never block on a parse error
  }

  if (toolName !== 'AskUserQuestion') {
    process.exit(0); // allow every other tool
  }

  const reason = [
    'AskUserQuestion is disabled by IDE Agent Kit.',
    '',
    'It opens a modal that freezes your whole session and only shows on this',
    "machine's screen — the user is on their phone/watch and will never see it,",
    'and it goes stale if they act while you wait. This caused a 9.5h hang.',
    '',
    'Do this instead:',
    '  1. Post the question to the room (room_post), or raise an IAK',
    '     confirmation card (request_confirmation) so it reaches the phone as',
    '     Approve/Deny — then STAY LIVE: keep monitoring and doing other work.',
    '  2. Re-check reality when the answer lands (they may have already done it).',
    '  3. For already-sanctioned low-risk work (CI-green + reviewed + approved),',
    "     just do it — don't ask what's already answered.",
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
});
