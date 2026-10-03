/**
 * A collection's Source (vector-family spec 6.3), from the recorded answers of the seeded collections: the
 * `Schema` part in the create-collection vocabulary, the `State` part in the description's, and the bound a
 * caller sets. The golden documents are the ones the captures under tests/fixtures/vector/qdrant/ and
 * tests/fixtures/qdrant-surface/ produce, never the abridged example of the design.
 */
import { describe, expect, test } from "bun:test";
import { sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import { readQdrantPayloadSample } from "@/lib/db/providers/vector/qdrant/sample";
import { readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import {
  DEPRECATED_SUFFIX,
  type QdrantSourceInput,
  qdrantSchemaDocument,
  qdrantSourceParts,
  qdrantStateDocument,
} from "@/lib/db/providers/vector/qdrant/source";
import { resultOf, surfaceCapture, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";

const UNIFORM = { method: "slice 0 of 2, uniform by id", uniform: true };

function inputOf(collection: string, sampled: boolean): QdrantSourceInput {
  return {
    collection: readQdrantCollection(collection, resultOf(vectorCapture(`describe-${collection}`))),
    aliases: resultOf(surfaceCapture(`aliases-${collection}`)),
    snapshots: resultOf(surfaceCapture(`snapshots-${collection}`)),
    optimizations: resultOf(surfaceCapture(`optimizations-${collection}`)),
    cluster: resultOf(surfaceCapture(`cluster-${collection}`)),
    sample: sampled
      ? readQdrantPayloadSample(collection, surfaceCapture(`sample-${collection}`).payload.body, UNIFORM)
      : null,
  };
}

const DOCS = inputOf("docs", true);

describe("the Schema part", () => {
  test("docs: the params at the top level, the rest of config, and the payload indexes as create-index writes them", () => {
    const document = qdrantSchemaDocument(DOCS.collection);
    expect(Object.keys(document)).toEqual([
      "vectors",
      "shard_number",
      "replication_factor",
      "write_consistency_factor",
      "on_disk_payload",
      "sparse_vectors",
      "hnsw_config",
      "optimizers_config",
      "wal_config",
      "quantization_config",
      "payload_indexes",
    ]);
    expect(document.vectors).toEqual({
      colbert: { size: 16, distance: "Dot", multivector_config: { comparator: "max_sim" } },
      image: { size: 64, distance: "Euclid" },
      text: { size: 384, distance: "Cosine" },
    });
    expect(document.sparse_vectors).toEqual({ keywords: { modifier: "idf" } });
    expect((document.payload_indexes as unknown[]).slice(0, 2)).toEqual([
      { field_name: "active", field_schema: "bool" },
      { field_name: "price", field_schema: "float" },
    ]);
  });

  test("optimizer_config is written optimizers_config, the one name the two vocabularies spell differently", () => {
    const document = qdrantSchemaDocument(DOCS.collection);
    expect(document.optimizers_config).toEqual(DOCS.collection.config.optimizer_config);
    expect(Object.hasOwn(document, "optimizer_config")).toBe(false);
  });

  test("a parameterised payload index writes its parameters as the field schema", () => {
    const collection = readQdrantCollection("probe", {
      config: { params: {} },
      payload_schema: { title: { data_type: "text", points: 1, params: { type: "text", tokenizer: "word" } } },
    });
    expect(qdrantSchemaDocument(collection).payload_indexes).toEqual([
      { field_name: "title", field_schema: { type: "text", tokenizer: "word" } },
    ]);
  });

  test("beside a memory tier the deprecated flags are kept under a name that says memory decides", () => {
    const collection = readQdrantCollection("probe", {
      config: {
        params: {
          vectors: { size: 4, distance: "Dot", on_disk: true, memory: "cached" },
          on_disk_payload: true,
          payload: { memory: "cold" },
        },
        hnsw_config: { m: 16, on_disk: false, memory: "cached" },
        quantization_config: { scalar: { type: "int8", always_ram: true, memory: "pinned" } },
      },
    });
    const document = qdrantSchemaDocument(collection);
    expect(document.vectors).toEqual({
      size: 4,
      distance: "Dot",
      [`on_disk${DEPRECATED_SUFFIX}`]: true,
      memory: "cached",
    });
    expect(document[`on_disk_payload${DEPRECATED_SUFFIX}`]).toBe(true);
    expect(Object.hasOwn(document, "on_disk_payload")).toBe(false);
    expect(document.hnsw_config).toEqual({ m: 16, [`on_disk${DEPRECATED_SUFFIX}`]: false, memory: "cached" });
    expect(document.quantization_config).toEqual({
      scalar: { type: "int8", [`always_ram${DEPRECATED_SUFFIX}`]: true, memory: "pinned" },
    });
  });

  test("with no memory tier the flags keep their names", () => {
    const document = qdrantSchemaDocument(DOCS.collection);
    expect(document.on_disk_payload).toBe(true);
    expect((document.hnsw_config as Record<string, unknown>).on_disk).toBe(false);
  });

  test("the collection's metadata is never in the Schema part", () => {
    const collection = readQdrantCollection("probe", { config: { params: {}, metadata: { owner: "MARKER_META" } } });
    expect(JSON.stringify(qdrantSchemaDocument(collection))).not.toContain("MARKER_META");
  });
});

describe("the State part", () => {
  test("docs: Qdrant's own status words, the point count labelled an estimate, and every read's answer", () => {
    const state = qdrantStateDocument(DOCS);
    expect(state).toMatchObject({
      status: "green",
      optimizer_status: "ok",
      points_count: 2000,
      pointsCountKind: "estimate",
      indexed_vectors_count: 2000,
      segments_count: 2,
      aliases: ["docs_alias"],
      snapshots: [],
      optimizations: resultOf(surfaceCapture("optimizations-docs")),
      cluster: resultOf(surfaceCapture("cluster-docs")),
    });
    expect(Object.hasOwn(state, "indexCoverage")).toBe(false);
  });

  test("docs: the payload sample's facts, its coverage, and the sampled fields no index declares", () => {
    const state = qdrantStateDocument(DOCS);
    const sample = DOCS.sample;
    if (sample === null) throw new Error("the docs sample capture holds no points");
    expect(state.payloadSample).toEqual({
      points: sample.points,
      method: "slice 0 of 2, uniform by id",
      keys: sample.keys.length,
    });
    expect(state.sampleCoverage).toContain("uniform sample of 1,000 points");
    const fields = state.sampledFields as { key: string; sampleSize: number }[];
    expect(fields.map((field) => field.key)).toContain("title");
    expect(fields.map((field) => field.key)).not.toContain("category");
    for (const field of fields) expect(field.sampleSize).toBe(sample.points);
  });

  test("a renamed key keeps its original key beside its column, which a filter needs", () => {
    const sample = readQdrantPayloadSample(
      "probe",
      '{"result":{"points":[{"id":1,"payload":{"id":"x","city":"Berlin"}}],"next_page_offset":null}}',
      { method: "first page, the lowest ids", uniform: false },
    );
    const state = qdrantStateDocument({ ...DOCS, sample });
    expect(state.sampledFields).toEqual([
      { key: "id", column: "payload.id", type: "string", nullable: false, sampleSize: 1 },
      { key: "city", type: "string", nullable: false, sampleSize: 1 },
    ]);
  });

  test.each([
    ["no aliases array", {}, []],
    ["an answer that is not an object", null, []],
    ["entries with no name", { aliases: [{ alias_name: "a" }, { collection_name: "docs" }, "b"] }, ["a"]],
  ])("aliases from %s", (_case, aliases, names) => {
    expect(qdrantStateDocument({ ...DOCS, aliases }).aliases).toEqual(names);
  });

  test("plain: fewer indexed vectors than points says that part of the data is searched by full scan", () => {
    expect(qdrantStateDocument(inputOf("plain", true)).indexCoverage).toBe(
      "indexed_vectors_count is below points_count, so the points not yet indexed are searched by full scan.",
    );
  });

  test("empty_novec: a collection that reports no points says it was not sampled", () => {
    const state = qdrantStateDocument(inputOf("empty_novec", false));
    expect(state.payloadSample).toEqual({
      points: 0,
      method: "not sampled: the collection reports no points",
      keys: 0,
    });
    expect(Object.hasOwn(state, "sampledFields")).toBe(false);
  });

  test("the collection's metadata is in the State part under its own key, as stored", () => {
    const collection = readQdrantCollection("probe", { config: { params: {}, metadata: { owner: "MARKER_META" } } });
    const state = qdrantStateDocument({ ...DOCS, collection, sample: null });
    expect(state.metadata).toEqual({ owner: "MARKER_META" });
  });

  test("a mixed key adds its notice, and the server's warnings are kept", () => {
    const sample = readQdrantPayloadSample(
      "probe",
      '{"result":{"points":[{"id":1,"payload":{"v":1}},{"id":2,"payload":{"v":"s"}}],"next_page_offset":null}}',
      { method: "first page, the lowest ids", uniform: false },
    );
    const collection = readQdrantCollection("probe", { config: { params: {} }, warnings: [{ message: "w" }] });
    const state = qdrantStateDocument({ ...DOCS, collection, sample });
    expect(state.sampleNotices).toEqual([
      'Payload key "v" holds string and number values in the sample, so its type is mixed.',
    ]);
    expect(state.warnings).toEqual([{ message: "w" }]);
  });
});

describe("qdrantSourceParts", () => {
  test("two pretty JSON parts, Schema then State, rendered and partial", () => {
    const [schema, state] = qdrantSourceParts(DOCS);
    expect(schema).toEqual({
      id: "schema",
      label: "Schema",
      text: JSON.stringify(qdrantSchemaDocument(DOCS.collection), null, 2),
      language: "json",
      form: "partial",
      origin: "rendered",
    });
    expect(state).toMatchObject({ id: "state", label: "State", language: "json", form: "partial", origin: "rendered" });
    expect(JSON.parse((state as { text: string }).text)).toEqual(qdrantStateDocument(DOCS));
  });

  test("a caller's bound cuts each part and marks it in the shared sentence", () => {
    const [schema, state] = qdrantSourceParts(DOCS, 40);
    expect(schema).toMatchObject({ truncated: { limit: 40, reason: sourceBoundTruncationReason(40) } });
    expect((schema as { text: string }).text).toHaveLength(40);
    expect(state).toMatchObject({ truncated: { limit: 40, reason: sourceBoundTruncationReason(40) } });
  });

  test("no part holds a payload value of the sample", () => {
    const text = JSON.stringify(qdrantSourceParts(DOCS));
    expect(text).not.toContain("Document 0005 alpha");
    expect(text).not.toContain("libredb-seed");
  });
});
