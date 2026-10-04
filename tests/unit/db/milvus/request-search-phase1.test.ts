/**
 * Phase 1 and the lowering of entities/search and entities/hybrid_search (vector-family spec 5.4, 5.6, E11, E12,
 * E28, E35, VF2): every query vector checked in its field's dtype against the fresh describe, text only for a BM25
 * output, ids typed by the key, the metric and the per-index search parameters against DescribeIndex, the range
 * order by metric, and the exact SearchRequest and HybridSearchRequest each sends.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  encodePlaceholderGroup,
  floatVectorBytes,
  int8VectorBytes,
  sparseVectorBytes,
  textBytes,
} from "@/lib/db/providers/vector/milvus/placeholder-group";
import {
  type IndexReading,
  type MilvusOperation,
  milvusPhase0,
  milvusPhase1,
  parseMilvusRequest,
} from "@/lib/db/providers/vector/milvus/request";
import type { DescribeCollectionResponse, SearchRequest } from "@/lib/db/providers/vector/milvus/client";
import {
  collectionSchema,
  describeAnswer,
  describedCollection,
  describedIndex,
  fieldSchema,
} from "../../../helpers/milvus-described";

const VECTOR = [0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338];
const F16 = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

const INDEXES: Readonly<Record<string, IndexReading>> = {
  docs_int64: { kind: "read", response: describedIndex({ vec: { indexType: "HNSW", metric: "COSINE" } }) },
  docs_varchar: {
    kind: "read",
    response: describedIndex({
      f16: { indexType: "HNSW", metric: "L2" },
      bf16: { indexType: "HNSW", metric: "IP" },
      bin: { indexType: "BIN_FLAT", metric: "HAMMING" },
      sparse: { indexType: "SPARSE_INVERTED_INDEX", metric: "IP" },
      i8: { indexType: "HNSW", metric: "L2" },
    }),
  },
  fts: {
    kind: "read",
    response: describedIndex({ text_sparse: { indexType: "SPARSE_INVERTED_INDEX", metric: "BM25" } }),
  },
  pk_partitioned: { kind: "read", response: describedIndex({ vec: { indexType: "IVF_FLAT", metric: "L2" } }) },
};

function lowerWith(
  text: string,
  collection: DescribeCollectionResponse,
  index: IndexReading = { kind: "not-read" },
): MilvusOperation {
  return milvusPhase1(milvusPhase0(parseMilvusRequest(text), { database: "default" }), { collection, index });
}

function search(
  collection: string,
  body: Record<string, unknown> | string,
  index = INDEXES[collection],
): MilvusOperation {
  const text = `POST entities/search\n${typeof body === "string" ? body : JSON.stringify({ collectionName: collection, ...body })}`;
  return lowerWith(text, describedCollection(collection), index);
}

function searchRequest(
  collection: string,
  body: Record<string, unknown> | string,
  index?: IndexReading,
): SearchRequest {
  const operation = search(collection, body, index ?? INDEXES[collection]);
  if (operation.kind !== "search") throw new Error(`expected a search, got ${operation.kind}`);
  return operation.request;
}

function refusalOf(run: () => unknown): { phase: number; key: string | null; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestRefusal) return { phase: error.phase, key: error.key, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const pairs = (request: { readonly search_params: readonly { key: string; value: string }[] }) =>
  Object.fromEntries(request.search_params.map((entry) => [entry.key, entry.value]));

describe("entities/search lowering (5.4)", () => {
  test("example 6: a dense search with an index parameter, the score from DescribeIndex", () => {
    const operation = search("docs_int64", {
      annsField: "vec",
      data: [VECTOR],
      filter: "seq >= 100",
      searchParams: { params: { ef: 64 } },
      outputFields: ["seq", "title"],
      limit: 5,
    });
    if (operation.kind !== "search") throw new Error("expected a search");
    const { request, shape } = operation;
    expect(request.placeholder_group).toEqual(encodePlaceholderGroup("FloatVector", [floatVectorBytes(VECTOR)]));
    expect(request).toMatchObject({
      collection_name: "docs_int64",
      dsl: "seq >= 100",
      dsl_type: "BoolExprV1",
      output_fields: ["seq", "title"],
      nq: "1",
      use_default_consistency: true,
    });
    expect(request.ids).toBeUndefined();
    expect(request.consistency_level).toBeUndefined();
    expect(request.search_params.map((entry) => entry.key)).toEqual([
      "anns_field",
      "topk",
      "offset",
      "params",
      "round_decimal",
    ]);
    expect(pairs(request)).toMatchObject({ anns_field: "vec", topk: "5", offset: "0", round_decimal: "-1" });
    expect(JSON.parse(pairs(request).params)).toEqual({ ef: 64 });
    expect(shape).toMatchObject({
      nq: 1,
      limit: 5,
      offset: 0,
      score: { kind: "metric", metric: "COSINE" },
      groupingField: undefined,
    });
  });

  test("a search with no parameter sends params {}, and a named metric and round_decimal travel as pairs", () => {
    expect(JSON.parse(pairs(searchRequest("docs_int64", { annsField: "vec", data: [VECTOR] })).params)).toEqual({});
    const named = searchRequest("docs_int64", {
      annsField: "vec",
      data: [VECTOR],
      searchParams: { metric_type: "COSINE", round_decimal: 3 },
      consistencyLevel: "Eventually",
      partitionNames: ["part_a"],
      exprParams: { s: 10 },
    });
    expect(pairs(named)).toMatchObject({ metric_type: "COSINE", round_decimal: "3" });
    expect(named).toMatchObject({
      consistency_level: "Eventually",
      use_default_consistency: false,
      partition_names: ["part_a"],
    });
    expect({ ...named.expr_template_values }).toEqual({ s: { int64_val: "10" } });
  });

  test("an integer in a search parameter travels as its digits", () => {
    const request = searchRequest(
      "docs_int64",
      '{"collectionName": "docs_int64", "annsField": "vec", "data": [[1, 2, 3, 4, 5, 6, 7, 8]], "searchParams": {"params": {"ef": 100, "radius": 0.25, "range_filter": 0.9}}}',
    );
    expect(pairs(request).params).toMatch(/"ef":\s*100/);
    expect(JSON.parse(pairs(request).params)).toEqual({ ef: 100, radius: 0.25, range_filter: 0.9 });
  });

  test("example 7: text on a BM25 output field is sent as VarChar text", () => {
    const request = searchRequest("fts", {
      annsField: "text_sparse",
      data: ["vector index"],
      outputFields: ["id", "text"],
      limit: 5,
    });
    expect(request.placeholder_group).toEqual(encodePlaceholderGroup("VarChar", [textBytes("vector index")]));
    expect(search("fts", { annsField: "text_sparse", data: ["vector index"] })).toMatchObject({
      shape: { score: { kind: "metric", metric: "BM25" } },
    });
  });

  test("text for a field no BM25 function produces is refused", () => {
    expect(refusalOf(() => search("docs_int64", { annsField: "vec", data: ["hello"] }))).toEqual({
      phase: 1,
      key: "data[0]",
      message: "data[0] is text, and only a field a BM25 function produces takes text; vec takes a vector.",
    });
  });

  test("text for a field an embedding function produces is refused: the server would call its provider (VF2)", () => {
    const schema = collectionSchema(
      "emb",
      [
        fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
        fieldSchema({ name: "doc", data_type: "VarChar", type_params: [{ key: "max_length", value: "64" }] }),
        fieldSchema({
          name: "dense",
          data_type: "FloatVector",
          type_params: [{ key: "dim", value: "8" }],
          is_function_output: true,
        }),
      ],
      {
        functions: [
          {
            name: "embed",
            id: "1",
            description: "",
            type: "TextEmbedding",
            input_field_names: ["doc"],
            input_field_ids: [],
            output_field_names: ["dense"],
            output_field_ids: [],
            params: [],
          },
        ],
      },
    );
    expect(
      refusalOf(() =>
        lowerWith(
          'POST entities/search\n{"collectionName": "emb", "annsField": "dense", "data": ["a question"]}',
          describeAnswer(schema),
          {
            kind: "unreadable",
          },
        ),
      ),
    ).toEqual({
      phase: 1,
      key: "data[0]",
      message:
        "dense is produced by an embedding function, so text sent to it would make Milvus call the embedding provider; Studio never sends a request that reaches a service the server calls. Send the vector itself.",
    });
  });

  test("example 9: ids on a VarChar key travel in search_input as str_id, with nq the id count (R40 M3)", () => {
    const request = searchRequest("docs_varchar", {
      annsField: "f16",
      ids: ["vc-0000", "vc-0001"],
      outputFields: ["pk", "label"],
      limit: 3,
    });
    expect(request.ids).toEqual({ str_id: { data: ["vc-0000", "vc-0001"] } });
    expect(request.placeholder_group).toBeUndefined();
    expect(request.nq).toBe("2");
  });

  test("ids on an Int64 key travel as int_id digits; a duplicate or a malformed id is refused in phase 1", () => {
    expect(
      searchRequest("docs_int64", '{"collectionName": "docs_int64", "annsField": "vec", "ids": [469489107428444015]}')
        .ids,
    ).toEqual({
      int_id: { data: ["469489107428444015"] },
    });
    expect(refusalOf(() => search("docs_int64", { annsField: "vec", ids: [1, "1"] }))).toEqual({
      phase: 1,
      key: "ids",
      message: 'ids names "1" twice.',
    });
    expect(refusalOf(() => search("docs_int64", { annsField: "vec", ids: ["abc"] })).key).toBe("ids[0]");
  });

  test("example 10: a grouped search sends the grouping pairs and keeps the field for $group", () => {
    const operation = search("docs_varchar", {
      annsField: "f16",
      data: [F16],
      groupingField: "label",
      groupSize: 1,
      strictGroupSize: false,
      outputFields: ["pk", "label"],
      limit: 4,
    });
    if (operation.kind !== "search") throw new Error("expected a search");
    expect(pairs(operation.request)).toMatchObject({
      group_by_field: "label",
      group_size: "1",
      strict_group_size: "false",
    });
    expect(operation.shape.groupingField?.name).toBe("label");
  });

  test("grouping by a vector field, or a field the collection lacks, is refused in phase 1", () => {
    expect(refusalOf(() => search("docs_varchar", { annsField: "f16", data: [F16], groupingField: "bin" }))).toEqual({
      phase: 1,
      key: "groupingField",
      message: "bin is a vector field; Milvus groups by a scalar field.",
    });
    expect(
      refusalOf(() => search("docs_varchar", { annsField: "f16", data: [F16], groupingField: "nope" })).message,
    ).toBe('"nope" is not a field of docs_varchar.');
  });

  test("grouping by a Float, Double, Array or Geometry field is refused in phase 1; JSON and the integers lower", () => {
    const scalarsOnly = collectionSchema("scalars", [
      fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
      fieldSchema({
        name: "v",
        data_type: "FloatVector",
        type_params: [{ key: "dim", value: "2" }],
      }),
      fieldSchema({ name: "f", data_type: "Float" }),
      fieldSchema({ name: "d", data_type: "Double" }),
      fieldSchema({ name: "a", data_type: "Array", element_type: "Int64" }),
      fieldSchema({ name: "g", data_type: "Geometry", nullable: true }),
      fieldSchema({ name: "j", data_type: "JSON" }),
      fieldSchema({ name: "b", data_type: "Bool" }),
      fieldSchema({ name: "i8", data_type: "Int8" }),
      fieldSchema({ name: "ts", data_type: "Timestamptz", nullable: true }),
    ]);
    const run = (groupingField: string) =>
      lowerWith(
        `POST entities/search\n${JSON.stringify({ collectionName: "scalars", annsField: "v", data: [[0.1, 0.2]], groupingField })}`,
        describeAnswer(scalarsOnly),
        { kind: "read", response: describedIndex({ v: { indexType: "FLAT", metric: "L2" } }) },
      );
    for (const [name, type] of [
      ["f", "Float"],
      ["d", "Double"],
      ["a", "Array"],
      ["g", "Geometry"],
    ]) {
      expect(refusalOf(() => run(name))).toEqual({
        phase: 1,
        key: "groupingField",
        message: `${name} has the type ${type}, which Milvus does not group by.`,
      });
    }
    for (const name of ["j", "b", "i8", "ts", "id"]) {
      const operation = run(name);
      if (operation.kind !== "search") throw new Error("expected a search");
      expect(pairs(operation.request).group_by_field).toBe(name);
    }
    expect(refusalOf(() => search("docs_int64", { annsField: "vec", data: [VECTOR], groupingField: "tags" }))).toEqual({
      phase: 1,
      key: "groupingField",
      message: "tags has the type Array, which Milvus does not group by.",
    });
  });

  test("a query_mode=large_topk collection is searched under Studio's own caps, as any other (E28, R43 F16)", () => {
    const plain = describedCollection("docs_int64");
    const large = { ...plain, properties: [{ key: "query_mode", value: "large_topk" }] };
    const text = `POST entities/search\n${JSON.stringify({ collectionName: "docs_int64", annsField: "vec", data: [VECTOR], limit: 1024 })}`;
    expect(lowerWith(text, large, INDEXES.docs_int64)).toEqual(lowerWith(text, plain, INDEXES.docs_int64));
    expect(() => lowerWith(text.replace('"limit":1024', '"limit":1025'), large, INDEXES.docs_int64)).toThrow(
      'limit is "1025"; Studio accepts 1 to 1024.',
    );
  });

  test("partitionNames on a partition-key collection are refused before any vector is read", () => {
    expect(
      refusalOf(() => search("pk_partitioned", { annsField: "vec", data: [F16], partitionNames: ["p"] })).key,
    ).toBe("partitionNames");
  });
});

describe("query vectors in the field's dtype (5.4, E12, 3.3)", () => {
  test("Float16Vector and BFloat16Vector take float32 data, which the server converts (R45 F6)", () => {
    expect(searchRequest("docs_varchar", { annsField: "f16", data: [F16] }).placeholder_group).toEqual(
      encodePlaceholderGroup("FloatVector", [floatVectorBytes(F16)]),
    );
  });

  test("Int8Vector takes integers", () => {
    const values = [-128, 127, 0, -1, 1, 2, 3, 4];
    expect(searchRequest("docs_varchar", { annsField: "i8", data: [values] }).placeholder_group).toEqual(
      encodePlaceholderGroup("Int8Vector", [int8VectorBytes(values)]),
    );
  });

  test("BinaryVector takes dimension / 8 bytes as a list or as base64 (R45 F4)", () => {
    const expected = encodePlaceholderGroup("BinaryVector", [Uint8Array.from([9, 13])]);
    expect(searchRequest("docs_varchar", { annsField: "bin", data: [[9, 13]] }).placeholder_group).toEqual(expected);
    expect(searchRequest("docs_varchar", { annsField: "bin", data: ["CQ0="] }).placeholder_group).toEqual(expected);
  });

  test("SparseFloatVector takes Milvus's index map", () => {
    expect(
      searchRequest("docs_varchar", { annsField: "sparse", data: [{ "17": 0.4, "230": 0.2 }] }).placeholder_group,
    ).toEqual(
      encodePlaceholderGroup("SparseFloatVector", [sparseVectorBytes({ indices: [17, 230], values: [0.4, 0.2] })]),
    );
  });

  test.each([
    ["f16", [[65504.00390625, 0, 0, 0, 0, 0, 0, 0]]],
    ["f16", [[1, 2, 3]]],
    ["i8", [[128, 0, 0, 0, 0, 0, 0, 0]]],
    ["i8", [[1.5, 0, 0, 0, 0, 0, 0, 0]]],
    ["bin", [[256, 0]]],
    ["bin", [[1, 2, 3]]],
    ["bin", ["CQ0NDQ=="]],
    ["sparse", [{ "4294967295": 0.5 }]],
  ])("%s refuses %j with the shared range table's sentence", (annsField, data) => {
    const refusal = refusalOf(() => search("docs_varchar", { annsField, data }));
    expect(refusal.phase).toBe(1);
    expect(refusal.key).toBe("data[0]");
    expect(refusal.message).toContain(annsField);
  });

  test("a float32 element of 1e39 is refused before any request (3.3)", () => {
    expect(
      refusalOf(() =>
        search(
          "docs_int64",
          '{"collectionName": "docs_int64", "annsField": "vec", "data": [[1e39, 0, 0, 0, 0, 0, 0, 0]]}',
        ),
      ).phase,
    ).toBe(1);
  });

  test("a base64 text that is not base64 is refused", () => {
    expect(refusalOf(() => search("docs_varchar", { annsField: "bin", data: ["!!"] }))).toEqual({
      phase: 1,
      key: "data[0]",
      message: "data[0] is not base64: a BinaryVector query is base64 or a list of bytes.",
    });
  });

  test("a sparse field refuses a list, and a dense field refuses an index map", () => {
    expect(refusalOf(() => search("docs_varchar", { annsField: "sparse", data: [[1, 2]] })).message).toBe(
      'data[0]: sparse is sparse and takes an index map such as {"17": 0.4}.',
    );
    expect(refusalOf(() => search("docs_varchar", { annsField: "f16", data: [{ "1": 1 }] })).message).toBe(
      "data[0]: f16 takes a list of numbers.",
    );
  });

  test("query vectors of two kinds in one data are refused", () => {
    expect(refusalOf(() => search("fts", { annsField: "text_sparse", data: [{ "1": 0.5 }, "text"] }))).toEqual({
      phase: 1,
      key: "data",
      message: "data mixes kinds of query: every element searches text_sparse the same way.",
    });
  });

  describe("an embedding list (5.4, 5.6)", () => {
    const clips = collectionSchema("clips", [fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true })], {
      struct_array_fields: [
        {
          fieldID: "200",
          name: "clips",
          description: "",
          fields: [
            fieldSchema({
              name: "semb",
              data_type: "ArrayOfVector",
              element_type: "FloatVector",
              type_params: [{ key: "dim", value: "4" }],
            }),
            fieldSchema({
              name: "h16",
              data_type: "ArrayOfVector",
              element_type: "Float16Vector",
              type_params: [{ key: "dim", value: "4" }],
            }),
          ],
          type_params: [],
          nullable: false,
        },
      ],
    });
    const run = (data: unknown, annsField = "clips[semb]") =>
      lowerWith(
        `POST entities/search\n${JSON.stringify({ collectionName: "clips", annsField, data })}`,
        describeAnswer(clips),
        {
          kind: "read",
          response: describedIndex({ "clips[semb]": { indexType: "HNSW", metric: "MAX_SIM_COSINE" } }),
        },
      );

    test("rows of a FloatVector list are sent as one EmbListFloatVector value", () => {
      const operation = run([
        [
          [0, 1, 0, 0],
          [1, 1, 0, 0],
        ],
      ]);
      expect(operation.kind === "search" && operation.request.placeholder_group).toEqual(
        encodePlaceholderGroup("EmbListFloatVector", [floatVectorBytes([0, 1, 0, 0, 1, 1, 0, 0])]),
      );
    });

    test("an embedding list of another element type, or a row that is not a list, is refused", () => {
      expect(refusalOf(() => run([[[0, 1, 0, 0]]], "clips[h16]")).message).toBe(
        "clips[h16] is an embedding list of Float16Vector; Studio searches one of FloatVector only.",
      );
      expect(refusalOf(() => run([[5]])).message).toBe("data[0][0]: an embedding list holds rows of numbers.");
      expect(refusalOf(() => run([[[0, 1, 0]]])).key).toBe("data[0][0]");
    });
  });

  describe("described dimensions (5.6, E13)", () => {
    const vectorOf = (data_type: string, dim: string | undefined) =>
      describeAnswer(
        collectionSchema("dims", [
          fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
          fieldSchema({ name: "v", data_type, type_params: dim === undefined ? [] : [{ key: "dim", value: dim }] }),
        ]),
      );
    test.each([
      ["FloatVector", "1", "2 to 32,768"],
      ["FloatVector", "40000", "2 to 32,768"],
      ["FloatVector", "2147483648", "2 to 32,768"],
      ["BinaryVector", "12", "a multiple of 8 from 8 to 262,144 bits"],
      ["BinaryVector", "262152", "a multiple of 8 from 8 to 262,144 bits"],
      ["FloatVector", undefined, "2 to 32,768"],
    ])("%s with dim %s is refused before it drives a check", (type, dim, range) => {
      expect(
        refusalOf(() =>
          lowerWith(
            'POST entities/search\n{"collectionName": "dims", "annsField": "v", "data": [[1, 2]]}',
            vectorOf(type, dim),
          ),
        ),
      ).toEqual({
        phase: 1,
        key: "annsField",
        message: `v declares the dimension ${dim ?? "none"}, outside the default server maximum (${range}), so Studio does not search it.`,
      });
    });
  });

  test("annsField must be a vector field of the collection", () => {
    expect(refusalOf(() => search("docs_int64", { annsField: "seq", data: [VECTOR] }))).toEqual({
      phase: 1,
      key: "annsField",
      message: '"seq" is not a vector field of docs_int64.',
    });
    expect(refusalOf(() => search("docs_int64", { annsField: "nope[x]", data: [VECTOR] })).key).toBe("annsField");
  });
});

describe("the index checks (E11, E28, 5.5)", () => {
  const unreadable: IndexReading = { kind: "unreadable" };

  test("a metric that differs from the index's is refused in phase 1, since Milvus answers it as not loaded (R40 M4)", () => {
    expect(
      refusalOf(() => search("docs_int64", { annsField: "vec", data: [VECTOR], searchParams: { metric_type: "L2" } })),
    ).toEqual({
      phase: 1,
      key: "searchParams",
      message:
        'vec is indexed with COSINE, and this request names "L2": Milvus answers a metric mismatch as if the collection were not loaded, so Studio refuses it here.',
    });
  });

  test("without IndexDetail, a search that names no metric and no parameter runs, its score unreadable (R51 U32)", () => {
    expect(search("docs_int64", { annsField: "vec", data: [VECTOR] }, unreadable)).toMatchObject({
      shape: { score: { kind: "unreadable" } },
    });
  });

  test.each([{ metric_type: "COSINE" }, { params: { ef: 100 } }])(
    "without IndexDetail, %j is refused naming it",
    (searchParams) => {
      expect(
        refusalOf(() => search("docs_int64", { annsField: "vec", data: [VECTOR], searchParams }, unreadable)),
      ).toEqual({
        phase: 1,
        key: "searchParams",
        message:
          "This search names a metric or a search parameter, which Studio checks against the index, and this Milvus user cannot read the index: grant IndexDetail, or leave both out.",
      });
    },
  );

  test("a field with no index takes no metric and no parameter, and its score names none", () => {
    const none: IndexReading = { kind: "read", response: describedIndex({}) };
    expect(search("docs_int64", { annsField: "vec", data: [VECTOR] }, none)).toMatchObject({
      shape: { score: { kind: "unreported" } },
    });
    expect(
      refusalOf(() =>
        search("docs_int64", { annsField: "vec", data: [VECTOR], searchParams: { params: { ef: 100 } } }, none),
      ).message,
    ).toBe("vec has no index, so it takes no metric and no search parameter.");
  });

  test("a search lowered without its DescribeIndex answer is a programming error", () => {
    expect(() => search("docs_int64", { annsField: "vec", data: [VECTOR] }, { kind: "not-read" })).toThrow(
      "This search needs the DescribeIndex answer fetched for it",
    );
  });

  test.each([
    [
      "docs_int64",
      "vec",
      VECTOR,
      { nprobe: 16 },
      "A HNSW index does not take nprobe; it takes ef, radius, range_filter.",
    ],
    ["docs_varchar", "bin", [9, 13], { ef: 100 }, "A BIN_FLAT index does not take ef; it takes radius, range_filter."],
    [
      "docs_varchar",
      "sparse",
      { "1": 0.5 },
      { radius: 0.5 },
      "A SPARSE_INVERTED_INDEX index does not take radius; it takes drop_ratio_search, dim_max_score_ratio, refine_factor.",
    ],
  ])("%s.%s refuses a key its index type does not take", (collection, annsField, vector, params, message) => {
    expect(refusalOf(() => search(collection, { annsField, data: [vector], searchParams: { params } }))).toEqual({
      phase: 1,
      key: `searchParams.${Object.keys(params)[0]}`,
      message,
    });
  });

  test("an index type Studio has not measured takes no key", () => {
    const gpu: IndexReading = {
      kind: "read",
      response: describedIndex({ vec: { indexType: "GPU_CAGRA", metric: "L2" } }),
    };
    expect(
      refusalOf(() =>
        search("docs_int64", { annsField: "vec", data: [VECTOR], searchParams: { params: { ef: 100 } } }, gpu),
      ).message,
    ).toBe("Studio sends no search parameter to a GPU_CAGRA index, which it has not measured.");
  });

  test("an index with an empty key list says it takes none", () => {
    const sparseIndex: IndexReading = {
      kind: "read",
      response: describedIndex({ vec: { indexType: "SPARSE_WAND", metric: "IP" } }),
    };
    expect(
      refusalOf(() =>
        search("docs_int64", { annsField: "vec", data: [VECTOR], searchParams: { params: { ef: 100 } } }, sparseIndex),
      ).message,
    ).toBe("A SPARSE_WAND index does not take ef; it takes drop_ratio_search, dim_max_score_ratio, refine_factor.");
  });

  describe("a range's order follows the metric (R43)", () => {
    const range = (collection: string, annsField: string, vector: unknown, radius: number, rangeFilter: number) =>
      search(collection, {
        annsField,
        data: [vector],
        searchParams: { params: { radius, range_filter: rangeFilter } },
      });

    test("COSINE, a similarity, needs range_filter above radius", () => {
      expect(range("docs_int64", "vec", VECTOR, 0.5, 0.9).kind).toBe("search");
      expect(refusalOf(() => range("docs_int64", "vec", VECTOR, 0.9, 0.5))).toEqual({
        phase: 1,
        key: "searchParams.range_filter",
        message:
          "With COSINE, range_filter must lie above radius and never equal it; Milvus retries a reversed pair for seconds before it refuses.",
      });
    });

    test("L2, a distance, needs range_filter below radius, and never equal", () => {
      expect(range("docs_varchar", "f16", F16, 10, 1).kind).toBe("search");
      expect(refusalOf(() => range("docs_varchar", "f16", F16, 1, 10)).message).toContain("must lie below radius");
      expect(refusalOf(() => range("docs_varchar", "f16", F16, 1, 1)).message).toContain("never equal it");
    });

    test("a metric whose order Studio does not know cannot take a range", () => {
      const maxSim: IndexReading = {
        kind: "read",
        response: describedIndex({ vec: { indexType: "HNSW", metric: "MAX_SIM_COSINE" } }),
      };
      expect(
        refusalOf(() =>
          search(
            "docs_int64",
            { annsField: "vec", data: [VECTOR], searchParams: { params: { radius: 0.1, range_filter: 0.5 } } },
            maxSim,
          ),
        ).message,
      ).toBe("Studio cannot order a range for the MAX_SIM_COSINE metric.");
    });
  });
});

describe("entities/hybrid_search lowering (5.4, E35, R40 M1, F3)", () => {
  const EXAMPLE_8 = {
    collectionName: "docs_varchar",
    search: [
      { annsField: "f16", data: [F16], limit: 10 },
      { annsField: "sparse", data: [{ "17": 0.4, "230": 0.2 }], limit: 10 },
    ],
    rerank: { strategy: "rrf", params: { k: 60 } },
    outputFields: ["pk", "label"],
    limit: 5,
  };
  const hybrid = (body: Record<string, unknown>, index: IndexReading = { kind: "not-read" }) => {
    const operation = lowerWith(
      `POST entities/hybrid_search\n${JSON.stringify(body)}`,
      describedCollection("docs_varchar"),
      index,
    );
    if (operation.kind !== "hybridSearch") throw new Error(`expected a hybrid search, got ${operation.kind}`);
    return operation;
  };

  test("example 8: sub-requests carry a placeholder and no consistency; rank_params carry the rerank and the window", () => {
    const { request, shape } = hybrid(EXAMPLE_8);
    expect(request.requests).toHaveLength(2);
    expect(request.requests[0]).toEqual({
      collection_name: "docs_varchar",
      dsl: "",
      dsl_type: "BoolExprV1",
      placeholder_group: encodePlaceholderGroup("FloatVector", [floatVectorBytes(F16)]),
      output_fields: ["pk", "label"],
      search_params: [
        { key: "anns_field", value: "f16" },
        { key: "topk", value: "10" },
        { key: "params", value: "{}" },
      ],
      nq: "1",
    });
    expect(request.requests[1].placeholder_group).toEqual(
      encodePlaceholderGroup("SparseFloatVector", [sparseVectorBytes({ indices: [17, 230], values: [0.4, 0.2] })]),
    );
    for (const sub of request.requests) {
      expect(sub.consistency_level).toBeUndefined();
      expect(sub.use_default_consistency).toBeUndefined();
      expect(sub.ids).toBeUndefined();
    }
    expect(request.rank_params.map((entry) => entry.key)).toEqual([
      "strategy",
      "params",
      "limit",
      "offset",
      "round_decimal",
    ]);
    expect(Object.fromEntries(request.rank_params.map((entry) => [entry.key, entry.value]))).toMatchObject({
      strategy: "rrf",
      limit: "5",
      offset: "0",
      round_decimal: "-1",
    });
    expect(JSON.parse(request.rank_params[1].value)).toEqual({ k: 60 });
    expect(request).toMatchObject({
      collection_name: "docs_varchar",
      output_fields: ["pk", "label"],
      use_default_consistency: true,
    });
    expect(shape).toMatchObject({ nq: 1, limit: 5, offset: 0, score: { kind: "fused", strategy: "rrf" } });
  });

  test("consistency goes on the top level only (R40 F3)", () => {
    const { request } = hybrid({ ...EXAMPLE_8, consistencyLevel: "Strong", partitionNames: ["_default"] });
    expect(request).toMatchObject({
      consistency_level: "Strong",
      use_default_consistency: false,
      partition_names: ["_default"],
    });
    expect(request.requests[0].consistency_level).toBeUndefined();
  });

  test("grouping goes into rank_params (R40 M16), and weighted sends its weights", () => {
    const { request, shape } = hybrid({
      ...EXAMPLE_8,
      rerank: { strategy: "weighted", params: { weights: [0.7, 0.3] } },
      groupingField: "label",
      groupSize: 2,
    });
    expect(request.rank_params.slice(5)).toEqual([
      { key: "group_by_field", value: "label" },
      { key: "group_size", value: "2" },
    ]);
    expect(JSON.parse(request.rank_params[1].value)).toEqual({ weights: [0.7, 0.3] });
    expect(shape.score).toEqual({ kind: "fused", strategy: "weighted" });
    expect(shape.groupingField?.name).toBe("label");
  });

  test("a rerank with no params sends {}", () => {
    expect(hybrid({ ...EXAMPLE_8, rerank: { strategy: "rrf" } }).request.rank_params[1].value).toBe("{}");
  });

  test("a sub-request's params and metric are checked against the index of its field", () => {
    const index = INDEXES.docs_varchar;
    const { request } = hybrid(
      {
        ...EXAMPLE_8,
        search: [
          {
            annsField: "f16",
            data: [F16],
            limit: 10,
            params: { ef: 20 },
            metricType: "L2",
            filter: "label == {l}",
            exprParams: { l: "north" },
          },
        ],
      },
      index,
    );
    expect(request.requests[0].search_params.map((entry) => entry.key)).toEqual([
      "anns_field",
      "topk",
      "params",
      "metric_type",
    ]);
    expect({ ...request.requests[0].expr_template_values }).toEqual({ l: { string_val: "north" } });
    expect(
      refusalOf(() => hybrid({ ...EXAMPLE_8, search: [{ annsField: "f16", data: [F16], metricType: "IP" }] }, index))
        .key,
    ).toBe("search[0].params");
  });

  test("a sub-request's vectors are checked in its field's dtype", () => {
    expect(
      refusalOf(() => hybrid({ ...EXAMPLE_8, search: [{ annsField: "i8", data: [[300, 0, 0, 0, 0, 0, 0, 0]] }] })),
    ).toMatchObject({
      phase: 1,
      key: "search[0].data[0]",
    });
    expect(refusalOf(() => hybrid({ ...EXAMPLE_8, search: [{ annsField: "label", data: [F16] }] }))).toEqual({
      phase: 1,
      key: "search[0].annsField",
      message: '"label" is not a vector field of docs_varchar.',
    });
  });
});
