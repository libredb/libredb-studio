import { QueryError } from "@/lib/db/errors";
/**
 * Conceptual tables, assembled from the instances a walk returned.
 *
 * WHY ROWS ARE KEYED BY THE INDEX AND NEVER BY POSITION. Measured against Net-SNMP snmpd
 * 5.9.4 on 13 October 2026: a table whose second column is missing one row returns, for that
 * column, the rows either side of the gap and nothing in between. A GetNext that reaches the
 * gap steps to the next row rather than to an empty value, which is the absence RFC 2863
 * section 3.1.18 describes. So a builder that reads a column in order and pairs the nth value
 * with the nth row key puts the third row's value on the second row. The gap is invisible to
 * it, and the result is not an error: it is a wrong number shown confidently.
 *
 * WHY A SKIPPED CELL IS NAMED. Measured on the same agent: a column holding a value no
 * datagram can carry ends a v2c walk with no error at all, four of five rows returned and an
 * ordinary end of walk. The walk cannot name what it missed, because it never saw it. The
 * index column can: it is narrow, it carries every row key, and fetching the wide cell one row
 * at a time leaves exactly the unreachable row silent. So the builder is given the row keys
 * separately from the cells, and anything in the keys with no cell and no value is reported by
 * name rather than dropped.
 */

/** One decoded index value. A table's key is the list of these its INDEX clause names. */
export type IndexValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string };

/** How to read a table's index out of an instance suffix (RFC 2578 section 7.7). */
export type IndexShape =
  /** A single sub-identifier, such as ifIndex. */
  | { readonly kind: "integer" }
  /** An octet string whose length is the sub-identifier before it. */
  | { readonly kind: "lengthPrefixedText" }
  /** An octet string of a length the MIB fixes, with no length sub-identifier. */
  | { readonly kind: "fixedText"; readonly length: number };

export class IndexDecodeError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "IndexDecodeError";
    Object.setPrototypeOf(this, IndexDecodeError.prototype);
  }
}

/**
 * Reads an instance suffix into the index values a table's INDEX clause declares.
 *
 * Refuses a suffix that is longer or shorter than the shape, because a suffix that does not
 * fit the shape means the instance belongs to something other than this table, and guessing
 * which row it belongs to is how a value lands on the wrong row.
 */
export function decodeIndex(suffix: readonly number[], shape: readonly IndexShape[]): IndexValue[] {
  const out: IndexValue[] = [];
  let at = 0;
  for (const part of shape) {
    if (part.kind === "integer") {
      if (at >= suffix.length) throw new IndexDecodeError("index ended before its integer part");
      out.push({ kind: "number", value: suffix[at] });
      at += 1;
      continue;
    }
    const length = part.kind === "fixedText" ? part.length : suffix[at++];
    if (length === undefined) throw new IndexDecodeError("index ended before its length sub-identifier");
    if (at + length > suffix.length) throw new IndexDecodeError("index text runs past the end of the suffix");
    const bytes = suffix.slice(at, at + length);
    if (bytes.some((b) => b < 0 || b > 255))
      throw new IndexDecodeError("index text holds a sub-identifier that is not a byte");
    out.push({ kind: "text", value: String.fromCharCode(...bytes) });
    at += length;
  }
  if (at !== suffix.length) throw new IndexDecodeError(`index shape left ${suffix.length - at} sub-identifiers unread`);
  return out;
}

/** A stable key for one row, built from its decoded index and nothing else. */
export function rowKey(index: readonly IndexValue[]): string {
  return index.map((v) => (v.kind === "number" ? `n:${v.value}` : `t:${encodeURIComponent(v.value)}`)).join("/");
}

/** One cell, which is present with a value, absent on the wire, or known to be unreachable. */
export type Cell =
  | { readonly state: "present"; readonly value: string; readonly raw: Uint8Array }
  | { readonly state: "absent" }
  | { readonly state: "unreachable"; readonly oid: string; readonly why: string };

export interface ColumnInput {
  readonly name: string;
  /** Keyed by `rowKey`. A key with no entry is an absence, not an empty value. */
  readonly cells: ReadonlyMap<string, Cell>;
}

export interface RowKeyInput {
  readonly key: string;
  readonly index: readonly IndexValue[];
  /** The instance OID this row's cells hang from, used when a cell has to be named. */
  readonly instanceSuffix: string;
}

export interface TableRow {
  readonly index: readonly IndexValue[];
  readonly cells: ReadonlyMap<string, Cell>;
}

export interface TableResult {
  readonly rows: readonly TableRow[];
  /** Every cell that exists on the agent but could not be carried, named. */
  readonly unreachable: readonly { readonly column: string; readonly oid: string; readonly why: string }[];
  /** True when a column was short and the rows it lacked were filled from the key list. */
  readonly completedFromIndex: boolean;
}

/**
 * Builds the rows of a conceptual table.
 *
 * `rowKeys` comes from the index column, which is narrow enough to walk whole; `columns` come
 * from the wide columns, which may be short. Every row in `rowKeys` appears in the result, in
 * the order the agent gave them, and a column that lacks a row says so rather than shifting.
 */
export function buildTable(rowKeys: readonly RowKeyInput[], columns: readonly ColumnInput[]): TableResult {
  const seen = new Set<string>();
  const rows: TableRow[] = [];
  const unreachable: { column: string; oid: string; why: string }[] = [];
  let completedFromIndex = false;

  for (const key of rowKeys) {
    if (seen.has(key.key)) continue;
    seen.add(key.key);
    const cells = new Map<string, Cell>();
    for (const column of columns) {
      const cell = column.cells.get(key.key);
      if (cell === undefined) {
        cells.set(column.name, { state: "absent" });
        completedFromIndex = true;
        continue;
      }
      if (cell.state === "unreachable") unreachable.push({ column: column.name, oid: cell.oid, why: cell.why });
      cells.set(column.name, cell);
    }
    rows.push({ index: key.index, cells });
  }

  return { rows, unreachable, completedFromIndex };
}

/**
 * Joins a table that AUGMENTS another (RFC 2578 section 7.8): the two share one index, so the
 * join is on the row key and never on position. A base row with no augmenting row keeps its
 * own cells and gains absences, which is what the agent said.
 */
export function joinAugments(
  base: TableResult,
  augmenting: readonly ColumnInput[],
  rowKeys: readonly RowKeyInput[],
): TableResult {
  const byKey = new Map(rowKeys.map((k) => [rowKey(k.index), k] as const));
  const rows = base.rows.map((row) => {
    const key = byKey.get(rowKey(row.index));
    const cells = new Map(row.cells);
    for (const column of augmenting) {
      const cell = key === undefined ? undefined : column.cells.get(key.key);
      cells.set(column.name, cell ?? { state: "absent" });
    }
    return { index: row.index, cells };
  });
  return { rows, unreachable: base.unreachable, completedFromIndex: true };
}
