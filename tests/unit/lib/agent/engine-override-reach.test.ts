import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseType, QueryResult } from "@/lib/types";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";

/**
 * An engine overlay's override reaches every consumer of the member it overrides (#1821).
 *
 * No shipped overlay overrides anything yet, so this file substitutes DuckDB's engine module with one that overrides
 * each member in `ENGINE_OVERRIDABLE_SERVER_MEMBERS`, and reads each through the consumer that spends it: the run
 * resolver, the planning prompt (`planningRules`), the agent prompt (`workflowToolRules`) and `present_answer`'s
 * refusal (`answerNotADataRead`). PostgreSQL, and a DuckDB run whose record persists another family, read the family
 * pack untouched.
 *
 * `mock.module` is process-wide, so the substitution is made before anything that reaches the engine registry is
 * loaded: every such module is imported dynamically below it, and the runner gives this file its own process.
 */

const PLANNING_RULE = "Name every DuckDB table by its schema.";
const TOOL_RULE = "Call inspect_schema before any DuckDB read.";
const NOT_A_DATA_READ = "That DuckDB artifact is not a read of data.";

// Captured as a plain object before the substitution: the namespace itself follows the replacement.
const REAL_DUCKDB = { ...DUCKDB };
mock.module("@/lib/agent/languages/sql/engines/duckdb", () => ({
  ...REAL_DUCKDB,
  DUCKDB_SERVER_OVERLAY: {
    ...REAL_DUCKDB.DUCKDB_SERVER_OVERLAY,
    grounding: (base: { readonly planningRules?: readonly string[] }) => ({ ...base, planningRules: [PLANNING_RULE] }),
    workflowToolRules: (base: Readonly<Record<string, string>>) => ({ ...base, investigation: TOOL_RULE }),
    answerNotADataRead: NOT_A_DATA_READ,
  },
}));

const { persistedRunFacts, workflowAvailability } = await import("@/lib/agent/agent-manifest");
const { forgetHeldSnapshots } = await import("@/lib/agent/context-snapshot");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { runInvestigation } = await import("@/lib/agent/investigation");
const { agentEnginePack } = await import("@/lib/agent/languages/engines/index");
const { runServerPack } = await import("@/lib/agent/languages/engines/server");
const { MONGO_SERVER_PACK } = await import("@/lib/agent/languages/mongo/server");
const { SQL_SERVER_PACK } = await import("@/lib/agent/languages/sql/server");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { AgentRunService } = await import("@/lib/agent/run-service");
const { AgentRunStore } = await import("@/lib/agent/run-store");
const { presentAnswerTool } = await import("@/lib/agent/tools");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry } = await import("@/lib/db/operations/descriptors");
const { createTargetScope } = await import("@/lib/db/operations/policy");
const { createDatabaseProvider } = await import("@/lib/db/factory");
const { createLocalWorld } = await import("@workflow/world-local");
const { CENSUS_CONNECTION } = await import("../../../helpers/census-connection");
const { answersProse, modelOver, scriptedModel } = await import("../../../isolated/fixtures/agent-scripted-model");

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A provider that answers every read empty and lists one object of `listedKind`, so a planning run is grounded. */
function providerDouble(listedKind: string): DatabaseProvider {
  return {
    queryReadOnly: async (): Promise<QueryResult> => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }),
    listContainers: async () => [],
    countObjects: async () => ({ [listedKind]: { count: 1 } }),
    listObjects: async (_container: readonly string[], kind: string) =>
      kind === listedKind ? [{ path: ["app"], name: "app", kind }] : [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
}

/** The system prompt of the first model request a run of `workflowType` in `mode` on `engine` sends. */
async function systemPromptOf(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
): Promise<string> {
  forgetHeldSnapshots();
  const connection = CENSUS_CONNECTION[engine];
  const declared = await createDatabaseProvider(connection);
  const capabilities = declared.getCapabilities();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error(`${engine} declares no object kind to list`);
  const availability = workflowAvailability(mode, workflowType, engine);
  if (!availability.open) throw new Error(`${mode}/${workflowType}/${engine} does not open`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-override-reach-"));
  dataDirs.push(dataDir);
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const run = await service.start({
    mode,
    workflowType,
    ...persistedRunFacts(mode, workflowType, engine, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "Which customers ordered most?",
  });
  const script = scriptedModel(answersProse("Done."), answersProse("Done."));
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
      acquireProvider: async () => providerDouble(listed.id),
    },
  });
  const [first] = script.turns;
  if (!first) throw new Error(`${mode}/${workflowType}/${engine} sent the model nothing`);
  const system = ((first.body.messages ?? []) as { role?: unknown; content?: unknown }[]).find(
    (message) => message.role === "system",
  )?.content;
  if (typeof system !== "string") throw new Error(`${mode}/${workflowType}/${engine} sent no system message`);
  return system;
}

/** What `present_answer` says on `engine` when a run cites its estimating plan as the answer. */
function notADataReadOn(engine: DatabaseType): string | undefined {
  const connection = CENSUS_CONNECTION[engine];
  const answer = presentAnswerTool(
    {
      runId: "run_reach",
      modelId: "gpt-4o-mini",
      mode: "agent",
      workflowType: "data-analysis",
      actor: { sessionId: "sess_1", role: "user" },
      connection,
      capabilities: { queryLanguage: "sql" } as never,
      labels: {} as never,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS["data-analysis"].runDeadlineMs, () => 10_000),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => {
        throw new Error("an answer reaches no database");
      },
    },
    {
      runId: "run_reach",
      autoExecute: false,
      events: [
        {
          kind: "tool-completed",
          atMs: 2,
          stepId: "step_1",
          artifact: {
            correlationId: "cid_plan",
            runId: "run_reach",
            operationId: "sql.explain.estimate",
            summary: { rowCount: 2, columnNames: ["plan"], elapsedMs: 3 },
          },
        },
      ],
    },
    { artifact: "cid_plan", presentation: { kind: "table" } },
  );
  expect(answer).toMatchObject({ kind: "unavailable", reasonCode: "ANSWER_NOT_A_DATA_READ" });
  return answer.modelText;
}

describe("an engine overlay's override", () => {
  test("is what the run resolver answers on that engine, for every overridable member", () => {
    const duckdb = runServerPack(undefined, "duckdb");
    expect(duckdb.grounding.planningRules).toEqual([PLANNING_RULE]);
    expect(duckdb.grounding.omissionAdvice).toBe(SQL_SERVER_PACK.grounding.omissionAdvice);
    expect(duckdb.workflowToolRules.investigation).toBe(TOOL_RULE);
    expect(duckdb.workflowToolRules.operations).toBe(SQL_SERVER_PACK.workflowToolRules.operations);
    expect(duckdb.answerNotADataRead).toBe(NOT_A_DATA_READ);
    expect(duckdb.adapter).toBe(SQL_SERVER_PACK.adapter);
    expect(duckdb.dialect).toBe(REAL_DUCKDB.DUCKDB_SERVER_OVERLAY.dialect);
  });

  test("is derived once, so every read of the engine's facet is the one the engine pack holds", () => {
    // A derived member is a new object each time its function runs, so a facet derived on every read would be a
    // different object on every run and never the engine pack's own.
    expect(runServerPack(undefined, "duckdb")).toBe(runServerPack("sql", "duckdb"));
    expect(runServerPack(undefined, "duckdb")).toBe(agentEnginePack("duckdb").server);
  });

  test("reaches no other engine, and no run whose record persists another family", () => {
    const postgres = runServerPack(undefined, "postgres");
    expect(postgres.grounding).toBe(SQL_SERVER_PACK.grounding);
    expect(postgres.workflowToolRules).toBe(SQL_SERVER_PACK.workflowToolRules);
    expect(postgres.answerNotADataRead).toBe(SQL_SERVER_PACK.answerNotADataRead);
    expect(runServerPack("mongo", "duckdb")).toBe(MONGO_SERVER_PACK);
  });

  test("reaches a plan-mode draft's statement contract through the planning rules", async () => {
    expect(await systemPromptOf("planning", "query-optimization", "duckdb")).toContain(PLANNING_RULE);
    expect(await systemPromptOf("planning", "query-optimization", "postgres")).not.toContain(PLANNING_RULE);
  }, 60_000);

  test("reaches an agent-mode run's tool rules", async () => {
    expect(await systemPromptOf("agent", "investigation", "duckdb")).toContain(TOOL_RULE);
    expect(await systemPromptOf("agent", "investigation", "postgres")).not.toContain(TOOL_RULE);
  }, 60_000);

  test("reaches present_answer's refusal of an artifact that is no read of data", () => {
    expect(notADataReadOn("duckdb")).toStartWith(NOT_A_DATA_READ);
    expect(notADataReadOn("postgres")).toStartWith(SQL_SERVER_PACK.answerNotADataRead);
  });
});
