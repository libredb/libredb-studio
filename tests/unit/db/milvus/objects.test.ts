/**
 * The Milvus object surface, over the fake client of
 * tests/helpers/milvus-catalog-client.ts: one permit per call in flight, the wait for a permit inside the call's
 * deadline, a full queue refused unchanged, the database on every request, one database level whose filtered list
 * reads "visible to this user", and one collection kind listed and counted by one ShowCollections, names only.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, TimeoutError } from "@/lib/db/errors";
import {
  countMilvusCollections,
  inBoundedFlight,
  listMilvusCollectionNames,
  listMilvusCollections,
  listMilvusDatabases,
  MILVUS_COLLECTION_KIND,
  MILVUS_CONTAINER_LEVELS,
  MILVUS_OBJECT_KINDS,
  milvusCause,
  refusedForPrivilege,
  refusedStatusCode,
  surfaceCall,
  surfaceErrorContext,
  unimplementedByServer,
} from "@/lib/db/providers/vector/milvus/objects";
import { engineLimiter, LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  failedStatus,
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
