import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import * as realModelAdapter from "@/lib/agent/model-adapter";
import * as realRunStore from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunFailureReason, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { type ExecutionProfileDenyCode, ExecutionProfileError } from "@/lib/db/errors";
import * as realFactory from "@/lib/db/factory";
import type { ExecutionProfile } from "@/lib/db/factory";
import * as realResolveConnection from "@/lib/seed/resolve-connection";
import type { DatabaseConnection } from "@/lib/types";
import { mongoDriver, mongoDriverModule, resetMongoDriver } from "../helpers/mongodb-driver";
import ferretBuildInfo from "../unit/db/mongodb/fixtures/buildinfo-ferretdb-2.7.0.json";
import noAuthReaderStatus from "../unit/db/mongodb/fixtures/connection-status-no-auth-libredb-agent-9.0.4.json";
import rootStatus from "../unit/db/mongodb/fixtures/connection-status-root-9.0.4.json";
import {
  answersProse,
  callsTool,
  correlationIdsIn,
  modelOver,
  promptText,
  reportOnAll,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "./fixtures/agent-scripted-model";

/**
 * One agent run per MongoDB workflow, each scored by its own verifier, and the runs the profile refuses, against the
 * REAL `MongoDBProvider` over the driver stand-in (`tests/helpers/mongodb-driver.ts`).
 *
 * Driven through the composition root, `driveAgentRun`, rather than `runInvestigation` as the Kubernetes runs are:
 * the driver is replaced at the module, so no seam has to reach the provider, and the composition root is where a
 * refused run is given its failure reason (`classifyDriveFailure`), which is what a refusal case here asserts. What
 * the root resolves from its environment is supplied: the run's connection (`resolveConnection`), its ledger world
 * (`resolveAgentLedgerWorld`) and its model (`createAgentModel`, a scripted model over the ratified adapter). The
 * factory is the real one, observed but not replaced: every acquisition is recorded with its profile and handed to
 * the real `acquireExecutionProfileProvider`, so the profile's context (`executionContextFor`), the profiled cache and
 * the provider's verification at open all run as they do on a server. The cache is cleared between cases, so no case
 * is handed a provider a previous one verified.
 *
 * Each run is opened as the start route opens it, with the language and verifier `persistedRunFacts` writes, so the
 * verdict a case asserts is its variant's own. The stand-in serves the documents of the object fixture's customers and
 * orders collections and its active_customers view (`docker/mongodb-init/01-object-fixture.js`), with numeric ids:
 * two orders, Ada's of 120 and Grace's of 80.
 */

/** The read-role principal of `docker/mongodb-init/02-agent-principal.js`, as a seed names it. */
const READER: DatabaseConnection = {
  id: "seed:mongo-agent",
  name: "MongoDB agent",
  type: "mongodb",
  host: "127.0.0.1",
  port: 27017,
  database: "app",
  user: "libredb_agent",
  password: "libredb_agent",
  authSource: "app",
  createdAt: new Date(0),
};

/** The compose file's root account, which the editor connects as. */
const ADMIN: DatabaseConnection = {
  ...READER,
  id: "seed:mongo-admin",
  name: "MongoDB admin",
  user: "admin",
  password: "admin",
  authSource: "admin",
};

/**
 * The comment a statement-sending run's own commands carry (`AGENT_COMMAND_COMMENT`): its checks at open, each read and
 * plan, its catalog read and the kill of a read's session.
 */
const AGENT_COMMENT = "libredb-studio-agent";

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mongodb-e2e-"));
  dataDirs.push(dir);
  return dir;
}

/** One ledger world for the file: `driveAgentRun` opens its own service per call, over whatever this resolves. */
const world = createLocalWorld({ dataDir: freshDataDir(), recoverActiveRuns: false });

/** What the drive in flight resolves: its connection and its model. */
let inFlight: { readonly connection: DatabaseConnection; readonly model: Promise<realModelAdapter.AgentModel> } | null =
  null;

/** Every execution profile an acquisition asked for, in order, since the case began. */
const acquired: ExecutionProfile[] = [];

// Taken before the factory module is replaced below, so the recording acquirer hands every call to the real one.
const acquireExecutionProfileProvider = realFactory.acquireExecutionProfileProvider;
const clearProviderCache = realFactory.clearProviderCache;
const factoryExports = { ...realFactory };
const runStoreExports = { ...realRunStore };
const modelAdapterExports = { ...realModelAdapter };
const resolveConnectionExports = { ...realResolveConnection };

afterAll(async () => {
  await clearProviderCache();
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

mock.module("mongodb", () => mongoDriverModule());
mock.module("@/lib/db/factory", () => ({
  ...factoryExports,
  acquireExecutionProfileProvider: (...args: Parameters<typeof acquireExecutionProfileProvider>) => {
    acquired.push(args[1]);
    return acquireExecutionProfileProvider(...args);
  },
}));
mock.module("@/lib/agent/run-store", () => ({ ...runStoreExports, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/agent/model-adapter", () => ({
  ...modelAdapterExports,
  createAgentModel: async () => {
    if (inFlight === null) throw new Error("no drive is in flight");
    return inFlight.model;
  },
}));
mock.module("@/lib/seed/resolve-connection", () => ({
  ...resolveConnectionExports,
  resolveConnection: async () => {
    if (inFlight === null) throw new Error("no drive is in flight");
    return inFlight.connection;
  },
}));

const { driveAgentRun, getAgentRunService } = await import("@/lib/agent/runtime");
const { MongoDBProvider } = await import("@/lib/db/providers/document/mongodb");

/**
 * Three of the object fixture's `app` objects, the customers and orders collections and the active_customers view,
 * with numeric ids. Every collection's indexes are the stand-in's own (`_id_` and `email_1`), not the fixture's.
 */
function seedAppDatabase(): void {
  mongoDriver.databaseList = [{ name: "app" }];
  mongoDriver.collectionsByDb = {
    app: [
      { name: "customers", type: "collection" },
      { name: "orders", type: "collection" },
      {
        name: "active_customers",
        type: "view",
        options: { viewOn: "customers", pipeline: [{ $match: { city: "Istanbul" } }] },
      },
    ],
  };
  mongoDriver.documentsByNs = {
    "app.customers": [
      { _id: 1, name: "Ada", city: "Istanbul" },
      { _id: 2, name: "Grace", city: "Ankara" },
      { _id: 3, name: "Alan", city: "Istanbul" },
    ],
    "app.orders": [
      { _id: 1, customer: "Ada", total: 120 },
      { _id: 2, customer: "Grace", total: 80 },
    ],
    "app.active_customers": [
      { _id: 1, name: "Ada", city: "Istanbul" },
      { _id: 3, name: "Alan", city: "Istanbul" },
    ],
  };
}

beforeEach(async () => {
  await clearProviderCache();
  resetMongoDriver();
  seedAppDatabase();
  // A cold process per run: a run on a connection an earlier run read is grounded on that reading instead.
  forgetHeldSnapshots();
  acquired.length = 0;
  inFlight = null;
});

interface Drive {
  readonly turns: readonly Turn[];
  readonly events: readonly AgentRunEvent[];
  /** What `driveAgentRun` threw, or undefined when it returned. */
  readonly thrown: unknown;
}

let runs = 0;

/**
 * One run of `workflowType` on `connection`, opened as the start route opens it and driven by `driveAgentRun`, whose
 * model is `turns`.
 */
async function drive(
  workflowType: AgentRunWorkflowType,
  turns: readonly ScriptedTurn[],
  {
    mode = "agent",
    connection = READER,
  }: { readonly mode?: AgentRunMode; readonly connection?: DatabaseConnection } = {},
): Promise<Drive> {
  const availability = workflowAvailability(mode, workflowType, "mongodb");
  if (!availability.open) throw new Error(`${mode} ${workflowType} does not open on mongodb`);
  runs += 1;
  const runId = `arun_mongo_e2e_${runs}`;
  await (await getAgentRunService()).start({
    runId,
    mode,
    workflowType,
    ...persistedRunFacts(mode, workflowType, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "Which customer placed the larger order?",
  });
  const script = scriptedModel(...turns);
  inFlight = { connection, model: modelOver(script.fetch) };
  const thrown = await driveAgentRun(runId).then(
    () => undefined,
    (error: unknown) => error,
  );
  inFlight = null;

  const report = await (await getAgentRunService()).status(runId);
  if (report === null) throw new Error(`run ${runId} has no ledger`);
  expect(report.record.statementLanguage).toBe("mongo");
  return { turns: script.turns, events: report.record.events, thrown };
}

/** The run's settled ending. */
function finishedOf(events: readonly AgentRunEvent[]): Extract<AgentRunEvent, { kind: "run-finished" }> {
  const finished = events.find((event) => event.kind === "run-finished");
  if (finished?.kind !== "run-finished") throw new Error("the run did not finish");
  return finished;
}

/** The operations each run settled, in order. */
const completed = (events: readonly AgentRunEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact.operationId] : []));

/** The correlation id of the latest artifact the transcript holds, taken from it as a model would take it. */
function latestArtifact(turn: Turn): string {
  const latest = correlationIdsIn(turn.transcript).at(-1);
  if (latest === undefined)
    throw new Error(`no artifact reference in the transcript: ${turn.transcript.slice(0, 400)}`);
  return latest;
}

/** The commands of the profile's verification at open, by name, in the order the server received them. */
const verificationCommands = (): string[] =>
  mongoDriver.commands.flatMap(({ command }) =>
    ["buildInfo", "connectionStatus", "delete"].filter((name) => command[name] !== undefined),
  );

/** The orders read the investigation and the analysis send: every order, the larger first. */
const ORDERS_BY_TOTAL = {
  command: { collection: "orders", operation: "find", filter: {}, options: { sort: { total: -1 } } },
};

describe("agent runs on a MongoDB connection, scored by their own verifiers", () => {
  test("investigation: inspect_schema, run_read_query, a report citing both, answers", async () => {
    const run = await drive("investigation", [
      callsTool("inspect_schema", {}, "call_schema"),
      callsTool("run_read_query", ORDERS_BY_TOTAL, "call_read"),
      reportOnAll("Ada placed the larger order, 120 against Grace's 80."),
    ]);

    expect(run.thrown).toBeUndefined();
    // The statement language the prompt quotes offers another database to the editor only, as the provider refuses it.
    expect(promptText(run.turns[0] as Turn)).toContain(
      "an agent run reads only the database its connection is bound to",
    );
    expect(completed(run.events)).toEqual(["mongo.schema.read", "mongo.query.read"]);
    // The grounding and both tools acquired the read-only profile, whose open proved the boundary once.
    expect(acquired).toEqual(["agent-read-only", "agent-read-only", "agent-read-only"]);
    expect(verificationCommands()).toEqual(["buildInfo", "connectionStatus", "delete"]);
    // The read reached the server bounded: one past the row budget, the budget's deadline, raw bytes.
    const read = mongoDriver.cursors.find((cursor) => cursor.kind === "find" && cursor.namespace === "app.orders");
    expect(read?.options).toMatchObject({ limit: 201, maxTimeMS: 10_000, raw: true, comment: AGENT_COMMENT });
    expect(promptText(run.turns[2] as Turn)).toContain('"customer":"Ada","total":120');
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-investigation.1" },
    });
  });

  test("query-optimization: inspect_plan, a document-index card citing that plan, a report, answers", async () => {
    const recommendsAnIndex: ScriptedTurn = (turn) =>
      callsTool(
        "recommend_change",
        {
          change: "document-index",
          collection: "orders",
          keys: { customer: 1 },
          rationale: "The plan reads every order to find one customer's: a COLLSCAN.",
          evidence: [{ source: "artifact", correlationId: latestArtifact(turn) }],
        },
        "call_recommend",
      )(turn);
    const run = await drive("query-optimization", [
      callsTool(
        "inspect_plan",
        { command: { collection: "orders", operation: "find", filter: { customer: "Ada" } } },
        "call_plan",
      ),
      recommendsAnIndex,
      reportOnAll("Reading one customer's orders scans the whole collection; an index on customer reaches them."),
    ]);

    expect(run.thrown).toBeUndefined();
    expect(completed(run.events)).toEqual(["mongo.plan.estimate"]);
    const plan = run.events.find((event) => event.kind === "tool-completed");
    if (plan?.kind !== "tool-completed") throw new Error("the run took no plan");
    // The plan is explained at queryPlanner verbosity under the read's own deadline, and reaches the model without
    // the server's identity.
    const explained = mongoDriver.cursors.find((cursor) => cursor.explained !== undefined);
    expect(explained?.explained).toEqual({ verbosity: "queryPlanner", maxTimeMS: 10_000 });
    expect(explained?.filter).toEqual({ customer: "Ada" });
    const handed = promptText(run.turns[1] as Turn);
    expect(handed).toContain("COLLSCAN");
    expect(handed).not.toContain("mock-host");
    expect(run.events.find((event) => event.kind === "recommendation")).toMatchObject({
      change: "document-index",
      collection: "orders",
      database: "app",
      keys: { customer: 1 },
      evidence: [{ source: "artifact", correlationId: plan.artifact.correlationId }],
    });
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-query-optimization.3" },
    });
  });

  test("database-assessment: profile_table, a report citing the profile, answers", async () => {
    const run = await drive("database-assessment", [
      callsTool("profile_table", { table: "app.customers", depth: "pattern" }, "call_profile"),
      reportOnAll("The three customers each carry a name and a city, and no field is shaped like personal data."),
    ]);

    expect(run.thrown).toBeUndefined();
    expect(completed(run.events)).toEqual(["mongo.table.profile"]);
    // The aggregation the server composed, counted by the stand-in over the fixture's three customers.
    const profiled = run.events.find((event) => event.kind === "table-profiled");
    expect(profiled).toMatchObject({
      kind: "table-profiled",
      profile: {
        table: "customers",
        depth: "pattern",
        rowCount: 3,
        columns: [
          { column: "_id", present: 3 },
          { column: "city", present: 3, shaped: 0, digitRun: 0 },
          { column: "name", present: 3, shaped: 0, digitRun: 0 },
        ],
      },
    });
    expect(promptText(run.turns[1] as Turn)).toContain("Profiled a collection: 3 document(s)");
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-database-assessment.1" },
    });
  });

  test("data-analysis: run_read_query, present_answer as a table, a report citing it, answers", async () => {
    const presentsTheRead: ScriptedTurn = (turn) =>
      callsTool(
        "present_answer",
        { artifact: latestArtifact(turn), presentation: { kind: "table" } },
        "call_answer",
      )(turn);
    const run = await drive("data-analysis", [
      callsTool("run_read_query", ORDERS_BY_TOTAL, "call_read"),
      presentsTheRead,
      reportOnAll("Ada placed the larger order, 120 against Grace's 80."),
    ]);

    expect(run.thrown).toBeUndefined();
    expect(run.events.find((event) => event.kind === "answer-composed")).toMatchObject({
      kind: "answer-composed",
      sql: JSON.stringify(ORDERS_BY_TOTAL.command),
      presentation: { kind: "table" },
    });
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-data-analysis.1" },
    });
  });

  test("inspect_schema reads the provider's catalog for the agent, never a composed SQL catalog", async () => {
    const catalog = spyOn(MongoDBProvider.prototype, "readCatalogReadOnly");
    const statements = spyOn(MongoDBProvider.prototype, "queryReadOnly");
    try {
      const run = await drive("investigation", [
        callsTool("inspect_schema", { table: "app.orders" }, "call_schema"),
        reportOnAll("An order holds a customer and a total."),
      ]);

      expect(run.thrown).toBeUndefined();
      expect(completed(run.events)).toEqual(["mongo.schema.read"]);
      // The inventory's spelling resolved to its database and collection, read under the run's own budget.
      expect(catalog.mock.calls).toEqual([
        [
          { container: "app", object: "orders" },
          { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 262_144 },
        ],
      ]);
      expect(statements).not.toHaveBeenCalled();
      // A sample of the collection's documents and its indexes, each in the agent's session under its deadline.
      expect(mongoDriver.cursors.at(-1)?.options).toMatchObject({ limit: 100, raw: true, comment: AGENT_COMMENT });
      expect(mongoDriver.listIndexesCalls.at(-1)).toMatchObject({
        namespace: "app.orders",
        options: { maxTimeMS: 10_000, comment: AGENT_COMMENT },
      });
      const handed = promptText(run.turns[1] as Turn);
      expect(handed).toContain('"name":"customer"');
      expect(handed).toContain('"name":"total"');
    } finally {
      catalog.mockRestore();
      statements.mockRestore();
    }
  });
});

describe("a MongoDB run the profile refuses ends before its first model turn", () => {
  /** What every refused run shows: its reason, the profile's code, no turn, no statement, one refused grounding. */
  function expectRefusedAtOpen(run: Drive, reasonCode: ExecutionProfileDenyCode, reason: AgentRunFailureReason): void {
    expect(run.thrown).toBeInstanceOf(ExecutionProfileError);
    expect((run.thrown as ExecutionProfileError).reasonCode).toBe(reasonCode);
    expect(run.turns).toHaveLength(0);
    expect(run.events.map((event) => event.kind)).not.toContain("statement-drafted");
    expect(run.events.filter((event) => event.kind === "context-unavailable")).toEqual([
      expect.objectContaining({ reasonCode: "CATALOG_READ_REFUSED", profileReasonCode: reasonCode }),
    ]);
    expect(finishedOf(run.events)).toMatchObject({ status: "failed", reason });
    // Only the grounding asked, under the profile every one of the run's tools would have asked under.
    expect(acquired).toEqual(["agent-read-only"]);
  }

  test("an admin principal, holding writes, fails agent-principal-refused", async () => {
    mongoDriver.connectionStatus = rootStatus.reply;
    mongoDriver.probe = "accepted";

    const run = await drive("investigation", [answersProse("never asked")], { connection: ADMIN });

    expectRefusedAtOpen(run, "PROFILE_PRIVILEGES_TOO_BROAD", "agent-principal-refused");
    // Refused on its privileges, so the probe is never sent.
    expect(verificationCommands()).toEqual(["buildInfo", "connectionStatus"]);
  });

  test("a server enforcing no authorization fails server-authorization-off, though the user holds only reads", async () => {
    mongoDriver.connectionStatus = noAuthReaderStatus.reply;
    mongoDriver.probe = "accepted";

    const run = await drive("data-analysis", [answersProse("never asked")]);

    expectRefusedAtOpen(run, "PROFILE_SERVER_UNENFORCED", "server-authorization-off");
    expect(verificationCommands()).toEqual(["buildInfo", "connectionStatus", "delete"]);
  });

  test("a FerretDB server fails profile-target-unsupported, before any privilege is read", async () => {
    mongoDriver.buildInfo = ferretBuildInfo.reply;

    const run = await drive("query-optimization", [answersProse("never asked")]);

    expectRefusedAtOpen(run, "PROFILE_UNSUPPORTED_TARGET", "profile-target-unsupported");
    expect(verificationCommands()).toEqual(["buildInfo"]);
  });
});

describe("plan mode and the operations workflow on the admin principal open as they did before agent mode", () => {
  /** The admin principal, which the profile would refuse had anything verified it. */
  function anAdminServer(): void {
    mongoDriver.connectionStatus = rootStatus.reply;
    mongoDriver.probe = "accepted";
  }

  test("a plan run is grounded under the operations profile, and nothing verifies its connection", async () => {
    anAdminServer();

    const run = await drive(
      "investigation",
      [
        answersProse(
          "Read the orders, the larger first.\n\n```mongodb\n" + JSON.stringify(ORDERS_BY_TOTAL.command) + "\n```",
        ),
      ],
      { mode: "planning", connection: ADMIN },
    );

    expect(run.thrown).toBeUndefined();
    expect(run.events.map((event) => event.kind)).toContain("context-captured");
    expect(run.events.map((event) => event.kind)).not.toContain("context-unavailable");
    expect(acquired).toEqual(["agent-operations"]);
    expect(verificationCommands()).toEqual([]);
    expect(run.events.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: JSON.stringify(ORDERS_BY_TOTAL.command),
      dialect: "mongodb",
    });
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-planning.1" },
    });
  });

  test("an operations run is grounded and reads under the operations profile, and nothing verifies its connection", async () => {
    anAdminServer();

    const run = await drive(
      "operations",
      [callsTool("inspect_operations", { kind: "sessions" }, "call_sessions"), reportOnAll("No session is running.")],
      { connection: ADMIN },
    );

    expect(run.thrown).toBeUndefined();
    expect(run.events.map((event) => event.kind)).toContain("context-captured");
    expect(completed(run.events)).toEqual(["db.operations.read"]);
    expect(acquired).toEqual(["agent-operations", "agent-operations"]);
    expect(verificationCommands()).toEqual([]);
    expect(finishedOf(run.events)).toMatchObject({
      status: "succeeded",
      goalVerdict: { outcome: "answered", verifier: "agent-operations.2" },
    });
  });
});
