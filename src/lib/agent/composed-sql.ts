/**
 * The SQL the SERVER composes for an agent run (#329, epic #325; planning decision P1).
 *
 * Two of the M2 tools do not take a statement from the model at all. A catalog
 * inspection takes a structured selector and a plan inspection takes the statement
 * it is about; in both cases the statement that reaches the database is written
 * here, per dialect. That is what lets a schema read BE the canonical bounded read
 * (`sql.query.read`) instead of needing a fourth operation descriptor, which the
 * epic pinned shut.
 *
 * Three constraints shape every string below:
 *
 * 1. **The composed statement must satisfy the M1 input guard**, or the tool can
 *    never run. That rules out more than it looks like: `statement-guard.ts`
 *    refuses any word beginning `PRAGMA_`, so SQLite's `pragma_table_info()`
 *    table-valued function — the obvious way to read a column list there — is
 *    unavailable, and the SQLite catalog read goes through `sqlite_master`
 *    instead. The asymmetry is real and documented on the tool: PostgreSQL yields
 *    a structured column inventory, SQLite yields each object's own DDL text.
 * 2. **The profiled providers bind nothing.** `queryReadOnly(sql, budget)` takes no
 *    parameters (`postgres.ts`, `sqlite.ts`), so a selector cannot be bound and has
 *    to be quoted with the shared `quoteLiteral`. Selectors are therefore validated
 *    here as well as quoted — see `assertSelector` for the one character that is
 *    refused rather than quoted, and why.
 * 3. **No dialect is served on a guess.** Both maps are looked up with
 *    `Object.hasOwn`, and an unlisted dialect is refused. A composition that has
 *    not been checked against that engine's catalog and its EXPLAIN grammar is not
 *    a fallback, it is a statement nobody verified.
 *
 * On the plan side: the composed form is the ESTIMATING one on both engines, never
 * the executing one. `src/lib/explain`'s PostgreSQL strategy is deliberately not
 * reused for this — its `buildSql` ignores the `mode` argument and always emits
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, which RUNS the statement it explains.
 * That is correct for the editor's Explain button (a user asked for real timings)
 * and exactly wrong here, where the approval-gated `sql.explain.analyze` descriptor
 * is the only thing allowed to execute a plan. Teaching the strategy registry to
 * honour its own mode argument is a separate, editor-visible change (#194).
 */

import { quoteLiteral } from "@/lib/sql/values";
import type { DatabaseType } from "@/lib/types";

export type AgentComposedSqlDenyCode =
  /** This milestone has verified a composition for PostgreSQL and SQLite only. */
  | "UNSUPPORTED_DIALECT"
  /** Blank, over-long, or carrying a character that cannot be safely quoted. */
  | "INVALID_SELECTOR"
  /** A well-formed selector that has no meaning for this engine. */
  | "SELECTOR_UNSUPPORTED_BY_DIALECT"
  /** Nothing to explain. */
  | "INVALID_STATEMENT";

/**
 * Raised when no statement can honestly be composed. The tool layer maps it to a
 * typed tool outcome; it is never surfaced as a database failure, because no
 * database was reached.
 */
export class AgentComposedSqlError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: AgentComposedSqlDenyCode,
  ) {
    super(message);
    this.name = "AgentComposedSqlError";
    Object.setPrototypeOf(this, AgentComposedSqlError.prototype);
  }
}

/**
 * The widest identifier limit among the engines this repository serves (Oracle's
 * 128; PostgreSQL's is 63 and MySQL's 64). A selector longer than any engine could
 * name is not a narrowing request, and bounding it keeps a multi-megabyte string
 * out of a composed statement.
 */
export const MAX_CATALOG_SELECTOR_LENGTH = 128;

/**
 * Which inventory a catalog read asks for.
 *
 * Four kinds rather than one wide statement, because the engines do not agree on
 * how many reads the inventory takes and a single composed monster would have to be
 * verified per dialect anyway. Each kind is one bounded read (`sql.query.read`)
 * under the same descriptor, so the split costs statements out of the run's budget
 * and buys nothing in privilege — which is exactly the trade the row cap forces:
 * one flat projection per kind stays diagnosable when it overflows, where a nested
 * aggregate would come back as one unreadable row-per-table blob.
 *
 * `statistics` is the newest and the only one whose values are ESTIMATES: it reads
 * what the engine already recorded about table sizes and column distributions, and
 * computes nothing. See `composePostgresStatistics` / `composeSqliteStatistics` for
 * what each engine actually holds and for what it does not hold at all.
 */
export type AgentCatalogKind = "columns" | "relations" | "indexes" | "statistics";

export interface AgentCatalogSelector {
  /** Defaults to the column inventory, which is what a bare `inspect_schema` means. */
  readonly kind?: AgentCatalogKind;
  readonly schema?: string;
  readonly table?: string;
}

/**
 * SQLite's only schema for a profiled provider. The read-only profile opens one
 * file and attaching another is refused at the input stage, so `main` is not merely
 * the default — it is the whole set.
 */
const SQLITE_ONLY_SCHEMA = "main";

/**
 * Validates one selector value and returns it.
 *
 * The backslash refusal is not decoration. `spans.ts` reads a single-quoted literal
 * with backslash escapes under the dialect-less grammar the guard uses, so a value
 * ending in a backslash makes the closing quote look escaped and the whole
 * composed statement reads as `UNDETERMINABLE_TEXT`. The statement would then be
 * refused anyway — this path fails closed either way — but it would be refused with
 * a reason that describes the composition rather than the input. Refusing here
 * names the actual cause, which is the difference between a model that can fix its
 * request and one that cannot.
 *
 * ANY backslash is refused, not only a trailing one, and that is deliberately wider
 * than the reasoning above requires: an interior backslash IS settleable (`'a\b'`
 * reads as a terminated literal and the guard admits the composed statement), so an
 * object genuinely named `a\b` cannot be selected. Separating the two cases would buy
 * that one name back at the cost of a rule whose boundary depends on where in the
 * string the character sits — and a selector is a name a caller can also reach by
 * narrowing to its schema instead. The wide rule is the one that stays true if the
 * grammar's escape handling is ever revisited (`docs/BACKLOG.md` S2).
 */
function assertSelector(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new AgentComposedSqlError(`catalog selector "${field}" must be a non-empty name`, "INVALID_SELECTOR");
  }
  if (trimmed.length > MAX_CATALOG_SELECTOR_LENGTH) {
    throw new AgentComposedSqlError(
      `catalog selector "${field}" is longer than ${MAX_CATALOG_SELECTOR_LENGTH} characters`,
      "INVALID_SELECTOR",
    );
  }
  if (trimmed.includes("\\")) {
    throw new AgentComposedSqlError(
      `catalog selector "${field}" carries a backslash, which no dialect-less reading of a quoted literal settles`,
      "INVALID_SELECTOR",
    );
  }
  return trimmed;
}

/** `AND <column> = '<value>'`, or nothing when the selector is absent. */
function equalsClause(column: string, value: string | undefined, field: string, dialect: DatabaseType): string {
  if (value === undefined) return "";
  return ` AND ${column} = ${quoteLiteral(assertSelector(value, field), dialect)}`;
}

function composePostgresCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position " +
    "FROM information_schema.columns " +
    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')" +
    equalsClause("table_schema", selector.schema, "schema", "postgres") +
    equalsClause("table_name", selector.table, "table", "postgres") +
    " ORDER BY table_schema, table_name, ordinal_position"
  );
}

/**
 * The foreign-key inventory.
 *
 * `pg_constraint` and not the `information_schema` constraint views, and the reason
 * is a privilege rule rather than taste: PostgreSQL restricts `table_constraints`,
 * `key_column_usage` and `constraint_column_usage` to constraints on tables the
 * calling role OWNS or holds a privilege on other than `SELECT`. The least-privilege
 * role `docs/AGENT_DEMO.md` tells operators to create holds `SELECT` and nothing
 * else, so those views answered NOTHING for it — measured on the seeded dvdrental as
 * `libredb_agent`: 0 rows where `pg_constraint WHERE contype = 'f'` holds 18, and a
 * run then reported that the database declares no foreign keys. `pg_constraint` needs
 * only `USAGE` on the schema, and answers all 18. What the rewrite cannot reach is that
 * ANY role can be narrower than its database, so the relations block declines to report
 * an absence from an empty read at all — see `er-diagram.ts`.
 *
 * The same rewrite is what pairs a composite key. Neither view exposes an ordinal,
 * so `FOREIGN KEY (x, y) REFERENCES parents (a, b)` came back as the cross-product
 * of the two column lists; `unnest(conkey, confkey) WITH ORDINALITY` unnests the two
 * arrays TOGETHER, so position 1 of one side meets position 1 of the other and
 * nothing else. And it closes the collision underneath: a constraint NAME is unique
 * per table, so two tables in one schema may both carry `fk_shared` and the
 * referenced side could not be narrowed by table at all — `constraint_column_usage`
 * exposes no referencing table. A `pg_constraint` row carries `conrelid` and
 * `confrelid` on itself and is never matched by name.
 *
 * Both defects compounded rather than sitting side by side, which is why they were
 * fixed together: on a fixture holding a composite key and a second constraint of
 * the same name, the old joins returned NINE rows — three right — and gave one table
 * edges to a table its own constraint never mentions. This read returns the three.
 *
 * The output column names are the ones `buildPostgresTables` already reads, so the
 * fold consuming these rows is unchanged. The projection stays flat — one row per
 * referencing COLUMN — because the row cap refuses rather than truncates, and a flat
 * overflow is diagnosable where a nested aggregate's is not.
 */
function composePostgresRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT rn.nspname AS table_schema, rel.relname AS table_name, att.attname AS column_name, " +
    "fn.nspname AS referenced_schema, frel.relname AS referenced_table, fatt.attname AS referenced_column " +
    "FROM pg_constraint c " +
    "JOIN pg_class rel ON rel.oid = c.conrelid " +
    "JOIN pg_namespace rn ON rn.oid = rel.relnamespace " +
    "JOIN pg_class frel ON frel.oid = c.confrelid " +
    "JOIN pg_namespace fn ON fn.oid = frel.relnamespace " +
    "JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) ON true " +
    "JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum " +
    "JOIN pg_attribute fatt ON fatt.attrelid = c.confrelid AND fatt.attnum = k.fattnum " +
    "WHERE c.contype = 'f' AND rn.nspname NOT IN ('pg_catalog', 'information_schema')" +
    equalsClause("rn.nspname", selector.schema, "schema", "postgres") +
    equalsClause("rel.relname", selector.table, "table", "postgres") +
    " ORDER BY rn.nspname, rel.relname, k.ord"
  );
}

/**
 * The index inventory, one row per indexed KEY POSITION.
 *
 * `indisprimary` rides along because it is the only place on this path that says
 * which columns are the primary key: `information_schema.columns` does not carry
 * it, and asking for it separately would be a fourth read out of a twenty-statement
 * budget. The order is the INDEX's own and not the table's, which is what makes a
 * composite index readable.
 *
 * Unnested WITH ORDINALITY rather than joined on `attnum = ANY(indkey)`, because an
 * EXPRESSION has no attribute to match: `indkey` stores 0 for it, so the old inner
 * join dropped `CREATE INDEX … ON t (lower(name))` from the inventory entirely and
 * returned `(status, lower(name))` carrying only `status` — which a reader could take
 * for an index on `status` alone (`docs/BACKLOG.md` B7). Every key position is now a
 * row, and `pg_get_indexdef(indexrelid, n, true)` names what sits in position n. That
 * is the shape the SQLite side already produces: `parseSqliteIndexDdl` keeps an
 * expression's written form in the same column list as the plain names, so both
 * dialects hand the fold the same thing and it needs no change for either. The
 * ordinal also replaces `array_position(indkey, attnum)`, which could not order two
 * positions holding the same expression marker.
 *
 * `att.attname` still wins where there IS an attribute, and that is not decoration.
 * `pg_get_indexdef` emits an identifier as PostgreSQL would have to WRITE it, so a
 * mixed-case column comes back as `"userId"`, quotes included — measured — and that
 * string matches no name in the column inventory, which is what the index's column
 * list and `markPrimary` are compared against. So the expression form reaches the
 * snapshot and the plain names stay exactly what they were.
 *
 * ONE KNOWN LIMITATION REMAINS, about what the inventory SAYS rather than about what
 * may run: `indkey` carries a covering index's `INCLUDE` columns after its key
 * columns (PostgreSQL 11+, where `indnkeyatts` is what separates them), so those
 * appear here as if they were key columns. Left as it is rather than sliced by
 * `indnkeyatts`: that column does not exist on older servers.
 */
function composePostgresIndexes(selector: AgentCatalogSelector): string {
  return (
    "SELECT n.nspname AS table_schema, t.relname AS table_name, i.relname AS index_name, " +
    "ix.indisunique AS is_unique, ix.indisprimary AS is_primary, " +
    "COALESCE(att.attname, pg_get_indexdef(ix.indexrelid, k.ord::int, true)) AS column_name " +
    "FROM pg_index ix " +
    "JOIN pg_class t ON t.oid = ix.indrelid " +
    "JOIN pg_class i ON i.oid = ix.indexrelid " +
    "JOIN pg_namespace n ON n.oid = t.relnamespace " +
    "JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true " +
    "LEFT JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = k.attnum " +
    "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')" +
    equalsClause("n.nspname", selector.schema, "schema", "postgres") +
    equalsClause("t.relname", selector.table, "table", "postgres") +
    " ORDER BY n.nspname, t.relname, i.relname, k.ord"
  );
}

/**
 * The statistics inventory: what the engine already believes, never what a scan
 * would prove.
 *
 * `pg_class.reltuples` and `pg_stats` are catalog reads. Nothing here counts, so
 * the cost does not grow with the table — which is the property that lets a plan
 * run be pointed at production, and the reason `COUNT(DISTINCT col)` (the honest
 * way to get the same numbers) is refused by the design rather than merely
 * unimplemented.
 *
 * FOUR things a consumer of these rows must not read as more than they are, all of
 * them consequences of the source rather than of this projection:
 *
 *  - **`reltuples` is an estimate, and `-1` means "never counted".** PostgreSQL 14+
 *    initialises it to -1 for a relation that has been neither `VACUUM`ed nor
 *    `ANALYZE`d; older servers left it at 0, which is indistinguishable from an
 *    empty table. A reader that prints -1 as a row count states a falsehood.
 *  - **`n_distinct` is NEGATIVE when it is a ratio.** PostgreSQL stores `-k` to mean
 *    "k * reltuples distinct values" (so -1 is a unique column) when the estimated
 *    count scales with the table. The conversion is deliberately NOT done here: it
 *    needs `reltuples`, which is itself an estimate that may be -1, and a converted
 *    number emitted under the name `n_distinct` would be a derived value wearing the
 *    raw one's name. Both columns go out raw and the reader converts and LABELS the
 *    result as derived (work item 2).
 *  - **A never-analysed table has no `pg_stats` rows at all**, which is why the join
 *    is a LEFT JOIN from `pg_class`. The table then appears once with every
 *    statistics column NULL — present and unknown, rather than absent. An inner join
 *    would omit it, and silence reads as zero.
 *  - **`pg_stats` is permission-filtered.** It is a view over `pg_statistic` that
 *    returns rows only for tables the calling role may read, so a least-privilege
 *    agent role sees "no statistics" for a table it cannot select from — the same
 *    shape as never analysed, and not distinguishable from here.
 *
 * `relkind` is restricted to ordinary (`r`) and partitioned (`p`) tables: those are
 * the relkinds `pg_stats` describes and that a plan's row estimates come from. A
 * view has no statistics of its own, and including one would add a row whose every
 * statistic is NULL for a reason unrelated to `ANALYZE`.
 */
function composePostgresStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT n.nspname AS table_schema, c.relname AS table_name, c.reltuples AS estimated_rows, " +
    "s.attname AS column_name, s.n_distinct AS n_distinct, s.null_frac AS null_frac " +
    "FROM pg_class c " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname " +
    "WHERE c.relkind IN ('r', 'p') " +
    "AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')" +
    equalsClause("n.nspname", selector.schema, "schema", "postgres") +
    equalsClause("c.relname", selector.table, "table", "postgres") +
    " ORDER BY n.nspname, c.relname, s.attname"
  );
}

/**
 * SQLite serves one schema, and a selector naming another is refused rather than
 * quietly read as `main`.
 */
function assertSqliteSchema(selector: AgentCatalogSelector): void {
  if (selector.schema === undefined) return;
  const schema = assertSelector(selector.schema, "schema");
  if (schema.toLowerCase() !== SQLITE_ONLY_SCHEMA) {
    throw new AgentComposedSqlError(
      `SQLite serves one schema on the agent path ("${SQLITE_ONLY_SCHEMA}"), so "${schema}" cannot be selected`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  // `main` needs no clause: sqlite_master IS main's catalog, so filtering on it
  // would be a no-op dressed up as a narrowing.
}

function composeSqliteCatalog(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT name, type, sql FROM sqlite_master " +
    // The escape character is `@` rather than a backslash on purpose: `'\'` is the
    // literal the dialect-less span reader cannot settle (see `assertSelector`).
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("name", selector.table, "table", "sqlite") +
    " ORDER BY type, name"
  );
}

/**
 * SQLite's index inventory.
 *
 * `sql IS NOT NULL` is what excludes the indexes SQLite creates for a `UNIQUE` or
 * `PRIMARY KEY` constraint: they carry no DDL text at all, so an inventory that
 * kept them would list an index nothing can describe. Their columns are not lost —
 * the constraint that created them is in the table's own DDL, which the object read
 * returns. The `sqlite_` name filter stays as a second line for the same objects.
 *
 * The selector narrows on `tbl_name` (the indexed TABLE), not on `name`: a caller
 * asking about a table wants that table's indexes, and nobody knows an index's name
 * before reading the inventory.
 */
function composeSqliteIndexes(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT name, tbl_name, sql FROM sqlite_master " +
    "WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("tbl_name", selector.table, "table", "sqlite") +
    " ORDER BY tbl_name, name"
  );
}

/**
 * SQLite's statistics inventory, from `sqlite_stat1`.
 *
 * `ANALYZE` writes one row per INDEX, whose `stat` column is a space-separated list
 * of integers: the first is the number of rows in the table, and each one after it
 * is the average number of rows matching an equal prefix of the index's columns. So
 * the row estimate and a per-index-prefix distinctness estimate are both derivable
 * from that string — by the reader, which is where the parsing and the labelling
 * belong — and a NULL FRACTION IS NOT AVAILABLE AT ALL on this engine. The reader
 * must report it absent rather than assume zero.
 *
 * The join direction is the load-bearing part, and it is verified against a live
 * engine in the tests rather than reasoned about:
 *
 *  - driving from `sqlite_master` with a LEFT JOIN keeps every table in the
 *    inventory, including one SQLite holds no statistics for. That is not a rare
 *    case: `ANALYZE` writes NOTHING for a table with no indexes, so an inner join
 *    would silently omit exactly the tables whose sizes are least known.
 *  - the estimate is therefore per index, not per column. This engine has no
 *    per-column distribution to read.
 *
 * WHY A SEPARATE PROBE, and not a self-guarding statement: `sqlite_stat1` does not
 * exist until an explicit `ANALYZE` has run, and SQLite resolves table names when it
 * PREPARES a statement. So there is no single statement that reads the table when it
 * is there and returns nothing when it is not — a `WHERE EXISTS (SELECT … FROM
 * sqlite_master …)` guard still mentions `sqlite_stat1` in a FROM clause and still
 * fails to prepare with `no such table`. The sqlite_master check is therefore its own
 * statement, `composeStatisticsAvailabilityProbe`, and a caller runs it FIRST; a
 * zero-row answer means "this database has never been analysed", which is reported
 * as statistics absent and must not be reported as a database failure.
 */
function composeSqliteStatistics(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT m.name AS table_name, s.idx AS index_name, s.stat AS stat " +
    "FROM sqlite_master m LEFT JOIN sqlite_stat1 s ON s.tbl = m.name " +
    "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("m.name", selector.table, "table", "sqlite") +
    " ORDER BY m.name, s.idx"
  );
}

// ─── DuckDB ─────────────────────────────────────────────────────────────────

/**
 * DuckDB's catalog is read through its own `duckdb_*` table functions rather than
 * through `information_schema`, and the choice is measured rather than stylistic
 * (`@duckdb/node-api` 1.5.5-r.4 / DuckDB v1.5.5, against a two-schema fixture):
 *
 *  - `information_schema.tables/columns` DO answer here, Postgres-shaped, but they
 *    carry no `internal` flag, so a read through them cannot separate the engine's
 *    own catalog objects from the user's. The `duckdb_*` functions carry one.
 *  - The `internal` flag is NOT usable as `NOT internal` on `duckdb_schemas()`: it
 *    is TRUE for `main` even in a user database, so filtering schemas on it drops
 *    the default schema. Every read here is therefore bounded by
 *    `database_name = current_database()` as well, which is what excludes the
 *    `temp` and `system` catalogs.
 *  - DuckDB quotes identifiers with `"` and treats `[…]` as a LIST literal rather
 *    than a name quote, so `quoteIdentifier`'s standard branch is correct for it and
 *    `quoteLiteral` doubles a single quote as it does on the other two engines.
 *
 * The guard admits all four statements: nothing here begins a word with `PRAGMA_`,
 * which is what rules SQLite's table-valued catalog functions out.
 */
const DUCKDB_CATALOG_SCOPE = " AND database_name = current_database()";

function composeDuckdbCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, column_name, data_type, is_nullable, " +
    "column_index AS ordinal_position " +
    "FROM duckdb_columns() " +
    `WHERE NOT internal${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name, column_index"
  );
}

/**
 * The foreign-key inventory, one row per referencing COLUMN.
 *
 * `duckdb_constraints()` publishes the two sides as LISTS — `constraint_column_names`
 * and `referenced_column_names` — so a composite key would come back as a
 * cross-product if the two were unnested independently, the same defect the
 * PostgreSQL read fixes with `unnest(conkey, confkey) WITH ORDINALITY`. DuckDB has no
 * `WITH ORDINALITY`, so the two lists are SUBSCRIPTED by one shared ordinal from
 * `generate_series` (1-based here, as every DuckDB list subscript is). Measured on a
 * fixture carrying `FOREIGN KEY (x, y) REFERENCES pair_parent(a, b)`: three rows, the
 * pairs `x→a` and `y→b`, and no cross-product.
 *
 * `referenced_schema` is the referencing table's own schema because DuckDB's
 * constraint catalog publishes no referenced schema at all and the engine resolves a
 * `REFERENCES` clause within one schema. Emitting the column keeps the projection the
 * same shape as PostgreSQL's, which is what a reader of these rows compares against.
 */
function composeDuckdbRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, constraint_column_names[k.ord] AS column_name, " +
    "schema_name AS referenced_schema, referenced_table, referenced_column_names[k.ord] AS referenced_column " +
    "FROM duckdb_constraints(), generate_series(1, len(constraint_column_names)) AS k(ord) " +
    `WHERE constraint_type = 'FOREIGN KEY'${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name, k.ord"
  );
}

/**
 * The index inventory, and it takes TWO reads unioned rather than one.
 *
 * Measured: `duckdb_indexes()` lists only indexes somebody wrote a `CREATE INDEX`
 * for. A `PRIMARY KEY` or `UNIQUE` constraint builds an ART index that the engine
 * uses and that this function does not list at all — on a fixture with a
 * `PRIMARY KEY (id)`, a `UNIQUE INDEX` and a plain index, `duckdb_indexes()` returned
 * the two written ones and `is_primary` was `false` on both. So the constraint-backed
 * indexes come from `duckdb_constraints()`, unioned in.
 *
 * That is the same hole B25 recorded on SQLite, where a UNIQUE-covered foreign key
 * read as unindexed because the constraint's index carries no DDL text. It also
 * carries the only primary-key information on this engine's agent path: the column
 * read publishes no `is_primary`, so without this union nothing a run can read says
 * which columns are the key.
 *
 * `expressions` is cast to a real list (`expressions::VARCHAR[]`) rather than parsed:
 * it prints as `[a, b]` in its VARCHAR form and the cast is measured to produce
 * `["a","b"]`, so an expression index needs no hand parsing here. Both halves are
 * subscripted by a shared ordinal for the reason `composeDuckdbRelations` records, and
 * the union is ordered by that ordinal so a composite key reads in its own order.
 */
function composeDuckdbIndexes(selector: AgentCatalogSelector): string {
  const narrowing =
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb");
  const written =
    "SELECT schema_name AS table_schema, table_name, index_name, is_unique, is_primary, " +
    "(expressions::VARCHAR[])[k.ord] AS column_name, k.ord AS ordinal_position " +
    "FROM duckdb_indexes(), generate_series(1, len(expressions::VARCHAR[])) AS k(ord) " +
    `WHERE true${DUCKDB_CATALOG_SCOPE}${narrowing}`;
  const constraintBacked =
    "SELECT schema_name AS table_schema, table_name, constraint_name AS index_name, true AS is_unique, " +
    "constraint_type = 'PRIMARY KEY' AS is_primary, constraint_column_names[k.ord] AS column_name, " +
    "k.ord AS ordinal_position " +
    "FROM duckdb_constraints(), generate_series(1, len(constraint_column_names)) AS k(ord) " +
    `WHERE constraint_type IN ('PRIMARY KEY', 'UNIQUE')${DUCKDB_CATALOG_SCOPE}${narrowing}`;
  // Ordered by position rather than by name: the two halves are one inventory, and the
  // ordinals are what makes a composite index readable.
  return `${written} UNION ALL ${constraintBacked} ORDER BY 1, 2, 3, 7`;
}

/**
 * The statistics inventory: one row per table, carrying the engine's own row estimate.
 *
 * `duckdb_tables().estimated_size` is a ROW COUNT and not a byte size — measured, and
 * it is the one estimate this catalog publishes. There is NO per-column distribution
 * anywhere in it: no distinct count, no null fraction, nothing `pg_stats` answers. So
 * this projection carries the table half and says nothing about columns, which is the
 * same shape SQLite's `sqlite_stat1` read produces and the reason
 * `AgentTableEstimate.columns` is allowed to be empty.
 *
 * Nothing here scans: it is a catalog read like every other statistics composition,
 * which is what lets a plan run be pointed at production.
 */
function composeDuckdbStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, estimated_size AS estimated_rows " +
    "FROM duckdb_tables() " +
    `WHERE NOT internal${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name"
  );
}

/**
 * Per dialect, per kind. SQLite's relation read IS its object read: foreign keys
 * are declared inside `CREATE TABLE` and the only structured alternative
 * (`pragma_foreign_key_list`) is refused by the guard, so the same statement serves
 * both and the DDL text is parsed for the edges.
 *
 * EVERY ENGINE IN `AGENT_EXECUTION_ENGINES` MUST HAVE AN ENTRY HERE, and
 * `tests/unit/lib/agent/engine-support.test.ts` fails if one does not. An engine that
 * reaches the factory's read-only gate but no composer is an engine on which
 * `inspect_schema`, `profile_table` and `inspect_plan` can only ever refuse — which is
 * how DuckDB shipped into `AGENT_EXECUTION_ENGINES`: `POST /api/agent/runs` accepted
 * the `query-optimization` and `database-assessment` workflows on it and no run could
 * complete one.
 */
const CATALOG_COMPOSERS: Partial<
  Record<DatabaseType, Readonly<Record<AgentCatalogKind, (selector: AgentCatalogSelector) => string>>>
> = {
  postgres: {
    columns: composePostgresCatalog,
    relations: composePostgresRelations,
    indexes: composePostgresIndexes,
    statistics: composePostgresStatistics,
  },
  sqlite: {
    columns: composeSqliteCatalog,
    relations: composeSqliteCatalog,
    indexes: composeSqliteIndexes,
    statistics: composeSqliteStatistics,
  },
  duckdb: {
    columns: composeDuckdbCatalog,
    relations: composeDuckdbRelations,
    indexes: composeDuckdbIndexes,
    statistics: composeDuckdbStatistics,
  },
};

/**
 * The statement that answers "does this database hold any statistics at all?", or
 * `null` when the dialect needs no such question asked.
 *
 * Only SQLite needs one, for the prepare-time reason documented on
 * `composeSqliteStatistics`. PostgreSQL's `pg_class` and `pg_stats` are part of every
 * installation, so absence there is per-table and already expressed IN the statistics
 * read as NULL statistics columns — a probe would answer a question that read has
 * already answered more precisely, and returning a statement for it would invite a
 * caller to treat an empty result as "no statistics anywhere".
 *
 * An unserved dialect is refused rather than answered `null`, because `null` here
 * means "verified: no probe needed", and a dialect nobody has verified has not
 * earned that answer.
 */
export function composeStatisticsAvailabilityProbe(dialect: DatabaseType): string | null {
  if (!Object.hasOwn(CATALOG_COMPOSERS, dialect)) {
    throw new AgentComposedSqlError(
      `no verified statistics composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  if (dialect !== "sqlite") return null;
  return "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'";
}

/**
 * The dialect's estimating EXPLAIN prefix. Every form here DESCRIBES without running:
 * PostgreSQL's `EXPLAIN` executes only with `ANALYZE`, SQLite's `EXPLAIN QUERY PLAN`
 * reports the plan the compiler produced, and DuckDB's `EXPLAIN (FORMAT JSON)` answers
 * the physical plan without touching a row.
 *
 * DuckDB's executing form is not merely unhelpful, it is a hazard: measured on v1.5.5,
 * `EXPLAIN ANALYZE` RUNS the statement (a probe table went from 0 rows to 1), and its
 * JSON variant answers `{"result": "error"}` rather than a plan. So the estimating form
 * is the only one this layer will ever compose for it, whatever a later version does to
 * the JSON.
 */
const ESTIMATING_EXPLAIN_PREFIX: Partial<Record<DatabaseType, string>> = {
  postgres: "EXPLAIN (FORMAT JSON)",
  sqlite: "EXPLAIN QUERY PLAN",
  duckdb: "EXPLAIN (FORMAT JSON)",
};

/**
 * The catalog statement for this dialect and selector.
 *
 * The result is a bounded read like any other: it carries no LIMIT, so a schema
 * wider than the policy's row budget is REFUSED rather than silently truncated.
 * That is the same choice the rest of this layer makes — a partial inventory that
 * claims to be whole is worse than a refusal a caller can narrow — and the selector
 * is how a caller narrows it.
 *
 * KNOWN LIMITATION, with its number: the PostgreSQL projection is one row per COLUMN,
 * so against `maxResultRows: 200` an unnarrowed call overflows at roughly 25 tables of
 * eight columns and comes back as a repairable database error. The engine's message
 * names the budget, so it is diagnosable, but it does cost one repair attempt. The
 * SQLite side is one row per OBJECT and is nowhere near the cap. Making the two
 * symmetric means aggregating columns per table, which changes what a caller parses
 * out of the result — that decision belongs with the context snapshot that consumes
 * it, not here.
 */
export function composeCatalogRead(dialect: DatabaseType, selector: AgentCatalogSelector): string {
  if (!Object.hasOwn(CATALOG_COMPOSERS, dialect)) {
    throw new AgentComposedSqlError(
      `no verified catalog composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  // Non-null: the key was just proven to be an own property of the map.
  return CATALOG_COMPOSERS[dialect]![selector.kind ?? "columns"](selector);
}

/**
 * The estimating plan statement for `sql` on this dialect.
 *
 * Nothing here inspects `sql`: whether it is a bounded read is the descriptor's
 * input contract to answer, and it answers for the COMPOSED text, so a write the
 * model smuggled in is refused with the prefix already attached. Composing it first
 * and letting the guard refuse it is deliberate — one place decides what a
 * statement may be.
 */
export function composeEstimatingExplain(dialect: DatabaseType, sql: string): string {
  const statement = typeof sql === "string" ? sql.trim() : "";
  if (statement.length === 0) {
    throw new AgentComposedSqlError("there is no statement to explain", "INVALID_STATEMENT");
  }
  if (!Object.hasOwn(ESTIMATING_EXPLAIN_PREFIX, dialect)) {
    throw new AgentComposedSqlError(
      `no verified estimating EXPLAIN for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  return `${ESTIMATING_EXPLAIN_PREFIX[dialect]} ${withoutEstimatingPrefix(statement)}`;
}

/**
 * The statement with a leading estimating EXPLAIN removed, if the model wrote one.
 *
 * Measured across 133 optimization runs: 21 calls arrived already prefixed, 12 were refused,
 * and at least three runs lost outright to it. `qwen3:8b` does it in 9 of its 15 runs on
 * that surface. What the model got back was one line of engine text —
 * `near "EXPLAIN": syntax error` — because this function had prepended a second prefix. That
 * message is unactionable when the model did not write the outer EXPLAIN, and the shared
 * rules then tell it not to send the same statement again; three runs abandoned the tool and
 * reported nothing.
 *
 * Stripped rather than refused. The intent is unambiguous — the model asked for the plan of
 * a statement and named the operation twice — and this function already trims whitespace
 * without asking anyone. A refusal would teach, but it would still cost the run the turn it
 * has already spent.
 *
 * `EXPLAIN ANALYZE` is deliberately NOT matched. That form asks to EXECUTE, which is a
 * different request and one this run may not make: removing it would quietly turn a refused
 * execution into an accepted estimate. Composing it through is what puts the word in front
 * of the guard that exists to refuse it.
 */
function withoutEstimatingPrefix(statement: string): string {
  // Anchored, case-insensitive, and requiring whitespace after the keyword so a column
  // called `explained` cannot be mistaken for the keyword. `QUERY PLAN` and `(FORMAT JSON)`
  // are matched as optional tails: a model that repeats this layer's own full prefix is the
  // most common shape of the mistake.
  const estimating = /^EXPLAIN\s+(?:QUERY\s+PLAN\s+|\(\s*FORMAT\s+JSON\s*\)\s*)?(?!ANALYZE\b)/i;
  const match = estimating.exec(statement);
  return match === null ? statement : statement.slice(match[0].length).trim();
}
