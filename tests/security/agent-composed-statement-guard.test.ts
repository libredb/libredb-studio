import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { getServerAuditBuffer } from "@/lib/audit";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../fixtures/provider-labels";

/**
 * Control 3.4 and 3.5: a statement the server composes meets the statement guard on every profile it is sent under.
 *
 * The statistics read is the one statement the agent sends through `provider.query`, under the operations profile,
 * where no read-only transaction contains it. So the guard every other agent statement meets is the boundary there
 * too: a composition the guard refuses is never sent, nothing is acquired for it, and the refusal is audited as the
 * pipeline's input denial, with no statement text, exactly as the same statement is refused under the execution
 * profile.
 *
 * The composition is planted, since no shipped engine composes one the guard refuses
 * (`tests/unit/lib/agent/schema-stats.test.ts` holds that): `mock.module` replaces the statistics composition with
 * the shipped statement followed by a second one. This file runs in a process of its own, so the replacement reaches
 * no other suite.
 */

const PLANTED_TAIL = "; DELETE FROM orders";

const realComposedSql = { ...(await import("@/lib/agent/composed-sql")) };
mock.module("@/lib/agent/composed-sql", () => ({
  ...realComposedSql,
  composeCatalogRead: (...args: Parameters<typeof realComposedSql.composeCatalogRead>) => {
    const sql = realComposedSql.composeCatalogRead(...args);
    return args[1].kind === "statistics" ? `${sql}${PLANTED_TAIL}` : sql;
  },
}));

const { readStatisticsForGrounding } = await import("@/lib/agent/tools");
const { readSchemaStatistics } = await import("@/lib/agent/schema-stats");
type AgentToolContext = Parameters<typeof readStatisticsForGrounding>[0];

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  supportsExternalQueryLimiting: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 1433,
  schemaRefreshPattern: "manual",
};

const connection: DatabaseConnection = { id: "conn-1", name: "Orders", type: "mssql", createdAt: new Date(0) };

const frozenClock = () => 1_000;

interface Harness {
  readonly context: AgentToolContext;
  readonly acquireProvider: ReturnType<typeof mock>;
  readonly query: ReturnType<typeof mock>;
  readonly queryReadOnly: ReturnType<typeof mock>;
}

/** SQL Server grounds under the operations profile in plan mode and under the execution profile in agent mode. */
function harness(profile: "operations" | "execution"): Harness {
  const answer = async (): Promise<QueryResult> => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 });
  const query = mock(answer);
  const queryReadOnly = mock(answer);
  const provider = { query, queryReadOnly } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  return {
    context: {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode: profile === "operations" ? "planning" : "agent",
      workflowType: "investigation",
      ...(profile === "operations" ? {} : { statementLanguage: "sql" as const }),
      actor: { sessionId: "session-1", role: "user" },
      connection,
      capabilities,
      labels: TABLE_LABELS,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn-1"),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        frozenClock,
      ),
      repairs: new AgentRepairLedger(),
      acquireProvider,
      clock: frozenClock,
    },
    acquireProvider,
    query,
    queryReadOnly,
  };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  getServerAuditBuffer().clear();
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

/** Everything both audit destinations recorded, as one string to scan. */
function auditedText(): string {
  const lines = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
  return `${JSON.stringify(getServerAuditBuffer().getAll())}\n${lines}`;
}

describe("a composed statistics statement the statement guard refuses", () => {
  test("under the operations profile a composed statistics statement the guard refuses is never sent, and the reading is refused", async () => {
    const h = harness("operations");

    const outcome = await readStatisticsForGrounding(h.context, "estimates");

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { class: "policy-denied", reasonCode: "INPUT_VALIDATION_FAILED" },
    });
    expect(h.acquireProvider).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.queryReadOnly).not.toHaveBeenCalled();
    // Answered, not thrown, so the drive goes on to its next grounding step with the statistics marked unread.
    const statistics = await readSchemaStatistics(harness("operations").context);
    expect(statistics).toMatchObject({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("the refusal is audited as an input denial of db.schema.read, with no statement text", async () => {
    const h = harness("operations");

    await readStatisticsForGrounding(h.context, "estimates");

    expect(getServerAuditBuffer().getAll()).toEqual([
      expect.objectContaining({
        type: "agent_operation",
        action: "db.schema.read",
        target: "agent/operations/decision",
        user: "agent:user",
        result: "failure",
        reason: "agent_input_validation_failed",
      }),
    ]);
    expect(auditedText()).not.toContain("DELETE");
    expect(auditedText()).not.toContain("sys.partitions");
  });

  test("the same statement is refused the same way under the execution profile", async () => {
    const h = harness("execution");

    const outcome = await readStatisticsForGrounding(h.context, "estimates");

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { class: "policy-denied", reasonCode: "INPUT_VALIDATION_FAILED" },
    });
    expect(h.acquireProvider).not.toHaveBeenCalled();
    expect(h.queryReadOnly).not.toHaveBeenCalled();
    expect(getServerAuditBuffer().getAll()).toEqual([
      expect.objectContaining({
        type: "agent_operation",
        action: "sql.query.read",
        target: "agent/operations/decision",
        result: "failure",
        reason: "agent_input_validation_failed",
      }),
    ]);
    expect(auditedText()).not.toContain("DELETE");
  });
});
