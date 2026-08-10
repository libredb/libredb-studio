import { describe, test, expect } from "bun:test";
import { BudgetAccountingError, ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import type { ExecutionBudget, ExecutionUsage } from "@/lib/db/operations/budgets";

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Consumes the budget model type so the six budget dimensions pinned by #328
// (statement count, timeout, row/byte, concurrency, total-run) stay compile-checked.
const budgetShape: ExecutionBudget = {
  maxConcurrentExecutions: 2,
  maxStatementsPerRun: 10,
  maxTotalRunMs: 60_000,
  statementTimeoutMs: 5_000,
  maxResultRows: 1_000,
  maxResultBytes: 1_048_576,
};

const zeroUsage: ExecutionUsage = { activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 };

// ─── usage ──────────────────────────────────────────────────────────────────

describe("ExecutionBudgetTracker.usage", () => {
  test("a run that never began has zero usage", () => {
    const tracker = new ExecutionBudgetTracker();
    expect(tracker.usage("run-1")).toEqual(zeroUsage);
    expect(budgetShape.maxStatementsPerRun).toBeGreaterThan(0);
  });

  test("returns a snapshot copy — mutating it never reaches the tracker", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run-1");
    const snapshot = tracker.usage("run-1") as { activeExecutions: number };
    snapshot.activeExecutions = 99;
    expect(tracker.usage("run-1").activeExecutions).toBe(1);
  });

  test("refuses a blank run id", () => {
    const tracker = new ExecutionBudgetTracker();
    expect(() => tracker.usage("")).toThrow(BudgetAccountingError);
    expect(() => tracker.usage("   ")).toThrow(BudgetAccountingError);
  });
});

// ─── beginExecution / endExecution ──────────────────────────────────────────

describe("ExecutionBudgetTracker accounting", () => {
  test("begin increments concurrency; end decrements it and accumulates statements and elapsed time", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run-1");
    tracker.beginExecution("run-1");
    expect(tracker.usage("run-1").activeExecutions).toBe(2);
    tracker.endExecution("run-1", { statements: 1, elapsedMs: 120.5 });
    tracker.endExecution("run-1", { statements: 1, elapsedMs: 79.5 });
    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 2, totalElapsedMs: 200 });
  });

  test("tracks runs independently", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run-a");
    tracker.beginExecution("run-b");
    tracker.endExecution("run-b", { statements: 1, elapsedMs: 5 });
    expect(tracker.usage("run-a")).toEqual({ activeExecutions: 1, executedStatements: 0, totalElapsedMs: 0 });
    expect(tracker.usage("run-b")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 5 });
  });

  test("an unbalanced end fails loud — silently clamping would under-count concurrency (fail open)", () => {
    const tracker = new ExecutionBudgetTracker();
    expect(() => tracker.endExecution("run-1", { statements: 0, elapsedMs: 0 })).toThrow(BudgetAccountingError);
    tracker.beginExecution("run-1");
    tracker.endExecution("run-1", { statements: 1, elapsedMs: 1 });
    expect(() => tracker.endExecution("run-1", { statements: 1, elapsedMs: 1 })).toThrow(BudgetAccountingError);
  });

  test("refuses corrupt outcome accounting instead of poisoning the run totals", () => {
    const tracker = new ExecutionBudgetTracker();
    const invalidOutcomes = [
      { statements: -1, elapsedMs: 0 },
      { statements: 1.5, elapsedMs: 0 },
      { statements: Number.NaN, elapsedMs: 0 },
      { statements: 0, elapsedMs: -1 },
      { statements: 0, elapsedMs: Number.NaN },
      { statements: 0, elapsedMs: Number.POSITIVE_INFINITY },
    ];
    for (const outcome of invalidOutcomes) {
      tracker.beginExecution("run-1");
      expect(() => tracker.endExecution("run-1", outcome)).toThrow(BudgetAccountingError);
      // The refused outcome must not have decremented concurrency or accumulated totals.
      expect(tracker.usage("run-1").executedStatements).toBe(0);
      tracker.endExecution("run-1", { statements: 0, elapsedMs: 0 });
    }
  });

  test("refuses blank run ids on both begin and end", () => {
    const tracker = new ExecutionBudgetTracker();
    expect(() => tracker.beginExecution(" ")).toThrow(BudgetAccountingError);
    expect(() => tracker.endExecution("", { statements: 0, elapsedMs: 0 })).toThrow(BudgetAccountingError);
  });
});

// ─── endRun ─────────────────────────────────────────────────────────────────

describe("ExecutionBudgetTracker.endRun", () => {
  test("releases a finished run's accounting and is idempotent", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run-1");
    tracker.endExecution("run-1", { statements: 3, elapsedMs: 42 });
    tracker.endRun("run-1");
    expect(tracker.usage("run-1")).toEqual(zeroUsage);
    tracker.endRun("run-1");
    expect(tracker.usage("run-1")).toEqual(zeroUsage);
  });

  test("refuses to end a run with live executions — dropping live usage would reset the budget mid-flight", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run-1");
    expect(() => tracker.endRun("run-1")).toThrow(BudgetAccountingError);
    expect(tracker.usage("run-1").activeExecutions).toBe(1);
  });

  test("refuses a blank run id", () => {
    const tracker = new ExecutionBudgetTracker();
    expect(() => tracker.endRun("")).toThrow(BudgetAccountingError);
  });
});
