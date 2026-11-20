/**
 * PostgreSQL's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them
 * on PostgreSQL. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import {
  type AgentCatalogCapture,
  attach,
  type CatalogRows,
  type ComposedKindResolver,
  emptyTable,
  markPrimary,
  numeric,
  qualified,
  type TableIndex,
  text,
  truthy,
} from "../../../catalog-rows";
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentColumnEstimate, AgentStatisticsReading, AgentTableEstimate } from "../../../schema-stats";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** `LIKE` for the email shape and a POSIX regular expression for the digit run (B26, `PROFILE_SHAPES`). */
const POSTGRES_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    digitRun: (quoted: string, runLength: number) => `${quoted} ~ '[0-9]{${runLength},}'`,
  }),
  incomparableType: /\b(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/i,
});

/** `EXPLAIN` executes only with `ANALYZE`, so the prefix without it describes the plan without running it. */
const POSTGRES_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" });

// ─── PostgreSQL internal-object exclusion ─────────────────────────────────

/**
 * The engine-builtin schemas a PostgreSQL grounding read must not treat as user
 * data. This is the SAME set the provider's object browser uses
 * (`SYSTEM_SCHEMAS` in `src/lib/db/providers/sql/postgres.ts`), copied rather
 * than imported because the agent side must not depend on the provider module.
 * `tests/unit/lib/agent/composed-sql.test.ts` pins the two lists together so
 * they cannot drift. Each group is sorted by engine and checked against that
 * engine's own documentation or, where the doc is silent, a live instance.
 */
const POSTGRES_SYSTEM_SCHEMAS = [
  // PostgreSQL itself.
  "pg_catalog",
  "information_schema",
  "pg_toast",
  // Materialize - materialize.com/docs/sql/system-catalog/ documents the first three.
  // `mz_unsafe` and `mz_catalog_unstable` are not on that page; Materialize v26.44.1
  // listed both beside a user's own schemas, so they are here on measurement (#1428).
  "mz_catalog",
  "mz_internal",
  "mz_introspection",
  "mz_unsafe",
  "mz_catalog_unstable",
  // RisingWave - docs.risingwave.com/sql/system-catalogs/rw-catalog. The schema holds
  // the system tables; RisingWave 3.1.0 listed 74 of them as user objects (#1428).
  "rw_catalog",
  // CockroachDB - cockroachlabs.com/docs/stable/system-catalogs enumerates exactly
  // four schemas; the two below are the ones stock PostgreSQL does not also have.
  "crdb_internal",
  "pg_extension",
  // TimescaleDB - the extension's own sql/pre_install/schemas.sql creates all seven.
  // `_timescaledb_internal` is the one that floods: it holds every hypertable chunk.
  "_timescaledb_catalog",
  "_timescaledb_config",
  "_timescaledb_functions",
  "_timescaledb_internal",
  "_timescaledb_cache",
  "timescaledb_experimental",
  "timescaledb_information",
  // Apache Cloudberry - cloudberry.apache.org create-and-manage-schemas documents the
  // first three. `pg_ext_aux` is not in that page but holds the PAX auxiliary tables
  // (pg_pax_tables, pg_pax_fastsequence) on a live 2.1.0 instance, so it is here on
  // measurement rather than on the doc's authority.
  "gp_toolkit",
  "pg_aoseg",
  "pg_bitmapindex",
  "pg_ext_aux",
] as const;

// Rendered once. Callers interpolate this into a `NOT IN (...)` clause.
const POSTGRES_SYSTEM_SCHEMA_LIST = POSTGRES_SYSTEM_SCHEMAS.map((schema) => `'${schema}'`).join(", ");

/**
 * Schemas an EXTENSION created. AlloyDB Omni is deliberately absent from the
 * name list above: its `google_ml` and `ai` schemas are extension-created, and
 * those are names a user could plausibly choose for schemas of their own, so
 * hiding them by name would make the user's tables vanish. Ownership is the
 * question the name was standing in for, and `pg_depend` answers it directly.
 * Same query the provider composes (`EXTENSION_OWNED_SCHEMAS_SQL`).
 */
const POSTGRES_EXTENSION_OWNED_SCHEMAS_SQL =
  "SELECT n.nspname FROM pg_namespace n " +
  "JOIN pg_depend d ON d.objid = n.oid AND d.classid = 'pg_namespace'::regclass AND d.deptype = 'e' " +
  "JOIN pg_extension e ON e.oid = d.refobjid";

/**
 * RELATIONS (tables, views, materialized views, sequences) an extension created
 * — the B76 sharp case. AlloyDB Omni installs 49 of its 67 extension views into
 * `public` itself, where no schema filter can reach them, so the OBJECT must be
 * excluded by ownership rather than by where it sits. This is the same
 * `pg_depend` ownership test with `classid = 'pg_class'::regclass`: it returns
 * the extension's own relations and nothing a user created, so a user's own
 * views survive.
 */
const POSTGRES_EXTENSION_OWNED_RELATIONS_SQL =
  "SELECT n.nspname, c.relname FROM pg_class c " +
  "JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'e' " +
  "JOIN pg_extension e ON e.oid = d.refobjid";

/**
 * The full "this schema is not the engine's own" test for one column: a fixed
 * list of engine-builtin schemas, plus anything an extension created. Mirrors
 * the provider's `schemaExclusion(column)`.
 */
function postgresSchemaExclusion(column: string): string {
  return `${column} NOT IN (${POSTGRES_SYSTEM_SCHEMA_LIST}) AND ${column} NOT IN (${POSTGRES_EXTENSION_OWNED_SCHEMAS_SQL})`;
}

/**
 * The relation-level ownership test for one (schema, table) pair. Every
 * PostgreSQL catalog read carries it, so `inspect_schema` answers the same
 * object set whatever `kind` it is asked for: a relation an extension created
 * is absent from columns, indexes, statistics and relations alike, and only a
 * user's own objects survive.
 */
function postgresRelationExclusion(schemaColumn: string, tableColumn: string): string {
  return `(${schemaColumn}, ${tableColumn}) NOT IN (${POSTGRES_EXTENSION_OWNED_RELATIONS_SQL})`;
}

/**
 * The same statement with both ownership tests removed, leaving the fixed
 * engine-builtin schema list alone. This is the agent-side mirror of the
 * provider's `withoutExtensionOwnershipTest`: the driver serves PostgreSQL-wire
 * engines nobody here has run, and one without `pg_depend`/`pg_extension`
 * raises on those names, so the read retries with the fixed list alone. Kept as
 * a pure string rewrite so the caller decides when to use it.
 */
export function withoutExtensionOwnershipTest(sql: string): string {
  const withoutSchemas = sql.replace(
    /\s+AND\s+[\w.]+ NOT IN \(SELECT n\.nspname FROM pg_namespace n JOIN pg_depend[^)]*\)/g,
    "",
  );
  return withoutSchemas.replace(
    /\s+AND\s+\([\w.]+,\s*[\w.]+\) NOT IN \(SELECT n\.nspname,\s*c\.relname FROM pg_class c JOIN pg_namespace n[^)]*\)/g,
    "",
  );
}

/**
 * The column inventory, one row per TABLE with its columns aggregated (B52).
 *
 * The projection used to be one row per COLUMN. Against `maxResultRows: 200` that
 * refused an unnarrowed capture on any PostgreSQL image whose own catalogs are wide
 * before the user creates anything. Two measurements exist and they disagree by
 * design, so each is stated with what it was taken UNDER: as a least-privilege agent
 * role on 2026-08-20, TimescaleDB answered 478 flat rows, Cloudberry 289 and AlloyDB
 * Omni 536; re-measured on 2026-09-01 with the aggregation in place and two seeded
 * user tables, the same reads answer 46, 67 and 70 OBJECT rows. The totals are
 * per-role and per-image and mean nothing without both.
 *
 * `json_agg … ORDER BY ordinal_position` keeps the column order, which is the one
 * property the flat projection used to guarantee. The object keys are the ones
 * `buildPostgresTables` reads (`name`, `type`, `nullable`), so the fold parses one
 * array per table instead of one row per column.
 *
 * MEASURED ON, and only on, the three servers B52 named plus stock PostgreSQL: the
 * aggregate runs on Cloudberry's MPP planner, which is the one that refuses other
 * reads with `multiple segworker groups is not supported`. It FAILS on RisingWave
 * 3.0.4, measured 2026-09-24: `json_build_object()` does not exist there, and with the
 * jsonb forms the read fails next on the relation exclusion's two-column
 * `ROW(...) NOT IN (SELECT ...)`, "Subquery must return only one column". NOT measured
 * on Materialize, which has no `json_agg()` either. Neither engine's registry caveats
 * promise agent grounding, so nothing regressed that was promised; a run that ever
 * claims grounding on either has to make this read answer first.
 *
 * The row budget now counts TABLES rather than columns, which is what a wide
 * catalog needs; two bounds still stand and are worth naming. A schema with more
 * than `maxResultRows` tables is still refused — B52 removes the per-column
 * overflow, not the per-table one — and a single table whose aggregated JSON
 * exceeds `maxResultBytes` is refused by the byte budget, the same backstop every
 * read meets, measured over the serialized rows. The model-facing pack then
 * bounds the prompt independently (`MAX_COLUMNS_PER_TABLE`,
 * `AGENT_CONTEXT_PACK_MAX_CHARS`), so a wide table does not spend the context
 * window on itself.
 *
 * This change closes B76: the aggregation that fixed the wide-catalog refusal
 * then admitted the image's own objects. The WHERE clause below now excludes
 * them three ways — the full engine-builtin schema list plus every schema an
 * extension created (both copied from the provider's object browser), AND every
 * RELATION an extension created (`pg_depend` with `classid = 'pg_class'::regclass`,
 * new on the agent path). The relation test is the load-bearing half on AlloyDB
 * Omni, whose 67 extension views mostly sit in `public` itself: no schema
 * filter can reach them, an ownership test can, and a user's own views are
 * never extension-owned so they survive.
 *
 * Every PostgreSQL catalog read carries the relation test, not only this one:
 * `inspect_schema` serves `indexes`, `statistics` and `relations` straight to
 * the model without passing them through `buildPostgresTables`, so a read that
 * filtered by schema alone would show a PostGIS-owned `spatial_ref_sys` in the
 * index and statistics inventories while hiding it from the column inventory.
 * The exclusion is applied where each statement identifies its own table, and
 * the four reads agree on the object set.
 *
 * Measured live on 2026-09-07 against the three `compat` images with two user
 * tables seeded: the column read answers 46 → 2 object rows on TimescaleDB,
 * 67 → 2 on Cloudberry and 70 → 2 on AlloyDB Omni. The sharp case is proven on
 * AlloyDB, not assumed: the schema half alone leaves 51 objects (the 2 user
 * tables plus the 49 extension views installed into `public`), `pg_depend`
 * reports 68 extension-owned relations there, and the relation ownership test
 * is what removes them. The committed tests pin the SQL SHAPE (the composed
 * text carries each filter); the row counts above are the live BEHAVIOUR, and
 * the two are asserted at different layers for that reason.
 *
 * `relkind` RIDES ALONG, and it is what lets a run be told what each entry IS
 * (#789). `information_schema.columns` answers a view's columns beside a table's
 * with nothing to tell them apart, which is the reading a model was handed a view
 * under the word table from. The engine's own word for the relation is one join
 * away - `pg_class` keyed by namespace and name - so it is read here rather than
 * bought with a fourth statement out of the run's budget, and
 * `context-snapshot.ts` maps it onto the kind id the PROVIDER declares. The raw
 * catalog character goes out rather than a word this file invented: the mapping
 * belongs where the declaration can be consulted.
 *
 * LEFT JOIN, deliberately, on both arms. The driver serves PostgreSQL-wire engines
 * nobody here has run, and one whose `pg_class` does not carry a row for a relation
 * `information_schema.columns` does answer for would lose that relation from the
 * whole inventory under an inner join. A missing `relkind` is an unknown kind,
 * which this path already knows how to say; a missing TABLE is the absence #414
 * measured. Both sides are cast to `text` because `sql_identifier` is a domain over
 * `name` on PostgreSQL 12 and later and over `character varying` before it, and the
 * cast is the one comparison that holds either way.
 *
 * Measured on postgres:18 against a fixture holding one relation of each kind: the
 * relkinds `information_schema.columns` actually returns are `r`, `p`, `v` and `f`.
 * A materialized view (`m`) and a sequence (`S`) are NOT in that catalog at all, so
 * this reading cannot see either, and a foreign table (`f`) is one it does see that
 * `postgres.ts` declares no kind for.
 */
function composePostgresCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, kc.relkind AS relkind, json_agg(json_build_object(" +
    "'name', column_name, 'type', data_type, 'nullable', is_nullable) " +
    "ORDER BY ordinal_position) AS columns " +
    "FROM information_schema.columns " +
    "LEFT JOIN pg_catalog.pg_namespace kn ON kn.nspname::text = table_schema::text " +
    "LEFT JOIN pg_catalog.pg_class kc ON kc.relnamespace = kn.oid AND kc.relname::text = table_name::text " +
    `WHERE ${postgresSchemaExclusion("table_schema")}` +
    ` AND ${postgresRelationExclusion("table_schema", "table_name")}` +
    equalsClause("table_schema", selector.schema, "schema", "postgres") +
    equalsClause("table_name", selector.table, "table", "postgres") +
    " GROUP BY table_schema, table_name, kc.relkind ORDER BY table_schema, table_name"
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
    "WHERE c.contype = 'f' AND " +
    postgresSchemaExclusion("rn.nspname") +
    ` AND ${postgresRelationExclusion("rn.nspname", "rel.relname")}` +
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
 * for an index on `status` alone (#463). Every key position is now a
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
    `WHERE ${postgresSchemaExclusion("n.nspname")}` +
    ` AND ${postgresRelationExclusion("n.nspname", "t.relname")}` +
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
    "AND " +
    postgresSchemaExclusion("n.nspname") +
    ` AND ${postgresRelationExclusion("n.nspname", "c.relname")}` +
    equalsClause("n.nspname", selector.schema, "schema", "postgres") +
    equalsClause("c.relname", selector.table, "table", "postgres") +
    " ORDER BY n.nspname, c.relname, s.attname"
  );
}

/**
 * Whether a database error names the two catalogs the extension ownership tests
 * join against. A postgres-typed connection can reach an engine the driver
 * serves but nobody here has run, and one without those catalogs raises on
 * them; the catalog read then retries without the ownership tests — the same
 * decision the provider makes in `isMissingExtensionCatalogError`.
 */
function isMissingExtensionCatalogError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("pg_depend") || lowered.includes("pg_extension");
}

/**
 * What a model that wrote `SHOW` is told (G1, PostgreSQL 19, 2026-11-20): the guard admits a statement led by SELECT,
 * VALUES, TABLE or EXPLAIN alone, so `SHOW server_version` is refused, and the same answers are a SELECT away. Every
 * function named here is stock PostgreSQL and reads without a privilege.
 */
const POSTGRES_NON_READ_ADVICE =
  "On PostgreSQL, read a setting with SELECT current_setting('<name>') or from the pg_settings view instead of SHOW, and the server version with SELECT version().";

/**
 * PostgreSQL's catalog read: the four kinds, each carrying both ownership tests, and the
 * one retry without them.
 *
 * A postgres-typed connection can reach an engine the driver serves but nobody
 * here has run, one without the two catalogs the ownership tests join against
 * (it raises on pg_depend/pg_extension). The provider drops the tests on that
 * error and retries with the fixed schema list alone; mirror it here.
 */
const POSTGRES_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composePostgresCatalog,
    relations: composePostgresRelations,
    indexes: composePostgresIndexes,
    statistics: composePostgresStatistics,
  }),
  retry: Object.freeze({ matches: isMissingExtensionCatalogError, rewrite: withoutExtensionOwnershipTest }),
  systemSchemas: Object.freeze([...POSTGRES_SYSTEM_SCHEMAS]),
  nonReadAdvice: POSTGRES_NON_READ_ADVICE,
});

/**
 * PostgreSQL's rows: one per (table, analysed column), and one per table with every
 * statistics column NULL where `pg_stats` has nothing — which the composed read's
 * LEFT JOIN guarantees, so a never-analysed table arrives rather than disappearing.
 *
 * `reltuples` of -1 is PostgreSQL 14+ saying the table has never been vacuumed or
 * analysed. It is read as absence. Older servers left 0 there instead, which is
 * indistinguishable from a genuinely empty table, and this code does not pretend to
 * tell those apart — an empty table and an uncounted one both come out as "roughly
 * 0 rows, estimated" on a server old enough to do that.
 */
function buildPostgresEstimates(rows: readonly Record<string, unknown>[]): Map<string, AgentTableEstimate> {
  const byTable = new Map<string, { estimatedRows: number | null; columns: AgentColumnEstimate[] }>();

  for (const row of rows) {
    const name = `${text(row.table_schema)}.${text(row.table_name)}`;
    const rawRows = numeric(row.estimated_rows);
    const entry = byTable.get(name) ?? { estimatedRows: rawRows === -1 ? null : rawRows, columns: [] };
    byTable.set(name, entry);

    const column = text(row.column_name);
    if (column === "") continue;
    const distinct = numeric(row.n_distinct);
    entry.columns.push({
      column,
      // 0 is PostgreSQL's "no estimate", not "no distinct values".
      distinct: distinct === 0 ? null : distinct,
      nullFraction: numeric(row.null_frac),
    });
  }

  return byTable;
}

/** PostgreSQL's statistics reading: no probe, since absence is per table and already NULL in the read itself. */
const POSTGRES_STATISTICS: AgentStatisticsReading = Object.freeze({ probe: null, build: buildPostgresEstimates });

/**
 * The column list a PostgreSQL column row carries, aggregated by `json_agg` (B52).
 *
 * `pg` parses a `json` column into an array in memory, but the same rows may arrive
 * as a JSON string from another transport or from a fixture, so both are read.
 * Anything else is the empty inventory rather than an exception: a row this cannot
 * read says nothing about its columns, and refusing it here would turn one malformed
 * row into a lost snapshot.
 *
 * The ELEMENTS are filtered for the same reason the value is, and the filter is the
 * load-bearing half: `Array.isArray` says nothing about what is IN the array, so a
 * `null` element used to reach the fold and be read as `column.name` — a TypeError,
 * raised where `buildPostgresTables` runs OUTSIDE `readInventory`'s catch, which ends
 * the run `internal` rather than degrading the capture (the shape B48 exists to keep
 * out of this path). A bad element is dropped rather than emptying the list: the rest
 * of the array is still an inventory, and losing one entry says less than losing the
 * table.
 */
function parsePostgresColumns(value: unknown): readonly Record<string, unknown>[] {
  const entries = (candidate: unknown): readonly Record<string, unknown>[] =>
    Array.isArray(candidate)
      ? candidate.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      : [];

  if (Array.isArray(value)) return entries(value);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return entries(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

function buildPostgresTables(rows: CatalogRows, kindOf: ComposedKindResolver): TableIndex {
  const tables: TableIndex = new Map();

  for (const row of rows.get("columns") ?? []) {
    const name = qualified(row.table_schema, row.table_name);
    const table = tables.get(name) ?? { ...emptyTable(name), kind: kindOf(row.relkind) };
    tables.set(name, table);
    for (const column of parsePostgresColumns(row.columns)) {
      table.columns.push({
        name: text(column.name),
        type: text(column.type),
        nullable: text(column.nullable).toUpperCase() === "YES",
        isPrimary: false,
      });
    }
  }

  for (const row of rows.get("relations") ?? []) {
    attach(tables, qualified(row.table_schema, row.table_name), (table) => {
      table.foreignKeys.push({
        columnName: text(row.column_name),
        referencedTable: qualified(row.referenced_schema, row.referenced_table),
        referencedColumn: text(row.referenced_column),
      });
    });
  }

  // One row per indexed column, in the index's own column order, so an index is
  // assembled across rows rather than declared by one.
  for (const row of rows.get("indexes") ?? []) {
    const indexName = text(row.index_name);
    const columnName = text(row.column_name);
    attach(tables, qualified(row.table_schema, row.table_name), (table) => {
      let index = table.indexes.find((candidate) => candidate.name === indexName);
      if (index === undefined) {
        index = { name: indexName, columns: [], unique: truthy(row.is_unique) };
        table.indexes.push(index);
      }
      index.columns.push(columnName);
      if (truthy(row.is_primary)) markPrimary(table, columnName);
    });
  }

  return tables;
}

/** PostgreSQL's grounding capture: columns, relations and indexes, each kind read as `pg_class.relkind` words. */
const POSTGRES_CATALOG_CAPTURE: AgentCatalogCapture = Object.freeze({
  kinds: Object.freeze(["columns", "relations", "indexes"] as const),
  build: buildPostgresTables,
  kindWords: Object.freeze({ r: "table", p: "table", v: "view", m: "materialized_view", S: "sequence" }),
});

export const POSTGRES_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: POSTGRES_CATALOG_READ,
    planEstimate: POSTGRES_PLAN_ESTIMATE,
    profileComposition: POSTGRES_PROFILE_COMPOSITION,
    statistics: POSTGRES_STATISTICS,
    catalogCapture: POSTGRES_CATALOG_CAPTURE,
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
