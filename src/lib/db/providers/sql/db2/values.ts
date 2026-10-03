/**
 * db2-node results, read into the product's `QueryResult` (#786).
 *
 * NO VALUE IS CONVERTED HERE, and that is a decision rather than an omission. db2-node 1.0.24
 * hands BIGINT back as a JS number inside the safe integer range and as its exact decimal string
 * beyond it, DECIMAL and DECFLOAT as strings, DATE as `2024-02-29`, TIME as `23.59.59`, a
 * TIMESTAMP of any precision as `2024-02-29-23.59.59.123456`, BINARY and BLOB as a Buffer and
 * CHAR space padded. Each of those is the driver's reading of the wire, and a second reading on
 * top of it (a `new Date`, a trim of user data) would only add a defect of ours to the driver's.
 * What this module adds is the declaration of each column, and the warnings that tell a reader
 * where the driver is known to be wrong.
 */

import type { PreviewProjection, QueryResult, QueryWarning } from "@/lib/db/types";
import { declaredColumnTypes } from "../column-types";
import type { Db2ColumnMeta, Db2QueryResult } from "./driver";

/** The driver's spellings that map one to one onto Db2's own type name. */
const PLAIN_TYPES: Readonly<Record<string, string>> = {
  BigInt: "BIGINT",
  SmallInt: "SMALLINT",
  Integer: "INTEGER",
  Real: "REAL",
  Double: "DOUBLE",
  Date: "DATE",
  Time: "TIME",
  Timestamp: "TIMESTAMP",
  Boolean: "BOOLEAN",
  Xml: "XML",
};

/**
 * The longest VARCHAR Db2 has. db2-node 1.0.24 describes some CLOB columns as `VarChar(32777)`
 * (measured: a `CLOB(1M)` column, a `CLOB(2G)` cast and `SYSCAT.VIEWS.TEXT`), and no VARCHAR can
 * be longer than this, so a longer one is a CLOB.
 */
const VARCHAR_MAX_LENGTH = 32672;

/** The spellings that carry a length, `VarChar(50)`, upper-cased onto Db2's `VARCHAR(50)`. */
const SIZED_TYPE = /^(Char|VarChar|Binary|VarBinary|DecFloat)\((\d+)\)$/i;

/** `Decimal { precision: 9, scale: 2 }`, the driver's Rust debug spelling of a DECIMAL. */
const DECIMAL_TYPE = /^Decimal \{ precision: (\d+), scale: (\d+) \}$/;

/**
 * The Db2 type name of one result column, in the engine's own upper-case spelling.
 *
 * The driver's `db2TypeName` wins where it supplies one (measured: only GRAPHIC and VARGRAPHIC,
 * which its `typeName` spells as CHAR). A spelling nothing below knows is shown verbatim: the
 * value is for display and export only, and a guess would be a type the column does not have.
 */
export function db2TypeName(column: Db2ColumnMeta): string {
  if (column.db2TypeName !== undefined) return column.db2TypeName;
  if (Object.hasOwn(PLAIN_TYPES, column.typeName)) return PLAIN_TYPES[column.typeName];
  const sized = SIZED_TYPE.exec(column.typeName);
  if (sized !== null) {
    const name = sized[1].toUpperCase();
    if (name === "VARCHAR" && Number(sized[2]) > VARCHAR_MAX_LENGTH) return "CLOB";
    return `${name}(${sized[2]})`;
  }
  const decimal = DECIMAL_TYPE.exec(column.typeName);
  if (decimal !== null) return `DECIMAL(${decimal[1]},${decimal[2]})`;
  return column.typeName;
}

/** The result types db2-node 1.0.24 can misread when another column shares the row (K4). */
const LARGE_OBJECT_TYPE = /^(CLOB|DBCLOB|BLOB|XML)$/;

/**
 * One warning naming the LOB and XML columns of a result that holds other columns too, or nothing.
 *
 * Measured on 12.1.0.0 through db2-node 1.0.24 (K4): a BLOB read beside a CLOB answered the
 * CLOB's bytes, a CLOB beside a GRAPHIC answered no row of three, a CLOB beside a DOUBLE failed
 * with a protocol error, and `SELECT *` over a table holding all four answered one row of three
 * and lost two columns from the header. Each of them read on its own was exact.
 */
function integrityWarning(types: readonly (readonly [string, string])[]): string[] {
  if (types.length < 2) return [];
  const named = new Map(types.filter(([, type]) => LARGE_OBJECT_TYPE.test(type)));
  if (named.size === 0) return [];
  const columns = [...named].map(([name, type]) => `${name} (${type})`).join(", ");
  return [
    "This result may not be what Db2 stored: db2-node can return wrong values, or drop rows, when a LOB or XML " +
      `column is read beside other columns, here ${columns}. Select each of them on its own to read it exactly ` +
      "(K4). Exported or copied rows carry the same values.",
  ];
}

/** One warning per column name the driver listed more than once (M7, K15). */
function duplicateWarnings(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  return [...duplicated].map(
    (name) =>
      `Db2 returned more than one column named ${name}; db2-node keys rows by column name, so only the last value ` +
      "is shown. Give each column its own alias.",
  );
}

/** One driver result as the product's `QueryResult`, without its execution time. */
export function readResult(result: Db2QueryResult): Omit<QueryResult, "executionTime"> {
  const fields = result.columns.map((column) => column.name);
  const types = result.columns.map((column) => [column.name, db2TypeName(column)] as const);
  const isResultSet = result.columns.length > 0;
  const warnings: QueryWarning[] = [
    ...integrityWarning(types),
    ...duplicateWarnings(fields),
    ...result.diagnostics,
  ].map((message) => ({ message }));
  return {
    rows: result.rows,
    fields,
    // A statement with no result set reports the driver's count of changed rows, which 1.0.24
    // reads from SQLERRD3: an UPDATE that matched nothing answers 0 (K19, fixed).
    rowCount: isResultSet ? result.rows.length : result.rowCount,
    ...declaredColumnTypes(types),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * How the object browser's preview reads each Db2 column, so a preview shows what Db2 stored
 * (#786). Matched against the declared type `catalog.ts` renders.
 *
 * Every column is read as itself except a LOB and XML, which are left out. Measured on 12.1.0.0
 * through db2-node 1.0.24, the 21 other columns of `APP.ALLTYPES` read together answered all
 * three rows exactly, BIGINT, DECFLOAT, BOOLEAN, TIMESTAMP(0) and TIMESTAMP(12) and non-ASCII
 * VARCHAR included, which 1.0.22 needed a cast for each (K1, K2, K3, K6, K8). A LOB or XML column
 * beside other columns can still come back wrong or take rows with it (K4), and a preview is
 * exactly a row of many columns, so those stay out.
 */
export const DB2_PREVIEW_PROJECTION: PreviewProjection = {
  rules: [
    { type: "^(CLOB|DBCLOB|BLOB)\\(", expression: null },
    { type: "^XML$", expression: null },
  ],
  omittedNote:
    "db2-node can return a wrong value, or none, for a LOB or XML column read beside other columns; select each " +
    "one on its own, as docs/providers/db2.md shows.",
  unprojectedNote:
    "The column list is not loaded, so this reads every column as db2-node returns it, which can be wrong for a " +
    "LOB or XML column beside the others (docs/providers/db2.md).",
};
