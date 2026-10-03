/**
 * A Qdrant collection's description read into columns, indexes, the shared vector field descriptions and a
 * result's vector columns (vector-family spec 6.3). The descriptions are the recorded answers of the seeded
 * collections under tests/fixtures/vector/qdrant/; the expected vector fields are the ones that directory's
 * `expected-fields.json` derives from the seed's manifest, which this module reproduces from the descriptions.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  qdrantCollectionFacts,
  qdrantCount,
  qdrantDeclaredColumns,
  qdrantIndexes,
  qdrantPayloadIndexes,
  qdrantVectorColumns,
  qdrantVectorFields,
  qdrantVectors,
  readQdrantCollection,
} from "@/lib/db/providers/vector/qdrant/schema";
import { vectorNameOfColumn, vectorTargetOfType } from "@/lib/db/providers/vector/qdrant/type-spelling";
import type { VectorFieldInfo } from "@/lib/db/vector/types";
import { resultOf, SEEDED_COLLECTIONS, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";
import { allFields } from "../../../helpers/vector-fixtures";

const seeded = (collection: string) =>
  readQdrantCollection(collection, resultOf(vectorCapture(`describe-${collection}`)));

/** A description with one unnamed vector and the collection's HNSW settings, for the rules no seeded collection shows. */
function described(vectors: unknown, extra: Record<string, unknown> = {}, hnsw: Record<string, unknown> = { m: 16 }) {
  return readQdrantCollection("probe", {
    points_count: 0,
    config: { params: { vectors, ...extra }, hnsw_config: hnsw },
    payload_schema: {},
  });
}

const byName = (a: { readonly name: string }, b: { readonly name: string }) => a.name.localeCompare(b.name);

describe("qdrantVectorFields", () => {
  test.each([...SEEDED_COLLECTIONS])("%s: the fields derived from the seed's manifest are reproduced", (collection) => {
    const expected: VectorFieldInfo[] = allFields("qdrant")
      .filter((entry) => entry.collection === collection)
      .map((entry) => entry.field);
    expect([...qdrantVectorFields(seeded(collection))].sort(byName)).toEqual([...expected].sort(byName));
  });

  test("Euclid is the distance itself, never the squared one", () => {
    const image = qdrantVectorFields(seeded("docs")).find((field) => field.name === "image");
    expect(image).toMatchObject({ metric: "euclidean", nativeMetric: "Euclid" });
  });

  test("a distance this version does not know keeps its native name under the metric `other`", () => {
    const [field] = qdrantVectorFields(described({ size: 4, distance: "Chebyshev" }));
    expect(field).toMatchObject({ metric: "other", nativeMetric: "Chebyshev" });
  });
});

describe("the index kind, from the effective hnsw_config", () => {
  test.each([
    ["m above 0", { m: 16 }, undefined, "hnsw", "HNSW"],
    ["m 0 and no payload_m", { m: 0 }, undefined, "flat", "full scan (m is 0)"],
    ["m 0 and payload_m 0", { m: 0, payload_m: 0 }, undefined, "flat", "full scan (m is 0)"],
    ["m 0 and payload_m above 0", { m: 0, payload_m: 16 }, undefined, "opaque", "HNSW per tenant (payload_m)"],
    ["the vector's own m 0 over the collection's 16", { m: 16 }, { m: 0 }, "flat", "full scan (m is 0)"],
    ["the vector's own m over the collection's 0", { m: 0 }, { m: 8 }, "hnsw", "HNSW"],
    [
      "the vector's own payload_m beside the collection's m 0",
      { m: 0 },
      { payload_m: 8 },
      "opaque",
      "HNSW per tenant (payload_m)",
    ],
    ["no m anywhere", {}, undefined, "opaque", "unknown"],
  ] as const)("%s", (_case, collectionHnsw, own, indexKind, nativeIndex) => {
    const [vector] = qdrantVectors(
      described({ size: 4, distance: "Dot", ...(own === undefined ? {} : { hnsw_config: own }) }, {}, collectionHnsw),
    );
    expect(vector).toMatchObject({ indexKind, nativeIndex });
  });

  test("a sparse vector is an inverted index, whatever the collection's hnsw_config", () => {
    const sparse = qdrantVectors(seeded("docs")).find((vector) => vector.name === "keywords");
    expect(sparse).toMatchObject({ indexKind: "opaque", nativeIndex: "sparse inverted index" });
  });

  test("quantization and the build state do not change the kind", () => {
    // plain has 300 points and none indexed yet (indexed_vectors_count 0): the kind is still its configuration.
    expect(seeded("plain").info.indexed_vectors_count).toBe(0);
    expect(qdrantVectors(seeded("plain"))[0]).toMatchObject({ indexKind: "hnsw" });
    const [quantized] = qdrantVectors(
      described({ size: 4, distance: "Dot", quantization_config: { scalar: { type: "int8" } } }),
    );
    expect(quantized).toMatchObject({ indexKind: "hnsw", typeText: "Dense(4, float32, Dot)" });
  });
});

describe("qdrantVectors", () => {
  test("docs: the dense vectors and the multivector in the description's order, then the sparse one", () => {
    expect(qdrantVectors(seeded("docs")).map((vector) => [vector.column, vector.typeText])).toEqual([
      ["vector.colbert", "Multi(16, float32, Dot, max_sim)"],
      ["vector.image", "Dense(64, float32, Euclid)"],
      ["vector.text", "Dense(384, float32, Cosine; stored normalised)"],
      ["vector.keywords", "Sparse(idf)"],
    ]);
  });

  test("small_dtypes: every datatype, and the sparse vector's from its index", () => {
    expect(qdrantVectors(seeded("small_dtypes")).map((vector) => [vector.column, vector.typeText])).toEqual([
      ["vector.f16", "Dense(8, float16, Cosine)"],
      ["vector.manhattan", "Dense(4, float32, Manhattan)"],
      ["vector.t4", "Dense(64, turbo4, Cosine)"],
      ["vector.u8", "Dense(8, uint8, Euclid)"],
      ["vector.sp_u8", "Sparse(none, uint8)"],
    ]);
  });

  test("an unnamed vector is the column `vector`, and a collection with no vectors has none", () => {
    expect(qdrantVectors(seeded("plain")).map((vector) => [vector.name, vector.column, vector.typeText])).toEqual([
      ["", "vector", "Dense(4, float32, Dot)"],
    ]);
    expect(qdrantVectors(seeded("empty_novec"))).toEqual([]);
    expect(qdrantVectors(readQdrantCollection("bare", { config: { params: {} } }))).toEqual([]);
  });

  test("a named vector called size is a named vector, because its value is an object", () => {
    const vectors = qdrantVectors(described({ size: { size: 4, distance: "Dot" } }));
    expect(vectors.map((vector) => vector.column)).toEqual(["vector.size"]);
  });

  test("every type text reads back to the target of its field", () => {
    for (const collection of SEEDED_COLLECTIONS) {
      const fields = qdrantVectorFields(seeded(collection));
      for (const [index, vector] of qdrantVectors(seeded(collection)).entries()) {
        const { name, kind, dtype, dimension } = fields[index];
        expect(vectorTargetOfType(vector.name, vector.typeText)).toEqual({ name, kind, dtype, dimension });
        expect(vectorNameOfColumn(vector.column)).toBe(vector.name);
      }
    }
  });

  test.each([
    ["a datatype this version does not read", { size: 4, distance: "Dot", datatype: "float64" }, "float64"],
    ["no size", { distance: "Dot" }, "declares no size and distance"],
    ["a vector that is not an object", { broken: 7 }, "declares no size and distance"],
  ])("%s is refused by name", (_case, vectors, named) => {
    expect(() => qdrantVectors(described(vectors))).toThrow(QueryError);
    expect(() => qdrantVectors(described(vectors))).toThrow(named);
  });

  test("a sparse vector whose index names an unknown datatype is refused by name", () => {
    const collection = described({}, { sparse_vectors: { sp: { index: { datatype: "float64" } } } });
    expect(() => qdrantVectors(collection)).toThrow('vector "sp" has the datatype "float64"');
  });
});

describe("qdrantVectorColumns", () => {
  test("docs: each vector column's declaration, the sparse one with Qdrant's own encoding", () => {
    expect(qdrantVectorColumns(seeded("docs"))).toEqual({
      "vector.text": { kind: "dense", dtype: "float32", dimension: 384 },
      "vector.image": { kind: "dense", dtype: "float32", dimension: 64 },
      "vector.colbert": { kind: "multi", dtype: "float32", dimension: 16 },
      "vector.keywords": { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "indices-values" },
    });
  });

  test("small_dtypes: turbo4 is read as float32, and the sparse column takes its index's datatype", () => {
    expect(qdrantVectorColumns(seeded("small_dtypes"))).toMatchObject({
      "vector.f16": { dtype: "float16" },
      "vector.u8": { dtype: "uint8" },
      "vector.t4": { dtype: "float32", dimension: 64 },
      "vector.sp_u8": { kind: "sparse", dtype: "uint8", sparseEncoding: "indices-values" },
    });
  });

  test("a vector named __proto__ is a column like any other", () => {
    const columns = qdrantVectorColumns(described(JSON.parse('{"__proto__": {"size": 4, "distance": "Dot"}}')));
    expect(Object.keys(columns)).toEqual(["vector.__proto__"]);
  });
});

describe("qdrantDeclaredColumns and qdrantIndexes", () => {
  test("docs: the id, one column per vector, one per payload index typed by the index", () => {
    const columns = qdrantDeclaredColumns(seeded("docs"));
    expect(columns[0]).toEqual({ name: "id", type: "uint64 or UUID", nullable: false, isPrimary: true });
    expect(columns.slice(1, 5).map((column) => column.name)).toEqual([
      "vector.colbert",
      "vector.image",
      "vector.text",
      "vector.keywords",
    ]);
    expect(columns.slice(5).map((column) => [column.name, column.type])).toEqual([
      ["active", "bool"],
      ["price", "float"],
      ["created_at", "datetime"],
      ["seq", "integer"],
      ["location", "geo"],
      ["category", "keyword"],
      ["tags", "keyword"],
      ["ref_uuid", "uuid"],
      ["body", "text"],
      ["big_int", "integer"],
      ["meta.owner.team", "keyword"],
    ]);
    expect(columns.some((column) => column.provenance !== undefined)).toBe(false);
    expect(columns.filter((column) => column.isPrimary).map((column) => column.name)).toEqual(["id"]);
  });

  test("a named or sparse vector and a payload field may be absent on a point; the unnamed vector and the id are not", () => {
    const nullable = (collection: string) =>
      Object.fromEntries(qdrantDeclaredColumns(seeded(collection)).map((column) => [column.name, column.nullable]));
    expect(nullable("docs")).toMatchObject({ id: false, "vector.image": true, "vector.keywords": true, seq: true });
    expect(nullable("plain")).toEqual({ id: false, vector: false });
  });

  test("an indexed key that an engine column already uses is a payload column", () => {
    const collection = readQdrantCollection("probe", {
      config: { params: { vectors: {} } },
      payload_schema: { id: { data_type: "keyword", points: 1 }, "vector.text": { data_type: "integer", points: 1 } },
    });
    expect(qdrantDeclaredColumns(collection).map((column) => column.name)).toEqual([
      "id",
      "payload.id",
      "payload.vector.text",
    ]);
    expect(qdrantIndexes(collection)).toEqual([
      { name: "id", columns: ["payload.id"], unique: false },
      { name: "vector.text", columns: ["payload.vector.text"], unique: false },
    ]);
  });

  test("docs: an index per payload index, named by the key a filter writes, and one per vector", () => {
    const indexes = qdrantIndexes(seeded("docs"));
    expect(indexes).toHaveLength(15);
    expect(indexes[0]).toEqual({ name: "active", columns: ["active"], unique: false });
    expect(indexes.slice(11).map((index) => index.name)).toEqual([
      "vector.colbert",
      "vector.image",
      "vector.text",
      "vector.keywords",
    ]);
  });

  test("a parameterised index carries its parameters, and an entry with no data_type is not an index", () => {
    const collection = readQdrantCollection("probe", {
      config: { params: {} },
      payload_schema: {
        title: { data_type: "text", points: 3, params: { type: "text", tokenizer: "word" } },
        broken: { points: 3 },
        category: { data_type: "keyword", points: 3 },
      },
    });
    expect(qdrantPayloadIndexes(collection)).toEqual([
      { key: "title", column: "title", type: "text", params: { type: "text", tokenizer: "word" } },
      { key: "category", column: "category", type: "keyword" },
    ]);
  });

  test("a description with no payload_schema declares no payload index", () => {
    expect(qdrantPayloadIndexes(readQdrantCollection("bare", { config: { params: {} } }))).toEqual([]);
  });
});

describe("readQdrantCollection and qdrantCount", () => {
  test.each([
    ["null", null, "the answer holds no result object"],
    ["a list", [], "the answer holds no result object"],
    ["an object with no config", { status: "green" }, "it holds no config"],
    ["a config with no params", { config: {} }, "its config holds no params"],
  ])("a result that is %s is refused naming the collection and the part", (_case, result, part) => {
    expect(() => readQdrantCollection("docs", result)).toThrow(QueryError);
    expect(() => readQdrantCollection("docs", result)).toThrow(`collection "docs" is not one Studio can read: ${part}`);
  });

  test("a description read for a console request, which names the collection itself, is refused naming the request", () => {
    expect(() => readQdrantCollection("", { status: "green" })).toThrow(
      "Qdrant's description of the collection this request names is not one Studio can read: it holds no config.",
    );
  });

  test("a count is a number, the exact digits of one past 2^53, or absent", () => {
    expect(qdrantCount(2000)).toBe(2000);
    expect(qdrantCount(0)).toBe(0);
    expect(qdrantCount("9007199254740993")).toBe(9007199254740992);
    expect(qdrantCount(null)).toBeNull();
    expect(qdrantCount(undefined)).toBeNull();
    expect(qdrantCount("many")).toBeNull();
  });
});

describe("qdrantCollectionFacts", () => {
  test.each([...SEEDED_COLLECTIONS])(
    "%s: the facts a console request reads are the seed's fields and indexes",
    (collection) => {
      const described = seeded(collection);
      const facts = qdrantCollectionFacts(described);
      expect(facts.vectors).toEqual(qdrantVectorFields(described));
      expect([...facts.payloadIndexTypes]).toEqual(
        qdrantPayloadIndexes(described).map((index) => [index.key, index.type]),
      );
    },
  );

  test("small_dtypes: only the turbo4 vector is answered as a reconstruction", () => {
    const turbo4 = qdrantVectors(seeded("small_dtypes"))
      .filter((vector) => vector.shape.datatype === "turbo4")
      .map((vector) => vector.name);
    expect(turbo4.length).toBeGreaterThan(0);
    expect([...qdrantCollectionFacts(seeded("small_dtypes")).reconstructed]).toEqual(turbo4);
  });

  test("docs: no vector is reconstructed, and each payload index is typed by its index", () => {
    const facts = qdrantCollectionFacts(seeded("docs"));
    expect(facts.reconstructed.size).toBe(0);
    expect(facts.payloadIndexTypes.size).toBeGreaterThan(0);
  });
});
