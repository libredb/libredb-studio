import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { executeAuditedOperation, releaseExecutionRun } from "@/lib/db/operations/execution";
import type { ExecutionActor, ExecutionPolicy, OperationRequest, TargetScope } from "@/lib/db/operations/policy";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * Audit + artifact glue for the agent execution path (#328 T6) — the execution
 * MECHANICS: what the caller is told, what the budget tracker records, what the
 * artifact store holds, and that a refused request never reaches the provider.
 *
 * What the audit TRAIL contains is asserted in
 * `tests/security/agent-execution-audit.test.ts` instead, and deliberately not
 * here. `bun run test` runs tests/unit, tests/api and tests/integration in one
 * process, and `tests/api/db/maintenance.test.ts` replaces `@/lib/audit`
 * wholesale via `mock.module` — which is process-wide, so whether an assertion
 * in this directory sees the real ring buffer depends on file ordering
 * (CLAUDE.md's coverage-isolation note; `tests/api/auth/login.test.ts` carries
 * the same warning). tests/security is its own `bun test` invocation with no
 * such stub, so the audit assertions are deterministic there. Do not "restore"
 * event assertions to this file.
 */

const budgets: ExecutionBudget = {
  maxConcurrentExecutions: 2,
  maxStatementsPerRun: 10,
  maxTotalRunMs: 60_000,
  statementTimeoutMs: 5_000,
  maxResultRows: 1_000,
  maxResultBytes: 1_048_576,
};

const policy: ExecutionPolicy = {
  version: "test-policy.1",
  maxRiskClass: 1,
  allowedRoles: ["admin", "user"],
  allowedModes: ["agent"],
  budgets,
};

const actor: ExecutionActor = { sessionId: "session-1", role: "user", mode: "agent" };

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

const readRequest: OperationRequest = {
  operationId: "sql.query.read",
  target: {},
  input: { sql: "SELECT id FROM orders" },
};

const scope: TargetScope = createTargetScope("conn-1");

/** Deterministic clock: each call returns the next pinned instant. */
function stubClock(...instants: number[]): () => number {
  let index = 0;
  return () => {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  };
}

function baseParams(overrides: Partial<Parameters<typeof executeAuditedOperation>[0]> = {}) {
  return {
    registry: createCanonicalOperationRegistry(),
    policy,
    actor,
    scope,
    request: readRequest,
    capabilities,
    ...overrides,
  };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  // Only to keep the authoritative stdout line out of the test output; nothing
  // here reads it (see the header note on where the audit trail is asserted).
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe("executeAuditedOperation — allowed execution", () => {
  test("reports the allow decision and the provider result to its caller", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<{ rows: { id: number }[] }>({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async () => ({ rows: [{ id: 1 }] }));

    const outcome = await executeAuditedOperation(
      baseParams(),
      { runId: "run-1", tracker, artifacts, clock: stubClock(1_000, 1_042) },
      invoke,
    );

    expect(outcome.kind).toBe("executed");
    expect(outcome.decision.reasonCode).toBe("ALLOWED");
    expect(outcome.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    if (outcome.kind === "executed") expect(outcome.result).toEqual({ rows: [{ id: 1 }] });
  });

  test("gives every execution its own correlation id", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async () => ({ rows: [] }));
    const context = { runId: "run-1", tracker, artifacts, clock: stubClock(1_000, 1_001) };

    const first = await executeAuditedOperation(baseParams(), context, invoke);
    const second = await executeAuditedOperation(baseParams(), context, invoke);

    expect(first.correlationId).not.toBe(second.correlationId);
  });

  test("stores the result as a run-scoped artifact keyed by the correlation id", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<{ rows: unknown[] }>({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async () => ({ rows: [{ id: 7 }] }));

    const outcome = await executeAuditedOperation(
      baseParams(),
      { runId: "run-1", tracker, artifacts, clock: stubClock(2_000, 2_010) },
      invoke,
    );

    const stored = artifacts.get(outcome.correlationId, 2_010);
    expect(stored?.value).toEqual({ rows: [{ id: 7 }] });
    expect(stored?.runId).toBe("run-1");
    expect(stored?.operationId).toBe("sql.query.read");
    expect(stored?.createdAtMs).toBe(2_000);
  });

  test("accounts the statement against the run and releases the concurrency slot", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });

    await executeAuditedOperation(
      baseParams(),
      { runId: "run-1", tracker, artifacts, clock: stubClock(0, 25) },
      mock(async () => ({ rows: [] })),
    );

    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 25 });
  });

  test("does not count its own in-flight execution against the concurrency budget", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    // A budget of one: if usage were read after beginExecution, the very first
    // execution of a run would deny itself.
    const params = baseParams({ policy: { ...policy, budgets: { ...budgets, maxConcurrentExecutions: 1 } } });

    const outcome = await executeAuditedOperation(
      params,
      { runId: "run-1", tracker, artifacts, clock: stubClock(0, 5) },
      mock(async () => ({ rows: [] })),
    );

    expect(outcome.kind).toBe("executed");
  });

  test("passes the validated input and the frozen effective budget to the provider callback", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async (_execution: { validatedInput: unknown; budget: ExecutionBudget }) => ({ rows: [] }));

    await executeAuditedOperation(baseParams(), { runId: "run-1", tracker, artifacts, clock: stubClock(0, 1) }, invoke);

    const execution = invoke.mock.calls[0][0];
    expect(execution.validatedInput).toEqual({ sql: "SELECT id FROM orders" });
    expect(execution.budget.statementTimeoutMs).toBe(5_000);
    expect(Object.isFrozen(execution.budget)).toBe(true);
  });
});

describe("executeAuditedOperation — refused execution", () => {
  test("never reaches the provider on a denial, and consumes nothing", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async () => ({ rows: [] }));
    const params = baseParams({ policy: { ...policy, allowedRoles: ["admin"] } });

    const outcome = await executeAuditedOperation(
      params,
      { runId: "run-1", tracker, artifacts, clock: stubClock(0, 1) },
      invoke,
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("denied");
    expect(outcome.decision.reasonCode).toBe("ROLE_FORBIDDEN");
    // A refused request consumes no statement and leaves no artifact behind.
    expect(tracker.usage("run-1").executedStatements).toBe(0);
    expect(artifacts.size).toBe(0);
  });

  test("never reaches the provider on an approval requirement", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const invoke = mock(async () => ({ rows: [] }));
    const params = baseParams({
      request: { operationId: "sql.explain.analyze", target: {}, input: { sql: "EXPLAIN ANALYZE SELECT 1" } },
    });

    const outcome = await executeAuditedOperation(
      params,
      { runId: "run-1", tracker, artifacts, clock: stubClock(0, 1) },
      invoke,
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("denied");
    expect(outcome.decision.reasonCode).toBe("APPROVAL_REQUIRED");
    expect(artifacts.size).toBe(0);
  });
});

describe("executeAuditedOperation — provider failure", () => {
  test("keeps no artifact, releases the slot, and rethrows the provider's error", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const failure = new Error("connection reset by peer");
    const invoke = mock(async () => {
      throw failure;
    });

    await expect(
      executeAuditedOperation(baseParams(), { runId: "run-1", tracker, artifacts, clock: stubClock(100, 160) }, invoke),
    ).rejects.toThrow(failure);

    // A failed statement still consumed the database's time, so it is accounted
    // for; only the result it never produced is absent.
    expect(artifacts.size).toBe(0);
    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 60 });
  });

  test("reports a failing artifact store's own error, without releasing the slot twice", async () => {
    const tracker = new ExecutionBudgetTracker();
    const storeFailure = new Error("artifact store rejected the result");
    const artifacts = {
      put: () => {
        throw storeFailure;
      },
      releaseRun: () => 0,
    } as unknown as ExecutionArtifactStore<{ rows: unknown[] }>;

    // Only the provider call belongs in the recovery path. A compensating
    // release that also covered post-execution bookkeeping would call
    // endExecution a second time, and the BudgetAccountingError that raises
    // would replace the error that actually happened.
    await expect(
      executeAuditedOperation(
        baseParams(),
        { runId: "run-1", tracker, artifacts, clock: stubClock(0, 30) },
        mock(async () => ({ rows: [] })),
      ),
    ).rejects.toThrow(storeFailure);

    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 30 });
  });

  test("survives a clock that steps backwards mid-execution", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });

    // `Date.now()` is the default clock and is not monotonic (an NTP step, a VM
    // clock sync). budgets.ts rejects a negative elapsedMs, so an unclamped
    // subtraction would strand the run's concurrency slot at 1 forever - the
    // run could then never be released.
    const outcome = await executeAuditedOperation(
      baseParams(),
      { runId: "run-1", tracker, artifacts, clock: stubClock(1_000, 400) },
      mock(async () => ({ rows: [] })),
    );

    expect(outcome.kind).toBe("executed");
    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 0 });
    releaseExecutionRun({ runId: "run-1", tracker, artifacts });
  });

  test("survives a clock that reports a non-finite instant", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });

    // `Math.max(0, NaN)` is NaN, and the tracker refuses a non-finite elapsed
    // time - which would strand the slot exactly as a backwards step did. The
    // clamp has to reject non-finite values, not just negative ones.
    const outcome = await executeAuditedOperation(
      baseParams(),
      { runId: "run-1", tracker, artifacts, clock: stubClock(0, Number.NaN) },
      mock(async () => ({ rows: [] })),
    );

    expect(outcome.kind).toBe("executed");
    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 1, totalElapsedMs: 0 });
    releaseExecutionRun({ runId: "run-1", tracker, artifacts });
  });
});

describe("releaseExecutionRun", () => {
  test("drops the run's artifacts and its budget accounting together", async () => {
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 });
    const context = { runId: "run-1", tracker, artifacts, clock: stubClock(0, 1) };

    const outcome = await executeAuditedOperation(
      baseParams(),
      context,
      mock(async () => ({ rows: [] })),
    );
    expect(artifacts.size).toBe(1);

    releaseExecutionRun(context);

    expect(artifacts.get(outcome.correlationId, 2)).toBeUndefined();
    expect(artifacts.size).toBe(0);
    expect(tracker.usage("run-1")).toEqual({ activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 });
  });
});
