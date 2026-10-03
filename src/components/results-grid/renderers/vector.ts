import { type SparseVector, sparseFromCell } from "@/lib/db/vector/sparse";
import type { SparseEncoding, VectorColumn, VectorDType } from "@/lib/db/vector/types";
import type { RenderContext, ValueRenderer } from "./types";

/*
  A vector cell, drawn from what its column declares and never from the value's shape alone (vector-family spec
  3.10): `[0.1, 0.2]` is as much a JSON array as an embedding, so `classifyValue` sends a value here only when the
  result declared its column a vector and the value has that column's shape.

  A 1,536-dimension embedding used to reach the grid as one JSON line of about 30,000 characters. The cell shows
  the first elements and the size, the row detail a header line and the whole value, and Copy Cell the whole value
  as compact JSON in the engine's own encoding, so a copied cell can be pasted back into a search on the same engine.

  The element form is what makes the copy searchable. Every element of a float vector and of every multivector is
  written with a fraction when it is integral (`1.0`), because an engine can read a two-row multivector printed
  `[[1,2],[3,4]]` as a sparse pair of indices and values, and refuse it. Int8, uint8 and binary elements of a dense
  or sparse cell, and every sparse index, are written as integers.
*/

const VECTOR_CLASS = "text-hue-teal/80 font-mono";
/** Elements the one-line grid cell shows before the ellipsis. */
const PREVIEW_ELEMENTS = 8;
const ELLIPSIS = "…";
const REFUSAL = "A value that is not a cell of a declared vector column reached the vector renderer";

/** How each element type is written. A `Record` over the closed union, so a new element type does not compile until it is placed. */
const ELEMENT_FORM: Readonly<Record<VectorDType, "float" | "integer">> = {
  float32: "float",
  float64: "float",
  float16: "float",
  bfloat16: "float",
  int8: "integer",
  uint8: "integer",
  binary: "integer",
};

/** One element: a finite number, or null where the engine stored one it could not represent (a float16 overflow). */
type Element = number | null;

type VectorCell =
  | { readonly kind: "dense"; readonly values: readonly Element[] }
  | { readonly kind: "multi"; readonly rows: readonly (readonly Element[])[] }
  | {
      readonly kind: "index-map";
      readonly entries: readonly (readonly [string, Element])[];
      readonly sparse: SparseVector;
    }
  | {
      readonly kind: "indices-values";
      readonly indices: readonly Element[];
      readonly values: readonly Element[];
      readonly sparse: SparseVector;
    };

function isElement(value: unknown): value is Element {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isElementRow(value: unknown): value is readonly Element[] {
  return Array.isArray(value) && value.every(isElement);
}

function readSparse(value: unknown, encoding: SparseEncoding | undefined): VectorCell | null {
  if (encoding === undefined || value === null || typeof value !== "object") return null;
  const sparse = sparseFromCell(value, encoding);
  if (sparse === null) return null;
  if (encoding === "index-map") {
    const entries: (readonly [string, Element])[] = [];
    for (const [index, element] of Object.entries(value)) {
      if (!isElement(element)) return null;
      entries.push([index, element]);
    }
    return { kind: "index-map", entries, sparse };
  }
  const { indices, values } = value as { readonly indices?: unknown; readonly values?: unknown };
  return isElementRow(indices) && isElementRow(values) ? { kind: "indices-values", indices, values, sparse } : null;
}

/** `value` read as a cell of `column`, or null when it does not have the shape the column declares. */
function readVectorCell(value: unknown, column: VectorColumn): VectorCell | null {
  switch (column.kind) {
    case "dense":
      return isElementRow(value) ? { kind: "dense", values: value } : null;
    case "multi":
      return Array.isArray(value) && value.every(isElementRow) ? { kind: "multi", rows: value } : null;
    case "sparse":
      return readSparse(value, column.sparseEncoding);
  }
}

/** Whether `value` has the shape `column` declares, which is what `classifyValue` asks before choosing this renderer. */
export function isVectorCell(value: unknown, column: VectorColumn): boolean {
  return readVectorCell(value, column) !== null;
}

function floatText(element: Element): string {
  if (element === null) return "null";
  if (Object.is(element, -0)) return "-0.0";
  const text = String(element);
  // A fraction only where JavaScript wrote none: `1e+21` and `3.4028234663852886e+38` are already floats.
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

function integerText(element: Element): string {
  return element === null ? "null" : String(element);
}

function elementText(column: VectorColumn): (element: Element) => string {
  return column.kind === "multi" || ELEMENT_FORM[column.dtype] === "float" ? floatText : integerText;
}

function headOf<T>(items: readonly T[], text: (item: T) => string): string {
  const shown = items.slice(0, PREVIEW_ELEMENTS).map(text);
  if (items.length > PREVIEW_ELEMENTS) shown.push(ELLIPSIS);
  return shown.join(", ");
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sizeText(cell: VectorCell, column: VectorColumn): string {
  switch (cell.kind) {
    case "dense":
      return column.dtype === "binary"
        ? counted(column.dimension ?? cell.values.length * 8, "bit", "bits")
        : counted(column.dimension ?? cell.values.length, "dim", "dims");
    case "multi": {
      const rowSize = column.dimension ?? (cell.rows.length === 0 ? 0 : cell.rows[0].length);
      return `${counted(cell.rows.length, "row", "rows")} of ${counted(rowSize, "dim", "dims")}`;
    }
    case "index-map":
    case "indices-values":
      return counted(cell.sparse.indices.length, "entry", "entries");
  }
}

function sparsePreview({ indices, values }: SparseVector, text: (element: Element) => string): string {
  const pairs = indices.slice(0, PREVIEW_ELEMENTS).map((index, position) => `${index}: ${text(values[position])}`);
  if (indices.length > PREVIEW_ELEMENTS) pairs.push(ELLIPSIS);
  return `{${pairs.join(", ")}}`;
}

function previewText(cell: VectorCell, column: VectorColumn): string {
  const text = elementText(column);
  switch (cell.kind) {
    case "dense":
      return `[${headOf(cell.values, text)}]`;
    case "multi": {
      if (cell.rows.length === 0) return "[]";
      const more = cell.rows.length > 1 ? `, ${ELLIPSIS}` : "";
      return `[[${headOf(cell.rows[0], text)}]${more}]`;
    }
    case "index-map":
    case "indices-values":
      return sparsePreview(cell.sparse, text);
  }
}

function jsonArray(items: readonly string[]): string {
  return `[${items.join(",")}]`;
}

function copyText(cell: VectorCell, column: VectorColumn): string {
  const text = elementText(column);
  switch (cell.kind) {
    case "dense":
      return jsonArray(cell.values.map(text));
    case "multi":
      return jsonArray(cell.rows.map((row) => jsonArray(row.map(text))));
    case "index-map": {
      const pairs = cell.entries.map(([index, element]) => `${JSON.stringify(index)}:${text(element)}`);
      return `{${pairs.join(",")}}`;
    }
    case "indices-values":
      return `{"indices":${jsonArray(cell.indices.map(integerText))},"values":${jsonArray(cell.values.map(text))}}`;
  }
}

function declaredCell(value: unknown, context: RenderContext | undefined): { cell: VectorCell; column: VectorColumn } {
  const column = context?.vector;
  const cell = column === undefined ? null : readVectorCell(value, column);
  // `classifyValue` sends only a value of its declared column's shape here, so this is a caller that skipped it,
  // and drawing anything would invent a vector.
  if (column === undefined || cell === null) throw new Error(REFUSAL);
  return { cell, column };
}

export const vectorRenderer: ValueRenderer = {
  kind: "vector",
  renderCompact(value, context) {
    const { cell, column } = declaredCell(value, context);
    return { display: `${previewText(cell, column)} ${sizeText(cell, column)}`, className: VECTOR_CLASS };
  },
  renderDetail(value, context) {
    const { cell, column } = declaredCell(value, context);
    return {
      text: `${column.kind} ${column.dtype}, ${sizeText(cell, column)}\n${copyText(cell, column)}`,
      className: VECTOR_CLASS,
      preserveWhitespace: true,
    };
  },
  renderCopy(value, context) {
    const { cell, column } = declaredCell(value, context);
    return copyText(cell, column);
  },
};
