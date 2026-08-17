import type { DatabaseType } from "@/lib/types";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { resolveColumns, toCsv } from "./csv";

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
}

export interface ResultExportFile {
  content: string;
  mimeType: string;
  extension: string;
}

/** The table name used when the tab's own name cannot safely be one. */
export const FALLBACK_TABLE_NAME = "table_name";

/** The prefix `use-tab-manager` puts on a generated tab name. */
const GENERATED_TAB_PREFIX = /^Query[\s:]*/;

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
    const value = row[column];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * A column's declared type, inferred from a value.
 *
 * Read from the first row that carries a value rather than from row 0: a column that
 * happens to be NULL in the first row was typed `TEXT` regardless of what the other
 * ten thousand rows hold.
 */
function sqlTypeOf(sample: unknown): string {
  if (typeof sample === "bigint") return "INTEGER";
  if (typeof sample === "number") return Number.isInteger(sample) ? "INTEGER" : "NUMERIC";
  if (typeof sample === "boolean") return "BOOLEAN";
  if (sample instanceof Date) return "TIMESTAMP";
  return "TEXT";
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
  if (typeof value === "object") return quoteLiteral(JSON.stringify(value), dialect);
  return quoteLiteral(String(value), dialect);
}

/** Build the file for `format`. The caller owns naming it and handing it to the browser. */
export function buildResultExport(format: ResultExportFormat, source: ResultExportSource): ResultExportFile {
  const { rows, dialect } = source;
  const columns = resolveColumns(rows, source.fields);

  if (format === "json") {
    return { content: JSON.stringify(rows, null, 2), mimeType: "application/json", extension: "json" };
  }

  if (format === "csv") {
    return { content: toCsv(rows, columns), mimeType: "text/csv", extension: "csv" };
  }

  const tableName = deriveTableName(source.tabName);
  // A result field IS a name read from the engine, so quoting it is exactly right —
  // and it is the only thing standing between an aliased column (`count(*) AS "n, m"`)
  // and a statement that no longer parses.
  const quotedColumns = columns.map((column) => quoteIdentifier(column, dialect));

  if (format === "sql-insert") {
    const statements = rows.map((row) => {
      const values = columns.map((column) => sqlValue(row[column], dialect));
      return `INSERT INTO ${tableName} (${quotedColumns.join(", ")}) VALUES (${values.join(", ")});`;
    });
    return { content: statements.join("\n"), mimeType: "text/sql", extension: "sql" };
  }

  const definitions = columns.map(
    (column, index) => `  ${quotedColumns[index]} ${sqlTypeOf(firstSample(rows, column))}`,
  );
  return {
    content: `CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`,
    mimeType: "text/sql",
    extension: "sql",
  };
}
