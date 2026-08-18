import type { DatabaseType } from "@/lib/types";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { cellOf, resolveColumns, toCsv } from "./csv";
import { jsonText } from "./json";

/**
 * Turning a result grid into a file the user keeps.
 *
 * The standalone shell (`src/components/Studio.tsx`) and the embeddable one
 * (`src/workspace/StudioWorkspace.tsx`) each carried their own copy of this, and the
 * copies had already drifted — different tab-name regexes, and only one of them
 * masking. Everything the two genuinely disagree about (which rows, under which
 * masking) is decided by the caller and arrives here as `rows`.
 */

export type ResultExportFormat = "csv" | "json" | "sql-insert" | "sql-ddl";

export interface ResultExportSource {
  /** The rows to write, already masked if the caller masks. */
  rows: readonly Record<string, unknown>[];
  /** The columns the engine declared for this result (`QueryResult.fields`). */
  fields: readonly string[];
  /** The tab the result is showing in; where the SQL forms get their table name. */
  tabName: string;
  /** The connected engine, whose literal and identifier grammars the SQL forms use. */
  dialect: DatabaseType | undefined;
  /**
   * The type each column was declared with, spelled the way the engine spells it
   * (`QueryResult.columnTypes`). Absent when the source declared none, which is the
   * common case — then the DDL form infers a type from a value instead.
   */
  columnTypes?: Record<string, string>;
}

export interface ResultExportFile {
  content: string;
  mimeType: string;
  extension: string;
}

/** The table name used when the tab's own name cannot safely be one. */
export const FALLBACK_TABLE_NAME = "table_name";

/**
 * The prefix `use-tab-manager` puts on a generated tab name — `Query 1`, `Query: users`.
 *
 * The separator is REQUIRED (a lookahead, so it is not consumed): stripping a bare
 * `Query` turned a tab renamed after a real table into a different table, and an
 * export from a tab named `QueryLog` wrote `INSERT INTO Log`.
 */
const GENERATED_TAB_PREFIX = /^Query(?=$|[\s:])[\s:]*/;

/** What a SQL export writes when there is nothing to describe. */
const NOTHING_TO_EXPORT = {
  rows: "-- No rows to export.",
  columns: "-- No columns to export.",
} as const;

/**
 * The table name the SQL exports write, derived from the tab's title.
 *
 * Interpolated into the statement UNQUOTED, and that is deliberate: this name was
 * guessed, not read from the engine, so quoting it would pin a case the database
 * may not use (`src/lib/sql/identifier.ts`). What a guess must not do is carry
 * statement text, so anything that is not a bare — optionally dotted — identifier is
 * refused outright rather than escaped. A tab named `users; DROP TABLE secrets`
 * previously reached the file verbatim, in a file whose whole purpose is to be run
 * somewhere else, unattended (#290's threat model).
 */
export function deriveTableName(tabName: string): string {
  const candidate = tabName.replace(GENERATED_TAB_PREFIX, "").trim();
  return isBareIdentifier(candidate) ? candidate : FALLBACK_TABLE_NAME;
}

/** The first value any row carries for `column`, or `undefined` if none does. */
function firstSample(rows: readonly Record<string, unknown>[], column: string): unknown {
  for (const row of rows) {
    const value = cellOf(row, column);
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** The kinds of column a value can be inferred to be, before a dialect spells them. */
type InferredKind = "text" | "integer" | "numeric" | "boolean" | "timestamp";

/**
 * How each dialect spells the inferred kinds.
 *
 * The generic set is not portable, and the statement is meant to be run against the
 * engine it was read from: Oracle has no `TEXT` and no `BOOLEAN` before 23c, SQL
 * Server has no `BOOLEAN` at all, and a bare `NUMERIC` on MySQL is `DECIMAL(10,0)` —
 * which silently truncates every decimal it was chosen for. Only the dialects that
 * disagree with the standard spelling appear here; the rest fall through to it,
 * including SQLite, whose column types are advisory affinities anyway.
 */
const STANDARD_TYPES: Record<InferredKind, string> = {
  text: "TEXT",
  integer: "BIGINT",
  numeric: "DOUBLE PRECISION",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMP",
};

const DIALECT_TYPES: Partial<Record<DatabaseType, Partial<Record<InferredKind, string>>>> = {
  mysql: { numeric: "DOUBLE", timestamp: "DATETIME" },
  oracle: {
    text: "VARCHAR2(4000)",
    integer: "NUMBER(19)",
    numeric: "BINARY_DOUBLE",
    boolean: "NUMBER(1)",
  },
  mssql: {
    text: "NVARCHAR(MAX)",
    numeric: "FLOAT",
    boolean: "BIT",
    timestamp: "DATETIME2",
  },
};

/**
 * The shape a declared type has to have before it is written into the statement.
 *
 * A declared type is engine output — or, through the embeddable shell, whatever the
 * host put in `columnTypes` — so it is data until it has been checked, in a file whose
 * whole purpose is to be run somewhere else unattended (#290). Letters, digits,
 * underscores, spaces, commas and parentheses cover every real spelling
 * (`Nullable(Int64)`, `DECIMAL(10, 2)`, `TIMESTAMP WITH TIME ZONE`) and exclude every
 * character that could end the definition list it sits in.
 */
const PLAUSIBLE_TYPE = /^[A-Za-z][A-Za-z0-9_(), ]*$/;

/** A column's kind, inferred from a value. */
function inferKind(sample: unknown): InferredKind {
  if (typeof sample === "bigint") return "integer";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "numeric";
  if (typeof sample === "boolean") return "boolean";
  if (sample instanceof Date) return "timestamp";
  return "text";
}

/**
 * A column's declared type for the CREATE TABLE.
 *
 * What the engine declared, when it declared anything plausible: that is the type of
 * THIS result, which is the only source for a computed column or an ad-hoc
 * projection, and it is already spelled the way the engine spells it.
 *
 * Otherwise inferred from the first row that carries a value rather than from row 0:
 * a column that happens to be NULL in the first row was typed `TEXT` regardless of
 * what the other ten thousand rows hold.
 */
function sqlTypeOf(column: string, rows: readonly Record<string, unknown>[], source: ResultExportSource): string {
  const declared = source.columnTypes;
  if (declared !== undefined && Object.hasOwn(declared, column) && PLAUSIBLE_TYPE.test(declared[column])) {
    return declared[column];
  }
  const kind = inferKind(firstSample(rows, column));
  return DIALECT_TYPES[source.dialect as DatabaseType]?.[kind] ?? STANDARD_TYPES[kind];
}

/**
 * A value as SQL.
 *
 * Everything that is not a number, a bigint or a boolean is quoted through the
 * dialect's own literal grammar, which is what keeps a value ending in a backslash
 * from closing its literal and having the rest of the file read as statements
 * (#290). The two conversions before that quoting matter as much: a `Date` used to
 * be stringified to a locale-dependent form no engine parses back, and an object to
 * the literal text `[object Object]`.
 */
function sqlValue(value: unknown, dialect: DatabaseType | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return String(value);
  // NaN and ±Infinity are not numbers any of these dialects accepts as a literal,
  // and `String(NaN)` would put the bare word `NaN` where a value belongs.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return quoteLiteral(value.toISOString(), dialect);
  // `jsonText`, not `JSON.stringify`: a bigint or a cycle inside the value would
  // otherwise throw out of the click handler and produce no file at all.
  if (typeof value === "object") return quoteLiteral(jsonText(value), dialect);
  return quoteLiteral(String(value), dialect);
}

/** Build the file for `format`. The caller owns naming it and handing it to the browser. */
export function buildResultExport(format: ResultExportFormat, source: ResultExportSource): ResultExportFile {
  const { rows, dialect } = source;
  const columns = resolveColumns(rows, source.fields);

  if (format === "json") {
    return { content: jsonText(rows, 2), mimeType: "application/json", extension: "json" };
  }

  if (format === "csv") {
    // The charset is stated even though the download layer's byte order mark is what
    // Excel actually reads, because every other consumer reads the type.
    return { content: toCsv(rows, columns), mimeType: "text/csv;charset=utf-8", extension: "csv" };
  }

  const sql = (content: string): ResultExportFile => ({ content, mimeType: "text/sql", extension: "sql" });
  // A statement with no column list parses nowhere: `CREATE TABLE t ()` and
  // `INSERT INTO t () VALUES ()` are both errors, and a 0-byte file says nothing
  // about why it is empty. A comment is valid SQL in every dialect here.
  if (columns.length === 0) return sql(NOTHING_TO_EXPORT.columns);

  const tableName = deriveTableName(source.tabName);
  // A result field IS a name read from the engine, so quoting it is exactly right —
  // and it is the only thing standing between an aliased column (`count(*) AS "n, m"`)
  // and a statement that no longer parses.
  const quotedColumns = columns.map((column) => quoteIdentifier(column, dialect));

  if (format === "sql-insert") {
    if (rows.length === 0) return sql(NOTHING_TO_EXPORT.rows);
    const statements = rows.map((row) => {
      const values = columns.map((column) => sqlValue(cellOf(row, column), dialect));
      return `INSERT INTO ${tableName} (${quotedColumns.join(", ")}) VALUES (${values.join(", ")});`;
    });
    return sql(statements.join("\n"));
  }

  const definitions = columns.map((column, index) => `  ${quotedColumns[index]} ${sqlTypeOf(column, rows, source)}`);
  return sql(`CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`);
}
