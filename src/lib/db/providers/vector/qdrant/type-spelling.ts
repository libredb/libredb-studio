/**
 * The type text of a Qdrant vector column, written and read back, and the column's name. `Dense(384, float32, Cosine;
 * stored normalised)` is a dense vector of 384 float32 elements compared by Cosine, `Multi(16, float32, Dot, max_sim)`
 * a multivector whose rows hold 16 elements, `Sparse(idf)` a sparse vector with the idf modifier and `Sparse(none,
 * uint8)` one whose index stores uint8 values. schema.ts writes the text for a column; the tree's generators hold only
 * that column, so this is how they learn a vector's name, kind, element type and size without a read of their own.
 *
 * Pure and browser-safe: it imports types and nothing else. A text it does not recognise is not a vector.
 */
import type { VectorTarget } from "@/lib/db/vector/dense";
import type { VectorDType } from "@/lib/db/vector/types";

/** Qdrant's vector datatypes with the element type Studio reads and checks: turbo4 stores a 4-bit code and is read and searched as float32. */
export const QDRANT_ELEMENT_DTYPE = {
  float32: "float32",
  float16: "float16",
  uint8: "uint8",
  turbo4: "float32",
} as const satisfies Readonly<Record<string, VectorDType>>;

export type QdrantDatatype = keyof typeof QDRANT_ELEMENT_DTYPE;

/** One vector as its type text states it. */
export type QdrantVectorShape =
  | { readonly kind: "dense"; readonly size: number; readonly datatype: QdrantDatatype; readonly distance: string }
  | {
      readonly kind: "multi";
      readonly size: number;
      readonly datatype: QdrantDatatype;
      readonly distance: string;
      readonly comparator: string;
    }
  | { readonly kind: "sparse"; readonly modifier: string; readonly datatype: QdrantDatatype };

/** The column of the unnamed vector, and the prefix of a named vector's column: Qdrant's own names for both. */
const UNNAMED_COLUMN = "vector";
const NAMED_PREFIX = "vector.";

/** A vector's column: `vector` for the unnamed one, `vector.<name>` for a named one. */
export function vectorColumnName(vectorName: string): string {
  return vectorName === "" ? UNNAMED_COLUMN : `${NAMED_PREFIX}${vectorName}`;
}

/** The vector a column names, "" for the unnamed one; null for a column that is not a vector's. */
export function vectorNameOfColumn(column: string): string | null {
  if (column === UNNAMED_COLUMN) return "";
  return column.startsWith(NAMED_PREFIX) && column.length > NAMED_PREFIX.length
    ? column.slice(NAMED_PREFIX.length)
    : null;
}

/**
 * What the type text adds for a float32 Cosine vector: Qdrant normalises it when it is written, so the cell a user
 * reads is not the vector that was sent.
 */
const NORMALISED = "; stored normalised";

function storedNormalised(shape: { readonly datatype: QdrantDatatype; readonly distance: string }): string {
  return shape.distance === "Cosine" && shape.datatype === "float32" ? NORMALISED : "";
}

/** The type text of a vector column. */
export function vectorTypeText(shape: QdrantVectorShape): string {
  if (shape.kind === "sparse") {
    return shape.datatype === "float32" ? `Sparse(${shape.modifier})` : `Sparse(${shape.modifier}, ${shape.datatype})`;
  }
  const head = `${shape.size}, ${shape.datatype}, ${shape.distance}`;
  return shape.kind === "dense"
    ? `Dense(${head}${storedNormalised(shape)})`
    : `Multi(${head}, ${shape.comparator}${storedNormalised(shape)})`;
}

/** The largest dense size Qdrant accepts; a text naming a larger one is not a vector this provider writes a query for. */
export const QDRANT_MAX_VECTOR_SIZE = 65_536;

const DENSE_TEXT = /^Dense\(([1-9][0-9]*), ([a-z0-9]+), ([A-Za-z]+)(?:; stored normalised)?\)$/;
const MULTI_TEXT = /^Multi\(([1-9][0-9]*), ([a-z0-9]+), ([A-Za-z]+), ([a-z_]+)(?:; stored normalised)?\)$/;
const SPARSE_TEXT = /^Sparse\(([a-z]+)(?:, ([a-z0-9]+))?\)$/;

function datatypeOf(text: string | undefined): QdrantDatatype | null {
  if (text === undefined) return "float32";
  return Object.hasOwn(QDRANT_ELEMENT_DTYPE, text) ? (text as QdrantDatatype) : null;
}

/** The vector a type text states, or null for a text that is not a vector's. */
export function vectorShapeOfType(typeText: string): QdrantVectorShape | null {
  const sparse = SPARSE_TEXT.exec(typeText);
  if (sparse !== null) {
    const datatype = datatypeOf(sparse[2]);
    return datatype === null ? null : { kind: "sparse", modifier: sparse[1], datatype };
  }
  const dense = DENSE_TEXT.exec(typeText);
  if (dense !== null) {
    const datatype = datatypeOf(dense[2]);
    const size = Number(dense[1]);
    return datatype === null || size > QDRANT_MAX_VECTOR_SIZE
      ? null
      : { kind: "dense", size, datatype, distance: dense[3] };
  }
  const multi = MULTI_TEXT.exec(typeText);
  if (multi === null) return null;
  const datatype = datatypeOf(multi[2]);
  const size = Number(multi[1]);
  return datatype === null || size > QDRANT_MAX_VECTOR_SIZE
    ? null
    : { kind: "multi", size, datatype, distance: multi[3], comparator: multi[4] };
}

/** The vector target a column's type text declares, under the vector's name; null for a text that is not a vector's. */
export function vectorTargetOfType(name: string, typeText: string): VectorTarget | null {
  const shape = vectorShapeOfType(typeText);
  if (shape === null) return null;
  const dtype = QDRANT_ELEMENT_DTYPE[shape.datatype];
  return shape.kind === "sparse"
    ? { name, kind: "sparse", dtype, dimension: null }
    : { name, kind: shape.kind, dtype, dimension: shape.size };
}
