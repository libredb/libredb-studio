/**
 * The S3 Parquet preview's schema walk. Browser-safe and pure. It runs on the
 * flat list `parquetMetadata` maps (which builds no tree) before anything calls `parquetSchema`, `getSchemaPath` or
 * `parquetReadObjects`, each of which builds the tree recursively; the walk is iterative, with a stack of remaining
 * child counts, and refuses an empty list, a list over 8 elements per allowed leaf column, a depth past the limit, a
 * child count larger than the elements left, a DECIMAL type lacking its precision or its scale, elements after the
 * root's subtree ends, and two children of one group with the same name, since a column is chosen and its chunks
 * matched by name, so a second one of a name would be read through the first one's chunks. The DECIMAL refusal
 * carries `malformedDecimal` and the duplicate-name refusal `duplicateName`, so the preview names each.
 */
import { S3_PREVIEW_ELEMENTS_PER_COLUMN, type S3PreviewLimits } from "./constants";

/** The fields of hyparquet's SchemaElement the walk reads; hyparquet's own type is assignable to it. */
export interface SchemaElementLike {
  readonly name: string;
  readonly type?: string;
  readonly num_children?: number;
  readonly converted_type?: string;
  readonly precision?: number;
  readonly scale?: number;
  readonly logical_type?: {
    readonly type: string;
    readonly precision?: number;
    readonly scale?: number;
    readonly unit?: string;
    readonly isAdjustedToUTC?: boolean;
    readonly bitWidth?: number;
    readonly isSigned?: boolean;
  };
}

export interface ParquetTopColumn {
  readonly name: string;
  readonly type: string;
  readonly leaves: number;
  /** It or any element below it has the VARIANT logical type. */
  readonly variant: boolean;
}

export interface ParquetLeaf {
  readonly path: readonly string[];
  readonly type: string;
  readonly underVariant: boolean;
  readonly decimal?: { readonly precision: number; readonly scale: number };
}

export interface ParquetSchemaShape {
  readonly ok: true;
  readonly columns: readonly ParquetTopColumn[];
  readonly leaves: readonly ParquetLeaf[];
}

const REFUSED = { ok: false } as const;
/** Two children of one group share a name; the preview refuses it with a sentence of its own. */
const DUPLICATE_NAME = { ok: false, duplicateName: true } as const;
/** A DECIMAL type lacks its precision or its scale; the preview refuses it with a sentence of its own. */
const MALFORMED_DECIMAL = { ok: false, malformedDecimal: true } as const;

/** The type string of one element with `children` children. */
export function parquetTypeString(element: SchemaElementLike, children: number): string {
  const logical = element.logical_type;
  if (children > 0 || element.type === undefined) {
    if (logical?.type === "LIST" || element.converted_type === "LIST") return "group LIST";
    if (logical?.type === "MAP" || element.converted_type === "MAP" || element.converted_type === "MAP_KEY_VALUE")
      return "group MAP";
    if (logical?.type === "VARIANT") return "group VARIANT";
    return children > 0 ? "group STRUCT" : "group";
  }
  const physical = element.type;
  if (logical !== undefined) {
    if (logical.type === "DECIMAL") return `${physical} DECIMAL(${logical.precision},${logical.scale})`;
    if (logical.type === "TIMESTAMP" || logical.type === "TIME") {
      return `${physical} ${logical.type}(${logical.unit}, ${logical.isAdjustedToUTC ? "UTC" : "local"})`;
    }
    if (logical.type === "INTEGER")
      return `${physical} INTEGER(${logical.bitWidth}, ${logical.isSigned ? "signed" : "unsigned"})`;
    return `${physical} ${logical.type}`;
  }
  if (element.converted_type === "DECIMAL") return `${physical} DECIMAL(${element.precision},${element.scale})`;
  return element.converted_type === undefined ? physical : `${physical} ${element.converted_type}`;
}

/**
 * The precision and scale of an element's DECIMAL type, from the logical type first, then the converted type;
 * "malformed" when that type lacks either, and undefined when the element is not a DECIMAL.
 */
function decimalOf(
  element: SchemaElementLike,
): { readonly precision: number; readonly scale: number } | "malformed" | undefined {
  const logical = element.logical_type;
  const holder = logical?.type === "DECIMAL" ? logical : element.converted_type === "DECIMAL" ? element : undefined;
  if (holder === undefined) return undefined;
  const { precision, scale } = holder;
  return precision === undefined || scale === undefined ? "malformed" : { precision, scale };
}

interface Frame {
  remaining: number;
  readonly path: readonly string[];
  readonly variant: boolean;
  /** The names of the children walked so far. */
  readonly names: Set<string>;
}

/** Walks the flat schema list once, iteratively; see the module docblock for what it refuses. */
export function walkParquetSchema(
  schema: readonly SchemaElementLike[],
  limits: Pick<S3PreviewLimits, "parquetMaxSchemaDepth" | "parquetMaxLeafColumns">,
): ParquetSchemaShape | { readonly ok: false; readonly duplicateName?: true; readonly malformedDecimal?: true } {
  if (schema.length === 0 || schema.length > limits.parquetMaxLeafColumns * S3_PREVIEW_ELEMENTS_PER_COLUMN)
    return REFUSED;
  const columns: { name: string; type: string; leaves: number; variant: boolean }[] = [];
  const leaves: ParquetLeaf[] = [];
  const stack: Frame[] = [{ remaining: schema[0].num_children ?? 0, path: [], variant: false, names: new Set() }];
  let next = 1;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.remaining === 0) {
      stack.pop();
      continue;
    }
    if (next >= schema.length || stack.length > limits.parquetMaxSchemaDepth) return REFUSED;
    frame.remaining -= 1;
    const element = schema[next];
    next += 1;
    const children = element.num_children ?? 0;
    const decimal = decimalOf(element);
    if (children < 0) return REFUSED;
    if (decimal === "malformed") return MALFORMED_DECIMAL;
    if (frame.names.has(element.name)) return DUPLICATE_NAME;
    frame.names.add(element.name);
    const isVariant = element.logical_type?.type === "VARIANT";
    const variant = frame.variant || isVariant;
    const path = [...frame.path, element.name];
    if (stack.length === 1)
      columns.push({ name: element.name, type: parquetTypeString(element, children), leaves: 0, variant: isVariant });
    const top = columns[columns.length - 1];
    if (variant) top.variant = true;
    if (children > 0) {
      stack.push({ remaining: children, path, variant, names: new Set() });
    } else {
      top.leaves += 1;
      leaves.push({
        path,
        type: variant ? "group VARIANT" : parquetTypeString(element, 0),
        underVariant: variant,
        ...(decimal === undefined ? {} : { decimal }),
      });
    }
  }
  if (next !== schema.length) return REFUSED;
  return { ok: true, columns, leaves };
}
