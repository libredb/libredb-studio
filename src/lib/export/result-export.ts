import type { DatabaseType } from "@/lib/types";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { asBytes } from "./binary";
import { cellOf, resolveColumns, toCsv, type CsvDelimiter } from "./csv";
import { htmlTable } from "./html";
import { binaryCellsAsHex, jsonText } from "./json";
import { markdownTable } from "./markdown";
import { resolveUpdateTarget } from "@/lib/sql/update-target";
import { sqlWritingFor } from "@/lib/db/sql-writing";
import type { ColumnWriter, ExportSpec, ExportTypeVocabulary, InferredKind } from "@/lib/db/sql-writing/types";
import { typedLiteral, UnwritableValue } from "./typed-literals";
import { isNonFiniteWord, nonFiniteWord, type NonFiniteWord } from "@/lib/non-finite";

/**
 * Turning a result grid into a file the user keeps.
 *
 * The standalone shell (`src/components/Studio.tsx`) and the embeddable one
 * (`src/workspace/StudioWorkspace.tsx`) each carried their own copy of this, and the
 * copies had already drifted — different tab-name regexes, and only one of them
 * masking. Everything the two genuinely disagree about (which rows, under which
 * masking) is decided by the caller and arrives here as `rows`.
 */

export type ResultExportFormat = "csv" | "json" | "sql-insert" | "sql-ddl" | "markdown" | "html";

export interface ResultExportSource {
  /** The rows to write, already masked if the caller masks. */
  rows: readonly Record<string, unknown>[];
  /** The columns the engine declared for this result (`QueryResult.fields`). */
  fields: readonly string[];
  /** The tab the result is showing in; where the SQL forms get their table name. */
  tabName: string;
  /**
   * The statement that produced the rows, when they are the tab's own. A SELECT reading
   * exactly one table names that table for the SQL forms, ahead of the tab's title.
   */
  query?: string;
  /** The connected engine, whose literal and identifier grammars the SQL forms use. */
  dialect: DatabaseType | undefined;
  /**
   * The type each column was declared with, spelled the way the engine spells it
   * (`QueryResult.columnTypes`). Absent when the source declared none, which is the
   * common case — then the DDL form infers a type from a value instead.
   */
  columnTypes?: Record<string, string>;
  /** CSV separator; omitted for the backward-compatible comma default. */
  csvDelimiter?: CsvDelimiter;
}

export interface ResultExportFile {
  content: string;
  mimeType: string;
  extension: string;
}

/** The table name used when the tab's own name cannot safely be one. */
export const FALLBACK_TABLE_NAME = "table_name";

/** What the file is called when the rows on screen are the tab's own. */
const USER_EXPORT_STEM = "query_result_export";
/** How much of a run id the file name carries, so a long id cannot dominate it. */
const MAX_RUN_ID_CHARS = 64;
/** Everything a file name may not carry, collapsed to a single separator. */
const UNNAMEABLE = /[^A-Za-z0-9_]+/g;

/**
 * What an export is saved as.
 *
 * A run's rows are named after the RUN, not after the tab they were read in (B34):
 * these files leave the product, and one carrying an agent's rows that is
 * indistinguishable from one the user ran is a file nobody can attribute later. The
 * id is reduced to characters a file name can hold — it reaches a path, so a `/` or a
 * `..` in it is not a naming problem — and an id that survives that as nothing at all
 * still leaves the attribution behind, because "an agent run produced this" is the
 * part that matters.
 */
export function resultExportFileName(extension: string, runId?: string): string {
  if (runId === undefined) return `${USER_EXPORT_STEM}.${extension}`;
  const safe = runId
    .replace(UNNAMEABLE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_RUN_ID_CHARS);
  return safe === "" ? `agent_run_export.${extension}` : `agent_run_${safe}_export.${extension}`;
}

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

/**
 * The shape a declared type has to have before it is written into the statement.
 *
 * A declared type is engine output — or, through the embeddable shell, whatever the
 * host put in `columnTypes` — so it is data until it has been checked, in a file whose
 * whole purpose is to be run somewhere else unattended (#290). Letters, digits,
 * underscores, spaces, commas and parentheses cover most real spellings
 * (`Nullable(Int64)`, `DECIMAL(10, 2)`, `TIMESTAMP WITH TIME ZONE`) and exclude every
 * character that could end the definition list it sits in.
 *
 * More shapes are real and were written as `TEXT` before #1386, which lost the type the
 * INSERT beside it needs: an array suffix (Postgres `integer[]`, DuckDB `INTEGER[3]` and
 * `MAP(INTEGER, VARCHAR[])`), a single-quoted argument (ClickHouse `DateTime64(3,
 * 'Europe/Istanbul')`, `Enum8('a' = 1)`), a double-quoted field name (DuckDB `STRUCT("a"
 * INTEGER)`), angle brackets (CQL `map<text, int>`), and the `=` and negative numbers an
 * enum's arguments hold. A quoted run may not contain its quote, a backslash or a line
 * break, so it cannot close early in any dialect, and a `-` must be followed by a digit,
 * so `--` cannot start a comment.
 */
const PLAUSIBLE_TYPE = /^[A-Za-z](?:[A-Za-z0-9_(), =<>]|\[\d*\]|-(?=\d)|'[^'\\\r\n]*'|"[^"\\\r\n]*")*$/;

/**
 * `PLAUSIBLE_TYPE`, plus parentheses that balance outside the quoted arguments.
 *
 * The character class alone admits `int) SELECT load_file('/etc/passwd') AS b, (c int`,
 * which closes the column list it sits in and opens a new one, so a host-supplied
 * `columnTypes` value could turn the CREATE TABLE into a CREATE TABLE ... AS SELECT. Every
 * real spelling nests: the depth never drops below zero and ends at zero.
 */
function isPlausibleType(declared: string): boolean {
  if (!PLAUSIBLE_TYPE.test(declared)) return false;
  // The angle brackets of a CQL `map<text, int>` are held to the same rule, so neither
  // pair can close a list the other opened.
  const unquoted = declared.replace(/'[^']*'|"[^"]*"/g, "");
  return balanced(unquoted, "(", ")") && balanced(unquoted, "<", ">");
}

/** `open` and `close` nest in `text`: the depth never drops below zero and ends at zero. */
function balanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === open) depth++;
    else if (char === close && --depth < 0) return false;
  }
  return depth === 0;
}

/** A column's kind, inferred from a value. */
function inferKind(sample: unknown): InferredKind {
  if (typeof sample === "bigint") return "integer";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "numeric";
  if (typeof sample === "boolean") return "boolean";
  if (sample instanceof Date) return "timestamp";
  // Before the text fallback, because a binary value IS an object and fell through to
  // it: a `bytea` column was recreated as `TEXT`, so the INSERT this same export
  // writes had nowhere to be replayed into.
  if (asBytes(sample) !== undefined) return "binary";
  return "text";
}

/**
 * A declared type, spelled so the target dialect can parse it without narrowing it.
 *
 * The target dialect is the ACTIVE connection's, not necessarily the one that declared
 * the type: both shells pass `conn.activeConnection?.type` beside the tab's own result
 * (`src/components/Studio.tsx`, `src/workspace/StudioWorkspace.tsx`), so running a
 * query on Oracle, switching connections and then exporting hands this module Oracle's
 * `VARCHAR2` and `BINARY_DOUBLE` under Postgres's dialect. Written verbatim those are
 * not types Postgres has, and the whole point of an exported file is that it replays
 * (#422) — so a bare name the target does not stand behind is re-spelled from its
 * family rather than kept. The family, not the value: a column that is NULL in every
 * exported row still declares `VARCHAR2`, where a value-shaped guess has nothing to
 * look at.
 *
 * A type that already carries its parameters is left exactly as it is. It is the
 * whole spelling the engine gave, `DECIMAL(10, 2)` and `Nullable(Int64)` included,
 * and there is nothing missing from it to complete. Only the four node drivers hand
 * over a parameterless name, and all four are covered by the `export` field's
 * `typeVocabulary.bareTypeFamily`; a parameterized type
 * from a FOREIGN dialect (`NUMBER(10,2)` under Postgres) still goes through verbatim,
 * which is what it did before and is a translation problem rather than this one.
 */
function completeDeclaredType(declared: string, exportSpec: ExportSpec): string {
  // Only a type the rewrite changed skips the completion below; a bare name it leaves alone
  // is still completed like any other.
  const rewritten = exportSpec.rewriteDeclared?.(declared);
  if (rewritten !== undefined && rewritten !== declared.trim()) return rewritten;
  if (declared.includes("(")) return declared;
  const respelled = exportSpec.bareSpelling;
  // The element type of an array is re-spelled the same way: a Postgres `bit[]` holds the
  // same `1010` text per element that a bare `bit` refuses.
  const [, name, dimensions] = /^(.*?)((?:\[\])*)$/.exec(declared.trim().toLowerCase()) as RegExpExecArray;
  if (Object.hasOwn(respelled, name)) return `${respelled[name]}${dimensions}`;
  // No dialect at all is not an unknown dialect: it means the file names no engine, so
  // there is nothing standing behind ANY private spelling and the portable name is the
  // only defensible one. It is also what this same export's value-shaped path already
  // writes there, and what it wrote for a declared type before the measured `standsAlone`
  // lists of the `export` field existed.
  const standsAlone = exportSpec.standsAlone;
  // `TIMESTAMP WITH TIME ZONE` from Oracle and `timestamp with time zone` from
  // Postgres are the same name, and a declared type is engine output rather than
  // something typed here, so neither the case nor the run of spaces is load-bearing.
  const bare = declared.trim().toLowerCase().replace(/\s+/g, " ");
  if (standsAlone.includes(bare)) return declared;
  // `Object.hasOwn`, not a plain lookup: a column declared `constructor` would
  // otherwise read `Object.prototype.constructor` as its family and, being a function
  // rather than a kind, put the literal `undefined` where the type belongs.
  const family = exportSpec.typeVocabulary.bareTypeFamily;
  if (!Object.hasOwn(family, bare)) return declared;
  return exportSpec.ddlTypes[family[bare]];
}

/**
 * A column's declared type for the CREATE TABLE.
 *
 * What the engine declared, when it declared anything plausible: that is the type of
 * THIS result, which is the only source for a computed column or an ad-hoc
 * projection, and it is already spelled the way the engine spells it — completed
 * first, because the spelling the engine uses for a column is not always one that
 * dialect will take back in a CREATE TABLE (`completeDeclaredType` above). An engine
 * whose `export` field declares a column from its first sample (`declareFromSample`)
 * answers ahead of that completion.
 *
 * Otherwise inferred from the first row that carries a value rather than from row 0:
 * a column that happens to be NULL in the first row was typed `TEXT` regardless of
 * what the other ten thousand rows hold.
 */
function sqlTypeOf(
  column: string,
  rows: readonly Record<string, unknown>[],
  source: ResultExportSource,
  exportSpec: ExportSpec,
): string {
  const declared = source.columnTypes;
  if (declared !== undefined && Object.hasOwn(declared, column) && isPlausibleType(declared[column])) {
    if (exportSpec.declareFromSample !== undefined) {
      const fromSample = exportSpec.declareFromSample(declared[column], firstSample(rows, column));
      if (fromSample !== undefined) return fromSample;
    }
    return completeDeclaredType(declared[column], exportSpec);
  }
  return exportSpec.ddlTypes[inferKind(firstSample(rows, column))];
}

/** What `source` declared for `column`, or `undefined`. */
function declaredTypeOf(source: ResultExportSource, column: string): string | undefined {
  // `Object.hasOwn` for the reason `sqlTypeOf` uses it: a column named `constructor`
  // would otherwise read `Object.prototype.constructor` as its declared type.
  const declared = source.columnTypes;
  return declared !== undefined && Object.hasOwn(declared, column) ? declared[column] : undefined;
}

/** NaN or an infinity as the engine reads it back into a float column (the `export` field's `nonFinite`). */
function nonFiniteLiteral(word: NonFiniteWord, exportSpec: ExportSpec): string {
  return exportSpec.nonFinite[word];
}

/** `columnTypes` is the host's data until checked, so a declared type is tested only as a string. */
function isFloatColumn(declared: unknown, vocabulary: ExportTypeVocabulary): boolean {
  return typeof declared === "string" && vocabulary.floatType.test(declared.trim());
}

/**
 * A declared type that holds numbers, through the wrappers that change nothing about that.
 * Used only by the CSV writer, which lets `-Infinity` through its formula guard in a
 * numeric column (`toCsv`).
 */
function isNumericColumn(declared: unknown, vocabulary: ExportTypeVocabulary): boolean {
  if (typeof declared !== "string") return false;
  let type = declared;
  for (let match = vocabulary.numericWrapper.exec(type); match !== null; match = vocabulary.numericWrapper.exec(type)) {
    type = match[1];
  }
  return isFloatColumn(type, vocabulary) || vocabulary.exactNumericType.test(type.trim());
}

/**
 * A value as SQL.
 *
 * Everything that is not a number, a bigint or a boolean is quoted through the
 * dialect's own literal grammar, which is what keeps a value ending in a backslash
 * from closing its literal and having the rest of the file read as statements
 * (#290). The two conversions before that quoting matter as much: a `Date` used to
 * be stringified to a locale-dependent form no engine parses back, and an object to
 * the literal text `[object Object]`. A column writer from the `export` field's
 * `columnWriters` answers for its column's cells before the binary and quoting
 * branches.
 */
function sqlValue(
  value: unknown,
  dialect: DatabaseType | undefined,
  exportSpec: ExportSpec,
  writer?: ColumnWriter,
  floatColumn = false,
): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") {
    const word = nonFiniteWord(value);
    return word === undefined ? String(value) : nonFiniteLiteral(word, exportSpec);
  }
  // A cell that crossed HTTP carries the word as a string, which is only a float when the
  // column was declared one: a text column may hold the word itself.
  if (floatColumn && isNonFiniteWord(value)) return nonFiniteLiteral(value, exportSpec);
  if (typeof value === "boolean") return String(value);
  const written = writer?.(value);
  if (written !== undefined) return written;
  if (value instanceof Date) return quoteLiteral(value.toISOString(), dialect);
  // Before the object branch, which used to write a `bytea`/`BLOB` cell as the quoted
  // text `{"type":"Buffer","data":[…]}`. Replayed into Postgres 18.4 that INSERT
  // stored 46 bytes of that JSON where six bytes belonged, and it stored them
  // successfully — bytea's escape input format accepts the text, so nothing failed.
  const bytes = asBytes(value);
  if (bytes !== undefined) return exportSpec.binaryLiteral(bytes);
  // `jsonText`, not `JSON.stringify`: a bigint or a cycle inside the value would
  // otherwise throw out of the click handler and produce no file at all.
  if (typeof value === "object") return quoteLiteral(jsonText(value), dialect);
  return quoteLiteral(String(value), dialect);
}

/**
 * The comment that stands where a row's INSERT would be, when one of its cells has no
 * literal in the dialect (#1386). One refused statement stops the whole file on replay, so
 * the row is skipped and named instead. The column name is engine output, so it is written
 * as JSON with everything outside printable ASCII replaced: a line break in it would end
 * the comment and put the rest of the name in the file as a statement. What the cell holds
 * can carry engine output too (a Databend type is the server's own text), so it gets the
 * same replacement.
 */
function skippedRow(rowIndex: number, column: string, what: string, dialect: DatabaseType | undefined): string {
  const name = JSON.stringify(column).replace(/[^\x20-\x7e]/g, "?");
  const held = what.replace(/[^\x20-\x7e]/g, "?");
  return `-- Row ${rowIndex + 1} skipped: column ${name} holds ${held}, which ${dialect ?? "this dialect"} has no literal for.`;
}

/**
 * The table the SQL forms write to: the one table the producing SELECT reads, when there is
 * exactly one (`resolveUpdateTarget`, the same reader inline editing trusts with a write),
 * and otherwise the tab's title. Either way only a bare, optionally dotted, identifier is
 * accepted, for the reason `deriveTableName` gives.
 */
function exportTableName(source: ResultExportSource): string {
  if (source.query !== undefined) {
    const target = resolveUpdateTarget(source.query, source.dialect);
    if (target.kind === "table" && isBareIdentifier(target.table)) return target.table;
  }
  return deriveTableName(source.tabName);
}

/** Build the file for `format`. The caller owns naming it and handing it to the browser. */
export function buildResultExport(format: ResultExportFormat, source: ResultExportSource): ResultExportFile {
  const { rows, dialect } = source;
  const exportSpec = sqlWritingFor(dialect).export;
  const vocabulary = exportSpec.typeVocabulary;
  const columns = resolveColumns(rows, source.fields);

  if (format === "markdown") {
    return { content: markdownTable(rows, columns), mimeType: "text/markdown;charset=utf-8", extension: "md" };
  }

  if (format === "html") {
    return { content: htmlTable(rows, columns), mimeType: "text/html;charset=utf-8", extension: "html" };
  }

  if (format === "json") {
    return { content: jsonText(rows.map(binaryCellsAsHex), 2), mimeType: "application/json", extension: "json" };
  }

  if (format === "csv") {
    // The charset is stated even though the download layer's byte order mark is what
    // Excel actually reads, because every other consumer reads the type.
    const numericColumns = new Set(
      columns.filter((column) => isNumericColumn(declaredTypeOf(source, column), vocabulary)),
    );
    return {
      content: toCsv(rows, columns, source.csvDelimiter, numericColumns),
      mimeType: "text/csv;charset=utf-8",
      extension: "csv",
    };
  }

  const sql = (content: string): ResultExportFile => ({ content, mimeType: "text/sql", extension: "sql" });
  // A statement with no column list parses nowhere: `CREATE TABLE t ()` and
  // `INSERT INTO t () VALUES ()` are both errors, and a 0-byte file says nothing
  // about why it is empty. A comment is valid SQL in every dialect here.
  if (columns.length === 0) return sql(NOTHING_TO_EXPORT.columns);

  const tableName = exportTableName(source);
  // A result field IS a name read from the engine, so quoting it is exactly right —
  // and it is the only thing standing between an aliased column (`count(*) AS "n, m"`)
  // and a statement that no longer parses.
  const quotedColumns = columns.map((column) => quoteIdentifier(column, dialect));

  if (format === "sql-insert") {
    if (rows.length === 0) return sql(NOTHING_TO_EXPORT.rows);
    // Resolved once per column rather than per cell: the shape comes from the declared
    // type, which does not change row to row.
    const declaredTypes = columns.map((column) => declaredTypeOf(source, column));
    const writers = exportSpec.columnWriters?.(declaredTypes);
    const floatColumns = declaredTypes.map((declared) => isFloatColumn(declared, vocabulary));
    const scalar = (value: unknown) => sqlValue(value, dialect, exportSpec);
    const statements = rows.map((row, rowIndex) => {
      const values: string[] = [];
      for (const [index, column] of columns.entries()) {
        const cell = cellOf(row, column);
        try {
          // The cells whose literal depends on the declared type first (#1386): an array,
          // an interval, a map, a BIT. Everything else is written as it always was.
          values.push(
            typedLiteral(cell, declaredTypes[index], dialect, scalar) ??
              sqlValue(cell, dialect, exportSpec, writers?.[index], floatColumns[index]),
          );
        } catch (error) {
          if (!(error instanceof UnwritableValue)) throw error;
          return skippedRow(rowIndex, column, error.message, dialect);
        }
      }
      if (exportSpec.insertForm === "select") {
        return `INSERT INTO ${tableName} (${quotedColumns.join(", ")}) SELECT ${values.join(", ")};`;
      }
      return `INSERT INTO ${tableName} (${quotedColumns.join(", ")}) VALUES (${values.join(", ")});`;
    });
    return sql(statements.join("\n"));
  }

  const definitions = columns.map(
    (column, index) => `  ${quotedColumns[index]} ${sqlTypeOf(column, rows, source, exportSpec)}`,
  );
  // An engine whose CREATE TABLE cannot run without a key the result cannot supply names
  // one in the `export` field's `createTableKey`, with the note that says so above the
  // statement, rather than in the column list, so it survives being read on its own.
  const key = exportSpec.createTableKey;
  if (key !== undefined) {
    definitions.push(`  ${key.clause(quotedColumns)}`);
    return sql(`${key.note}CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`);
  }
  return sql(`CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`);
}
