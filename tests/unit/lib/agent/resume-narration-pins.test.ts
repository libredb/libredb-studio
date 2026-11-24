import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import type { AgentArtifactReference, AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import { fenceUntrustedContent } from "@/lib/agent/untrusted-content";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { providerAuthor } from "@/lib/db/operations/provider-text";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes";
import { WORKLOAD_PROFILE_FIELDS } from "@/lib/db/providers/platform/kubernetes/agent-readings";
import type { DatabaseProvider, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import {
  answersProse,
  callsTool,
  modelOver,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "../../../isolated/fixtures/agent-scripted-model";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";

// The agent's statements run through the host core's read-only execute, so this file installs one for its runs.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

/**
 * The sentences the run loop speaks from core rather than from a language pack, pinned verbatim as they read before
 * the run resolver: what a resumed run is told about a profile, a usage reading it could not take and a statement
 * recommendation it already made; the plan-bar notice; and the instrument count that refuses a narrowed run's fourth
 * workload profile.
 *
 * A resumed mongo run is told its profile under the SQL operation id. That is B127, pinned here as the current
 * behaviour so that no step of the language-pack work moves it by accident; the B127 fix changes this pin on purpose.
 *
 * Each drive is the real `runInvestigation` over a real ledger in a temporary directory and the scripted model the
 * isolated suite drives, over a provider double, as `investigation.test.ts` drives one.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Declarations {
  readonly capabilities: ProviderCapabilities;
  readonly labels: ProviderLabels;
}

interface Drive {
  readonly events: readonly AgentRunEvent[];
  readonly turns: readonly Turn[];
}

/**
 * One agent-mode run of `turns` on `connection`, opened the way the start route opens it, over a provider double that
 * grounds the run on one object (`orders`, in the session's own container `app`) and answers every statement with one
 * row. `methods` adds to or replaces the double's methods, and `prior` is appended to the ledger before the drive, as
 * a resumed run finds it.
 */
async function drive(
  connection: DatabaseConnection,
  declared: Declarations,
  options: {
    readonly workflowType: AgentRunWorkflowType;
    readonly turns?: readonly ScriptedTurn[];
    readonly prior?: readonly AgentRunEvent[];
    readonly methods?: Readonly<Record<string, unknown>>;
  },
): Promise<Drive> {
  const { workflowType, turns = [], prior = [], methods = {} } = options;
  forgetHeldSnapshots();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-narration-pins-"));
  dataDirs.push(dataDir);
  const [listed] = declared.capabilities.objectKinds ?? [];
  const provider = {
    type: connection.type,
    queryReadOnly: async (): Promise<QueryResult> => ({
      rows: [{ n: 1 }],
      fields: ["n"],
      rowCount: 1,
      executionTime: 1,
    }),
    listContainers: async () => [],
    countObjects: async () => (listed === undefined ? {} : { [listed.id]: { count: 1 } }),
    listObjects: async (container: readonly string[], kind: string) =>
      kind === listed?.id ? [{ path: [...container, "orders"], name: "orders", kind }] : [],
    describeObjects: async () => ({ details: [] }),
    ...methods,
  } as unknown as DatabaseProvider;
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const availability = workflowAvailability("agent", workflowType, connection.type);
  if (!availability.open) throw new Error(`${workflowType} does not open on ${connection.type}`);
  const run = await service.start({
    mode: "agent",
    workflowType,
    ...persistedRunFacts("agent", workflowType, connection.type, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "Which customers ordered most?",
  });
  for (const event of prior) {
    // oxlint-disable-next-line no-await-in-loop -- a ledger is ordered: each event lands after the one before it.
    await store.appendEvent(run.runId, event);
  }
  const script = scriptedModel(...turns, answersProse("No report."), answersProse("No report."));
  await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources: {
      connection,
      ...declared,
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
  return { events: view.record.events, turns: script.turns };
}

/** The `user` messages one request carried, each as its text. */
function userMessages(turn: Turn | undefined): string[] {
  if (turn === undefined) throw new Error("the drive sent no such request");
  return ((turn.body.messages ?? []) as { role?: string; content?: unknown }[]).flatMap((message) =>
    message.role === "user" && typeof message.content === "string" ? [message.content] : [],
  );
}

/** What one request carried as the result of the call `callId`. */
function toolResult(turn: Turn | undefined, callId: string): string {
  if (turn === undefined) throw new Error("the drive sent no such request");
  const found = ((turn.body.messages ?? []) as { role?: string; tool_call_id?: string; content?: unknown }[]).find(
    (message) => message.role === "tool" && message.tool_call_id === callId,
  );
  if (typeof found?.content !== "string") throw new Error(`no result for ${callId}`);
  return found.content;
}

/** The one message of the first request that carries `marker`. */
function openingMessageWith(run: Drive, marker: string): string {
  const found = userMessages(run.turns[0]).filter((message) => message.includes(marker));
  if (found.length !== 1) throw new Error(`expected one opening message with ${marker}, found ${found.length}`);
  return found[0] as string;
}

const postgres: DatabaseConnection = { id: "conn_pg", name: "Orders", type: "postgres", createdAt: new Date(0) };
const POSTGRES: Declarations = {
  capabilities: {
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
  },
  labels: TABLE_LABELS,
};

const mongoConnection: DatabaseConnection = {
  id: "conn_mongo",
  name: "MongoDB",
  type: "mongodb",
  host: "127.0.0.1",
  port: 27017,
  database: "app",
  createdAt: new Date(0),
};
const mongo = new MongoDBProvider(mongoConnection);
const MONGO: Declarations = { capabilities: mongo.getCapabilities(), labels: mongo.getLabels() };

const k8sConnection = kubernetesConnection({ id: "conn_k8s", database: "shop" });
const k8s = new KubernetesProvider(k8sConnection);
const KUBERNETES: Declarations = { capabilities: k8s.getCapabilities(), labels: k8s.getLabels() };

const artifact = (correlationId: string, operationId: string): AgentArtifactReference => ({
  correlationId,
  runId: "arun_1",
  operationId,
  summary: { rowCount: 4, columnNames: ["n"], elapsedMs: 3 },
});

/** A profile a dead earlier drive took, under `operationId`, with one finding. */
const profiled = (operationId: string): AgentRunEvent => ({
  kind: "table-profiled",
  atMs: 1,
  artifact: artifact("profile_1", operationId),
  profile: {
    table: "orders",
    depth: "basic",
    rowCount: 4,
    columns: [{ column: "customer", present: 3 }],
    findings: [{ code: "high_null", column: "customer", detail: "One value in four is missing." }],
  },
});

/**
 * The narration of `profiled` as the run loop speaks it today, whatever the run's language: fenced as SQL's, naming
 * the provider of the run's connection as the one that relayed the names.
 */
const profileNarration = (connection: DatabaseConnection): string =>
  `A table was already profiled at basic depth (4 row(s)), artifact profile_1. That profile is recorded; deepen it only if it left a question.\n${fenceUntrustedContent(
    "table: orders\ncustomer: high_null",
    {
      label: "profile already taken",
      operationId: "sql.table.profile",
      reference: "profile_1",
      relayedBy: providerAuthor(connection.type),
    },
  )}`;

describe("a resumed run that already profiled a table", () => {
  test("on SQL is told the profile, fenced under the SQL profile's operation id", async () => {
    const run = await drive(postgres, POSTGRES, {
      workflowType: "database-assessment",
      prior: [profiled("sql.table.profile")],
    });

    expect(openingMessageWith(run, "A table was already profiled")).toContain(profileNarration(postgres));
  });

  test("on mongo is told the profile fenced under the SQL profile's operation id too (B127, current behaviour)", async () => {
    const run = await drive(mongoConnection, MONGO, {
      workflowType: "database-assessment",
      prior: [profiled("mongo.collection.profile")],
    });

    expect(openingMessageWith(run, "A table was already profiled")).toContain(profileNarration(mongoConnection));
  });
});

describe("a resumed SQL run that already recommended a statement", () => {
  test.each([
    [
      "index",
      "CREATE INDEX orders_customer_idx ON orders (customer)",
      "A index was already recommended and is recorded: CREATE INDEX orders_customer_idx ON orders (customer). Do not propose it a second time.",
    ],
    [
      "rewrite",
      "SELECT customer FROM orders WHERE customer = 1",
      "A rewrite was already recommended and is recorded: SELECT customer FROM orders WHERE customer = 1. Do not propose it a second time.",
    ],
  ] as const)("of a %s is told it by its statement", async (change, statement, sentence) => {
    const run = await drive(postgres, POSTGRES, {
      workflowType: "query-optimization",
      prior: [
        {
          kind: "recommendation",
          atMs: 1,
          change,
          statement,
          rationale: "The plan reads orders end to end.",
          evidence: [{ source: "artifact", correlationId: "plan_1" }],
        },
      ],
    });

    expect(openingMessageWith(run, "already recommended")).toContain(sentence);
  });
});

describe("a resumed kubectl run whose cluster served no usage metrics", () => {
  test("is told the namespace and why asking again will not help", async () => {
    const run = await drive(k8sConnection, KUBERNETES, {
      workflowType: "query-optimization",
      prior: [{ kind: "usage-unavailable", atMs: 1, namespace: "web" }],
    });

    expect(openingMessageWith(run, "Usage could not be read")).toContain(
      "Usage could not be read in namespace web: this cluster serves no usage metrics (metrics.k8s.io), because metrics-server is not installed or not answering. Asking again will not change that.",
    );
  });
});

describe("the plan-bar notice", () => {
  test("follows an optimization run's first plan, in these words", async () => {
    const run = await drive(postgres, POSTGRES, {
      workflowType: "query-optimization",
      turns: [callsTool("inspect_plan", { sql: "SELECT customer FROM orders" }, "call_plan")],
    });

    expect(userMessages(run.turns[1])).toContain(
      "You have a plan in hand, and this workflow is judged on a comparison rather than on the plan alone: a report answers when two plans have been compared, or when an index is recommended citing the plan whose access path it would change. Neither is recorded yet. Before you call compose_report, either call inspect_plan on a rewritten form of the statement and then compare_plans with the two artifact ids, or call recommend_change for an index citing the plan artifact you already hold.",
    );
    expect(userMessages(run.turns[0]).join("\n")).not.toContain("You have a plan in hand");
  });
});

/** One workload's state, as `readWorkloadProfile` answers it. */
const WORKLOAD_ROWS = {
  kind: "rows",
  result: {
    rows: [{ kind: "Deployment", name: "web", desired: 1, ready: 1 }],
    fields: [...WORKLOAD_PROFILE_FIELDS],
    rowCount: 1,
    executionTime: 3,
  },
} as const;

describe("a narrowed kubectl cluster-health run", () => {
  test("is refused its fourth workload profile after the narrowing, as a tool it no longer holds", async () => {
    // Twelve unreported calls narrow the run; every call profiles a namespace of its own, so none is a repeat.
    const namespaces = Array.from({ length: 16 }, (_, index) => `ns-${String(index + 1).padStart(2, "0")}`);
    const run = await drive(k8sConnection, KUBERNETES, {
      workflowType: "database-assessment",
      turns: namespaces.map((namespace, index) =>
        callsTool("profile_workloads", { namespace }, `call_profile_${index + 1}`),
      ),
      methods: {
        listContainers: async () => [
          { path: ["shop"], name: "shop", level: 0, isSessionDefault: true, kinds: ["pods"] },
        ],
        readWorkloadProfile: async () => WORKLOAD_ROWS,
      },
    });

    // Narrowed at the twelfth call, so the twelfth, thirteenth and fourteenth are its three kept uses.
    expect(run.events.flatMap((event) => (event.kind === "workloads-profiled" ? [event.namespace] : []))).toEqual(
      namespaces.slice(0, 14),
    );
    expect(toolResult(run.turns[14], "call_profile_14")).toStartWith("Stored as artifact ");
    for (const [turn, callId] of [
      [15, "call_profile_15"],
      [16, "call_profile_16"],
    ] as const) {
      expect(toolResult(run.turns[turn], callId)).toBe(
        'There is no tool called "profile_workloads" in this run. Use one of the tools you were given, or answer without a tool.',
      );
    }
  });
});
