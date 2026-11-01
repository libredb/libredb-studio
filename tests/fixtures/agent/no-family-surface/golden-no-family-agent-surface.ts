/**
 * The behaviour-neutral oracle of the agent's surface on an engine with no statement family, the companion of
 * `golden-sql-agent-surface.ts` and `golden-language-agent-surface.ts`.
 *
 * Such an engine maps to null in `AGENT_STATEMENT_LANGUAGE`, so a run on it persists no `statementLanguage` and still
 * opens: the operations workflow in agent mode, and every workflow in planning mode. What it reads then is recorded
 * here, per engine: the first request the model is sent for an agent-mode operations run and for a plan of the
 * operations and query-optimization workflows (system prompt, every message, every tool's JSON schema as the SDK
 * sends it), the facts the run persisted, and the denial a curated `inspect_operations` reading is given.
 *
 * `golden-no-family-agent-surface.json` beside this file is this module's output on the commit before the run
 * resolver existed, and `tests/isolated/agent-no-family-surface-golden.test.ts` holds today's output to it byte for
 * byte. A change that means to move an answer regenerates the file from the base it starts from, with that base's
 * code, and commits it on its own first:
 *
 *   bun tests/fixtures/agent/no-family-surface/golden-no-family-agent-surface.ts > tests/fixtures/agent/no-family-surface/golden-no-family-agent-surface.json
 *
 * Every provider is built unconnected through the real factory (`tests/helpers/census-connection.ts`) and only its
 * declarations are read; the drive reads through a double. That factory is why the test that reads this runs under
 * `tests/isolated/`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import { inspectOperationsTool } from "@/lib/agent/tools";
import type { AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { answersProse, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * The engine with no statement family on the base commit, frozen here rather than read from `AGENT_STATEMENT_LANGUAGE`,
 * which gains families. It is Spark, a SQL engine whose dialect has no agent language, because it has no read-only
 * boundary to join a family on; Oracle held the place until it joined. No non-SQL engine is left without a family:
 * Sparkplug held the non-SQL place until it joined the last of them, and Redis before it, so the golden holds Spark
 * alone.
 */
const ENGINES: readonly DatabaseType[] = ["spark"];

/** The (mode, workflow) pairs recorded per engine: every agent-mode run such an engine opens, and two plans. */
const CASES: readonly { readonly mode: AgentRunMode; readonly workflowType: AgentRunWorkflowType }[] = [
  { mode: "agent", workflowType: "operations" },
  { mode: "planning", workflowType: "operations" },
  { mode: "planning", workflowType: "query-optimization" },
];

const OBJECTIVE = "Which sessions are holding locks right now?";

/** The drive's clock, fixed, so the packed inventory's epoch is the same on every generation. */
const clock = (): number => 10_000;

/** The engine's provider, built unconnected, for its declarations alone. */
async function declarationsOf(engine: DatabaseType) {
  const declared = await createDatabaseProvider(CENSUS_CONNECTION[engine]);
  const capabilities = declared.getCapabilities();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error(`${engine} declares no object kind to list`);
  return { capabilities, labels: declared.getLabels(), listedKind: listed.id };
}

/**
 * A provider that answers every read empty and lists one object of the engine's first declared kind, as the SQL
 * oracle's drive builds one.
 */
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

/**
 * What one drive's first model request carried, as sent, beside the facts its run persisted: `system` lifted out
 * for reading, `messages` in full, and `request` holding every other field of the body, as the SQL oracle records it.
 */
interface SurfaceEntry {
  readonly mode: AgentRunMode;
  readonly workflowType: AgentRunWorkflowType;
  readonly engine: DatabaseType;
  readonly persisted: Readonly<Record<string, unknown>>;
  readonly system: string;
  readonly messages: unknown;
  readonly tools?: unknown;
  readonly request: Readonly<Record<string, unknown>>;
}

/**
 * One run, opened as the start route opens it, driven until its first model turn. The run id is literal so that
 * nothing random reaches a prompt, and distinct per drive because the store refuses to reopen a run id this process
 * has closed.
 */
async function surfaceOf(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
): Promise<SurfaceEntry> {
  const what = `${mode}/${workflowType}/${engine}`;
  forgetHeldSnapshots();
  const connection = CENSUS_CONNECTION[engine];
  const { capabilities, labels, listedKind } = await declarationsOf(engine);
  const availability = workflowAvailability(mode, workflowType, engine);
  if (!availability.open) throw new Error(`${what} does not open`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-no-family-surface-"));
  try {
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
    const service = new AgentRunService({ store, resources: { tracker, artifacts } });
    const run = await service.start({
      runId: `run_golden_${mode}_${workflowType.replaceAll("-", "_")}_${engine}`,
      mode,
      workflowType,
      ...persistedRunFacts(mode, workflowType, availability),
      actor: { sessionId: "sess_1", role: "user" },
      connectionId: connection.id,
      objective: OBJECTIVE,
    });
    const script = scriptedModel(answersProse("Done."), answersProse("Done."));

    await runInvestigation(run.runId, {
      service,
      model: await modelOver(script.fetch),
      resources: {
        connection,
        capabilities,
        labels,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(connection.id),
        tracker,
        artifacts,
        deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, clock),
        repairs: new AgentRepairLedger(),
        acquireProvider: async () => providerDouble(listedKind),
        clock,
      },
    });

    const view = await store.read(run.runId);
    if (!view) throw new Error(`run ${run.runId} has no ledger`);
    const persisted = {
      statementLanguage: view.record.statementLanguage ?? null,
      verifier: view.record.verifier ?? null,
    };
    const [first] = script.turns;
    if (!first) throw new Error(`${what} sent the model nothing`);
    const { messages, tools, ...request } = first.body;
    const system = ((messages ?? []) as { role?: unknown; content?: unknown }[]).find(
      (message) => message.role === "system",
    )?.content;
    if (typeof system !== "string") throw new Error(`${what} sent no system message`);
    return {
      mode,
      workflowType,
      engine,
      persisted,
      system,
      messages,
      ...(tools === undefined ? {} : { tools }),
      request,
    };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * The denial a curated `inspect_operations` reading is given on an agent-mode operations run of `engine`, whose
 * context carries no statement language: a table-stats reading narrowed to a schema the run's scope does not hold.
 */
async function curatedDenial(engine: DatabaseType) {
  const connection = CENSUS_CONNECTION[engine];
  const { capabilities, labels, listedKind } = await declarationsOf(engine);
  const outcome = await inspectOperationsTool(
    {
      runId: "run_g",
      modelId: "gpt-4o-mini",
      mode: "agent",
      workflowType: "operations",
      actor: { sessionId: "sess_1", role: "user" },
      connection,
      capabilities,
      labels,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id, { schemas: ["public"] }),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.operations.runDeadlineMs, clock),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => providerDouble(listedKind),
      clock,
    },
    { kind: "table-stats", schema: "secrets" },
  );
  if (outcome.kind !== "refused" || outcome.refusal.class !== "policy-denied") {
    throw new Error(`the curated reading on ${engine} was not denied: ${outcome.kind}`);
  }
  return { reasonCode: outcome.refusal.reasonCode, message: outcome.modelText };
}

/** The oracle's text: one JSON object, two spaces of indentation, and a final newline. */
export async function goldenNoFamilyAgentSurface(): Promise<string> {
  const { log, info, debug, warn } = console;
  // The factory logs one line per provider it builds and the drive logs one per run it ends, both to stdout, and the
  // command-line form writes the oracle to stdout.
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;
  console.warn = () => undefined;
  try {
    const surfaces: SurfaceEntry[] = [];
    const denials: Record<string, unknown> = {};
    // One drive at a time: each starts from a cold snapshot cache, which is process state a parallel drive would share.
    for (const engine of ENGINES) {
      for (const { mode, workflowType } of CASES) surfaces.push(await surfaceOf(mode, workflowType, engine));
      denials[engine] = await curatedDenial(engine);
    }
    return `${JSON.stringify({ surfaces, denials }, null, 2)}\n`;
  } finally {
    Object.assign(console, { log, info, debug, warn });
  }
}

if (import.meta.main) process.stdout.write(await goldenNoFamilyAgentSurface());
