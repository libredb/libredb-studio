import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { type AgentToolContext, executeAgentOperation, runReadQueryTool } from "@/lib/agent/tools";
import { getServerAuditBuffer } from "@/lib/audit";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { OperationRegistry } from "@/lib/db/operations/registry";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

/**
 * Control 3.5 — accountability of the agent TOOL layer (#329 T6).
 *
 * `tests/security/agent-execution-audit.test.ts` covers the M1 execution glue. This
 * suite covers the one refusal the tool layer owns and the glue cannot see: the
 * run's wall-clock deadline. It fires BEFORE `executeAuditedOperation` is reached,
 * so without its own audit event a run that stopped on its own deadline would leave
 * no trace at all — which is exactly the silent-decision failure mode the M1 layer
 * was built to avoid.
 *
 * It lives in tests/security rather than beside the tool unit tests because
 * `tests/api/db/maintenance.test.ts` replaces `@/lib/audit` process-wide via
 * `mock.module`, and `bun run test` runs tests/unit, tests/api and tests/integration
 * in one process. tests/security is its own invocation with no such stub, so these
 * assertions are deterministic here and would be file-order-dependent there.
 */

const SQL_SENTINEL = "zt7q_salary_column_sentinel";
const SESSION_SENTINEL = "eyJhbGciOiJIUzI1NiJ9.sentinel-session-token";
const ENGINE_MESSAGE_SENTINEL = "zt7q_engine_said_this_out_loud";

const connection: DatabaseConnection = { id: "conn-1", name: "Orders", type: "postgres", createdAt: new Date(0) };

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

/** Reads the pinned instants in order, then holds the last one. */
function stubClock(...instants: number[]): () => number {
  let index = 0;
  return () => {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  };
}

function context(
  overrides: Partial<AgentToolContext> = {},
  run: () => Promise<QueryResult> = async () => ({
    rows: [],
    fields: [],
    rowCount: 0,
    executionTime: 1,
  }),
): AgentToolContext {
  const provider = { queryReadOnly: mock(run) } as unknown as DatabaseProvider;
  return {
    runId: "run-1",
    mode: "agent",
    workflowType: "investigation",
    actor: { sessionId: SESSION_SENTINEL, role: "user" },
    connection,
    capabilities,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope("conn-1"),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 8 }),
    // Two readings past a 1ms total: construction takes the first, `admit` the next.
    deadline: new AgentRunDeadline(1, stubClock(0, 5_000)),
    repairs: new AgentRepairLedger(),
    acquireProvider: mock(async () => provider),
    clock: stubClock(1_000, 1_010),
    ...overrides,
  };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

/** Everything both destinations recorded, as one string to scan. */
function auditedText(): string {
  const lines = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
  return `${JSON.stringify(getServerAuditBuffer().getAll())}\n${lines}`;
}

beforeEach(() => {
  getServerAuditBuffer().clear();
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe("a run that stops on its own deadline is auditable", () => {
  test("an exhausted deadline records an agent_operation failure with its own reason code", async () => {
    const outcome = await runReadQueryTool(context(), { sql: `SELECT ${SQL_SENTINEL} FROM staff` });

    expect(outcome.kind).toBe("unavailable");
    const events = getServerAuditBuffer().getAll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_operation");
    expect(events[0].result).toBe("failure");
    expect(events[0].reason).toBe("agent_run_deadline_exceeded");
    expect(events[0].target).toBe("agent/operations/deadline");
  });

  test("a call that no longer fits its minimum records the other reason code", async () => {
    const outcome = await runReadQueryTool(context({ deadline: new AgentRunDeadline(1_000, stubClock(0, 999)) }), {
      sql: "SELECT 1",
    });

    if (outcome.kind !== "unavailable") throw new Error(`expected unavailable, got ${outcome.kind}`);
    expect(outcome.reasonCode).toBe("INSUFFICIENT_TIME_REMAINING");
    expect(getServerAuditBuffer().getAll()[0].reason).toBe("agent_insufficient_time_remaining");
  });

  test("the recorded action is the registry-resolved operation id", async () => {
    await runReadQueryTool(context(), { sql: "SELECT 1" });

    expect(getServerAuditBuffer().getAll()[0].action).toBe("sql.query.read");
  });

  test("an operation the registry cannot resolve is recorded as unresolved, never as the caller's string", async () => {
    // An empty registry stands in for a misconfigured one: the audited action must
    // stay a closed vocabulary even when resolution fails.
    await executeAgentOperation(context({ registry: new OperationRegistry() }), {
      operationId: "sql.query.read",
      sql: "SELECT 1",
    });

    expect(getServerAuditBuffer().getAll()[0].action).toBe("unresolved");
  });

  test("the actor label is mode:role once the policy layer has accepted the actor", async () => {
    await runReadQueryTool(context(), { sql: "SELECT 1" });

    expect(getServerAuditBuffer().getAll()[0].user).toBe("agent:user");
  });

  test("an actor the policy layer would refuse is logged as unknown, not as its own values", async () => {
    // A blank session id is exactly what `isValidActor` refuses, so the label may
    // not be built from the actor's fields.
    await runReadQueryTool(context({ actor: { sessionId: "", role: "admin" } }), { sql: "SELECT 1" });

    expect(getServerAuditBuffer().getAll()[0].user).toBe("agent:unknown");
  });
});

describe("the tool layer records no content it is not allowed to record", () => {
  test("a deadline refusal records neither the statement nor the session identifier", async () => {
    await runReadQueryTool(context(), { sql: `SELECT ${SQL_SENTINEL} FROM staff` });

    const recorded = auditedText();
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain(SESSION_SENTINEL);
  });

  test("an engine message reaches the model fenced and the audit trail not at all", async () => {
    const outcome = await runReadQueryTool(
      context({ deadline: new AgentRunDeadline(60_000, stubClock(0, 0)) }, async () => {
        throw new QueryError(`${ENGINE_MESSAGE_SENTINEL} near "staff"`, "postgres", "SELECT 1");
      }),
      { sql: `SELECT ${SQL_SENTINEL} FROM staff` },
    );

    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.modelText).toContain(ENGINE_MESSAGE_SENTINEL);

    const recorded = auditedText();
    expect(recorded).not.toContain(ENGINE_MESSAGE_SENTINEL);
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain(SESSION_SENTINEL);
    // The failure is still visible as a typed reason.
    expect(recorded).toContain("agent_execution_failed");
  });

  test("an allowed read records the correlation id and no result content", async () => {
    const outcome = await runReadQueryTool(
      context({ deadline: new AgentRunDeadline(60_000, stubClock(0, 0)) }, async () => ({
        rows: [{ [SQL_SENTINEL]: 90_000 }],
        fields: [SQL_SENTINEL],
        rowCount: 1,
        executionTime: 4,
      })),
      { sql: "SELECT salary FROM staff" },
    );

    if (outcome.kind !== "completed") throw new Error(`expected completed, got ${outcome.kind}`);
    const recorded = auditedText();
    expect(recorded).toContain(outcome.artifact.correlationId);
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain(SESSION_SENTINEL);
  });
});
