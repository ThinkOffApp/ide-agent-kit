# Task lifecycle (permanent-team orchestration)

**Direction (Petrus, 2026-06-20):** implement team lifecycle, lead/worker, task
monitor, and completion summaries — but **no create-team API**. We have a
permanent roster (petrus, @claudeMB, @claudemm, @ether, @codex/@codexmb), so the
lifecycle is over **tasks**, not over creating/disbanding teams. Inspired by
`michelhelsdingen/ensemble`, but controlled through CodeWatch and backed by IAK
typed actions + receipts (see `docs/codewatch-control-plane.md`).

## Model

A **Task** is one unit of work assigned across the permanent roster.

```jsonc
{
  "id": "tsk_<short>",            // daemon-assigned
  "title": "Garageland Shopify import",
  "detail": "Import 3,492 products as drafts once the store + token exist",
  "lead": "@claudeMB",           // one agent (or @petrus) accountable
  "workers": ["@ether"],          // 0+ contributing agents
  "status": "open",              // see statuses below
  "room": "thinkoff-development", // where updates/receipts post
  "created_by": "@petrus",
  "created_at": "<iso>",
  "updated_at": "<iso>",
  "updates": [                     // append-only progress log
    { "at": "<iso>", "by": "@claudeMB", "text": "catalog transformed; awaiting store" }
  ],
  "actions": ["<action nonce>"],  // typed action-requests spawned by this task (control-plane)
  "summary": null                 // completion summary, set on done
}
```

### Statuses

`open` -> `in_progress` -> (`blocked` <->) -> `done` | `cancelled`

- `open`: created, lead assigned, not started.
- `in_progress`: lead/workers actively on it.
- `blocked`: waiting on a human step (payment, token, file-pick, approval) or an
  external dependency. Record what it's blocked on in `updates`.
- `done`: finished; `summary` set.
- `cancelled`: dropped; `summary` records why.

## Daemon API (IAK — ether's lane)

```
POST   /tasks                 { title, detail, lead, workers, room }      -> { id, ...task }
GET    /tasks                 [?status=]                                  -> [task]
GET    /tasks/{id}                                                        -> task
PATCH  /tasks/{id}            { status?, lead?, workers?, update? }       -> task   (update appends to log)
POST   /tasks/{id}/complete   { summary }                                 -> task   (status=done)
```

- The daemon is authoritative for task state + the append-only update log.
- Status changes and completion **post to `room`** (so the team + petrus see them),
  and emit a CodeWatch-renderable card (action: open task / view monitor).
- A task may spawn typed actions via `/actions/request`; those receipts attach to
  the task's `actions[]` so the monitor shows the full chain.

## CodeWatch surface (mine — @claudeMB)

- **Task monitor**: a list of active tasks (title, lead, workers, status badge,
  last update, age). Tap a task -> detail (the update log + any action receipts).
- **Completion summary**: when a task hits `done`, CodeWatch shows the summary card
  (what was done, by whom, receipts) in the room and in the monitor.
- Reads `GET /tasks` / `GET /tasks/{id}` (degrades to empty until the daemon ships,
  same pattern as the agents list).

## Lane split

- **IAK daemon (ether):** the `/tasks` registry + state + append-only log + room
  posting on transitions + completion summaries.
- **CodeWatch (claudeMB):** the task-monitor UI + completion-summary cards + a thin
  task-request helper (mirror of `scripts/action-request.mjs`) to open/update tasks.
- **Shared:** this schema is the contract; both build to it.

## Explicitly NOT building

- **create-team / disband API** — the roster is permanent; ensemble's ephemeral
  team spawn/disband doesn't apply. (Revisit only if ad-hoc sub-teams are ever needed.)
