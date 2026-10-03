/**
 * Milvus answers to results (vector-family spec 5.5, 5.6, 3.3, E13): columns in schema order whatever order the
 * server sends, the dynamic-field merge rule with its name allocation and warnings, the score column, `$query`,
 * `$group`, the lone count, vector declarations, and the byte budget that drops rows whole.
 */
import { describe, expect, test } from "bun:test";
import type { QueryResults, SearchResults, WireFieldData } from "@/lib/db/providers/vector/milvus/client";
import {
  encodePlaceholderGroup,
  floatVectorBytes,
  sparseVectorBytes,
} from "@/lib/db/providers/vector/milvus/placeholder-group";
import {
  milvusPhase0,
  milvusPhase1,
  parseMilvusRequest,
  type SearchShape,
} from "@/lib/db/providers/vector/milvus/request";
import { countResult, queryResult, searchResult, tableResult } from "@/lib/db/providers/vector/milvus/results";
import { nonFiniteScoreWarning } from "@/lib/db/vector/score";
import { collectionSchema, describedCollection, fieldSchema, OK_STATUS } from "../../../helpers/milvus-described";
import {
  arrayScalars,
  dynamicColumn,
  scalarColumn,
  scalars,
  utf8,
  vectorColumn,
  vectors,
} from "../../../helpers/milvus-field-data";

const OPTIONS = { executionTime: 7 };
const DOCS_INT64 = describedCollection("docs_int64").schema;
if (DOCS_INT64 === null) throw new Error("docs_int64 has no schema");

function answer(fields: readonly WireFieldData[]): QueryResults {
  return {
    status: OK_STATUS,
    fields_data: fields,
    collection_name: "c",
    output_fields: [],
    session_ts: "0",
    primary_field_name: "",
  };
}

const shape = { schema: DOCS_INT64, limit: 100, offset: 0 };

const ID = scalarColumn("id", "Int64", scalars("long_data", ["469489107428444015", "469489107428444016"]));
const SEQ = scalarColumn("seq", "Int64", scalars("long_data", ["10", "20"]));
const TITLE = scalarColumn("title", "VarChar", scalars("string_data", ["doc 0010", "doc 0020"]));
const TAGS = scalarColumn(
  "tags",
  "Array",
  arrayScalars("Int64", [scalars("long_data", ["1"]), scalars("long_data", [])]),
);

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item].concat(rest)),
  );
}

describe("queryResult (5.5)", () => {
  test("every permutation of fields_data gives deep-equal rows and one column order (R09 F23)", () => {
    const results = permutations([ID, SEQ, TITLE, TAGS]).map((order) => queryResult(answer(order), shape, OPTIONS));
    for (const result of results) {
      expect(result.fields).toEqual(["id", "seq", "title", "tags"]);
      expect(result.rows.map((row) => Object.assign({}, row))).toEqual(
        results[0].rows.map((row) => Object.assign({}, row)),
      );
    }
    expect(results).toHaveLength(24);
    expect(results[0].rows.map((row) => Object.assign({}, row))).toEqual([
      { id: "469489107428444015", seq: "10", title: "doc 0010", tags: ["1"] },
      { id: "469489107428444016", seq: "20", title: "doc 0020", tags: [] },
    ]);
  });

  test("columnTypes spell each field's type; rows are null-prototype objects", () => {
    const result = queryResult(answer([TITLE, ID, TAGS]), shape, OPTIONS);
    expect(result.columnTypes).toEqual({ id: "Int64", title: "VarChar(256)", tags: "Array<Int64>(8)" });
    expect(Object.getPrototypeOf(result.rows[0])).toBeNull();
    expect(result).toMatchObject({ rowCount: 2, executionTime: 7 });
    expect(result.warnings).toBeUndefined();
    expect(result.vectorColumns).toBeUndefined();
    expect(result.pagination).toBeUndefined();
  });

  test("a vector column is declared in vectorColumns (3.10)", () => {
    const vec = vectorColumn(
      "vec",
      "FloatVector",
      vectors(8, "float_vector", { data: Array.from({ length: 16 }, () => 0.5) }),
    );
    expect(queryResult(answer([ID, vec]), shape, OPTIONS).vectorColumns).toEqual({
      vec: { kind: "dense", dtype: "float32", dimension: 8 },
    });
    const varchar = describedCollection("docs_varchar").schema;
    if (varchar === null) throw new Error("no schema");
    const sparse = vectorColumn(
      "sparse",
      "SparseFloatVector",
      vectors(0, "sparse_float_vector", { contents: [], dim: "0" }),
    );
    const bin = vectorColumn("bin", "BinaryVector", vectors(16, "binary_vector", new Uint8Array(0)));
    expect(queryResult(answer([sparse, bin]), { ...shape, schema: varchar }, OPTIONS).vectorColumns).toEqual({
      bin: { kind: "dense", dtype: "binary", dimension: 16 },
      sparse: { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "index-map" },
    });
  });

  test("a column the description does not list follows the described ones, by name", () => {
    const extra = scalarColumn("zz", "Int32", scalars("int_data", [1, 2]));
    const added = scalarColumn("aa", "Bool", scalars("bool_data", [true, false]));
    const result = queryResult(answer([extra, ID, added]), shape, OPTIONS);
    expect(result.fields).toEqual(["id", "aa", "zz"]);
    expect(result.columnTypes).toMatchObject({ aa: "Bool", zz: "Int32" });
  });

  test("a struct array follows the fields, typed ArrayOfStruct", () => {
    const schema = collectionSchema("s", [fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true })], {
      struct_array_fields: [
        { fieldID: "9", name: "clips", description: "", fields: [], type_params: [], nullable: false },
      ],
    });
    const clips: WireFieldData = {
      type: "ArrayOfStruct",
      field_name: "clips",
      scalars: null,
      vectors: null,
      struct_arrays: { fields: [scalarColumn("si", "Array", arrayScalars("Int32", [scalars("int_data", [1])]))] },
      field_id: "9",
      is_dynamic: false,
      valid_data: [],
      field: "struct_arrays",
    };
    const result = queryResult(
      answer([clips, scalarColumn("id", "Int64", scalars("long_data", ["1"]))]),
      { ...shape, schema },
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "clips"]);
    expect(result.columnTypes).toEqual({ id: "Int64", clips: "ArrayOfStruct" });
  });

  test("columns of different lengths are a malformed answer", () => {
    expect(() =>
      queryResult(answer([ID, scalarColumn("seq", "Int64", scalars("long_data", ["1"]))]), shape, OPTIONS),
    ).toThrow("Milvus returned an answer Studio cannot read: columns of different lengths.");
  });

  test("an empty answer is an empty result", () => {
    expect(queryResult(answer([]), shape, OPTIONS)).toMatchObject({ rows: [], fields: [], rowCount: 0 });
  });
});

describe("the dynamic-field merge rule (5.5, R40 M19, R51 U14m)", () => {
  const SHADOWED = collectionSchema("shadowed", [
    fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
    fieldSchema({ name: "zeta", data_type: "Int64", nullable: true }),
    fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }),
  ]);
  const shadowedShape = { schema: SHADOWED, limit: 100, offset: 0 };
  const ids = (count: number) =>
    scalarColumn(
      "id",
      "Int64",
      scalars(
        "long_data",
        Array.from({ length: count }, (_, index) => String(index + 1)),
      ),
    );

  test("static columns first, then dynamic keys in first-seen order, row order first, stored order inside a row", () => {
    const result = queryResult(
      answer([dynamicColumn(['{"beta": 6, "alpha": 5}', '{"gamma": 1, "alpha": 2}']), ids(2)]),
      shadowedShape,
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "beta", "alpha", "gamma"]);
    expect(result.rows.map((row) => Object.assign({}, row))).toEqual([
      { id: "1", beta: 6, alpha: 5 },
      { id: "2", gamma: 1, alpha: 2 },
    ]);
    expect(result.columnTypes).toMatchObject({ beta: "dynamic", alpha: "dynamic", gamma: "dynamic" });
  });

  test("a dynamic key shadowed by a static field is shown as $meta.<key>, never merged or dropped, with one warning", () => {
    const zeta = scalarColumn("zeta", "Int64", scalars("long_data", ["0", "0"]), { valid: [false, false] });
    for (const order of permutations([ids(2), zeta, dynamicColumn(['{"beta": 7, "zeta": 8}', "{}"])])) {
      const result = queryResult(answer(order), shadowedShape, OPTIONS);
      expect(result.fields).toEqual(["id", "zeta", "beta", "$meta.zeta"]);
      expect({ ...result.rows[0] }).toEqual({ id: "1", zeta: null, beta: 7, "$meta.zeta": 8 });
      expect(result.warnings).toEqual([
        {
          message:
            'The dynamic key zeta is shadowed by the static field of the same name: it is shown as $meta.zeta, and only $meta["zeta"] in a filter reaches the dynamic value.',
        },
      ]);
    }
  });

  test("a dynamic key literally named $meta.zeta beside a shadowed zeta takes the next free suffix, named in a warning", () => {
    const zeta = scalarColumn("zeta", "Int64", scalars("long_data", ["0"]), { valid: [false] });
    const result = queryResult(
      answer([ids(1), zeta, dynamicColumn(['{"$meta.zeta": 1, "zeta": 8}'])]),
      shadowedShape,
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "zeta", "$meta.zeta", "$meta.zeta (2)"]);
    expect({ ...result.rows[0] }).toEqual({ id: "1", zeta: null, "$meta.zeta": 1, "$meta.zeta (2)": 8 });
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      'The dynamic key zeta is shadowed by the static field of the same name: it is shown as $meta.zeta (2), and only $meta["zeta"] in a filter reaches the dynamic value.',
    ]);
  });

  test("a repeated key keeps its last value, with a warning naming it", () => {
    const result = queryResult(answer([ids(1), dynamicColumn(['{"k":1,"k":2}'])]), shadowedShape, OPTIONS);
    expect({ ...result.rows[0] }).toEqual({ id: "1", k: 2 });
    expect(result.warnings).toEqual([
      { message: "A row's dynamic field repeats the key k; Studio shows its last value, as JSON reading does." },
    ]);
  });

  test("an empty and a null $meta add no column; __proto__ and constructor are plain data columns", () => {
    const meta = scalarColumn(
      "$meta",
      "JSON",
      scalars("json_data", [utf8("{}"), utf8(""), utf8('{"__proto__": 1, "constructor": 2}')]),
      {
        dynamic: true,
      },
    );
    const result = queryResult(answer([ids(3), meta]), shadowedShape, OPTIONS);
    expect(result.fields).toEqual(["id", "__proto__", "constructor"]);
    expect(Object.getOwnPropertyNames(result.rows[2])).toEqual(["id", "__proto__", "constructor"]);
    expect(result.rows[2].__proto__).toBe(1);
  });

  test("1152921504606846977 stays exact, with a warning", () => {
    const result = queryResult(
      answer([ids(1), dynamicColumn(['{"big_int": 1152921504606846977}'])]),
      shadowedShape,
      OPTIONS,
    );
    expect(result.rows[0].big_int).toBe("1152921504606846977");
    expect(result.warnings?.[0].message).toContain("$meta.big_int");
  });

  test("a dynamic string longer than 65,536 code units is cut and counted", () => {
    const result = queryResult(
      answer([ids(1), dynamicColumn([JSON.stringify({ note: "n".repeat(70_000) })])]),
      shadowedShape,
      OPTIONS,
    );
    expect(String(result.rows[0].note)).toEndWith("…[cut: 65536 of 70000 characters shown]");
    expect(result.warnings?.[0].message).toStartWith("1 text cells were longer than 65,536 characters");
  });
});

describe("tableResult (5.5, 5.6)", () => {
  test("named, typed columns of null-prototype rows, under the budget", () => {
    const result = tableResult(
      [
        { name: "collection", typeText: "VarChar" },
        { name: "id", typeText: "Int64" },
      ],
      [
        ["docs_int64", "469489107428444006"],
        ["fts", "469489107428444007"],
      ],
      OPTIONS,
    );
    expect(result).toMatchObject({
      fields: ["collection", "id"],
      rowCount: 2,
      columnTypes: { collection: "VarChar", id: "Int64" },
    });
    expect(Object.getPrototypeOf(result.rows[0])).toBeNull();
    expect({ ...result.rows[1] }).toEqual({ collection: "fts", id: "469489107428444007" });
    const limited = tableResult([{ name: "n", typeText: "VarChar" }], [["a".repeat(100)], ["b".repeat(100)]], {
      executionTime: 1,
      budgetBytes: 150,
    });
    expect(limited).toMatchObject({
      rowCount: 1,
      pagination: { limit: 2, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true },
    });
  });
});

describe("countResult (3.3, 5.4)", () => {
  test("one row, the count an exact Int64 string, labelled exact", () => {
    const result = countResult(answer([scalarColumn("count(*)", "Int64", scalars("long_data", ["500"]))]), OPTIONS);
    expect(result).toMatchObject({
      fields: ["count(*)"],
      rowCount: 1,
      executionTime: 7,
      columnTypes: { "count(*)": "Int64, exact count" },
    });
    expect({ ...result.rows[0] }).toEqual({ "count(*)": "500" });
  });

  test("a count answer with no count(*) value is a malformed answer", () => {
    expect(() => countResult(answer([]), OPTIONS)).toThrow(
      "Milvus returned an answer Studio cannot read: a count with no count(*) value.",
    );
  });
});

describe("searchResult (5.5)", () => {
  const VARCHAR = describedCollection("docs_varchar").schema;
  if (VARCHAR === null) throw new Error("no schema");
  const LABEL = VARCHAR.fields.find((field) => field.name === "label");

  function hits(
    topks: readonly number[],
    ids: readonly string[],
    scores: readonly number[],
    fields: readonly WireFieldData[] = [],
    group?: WireFieldData,
  ): SearchResults {
    return {
      status: OK_STATUS,
      collection_name: "docs_varchar",
      session_ts: "0",
      results: {
        num_queries: String(topks.length),
        top_k: "0",
        fields_data: fields,
        scores,
        ids: { str_id: { data: ids }, id_field: "str_id" },
        topks: topks.map(String),
        output_fields: [],
        group_by_field_value: group ?? null,
        all_search_count: "0",
        distances: [],
        recalls: [],
        primary_field_name: "pk",
        element_indices: null,
        group_by_field_values: [],
      },
    };
  }

  const searchShape = (extra: Partial<SearchShape> = {}): SearchShape => ({
    schema: VARCHAR,
    nq: 1,
    limit: 3,
    offset: 0,
    score: { kind: "metric", metric: "L2" },
    groupingField: undefined,
    ...extra,
  });

  test("one query: the key from ids, the output fields, and the score in distance with the text of 3.3", () => {
    const label = scalarColumn("label", "VarChar", scalars("string_data", ["north", "south"]));
    const result = searchResult(hits([2], ["vc-0001", "vc-0002"], [0, 0.5]), searchShape(), OPTIONS);
    expect(result.fields).toEqual(["pk", "distance"]);
    const withLabel = searchResult(hits([2], ["vc-0001", "vc-0002"], [0, 0.5], [label]), searchShape(), OPTIONS);
    expect(withLabel.fields).toEqual(["pk", "label", "distance"]);
    expect(withLabel.rows.map((row) => Object.assign({}, row))).toEqual([
      { pk: "vc-0001", label: "north", distance: 0 },
      { pk: "vc-0002", label: "south", distance: 0.5 },
    ]);
    expect(withLabel.columnTypes).toEqual({
      pk: "VarChar(64)",
      label: "VarChar(64)",
      distance: "Float, L2 (squared Euclidean), lower is closer",
    });
  });

  test("the key in fields_data too is read once, from ids", () => {
    const pk = scalarColumn("pk", "VarChar", scalars("string_data", ["x"]));
    expect(searchResult(hits([1], ["vc-0001"], [0], [pk]), searchShape(), OPTIONS).rows[0].pk).toBe("vc-0001");
  });

  test("more than one query puts $query first, each hit's position in data or ids (R22 5.1)", () => {
    const result = searchResult(hits([2, 1], ["a", "b", "c"], [1, 2, 3]), searchShape({ nq: 2 }), OPTIONS);
    expect(result.fields).toEqual(["$query", "pk", "distance"]);
    expect(result.rows.map((row) => row.$query)).toEqual([0, 0, 1]);
    expect(result.columnTypes?.$query).toBe("Int32");
  });

  test("a grouped search adds $group, typed as the grouping field (R40 M16)", () => {
    const group = scalarColumn("label", "VarChar", scalars("string_data", ["west", "east"]));
    const result = searchResult(
      hits([2], ["a", "b"], [1, 2], [], group),
      searchShape({ groupingField: LABEL }),
      OPTIONS,
    );
    expect(result.fields).toEqual(["pk", "distance", "$group"]);
    expect(result.rows.map((row) => row.$group)).toEqual(["west", "east"]);
    expect(result.columnTypes?.$group).toBe("VarChar(64)");
  });

  test("a non-finite score is written as a word with one warning counting the rows (3.3, R45 F7)", () => {
    const result = searchResult(
      hits([2], ["a", "b"], [Number.POSITIVE_INFINITY, 1]),
      searchShape({ score: { kind: "metric", metric: "IP" } }),
      OPTIONS,
    );
    expect(result.rows.map((row) => row.distance)).toEqual(["Infinity", 1]);
    expect(result.warnings).toEqual([nonFiniteScoreWarning(1)]);
  });

  test("without IndexDetail the score names no metric, with one warning (R51 U32)", () => {
    const result = searchResult(hits([1], ["a"], [0.9]), searchShape({ score: { kind: "unreadable" } }), OPTIONS);
    expect(result.columnTypes?.distance).toBe("Float, metric not readable without IndexDetail, rows are in rank order");
    expect(result.warnings).toEqual([
      {
        message:
          "Studio could not read this collection's index (DescribeIndex needs the IndexDetail privilege), so the score column names no metric and the rows are in rank order.",
      },
    ]);
  });

  test("a fused score reads as the rerank's fusion", () => {
    expect(
      searchResult(hits([1], ["a"], [0.03]), searchShape({ score: { kind: "fused", strategy: "rrf" } }), OPTIONS)
        .columnTypes?.distance,
    ).toBe("Float, RRF fusion, higher ranks first");
  });

  test("a static field named distance moves the score to $distance, and a dynamic key named distance takes a suffix", () => {
    const schema = collectionSchema("d", [
      fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
      fieldSchema({ name: "distance", data_type: "Double" }),
      fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }),
    ]);
    const answerWithInt: SearchResults = {
      ...hits(
        [1],
        [],
        [0.5],
        [scalarColumn("distance", "Double", scalars("double_data", [42])), dynamicColumn(['{"$distance": 1}'])],
      ),
    };
    const result = searchResult(
      {
        ...answerWithInt,
        results: {
          ...(answerWithInt.results as NonNullable<SearchResults["results"]>),
          ids: { int_id: { data: ["7"] }, id_field: "int_id" },
        },
      },
      searchShape({ schema }),
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "distance", "$distance", "$distance (2)"]);
    expect({ ...result.rows[0] }).toEqual({ id: "7", distance: 42, $distance: 0.5, "$distance (2)": 1 });
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      "The dynamic key $distance is shown as $distance (2), because another column has its name.",
    ]);
  });

  test("a dynamic key named distance, with no static distance, takes a suffix too", () => {
    const schema = collectionSchema("d", [
      fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
      fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }),
    ]);
    const base = hits([1], [], [0.5], [dynamicColumn(['{"distance": 3}'])]);
    const result = searchResult(
      {
        ...base,
        results: {
          ...(base.results as NonNullable<SearchResults["results"]>),
          ids: { int_id: { data: ["7"] }, id_field: "int_id" },
        },
      },
      searchShape({ schema }),
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "distance", "distance (2)"]);
  });

  test("an answer whose ids, scores and columns disagree is malformed; no results is an empty grid", () => {
    expect(() => searchResult(hits([2], ["a"], [1, 2]), searchShape(), OPTIONS)).toThrow(
      "Milvus returned an answer Studio cannot read: search columns of different lengths.",
    );
    const empty = searchResult(
      { status: OK_STATUS, results: null, collection_name: "c", session_ts: "0" },
      searchShape(),
      OPTIONS,
    );
    expect(empty).toMatchObject({ rows: [], fields: ["pk", "distance"], rowCount: 0 });
  });
});

describe("the result budget (5.6, E13)", () => {
  const embedding = (rows: number) => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647 - 0.5;
    };
    const data: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      const vector = Array.from({ length: 768 }, random);
      const norm = Math.hypot(...vector);
      data.push(...vector.map((value) => Math.fround(value / norm)));
    }
    return vectorColumn("vec", "FloatVector", vectors(768, "float_vector", { data }));
  };
  const keys = (rows: number) =>
    scalarColumn(
      "id",
      "Int64",
      scalars(
        "long_data",
        Array.from({ length: rows }, (_, index) => String(index)),
      ),
    );

  test("100 rows of a 768-dimension normalised embedding stay within 8 MiB", () => {
    const result = queryResult(answer([keys(100), embedding(100)]), shape, OPTIONS);
    expect(result.rowCount).toBe(100);
    expect(result.pagination).toBeUndefined();
  });

  test("past the budget, conversion stops, the rest is dropped whole, wasLimited is set and a warning names the bound", () => {
    const result = queryResult(answer([keys(1000), embedding(1000)]), { ...shape, limit: 1000 }, OPTIONS);
    expect(result.rowCount).toBeLessThan(1000);
    expect(Buffer.byteLength(JSON.stringify(result.rows.map((row) => [row.id, row.vec])))).toBeLessThanOrEqual(
      8_388_608,
    );
    expect(result.pagination).toEqual({
      limit: 1000,
      offset: 0,
      hasMore: false,
      totalReturned: result.rowCount,
      wasLimited: true,
    });
    expect(result.warnings?.at(-1)?.message).toBe(
      `The result reached Studio's 8 MiB result budget after ${result.rowCount} rows; the remaining ${1000 - result.rowCount} rows are not shown. Ask for fewer rows or fewer fields.`,
    );
  });

  test("a row is dropped whole: a smaller budget keeps whole rows only", () => {
    const result = queryResult(answer([keys(3), embedding(3)]), shape, { executionTime: 1, budgetBytes: 20_000 });
    expect(result.rowCount).toBe(2);
    expect((result.rows[1].vec as number[]).length).toBe(768);
    expect(result.warnings?.at(-1)?.message).toContain("Studio's 20000-byte result budget after 2 rows");
  });
});

describe("Review Focus: what a user meets first", () => {
  const VARCHAR = describedCollection("docs_varchar").schema;
  if (VARCHAR === null) throw new Error("no schema");
  const varcharShape = { schema: VARCHAR, limit: 100, offset: 0 };

  test("a vector cell copied from a result is valid search data that searches as stored (R45 M21)", () => {
    const f16 = new Uint8Array(16);
    const view = new DataView(f16.buffer);
    [0x7bff, 0xfbff, 0x0400, 0x0001, 0x3c00, 0x2e66, 0x0000, 0xc000].forEach((bits, index) =>
      view.setUint16(index * 2, bits, true),
    );
    const sparseRow = new Uint8Array(16);
    const sparseView = new DataView(sparseRow.buffer);
    sparseView.setUint32(0, 17, true);
    sparseView.setFloat32(4, 0.4, true);
    sparseView.setUint32(8, 4_294_967_294, true);
    sparseView.setFloat32(12, 1e-30, true);
    const result = queryResult(
      answer([
        scalarColumn("pk", "VarChar", scalars("string_data", ["vc-0000"])),
        vectorColumn("f16", "Float16Vector", vectors(8, "float16_vector", f16)),
        vectorColumn("bin", "BinaryVector", vectors(16, "binary_vector", Uint8Array.from([9, 13]))),
        vectorColumn(
          "sparse",
          "SparseFloatVector",
          vectors(0, "sparse_float_vector", { contents: [sparseRow], dim: "0" }),
        ),
      ]),
      varcharShape,
      OPTIONS,
    );
    const row = result.rows[0];
    const lowered = (annsField: string, cell: unknown) => {
      const text = `POST entities/search\n{"collectionName": "docs_varchar", "annsField": "${annsField}", "data": [${JSON.stringify(cell)}]}`;
      const operation = milvusPhase1(milvusPhase0(parseMilvusRequest(text), { database: "default" }), {
        collection: describedCollection("docs_varchar"),
        index: { kind: "unreadable" },
      });
      if (operation.kind !== "search") throw new Error("expected a search");
      return operation.request.placeholder_group;
    };
    const f16Cell = row.f16 as number[];
    expect(lowered("f16", f16Cell)).toEqual(encodePlaceholderGroup("FloatVector", [floatVectorBytes(f16Cell)]));
    expect(f16Cell).toEqual([65504, -65504, 0.000061035156, 5.9604645e-8, 1, 0.099975586, 0, -2]);
    // Each printed element rounds back to exactly the stored float16 value.
    expect(f16Cell.map((value) => Math.fround(value))).toEqual([
      65504,
      -65504,
      2 ** -14,
      2 ** -24,
      1,
      0.0999755859375,
      0,
      -2,
    ]);
    expect(lowered("bin", row.bin)).toEqual(encodePlaceholderGroup("BinaryVector", [Uint8Array.from([9, 13])]));
    expect(lowered("sparse", row.sparse)).toEqual(
      encodePlaceholderGroup("SparseFloatVector", [
        sparseVectorBytes({ indices: [17, 4_294_967_294], values: [0.4, 1e-30] }),
      ]),
    );
  });

  test("dynamic keys named like numbers keep their stored order, which JSON.parse would sort", () => {
    const SHADOWED = collectionSchema("d", [
      fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
      fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }),
    ]);
    const result = queryResult(
      answer([scalarColumn("id", "Int64", scalars("long_data", ["1"])), dynamicColumn(['{"b": 1, "10": 2, "2": 3}'])]),
      { schema: SHADOWED, limit: 100, offset: 0 },
      OPTIONS,
    );
    expect(result.fields).toEqual(["id", "b", "10", "2"]);
  });

  test("an auto_id key above 2^53 in a search answer stays its exact digits", () => {
    const result = searchResult(
      {
        status: OK_STATUS,
        collection_name: "docs_int64",
        session_ts: "0",
        results: {
          num_queries: "1",
          top_k: "1",
          fields_data: [],
          scores: [0.99],
          ids: { int_id: { data: ["469489107428444015"] }, id_field: "int_id" },
          topks: ["1"],
          output_fields: [],
          group_by_field_value: null,
          all_search_count: "1",
          distances: [],
          recalls: [],
          primary_field_name: "id",
          element_indices: null,
          group_by_field_values: [],
        },
      },
      {
        schema: DOCS_INT64,
        nq: 1,
        limit: 1,
        offset: 0,
        score: { kind: "metric", metric: "COSINE" },
        groupingField: undefined,
      },
      OPTIONS,
    );
    expect(result.rows[0].id).toBe("469489107428444015");
  });

  test("a server that answers group values in group_by_field_values still fills $group", () => {
    const label = VARCHAR.fields.find((field) => field.name === "label");
    const result = searchResult(
      {
        status: OK_STATUS,
        collection_name: "docs_varchar",
        session_ts: "0",
        results: {
          num_queries: "1",
          top_k: "1",
          fields_data: [],
          scores: [1],
          ids: { str_id: { data: ["vc-0000"] }, id_field: "str_id" },
          topks: ["1"],
          output_fields: [],
          group_by_field_value: null,
          all_search_count: "1",
          distances: [],
          recalls: [],
          primary_field_name: "pk",
          element_indices: null,
          group_by_field_values: [scalarColumn("label", "VarChar", scalars("string_data", ["north"]))],
        },
      },
      { schema: VARCHAR, nq: 1, limit: 1, offset: 0, score: { kind: "metric", metric: "L2" }, groupingField: label },
      OPTIONS,
    );
    expect(result.rows[0].$group).toBe("north");
  });
});
