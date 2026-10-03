/**
 * db2-node 1.0.22 results, read into the product's `QueryResult` (#786).
 *
 * NO VALUE IS CONVERTED HERE, and that is a decision rather than an omission. The driver
 * hands BIGINT back as a JS number (lossy above 2^53), DECIMAL and DECFLOAT as strings, DATE
 * as `2024-02-29`, TIME as `23.59.59`, TIMESTAMP(6) as `2024-02-29-23.59.59.123456`, BINARY as a
 * Buffer and CHAR space padded. Each of those is the driver's reading of the wire, and a second
 * reading on top of it (a `new Date`, a trim of user data) would only add a defect of ours to the
 * driver's. What this module adds is the declaration of each column, and the warnings that tell
 * a reader where the driver is known to be wrong.
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
  if (sized !== null) return `${sized[1].toUpperCase()}(${sized[2]})`;
  const decimal = DECIMAL_TYPE.exec(column.typeName);
  if (decimal !== null) return `DECIMAL(${decimal[1]},${decimal[2]})`;
  return column.typeName;
}

/**
 * The row count a searched UPDATE or DELETE that matched NO row answers through db2-node
 * 1.0.22, measured on 12.1.0.0: the statement succeeds with SQLCODE +100 and the driver reports
 * this number instead of 0.
 */
export const DML_NO_ROW_SENTINEL = -2147221503;

/**
 * The defects db2-node 1.0.22 is known to have per result type, each in one sentence a reader
 * can act on, with the cast that reads the column correctly.
 */
const INTEGRITY_DEFECTS: readonly { readonly matches: RegExp; readonly sentence: string }[] = [
  {
    matches: /^BIGINT$/,
    sentence: "BIGINT values beyond 2^53 come back rounded; select VARCHAR(column) to read them exactly (K6).",
  },
  {
    matches: /^(DECFLOAT\(\d+\)|BOOLEAN)$/,
    sentence:
      "a DECFLOAT or BOOLEAN column can corrupt the INTEGER values in its row and add rows that do not exist; " +
      "select VARCHAR(column) instead (K2, K3).",
  },
  {
    matches: /^XML$/,
    sentence: "rows whose XML value is NULL are dropped; select XMLSERIALIZE(column AS VARCHAR(32000)) instead (K5).",
  },
];

/** One warning naming the columns of a type the driver misreads, or nothing. */
function integrityWarning(types: readonly (readonly [string, string])[]): string[] {
  const named = new Map<string, string>();
  const sentences: string[] = [];
  for (const defect of INTEGRITY_DEFECTS) {
    const hit = types.filter(([, type]) => defect.matches.test(type));
    if (hit.length === 0) continue;
    for (const [name, type] of hit) named.set(name, type);
    sentences.push(defect.sentence);
  }
  if (named.size === 0) return [];
  const columns = [...named].map(([name, type]) => `${name} (${type})`).join(", ");
  return [
    `This result may not be what Db2 stored: db2-node 1.0.22 misreads ${columns}. ${sentences.join(" ")} ` +
      "Exported or copied rows carry the same values.",
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

/**
 * How many rows a statement with no result set changed, as far as the driver can say.
 *
 * The sentinel is a measured zero. Any other negative number is no count at all, so it is
 * reported as 0 and NAMED in a warning rather than passed on as a count of rows.
 */
function changedRows(rowCount: number): { rowCount: number; warnings: string[] } {
  if (rowCount >= 0) return { rowCount, warnings: [] };
  if (rowCount === DML_NO_ROW_SENTINEL) return { rowCount: 0, warnings: [] };
  return {
    rowCount: 0,
    warnings: [
      `db2-node reported ${rowCount} changed rows, which is not a row count; the statement ran, and how many rows ` +
        "it changed is unknown.",
    ],
  };
}

/** One driver result as the product's `QueryResult`, without its execution time. */
export function readResult(result: Db2QueryResult): Omit<QueryResult, "executionTime"> {
  const fields = result.columns.map((column) => column.name);
  const types = result.columns.map((column) => [column.name, db2TypeName(column)] as const);
  const isResultSet = result.columns.length > 0;
  const changed = isResultSet ? { rowCount: result.rows.length, warnings: [] } : changedRows(result.rowCount);
  const warnings: QueryWarning[] = [
    ...integrityWarning(types),
    ...duplicateWarnings(fields),
    ...changed.warnings,
    ...result.diagnostics,
  ].map((message) => ({ message }));
  return {
    rows: result.rows,
    fields,
    rowCount: changed.rowCount,
    ...declaredColumnTypes(types),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * How the object browser's preview reads each Db2 column, so a preview shows what Db2 stored
 * (#786). Matched against the declared type `catalog.ts` renders, first rule first.
 *
 * Every expression was run against `APP.ALLTYPES` on 12.1.0.0 through db2-node 1.0.22, where the
 * same table read with `SELECT *` returned no row at all (K4):
 *
 * - BIGINT, DECFLOAT, BOOLEAN and a TIMESTAMP of any precision but 6 read as `VARCHAR(column)`:
 *   exact text, and no DECFLOAT or BOOLEAN left in the row to corrupt its INTEGERs (K2, K3, K6,
 *   K8). `CHAR(bigint)` reads exactly too but pads with a blank.
 * - A CHAR or VARCHAR reads as `VARGRAPHIC(column)`, which the driver decodes as UTF-16, so
 *   `Grüße, 世界` followed by a four-byte character arrives whole where the plain column arrives
 *   as EBCDIC mojibake (K1). Only up to a declared 9999 bytes, or 999 CODEUNITS32 characters: a
 *   value longer than VARGRAPHIC's 16336 units raises a truncation warning, and the driver
 *   answers that with rows of garbage.
 *   Unicode databases only; in another code page VARGRAPHIC of a single-byte string is refused,
 *   which `docs/providers/db2.md` records.
 * - A LOB and XML are left out. The driver cannot fetch a LOB (K7), and `XMLSERIALIZE(... AS
 *   VARCHAR(32000))` over a document longer than that dropped the row in silence (measured).
 */
export const DB2_PREVIEW_PROJECTION: PreviewProjection = {
  rules: [
    { type: "^BIGINT$", expression: "VARCHAR({column})" },
    { type: "^DECFLOAT\\(\\d+\\)$", expression: "VARCHAR({column})" },
    { type: "^BOOLEAN$", expression: "VARCHAR({column})" },
    { type: "^TIMESTAMP\\(\\d+\\)$", expression: "VARCHAR({column})" },
    { type: "^(CHARACTER|VARCHAR)\\(\\d{1,4}\\)$", expression: "VARGRAPHIC({column})" },
    { type: "^(CHARACTER|VARCHAR)\\(\\d{1,3} CODEUNITS32\\)$", expression: "VARGRAPHIC({column})" },
    { type: "^(CLOB|DBCLOB|BLOB)\\(", expression: null },
    { type: "^XML$", expression: null },
  ],
  omittedNote: "db2-node 1.0.22 cannot fetch these types; select one through a cast, as docs/providers/db2.md shows.",
  unprojectedNote:
    "The column list is not loaded, so this reads every column as db2-node 1.0.22 returns it, which can be wrong " +
    "for BIGINT, DECFLOAT, BOOLEAN, XML, LOB and non-ASCII text columns (docs/providers/db2.md).",
};
