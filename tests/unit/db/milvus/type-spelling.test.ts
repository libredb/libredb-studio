/**
 * The provider's own type text read back into a vector target. The text is what milvus-vocabulary.ts writes for a
 * column (`FloatVector(8)`, `SparseFloatVector(BM25: text_bm25)`); for every vector type the target read from the
 * text is the target request.ts reads from the described field, so the tree's generators and the server's checks
 * agree on a field's kind, element type and dimension. A text that is not a vector's answers null.
 */
import { describe, expect, test } from "bun:test";
import { fieldTypeText } from "@/lib/db/providers/vector/milvus/milvus-vocabulary";
import { vectorTargetOf } from "@/lib/db/providers/vector/milvus/request";
import { functionOfType, vectorTargetOfType } from "@/lib/db/providers/vector/milvus/type-spelling";
import type { VectorTarget } from "@/lib/db/vector/dense";
import { fieldSchema } from "../../../helpers/milvus-described";

const dim = (value: string) => [{ key: "dim", value }];

describe("vectorTargetOfType", () => {
  test.each([
    ["FloatVector", "8"],
    ["Float16Vector", "8"],
    ["BFloat16Vector", "8"],
    ["Int8Vector", "8"],
    ["BinaryVector", "16"],
  ])("%s: the text read back is the described field's target", (dataType, dimension) => {
    const field = fieldSchema({ name: "v", data_type: dataType, type_params: dim(dimension) });
    expect(vectorTargetOfType("v", fieldTypeText(field, []))).toEqual(vectorTargetOf(field) ?? null);
  });

  test("a sparse field, with or without the function that produces it, is sparse with no dimension", () => {
    const sparse: VectorTarget = { name: "s", kind: "sparse", dtype: "float32", dimension: null };
    expect(vectorTargetOfType("s", "SparseFloatVector")).toEqual(sparse);
    expect(vectorTargetOfType("s", "SparseFloatVector(BM25: text_bm25)")).toEqual(sparse);
  });

  test("a dense type written with no dimension, or with the unknown mark, has a null dimension", () => {
    const field = fieldSchema({ name: "v", data_type: "FloatVector" });
    expect(fieldTypeText(field, [])).toBe("FloatVector(?)");
    expect(vectorTargetOfType("v", "FloatVector(?)")).toEqual({
      name: "v",
      kind: "dense",
      dtype: "float32",
      dimension: null,
    });
    expect(vectorTargetOfType("v", "FloatVector")).toEqual({
      name: "v",
      kind: "dense",
      dtype: "float32",
      dimension: null,
    });
  });

  test("an embedding list is a multivector whose dimension the text does not carry", () => {
    expect(vectorTargetOfType("frames", "ArrayOfVector")).toEqual({
      name: "frames",
      kind: "multi",
      dtype: "float32",
      dimension: null,
    });
  });

  test.each([
    "Int64",
    "VarChar(256)",
    "Array<Int64>(8)",
    "JSON",
    "JSON (dynamic)",
    "Decimal (not supported)",
    "FloatVector(8",
    "floatvector(8)",
    "FloatVector(-1)",
    "constructor",
    "",
  ])("%j is not a vector", (typeText) => {
    expect(vectorTargetOfType("c", typeText)).toBeNull();
  });
});

describe("functionOfType", () => {
  test("names the function a sparse field's text carries", () => {
    expect(functionOfType("SparseFloatVector(BM25: text_bm25)")).toEqual({ type: "BM25", name: "text_bm25" });
    expect(functionOfType("SparseFloatVector(TextEmbedding: embed)")).toEqual({ type: "TextEmbedding", name: "embed" });
  });

  test.each(["SparseFloatVector", "FloatVector(8)", "VarChar(256)", "SparseFloatVector(BM25)", ""])(
    "%j names none",
    (typeText) => {
      expect(functionOfType(typeText)).toBeNull();
    },
  );
});
