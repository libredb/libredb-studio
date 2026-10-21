/**
 * The behaviour-neutral oracle of the agent's kubectl and MongoDB surface, the companion of
 * `golden-sql-agent-surface.ts`, which holds the SQL engines.
 *
 * Two sections. The surface: per (mode, workflow) a language's variants open on its engine, the first request the
 * model is sent (system prompt, every message, every tool's JSON schema as the SDK sends it), the prompted-protocol
 * contract, the classifier prompt, the posture copy, the auto-execute terms, and the verdicts of the language verifier
 * ids over a fixed set of runs. The pack values: the sentences a run meets only later, or only on one input, each
 * recorded against a fixed input so that it is pinned even where no first turn carries it. These are the shortfall
 * notices and the usage bar a drive speaks, the refusals a tool gives, both recommendation cards, the
 * not-a-data-read refusal, the grounding notes, the shape and row-cap advice, and the workflow rule strings.
 *
 * `golden-language-agent-surface.json` beside this file is this module's output on the commit before the language
 * packs existed, and `tests/isolated/agent-language-surface-golden.test.ts` holds today's output to it byte for byte.
 * A change that means to move an answer regenerates the file from the base it starts from, with that base's code,
 * and commits it on its own first:
 *
 *   bun tests/fixtures/agent/language-surface/golden-language-agent-surface.ts > tests/fixtures/agent/language-surface/golden-language-agent-surface.json
 *
 * Every provider is built unconnected through the real factory (`tests/helpers/census-connection.ts`) and only its
 * declarations are read; every drive and every tool reads through a double, so no driver module is replaced. That
 * factory is why the test that reads this runs under `tests/isolated/`. A correlation id is minted at random, so each
 * one is written as the order it first appeared in, and nothing else in the output varies between generations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AGENT_LANGUAGE_COPY, persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { DATABASE_TOOL_HANDLERS, runInvestigation } from "@/lib/agent/investigation";
import { agentPosture, autoExecuteTerms } from "@/lib/agent/posture";
import { promptedToolContract } from "@/lib/agent/prompted-tools";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import { inspectUsageTool, profileWorkloadsTool } from "@/lib/agent/languages/kubectl/tools";
import { planMongoProfile, runMongoProfile } from "@/lib/agent/languages/mongo/tools";
import { languageServer, WORKFLOW_TOOL_RULES } from "@/lib/agent/languages/server";
import { type AgentToolContext, presentAnswerTool, recommendChangeTool, selectAgentTools } from "@/lib/agent/tools";
import type {
  AgentArtifactReference,
  AgentContextSnapshot,
  AgentInventoryObject,
  AgentRunEvent,
  AgentRunMode,
  AgentRunWorkflowType,
} from "@/lib/agent/types";
import { classifyAgentWorkflow } from "@/lib/agent/workflow-classifier";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { createDatabaseProvider } from "@/lib/db/factory";
import type {
  ClusterUsageReading,
  DatabaseProvider,
  ReadOnlyCatalogReading,
  WorkloadProfileReading,
} from "@/lib/db/types";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import {
  answersProse,
  callsTool,
  correlationIdsIn,
  modelOver,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "../../../isolated/fixtures/agent-scripted-model";

const MODES: readonly AgentRunMode[] = ["planning", "agent"];
const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

/**
 * The two engines whose statement language is not SQL on the base commit, frozen here rather than read from
 * `AGENT_STATEMENT_LANGUAGE`, which gains engines: the oracle has to keep reading exactly these two.
 */
const ENGINES: readonly DatabaseType[] = ["mongodb", "kubernetes"];

/** Each engine's statement language, as the base commit's `AGENT_STATEMENT_LANGUAGE` maps it. */
const LANGUAGE = { mongodb: "mongo", kubernetes: "kubectl" } as const;

/** The SQL engine the pack values compare against where a value is per language. */
const SQL_ENGINE: DatabaseType = "postgres";

const OBJECTIVE = "Which customer placed the larger order?";

/** The drive's clock, fixed, so the packed inventory's epoch is the same on every generation. */
const clock = (): number => 10_000;

// ─── doubles ────────────────────────────────────────────────────────────────

/** What a double answers; every field optional, so a drive states only what its case needs. */
interface DoubleAnswers {
  /** The objects the grounding lists in `app`, of the engine's first declared kind. Defaults to one, `orders`. */
  readonly listed?: readonly string[];
  /** Thrown by the grounding's listing, for a run that cannot be grounded. */
  readonly listingFails?: Error;
  readonly query?: () => Promise<QueryResult>;
  readonly catalog?: () => Promise<ReadOnlyCatalogReading>;
  readonly usage?: () => Promise<ClusterUsageReading>;
  readonly workloads?: () => Promise<WorkloadProfileReading>;
}

const EMPTY_RESULT: QueryResult = { rows: [], fields: [], rowCount: 0, executionTime: 1 };

const ONE_ROW: QueryResult = { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };

/**
 * A provider that answers every read from `answers`, as the plan-mode drive in
 * `tests/unit/lib/agent/investigation.test.ts` builds one: an empty read, and one container holding one listed object of
 * the engine's first declared kind, unless the case says otherwise.
 */
function providerDouble(listedKind: string, answers: DoubleAnswers = {}): DatabaseProvider {
  const listed = answers.listed ?? ["orders"];
  return {
    queryReadOnly: answers.query ?? (async () => EMPTY_RESULT),
    readCatalogReadOnly: answers.catalog ?? (async () => ({ kind: "not-found", container: "app", object: "none" })),
    readClusterUsage: answers.usage ?? (async () => ({ kind: "rows", result: ONE_ROW })),
    readWorkloadProfile: answers.workloads ?? (async () => ({ kind: "rows", result: ONE_ROW })),
    // One container at every level, `app`, the session's own.
    listContainers: async (parent: readonly string[] = []) => [
      { path: [...parent, "app"], name: "app", level: parent.length, isSessionDefault: true },
    ],
    countObjects: async () => ({ [listedKind]: { count: listed.length } }),
    listObjects: async (container: readonly string[], kind: string) => {
      if (answers.listingFails !== undefined) throw answers.listingFails;
      return kind === listedKind ? listed.map((name) => ({ path: [...container, name], name, kind })) : [];
    },
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
}

/** The engine's provider, built unconnected, for its declarations alone. */
async function declarationsOf(engine: DatabaseType) {
  const declared = await createDatabaseProvider(CENSUS_CONNECTION[engine]);
  const capabilities = declared.getCapabilities();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error(`${engine} declares no object kind to list`);
  return { capabilities, labels: declared.getLabels(), listedKind: listed.id };
}

// ─── drives ─────────────────────────────────────────────────────────────────

interface Drive {
  readonly turns: readonly Turn[];
  readonly events: readonly AgentRunEvent[];
}

let drives = 0;

/**
 * One run, opened as the start route opens it (the language and verifier `persistedRunFacts` writes) and driven by
 * `turns` through `runInvestigation` over a double. The run id is literal and distinct per drive, because the store
 * refuses to reopen a run id this process has closed.
 */
async function drive(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
  turns: readonly ScriptedTurn[],
  answers: DoubleAnswers = {},
): Promise<Drive> {
  forgetHeldSnapshots();
  const connection = CENSUS_CONNECTION[engine];
  const { capabilities, labels, listedKind } = await declarationsOf(engine);
  const provider = providerDouble(listedKind, answers);
  const availability = workflowAvailability(mode, workflowType, engine);
  if (!availability.open) throw new Error(`${mode} ${workflowType} does not open on ${engine}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-language-surface-"));
  try {
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
    const service = new AgentRunService({ store, resources: { tracker, artifacts } });
    drives += 1;
    const run = await service.start({
      runId: `run_golden_language_${drives}`,
      mode,
      workflowType,
      ...persistedRunFacts(mode, workflowType, availability),
      actor: { sessionId: "sess_1", role: "user" },
      connectionId: connection.id,
      objective: OBJECTIVE,
    });
    // A model that has said what the case needed and then only answers in prose, for as many turns as the drive
    // asks: running out of turns would be the simulated process death, which no case here is about.
    const script = scriptedModel(...turns, ...Array.from({ length: 8 }, () => answersProse("Done.")));

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

    const view = await store.read(run.runId);
    if (!view) throw new Error(`run ${run.runId} has no ledger`);
    return { turns: script.turns, events: view.record.events };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * What one drive's first model request carried, as sent: `system` lifted out for reading, `messages` in full, and
 * `request` holding every other field of the body beside them, as the SQL oracle records it.
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

function firstRequest(turns: readonly Turn[], what: string): Record<string, unknown> {
  const [first] = turns;
  if (!first) throw new Error(`${what} sent the model nothing`);
  return first.body;
}

async function surfaceOf(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  engine: DatabaseType,
): Promise<SurfaceEntry> {
  const what = `${mode}/${workflowType}/${engine}`;
  const run = await drive(mode, workflowType, engine, []);
  const { messages, tools, ...request } = firstRequest(run.turns, what);
  const system = ((messages ?? []) as { role?: unknown; content?: unknown }[]).find(
    (message) => message.role === "system",
  )?.content;
  if (typeof system !== "string") throw new Error(`${what} sent no system message`);
  return { mode, workflowType, engine, system, messages, ...(tools === undefined ? {} : { tools }), request };
}

/**
 * What a drive said after its first request: the calls it held, with the shortfall each spoke for and what the run was
 * told, and every message it sent after the first request, turn by turn (the tool results, refusals and notices, and
 * the model's own calls between them). Each correlation id is written as its order of first appearance, since the
 * ids are minted at random.
 */
function laterTurns(run: Drive): unknown {
  const held = run.events.flatMap((event) =>
    event.kind === "call-held"
      ? [
          {
            tool: event.tool,
            ...(event.shortfall === undefined ? {} : { shortfall: event.shortfall }),
            reason: event.reason,
          },
        ]
      : [],
  );
  const deliveries = run.turns.slice(1).map((turn, index) => {
    const before = ((run.turns[index]?.body.messages ?? []) as unknown[]).length;
    return ((turn.body.messages ?? []) as unknown[]).slice(before);
  });
  const text = JSON.stringify({ held, deliveries });
  const ids = correlationIdsIn(text);
  return JSON.parse(ids.reduce((written, id, index) => written.replaceAll(id, `<artifact-${index + 1}>`), text));
}

/** The correlation id of the latest artifact the transcript holds, taken from it as a model would take it. */
function latestArtifact(turn: Turn): string {
  const latest = correlationIdsIn(turn.transcript).at(-1);
  if (latest === undefined)
    throw new Error(`no artifact reference in the transcript: ${turn.transcript.slice(0, 400)}`);
  return latest;
}

/** A report whose one claim cites the latest artifact of this run. */
const reportOnLatest =
  (claim: string): ScriptedTurn =>
  (turn) =>
    callsTool(
      "compose_report",
      { claims: [{ claim, evidence: [{ source: "artifact", correlationId: latestArtifact(turn) }] }] },
      "call_report",
    )(turn);

/** A citation of the inventory a run was handed rather than of anything it read. */
const INVENTORY_CITATION = { source: "context-snapshot", fingerprint: "ctx_golden" } as const;

/** A report whose one claim cites nothing this run read: only the inventory. */
const reportOnInventory = (claim: string): ScriptedTurn =>
  callsTool("compose_report", { claims: [{ claim, evidence: [INVENTORY_CITATION] }] }, "call_report");

// ─── the surface ────────────────────────────────────────────────────────────

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
 * The system prompt the workflow classifier sends for one language, read off a transport that records the request
 * and then fails. The model keys are saved and put back as `tests/helpers/agent-model-env.ts` does.
 */
async function classifierPrompt(statementLanguage: "kubectl" | "mongo"): Promise<string> {
  const saved = new Map(
    [...Object.keys(CLASSIFIER_ENV), ...CLASSIFIER_ENV_CLEARED].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, CLASSIFIER_ENV);
  for (const key of CLASSIFIER_ENV_CLEARED) delete process.env[key];
  let sent: { role?: unknown; content?: unknown }[] | undefined;
  try {
    await classifyAgentWorkflow("Which customer placed the larger order?", {
      statementLanguage,
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
  if (typeof system !== "string") throw new Error(`the ${statementLanguage} classifier sent no system message`);
  return system;
}

/** The (mode, workflow) pairs that open on an engine, in the order the loops below walk them. */
function openOn(engine: DatabaseType): { mode: AgentRunMode; workflowType: AgentRunWorkflowType }[] {
  return MODES.flatMap((mode) =>
    WORKFLOWS.flatMap((workflowType) =>
      workflowAvailability(mode, workflowType, engine).open ? [{ mode, workflowType }] : [],
    ),
  );
}

/** The posture copy for each engine, plain and with the hand-over ticked. */
function postures() {
  return Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      {
        reads: agentPosture({ mode: "agent", engine, engineLabel: engine, handover: false }),
        widened: agentPosture({ mode: "agent", engine, engineLabel: engine, handover: true }),
      },
    ]),
  );
}

// ─── verdicts ───────────────────────────────────────────────────────────────

const artifact = (correlationId: string, operationId: string, rowCount: number): AgentArtifactReference => ({
  correlationId,
  runId: "run_g",
  operationId,
  summary: { rowCount, columnNames: ["n"], elapsedMs: 3 },
});
const completed = (stepId: string, a: AgentArtifactReference): AgentRunEvent => ({
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
const inventoryReport: AgentRunEvent = {
  kind: "report-composed",
  atMs: 9,
  claims: [{ claim: "c", evidence: [INVENTORY_CITATION] }],
};

const usage = artifact("cid_usage", "cluster.usage.read", 1);
const emptyUsage = artifact("cid_usage_empty", "cluster.usage.read", 0);
const workloads = artifact("cid_workloads", "cluster.workloads.read", 1);
const emptyWorkloads = artifact("cid_workloads_empty", "cluster.workloads.read", 0);
const kubectlRead = artifact("cid_kubectl", "kubectl.query.read", 2);
const mongoPlan = artifact("cid_mongo_plan", "mongo.plan.estimate", 0);
const mongoRead = artifact("cid_mongo_read", "mongo.query.read", 2);

const usageRead = (a: AgentArtifactReference): AgentRunEvent => ({
  kind: "usage-read",
  atMs: 3,
  artifact: a,
  namespace: "shop",
});
const workloadsProfiled = (a: AgentArtifactReference): AgentRunEvent => ({
  kind: "workloads-profiled",
  atMs: 3,
  artifact: a,
  namespace: "shop",
});
const resources = (first: string, ...rest: string[]): AgentRunEvent => ({
  kind: "recommendation",
  atMs: 6,
  change: "resources",
  namespace: "shop",
  ownerKind: "Deployment",
  ownerName: "web",
  container: "web",
  current: { requests: { cpu: "500m" }, limits: { cpu: "1" } },
  proposed: { requests: { cpu: "150m" }, limits: { cpu: "500m" } },
  rationale: "The web container uses a third of the CPU it requests.",
  evidence: [cite(first), ...rest.map(cite)],
});
const documentIndex = (first: string, ...rest: string[]): AgentRunEvent => ({
  kind: "recommendation",
  atMs: 6,
  change: "document-index",
  collection: "orders",
  database: "app",
  keys: { customer: 1 },
  evidence: [cite(first), ...rest.map(cite)],
});

/** Per language verifier id, the workflow it judges and one run per shape it distinguishes, every field literal. */
const LANGUAGE_RUNS = {
  "agent-query-optimization-kubectl.1": {
    workflowType: "query-optimization",
    statementLanguage: "kubectl",
    runs: {
      "no report": [completed("step_1", usage), usageRead(usage)],
      "report citing the inventory only": [inventoryReport],
      "metrics unavailable then report": [{ kind: "usage-unavailable", atMs: 3, namespace: "shop" }, inventoryReport],
      "usage read, report citing it": [completed("step_1", usage), usageRead(usage), report("cid_usage")],
      "empty usage read, report citing it": [
        completed("step_1", emptyUsage),
        usageRead(emptyUsage),
        report("cid_usage_empty"),
      ],
      "usage read, report citing another read": [
        completed("step_1", usage),
        usageRead(usage),
        completed("step_2", kubectlRead),
        report("cid_kubectl"),
      ],
      "resources recommendation citing the usage read": [
        completed("step_1", usage),
        usageRead(usage),
        resources("cid_usage"),
        report("cid_usage"),
      ],
      "resources recommendation citing another read": [
        completed("step_1", usage),
        usageRead(usage),
        completed("step_2", kubectlRead),
        resources("cid_kubectl"),
        report("cid_usage"),
      ],
    },
  },
  "agent-database-assessment-kubectl.1": {
    workflowType: "database-assessment",
    statementLanguage: "kubectl",
    runs: {
      "no report": [completed("step_1", workloads), workloadsProfiled(workloads)],
      "report citing a read, nothing profiled": [completed("step_1", kubectlRead), report("cid_kubectl")],
      "profile, report citing it": [
        completed("step_1", workloads),
        workloadsProfiled(workloads),
        report("cid_workloads"),
      ],
      "empty profile, report citing it": [
        completed("step_1", emptyWorkloads),
        workloadsProfiled(emptyWorkloads),
        report("cid_workloads_empty"),
      ],
      "profile, report citing another read": [
        completed("step_1", workloads),
        workloadsProfiled(workloads),
        completed("step_2", kubectlRead),
        report("cid_kubectl"),
      ],
    },
  },
  "agent-query-optimization-mongo.1": {
    workflowType: "query-optimization",
    statementLanguage: "mongo",
    runs: {
      "no report": [completed("step_1", mongoPlan)],
      "report citing a read, no plan": [completed("step_1", mongoRead), report("cid_mongo_read")],
      "plan, report citing it": [completed("step_1", mongoPlan), report("cid_mongo_plan")],
      "plan, report citing another read": [
        completed("step_1", mongoPlan),
        completed("step_2", mongoRead),
        report("cid_mongo_read"),
      ],
      "index recommendation citing the plan": [
        completed("step_1", mongoPlan),
        documentIndex("cid_mongo_plan"),
        report("cid_mongo_plan"),
      ],
      "index recommendation citing another read": [
        completed("step_1", mongoPlan),
        completed("step_2", mongoRead),
        documentIndex("cid_mongo_read"),
        report("cid_mongo_plan"),
      ],
    },
  },
} as const satisfies Record<
  string,
  {
    readonly workflowType: AgentRunWorkflowType;
    readonly statementLanguage: "kubectl" | "mongo";
    readonly runs: Readonly<Record<string, readonly AgentRunEvent[]>>;
  }
>;

function verdicts() {
  return Object.fromEntries(
    Object.entries(LANGUAGE_RUNS).map(([verifier, { workflowType, statementLanguage, runs }]) => [
      verifier,
      Object.fromEntries(
        Object.entries(runs).map(([name, events]) => [
          name,
          verifyRunGoal({
            mode: "agent",
            workflowType,
            status: "succeeded",
            events,
            statementLanguage,
            verifier: verifier as keyof typeof LANGUAGE_RUNS,
          }),
        ]),
      ),
    ]),
  );
}

// ─── pack values ────────────────────────────────────────────────────────────

/** A tool context over a double, as `tests/unit/lib/agent/mongo-tools.test.ts` builds one. */
async function toolContext(
  engine: DatabaseType,
  workflowType: AgentRunWorkflowType,
  answers: DoubleAnswers = {},
): Promise<AgentToolContext> {
  const connection = CENSUS_CONNECTION[engine];
  const { capabilities, labels, listedKind } = await declarationsOf(engine);
  const provider = providerDouble(listedKind, answers);
  const language = engine === SQL_ENGINE ? "sql" : LANGUAGE[engine as keyof typeof LANGUAGE];
  return {
    runId: "run_g",
    modelId: "gpt-4o-mini",
    mode: "agent",
    workflowType,
    statementLanguage: language,
    actor: { sessionId: "sess_1", role: "user" },
    connection,
    capabilities,
    labels,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

/** A collection of the `app` database as the grounding walk names it, with `indexes` on it. */
const ordersCollection = (indexes: AgentInventoryObject["indexes"] = []): AgentInventoryObject => ({
  path: ["app", "orders"],
  name: "app.orders",
  kind: "collection",
  columns: [
    { name: "customer", type: "string", nullable: true, isPrimary: false },
    { name: "total", type: "double", nullable: true, isPrimary: false },
  ],
  indexes,
  foreignKeys: [],
});

const captured = (objects: readonly AgentInventoryObject[]): AgentRunEvent => {
  const snapshot: AgentContextSnapshot = {
    connectionId: CENSUS_CONNECTION.mongodb.id,
    fingerprint: "ctx_golden",
    capturedAtMs: 0,
    objects,
    kinds: [{ id: "collection", role: "relation", label: "Collection", labelPlural: "Collections" }],
    defaultContainer: ["app"],
  };
  return { kind: "context-captured", atMs: 0, fingerprint: snapshot.fingerprint, tableCount: objects.length, snapshot };
};

/** Both recommendation cards over a fixed run, and the document-index card refused for an index that exists. */
async function cards() {
  const kubectl = await toolContext("kubernetes", "query-optimization");
  const resourcesCard = recommendChangeTool(
    kubectl,
    { runId: "run_g", events: [completed("step_1", usage), usageRead(usage)] },
    {
      change: "resources",
      namespace: "shop",
      ownerKind: "Deployment",
      ownerName: "web",
      container: "web",
      current: { requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
      proposed: { requests: { cpu: "150m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      rationale: "The web container uses a quarter of the CPU and memory it requests.",
      evidence: [cite("cid_usage")],
    },
  );
  const mongo = await toolContext("mongodb", "query-optimization");
  const card = {
    change: "document-index",
    collection: "orders",
    keys: { customer: 1 },
    rationale: "The plan reads every order to find one customer's: a COLLSCAN.",
    evidence: [cite("cid_mongo_plan")],
  };
  const documentIndexCard = recommendChangeTool(
    mongo,
    { runId: "run_g", events: [captured([ordersCollection()]), completed("step_1", mongoPlan)] },
    card,
  );
  const indexAlreadyExists = recommendChangeTool(
    mongo,
    {
      runId: "run_g",
      events: [
        captured([ordersCollection([{ name: "customer_1", columns: ["customer"], unique: false }])]),
        completed("step_1", mongoPlan),
      ],
    },
    card,
  );
  return { resources: resourcesCard, "document-index": documentIndexCard, "index-already-exists": indexAlreadyExists };
}

/**
 * `present_answer` on a result that is not a data read, per language: a plan on SQL and MongoDB, a usage reading on
 * kubectl, each the only artifact of its run.
 */
async function answerNotADataRead() {
  const cases = [
    { engine: SQL_ENGINE, operationId: "sql.explain.estimate" },
    { engine: "kubernetes" as const, operationId: "cluster.usage.read" },
    { engine: "mongodb" as const, operationId: "mongo.plan.estimate" },
  ];
  const outcomes: Record<string, unknown> = {};
  for (const { engine, operationId } of cases) {
    const context = await toolContext(engine, "data-analysis");
    outcomes[context.statementLanguage ?? "sql"] = presentAnswerTool(
      context,
      {
        runId: "run_g",
        events: [
          { kind: "statement-drafted", atMs: 1, stepId: "step_1", sql: "the statement", rationale: "(none given)" },
          completed("step_1", artifact("cid_not_a_read", operationId, 1)),
        ],
        autoExecute: false,
      },
      { artifact: "cid_not_a_read", presentation: { kind: "table" } },
    );
  }
  return outcomes;
}

/** The catalog refusals a MongoDB `inspect_schema` gives, each over a fixed input. */
async function mongoCatalogRefusals() {
  const inspect = async (input: unknown, answers: DoubleAnswers = {}) =>
    DATABASE_TOOL_HANDLERS.inspect_schema(await toolContext("mongodb", "investigation", answers), input, null);
  return {
    relations: await inspect({ kind: "relations" }),
    "indexes without a collection": await inspect({ kind: "indexes" }),
    "a collection whose sample holds nothing": await inspect(
      { table: "orders" },
      {
        catalog: async () => ({
          kind: "described",
          container: "app",
          object: "orders",
          objectKind: "collection",
          columns: [],
          indexes: [],
          sampled: 0,
        }),
      },
    ),
  };
}

/** `value` with each correlation id written as its order of first appearance, as `laterTurns` writes them. */
function withArtifactOrder(value: unknown): unknown {
  const text = JSON.stringify(value);
  const ids = correlationIdsIn(text);
  return JSON.parse(ids.reduce((written, id, index) => written.replaceAll(id, `<artifact-${index + 1}>`), text));
}

/** A reading of one row wider than any run's byte budget, so it is refused by bytes under the row ceiling. */
const OVER_BYTES: QueryResult = {
  rows: [{ wide: "x".repeat(300_000) }],
  fields: ["wide"],
  rowCount: 1,
  executionTime: 1,
};

/**
 * The refusals and notes a kubectl or MongoDB tool gives on one input and that no other value here carries: both
 * cluster readings past their row ceiling and past the byte budget, a resources card with a quantity Kubernetes does
 * not parse, a document-index card with its keys among the options, an empty MongoDB plan command, and a collection
 * profile over more fields than one call covers.
 */
async function toolRefusals() {
  const kubectl = (answers: DoubleAnswers) => toolContext("kubernetes", "query-optimization", answers);
  const shop = { namespace: "shop" };
  const resources = recommendChangeTool(
    await kubectl({}),
    { runId: "run_g", events: [completed("step_1", usage), usageRead(usage)] },
    {
      change: "resources",
      namespace: "shop",
      ownerKind: "Deployment",
      ownerName: "web",
      container: "web",
      current: { requests: { cpu: "500m" }, limits: { cpu: "1" } },
      proposed: { requests: { cpu: "a lot" }, limits: { cpu: "1" } },
      rationale: "The web container needs less CPU.",
      evidence: [cite("cid_usage")],
    },
  );
  const mongo = await toolContext("mongodb", "query-optimization");
  const keysInOptions = recommendChangeTool(
    mongo,
    { runId: "run_g", events: [captured([ordersCollection()]), completed("step_1", mongoPlan)] },
    {
      change: "document-index",
      collection: "orders",
      keys: { customer: 1 },
      options: { key: { total: 1 } },
      rationale: "The plan reads every order to find one customer's.",
      evidence: [cite("cid_mongo_plan")],
    },
  );
  const wide = {
    ...ordersCollection(),
    columns: Array.from({ length: 20 }, (_, index) => ({
      name: `field_${String(index).padStart(2, "0")}`,
      type: "string",
      nullable: true,
      isPrimary: false,
    })),
  };
  const profiling = await toolContext("mongodb", "data-analysis");
  const planned = planMongoProfile(
    profiling,
    { runId: "run_g", events: [captured([wide])] },
    { table: "orders", depth: "basic" },
  );
  return {
    kubectl: {
      "usage over its row ceiling": await inspectUsageTool(
        await kubectl({ usage: async () => ({ kind: "over-ceiling" }) }),
        shop,
      ),
      "usage over the byte budget": await inspectUsageTool(
        await kubectl({ usage: async () => ({ kind: "rows", result: OVER_BYTES }) }),
        shop,
      ),
      "workloads over their row ceiling": await profileWorkloadsTool(
        await kubectl({ workloads: async () => ({ kind: "over-ceiling" }) }),
        shop,
      ),
      "workloads over the byte budget": await profileWorkloadsTool(
        await kubectl({ workloads: async () => ({ kind: "rows", result: OVER_BYTES }) }),
        shop,
      ),
      "a resources card with a quantity that does not parse": resources,
    },
    mongo: {
      "a document-index card with its keys among the options": keysInOptions,
      "an empty plan command": await DATABASE_TOOL_HANDLERS.inspect_plan(mongo, { command: {} }, null),
      "a profile over more fields than one call covers": withArtifactOrder(
        planned.kind === "planned" ? await runMongoProfile(profiling, planned.plan) : planned,
      ),
    },
  };
}

/** One statement per command that has row-cap advice of its own, and one that has none. */
const ADVICE_STATEMENTS = {
  kubectl: (key: string) =>
    ({ get: "get pods", top: "top pods", logs: "logs web-1", events: "events -n shop" })[key] ?? key,
  mongo: (key: string) => JSON.stringify({ collection: "orders", operation: key }),
} as const;

/** Each language's shape advice, and its row-cap advice for every `adviceKeys` entry and for a command with none. */
function statementAdvice() {
  const generic = { sql: "SELECT * FROM orders", kubectl: "describe pods", mongo: '{"collection":"orders"}' } as const;
  return Object.fromEntries(
    (["sql", "kubectl", "mongo"] as const).map((language) => {
      const server = languageServer(language);
      const keyed = AGENT_LANGUAGE_COPY[language].adviceKeys.map((key) => {
        const statement = ADVICE_STATEMENTS[language as "kubectl" | "mongo"](key);
        return { key, statement, rowCapAdvice: server.rowCapAdvice(statement, "200") };
      });
      return [
        language,
        {
          ...(server.shapeAdvice === undefined ? {} : { shapeAdvice: server.shapeAdvice }),
          rowCapAdvice: [
            ...keyed,
            { statement: generic[language], rowCapAdvice: server.rowCapAdvice(generic[language], "200") },
          ],
        },
      ];
    }),
  );
}

/**
 * The drives whose later turns carry what a first turn never does: every shortfall notice a language arm speaks,
 * with a plan in hand and without; the usage bar; the cluster's metrics refusal; and the grounding notes of an
 * inventory too long to pack and of a run that could not be grounded.
 */
async function languageDrives() {
  const many = Array.from({ length: 400 }, (_, index) => `object_${String(index).padStart(3, "0")}`);
  const scenarios: Record<string, Drive> = {
    "mongo query-optimization, a report with no plan": await drive("agent", "query-optimization", "mongodb", [
      reportOnInventory("The orders collection is read end to end."),
    ]),
    "mongo query-optimization, a report beside an uncited plan": await drive(
      "agent",
      "query-optimization",
      "mongodb",
      [
        callsTool("inspect_plan", {
          command: { collection: "orders", operation: "find", filter: { customer: "Ada" } },
        }),
        reportOnInventory("The orders collection is read end to end."),
      ],
      { query: async () => ({ rows: [{ stage: "COLLSCAN" }], fields: ["stage"], rowCount: 1, executionTime: 1 }) },
    ),
    "kubectl query-optimization, a report with no usage reading": await drive(
      "agent",
      "query-optimization",
      "kubernetes",
      [reportOnInventory("The web container is oversized.")],
    ),
    "kubectl query-optimization, a usage reading and a report not citing it": await drive(
      "agent",
      "query-optimization",
      "kubernetes",
      [
        callsTool("inspect_usage", { namespace: "app" }, "call_usage"),
        reportOnInventory("The web container is oversized."),
      ],
    ),
    "kubectl query-optimization, a cluster serving no metrics": await drive(
      "agent",
      "query-optimization",
      "kubernetes",
      [callsTool("inspect_usage", { namespace: "app" }, "call_usage")],
      { usage: async () => ({ kind: "metrics-unavailable" }) },
    ),
    "kubectl database-assessment, a report with no workload profile": await drive(
      "agent",
      "database-assessment",
      "kubernetes",
      [reportOnInventory("The workloads are healthy.")],
    ),
    "kubectl database-assessment, a profile then a report citing it": await drive(
      "agent",
      "database-assessment",
      "kubernetes",
      [callsTool("profile_workloads", { namespace: "app" }, "call_profile"), reportOnLatest("All ready.")],
    ),
  };
  const grounding: Record<string, Drive> = {};
  for (const engine of ENGINES) {
    grounding[`${engine} agent investigation, an inventory too long to pack`] = await drive(
      "agent",
      "investigation",
      engine,
      [],
      { listed: many },
    );
    grounding[`${engine} agent investigation, a listing that fails`] = await drive(
      "agent",
      "investigation",
      engine,
      [],
      { listingFails: new Error("connect ECONNREFUSED 127.0.0.1:1") },
    );
  }
  return {
    later: Object.fromEntries(Object.entries(scenarios).map(([name, run]) => [name, laterTurns(run)])),
    grounding: Object.fromEntries(
      Object.entries(grounding).map(([name, run]) => [name, firstRequest(run.turns, name).messages]),
    ),
  };
}

/** The oracle's text: one JSON object, two spaces of indentation, and a final newline. */
export async function goldenLanguageAgentSurface(): Promise<string> {
  const { log, info, debug, warn } = console;
  // The factory logs one line per provider it builds and the drive logs one per run it ends, both to stdout, and the
  // command-line form writes the oracle to stdout.
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;
  console.warn = () => undefined;
  try {
    const surfaces: SurfaceEntry[] = [];
    // One drive at a time: each starts from a cold snapshot cache, which is process state a parallel drive would share.
    for (const engine of ENGINES) {
      for (const { mode, workflowType } of openOn(engine)) surfaces.push(await surfaceOf(mode, workflowType, engine));
    }
    const prompted = ENGINES.flatMap((engine) =>
      openOn(engine).map(({ mode, workflowType }) => ({
        mode,
        workflowType,
        engine,
        contract: promptedToolContract(
          selectAgentTools({ mode, workflowType, statementLanguage: LANGUAGE[engine as keyof typeof LANGUAGE] }),
        ),
      })),
    );
    const languages = ["kubectl", "mongo"] as const;
    const classifier: Record<string, string> = {};
    for (const language of languages) classifier[language] = await classifierPrompt(language);
    const { later, grounding } = await languageDrives();
    const result = {
      surface: {
        surfaces,
        prompted,
        classifier,
        posture: postures(),
        autoExecuteTerms: Object.fromEntries(
          languages.map((language) => [
            language,
            Object.fromEntries(
              WORKFLOWS.map((workflowType) => [workflowType, autoExecuteTerms(workflowType, language)]),
            ),
          ]),
        ),
        verdicts: verdicts(),
      },
      packValues: {
        drives: later,
        grounding,
        cards: await cards(),
        answerNotADataRead: await answerNotADataRead(),
        mongoCatalogRefusals: await mongoCatalogRefusals(),
        toolRefusals: await toolRefusals(),
        statementAdvice: statementAdvice(),
        workflowToolRules: WORKFLOW_TOOL_RULES,
      },
    };
    return `${JSON.stringify(result, null, 2)}\n`;
  } finally {
    Object.assign(console, { log, info, debug, warn });
  }
}

if (import.meta.main) process.stdout.write(await goldenLanguageAgentSurface());
