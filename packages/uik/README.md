# @thinkoff/uik

User Intent Kit - the human-intent contract layer of [IDE Agent Kit](../../README.md).

UIK turns free-form chat requests into structured `Intent` objects: goal,
constraints, approval gates, ownership, receipts, escalation, done criteria.
Agents executing inside IAK read Intents as the source of truth for what a
human actually asked for.

Full design doc: [`docs/UIK.md`](../../docs/UIK.md).

## Install

This package is part of the IAK repo and ships with it. Build it locally with:

```bash
cd packages/uik
npx tsc
```

## Example

```ts
import { validateIntent, type Intent } from "@thinkoff/uik";

const intent: Intent = {
  goal: "Fix flaky payments_test.go and land a PR",
  constraints: [
    { kind: "tool_allowlist", value: ["git", "go test", "gh pr"] },
  ],
  approvalGates: [
    { name: "before_merge", approver: "@petrus" },
  ],
  owner: { agent: "@claudemb", human: "@petrus" },
  receipts: [{ kind: "pr_url" }, { kind: "commit_hash" }],
  escalation: { room: "thinkoff-development", timeoutMinutes: 30 },
  doneCriteria: [{ check: "PR merged and CI green on main" }],
};

const result = validateIntent(intent);
if (!result.ok) {
  console.error("invalid intent:", result.errors);
}
```

## Status

Seed package: types and a minimal validator. The MCP tools
(`intent_create`, `intent_status`, `intent_close`) and the approval-gate
executor land in a follow-up once the shape stabilises.
