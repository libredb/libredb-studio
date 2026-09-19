import { describe, expect, test } from "bun:test";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { deriveDriveCeilings } from "@/lib/agent/drive-budget";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentRunEvent } from "@/lib/agent/types";

const CREATED_AT = 1_700_000_000_000;
const INVESTIGATION_DEADLINE = AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs;

function completedEvent(stepId: string, elapsedMs: number): AgentRunEvent {
  return {
    kind: "tool-completed",
    atMs: CREATED_AT + elapsedMs,
    stepId,
    artifact: {
      correlationId: `corr_${stepId}`,
      runId: "arun_x",
      operationId: "sql.query.read",
      summary: { rowCount: 2, columnNames: ["id"], elapsedMs },
    },
  };
}

describe("deriveDriveCeilings", () => {
  test("a first drive starts with the full deadline and no spend", () => {
    const ceilings = deriveDriveCeilings(
      { workflowType: "investigation", createdAtMs: CREATED_AT, events: [] },
      CREATED_AT,
    );

    expect(ceilings.deadlineMs).toBe(INVESTIGATION_DEADLINE);
    expect(ceilings.executedStatements).toBe(0);
    expect(ceilings.executedMs).toBe(0);
    expect(ceilings.artifactAllowance).toBe(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxStatementsPerRun);
  });

  test("a resumed drive inherits the completed reads the ledger recorded", () => {
    const events = [completedEvent("s1", 25), completedEvent("s2", 40)];

    const ceilings = deriveDriveCeilings(
      { workflowType: "investigation", createdAtMs: CREATED_AT, events },
      CREATED_AT + 10_000,
    );

    expect(ceilings.executedStatements).toBe(2);
    expect(ceilings.executedMs).toBe(65);
    expect(ceilings.deadlineMs).toBe(INVESTIGATION_DEADLINE - 10_000);
  });

  test("a run whose deadline has passed floors at one millisecond, never zero", () => {
    const ceilings = deriveDriveCeilings(
      { workflowType: "investigation", createdAtMs: CREATED_AT, events: [] },
      CREATED_AT + INVESTIGATION_DEADLINE + 5_000,
    );

    expect(ceilings.deadlineMs).toBe(1);
  });

  test("only tool-completed entries count as spend; other events do not", () => {
    const events: AgentRunEvent[] = [
      completedEvent("s1", 10),
      { kind: "statement-drafted", atMs: CREATED_AT + 1, stepId: "s0", sql: "SELECT 1", rationale: "inspect" },
    ];

    const ceilings = deriveDriveCeilings(
      { workflowType: "investigation", createdAtMs: CREATED_AT, events },
      CREATED_AT,
    );

    expect(ceilings.executedStatements).toBe(1);
    expect(ceilings.executedMs).toBe(10);
  });
});

describe("ExecutionBudgetTracker.seedUsage", () => {
  test("seeds a run with a previous drive's spend", () => {
    const tracker = new ExecutionBudgetTracker();

    tracker.seedUsage("run_1", { executedStatements: 3, totalElapsedMs: 40 });

    expect(tracker.usage("run_1")).toEqual({ activeExecutions: 0, executedStatements: 3, totalElapsedMs: 40 });
  });

  test("never re-seeds a run this process already accounts for", () => {
    const tracker = new ExecutionBudgetTracker();
    tracker.beginExecution("run_1");
    tracker.endExecution("run_1", { statements: 1, elapsedMs: 10 });

    tracker.seedUsage("run_1", { executedStatements: 99, totalElapsedMs: 999 });

    expect(tracker.usage("run_1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 10 });
  });

  test("refuses a malformed seed", () => {
    const tracker = new ExecutionBudgetTracker();

    expect(() => tracker.seedUsage("run_1", { executedStatements: -1, totalElapsedMs: 0 })).toThrow();
    expect(() => tracker.seedUsage("run_1", { executedStatements: 0, totalElapsedMs: Number.NaN })).toThrow();
    expect(() => tracker.seedUsage("run_1", { executedStatements: 1.5, totalElapsedMs: 0 })).toThrow();
  });
});

describe("ExecutionArtifactStore.setRunAllowance", () => {
  function artifactFor(runId: string, correlationId: string, createdAtMs: number) {
    return { correlationId, runId, operationId: "sql.query.read", createdAtMs, value: { rows: [] } };
  }

  test("a run at its allowance evicts its own oldest, not another run's", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 10 });
    store.setRunAllowance("run_a", 2);
    store.put(artifactFor("run_a", "corr_1", 1), 1);
    store.put(artifactFor("run_a", "corr_2", 2), 2);
    store.put(artifactFor("run_b", "corr_b", 3), 3);

    store.put(artifactFor("run_a", "corr_3", 4), 4);

    expect(store.get("corr_1", 4)).toBeUndefined();
    expect(store.get("corr_2", 4)).toBeDefined();
    expect(store.get("corr_b", 4)).toBeDefined();
  });

  test("a run without an allowance is bounded only by the global cap", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 2 });
    store.put(artifactFor("run_a", "corr_1", 1), 1);
    store.put(artifactFor("run_b", "corr_2", 2), 2);

    store.put(artifactFor("run_c", "corr_3", 3), 3);

    // run_c held nothing, so the store-wide oldest (run_a's) went.
    expect(store.get("corr_1", 3)).toBeUndefined();
    expect(store.get("corr_2", 3)).toBeDefined();
  });

  test("releasing a run drops its allowance with its artifacts", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 10 });
    store.setRunAllowance("run_a", 1);
    store.put(artifactFor("run_a", "corr_1", 1), 1);

    store.releaseRun("run_a");
    store.put(artifactFor("run_a", "corr_2", 2), 2);
    store.put(artifactFor("run_a", "corr_3", 3), 3);

    // The allowance is gone, so the run is back to the global cap only.
    expect(store.get("corr_2", 3)).toBeDefined();
    expect(store.get("corr_3", 3)).toBeDefined();
  });

  test("refuses a non-positive allowance", () => {
    const store = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 10 });
    expect(() => store.setRunAllowance("run_a", 0)).toThrow();
  });
});
