import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentCatalogKind, AgentCatalogRead } from "@/lib/agent/composed-sql-primitives";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";
import * as SQL_CLIENT_OVERLAYS from "@/lib/agent/languages/sql/engines/client";

/**
 * A statement workflow on an engine whose catalog answers only to a command, not to a SELECT, driven through the real
 * run loop and the real catalog read: the statement the server composed for a catalog kind is admitted by identity,
 * and nothing else is. The same text written by the model is refused as it always was, a statement other than the one
 * composed is refused on the catalog path too, and an overlay that does not declare its catalog read a command gets
 * the ordinary refusal.
 *
 * No shipped engine is that engine yet, so this file substitutes DuckDB's engine modules with a double that declares
 * exactly that dialect. `mock.module` is process-wide, so the substitution is made before anything that reaches the
 * engine registry is loaded: every such module is imported dynamically below it, and the runner gives this file its
 * own process.
 */

/** The command the double composes for every kind, and the engine's own column names it answers under. */
const ENGINE_CATALOG = 'SHOW COLUMNS FROM "orders"';
const ENGINE_FIELDS = ["TABLE_NAME", "COLUMN_NAME", "TYPE_NAME"];
const ENGINE_ROWS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({ TABLE_NAME: "orders", COLUMN_NAME: "id", TYPE_NAME: "INTEGER" }),
  Object.freeze({ TABLE_NAME: "orders", COLUMN_NAME: "customer", TYPE_NAME: "VARCHAR" }),
]);
/** The refusal the double's retry matches, and what its rewrite sends instead. */
const RETRY_MESSAGE = "the catalog answer is not-a-real-refusal";
let rewriteTo: (sql: string) => string = (sql) => sql;
/** Whether the double declares its catalog read a command, read on every use. */
let declaresCommand = true;

const CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: () => ENGINE_CATALOG,
    relations: () => ENGINE_CATALOG,
    indexes: () => ENGINE_CATALOG,
    statistics: () => ENGINE_CATALOG,
  }),
  get commandShaped(): true | undefined {
    return declaresCommand ? true : undefined;
  },
  retry: Object.freeze({
    matches: (message: string) => message === RETRY_MESSAGE,
    rewrite: (sql: string) => rewriteTo(sql),
  }),
  mapRows: (_kind: AgentCatalogKind, rows: readonly Record<string, unknown>[]) => ({
    fields: ["table_name", "column_name", "data_type"],
    rows: rows.map((row) => ({ table_name: row.TABLE_NAME, column_name: row.COLUMN_NAME, data_type: row.TYPE_NAME })),
  }),
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

const { persistedRunFacts, workflowAvailability } = await import("@/lib/agent/agent-manifest");
const { forgetHeldSnapshots } = await import("@/lib/agent/context-snapshot");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { runInvestigation } = await import("@/lib/agent/investigation");
const { readCatalogForGrounding } = await import("@/lib/agent/tools");
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

/** The engine's catalog answer, or one row for any other statement. */
function engineAnswer(sql: string): QueryResult {
  return sql === ENGINE_CATALOG
    ? { rows: structuredClone([...ENGINE_ROWS]), fields: ENGINE_FIELDS, rowCount: 2, executionTime: 1 }
    : { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };
}

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
      return engineAnswer(sql);
    },
    listContainers: async () => [],
    countObjects: async () => ({ [listed.id]: { count: 1 } }),
    listObjects: async (container: readonly string[], kind: string) =>
      kind === listed.id ? [{ path: [...container, "orders"], name: "orders", kind }] : [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  const availability = workflowAvailability("agent", workflowType, connection.type);
  if (!availability.open) throw new Error(`${workflowType} does not open on the double`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-composed-catalog-"));
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

/** A grounding catalog read on the double, with `queryReadOnly` answering through `answer`, and what it sent. */
async function readCatalogOnce(answer: (sql: string, attempt: number) => QueryResult) {
  const sent: string[] = [];
  const outcome = await readCatalogForGrounding(
    {
      runId: "run_composed",
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
      acquireProvider: async () =>
        ({
          queryReadOnly: async (sql: string): Promise<QueryResult> => {
            sent.push(sql);
            return answer(sql, sent.length);
          },
        }) as unknown as DatabaseProvider,
    },
    { kind: "columns" },
  );
  return { outcome, sent };
}

/** The refusal the policy pipeline gives a statement the fence refused, before anything is sent. */
const FENCE_REFUSAL = { class: "policy-denied", reasonCode: "INPUT_VALIDATION_FAILED" };

describe("an engine whose catalog read is a composed command", () => {
  test("an investigation reads the composed command's catalog as the mapper's rows, and sends its own statement", async () => {
    declaresCommand = true;
    const { events, sent } = await drive("investigation", [
      callsTool("inspect_schema", { kind: "columns" }, "call_1"),
      callsTool("run_read_query", { sql: "SELECT count(*) FROM orders", rationale: "count them" }, "call_2"),
    ]);
    expect(sent).toEqual([ENGINE_CATALOG, "SELECT count(*) FROM orders"]);
    const completed = events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact] : []));
    expect(completed.map((artifact) => artifact.operationId)).toEqual(["sql.query.read", "sql.query.read"]);
    expect(completed[0]?.summary).toMatchObject({
      rowCount: 2,
      columnNames: ["table_name", "column_name", "data_type"],
    });
  });

  test("the identical command written by the model is refused before it is sent, as it always was", async () => {
    declaresCommand = true;
    const { events, sent } = await drive("investigation", [
      callsTool("run_read_query", { sql: ENGINE_CATALOG, rationale: "list the columns" }, "call_1"),
    ]);
    expect(sent).toEqual([]);
    const refused = events.flatMap((event) => (event.kind === "tool-refused" ? [event.refusal] : []));
    expect(refused).toEqual([expect.objectContaining(FENCE_REFUSAL)]);
  });

  test("the model's refused copy of the command does not block the composed catalog read, and stays refused itself", async () => {
    declaresCommand = true;
    const { events, sent } = await drive("investigation", [
      callsTool("run_read_query", { sql: ENGINE_CATALOG, rationale: "list the columns" }, "call_1"),
      callsTool("inspect_schema", { kind: "columns" }, "call_2"),
      // The same statement in the ledger's eyes, though not the same step: a trailing terminator is no new statement.
      callsTool("run_read_query", { sql: `${ENGINE_CATALOG};`, rationale: "list them again" }, "call_3"),
    ]);
    expect(sent).toEqual([ENGINE_CATALOG]);
    const completed = events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact] : []));
    expect(completed.map((artifact) => artifact.summary)).toEqual([
      expect.objectContaining({ rowCount: 2, columnNames: ["table_name", "column_name", "data_type"] }),
    ]);
    const refused = events.flatMap((event) => (event.kind === "tool-refused" ? [event.refusal] : []));
    expect(refused).toEqual([
      expect.objectContaining(FENCE_REFUSAL),
      expect.objectContaining({ class: "not-sent", reasonCode: "STATEMENT_ALREADY_FAILED" }),
    ]);
  });

  test.each([
    ["altered by one character", (sql: string) => sql.replace("orders", "orderz")],
    ["with a second statement appended", (sql: string) => `${sql}; SHOW TABLES`],
  ])("a retry that sends the composed command %s is refused before it is sent", async (_label, rewrite) => {
    declaresCommand = true;
    rewriteTo = rewrite;
    const { outcome, sent } = await readCatalogOnce((sql, attempt) => {
      if (attempt === 1) throw new QueryError(RETRY_MESSAGE, "duckdb", sql);
      return engineAnswer(sql);
    });
    rewriteTo = (sql) => sql;
    expect(sent).toEqual([ENGINE_CATALOG]);
    if (outcome.kind !== "refused") throw new Error(`expected the retry refused, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject(FENCE_REFUSAL);
  });

  test("an overlay that does not declare its catalog read a command gets the ordinary refusal", async () => {
    declaresCommand = false;
    const { outcome, sent } = await readCatalogOnce(engineAnswer);
    declaresCommand = true;
    expect(sent).toEqual([]);
    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject(FENCE_REFUSAL);
  });

  test("the declared overlay's grounding read is admitted and mapped", async () => {
    declaresCommand = true;
    const { outcome, sent } = await readCatalogOnce(engineAnswer);
    expect(sent).toEqual([ENGINE_CATALOG]);
    if (outcome.kind !== "completed") throw new Error(`expected a completed read, got ${outcome.kind}`);
    expect(outcome.artifact.summary).toMatchObject({
      rowCount: 2,
      columnNames: ["table_name", "column_name", "data_type"],
    });
  });
});
