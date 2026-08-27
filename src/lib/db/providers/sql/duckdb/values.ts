/**
 * DuckDB result mapping (issue #424)
 *
 * Two conversions live here, both of them things the engine answers in a shape the
 * rest of the product does not speak.
 *
 * 1. A statement result -> `QueryResult`. The interesting part is not the rows, it is
 *    which statements HAVE rows: DuckDB answers every DML and DDL statement with a
 *    one-column result named `Count` (measured - `INSERT` of two rows answers
 *    `[{"Count":"2"}]`, `CREATE TABLE` answers zero rows with the same column
 *    declared), and surfacing that as a result grid would show the operator a table
 *    with one cell where their `UPDATE` used to report a row count.
 * 2. DuckDB's human-formatted sizes -> bytes. `pragma_database_size()` publishes
 *    `"2.0 MiB"` and `"0 bytes"` for every size column except `block_size`, so a
 *    provider that wants a byte figure has to parse the text the engine printed.
 */

import type { QueryResult } from "@/lib/types";
import type { DuckDBStatementResult } from "./client";

// ============================================================================
// Statement classification
// ============================================================================

/**
 * The one column DuckDB declares for a statement that changed things rather than
 * selected them.
 */
const DML_RESULT_COLUMN = "Count";

/**
 * Leading keywords that open a statement DuckDB answers with ROWS.
 *
 * Wider than `SQLBaseProvider.isReadOnlyQuery`'s set on purpose, and used for a
 * different question. That predicate ROUTES sqlite between two driver calls, and its
 * set (SELECT/SHOW/DESCRIBE/EXPLAIN/PRAGMA) is missing four forms DuckDB reads as
 * queries - `FROM tbl` (FROM-first syntax), `CALL`, `SUMMARIZE` and `PIVOT` - which is
 * bug #275 waiting in a new dialect. This provider never routes on a keyword at all:
 * it runs every statement through one call and reads the answer's SHAPE. The set below
 * is only the second half of the `Count` test, so that a query the operator wrote as
 * `SELECT 1 AS Count` is never mistaken for a write.
 *
 * `EXECUTE` is in the set because a prepared statement answers whatever it was prepared
 * over: measured, `PREPARE p AS SELECT 1 AS Count` then `EXECUTE p` answers
 * `[{"Count":1}]`, which is data.
 */
const ROW_PRODUCING_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WITH",
  "VALUES",
  "TABLE",
  "CALL",
  "SUMMARIZE",
  "PIVOT",
  "UNPIVOT",
  "DESCRIBE",
  "SHOW",
  "EXPLAIN",
  "PRAGMA",
  "EXECUTE",
]);

/**
 * Whether this result is DuckDB's synthetic write acknowledgement rather than data.
 *
 * BOTH halves are required, and the default is to SHOW the result. The column shape
 * alone would swallow `SELECT 1 AS Count`; a result is discarded only when a leading
 * keyword was actually READ and that keyword produces no rows.
 *
 * `leadingKeyword` is `undefined` when the statement opens with something
 * `readLeadingKeyword` cannot name - a parenthesised `(SELECT 1 AS Count)` is the
 * measured case, and it answers a real row (DuckDB v1.5.5, 2026-08-27). An unread
 * opener therefore falls through and the result is shown exactly as the engine sent it:
 * a spurious one-cell grid is a far cheaper error than a silently discarded result.
 */
export function isWriteAcknowledgement(result: DuckDBStatementResult, leadingKeyword: string | undefined): boolean {
  if (result.columnNames.length !== 1 || result.columnNames[0] !== DML_RESULT_COLUMN) return false;
  return leadingKeyword !== undefined && !ROW_PRODUCING_KEYWORDS.has(leadingKeyword);
}

// ============================================================================
// Result mapping
// ============================================================================

/**
 * The engine's declared type per column, keyed by name.
 *
 * Duplicate column names collapse to the last one, which is what the row objects
 * themselves do (`getRowObjectsJson()` builds plain objects), so the two agree. The
 * map is built even when it would be empty; the caller decides whether to emit it,
 * because `QueryResult.columnTypes` must be ABSENT rather than `{}` when there is
 * nothing to say.
 */
export function columnTypeMap(result: DuckDBStatementResult): Record<string, string> {
  const types: Record<string, string> = {};
  result.columnNames.forEach((name, index) => {
    const type = result.columnTypes[index];
    if (type !== undefined) types[name] = type;
  });
  return types;
}

/**
 * A DuckDB statement result in the product's own vocabulary.
 *
 * A write reports `rowsChanged` and NO rows: the `Count` column is the engine's
 * acknowledgement, not a projection, and the row count is the number the operator
 * asked for. A read reports what it selected, including the zero rows and the declared
 * columns of an empty result - `columnNames()` answers for an empty row set and
 * `getRowObjectsJson()` does not, which is why the columns never come from the rows.
 */
export function toQueryResult(
  result: DuckDBStatementResult,
  executionTime: number,
  leadingKeyword: string | undefined,
): QueryResult {
  if (isWriteAcknowledgement(result, leadingKeyword)) {
    return { rows: [], fields: [], rowCount: result.rowsChanged, executionTime };
  }

  const types = columnTypeMap(result);

  return {
    rows: result.rows,
    fields: result.columnNames,
    rowCount: result.rows.length,
    executionTime,
    // Declared types travel with the result (#273) and the key is omitted rather than
    // emitted empty - DuckDB declares a type for every column of every result, so an
    // empty map here means the statement projected nothing at all.
    ...(Object.keys(types).length > 0 ? { columnTypes: types } : {}),
  };
}

// ============================================================================
// Human-formatted sizes
// ============================================================================

/**
 * The multipliers DuckDB's size formatter uses. Binary, not decimal: measured
 * `"2.0 MiB"` against a 2,109,440-byte file, so `MiB` is 1024^2 and not 1000^2.
 */
const SIZE_UNITS: Record<string, number> = {
  byte: 1,
  bytes: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/**
 * Bytes out of a string DuckDB printed for a human, or `undefined` when the text is
 * not one.
 *
 * `undefined` and not `0`, because the two are different facts and this repo has paid
 * for confusing them more than once: a `0` here reaches `StorageStats.sizeBytes` and
 * draws an empty database, while an absence lets the caller omit the panel. A real
 * `"0 bytes"` still parses to `0` - that IS a measurement.
 *
 * The parse is deliberately narrow: a number, optional whitespace, one of the units
 * above. Anything else - a unit DuckDB does not use, a locale-formatted number, an
 * empty string, a NULL that arrived as `null` - is not a reading.
 */
export function parseDuckDBSize(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;

  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(value.trim());
  if (match === null) return undefined;

  const multiplier = SIZE_UNITS[match[2].toLowerCase()];
  if (multiplier === undefined) return undefined;

  return Math.round(Number(match[1]) * multiplier);
}

/**
 * A count DuckDB sent as a decimal string, or `undefined` when it sent something else.
 *
 * BIGINT arrives as a STRING through `getRowObjectsJson()` - `estimated_size`,
 * `total_blocks`, `block_id` and every other 64-bit column - so `Number(row.x)` is the
 * ordinary reading here rather than a defensive one. Non-finite input is absent for
 * the same reason `measuredNumber` treats it so: it is not a reading either.
 */
export function readCount(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
