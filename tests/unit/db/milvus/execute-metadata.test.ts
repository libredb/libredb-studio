/**
 * The Milvus console's metadata routes: each is a read whose answer becomes named, typed columns, with the calls it
 * makes and no more. A filtered listing says so in its column's type; a statistics row count is typed an estimate; a
 * described collection is one row per field with its index and the collection's load state, read with no load; a
 * partition listing stops at 1,024 names and says so.
 */
import { describe, expect, test } from "bun:test";
import { TimeoutError } from "@/lib/db/errors";
import { executeMilvusConsole, type MilvusExecuteContext } from "@/lib/db/providers/vector/milvus/execute";
import { createRunRegistry } from "@/lib/db/utils/bounded-limiter";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeCatalog,
  failedStatus,
  OK,
  plainCollection,
  TEST_ERRORS,
  testSurface,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      {
        describe: { ...DOCS_INT64, aliases: ["docs"] },
        indexes: [DOCS_INT64_INDEX],
        rowCount: "2000",
        partitions: ["_default", "part_a", "part_b"],
      },
      {
        describe: plainCollection("unloaded_big"),
        indexes: [wireIndex("vec", "IVF_FLAT", "L2")],
        loadState: "LoadStateNotLoad",
      },
      { describe: plainCollection("noidx"), loadState: "LoadStateNotLoad" },
    ],
    probe_db: [{ describe: plainCollection("notes", "probe_db") }],
  },
};

const request = (route: string, body: unknown) => `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

function executor(catalog: FakeCatalog = CATALOG, over: Partial<MilvusExecuteContext> = {}) {
  const client = createFakeMilvusClient(catalog);
  const context: MilvusExecuteContext = {
    database: "default",
    version: { reported: "v3.0.2", major: 3, minor: 0 },
    limiter: testSurface().limiter,
    runs: createRunRegistry(),
    queryTimeoutMs: 5_000,
    lifetime: new AbortController().signal,
    errors: TEST_ERRORS,
    secretForms: [],
    now: () => 0,
    ...over,
  };
  return {
    client,
    run: (route: string, body: unknown = {}) => executeMilvusConsole(client, request(route, body), undefined, context),
  };
}

describe("databases", () => {
  test("databases/list: one row per database, the column saying the list is the user's view", async () => {
    const { client, run } = executor();
    const result = await run("databases/list");
    expect(result.rows).toEqual([{ dbName: "default" }, { dbName: "probe_db" }]);
    expect(result.columnTypes).toEqual({ dbName: "VarChar, visible to this user" });
    expect(result.warnings).toBeUndefined();
    expectCalls(client, [{ method: "listDatabases", args: ["default"] }]);
  });

  test("databases/list with none visible says why in a warning, since an empty grid alone reads as none", async () => {
    const { run } = executor({ databases: {} });
    const result = await run("databases/list");
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([
      {
        message:
          "Milvus lists no database visible to this Milvus user: a user sees only the databases it holds a privilege on.",
      },
    ]);
  });

  test("databases/describe: the named database, its id as an exact string", async () => {
    const { client, run } = executor();
    const result = await run("databases/describe", { dbName: "probe_db" });
    expect(result.rows).toEqual([{ dbName: "probe_db", dbID: "1", properties: {} }]);
    expect(result.columnTypes).toEqual({ dbName: "VarChar", dbID: "Int64", properties: "JSON" });
    expectCalls(client, [{ method: "describeDatabase", args: ["probe_db", {}] }]);
  });
});

describe("collections", () => {
  test("collections/list: names only, from one ShowCollections of the named database", async () => {
    const { client, run } = executor();
    const result = await run("collections/list", { dbName: "probe_db" });
    expect(result.rows).toEqual([{ collectionName: "notes" }]);
    expect(result.columnTypes).toEqual({ collectionName: "VarChar, visible to this user" });
    expect(result.warnings).toBeUndefined();
    expectCalls(client, [{ method: "showCollections", args: ["probe_db"] }]);
  });

  test("collections/list with none visible says why in a warning, naming the database it listed", async () => {
    const { run } = executor({ databases: { ...CATALOG.databases, probe_db: [] } });
    const result = await run("collections/list", { dbName: "probe_db" });
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([
      {
        message:
          "Milvus lists no collection of database probe_db visible to this Milvus user: a user sees only the collections it holds a privilege on.",
      },
    ]);
  });

  test("collections/describe: one row per field with its index, and the load state, read with no load", async () => {
    const { client, run } = executor();
    const result = await run("collections/describe", { collectionName: "unloaded_big" });
    expect(result.rows).toEqual([
      {
        fieldName: "id",
        dataType: "Int64",
        isPrimary: true,
        nullable: false,
        isPartitionKey: false,
        indexName: null,
        indexType: null,
        metricType: null,
        load: "LoadStateNotLoad",
      },
      {
        fieldName: "vec",
        dataType: "FloatVector(4)",
        isPrimary: false,
        nullable: false,
        isPartitionKey: false,
        indexName: "vec",
        indexType: "IVF_FLAT",
        metricType: "L2",
        load: "LoadStateNotLoad",
      },
    ]);
    expectCalls(client, ["describeCollection", "describeIndex", "getLoadState"]);
  });

  test("collections/describe of a collection with no index leaves the index columns empty", async () => {
    const { run } = executor();
    const result = await run("collections/describe", { collectionName: "noidx" });
    expect(result.rows.map((row) => row.indexName)).toEqual([null, null]);
  });

  test("collections/describe of an index that reports no type or metric leaves those two empty", async () => {
    const bare = { ...CATALOG.databases.default[1], indexes: [wireIndex("vec", "X", "Y", { params: [] })] };
    const { run } = executor({ databases: { default: [bare] } });
    const [, vec] = (await run("collections/describe", { collectionName: "unloaded_big" })).rows;
    expect([vec.indexName, vec.indexType, vec.metricType]).toEqual(["vec", null, null]);
  });

  test("collections/get_stats: the row count, typed an estimate", async () => {
    const { client, run } = executor();
    const result = await run("collections/get_stats", { collectionName: "docs_int64" });
    expect(result.rows).toEqual([{ rowCount: "2000" }]);
    expect(result.columnTypes).toEqual({ rowCount: "Int64, estimate" });
    expectCalls(client, ["getCollectionStatistics"]);
  });

  test("collections/get_stats with no row_count in the answer is refused naming the collection", async () => {
    const { client, run } = executor();
    client.on("getCollectionStatistics", () => ({ status: OK, stats: [] }));
    await expect(run("collections/get_stats", { collectionName: "docs_int64" })).rejects.toThrow(
      "Milvus answered the statistics of collection docs_int64 with no row_count.",
    );
  });

  test("collections/get_load_state: the state, and the progress where a load exists", async () => {
    const loaded = executor();
    expect((await loaded.run("collections/get_load_state", { collectionName: "docs_int64" })).rows).toEqual([
      { loadState: "LoadStateLoaded", loadProgress: "100" },
    ]);
    expectCalls(loaded.client, ["getLoadState", "getLoadingProgress"]);
    const unloaded = executor();
    expect((await unloaded.run("collections/get_load_state", { collectionName: "unloaded_big" })).rows).toEqual([
      { loadState: "LoadStateNotLoad", loadProgress: null },
    ]);
    expectCalls(unloaded.client, ["getLoadState"]);
  });
});

describe("partitions, indexes and aliases", () => {
  test("partitions/list: one row per partition", async () => {
    const { client, run } = executor();
    const result = await run("partitions/list", { collectionName: "docs_int64" });
    expect(result.rows).toEqual([
      { partitionName: "_default" },
      { partitionName: "part_a" },
      { partitionName: "part_b" },
    ]);
    expect(result.pagination).toBeUndefined();
    expectCalls(client, ["showPartitions"]);
  });

  test("partitions/list stops at 1,024 names and says how many there are", async () => {
    const many = { describe: plainCollection("wide"), partitions: Array.from({ length: 1500 }, (_, at) => `p_${at}`) };
    const { run } = executor({ databases: { default: [many] } });
    const result = await run("partitions/list", { collectionName: "wide" });
    expect(result.rowCount).toBe(1024);
    expect(result.warnings).toEqual([{ message: "Studio lists the first 1,024 of 1,500 partitions." }]);
    expect(result.pagination).toEqual({
      limit: 1024,
      offset: 0,
      hasMore: false,
      totalReturned: 1024,
      wasLimited: true,
    });
  });

  test("indexes/list: one row per index, its type as the server reports it, its parameters as one cell", async () => {
    const { client, run } = executor();
    const result = await run("indexes/list", { collectionName: "docs_int64" });
    expect(result.rows).toEqual([
      {
        indexName: "vec",
        fieldName: "vec",
        indexType: "HNSW",
        metricType: "COSINE",
        indexState: "Finished",
        indexedRows: "2000",
        totalRows: "2000",
        pendingRows: "0",
        failReason: null,
        params: { M: "16", efConstruction: "64" },
      },
    ]);
    expectCalls(client, [{ method: "describeIndex", args: ["default", { collection_name: "docs_int64" }] }]);
  });

  test("indexes/list of a collection with no index is no row, and a fail reason passes the secret check", async () => {
    const empty = executor();
    expect((await empty.run("indexes/list", { collectionName: "noidx" })).rows).toEqual([]);
    const failed = {
      describe: plainCollection("failed"),
      indexes: [wireIndex("vec", "HNSW", "L2", { state: "Failed", index_state_fail_reason: `bad ${TEST_PASSWORD}` })],
    };
    const { run } = executor({ databases: { default: [failed] } }, { secretForms: [TEST_PASSWORD] });
    const [row] = (await run("indexes/list", { collectionName: "failed" })).rows;
    expect(String(row.failReason)).not.toContain(TEST_PASSWORD);
    expect(String(row.failReason)).toContain("withheld");
  });

  test("indexes/describe names the index, and an index that is not there is the server's refusal", async () => {
    const { client, run } = executor();
    await run("indexes/describe", { collectionName: "docs_int64", indexName: "vec" });
    expectCalls(client, [
      { method: "describeIndex", args: ["default", { collection_name: "docs_int64", index_name: "vec" }] },
    ]);
    client.on("describeIndex", () => failedStatus(700, "IndexNotExist", "index not found"));
    await expect(run("indexes/describe", { collectionName: "docs_int64", indexName: "nope" })).rejects.toThrow(
      "Milvus refused the indexes/describe request with code 700 (IndexNotExist).",
    );
  });

  test("aliases/list: a collection's aliases, or the database's; aliases/describe: the collection an alias names", async () => {
    const { client, run } = executor();
    expect((await run("aliases/list", { collectionName: "docs_int64" })).rows).toEqual([{ aliasName: "docs" }]);
    expect((await run("aliases/list")).rows).toEqual([{ aliasName: "docs" }]);
    expect((await run("aliases/describe", { aliasName: "docs" })).rows).toEqual([
      { aliasName: "docs", collectionName: "docs_int64", dbName: "default" },
    ]);
    expectCalls(client, [
      { method: "listAliases", args: ["default", { collection_name: "docs_int64" }] },
      { method: "listAliases", args: ["default", {}] },
      { method: "describeAlias", args: ["default", { alias: "docs" }] },
    ]);
  });
});

describe("a metadata route's failures and its deadline", () => {
  test("an unknown collection is the collection sentence", async () => {
    const { run } = executor();
    await expect(run("collections/describe", { collectionName: "gone" })).rejects.toThrow(
      "Collection gone does not exist in database default.",
    );
  });

  test("the deadline is the query timeout where that is shorter than 10 seconds", async () => {
    const { client, run } = executor(CATALOG, { queryTimeoutMs: 30 });
    client.hold("showCollections");
    const error = await run("collections/list").catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toStartWith("The collections/list request reached its deadline of 30 ms.");
  });
});
