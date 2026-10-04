/**
 * The provider's own type text read back into a vector target: `FloatVector(8)` is a dense float32 field of dimension
 * 8, `BinaryVector(16)` a binary one of 16 bits, `SparseFloatVector(BM25: text_bm25)` a sparse field a BM25 function
 * produces. milvus-vocabulary.ts writes the text for a column; the tree's generators hold only that column, so this
 * is how they learn a field's kind, element type and dimension without a describe of their own.
 *
 * Pure and browser-safe: it imports a type and nothing else. A text it does not recognise is not a vector.
 */
import type { VectorTarget } from "@/lib/db/vector/dense";

/** The dense types by their text, with the element type Studio reads and checks. */
const DENSE: Readonly<Record<string, VectorTarget["dtype"]>> = {
  FloatVector: "float32",
  Float16Vector: "float16",
  BFloat16Vector: "bfloat16",
  Int8Vector: "int8",
  BinaryVector: "binary",
};

/** `Type`, `Type(8)` or `Type(?)`: the dimension where the text carries one. */
const DENSE_TEXT = /^([A-Za-z0-9]+)(?:\(([0-9]+|\?)\))?$/;

/** `SparseFloatVector`, or `SparseFloatVector(<function type>: <function name>)` for a function's output. */
const SPARSE_TEXT = /^SparseFloatVector(?:\(([A-Za-z0-9]+): (.+)\))?$/;

/** The engine's name for a struct array field's type, a column of its own that may hold an embedding list. */
export const STRUCT_ARRAY_TYPE = "ArrayOfStruct";

/** An embedding list: one or more vectors per row, whose dimension its text does not carry. */
const EMBEDDING_LIST = "ArrayOfVector";

/** The vector target a column's type text declares, or null for a text that is not a vector's. */
export function vectorTargetOfType(name: string, typeText: string): VectorTarget | null {
  if (SPARSE_TEXT.test(typeText)) return { name, kind: "sparse", dtype: "float32", dimension: null };
  if (typeText === EMBEDDING_LIST) return { name, kind: "multi", dtype: "float32", dimension: null };
  const dense = DENSE_TEXT.exec(typeText);
  if (dense === null || !Object.hasOwn(DENSE, dense[1])) return null;
  const dimension = dense[2] === undefined || dense[2] === "?" ? null : Number(dense[2]);
  return { name, kind: "dense", dtype: DENSE[dense[1]], dimension };
}

/** The function that produces a sparse field, where its text names one. */
export function functionOfType(typeText: string): { readonly type: string; readonly name: string } | null {
  const sparse = SPARSE_TEXT.exec(typeText);
  return sparse === null || sparse[1] === undefined ? null : { type: sparse[1], name: sparse[2] };
}
