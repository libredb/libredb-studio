/**
 * The behaviour-neutral oracle of the agent's SQL surface: per (mode, workflow, SQL engine), the first request the
 * model is sent (its system prompt, every message after it, and the tool list with each tool's JSON schema as the SDK
 * sends it), the prompted-protocol contract, the classifier prompt, and the verifier's verdict over a fixed set of runs.
 *
 * `golden-sql-agent-surface.json` beside this file is this module's output on the commit before the statement-language
 * layer existed, and `tests/isolated/agent-sql-surface-golden.test.ts` holds today's output to it byte for byte. A
 * change that means to move an answer regenerates the file from the base it starts from, with that base's code, and
 * commits it on its own first:
 *
 *   bun tests/fixtures/agent/sql-surface/golden-sql-agent-surface.ts > tests/fixtures/agent/sql-surface/golden-sql-agent-surface.json
 *
 * Every provider is built unconnected through the real factory (`tests/helpers/census-connection.ts`) and only its
 * declarations are read; the drive reads through a double. That factory is why the test that reads this runs under
 * `tests/isolated/`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { runInvestigation } from "@/lib/agent/investigation";
import { promptedToolContract } from "@/lib/agent/prompted-tools";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import { selectAgentTools } from "@/lib/agent/tools";
import type { AgentRunEvent, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { classifyAgentWorkflow } from "@/lib/agent/workflow-classifier";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { answersProse, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

const MODES: readonly AgentRunMode[] = ["planning", "agent"];
const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

/**
 * The five SQL engines `AGENT_EXECUTION_ENGINES` named on the base commit, frozen here rather than imported: that
 * constant gains engines that are not SQL, and the oracle has to keep reading exactly these five.
 */
const ENGINES: readonly DatabaseType[] = ["postgres", "sqlite", "duckdb", "mssql", "mysql"];

const OBJECTIVE = "Which customers ordered most last month?";

/**
 * The drive's clock, fixed. The packed inventory states the epoch it was read at, so a wall clock would make every
 * generation differ from the last.
 */
const clock = (): number => 10_000;

/**
 * What one drive's first model request carried, as sent.
 *
 * `system` is lifted out for reading, but it is not the whole prompt: in agent mode it is the same for every engine,
 * and the engine's own words (the packed inventory and relations, the operations and planning notes, the schema
 * statistics, an ungrounded note, the prompted contract) go out as `user` messages. So `messages` is recorded in full,
 * and `request` holds every other field of the body (the model, the tool choice, the sampling settings) beside it.
 */
interface SurfaceEntry {
  readonly mode: AgentRunMode;
  readonly workflowType: AgentRunWorkflowType;
  readonly engine: DatabaseType;
  readonly system: string;
  readonly messages: unknown;
  readonly tools?: unknown;
  readonly request: Readonly<Record<string, unknown>>;
}

/**
 * Drives one run until its first model turn and returns that turn's body.
 *
 * The provider is built only for its declarations and is never connected; the drive reads through a double that
 * answers every read empty and lists one object of the engine's first declared kind, as the plan-mode drive in
 * `tests/unit/lib/agent/investigation.test.ts` builds it. The run id is literal so that nothing random reaches a prompt,
 * and distinct per drive because the store refuses to reopen a run id this process has closed.
 */
async function driveFirstTurn(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
): Promise<Record<string, unknown>> {
  forgetHeldSnapshots();
  const connection = CENSUS_CONNECTION[engine];
  const declared = await createDatabaseProvider(connection);
  const capabilities = declared.getCapabilities();
  const labels = declared.getLabels();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error(`${engine} declares no object kind to list`);
  const provider = {
    queryReadOnly: async (): Promise<QueryResult> => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }),
    listContainers: async () => [],
    countObjects: async () => ({ [listed.id]: { count: 1 } }),
    listObjects: async (_container: readonly string[], kind: string) =>
      kind === listed.id ? [{ path: ["app"], name: "app", kind }] : [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sql-surface-"));
  try {
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
    const service = new AgentRunService({ store, resources: { tracker, artifacts } });
    const run = await service.start({
      runId: `run_golden_${mode}_${workflowType.replaceAll("-", "_")}_${engine}`,
      mode,
      workflowType,
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
        acquireProvider: async () => provider,
        clock,
      },
    });

    const [first] = script.turns;
    if (!first) throw new Error(`${mode}/${workflowType}/${engine} sent the model nothing`);
    return first.body;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function surfaceOf(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
): Promise<SurfaceEntry> {
  const body = await driveFirstTurn(mode, workflowType, engine);
  const { messages, tools, ...request } = body;
  const system = ((messages ?? []) as { role?: unknown; content?: unknown }[]).find(
    (message) => message.role === "system",
  )?.content;
  if (typeof system !== "string") throw new Error(`${mode}/${workflowType}/${engine} sent no system message`);
  return { mode, workflowType, engine, system, messages, ...(tools === undefined ? {} : { tools }), request };
}

/**
 * A chat-wire endpoint, because the request this records is read as Chat Completions `messages`; the `openai` kind
 * sends the Responses API's `input` instead. Only the system prompt is recorded, so which kind carries it does not
 * reach the golden.
 */
const CLASSIFIER_ENV = {
  LLM_PROVIDER: "custom",
  LLM_API_KEY: "sk-test",
  LLM_MODEL: "gpt-4o-mini",
  LLM_API_URL: "https://llm.internal/v1",
} as const;

/** Model keys cleared for the call rather than set: only the openai provider may carry an effort. */
const CLASSIFIER_ENV_CLEARED = ["LLM_MODEL_EFFORT"] as const;

/**
 * The system prompt the workflow classifier sends, read off a transport that records the request and then fails.
 *
 * The classification itself comes back `unclassified`, which is not what is recorded: only the prompt is. The model
 * keys are saved and put back exactly as `tests/helpers/agent-model-env.ts` does, because bun loads a
 * checkout's `.env` and a developer's real key must neither leak into this nor be lost by it.
 */
async function classifierPrompt(): Promise<string> {
  const saved = new Map(
    [...Object.keys(CLASSIFIER_ENV), ...CLASSIFIER_ENV_CLEARED].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, CLASSIFIER_ENV);
  for (const key of CLASSIFIER_ENV_CLEARED) delete process.env[key];
  let sent: { role?: unknown; content?: unknown }[] | undefined;
  try {
    await classifyAgentWorkflow("Which customers ordered most?", {
      fetch: async (_input, init) => {
        sent = JSON.parse(String(init?.body)).messages;
        throw new TypeError("the golden classifier transport records and refuses");
      },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const system = sent?.find((message) => message.role === "system")?.content;
  if (typeof system !== "string") throw new Error("the classifier sent no system message");
  return system;
}

// ─── verdicts ───────────────────────────────────────────────────────────────

const artifact = (correlationId: string, operationId: string, rowCount: number) => ({
  correlationId,
  runId: "run_g",
  operationId,
  summary: { rowCount, columnNames: ["n"], elapsedMs: 3 },
});
const completed = (stepId: string, a: ReturnType<typeof artifact>): AgentRunEvent => ({
  kind: "tool-completed",
  atMs: 2,
  stepId,
  artifact: a,
});
const cite = (correlationId: string) => ({ source: "artifact" as const, correlationId });
const report = (first: string, ...rest: string[]): AgentRunEvent => ({
  kind: "report-composed",
  atMs: 9,
  claims: [{ claim: "c", evidence: [cite(first), ...rest.map(cite)] }],
});

const READ = "sql.query.read";
const PLAN = "sql.explain.estimate";
const emptyRead = artifact("cid_empty", READ, 0);
const filledRead = artifact("cid_rows", READ, 4);
const planBefore = artifact("cid_plan_a", PLAN, 2);
const planAfter = artifact("cid_plan_b", PLAN, 1);
const answer = artifact("cid_answer", READ, 4);

const planSummary = { access: "full-scan" as const, estimatedRows: 100, estimatedCost: 12.5 };

/** One run per shape the agent-mode verifiers distinguish, every field literal. */
const AGENT_RUNS: Readonly<Record<string, readonly AgentRunEvent[]>> = {
  "no report": [completed("step_1", filledRead)],
  "report citing an empty read": [completed("step_1", emptyRead), report("cid_empty")],
  "report citing a non-empty read": [completed("step_1", filledRead), report("cid_rows")],
  "one plan then report": [completed("step_1", planBefore), report("cid_plan_a")],
  "plan comparison then report": [
    completed("step_1", planBefore),
    completed("step_2", planAfter),
    {
      kind: "plan-comparison",
      atMs: 5,
      before: { correlationId: "cid_plan_a", sql: "SELECT n FROM t", summary: planSummary },
      after: { correlationId: "cid_plan_b", sql: "SELECT n FROM t WHERE n = 1", summary: { access: "index" } },
    },
    report("cid_plan_a", "cid_plan_b"),
  ],
  "index recommendation citing a plan then report": [
    completed("step_1", planBefore),
    {
      kind: "recommendation",
      atMs: 6,
      change: "index",
      statement: "CREATE INDEX t_n ON t (n)",
      rationale: "The plan reads t end to end.",
      evidence: [{ source: "artifact", correlationId: "cid_plan_a" }],
    },
    report("cid_plan_a"),
  ],
  "table profiled then report": [
    completed("step_1", filledRead),
    {
      kind: "table-profiled",
      atMs: 4,
      artifact: filledRead,
      profile: {
        table: "t",
        depth: "basic",
        rowCount: 4,
        columns: [{ column: "n", present: 4 }],
        findings: [],
      },
    },
    report("cid_rows"),
  ],
  "answer composed and cited": [
    completed("step_1", answer),
    {
      kind: "answer-composed",
      atMs: 7,
      sql: "SELECT n FROM t",
      artifact: answer,
      presentation: { kind: "table" },
      handover: "none",
    },
    report("cid_answer"),
  ],
  "answer composed not cited": [
    completed("step_1", filledRead),
    completed("step_2", answer),
    {
      kind: "answer-composed",
      atMs: 7,
      sql: "SELECT n FROM t",
      artifact: answer,
      presentation: { kind: "table" },
      handover: "none",
    },
    report("cid_rows"),
  ],
  "operations reading cited": [completed("step_1", artifact("cid_ops", READ, 2)), report("cid_ops")],
};

/** The two shapes the planning verifier distinguishes. */
const PLANNING_RUNS: Readonly<Record<string, readonly AgentRunEvent[]>> = {
  "planning closing statement only": [{ kind: "closing-statement", atMs: 8, text: "Read the orders table first." }],
  "planning with a drafted plan statement": [
    {
      kind: "plan-statement-drafted",
      atMs: 7,
      sql: "SELECT n FROM t",
      dialect: "postgres",
      language: "sql",
      readOnly: true,
      guardApplicable: true,
      identifiers: { kind: "checked", unknownTables: [] },
    },
    { kind: "closing-statement", atMs: 8, text: "```postgres\nSELECT n FROM t\n```" },
  ],
};

function verdicts(mode: AgentRunMode, runs: Readonly<Record<string, readonly AgentRunEvent[]>>) {
  return Object.fromEntries(
    WORKFLOWS.map((workflowType) => [
      workflowType,
      Object.fromEntries(
        Object.entries(runs).map(([name, events]) => [
          name,
          verifyRunGoal({ mode, workflowType, status: "succeeded", events }),
        ]),
      ),
    ]),
  );
}

/** The oracle's text: one JSON object, two spaces of indentation, and a final newline. */
export async function goldenSqlAgentSurface(): Promise<string> {
  const { log, info, debug } = console;
  // The factory logs one line per provider it builds and the drive logs one per run it ends, both to stdout, and the
  // command-line form writes the oracle to stdout.
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;
  try {
    const surfaces: SurfaceEntry[] = [];
    // One drive at a time: each starts from a cold snapshot cache, which is process state a parallel drive would share.
    for (const mode of MODES) {
      for (const workflowType of WORKFLOWS) {
        for (const engine of ENGINES) surfaces.push(await surfaceOf(mode, workflowType, engine));
      }
    }
    const prompted = MODES.flatMap((mode) =>
      WORKFLOWS.map((workflowType) => ({
        mode,
        workflowType,
        contract: promptedToolContract(selectAgentTools({ mode, workflowType })),
      })),
    );
    const result = {
      surfaces,
      prompted,
      classifier: await classifierPrompt(),
      verdicts: { agent: verdicts("agent", AGENT_RUNS), planning: verdicts("planning", PLANNING_RUNS) },
    };
    return `${JSON.stringify(result, null, 2)}\n`;
  } finally {
    Object.assign(console, { log, info, debug });
  }
}

if (import.meta.main) process.stdout.write(await goldenSqlAgentSurface());
