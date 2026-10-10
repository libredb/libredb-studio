/**
 * Migration SQL from a schema diff. Dialect-specific DDL is emitted where the
 * engine supports it; otherwise a comment names the limitation (#284).
 *
 * SQL Server uses BEGIN TRANSACTION; Oracle DDL commits implicitly, so it has
 * no wrapper. Oracle drops omit version-dependent IF EXISTS clauses. The live
 * regression probe is tests/live/schema-diff-dialects.ts.
 *
 * A diff is not a complete migration plan: source constraint names, schema
 * qualifiers and cross-table dependency order are not recorded here. Review
 * the generated SQL before executing it against the target database.
 */
import type { DatabaseType } from "@/lib/types";
// The shared quoter, which also escapes an embedded closing quote character — this
// file used to carry its own copy that did not, so a schema object named with one
// produced SQL that ended the quoted span early (PR #289 review).
import { quoteIdentifier as escapeIdentifier } from "@/lib/sql/identifier";
import type { SchemaDiff, TableDiff, ColumnDiff, IndexDiff } from "./types";

/**
 * ClickHouse column-default kinds as `system.columns.default_kind` reports them, and as
 * `clickhouse/introspect.ts:readDefault` prefixes them onto the expression it hands the diff engine.
 * `DEFAULT` is the only kind that arrives bare, so a value starting with one of these already names
 * its own clause and must not be put behind another `DEFAULT` keyword.
 *
 * Live-probed against the pinned `clickhouse-server:26.7.1.1315` build:
 * `MODIFY COLUMN "y" Int32 DEFAULT MATERIALIZED toYear(d)` is a syntax error (code 62) while
 * `MODIFY COLUMN "y" Int32 MATERIALIZED toYear(d)` is accepted, and switching kind in one statement
 * works. `REMOVE` takes `DEFAULT`, `MATERIALIZED` or `ALIAS` only — `REMOVE EPHEMERAL` is rejected
 * (code 62, "Expected one of: DEFAULT, MATERIALIZED, ALIAS, COMMENT, CODEC, TTL, SETTINGS") — and
 * `REMOVE DEFAULT` against a column that has none is an error too (code 36), which is why the branch
 * below only emits it for a default that existed.
 */
const CLICKHOUSE_DEFAULT_KINDS = ["MATERIALIZED", "ALIAS", "EPHEMERAL"];
const CLICKHOUSE_REMOVABLE_KINDS = ["DEFAULT", "MATERIALIZED", "ALIAS"];

function clickhouseDefaultKind(value: string): string {
  return CLICKHOUSE_DEFAULT_KINDS.find((kind) => value.startsWith(`${kind} `)) ?? "DEFAULT";
}

function defaultClause(col: ColumnDiff, dialect: DatabaseType): string {
  const value = defaultSql(col);
  if (value === undefined) return "";
  if (dialect === "clickhouse" && clickhouseDefaultKind(value) !== "DEFAULT") return ` ${value}`;
  return ` DEFAULT ${value}`;
}

/**
 * Why a Databend migration names a modified column in a comment rather than altering it (probe L8). Databend HAS
 * `ALTER TABLE ... MODIFY COLUMN`, measured changing type, nullability and comment with the data kept, so the
 * sentence never says otherwise: what it declines is this generator's spelling. The MySQL branch's statement runs on a
 * populated table, but its `NOT NULL` form is refused on an empty one (1058, "Cannot find statistics for column")
 * and a change that does not restate the default drops it; the PostgreSQL branch's `ALTER COLUMN` is a parse error
 * (1005).
 */
export const DATABEND_COLUMN_MODIFICATION_REASON =
  "Databend has ALTER TABLE ... MODIFY COLUMN, but the MySQL spelling this generator writes fails NOT NULL on an empty table and silently drops an existing default it does not restate; write the change by hand.";

/** Why an added Databend table declines its key in a comment: probe L11, every `PRIMARY KEY` form is 1005. */
export const DATABEND_PRIMARY_KEY_REASON = "Databend's CREATE TABLE has no primary-key constraint.";

/**
 * Databend's index refusal. Its CREATE INDEX always names a kind (INVERTED, NGRAM, VECTOR or SPATIAL search
 * indexes), with no plain or UNIQUE index to carry the diff's column list and uniqueness.
 */
export const DATABEND_INDEX_REFUSAL =
  "Databend: Cannot generate index DDL. Its indexes are inverted, ngram, vector and spatial search indexes, which the diff does not record; write the index change by hand.";

/**
 * Canonical type ids whose column modification this generator does not write, each entry's reason saying why.
 * Most of these engines have no column-modification statement at all; Db2 and Databend have one that the
 * spelling this generator would emit cannot carry safely.
 *
 * The modified-column path below branches per dialect and ends in a PostgreSQL `else`, so every id
 * without a branch used to be handed `ALTER TABLE ... ALTER COLUMN` no matter what it can run
 * (#269). Naming the limitation in a comment instead is this generator's own precedent — the SQLite
 * branch already answers an inexpressible change that way, because a comment a human can read beats
 * DDL the target engine can only reject.
 *
 * The value completes `-- <label>: Cannot alter column "<name>". <reason>`. The labels deliberately
 * repeat `db-ui-config.ts`'s display names instead of reading them from it: that registry carries React
 * icon components, which this pure SQL module must not pull in, and the `SQLite` comments elsewhere in
 * this file spell their engine out the same way.
 */
const NO_COLUMN_MODIFICATION: Partial<Record<DatabaseType, { label: string; reason: string }>> = {
  // Measured over Hrana on sqld 0.24.33, and the entry exists because the PostgreSQL
  // branch this id would otherwise inherit emits text libSQL cannot parse:
  // `ALTER TABLE t ALTER COLUMN c TYPE integer` is "unexpected end of input" and the
  // MySQL spelling `MODIFY COLUMN` is "syntax error around `MODIFY`". No SQLite has a
  // column TYPE change, and libSQL is SQLite - unlike DROP COLUMN and RENAME COLUMN,
  // which it DOES accept (both measured), so this row is narrower than the `sqlite`
  // branch below and deliberately so. Nullability is the one exception and it does not
  // reach libSQL: SQLite gained `ALTER COLUMN ... SET/DROP NOT NULL` in 3.53.0 (measured
  // 2026-08-27 on 3.53.0 - it rewrites the stored schema and is enforced on insert),
  // while sqld 0.24.33 ships 3.47.0, so declining every modification is still right here.
  // The `sqlite` branch below declines it too, and deliberately: that provider runs on
  // whichever SQLite its runtime bundles - `bun:sqlite` or `node:sqlite`, chosen at runtime
  // with `LIBREDB_SQLITE_DRIVER` as an override - so emitting the statement would write a
  // migration file that succeeds on one deployment and fails on another. A file handed to a
  // human to run elsewhere makes that guess worse than the decline.
  libsql: {
    label: "libSQL",
    reason: "SQLite cannot retype a column; recreate the table and copy the rows.",
  },
  // Db2 retypes a column with its own `ALTER COLUMN … SET DATA TYPE`, which the PostgreSQL branch
  // this id would otherwise inherit does not emit, and several such changes leave the table
  // REORG-pending until a REORG runs, which a flat migration file cannot schedule (#786). ADD and
  // DROP COLUMN take the standard spelling, both measured on Db2 LUW 12.1.0.0.
  db2: {
    label: "Db2 LUW",
    reason:
      "Db2 changes a column with ALTER COLUMN ... SET DATA TYPE and may leave the table REORG-pending; write the change by hand.",
  },
  couchbase: {
    label: "Couchbase",
    reason: "Collections hold schemaless JSON documents, so there is no column definition to change.",
  },
  druid: {
    label: "Apache Druid",
    reason: "Druid SQL has no ALTER TABLE; rewrite the datasource with REPLACE INTO through an MSQ task.",
  },
  // Measured 2026-08-20 on Trino 476, and the entry exists because the PostgreSQL
  // branch this id would otherwise inherit emits text Trino cannot even PARSE:
  // `ALTER TABLE ... ALTER COLUMN id TYPE varchar` is "line 1:50: mismatched input
  // 'TYPE'. Expecting: '.', 'DROP', 'SET'". Trino's own spelling
  // (`ALTER COLUMN id SET DATA TYPE varchar`) parses and then hands the question to
  // the catalog, which answered "This connector does not support setting column
  // types" - so there is no single statement a portable migration could carry, and
  // which one would work is a property of the catalog rather than of Trino.
  trino: {
    label: "Trino",
    reason:
      "Whether a column can be retyped is the connector's answer, not Trino's; run the change in the system the catalog points at.",
  },
  // Measured 2026-08-19: `ALTER TABLE probe_orders ADD COLUMN x INT` and
  // `... MODIFY COLUMN customer TEXT` are refused by both grammars - Elasticsearch
  // 9.1.4 with `parsing_exception`, "mismatched input 'ALTER' expecting {'(',
  // 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}" (the
  // grammar lists everything it accepts, and no DDL is among them), OpenSearch 3.8.0
  // with `SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE,
  // SHOW or DESCRIBE". A mapping is also not editable in place even outside SQL: an
  // existing field's type cannot be changed at all, which is why the reason says
  // reindex rather than "use the mapping API".
  elasticsearch: {
    label: "Elasticsearch",
    reason: "Elasticsearch SQL reads only; change a field by reindexing into an index whose mapping declares it.",
  },
  opensearch: {
    label: "OpenSearch",
    reason: "OpenSearch SQL reads only; change a field by reindexing into an index whose mapping declares it.",
  },
  // Measured on Cassandra 5.0.9: `ALTER TABLE probe.customers ALTER name TYPE blob`
  // answers 8704, "Altering column types is no longer supported" - the operation was
  // REMOVED from the engine (it corrupted data), not merely unimplemented. The
  // PostgreSQL branch this id would otherwise inherit emits `ALTER COLUMN … TYPE …`,
  // which is not even in CQL's ALTER grammar, so there is no statement to emit at all.
  cassandra: {
    label: "Apache Cassandra",
    reason:
      "Cassandra no longer supports altering a column's type; add a new column and migrate the values, or recreate the table.",
  },
  mongodb: {
    label: "MongoDB",
    reason: "Collections are schemaless, so there is no column definition to change.",
  },
  redis: {
    label: "Redis",
    reason: "Keys are not tables and have no column definitions to change.",
  },
  libredb: {
    label: "LibreDB",
    reason: "The embedded engine speaks a JSON command grammar, not SQL DDL.",
  },
  // Not "no column modification": see DATABEND_COLUMN_MODIFICATION_REASON for what was measured.
  databend: {
    label: "Databend",
    reason: DATABEND_COLUMN_MODIFICATION_REASON,
  },
  // Not a table store at all (#1085): a metric is whatever scrapes and recording rules write
  // under its name, and the HTTP API declares no column anywhere. The sentence is the one
  // `NO_TABLE_DDL` below prints when it declines the whole diff.
  prometheus: {
    label: "Prometheus",
    reason:
      "A metric is written by scrapes and recording rules, not declared with columns, so there is no column definition to change.",
  },
  // Not a table store either (#1088): a topic holds messages whose keys and values are bytes the
  // producers chose, and the broker declares no column anywhere; the columns the object browser
  // shows are the fixed shape of a read result. The sentence is the one `NO_TABLE_DDL` below
  // prints when it declines the whole diff.
  kafka: {
    label: "Apache Kafka",
    reason: "A topic holds messages, not rows with declared columns, so there is no column definition to change.",
  },
  // Not a table store either (#1089): a key's value is bytes, and a key-prefix group is derived from the
  // key space's shape rather than declared; the columns the object browser shows are the fixed shape of a
  // `get` row. The sentence is the one `NO_TABLE_DDL` below prints when it declines the whole diff.
  etcd: {
    label: "etcd",
    reason:
      "A key-prefix group holds keys whose values are bytes, not rows with declared columns, so there is no column definition to change.",
  },
  // Not a table store either: a label groups nodes, each carrying whatever properties it was written with,
  // and the columns the object browser shows are the property keys the server reports for that label. The
  // provider is read-only besides. The sentence is the one `NO_TABLE_DDL` below prints when it declines the
  // whole diff.
  neo4j: {
    label: "Neo4j",
    reason:
      "A node label groups nodes whose properties are not declared columns, so there is no column definition to change.",
  },
  // Not a table store either (vector-family spec 5.3): a collection's schema is declared through Milvus's own
  // collection API, and the columns the object browser shows are its fields. The sentence is the one
  // `NO_TABLE_DDL` below prints when it declines the whole diff.
  milvus: {
    label: "Milvus",
    reason:
      "A collection's schema is declared through Milvus's own collection API, not SQL DDL, so there is no column definition to change.",
  },
  // Not a table store either (vector-family spec 6.3): a collection holds points whose payloads are schemaless, and
  // the columns the object browser shows are its vectors, its payload indexes and a sample of its payload keys.
  // The sentence is the one `NO_TABLE_DDL` below prints when it declines the whole diff.
  qdrant: {
    label: "Qdrant",
    reason:
      "A collection's payloads are schemaless and its vectors are declared through Qdrant's own collection API, not SQL DDL, so there is no column definition to change.",
  },
  // Not a table store either: a measurement's tags and fields come into being with the points written to it, and
  // the provider is read-only. The sentence is the one `NO_TABLE_DDL` below prints when it declines the whole diff.
  influxdb: {
    label: "InfluxDB (InfluxQL)",
    reason:
      "A measurement's tags and fields are created by the points written to it, not declared with columns, so there is no column definition to change.",
  },
  // The same for InfluxDB 3, whose SQL is a read surface: the 3.x planner refuses DDL and DML. The sentence is the
  // one `NO_TABLE_DDL` below prints when it declines the whole diff.
  influxdb3: {
    label: "InfluxDB 3 (SQL)",
    reason:
      "A table's tags and fields are created by the line protocol written to it, and InfluxDB 3's SQL takes no DDL, so there is no column definition to change.",
  },
  // Not a table store either (SB2-4.3): a key holds opaque bytes, and the columns a read shows are a record's fixed
  // shape. The sentence is the one `NO_TABLE_DDL` below prints when it declines the whole diff.
  oxia: {
    label: "Oxia",
    reason:
      "Oxia stores opaque values under string keys and has no schema, so there is no column definition to change.",
  },
  // Not a table store either: an object is bytes under a key, and the columns a listing shows are its fixed
  // shape. The sentence is the one `NO_TABLE_DDL` below prints when it declines the whole diff.
  s3: {
    label: "S3-compatible object storage",
    reason: "S3 stores objects under keys with no schema, so there is no column definition to change.",
  },
};

/**
 * The dialects with no `IF EXISTS` on `DROP CONSTRAINT` or `DROP INDEX`, so a dropped foreign key or
 * index is written bare. Oracle has neither form; Db2 (#786) neither, measured on Db2 LUW 12.1.0.0:
 * `ALTER TABLE "C" DROP CONSTRAINT IF EXISTS "fk_c"` and `DROP INDEX IF EXISTS "ix_c"` are both
 * SQL0104N at `EXISTS`, while the bare statements run.
 */
const NO_DROP_IF_EXISTS: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["oracle", "db2"]);

/**
 * Canonical type ids whose migration text carries no transaction wrapper, because no
 * `BEGIN;` this generator could emit would be both valid and meaningful for them (#284).
 *
 * `sqlite` runs its own transaction, and `libsql` is SQLite - the same reasoning, with
 * one addition of its own: this provider closes its Hrana stream in the same request as
 * each statement, so a BEGIN it emitted could not be continued by the app that generated
 * the file. `cassandra` has no transaction at all - measured on 5.0.9, `BEGIN;` is "line
 * 1:5 mismatched input ';' expecting K_BATCH" and `COMMIT;` is "no viable alternative at
 * input 'COMMIT'". The only grouping CQL has is `BEGIN BATCH ... APPLY BATCH`, which is
 * not a transaction and takes no DDL, so there is nothing to translate the wrapper INTO -
 * it can only be left out. Unlike the other two, Cassandra's OTHER statements in this
 * generator were each measured against a live server too, so the wrapper would have been
 * the only unrunnable line in an otherwise runnable migration.
 *
 * The other nine are new, and each reuses a fact this module (or `src/lib/sql/grammar.ts`)
 * already established for a different fallback rather than asserting a fresh one:
 * `mongodb` and `redis` write no SQL text at all (`NON_SQL_DIALECTS` in `grammar.ts`), and
 * wrapping non-SQL command text in SQL statements is wrong regardless of Mongo's own
 * driver-level transaction API; `libredb` "speaks a JSON command grammar, not SQL DDL"
 * (`NO_COLUMN_MODIFICATION`'s own words); `couchbase` HAS distributed ACID transactions,
 * but spells one `BEGIN TRANSACTION` and answers with a `txid` that every following
 * statement has to carry as a request parameter (`docs/providers/couchbase.md` §13) - a
 * shape a flat migration file cannot express at all, so `BEGIN;` is both the wrong
 * keyword and the wrong mechanism; `druid` has no transaction concept to translate the
 * wrapper into ("Druid SQL has no ALTER TABLE", `NO_COLUMN_MODIFICATION`; a datasource is
 * rewritten by an MSQ task, not by a bracketed statement list); `elasticsearch` and
 * `opensearch` do not have `BEGIN` in their grammar at all - the parse error quoted in
 * `NO_COLUMN_MODIFICATION` lists every statement Elasticsearch SQL accepts and `BEGIN` is
 * not among them, and OpenSearch 3.8.0 was measured separately
 * (`docs/providers/opensearch.md` §9); `trino`'s transactional semantics are the CONNECTOR's answer, not a
 * property of Trino itself (`NO_COLUMN_MODIFICATION`), so no portable `BEGIN;`/`COMMIT;`
 * exists; and `clickhouse`'s transaction support is experimental and setting-gated rather
 * than a safe default — this set is what removes it from the wrapper it used to inherit.
 *
 * Oracle DDL commits implicitly and BEGIN opens a PL/SQL block, not a transaction.
 * Db2 (#786) is excluded for the Oracle reason: it has no standalone `BEGIN;`, and BEGIN opens a
 * compound SQL block.
 * SQL Server is handled separately with BEGIN TRANSACTION.
 *
 * `prometheus` (#1085) joined later, on the fact `mongodb` and `redis` already rest on: its
 * text is PromQL, not SQL (`NON_SQL_DIALECTS`). `NO_TABLE_DDL` declines its whole diff before
 * any wrapper is written, so this entry keeps the two sets agreeing rather than changing output.
 * `kafka` (#1088) joined on the same fact and for the same reason: its text is a JSON read
 * request, not SQL. `etcd` (#1089) joined the same way: its text is an etcdctl command line, and
 * `neo4j` too: its text is a Cypher statement, `milvus`: its text is a Milvus console request, and `qdrant`: its
 * text is a Qdrant console request. `influxdb` joined on the same fact: its text is an InfluxQL statement, and
 * `influxdb3` on `NO_TABLE_DDL`'s: its text is SQL, but the 3.x planner takes no DDL, so there is no table DDL
 * to wrap. `oxia` joined on the first fact: its text is one `oxia client` read command. `s3` joined on the first
 * fact: its text is one AWS CLI subset command.
 *
 * `databend` joined on the Oracle reason: Databend has `BEGIN`, `COMMIT` and `ROLLBACK`, but a DDL statement commits
 * the open transaction, so a `BEGIN;` around a migration made of DDL brackets nothing it could roll back.
 */
const NO_TRANSACTION_WRAPPER: ReadonlySet<DatabaseType> = new Set<DatabaseType>([
  "oracle",
  "db2",
  "sqlite",
  "libsql",
  "cassandra",
  "mongodb",
  "redis",
  "libredb",
  "couchbase",
  "druid",
  "clickhouse",
  "elasticsearch",
  "opensearch",
  "trino",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "influxdb",
  "influxdb3",
  "oxia",
  "databend",
  "s3",
]);

// These engines cannot apply a relational table diff through SQL. In particular,
// Couchbase has index/collection DDL, but no CREATE/ALTER TABLE column grammar.
// The reasons are already documented and tested by the modified-column path.
const NO_TABLE_DDL: ReadonlySet<DatabaseType> = new Set<DatabaseType>([
  "mongodb",
  "redis",
  "libredb",
  "couchbase",
  "druid",
  "elasticsearch",
  "opensearch",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "influxdb",
  "influxdb3",
  "oxia",
  "s3",
]);

// IndexDiff carries column names/uniqueness, not ClickHouse's index expression,
// kind and granularity. It also cannot distinguish its synthetic sorting-key rows.
// Trino has no index or foreign-key grammar (docs/providers/trino.md §3.8). Databend's indexes are search indexes of a
// named kind (DATABEND_INDEX_REFUSAL), and its constraints are CHECK only, so it declares no foreign key.
const NO_PORTABLE_INDEX_DDL: Partial<Record<DatabaseType, string>> = {
  clickhouse:
    "ClickHouse: Cannot generate index DDL. The diff does not record the index kind, expression or granularity; write the index change by hand.",
  trino: "Trino: Cannot generate index DDL. Indexes belong to the connector's underlying system, not Trino SQL.",
  databend: DATABEND_INDEX_REFUSAL,
};
const NO_FOREIGN_KEYS: Partial<Record<DatabaseType, string>> = {
  clickhouse: "ClickHouse",
  trino: "Trino",
  databend: "Databend",
};

/**
 * Canonical type ids whose CREATE TABLE has no primary-key constraint, so an added table's key is declined in a
 * comment after the statement rather than written into it. The comment names no key column. The value completes
 * `-- <label>: Cannot declare a primary key. <reason>`. Trino was the first, and its output is unchanged by the
 * move onto this record; Databend refuses every `PRIMARY KEY` form with 1005 (probe L11).
 */
const NO_PRIMARY_KEY_CONSTRAINT: Partial<Record<DatabaseType, { label: string; reason: string }>> = {
  trino: { label: "Trino", reason: "Trino SQL has no primary-key constraint." },
  databend: { label: "Databend", reason: DATABEND_PRIMARY_KEY_REASON },
};

// Object names are untrusted metadata. Quoting protects SQL identifiers, but a
// newline in a -- comment can start an executable statement outside that quote.
function commentName(name: string): string {
  return name.replace(/[\r\n\u2028\u2029]/g, " ");
}

/**
 * The text that goes after DEFAULT: the engine's own SQL where the provider measured it, and
 * the raw field otherwise.
 *
 * `targetDefault` is the VALUE the column defaults to, and a value is not SQL. Measured on
 * MariaDB 12.3.2: `CREATE TABLE t (note varchar(20) DEFAULT abc)` is ERROR 1054 (42S22)
 * Unknown column 'abc' in 'DEFAULT', while `DEFAULT 'abc'` is accepted. Dialects whose
 * provider declares no expression fall back to the raw field and are unchanged.
 *
 * Every caller gates on `=== undefined` and never on truthiness, because the empty string is
 * a default a column really has. `diffColumns` compares the same quantity by presence, so a
 * truthiness gate here would report a change the migration then silently does not carry.
 */
function defaultSql(col: ColumnDiff): string | undefined {
  return col.targetDefaultSql ?? col.targetDefault;
}

function generateColumnDef(col: ColumnDiff, dialect: DatabaseType): string {
  const type = col.targetType || col.sourceType || (dialect === "oracle" ? "VARCHAR2(255)" : "TEXT");
  // A CQL column definition is a name and a type, full stop. Measured on 5.0.9:
  // `name TEXT NOT NULL`, `name TEXT UNIQUE` and `name TEXT DEFAULT 'x'` are each
  // "no viable alternative at input" - none of the three qualifiers exists in the
  // grammar. Nullability is not a column property there (only a primary-key
  // component cannot be null) and there are no defaults at all.
  if (dialect === "cassandra") return `${escapeIdentifier(col.columnName, dialect)} ${type}`;
  const nullable = col.targetNullable === false ? " NOT NULL" : "";
  const defaultVal = defaultClause(col, dialect);
  // Oracle's column grammar puts DEFAULT before inline constraints such as NOT NULL.
  const modifiers = dialect === "oracle" ? `${defaultVal}${nullable}` : `${nullable}${defaultVal}`;
  return `${escapeIdentifier(col.columnName, dialect)} ${type}${modifiers}`;
}

/**
 * Why a Cassandra CREATE is refused here rather than emitted.
 *
 * A CQL primary key is two things at once: the partition key, which decides which node holds a row,
 * and the clustering columns, which order rows inside that partition. The brackets carry that
 * distinction and nothing else does. Measured on 5.0.9 with two probe tables that differ only in one
 * pair of them — `probe.composite_pk` is `PRIMARY KEY ((tenant, day), ts)`, `probe.pk_flat` is
 * `PRIMARY KEY (tenant, day, ts)`: `SELECT * FROM probe.pk_flat WHERE tenant = 'a'` is served, while
 * the same restriction on `probe.composite_pk` answers code 2200, "Cannot execute this query as it
 * might involve data filtering and thus may have unpredictable performance". So the two spellings are
 * different tables, not two ways of writing one.
 *
 * `system_schema.columns` distinguishes them by `kind` (`partition_key` vs `clustering`), but
 * `ColumnDiff` keeps only `targetIsPrimary` — both tables above reduce to the same three key columns —
 * so the bracketing is not recoverable from a diff and the shared `PRIMARY KEY (a, b, c)` serializer
 * below would silently pick the flat layout. Guessing the physical layout of a table is not a
 * cosmetic error, so this path declines the way the rest of the module declines: a comment naming the
 * limitation, which a human can read, instead of DDL that would run and be wrong.
 *
 * The provider already publishes `supportsCreateTable: false` (`sql/cassandra/index.ts`) for the
 * neighbouring reason — what `CreateTableModal` emits is not valid CQL — but `SchemaDiff.tsx` calls
 * this generator with the connection's type and never consults capabilities, so the refusal has to be
 * repeated here or the two contradict each other.
 */
const CASSANDRA_NO_CREATE_TABLE =
  "A CQL primary key splits into a partition key and clustering columns, and a schema diff records neither role, so the partitioning cannot be derived; write the CREATE TABLE by hand.";

/**
 * Canonical type ids whose grammar declares a foreign key ONLY as a `CREATE TABLE` table constraint,
 * with the label each one's comments carry. `sqlite` is the engine and `libsql` is a fork of it, so
 * the two answer identically; the labels are spelled out per id anyway, because a reader wants the
 * name of the engine they connected to (the same reason the neighbouring libSQL branches exist).
 *
 * SQLite's ALTER TABLE page enumerates every schema change the engine has - "rename table", "rename
 * column", "add column", "drop column", plus SET/DROP NOT NULL since 3.53.0 - and adding a constraint
 * is not among them; it routes such a change through its own 12-step table-recreation procedure.
 * Measured on sqlite3 3.53.3: `ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY
 * ("dept_id") REFERENCES "departments"("id")` is `near "FOREIGN": syntax error` - the parser has
 * already taken `CONSTRAINT` for a column name and the quoted name for its type - and the same
 * statement over Hrana on sqld 0.24.33 is `near CONSTRAINT ... syntax error`. Two tokens, one verdict.
 *
 * Both emission paths read this map and answer it DIFFERENTLY, which is the point of naming the fact
 * once (#515). `generateCreateTable` is building the table right there, so it moves the key
 * INSIDE the statement, where SQLite's grammar does take it; `generateAlterTable` has no such place
 * to put it and declines with a comment. Declining on both paths would throw away a key the engine
 * can perfectly well hold.
 */
const FOREIGN_KEY_ONLY_IN_CREATE_TABLE: Partial<Record<DatabaseType, { label: string; reason: string }>> = {
  sqlite: {
    label: "SQLite",
    reason: "A foreign key is declarable only as a CREATE TABLE constraint; recreate the table and copy the rows.",
  },
  libsql: {
    label: "libSQL",
    reason: "SQLite declares one only in CREATE TABLE; recreate the table and copy the rows.",
  },
  // Measured on DuckDB v1.5.5, both arms. The table constraint this map selects is
  // accepted and readable back - `CREATE TABLE "users" (..., PRIMARY KEY ("id"),
  // FOREIGN KEY ("dept_id") REFERENCES "departments"("id"))` lands, and
  // `duckdb_constraints()` then reports it. The trailing ALTER the other ids get is
  // NOT: `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` answers
  // "Not implemented Error: No support for that ALTER TABLE option yet!", which is
  // exactly what `generateAlterTable` already declines to emit for this id. Without
  // this entry the two halves disagreed: the created-table path emitted the very
  // statement the modified-table path documents as refused.
  duckdb: {
    label: "DuckDB",
    reason: "ALTER TABLE cannot add one yet; recreate the table and copy the rows.",
  },
};

function generateCreateTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  // Declined whole, indexes and foreign keys included: there would be no table for them to attach to.
  if (dialect === "cassandra") {
    return `-- Apache Cassandra: Cannot generate CREATE TABLE for ${commentName(id)}. ${CASSANDRA_NO_CREATE_TABLE}`;
  }

  const colDefs = table.columns.filter((c) => c.action === "added").map((c) => `  ${generateColumnDef(c, dialect)}`);

  // Add primary key constraint
  const pkCols = table.columns.filter((c) => c.targetIsPrimary).map((c) => escapeIdentifier(c.columnName, dialect));
  // An engine with no primary-key constraint gets the key declined in a comment instead (NO_PRIMARY_KEY_CONSTRAINT).
  const undeclarableKey = NO_PRIMARY_KEY_CONSTRAINT[dialect];
  const keyWritten = pkCols.length > 0 && undeclarableKey === undefined;

  // A key the target can only declare here has to be emitted here, so the closing paren is not
  // written until the constraint list is complete.
  const addedForeignKeys = table.foreignKeys.filter((fk) => fk.action === "added");
  const keyIsTableConstraint = FOREIGN_KEY_ONLY_IN_CREATE_TABLE[dialect] !== undefined;

  lines.push(`CREATE TABLE ${id} (`);
  lines.push(colDefs.join(",\n"));
  if (keyWritten) {
    lines.push(`,  PRIMARY KEY (${pkCols.join(", ")})`);
  }
  if (keyIsTableConstraint) {
    // SQLite's CREATE TABLE takes "one or more column definitions, optionally followed by a list of
    // table constraints", one of which is `FOREIGN KEY ( column-name, ... ) REFERENCES ...`. Hence
    // the position: after the columns AND after the PRIMARY KEY line, never before them - the same
    // constraint placed ahead of a column definition is `near "FOREIGN": syntax error` (measured on
    // sqlite3 3.53.3, where the form below is accepted and `PRAGMA foreign_key_list` then reports the
    // key).
    //
    // The `fk_<table>_<column>` name the other dialects carry is dropped rather than translated into
    // a `CONSTRAINT name` prefix, which SQLite would also accept: the name is this generator's own
    // invention rather than anything the diff recorded, and SQLite never reads a foreign key's name
    // back out - `PRAGMA foreign_key_list` has no name column - so it could only ever be write-only.
    addedForeignKeys.forEach((fk) => {
      lines.push(
        `,  FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)})`,
      );
    });
  }
  lines.push(");");
  if (pkCols.length > 0 && undeclarableKey !== undefined) {
    lines.push(`-- ${undeclarableKey.label}: Cannot declare a primary key. ${undeclarableKey.reason}`);
  }

  // Indexes, less the one the PRIMARY KEY line above already builds. An engine that reports
  // its key's index in the index list (PostgreSQL's `<table>_pkey`, MySQL's `PRIMARY`) creates
  // that index with the constraint, so emitting it again aborts the migration: measured on
  // PostgreSQL 18.6, `CREATE UNIQUE INDEX "ui_t_pkey"` after the CREATE TABLE is
  // `relation "ui_t_pkey" already exists` (#1395), and MySQL refuses an index named
  // `PRIMARY`. The index is recognised by what it is, a unique index over exactly the key's
  // columns, because its name is the engine's own choice. The columns are compared as a set,
  // since the PRIMARY KEY line is written in table order and `IndexDiff` carries no primary
  // flag; so a second unique index over the same columns, in any order, is skipped with it.
  const keyColumns = new Set(table.columns.filter((c) => c.targetIsPrimary).map((c) => c.columnName));
  const backsTheKey = (idx: IndexDiff): boolean => {
    const columns = idx.targetColumns ?? [];
    return (
      keyWritten &&
      idx.targetUnique === true &&
      columns.length === keyColumns.size &&
      columns.every((column) => keyColumns.has(column))
    );
  };
  table.indexes
    .filter((i) => i.action === "added" && !backsTheKey(i))
    .forEach((idx) => {
      const refusal = NO_PORTABLE_INDEX_DDL[dialect];
      if (refusal) {
        lines.push(`-- ${refusal}`);
        return;
      }
      const unique = idx.targetUnique ? "UNIQUE " : "";
      const cols = (idx.targetColumns || []).map((c) => escapeIdentifier(c, dialect)).join(", ");
      lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
    });

  // Foreign keys. Already emitted above for the ids that can only declare one inside the statement;
  // for everyone else this separate ALTER is the shape that has always been emitted here.
  if (!keyIsTableConstraint) {
    addedForeignKeys.forEach((fk) => {
      const label = NO_FOREIGN_KEYS[dialect];
      if (label) {
        lines.push(`-- ${label}: Cannot add a foreign key. The engine has no foreign-key constraint.`);
        return;
      }
      lines.push(
        `ALTER TABLE ${id} ADD CONSTRAINT ${escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect)} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)});`,
      );
    });
  }

  return lines.join("\n");
}

function generateDropTable(table: TableDiff, dialect: DatabaseType): string {
  const conditional = dialect === "oracle" ? "" : " IF EXISTS";
  return `DROP TABLE${conditional} ${escapeIdentifier(table.tableName, dialect)};`;
}

function generateAlterTable(table: TableDiff, dialect: DatabaseType): string {
  const lines: string[] = [];
  const id = escapeIdentifier(table.tableName, dialect);

  lines.push(`-- Alter table: ${commentName(table.tableName)}`);

  // Drop recorded dependencies before altering their columns or reusing their names.
  // Removed foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "removed")
    .forEach((fk) => {
      const label = NO_FOREIGN_KEYS[dialect];
      if (label) {
        lines.push(`-- ${label}: Cannot drop a foreign key. The engine has no foreign-key constraint.`);
        return;
      }
      const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
      if (dialect === "mysql") {
        lines.push(`ALTER TABLE ${id} DROP FOREIGN KEY ${constraintName};`);
      } else if (dialect === "sqlite") {
        lines.push(`-- SQLite: Cannot drop foreign key directly. Requires table recreation.`);
      } else if (dialect === "libsql") {
        // The generic `DROP CONSTRAINT` branch below is not parseable here, measured on
        // sqld 0.24.33: `ALTER TABLE t DROP CONSTRAINT fk_x` is "near CONSTRAINT …
        // syntax error". Same limit as SQLite, named separately so the comment names
        // the engine the reader connected to.
        lines.push(`-- libSQL: Cannot drop a foreign key directly. Requires table recreation.`);
      } else if (dialect === "duckdb") {
        // The generic branch below is refused here too, measured on v1.5.5: `ALTER
        // TABLE t DROP CONSTRAINT IF EXISTS fk_x` is "Not implemented Error: No
        // support for that ALTER TABLE option yet!" - and a `Not implemented` is not
        // an `IF EXISTS` no-op, so the line would fail a migration rather than skip.
        lines.push(`-- DuckDB: Cannot drop a foreign key directly. Requires table recreation.`);
      } else if (dialect === "cassandra") {
        // `DROP CONSTRAINT IF EXISTS fk_x` is "mismatched input 'IF' expecting EOF"
        // (measured), and dropping what was never declarable is not a statement.
        lines.push(`-- Apache Cassandra: Cannot drop a foreign key. CQL never declared one.`);
      } else if (NO_DROP_IF_EXISTS.has(dialect)) {
        lines.push(`ALTER TABLE ${id} DROP CONSTRAINT ${constraintName};`);
      } else {
        lines.push(`ALTER TABLE ${id} DROP CONSTRAINT IF EXISTS ${constraintName};`);
      }
    });

  // Changed indexes need replacement too. Drop the old definition before column
  // changes, then recreate it with the target columns and uniqueness below.
  table.indexes
    .filter((i) => i.action === "removed" || i.action === "modified")
    .forEach((idx) => {
      const refusal = NO_PORTABLE_INDEX_DDL[dialect];
      if (refusal) {
        lines.push(`-- ${refusal}`);
        return;
      }
      if (dialect === "mysql") {
        lines.push(`DROP INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id};`);
      } else if (dialect === "mssql") {
        lines.push(`DROP INDEX IF EXISTS ${escapeIdentifier(idx.indexName, dialect)} ON ${id};`);
      } else if (NO_DROP_IF_EXISTS.has(dialect)) {
        lines.push(`DROP INDEX ${escapeIdentifier(idx.indexName, dialect)};`);
      } else {
        lines.push(`DROP INDEX IF EXISTS ${escapeIdentifier(idx.indexName, dialect)};`);
      }
    });

  // Added columns
  table.columns
    .filter((c) => c.action === "added")
    .forEach((col) => {
      // CQL spells it without the COLUMN keyword, measured on 5.0.9: `ADD COLUMN extra
      // TEXT` is "line 1:42 mismatched input 'TEXT' expecting EOF" while `ADD extra
      // text` succeeds.
      const definition = generateColumnDef(col, dialect);
      if (dialect === "oracle") {
        lines.push(`ALTER TABLE ${id} ADD (${definition});`);
      } else {
        const keyword = dialect === "cassandra" || dialect === "mssql" ? "ADD" : "ADD COLUMN";
        lines.push(`ALTER TABLE ${id} ${keyword} ${definition};`);
      }
    });

  // Removed columns
  table.columns
    .filter((c) => c.action === "removed")
    .forEach((col) => {
      if (dialect === "sqlite") {
        lines.push(
          `-- SQLite: Cannot drop column "${commentName(col.columnName)}" directly. Requires table recreation.`,
        );
      } else {
        // Same measurement in the other direction: `DROP COLUMN extra` is "mismatched
        // input 'extra' expecting EOF" on CQL, while `DROP extra` succeeds.
        const keyword = dialect === "cassandra" ? "DROP" : "DROP COLUMN";
        lines.push(`ALTER TABLE ${id} ${keyword} ${escapeIdentifier(col.columnName, dialect)};`);
      }
    });

  // Modified columns
  const inexpressible = NO_COLUMN_MODIFICATION[dialect];
  table.columns
    .filter((c) => c.action === "modified")
    .forEach((col) => {
      if (dialect === "sqlite") {
        lines.push(
          `-- SQLite: Cannot alter column "${commentName(col.columnName)}" type directly. Requires table recreation.`,
        );
      } else if (dialect === "mysql") {
        const type = col.targetType || col.sourceType || "TEXT";
        const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
        const declaredDefault = defaultSql(col);
        const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
        lines.push(
          `ALTER TABLE ${id} MODIFY COLUMN ${escapeIdentifier(col.columnName, dialect)} ${type}${nullable}${defaultVal};`,
        );
      } else if (dialect === "oracle") {
        const type = col.targetType || col.sourceType || "VARCHAR2(255)";
        // Oracle refuses a nullability the column already has (#1240): a type change that
        // restates ` NULL` on a nullable column is ORA-01451, and the column keeps its old type.
        // So the clause is written only when the nullability changes.
        const nullable =
          col.sourceNullable === col.targetNullable ? "" : col.targetNullable === false ? " NOT NULL" : " NULL";
        const declaredDefault = defaultSql(col);
        const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
        lines.push(
          `ALTER TABLE ${id} MODIFY (${escapeIdentifier(col.columnName, dialect)} ${type}${defaultVal}${nullable});`,
        );
      } else if (dialect === "mssql") {
        const type = col.targetType || col.sourceType || "NVARCHAR(MAX)";
        const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
        lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} ${type}${nullable};`);
        const declaredDefault = defaultSql(col);
        if (col.sourceDefault !== col.targetDefault && declaredDefault !== undefined) {
          lines.push(
            `ALTER TABLE ${id} ADD DEFAULT ${declaredDefault} FOR ${escapeIdentifier(col.columnName, dialect)};`,
          );
        }
      } else if (dialect === "clickhouse") {
        // Nullability is part of the type here (`Nullable(T)`) — which is exactly what this
        // provider's introspection reports (`clickhouse/introspect.ts`) — so restating the declared
        // type covers a nullability change too; there is no `SET NOT NULL`. Dropping a default needs
        // the explicit `REMOVE <kind>` form: omitting the clause leaves the old default in place
        // (live-probed). See CLICKHOUSE_DEFAULT_KINDS for the kind vocabulary and its traps.
        const column = escapeIdentifier(col.columnName, dialect);
        const type = col.targetType || col.sourceType || "String";
        const declared = defaultClause(col, dialect);
        lines.push(`ALTER TABLE ${id} MODIFY COLUMN ${column} ${type}${declared};`);
        if (col.sourceDefault && defaultSql(col) === undefined) {
          const kind = clickhouseDefaultKind(col.sourceDefault);
          if (CLICKHOUSE_REMOVABLE_KINDS.includes(kind)) {
            lines.push(`ALTER TABLE ${id} MODIFY COLUMN ${column} REMOVE ${kind};`);
          } else {
            lines.push(
              `-- ClickHouse: Cannot remove the ${kind} property of column "${commentName(col.columnName)}". REMOVE accepts DEFAULT, MATERIALIZED or ALIAS only; recreate the column.`,
            );
          }
        }
      } else if (inexpressible) {
        lines.push(
          `-- ${inexpressible.label}: Cannot alter column "${commentName(col.columnName)}". ${inexpressible.reason}`,
        );
      } else {
        // PostgreSQL
        if (col.sourceType !== col.targetType) {
          lines.push(
            `ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} TYPE ${col.targetType};`,
          );
        }
        if (col.sourceNullable !== col.targetNullable) {
          if (col.targetNullable) {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP NOT NULL;`);
          } else {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET NOT NULL;`);
          }
        }
        if (col.sourceDefault !== col.targetDefault) {
          const declaredDefault = defaultSql(col);
          if (declaredDefault !== undefined) {
            lines.push(
              `ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} SET DEFAULT ${declaredDefault};`,
            );
          } else {
            lines.push(`ALTER TABLE ${id} ALTER COLUMN ${escapeIdentifier(col.columnName, dialect)} DROP DEFAULT;`);
          }
        }
      }
    });

  // Added and replaced indexes
  table.indexes
    .filter((i) => i.action === "added" || i.action === "modified")
    .forEach((idx) => {
      const refusal = NO_PORTABLE_INDEX_DDL[dialect];
      if (refusal) {
        lines.push(`-- ${refusal}`);
        return;
      }
      const unique = idx.targetUnique ? "UNIQUE " : "";
      const cols = (idx.targetColumns || []).map((c) => escapeIdentifier(c, dialect)).join(", ");
      lines.push(`CREATE ${unique}INDEX ${escapeIdentifier(idx.indexName, dialect)} ON ${id} (${cols});`);
    });

  // Added foreign keys
  table.foreignKeys
    .filter((fk) => fk.action === "added")
    .forEach((fk) => {
      const label = NO_FOREIGN_KEYS[dialect];
      if (label) {
        lines.push(`-- ${label}: Cannot add a foreign key. The engine has no foreign-key constraint.`);
        return;
      }
      const constraintName = escapeIdentifier(`fk_${table.tableName}_${fk.columnName}`, dialect);
      // Cassandra has no foreign key to add: `ADD CONSTRAINT ... FOREIGN KEY` is
      // "mismatched input 'FOREIGN' expecting EOF" (measured on 5.0.9), which is also
      // why the provider reports `declaresForeignKeys: false`. This branch exists
      // because that report does not reach here: `SchemaDiff.tsx` reads the dialect
      // from the current connection and the diff from a snapshot that may be another
      // connection's, so a relational schema's keys arrive with a CQL dialect.
      if (dialect === "cassandra") {
        lines.push(
          `-- Apache Cassandra: Cannot add a foreign key on ${commentName(escapeIdentifier(fk.columnName, dialect))}. The clause is not in CQL's grammar; enforce the relationship in the application.`,
        );
        return;
      }
      // No ALTER adds a foreign key on these ids, so the honest line names the table recreation
      // instead (see FOREIGN_KEY_ONLY_IN_CREATE_TABLE for the three measurements). For `sqlite` and
      // `libsql` it is SQLite's grammar; for `duckdb` it is a refusal at execution -
      // `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` parses and then answers
      // "Not implemented Error: No support for that ALTER TABLE option yet!" (v1.5.5), as does the
      // UNIQUE form, while `ADD CONSTRAINT ... PRIMARY KEY` is the one arm that lands. Unlike the
      // created-table path, there is nothing to move the key into: the table already exists, and
      // this generator does not write the recreation.
      const declined = FOREIGN_KEY_ONLY_IN_CREATE_TABLE[dialect];
      if (declined) {
        lines.push(
          `-- ${declined.label}: Cannot add a foreign key on ${commentName(escapeIdentifier(fk.columnName, dialect))}. ${declined.reason}`,
        );
        return;
      }
      lines.push(
        `ALTER TABLE ${id} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${escapeIdentifier(fk.columnName, dialect)}) REFERENCES ${escapeIdentifier(fk.targetReferencedTable || "", dialect)}(${escapeIdentifier(fk.targetReferencedColumn || "", dialect)});`,
      );
    });

  return lines.join("\n");
}

export function generateMigrationSQL(diff: SchemaDiff, dialect: DatabaseType): string {
  if (!diff.hasChanges) {
    return "-- No schema changes detected.";
  }

  const sections: string[] = [];
  sections.push(`-- Migration generated at ${new Date().toISOString()}`);
  sections.push(`-- Dialect: ${dialect}`);
  sections.push(
    `-- Changes: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.modified} modified`,
  );
  sections.push("");

  if (NO_TABLE_DDL.has(dialect)) {
    const limitation = NO_COLUMN_MODIFICATION[dialect]!;
    sections.push(`-- ${limitation.label}: Cannot generate table DDL. ${limitation.reason}`);
    return sections.join("\n");
  }

  // ONE definition, read twice: the opening and the closing halves of this wrapper used
  // to be two independent conditions, which is a shape that can diverge into a `BEGIN;`
  // with no `COMMIT;`. See NO_TRANSACTION_WRAPPER for why each excluded id is excluded.
  const wrapsInTransaction = !NO_TRANSACTION_WRAPPER.has(dialect);

  if (wrapsInTransaction) {
    sections.push(dialect === "mssql" ? "BEGIN TRANSACTION;" : "BEGIN;");
    sections.push("");
  }

  // Drop tables first (reverse dependency order)
  const droppedTables = diff.tables.filter((t) => t.action === "removed");
  if (droppedTables.length > 0) {
    sections.push("-- Drop removed tables");
    droppedTables.forEach((t) => sections.push(generateDropTable(t, dialect)));
    sections.push("");
  }

  // Create new tables
  const addedTables = diff.tables.filter((t) => t.action === "added");
  if (addedTables.length > 0) {
    sections.push("-- Create new tables");
    addedTables.forEach((t) => {
      sections.push(generateCreateTable(t, dialect));
      sections.push("");
    });
  }

  // Alter existing tables
  const modifiedTables = diff.tables.filter((t) => t.action === "modified");
  if (modifiedTables.length > 0) {
    sections.push("-- Modify existing tables");
    modifiedTables.forEach((t) => {
      sections.push(generateAlterTable(t, dialect));
      sections.push("");
    });
  }

  if (wrapsInTransaction) {
    sections.push("COMMIT;");
  }

  return sections.join("\n");
}
