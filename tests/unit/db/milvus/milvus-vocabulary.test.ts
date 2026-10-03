/**
 * Milvus metrics and types in the shared vocabulary (vector-family spec 3.3, 5.3, 5.5): the score column's text for
 * every metric and source, L2 kept apart as the squared distance, and the type text of every field kind.
 */
import { describe, expect, test } from "bun:test";
import {
  fieldTypeText,
  scoreColumnText,
  scoreSemantics,
  UNDECODED_TYPES,
} from "@/lib/db/providers/vector/milvus/milvus-vocabulary";
import { fieldSchema } from "../../../helpers/milvus-described";

describe("scoreSemantics (3.3)", () => {
  test("L2 is the squared Euclidean distance, never Qdrant's euclidean", () => {
    expect(scoreSemantics("L2")).toEqual({
      kind: "distance",
      better: "lower",
      metric: "euclidean_squared",
      nativeName: "L2",
    });
  });

  test.each([
    ["COSINE", { kind: "similarity", better: "higher", metric: "cosine", nativeName: "COSINE" }],
    ["IP", { kind: "similarity", better: "higher", metric: "dot", nativeName: "IP" }],
    ["HAMMING", { kind: "distance", better: "lower", metric: "hamming", nativeName: "HAMMING" }],
    ["JACCARD", { kind: "distance", better: "lower", metric: "jaccard", nativeName: "JACCARD" }],
    ["BM25", { kind: "similarity", better: "higher", metric: "other", nativeName: "BM25" }],
    ["MHJACCARD", { kind: "distance", better: "lower", metric: "other", nativeName: "MHJACCARD" }],
    ["MAX_SIM_COSINE", { kind: "similarity", better: null, metric: "other", nativeName: "MAX_SIM_COSINE" }],
    ["constructor", { kind: "similarity", better: null, metric: "other", nativeName: "constructor" }],
  ])("%s", (metric, semantics) => {
    expect(scoreSemantics(metric)).toEqual(semantics as ReturnType<typeof scoreSemantics>);
  });
});

describe("scoreColumnText (3.3, 5.5)", () => {
  test.each([
    [{ kind: "metric", metric: "COSINE" }, "Float, COSINE, higher is closer"],
    [{ kind: "metric", metric: "IP" }, "Float, IP, higher is closer"],
    [{ kind: "metric", metric: "L2" }, "Float, L2 (squared Euclidean), lower is closer"],
    [{ kind: "metric", metric: "HAMMING" }, "Float, HAMMING, lower is closer"],
    [{ kind: "metric", metric: "BM25" }, "Float, BM25, higher is closer"],
    [{ kind: "metric", metric: "MAX_SIM_COSINE" }, "Float, MAX_SIM_COSINE, rows are in rank order"],
    [{ kind: "fused", strategy: "rrf" }, "Float, RRF fusion, higher ranks first"],
    [{ kind: "fused", strategy: "weighted" }, "Float, weighted fusion, higher ranks first"],
    [{ kind: "unreadable" }, "Float, metric not readable without IndexDetail, rows are in rank order"],
    [{ kind: "unreported" }, "Float, no index reported for the field, rows are in rank order"],
  ] as const)("%j reads %s", (score, text) => {
    expect(scoreColumnText(score)).toBe(text);
  });
});

describe("fieldTypeText (5.3, 5.5)", () => {
  const BM25 = {
    name: "text_bm25",
    id: "1",
    description: "",
    type: "BM25",
    input_field_names: ["text"],
    input_field_ids: [],
    output_field_names: ["text_sparse"],
    output_field_ids: [],
    params: [],
  };

  test.each([
    [fieldSchema({ name: "a", data_type: "Int32" }), "Int32"],
    [fieldSchema({ name: "a", data_type: "Int64" }), "Int64"],
    [
      fieldSchema({ name: "a", data_type: "VarChar", type_params: [{ key: "max_length", value: "256" }] }),
      "VarChar(256)",
    ],
    [fieldSchema({ name: "a", data_type: "VarChar" }), "VarChar(?)"],
    [
      fieldSchema({
        name: "a",
        data_type: "Array",
        element_type: "Int64",
        type_params: [{ key: "max_capacity", value: "8" }],
      }),
      "Array<Int64>(8)",
    ],
    [
      fieldSchema({ name: "a", data_type: "FloatVector", type_params: [{ key: "dim", value: "768" }] }),
      "FloatVector(768)",
    ],
    [
      fieldSchema({ name: "a", data_type: "Float16Vector", type_params: [{ key: "dim", value: "8" }] }),
      "Float16Vector(8)",
    ],
    [
      fieldSchema({ name: "a", data_type: "BinaryVector", type_params: [{ key: "dim", value: "16" }] }),
      "BinaryVector(16)",
    ],
    [fieldSchema({ name: "a", data_type: "SparseFloatVector" }), "SparseFloatVector"],
    [fieldSchema({ name: "text_sparse", data_type: "SparseFloatVector" }), "SparseFloatVector(BM25: text_bm25)"],
    [fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }), "JSON (dynamic)"],
    [fieldSchema({ name: "a", data_type: "Decimal" }), "Decimal (not supported)"],
    [fieldSchema({ name: "a", data_type: "Timestamptz" }), "Timestamptz"],
  ])("%j is %s", (field, text) => {
    expect(fieldTypeText(field, [BM25])).toBe(text);
  });

  test("the types Studio does not decode", () => {
    expect([...UNDECODED_TYPES]).toEqual(["Decimal", "Date", "Time", "Mol"]);
  });
});
