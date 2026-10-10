import type { DatabaseType } from "@/lib/types";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { asBytes, binaryText } from "./binary";
import { cellOf, resolveColumns, toCsv, type CsvDelimiter } from "./csv";
import { htmlTable } from "./html";
import { binaryCellsAsHex, jsonText } from "./json";
import { markdownTable } from "./markdown";
import { resolveUpdateTarget } from "@/lib/sql/update-target";
import { cqlFrozenNested, typedLiteral, UnwritableValue } from "./typed-literals";
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
  // Db2 has no TEXT: measured on 12.1.0.0, `CREATE TABLE ... (c TEXT)` is SQL0204N `"TEXT" is an
  // undefined name`, while BIGINT, DOUBLE PRECISION, BOOLEAN, TIMESTAMP and BLOB are whole types.
  // CLOB, the unbounded character type, rather than a VARCHAR whose bound a cell could pass (#786).
  db2: { text: "CLOB" },
  // Databend's measured spellings (design 7.2, X01): M08a created `VARCHAR`, `DOUBLE` and `BINARY` columns on the
  // pinned image and M08c read them back as `String`, `Float64` and `Binary`, unbounded. The standard `TEXT`,
  // `DOUBLE PRECISION` and `BLOB` were not measured there. `BIGINT`, `BOOLEAN` and `TIMESTAMP` were, as they are.
  databend: { text: "VARCHAR", numeric: "DOUBLE", binary: "BINARY" },
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
 * inherit a silently wrong answer. The eighteen dialects with NO row measured have an
 * empty one. Db2 is the one of them that parses both statements (#786); no bare name was
 * measured standing alone there, so each is re-spelled from its family. Druid takes no INSERT at all without the MSQ extension. The two search
 * endpoints and Couchbase parse no CREATE TABLE: a SQL++ collection is schemaless and
 * `CREATE COLLECTION` takes no columns, which is why the Couchbase provider declares
 * `supportsCreateTable: false`. InfluxDB 3 parses SQL, but its 3.12 planner refuses DDL and DML, so
 * a generated file is for another engine, the search pair's reason. MongoDB, Redis, Kafka, etcd,
 * Milvus, Qdrant, Oxia, S3 and the embedded store declare `queryLanguage: "json"`, `prometheus` declares
 * `"promql"`, `neo4j` declares `"cypher"` and `influxdb` declares `"influxql"`, so no SQL statement
 * is ever built for those twelve to read. A file for any of those seventeen
 * is by definition meant to run somewhere else, so every bare name in it is re-spelled
 * portably rather than kept as one engine's private word.
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
  mysql: ["text", "tinytext", "mediumtext", "longtext", "blob", "tinyblob", "mediumblob", "longblob", "year"],
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
  // The same list, for the same measured reason: libSQL IS SQLite 3.47.0, and
  // `pragma_table_info` there answers the declared spelling verbatim too (measured on
  // sqld 0.24.33). Written out rather than aliased so a future divergence can be
  // recorded in one row without touching the other.
  libsql: [
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
  // Measured on DuckDB v1.5.5, one `CREATE TABLE probe (c <name>)` per name read back
  // out of `duckdb_columns().data_type`. Every name here resolved to an UNNARROWED
  // type - the seven text spellings to `VARCHAR`, the four byte ones to `BLOB`, the
  // four moment ones to `TIMESTAMP` (and `TIMESTAMP WITH TIME ZONE` to itself).
  //
  // `numeric` and `decimal` are the absences that matter: DuckDB accepts both and
  // stores `DECIMAL(18,3)`, which rounds away every value past the third decimal the
  // column existed for - the same silent narrowing MySQL's bare `decimal` does. They
  // are therefore re-spelled from their family rather than kept.
  duckdb: [
    "character varying",
    "varchar",
    "nvarchar",
    "character",
    "char",
    "nchar",
    "text",
    "binary",
    "varbinary",
    "blob",
    "bytea",
    "timestamp",
    "timestamp without time zone",
    "timestamp with time zone",
    "datetime",
  ],
  trino: ["varchar", "varbinary", "timestamp", "timestamp without time zone", "timestamp with time zone"],
  // No name was measured standing alone on Db2 in its first version (#786), so every bare name is
  // re-spelled from its family.
  db2: NOTHING_STANDS_ALONE,
  cassandra: ["varchar", "text", "blob", "decimal", "timestamp"],
  druid: NOTHING_STANDS_ALONE,
  elasticsearch: NOTHING_STANDS_ALONE,
  opensearch: NOTHING_STANDS_ALONE,
  mongodb: NOTHING_STANDS_ALONE,
  redis: NOTHING_STANDS_ALONE,
  libredb: NOTHING_STANDS_ALONE,
  couchbase: NOTHING_STANDS_ALONE,
  prometheus: NOTHING_STANDS_ALONE,
  kafka: NOTHING_STANDS_ALONE,
  etcd: NOTHING_STANDS_ALONE,
  neo4j: NOTHING_STANDS_ALONE,
  milvus: NOTHING_STANDS_ALONE,
  qdrant: NOTHING_STANDS_ALONE,
  influxdb: NOTHING_STANDS_ALONE,
  influxdb3: NOTHING_STANDS_ALONE,
  // Oxia has no statement form for an export.
  oxia: NOTHING_STANDS_ALONE,
  // S3 has no statement form for an export.
  s3: NOTHING_STANDS_ALONE,
  // Measured by M08a and M08c on the pinned image: each was created and read back unbounded (`String`, `Timestamp`
  // with microseconds, `Binary`). Every other bare name is re-spelled from its family (design 7.2, X01).
  databend: ["varchar", "timestamp", "binary"],
};

/**
 * The bare names a dialect narrows below the value its own driver hands back, so the
 * INSERT this same export writes beside the CREATE TABLE fails or rounds (#1386).
 *
 * Kept per dialect because the drivers disagree about the value (`BARE_TYPE_FAMILY` above
 * says why `bit` cannot have one family): `pg` hands a bit string back as text such as
 * `1010`, which a bare `bit` (`bit(1)`) refuses with `bit string length 4 does not match
 * type bit(1)` and `bit varying` takes at any length; `mysql2` hands one back as bytes,
 * which `bit(64)`, MySQL's widest, takes for every width. MySQL's bare `datetime`,
 * `timestamp` and `time` have fractional precision 0, which ROUNDS a `.999` replayed into
 * them up to the next second, so they are written at precision 6.
 *
 * Databend has no row (design 7.2, X01): its `Timestamp` keeps microseconds without a precision and its `Decimal`
 * always carries its own, so no bare name it reports narrows the value its INSERT writes back.
 */
const DIALECT_BARE_SPELLING: Partial<Record<DatabaseType, Readonly<Record<string, string>>>> = {
  postgres: { bit: "bit varying" },
  mysql: { bit: "bit(64)", datetime: "datetime(6)", timestamp: "timestamp(6)", time: "time(6)" },
};

/**
 * The dialects whose declared types need a rewrite of their own before a CREATE TABLE takes
 * them, ahead of the bare-name completion below.
 *
 * The Cassandra driver reports a nested collection without its `frozen<...>` (measured on
 * 5.0.9: a `list<frozen<list<int>>>` column is declared `list<list<int>>`), and CQL refuses
 * that spelling: `Non-frozen collections are not allowed inside collections`.
 *
 * Databend has no row (design 7.2, X01): its declared types are written as its query schema spells them
 * (`Nullable(Array(Int32 NULL))`), and the every-type replay of the provider's local pass is what proves or refutes
 * that spelling in a CREATE TABLE.
 */
const DECLARED_TYPE_REWRITE: Partial<Record<DatabaseType, (declared: string) => string>> = {
  cassandra: cqlFrozenNested,
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
  // Only a type the rewrite changed skips the completion below; a bare name it leaves alone
  // is still completed like any other.
  const rewritten = dialect === undefined ? undefined : DECLARED_TYPE_REWRITE[dialect]?.(declared);
  if (rewritten !== undefined && rewritten !== declared.trim()) return rewritten;
  if (declared.includes("(")) return declared;
  const respelled = dialect === undefined ? undefined : DIALECT_BARE_SPELLING[dialect];
  // The element type of an array is re-spelled the same way: a Postgres `bit[]` holds the
  // same `1010` text per element that a bare `bit` refuses.
  const [, name, dimensions] = /^(.*?)((?:\[\])*)$/.exec(declared.trim().toLowerCase()) as RegExpExecArray;
  if (respelled !== undefined && Object.hasOwn(respelled, name)) return `${respelled[name]}${dimensions}`;
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
  if (declared !== undefined && Object.hasOwn(declared, column) && isPlausibleType(declared[column])) {
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
 * - `binary-hex`: `BX'0102'`, Db2's binary string literal. Db2 parses `X'…'` too, but as a
 *   CHARACTER string (FOR BIT DATA), which a `BLOB` or a `VARBINARY` column refuses.
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
type BinaryLiteral = "standard-hex" | "zero-x" | "binary-hex" | "pg-bytea" | "hextoraw" | "unhex" | "text";

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
  // Measured over Hrana on sqld 0.24.33: `SELECT hex(X'0102deadbeef')` answers
  // `0102DEADBEEF`, `typeof(X'')` answers `blob` and `length(X'')` answers 0 - the
  // same readings as the SQLite row above, taken again rather than assumed.
  libsql: "standard-hex",
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
  // `queryLanguage: "json"`: no statement is ever built for these seven to read, so
  // the standard form is the only thing an export can claim (as in `values.ts`).
  mongodb: "standard-hex",
  redis: "standard-hex",
  libredb: "standard-hex",
  kafka: "standard-hex",
  etcd: "standard-hex",
  milvus: "standard-hex",
  qdrant: "standard-hex",
  // PromQL, not SQL (#1085): no statement is ever built for it either, so the same claim.
  prometheus: "standard-hex",
  // Cypher, not SQL: it has no INSERT and no byte literal, so no statement is built for it either.
  neo4j: "standard-hex",
  // InfluxQL, not SQL: it has no INSERT and no byte literal, so no statement is built for it either.
  influxdb: "standard-hex",
  // Measured on InfluxDB 3.12.0: `SELECT arrow_typeof(X'00ff')` answers `Binary`, and `SELECT
  // arrow_typeof(X''), encode(X'','hex'), encode(X'0102deadbeef','hex')` answers `Binary`, the empty
  // string and `0102deadbeef`, so the empty value has a spelling too.
  influxdb3: "standard-hex",
  // Oxia has no statement language for a value, so no statement is built for it; the answer is the inert default,
  // as `etcd`'s and `neo4j`'s.
  oxia: "standard-hex",
  // No statement language for a value, so no statement is built for it; the inert default, as Oxia's.
  s3: "standard-hex",
  // Measured on SQL Server 2022: `SELECT CONVERT(varchar(64), 0x0102deadbeef, 2)`
  // answers `0102DEADBEEF`, `DATALENGTH(0x)` answers 0 — so the empty case is spelled
  // — and `SELECT X'0102'` is `Msg 207 … Invalid column name 'X'`.
  mssql: "zero-x",
  // Measured on Cassandra 5.0.9: the generated pair replays, and `SELECT "payload"`
  // answers `0x0102deadbeef`. Bare `0x` is the empty blob — `blobAsText(0x)` answers
  // the empty string rather than raising — and `X'…'` is not in the grammar at all.
  cassandra: "zero-x",
  oracle: "hextoraw",
  // Measured on Db2 LUW 12.1.0.0 (#786): `INSERT … VALUES (X'0102deadbeef')` into a `BLOB` or a
  // `VARBINARY` column is SQL0408N, "a value is not compatible with the data type of its
  // assignment target", because `X'…'` is a character string here. `BX'0102deadbeef'` goes into
  // `BLOB`, `VARBINARY` and `VARCHAR FOR BIT DATA` alike, reading back as `HEX(…)` =
  // `0102DEADBEEF`, and `BX''` inserts the zero-length value into all three.
  db2: "binary-hex",
  // Measured on 26.7.1: `unhex('0102deadbeef')` into a `String` column reads back as
  // `hex(payload)` = `0102DEADBEEF` with `length(payload)` 6, and `length(unhex(''))`
  // is 0.
  // `unhex`, and NOT `standard-hex` even though DuckDB is Postgres-shaped everywhere
  // else in this file. Measured on v1.5.5: `X'0102'` is not a binary literal at all -
  // `SELECT typeof(X'0102')` answers `VARCHAR` and `SELECT X'0102'` answers the five
  // characters `x0102`, so the standard spelling PARSES and writes text where bytes
  // belong. `unhex('0102deadbeef')` answers a real `BLOB`, and the generated pair
  // replays: inserted into a `BLOB` column it reads back as `hex(payload)` =
  // `0102DEADBEEF` with `octet_length(payload)` 6, and `unhex('')` inserts the
  // zero-length blob (`octet_length` 0). `0x0102` is a parser error here.
  duckdb: "unhex",
  clickhouse: "unhex",
  // Databend reads a quoted string into BINARY through `binary_input_format`, utf-8 by default, so the standard
  // `X'…'` was not its measured spelling: M08b inserted `unhex('00ff10')` on the pinned image and M08c read back the
  // three bytes as `00FF10` (design 7.2, X01).
  databend: "unhex",
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
    case "binary-hex":
      return `BX'${hex}'`;
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
 * Which Oracle conversion function a `Date` cell is written through. The provider's own
 * rows carry a DATE and a TIMESTAMP as text since #1131 (`OracleDateColumn` below), so a
 * naive `Date` reaches this only from a host that built its rows itself.
 *
 * Oracle parses none of the literal forms a `Date` stringifies to: measured through the
 * real export path on the Oracle Free image (`Oracle AI Database 26ai Free Release
 * 23.26.2.0.0`), an exported `'2026-08-24T07:11:12.345Z'` is `ORA-01843: An invalid month
 * was specified` for all three timestamp types and `ORA-01861: literal does not match
 * format string` for a DATE, so every ordinary Oracle table with a date column produced a
 * file that could not be replayed. The conversion function IS the literal here, the way
 * `HEXTORAW` is for a RAW.
 *
 * The shape has to come from the DECLARED type, because the two shapes disagree about
 * which fields of the `Date` are the value:
 *
 * - A naive `DATE`/`TIMESTAMP` reaches us as a `Date` the driver built by reading the
 *   stored wall clock **in the Node process's zone**. Measured, a `DATE` holding
 *   `2026-08-24 10:11:12` arrived as `2026-08-24T07:11:12.000Z` from a process at
 *   `+03:00`. So the fields that replay it are the LOCAL ones, and writing the ISO text
 *   would move every such value by the exporter's own offset - silently, since it still
 *   parses.
 * - A zoned column (`WITH TIME ZONE`, `WITH LOCAL TIME ZONE`) reaches us as the true UTC
 *   instant, its stored offset already gone at the driver boundary
 *   (`docs/providers/oracle.md` 5.5). `FROM_TZ(..., 'UTC')` is what keeps that instant
 *   whatever zone the replaying session runs in: a plain `TO_TIMESTAMP` is read in the
 *   SESSION time zone, so the same file would land on a different instant on a machine
 *   in another zone. No offset is invented - the value comes back rendered as UTC, and
 *   the original zone is the thing 5.5 says only the server still has.
 *
 * With no declared type - `columnTypes` is optional on `ResultExportSource`, and a host
 * driving the embeddable surface may supply none - the timestamp form is the fallback:
 * Oracle's own provider always declares (`metaData[].dbTypeName`, 5.4), the naive types
 * are the common ones, and the fallback is the shape that is exact for them.
 */
type OracleDateShape = "date" | "timestamp" | "zoned";

function oracleDateShape(declared: string | undefined): OracleDateShape {
  const bare = declared?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  if (bare === "DATE") return "date";
  return bare.endsWith("TIME ZONE") ? "zoned" : "timestamp";
}

/**
 * How one Oracle column's date cells are written: `shape` for a `Date`, and `text` for a
 * cell that arrives as a string: the zone-less text the provider reads a DATE and a
 * TIMESTAMP as (#1131), or, for a zoned column, the `Date#toISOString` text a row carries
 * once it has been through JSON over HTTP (#1224).
 *
 * `text` is set only for a column DECLARED `DATE`, `TIMESTAMP[(n)]` or
 * `TIMESTAMP[(n)] WITH [LOCAL] TIME ZONE`, never by the fallback `shape` takes. A VARCHAR2
 * holding `2026-09-01 10:30:00` is text, and converting it would store the NLS rendering
 * of a timestamp where the characters belonged.
 */
interface OracleDateColumn {
  shape: OracleDateShape;
  text?: "date" | "timestamp" | "zoned";
}

function oracleDateColumn(declared: string | undefined): OracleDateColumn {
  const bare = declared?.trim().toUpperCase() ?? "";
  const text =
    bare === "DATE"
      ? "date"
      : /^TIMESTAMP\s*(\(\d\))?$/.test(bare)
        ? "timestamp"
        : /^TIMESTAMP\s*(\(\d\))?\s+WITH\s+(LOCAL\s+)?TIME\s+ZONE$/.test(bare)
          ? "zoned"
          : undefined;
  return { shape: oracleDateShape(declared), ...(text === undefined ? {} : { text }) };
}

/** What `source` declared for `column`, or `undefined`. */
function declaredTypeOf(source: ResultExportSource, column: string): string | undefined {
  // `Object.hasOwn` for the reason `sqlTypeOf` uses it: a column named `constructor`
  // would otherwise read `Object.prototype.constructor` as its declared type.
  const declared = source.columnTypes;
  return declared !== undefined && Object.hasOwn(declared, column) ? declared[column] : undefined;
}

/** `value`, two digits at least, so `2026-1-2 3:4:5` never reaches a format mask. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * An Oracle date literal, from the LOCAL fields for a naive column and the UTC ones for
 * a zoned column (see `oracleDateShape`).
 *
 * The fraction is three digits and `FF3` rather than dropped: a `Date` carries
 * milliseconds and a `TIMESTAMP(6)` keeps them. `TO_DATE` is used for a declared `DATE`
 * because a `DATE` has no fractional second at all - measured, a `TO_TIMESTAMP` literal
 * inserted into a `DATE` column is accepted and silently truncated to the whole second,
 * so nothing is lost either way and the explicit function says what the column is.
 */
function oracleDateLiteral(value: Date, shape: OracleDateShape): string {
  const utc = shape === "zoned";
  const date = `${pad(utc ? value.getUTCFullYear() : value.getFullYear(), 4)}-${pad((utc ? value.getUTCMonth() : value.getMonth()) + 1)}-${pad(utc ? value.getUTCDate() : value.getDate())}`;
  const time = `${pad(utc ? value.getUTCHours() : value.getHours())}:${pad(utc ? value.getUTCMinutes() : value.getMinutes())}:${pad(utc ? value.getUTCSeconds() : value.getSeconds())}`;
  if (shape === "date") return `TO_DATE('${date} ${time}', 'YYYY-MM-DD HH24:MI:SS')`;
  const stamp = `TO_TIMESTAMP('${date} ${time}.${pad(utc ? value.getUTCMilliseconds() : value.getMilliseconds(), 3)}', 'YYYY-MM-DD HH24:MI:SS.FF3')`;
  return utc ? `FROM_TZ(${stamp}, 'UTC')` : stamp;
}

/**
 * The text the Oracle provider reads a DATE and a TIMESTAMP as (#1131): the wall clock,
 * a leading `-` on a BC year, and a fraction only where there is one.
 */
const ORACLE_ZONELESS_TEXT = /^(-?)\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;

/**
 * That text as the literal of the declared type, or `undefined` when it is not in that form.
 *
 * Quoted as it is, the text is read through the session's `NLS_DATE_FORMAT`, `DD-MON-RR` by
 * default, and refused. The mask spells the text's own form instead, so it replays the same
 * in every session: `SYYYY` only for a signed year, and `FF` only for a fraction, since `FF`
 * with no digit count takes the one to nine digits a TIMESTAMP holds. A DATE has no
 * fractional second, so a fraction is not a DATE's text. The text is digits and separators
 * by that same match, so interpolating it needs no quoting.
 */
function oracleTextLiteral(text: string, type: "date" | "timestamp"): string | undefined {
  const match = ORACLE_ZONELESS_TEXT.exec(text);
  if (match === null) return undefined;
  const [, sign, fraction] = match;
  const mask = `${sign === "" ? "YYYY" : "SYYYY"}-MM-DD HH24:MI:SS`;
  if (type === "date") return fraction === undefined ? `TO_DATE('${text}', '${mask}')` : undefined;
  return `TO_TIMESTAMP('${text}', '${mask}${fraction === undefined ? "" : ".FF"}')`;
}

/**
 * The text `Date#toISOString` writes for a year from 0000 to 9999. A year outside that
 * range is written with a sign and six digits (`-000044-…`, `+012026-…`) and does not
 * match: Oracle has no year after 9999, and the `Date` path does not write a BC year
 * Oracle reads back, so that text stays quoted instead of taking a literal the `Date`
 * of the same instant would not get.
 */
const ISO_INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A zoned column's cell as it arrives over HTTP (#1224), as the literal the `Date` of that
 * instant gets, or `undefined` when it is not that text.
 *
 * The driver hands a `TIMESTAMP WITH [LOCAL] TIME ZONE` over as the `Date` of its instant,
 * and `POST /api/db/query` answers with JSON, so by the time an export over HTTP sees the
 * row the cell is that `Date`'s ISO text. Quoted, Oracle reads it through the session's
 * `NLS_TIMESTAMP_TZ_FORMAT` and refuses it (`ORA-01843`). The text is parsed back to its
 * `Date` and written by `oracleDateLiteral`, so the two paths cannot drift apart, and only
 * when that `Date` writes the same text again: `2026-02-30T…` and `T24:00:00.000Z` fit the
 * form but are not what `toISOString` writes for any instant. The literal is built from
 * the parsed fields, never from the text.
 */
function oracleZonedTextLiteral(text: string): string | undefined {
  if (!ISO_INSTANT_TEXT.test(text)) return undefined;
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === text
    ? oracleDateLiteral(instant, "zoned")
    : undefined;
}

/**
 * NaN and the infinities as each dialect reads them back into a float column.
 *
 * None of them is a number literal anywhere, the bare word `NaN` would read as a column
 * name, and NULL is a different value, so each spelling here was replayed into the
 * engine (2026-10-04): PostgreSQL 18.6 and DuckDB read the quoted words into `real`,
 * `double precision`, `DOUBLE` and `FLOAT` (PostgreSQL also into `timestamptz`, whose
 * infinities are quoted text anyway); SQLite reads `9e999` and `-9e999` as its
 * infinities in a `REAL` column, where a quoted `'Infinity'` is stored as TEXT, and has
 * no NaN at all (it stores one as NULL); Oracle AI Database 23.26.3 reads its own
 * constants into `BINARY_DOUBLE` and `BINARY_FLOAT`; Databend (M08b, on the pinned image) inserted
 * `'NaN'::FLOAT`, `'inf'::DOUBLE` and `'-inf'::FLOAT` into its `FLOAT` and `DOUBLE` columns and read back NaN,
 * Infinity and -Infinity. Every other dialect, which either
 * cannot store these values or was not replayed, keeps writing NULL.
 */
const NON_FINITE_LITERALS: Partial<Record<DatabaseType, Readonly<Record<NonFiniteWord, string>>>> = {
  postgres: { NaN: "'NaN'", Infinity: "'Infinity'", "-Infinity": "'-Infinity'" },
  duckdb: { NaN: "'NaN'", Infinity: "'Infinity'", "-Infinity": "'-Infinity'" },
  sqlite: { NaN: "NULL", Infinity: "9e999", "-Infinity": "-9e999" },
  oracle: { NaN: "BINARY_DOUBLE_NAN", Infinity: "BINARY_DOUBLE_INFINITY", "-Infinity": "-BINARY_DOUBLE_INFINITY" },
  databend: { NaN: "'NaN'::FLOAT", Infinity: "'inf'::DOUBLE", "-Infinity": "'-inf'::FLOAT" },
};

function nonFiniteLiteral(word: NonFiniteWord, dialect: DatabaseType | undefined): string {
  return (dialect === undefined ? undefined : NON_FINITE_LITERALS[dialect]?.[word]) ?? "NULL";
}

/**
 * A declared type that holds a binary float, spelled the way the providers report it:
 * PostgreSQL's `real` / `double precision`, DuckDB's `FLOAT` / `DOUBLE`, SQLite's
 * declared `REAL`, Oracle's `BINARY_DOUBLE` / `BINARY_FLOAT`, and `float4`/`float8`.
 */
const FLOAT_TYPE = /^(double( precision)?|real|float\d*|binary_(double|float))$/i;

/** `columnTypes` is the host's data until checked, so a declared type is tested only as a string. */
function isFloatColumn(declared: unknown): boolean {
  return typeof declared === "string" && FLOAT_TYPE.test(declared.trim());
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
function sqlValue(
  value: unknown,
  dialect: DatabaseType | undefined,
  oracle?: OracleDateColumn,
  floatColumn = false,
): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") {
    const word = nonFiniteWord(value);
    return word === undefined ? String(value) : nonFiniteLiteral(word, dialect);
  }
  // A cell that crossed HTTP carries the word as a string, which is only a float when the
  // column was declared one: a text column may hold the word itself.
  if (floatColumn && isNonFiniteWord(value)) return nonFiniteLiteral(value, dialect);
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    if (oracle !== undefined) return oracleDateLiteral(value, oracle.shape);
    return quoteLiteral(value.toISOString(), dialect);
  }
  if (typeof value === "string" && oracle?.text !== undefined) {
    const literal = oracle.text === "zoned" ? oracleZonedTextLiteral(value) : oracleTextLiteral(value, oracle.text);
    if (literal !== undefined) return literal;
  }
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
    return { content: toCsv(rows, columns, source.csvDelimiter), mimeType: "text/csv;charset=utf-8", extension: "csv" };
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
    const oracleColumns =
      dialect === "oracle" ? columns.map((column) => oracleDateColumn(declaredTypeOf(source, column))) : undefined;
    const floatColumns = columns.map((column) => isFloatColumn(declaredTypeOf(source, column)));
    const declaredTypes = columns.map((column) => declaredTypeOf(source, column));
    const scalar = (value: unknown) => sqlValue(value, dialect);
    const statements = rows.map((row, rowIndex) => {
      const values: string[] = [];
      for (const [index, column] of columns.entries()) {
        const cell = cellOf(row, column);
        try {
          // The cells whose literal depends on the declared type first (#1386): an array,
          // an interval, a map, a BIT. Everything else is written as it always was.
          values.push(
            typedLiteral(cell, declaredTypes[index], dialect, scalar) ??
              sqlValue(cell, dialect, oracleColumns?.[index], floatColumns[index]),
          );
        } catch (error) {
          if (!(error instanceof UnwritableValue)) throw error;
          return skippedRow(rowIndex, column, error.message, dialect);
        }
      }
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
