/**
 * The MongoDB agent read (issue #1614): the deadline the provider owns, the read streamed under the row and byte
 * budgets, the one builder execute and explain share, and the database a run is bound to.
 *
 * Driven through a client of this file's own that answers from plain documents, with the REAL driver's BSON: a raw
 * cursor yields each document's real bytes, so what is counted, what is decoded and what is served are the provider's
 * own work on the bytes a server sends. The client records every call, so each assertion is about what the read sent,
 * and a read can be held in flight until the session is killed, settled after the kill, or never settled at all.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as mongodbDriver from "mongodb";
import { Binary, Decimal128, Long, ObjectId, UUID, type MongoClient } from "mongodb";
import { ConnectionError, QueryError, mapDatabaseError } from "@/lib/db/errors";
import {
  AGENT_COMMAND_COMMENT,
  AGENT_DEADLINE_BACKSTOP_MS,
  AGENT_KILL_GRACE_MS,
  distinctCommand,
  openBoundedRead,
  planOnly,
  readMongoForAgent,
  runUnderAgentDeadline,
  sampleWithinBudget,
} from "@/lib/db/providers/document/mongodb/agent-read";
import type { RevivedMongoReadEnvelope } from "@/lib/db/providers/document/mongodb/extended-json";
import { serializeMongoDocument } from "@/lib/db/providers/document/mongodb/values";
import { MAX_STATEMENT_TIMEOUT_MS } from "@/lib/db/providers/sql/read-only-budget";
import { AGENT_HANDOVER_BUDGET } from "@/lib/agent/execution-policy";
import { rowBudgetIn } from "@/lib/agent/context-snapshot";
import { classifyReadQueryFailure } from "@/lib/mcp/tools/read-query-limits";

type Doc = Record<string, unknown>;

// The BSON parser and writer, through the namespace for the reason the provider's `index.ts` gives: bun does not see
// `BSON` as a named export of the driver.
const { BSON } = mongodbDriver;

/** How the client answers a read. */
interface Behaviour {
  /** The documents a cursor serves, cut at its `limit`. */
  documents?: Doc[];
  /** The read never settles on its own: it ends only if the kill ends it, as `killed` says. */
  hang?: boolean;
  /** What a hung read does when its session is killed: rejects with code 11601, answers, or stays silent. */
  killed?: "interrupted" | "answers" | "silent";
  /** The read fails at once with this error. */
  error?: Error;
  /** The kill itself fails with this error. */
  killError?: Error;
  /** How long a read takes before it answers, in ms. */
  delayMs?: number;
  /** What a `distinct` command answers. */
  values?: unknown[];
  /** What an explain answers. */
  plan?: Doc;
}

interface Opened {
  readonly kind: "find" | "aggregate";
  readonly database: string;
  readonly collection: string;
  readonly target: Doc | Doc[];
  readonly options: Doc;
  pulled: number;
  closes: number;
  explained?: unknown;
}

interface Sent {
  readonly database: string;
  readonly command: Doc;
  readonly options?: Doc;
}

const serverError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code, name: "MongoServerError" });
const transportError = (name: string): Error => Object.assign(new Error(`${name}: the socket closed`), { name });

/** A client answering from `behaviour`, recording every cursor, command and session. */
function fakeClient(behaviour: Behaviour = {}) {
  const opened: Opened[] = [];
  const sent: Sent[] = [];
  const sessions: { id: { id: string }; ended: boolean }[] = [];
  let killed: () => void = () => undefined;
  const whenKilled = new Promise<void>((resolve) => {
    killed = resolve;
  });

  /** One read's answer, after its delay, its hang or its failure. */
  async function settle<T>(answer: () => T): Promise<T> {
    if (behaviour.error !== undefined) throw behaviour.error;
    if (behaviour.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
    if (behaviour.hang === true) {
      await whenKilled;
      if (behaviour.killed === "interrupted") throw serverError(11601, "operation was interrupted");
      if (behaviour.killed !== "answers") await new Promise(() => undefined);
    }
    return answer();
  }

  const cursor = (record: Opened) => {
    opened.push(record);
    const served = () => {
      const limit = record.options.limit;
      const all = behaviour.documents ?? [];
      return typeof limit === "number" ? all.slice(0, limit) : all;
    };
    return {
      next: () =>
        settle(() => {
          const document = served()[record.pulled];
          if (document === undefined) return null;
          record.pulled += 1;
          return record.options.raw === true ? Buffer.from(BSON.serialize(document)) : document;
        }),
      close: async () => {
        record.closes += 1;
      },
      explain: (options: unknown) => {
        record.explained = options;
        return settle(() => behaviour.plan ?? { queryPlanner: { winningPlan: { stage: "COLLSCAN" } }, ok: 1 });
      },
    };
  };

  const client = {
    startSession: () => {
      const session = { id: { id: `session-${sessions.length + 1}` }, ended: false };
      sessions.push(session);
      return {
        id: session.id,
        endSession: async () => {
          session.ended = true;
        },
      };
    },
    db: (database: string) => ({
      collection: (collection: string) => ({
        find: (filter: Doc, options: Doc) =>
          cursor({ kind: "find", database, collection, target: filter, options, pulled: 0, closes: 0 }),
        aggregate: (pipeline: Doc[], options: Doc) =>
          cursor({ kind: "aggregate", database, collection, target: pipeline, options, pulled: 0, closes: 0 }),
      }),
      command: async (command: Doc, options?: Doc) => {
        sent.push({ database, command, ...(options === undefined ? {} : { options }) });
        if (command.killSessions !== undefined) {
          if (behaviour.killError !== undefined) throw behaviour.killError;
          killed();
          return { ok: 1 };
        }
        if (command.explain !== undefined) return settle(() => behaviour.plan ?? { queryPlanner: {}, ok: 1 });
        return settle(() => (behaviour.values === undefined ? { ok: 1 } : { values: behaviour.values, ok: 1 }));
      },
    }),
  } as unknown as MongoClient;
  return { client, opened, sent, sessions };
}

const BUDGET = { statementTimeoutMs: 5000, maxResultRows: 10, maxResultBytes: 512 * 1024 };
const FAST = { backstopMs: 10, graceMs: 10 };
const statement = (envelope: Doc) => JSON.stringify(envelope);

const FIND: RevivedMongoReadEnvelope = {
  collection: "orders",
  operation: "find",
  filter: { status: "shipped" },
  options: { projection: { total: 1 }, sort: { total: -1 }, skip: 2, limit: 50 },
};
const FIND_ONE: RevivedMongoReadEnvelope = {
  collection: "orders",
  operation: "findOne",
  filter: { status: "shipped" },
  options: { projection: { total: 1 } },
};
const AGGREGATE: RevivedMongoReadEnvelope = {
  collection: "orders",
  operation: "aggregate",
  pipeline: [{ $match: { status: "shipped" } }, { $group: { _id: "$customer", n: { $sum: 1 } } }],
};
const COUNT: RevivedMongoReadEnvelope = { collection: "orders", operation: "count", filter: { status: "shipped" } };
const DISTINCT: RevivedMongoReadEnvelope = {
  collection: "orders",
  operation: "distinct",
  field: "customer",
  filter: { status: "shipped" },
};

/** One read through the provider's own entry point, with fast deadline seams. */
const read = (
  client: MongoClient,
  envelope: RevivedMongoReadEnvelope,
  mode: "execute" | "estimate-plan" = "execute",
  budget = BUDGET,
) => readMongoForAgent(client, "app", envelope, budget, mode, statement(envelope as Doc), FAST);

/** The error a promise rejects with. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

afterEach(() => {
  BSON_DESERIALIZE.mockClear();
});
const BSON_DESERIALIZE = spyOn(BSON, "deserialize");

describe("the one builder", () => {
  test("each read is the command it names, bounded one row past the budget server-side", () => {
    const { client, opened } = fakeClient();
    const collection = client.db("app").collection("orders");
    const options = { session: { id: "s" }, maxTimeMS: 5000, comment: AGENT_COMMAND_COMMENT, raw: true, batchSize: 11 };
    const shapes = [FIND, FIND_ONE, AGGREGATE, COUNT].map(
      (envelope) => openBoundedRead(collection, envelope, BUDGET, options as never).kind,
    );
    expect(shapes).toEqual(["cursor", "cursor", "cursor", "cursor"]);
    const common = { session: { id: "s" }, maxTimeMS: 5000, comment: AGENT_COMMAND_COMMENT, raw: true, batchSize: 11 };
    expect(opened.map(({ kind, target, options: given }) => ({ kind, target, given }))).toEqual([
      {
        kind: "find",
        target: { status: "shipped" },
        // The envelope's own limit is larger than one past the budget, so the budget's bound is sent.
        given: { projection: { total: 1 }, sort: { total: -1 }, skip: 2, limit: 11, ...common },
      },
      { kind: "find", target: { status: "shipped" }, given: { projection: { total: 1 }, limit: 1, ...common } },
      {
        kind: "aggregate",
        target: [{ $match: { status: "shipped" } }, { $group: { _id: "$customer", n: { $sum: 1 } } }, { $limit: 11 }],
        given: common,
      },
      // A count is the pipeline the driver's countDocuments sends, never the count command.
      {
        kind: "aggregate",
        target: [{ $match: { status: "shipped" } }, { $group: { _id: 1, n: { $sum: 1 } } }],
        given: common,
      },
    ]);
    expect(openBoundedRead(collection, DISTINCT, BUDGET, options as never)).toEqual({
      kind: "command",
      command: { distinct: "orders", key: "customer", query: { status: "shipped" } },
    });
  });

  test("a find's own limit is sent when it is the smaller, and an absent filter is an empty one", () => {
    const { client, opened } = fakeClient();
    const collection = client.db("app").collection("orders");
    openBoundedRead(
      collection,
      { collection: "orders", operation: "find", options: { limit: 3 } },
      BUDGET,
      {} as never,
    );
    openBoundedRead(collection, { collection: "orders", operation: "find" }, BUDGET, {} as never);
    openBoundedRead(collection, { collection: "orders", operation: "count" }, BUDGET, {} as never);
    expect(opened.map(({ target, options }) => ({ target, limit: options.limit }))).toEqual([
      { target: {}, limit: 3 },
      { target: {}, limit: 11 },
      { target: [{ $match: {} }, { $group: { _id: 1, n: { $sum: 1 } } }], limit: undefined },
    ]);
    expect(distinctCommand({ collection: "orders", operation: "distinct", field: "x" })).toEqual({
      distinct: "orders",
      key: "x",
      query: {},
    });
  });

  test("for each of the five reads, the command explained is the command executed", async () => {
    for (const envelope of [FIND, FIND_ONE, AGGREGATE, COUNT]) {
      const executed = fakeClient({ documents: [] });
      await read(executed.client, envelope);
      const explained = fakeClient();
      await read(explained.client, envelope, "estimate-plan");
      const [run] = executed.opened;
      const [plan] = explained.opened;
      // The two differ in how the reply is read and in the session each ran in, nothing else.
      const sent = ({ raw, session, ...rest }: Doc) => ({ rest, raw, session: session !== undefined });
      expect([run.kind, run.target, sent(run.options).rest]).toEqual([plan.kind, plan.target, sent(plan.options).rest]);
      expect([sent(run.options).raw, sent(plan.options).raw]).toEqual([true, false]);
      expect([sent(run.options).session, sent(plan.options).session]).toEqual([true, true]);
      // Planned under the same server deadline, at the top of the explain command where 8.3.11 and 7.0.43 read it.
      expect(plan.explained).toEqual({ verbosity: "queryPlanner", maxTimeMS: 5000 });
    }
    const executed = fakeClient({ values: ["Ada"] });
    await read(executed.client, DISTINCT);
    const explained = fakeClient();
    await read(explained.client, DISTINCT, "estimate-plan");
    const { maxTimeMS, comment, ...run } = executed.sent[0].command;
    expect([maxTimeMS, comment]).toEqual([5000, AGENT_COMMAND_COMMENT]);
    expect(explained.sent[0].command).toEqual({
      explain: run,
      verbosity: "queryPlanner",
      maxTimeMS: 5000,
      comment: AGENT_COMMAND_COMMENT,
    });
  });

  test("a count's plan is the $group the read runs, never the count command", async () => {
    const { client, opened, sent } = fakeClient();
    await read(client, COUNT, "estimate-plan");
    expect(opened[0].kind).toBe("aggregate");
    expect(JSON.stringify(opened[0].target)).toContain('"$group"');
    expect(sent.filter(({ command }) => command.explain !== undefined)).toEqual([]);
  });
});

describe("planOnly", () => {
  /** What a server answers beside the plan at the top level of every explain reply. */
  const SERVER_SPEAKING = {
    command: { find: "orders", filter: { ok: 1, command: "x" } },
    serverInfo: { host: "h0", port: 27017, version: "9.0.4", gitVersion: "64ade602" },
    serverParameters: { internalQueryFacetBufferSizeBytes: 104857600 },
    ok: 1,
    $clusterTime: { clusterTime: 1 },
    operationTime: 1,
  };

  test("keeps the plan as the server wrote it, where it echoes the command's field names, whatever they are", () => {
    // The shapes 9.0.4, 8.3.11 and 7.0.43 answer for field names chosen to collide with the server's own (measured):
    // the names come back in the parsed query, a stage's filter, projection and sort, an index's key pattern, multikey
    // paths and bounds, and an aggregate's stages, and the server's own keys only at the top level.
    const find = {
      explainVersion: "1",
      queryPlanner: {
        namespace: "app.orders",
        parsedQuery: { ok: { $eq: 1 }, command: { $eq: "x" }, _id: { $eq: new ObjectId("65f0a1b2c3d4e5f6a7b8c9d0") } },
        winningPlan: {
          stage: "PROJECTION_SIMPLE",
          transformBy: { ok: true, serverInfo: true },
          inputStage: {
            stage: "SORT",
            sortPattern: { connectionString: 1, ok: -1 },
            inputStage: {
              stage: "FETCH",
              filter: { $and: [{ operationTime: { $eq: 5 } }, { serverParameters: { $eq: "s" } }] },
              inputStage: {
                stage: "IXSCAN",
                keyPattern: { ok: 1 },
                indexName: "ok_1",
                multiKeyPaths: { ok: [] },
                indexBounds: { ok: ["[1, 1]"] },
              },
            },
          },
        },
        rejectedPlans: [],
      },
      queryShapeHash: "ABC",
      ...SERVER_SPEAKING,
    };
    const plan = planOnly(find);
    expect(plan).toEqual({ explainVersion: "1", queryPlanner: find.queryPlanner });
    // A BSON value in the plan stays the value it is.
    expect((plan.queryPlanner as { parsedQuery: { _id: { $eq: unknown } } }).parsedQuery._id.$eq).toBeInstanceOf(
      ObjectId,
    );
    const aggregate = {
      explainVersion: "2",
      stages: [
        { $cursor: { queryPlanner: { parsedQuery: { serverInfo: { $gte: 0 } }, winningPlan: { stage: "COLLSCAN" } } } },
        { $group: { _id: "$command", serverInfo: { $sum: { $const: 1 } }, ok: { $max: "$ok" } } },
        { $project: { _id: true, serverParameters: "$serverInfo", ok: true } },
        { $sort: { sortKey: { serverParameters: -1 } } },
        { $facet: { connectionString: [{ $match: { ok: { $eq: 1 } } }] } },
        // A stage may hold a string `stage` beside a `shards` list of its own: echoed verbatim (measured).
        { $addFields: { stage: "$c", shards: [{ connectionString: "$c", serverInfo: "$c" }] } },
        // An unsharded $unionWith explains its pipeline as a list of stages (measured).
        {
          $unionWith: { coll: "u", pipeline: [{ $cursor: { queryPlanner: { parsedQuery: { host: { $eq: "a" } } } } }] },
        },
        { $limit: 11 },
      ],
      ...SERVER_SPEAKING,
    };
    expect(planOnly(aggregate)).toEqual({ explainVersion: "2", stages: aggregate.stages });
  });

  test("drops what the server says about itself, and the address of each shard a sharded plan names", () => {
    // The sharded shapes, as the server's 9.0.4 source writes them (`ClusterExplain::buildPlannerInfo`,
    // `mergeExplainOutputFromShards`): a find's plan lists its shards, each with its connection string and server; a
    // split pipeline answers each shard's plan under `shards`, each with its host, at the top level of an aggregate's
    // reply and as the explained pipeline of a $unionWith that reads a sharded collection.
    const shardedFind = {
      queryPlanner: {
        winningPlan: {
          stage: "SHARD_MERGE",
          shards: [
            {
              explainVersion: "1",
              shardName: "a",
              connectionString: "a/h1:27018,h2:27018",
              serverInfo: { host: "h1", port: 27018 },
              parsedQuery: { connectionString: { $eq: "kept" } },
              winningPlan: { stage: "COLLSCAN" },
              rejectedPlans: [],
            },
          ],
        },
      },
      ...SERVER_SPEAKING,
    };
    expect(planOnly(shardedFind)).toEqual({
      queryPlanner: {
        winningPlan: {
          stage: "SHARD_MERGE",
          shards: [
            {
              explainVersion: "1",
              shardName: "a",
              parsedQuery: { connectionString: { $eq: "kept" } },
              winningPlan: { stage: "COLLSCAN" },
              rejectedPlans: [],
            },
          ],
        },
      },
    });
    const shardStages = [{ $cursor: { queryPlanner: { parsedQuery: { host: { $eq: "kept" } } } } }];
    const split = {
      mergeType: "anyShard",
      splitPipeline: { shardsPart: [{ $match: { host: { $eq: "kept" } } }], mergerPart: [{ $limit: 11 }] },
      shards: { b: { host: "h2:27018", explainVersion: "2", stages: shardStages } },
    };
    const shardedAggregate = {
      mergeType: "anyShard",
      mergeShardId: "a",
      splitPipeline: { shardsPart: [{ $match: { host: { $eq: "kept" } } }], mergerPart: [{ $limit: 11 }] },
      shards: {
        a: {
          host: "h1:27018",
          explainVersion: "2",
          stages: [...shardStages, { $unionWith: { coll: "u", pipeline: split } }],
        },
      },
      ...SERVER_SPEAKING,
    };
    expect(planOnly(shardedAggregate)).toEqual({
      mergeType: "anyShard",
      mergeShardId: "a",
      splitPipeline: shardedAggregate.splitPipeline,
      shards: {
        a: {
          explainVersion: "2",
          stages: [
            ...shardStages,
            {
              $unionWith: {
                coll: "u",
                pipeline: { ...split, shards: { b: { explainVersion: "2", stages: shardStages } } },
              },
            },
          ],
        },
      },
    });
    // A copy: the reply is not changed.
    expect(shardedFind.queryPlanner.winningPlan.shards[0].serverInfo).toEqual({ host: "h1", port: 27018 });
    expect([shardedAggregate.shards.a.host, split.shards.b.host]).toEqual(["h1:27018", "h2:27018"]);
  });

  test("an estimating read answers the plan alone as its one row", async () => {
    const { client } = fakeClient({
      plan: { queryPlanner: { winningPlan: { stage: "IXSCAN" } }, serverInfo: { host: "h" }, command: {}, ok: 1 },
    });
    const result = await read(client, FIND, "estimate-plan");
    expect(result.rows).toEqual([{ queryPlanner: { winningPlan: { stage: "IXSCAN" } } }]);
    expect(result.fields).toEqual(["queryPlanner"]);
  });
});

describe("the streamed read", () => {
  test("rows past the budget are refused on the crossing row, which is never decoded", async () => {
    const documents = Array.from({ length: 40 }, (_, i) => ({ i }));
    const { client, opened } = fakeClient({ documents });
    const error = await rejection(read(client, FIND));
    expect(error).toBeInstanceOf(QueryError);
    // A cursor read stops one row past the budget, so the count is that bound and the sentence says the total is unknown.
    expect((error as Error).message).toBe(
      'Read-only execution exceeded the row budget: 11 rows > 10 allowed; the read stops one row past the budget, so at least 11 documents match and the total is not known (count it with "operation": "count", or narrow the read)',
    );
    // The sentence round-trips through the reader the run uses for its row-budget advice.
    expect(rowBudgetIn((error as Error).message)).toEqual({ projected: 11, allowed: 10 });
    expect(opened[0].pulled).toBe(11);
    expect(opened[0].closes).toBe(1);
    expect(BSON_DESERIALIZE).toHaveBeenCalledTimes(10);
  });

  test("exactly the budget is admitted, and one past it refused", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    const admitted = await read(fakeClient({ documents: rows(10) }).client, AGGREGATE);
    expect(admitted.rowCount).toBe(10);
    const refused = await rejection(read(fakeClient({ documents: rows(11) }).client, AGGREGATE));
    expect((refused as Error).message).toContain("11 rows > 10 allowed");
  });

  test("bytes are counted as each document's BSON before it is decoded, and the crossing one is not decoded", async () => {
    const documents = Array.from({ length: 8 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
    const size = BSON.calculateObjectSize(documents[0]);
    const { client, opened } = fakeClient({ documents });
    const budget = { ...BUDGET, maxResultBytes: size * 4 + 1 };
    const error = await rejection(read(client, FIND, "execute", budget));
    expect((error as Error).message).toBe(
      `Read-only execution exceeded the byte budget: ${size * 5} bytes > ${size * 4 + 1} allowed`,
    );
    // MCP's run_read_query reads this very refusal as too large, not as an engine error.
    expect(classifyReadQueryFailure(error, 0, 1)).toMatchObject({
      kind: "too-large",
      text: expect.stringContaining("larger than 1 MiB"),
    });
    expect(opened[0].pulled).toBe(5);
    expect(opened[0].closes).toBe(1);
    expect(BSON_DESERIALIZE).toHaveBeenCalledTimes(4);
  });

  test("a 220,000-byte Binary row is served on a 262,144-byte budget: its BSON is what is counted", async () => {
    const { client } = fakeClient({ documents: [{ _id: 1, blob: new Binary(Buffer.alloc(220_000)) }] });
    const result = await read(client, FIND, "execute", { ...BUDGET, maxResultBytes: 262_144 });
    expect(result.rows).toEqual([{ _id: 1, blob: "<Binary: 220000 bytes>" }]);
  });

  test("a decoded row is the editor's row: the driver's default decode, then the same serializer", async () => {
    const document = {
      _id: new ObjectId("65f0a1b2c3d4e5f6a7b8c9d0"),
      at: new Date("2026-10-17T00:00:00Z"),
      big: Long.fromString("9007199254740993"),
      small: Long.fromNumber(5),
      price: Decimal128.fromString("12.50"),
      bytes: new Binary(Buffer.from("abc")),
      uuid: new UUID("0f8fad5b-d9cb-469f-a165-70867728950e"),
    };
    const { client } = fakeClient({ documents: [document] });
    const result = await read(client, FIND);
    expect(result.rows).toEqual([serializeMongoDocument(BSON.deserialize(BSON.serialize(document)))]);
    expect(result.rows[0]).toEqual({
      _id: "65f0a1b2c3d4e5f6a7b8c9d0",
      at: "2026-10-17T00:00:00.000Z",
      big: "9007199254740993",
      small: 5,
      price: "12.50",
      bytes: "<Binary: 3 bytes>",
      uuid: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
  });

  test("columns are every row's keys, first seen first, and an empty key is named", async () => {
    const { client } = fakeClient({ documents: [{ a: 1 }, { "": "blank", b: 2 }] });
    const result = await read(client, FIND);
    expect(result.fields).toEqual(["a", "(No column name)", "b"]);
    expect(result.rows).toEqual([{ a: 1 }, { "(No column name)": "blank", b: 2 }]);
  });

  test("a count answers its number, and 0 when the $group answers no document", async () => {
    expect((await read(fakeClient({ documents: [{ _id: 1, n: 7 }] }).client, COUNT)).rows).toEqual([{ count: 7 }]);
    expect((await read(fakeClient({ documents: [] }).client, COUNT)).rows).toEqual([{ count: 0 }]);
  });

  test("a findOne that matches nothing answers no rows", async () => {
    const result = await read(fakeClient({ documents: [] }).client, FIND_ONE);
    expect(result.rowCount).toBe(0);
    expect(result.fields).toEqual([]);
  });

  test("a distinct is one reply, refused past the row budget before any row is built, and past the byte budget", async () => {
    const values = await read(fakeClient({ values: ["Ada", "Grace"] }).client, DISTINCT);
    expect(values.rows).toEqual([{ customer: "Ada" }, { customer: "Grace" }]);
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const tooMany = await rejection(read(fakeClient({ values: many }).client, DISTINCT));
    expect((tooMany as Error).message).toBe("Read-only execution exceeded the row budget: 30 rows > 10 allowed");
    const wide = ["x".repeat(600), "y".repeat(600)];
    const rowBytes = BSON.calculateObjectSize({ customer: wide[0] });
    const tooWide = await rejection(
      read(fakeClient({ values: wide }).client, DISTINCT, "execute", { ...BUDGET, maxResultBytes: rowBytes + 10 }),
    );
    expect((tooWide as Error).message).toBe(
      `Read-only execution exceeded the byte budget: ${rowBytes * 2} bytes > ${rowBytes + 10} allowed`,
    );
  });

  test("a distinct reply with no list of values is the server's fault, said as such", async () => {
    const error = await rejection(read(fakeClient().client, DISTINCT));
    expect((error as Error).message).toBe("The server answered the distinct with no list of values");
  });

  test("an invalid budget is refused before anything is sent", async () => {
    const { client, sessions } = fakeClient();
    for (const budget of [
      { ...BUDGET, maxResultRows: 0 },
      { ...BUDGET, statementTimeoutMs: Number.NaN },
    ]) {
      expect(await rejection(read(client, FIND, "execute", budget))).toBeInstanceOf(QueryError);
    }
    expect(sessions).toEqual([]);
  });
});

describe("sampleWithinBudget", () => {
  /** A raw find cursor over `documents`, through the fake client. */
  const sampleCursor = (documents: Doc[]) => {
    const { client, opened } = fakeClient({ documents });
    const cursor = client.db("app").collection("orders").find({}, { raw: true, limit: 100 });
    return { cursor, record: () => opened[0] };
  };

  test("decodes every document that fits the byte budget, and closes the cursor", async () => {
    const { cursor, record } = sampleCursor([{ a: 1 }, { b: new ObjectId("65f0a1b2c3d4e5f6a7b8c9d0") }]);
    const sample = await sampleWithinBudget(cursor, BUDGET, "s");
    expect(sample).toEqual([{ a: 1 }, { b: new ObjectId("65f0a1b2c3d4e5f6a7b8c9d0") }]);
    expect(record()).toMatchObject({ pulled: 2, closes: 1 });
  });

  test("stops before the document whose bytes would cross the budget, never decoding it", async () => {
    const documents = Array.from({ length: 5 }, (_, i) => ({ i, pad: "x".repeat(300) }));
    const size = BSON.calculateObjectSize(documents[0]);
    const { cursor, record } = sampleCursor(documents);
    const sample = await sampleWithinBudget(cursor, { ...BUDGET, maxResultBytes: size * 2 + 1 }, "s");
    expect(sample).toHaveLength(2);
    expect(record()).toMatchObject({ pulled: 3, closes: 1 });
    expect(BSON_DESERIALIZE).toHaveBeenCalledTimes(2);
  });

  test("refuses when the first document alone crosses the budget: nothing honest is left to infer from", async () => {
    const { cursor, record } = sampleCursor([{ pad: "x".repeat(300) }]);
    const error = await rejection(sampleWithinBudget(cursor, { ...BUDGET, maxResultBytes: 100 }, "s"));
    expect((error as Error).message).toMatch(/^Read-only execution exceeded the byte budget: \d+ bytes > 100 allowed$/);
    expect(record().closes).toBe(1);
    expect(BSON_DESERIALIZE).not.toHaveBeenCalled();
  });
});

describe("the database a run is bound to", () => {
  test("a command naming another database is refused before anything is sent, naming the bound one", async () => {
    const { client, opened, sessions } = fakeClient();
    const other = { ...FIND, database: "reporting" } as RevivedMongoReadEnvelope;
    const error = await rejection(read(client, other));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      'This run reads the database "app" its connection is bound to, and "database": "reporting" names another, so nothing was sent. Drop the key or name "app".',
    );
    expect([opened, sessions]).toEqual([[], []]);
  });

  test("a command naming the bound database is read there, and one naming none is read there too", async () => {
    const { client, opened } = fakeClient({ documents: [] });
    await read(client, { ...FIND, database: "app" } as RevivedMongoReadEnvelope);
    await read(client, FIND);
    expect(opened.map(({ database }) => database)).toEqual(["app", "app"]);
  });
});

describe("the owned deadline", () => {
  test("every call carries the session, the server deadline and the agent's comment, in batches of at most 100", async () => {
    for (const envelope of [FIND, FIND_ONE, AGGREGATE, COUNT]) {
      for (const mode of ["execute", "estimate-plan"] as const) {
        const { client, opened, sessions } = fakeClient({ documents: [] });
        await read(client, envelope, mode);
        expect(opened[0].options).toMatchObject({ maxTimeMS: 5000, comment: AGENT_COMMAND_COMMENT });
        expect((opened[0].options.session as { id: unknown }).id).toEqual(sessions[0].id);
        expect(sessions[0].ended).toBe(true);
        // One batch holds the row bound when it fits: one past the budget, which is 10 rows here.
        expect(opened[0].options.batchSize).toBe(Math.min(BUDGET.maxResultRows + 1, 100));
      }
    }
    // A larger budget is read in batches of 100, never in one batch of its whole bound.
    const wide = fakeClient({ documents: [] });
    await read(wide.client, FIND, "execute", { ...BUDGET, maxResultRows: 500 });
    expect(wide.opened[0].options).toMatchObject({ batchSize: 100, limit: 50 });
    for (const mode of ["execute", "estimate-plan"] as const) {
      const { client, sent, sessions } = fakeClient({ values: [] });
      await read(client, DISTINCT, mode);
      expect(sent[0].command).toMatchObject({ maxTimeMS: 5000, comment: AGENT_COMMAND_COMMENT });
      expect(sent[0].options).toMatchObject({ session: { id: sessions[0].id } });
    }
  });

  test("a server that stays silent is killed by session, its cursor closed, and the client stops waiting", async () => {
    const { client, opened, sent, sessions } = fakeClient({ documents: [{ a: 1 }], hang: true, killed: "silent" });
    const budget = { ...BUDGET, statementTimeoutMs: 20 };
    const started = Date.now();
    const error = await rejection(read(client, FIND, "execute", budget));
    expect(Date.now() - started).toBeLessThan(200);
    expect((error as Error).message).toBe(
      "Read-only execution exceeded the statement deadline of 20ms and the server did not end it, so the client stopped waiting",
    );
    const kills = sent.filter(({ command }) => command.killSessions !== undefined);
    expect(kills).toEqual([
      { database: "admin", command: { killSessions: [sessions[0].id], comment: AGENT_COMMAND_COMMENT } },
    ]);
    expect(opened[0].closes).toBe(1);
    expect(sessions[0].ended).toBe(true);
  });

  test("a read the kill ends, or one that answers after the kill, is the statement deadline, killed server-side", async () => {
    for (const killed of ["interrupted", "answers"] as const) {
      const { client } = fakeClient({ documents: [{ a: 1 }], hang: true, killed });
      const error = await rejection(read(client, FIND, "execute", { ...BUDGET, statementTimeoutMs: 20 }));
      expect((error as Error).message).toBe(
        "Read-only execution exceeded the statement deadline of 20ms and was killed server-side",
      );
    }
  });

  test("a plan's cursor, which its explain never opens, is closed once the plan settles; the kill alone ends a hung one", async () => {
    const plans = [FIND, FIND_ONE, AGGREGATE, COUNT].map((envelope) => ({ envelope, fake: fakeClient() }));
    await Promise.all(plans.map(({ envelope, fake }) => read(fake.client, envelope, "estimate-plan")));
    for (const { fake } of plans) expect(fake.opened[0].closes).toBe(1);
    const failed = fakeClient({ error: serverError(2, "BadValue") });
    await rejection(read(failed.client, FIND, "estimate-plan"));
    expect(failed.opened[0].closes).toBe(1);
    const hung = fakeClient({ hang: true, killed: "interrupted" });
    const error = await rejection(read(hung.client, FIND, "estimate-plan", { ...BUDGET, statementTimeoutMs: 20 }));
    expect((error as Error).message).toBe(
      "Read-only execution exceeded the statement deadline of 20ms and was killed server-side",
    );
    expect(hung.sent.filter(({ command }) => command.killSessions !== undefined)).toHaveLength(1);
    expect(hung.opened[0].closes).toBe(1);
  });

  test("the server's own deadline (code 50) is the statement deadline, and nothing is killed", async () => {
    const { client, sent } = fakeClient({ error: serverError(50, "operation exceeded time limit") });
    const error = await rejection(read(client, FIND));
    expect((error as Error).message).toBe(
      "Read-only execution exceeded the statement deadline of 5000ms and was killed server-side",
    );
    expect(sent).toEqual([]);
  });

  test("a transport failure the driver reports is a connection failure, from the read or from the kill, never a statement fault", async () => {
    for (const name of ["MongoNetworkError", "MongoNetworkTimeoutError", "MongoServerSelectionError"]) {
      const fromRead = await rejection(read(fakeClient({ error: transportError(name) }).client, FIND));
      expect(fromRead).toBeInstanceOf(ConnectionError);
      const fromKill = await rejection(
        read(fakeClient({ hang: true, killed: "silent", killError: transportError(name) }).client, FIND, "execute", {
          ...BUDGET,
          statementTimeoutMs: 20,
        }),
      );
      expect(fromKill).toBeInstanceOf(ConnectionError);
    }
  });

  test("any other failure is the editor's mapping, unchanged", async () => {
    const failure = serverError(2, "BadValue: unknown operator: $nope");
    const error = await rejection(read(fakeClient({ error: failure }).client, FIND));
    const mapped = mapDatabaseError(failure, "mongodb", statement(FIND as Doc));
    expect((error as Error).constructor).toBe(mapped.constructor);
    expect((error as Error).message).toBe(mapped.message);
  });

  test("the backstop is armed past the server's deadline, and never past the timer's 32-bit range", async () => {
    const delays: number[] = [];
    const spy = spyOn(globalThis, "setTimeout");
    spy.mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const { client } = fakeClient({ documents: [] });
      await runUnderAgentDeadline(client, BUDGET, "s", async () => "done");
      await runUnderAgentDeadline(client, AGENT_HANDOVER_BUDGET, "s", async () => "done");
    } finally {
      spy.mockRestore();
    }
    expect(delays).toEqual([5000 + AGENT_DEADLINE_BACKSTOP_MS, MAX_STATEMENT_TIMEOUT_MS]);
    expect([AGENT_DEADLINE_BACKSTOP_MS, AGENT_KILL_GRACE_MS]).toEqual([1000, 1000]);
  });

  test("under the hand-over budget a read that takes 50 ms is served, with no timer overflow", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      const { client } = fakeClient({ documents: [{ a: 1 }], delayMs: 50 });
      const result = await readMongoForAgent(client, "app", FIND, AGENT_HANDOVER_BUDGET, "execute", "s");
      expect(result.rows).toEqual([{ a: 1 }]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).not.toContain("TimeoutOverflowWarning");
  });
});
