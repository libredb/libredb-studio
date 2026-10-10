/**
 * The S3 Parquet preview's schema walk. Browser-safe and pure. It runs on the
 * flat list `parquetMetadata` maps (which builds no tree) before anything calls `parquetSchema`, `getSchemaPath` or
 * `parquetReadObjects`, each of which builds the tree recursively; the walk is iterative, with a stack of remaining
 * child counts, and refuses an empty list, a list over 8 elements per allowed leaf column, a depth past the limit, a
 * child count larger than the elements left, and elements after the root's subtree ends.
 */
import type { S3PreviewLimits } from "./constants";

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

function decimalOf(element: SchemaElementLike): { readonly precision: number; readonly scale: number } | undefined {
  const logical = element.logical_type;
  if (logical?.type === "DECIMAL") return { precision: logical.precision ?? 0, scale: logical.scale ?? 0 };
  if (element.converted_type === "DECIMAL") return { precision: element.precision ?? 0, scale: element.scale ?? 0 };
  return undefined;
}

interface Frame {
  remaining: number;
  readonly path: readonly string[];
  readonly variant: boolean;
}

/** Walks the flat schema list once, iteratively; see the module docblock for what it refuses. */
export function walkParquetSchema(
  schema: readonly SchemaElementLike[],
  limits: Pick<S3PreviewLimits, "parquetMaxSchemaDepth" | "parquetMaxLeafColumns">,
): ParquetSchemaShape | { readonly ok: false } {
  if (schema.length === 0 || schema.length > limits.parquetMaxLeafColumns * 8) return REFUSED;
  const columns: { name: string; type: string; leaves: number; variant: boolean }[] = [];
  const leaves: ParquetLeaf[] = [];
  const stack: Frame[] = [{ remaining: schema[0].num_children ?? 0, path: [], variant: false }];
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
    if (children < 0) return REFUSED;
    const isVariant = element.logical_type?.type === "VARIANT";
    const variant = frame.variant || isVariant;
    const path = [...frame.path, element.name];
    if (stack.length === 1)
      columns.push({ name: element.name, type: parquetTypeString(element, children), leaves: 0, variant: isVariant });
    const top = columns[columns.length - 1];
    if (variant) top.variant = true;
    if (children > 0) {
      stack.push({ remaining: children, path, variant });
    } else {
      top.leaves += 1;
      const decimal = decimalOf(element);
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
