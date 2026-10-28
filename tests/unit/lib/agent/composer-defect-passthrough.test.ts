import { describe, expect, mock, test } from "bun:test";
import * as COMPOSED_SQL from "@/lib/agent/composed-sql";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";

/**
 * A composer defect leaves as itself, never as a refusal.
 *
 * `composedSqlOutcome` in `tools.ts` and `readSchemaStatistics` in `schema-stats.ts` turn an
 * `AgentComposedSqlError` into a refusal outcome and rethrow anything else. The real composers
 * throw only `AgentComposedSqlError`, so this file substitutes the composer module with one whose
 * two composers throw a foreign error, and asserts that the same error object leaves each entry
 * point.
 *
 * `mock.module` is process-wide, so the substitution is made before either module under test is
 * loaded: both are imported dynamically below it, and the runner gives this file its own process.
 */

const DEFECT = new TypeError("defect");

// Captured as a plain object before the substitution: the namespace itself follows the replacement.
const REAL_COMPOSED_SQL = { ...COMPOSED_SQL };
mock.module("@/lib/agent/composed-sql", () => ({
  ...REAL_COMPOSED_SQL,
  composeCatalogRead: () => {
    throw DEFECT;
  },
  composeStatisticsAvailabilityProbe: () => {
    throw DEFECT;
  },
}));

const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { readSchemaStatistics } = await import("@/lib/agent/schema-stats");
const { inspectSchemaTool } = await import("@/lib/agent/tools");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry } = await import("@/lib/db/operations/descriptors");
const { createTargetScope } = await import("@/lib/db/operations/policy");

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

const frozenClock = () => 1_000;

function contextFor(type: DatabaseType): { context: AgentToolContext; queryReadOnly: ReturnType<typeof mock> } {
  const queryReadOnly = mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }));
  const provider = { queryReadOnly } as unknown as DatabaseProvider;
  const connection: DatabaseConnection = { id: "conn-1", name: "Orders", type, createdAt: new Date(0) };
  return {
    queryReadOnly,
    context: {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode: "planning",
      workflowType: "investigation",
      actor: { sessionId: "session-1", role: "user" },
      connection,
      capabilities,
      labels: TABLE_LABELS,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn-1"),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        frozenClock,
      ),
      repairs: new AgentRepairLedger(),
      acquireProvider: mock(async () => provider),
      clock: frozenClock,
    },
  };
}

describe("a composer defect leaves as itself, not as a refusal", () => {
  test("inspect_schema rethrows a foreign error from the catalog composer", async () => {
    const { context, queryReadOnly } = contextFor("postgres");

    await expect(inspectSchemaTool(context, { kind: "columns" })).rejects.toBe(DEFECT);
    expect(queryReadOnly).not.toHaveBeenCalled();
  });

  test("readSchemaStatistics rethrows a foreign error from the availability probe composer", async () => {
    const { context, queryReadOnly } = contextFor("sqlite");

    await expect(readSchemaStatistics(context)).rejects.toBe(DEFECT);
    expect(queryReadOnly).not.toHaveBeenCalled();
  });
});
