/**
 * A collection's Source: the `Schema` part in the REST create-collection
 * vocabulary, every key of which is in the create key list, the
 * `State` part in the describe vocabulary, golden texts for docs_int64, and no default value, function parameter or
 * secret in either.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  MILVUS_PARTITIONS_LISTED,
  type MilvusSourceInput,
  milvusSourceParts,
  ROW_COUNT_SOURCE,
  schemaDocument,
  stateDocument,
} from "@/lib/db/providers/vector/milvus/source";
import {
  DEFAULT_MARKER,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  describeAnswer,
  FTS,
  FTS_INDEX,
  FUNCTION_MARKER,
  kv,
  wireField,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

/**
 * The create request's key paths for the schema form, copied from the create-collection request of Milvus's REST v2 reference
 * ("== Create.mdx request", the second request shape). `indexParams[].params` is an open object there, its listed
 * sub-keys examples, so the walk below does not descend into it.
 */
const CREATE_KEYS: ReadonlySet<string> = new Set([
  "dbName",
  "collectionName",
  "schema",
  "schema.autoID",
  "schema.enableDynamicField",
  "schema.fields",
  "schema.fields[].fieldName",
  "schema.fields[].dataType",
  "schema.fields[].elementDataType",
  "schema.fields[].nullable",
  "schema.fields[].defaultValue",
  "schema.fields[].isPrimary",
  "schema.fields[].isPartitionKey",
  "schema.fields[].isClusteringKey",
  "schema.fields[].elementTypeParams",
  "schema.fields[].elementTypeParams.max_length",
  "schema.fields[].elementTypeParams.dim",
  "schema.fields[].elementTypeParams.max_capacity",
  "schema.fields[].externalField",
  "schema.functions",
  "schema.functions[].name",
  "schema.functions[].description",
  "schema.functions[].type",
  "schema.functions[].inputFieldNames",
  "schema.functions[].outputFieldNames",
  "schema.functions[].params",
  "schema.externalSource",
  "schema.externalSpec",
  "schema.structFields",
  "indexParams",
  "indexParams[].metricType",
  "indexParams[].fieldName",
  "indexParams[].indexName",
  "indexParams[].params",
  "params",
  "params.shardsNum",
  "params.consistencyLevel",
  "params.partitionsNum",
  "params.ttlSeconds",
  "params.partitionKeyIsolation",
  "params.mmap.enabled",
  "params.ttlField",
]);
const OPEN_OBJECTS: ReadonlySet<string> = new Set(["indexParams[].params"]);

/** Every key path of a JSON value, arrays written `[]`, open objects not descended into. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (typeof value !== "object" || value === null || OPEN_OBJECTS.has(prefix)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return [path].concat(keyPaths(child, path));
  });
}

const DOCS_INPUT: MilvusSourceInput = {
  describe: DOCS_INT64,
  indexes: [DOCS_INT64_INDEX],
  loadState: "LoadStateLoaded",
  rowCount: "2000",
  partitions: ["_default", "part_a", "part_b"],
  aliases: [],
  secretForms: [],
};

/** The Schema part of docs_int64, exactly. */
const DOCS_SCHEMA = {
  collectionName: "docs_int64",
  schema: {
    autoID: true,
    enableDynamicField: true,
    fields: [
      { fieldName: "id", dataType: "Int64", isPrimary: true },
      { fieldName: "seq", dataType: "Int64" },
      { fieldName: "vec", dataType: "FloatVector", elementTypeParams: { dim: 8 } },
      { fieldName: "title", dataType: "VarChar", elementTypeParams: { max_length: 256 } },
      { fieldName: "meta", dataType: "Json" },
      { fieldName: "tags", dataType: "Array", elementDataType: "Int64", elementTypeParams: { max_capacity: 8 } },
      { fieldName: "maybe_count", dataType: "Int32", nullable: true },
    ],
    functions: [],
  },
  indexParams: [
    {
      fieldName: "vec",
      indexName: "vec",
      metricType: "COSINE",
      params: { index_type: "HNSW", M: 16, efConstruction: 64 },
    },
  ],
  params: { shardsNum: 1, consistencyLevel: "Bounded" },
};

/** The State part of docs_int64, with each index's build state. */
const DOCS_STATE = {
  collectionID: "469489107428444006",
  load: "LoadStateLoaded",
  rowCountEstimate: "2000",
  rowCountSource: ROW_COUNT_SOURCE,
  partitions: [{ name: "_default" }, { name: "part_a" }, { name: "part_b" }],
  aliases: [],
  indexes: [
    {
      indexName: "vec",
      fieldName: "vec",
      indexType: "HNSW",
      metricType: "COSINE",
      indexState: "Finished",
      indexedRows: "2000",
      totalRows: "2000",
      pendingRows: "0",
    },
  ],
};

describe("the Schema part", () => {
  test("docs_int64 reads its golden Schema exactly; the dynamic field is the flag, never a field", () => {
    expect(schemaDocument(DOCS_INT64, [DOCS_INT64_INDEX])).toEqual(DOCS_SCHEMA);
  });

  test("every key it writes is a key of the create request", () => {
    const documents = [
      schemaDocument(DOCS_INT64, [DOCS_INT64_INDEX]),
      schemaDocument(FTS, [FTS_INDEX]),
      schemaDocument(
        describeAnswer({
          name: "keyed",
          fields: [
            wireField("tenant", "VarChar", { is_partition_key: true, type_params: [kv("max_length", "64")] }),
            wireField("rank", "Int64", { is_clustering_key: true }),
          ],
          numPartitions: "16",
        }),
        [],
      ),
    ];
    for (const document of documents) {
      expect(keyPaths(document).filter((path) => !CREATE_KEYS.has(path))).toEqual([]);
    }
  });

  test("the key walk finds a key the create request does not take (the check's control)", () => {
    expect(keyPaths({ schema: { fields: [{ fieldName: "a", bogus: 1 }] } })).toContain("schema.fields[].bogus");
  });

  test("a function shows its name, type and input and output fields, never its parameters", () => {
    const document = schemaDocument(FTS, [FTS_INDEX]);
    expect((document.schema as { functions: unknown[] }).functions).toEqual([
      { name: "text_bm25", type: "BM25", inputFieldNames: ["text"], outputFieldNames: ["text_sparse"] },
    ]);
    // The output fields read from the function agree with the fields the schema marks as function outputs.
    expect(FTS.schema?.fields.filter((field) => field.is_function_output).map((field) => field.name)).toEqual(
      FTS.schema?.functions.flatMap((fn) => fn.output_field_names),
    );
    const text = JSON.stringify(document);
    expect(text).not.toContain(FUNCTION_MARKER);
    expect(text).not.toContain(DEFAULT_MARKER);
    expect(text).not.toContain("enable_analyzer");
  });

  test("a partition-key collection carries its key, a clustering key and the partition count", () => {
    const document = schemaDocument(
      describeAnswer({
        name: "keyed",
        fields: [
          wireField("tenant", "VarChar", { is_partition_key: true, type_params: [kv("max_length", "64")] }),
          wireField("rank", "Int64", { is_clustering_key: true }),
        ],
        numPartitions: "16",
      }),
      [],
    );
    expect((document.schema as { fields: unknown[] }).fields).toEqual([
      { fieldName: "tenant", dataType: "VarChar", isPartitionKey: true, elementTypeParams: { max_length: 64 } },
      { fieldName: "rank", dataType: "Int64", isClusteringKey: true },
    ]);
    expect(document.params).toEqual({ shardsNum: 1, consistencyLevel: "Bounded", partitionsNum: 16 });
  });

  test("autoID is read from the key field when the schema's own flag is off", () => {
    const document = schemaDocument(
      describeAnswer({ name: "auto", fields: [wireField("id", "Int64", { is_primary_key: true, autoID: true })] }),
      [],
    );
    expect((document.schema as { autoID: boolean }).autoID).toBe(true);
  });

  test("an index without a metric or an index type writes neither, and keeps a non-numeric parameter as text", () => {
    const document = schemaDocument(DOCS_INT64, [
      wireIndex("vec", "HNSW", "COSINE", { params: [kv("mmap.enabled", "true")] }),
    ]);
    expect(document.indexParams).toEqual([{ fieldName: "vec", indexName: "vec", params: { "mmap.enabled": "true" } }]);
  });

  test("a data type the create request does not list passes as Milvus names it", () => {
    const document = schemaDocument(describeAnswer({ name: "t", fields: [wireField("body", "Text")] }), []);
    expect((document.schema as { fields: unknown[] }).fields).toEqual([{ fieldName: "body", dataType: "Text" }]);
  });

  test("a describe answer with no schema is refused in Studio's words", () => {
    expect(() => schemaDocument({ ...DOCS_INT64, schema: null }, [])).toThrow(
      new QueryError(
        "Milvus described collection docs_int64 with no schema, so Studio has no Source to show.",
        "milvus",
      ),
    );
  });
});

describe("the State part", () => {
  test("docs_int64 reads its golden State, with each index's build state after the aliases", () => {
    expect(stateDocument(DOCS_INPUT)).toEqual(DOCS_STATE);
  });

  test("with no row_count there is no estimate and no source sentence", () => {
    const document = stateDocument({ ...DOCS_INPUT, rowCount: undefined });
    expect(Object.hasOwn(document, "rowCountEstimate")).toBe(false);
    expect(Object.hasOwn(document, "rowCountSource")).toBe(false);
  });

  test("a partition-key collection names its key field, the count and that they are generated, and lists 1,024", () => {
    const describeKeyed = describeAnswer({
      name: "pk",
      fields: [wireField("tenant", "VarChar", { is_partition_key: true })],
      numPartitions: "1500",
    });
    const partitions = Array.from({ length: 1500 }, (_, at) => `p_${at}`);
    const document = stateDocument({ ...DOCS_INPUT, describe: describeKeyed, indexes: [], partitions });
    expect(document.partitionKey).toEqual({ fieldName: "tenant", partitionsNum: 1500, generated: true });
    expect(document.partitions).toHaveLength(MILVUS_PARTITIONS_LISTED);
    expect(document.partitionsListed).toBe("the first 1,024 of 1,500");
    expect(Object.hasOwn(document, "indexes")).toBe(false);
  });

  test("an index's fail reason is the server's text, withheld whole when it holds the secret", () => {
    const failed = wireIndex("vec", "HNSW", "L2", { state: "Failed", index_state_fail_reason: `bad ${TEST_PASSWORD}` });
    const document = stateDocument({ ...DOCS_INPUT, indexes: [failed], secretForms: [TEST_PASSWORD] });
    const [index] = document.indexes as { failReason: string }[];
    expect(index.failReason).not.toContain(TEST_PASSWORD);
    expect(index.failReason).toContain("withheld");
  });
});

describe("milvusSourceParts", () => {
  test("two pretty JSON parts, Schema then State, rendered and partial", () => {
    const [schema, state] = milvusSourceParts(DOCS_INPUT);
    expect(schema).toEqual({
      id: "schema",
      label: "Schema",
      text: JSON.stringify(DOCS_SCHEMA, null, 2),
      language: "json",
      form: "partial",
      origin: "rendered",
    });
    expect(state).toEqual({
      id: "state",
      label: "State",
      text: JSON.stringify(DOCS_STATE, null, 2),
      language: "json",
      form: "partial",
      origin: "rendered",
    });
  });

  test("a caller's bound cuts each part and marks it in the shared sentence", () => {
    const [schema, state] = milvusSourceParts(DOCS_INPUT, 40);
    expect(schema).toMatchObject({
      text: JSON.stringify(DOCS_SCHEMA, null, 2).slice(0, 40),
      truncated: { limit: 40, reason: sourceBoundTruncationReason(40) },
    });
    expect(state).toMatchObject({ truncated: { limit: 40, reason: sourceBoundTruncationReason(40) } });
  });

  test("no part holds a default value or a function parameter", () => {
    const text = JSON.stringify(milvusSourceParts({ ...DOCS_INPUT, describe: FTS, indexes: [FTS_INDEX] }));
    expect(text).not.toContain(FUNCTION_MARKER);
    expect(text).not.toContain(DEFAULT_MARKER);
  });
});
