/**
 * User Intent Kit - core type definitions.
 *
 * An Intent is the structured form of a human request: goal, constraints,
 * approval gates, ownership, receipts, escalation, and done criteria.
 *
 * See docs/UIK.md in the repo root for the full design rationale.
 */

/** Hard limits the agent must respect while executing the Intent. */
export interface Constraint {
  /**
   * Constraint family. Common values:
   * - `tool_allowlist`  - value is string[] of permitted tool names.
   * - `tool_denylist`   - value is string[] of forbidden tool names.
   * - `time_window`     - value is { startIso: string; endIso: string }.
   * - `budget_usd`      - value is number, max spend.
   * - `paths_off_limit` - value is string[] of glob patterns.
   * - `no_force_push`   - value is true.
   * Custom kinds are allowed; consumers may ignore unknown kinds.
   */
  kind: string;
  value: unknown;
  note?: string;
}

/** A named decision point where the agent must pause and ask a specific human. */
export interface ApprovalGate {
  /** Stable name for this gate, used in receipts and the confirmation registry. */
  name: string;
  /** Handle of the human (or agent) whose approval is required, e.g. `@petrus`. */
  approver: string;
  /** Optional human-readable prompt shown in the approval UI. */
  prompt?: string;
  /** Optional auto-deny timeout in minutes. */
  timeoutMinutes?: number;
}

/** Who runs the Intent and who is accountable for the outcome. */
export interface Owner {
  /** Agent handle responsible for execution, e.g. `@claudemb`. */
  agent: string;
  /** Human handle accountable for the outcome, e.g. `@petrus`. */
  human: string;
}

/** A piece of evidence to record as the Intent progresses. */
export interface Receipt {
  /**
   * Receipt kind. Common values: `pr_url`, `commit_hash`, `room_message_id`,
   * `file_diff`, `test_output`, `tool_call`, `external_link`.
   */
  kind: string;
  /** Optional label shown in the receipts log. */
  label?: string;
}

/** How to escalate when the Intent is blocked or stalled. */
export interface Escalation {
  /** Room handle to ping, e.g. `thinkoff-development`. */
  room: string;
  /** Optional explicit handle(s) to mention. */
  mention?: string[];
  /** Minutes of inactivity before auto-escalation. */
  timeoutMinutes?: number;
  /** Optional URL to a gate / dashboard / runbook. */
  gateUrl?: string;
}

/** A testable condition that, when true, means the Intent is complete. */
export interface DoneCriterion {
  /** Plain-language description of the check. */
  check: string;
  /** Optional structured probe an agent can evaluate (URL, shell snippet, etc.). */
  probe?: string;
}

/** The full Intent contract. */
export interface Intent {
  /** Optional stable id; if absent, the executor assigns one. */
  id?: string;
  /** One-sentence statement of the outcome. */
  goal: string;
  /** Hard limits on execution. */
  constraints: Constraint[];
  /** Decision points requiring human approval. */
  approvalGates: ApprovalGate[];
  /** Execution and accountability. */
  owner: Owner;
  /** Evidence to record. */
  receipts: Receipt[];
  /** Escalation path. */
  escalation: Escalation;
  /** Non-empty list of completion checks. */
  doneCriteria: DoneCriterion[];
  /** Optional free-form context the agent may use. */
  notes?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Minimal validation: required fields present, ownership is a non-empty
 * agent handle, doneCriteria is a non-empty array. Deeper semantic checks
 * (constraint families, approver existence) are left to the executor.
 */
export function validateIntent(intent: Intent): ValidationResult {
  const errors: string[] = [];

  if (!intent || typeof intent !== "object") {
    return { ok: false, errors: ["intent must be an object"] };
  }

  if (typeof intent.goal !== "string" || intent.goal.trim().length === 0) {
    errors.push("goal must be a non-empty string");
  }

  if (!Array.isArray(intent.constraints)) {
    errors.push("constraints must be an array");
  }

  if (!Array.isArray(intent.approvalGates)) {
    errors.push("approvalGates must be an array");
  }

  if (!intent.owner || typeof intent.owner !== "object") {
    errors.push("owner is required");
  } else {
    if (
      typeof intent.owner.agent !== "string" ||
      intent.owner.agent.trim().length === 0
    ) {
      errors.push("owner.agent must be a non-empty agent handle");
    }
    if (
      typeof intent.owner.human !== "string" ||
      intent.owner.human.trim().length === 0
    ) {
      errors.push("owner.human must be a non-empty handle");
    }
  }

  if (!Array.isArray(intent.receipts)) {
    errors.push("receipts must be an array");
  }

  if (!intent.escalation || typeof intent.escalation !== "object") {
    errors.push("escalation is required");
  } else if (
    typeof intent.escalation.room !== "string" ||
    intent.escalation.room.trim().length === 0
  ) {
    errors.push("escalation.room must be a non-empty room handle");
  }

  if (!Array.isArray(intent.doneCriteria) || intent.doneCriteria.length === 0) {
    errors.push("doneCriteria must be a non-empty array");
  } else {
    for (let i = 0; i < intent.doneCriteria.length; i++) {
      const dc = intent.doneCriteria[i];
      if (!dc || typeof dc.check !== "string" || dc.check.trim().length === 0) {
        errors.push(`doneCriteria[${i}].check must be a non-empty string`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
