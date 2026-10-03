/**
 * One Milvus console request, run over the fake client: which calls each request makes and in what order, and what
 * is refused before any of them. A refusal that reads the text alone, a version gate among them, leaves the call log
 * empty and takes no permit; a refusal that needs the schema follows exactly one DescribeCollection, and on a search
 * one DescribeIndex, and no execution call. The describe is read for each request and never kept. A request holds one
 * permit and one deadline across its calls, which never overlap; its id names it for a cancel, running or waiting.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  executeMilvusConsole,
  MILVUS_ENTITIES_DEADLINE_MS,
  MILVUS_METADATA_DEADLINE_MS,
  type MilvusExecuteContext,
} from "@/lib/db/providers/vector/milvus/execute";
import { milvusPhase0, milvusPhase1, parseMilvusRequest } from "@/lib/db/providers/vector/milvus/request";
import { createRunRegistry, DuplicateRunError } from "@/lib/db/utils/bounded-limiter";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  describeAnswer,
  type FakeCatalog,
  failedStatus,
  kv,
  OK,
  permissionDenied,
  plainCollection,
  settle,
  TEST_ERRORS,
  testSurface,
  wireField,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

const KEYED = describeAnswer({
  name: "pk_partitioned",
  fields: [
    wireField("id", "Int64", { is_primary_key: true }),
    wireField("tenant", "VarChar", { is_partition_key: true, type_params: [kv("max_length", "64")] }),
    wireField("vec", "FloatVector", { type_params: [kv("dim", "8")] }),
  ],
  numPartitions: "16",
});

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" },
      { describe: KEYED, indexes: [wireIndex("vec", "FLAT", "L2")] },
      { describe: plainCollection("plain"), indexes: [wireIndex("vec", "FLAT", "L2")] },
      { describe: plainCollection("noidx") },
    ],
    probe_db: [{ describe: plainCollection("notes", "probe_db"), indexes: [wireIndex("vec", "FLAT", "L2")] }],
  },
};

const DATA8 = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const DATA4 = [0.1, 0.2, 0.3, 0.4];

/** `POST /v2/vectordb/<route>` with `body` as its JSON body, as the console takes it. */
const request = (route: string, body: unknown) => `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;
const QUERY = request("entities/query", { collectionName: "docs_int64", filter: "seq >= 10", limit: 5 });
const SEARCH = request("entities/search", { collectionName: "docs_int64", annsField: "vec", data: [DATA8], limit: 5 });

function executor(over: Partial<MilvusExecuteContext> = {}, perProvider = 4) {
  const client = createFakeMilvusClient(CATALOG);
  const { limiter } = testSurface({}, perProvider);
  let acquisitions = 0;
  const context: MilvusExecuteContext = {
    database: "default",
    version: { reported: "v3.0.2", major: 3, minor: 0 },
    limiter: {
      acquire: (signal) => {
        acquisitions += 1;
        return limiter.acquire(signal);
      },
    },
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
    context,
    limiter,
    acquisitions: () => acquisitions,
    run: (text: string, queryId?: string) => executeMilvusConsole(client, text, queryId, context),
  };
}

const methodsOf = (client: { calls: readonly { method: string }[] }) => client.calls.map((call) => call.method);
const failure = (pending: Promise<unknown>): Promise<Error> =>
  pending.then(
    () => {
      throw new Error("it succeeded");
    },
    (error: unknown) => error as Error,
  );

describe("which calls a request makes", () => {
  test("a query: one DescribeCollection, then the lowered Query, both in the request's database", async () => {
    const { client, run } = executor();
    const result = await run(QUERY);
    expect(result.rowCount).toBe(0);
    const lowered = milvusPhase1(milvusPhase0(parseMilvusRequest(QUERY), { database: "default" }), {
      collection: DOCS_INT64,
      index: { kind: "not-read" },
    });
    expectCalls(client, [
      { method: "describeCollection", args: ["default", { collection_name: "docs_int64" }] },
      { method: "query", args: ["default", (lowered as { request: unknown }).request] },
    ]);
  });

  test("a search: one DescribeCollection, one DescribeIndex of the collection, then the Search", async () => {
    const { client, run } = executor();
    await run(SEARCH);
    expect(methodsOf(client)).toEqual(["describeCollection", "describeIndex", "search"]);
    expect(client.calls[1]).toEqual({ method: "describeIndex", args: ["default", { collection_name: "docs_int64" }] });
  });

  test("a lone count is one Query, answered as one exact row", async () => {
    const { client, run } = executor();
    client.on("query", () => ({
      status: OK,
      fields_data: [
        {
          type: "Int64",
          field_name: "count(*)",
          scalars: { long_data: { data: ["500"] } },
          vectors: null,
          struct_arrays: null,
          field_id: "0",
          is_dynamic: false,
          valid_data: [],
        },
      ],
      collection_name: "docs_int64",
      output_fields: ["count(*)"],
      session_ts: "0",
      primary_field_name: "id",
    }));
    const result = await run(request("entities/query", { collectionName: "docs_int64", outputFields: ["count(*)"] }));
    expect(result.rows).toEqual([{ "count(*)": "500" }]);
    expect(result.columnTypes).toEqual({ "count(*)": "Int64, exact count" });
    expect(methodsOf(client)).toEqual(["describeCollection", "query"]);
  });

  test("a hybrid search that names no metric and no search parameter reads no DescribeIndex", async () => {
    const { client, run } = executor();
    await run(
      request("entities/hybrid_search", {
        collectionName: "docs_int64",
        search: [{ annsField: "vec", data: [DATA8], limit: 5 }],
        rerank: { strategy: "rrf", params: { k: 60 } },
        limit: 5,
      }),
    );
    expect(methodsOf(client)).toEqual(["describeCollection", "hybridSearch"]);
  });

  test("the schema is read for every request and never kept", async () => {
    const { client, run } = executor();
    await run(QUERY);
    await run(QUERY);
    expect(methodsOf(client).filter((method) => method === "describeCollection")).toHaveLength(2);
  });

  test("a dbName in the body is the database of every call", async () => {
    const { client, run } = executor();
    await run(request("entities/query", { dbName: "probe_db", collectionName: "notes", filter: "", limit: 1 }));
    expect(client.calls.map((call) => call.args?.[0])).toEqual(["probe_db", "probe_db"]);
  });
});

describe("what is refused from the text alone: no call and no permit", () => {
  test.each([
    ["a text past the console's byte bound", `# ${"x".repeat(1_048_576)}\n${QUERY}`],
    ["a route Studio runs only from Operations", request("collections/load", { collectionName: "docs_int64" })],
    ["a limit past the row bound", request("entities/query", { collectionName: "docs_int64", limit: 1001 })],
    [
      "a search-time function",
      request("entities/search", { collectionName: "docs_int64", annsField: "vec", data: [DATA8], functionScore: {} }),
    ],
    ["a key the route does not take", request("entities/query", { collectionName: "docs_int64", bogus: 1 })],
  ])("%s", async (_name, text) => {
    const { client, run, acquisitions } = executor();
    const error = await failure(run(text));
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(0);
    expect(client.calls).toEqual([]);
    expect(acquisitions()).toBe(0);
  });

  test("a key a 2.6 server would ignore is refused by the version read at connect, and runs on 3.0", async () => {
    const ordered = request("entities/query", {
      collectionName: "docs_int64",
      filter: "",
      limit: 5,
      orderByFields: ["seq"],
    });
    const old = executor({ version: { reported: "v2.6.25", major: 2, minor: 6 } });
    const error = await failure(old.run(ordered));
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(0);
    expect((error as RequestRefusal).key).toBe("orderByFields");
    expect(old.client.calls).toEqual([]);
    expect(old.acquisitions()).toBe(0);
    const current = executor();
    await current.run(ordered);
    expect(methodsOf(current.client)).toEqual(["describeCollection", "query"]);
  });

  test.each([["q".repeat(129)], ["q 1"]])(
    "a queryId that is not 1 to 128 safe characters, %j, is refused",
    async (queryId) => {
      const { client, run, acquisitions } = executor();
      expect(await failure(run(QUERY, queryId))).toBeInstanceOf(QueryError);
      expect(client.calls).toEqual([]);
      expect(acquisitions()).toBe(0);
    },
  );

  test("the browser's id form is accepted, and an id already running is refused with nothing sent for it", async () => {
    const { client, run } = executor();
    const release = client.hold("query");
    const first = run(QUERY, "q-1759400000000-abcDEF_123");
    await settle();
    const before = client.calls.length;
    expect(await failure(run(QUERY, "q-1759400000000-abcDEF_123"))).toBeInstanceOf(DuplicateRunError);
    expect(client.calls).toHaveLength(before);
    release();
    await first;
  });
});

describe("what is refused once the schema is read: exactly the metadata reads, and no execution call", () => {
  test.each([
    [
      "partitionNames on a partition-key collection",
      request("entities/query", { collectionName: "pk_partitioned", filter: "", limit: 5, partitionNames: ["p"] }),
      ["describeCollection"],
    ],
    [
      "a dynamic projection on a collection with no dynamic field",
      request("entities/query", { collectionName: "plain", filter: "", limit: 5, outputFields: ["big_int"] }),
      ["describeCollection"],
    ],
    [
      "a malformed digit string as the id of an Int64 key",
      request("entities/get", { collectionName: "docs_int64", id: ["abc"] }),
      ["describeCollection"],
    ],
    [
      "a metric that is not the index's",
      request("entities/search", {
        collectionName: "docs_int64",
        annsField: "vec",
        data: [DATA8],
        limit: 5,
        searchParams: { metric_type: "L2" },
      }),
      ["describeCollection", "describeIndex"],
    ],
  ])("%s", async (_name, text, reads) => {
    const { client, run } = executor();
    const error = await failure(run(text, "q-1"));
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(1);
    expectCalls(client, reads);
    await run(QUERY, "q-1");
  });
});

describe("the index, where a search reads it", () => {
  const WITH_METRIC = request("entities/search", {
    collectionName: "docs_int64",
    annsField: "vec",
    data: [DATA8],
    limit: 5,
    searchParams: { metric_type: "COSINE" },
  });

  test("a DescribeIndex refused for want of IndexDetail does not refuse a search that names no metric and no parameter", async () => {
    const { client, run } = executor();
    client.on("describeIndex", () => permissionDenied("IndexDetail"));
    await run(SEARCH);
    expect(methodsOf(client)).toEqual(["describeCollection", "describeIndex", "search"]);
  });

  test("the same refusal refuses a search that names a metric, whose check needs the index", async () => {
    const { client, run } = executor();
    client.on("describeIndex", () => permissionDenied("IndexDetail"));
    const error = await failure(run(WITH_METRIC));
    expect(error).toBeInstanceOf(RequestRefusal);
    expect((error as RequestRefusal).phase).toBe(1);
    expect(methodsOf(client)).toEqual(["describeCollection", "describeIndex"]);
  });

  test("a collection with no index answers 700, which is an index list with no entry, not a failure of the read", async () => {
    const { client, run } = executor();
    await run(request("entities/search", { collectionName: "noidx", annsField: "vec", data: [DATA4], limit: 5 }));
    expect(methodsOf(client)).toEqual(["describeCollection", "describeIndex", "search"]);
  });

  test("any other failure of the read is raised, and nothing is searched", async () => {
    const { client, run } = executor();
    client.on("describeIndex", () => failedStatus(65535, "UnexpectedError", "busy"));
    const error = await failure(run(SEARCH));
    expect(error.message).toStartWith("Milvus refused the entities/search request with code 65535");
    expect(methodsOf(client)).toEqual(["describeCollection", "describeIndex"]);
  });
});

describe("one permit and one deadline for the whole request", () => {
  test("a request takes one permit across its reads and its call, which never overlap", async () => {
    const { client, run, acquisitions } = executor({}, 1);
    await run(SEARCH);
    expect(acquisitions()).toBe(1);
    expect(client.maxInFlight()).toBe(1);
    await run(SEARCH);
    expect(acquisitions()).toBe(2);
  });

  test("the deadlines are 30 seconds for a query or a search and 10 for a metadata route", () => {
    expect(MILVUS_ENTITIES_DEADLINE_MS).toBe(30_000);
    expect(MILVUS_METADATA_DEADLINE_MS).toBe(10_000);
  });

  test("the connection's query timeout caps the deadline, which ends the call and frees the permit", async () => {
    const { client, run } = executor({ queryTimeoutMs: 40 });
    const release = client.hold("query");
    const error = await failure(run(QUERY));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toStartWith("The entities/query request reached its deadline of 40 ms.");
    release();
    expect(client.inFlight()).toBe(0);
    await run(QUERY);
  });

  test("a request that waits for a permit past its deadline sends nothing", async () => {
    const { client, run, limiter } = executor({ queryTimeoutMs: 30 }, 1);
    const held = await limiter.acquire(new AbortController().signal);
    expect(await failure(run(QUERY))).toBeInstanceOf(TimeoutError);
    expect(client.calls).toEqual([]);
    held.release();
  });

  test("a failure of the server is worded with the request's own route", async () => {
    const { client, run } = executor();
    client.on("query", () => failedStatus(1100, "IllegalArgument", "cannot parse expression"));
    const error = await failure(run(QUERY));
    expect(error.message).toStartWith("Milvus refused the entities/query request's input");
  });
});

describe("cancel, by the request's id", () => {
  test("a running request is stopped and answers true; once it has ended its id answers false", async () => {
    const { client, context, run } = executor();
    client.hold("query");
    const running = failure(run(QUERY, "q-run"));
    await settle();
    expect(context.runs.cancel("q-run")).toBe(true);
    expect(await running).toBeInstanceOf(QueryCancelledError);
    expect(context.runs.cancel("q-run")).toBe(false);
    expect(client.inFlight()).toBe(0);
  });

  test("a request waiting for a permit leaves the queue, sends nothing and answers true", async () => {
    const { client, context, run, limiter } = executor({}, 1);
    const held = await limiter.acquire(new AbortController().signal);
    const waiting = failure(run(QUERY, "q-wait"));
    await settle();
    expect(context.runs.cancel("q-wait")).toBe(true);
    expect(await waiting).toBeInstanceOf(QueryCancelledError);
    expect(client.calls).toEqual([]);
    held.release();
  });

  test("an id that names no run answers false", () => {
    expect(executor().context.runs.cancel("q-unknown")).toBe(false);
  });

  test("the connection's close ends a running request as cancelled", async () => {
    const closing = new AbortController();
    const { client, run } = executor({ lifetime: closing.signal });
    client.hold("query");
    const running = failure(run(QUERY));
    await settle();
    closing.abort(new QueryCancelledError("The connection to Milvus was closed."));
    expect(await running).toBeInstanceOf(QueryCancelledError);
  });
});
