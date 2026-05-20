# User Intent Kit (UIK)

UIK is the human-intent contract layer shipped inside IDE Agent Kit. Where IAK
gives agents safe access to tools, rooms, and sessions, UIK gives humans a
structured way to express what they actually want done so an agent can execute
on it without guesswork.

## What UIK is

An Intent is a small JSON object that names a goal, the constraints around it,
who owns it, what counts as "done", which actions require human approval, what
to record as receipts, and how to escalate when things go wrong. Agents read
Intents the same way they read MCP tool calls: structured, validated, replayable.
A free-form chat request becomes a UIK Intent the moment a human (or an agent
on their behalf) fills in the seven required slots.

## Why it lives in IAK

IAK already owns the substrate: room I/O (`room_post`, `room_recent`,
`room_ack`), session control (`tmux_run`, `wake_ide`, `wake_remote`), the
confirmation registry, and the receipts log. UIK is the layer humans speak in;
IAK is the layer agents act in. Shipping UIK as a separate repo would orphan
both halves. Inside IAK, an Intent flows naturally into the existing primitives:
constraints become tool allowlists, approval gates become confirmation registry
entries, receipts append to the existing receipts JSONL.

## The seven elements of an Intent

1. **Goal** - one-sentence statement of the outcome ("ship a PR that fixes #214").
2. **Constraints** - hard limits: budget, allowed tools, time window, files
   off-limits, "no force push", etc.
3. **Approval gates** - named decision points where the agent must stop and ask
   a specific human (e.g. before merging, before sending an external email).
4. **Ownership** - the agent handle responsible for execution (`@claudemb`)
   and the human accountable for outcome (`@petrus`).
5. **Receipts** - what evidence to record per step: PR URL, commit hash, room
   message id, file diff. Appended to IAK's existing receipts log.
6. **Escalation** - who to wake and how when blocked: room handle, gate URL,
   timeout before auto-escalation.
7. **Done criteria** - testable conditions for completion. Non-empty array.
   "PR merged AND tests green AND owner acked in #thinkoff-development".

## Raw chat vs UIK Intent

Raw chat:

> @claudemb fix the flaky test in payments_test.go and ship it

Same task as UIK Intent:

```ts
{
  goal: "Fix flaky payments_test.go and land a PR",
  constraints: [
    { kind: "tool_allowlist", value: ["git", "go test", "gh pr"] },
    { kind: "no_force_push", value: true }
  ],
  approvalGates: [
    { name: "before_merge", approver: "@petrus" }
  ],
  owner: { agent: "@claudemb", human: "@petrus" },
  receipts: [
    { kind: "pr_url" }, { kind: "commit_hash" }, { kind: "test_output" }
  ],
  escalation: { room: "thinkoff-development", timeoutMinutes: 30 },
  doneCriteria: [
    { check: "PR merged" },
    { check: "CI green on main" }
  ]
}
```

The Intent is reviewable, diffable, and replayable. The chat line is not.

## Composition with IAK MCP tools

Once an Intent is accepted, its lifecycle maps onto the tools IAK already
exposes. `room_post` announces the Intent and posts progress receipts.
`room_recent` plus `room_ack` confirm escalation reads. Approval gates register
with the existing confirmation registry (`POST /intent` on the iak-mcp-daemon)
and surface in the CodeWatch / GroupMind Approve/Deny UI. `tmux_run` executes
allowlisted commands the constraints permit. Each step appends to the receipts
JSONL keyed by Intent id.

UIK does not replace any IAK primitive. It is the schema that decides which
ones to call, in which order, with whose permission, and what to record.

See `packages/uik/` for the type definitions and `validateIntent()` helper.
A concrete reference implementation of approval-gate execution and the
`intent_create / intent_status / intent_close` MCP tools will follow once the
shape settles.
