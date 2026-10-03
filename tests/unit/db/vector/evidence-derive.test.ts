/**
 * What the vector evidence harness derives from the seeds' manifests (tests/live/vector-evidence-derive.ts;
 * vector-family spec 7.3): the expected VectorFieldInfo[] per collection, the expected cells in Studio's cell form,
 * the Milvus non-finite score REST cannot encode, and the float32 comparison of a derived cell with a REST cell.
 */
import { describe, expect, test } from "bun:test";
import {
  compareCell,
  expectedMilvusCells,
  expectedMilvusFields,
  expectedQdrantCells,
  expectedQdrantFields,
  float32SelfInnerProduct,
  type MilvusManifest,
  milvusNonFiniteScore,
  type QdrantManifest,
  scoreText,
  serialiseFixture,
  type VectorIndexKindJson,
} from "../../../live/vector-evidence-derive";

const MILVUS: MilvusManifest = {
  engine: "milvus",
  server_version: "v3.0.2",
  databases: {
    default: {
      docs_varchar: {
        rows: 1,
        loaded: true,
        key: "pk",
        functions: [],
        fields: [
          { name: "pk", type: "VarChar" },
          { name: "f16", type: "Float16Vector", dim: 2 },
          { name: "bin", type: "BinaryVector", dim: 16 },
          { name: "sparse", type: "SparseFloatVector" },
          { name: "q", type: "FloatVector", dim: 2 },
        ],
        indexes: {
          f16: { type: "HNSW", metric: "L2", params: {} },
          bin: { type: "BIN_IVF_FLAT", metric: "HAMMING", params: {} },
          sparse: { type: "SPARSE_INVERTED_INDEX", metric: "IP", params: {} },
          q: { type: "AUTOINDEX", metric: "COSINE", params: {} },
        },
        sample: [
          {
            seq: 0,
            key: "vc-0000",
            values: {
              pk: "vc-0000",
              f16: [65504, 0.5],
              bin: [0, 255],
              sparse: { "900": 0.25, "17": 0.5 },
              q: [0.6, 0.8],
            },
          },
        ],
      },
      docs_int64: {
        rows: 1,
        loaded: true,
        key: null,
        functions: [],
        fields: [
          { name: "id", type: "Int64" },
          { name: "seq", type: "Int64" },
          { name: "vec", type: "FloatVector", dim: 2 },
        ],
        indexes: { vec: { type: "HNSW", metric: "COSINE", params: {} } },
        sample: [{ seq: 0, key: null, values: { seq: 0, vec: [0.6, 0.8] } }],
      },
      fts: {
        rows: 1,
        loaded: true,
        key: "id",
        functions: [{ name: "text_bm25", output: ["text_sparse"] }],
        fields: [
          { name: "id", type: "Int64" },
          { name: "text", type: "VarChar" },
          { name: "text_sparse", type: "SparseFloatVector" },
        ],
        indexes: { text_sparse: { type: "SPARSE_INVERTED_INDEX", metric: "BM25", params: {} } },
        sample: [{ seq: 0, key: 0, values: { id: 0, text: "the cat reads the logs quickly" } }],
      },
      edge_values: {
        rows: 1,
        loaded: true,
        key: "id",
        functions: [],
        fields: [
          { name: "id", type: "Int64" },
          { name: "sp", type: "SparseFloatVector" },
        ],
        indexes: { sp: { type: "SPARSE_INVERTED_INDEX", metric: "IP", params: {} } },
        sample: [{ seq: 2, key: 3, values: { id: 3, label: "non-finite-score", sp: { "1": 3.3999999521443642e38 } } }],
      },
    },
  },
};

const QDRANT: QdrantManifest = {
  engine: "qdrant",
  server_version: "1.19.1",
  collections: {
    docs: {
      points: 1,
      vectors: [
        {
          name: "text",
          kind: "dense",
          size: 2,
          distance: "Cosine",
          datatype: "float32",
          derivable: false,
          reason: "the server normalises a Cosine vector when it is written",
        },
        { name: "image", kind: "dense", size: 2, distance: "Euclid", datatype: "float32", derivable: true },
        { name: "colbert", kind: "multi", size: 2, distance: "Dot", datatype: "float32", derivable: true },
        { name: "keywords", kind: "sparse", size: null, distance: null, datatype: "float32", derivable: true },
      ],
      sample: [
        {
          seq: 0,
          id: "18446744073709551615",
          vectors: {
            image: [1.5, -2],
            colbert: [
              [1, 2],
              [3, 4],
            ],
            keywords: { indices: [30, 7], values: [0.5, 0.25] },
          },
        },
      ],
    },
    small_dtypes: {
      points: 1,
      vectors: [
        {
          name: "t4",
          kind: "dense",
          size: 64,
          distance: "Cosine",
          datatype: "turbo4",
          derivable: false,
          reason: "turbo4 stores a reconstruction",
        },
        { name: "f16", kind: "dense", size: 4, distance: "Euclid", datatype: "float16", derivable: true },
        { name: "sp_u8", kind: "sparse", size: null, distance: null, datatype: "uint8", derivable: true },
      ],
      sample: [{ seq: 0, id: 0, vectors: { f16: [null, 1, 2, 3], sp_u8: null } }],
    },
    plain: {
      points: 1,
      vectors: [{ name: "", kind: "dense", size: 2, distance: "Dot", datatype: "float32", derivable: true }],
      sample: [{ seq: 0, id: 1, vectors: { "": [0.25, 0.5] } }],
    },
    empty_novec: { points: 0, vectors: [], sample: [] },
  },
};

describe("expectedMilvusFields", () => {
  const fields = expectedMilvusFields(MILVUS);

  test("maps every vector field of every collection, and only vector fields", () => {
    expect(Object.keys(fields).sort()).toEqual([
      "default/docs_int64",
      "default/docs_varchar",
      "default/edge_values",
      "default/fts",
    ]);
    expect(fields["default/docs_varchar"].map((field) => field.name)).toEqual(["f16", "bin", "sparse", "q"]);
  });

  test("L2 is the squared Euclidean distance, never the plain one", () => {
    expect(fields["default/docs_varchar"][0]).toEqual({
      name: "f16",
      kind: "dense",
      dtype: "float16",
      dimension: 2,
      metric: "euclidean_squared",
      nativeMetric: "L2",
      indexKind: "hnsw",
      nativeType: "Float16Vector(2)",
    });
  });

  test("a binary field counts its dimension in bits, and a sparse field has none", () => {
    expect(fields["default/docs_varchar"][1]).toMatchObject({
      dtype: "binary",
      dimension: 16,
      metric: "hamming",
      indexKind: "ivf",
    });
    expect(fields["default/docs_varchar"][2]).toMatchObject({
      kind: "sparse",
      dimension: null,
      metric: "dot",
      nativeType: "SparseFloatVector",
    });
  });

  test("an index type the table does not name is opaque, and BM25 is the family's other metric", () => {
    expect(fields["default/docs_varchar"][3]).toMatchObject({ indexKind: "opaque", metric: "cosine" });
    expect(fields["default/fts"][0]).toMatchObject({ metric: "other", nativeMetric: "BM25", indexKind: "opaque" });
  });

  test("a metric the family has no value for is refused by name", () => {
    const unknownMetric = structuredClone(MILVUS) as unknown as {
      databases: { default: { docs_int64: { indexes: { vec: { metric: string } } } } };
    };
    unknownMetric.databases.default.docs_int64.indexes.vec.metric = "MHJACCARD";
    expect(() => expectedMilvusFields(unknownMetric as unknown as MilvusManifest)).toThrow(
      "no family value for the Milvus metric of default.docs_int64.vec MHJACCARD",
    );
  });

  test("a field with no index has neither a metric nor an index kind", () => {
    const noIndex = structuredClone(MILVUS) as unknown as {
      databases: { default: { docs_int64: { indexes: Record<string, unknown> } } };
    };
    noIndex.databases.default.docs_int64.indexes = {};
    expect(expectedMilvusFields(noIndex as unknown as MilvusManifest)["default/docs_int64"][0]).toEqual({
      name: "vec",
      kind: "dense",
      dtype: "float32",
      dimension: 2,
      metric: null,
      nativeMetric: null,
      indexKind: null,
      nativeType: "FloatVector(2)",
    });
  });

  test("every index type maps to its family kind, and a name the table does not list is opaque", () => {
    const kinds: Record<string, VectorIndexKindJson> = {
      HNSW: "hnsw",
      HNSW_SQ: "hnsw",
      HNSW_PQ: "hnsw",
      HNSW_PRQ: "hnsw",
      FLAT: "flat",
      BIN_FLAT: "flat",
      GPU_BRUTE_FORCE: "flat",
      IVF_FLAT: "ivf",
      IVF_SQ8: "ivf",
      IVF_PQ: "ivf",
      IVF_RABITQ: "ivf",
      BIN_IVF_FLAT: "ivf",
      SCANN: "ivf",
      IVF_FLAT_CC: "ivf",
      IVF_SQ_CC: "ivf",
      GPU_IVF_FLAT: "ivf",
      GPU_IVF_PQ: "ivf",
      DISKANN: "graph_other",
      AISAQ: "graph_other",
      GPU_CAGRA: "graph_other",
      AUTOINDEX: "opaque",
      SPARSE_INVERTED_INDEX: "opaque",
      SPARSE_WAND: "opaque",
      MINHASH_LSH: "opaque",
      SOME_FUTURE_INDEX: "opaque",
    };
    for (const [type, kind] of Object.entries(kinds)) {
      const manifest = structuredClone(MILVUS) as unknown as {
        databases: { default: { docs_int64: { indexes: { vec: { type: string } } } } };
      };
      manifest.databases.default.docs_int64.indexes.vec.type = type;
      const field = expectedMilvusFields(manifest as unknown as MilvusManifest)["default/docs_int64"][0];
      expect({ type, kind: field.indexKind }).toEqual({ type, kind });
    }
  });
});

describe("expectedQdrantFields", () => {
  const fields = expectedQdrantFields(QDRANT);

  test("Euclid is the plain Euclidean distance, and a multivector says so in its native type", () => {
    expect(fields.docs[1]).toEqual({
      name: "image",
      kind: "dense",
      dtype: "float32",
      dimension: 2,
      metric: "euclidean",
      nativeMetric: "Euclid",
      indexKind: "hnsw",
      nativeType: "float32(2)",
    });
    expect(fields.docs[2]).toMatchObject({ kind: "multi", metric: "dot", nativeType: "float32(2) multivector" });
  });

  test("a sparse vector has no dimension and scores by dot product, with its datatype in the native type", () => {
    expect(fields.small_dtypes[2]).toEqual({
      name: "sp_u8",
      kind: "sparse",
      dtype: "uint8",
      dimension: null,
      metric: "dot",
      nativeMetric: null,
      indexKind: "opaque",
      nativeType: "sparse uint8",
    });
  });

  test('turbo4 is read as float32, an unnamed vector keeps the name "", and a collection with no vector has none', () => {
    expect(fields.small_dtypes[0]).toMatchObject({ dtype: "float32", nativeType: "turbo4(64)" });
    expect(fields.plain[0]).toMatchObject({ name: "", metric: "dot" });
    expect(fields.empty_novec).toEqual([]);
  });

  test("a vector with no HNSW setting of its own or of its collection takes the server's default, m 16, and is hnsw", () => {
    expect(fields.docs.map((field) => field.indexKind)).toEqual(["hnsw", "hnsw", "hnsw", "opaque"]);
  });

  test("the vector's own HNSW setting decides over its collection's: m 0 is flat, or opaque with payload_m above 0", () => {
    const withConfig = (collectionConfig: object | undefined, vectorConfig: object | undefined) => {
      const manifest = structuredClone(QDRANT) as unknown as {
        collections: { plain: { hnsw_config?: object; vectors: { hnsw_config?: object }[] } };
      };
      if (collectionConfig !== undefined) manifest.collections.plain.hnsw_config = collectionConfig;
      if (vectorConfig !== undefined) manifest.collections.plain.vectors[0].hnsw_config = vectorConfig;
      return expectedQdrantFields(manifest as unknown as QdrantManifest).plain[0].indexKind;
    };
    expect(withConfig({ m: 0 }, undefined)).toBe("flat");
    expect(withConfig({ m: 0, payload_m: 0 }, undefined)).toBe("flat");
    expect(withConfig({ m: 0, payload_m: 16 }, undefined)).toBe("opaque");
    expect(withConfig({ m: 0 }, { m: 32 })).toBe("hnsw");
    expect(withConfig({ m: 16 }, { m: 0 })).toBe("flat");
    expect(withConfig({ m: 16, payload_m: 8 }, { m: 0 })).toBe("opaque");
    expect(withConfig({ m: 0, payload_m: 8 }, { payload_m: 0 })).toBe("flat");
  });

  test("a sparse vector is opaque whatever its collection's HNSW setting", () => {
    const manifest = structuredClone(QDRANT) as unknown as { collections: { docs: { hnsw_config?: object } } };
    manifest.collections.docs.hnsw_config = { m: 0 };
    expect(expectedQdrantFields(manifest as unknown as QdrantManifest).docs[3].indexKind).toBe("opaque");
  });
});

describe("expectedMilvusCells", () => {
  const { cells, excluded } = expectedMilvusCells(MILVUS);
  const cell = (collection: string, field: string) =>
    cells.find((entry) => entry.collection === collection && entry.field === field);

  test("a sparse cell is an index map in ascending index order", () => {
    expect(Object.keys(cell("default/docs_varchar", "sparse")?.cell as object)).toEqual(["17", "900"]);
  });

  test("dense and binary cells are the stored numbers and bytes, addressed by the primary key", () => {
    expect(cell("default/docs_varchar", "f16")).toEqual({
      collection: "default/docs_varchar",
      seq: 0,
      match: { field: "pk", value: "vc-0000" },
      field: "f16",
      kind: "dense",
      dtype: "float16",
      cell: [65504, 0.5],
    });
    expect(cell("default/docs_varchar", "bin")?.cell).toEqual([0, 255]);
  });

  test("a collection whose key the server assigns is addressed by seq", () => {
    expect(cell("default/docs_int64", "vec")?.match).toEqual({ field: "seq", value: 0 });
  });

  test("a server function's output is excluded by name, because the seed never writes it", () => {
    expect(excluded).toEqual([
      {
        collection: "default/fts",
        field: "text_sparse",
        reason: "a server function's output, which the seed never writes",
      },
    ]);
  });
});

describe("expectedQdrantCells", () => {
  const { cells, excluded } = expectedQdrantCells(QDRANT);
  const cell = (collection: string, field: string) =>
    cells.find((entry) => entry.collection === collection && entry.field === field);

  test("a sparse cell is {indices, values} in ascending index order, its values moved with their indices", () => {
    expect(cell("docs", "keywords")?.cell).toEqual({ indices: [7, 30], values: [0.25, 0.5] });
  });

  test("a float16 element that overflowed stays null, and a point without a vector has a null cell", () => {
    expect(cell("small_dtypes", "f16")?.cell).toEqual([null, 1, 2, 3]);
    expect(cell("small_dtypes", "sp_u8")?.cell).toBeNull();
  });

  test('a point is addressed by its id, exact above 2^53, and an unnamed vector by ""', () => {
    expect(cell("docs", "image")?.match).toEqual({ field: "id", value: "18446744073709551615" });
    expect(cell("plain", "")?.cell).toEqual([0.25, 0.5]);
  });

  test("a vector the server does not return as sent is excluded with the manifest's reason", () => {
    expect(excluded).toEqual([
      { collection: "docs", field: "text", reason: "the server normalises a Cosine vector when it is written" },
      { collection: "small_dtypes", field: "t4", reason: "turbo4 stores a reconstruction" },
    ]);
  });
});

describe("the non-finite score", () => {
  test("a 3.4e38 sparse value's self inner product is Infinity in float32 and finite in double", () => {
    const score = milvusNonFiniteScore(MILVUS);
    expect(score.score).toBe("Infinity");
    expect(score.doubleSelfInnerProduct).toBe(1.1559999674581679e77);
    expect(score).toMatchObject({
      collection: "default/edge_values",
      id: 3,
      field: "sp",
      cell: { "1": 3.3999999521443642e38 },
    });
  });

  test("float32 accumulation overflows where double does not, and a finite sum stays a number", () => {
    expect(float32SelfInnerProduct([3, 4])).toBe(25);
    expect(float32SelfInnerProduct([2e19, 2e19])).toBe(Number.POSITIVE_INFINITY);
    expect(scoreText(25)).toBe(25);
    expect(scoreText(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
    expect(scoreText(Number.NaN)).toBe("NaN");
  });

  test("a manifest without the labelled row is refused", () => {
    const without = structuredClone(MILVUS) as unknown as { databases: { default: Record<string, unknown> } };
    delete without.databases.default.edge_values;
    expect(() => milvusNonFiniteScore(without as unknown as MilvusManifest)).toThrow(
      "the Milvus manifest has no edge_values row labelled non-finite-score",
    );
  });
});

describe("compareCell", () => {
  test("numbers compare as float32, so the shortest float32 text equals the double it came from", () => {
    expect(compareCell([0.1676955372095108], [0.16769554])).toEqual({ status: "equal" });
    expect(compareCell([0.1], [0.2])).toEqual({ status: "differs", detail: "cell[0]: expected 0.1, REST holds 0.2" });
  });

  test("zero keeps its sign: -0 equals only -0", () => {
    expect(compareCell([-0], [-0])).toEqual({ status: "equal" });
    expect(compareCell([-0], [0])).toEqual({ status: "differs", detail: "cell[0]: expected -0, REST holds 0" });
    expect(compareCell([0], [-0])).toEqual({ status: "differs", detail: "cell[0]: expected 0, REST holds -0" });
  });

  test("null equals only null", () => {
    expect(compareCell([null, 1], [null, 1])).toEqual({ status: "equal" });
    expect(compareCell([null], [65504])).toEqual({
      status: "differs",
      detail: "cell[0]: expected null, REST holds 65504",
    });
  });

  test("a REST cell of another shape is not comparable, which is not a difference", () => {
    expect(compareCell([0, 255], "AP8=")).toEqual({ status: "not-comparable", detail: "cell: REST holds string" });
    expect(compareCell({ "1": 0.5 }, [[1, 0.5]])).toEqual({
      status: "not-comparable",
      detail: "cell: REST holds an array",
    });
  });

  test("objects compare key by key, and a missing key is a difference", () => {
    expect(compareCell({ indices: [7], values: [0.25] }, { values: [0.25], indices: [7] })).toEqual({
      status: "equal",
    });
    expect(compareCell({ "1": 0.5, "2": 0.5 }, { "1": 0.5 })).toEqual({
      status: "differs",
      detail: "cell: expected the keys 1,2, REST holds 1",
    });
  });

  test("arrays of another length differ", () => {
    expect(compareCell([[1, 2]], [[1, 2, 3]])).toEqual({
      status: "differs",
      detail: "cell[0]: expected 2 elements, REST holds 3",
    });
  });
});

describe("serialiseFixture", () => {
  test("writes -0 as -0.0, so the file parses back to the signed zero the seed stored", () => {
    const text = serialiseFixture({ cell: [-0, 0, 1.5, -2], nested: { zero: -0 } });
    expect(text).toBe(
      '{\n  "cell": [\n    -0.0,\n    0,\n    1.5,\n    -2\n  ],\n  "nested": {\n    "zero": -0.0\n  }\n}\n',
    );
    const parsed = JSON.parse(text) as { cell: number[]; nested: { zero: number } };
    expect(Object.is(parsed.cell[0], -0)).toBe(true);
    expect(Object.is(parsed.cell[1], 0)).toBe(true);
    expect(Object.is(parsed.nested.zero, -0)).toBe(true);
  });

  test("refuses content that already holds its placeholder for the signed zero", () => {
    expect(() => serialiseFixture({ text: "\u0000negative-zero\u0000" })).toThrow(
      "the content holds the serialiser's placeholder for -0",
    );
  });
});
