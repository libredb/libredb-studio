/**
 * The Db2 LUW catalog reads, and the pure functions that read their rows (#786).
 *
 * Every statement here reads `SYSCAT`, binds every value with `?`, and binds the schema rather
 * than leaning on the session's (M4), so a catalog read never depends on what the session's
 * schema happens to be.
 *
 * THREE RULES SHAPE EVERY STATEMENT BELOW:
 *
 * 1. No LOB is selected beside other columns (M1). `SYSCAT.COLUMNS."DEFAULT"` and the `TEXT` of a
 *    view, a routine and a trigger are CLOBs. db2-node 1.0.22 could not fetch a CLOB at all (K7),
 *    and 1.0.24 fetched one read on its own while a LOB beside other columns could come back wrong
 *    or fail (K4, fixed in 1.0.25, where such reads answered what each column read alone does,
 *    measured on 12.1.0.0 and 11.5.9.0). Reading the CLOB whole is D165; until then a LOB is
 *    read as `VARCHAR(SUBSTRING(x, start, n, OCTETS), n)`, which never truncates: SUBSTRING with
 *    an explicit length PADS a shorter value with blanks rather than warning, and the reader cuts
 *    the padding off by the byte length `LENGTH(x)` reports beside it.
 * 2. Catalog text is read as HEX, under an alias ending `_HEX`, and decoded here. 1.0.22 decoded
 *    every non-ASCII byte of a VARCHAR as EBCDIC 037 (K1), which is why this started; 1.0.24
 *    decodes a Unicode database's text correctly. It stays because a SUBSTRING chunk of a
 *    definition or a default can end inside a character, which only bytes can be cut at cleanly,
 *    and because on a database with another code page the driver's decoding was not measured,
 *    where this provider refuses a non-ASCII name it cannot decode rather than show a guess.
 * 3. Blank-padded CHAR columns arrive padded (`SCHEMANAME` as `"APP     "`), so every one is
 *    RTRIMmed in the statement (M5).
 *
 * Two sources serve a relation's columns and the code page, and the provider picks one by its execution profile, never
 * by an error: `SYSCAT_COLUMNS` everywhere but under an agent profile, and `VALUE_FREE_COLUMNS` there. `SYSCAT.COLUMNS`
 * keeps the second highest and lowest stored value of every column (`HIGH2KEY`, `LOW2KEY`), so the agent user's seed
 * revokes it from PUBLIC with the six other objects that keep them, and the agent profile reads what holds no stored
 * value instead: `SYSIBM.COLUMNS`, `SYSIBM.SQLCOLUMNS` for a binary length and FOR BIT DATA, the primary key from
 * `SYSCAT.TABCONST` and `SYSCAT.KEYCOLUSE`, and a zero-row describe for a DECFLOAT column's precision (measured on
 * 12.1.0.0, captures 14 and 16 under `tests/fixtures/db2/12.1.0.0/agent-boundary/`).
 */

import type { ColumnSchema, ForeignKeySchema, IndexSchema, ObjectDetail } from "@/lib/db/types";
import { QueryError } from "../../../errors";
import { GRANTEES } from "./agent-read";
import type { Db2ColumnMeta } from "./driver";

// ============================================================================
// Decoding
// ============================================================================

/** The code page of a Unicode Db2 database, the only one whose non-ASCII catalog text this reads. */
export const UTF8_CODE_PAGE = 1208;

/**
 * The database's code page, read off a column every database has. `SYSIBMADM.DBCFG` answers the
 * same number but needs a privilege a plain user may not hold; `SYSCAT.COLUMNS` does not.
 */
export const CODE_PAGE_SQL = `SELECT CODEPAGE FROM SYSCAT.COLUMNS
WHERE TABSCHEMA = 'SYSIBM' AND TABNAME = 'SYSDUMMY1' AND COLNAME = 'IBMREQD'`;

/**
 * The code page under an agent profile, read off the same column as `CODE_PAGE_SQL` through `SYSIBM.COLUMNS`, which
 * names it as a character set: `IBM1208` in a Unicode database (capture 16).
 */
export const VALUE_FREE_CODE_PAGE_SQL = `SELECT CHARACTER_SET_NAME FROM SYSIBM.COLUMNS
WHERE TABLE_SCHEMA = 'SYSIBM' AND TABLE_NAME = 'SYSDUMMY1' AND COLUMN_NAME = 'IBMREQD'`;

/** The code page a `SYSIBM.COLUMNS` character set names, `IBM<code page>`; any other answer is refused. */
export function codePageOfCharacterSet(name: unknown): number {
  const match = typeof name === "string" ? /^IBM(\d+)$/.exec(name.trimEnd()) : null;
  if (match === null) {
    throw new QueryError(`Db2 answered no code page this provider can read for this database (${String(name)})`, "db2");
  }
  return Number(match[1]);
}

/**
 * Catalog bytes as text.
 *
 * UTF-8 in a Unicode database, decoded in stream mode so a definition cut mid-character at the
 * byte bound loses the incomplete character rather than gaining a replacement glyph. In any other
 * code page an all-ASCII value is decoded as ASCII, and anything else is REFUSED: this provider
 * carries no table for a non-Unicode code page, and a guessed one would put a name in the tree
 * that no statement can address.
 */
export function decodeCatalogBytes(bytes: Uint8Array, codePage: number): string {
  if (codePage === UTF8_CODE_PAGE) return new TextDecoder("utf-8").decode(bytes, { stream: true });
  if (bytes.every((byte) => byte < 0x80)) return new TextDecoder("ascii").decode(bytes);
  throw new QueryError(
    `Db2 answered catalog text that is not ASCII in a database whose code page is ${codePage}; this provider ` +
      `decodes non-ASCII catalog text only in a Unicode (code page ${UTF8_CODE_PAGE}) database.`,
    "db2",
  );
}

/** One `HEX(...)` value as text, cut to `length` bytes when a length is known. */
export function decodeCatalogHex(hex: string, codePage: number, length?: number): string {
  const bytes = Buffer.from(hex, "hex");
  return decodeCatalogBytes(length === undefined ? bytes : bytes.subarray(0, length), codePage);
}

/** The suffix that marks a column as `HEX(...)` text to decode. */
const HEX_SUFFIX = "_HEX";

/**
 * One catalog row with every `*_HEX` column decoded under its name without the suffix. A NULL
 * stays NULL; every other column passes through untouched.
 */
export function decodeCatalogRow(row: Record<string, unknown>, codePage: number): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith(HEX_SUFFIX)) {
      decoded[key] = value;
      continue;
    }
    decoded[key.slice(0, -HEX_SUFFIX.length)] = typeof value === "string" ? decodeCatalogHex(value, codePage) : value;
  }
  return decoded;
}

// ============================================================================
// Containers and counts
// ============================================================================

/** Every user schema, and which one the session resolves unqualified names in. */
export const CONTAINERS_SQL = `SELECT HEX(RTRIM(SCHEMANAME)) AS NAME_HEX,
       CASE WHEN SCHEMANAME = CURRENT SCHEMA THEN 1 ELSE 0 END AS IS_SESSION_DEFAULT
FROM SYSCAT.SCHEMATA
WHERE SCHEMANAME NOT LIKE 'SYS%' AND SCHEMANAME NOT IN ('NULLID', 'SQLJ')`;

/** Nine kinds in one statement; it binds the schema five times. */
export const COUNTS_SQL = `SELECT RTRIM('TABLES:' CONCAT TYPE) AS KIND, COUNT(*) AS N
FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T', 'V', 'S', 'A') GROUP BY TYPE
UNION ALL
SELECT 'SEQUENCES', COUNT(*) FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = ? AND SEQTYPE = 'S'
UNION ALL
SELECT 'MODULES', COUNT(*) FROM SYSCAT.MODULES WHERE MODULESCHEMA = ? AND MODULETYPE IN ('M', 'P')
UNION ALL
SELECT RTRIM('ROUTINES:' CONCAT ROUTINETYPE), COUNT(*)
FROM SYSCAT.ROUTINES
WHERE ROUTINESCHEMA = ? AND ROUTINETYPE IN ('P', 'F') AND ROUTINEMODULENAME IS NULL
  AND ORIGIN IN ('E', 'F', 'Q', 'U')
GROUP BY ROUTINETYPE
UNION ALL
SELECT 'TRIGGERS', COUNT(*) FROM SYSCAT.TRIGGERS WHERE TRIGSCHEMA = ?`;

/** The `KIND` label each count row carries, and the kind it counts. */
export const COUNT_KINDS: Readonly<Record<string, string>> = {
  "TABLES:T": "table",
  "TABLES:V": "view",
  "TABLES:S": "materialized_query_table",
  "TABLES:A": "alias",
  SEQUENCES: "sequence",
  MODULES: "module",
  "ROUTINES:P": "procedure",
  "ROUTINES:F": "function",
  TRIGGERS: "trigger",
};

// ============================================================================
// Listings
// ============================================================================

/** The `SYSCAT.TABLES.TYPE` each relation-like kind is. */
export const TABLE_TYPES: Readonly<Record<string, string>> = {
  table: "T",
  view: "V",
  materialized_query_table: "S",
  alias: "A",
};

/** The `SYSCAT.ROUTINES.ROUTINETYPE` each routine kind is. */
export const ROUTINE_TYPES: Readonly<Record<string, string>> = { procedure: "P", function: "F" };

export const LIST_TABLES_SQL = `SELECT HEX(t.TABNAME) AS NAME_HEX, RTRIM(t.STATUS) AS STATUS, t.CARD, RTRIM(v.VALID) AS VALID
FROM SYSCAT.TABLES t
LEFT JOIN SYSCAT.VIEWS v ON v.VIEWSCHEMA = t.TABSCHEMA AND v.VIEWNAME = t.TABNAME
WHERE t.TABSCHEMA = ? AND t.TYPE = ?`;

export const LIST_SEQUENCES_SQL = `SELECT HEX(SEQNAME) AS NAME_HEX FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = ? AND SEQTYPE = 'S'`;

export const LIST_MODULES_SQL = `SELECT HEX(MODULENAME) AS NAME_HEX FROM SYSCAT.MODULES
WHERE MODULESCHEMA = ? AND MODULETYPE IN ('M', 'P')`;

/**
 * A routine is ADDRESSED by its specific name and LABELLED by its routine name: an overloaded
 * function is two rows with one ROUTINENAME and two SPECIFICNAMEs.
 */
export const LIST_ROUTINES_SQL = `SELECT HEX(SPECIFICNAME) AS SEGMENT_HEX, HEX(ROUTINENAME) AS NAME_HEX, RTRIM(VALID) AS VALID
FROM SYSCAT.ROUTINES
WHERE ROUTINESCHEMA = ? AND ROUTINETYPE = ? AND ROUTINEMODULENAME IS NULL
  AND ORIGIN IN ('E', 'F', 'Q', 'U')`;

/**
 * A trigger hangs off its table when the two share a schema, and off the schema alone when they
 * do not: Db2 allows `CREATE TRIGGER REPORTING.T ... ON APP.ORDERS`, and a path under the
 * trigger's own schema cannot name a table in another.
 */
export const LIST_TRIGGERS_SQL = `SELECT HEX(TRIGNAME) AS NAME_HEX,
       CASE WHEN TABSCHEMA = TRIGSCHEMA THEN HEX(TABNAME) END AS PARENT_HEX,
       RTRIM(VALID) AS VALID
FROM SYSCAT.TRIGGERS
WHERE TRIGSCHEMA = ?`;

/** The status a reader has anything to do about, and nothing for an ordinary object. */
export function objectStatus(row: Record<string, unknown>): { status?: string } {
  if (row.VALID === "N") return { status: "INVALID" };
  if (row.VALID === "X" || row.STATUS === "X") return { status: "INOPERATIVE" };
  if (row.STATUS === "C") return { status: "SET INTEGRITY PENDING" };
  return {};
}

// ============================================================================
// Detail: columns, foreign keys, indexes
// ============================================================================

/**
 * The column read. The default is read up to 254 bytes, the most IBM allows a default constant,
 * with its full length beside it so a longer one is never shown cut.
 */
const COLUMN_SELECT = `HEX(COLNAME) AS COLUMN_NAME_HEX, HEX(TYPENAME) AS TYPENAME_HEX, LENGTH, SCALE, CODEPAGE,
       RTRIM(TYPESTRINGUNITS) AS TYPESTRINGUNITS, STRINGUNITSLENGTH, RTRIM(NULLS) AS NULLS,
       HEX(VARCHAR(SUBSTRING("DEFAULT", 1, 254, OCTETS), 254)) AS DEFAULT_BYTES, LENGTH("DEFAULT") AS DEFAULT_LENGTH,
       KEYSEQ`;

/** The byte bound of a default the column read can show whole. */
export const DEFAULT_BYTE_LIMIT = 254;

export const OBJECT_COLUMNS_SQL = `SELECT ${COLUMN_SELECT}
FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO`;

const FOREIGN_KEY_SELECT = `HEX(fk.COLNAME) AS COLUMN_NAME_HEX, HEX(RTRIM(r.REFTABSCHEMA)) AS REF_SCHEMA_HEX,
       HEX(r.REFTABNAME) AS REF_TABLE_HEX, HEX(pk.COLNAME) AS REF_COLUMN_HEX`;

/**
 * Two KEYCOLUSE joins, one per side of the constraint. `pk.TABNAME = r.REFTABNAME` is a
 * maintainer fix over #787: a key is named per table, two tables can both have a key called
 * `PK`, and without the table term the referenced side joined both tables' key columns.
 */
const FOREIGN_KEY_FROM = `FROM SYSCAT.REFERENCES r
JOIN SYSCAT.KEYCOLUSE fk
  ON fk.CONSTNAME = r.CONSTNAME AND fk.TABSCHEMA = r.TABSCHEMA AND fk.TABNAME = r.TABNAME
JOIN SYSCAT.KEYCOLUSE pk
  ON pk.CONSTNAME = r.REFKEYNAME AND pk.TABSCHEMA = r.REFTABSCHEMA AND pk.TABNAME = r.REFTABNAME
     AND pk.COLSEQ = fk.COLSEQ`;

export const OBJECT_FOREIGN_KEYS_SQL = `SELECT ${FOREIGN_KEY_SELECT}
${FOREIGN_KEY_FROM}
WHERE r.TABSCHEMA = ? AND r.TABNAME = ?
ORDER BY r.CONSTNAME, fk.COLSEQ`;

const INDEX_SELECT = `HEX(RTRIM(i.INDSCHEMA)) AS INDEX_SCHEMA_HEX, HEX(i.INDNAME) AS INDEX_NAME_HEX,
       RTRIM(i.UNIQUERULE) AS UNIQUERULE, HEX(ic.COLNAME) AS COLUMN_NAME_HEX`;

const INDEX_FROM = `FROM SYSCAT.INDEXES i
JOIN SYSCAT.INDEXCOLUSE ic ON ic.INDSCHEMA = i.INDSCHEMA AND ic.INDNAME = i.INDNAME`;

export const OBJECT_INDEXES_SQL = `SELECT ${INDEX_SELECT}
${INDEX_FROM}
WHERE i.TABSCHEMA = ? AND i.TABNAME = ?
ORDER BY i.INDSCHEMA, i.INDNAME, ic.COLSEQ`;

/** The relations of one type in one schema, by name, bounded when the caller bounds the read. */
function targetSelect(nameColumn: string, bounded: boolean): string {
  return `SELECT ${nameColumn} FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE = ? ORDER BY TABNAME${
    bounded ? " FETCH FIRST ? ROWS ONLY" : ""
  }`;
}

/**
 * The objects a bulk read describes. It binds `[schema, type]`, or `[schema, type, limit + 1]`
 * when bounded, so a saturated read says so without a second count.
 */
export function bulkTargetSql(bounded: boolean): string {
  return targetSelect("HEX(TABNAME) AS OBJECT_NAME_HEX", bounded);
}

/**
 * The three detail reads of a bulk read, each scoped to the same target set. Each binds the
 * target's values and then the schema once more, for its own `TABSCHEMA = ?`.
 */
export function bulkDetailSql(bounded: boolean): { columns: string; foreignKeys: string; indexes: string } {
  const target = `WITH TARGET AS (${targetSelect("TABNAME AS OBJECT_NAME", bounded)})`;
  return {
    columns: `${target}
SELECT HEX(TABNAME) AS OBJECT_NAME_HEX, ${COLUMN_SELECT}
FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
ORDER BY TABNAME, COLNO`,
    foreignKeys: `${target}
SELECT HEX(r.TABNAME) AS OBJECT_NAME_HEX, ${FOREIGN_KEY_SELECT}
${FOREIGN_KEY_FROM}
WHERE r.TABSCHEMA = ? AND r.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
ORDER BY r.TABNAME, r.CONSTNAME, fk.COLSEQ`,
    indexes: `${target}
SELECT HEX(i.TABNAME) AS OBJECT_NAME_HEX, ${INDEX_SELECT}
${INDEX_FROM}
WHERE i.TABSCHEMA = ? AND i.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)
ORDER BY i.TABNAME, i.INDSCHEMA, i.INDNAME, ic.COLSEQ`,
  };
}

/** The types whose catalog LENGTH is a length the declaration names. */
const LENGTH_TYPES = new Set([
  "CHARACTER",
  "VARCHAR",
  "GRAPHIC",
  "VARGRAPHIC",
  "BINARY",
  "VARBINARY",
  "CLOB",
  "BLOB",
  "DBCLOB",
]);

/**
 * The string units a declaration with none written gets, per type. A column declared in any
 * other unit prints that unit, because its LENGTH is in bytes and is not what was declared:
 * `VARCHAR(10 CODEUNITS32)` has LENGTH 40 and STRINGUNITSLENGTH 10 (measured).
 */
const DEFAULT_STRING_UNITS: Readonly<Record<string, string>> = {
  CHARACTER: "OCTETS",
  VARCHAR: "OCTETS",
  CLOB: "OCTETS",
  GRAPHIC: "CODEUNITS16",
  VARGRAPHIC: "CODEUNITS16",
  DBCLOB: "CODEUNITS16",
};

/** The size inside a length type's parentheses, in the units it was declared in. */
function declaredSize(name: string, row: Record<string, unknown>): string {
  const units = row.TYPESTRINGUNITS;
  if (typeof units !== "string") return String(row.LENGTH);
  if (units === DEFAULT_STRING_UNITS[name]) return String(row.STRINGUNITSLENGTH);
  return `${String(row.STRINGUNITSLENGTH)} ${units}`;
}

/** One column's declared type, rebuilt from its `SYSCAT.COLUMNS` row. */
export function columnType(row: Record<string, unknown>): string {
  const name = String(row.TYPENAME).trimEnd();
  if (LENGTH_TYPES.has(name)) {
    const bitData = (name === "CHARACTER" || name === "VARCHAR") && Number(row.CODEPAGE) === 0;
    return `${name}(${declaredSize(name, row)})${bitData ? " FOR BIT DATA" : ""}`;
  }
  if (name === "DECIMAL") return `DECIMAL(${String(row.LENGTH)},${String(row.SCALE)})`;
  if (name === "TIMESTAMP") return Number(row.SCALE) === 6 ? "TIMESTAMP" : `TIMESTAMP(${String(row.SCALE)})`;
  // DECFLOAT(34) is 16 bytes and DECFLOAT(16) is 8 (measured): the precision is not stored.
  if (name === "DECFLOAT") return Number(row.LENGTH) === 16 ? "DECFLOAT(34)" : "DECFLOAT(16)";
  return name;
}

// ============================================================================
// The value-free column source
// ============================================================================

/**
 * The value-free column read. `SYSIBM.COLUMNS` lists every column of every table, IBM's included, and holds no stored
 * value; `SYSIBM.SQLCOLUMNS` adds a binary column's length and FOR BIT DATA, and leaves DECFLOAT columns out, which the
 * LEFT JOIN keeps. Its default is a VARCHAR(2000), read whole as hex with its byte length beside it, which the shared
 * default reader holds to the same bound as the catalog's.
 */
const VALUE_FREE_COLUMN_SELECT = `HEX(c.COLUMN_NAME) AS COLUMN_NAME_HEX, c.DATA_TYPE, HEX(c.UDT_NAME) AS UDT_NAME_HEX,
       c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.DATETIME_PRECISION,
       CASE c.IS_NULLABLE WHEN 'YES' THEN 'Y' ELSE 'N' END AS NULLS,
       HEX(c.COLUMN_DEFAULT) AS DEFAULT_BYTES, LENGTH(c.COLUMN_DEFAULT, OCTETS) AS DEFAULT_LENGTH,
       s.TYPE_NAME AS SQL_TYPE_NAME, s.COLUMN_SIZE, pk.COLSEQ AS KEYSEQ`;

const VALUE_FREE_COLUMN_FROM = `FROM SYSIBM.COLUMNS c
LEFT JOIN SYSIBM.SQLCOLUMNS s
  ON s.TABLE_SCHEM = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME AND s.COLUMN_NAME = c.COLUMN_NAME
LEFT JOIN (SELECT k.TABSCHEMA, k.TABNAME, k.COLNAME, k.COLSEQ FROM SYSCAT.KEYCOLUSE k
           JOIN SYSCAT.TABCONST p ON p.TABSCHEMA = k.TABSCHEMA AND p.TABNAME = k.TABNAME AND p.CONSTNAME = k.CONSTNAME
           WHERE p.TYPE = 'P') pk
  ON pk.TABSCHEMA = c.TABLE_SCHEMA AND pk.TABNAME = c.TABLE_NAME AND pk.COLNAME = c.COLUMN_NAME`;

/** The ISO type names `SYSIBM.COLUMNS` answers, as a Db2 declaration spells them (capture 16). */
const ISO_TYPE_NAMES: Readonly<Record<string, string>> = {
  "CHARACTER VARYING": "VARCHAR",
  "GRAPHIC VARYING": "VARGRAPHIC",
  "CHARACTER LARGE OBJECT": "CLOB",
  "DOUBLE-BYTE CHARACTER LARGE OBJECT": "DBCLOB",
  "BINARY LARGE OBJECT": "BLOB",
  "DOUBLE PRECISION": "DOUBLE",
};

/** The string and LOB types whose `CHARACTER_MAXIMUM_LENGTH` is the length a declaration in default units names. */
const CHARACTER_LENGTH_TYPES = new Set(["CHARACTER", "VARCHAR", "GRAPHIC", "VARGRAPHIC", "CLOB", "DBCLOB", "BLOB"]);

/**
 * One column's declared type, rebuilt from its value-free row. Two things neither view keeps are left out rather than
 * guessed: the string units a column was declared in, so `VARCHAR(20 CODEUNITS32)` shows its length in the type's
 * default units, `VARCHAR(80)`; and a DECFLOAT column's precision, shown only when a describe of the table answered it
 * (`DECFLOAT_PRECISION`), and `DECFLOAT` otherwise.
 */
export function valueFreeColumnType(row: Record<string, unknown>): string {
  const iso = String(row.DATA_TYPE);
  const name = iso === "USER-DEFINED" ? String(row.UDT_NAME) : (ISO_TYPE_NAMES[iso] ?? iso);
  if (CHARACTER_LENGTH_TYPES.has(name)) {
    const bitData = (name === "CHARACTER" || name === "VARCHAR") && String(row.SQL_TYPE_NAME).endsWith("FOR BIT DATA");
    return `${name}(${String(row.CHARACTER_MAXIMUM_LENGTH)})${bitData ? " FOR BIT DATA" : ""}`;
  }
  if (name === "BINARY" || name === "VARBINARY") {
    return typeof row.COLUMN_SIZE === "number" ? `${name}(${row.COLUMN_SIZE})` : name;
  }
  if (name === "DECIMAL") return `DECIMAL(${String(row.NUMERIC_PRECISION)},${String(row.NUMERIC_SCALE)})`;
  if (name === "TIMESTAMP") {
    return Number(row.DATETIME_PRECISION) === 6 ? "TIMESTAMP" : `TIMESTAMP(${String(row.DATETIME_PRECISION)})`;
  }
  if (name === "DECFLOAT" && typeof row.DECFLOAT_PRECISION === "number") return `DECFLOAT(${row.DECFLOAT_PRECISION})`;
  return name;
}

/** A value-free DECFLOAT column whose precision no describe has answered yet. */
export function isUndescribedDecfloat(row: Record<string, unknown>): boolean {
  return row.DATA_TYPE === "DECFLOAT" && row.DECFLOAT_PRECISION === undefined;
}

/**
 * The base tables of one schema that hold a DECFLOAT column and that the session's grantees may read, the only tables
 * the value-free source describes: Db2 refuses a describe of a table the user may not read (SQL0551N, capture 16), and
 * a describe of a view would revalidate an invalid one. Binds the schema.
 */
export const DECFLOAT_DESCRIBABLE_SQL = `WITH ${GRANTEES}
SELECT HEX(t.TABNAME) AS NAME_HEX FROM SYSCAT.TABLES t
WHERE t.TABSCHEMA = ? AND t.TYPE = 'T'
  AND EXISTS (SELECT 1 FROM SYSIBM.COLUMNS c
              WHERE c.TABLE_SCHEMA = t.TABSCHEMA AND c.TABLE_NAME = t.TABNAME AND c.DATA_TYPE = 'DECFLOAT')
  AND (EXISTS (SELECT 1 FROM SYSCAT.TABAUTH a JOIN G ON G.GRANTEE = a.GRANTEE AND G.GRANTEETYPE = a.GRANTEETYPE
               WHERE a.TABSCHEMA = t.TABSCHEMA AND a.TABNAME = t.TABNAME
                 AND (a.SELECTAUTH <> 'N' OR a.CONTROLAUTH <> 'N'))
    OR EXISTS (SELECT 1 FROM SYSCAT.SCHEMAAUTH a JOIN G ON G.GRANTEE = a.GRANTEE AND G.GRANTEETYPE = a.GRANTEETYPE
               WHERE a.SCHEMANAME = t.TABSCHEMA AND (a.SELECTINAUTH <> 'N' OR a.DATAACCESSAUTH <> 'N'))
    OR EXISTS (SELECT 1 FROM TABLE (SYSPROC.AUTH_LIST_AUTHORITIES_FOR_AUTHID(SESSION_USER, 'U')) AS a
               WHERE a.AUTHORITY = 'DATAACCESS'
                 AND 'Y' IN (a.D_USER, a.D_GROUP, a.D_PUBLIC, a.ROLE_USER, a.ROLE_GROUP, a.ROLE_PUBLIC)))`;

/** A zero-row describe of one base table, its schema and name delimited exactly as the catalog spells them. */
export function zeroRowDescribeSql(schema: string, table: string): string {
  const delimited = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return `SELECT * FROM ${delimited(schema)}.${delimited(table)} WHERE 1 = 0`;
}

/** Each DECFLOAT column's precision, as db2-node 1.0.25 reports it in a describe (`DecFloat(16)`, precision 16). */
export function decfloatPrecisions(columns: readonly Db2ColumnMeta[]): Map<string, number> {
  const precisions = new Map<string, number>();
  for (const column of columns) {
    if (!column.typeName.startsWith("DecFloat") || (column.precision !== 16 && column.precision !== 34)) continue;
    precisions.set(column.name, column.precision);
  }
  return precisions;
}

/** The value-free source's column reads, scoped as the catalog's are. */
const OBJECT_VALUE_FREE_COLUMNS_SQL = `SELECT ${VALUE_FREE_COLUMN_SELECT}
${VALUE_FREE_COLUMN_FROM}
WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION`;

function bulkValueFreeColumnsSql(bounded: boolean): string {
  return `WITH TARGET AS (${targetSelect("TABNAME AS OBJECT_NAME", bounded)})
SELECT HEX(c.TABLE_NAME) AS OBJECT_NAME_HEX, ${VALUE_FREE_COLUMN_SELECT}
${VALUE_FREE_COLUMN_FROM}
WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME IN (SELECT OBJECT_NAME FROM TARGET)
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;
}

/** Where a relation's columns are read from, and how a row of that read spells its type. */
export interface ColumnSource {
  /** One relation's columns; binds the schema and the name. */
  readonly object: string;
  /** Every target's columns in a bulk read; binds as `bulkDetailSql` does. */
  bulk(bounded: boolean): string;
  /** One decoded row's declared type. */
  readonly type: (row: Record<string, unknown>) => string;
  /** Whether a DECFLOAT column's precision needs a describe of its table. */
  readonly describesDecfloat: boolean;
}

/**
 * A column's default, or nothing. A default longer than the byte bound is left out rather than
 * shown cut: `ColumnSchema` has no way to say a default is partial, and a cut expression handed
 * to a migration as complete is worse than none.
 */
function columnDefault(row: Record<string, unknown>, codePage: number): string | undefined {
  const length = row.DEFAULT_LENGTH;
  if (typeof row.DEFAULT_BYTES !== "string" || typeof length !== "number" || length > DEFAULT_BYTE_LIMIT) {
    return undefined;
  }
  return decodeCatalogHex(row.DEFAULT_BYTES, codePage, length);
}

/** The three row sets one object's detail is built from, already decoded. */
export interface DetailRows {
  readonly columns: readonly Record<string, unknown>[];
  readonly foreignKeys: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
}

/**
 * One object's detail, shared by the single and the bulk read so the two can never spell the
 * same table differently.
 *
 * `schema` is the object's own and decides only how a reference is spelled: bare inside the
 * schema and `SCHEMA.TABLE` across it, and an index in another schema likewise.
 */
export function objectDetailFromRows(
  path: readonly string[],
  schema: string,
  rows: DetailRows,
  codePage: number,
  typeOf: (row: Record<string, unknown>) => string = columnType,
): ObjectDetail {
  const columns: ColumnSchema[] = rows.columns.map((row) => {
    const defaultValue = columnDefault(row, codePage);
    return {
      name: String(row.COLUMN_NAME),
      type: typeOf(row),
      nullable: row.NULLS === "Y",
      isPrimary: typeof row.KEYSEQ === "number" && row.KEYSEQ > 0,
      ...(defaultValue === undefined ? {} : { defaultValue }),
    };
  });

  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const indexSchema = String(row.INDEX_SCHEMA);
    const indexName = String(row.INDEX_NAME);
    const key = `${indexSchema}\0${indexName}`;
    const index = byIndex.get(key) ?? {
      name: indexSchema === schema ? indexName : `${indexSchema}.${indexName}`,
      columns: [],
      unique: row.UNIQUERULE === "U" || row.UNIQUERULE === "P",
    };
    index.columns.push(String(row.COLUMN_NAME));
    byIndex.set(key, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: String(row.COLUMN_NAME),
    referencedTable:
      row.REF_SCHEMA === schema ? String(row.REF_TABLE) : `${String(row.REF_SCHEMA)}.${String(row.REF_TABLE)}`,
    referencedColumn: String(row.REF_COLUMN),
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

// ============================================================================
// Source
// ============================================================================

/**
 * How many bytes of a definition one `HEX(...)` can carry: HEX doubles the bytes and a VARCHAR
 * holds 32672, so 16336. Two chunks read 32672 bytes, the most this provider shows.
 */
export const SOURCE_CHUNK_BYTES = 16336;
export const SOURCE_BYTE_LIMIT = SOURCE_CHUNK_BYTES * 2;

/**
 * The two statements that read one definition: the head reads its first chunk and its byte
 * length (and whatever else the kind needs), the tail its second chunk, run only when the
 * definition is longer than one chunk.
 *
 * TWO STATEMENTS AND NOT ONE, so that a definition shorter than one chunk, which is nearly every
 * definition, does not carry a second chunk of 16336 padding blanks over the wire. db2-node 1.0.22
 * also failed a row carrying both 32672-character chunks with "Protocol error: invalid DSS magic
 * byte" (K21); 1.0.24 reads such a row, measured on 12.1.0.0, so that is no longer the reason.
 */
export interface SourceStatements {
  readonly head: string;
  readonly tail: string;
}

function chunk(column: string, start: number): string {
  return `HEX(VARCHAR(SUBSTRING(${column}, ${start}, ${SOURCE_CHUNK_BYTES}, OCTETS), ${SOURCE_CHUNK_BYTES})) AS TEXT_BYTES`;
}

function sourceStatements(column: string, from: string, extra = ""): SourceStatements {
  return {
    head: `SELECT ${chunk(column, 1)}, LENGTH(${column}) AS TEXT_LENGTH${extra}\n${from}`,
    tail: `SELECT ${chunk(column, SOURCE_CHUNK_BYTES + 1)}\n${from}`,
  };
}

/** A view's or a materialized query table's definition; binds schema, name and type (V or S). */
export const VIEW_SOURCE = sourceStatements(
  "v.TEXT",
  `FROM SYSCAT.VIEWS v
JOIN SYSCAT.TABLES t ON t.TABSCHEMA = v.VIEWSCHEMA AND t.TABNAME = v.VIEWNAME
WHERE v.VIEWSCHEMA = ? AND v.VIEWNAME = ? AND t.TYPE = ?`,
);

/** A schema-level routine's definition by specific name; binds schema, specific name, type. */
export const ROUTINE_SOURCE = sourceStatements(
  "TEXT",
  `FROM SYSCAT.ROUTINES
WHERE ROUTINESCHEMA = ? AND SPECIFICNAME = ? AND ROUTINETYPE = ? AND ROUTINEMODULENAME IS NULL`,
  ", RTRIM(ORIGIN) AS ORIGIN",
);

/** A trigger on a table in its own schema; binds schema, table, trigger. */
export const TABLE_TRIGGER_SOURCE = sourceStatements(
  "TEXT",
  `FROM SYSCAT.TRIGGERS
WHERE TRIGSCHEMA = ? AND TABSCHEMA = TRIGSCHEMA AND TABNAME = ? AND TRIGNAME = ?`,
);

/** A trigger on a table in another schema; binds schema, trigger. */
export const SCHEMA_TRIGGER_SOURCE = sourceStatements(
  "TEXT",
  `FROM SYSCAT.TRIGGERS
WHERE TRIGSCHEMA = ? AND TRIGNAME = ? AND TABSCHEMA <> TRIGSCHEMA`,
);

/** A driver answer this file does not understand, raised rather than read as a missing definition. */
function unreadableDefinition(row: Record<string, unknown>): QueryError {
  return new QueryError(
    `Db2 answered a definition as ${typeof row.TEXT_BYTES} with a length of ${String(row.TEXT_LENGTH)}, which is ` +
      "not the hex text and byte length this provider reads",
    "db2",
  );
}

/**
 * The byte length of the definition a head row read, or null when the catalog holds none (`TEXT`
 * is NULL, so both columns are). Any other shape raises.
 */
export function sourceLength(row: Record<string, unknown>): number | null {
  if (row.TEXT_LENGTH === null && row.TEXT_BYTES === null) return null;
  if (typeof row.TEXT_LENGTH !== "number" || typeof row.TEXT_BYTES !== "string") throw unreadableDefinition(row);
  return row.TEXT_LENGTH;
}

/**
 * A definition's text from its chunk rows, cut to the bytes it really has, which drops the blanks
 * SUBSTRING padded a short chunk with.
 */
export function sourceText(chunks: readonly Record<string, unknown>[], length: number, codePage: number): string {
  const hex = chunks
    .map((row) => {
      if (typeof row.TEXT_BYTES !== "string") throw unreadableDefinition(row);
      return row.TEXT_BYTES;
    })
    .join("");
  return decodeCatalogHex(hex, codePage, Math.min(length, SOURCE_BYTE_LIMIT));
}

// ============================================================================
// The two column sources
// ============================================================================

/** `SYSCAT.COLUMNS`, read on every handle but an agent profile's: the declared type whole. */
export const SYSCAT_COLUMNS: ColumnSource = Object.freeze({
  object: OBJECT_COLUMNS_SQL,
  bulk: (bounded: boolean) => bulkDetailSql(bounded).columns,
  type: columnType,
  describesDecfloat: false,
});

/** The value-free source an agent profile reads, with the two limits `valueFreeColumnType` names. */
export const VALUE_FREE_COLUMNS: ColumnSource = Object.freeze({
  object: OBJECT_VALUE_FREE_COLUMNS_SQL,
  bulk: bulkValueFreeColumnsSql,
  type: valueFreeColumnType,
  describesDecfloat: true,
});
