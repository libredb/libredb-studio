import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentCatalogKind, AgentCatalogRead } from "@/lib/agent/composed-sql-primitives";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import type { DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";
import * as SQL_CLIENT_OVERLAYS from "@/lib/agent/languages/sql/engines/client";

/**
 * A statement workflow on an engine whose dialect composes a catalog read through a row mapper and no estimating plan,
 * driven through the real run loop: the catalog-only workflows open there and send their statements through
 * `queryReadOnly`, the catalog read reaches the model as the rows the mapper wrote, and the workflow whose verdict
 * needs a plan stays refused for the reason it always was.
 *
 * No shipped engine is that engine yet, so this file substitutes DuckDB's engine modules with a double that declares
 * exactly that dialect. `mock.module` is process-wide, so the substitution is made before anything that reaches the
 * engine registry is loaded: every such module is imported dynamically below it, and the runner gives this file its
 * own process.
 */

/** The statement the double composes for each kind, and the engine's own column names it answers under. */
const ENGINE_CATALOG = "SELECT * FROM engine_catalog";
const ENGINE_ROWS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({ TABLE_NAME: "orders", COLUMN_NAME: "id", TYPE_NAME: "INTEGER" }),
  Object.freeze({ TABLE_NAME: "orders", COLUMN_NAME: "customer", TYPE_NAME: "VARCHAR" }),
]);

const mappedKinds: AgentCatalogKind[] = [];

const CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: () => ENGINE_CATALOG,
    relations: () => ENGINE_CATALOG,
    indexes: () => ENGINE_CATALOG,
    statistics: () => ENGINE_CATALOG,
  }),
  mapRows: (kind: AgentCatalogKind, rows: readonly Record<string, unknown>[]) => {
    mappedKinds.push(kind);
    return {
      fields: ["table_name", "column_name", "data_type"],
      rows: rows.map((row) => ({ table_name: row.TABLE_NAME, column_name: row.COLUMN_NAME, data_type: row.TYPE_NAME })),
    };
  },
});

// Captured as plain objects before the substitution: a namespace follows its replacement.
const REAL_DUCKDB = { ...DUCKDB };
const REAL_SQL_CLIENT_OVERLAYS = { ...SQL_CLIENT_OVERLAYS };
mock.module("@/lib/agent/languages/sql/engines/duckdb", () => ({
  ...REAL_DUCKDB,
  DUCKDB_SERVER_OVERLAY: {
    dialect: Object.freeze({
      catalogRead: CATALOG_READ,
      planEstimate: "unsupported",
      profileComposition: "unsupported",
      statistics: "unsupported",
      catalogCapture: "unsupported",
    }),
  },
}));
mock.module("@/lib/agent/languages/sql/engines/client", () => ({
  ...REAL_SQL_CLIENT_OVERLAYS,
  DUCKDB_CLIENT_OVERLAY: {
    dialect: Object.freeze({ catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" }),
  },
}));

const { AGENT_REQUIREMENT_ENGINES, persistedRunFacts, workflowAvailability } = await import(
  "@/lib/agent/agent-manifest"
);
const { forgetHeldSnapshots } = await import("@/lib/agent/context-snapshot");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { runInvestigation } = await import("@/lib/agent/investigation");
const { readStatisticsForGrounding } = await import("@/lib/agent/tools");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { AgentRunService } = await import("@/lib/agent/run-service");
const { AgentRunStore } = await import("@/lib/agent/run-store");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry } = await import("@/lib/db/operations/descriptors");
const { createTargetScope } = await import("@/lib/db/operations/policy");
const { createDatabaseProvider } = await import("@/lib/db/factory");
const { createLocalWorld } = await import("@workflow/world-local");
const { CENSUS_CONNECTION } = await import("../../../helpers/census-connection");
const { answersProse, callsTool, modelOver, scriptedModel } = await import(
  "../../../isolated/fixtures/agent-scripted-model"
);

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const connection = CENSUS_CONNECTION.duckdb;

/** One agent-mode drive of `turns` on the double, and every statement it sent through `queryReadOnly`. */
async function drive(
  workflowType: AgentRunWorkflowType,
  turns: readonly ReturnType<typeof callsTool>[],
): Promise<{ readonly events: readonly AgentRunEvent[]; readonly sent: readonly string[] }> {
  forgetHeldSnapshots();
  const declared = await createDatabaseProvider(connection);
  const capabilities = declared.getCapabilities();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error("duckdb declares no object kind to list");
  const sent: string[] = [];
  const provider = {
    queryReadOnly: async (sql: string): Promise<QueryResult> => {
      sent.push(sql);
      return sql === ENGINE_CATALOG
        ? {
            rows: ENGINE_ROWS.map((row) => ({ ...row })),
            fields: ["TABLE_NAME", "COLUMN_NAME", "TYPE_NAME"],
            rowCount: 2,
            executionTime: 1,
          }
        : { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };
    },
    listContainers: async () => [],
    countObjects: async () => ({ [listed.id]: { count: 1 } }),
    listObjects: async (container: readonly string[], kind: string) =>
      kind === listed.id ? [{ path: [...container, "orders"], name: "orders", kind }] : [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  const availability = workflowAvailability("agent", workflowType, connection.type);
  if (!availability.open) throw new Error(`${workflowType} does not open on the double`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-catalog-row-mapper-"));
  dataDirs.push(dataDir);
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const run = await service.start({
    mode: "agent",
    workflowType,
    ...persistedRunFacts("agent", workflowType, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "Which customers ordered most?",
  });
  const script = scriptedModel(...turns, answersProse("No report."), answersProse("No report."));
  await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources: {
      connection,
      capabilities,
      labels: declared.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, () => 10_000),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => provider,
    },
  }).catch(() => undefined);
  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);
  return { events: view.record.events, sent };
}

describe("an engine that composes its catalog read through a row mapper and no estimating plan", () => {
  test("holds sql-catalog and not sql-composers", () => {
    expect(AGENT_REQUIREMENT_ENGINES["sql-catalog"]).toContain("duckdb");
    expect(AGENT_REQUIREMENT_ENGINES["sql-composers"]).not.toContain("duckdb");
  });

  test.each(["investigation", "database-assessment", "data-analysis"] as const)("opens %s", (workflow) => {
    expect(workflowAvailability("agent", workflow, "duckdb")).toMatchObject({ open: true, statementLanguage: "sql" });
  });

  test("refuses query-optimization with the sentence it was always refused with", () => {
    expect(workflowAvailability("agent", "query-optimization", "duckdb")).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence:
        "Agent mode has no verified catalog or plan composition for this engine, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    });
  });

  test("an investigation reads the catalog as the mapper's rows and sends its own statement through queryReadOnly", async () => {
    mappedKinds.length = 0;
    const { events, sent } = await drive("investigation", [
      callsTool("inspect_schema", { kind: "columns" }, "call_1"),
      callsTool("run_read_query", { sql: "SELECT count(*) FROM orders", rationale: "count them" }, "call_2"),
    ]);
    expect(sent).toEqual([ENGINE_CATALOG, "SELECT count(*) FROM orders"]);
    expect(mappedKinds).toEqual(["columns"]);
    const completed = events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact] : []));
    expect(completed.map((artifact) => artifact.operationId)).toEqual(["sql.query.read", "sql.query.read"]);
    expect(completed[0]?.summary).toMatchObject({
      rowCount: 2,
      columnNames: ["table_name", "column_name", "data_type"],
    });
    expect(completed[1]?.summary).toMatchObject({ rowCount: 1, columnNames: ["n"] });
  });

  test("an analysis asking for a plan is refused by inspect_plan alone, before anything is sent", async () => {
    const { events, sent } = await drive("data-analysis", [
      callsTool("inspect_plan", { sql: "SELECT count(*) FROM orders" }, "call_1"),
      callsTool("run_read_query", { sql: "SELECT count(*) FROM orders", rationale: "count them" }, "call_2"),
    ]);
    expect(sent).toEqual(["SELECT count(*) FROM orders"]);
    const refused = events.flatMap((event) => (event.kind === "tool-refused" ? [event.refusal] : []));
    expect(refused).toEqual([{ class: "not-sent", reasonCode: "INVALID_TOOL_INPUT", detail: "UNSUPPORTED_DIALECT" }]);
  });

  test("a plan run's statistics read under the operations profile keeps the mapped rows of the statistics kind", async () => {
    mappedKinds.length = 0;
    const profiles: string[] = [];
    const outcome = await readStatisticsForGrounding(
      {
        runId: "run_mapped",
        modelId: "gpt-4o-mini",
        mode: "planning",
        workflowType: "investigation",
        actor: { sessionId: "sess_1", role: "user" },
        connection,
        capabilities: { queryLanguage: "sql" } as never,
        labels: {} as never,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(connection.id),
        tracker: new ExecutionBudgetTracker(),
        artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
        deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs, () => 10_000),
        repairs: new AgentRepairLedger(),
        acquireProvider: async (_connection, profile) => {
          profiles.push(profile);
          return {
            query: async (sql: string): Promise<QueryResult> => {
              expect(sql).toBe(ENGINE_CATALOG);
              return {
                rows: ENGINE_ROWS.map((row) => ({ ...row })),
                fields: ["TABLE_NAME", "COLUMN_NAME", "TYPE_NAME"],
                rowCount: 2,
                executionTime: 1,
              };
            },
          } as unknown as DatabaseProvider;
        },
      },
      "estimates",
    );
    expect(profiles).toEqual(["agent-operations"]);
    expect(mappedKinds).toEqual(["statistics"]);
    if (outcome.kind !== "completed") throw new Error(`expected a completed read, got ${outcome.kind}`);
    expect(outcome.artifact.summary).toMatchObject({
      rowCount: 2,
      columnNames: ["table_name", "column_name", "data_type"],
    });
  });
});
