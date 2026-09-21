/**
 * What one drive may spend, derived from the run's own ledger rather than from
 * the drive's construction (#329, epic #325; `docs/BACKLOG.md` B6).
 *
 * The statement, elapsed-time and deadline ceilings were all per drive: a run
 * resumed after a process death was handed a fresh set and started each ceiling
 * again, so N resumes cost up to N times one drive's budget. This module is the
 * missing read: it folds the run's persisted history into the ceilings a drive
 * starts with, and derives the artifact allowance the same way (#999). The
 * repair ledger stays per drive (`docs/BACKLOG.md` B6).
 *
 * Two clocks meet here and are kept apart on purpose. The deadline is derived
 * from `record.createdAtMs`, a WALL-CLOCK timestamp written when the run opened,
 * while the statement and elapsed-time figures come from the ledger's own
 * `tool-completed` entries. The derived deadline is then handed to
 * `AgentRunDeadline`, which measures the rest of the run on a monotonic clock.
 */

import { AGENT_WORKFLOW_BUDGETS } from "./execution-policy";
import type { AgentRunEvent, AgentRunWorkflowType } from "./types";

/** The ceilings a drive begins with, folded from the run's persisted history. */
export interface DriveCeilings {
  /** Wall-clock milliseconds left, floored at 1 so `AgentRunDeadline` always accepts it. */
  readonly deadlineMs: number;
  /** Statements already spent by earlier drives, folded from `tool-completed` entries. */
  readonly executedStatements: number;
  /** Database time already spent by earlier drives, from the same entries. */
  readonly executedMs: number;
  /** How many artifacts this run may hold at once, across drives (#999). */
  readonly artifactAllowance: number;
}

/**
 * Derives what the next drive may spend from the run's ledger.
 *
 * The statement count folds `tool-completed` entries: each records one read the
 * execution layer accounted for. A first drive starts at zero; a resumed drive
 * inherits the spend the ledger shows.
 */
export function deriveDriveCeilings(
  run: {
    readonly workflowType: AgentRunWorkflowType;
    readonly createdAtMs: number;
    readonly events: readonly AgentRunEvent[];
  },
  nowMs: number,
): DriveCeilings {
  const budget = AGENT_WORKFLOW_BUDGETS[run.workflowType];
  const deadlineMs = Math.max(1, run.createdAtMs + budget.runDeadlineMs - nowMs);
  let executedStatements = 0;
  let executedMs = 0;
  for (const event of run.events) {
    if (event.kind === "tool-completed") {
      executedStatements += 1;
      executedMs += event.artifact.summary.elapsedMs;
    }
  }
  return {
    deadlineMs,
    executedStatements,
    executedMs,
    artifactAllowance: budget.policy.budgets.maxStatementsPerRun,
  };
}
