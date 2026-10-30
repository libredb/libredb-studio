/**
 * The metadata-only answer of a Milvus agent request: each admitted route's reads, replayed from what Milvus 3.0.2
 * answered a CollectionReadOnly reader (tests/fixtures/milvus/3.0.2/agent-boundary/) through the real adapter, and
 * projected through the shared metadata-only module. No stored scalar, vector or dynamic value, no default value, no
 * description, property, index or function parameter and no server text reaches a row, a column name or an error.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, TimeoutError } from "@/lib/db/errors";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import type { MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { createGrpcMilvusClient, type MilvusRpc } from "@/lib/db/providers/vector/milvus/grpc-client";
import {
  MILVUS_METADATA_ONLY,
  milvusAgentFailure,
  milvusAgentResult,
  readMilvusMetadata,
} from "@/lib/db/providers/vector/milvus/metadata-read";
import { readMilvusAgentStatement } from "@/lib/db/providers/vector/milvus/metadata-request";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentMilvusWire, milvusAgentCapture, replayed } from "../../../helpers/milvus-agent";
import { okStatus, type RecordedMilvusAnswer, statusError } from "../../../helpers/milvus-wire";

const OPTIONS: MilvusConnectionOptions = {
  target: "dns:127.0.0.1:19530",
  endpoint: { host: "127.0.0.1", port: 19530 },
  auth: { kind: "none" },
  database: "default",
  callTimeoutMs: 10_000,
  receiveCapBytes: 16 * 1024 * 1024,
  secretForms: [],
};

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 100, maxResultBytes: 1_000_000, statementTimeoutMs: 5_000 };

/** Every stored value the probe wrote; none may reach an agent answer. */
const STORED = /stored-|not-a-real/;

const request = (route: string, body?: unknown) =>
  body === undefined ? `POST /v2/vectordb/${route}` : `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

function planOf(text: string) {
  const reading = readMilvusAgentStatement(text, "default");
  if (!reading.ok) throw new Error(reading.message);
  return reading.plan;
}

async function read(text: string, overrides: Partial<Record<MilvusRpc, RecordedMilvusAnswer>> = {}) {
  const wire = agentMilvusWire("reader", { overrides });
  const client = await createGrpcMilvusClient(OPTIONS, wire.transport);
  const rows = await readMilvusMetadata(client, planOf(text), { db: "default", signal: new AbortController().signal });
  expect(JSON.stringify(rows)).not.toMatch(STORED);
  return { rows, wire };
}

const NO_FIELD = {
  type: null,
  element_type: null,
  dimension: null,
  max_length: null,
  primary: null,
  nullable: null,
  dynamic: null,
  partition_key: null,
  function_output: null,
  index: null,
  index_type: null,
  metric: null,
  shards: null,
  partitions: null,
  consistency: null,
  load_state: null,
};

const scalar = (name: string, type: string, extra: object = {}) => ({
  ...NO_FIELD,
  name,
  kind: "field",
  type,
  primary: false,
  nullable: false,
  dynamic: false,
  partition_key: false,
  function_output: false,
  ...extra,
});

describe("each admitted route's metadata, from what 3.0.2 answered a reader", () => {
  test("databases/list answers each database's name", async () => {
    const { rows, wire } = await read(request("databases/list"));
    expect(rows).toEqual({ fields: ["database"], rows: [{ database: "default" }] });
    expect(wire.calls).toEqual([{ method: "ListDatabases", args: [{}, {}] }]);
  });

  test("databases/describe answers the database and how many properties it has, never their values", async () => {
    const { rows, wire } = await read(request("databases/describe", { dbName: "default" }));
    expect(rows).toEqual({ fields: ["database", "properties"], rows: [{ database: "default", properties: 0 }] });
    expect(wire.calls).toEqual([{ method: "DescribeDatabase", args: [{ db_name: "default" }, {}] }]);
  });

  test("collections/list answers each collection's name", async () => {
    const { rows } = await read(request("collections/list"));
    expect(rows.rows).toEqual([{ collection: "agent_docs" }, { collection: "agent_scratch" }]);
  });

  test("collections/describe answers the collection, its fields with their types and indexes, and its functions' kinds", async () => {
    const { rows, wire } = await read(request("collections/describe", { collectionName: "agent_docs" }));
    const named = { collection_name: "agent_docs", db_name: "default" };
    expect(wire.calls).toEqual([
      { method: "DescribeCollection", args: [named, {}] },
      { method: "DescribeIndex", args: [named, {}] },
      { method: "GetLoadState", args: [named, {}] },
    ]);
    expect(rows.fields).toEqual(Object.keys({ name: 0, kind: 0, ...NO_FIELD }));
    expect(rows.rows).toEqual([
      {
        ...NO_FIELD,
        name: "agent_docs",
        kind: "collection",
        dynamic: true,
        shards: 1,
        partitions: 2,
        consistency: "Strong",
        load_state: "Loaded",
      },
      scalar("id", "Int64", { primary: true }),
      scalar("vec", "FloatVector", { dimension: 4, index: "vec_idx", index_type: "FLAT", metric: "L2" }),
      scalar("title", "VarChar", { max_length: 128 }),
      scalar("label", "VarChar", { max_length: 128 }),
      scalar("text", "VarChar", { max_length: 256 }),
      scalar("sparse", "SparseFloatVector", {
        function_output: true,
        index: "sparse_idx",
        index_type: "SPARSE_INVERTED_INDEX",
        metric: "BM25",
      }),
      { ...NO_FIELD, name: "text_bm25", kind: "function", type: "BM25" },
    ]);
    // The schema's default value is a stored value: the capture holds it, the answer does not.
    expect(JSON.stringify(milvusAgentCapture("describe-collection", "reader").payload)).toContain(
      "stored-default-value",
    );
  });

  test("collections/describe answers a struct array, then each of its fields with its own index", async () => {
    const answer = replayed(milvusAgentCapture("describe-collection", "reader")) as {
      schema: { fields: unknown[]; functions: unknown[]; struct_array_fields: unknown[] };
    };
    const vec = answer.schema.fields[1] as Record<string, unknown>;
    answer.schema.fields = [answer.schema.fields[0]];
    answer.schema.functions = [];
    answer.schema.struct_array_fields = [
      {
        fieldID: "200",
        name: "chunks",
        description: "stored-label-value",
        type_params: [],
        nullable: false,
        fields: [{ ...vec, name: "chunks[emb]", data_type: "ArrayOfVector", element_type: "FloatVector" }],
      },
    ];
    const { rows } = await read(request("collections/describe", { collectionName: "agent_docs" }), {
      DescribeCollection: () => answer,
      DescribeIndex: () => ({
        status: okStatus,
        index_descriptions: [
          {
            index_name: "emb_idx",
            indexID: "1",
            params: [
              { key: "index_type", value: "HNSW" },
              { key: "metric_type", value: "MAX_SIM_COSINE" },
            ],
            field_name: "chunks[emb]",
            indexed_rows: "3",
            total_rows: "3",
            state: "Finished",
            index_state_fail_reason: "",
            pending_index_rows: "0",
          },
        ],
      }),
    });
    expect(rows.rows.slice(2)).toEqual([
      { ...NO_FIELD, name: "chunks", kind: "struct_array" },
      scalar("chunks[emb]", "ArrayOfVector", {
        kind: "struct_field",
        element_type: "FloatVector",
        dimension: 4,
        index: "emb_idx",
        index_type: "HNSW",
        metric: "MAX_SIM_COSINE",
      }),
    ]);
  });

  test("collections/describe of a collection with no index answers its fields with no index", async () => {
    const { rows } = await read(request("collections/describe", { collectionName: "agent_docs" }), {
      DescribeIndex: () => ({
        status: { ...okStatus, code: 700, error_code: "IndexNotExist" },
        index_descriptions: [],
      }),
    });
    expect(rows.rows.every((row) => row.index === null)).toBe(true);
  });

  test("collections/get_stats answers the row count", async () => {
    const { rows } = await read(request("collections/get_stats", { collectionName: "agent_docs" }));
    expect(rows).toEqual({ fields: ["collection", "row_count"], rows: [{ collection: "agent_docs", row_count: 0 }] });
  });

  test("collections/get_stats with no row count is withheld", async () => {
    await expect(
      read(request("collections/get_stats", { collectionName: "agent_docs" }), {
        GetCollectionStatistics: () => ({ status: okStatus, stats: [] }),
      }),
    ).rejects.toThrow(QueryError);
  });

  test("collections/get_load_state answers the state and, loaded, the progress", async () => {
    const { rows, wire } = await read(
      request("collections/get_load_state", { collectionName: "agent_docs", partitionNames: ["part_a"] }),
    );
    expect(rows).toEqual({
      fields: ["collection", "load_state", "progress"],
      rows: [{ collection: "agent_docs", load_state: "Loaded", progress: 100 }],
    });
    const named = { collection_name: "agent_docs", partition_names: ["part_a"], db_name: "default" };
    expect(wire.calls).toEqual([
      { method: "GetLoadState", args: [named, {}] },
      { method: "GetLoadingProgress", args: [named, {}] },
    ]);
  });

  test("collections/get_load_state of an unloaded collection reads no progress", async () => {
    const { rows, wire } = await read(request("collections/get_load_state", { collectionName: "agent_docs" }), {
      GetLoadState: () => ({ status: okStatus, state: "LoadStateNotLoad" }),
    });
    expect(rows.rows).toEqual([{ collection: "agent_docs", load_state: "NotLoad", progress: null }]);
    expect(wire.calls.map((logged) => logged.method)).toEqual(["GetLoadState"]);
  });

  test("partitions/list answers each partition's name", async () => {
    const { rows } = await read(request("partitions/list", { collectionName: "agent_docs" }));
    expect(rows.rows).toEqual([{ partition: "_default" }, { partition: "part_a" }]);
  });

  test("indexes/list answers each index's name, field, kind, metric, state and counts, never its parameters", async () => {
    const { rows } = await read(request("indexes/list", { collectionName: "agent_docs" }));
    expect(rows.fields).toEqual([
      "index",
      "field",
      "index_type",
      "metric",
      "state",
      "indexed_rows",
      "total_rows",
      "pending_rows",
      "failed",
    ]);
    expect(rows.rows[0]).toEqual({
      index: "vec_idx",
      field: "vec",
      index_type: "FLAT",
      metric: "L2",
      state: "Finished",
      indexed_rows: 0,
      total_rows: 0,
      pending_rows: 0,
      failed: false,
    });
    expect(rows.rows).toHaveLength(2);
  });

  test("indexes/list of a collection with no index answers no row; indexes/describe of a missing index is refused", async () => {
    const missing = () => ({ status: { ...okStatus, code: 700, error_code: "IndexNotExist" }, index_descriptions: [] });
    const { rows } = await read(request("indexes/list", { collectionName: "agent_docs" }), { DescribeIndex: missing });
    expect(rows.rows).toEqual([]);
    await expect(
      read(request("indexes/describe", { collectionName: "agent_docs", indexName: "nope" }), {
        DescribeIndex: missing,
      }),
    ).rejects.toBeInstanceOf(MilvusError);
  });

  test("indexes/describe names the index, and a failed build answers failed alone, never the server's reason", async () => {
    const failed = () => ({
      status: okStatus,
      index_descriptions: [
        {
          index_name: "vec_idx",
          indexID: "1",
          params: [
            { key: "index_type", value: "HNSW" },
            { key: "metric_type", value: "COSINE" },
            { key: "params", value: '{"M":"stored-param-value"}' },
          ],
          field_name: "vec",
          indexed_rows: "1",
          total_rows: "2",
          state: "Failed",
          index_state_fail_reason: "row stored-title-value-1 is not a vector",
          pending_index_rows: "1",
        },
      ],
    });
    const { rows, wire } = await read(
      request("indexes/describe", { collectionName: "agent_docs", indexName: "vec_idx" }),
      {
        DescribeIndex: failed,
      },
    );
    expect(rows.rows).toEqual([
      {
        index: "vec_idx",
        field: "vec",
        index_type: "HNSW",
        metric: "COSINE",
        state: "Failed",
        indexed_rows: 1,
        total_rows: 2,
        pending_rows: 1,
        failed: true,
      },
    ]);
    expect(wire.calls[0]?.args?.[0]).toEqual({
      collection_name: "agent_docs",
      index_name: "vec_idx",
      db_name: "default",
    });
  });

  test("aliases/list answers each alias, and the collection when the request named one", async () => {
    const all = await read(request("aliases/list"));
    expect(all.rows).toEqual({ fields: ["alias", "collection"], rows: [{ alias: "agent_alias", collection: null }] });
    const one = await read(request("aliases/list", { collectionName: "agent_docs" }), {
      ListAliases: () => ({ status: okStatus, db_name: "default", collection_name: "agent_docs", aliases: ["a1"] }),
    });
    expect(one.rows.rows).toEqual([{ alias: "a1", collection: "agent_docs" }]);
  });

  test("aliases/describe answers the alias, its collection and its database", async () => {
    const { rows } = await read(request("aliases/describe", { aliasName: "agent_alias" }));
    expect(rows.rows).toEqual([{ alias: "agent_alias", collection: "agent_docs", database: "default" }]);
  });

  test("the capability states every projection, column by column", () => {
    expect(Object.keys(MILVUS_METADATA_ONLY).sort()).toEqual([
      "alias",
      "aliases",
      "collection",
      "collections",
      "database",
      "databases",
      "indexes",
      "load_state",
      "partitions",
      "statistics",
    ]);
    expect(MILVUS_METADATA_ONLY.statistics).toEqual([
      { column: "collection", kind: "name" },
      { column: "row_count", kind: "count" },
    ]);
  });
});

describe("a value smuggled into metadata is withheld, the whole answer with it", () => {
  test.each<[string, string, Partial<Record<MilvusRpc, RecordedMilvusAnswer>>]>([
    [
      "a collection name holding a line break",
      request("collections/list"),
      { ShowCollections: () => ({ status: okStatus, collection_names: ["a\nstored-title-value"] }) },
    ],
    [
      "a partition name of more than 512 characters",
      request("partitions/list", { collectionName: "agent_docs" }),
      { ShowPartitions: () => ({ status: okStatus, partition_names: ["p".repeat(513)] }) },
    ],
    [
      "a dimension that is not a whole number",
      request("collections/describe", { collectionName: "agent_docs" }),
      {
        DescribeCollection: () => {
          const answer = replayed(milvusAgentCapture("describe-collection", "reader")) as {
            schema: { fields: { type_params: { key: string; value: string }[] }[] };
          };
          answer.schema.fields[1]?.type_params.splice(0, 1, { key: "dim", value: "stored-title-value" });
          return answer;
        },
      },
    ],
    [
      "a row count past 2^53",
      request("collections/get_stats", { collectionName: "agent_docs" }),
      {
        GetCollectionStatistics: () => ({ status: okStatus, stats: [{ key: "row_count", value: "9007199254740993" }] }),
      },
    ],
  ])("%s", async (_name, text, overrides) => {
    const outcome = await read(text, overrides).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(QueryError);
    expect((outcome as Error).message).not.toMatch(STORED);
    expect((outcome as Error).message).toContain("withheld");
  });

  test("function parameters, field descriptions, collection properties and default values never reach a row", async () => {
    const answer = replayed(milvusAgentCapture("describe-collection", "reader")) as {
      schema: {
        description: string;
        fields: { description: string }[];
        functions: { params: { key: string; value: string }[] }[];
      };
      properties: { key: string; value: string }[];
    };
    answer.schema.description = "stored-title-value";
    for (const field of answer.schema.fields) field.description = "stored-label-value";
    answer.schema.functions[0]?.params.push(
      { key: "api_key", value: "not-a-real-key" },
      { key: "endpoint", value: "http://stored-endpoint.invalid" },
    );
    answer.properties.push({ key: "stored-property", value: "stored-property-value" });
    await read(request("collections/describe", { collectionName: "agent_docs" }), { DescribeCollection: () => answer });
  });
});

describe("the agent's answer and its failures", () => {
  const rows = { fields: ["collection"], rows: [{ collection: "a" }, { collection: "b" }] };

  test("an answer within the budget is the rows with their count and time", () => {
    expect(milvusAgentResult(rows, BUDGET, "s", 7)).toEqual({
      fields: ["collection"],
      rows: rows.rows,
      rowCount: 2,
      executionTime: 7,
    });
  });

  test("an answer past the row or byte budget is refused, never cut", () => {
    expect(() => milvusAgentResult(rows, { ...BUDGET, maxResultRows: 1 }, "s", 0)).toThrow(QueryError);
    expect(() => milvusAgentResult(rows, { ...BUDGET, maxResultBytes: 4 }, "s", 0)).toThrow(QueryError);
  });

  test("a server refusal is worded by its category, never the server's words", () => {
    const failure = milvusAgentFailure(
      new MilvusError("status", "collection stored-title-value-1 not found", { status: { code: 100, errorCode: "x" } }),
      BUDGET,
      "s",
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.message).not.toMatch(STORED);
    expect(failure?.message).toContain("status");
  });

  test("a deadline or a timeout is the time budget's refusal", () => {
    for (const error of [
      new MilvusError("deadline-exceeded", "context deadline exceeded"),
      new TimeoutError("late", "milvus"),
    ]) {
      expect(milvusAgentFailure(error, BUDGET, "s")?.message).toContain("5000ms");
    }
  });

  test("a refusal of the profile, or of the projection, is passed on as it is; anything else is left to the provider", () => {
    expect(
      milvusAgentFailure(new ExecutionProfileError("x", "PROFILE_PRIVILEGES_TOO_BROAD"), BUDGET, "s"),
    ).toBeUndefined();
    expect(milvusAgentFailure(new Error("x"), BUDGET, "s")).toBeUndefined();
  });

  test("a server refusal through the real adapter is worded without the server's text", async () => {
    const outcome = await read(request("aliases/describe", { aliasName: "agent_alias" }), {
      DescribeAlias: () => Promise.reject(statusError(7, "PrivilegeDescribeAlias: stored-title-value")),
    }).catch((error: unknown) => error);
    const failure = milvusAgentFailure(outcome, BUDGET, "s");
    expect(failure?.message).toContain("permission-denied");
    expect(failure?.message).not.toMatch(STORED);
  });
});
