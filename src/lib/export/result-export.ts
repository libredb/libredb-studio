import type { DatabaseType } from "@/lib/types";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { asBytes, binaryText } from "./binary";
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
 * Written above the Cassandra `CREATE TABLE` only, immediately before the statement.
 *
 * Every line is its own `--` comment closed by a real newline: a CQL line comment
 * that reaches end of file with no trailing newline is left open, so this is never
 * the last thing in the file without one — the statement always follows it.
 */
const CASSANDRA_PRIMARY_KEY_NOTE =
  "-- CQL requires exactly one PRIMARY KEY per table, and a result set carries no key of\n" +
  "-- its own. This export chose the first column as a placeholder: confirm it is unique\n" +
  "-- per row before running this statement.\n";

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
type InferredKind = "text" | "integer" | "numeric" | "boolean" | "timestamp" | "binary";

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
  // `BLOB` is the standard spelling and MySQL, SQLite, Oracle and Cassandra all take
  // it verbatim, so the four that would otherwise need a row here do not get one.
  binary: "BLOB",
};

const DIALECT_TYPES: Partial<Record<DatabaseType, Partial<Record<InferredKind, string>>>> = {
  postgres: { binary: "BYTEA" },
  mysql: { numeric: "DOUBLE", timestamp: "DATETIME" },
  // ClickHouse has no BLOB: its byte container IS `String`, which is a byte sequence
  // and not a text encoding, and `unhex` (the literal below) returns exactly that.
  // Measured on 26.7.1, the other four standard spellings all resolve to a whole type
  // (`TEXT` -> `String`, `BIGINT` -> `Int64`, `DOUBLE PRECISION` -> `Float64`,
  // `TIMESTAMP` -> `DateTime`), so ClickHouse needs no row of its own for them.
  clickhouse: { binary: "String" },
  // `text` is `Unknown type 'text'` on Trino 476 — `VARCHAR` is the unbounded
  // character type, and `DOUBLE PRECISION`, `BIGINT`, `BOOLEAN` and `TIMESTAMP` are
  // all accepted as they are (measured, `DOUBLE PRECISION` is stored as `double`).
  trino: { text: "VARCHAR", binary: "VARBINARY" },
  // CQL has no `DOUBLE PRECISION`: measured on Cassandra 5.0.9, `CREATE TABLE … (c
  // DOUBLE PRECISION)` is `SyntaxException: no viable alternative at input
  // 'PRECISION'`, while `DOUBLE`, `TEXT`, `BIGINT`, `BOOLEAN`, `TIMESTAMP` and `BLOB`
  // are all whole type names.
  cassandra: { numeric: "DOUBLE" },
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
    // `BLOB` is not a T-SQL type name at all, and `IMAGE` has been deprecated since
    // 2005.
    binary: "VARBINARY(MAX)",
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
  // Before the text fallback, because a binary value IS an object and fell through to
  // it: a `bytea` column was recreated as `TEXT`, so the INSERT this same export
  // writes had nowhere to be replayed into.
  if (asBytes(sample) !== undefined) return "binary";
  return "text";
}

/**
 * The family a BARE declared type belongs to, for the names that cannot stand alone.
 *
 * The four biggest providers declare a bare base name — `varchar`, `decimal`,
 * `VARCHAR2`, `nvarchar`, `varbinary` — because a length or a precision cannot be
 * recovered from the wire, and `src/lib/db/providers/sql/column-types.ts` says why it
 * must not be guessed at: a MySQL `varchar(40)` reports `columnLength` 160 under
 * utf8mb4 and 120 under utf8mb3, `mssql` reports 65535 as its sentinel for
 * `varchar(MAX)`, and Oracle reports precision 0 for `COUNT(*)` and scale -127 for
 * `1/3`. So the length is genuinely gone, and a bare name carries exactly as much
 * information as one of the inferred kinds above — which is what this maps it to, so
 * that the dialect tables spell it the same way they spell an inferred column.
 *
 * Measured by replaying the generated `CREATE TABLE` into the engine it was read from:
 *
 *   mysql:  ERROR 1064 … near ',\n  `body` text,'   (the bare `varchar` before it)
 *   oracle: ORA-00906: missing left parenthesis      (the bare VARCHAR2)
 *   mssql:  parses, then INFORMATION_SCHEMA.COLUMNS reports nvarchar length 1,
 *           varchar length 1, varbinary length 1, decimal precision 18 scale 0
 *
 * The silent narrowing is the worst of the three: the file replays and the data is
 * truncated. Two more of the same class were measured and are covered here — `CREATE
 * TABLE t (c decimal)` is `decimal(10,0)` on MySQL and `NUMBER(*,0)` on Oracle, both
 * of which round every decimal the column existed for, and `character` is
 * `character(1)` even on Postgres.
 *
 * Only the four families whose parameters the wire drops are listed. `bit` is measured
 * to narrow to `bit(1)` on Postgres and MySQL and is deliberately NOT here: `pg` hands
 * a bit string back as `"1010"` and `mysql2` hands it back as a Buffer, so the two
 * drivers need different families for the same name, and completing it to one of them
 * would break the INSERT this same export writes for the other.
 */
const BARE_TYPE_FAMILY: Record<string, InferredKind> = {
  "character varying": "text",
  varchar: "text",
  varchar2: "text",
  nvarchar: "text",
  nvarchar2: "text",
  character: "text",
  char: "text",
  nchar: "text",
  text: "text",
  ntext: "text",
  tinytext: "text",
  mediumtext: "text",
  longtext: "text",
  clob: "text",
  nclob: "text",
  enum: "text",
  set: "text",
  uniqueidentifier: "text",
  rowid: "text",
  binary: "binary",
  varbinary: "binary",
  raw: "binary",
  blob: "binary",
  tinyblob: "binary",
  mediumblob: "binary",
  longblob: "binary",
  bytea: "binary",
  image: "binary",
  numeric: "numeric",
  decimal: "numeric",
  number: "numeric",
  binary_double: "numeric",
  binary_float: "numeric",
  money: "numeric",
  timestamp: "timestamp",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  datetime: "timestamp",
  datetime2: "timestamp",
  smalldatetime: "timestamp",
  datetimeoffset: "timestamp",
  year: "integer",
};

/**
 * The bare names each dialect DOES stand behind, so they are written through verbatim.
 *
 * Measured, one `CREATE TABLE probe (c <name>)` per name per engine — Postgres 18.4,
 * MySQL 26.7.0, Oracle Free 23ai, SQL Server 2022 CU26, SQLite through `bun:sqlite`,
 * ClickHouse 26.7.1, Trino 476 and Cassandra 5.0.9 — read back out of `format_type`,
 * `information_schema.COLUMNS.COLUMN_TYPE`, `USER_TAB_COLUMNS`,
 * `INFORMATION_SCHEMA.COLUMNS`, `pragma_table_info`, `system.columns`,
 * `information_schema.columns` and `system_schema.columns`. A name is here only when
 * the engine both accepted it and stored it unnarrowed: `character varying` on
 * Postgres is unbounded, `text` and `longtext` on MySQL are whole types already,
 * `NUMBER` on Oracle is the full 38 digits, ClickHouse resolves every character and
 * byte alias it knows to `String`, Cassandra's `decimal` is arbitrary-precision — and
 * `nvarchar` on SQL Server is NOT here because it came back as length 1.
 *
 * Absences worth naming, because each is a name that LOOKS portable:
 *
 * - MySQL's `varchar`, which MySQL refuses outright, unlike Postgres's.
 * - SQL Server's `timestamp`, which is not a moment in time at all: measured, `CREATE
 *   TABLE t (c timestamp)` on 2022 CU26 creates a `rowversion`, which no INSERT may
 *   name — so keeping a foreign engine's `timestamp` there would produce a file that
 *   parses and then fails on its own INSERT.
 * - Trino's `char` and `decimal`, stored as `char(1)` and `decimal(38,0)`, and
 *   ClickHouse's `decimal`, stored as `Decimal(10, 0)` — the MySQL narrowing again.
 * - ClickHouse's `set`. MySQL's SET is a CHARACTER type; ClickHouse accepts the word
 *   and stores `UInt64`, which is the widest silent mistranslation measured here.
 * - SQLite's `enum`, `uniqueidentifier` and `rowid`. SQLite parses any type name, so
 *   the narrowing is in the AFFINITY: these three match none of its keywords, so the
 *   column is NUMERIC and `INSERT INTO p (c) VALUES ('007')` reads back as the integer
 *   7 (measured), where the same insert into `varchar2` reads back as the text `007`.
 *   `set` is not in SQLite's grammar as a type name at all (`near "set": syntax
 *   error`).
 *
 * Trino is why a bare name cannot simply be re-spelled whenever the target is
 * unmeasured: its own `varchar` is legal AND unbounded, and would have become a `TEXT`
 * it answers `Unknown type 'text'` to.
 *
 * The map is total, for the reason `BINARY_LITERAL` below is: a new provider must not
 * inherit a silently wrong answer. The seven dialects with NO row measured have an
 * empty one — Druid takes no INSERT at all without the MSQ extension, the two search
 * endpoints parse no CREATE TABLE, and the other four declare `queryLanguage: "json"`
 * so no statement is ever built for them to read. Their file is by definition meant to
 * run somewhere else, so every bare name in it is re-spelled portably rather than kept
 * as one engine's private word.
 */
const NOTHING_STANDS_ALONE: readonly string[] = [];

const STANDS_ALONE: Record<DatabaseType, readonly string[]> = {
  postgres: [
    "character varying",
    "varchar",
    "text",
    "bytea",
    "numeric",
    "decimal",
    "money",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
  ],
  mysql: [
    "text",
    "tinytext",
    "mediumtext",
    "longtext",
    "blob",
    "tinyblob",
    "mediumblob",
    "longblob",
    "timestamp",
    "datetime",
    "year",
  ],
  oracle: ["number", "binary_double", "binary_float", "clob", "nclob", "blob", "timestamp", "timestamp with time zone"],
  mssql: [
    "text",
    "ntext",
    "image",
    "money",
    "uniqueidentifier",
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
  ],
  // Every candidate name but the four listed in the note above: SQLite keeps a declared
  // type as the exact string it was given (`pragma_table_info` answers `varchar2` for
  // `varchar2`), so the spelling the source engine used is the one that survives.
  sqlite: [
    "character varying",
    "varchar",
    "varchar2",
    "nvarchar",
    "nvarchar2",
    "character",
    "char",
    "nchar",
    "text",
    "ntext",
    "tinytext",
    "mediumtext",
    "longtext",
    "clob",
    "nclob",
    "binary",
    "varbinary",
    "raw",
    "blob",
    "tinyblob",
    "mediumblob",
    "longblob",
    "bytea",
    "image",
    "numeric",
    "decimal",
    "number",
    "binary_double",
    "binary_float",
    "money",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
    "year",
  ],
  clickhouse: [
    "character varying",
    "varchar",
    "varchar2",
    "nvarchar",
    "character",
    "char",
    "nchar",
    "text",
    "tinytext",
    "mediumtext",
    "longtext",
    "clob",
    "varbinary",
    "blob",
    "tinyblob",
    "mediumblob",
    "longblob",
    "bytea",
    "timestamp",
    "datetime",
    "year",
  ],
  trino: ["varchar", "varbinary", "timestamp", "timestamp without time zone", "timestamp with time zone"],
  cassandra: ["varchar", "text", "blob", "decimal", "timestamp"],
  druid: NOTHING_STANDS_ALONE,
  elasticsearch: NOTHING_STANDS_ALONE,
  opensearch: NOTHING_STANDS_ALONE,
  mongodb: NOTHING_STANDS_ALONE,
  redis: NOTHING_STANDS_ALONE,
  libredb: NOTHING_STANDS_ALONE,
  couchbase: NOTHING_STANDS_ALONE,
};

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
 * over a parameterless name, and all four are covered above; a parameterized type
 * from a FOREIGN dialect (`NUMBER(10,2)` under Postgres) still goes through verbatim,
 * which is what it did before and is a translation problem rather than this one.
 */
function completeDeclaredType(declared: string, dialect: DatabaseType | undefined): string {
  if (declared.includes("(")) return declared;
  // No dialect at all is not an unknown dialect: it means the file names no engine, so
  // there is nothing standing behind ANY private spelling and the portable name is the
  // only defensible one. It is also what this same export's value-shaped path already
  // writes there, and what it wrote for a declared type before the measured rows above
  // existed.
  const standsAlone = dialect === undefined ? NOTHING_STANDS_ALONE : STANDS_ALONE[dialect];
  // `TIMESTAMP WITH TIME ZONE` from Oracle and `timestamp with time zone` from
  // Postgres are the same name, and a declared type is engine output rather than
  // something typed here, so neither the case nor the run of spaces is load-bearing.
  const bare = declared.trim().toLowerCase().replace(/\s+/g, " ");
  if (standsAlone.includes(bare)) return declared;
  // `Object.hasOwn`, not a plain lookup: a column declared `constructor` would
  // otherwise read `Object.prototype.constructor` as its family and, being a function
  // rather than a kind, put the literal `undefined` where the type belongs.
  if (!Object.hasOwn(BARE_TYPE_FAMILY, bare)) return declared;
  const kind = BARE_TYPE_FAMILY[bare];
  return DIALECT_TYPES[dialect as DatabaseType]?.[kind] ?? STANDARD_TYPES[kind];
}

/**
 * A column's declared type for the CREATE TABLE.
 *
 * What the engine declared, when it declared anything plausible: that is the type of
 * THIS result, which is the only source for a computed column or an ad-hoc
 * projection, and it is already spelled the way the engine spells it — completed
 * first, because the spelling the engine uses for a column is not always one that
 * dialect will take back in a CREATE TABLE (`completeDeclaredType` above).
 *
 * Otherwise inferred from the first row that carries a value rather than from row 0:
 * a column that happens to be NULL in the first row was typed `TEXT` regardless of
 * what the other ten thousand rows hold.
 */
function sqlTypeOf(column: string, rows: readonly Record<string, unknown>[], source: ResultExportSource): string {
  const declared = source.columnTypes;
  if (declared !== undefined && Object.hasOwn(declared, column) && PLAUSIBLE_TYPE.test(declared[column])) {
    return completeDeclaredType(declared[column], source.dialect);
  }
  const kind = inferKind(firstSample(rows, column));
  return DIALECT_TYPES[source.dialect as DatabaseType]?.[kind] ?? STANDARD_TYPES[kind];
}

/**
 * How a dialect spells a binary value inside a statement.
 *
 * There is no portable spelling, which is why the value-rendering work that gave the
 * grid, the detail sheet and the CSV their shared `\x…` hex left the SQL forms out:
 * the file has to name a dialect before it can name a literal, and this module is
 * where that knowledge already lives (the DDL type names above).
 *
 * - `standard-hex` — `X'0102'`, the SQL standard's binary string literal.
 * - `zero-x` — `0x0102`, for the dialects that reject `X'…'`.
 * - `pg-bytea` — `'\x0102'::bytea`. Postgres's `X'…'` is a BIT STRING, not bytea, and
 *   there is no cast between the two: measured on 18.4, `SELECT pg_typeof(X'0102')`
 *   answers `bit` and `SELECT X'0102'::bytea` is `ERROR: cannot cast type bit to
 *   bytea`. The hex-input form is what remains, and it is written as a PLAIN literal
 *   rather than `E'\\x…'` because it survives `standard_conforming_strings` in both
 *   positions: with the setting `off`, `SELECT length('\x0102deadbeef'::bytea)` still
 *   answers 6.
 * - `hextoraw` — Oracle parses neither of the two literal forms (`SELECT
 *   rawtohex(x'0102') FROM dual` is `ORA-00907`), so the conversion function is the
 *   literal. `HEXTORAW('')` is NULL, which is also what Oracle stores for a
 *   zero-length RAW, so the empty case needs no special spelling.
 * - `unhex` — same reasoning for ClickHouse, whose byte container is `String`.
 * - `text` — the dialect has no binary value at all. SQL++ is JSON, and JSON has no
 *   byte type; the least-wrong option is the same `\x…` text every other surface
 *   shows, quoted as a string, so a reader can at least decode it by hand.
 *
 * The map is total for the same reason `LITERAL_ESCAPE` is
 * (`src/lib/sql/values.ts`): a new provider must not inherit a silently wrong answer.
 */
type BinaryLiteral = "standard-hex" | "zero-x" | "pg-bytea" | "hextoraw" | "unhex" | "text";

const BINARY_LITERAL: Record<DatabaseType, BinaryLiteral> = {
  postgres: "pg-bytea",
  // Measured on MySQL 26.7.0: `SELECT HEX(X'0102deadbeef')` answers `0102DEADBEEF` and
  // `SELECT LENGTH(X'')` answers 0, so MySQL is here rather than in `zero-x` even
  // though it accepts `0x0102deadbeef` too — a zero-length value has no `0x` spelling
  // (`SELECT LENGTH(0x)` is `ERROR 1054 … Unknown column '0x'`), and an empty cell is
  // not a case an export gets to refuse.
  mysql: "standard-hex",
  // Measured through `bun:sqlite`: `select hex(X'0102deadbeef')` -> `0102DEADBEEF`,
  // and `typeof(X'')` -> `blob` with `length(X'')` 0.
  sqlite: "standard-hex",
  // Trino measured on 476: `SELECT typeof(X'0102')` answers `varbinary`,
  // `to_hex(X'0102deadbeef')` answers `0102DEADBEEF`, `length(X'')` answers 0, and the
  // whole generated pair replays into the memory connector. Druid is the one row here
  // that is NOT measured — its SQL is Calcite's, which spells a binary literal `X'…'`,
  // and a standalone Druid takes no INSERT at all (that needs the MSQ extension), so
  // what is emitted for it is portable SQL meant to run elsewhere.
  trino: "standard-hex",
  druid: "standard-hex",
  // Neither endpoint parses INSERT at all, so what is emitted for them is portable SQL
  // for somewhere else; their SQL reads its literals the way MySQL's does.
  elasticsearch: "standard-hex",
  opensearch: "standard-hex",
  // `queryLanguage: "json"` — no statement is ever built for these three to read, so
  // the standard form is the only thing an export can claim (as in `values.ts`).
  mongodb: "standard-hex",
  redis: "standard-hex",
  libredb: "standard-hex",
  // Measured on SQL Server 2022: `SELECT CONVERT(varchar(64), 0x0102deadbeef, 2)`
  // answers `0102DEADBEEF`, `DATALENGTH(0x)` answers 0 — so the empty case is spelled
  // — and `SELECT X'0102'` is `Msg 207 … Invalid column name 'X'`.
  mssql: "zero-x",
  // Measured on Cassandra 5.0.9: the generated pair replays, and `SELECT "payload"`
  // answers `0x0102deadbeef`. Bare `0x` is the empty blob — `blobAsText(0x)` answers
  // the empty string rather than raising — and `X'…'` is not in the grammar at all.
  cassandra: "zero-x",
  oracle: "hextoraw",
  // Measured on 26.7.1: `unhex('0102deadbeef')` into a `String` column reads back as
  // `hex(payload)` = `0102DEADBEEF` with `length(payload)` 6, and `length(unhex(''))`
  // is 0.
  clickhouse: "unhex",
  couchbase: "text",
};

/**
 * A binary value as a literal the target engine accepts.
 *
 * The hex comes from `binaryText`, minus the `\x` prefix that is Postgres's own
 * spelling rather than every dialect's — sharing that function is what keeps the file
 * and the screen showing the same bytes. It is `[0-9a-f]*` by construction, so
 * interpolating it needs no quoting: there is no character in it that could end the
 * literal it sits in (#290).
 */
function binaryLiteral(bytes: Uint8Array, dialect: DatabaseType | undefined): string {
  const text = binaryText(bytes);
  const hex = text.slice(2);
  switch (dialect === undefined ? "standard-hex" : BINARY_LITERAL[dialect]) {
    case "pg-bytea":
      return `'${text}'::bytea`;
    case "zero-x":
      return `0x${hex}`;
    case "hextoraw":
      return `HEXTORAW('${hex}')`;
    case "unhex":
      return `unhex('${hex}')`;
    case "text":
      return quoteLiteral(text, dialect);
    default:
      return `X'${hex}'`;
  }
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
  // Before the object branch, which used to write a `bytea`/`BLOB` cell as the quoted
  // text `{"type":"Buffer","data":[…]}`. Replayed into Postgres 18.4 that INSERT
  // stored 46 bytes of that JSON where six bytes belonged, and it stored them
  // successfully — bytea's escape input format accepts the text, so nothing failed.
  const bytes = asBytes(value);
  if (bytes !== undefined) return binaryLiteral(bytes, dialect);
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
  // Cassandra-only: measured on 5.0.9, a CQL `CREATE TABLE` with a column list and no
  // key is `InvalidRequest ... No PRIMARY KEY specifed for table (exactly one
  // required)`, so the plain column list every other dialect gets here cannot run at
  // all. A result set does not know which column is the real key, so the first one is
  // chosen as a placeholder - wrong often enough to be dangerous, but a wrong key that
  // replays beats a file that fails to parse. The comment says so above the statement,
  // rather than in the column list, so it survives being read on its own.
  if (dialect === "cassandra") {
    definitions.push(`  PRIMARY KEY (${quotedColumns[0]})`);
    return sql(`${CASSANDRA_PRIMARY_KEY_NOTE}CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`);
  }
  return sql(`CREATE TABLE ${tableName} (\n${definitions.join(",\n")}\n);`);
}
