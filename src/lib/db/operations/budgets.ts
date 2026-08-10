/**
 * Execution budgets and run-scoped usage accounting (#328).
 *
 * The five budget dimensions pinned by the acceptance bar all live here:
 * statement count (`maxStatementsPerRun`), per-statement timeout
 * (`statementTimeoutMs`), row/byte caps (`maxResultRows`/`maxResultBytes`),
 * concurrency (`maxConcurrentExecutions`), and total execution time
 * (`maxTotalRunMs`). Concurrency, statement count, and total execution time are
 * gate checks the policy pipeline evaluates against a run's usage; timeout and
 * row/byte caps are enforcement parameters the execution profiles apply
 * database-side (transaction-local timeout) and result-side.
 *
 * `maxTotalRunMs` bounds the DATABASE time a run consumes — the sum of the
 * elapsed times the execution layer reports for completed calls. It is not a
 * wall-clock deadline for the run: time between calls is not counted, parallel
 * calls each contribute their own duration, and a call admitted just under the
 * limit can still overrun it by up to one statement timeout. That is the useful
 * bound at this layer (it limits load on the database), and a real wall-clock
 * deadline needs a clock this tracker deliberately does not have — see the
 * determinism note below. Bounding an agent run's wall clock belongs to the run
 * loop that M2 introduces; tracked in docs/BACKLOG.md.
 *
 * `src/lib/api/rate-limit.ts` was evaluated for reuse and deliberately not
 * used: its counters are fixed-window and monotonic (no decrement, so
 * concurrency release is inexpressible) and its capacity eviction fails OPEN
 * by design (an evicted key restarts at zero) — correct for rate limiting,
 * a bypass for a security budget. This tracker is run-scoped, decrements on
 * release, and fails loud on accounting corruption instead of guessing.
 */

/**
 * Effective budget attached to every policy decision. Enforceable policies
 * carry positive integers in every field; the all-zero budget exists only on
 * malformed-context denials, where nothing is executable.
 */
export interface ExecutionBudget {
  readonly maxConcurrentExecutions: number;
  readonly maxStatementsPerRun: number;
  readonly maxTotalRunMs: number;
  readonly statementTimeoutMs: number;
  readonly maxResultRows: number;
  readonly maxResultBytes: number;
}

/** Snapshot of a run's consumption, evaluated by the policy pipeline's budget stage. */
export interface ExecutionUsage {
  readonly activeExecutions: number;
  readonly executedStatements: number;
  readonly totalElapsedMs: number;
}

export class BudgetAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetAccountingError";
    Object.setPrototypeOf(this, BudgetAccountingError.prototype);
  }
}

interface RunAccount {
  activeExecutions: number;
  executedStatements: number;
  totalElapsedMs: number;
}

function assertRunId(runId: string): string {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new BudgetAccountingError("run id must be a non-empty string");
  }
  return runId;
}

/**
 * Per-run execution accounting. There is no clock in here: elapsed time is
 * whatever the execution layer measured and reported, which keeps the tracker
 * deterministic under test. Every accounting error throws instead of clamping —
 * an unbalanced release that silently clamped to zero would under-count
 * concurrency and fail open.
 */
export class ExecutionBudgetTracker {
  private readonly runs = new Map<string, RunAccount>();

  beginExecution(runId: string): void {
    const id = assertRunId(runId);
    const account = this.runs.get(id) ?? { activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 };
    account.activeExecutions += 1;
    this.runs.set(id, account);
  }

  endExecution(runId: string, outcome: { readonly statements: number; readonly elapsedMs: number }): void {
    const id = assertRunId(runId);
    const { statements, elapsedMs } = outcome;
    if (!Number.isInteger(statements) || statements < 0) {
      throw new BudgetAccountingError(`statements must be a non-negative integer, got ${String(statements)}`);
    }
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new BudgetAccountingError(`elapsedMs must be a non-negative finite number, got ${String(elapsedMs)}`);
    }
    const account = this.runs.get(id);
    if (!account || account.activeExecutions === 0) {
      throw new BudgetAccountingError(`unbalanced endExecution for run "${id}" — no live execution to release`);
    }
    account.activeExecutions -= 1;
    account.executedStatements += statements;
    account.totalElapsedMs += elapsedMs;
  }

  usage(runId: string): ExecutionUsage {
    const account = this.runs.get(assertRunId(runId));
    if (!account) return { activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 };
    return {
      activeExecutions: account.activeExecutions,
      executedStatements: account.executedStatements,
      totalElapsedMs: account.totalElapsedMs,
    };
  }

  /**
   * Releases a finished run's accounting. Idempotent for finished runs, but a
   * run with live executions cannot be ended: dropping live usage would reset
   * the concurrency and total-run budgets mid-flight.
   */
  endRun(runId: string): void {
    const id = assertRunId(runId);
    const account = this.runs.get(id);
    if (!account) return;
    if (account.activeExecutions > 0) {
      throw new BudgetAccountingError(`cannot end run "${id}" while ${account.activeExecutions} execution(s) are live`);
    }
    this.runs.delete(id);
  }
}
