import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import { createDatabaseProvider } from "@/lib/db/factory";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { createLocalWorld } from "@workflow/world-local";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { answersProse, callsTool, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * The statement workflows on Elasticsearch, driven through the real run loop, the real Elasticsearch overlay and the
 * real catalog read: investigation, data analysis and database assessment open, read the catalog through the composed
 * `SYS COLUMNS` command as mapped column rows, and send the model's own statement through `queryReadOnly`. Query
 * optimization stays closed, because Elasticsearch composes no estimating plan. The engine's catalog answer is the one
 * 9.1.4 gave (tests/fixtures/elasticsearch/9.1.4/catalog-read/columns.json).
 */

const CATALOG_CAPTURE = path.posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "../../../fixtures/elasticsearch/9.1.4/catalog-read/columns.json",
);

/** The engine's `SYS COLUMNS` answer as the provider hands it on. */
function capturedCatalog(): QueryResult {
  const capture = JSON.parse(fs.readFileSync(CATALOG_CAPTURE, "utf8")) as { body: string };
  const answer = JSON.parse(capture.body) as { columns: { name: string }[]; rows: unknown[][] };
  const fields = answer.columns.map((column) => column.name);
  const rows = answer.rows.map((row) => Object.fromEntries(fields.map((field, i) => [field, row[i]])));
  return { rows, fields, rowCount: rows.length, executionTime: 1 };
}

const CATALOG = capturedCatalog();
const MODEL_READ = "SELECT customer, COUNT(*) AS n FROM probe_orders GROUP BY customer";

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const connection = CENSUS_CONNECTION.elasticsearch;

/** One agent-mode drive of `turns` on Elasticsearch, and every statement it sent through `queryReadOnly`. */
async function drive(
  workflowType: AgentRunWorkflowType,
  turns: readonly ReturnType<typeof callsTool>[],
): Promise<{ readonly events: readonly AgentRunEvent[]; readonly sent: readonly string[] }> {
  forgetHeldSnapshots();
  const declared = await createDatabaseProvider(connection);
  const capabilities = declared.getCapabilities();
  const sent: string[] = [];
  const provider = {
    queryReadOnly: async (sql: string): Promise<QueryResult> => {
      sent.push(sql);
      return sql === "SYS COLUMNS"
        ? structuredClone(CATALOG)
        : { rows: [{ customer: "acme", n: 2 }], fields: ["customer", "n"], rowCount: 1, executionTime: 1 };
    },
    listContainers: async () => [],
    countObjects: async () => ({}),
    listObjects: async () => [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  const availability = workflowAvailability("agent", workflowType, connection.type);
  if (!availability.open) throw new Error(`${workflowType} does not open on Elasticsearch`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-elasticsearch-catalog-"));
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

describe("the statement workflows on Elasticsearch", () => {
  test.each(["investigation", "data-analysis", "database-assessment"] as const)(
    "%s opens, reads the catalog through the composed command as column rows, and sends the model's statement",
    async (workflow) => {
      const { events, sent } = await drive(workflow, [
        callsTool("inspect_schema", { kind: "columns" }, "call_1"),
        callsTool("run_read_query", { sql: MODEL_READ, rationale: "count the orders per customer" }, "call_2"),
      ]);
      expect(sent).toEqual(["SYS COLUMNS", MODEL_READ]);
      const completed = events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact] : []));
      expect(completed.map((artifact) => artifact.operationId)).toEqual(["sql.query.read", "sql.query.read"]);
      expect(completed[0]?.summary).toMatchObject({
        rowCount: CATALOG.rowCount,
        columnNames: ["table_name", "column_name", "data_type", "is_nullable", "ordinal_position"],
      });
    },
  );

  test("query optimization stays closed: Elasticsearch composes no estimating plan", () => {
    expect(workflowAvailability("agent", "query-optimization", connection.type)).toMatchObject({
      open: false,
      cause: "requirement-unmet",
    });
  });

  test("the composed command written by the model is refused before it is sent", async () => {
    const { events, sent } = await drive("investigation", [
      callsTool("run_read_query", { sql: "SYS COLUMNS", rationale: "list the columns" }, "call_1"),
    ]);
    expect(sent).toEqual([]);
    const refused = events.flatMap((event) => (event.kind === "tool-refused" ? [event.refusal] : []));
    expect(refused).toEqual([
      expect.objectContaining({ class: "policy-denied", reasonCode: "INPUT_VALIDATION_FAILED" }),
    ]);
  });

  test("a kind the engine cannot answer is refused with nothing sent", async () => {
    const { events, sent } = await drive("investigation", [
      callsTool("inspect_schema", { kind: "relations" }, "call_1"),
    ]);
    expect(sent).toEqual([]);
    expect(events.some((event) => event.kind === "tool-completed")).toBe(false);
  });
});
