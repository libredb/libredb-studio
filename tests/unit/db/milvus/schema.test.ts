/**
 * DescribeCollection and DescribeIndex in the shapes the tree, the agent and the Load preview read. The columns are
 * the described fields with the type text Studio spells everywhere and never a default value; the vector fields with
 * their indexes reproduce, for every seeded collection, the `VectorFieldInfo` list the shared fixtures commit, from
 * the DescribeCollection answers captured over gRPC; and the index-kind table has one test per row, a name it does
 * not list being `opaque`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DescribeCollectionResponse } from "@/lib/db/providers/vector/milvus/client";
import {
  collectionColumns,
  describedSchema,
  indexParam,
  MILVUS_INDEX_KINDS,
  milvusIndexKind,
  vectorFieldInfos,
  withIndexKinds,
} from "@/lib/db/providers/vector/milvus/schema";
import type { VectorFieldInfo, VectorIndexKind } from "@/lib/db/vector/types";
import {
  collectionSchema,
  describeAnswer,
  describedCollection,
  describedIndex,
  fieldSchema,
} from "../../../helpers/milvus-described";
import { capturedAnswer, milvusCapture } from "../../../helpers/milvus-fixtures";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "milvus");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

const EXPECTED = fixture<{ readonly fields: Readonly<Record<string, readonly VectorFieldInfo[]>> }>(
  "expected-fields.json",
);
const MANIFEST = fixture<{
  readonly databases: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          { readonly indexes: Readonly<Record<string, { readonly type: string; readonly metric: string }>> }
        >
      >
    >
  >;
}>("manifest.json");

/** The seeded collections of database `default`. */
const SEEDED = Object.keys(EXPECTED.fields)
  .filter((key) => key.startsWith("default/"))
  .map((key) => key.slice("default/".length));

/** A seeded collection's DescribeCollection answer, as the gRPC capture recorded it. */
const captured = (name: string): DescribeCollectionResponse =>
  capturedAnswer(milvusCapture(`milvus/describe-collection-default-${name}`)) as DescribeCollectionResponse;

describe("collectionColumns", () => {
  test("docs_int64: every field with its type text, the key and the nullable ones marked, the dynamic field as $meta", () => {
    expect(collectionColumns(describedCollection("docs_int64"))).toEqual([
      { name: "id", type: "Int64", nullable: false, isPrimary: true },
      { name: "seq", type: "Int64", nullable: false, isPrimary: false },
      { name: "vec", type: "FloatVector(8)", nullable: false, isPrimary: false },
      { name: "title", type: "VarChar(256)", nullable: false, isPrimary: false },
      { name: "meta", type: "JSON", nullable: false, isPrimary: false },
      { name: "tags", type: "Array<Int64>(8)", nullable: false, isPrimary: false },
      { name: "maybe_count", type: "Int32", nullable: true, isPrimary: false },
      { name: "$meta", type: "JSON (dynamic)", nullable: true, isPrimary: false },
    ]);
  });

  test("a function's output field is spelled with its function", () => {
    const sparse = collectionColumns(describedCollection("fts")).find((column) => column.name === "text_sparse");
    expect(sparse?.type).toBe("SparseFloatVector(BM25: text_bm25)");
  });

  test("no column carries a default value, whatever the field declares", () => {
    const described = describeAnswer(
      collectionSchema("defaults", [
        fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
        fieldSchema({
          name: "label",
          data_type: "VarChar",
          default_value: { string_data: "MARKER", data: "string_data" },
        }),
      ]),
    );
    const columns = collectionColumns(described);
    expect(columns.every((column) => !("defaultValue" in column))).toBe(true);
    expect(JSON.stringify(columns)).not.toContain("MARKER");
  });

  test("a struct array field is one column under the engine's name for its type", () => {
    const described = describeAnswer(
      collectionSchema("clips", [fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true })], {
        struct_array_fields: [
          {
            fieldID: "101",
            name: "frames",
            description: "",
            fields: [
              fieldSchema({
                name: "semb",
                data_type: "ArrayOfVector",
                element_type: "FloatVector",
                type_params: [{ key: "dim", value: "4" }],
              }),
            ],
            type_params: [],
            nullable: true,
          },
        ],
      }),
    );
    expect(collectionColumns(described)[1]).toEqual({
      name: "frames",
      type: "ArrayOfStruct",
      nullable: true,
      isPrimary: false,
    });
    expect(vectorFieldInfos(described).map((field) => [field.name, field.kind])).toEqual([["frames[semb]", "multi"]]);
  });

  test("a describe answer with no schema is refused in Studio's words", () => {
    const empty = { ...describedCollection("docs_int64"), schema: null };
    expect(() => collectionColumns(empty)).toThrow(
      "Milvus described collection docs_int64 with no schema, so Studio reads no field from it.",
    );
    expect(() => vectorFieldInfos(empty)).toThrow("with no schema");
    expect(describedSchema(describedCollection("docs_int64")).name).toBe("docs_int64");
  });
});

describe("vectorFieldInfos", () => {
  test("from DescribeCollection alone, a vector field has no metric and no index kind", () => {
    expect(vectorFieldInfos(describedCollection("docs_int64"))).toEqual([
      {
        name: "vec",
        kind: "dense",
        dtype: "float32",
        dimension: 8,
        metric: null,
        nativeMetric: null,
        indexKind: null,
        nativeType: "FloatVector(8)",
      },
    ]);
  });

  test.each(SEEDED.map((name) => [name]))(
    "%s: the captured describe with its indexes reproduces the committed VectorFieldInfo list",
    (name) => {
      const indexes = Object.fromEntries(
        Object.entries(MANIFEST.databases.default[name].indexes).map(([field, index]) => [
          field,
          { indexType: index.type, metric: index.metric },
        ]),
      );
      const fields = withIndexKinds(vectorFieldInfos(captured(name)), describedIndex(indexes).index_descriptions);
      expect(fields).toEqual([...EXPECTED.fields[`default/${name}`]]);
    },
  );

  test("the seeded set is the eleven collections of database default", () => {
    expect(SEEDED).toHaveLength(11);
  });
});

const ROWS: ReadonlyArray<readonly [string, VectorIndexKind]> = [
  ["HNSW", "hnsw"],
  ["HNSW_SQ", "hnsw"],
  ["HNSW_PQ", "hnsw"],
  ["HNSW_PRQ", "hnsw"],
  ["FLAT", "flat"],
  ["BIN_FLAT", "flat"],
  ["GPU_BRUTE_FORCE", "flat"],
  ["IVF_FLAT", "ivf"],
  ["IVF_SQ8", "ivf"],
  ["IVF_PQ", "ivf"],
  ["IVF_RABITQ", "ivf"],
  ["BIN_IVF_FLAT", "ivf"],
  ["SCANN", "ivf"],
  ["IVF_FLAT_CC", "ivf"],
  ["IVF_SQ_CC", "ivf"],
  ["GPU_IVF_FLAT", "ivf"],
  ["GPU_IVF_PQ", "ivf"],
  ["DISKANN", "graph_other"],
  ["AISAQ", "graph_other"],
  ["GPU_CAGRA", "graph_other"],
  ["AUTOINDEX", "opaque"],
  ["SPARSE_INVERTED_INDEX", "opaque"],
  ["SPARSE_WAND", "opaque"],
  ["MINHASH_LSH", "opaque"],
];

describe("MILVUS_INDEX_KINDS", () => {
  test.each(ROWS)("%s is %s", (indexType, kind) => {
    expect(milvusIndexKind(indexType)).toBe(kind);
  });

  test("holds exactly the documented rows", () => {
    expect(Object.keys(MILVUS_INDEX_KINDS).sort()).toEqual(ROWS.map(([indexType]) => indexType).sort());
  });

  test.each(["IVF_HNSW_NEW", "", "hnsw", "constructor", "__proto__", "toString"])(
    "a name not in the table, %j, is opaque",
    (indexType) => {
      expect(milvusIndexKind(indexType)).toBe("opaque");
    },
  );
});

describe("withIndexKinds", () => {
  const [vec] = vectorFieldInfos(describedCollection("docs_int64"));

  test("L2 is the squared distance, and an index's metric replaces whatever the field carried", () => {
    const [field] = withIndexKinds(
      [{ ...vec, metric: "cosine", nativeMetric: "COSINE" }],
      describedIndex({ vec: { indexType: "IVF_FLAT", metric: "L2" } }).index_descriptions,
    );
    expect(field).toEqual({ ...vec, indexKind: "ivf", nativeMetric: "L2", metric: "euclidean_squared" });
  });

  test("a field with no index has no kind and no metric", () => {
    expect(withIndexKinds([{ ...vec, metric: "cosine", nativeMetric: "COSINE", indexKind: "hnsw" }], [])).toEqual([
      vec,
    ]);
  });

  test("an index that reports no type is opaque, and one that reports no metric leaves the metric null", () => {
    const [bare] = describedIndex({ vec: { indexType: "HNSW", metric: "L2" } }).index_descriptions;
    expect(withIndexKinds([vec], [{ ...bare, params: [] }])).toEqual([{ ...vec, indexKind: "opaque" }]);
  });

  test("indexParam reads one key of an index's parameters", () => {
    const [index] = describedIndex({ vec: { indexType: "HNSW", metric: "COSINE" } }).index_descriptions;
    expect(indexParam(index, "index_type")).toBe("HNSW");
    expect(indexParam(index, "M")).toBeUndefined();
  });
});
