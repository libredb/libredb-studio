/**
 * db2-node results, read into the product's `QueryResult` (#786).
 *
 * NO VALUE IS CONVERTED HERE, and that is a decision rather than an omission. db2-node 1.0.25
 * hands BIGINT back as a JS number inside the safe integer range and as its exact decimal string
 * beyond it, DECIMAL and DECFLOAT as strings, DATE as `2024-02-29`, TIME as `23.59.59`, a
 * TIMESTAMP of any precision as `2024-02-29-23.59.59.123456`, BINARY and BLOB as a Buffer and
 * CHAR space padded. Each of those is the driver's reading of the wire, and a second reading on
 * top of it (a `new Date`, a trim of user data) would only add a defect of ours to the driver's.
 * What this module adds is the declaration of each column, the record each array row becomes,
 * and the warning that tells a reader where the driver is known to be wrong.
 */

import type { PreviewProjection, QueryResult, QueryWarning } from "@/lib/db/types";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { declaredColumnTypes } from "../column-types";
import { QueryError } from "../../../errors";
import type { Db2ArrayQueryResult, Db2ColumnMeta } from "./driver";

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
 * The longest VARCHAR Db2 has. db2-node 1.0.24 and 1.0.25 describe some CLOB columns as
 * `VarChar(32777)` (measured: a `CLOB(1M)` column, a `CLOB(2G)` cast and `SYSCAT.VIEWS.TEXT`),
 * and no VARCHAR can be longer than this, so a longer one is a CLOB.
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

/**
 * The declared result types a bound value can be lost in (K24), as a regular expression source:
 * the provider's `inlineEditRefusedColumns` carries it to the grid as JSON.
 */
export const LARGE_OBJECT_TYPE_SOURCE = "^(CLOB|DBCLOB|BLOB)$";
const LARGE_OBJECT_TYPE = new RegExp(LARGE_OBJECT_TYPE_SOURCE);

/** Why the grid's editor refuses such a column, shown on each of its cells. */
export const LARGE_OBJECT_EDIT_REASON =
  "Not editable inline: db2-node writes nothing, and reports no error, for a value bound to a CLOB, DBCLOB or " +
  "BLOB column declared 32768 bytes or longer (docs/providers/db2.md, K24). Change it with an UPDATE of your own " +
  "that writes the value as a literal.";

/**
 * One warning naming the CLOB, DBCLOB and BLOB columns of a result, or nothing.
 *
 * Measured on 12.1.0.0 and 11.5.9.0 through db2-node 1.0.24 and 1.0.25 (K24): a value bound to
 * such a column declared 32768 bytes or longer answers 0 changed rows, with no error and no
 * diagnostic, and is not written, alone or beside other parameters; at 32767 bytes it is. That is
 * what the grid's inline editor would send for such a cell, so the provider's
 * `inlineEditRefusedColumns` keeps the editor off these columns, and this warning says so. The
 * declared length does not reach a result (a `CLOB(1M)` column arrives as `VarChar(32777)`, a
 * `CLOB(1K)` cast as `CLOB`), so every such column is named.
 */
function largeObjectEditWarning(types: readonly (readonly [string, string])[]): string[] {
  const named = types.filter(([, type]) => LARGE_OBJECT_TYPE.test(type));
  if (named.length === 0) return [];
  const columns = named.map(([name, type]) => `${name} (${type})`).join(", ");
  return [
    `The grid does not edit ${columns} inline: db2-node writes nothing, and reports no error, for a value bound ` +
      "to a CLOB, DBCLOB or BLOB column declared 32768 bytes or longer (K24). Change such a value with an UPDATE " +
      "of your own that writes it as a literal.",
  ];
}

/**
 * One driver result, read with `rowMode: "array"`, as the product's `QueryResult` without its
 * execution time. Array rows are what keep a duplicated column's every value (K15, fixed in
 * 1.0.25): an object row keys by name and keeps the last. `SELECT 1 AS A, 2 AS A` really declares
 * two columns named `A`, so the repeat is numbered while the record is built.
 */
export function readResult(result: Db2ArrayQueryResult): Omit<QueryResult, "executionTime"> {
  const fields = uniqueFieldNames(result.columns.map((column) => column.name));
  const types = result.columns.map((column, index) => [fields[index], db2TypeName(column)] as const);
  const isResultSet = result.columns.length > 0;
  const rows = result.rows.map((row) => {
    // A row whose value count differs from the declaration cannot be read by position: a short
    // one would carry `undefined` values and a long one would lose its tail, both silently.
    if (row.length !== fields.length) {
      throw new QueryError(
        `Db2 answered a row with ${row.length} values for ${fields.length} columns, so the result cannot be read`,
        "db2",
      );
    }
    return Object.fromEntries(fields.map((field, index) => [field, row[index]]));
  });
  const warnings: QueryWarning[] = [...largeObjectEditWarning(types), ...result.diagnostics].map((message) => ({
    message,
  }));
  return {
    rows,
    fields,
    // A statement with no result set reports the driver's count of changed rows, which 1.0.24
    // reads from SQLERRD3: an UPDATE that matched nothing answers 0 (K19, fixed).
    rowCount: isResultSet ? rows.length : result.rowCount,
    ...declaredColumnTypes(types),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * How the object browser's preview reads each Db2 column (#786). Matched against the declared
 * type `catalog.ts` renders.
 *
 * Every column is read as itself except a CLOB, DBCLOB and BLOB, which are left out. Measured on
 * 12.1.0.0 and 11.5.9.0 through db2-node 1.0.25, `SELECT *` over `APP.ALLTYPES` answered all 25
 * columns and three rows exactly as each column read alone, LOB and XML included (K4, fixed),
 * so reading them is no longer the problem. Writing them is: a preview is the grid's inline
 * editor, and a value bound to such a column declared 32768 bytes or longer is lost with no error
 * (K24), so the preview leaves them out rather than offer an edit that is reported saved and
 * dropped. XML is written correctly, and is read.
 */
export const DB2_PREVIEW_PROJECTION: PreviewProjection = {
  rules: [{ type: "^(CLOB|DBCLOB|BLOB)\\(", expression: null }],
  omittedNote:
    "db2-node writes nothing, and reports no error, for an inline edit of a CLOB, DBCLOB or BLOB column, so this " +
    "preview does not offer one; select such a column in a query of your own to read it (docs/providers/db2.md, K24).",
  unprojectedNote:
    "The column list is not loaded, so this reads every column; the grid does not edit a CLOB, DBCLOB or BLOB column " +
    "inline (docs/providers/db2.md, K24).",
};
