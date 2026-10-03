/**
 * The Milvus tree texts: the click's query and Generate Command's search, every runnable
 * output parsed by the real console parser and every probe passing its field's dense check; a sparse-only collection,
 * a field with no readable dimension and a collection with no vector field get comment-only templates, so no
 * wrong-length probe is ever written.
 */
import { describe, expect, test } from "bun:test";
import type { TaggedJson } from "@/lib/db/console/tagged-json";
import {
  MILVUS_CLICK_LIMIT,
  MILVUS_SEARCH_LIMIT,
  milvusSelectQuery,
  milvusProbeText,
  milvusTableQuery,
} from "@/lib/db/providers/vector/milvus/generators";
import { milvusPhase0, parseMilvusRequest } from "@/lib/db/providers/vector/milvus/request";
import { vectorTargetOfType } from "@/lib/db/providers/vector/milvus/type-spelling";
import { checkDenseElements, type VectorTarget, vectorNumbers } from "@/lib/db/vector/dense";
import type { DialectGenerators } from "@/lib/query-generators";
import type { ColumnSchema } from "@/lib/types";

const column = (name: string, type: string, isPrimary = false, nullable = false): ColumnSchema => ({
  name,
  type,
  isPrimary,
  nullable,
});

/** docs_int64's columns as describeObject spells them. */
const DOCS_COLUMNS: readonly ColumnSchema[] = [
  column("id", "Int64", true),
  column("seq", "Int64"),
  column("vec", "FloatVector(8)"),
  column("title", "VarChar(256)"),
  column("meta", "JSON"),
  column("tags", "Array<Int64>(8)"),
  column("maybe_count", "Int32", false, true),
  column("$meta", "JSON (dynamic)", false, true),
];
const PATH = ["default", "docs_int64"];

/** The text through the console's grammar and every rule it applies before any call. */
function parsed(text: string) {
  const request = parseMilvusRequest(text);
  milvusPhase0(request, { database: "default" });
  return request;
}

/** The probe of a parsed search passes its field's own dense check. */
function expectProbePasses(text: string, columnName: string, columnType: string): void {
  const request = parsed(text);
  const target = vectorTargetOfType(columnName, columnType) as VectorTarget;
  const data = request.body.data as readonly TaggedJson[];
  const numbers = vectorNumbers(target, data[0] as readonly TaggedJson[]);
  expect(Array.isArray(numbers)).toBe(true);
  expect(checkDenseElements(target, numbers as readonly number[])).toBeNull();
}

/** The two texts are the members `DIALECT_GENERATORS.milvus` registers: this does not compile if they stop fitting. */
const REGISTERED: DialectGenerators = { table: milvusTableQuery, select: milvusSelectQuery };

describe("milvusTableQuery, the tree click", () => {
  test("queries the clicked collection's first 100 entities with an empty filter, and parses", () => {
    const text = milvusTableQuery(PATH);
    expect(text).toBe(
      'POST /v2/vectordb/entities/query\n{"dbName": "default", "collectionName": "docs_int64", "filter": "", "limit": 100}',
    );
    expect(parsed(text).route.template).toBe("entities/query");
    expect(MILVUS_CLICK_LIMIT).toBe(100);
    expect(REGISTERED.table(PATH, DOCS_COLUMNS, undefined)).toBe(text);
  });

  test("a one-segment path names the collection alone, and a name is written as a JSON string", () => {
    expect(milvusTableQuery(['we"ird'])).toBe(
      'POST /v2/vectordb/entities/query\n{"collectionName": "we\\"ird", "filter": "", "limit": 100}',
    );
  });
});

describe("milvusSelectQuery, Generate Command", () => {
  test("docs_int64: a runnable search over its first dense field, the probe printed in shortest float32", () => {
    const text = milvusSelectQuery(PATH, DOCS_COLUMNS);
    expect(text).toBe(
      [
        "# Replace data with your query vector: vec, FloatVector, dim 8",
        "POST /v2/vectordb/entities/search",
        '{"dbName": "default", "collectionName": "docs_int64", "annsField": "vec",',
        ' "data": [[0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338]],',
        ' "outputFields": ["id", "seq", "title", "meta", "tags", "maybe_count"], "limit": 10}',
      ].join("\n"),
    );
    expect(parsed(text).route.template).toBe("entities/search");
    expectProbePasses(text, "vec", "FloatVector(8)");
    expect(MILVUS_SEARCH_LIMIT).toBe(10);
  });

  test("the comment names no metric, and every other vector field has a comment line of its own", () => {
    const columns = [
      column("pk", "VarChar(64)", true),
      column("f16", "Float16Vector(8)"),
      column("bf16", "BFloat16Vector(8)"),
      column("bin", "BinaryVector(16)"),
      column("sparse", "SparseFloatVector"),
    ];
    const lines = milvusSelectQuery(["default", "docs_varchar"], columns).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "# Replace data with your query vector: f16, Float16Vector, dim 8",
      '# Other vector field: bf16, BFloat16Vector, dim 8; set annsField to "bf16" to search it',
      '# Other vector field: bin, BinaryVector, dim 16; set annsField to "bin" to search it',
      '# Other vector field: sparse, SparseFloatVector; set annsField to "sparse" to search it',
    ]);
    expect(lines.join("\n")).not.toMatch(/COSINE|L2|IP|HAMMING/);
  });

  test.each([["FloatVector(8)"], ["Float16Vector(8)"], ["BFloat16Vector(8)"], ["Int8Vector(8)"], ["BinaryVector(16)"]])(
    "a %s field's probe parses and passes its dense check",
    (type) => {
      const text = milvusSelectQuery(["default", "c"], [column("id", "Int64", true), column("v", type)]);
      expectProbePasses(text, "v", type);
    },
  );

  test("a struct array field, which may hold an embedding list, is never an output field", () => {
    const text = milvusSelectQuery(
      ["default", "c"],
      [column("id", "Int64", true), column("vec", "FloatVector(4)"), column("clips", "ArrayOfStruct")],
    );
    expect(text).toContain('"outputFields": ["id"]');
    expect(text).not.toContain("clips");
  });

  test("a BM25 output field gets a runnable text search and a comment asking for the user's own words", () => {
    const columns = [
      column("id", "Int64", true),
      column("text", "VarChar(1024)"),
      column("text_sparse", "SparseFloatVector(BM25: text_bm25)"),
    ];
    const text = milvusSelectQuery(["default", "fts"], columns);
    expect(text).toBe(
      [
        "# Replace the search text with your own words: text_sparse, SparseFloatVector, produced by BM25 function text_bm25",
        "POST /v2/vectordb/entities/search",
        '{"dbName": "default", "collectionName": "fts", "annsField": "text_sparse",',
        ' "data": ["search text"],',
        ' "outputFields": ["id", "text"], "limit": 10}',
      ].join("\n"),
    );
    expect(parsed(text).route.template).toBe("entities/search");
  });

  test("a sparse-only collection gets a comment-only template with the map form and the text form", () => {
    const text = milvusSelectQuery(
      ["default", "sp"],
      [column("id", "Int64", true), column("sparse", "SparseFloatVector")],
    );
    const lines = text.split("\n");
    expect(lines.every((line) => line.startsWith("#"))).toBe(true);
    expect(text).toContain('"data": [{"0": 1}]');
    expect(text).toContain('"data": ["search text"]');
    const mapRequest = [lines[2], lines[3]].map((line) => line.replace(/^# /, "")).join("\n");
    expect(parsed(mapRequest).route.template).toBe("entities/search");
  });

  test("a field whose type carries no dimension gets a comment that asks for a vector, never a probe", () => {
    const text = milvusSelectQuery(["default", "nodim"], [column("id", "Int64", true), column("v", "FloatVector(?)")]);
    expect(text.split("\n").every((line) => line.startsWith("#"))).toBe(true);
    expect(text).toContain(
      "v, FloatVector: Studio cannot read this field's dimension; write one query vector of that many elements in data",
    );
    expect(text).not.toMatch(/\[\[0\./);
  });

  test("a collection with no vector field reads its entities, saying there is nothing to search", () => {
    const text = milvusSelectQuery(["default", "plain"], [column("id", "Int64", true)]);
    expect(text).toBe(
      `# Collection plain has no vector field, so there is nothing to search: this reads its entities.\n${milvusTableQuery(["default", "plain"])}`,
    );
    expect(parsed(text).route.template).toBe("entities/query");
  });
});

describe("milvusProbeText", () => {
  test("a dense, a sparse and an embedding-list probe, and nothing where the dimension is unknown", () => {
    const target = (
      kind: VectorTarget["kind"],
      dimension: number | null,
      dtype: VectorTarget["dtype"] = "float32",
    ): VectorTarget => ({
      name: "v",
      kind,
      dtype,
      dimension,
    });
    expect(milvusProbeText(target("dense", 4))).toBe("[[0.5, 0.5, 0.5, 0.5]]");
    expect(milvusProbeText(target("dense", 2, "uint8"))).toBe("[[1, 1]]");
    expect(milvusProbeText(target("sparse", null))).toBe('[{"0": 1}]');
    expect(milvusProbeText(target("multi", 4))).toBe("[[[0.5, 0.5, 0.5, 0.5]]]");
    expect(milvusProbeText(target("dense", null))).toBeUndefined();
  });
});
