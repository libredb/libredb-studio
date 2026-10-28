/**
 * The MongoDB arms of the agent tools (issue #1614): what `run_read_query`, `inspect_schema`, `inspect_plan`,
 * `profile_table` and `recommend_change` do on the `mongo` statement language.
 *
 * The harness is `kubectl-tools.test.ts`'s, on a MongoDB connection: the model's argument is a JSON OBJECT where
 * kubectl's is a line, and the language's `canonicalize` turns it into the text every server layer reads - so the
 * assertions here are about that text, the reader's refusals reaching nothing, and each arm's own reading.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolContext,
  type AgentToolName,
  agentToolDefinition,
  comparePlansTool,
  presentableArtifact,
  presentAnswerTool,
  recommendChangeTool,
  runReadQueryTool,
  selectAgentTools,
} from "@/lib/agent/tools";
import { AGENT_ANSWER_CONTRACT } from "@/lib/agent/tool-contracts";
import {
  mongoInspectPlanTool,
  mongoInspectSchemaTool,
  mongoProfileTablePlan,
  planMongoProfile,
} from "@/lib/agent/languages/mongo/tools";
import { draftedStatement, profileTable } from "@/lib/agent/investigation";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { QueryError } from "@/lib/db/errors";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseProvider, ReadOnlyCatalogReading, ReadOnlyStatementBudget } from "@/lib/db/types";
import type {
  AgentArtifactReference,
  AgentContextSnapshot,
  AgentInventoryObject,
  AgentRunEvent,
  AgentRunRecord,
} from "@/lib/agent/types";
import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";
import type { QueryResult } from "@/lib/types";

/** A MongoDB connection in the field form the seed file uses. */
const connection = {
  id: "seed:mongo-agent",
  name: "MongoDB agent",
  type: "mongodb" as const,
  host: "127.0.0.1",
  port: 27017,
  database: "app",
  user: "libredb_agent",
  password: "libredb_agent",
  createdAt: new Date(0),
};

const mongodb = new MongoDBProvider(connection);

/** A clock that never advances, so the deadline is never the reason anything fails. */
const frozenClock = () => 1_000;

/** What the stub provider's agent catalog read answers when a test does not say. */
const LISTED: ReadOnlyCatalogReading = {
  kind: "listed",
  container: "app",
  objects: [
    { name: "orders", kind: "collection" },
    { name: "active_customers", kind: "view" },
  ],
};

interface MongoHarness {
  readonly context: AgentToolContext;
  readonly queryReadOnly: ReturnType<typeof mock>;
  readonly readCatalogReadOnly: ReturnType<typeof mock>;
  readonly acquireProvider: ReturnType<typeof mock>;
}

function harness(
  overrides: Partial<AgentToolContext> = {},
  result?: () => Promise<QueryResult>,
  catalog: () => Promise<ReadOnlyCatalogReading> = async () => LISTED,
): MongoHarness {
  const queryReadOnly = mock(
    result === undefined
      ? async (): Promise<QueryResult> => ({
          rows: [{ customer: "Ada" }],
          fields: ["customer"],
          rowCount: 1,
          executionTime: 3,
        })
      : result,
  );
  const readCatalogReadOnly = mock(catalog);
  const provider = {
    queryReadOnly,
    readCatalogReadOnly,
    getCapabilities: () => mongodb.getCapabilities(),
  } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  const context: AgentToolContext = {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    statementLanguage: "mongo",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: mongodb.getCapabilities(),
    labels: mongodb.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, frozenClock),
    repairs: new AgentRepairLedger(),
    acquireProvider,
    clock: () => 1_000,
    ...overrides,
  };
  return { context, queryReadOnly, readCatalogReadOnly, acquireProvider };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

const properties = (schema: unknown): string[] => Object.keys(z.toJSONSchema(schema as z.ZodType).properties ?? {});

const STATEMENT_WORKFLOWS = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;

/** One field of a collection, as the sample-inferred inventory carries it. */
const field = (name: string, type = "string") => ({ name, type, nullable: true, isPrimary: false });

/** One collection as the grounding walk names it: its database in front, its path the two segments. */
const collection = (database: string, name: string, columns = [field("customer"), field("total", "double")]) =>
  ({
    path: [database, name],
    name: `${database}.${name}`,
    kind: "collection",
    columns,
    indexes: [],
    foreignKeys: [],
  }) satisfies AgentInventoryObject;

/** A captured snapshot over `objects`, read in `defaultContainer` where the walk knew one. */
const snapshotOf = (
  objects: readonly AgentInventoryObject[],
  defaultContainer?: readonly string[],
): AgentContextSnapshot => ({
  connectionId: connection.id,
  fingerprint: "ctx_test",
  capturedAtMs: 0,
  objects,
  kinds: [{ id: "collection", role: "relation", label: "Collection", labelPlural: "Collections" }],
  ...(defaultContainer === undefined ? {} : { defaultContainer }),
});

/** The context-captured event a run's ledger carries, holding `snapshot`. */
const captured = (snapshot: AgentContextSnapshot): AgentRunEvent => ({
  kind: "context-captured",
  atMs: 0,
  fingerprint: snapshot.fingerprint,
  tableCount: snapshot.objects.length,
  snapshot,
});

/** A run record holding `events`, the shape `profileTable` reads back through `service.resume`. */
const recordOf = (events: readonly AgentRunEvent[]): AgentRunRecord =>
  ({ runId: "run-1", status: "running", events }) as unknown as AgentRunRecord;

/** A completed step under `operationId`, with the statement the model drafted for it. */
function drafted(stepId: string, artifact: AgentArtifactReference, sql: string): AgentRunEvent[] {
  return [
    { kind: "statement-drafted", atMs: 1, stepId, sql, rationale: "(none given)" },
    { kind: "tool-completed", atMs: 2, stepId, artifact },
  ];
}

describe("run_read_query on mongo", () => {
  test("offers a command object on every mongo statement workflow, and the SQL argument stays SQL's", () => {
    for (const workflow of STATEMENT_WORKFLOWS) {
      const definition = agentToolDefinition("mongo", workflow, "run_read_query");
      expect(properties(definition.inputSchema), workflow).toEqual(["command", "rationale"]);
      expect(definition.operationId, workflow).toBe("mongo.query.read");
    }
    expect(properties(agentToolDefinition(undefined, "investigation", "run_read_query").inputSchema)).toEqual([
      "sql",
      "rationale",
    ]);
  });

  test("a mongo run is offered exactly its variant's tools, the catalog and the plan beside the read", () => {
    // Read from the manifest rather than restated: the variant is the one place a tool set is decided, and what this
    // pins is that the offer is that set, in that order, on every mongo workflow.
    for (const workflowType of STATEMENT_WORKFLOWS) {
      const offered = selectAgentTools({ mode: "agent", workflowType, statementLanguage: "mongo" });
      expect(
        offered.map((tool) => tool.name),
        workflowType,
      ).toEqual([...(AGENT_WORKFLOW_VARIANTS.mongo[workflowType]?.tools ?? [])]);
    }
    const analysis = selectAgentTools({ mode: "agent", workflowType: "data-analysis", statementLanguage: "mongo" });
    expect(analysis.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["inspect_schema", "run_read_query", "inspect_plan", "profile_table", "present_answer"]),
    );
  });

  test("an admitted command reaches the provider in the order the model wrote it", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, {
      command: { operation: "find", collection: "orders", filter: { status: "shipped" } },
      rationale: "read the orders",
    });
    expect(outcome.kind).toBe("completed");
    expect(h.queryReadOnly.mock.calls[0]?.[0]).toBe(
      '{"operation":"find","collection":"orders","filter":{"status":"shipped"}}',
    );
    // The operation the audited pipeline recorded is the mongo one, not the SQL one.
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.query.read");
  });

  test("a sort, a $sort and an embedded document keep their key order, which is part of what they read", async () => {
    // Measured on 9.0.4: a sort written {b: 1, a: 1} and run as {a: 1, b: 1} returns a different first document, and
    // an embedded document compared for equality matches only in the order it was stored in.
    const reads = [
      { collection: "orders", operation: "find", options: { sort: { b: 1, a: 1 } } },
      { collection: "orders", operation: "aggregate", pipeline: [{ $sort: { z: 1, a: -1 } }] },
      { collection: "orders", operation: "count", filter: { address: { zip: "10001", city: "NYC" } } },
    ];
    const sent = await Promise.all(
      reads.map(async (command) => {
        const h = harness();
        await runReadQueryTool(h.context, { command });
        return h.queryReadOnly.mock.calls[0]?.[0];
      }),
    );
    expect(sent).toEqual(reads.map((command) => JSON.stringify(command)));
  });

  test("an empty command is invalid input, and nothing is sent", async () => {
    const h = harness();
    const empty = await runReadQueryTool(h.context, { command: {} });
    expect(empty.kind).toBe("unavailable");
    expect(empty.kind === "unavailable" && empty.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("a write is answered with the reader's own sentence and reaches nothing", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, {
      command: { collection: "orders", operation: "insertOne", documents: [{ a: 1 }] },
    });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("STATEMENT_NOT_ADMITTED");
    expect(outcome.kind === "unavailable" && outcome.detail).toContain("not one of the five reads");
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("a read the captured inventory shows would answer nothing is refused before anything is sent", async () => {
    const snapshot = snapshotOf(
      [collection("app", "orders", [field("_id", "number"), field("created_at", "date")])],
      ["app"],
    );
    const h = harness();
    const qualified = await runReadQueryTool(
      h.context,
      { command: { collection: "app.orders", operation: "count" } },
      snapshot,
    );
    expect(qualified.kind === "unavailable" && qualified.reasonCode).toBe("STATEMENT_NOT_ADMITTED");
    expect(qualified.kind === "unavailable" && qualified.detail).toContain('as in "collection": "orders"');
    const stringDate = await runReadQueryTool(
      h.context,
      { command: { collection: "orders", operation: "count", filter: { created_at: { $gte: "2026-03-01" } } } },
      snapshot,
    );
    expect(stringDate.kind === "unavailable" && stringDate.detail).toContain('{"$date": "2026-03-01"}');
    expect(h.acquireProvider).not.toHaveBeenCalled();
    // The same read with the date written as one is sent.
    const wrapped = await runReadQueryTool(
      h.context,
      {
        command: {
          collection: "orders",
          operation: "count",
          filter: { created_at: { $gte: { $date: "2026-03-01" } } },
        },
      },
      snapshot,
    );
    expect(wrapped.kind).toBe("completed");
  });

  test("an sql argument on a mongo run is invalid input, and the field name is the language's own", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, { sql: "SELECT 1" });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });

  test("the description names the collection bare and the bound database, and offers no database key", () => {
    expect(agentToolDefinition("mongo", "investigation", "run_read_query").description).toBe(
      'Run one bounded read-only command envelope as JSON, with the keys its operation takes and no others: find takes "filter" and "options" ("projection", "sort", "skip", "limit"); findOne takes "filter" and "options" ("projection" only); aggregate takes "pipeline" only, so its filter, sort and limit are $match, $sort and $limit stages; count takes "filter"; distinct takes "field" and "filter". For example {"collection": "orders", "operation": "aggregate", "pipeline": [{"$match": {"status": "paid"}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]}. Write the collection by its bare name, as in "orders" for an inventory entry app.orders: the run reads the database its connection is bound to. Write a date as {"$date": "2026-03-01T00:00:00Z"} and an ObjectId as {"$oid": "<24 hex digits>"}: a plain string never equals either, and a read shows both as plain strings. Writes and the write stages of a pipeline ($out, $merge) are refused before the database is reached, and you are told why.',
    );
  });
});

describe("inspect_schema on mongo", () => {
  test("the catalog read is handed the run's read allowance in its budget, as every read of the run is", async () => {
    const readAllowance = new RunReadAllowance(10);
    const h = harness({ readAllowance });
    await mongoInspectSchemaTool(h.context, {}, null);
    expect((h.readCatalogReadOnly.mock.calls[0]?.[1] as ReadOnlyStatementBudget | undefined)?.readAllowance).toBe(
      readAllowance,
    );
  });

  test("a database-scoped read asks the provider for the bound database's collections, never a guessed one", async () => {
    const h = harness();
    const outcome = await mongoInspectSchemaTool(h.context, {}, null);
    expect(outcome.kind).toBe("completed");
    // No container: the provider answers for the database it is bound to, so the agent layer guesses none (and
    // never "admin", which a read user cannot list).
    expect(h.readCatalogReadOnly.mock.calls[0]?.[0]).toEqual({});
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.schema.read");
    expect(outcome.kind === "completed" && outcome.modelText).toContain("active_customers");
    // Under the profile that proves the principal: the catalog read is a read of the agent path.
    expect(h.acquireProvider.mock.calls[0]?.[1]).toBe("agent-read-only");
  });

  test("a qualified name the snapshot holds is read in the database the snapshot says", async () => {
    const snapshot = snapshotOf([collection("app", "orders")], ["app"]);
    const spellings = [{ table: "app.orders" }, { schema: "app", table: "orders" }, { table: "orders" }];
    const asked = await Promise.all(
      spellings.map(async (input) => {
        const h = harness({}, undefined, async () => ({
          kind: "described",
          container: "app",
          object: "orders",
          objectKind: "collection",
          columns: [{ name: "customer", type: "string" }],
          indexes: [{ name: "_id_", columns: ["_id"] }],
          sampled: 3,
        }));
        const outcome = await mongoInspectSchemaTool(h.context, input, snapshot);
        return { outcome: outcome.kind, selector: h.readCatalogReadOnly.mock.calls[0]?.[0] };
      }),
    );
    for (const answer of asked) {
      expect(answer).toEqual({ outcome: "completed", selector: { container: "app", object: "orders" } });
    }
  });

  test("a name the snapshot does not hold is passed whole, never split on its dot", async () => {
    // GridFS keeps its files in a collection literally named fs.files: splitting the name would read a collection
    // called files in a database called fs.
    const h = harness({}, undefined, async () => ({
      kind: "described",
      container: "app",
      object: "fs.files",
      objectKind: "collection",
      columns: [{ name: "filename", type: "string" }],
      indexes: [],
      sampled: 1,
    }));
    await mongoInspectSchemaTool(h.context, { table: "fs.files" }, snapshotOf([collection("app", "orders")], ["app"]));
    expect(h.readCatalogReadOnly.mock.calls[0]?.[0]).toEqual({ object: "fs.files" });
    await mongoInspectSchemaTool(h.context, { schema: "app", table: "fs.files" }, null);
    expect(h.readCatalogReadOnly.mock.calls[1]?.[0]).toEqual({ container: "app", object: "fs.files" });
  });

  test("a collection the database does not hold is the SQL arm's no-such-object answer", async () => {
    const h = harness({}, undefined, async () => ({ kind: "not-found", container: "app", object: "orderz" }));
    const outcome = await mongoInspectSchemaTool(h.context, { table: "orderz" }, null);
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("CATALOG_MATCHED_NOTHING");
  });

  test("a database holding no collection is answered as matching nothing, never as an empty artifact to cite", async () => {
    // The SQL arm's answer to a listing with no row: a catalog read that inspected nothing establishes nothing.
    const h = harness({}, undefined, async () => ({ kind: "listed", container: "app", objects: [] }));
    const outcome = await mongoInspectSchemaTool(h.context, {}, null);
    expect(h.readCatalogReadOnly.mock.calls[0]?.[0]).toEqual({});
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "CATALOG_MATCHED_NOTHING" });
  });

  test("a collection whose sample held no field is said to exist and be empty, never to be missing", async () => {
    // An empty collection or view infers no field at all, and "there is no object of that name" would be false.
    const h = harness({}, undefined, async () => ({
      kind: "described",
      container: "app",
      object: "archive",
      objectKind: "collection",
      columns: [],
      indexes: [{ name: "_id_", columns: ["_id"] }],
      sampled: 0,
    }));
    const outcome = await mongoInspectSchemaTool(h.context, { table: "archive" }, null);
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("CATALOG_OBJECT_EMPTY");
    expect(outcome.modelText).toContain("exists");
  });

  test("the indexes kind describes the same collection, and an object with none declares none", async () => {
    const declared = harness({}, undefined, async () => ({
      kind: "described",
      container: "app",
      object: "orders",
      objectKind: "collection",
      columns: [{ name: "customer", type: "string" }],
      indexes: [{ name: "customer_1", columns: ["customer"] }],
      sampled: 2,
    }));
    const one = await mongoInspectSchemaTool(declared.context, { kind: "indexes", table: "orders" }, null);
    expect(one.kind === "completed" && one.modelText).toContain("customer_1");

    const view = harness({}, undefined, async () => ({
      kind: "described",
      container: "app",
      object: "active_customers",
      objectKind: "view",
      columns: [{ name: "customer", type: "string" }],
      indexes: [],
      sampled: 2,
    }));
    const none = await mongoInspectSchemaTool(view.context, { kind: "indexes", table: "active_customers" }, null);
    expect(none.kind === "unavailable" && none.reasonCode).toBe("CATALOG_INVENTORY_EMPTY");
  });

  test("a database-wide index inventory is sent to one collection, and a relations read refused as an absence never stated", async () => {
    const h = harness();
    const broad = await mongoInspectSchemaTool(h.context, { kind: "indexes" }, null);
    expect(broad.kind === "unavailable" && broad.reasonCode).toBe("KIND_REFUSED");
    expect(broad.kind === "unavailable" && broad.detail).toBe(
      "A database-wide index inventory is not a catalog read here. Narrow to one collection with table, and its indexes are described beside its fields.",
    );
    const relations = await mongoInspectSchemaTool(h.context, { kind: "relations" }, null);
    expect(relations.kind === "unavailable" && relations.reasonCode).toBe("KIND_REFUSED");
    expect(relations.kind === "unavailable" && relations.detail).toContain("no foreign keys");
    expect(h.acquireProvider).not.toHaveBeenCalled();

    // A refusal naming a tool the run does not hold is answered "there is no tool called ..." and costs the run a turn
    // (#350), so each refusal names only tools that every mongo variant offering inspect_schema holds.
    const holders = Object.entries(AGENT_WORKFLOW_VARIANTS.mongo).flatMap(([workflow, variant]) =>
      variant?.tools.includes("inspect_schema") === true ? [{ workflow, tools: variant.tools }] : [],
    );
    expect(holders.length).toBeGreaterThan(0);
    for (const refusal of [broad, relations]) {
      const named = (Object.keys(AGENT_TOOL_DEFINITIONS) as AgentToolName[]).filter((tool) =>
        refusal.modelText.includes(tool),
      );
      for (const { workflow, tools } of holders) {
        for (const tool of named) expect(tools, `${workflow} holds ${tool}`).toContain(tool);
      }
    }
  });

  test("an engine's refusal settles as a database error the model can repair, and is never thrown", async () => {
    // Code 13 on another database, or the provider's own refusal of a database the connection is not bound to.
    const h = harness({}, undefined, async () => {
      throw new QueryError('This run reads the database "app" its connection is bound to', "mongodb");
    });
    const outcome = await mongoInspectSchemaTool(h.context, { schema: "admin" }, null);
    // The database the model named is the one asked for, so the refusal is the provider's to make, never this arm's
    // listing of the bound database under another's name.
    expect(h.readCatalogReadOnly.mock.calls[0]?.[0]).toEqual({ container: "admin" });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.refusal.class).toBe("database-error");
  });

  test("the read is held to the run's clamped budget, the one every statement takes", async () => {
    const h = harness({ deadline: new AgentRunDeadline(3_000, frozenClock) });
    await mongoInspectSchemaTool(h.context, {}, null);
    const budget = h.readCatalogReadOnly.mock.calls[0]?.[1] as {
      statementTimeoutMs: number;
      maxResultRows: number;
      maxResultBytes: number;
    };
    expect(budget.statementTimeoutMs).toBe(3_000);
    expect(budget.maxResultRows).toBe(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxResultRows);
    expect(budget.maxResultBytes).toBe(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxResultBytes);
  });

  test("a provider with no agent catalog read is a server fault named as one, never a fall back to the editor's", async () => {
    const h = harness({
      acquireProvider: mock(async () => ({ getCapabilities: () => mongodb.getCapabilities() }) as never),
    });
    await expect(mongoInspectSchemaTool(h.context, {}, null)).rejects.toThrow(/readCatalogReadOnly/);
  });

  test("the description narrows to a collection, never to another database", () => {
    // A listing past the row budget is refused (`readCatalogReadOnly`), but one collection's fields are inferred from
    // a sample and cut at the provider's fixed bound, so the description promises a complete listing and no complete
    // field list: a field absent from a very wide collection's list may still exist.
    expect(agentToolDefinition("mongo", "investigation", "inspect_schema").description).toBe(
      "Read the database's own catalog, optionally narrowed to one collection. Pass kind to choose the inventory: columns (the default: the collections, or one collection's fields, inferred from a sample of its documents) or indexes (the indexes one collection declares). MongoDB declares no foreign keys, so a relations read is refused rather than answered empty. A collection listing past the row budget is refused, not truncated. One collection's fields are listed up to a fixed bound, _id first and the rest in sorted order, so a field missing from a very wide collection's list may still exist.",
    );
  });
});

describe("inspect_plan on mongo", () => {
  test("takes a command object and plans it under the estimating operation", async () => {
    const h = harness();
    const outcome = await mongoInspectPlanTool(h.context, {
      command: {
        operation: "find",
        collection: "orders",
        filter: { customer: "Ada" },
        options: { sort: { b: 1, a: 1 } },
      },
    });
    expect(outcome.kind).toBe("completed");
    // The command the provider is asked to plan is the one the model wrote, in its order, so the plan is the plan of
    // the read it will run; and the mode is the estimating one.
    const call = h.queryReadOnly.mock.calls[0];
    expect(call?.[0]).toBe(
      '{"operation":"find","collection":"orders","filter":{"customer":"Ada"},"options":{"sort":{"b":1,"a":1}}}',
    );
    expect(call?.[2]).toBe("estimate-plan");
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.plan.estimate");
  });

  test("a command the inventory shows would match nothing is not planned, and one the reader refuses goes on to the pipeline", async () => {
    const snapshot = snapshotOf(
      [collection("app", "events", [field("_id", "objectId"), field("ts", "date")])],
      ["app"],
    );
    const h = harness({ workflowType: "query-optimization" });
    const strings = await mongoInspectPlanTool(
      h.context,
      { command: { collection: "events", operation: "find", filter: { ts: { $gte: "2026-10-01T00:00:00.000Z" } } } },
      snapshot,
    );
    expect(strings.kind === "unavailable" && strings.reasonCode).toBe("STATEMENT_NOT_ADMITTED");
    expect(strings.kind === "unavailable" && strings.detail).toEndWith("Nothing was planned.");
    expect(h.queryReadOnly).not.toHaveBeenCalled();
    // A write is the reader's to refuse, as it always was: the inventory is never asked about it.
    const write = await mongoInspectPlanTool(
      h.context,
      { command: { collection: "nowhere", operation: "insertOne", documents: [{ a: 1 }] } },
      snapshot,
    );
    expect(write.kind).toBe("refused");
  });

  test("an empty command is invalid input, as it is for the read, and nothing is planned", async () => {
    const h = harness();
    const outcome = await mongoInspectPlanTool(h.context, { command: {} });
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("a shape the reader refuses is answered before anything is planned", async () => {
    const h = harness();
    const outcome = await mongoInspectPlanTool(h.context, {
      command: { collection: "orders", operation: "insertOne" },
    });
    // The plan descriptor's input validates the command's text with the same admission the read path uses,
    // so a write is refused by the pipeline's own input stage: the audited refusal, never the tool's.
    expect(outcome.kind).toBe("refused");
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });

  test("the description says what the plan costs, and claims no untouched document", () => {
    expect(agentToolDefinition("mongo", "query-optimization", "inspect_plan").description).toBe(
      "Ask the engine for the ESTIMATED plan of one read-only command envelope, the same JSON shape run_read_query takes, with dates and ObjectIds written the same way: a range over a date field written with strings plans an index scan over strings, which matches no document. The engine plans the command with the explain command at queryPlanner verbosity and returns no result rows; where several plans are candidates it tries each for a bounded trial, under the same deadline your reads have. No timings are produced.",
    );
  });

  test("two plans of this run are plans compare_plans can read, whatever language they were asked in", async () => {
    // A plan is a plan by the KIND of artifact (`PLAN_ESTIMATE_OPERATIONS`), so the join under a comparison and the
    // auto-execute gate finds a MongoDB plan the way it finds a SQL one; whether the tool is offered is the
    // manifest's decision, not this join's.
    const h = harness();
    const events: AgentRunEvent[] = [];
    for (const [stepId, filter] of [
      ["s1", { customer: "Ada" }],
      ["s2", { customer: "Ada", status: "open" }],
    ] as const) {
      const command = { collection: "orders", operation: "find", filter };
      // oxlint-disable-next-line no-await-in-loop -- one run executes one statement at a time (maxConcurrentExecutions 1), so its plans are taken in turn.
      const outcome = await mongoInspectPlanTool(h.context, { command });
      if (outcome.kind !== "completed") throw new Error(`expected a plan, got ${outcome.kind}`);
      events.push(...drafted(stepId, outcome.artifact, JSON.stringify(command)));
    }
    const [before, after] = events.flatMap((event) =>
      event.kind === "tool-completed" ? [event.artifact.correlationId] : [],
    );
    const compared = comparePlansTool(h.context, { runId: "run-1", events }, { before, after });
    expect(compared.kind).toBe("compared");
  });
});

describe("profile_table on mongo", () => {
  const orders = collection("app", "orders", [field("customer"), field("status"), field("total", "double")]);

  /** The `$group` stage of a planned profile's composed aggregation. */
  const groupOf = (statement: string): Record<string, unknown> =>
    (JSON.parse(statement) as { pipeline: Record<string, Record<string, unknown>>[] }).pipeline[0]?.$group ?? {};

  test("the composition is server-side: one $group in the database the inventory read the collection in", () => {
    for (const input of [{ table: "app.orders" }, { schema: "app", table: "orders" }]) {
      const planned = mongoProfileTablePlan([orders], ["app"], input);
      if (planned.kind !== "planned") throw new Error(planned.modelText);
      const command = JSON.parse(planned.plan.statement) as Record<string, unknown>;
      expect(Object.keys(command)).toEqual(["collection", "database", "operation", "pipeline"]);
      expect(command).toMatchObject({ collection: "orders", database: "app", operation: "aggregate" });
      expect(planned.plan.target).toEqual({ schema: "app", table: "orders" });
      const group = groupOf(planned.plan.statement);
      expect(group.row_count).toEqual({ $sum: 1 });
      expect(group.present_0).toEqual({
        $sum: { $cond: [{ $in: [{ $type: "$customer" }, ["missing", "null"]] }, 0, 1] },
      });
      expect(planned.plan.columns.map((column) => column.name)).toEqual(["customer", "status", "total"]);
    }
  });

  test("a qualifier names the database the profile reads, and an unqualified name two databases hold is refused", () => {
    const other = collection("other", "orders");
    const qualified = mongoProfileTablePlan([orders, other], ["app"], { schema: "other", table: "orders" });
    if (qualified.kind !== "planned") throw new Error(qualified.modelText);
    expect(JSON.parse(qualified.plan.statement)).toMatchObject({ collection: "orders", database: "other" });
    // The session's own database breaks a tie, as it does for every reader of the address rule.
    const defaulted = mongoProfileTablePlan([orders, other], ["app"], { table: "orders" });
    expect(defaulted.kind === "planned" && JSON.parse(defaulted.plan.statement).database).toBe("app");
    const ambiguous = mongoProfileTablePlan([orders, other], undefined, { table: "orders" });
    expect(ambiguous.kind === "unavailable" && ambiguous.reasonCode).toBe("TABLE_SPELLING_AMBIGUOUS");
    expect(ambiguous.kind === "unavailable" && ambiguous.detail).toBe("app.orders, other.orders");
    const absent = mongoProfileTablePlan([orders], ["app"], { table: "no_such" });
    expect(absent.kind === "unavailable" && absent.reasonCode).toBe("TABLE_NOT_INVENTORIED");
  });

  test("a wide collection is profiled in batches, each starting where the model asked", () => {
    const wide = collection(
      "app",
      "wide",
      Array.from({ length: 30 }, (_, index) => field(`f${index}`)),
    );
    const first = mongoProfileTablePlan([wide], ["app"], { table: "wide" });
    if (first.kind !== "planned") throw new Error(first.modelText);
    expect(first.plan.columns).toHaveLength(16);
    expect(first.plan.remaining).toBe(14);
    const rest = mongoProfileTablePlan([wide], ["app"], { table: "wide", fromColumn: 16 });
    if (rest.kind !== "planned") throw new Error(rest.modelText);
    expect(rest.plan.columns.map((column) => column.name)).toEqual(Array.from({ length: 14 }, (_, i) => `f${16 + i}`));
    expect(rest.plan.from).toBe(16);
    expect(rest.plan.remaining).toBe(0);
    // The aliases are the batch's own, as the SQL arm's are, because the mapper reads them by index.
    expect(groupOf(rest.plan.statement).present_0).toEqual({
      $sum: { $cond: [{ $in: [{ $type: "$f16" }, ["missing", "null"]] }, 0, 1] },
    });
    const past = mongoProfileTablePlan([wide], ["app"], { table: "wide", fromColumn: 40 });
    expect(past.kind === "unavailable" && past.reasonCode).toBe("NO_COLUMNS_AT_OFFSET");
    // A batch starting exactly at the field count holds no field either: refused, never composed as a count-only
    // $group whose answer would tell the model the inventory lists no field.
    const atEnd = mongoProfileTablePlan([wide], ["app"], { table: "wide", fromColumn: 30 });
    expect(atEnd.kind === "unavailable" && atEnd.reasonCode).toBe("NO_COLUMNS_AT_OFFSET");
  });

  test("pattern depth tests only string values, unanchored as the SQL shape test is, and converts nothing", () => {
    // `$toString` of an object fails the whole aggregation on 7.0 and is regex-tested as its JSON on 8.3 and 9.0; the
    // type guard runs first and `$and` stops at it, so the regex never sees a value that is not a string.
    const planned = mongoProfileTablePlan([orders], ["app"], { table: "orders", depth: "pattern" });
    if (planned.kind !== "planned") throw new Error(planned.modelText);
    expect(planned.plan.statement).not.toContain("$toString");
    const group = groupOf(planned.plan.statement);
    expect(group.shaped_0).toEqual({
      $sum: {
        $cond: [
          {
            $and: [
              { $eq: [{ $type: "$customer" }, "string"] },
              { $regexMatch: { input: "$customer", regex: ".@.+\\..", options: "s" } },
            ],
          },
          1,
          0,
        ],
      },
    });
    expect(group.digits_0).toEqual({
      $sum: {
        $cond: [
          {
            $and: [
              { $eq: [{ $type: "$customer" }, "string"] },
              { $regexMatch: { input: "$customer", regex: "[0-9]{9,}", options: "s" } },
            ],
          },
          1,
          0,
        ],
      },
    });
    // A field the sample saw as a number takes no shape test.
    expect(group.shaped_2).toBeUndefined();
  });

  test("an inventoried collection with no field is counted, not refused as missing", () => {
    const planned = mongoProfileTablePlan([collection("app", "empty", [])], ["app"], { table: "empty" });
    if (planned.kind !== "planned") throw new Error(planned.modelText);
    expect(groupOf(planned.plan.statement)).toEqual({ _id: null, row_count: { $sum: 1 } });
  });

  test("distribution is not offered, so the schema refuses it, and the description names the two depths there are", () => {
    const definition = agentToolDefinition("mongo", "database-assessment", "profile_table");
    expect(definition.inputSchema.safeParse({ table: "orders", depth: "distribution" }).success).toBe(false);
    expect(definition.inputSchema.safeParse({ table: "orders", depth: "pattern", fromColumn: 16 }).success).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(definition.inputSchema as z.ZodType))).not.toContain("distribution");
    expect(definition.description).toBe(
      "Profile one collection the run has already inventoried. The server chooses the fields from the captured inventory and composes the aggregation; you supply only the collection and how deep to go. Depth basic counts documents and missing values, and pattern adds a shape test for personal data. Only COUNTS are returned: no value is ever read out of any field.",
    );
    const refused = mongoProfileTablePlan([orders], ["app"], { table: "orders", depth: "distribution" });
    expect(refused.kind === "unavailable" && refused.reasonCode).toBe("INVALID_TOOL_INPUT");
  });

  /**
   * A run service over a ledger holding `snapshot`, settling every step it is handed and recording what it writes:
   * the events, the step ids, and each step's invocation as the ledger would record it.
   */
  function serviceOver(snapshot: AgentContextSnapshot) {
    const recorded: AgentRunEvent[] = [];
    const steps: string[] = [];
    const invocations: { readonly stepId: string; readonly tool: string; readonly operationId?: string }[] = [];
    const service = {
      resume: async () => ({ record: recordOf([captured(snapshot)]) }),
      runStep: async (
        _runId: string,
        step: { readonly stepId: string; readonly tool: string; readonly operationId?: string },
        execute: () => Promise<unknown>,
      ) => {
        steps.push(step.stepId);
        invocations.push(step);
        await execute();
        return { kind: "performed" as const };
      },
      recordEvent: async (_runId: string, event: AgentRunEvent) => {
        recorded.push(event);
      },
    } as unknown as Parameters<typeof profileTable>[0];
    return { service, recorded, steps, invocations };
  }

  test("the run settles a step under the mongo operation, records the profile, and answers in the SQL arm's sentences", async () => {
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 7, present_0: 7, present_1: 6, present_2: 5 }],
      fields: ["row_count", "present_0", "present_1", "present_2"],
      rowCount: 1,
      executionTime: 3,
    }));
    const { service, recorded, invocations } = serviceOver(snapshotOf([orders], ["app"]));

    const result = await profileTable(service, h.context, { input: { table: "app.orders" } }, new Set());

    expect(result.kind === "answered" && result.text).toContain("Profiled a collection: 7 document(s)");
    // Covered as far as the inventory goes: its fields were inferred from a sample and are bounded, so the sentence
    // claims the fields it lists, never every field the collection holds.
    expect(result.kind === "answered" && result.text).toContain(
      "Every field the inventory lists for that collection is covered.",
    );
    expect(result.kind === "answered" && result.text).toContain("Only counts were read");
    // The collection's name is database content, so the model reads it fenced.
    expect(result.kind === "answered" && result.text).toContain("UNTRUSTED");
    // The step is recorded, and drawn on the timeline, under the operation its read ran under, never SQL's.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ tool: "profile_table", operationId: "mongo.table.profile" });
    const profiled = recorded.find((event) => event.kind === "table-profiled");
    expect(profiled?.kind === "table-profiled" && profiled.artifact.operationId).toBe("mongo.table.profile");
  });

  test("a finding is fenced under the mongo profile's operation, the one its read ran under", async () => {
    // 30 of 40 documents carry no customer, which crosses the high-null threshold.
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 40, present_0: 10, present_1: 40, present_2: 40 }],
      fields: ["row_count", "present_0", "present_1", "present_2"],
      rowCount: 1,
      executionTime: 3,
    }));
    const { service } = serviceOver(snapshotOf([orders], ["app"]));

    const result = await profileTable(service, h.context, { input: { table: "orders" } }, new Set());

    const text = result.kind === "answered" ? result.text : "";
    expect(text).toContain("high_null");
    expect(text).toContain("profile finding(s); operation mongo.table.profile; reference server-derived");
    expect(text).not.toContain("operation sql.table.profile");
  });

  test("a run record that is not this run's is a server fault, never a profile planned from another run's inventory", () => {
    const h = harness();
    expect(() => planMongoProfile(h.context, { runId: "another-run", events: [] }, { table: "orders" })).toThrow(
      "agent tool layer: the profile's run record does not belong to this run",
    );
  });

  test("planning mode has no tools at all, so nothing is resolved or composed", () => {
    const h = harness({ mode: "planning" });
    const outcome = planMongoProfile(h.context, { runId: "run-1", events: [] }, { table: "orders" });
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "MODE_HAS_NO_TOOLS" });
  });

  test("an empty collection profiles as zero documents, because a $group over nothing answers no row", async () => {
    const h = harness(undefined, async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }));
    const { service, recorded } = serviceOver(snapshotOf([orders], ["app"]));

    const result = await profileTable(service, h.context, { input: { table: "orders" } }, new Set());

    expect(result.kind === "answered" && result.text).toContain("0 document(s)");
    const profiled = recorded.find((event) => event.kind === "table-profiled");
    expect(profiled?.kind === "table-profiled" && profiled.profile.rowCount).toBe(0);
  });

  test("a collection whose inventory lists no field is answered as its document count, with no field range", async () => {
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 3 }],
      fields: ["row_count"],
      rowCount: 1,
      executionTime: 1,
    }));
    const { service } = serviceOver(snapshotOf([collection("app", "empty", [])], ["app"]));

    const result = await profileTable(service, h.context, { input: { table: "empty" } }, new Set());

    const text = result.kind === "answered" ? result.text : "";
    expect(text).toContain("Profiled a collection: 3 document(s), no field at basic depth, 0 finding(s).");
    expect(text).toContain("Its inventory lists no field, so only its documents were counted.");
    expect(text).not.toContain("fields 1-0");
    expect(text).not.toContain("Every field the inventory lists for that collection is covered.");
  });

  test("two batches of one collection are two steps, and one batch asked twice is one", async () => {
    const wide = collection(
      "app",
      "wide",
      Array.from({ length: 30 }, (_, index) => field(`f${index}`)),
    );
    /** The step one profile request settles as, on a run of its own. */
    const stepOf = async (input: Record<string, unknown>): Promise<string | undefined> => {
      const h = harness(undefined, async () => ({
        rows: [{ row_count: 1 }],
        fields: ["row_count"],
        rowCount: 1,
        executionTime: 1,
      }));
      const { service, steps } = serviceOver(snapshotOf([wide], ["app"]));
      await profileTable(service, h.context, { input }, new Set());
      return steps[0];
    };

    const [first, second, respelled] = await Promise.all(
      [{ table: "wide" }, { table: "wide", fromColumn: 16 }, { table: "app.wide", fromColumn: 0 }].map(stepOf),
    );

    expect(first).toStartWith("step_");
    expect(second).not.toBe(first);
    // The same resolved collection, depth and batch, spelled another way, is the same step.
    expect(respelled).toBe(first);
  });

  test("a read the provider refuses settles as refused, with the refusal's own sentence", async () => {
    const h = harness(undefined, async () => {
      throw new QueryError("Read-only execution exceeded the row budget: 11 rows > 10 allowed", "mongodb", "");
    });
    const { service } = serviceOver(snapshotOf([orders], ["app"]));
    const refused = await profileTable(service, h.context, { input: { table: "orders" } }, new Set());
    // The refusal's own model text is what the model reads: the row-budget sentence, not a silent nothing.
    expect(refused.kind === "answered" && refused.text).toContain("row budget");
  });

  test("a profile whose row does not map is PROFILE_UNREADABLE, refused rather than reported", async () => {
    const h = harness(undefined, async () => ({
      rows: [{ customer: "Ada" }],
      fields: ["customer"],
      rowCount: 1,
      executionTime: 3,
    }));
    const { service } = serviceOver(snapshotOf([orders], ["app"]));
    const outcome = await profileTable(service, h.context, { input: { table: "orders" } }, new Set());
    expect(outcome.kind === "answered" && outcome.text).toContain("could not be read as counts");
  });

  test("the draft of a command the model wrote as an object is its text in written order, with its rationale", async () => {
    // draftedStatement is the run loop's own entry: the model's input, read in the run's language.
    const draft = draftedStatement(
      { command: { operation: "find", collection: "orders" }, rationale: "count the orders" },
      "mongo",
    );
    expect(draft).toEqual({ sql: '{"operation":"find","collection":"orders"}', rationale: "count the orders" });
    // No rationale is "(none given)", the sentence the SQL drafts settled on long ago.
    const bare = draftedStatement({ command: { collection: "orders", operation: "count" } }, "mongo");
    expect(bare?.rationale).toBe("(none given)");
    // A command that carries no statement (an empty object) drafts nothing.
    expect(draftedStatement({ command: {} }, "mongo")).toBeNull();
    // The other languages' text passes through unchanged, and an object is no statement in them.
    expect(draftedStatement({ sql: "SELECT 1" }, "sql")).toEqual({ sql: "SELECT 1", rationale: "(none given)" });
    expect(draftedStatement({ statement: { get: "pods" } }, "kubectl")).toBeNull();
  });

  test("a replayed profile answers from the ledger, an unsettled one honestly cannot be known, a cancelled one ends", async () => {
    const h = harness();
    const ledger = { resume: async () => ({ record: recordOf([captured(snapshotOf([orders], ["app"]))]) }) };
    const replayed = await profileTable(
      {
        ...ledger,
        runStep: async () => ({
          kind: "replayed" as const,
          event: {
            kind: "tool-completed" as const,
            stepId: "s",
            artifact: {
              correlationId: "a",
              operationId: "mongo.table.profile",
              summary: { rowCount: 7, elapsedMs: 3 },
            },
          },
        }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof profileTable>[0],
      h.context,
      { input: { table: "orders" } },
      new Set(),
    );
    expect(replayed.kind === "answered" && replayed.text).toContain("already taken in this run");

    const indeterminate = await profileTable(
      {
        ...ledger,
        runStep: async () => ({ kind: "indeterminate" as const, stepId: "step_x" }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof profileTable>[0],
      h.context,
      { input: { table: "orders" } },
      new Set(),
    );
    expect(indeterminate.kind === "answered" && indeterminate.text).toContain("outcome was never recorded");

    const cancelled = await profileTable(
      {
        ...ledger,
        runStep: async () => ({ kind: "cancelled" as const }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof profileTable>[0],
      h.context,
      { input: { table: "orders" } },
      new Set(),
    );
    expect(cancelled.kind).toBe("cancelled");
  });
});

describe("recommend_change on mongo", () => {
  const snapshot = snapshotOf([collection("app", "orders")], ["app"]);

  /** A query-optimization run's ledger: the snapshot it captured and one plan it inspected. */
  async function runHoldingAPlan(): Promise<{
    readonly h: MongoHarness;
    readonly events: AgentRunEvent[];
    readonly plan: string;
  }> {
    const h = harness({ workflowType: "query-optimization" });
    const command = { collection: "orders", operation: "find", filter: { customer: "Ada" } };
    const outcome = await mongoInspectPlanTool(h.context, { command });
    if (outcome.kind !== "completed") throw new Error(`expected a plan, got ${outcome.kind}`);
    const events = [captured(snapshot), ...drafted("s1", outcome.artifact, JSON.stringify(command))];
    return { h, events, plan: outcome.artifact.correlationId };
  }

  test("an index citing the plan it would change is a document-index card, in the database the run read", async () => {
    const { h, events, plan } = await runHoldingAPlan();
    for (const spelling of ["orders", "app.orders"]) {
      const outcome = recommendChangeTool(
        h.context,
        { runId: "run-1", events },
        {
          change: "document-index",
          collection: spelling,
          keys: { customer: 1, status: -1 },
          options: { unique: false },
          rationale: "The plan reads every document of orders.",
          evidence: [{ source: "artifact", correlationId: plan }],
        },
      );
      if (outcome.kind !== "recommended") throw new Error(`expected a card, got ${outcome.reasonCode}`);
      expect(outcome.recommendation).toEqual({
        change: "document-index",
        collection: "orders",
        database: "app",
        keys: { customer: 1, status: -1 },
        options: { unique: false },
        rationale: "The plan reads every document of orders.",
        evidence: [{ source: "artifact", correlationId: plan }],
      });
    }
  });

  test("a collection the inventory does not hold is named whole, in the session's database where the capture read one", async () => {
    const { h, events, plan } = await runHoldingAPlan();
    const card = {
      change: "document-index",
      collection: "archive",
      keys: { customer: 1 },
      evidence: [{ source: "artifact", correlationId: plan }],
    };

    const inSession = recommendChangeTool(h.context, { runId: "run-1", events }, card);
    if (inSession.kind !== "recommended") throw new Error(`expected a card, got ${inSession.reasonCode}`);
    expect(inSession.recommendation).toMatchObject({
      change: "document-index",
      collection: "archive",
      database: "app",
    });

    // A capture that read no session database stamps none, rather than one nobody established.
    const unplaced = events.map((event) =>
      event.kind === "context-captured" ? captured(snapshotOf(snapshot.objects)) : event,
    );
    const outcome = recommendChangeTool(h.context, { runId: "run-1", events: unplaced }, card);
    if (outcome.kind !== "recommended") throw new Error(`expected a card, got ${outcome.reasonCode}`);
    expect(outcome.recommendation).toMatchObject({ change: "document-index", collection: "archive" });
    expect(Object.hasOwn(outcome.recommendation, "database")).toBe(false);
  });

  test("an index on keys the collection already has is refused, with no change named as the answer instead", async () => {
    const { h, events, plan } = await runHoldingAPlan();
    const indexed = events.map((event) =>
      event.kind === "context-captured"
        ? captured(
            snapshotOf(
              [
                {
                  ...collection("app", "orders"),
                  indexes: [{ name: "customer_1_status_1", columns: ["customer", "status"], unique: false }],
                },
              ],
              ["app"],
            ),
          )
        : event,
    );
    const card = (keys: Record<string, number>, spelling = "orders") => ({
      change: "document-index",
      collection: spelling,
      keys,
      evidence: [{ source: "artifact", correlationId: plan }],
    });
    for (const spelling of ["orders", "app.orders"]) {
      const same = recommendChangeTool(
        h.context,
        { runId: "run-1", events: indexed },
        card({ customer: 1, status: -1 }, spelling),
      );
      expect(same.kind === "unavailable" && same.reasonCode).toBe("INDEX_ALREADY_EXISTS");
      expect(same.kind === "unavailable" && same.modelText).toContain("nothing needs to change");
    }
    // A different order, a prefix, a longer key that begins with the existing one and another collection are new indexes.
    for (const keys of [
      { status: 1, customer: 1 },
      { customer: 1 },
      { customer: 1, status: 1, created_at: 1 },
    ] as Record<string, number>[]) {
      expect(recommendChangeTool(h.context, { runId: "run-1", events: indexed }, card(keys)).kind).toBe("recommended");
    }
    expect(
      recommendChangeTool(h.context, { runId: "run-1", events: indexed }, card({ customer: 1, status: 1 }, "archive"))
        .kind,
    ).toBe("recommended");
    // A capture that placed no database still finds the collection by its own name.
    const unplaced = indexed.map((event) =>
      event.kind === "context-captured" && event.snapshot !== undefined
        ? captured(snapshotOf(event.snapshot.objects))
        : event,
    );
    expect(
      recommendChangeTool(h.context, { runId: "run-1", events: unplaced }, card({ customer: 1, status: 1 }, "orders"))
        .kind,
    ).toBe("unavailable");
  });

  test("a card citing nothing this run produced is refused as unverifiable", async () => {
    const { h, events } = await runHoldingAPlan();
    const outcome = recommendChangeTool(
      h.context,
      { runId: "run-1", events },
      {
        change: "document-index",
        collection: "orders",
        keys: { customer: 1 },
        evidence: [{ source: "artifact", correlationId: "not-this-run" }],
      },
    );
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("UNVERIFIABLE_EVIDENCE");
  });

  test("a statement card and an options.key are refused as input, never read as a document index", async () => {
    const { h, events, plan } = await runHoldingAPlan();
    const evidence = [{ source: "artifact", correlationId: plan }];
    const statement = recommendChangeTool(
      h.context,
      { runId: "run-1", events },
      { change: "index", statement: "CREATE INDEX ix ON orders (customer)", rationale: "scan", evidence },
    );
    expect(statement.kind === "unavailable" && statement.reasonCode).toBe("INVALID_TOOL_INPUT");
    // An options key would replace the validated keys in the index spec the user creates.
    const keyed = recommendChangeTool(
      h.context,
      { runId: "run-1", events },
      { change: "document-index", collection: "orders", keys: { customer: 1 }, options: { key: { a: 1 } }, evidence },
    );
    expect(keyed.kind === "unavailable" && keyed.reasonCode).toBe("INVALID_TOOL_INPUT");
  });
});

describe("present_answer on mongo", () => {
  const artifact = (correlationId: string, operationId: string): AgentArtifactReference => ({
    correlationId,
    runId: "run-1",
    operationId,
    summary: { rowCount: 1, columnNames: ["n"], elapsedMs: 1 },
  });

  test("a profile is not an answer, and the refusal names the read this run already holds", () => {
    const h = harness({ workflowType: "data-analysis" });
    const events: AgentRunEvent[] = [
      ...drafted("s1", artifact("read-1", "mongo.query.read"), '{"collection":"orders","operation":"count"}'),
      { kind: "tool-completed", atMs: 3, stepId: "s2", artifact: artifact("profile-1", "mongo.table.profile") },
    ];
    const outcome = presentAnswerTool(
      h.context,
      { runId: "run-1", events, autoExecute: false },
      { artifact: "profile-1", presentation: { kind: "table" } },
    );
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("ANSWER_NOT_A_DATA_READ");
    expect(outcome.kind === "unavailable" && outcome.detail).toBe("this run already read read-1, present that");
    expect(outcome.modelText).toEndWith(" (this run already read read-1, present that)");
  });

  test("a plan is refused as returning none of the command's documents, never as a command that ran nothing", () => {
    // With several candidate plans the engine tries each for a bounded trial, so the SQL sentence, that a plan
    // describes a statement without running it, would contradict the inspect_plan description this run holds.
    const plan = drafted("s1", artifact("plan-1", "mongo.plan.estimate"), '{"collection":"orders","operation":"find"}');
    const outcome = presentAnswerTool(
      harness({ workflowType: "data-analysis" }).context,
      { runId: "run-1", events: plan, autoExecute: false },
      { artifact: "plan-1", presentation: { kind: "table" } },
    );
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "ANSWER_NOT_A_DATA_READ" });
    expect(outcome.modelText).toBe(
      "That result is this run's, and it holds none of the documents a read returns, so it cannot be the answer: a plan returns none of the command's documents, and a profile returns counts the server composed about a collection. Present the result of a run_read_query you drafted, and run the read first if you have not. A plan or a profile can still be cited as evidence in your report.",
    );

    // A SQL run's plan is still told the shared sentence.
    const sqlPlan = drafted("s1", artifact("plan-1", "sql.explain.estimate"), "SELECT * FROM orders");
    const sql = presentAnswerTool(
      harness({ workflowType: "data-analysis", statementLanguage: "sql" }).context,
      { runId: "run-1", events: sqlPlan, autoExecute: false },
      { artifact: "plan-1", presentation: { kind: "table" } },
    );
    expect(sql.modelText).toContain("a plan DESCRIBES a statement without running it");
  });

  test("the description says what keeps a plan and a profile from being the answer, in commands and collections", () => {
    const definition = agentToolDefinition("mongo", "data-analysis", "present_answer");
    expect(definition.description).toBe(
      `Record that one result you have already read IS the answer, and how it should be shown. Only a result of a run_read_query you drafted can be the answer: a plan returns none of the command's documents and a profile returns counts about a collection, so neither may be presented; both may still be cited as evidence. Pass the artifact id that read reported; the command behind it comes from this run's own ledger, so you do not supply it. The columns a chart names are checked against that result's real columns and refused if they do not match. Your report must then cite this same artifact in at least one claim: the presentation shows the result and the claims say what it means, so a report resting on other evidence entirely leaves the run scored as not having answered. ${AGENT_ANSWER_CONTRACT}`,
    );
    // What is presented is an artifact id and a presentation in every language, so the schema is the one tool's; and a
    // SQL run is offered the shared definition unchanged.
    expect(definition.inputSchema).toBe(AGENT_TOOL_DEFINITIONS.present_answer.inputSchema);
    expect(agentToolDefinition("sql", "data-analysis", "present_answer")).toBe(AGENT_TOOL_DEFINITIONS.present_answer);
  });

  test("a run holding only a plan holds nothing presentable", () => {
    const events = drafted(
      "s1",
      artifact("plan-1", "mongo.plan.estimate"),
      '{"collection":"orders","operation":"find"}',
    );
    expect(presentableArtifact(events)).toBeUndefined();
  });
});
