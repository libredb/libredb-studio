/**
 * The Milvus object surface, over the fake client of
 * tests/helpers/milvus-catalog-client.ts: one permit per call in flight, the wait for a permit inside the call's
 * deadline, a full queue refused unchanged, the database on every request, one database level whose filtered list
 * reads "visible to this user", and one collection kind listed and counted by one ShowCollections, names only.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, TimeoutError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  countMilvusCollections,
  describeMilvusCollection,
  describeMilvusCollections,
  inBoundedFlight,
  listMilvusCollectionNames,
  listMilvusCollections,
  listMilvusDatabases,
  MILVUS_COLLECTION_KIND,
  MILVUS_CONTAINER_LEVELS,
  MILVUS_DESCRIBE_BATCH,
  MILVUS_FAN_OUT,
  MILVUS_OBJECT_KINDS,
  milvusCause,
  readCollectionIndexes,
  refusedForPrivilege,
  refusedStatusCode,
  surfaceCall,
  surfaceErrorContext,
  unimplementedByServer,
} from "@/lib/db/providers/vector/milvus/objects";
import { collectionColumns } from "@/lib/db/providers/vector/milvus/schema";
import { engineLimiter, LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  failedStatus,
  OK,
  permissionDenied,
  plainCollection,
  settle,
  TEST_ERRORS,
  testSurface,
  unimplemented,
} from "../../../helpers/milvus-catalog-client";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

/** The error a promise rejects with; a promise that resolves fails the test. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
  if (outcome === undefined) throw new Error("expected a rejection");
  return outcome;
}

const CATALOG = {
  databases: {
    default: [
      { describe: plainCollection("zeta") },
      { describe: plainCollection("alpha") },
      { describe: plainCollection("Beta") },
    ],
    probe_db: [{ describe: plainCollection("notes", "probe_db") }],
  },
};

describe("the declarations", () => {
  test("one container level, Database, and one kind, collection", () => {
    expect(MILVUS_CONTAINER_LEVELS).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);
    expect(MILVUS_OBJECT_KINDS).toEqual([
      {
        id: "collection",
        role: "relation",
        label: "Collection",
        labelPlural: "Collections",
        hasColumns: true,
        hasSource: true,
        sourceLanguage: "json",
        countIsListing: true,
      },
    ]);
    expect(MILVUS_COLLECTION_KIND).toBe("collection");
  });

  test("a fan-out of reads keeps at most four in flight, the provider's own bound", () => {
    expect(MILVUS_FAN_OUT).toBe(4);
  });
});

describe("surfaceCall", () => {
  test("sends the database on the call and answers what the client answered", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const answer = await surfaceCall(testSurface(), "listing", { database: "probe_db" }, (o) =>
      client.showCollections(o),
    );
    expect(answer.collection_names).toEqual(["notes"]);
    expectCalls(client, [{ method: "showCollections", args: ["probe_db"] }]);
  });

  test("holds one permit per call in flight: a provider bound of one admits the second call after the first", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const context = testSurface({}, 1);
    const release = client.hold("showCollections");
    const first = surfaceCall(context, "listing", { database: "default" }, (o) => client.showCollections(o));
    const second = surfaceCall(context, "listing", { database: "probe_db" }, (o) => client.showCollections(o));
    await settle();
    expect(client.inFlight()).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(client.maxInFlight()).toBe(1);
    expect(client.calls.map((call) => call.args)).toEqual([["default"], ["probe_db"]]);
  });

  test("a wait that reaches its deadline sends nothing and reads as the deadline", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const limiter = engineLimiter("milvus-objects-deadline", { perProvider: 1, perEngine: 16, queueDepth: 64 })();
    const held = await limiter.acquire(new AbortController().signal);
    const context = testSurface({ limiter, signal: () => AbortSignal.timeout(20) });
    const error = await surfaceCall(context, "listing", { database: "default" }, (o) =>
      client.showCollections(o),
    ).catch((caught: unknown) => caught);
    held.release();
    expect(error).toBeInstanceOf(TimeoutError);
    expect(client.calls).toEqual([]);
  });

  test("a full queue is refused unchanged, with no call", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const limiter = engineLimiter("milvus-objects-full", { perProvider: 1, perEngine: 1, queueDepth: 0 })();
    const held = await limiter.acquire(new AbortController().signal);
    const error = await surfaceCall(testSurface({ limiter }), "listing", { database: "default" }, (o) =>
      client.showCollections(o),
    ).catch((caught: unknown) => caught);
    held.release();
    expect(error).toBeInstanceOf(LimiterFullError);
    expect(client.calls).toEqual([]);
  });

  test("maps a failure through errors.ts and keeps the adapter's classification beside it, never on it", async () => {
    const client = createFakeMilvusClient(CATALOG);
    client.on("showCollections", () => failedStatus(800, "DatabaseNotExist", "database not found[database=gone]"));
    const error = await surfaceCall(testSurface(), "listing", { database: "gone" }, (o) =>
      client.showCollections(o),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toStartWith("Database gone does not exist.");
    expect(refusedStatusCode(error)).toBe(800);
    expect(milvusCause(error)?.category).toBe("status");
    expect(Object.values(error as object)).not.toContainEqual(expect.objectContaining({ category: "status" }));
    expect(refusedForPrivilege(error)).toBe(false);
    expect(unimplementedByServer(error)).toBe(false);
  });

  test("a server text that holds the configured secret is withheld from the sentence", async () => {
    const client = createFakeMilvusClient(CATALOG);
    client.on("showCollections", () => permissionDenied(`Collection for ${TEST_PASSWORD}`));
    const context = testSurface({ secretForms: [TEST_PASSWORD] });
    const error = await rejection(
      surfaceCall(context, "listing", { database: "default" }, (o) => client.showCollections(o)),
    );
    expect(error.message).not.toContain(TEST_PASSWORD);
    expect(error.message).toContain("withheld");
    expect(refusedForPrivilege(error)).toBe(true);
  });

  test("an error that is no MilvusError has no cause, and a gRPC 12 reads as unimplemented", async () => {
    expect(milvusCause(new Error("x"))).toBeUndefined();
    expect(milvusCause("x")).toBeUndefined();
    const client = createFakeMilvusClient(CATALOG);
    client.on("showCollections", () => unimplemented("ShowCollections"));
    const error = await surfaceCall(testSurface(), "listing", { database: "default" }, (o) =>
      client.showCollections(o),
    ).catch((caught: unknown) => caught);
    expect(unimplementedByServer(error)).toBe(true);
  });

  test("surfaceErrorContext names the database, the collection where there is one, and the write flag", () => {
    const context = testSurface({ secretForms: ["s"] });
    expect(surfaceErrorContext(context, "Load of collection c", { database: "d", collection: "c" }, true)).toEqual({
      operation: "Load of collection c",
      write: true,
      database: "d",
      collection: "c",
      connection: TEST_ERRORS,
      secretForms: ["s"],
    });
    expect(surfaceErrorContext(context, "listing", { database: "d" })).toEqual({
      operation: "listing",
      write: false,
      database: "d",
      connection: TEST_ERRORS,
      secretForms: ["s"],
    });
  });
});

describe("inBoundedFlight", () => {
  test("keeps at most the limit in flight and answers in the items' order", async () => {
    let current = 0;
    let most = 0;
    const answers = await inBoundedFlight([1, 2, 3, 4, 5, 6], 4, async (item) => {
      current += 1;
      most = Math.max(most, current);
      await settle();
      current -= 1;
      return item * 10;
    });
    expect(answers).toEqual([10, 20, 30, 40, 50, 60]);
    expect(most).toBe(4);
  });

  test("starts nothing after the first failure and raises it", async () => {
    const started: number[] = [];
    const error = await rejection(
      inBoundedFlight([1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error("second");
        return item;
      }),
    );
    expect(error.message).toBe("second");
    expect(started).toEqual([1, 2]);
  });

  test("an empty list starts nothing", async () => {
    expect(await inBoundedFlight([], 4, async () => 1)).toEqual([]);
  });
});

describe("listMilvusDatabases", () => {
  test("one ListDatabases, sorted by name, the connection's database marked as the session's", async () => {
    const client = createFakeMilvusClient(CATALOG);
    expect(await listMilvusDatabases(client, testSurface({ database: "probe_db" }))).toEqual([
      { path: ["default"], name: "default", level: 0, isSessionDefault: false },
      { path: ["probe_db"], name: "probe_db", level: 0, isSessionDefault: true },
    ]);
    expectCalls(client, ["listDatabases"]);
  });

  test("a list filtered to nothing reads 'visible to this user', never as no databases", async () => {
    const client = createFakeMilvusClient({ databases: {} });
    await expect(listMilvusDatabases(client, testSurface())).rejects.toThrow(
      "Milvus lists no database visible to this Milvus user: a user sees only the databases it holds a privilege on.",
    );
  });
});

describe("the collection listing and its count", () => {
  test("one ShowCollections per database, names only, sorted in the repository's path order", async () => {
    const client = createFakeMilvusClient(CATALOG);
    expect(await listMilvusCollectionNames(client, testSurface(), "default")).toEqual(["Beta", "alpha", "zeta"]);
    expect(await listMilvusCollections(client, testSurface(), "default")).toEqual([
      { path: ["default", "Beta"], name: "Beta", kind: "collection" },
      { path: ["default", "alpha"], name: "alpha", kind: "collection" },
      { path: ["default", "zeta"], name: "zeta", kind: "collection" },
    ]);
    expectCalls(client, [
      { method: "showCollections", args: ["default"] },
      { method: "showCollections", args: ["default"] },
    ]);
  });

  test("the count is the length of the same listing", async () => {
    const client = createFakeMilvusClient(CATALOG);
    expect(await countMilvusCollections(client, testSurface(), "default")).toEqual({ collection: { count: 3 } });
    expectCalls(client, ["showCollections"]);
  });

  test("a listing refused for want of a privilege is the folder's own sentence, never a count of 0", async () => {
    const client = createFakeMilvusClient(CATALOG);
    client.on("showCollections", () => permissionDenied("ShowCollections"));
    const counts = await countMilvusCollections(client, testSurface(), "default");
    expect(counts.collection).toEqual({ unavailable: expect.stringContaining("The Milvus user lacks the privilege") });
  });

  test("any other failure of the count is raised", async () => {
    const client = createFakeMilvusClient(CATALOG);
    await expect(countMilvusCollections(client, testSurface(), "gone")).rejects.toThrow(
      "Database gone does not exist.",
    );
  });

  test("two listings of two databases in flight on one context each reach their own", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const context = testSurface();
    const [left, right] = await Promise.all([
      listMilvusCollectionNames(client, context, "default"),
      listMilvusCollectionNames(client, context, "probe_db"),
    ]);
    expect(left).toEqual(["Beta", "alpha", "zeta"]);
    expect(right).toEqual(["notes"]);
    expect(client.calls.map((call) => call.args?.[0]).sort()).toEqual(["default", "probe_db"]);
  });
});

describe("describeMilvusCollection", () => {
  const catalog = { databases: { default: [{ describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX] }] } };

  test("DescribeCollection then DescribeIndex: schema.ts's columns, an IndexSchema per index, no foreign key", async () => {
    const client = createFakeMilvusClient(catalog);
    expect(await describeMilvusCollection(client, testSurface(), "default", "docs_int64")).toEqual({
      path: ["default", "docs_int64"],
      columns: collectionColumns(DOCS_INT64),
      indexes: [{ name: "vec", columns: ["vec"], unique: false }],
      foreignKeys: [],
    });
    expectCalls(client, [
      { method: "describeCollection", args: ["default", { collection_name: "docs_int64" }] },
      { method: "describeIndex", args: ["default", { collection_name: "docs_int64" }] },
    ]);
  });

  test("no column carries a default value", async () => {
    const client = createFakeMilvusClient(catalog);
    const detail = await describeMilvusCollection(client, testSurface(), "default", "docs_int64");
    expect(detail.columns.every((column) => column.defaultValue === undefined)).toBe(true);
  });

  test("a collection with no index answers 700, which is no index, not an error", async () => {
    const client = createFakeMilvusClient({ databases: { default: [{ describe: DOCS_INT64 }] } });
    expect((await describeMilvusCollection(client, testSurface(), "default", "docs_int64")).indexes).toEqual([]);
    expect(await readCollectionIndexes(client, testSurface(), "default", "docs_int64")).toEqual([]);
  });

  test("an unknown collection is raised with the collection sentence after one DescribeCollection", async () => {
    const client = createFakeMilvusClient(catalog);
    await expect(describeMilvusCollection(client, testSurface(), "default", "gone")).rejects.toThrow(
      "Collection gone does not exist in database default.",
    );
    expectCalls(client, ["describeCollection"]);
  });

  test("a DescribeIndex refused for want of IndexDetail is raised, never shown as no index", async () => {
    const client = createFakeMilvusClient(catalog);
    client.on("describeIndex", () => permissionDenied("IndexDetail"));
    await expect(describeMilvusCollection(client, testSurface(), "default", "docs_int64")).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
  });
});

/** `count` collections named c_000 and up, each a plain one. */
function many(count: number) {
  return Array.from({ length: count }, (_, at) => ({ describe: plainCollection(`c_${String(at).padStart(3, "0")}`) }));
}
const namesOf = (count: number) => Array.from({ length: count }, (_, at) => `c_${String(at).padStart(3, "0")}`);

describe("describeMilvusCollections", () => {
  test("one BatchDescribeCollection for up to 200 names, columns only and no index read", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(200) } });
    const batch = await describeMilvusCollections(client, testSurface(), "default", namesOf(200));
    expect(batch.details).toHaveLength(200);
    expect(batch.details[0]).toEqual({
      path: ["default", "c_000"],
      columns: collectionColumns(plainCollection("c_000")),
      indexes: [],
      foreignKeys: [],
    });
    expect(batch.truncated).toBeUndefined();
    expectCalls(client, ["batchDescribeCollection"]);
    expect(MILVUS_DESCRIBE_BATCH).toBe(200);
  });

  test("two calls for 201 names: 200, then 1", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(201) } });
    const batch = await describeMilvusCollections(client, testSurface(), "default", namesOf(201));
    expect(batch.details).toHaveLength(201);
    const sizes = client.calls.map((call) => {
      const request = call.args?.[1] as { collection_name: string[] } | undefined;
      return request?.collection_name.length;
    });
    expect(sizes).toEqual([200, 1]);
  });

  test("the caller's limit is applied before any call, and truncated names it in the shared sentence", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(5) } });
    const batch = await describeMilvusCollections(client, testSurface(), "default", namesOf(5), 3);
    expect(batch.details.map((detail) => detail.path[1])).toEqual(["c_000", "c_001", "c_002"]);
    expect(batch.truncated).toEqual({ limit: 3, reason: callerBoundTruncationReason(3) });
    expectCalls(client, [
      { method: "batchDescribeCollection", args: ["default", { collection_name: ["c_000", "c_001", "c_002"] }] },
    ]);
  });

  test("a limit at or above the listing truncates nothing", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(2) } });
    expect(
      (await describeMilvusCollections(client, testSurface(), "default", namesOf(2), 2)).truncated,
    ).toBeUndefined();
  });

  test("an empty listing sends nothing", async () => {
    const client = createFakeMilvusClient({ databases: { default: [] } });
    expect(await describeMilvusCollections(client, testSurface(), "default", [])).toEqual({ details: [] });
    expect(client.calls).toEqual([]);
  });

  test("entries are read by position: an alias asked is described under the name asked, never the echoed one", async () => {
    const client = createFakeMilvusClient({ databases: { default: [{ describe: DOCS_INT64 }] } });
    client.on("batchDescribeCollection", () => ({ status: OK, responses: [DOCS_INT64] }));
    const batch = await describeMilvusCollections(client, testSurface(), "default", ["docs_alias"]);
    expect(batch.details.map((detail) => detail.path)).toEqual([["default", "docs_alias"]]);
  });

  test("a collection dropped between the listing and the bulk describe is left out, and the others are kept", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(3) } });
    const batch = await describeMilvusCollections(client, testSurface(), "default", ["c_000", "c_dropped", "c_002"]);
    expect(batch.details.map((detail) => detail.path[1])).toEqual(["c_000", "c_002"]);
    expect(batch.truncated).toBeUndefined();
  });

  test.each([
    [100, "CollectionNotExists"],
    [800, "DatabaseNotExist"],
    [1100, "IllegalArgument"],
    [0, "CollectionNotExists"],
  ])("a per-entry %i %s leaves that object out", async (code, errorCode) => {
    const client = createFakeMilvusClient({ databases: { default: many(2) } });
    client.on("batchDescribeCollection", () => ({
      status: OK,
      responses: [
        plainCollection("c_000"),
        { ...plainCollection("c_001"), status: { ...OK, code, error_code: errorCode } },
      ],
    }));
    const batch = await describeMilvusCollections(client, testSurface(), "default", namesOf(2));
    expect(batch.details.map((detail) => detail.path[1])).toEqual(["c_000"]);
  });

  test("a per-entry failure of another code is raised", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(1) } });
    client.on("batchDescribeCollection", () => ({
      status: OK,
      responses: [
        { ...plainCollection("c_000"), status: { ...OK, code: 65535, error_code: "UnexpectedError", reason: "x" } },
      ],
    }));
    await expect(describeMilvusCollections(client, testSurface(), "default", namesOf(1))).rejects.toThrow(
      "Milvus refused the bulk describe of collection c_000 with code 65535 (UnexpectedError).",
    );
  });

  test("a whole-call failure is raised: a gRPC 7 and a code 1101", async () => {
    const denied = createFakeMilvusClient({ databases: { default: many(1) } });
    denied.on("batchDescribeCollection", () => permissionDenied("DescribeCollection"));
    await expect(describeMilvusCollections(denied, testSurface(), "default", namesOf(1))).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
    const failed = createFakeMilvusClient({ databases: { default: many(1) } });
    failed.on("batchDescribeCollection", () => failedStatus(1101, "UnexpectedError", "rate limit exceeded"));
    await expect(describeMilvusCollections(failed, testSurface(), "default", namesOf(1))).rejects.toThrow("code 1101");
  });

  test("an answer with another number of entries than names asked is refused, reading none", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(2) } });
    client.on("batchDescribeCollection", () => ({ status: OK, responses: [plainCollection("c_000")] }));
    await expect(describeMilvusCollections(client, testSurface(), "default", namesOf(2))).rejects.toThrow(
      "Milvus answered a bulk describe of 2 collections with 1 entries",
    );
  });

  test("UNIMPLEMENTED: one DescribeCollection per collection, never more than 4 in flight", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(10) } });
    client.on("batchDescribeCollection", () => unimplemented("BatchDescribeCollection"));
    const release = client.hold("describeCollection");
    const pending = describeMilvusCollections(client, testSurface({}, 8), "default", namesOf(10), 9);
    await settle();
    expect(client.inFlight()).toBe(4);
    release();
    const batch = await pending;
    expect(batch.details.map((detail) => detail.path[1])).toEqual(namesOf(9));
    expect(batch.truncated).toEqual({ limit: 9, reason: callerBoundTruncationReason(9) });
    expect(client.maxInFlight()).toBe(4);
    expect(client.calls.filter((call) => call.method === "describeCollection")).toHaveLength(9);
  });

  test("UNIMPLEMENTED: the fallback leaves out a collection that is gone and raises any other failure", async () => {
    const gone = createFakeMilvusClient({ databases: { default: many(2) } });
    gone.on("batchDescribeCollection", () => unimplemented("BatchDescribeCollection"));
    const batch = await describeMilvusCollections(gone, testSurface(), "default", ["c_000", "c_gone", "c_001"]);
    expect(batch.details.map((detail) => detail.path[1])).toEqual(["c_000", "c_001"]);
    const denied = createFakeMilvusClient({ databases: { default: many(2) } });
    denied.on("batchDescribeCollection", () => unimplemented("BatchDescribeCollection"));
    denied.on("describeCollection", () => permissionDenied("DescribeCollection"));
    await expect(describeMilvusCollections(denied, testSurface(), "default", namesOf(2))).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
  });
});
