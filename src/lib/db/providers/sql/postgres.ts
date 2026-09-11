/**
 * PostgreSQL Database Provider
 * Full PostgreSQL support with connection pooling
 */

import { Pool, type PoolClient, type PoolConfig as PgPoolConfig, type QueryConfig } from "pg";
import { SQLBaseProvider } from "./sql-base";
import {
  type DatabaseConnection,
  type TableSchema,
  type TableRelations,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ExplainFormat,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderExecutionContext,
  type ReadOnlyStatementBudget,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type Container,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type ObjectKindSpec,
} from "../../types";
import { declaredKinds } from "../../object-kinds";
import {
  DatabaseConfigError,
  ConnectionError,
  ExecutionProfileError,
  QueryError,
  mapDatabaseError,
} from "../../errors";
import { assertReadOnlyBudget, measureResultBytes } from "./read-only-budget";
import { postgresColumnTypes } from "./column-types";
import { formatBytes } from "../../utils/pool-manager";
import { measuredNullableAggregate } from "../../utils/measured-aggregate";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Type Definitions
// ============================================================================

interface PgStatActivityRow {
  datname?: string;
  pid?: number;
  usename?: string;
  application_name?: string;
  client_addr?: string;
  backend_start?: string | Date;
  state?: string;
  query?: string;
  [key: string]: unknown;
}

// Row shapes returned by the schema introspection queries below.
interface SchemaRow {
  table_schema: string;
  table_name: string;
  row_count: string | null;
  total_size: string;
  pk_columns: string[];
  columns?: Array<{ name: string; type: string; nullable: boolean; defaultValue?: string | null }>;
  indexes?: Array<{ name: string; columns: string[]; unique: boolean }>;
  foreign_keys?: Array<{
    columnName: string;
    referencedSchema: string;
    referencedTable: string;
    referencedColumn: string;
  }>;
}

type SchemaListRow = Omit<SchemaRow, "indexes" | "foreign_keys">;
type SchemaRelationRow = Pick<SchemaRow, "table_schema" | "table_name" | "foreign_keys" | "indexes">;

/** One row of `CONTAINERS_SQL`. */
interface ContainerRow {
  name: string;
}

/** One row of `COUNTS_SQL`. `count(*)::int` arrives as a JS number, not a string. */
interface KindCountRow {
  kind: string;
  n: number;
}

/**
 * One row of the three listing statements, which select different columns: the relation
 * listing adds `row_count` and `size_bytes`, the routine listing adds `identity`, and the
 * trigger listing adds `parent`. Every one of those is optional here because the column
 * is absent from the other two statements, not because its value can be null.
 */
interface ObjectRow {
  name: string;
  row_count?: string | null;
  size_bytes?: string | null;
  /** The engine's disambiguated form, used as the last path segment where it differs. */
  identity?: string;
  /** The object this one hangs off, for a kind that declares `attachedTo`. */
  parent?: string;
}

/** The single row `OBJECT_DETAIL_SQL` always returns. */
type ObjectDetailRow = Pick<SchemaRow, "pk_columns" | "columns" | "indexes" | "foreign_keys">;

// ============================================================================
// Schema introspection SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope (not inlined in the methods) on purpose. bun's
// coverage instruments the interior lines of a *multi-line template literal in
// a function body* as 0-hit in any test process that imports this file but does
// not exercise the method — and the merged lcov then reports those SQL lines as
// uncovered even though the method is tested. Evaluated once at module load,
// these consts are reported as covered everywhere, so coverage stays accurate.
//
// All CTEs are MATERIALIZED on purpose: PG12+ inlines single-reference CTEs,
// which lets the planner re-execute these information_schema-based CTEs inside
// nested-loop joins (it estimates rows=1 for them). On large schemas (100+
// tables/constraints/indexes) that explodes to minutes. MATERIALIZED forces
// each CTE to compute once — ~295s -> ~2.6s on a 122-table schema.
// ============================================================================

// Schemas that hold engine internals rather than a user's own tables, single-sourced
// so a new query cannot filter on a shorter list than the rest of the file. Every
// entry was read off that engine's own documentation and then confirmed against a
// live instance; stock PostgreSQL creates none of them, so excluding them there is a
// no-op. Two separate defects made this list load-bearing rather than cosmetic:
// the object browser reads information_schema and listed 61 tables on TimescaleDB
// where 2 were the user's (34 chunk tables, 22 catalog, 3 cache), 10 on AlloyDB Omni
// and 4 on Cloudberry; and the overview counts pg_tables directly, which on
// CockroachDB answers 98 for the same 2 tables because crdb_internal objects reach
// pg_tables but not information_schema's BASE TABLE filter - so the two panels
// disagreed inside one app. Sorted by engine, not alphabetically, so each group can
// be checked against its citation.
const SYSTEM_SCHEMAS = [
  // PostgreSQL itself.
  "pg_catalog",
  "information_schema",
  "pg_toast",
  // Materialize - materialize.com/docs/sql/system-catalog/
  "mz_catalog",
  "mz_internal",
  "mz_introspection",
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

/**
 * What `pg_class.reltuples` actually said, or nothing.
 *
 * It is an estimate, and PostgreSQL 14+ writes **-1** for a relation nothing has
 * vacuumed or analysed yet: "I have not counted this", which is not "this has no rows".
 * NULL arrives the same way when the pg_class join matched nothing at all. Both become
 * absence, and `TableSchema.rowCount` is optional so the badge simply is not drawn -
 * the object browser already gates on that.
 *
 * Measured on stock PostgreSQL 18.4: two tables holding 5000 and 1200 rows both read -1
 * until ANALYZE ran, and every one of them displayed "0 rows". A freshly restored dump
 * is exactly that state. `src/lib/agent/schema-stats.ts` already reads -1 as absence for
 * the agent's grounding read and names the reason - "the standing defect class in this
 * repository is claiming a precision you do not have" - and this is the same read for a
 * person instead of a model.
 *
 * A genuine 0 is kept, because an empty table is a real measurement. On a server old
 * enough to write 0 rather than -1 the two are indistinguishable and nothing here can
 * tell them apart, the same limit schema-stats.ts documents.
 */
function estimatedRowCount(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = parseInt(raw);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}

// Rendered once. Callers interpolate this into a `NOT IN (...)` clause.
const SYSTEM_SCHEMA_LIST = SYSTEM_SCHEMAS.map((schema) => `'${schema}'`).join(", ");

// AlloyDB Omni is deliberately absent from the list above. Its google_ml schema is
// created by an extension rather than built into the engine, and "google_ml" is the
// one name of this kind a user could plausibly choose for a schema of their own -
// hiding it by name would make their tables vanish with no explanation. Ownership is
// the question the name was standing in for, and pg_depend answers it directly and
// better: on a live AlloyDB Omni it returns google_ml AND ai, which a name list had
// missed. Measured on all seven engines including PostgreSQL, where it correctly
// returns nothing; a user's own schema is never extension-owned, so it always
// survives. Kept free of parentheses so the fallback below can strip it by regex.
const EXTENSION_OWNED_SCHEMAS_SQL =
  "SELECT n.nspname FROM pg_namespace n " +
  "JOIN pg_depend d ON d.objid = n.oid AND d.classid = 'pg_namespace'::regclass AND d.deptype = 'e' " +
  "JOIN pg_extension e ON e.oid = d.refobjid";

// What counts as a table, single-sourced because two readers ask: the object browser
// and the overview's count. They answered from different catalogs and disagreed twice
// - 98 against 2 on CockroachDB, then 4 against 3 on Materialize once materialized
// views joined the browser - so both now read information_schema.tables through this.
const USER_TABLE_TYPES = "'BASE TABLE', 'MATERIALIZED VIEW'";

// The full "this schema is not the engine's own" test for one column: a fixed list of
// engine-builtin schemas, plus anything an extension created.
function schemaExclusion(column: string): string {
  return `${column} NOT IN (${SYSTEM_SCHEMA_LIST}) AND ${column} NOT IN (${EXTENSION_OWNED_SCHEMAS_SQL})`;
}

// Reusable CTE fragments (no trailing comma). Composed into the queries below;
// kept single-sourced so the shared CTEs aren't duplicated across queries.
// The table_type filter is a positive list, not "anything that is not a view".
// `MATERIALIZED VIEW` is on it for Materialize, which reports its materialized views
// through information_schema.tables under that type and whose users work with them
// rather than with base tables - listing only BASE TABLE hid the product itself.
// Measured no-op everywhere else: PostgreSQL leaves materialized views out of
// information_schema.tables altogether (its table_type is only BASE TABLE, VIEW,
// FOREIGN or LOCAL TEMPORARY), and TimescaleDB, YugabyteDB, Cloudberry, AlloyDB Omni
// and CockroachDB were each checked on a live instance and emit no such row.
const CTE_TABLES_INFO = `
        tables_info AS MATERIALIZED (
          SELECT
            t.table_schema,
            t.table_name,
            c.reltuples::bigint as row_count,
            COALESCE(pg_total_relation_size(c.oid), 0) as total_size
          FROM information_schema.tables t
          LEFT JOIN pg_class c ON c.oid = to_regclass(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))
          WHERE ${schemaExclusion("t.table_schema")}
          AND t.table_type IN (${USER_TABLE_TYPES})
        )`;

const CTE_COLUMNS_INFO = `
        columns_info AS MATERIALIZED (
          SELECT
            c.table_schema,
            c.table_name,
            json_agg(
              json_build_object(
                'name', c.column_name,
                'type', c.data_type,
                'nullable', c.is_nullable = 'YES',
                'defaultValue', c.column_default
              ) ORDER BY c.ordinal_position
            ) FILTER (WHERE c.ordinal_position <= 100) as columns
          FROM information_schema.columns c
          WHERE ${schemaExclusion("c.table_schema")}
          GROUP BY c.table_schema, c.table_name
        )`;

const CTE_PK_INFO = `
        pk_info AS MATERIALIZED (
          SELECT
            tc.table_schema,
            tc.table_name,
            array_agg(kcu.column_name) as pk_columns
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
          AND ${schemaExclusion("tc.table_schema")}
          GROUP BY tc.table_schema, tc.table_name
        )`;

const CTE_FK_INFO = `
        fk_info AS MATERIALIZED (
          SELECT
            tc.table_schema,
            tc.table_name,
            json_agg(
              json_build_object(
                'columnName', kcu.column_name,
                'referencedSchema', ccu.table_schema,
                'referencedTable', ccu.table_name,
                'referencedColumn', ccu.column_name
              )
            ) as foreign_keys
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ${schemaExclusion("tc.table_schema")}
          GROUP BY tc.table_schema, tc.table_name
        )`;

const CTE_INDEX_INFO = `
        index_info AS MATERIALIZED (
          SELECT
            n.nspname as table_schema,
            t.relname as table_name,
            json_agg(
              json_build_object(
                'name', i.relname,
                'columns', (
                  SELECT array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum))
                  FROM pg_attribute a
                  WHERE a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
                ),
                'unique', ix.indisunique
              )
            ) as indexes
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE ${schemaExclusion("n.nspname")}
          GROUP BY n.nspname, t.relname
        )`;

// Full schema: tables + columns + PKs + foreign keys + indexes in one query.
const SCHEMA_FULL_SQL = `
        WITH ${CTE_TABLES_INFO},${CTE_COLUMNS_INFO},${CTE_PK_INFO},${CTE_FK_INFO},${CTE_INDEX_INFO}
        SELECT
          ti.table_schema,
          ti.table_name,
          ti.row_count,
          ti.total_size,
          COALESCE(ci.columns, '[]'::json) as columns,
          COALESCE(pk.pk_columns, ARRAY[]::text[]) as pk_columns,
          COALESCE(fk.foreign_keys, '[]'::json) as foreign_keys,
          COALESCE(ii.indexes, '[]'::json) as indexes
        FROM tables_info ti
        LEFT JOIN columns_info ci ON ci.table_schema = ti.table_schema AND ci.table_name = ti.table_name
        LEFT JOIN pk_info pk ON pk.table_schema = ti.table_schema AND pk.table_name = ti.table_name
        LEFT JOIN fk_info fk ON fk.table_schema = ti.table_schema AND fk.table_name = ti.table_name
        LEFT JOIN index_info ii ON ii.table_schema = ti.table_schema AND ii.table_name = ti.table_name
        ORDER BY ti.table_schema, ti.table_name ASC;
      `;

// Fast structural list: tables + columns + PKs only (no FK/index joins).
const SCHEMA_LIST_SQL = `
        WITH ${CTE_TABLES_INFO},${CTE_COLUMNS_INFO},${CTE_PK_INFO}
        SELECT
          ti.table_schema,
          ti.table_name,
          ti.row_count,
          ti.total_size,
          COALESCE(ci.columns, '[]'::json) as columns,
          COALESCE(pk.pk_columns, ARRAY[]::text[]) as pk_columns
        FROM tables_info ti
        LEFT JOIN columns_info ci ON ci.table_schema = ti.table_schema AND ci.table_name = ti.table_name
        LEFT JOIN pk_info pk ON pk.table_schema = ti.table_schema AND pk.table_name = ti.table_name
        ORDER BY ti.table_schema, ti.table_name ASC;
      `;

// Heavy relationship/index introspection (foreign keys + indexes).
const SCHEMA_RELATIONS_SQL = `
        WITH ${CTE_FK_INFO},${CTE_INDEX_INFO}
        SELECT
          COALESCE(fk.table_schema, ii.table_schema) as table_schema,
          COALESCE(fk.table_name, ii.table_name) as table_name,
          COALESCE(fk.foreign_keys, '[]'::json) as foreign_keys,
          COALESCE(ii.indexes, '[]'::json) as indexes
        FROM fk_info fk
        FULL OUTER JOIN index_info ii
          ON ii.table_schema = fk.table_schema AND ii.table_name = fk.table_name;
      `;

// Materialize and RisingWave reserve MATERIALIZED as a keyword (it's part of
// their own CREATE MATERIALIZED VIEW grammar), so they reject the CTE modifier
// above with a syntax error - even though the information_schema/pg_catalog
// views these CTEs query are otherwise readable there. Stripping the hint lets
// the schema query run as plain CTEs on those engines instead of failing outright.
function withoutMaterializedHint(sql: string): string {
  return sql.replace(/\bAS MATERIALIZED\s*\(/gi, "AS (");
}

// Message text for this collision is not standardized across engines - PostgreSQL-style
// "syntax error at or near ..." never applies here since real PostgreSQL accepts the hint,
// so only an engine that rejects it reaches this check. Materialize says "Expected left
// parenthesis, found MATERIALIZED" - no "syntax error" substring at all. This SQL text is
// always exactly one of the SCHEMA_*_SQL consts above, so any error naming MATERIALIZED is
// necessarily about this reserved-keyword collision, not an unrelated coincidence.
function isMaterializedKeywordSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("materialized");
}

// CockroachDB has no pg_total_relation_size() builtin (its own compatibility.ts entry
// says so); Materialize reaches the same gap once the MATERIALIZED retry above gets past
// the keyword collision. Replacing the call with a literal 0 loses per-table size for
// those engines but recovers every other column instead of failing the query outright.
function withoutTotalRelationSizeFn(sql: string): string {
  return sql.replace(/pg_total_relation_size\(c\.oid\)/gi, "0");
}

function isMissingTotalRelationSizeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("pg_total_relation_size");
}

// Materialize has no json_agg()/json_build_object() - only their jsonb_ equivalents,
// which return the same array/object shape over the wire (node-postgres parses both
// the json and jsonb OIDs into plain JS values), so swapping the function name is
// enough; the '[]'::json casts elsewhere in these queries are unaffected, since the
// json TYPE itself does exist there.
function withoutJsonAggFunctions(sql: string): string {
  return sql.replace(/\bjson_agg\(/gi, "jsonb_agg(").replace(/\bjson_build_object\(/gi, "jsonb_build_object(");
}

function isMissingJsonAggError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("json_agg") || message.includes("json_build_object");
}

// Replaces one named CTE's body, matching the closing parenthesis by depth rather
// than by text, because the fallbacks above have already rewritten parts of this
// SQL by the time this one runs and a literal match would no longer find it. Brackets
// inside single-quoted strings are skipped, so a literal cannot move the boundary; it
// is still not a general SQL parser (no dollar-quoting, no comments). Returns the SQL
// untouched when the CTE is absent,
// which is how a query that never joined the FK catalog reports "not repairable"
// instead of silently retrying something it did not change.
function replaceCteBody(sql: string, cteName: string, body: string): string {
  const header = new RegExp(`${cteName}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(`, "i");
  const match = header.exec(sql);
  if (!match) return sql;

  const bodyStart = match.index + match[0].length;
  let depth = 1;
  let cursor = bodyStart;
  let inLiteral = false;
  while (cursor < sql.length && depth > 0) {
    const char = sql[cursor];
    // A bracket inside a quoted string is text, not structure. SQL escapes a quote by
    // doubling it, and flipping twice lands back on the same state, so '' needs no
    // special case. These CTEs use no dollar-quoting.
    if (char === "'") inLiteral = !inLiteral;
    else if (!inLiteral) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    cursor++;
  }
  return sql.slice(0, bodyStart) + body + sql.slice(cursor - 1);
}

// Materialize answers information_schema.table_constraints and key_column_usage but
// has no constraint_column_usage, which is the only one of the three that names the
// table a foreign key points AT - so the relationship is genuinely unknowable there,
// while every other column in the same query is not. Emptying the CTE keeps the outer
// LEFT JOIN and FULL OUTER JOIN valid and leaves foreignKeys as [], an absence, rather
// than dropping the tables and columns that were readable all along.
const EMPTY_FK_INFO_BODY = `
          SELECT
            NULL::text AS table_schema,
            NULL::text AS table_name,
            NULL::json AS foreign_keys
          WHERE false
        `;

function withoutForeignKeyCatalog(sql: string): string {
  return replaceCteBody(sql, "fk_info", EMPTY_FK_INFO_BODY);
}

function isMissingConstraintColumnUsageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("constraint_column_usage");
}

// Every engine probed accepts the ownership test, PostgreSQL 18.4, TimescaleDB,
// YugabyteDB, Cloudberry, AlloyDB Omni, CockroachDB and Materialize among them, but
// the driver serves engines nobody here has run. One that has no pg_depend or
// pg_extension drops the clause and keeps the fixed list, which is what it filtered
// on before ownership was asked at all.
function withoutExtensionOwnershipTest(sql: string): string {
  return sql.replace(/\s+AND\s+[\w.]+ NOT IN \(SELECT n\.nspname FROM pg_namespace n JOIN pg_depend[^)]*\)/g, "");
}

// tables_info lists relations from information_schema and then resolves each name to a
// pg_class row. A bare ::regclass cast RAISES when the name no longer resolves, so a
// table dropped between those two steps killed the whole read - reproduced on
// PostgreSQL 18.4, where 102 of 400 runs died under concurrent CREATE/DROP.
// to_regclass() answers NULL instead, and the row survives with its count absent.
//
// Measured: PostgreSQL, TimescaleDB, YugabyteDB, Cloudberry, AlloyDB Omni and
// CockroachDB all have to_regclass. Materialize does not, and it is the engine this
// chain exists for, so it retries with the cast it had before - back to raising on a
// concurrent drop, which is what it did all along.
function withoutToRegclass(sql: string): string {
  return sql.replace(
    /to_regclass\((quote_ident\(t\.table_schema\) \|\| '\.' \|\| quote_ident\(t\.table_name\))\)/g,
    "($1)::regclass",
  );
}

function isMissingToRegclassError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("to_regclass");
}

function isMissingExtensionCatalogError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("pg_depend") || message.includes("pg_extension");
}

// ============================================================================
// Object surface SQL (#789)
// ----------------------------------------------------------------------------
// Hoisted to module scope for the same coverage reason as the schema SQL above.
// ============================================================================

// The containers this connection has, which on PostgreSQL is one level: schemas.
// It reads pg_namespace through the same `schemaExclusion()` every other query in this
// file uses, so a schema the object browser hides here is the same set the schema tree
// and the overview count hide. Measured on the seeded postgres:18 fixture: `app` and
// `public`, and nothing else - pg_namespace there holds only those two plus pg_catalog,
// information_schema and pg_toast, all three of which the fixed list removes.
const CONTAINERS_SQL = `
        SELECT n.nspname AS name
        FROM pg_catalog.pg_namespace n
        WHERE ${schemaExclusion("n.nspname")}
        ORDER BY n.nspname ASC`;

// One UNION arm per catalog that answers for a declared kind. Split into consts rather
// than written twice because `countObjects` needs the same statement with the routine
// arm removed, and two hand-maintained copies of the relation and trigger arms would
// drift the moment a relkind is added to one of them.
const COUNTS_RELATION_ARM = `
          SELECT CASE c.relkind
                   WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                   WHEN 'v' THEN 'view'  WHEN 'm' THEN 'materialized_view'
                   WHEN 'S' THEN 'sequence'
                 END AS kind
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S')`;

// `prokind` is a PostgreSQL 11 column. Everything that predates it, and the forks that
// never grew it, answer 42703 here - which is why this arm is separable at all.
const COUNTS_ROUTINE_ARM = `
          SELECT CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' END
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1`;

// `tgisinternal` excludes the triggers PostgreSQL creates for a foreign key or a
// deferred unique constraint. A user never wrote them and cannot drop them on their own,
// so counting them would report a number nobody could reconcile with their own DDL.
const COUNTS_TRIGGER_ARM = `
          SELECT 'trigger'
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND NOT t.tgisinternal`;

// One statement, one GROUP BY, one round trip for the whole folder row. `kind IS NULL`
// drops the relkinds and prokinds the CASE has no name for (an index, a TOAST table, an
// aggregate) rather than counting them under a folder that does not exist.
function countsSql(arms: readonly string[]): string {
  return `
        SELECT kind, count(*)::int AS n FROM (${arms.join(`
          UNION ALL`)}
        ) s
        WHERE kind IS NOT NULL
        GROUP BY kind`;
}

const COUNTS_SQL = countsSql([COUNTS_RELATION_ARM, COUNTS_ROUTINE_ARM, COUNTS_TRIGGER_ARM]);
const COUNTS_SQL_WITHOUT_ROUTINES = countsSql([COUNTS_RELATION_ARM, COUNTS_TRIGGER_ARM]);

// A server that has no `pg_proc.prokind` cannot tell a function from a procedure, so the
// two routine folders are unknowable there - but the relations and the triggers still
// are. Keyed on the column name as well as the code because 42703 is "undefined column"
// generally, and re-running without the routine arm repairs nothing if the missing
// column was in one of the arms that survive.
function isMissingProkindError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { code?: string }).code === "42703" && error.message.toLowerCase().includes("prokind");
}

// The relkinds behind each relation-shaped kind id, so `listObjects` never interpolates
// anything a caller supplied: an id that is not a key here is not a relation, and the
// lookup returns undefined rather than a fragment.
const RELKIND_BY_KIND: Record<string, string> = {
  table: "'r','p'",
  view: "'v'",
  materialized_view: "'m'",
  sequence: "'S'",
};

// `reltuples` is read here for the same reason `CTE_TABLES_INFO` reads it, and is mapped
// through the same `estimatedRowCount()`: PostgreSQL 14+ writes -1 for a relation nothing
// has analysed, and that is an absence rather than an empty relation.
//
// No `COALESCE(pg_total_relation_size(c.oid), 0)`, which is what the schema query wraps
// the same call in. This statement is not run through `queryWithMaterializedFallback()`
// either, and the two go together. `withoutTotalRelationSizeFn()` repairs an engine
// without that builtin by replacing the call with a literal 0 - correct for `getSchema`,
// where the alternative is losing the whole tree, and wrong here, because it would report
// every relation on CockroachDB and Materialize as 0 bytes. The size column is simply
// dropped instead (`withSize: false`), so the row carries no `size_bytes` at all and
// `measuredSizeBytes()` reads absence. Nothing else in this statement is repairable by
// that chain: it has no `AS MATERIALIZED`, no `json_agg`, no `to_regclass` and no
// `pg_depend`.
function listRelationsSql(relkinds: string, withSize: boolean): string {
  const size = withSize ? ",\n          pg_total_relation_size(c.oid) AS size_bytes" : "";
  return `
        SELECT
          c.relname AS name,
          c.reltuples::bigint AS row_count${size}
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN (${relkinds})`;
}

const LIST_RELATIONS_SQL: Record<string, string> = Object.fromEntries(
  Object.entries(RELKIND_BY_KIND).map(([kind, relkinds]) => [kind, listRelationsSql(relkinds, true)]),
);

const LIST_RELATIONS_SQL_WITHOUT_SIZE: Record<string, string> = Object.fromEntries(
  Object.entries(RELKIND_BY_KIND).map(([kind, relkinds]) => [kind, listRelationsSql(relkinds, false)]),
);

// The prokind character each routine kind id is spelled with on the wire.
const PROKIND_BY_KIND: Record<string, string> = { function: "f", procedure: "p" };

// PostgreSQL identifies a routine by name AND argument types, so `proname` alone is not
// an address: two overloads of `app.order_total` would be two rows nothing can tell
// apart. `identity` is what the path carries and `name` is what a person reads, which
// `DatabaseObject` now says are allowed to differ.
//
// The signature comes from `pg_get_function_identity_arguments()` rather than from
// anything assembled here, and that function is chosen because its output is exactly the
// argument list `ALTER FUNCTION` and `DROP FUNCTION` accept - so the segment round-trips
// back to the engine that produced it. Measured on postgres:18: it renders the parameter
// NAME and mode too, so the three routines in the seed come back as
// `order_total(order_id integer)`, `stamp_updated_at()` and
// `touch_order(IN order_id integer)`, not as the bare type lists a reader might expect.
// Stripping the names would be assembling a form of our own, and would lose the property
// that makes this segment usable as a DDL target.
const LIST_ROUTINES_SQL = `
        SELECT
          p.proname AS name,
          p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS identity
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind = $2`;

// A trigger name is unique per TABLE, not per schema - two tables in one schema may each
// carry a trigger called `stamp_updated_at` - so the table is a path segment and not
// decoration. That is the same nesting the `attachedTo: "table"` declaration states.
const LIST_TRIGGERS_SQL = `
        SELECT t.tgname AS name, c.relname AS parent
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT t.tgisinternal`;

// Columns for ONE object, from pg_attribute rather than from `CTE_COLUMNS_INFO`.
//
// This is the one place `describeObject` does not reuse the schema query's CTEs, and the
// reason is measured. `information_schema.columns` is defined over relkinds 'r', 'v',
// 'f' and 'p' only, so it has no row at all for a materialized view or a sequence:
// on the seeded postgres:18 fixture it answered 0 columns for `app.revenue_by_month`
// (relkind 'm') and 0 for `app.invoice_number_seq` ('S') while pg_attribute answered 2
// and 3. Reusing it would have shipped the object browser's headline new folder - the
// materialized view #710 is about - with an empty column list.
//
// `format_type(a.atttypid, NULL)` is the second argument deliberately: passing
// `a.atttypmod` yields `character varying(50)` and `numeric(12,2)`, while NULL yields the
// unqualified base type. NULL is used because that is exactly what
// `information_schema.columns.data_type` says, so this surface and the flat schema tree
// name a column's type identically while both are live. Verified column by column on
// `app.orders`.
const CTE_OBJECT_COLUMNS = `
        object_columns AS (
          SELECT
            json_agg(
              json_build_object(
                'name', a.attname,
                'type', format_type(a.atttypid, NULL),
                'nullable', NOT a.attnotnull,
                'defaultValue', pg_get_expr(ad.adbin, ad.adrelid)
              ) ORDER BY a.attnum
            ) AS columns
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        )`;

// One object's columns, primary key, foreign keys and indexes. The last three reuse the
// schema query's own CTEs, so a fork that needs `withoutForeignKeyCatalog()` or
// `withoutJsonAggFunctions()` gets the same repair here that `getSchema()` gets.
//
// The `AS MATERIALIZED` hints are stripped, which is the opposite of what the schema
// queries want and for the opposite reason. There, the CTEs are each read by several
// joins over every relation in the database and materializing them once is the cheap
// answer. Here there is exactly one target object, and the hint forbids the planner from
// pushing `$1`/`$2` into the CTEs - so it computes every constraint and every index in
// the database to answer for one name. Measured on the 10-table seed fixture with
// EXPLAIN: total plan cost 3416.66 with the hints against 122.99 without, and the gap
// grows with the database rather than with the object.
//
// `object_columns` has no GROUP BY, so its aggregate returns exactly one row even when
// the object has no columns at all. That is what makes a sequence, a routine and a
// trigger answer `{ columns: [], indexes: [], foreignKeys: [] }` instead of no row.
const OBJECT_DETAIL_SQL = withoutMaterializedHint(`
        WITH ${CTE_OBJECT_COLUMNS},${CTE_PK_INFO},${CTE_FK_INFO},${CTE_INDEX_INFO}
        SELECT
          COALESCE(oc.columns, '[]'::json) as columns,
          COALESCE(pk.pk_columns, ARRAY[]::text[]) as pk_columns,
          COALESCE(fk.foreign_keys, '[]'::json) as foreign_keys,
          COALESCE(ii.indexes, '[]'::json) as indexes
        FROM object_columns oc
        LEFT JOIN pk_info pk ON pk.table_schema = $1 AND pk.table_name = $2
        LEFT JOIN fk_info fk ON fk.table_schema = $1 AND fk.table_name = $2
        LEFT JOIN index_info ii ON ii.table_schema = $1 AND ii.table_name = $2;
      `);

/**
 * The one schema a container path names on this engine.
 *
 * PostgreSQL declares exactly one container level, so a path of any other length is a
 * caller that built it from another engine's shape. It raises rather than reading
 * `path[0]` and carrying on, because `undefined` bound to `$1` would answer an empty
 * folder that looks exactly like a schema holding nothing.
 */
function containerSchema(container: readonly string[]): string {
  if (container.length !== 1) {
    throw new QueryError(
      `A PostgreSQL container path is one schema name, received ${JSON.stringify(container)}`,
      "postgres",
    );
  }
  return container[0];
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this engine has this kind and this schema holds none" render as
 * a 0 badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has
 * no such concept, so the tree draws no folder at all (`ProviderCapabilities.objectKinds`).
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through `mapDatabaseError`. That mapper gives a THROWN error a type
 * and this product's prefix, and nothing here throws: the sentence is rendered to a
 * person as the reason a folder has no number, so prefixing it would put our words in
 * front of the server's. A refused read is never 0 - "permission denied for schema
 * sales" and "this schema holds no tables" are different facts and `KindCount` is the
 * type that keeps them apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/** Overwrites the seeded zeros with what the GROUP BY actually answered. */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    counts[row.kind] = { count: row.n };
  }
}

/**
 * Which statement answers for one kind, or nothing when this engine has no such kind.
 *
 * `withoutSize` is present only for the relation kinds, and only they can be refused for
 * a missing `pg_total_relation_size()`.
 */
function objectListingStatement(
  schema: string,
  kind: string,
): { sql: string; params: unknown[]; withoutSize?: string } | undefined {
  const relations = LIST_RELATIONS_SQL[kind];
  if (relations !== undefined) {
    return { sql: relations, params: [schema], withoutSize: LIST_RELATIONS_SQL_WITHOUT_SIZE[kind] };
  }
  const prokind = PROKIND_BY_KIND[kind];
  if (prokind !== undefined) return { sql: LIST_ROUTINES_SQL, params: [schema, prokind] };
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [schema] };
  return undefined;
}

/**
 * Where one listed object is addressed, which is not always where it is labelled.
 *
 * Built from the ROW rather than from the kind id, so the three listing statements share
 * one rule: a `parent` column adds a nesting segment, and an `identity` column replaces
 * the last one. `src/lib/db` does not branch on the type id, and it should not branch on
 * the kind id where the data already says what to do either.
 *
 * `DatabaseObject.path` is the container path plus one segment per nesting level, each
 * unique within its parent, and `name` is only the label - so a trigger is
 * `[schema, table, trigger]` and an overloaded routine's last segment carries its
 * signature while its name does not.
 */
function objectPath(schema: string, row: ObjectRow): string[] {
  const segments = [schema];
  if (row.parent !== undefined) segments.push(row.parent);
  segments.push(row.identity ?? row.name);
  return segments;
}

/**
 * What `pg_total_relation_size()` answered, or nothing.
 *
 * Absence and 0 are different facts here for the same reason `estimatedRowCount()` keeps
 * them apart: a NULL means the size was not read - the fallback chain can replace the
 * call with a literal, and a fork may not have the function at all - while 0 is a real
 * measurement of a relation with no storage yet. `DatabaseObject.sizeBytes` is optional
 * so the badge is simply not drawn for the first.
 */
function measuredSizeBytes(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = parseInt(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ============================================================================
// Monitoring & maintenance SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope for the same coverage reason as the schema SQL
// above: bun reports interior lines of method-body template literals as 0-hit
// in test processes that import this module without executing the method.
// ============================================================================

// getHealth: buffer cache hit ratio across user tables.
//
// No COALESCE, deliberately. `NULLIF(..., 0)` is here because the denominator can
// genuinely be zero, and the statement used to wrap the resulting NULL in
// `COALESCE(..., 100)` - so a database PostgreSQL had measured nothing about
// reported a perfect cache. Measured 2026-08-23 on postgres:18, a database with no
// user tables:
//
//   heap_read | heap_hit | raw_ratio | coalesced
//  -----------+----------+-----------+-----------
//             |          |           |       100
//
// and a table nothing has read yet gives `0 / NULLIF(0, 0)`, the same NULL. The
// NULL now travels to TypeScript, which reports it as unavailable (#424).
const HEALTH_CACHE_HIT_SQL = `
        SELECT
          sum(heap_blks_read) as heap_read,
          sum(heap_blks_hit)  as heap_hit,
          ROUND((sum(heap_blks_hit) * 100.0 / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0)), 1) as ratio
        FROM pg_statio_user_tables;
      `;

// getHealth: top slow queries from pg_stat_statements (optional extension).
const HEALTH_SLOW_QUERIES_SQL = `
          SELECT
            LEFT(query, 100) as query,
            calls,
            ROUND((mean_exec_time)::numeric, 2)::text || 'ms' as avgTime
          FROM pg_stat_statements
          WHERE calls > 0
          ORDER BY total_exec_time DESC
          LIMIT 5;
        `;

// getHealth: recent sessions for the current database ($1 = database).
const HEALTH_SESSIONS_SQL = `
        SELECT
          pid,
          usename as user,
          datname as database,
          COALESCE(state, 'unknown') as state,
          LEFT(COALESCE(query, ''), 100) as query,
          CASE
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (NOW() - xact_start))::text || 's'
            ELSE 'N/A'
          END as duration
        FROM pg_stat_activity
        WHERE datname = $1
        AND pid != pg_backend_pid()
        ORDER BY xact_start DESC NULLS LAST
        LIMIT 10;
      `;

// getOverview: server version. Split from uptime/start time below because a single
// SELECT fails whole-row if any one column's function is unavailable, and
// pg_postmaster_start_time() does not exist on engines with no pg statistics
// catalog (Materialize, RisingWave) even though version() does.
const OVERVIEW_VERSION_SQL = `SELECT version() as version`;

// getOverview: start time and uptime, guarded separately (see above).
const OVERVIEW_UPTIME_SQL = `
        SELECT
          pg_postmaster_start_time() as start_time,
          EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint as uptime_seconds
      `;

// getOverview: active vs max connections ($1 = database).
const OVERVIEW_CONNECTIONS_SQL = `
        SELECT
          count(*) as active_connections,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
        FROM pg_stat_activity
        WHERE datname = $1
      `;

// getOverview: database size, pretty-printed and raw bytes ($1 = database).
const OVERVIEW_SIZE_SQL = `
        SELECT
          pg_database_size($1) as database_size_bytes
      `;

// getOverview: user table and index counts across all user schemas.
const OVERVIEW_COUNTS_SQL = `
        SELECT
          (SELECT count(*) FROM information_schema.tables
            WHERE ${schemaExclusion("table_schema")} AND table_type IN (${USER_TABLE_TYPES})) as table_count,
          (SELECT count(*) FROM pg_indexes WHERE ${schemaExclusion("schemaname")}) as index_count
      `;

// getPerformanceMetrics: buffer cache hit ratio. NULL when there is nothing to
// divide, for the reasons and with the measurement given at HEALTH_CACHE_HIT_SQL.
const PERF_CACHE_HIT_SQL = `
        SELECT
          ROUND(sum(heap_blks_hit) * 100.0 / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) as cache_hit_ratio
        FROM pg_statio_user_tables
      `;

// getPerformanceMetrics: transaction stats for the database ($1 = database).
const PERF_TRANSACTION_STATS_SQL = `
        SELECT
          xact_commit,
          xact_rollback,
          deadlocks,
          blks_read,
          blks_hit
        FROM pg_stat_database
        WHERE datname = $1
      `;

// getPerformanceMetrics: checkpoint timings (columns absent on older PG).
const PERF_CHECKPOINT_SQL = `
          SELECT
            checkpoint_write_time,
            checkpoint_sync_time
          FROM pg_stat_bgwriter
        `;

// getSlowQueries: pg_stat_statements stats ($1 = database, $2 = limit).
const SLOW_QUERIES_SQL = `
          SELECT
            queryid::text as query_id,
            LEFT(query, 500) as query,
            calls,
            ROUND(total_exec_time::numeric, 2) as total_time,
            ROUND(mean_exec_time::numeric, 2) as avg_time,
            ROUND(min_exec_time::numeric, 2) as min_time,
            ROUND(max_exec_time::numeric, 2) as max_time,
            rows,
            shared_blks_hit,
            shared_blks_read
          FROM pg_stat_statements
          WHERE calls > 0
            AND dbid = (SELECT oid FROM pg_database WHERE datname = $1)
          ORDER BY total_exec_time DESC
          LIMIT $2
        `;

// getSlowQueries fallback: currently running queries from pg_stat_activity
// ($1 = database, $2 = limit).
const SLOW_QUERIES_FALLBACK_SQL = `
          SELECT
            pid::text as query_id,
            LEFT(COALESCE(query, ''), 500) as query,
            1 as calls,
            COALESCE(EXTRACT(EPOCH FROM (now() - query_start)) * 1000, 0) as total_time,
            COALESCE(EXTRACT(EPOCH FROM (now() - query_start)) * 1000, 0) as avg_time,
            0 as rows
          FROM pg_stat_activity
          WHERE datname = $1
            AND pid != pg_backend_pid()
            AND state = 'active'
            AND query IS NOT NULL
            AND query != ''
            AND query NOT LIKE '%pg_stat_activity%'
          ORDER BY query_start ASC NULLS LAST
          LIMIT $2
        `;

// getActiveSessions: detailed session list ($1 = database, $2 = limit).
const ACTIVE_SESSIONS_SQL = `
        SELECT
          pid,
          usename as user,
          datname as database,
          application_name,
          client_addr::text,
          COALESCE(state, 'unknown') as state,
          LEFT(COALESCE(query, ''), 500) as query,
          query_start,
          wait_event_type,
          wait_event,
          CASE
            WHEN state = 'active' THEN
              EXTRACT(EPOCH FROM (now() - query_start))::text || 's'
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (now() - xact_start))::text || 's'
            ELSE 'N/A'
          END as duration,
          CASE
            WHEN state = 'active' THEN
              EXTRACT(EPOCH FROM (now() - query_start)) * 1000
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (now() - xact_start)) * 1000
            ELSE 0
          END as duration_ms
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid != pg_backend_pid()
        ORDER BY
          CASE state WHEN 'active' THEN 0 ELSE 1 END,
          query_start DESC NULLS LAST
        LIMIT $2
      `;

// getTableStats: per-table stats. A schema WHERE clause is interpolated
// between the two fragments at the call site.
const TABLE_STATS_SELECT_SQL = `
        SELECT
          schemaname as schema_name,
          relname as table_name,
          n_live_tup as live_row_count,
          n_dead_tup as dead_row_count,
          n_live_tup + n_dead_tup as row_count,
          pg_size_pretty(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(relname))) as table_size,
          pg_table_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as table_size_bytes,
          pg_size_pretty(pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(relname))) as index_size,
          pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as index_size_bytes,
          pg_size_pretty(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname))) as total_size,
          pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) as total_size_bytes,
          last_vacuum,
          last_autovacuum,
          last_analyze,
          last_autoanalyze,
          CASE
            WHEN n_live_tup > 0 THEN
              ROUND(n_dead_tup * 100.0 / (n_live_tup + n_dead_tup), 2)
            ELSE 0
          END as bloat_ratio
        FROM pg_stat_user_tables
        `;

const TABLE_STATS_ORDER_SQL = `
        ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(relname)) DESC
      `;

// getIndexStats: per-index stats. A schema WHERE clause is interpolated
// between the two fragments at the call site.
const INDEX_STATS_SELECT_SQL = `
        SELECT
          s.schemaname as schema_name,
          s.relname as table_name,
          s.indexrelname as index_name,
          am.amname as index_type,
          pg_size_pretty(pg_relation_size(s.indexrelid)) as index_size,
          pg_relation_size(s.indexrelid) as index_size_bytes,
          s.idx_scan as scans,
          s.idx_tup_read as tuples_read,
          s.idx_tup_fetch as tuples_fetched,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary,
          array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
          CASE
            WHEN (SELECT seq_scan + idx_scan FROM pg_stat_user_tables t WHERE t.relid = s.relid) > 0
            THEN ROUND(
              s.idx_scan * 100.0 /
              (SELECT seq_scan + idx_scan FROM pg_stat_user_tables t WHERE t.relid = s.relid),
              2
            )
            ELSE 0
          END as usage_ratio
        FROM pg_stat_user_indexes s
        JOIN pg_index ix ON ix.indexrelid = s.indexrelid
        JOIN pg_class i ON i.oid = s.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        JOIN pg_attribute a ON a.attrelid = s.relid AND a.attnum = ANY(ix.indkey)
        `;

const INDEX_STATS_GROUP_ORDER_SQL = `
        GROUP BY s.schemaname, s.relname, s.indexrelname, am.amname,
                 s.indexrelid, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
                 ix.indisunique, ix.indisprimary, s.relid
        ORDER BY s.idx_scan DESC
      `;

// getStorageStats: tablespace sizes.
const STORAGE_TABLESPACES_SQL = `
        SELECT
          spcname as name,
          pg_tablespace_location(oid) as location,
          pg_size_pretty(pg_tablespace_size(oid)) as size,
          pg_tablespace_size(oid) as size_bytes,
          spcname = 'pg_default' as is_default
        FROM pg_tablespace
        WHERE spcname NOT LIKE 'pg_global'
      `;

// getStorageStats: WAL size (requires superuser; the caller ignores failures).
const STORAGE_WAL_SQL = `
          SELECT
            pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) as wal_size,
            pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') as wal_size_bytes
        `;

// ============================================================================
// Agent read-only execution profile (#328)
// ============================================================================

/**
 * The capabilities a read-only TRANSACTION cannot contain, asked of the role
 * the profile would run as.
 *
 * `to_regrole` keeps the query safe on a server where a predefined role is
 * absent (it yields NULL, and `COALESCE` makes that a `false` rather than an
 * error), so the check does not depend on the server's major version.
 *
 * Every catalog FUNCTION is schema-qualified because this query decides a
 * security boundary. `pg_catalog` is searched implicitly first only while it is
 * not named in `search_path`; once it is named explicitly, any schema ahead of
 * it shadows built-ins, so `search_path = attacker_schema, pg_catalog` plus a
 * shadow `pg_has_role()` would answer four falses for a superuser and defeat
 * the one check meant to catch that role. `COALESCE` and `current_user` need no
 * qualification (and accept none): they are SQL constructs the parser resolves,
 * not functions that name resolution can redirect.
 */
const AGENT_ROLE_PRIVILEGE_SQL = `
        SELECT pg_catalog.current_setting('is_superuser') = 'on' AS is_superuser,
               COALESCE(
                 pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('pg_read_server_files'), 'USAGE'),
                 false
               ) AS reads_server_files,
               COALESCE(
                 pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('pg_write_server_files'), 'USAGE'),
                 false
               ) AS writes_server_files,
               COALESCE(
                 pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('pg_execute_server_program'), 'USAGE'),
                 false
               ) AS executes_programs
      `;

const AGENT_ROLE_FORBIDDEN_CAPABILITIES = [
  "is_superuser",
  "reads_server_files",
  "writes_server_files",
  "executes_programs",
] as const;

/**
 * Refuses a role whose privileges reach past the read-only transaction.
 *
 * `BEGIN READ ONLY` forbids changing the DATABASE. It does not forbid writing
 * somewhere else: verified on PostgreSQL 18, a superuser session inside a
 * read-only transaction still ran `COPY (…) TO '<path>'` (an arbitrary
 * server-side file write), `COPY (…) TO PROGRAM '<cmd>'` (command execution as
 * the server's OS user) and `pg_read_file()` (an arbitrary server-side file
 * read). Only privileges refuse those — the same lesson the SQLite profile
 * learned from `VACUUM INTO`: a control is a claim about one resource, so the
 * question is always what else the statement can reach.
 *
 * Hence a least-privilege agent role is part of this profile's boundary rather
 * than a recommendation, and it is VERIFIED at open instead of assumed from
 * configuration: an admin can point `agentUser` at a superuser, and a
 * connection's own user very often is one.
 *
 * Fails closed on anything it cannot read as four explicit `false`s — a server
 * that answers nothing, or answers something else, leaves the boundary
 * unproven.
 */
function assertAgentRoleIsUnprivileged(rows: unknown[]): void {
  const row = rows[0] as Record<string, unknown> | undefined;
  const held = AGENT_ROLE_FORBIDDEN_CAPABILITIES.filter((capability) => row?.[capability] !== false);
  if (held.length > 0) {
    throw new ExecutionProfileError(
      `The agent read-only execution profile requires a least-privilege PostgreSQL role; this role is unverified or too broad (${held.join(", ")}). A read-only transaction does not stop server-side file access or program execution.`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
  }
}

/**
 * The EXPLAIN grammars this provider can ask for, most specific first, each paired
 * with the strategy id that reads what the statement answers.
 *
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` is PostgreSQL's own grammar and the rest
 * of the wire family does not share it. Measured 2026-09-06 through `pg`, one
 * connection per engine:
 *
 * - PostgreSQL 18, TimescaleDB (PG 17.11), YugabyteDB 2.25.2, Apache Cloudberry 2.1.0
 *   and AlloyDB Omni (PG 17.9): accepted, so nothing about those five changes.
 * - CockroachDB v26.2.5: `at or near "analyze": syntax error`, and `at or near
 *   "json": syntax error` for a bare `(FORMAT JSON)` - its parenthesised options are
 *   its own vocabulary, and `JSON` is legal there only beside `DISTSQL`, where it
 *   answers a processor diagram rather than a plan. Its `EXPLAIN ANALYZE` needs no
 *   parentheses and reports what the query really did.
 * - Materialize v26.40.0: `Expected SELECT, VALUES, or a subquery in the query body,
 *   found ANALYZE`, the same refusal for `(FORMAT JSON)` naming `FORMAT` - the
 *   PARENTHESES are what the grammar has no rule for - and `Expected one of CPU or
 *   MEMORY, found SELECT` for `EXPLAIN ANALYZE`, which is a different statement
 *   there. The plain `EXPLAIN` is the only plan grammar it publishes.
 *
 * Each probe is the statement its strategy really sends, so a grammar that answers
 * here is one the panel can use. `SELECT 1` is what they run: the first two forms
 * execute what they explain, and this one has nothing to execute.
 */
const EXPLAIN_PROBES: readonly (readonly [sql: string, format: ExplainFormat])[] = [
  ["EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1", "postgres-json"],
  ["EXPLAIN ANALYZE SELECT 1", "postgres-text-analyze"],
  ["EXPLAIN SELECT 1", "postgres-text"],
];

/**
 * Which of those grammars this server accepts, or `undefined` when it accepts none.
 * Run once per `connect()`, on the client that connect already borrowed.
 *
 * It reads SUCCESS OR FAILURE and never the message, because the family does not
 * share one for a grammar refusal - Materialize names the token its parser stopped
 * at, CockroachDB names a position - and keying on wording would have to enumerate
 * engines, which is the branch `src/lib/db` does not take. Asking the server what its
 * grammar accepts is the same answer without the enumeration.
 *
 * Nothing here rejects. A grammar the server does not have is a fact about the
 * Explain panel, not about the connection, and `connect()` must not fail for it.
 */
async function probeExplainFormat(client: PoolClient): Promise<ExplainFormat | undefined> {
  for (const [sql, format] of EXPLAIN_PROBES) {
    try {
      await client.query(sql);
      return format;
    } catch {
      // Refused, so try the next grammar. The reason is the engine's own and there is
      // nothing to report: the capability this produces IS the report.
    }
  }
  return undefined;
}

// ============================================================================
// PostgreSQL Provider
// ============================================================================

export class PostgresProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  // Transaction support: dedicated client held outside pool
  private txClient: PoolClient | null = null;
  private txActive = false;
  private txTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly TX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** True when this instance was opened under the agent read-only profile. */
  private readonly readOnlyProfile: boolean;

  /**
   * The EXPLAIN grammar this server accepts, measured by `probeExplainFormat()` at
   * connect. It starts as PostgreSQL's own grammar, which is what this provider
   * declared unconditionally before the probe existed and is still the right answer
   * for an unconnected provider: `POST /api/db/provider-meta` reads capabilities off a
   * provider it never connects (#457), so the pre-flight the client does keeps exactly
   * the behaviour it had.
   */
  private measuredExplainFormat: ExplainFormat | undefined = "postgres-json";

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(config, options);
    // Server-injected only (see ProviderExecutionContext): the editor path
    // builds providers from caller-supplied ProviderOptions, which has no route
    // to this flag in either direction.
    this.readOnlyProfile = execution.readOnly === true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 5432,
      // Measured at connect, not declared per type id: the PostgreSQL-wire relatives
      // do not all accept the parenthesised JSON form (#597). The key is spread in
      // rather than set to `undefined` because `ProviderCapabilities.explainFormat` is
      // present iff `supportsExplain` is true, and the provider tests assert that as a
      // shape.
      supportsExplain: this.measuredExplainFormat !== undefined,
      ...(this.measuredExplainFormat === undefined ? {} : { explainFormat: this.measuredExplainFormat }),
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // BEGIN / COMMIT / ROLLBACK over one held pool client (`beginTransaction()` below).
      supportsTransactions: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
      // Every statement below has both forms - `VACUUM ANALYZE <table>` and bare
      // `VACUUM ANALYZE`, `REINDEX TABLE <table>` and `REINDEX DATABASE` - so
      // PostgreSQL is the engine whose per-row and global controls were both already
      // right, and declaring them changes nothing here (#496). `kill` takes a backend
      // PID, which only the Sessions panel can supply.
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Table", perEntity: true, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
      // One level. `catalog` is not a second one here: a `pg` pool is opened against one
      // database and nothing in the product can switch it on a live connection, so
      // declaring a catalog level would draw a folder with exactly one child forever.
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      // Seven kinds, each with the catalog that answers for it (#789):
      // table, view, materialized view and sequence from `pg_class.relkind`; function and
      // procedure from `pg_proc.prokind`; trigger from `pg_trigger`.
      //
      // No `index` kind, deliberately. PostgreSQL's own catalog models an index as a
      // property of the relation it is on - `pg_index` is keyed by `indrelid` and an
      // index cannot exist without one - so it belongs in `describeObject`'s output,
      // where it already is, rather than in a container-level folder of its own.
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        // No `acceptsRowWrites`. PostgreSQL does accept an UPDATE against a simple
        // updatable view and against any view carrying an INSTEAD OF trigger, and the
        // provider still declares nothing: whether a given view is one of those is a
        // per-object fact this declaration is per-kind, so claiming it would offer an
        // import target that fails on most views in most schemas.
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        {
          id: "materialized_view",
          role: "relation",
          label: "Materialized View",
          labelPlural: "Materialized Views",
        },
        { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
        { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
        { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
        { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
      ],
    };
  }

  /**
   * Only the global reindex triad; every other label is the SQL default and right.
   *
   * The Operations tab's reindex card was hardcoded to this wording for every engine
   * (#464), so declaring it here changes nothing on PostgreSQL and lets the two other
   * providers that declare `reindex` say what theirs does instead.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      reindexGlobalLabel: "Run Reindex",
      reindexGlobalTitle: "Rebuild Indexes",
      reindexGlobalDesc: "Runs REINDEX DATABASE, reconstructing every index in the database.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for PostgreSQL", "postgres");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for PostgreSQL", "postgres");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      const poolConfig = this.buildPoolConfig();
      this.pool = new Pool(poolConfig);
      this.attachPoolErrorListener(this.pool);

      const client = await this.pool.connect();
      try {
        // Under the profile, the role itself is part of the boundary — verify it
        // on the same client this connect already borrowed.
        if (this.readOnlyProfile) {
          assertAgentRoleIsUnprivileged((await client.query(AGENT_ROLE_PRIVILEGE_SQL)).rows);
        }
        // Never under the read-only profile. That connection's invariant is that every
        // statement it runs arrives inside a `BEGIN READ ONLY` envelope
        // (`tests/isolated/agent-investigation-e2e.test.ts` asserts exactly that), and
        // a bare probe at connect would be the first statement to leave it - for an
        // answer that path cannot use: the agent composes its own EXPLAIN from
        // `ESTIMATING_EXPLAIN_PREFIX`, keyed on the type id and not on this capability,
        // and `summarisePlan` reads a plan only when that composed `EXPLAIN
        // (FORMAT JSON)` succeeded, which is the case where the probe would have
        // answered `postgres-json` anyway. So the profile keeps the static default and
        // the envelope keeps its hole-free guarantee.
        if (!this.readOnlyProfile) {
          this.measuredExplainFormat = await probeExplainFormat(client);
        }
      } finally {
        client.release();
      }

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      // The pool is built before anything that can fail here — the borrow, and
      // under the profile the role probe. Whatever went wrong, the caller ends
      // up without a usable provider, and `acquireExecutionProfileProvider`
      // drops it WITHOUT calling disconnect(), so a pool left open here leaks
      // its idle socket and timers with no reference left to close them. End it
      // on every failed connect, not just the typed refusal.
      const failedPool = this.pool;
      this.pool = null;
      await failedPool?.end().catch(() => {});
      // A typed profile refusal keeps its identity: wrapping it would strip the
      // deny reason code callers branch on.
      if (error instanceof ExecutionProfileError) {
        throw error;
      }
      throw new ConnectionError(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : error}`,
        "postgres",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.setConnected(false);
    }
  }

  /**
   * A client that fails while CHECKED OUT rejects its own query, which is why ordinary
   * query failures behave correctly. A client that fails while IDLE — the server dropped
   * it, the network went away — has no query to reject, so `pg` removes and destroys it
   * and then emits `error` on the pool. An `error` event with no listener is an uncaught
   * exception, so without this handler a dropped idle connection takes the whole server
   * process down (#298).
   *
   * The client is already gone by the time this fires, so the handler exists to keep the
   * event non-fatal and visible — not to reconnect. The pool opens a fresh client on the
   * next acquire by itself.
   */
  private attachPoolErrorListener(pool: Pool): void {
    pool.on("error", (error) => {
      console.error("[Postgres] Idle pool client error:", error);
    });
  }

  private buildPoolConfig(): PgPoolConfig {
    const sslConfig = this.buildSSLConfig();

    const baseConfig: PgPoolConfig = {
      min: this.poolConfig.min,
      max: this.poolConfig.max,
      idleTimeoutMillis: this.poolConfig.idleTimeout,
      connectionTimeoutMillis: this.poolConfig.acquireTimeout,
      statement_timeout: this.queryTimeout,
      ssl: sslConfig,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        connectionString: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
    };
  }

  private buildSSLConfig(): PgPoolConfig["ssl"] {
    const connSSL = this.config.ssl;

    // Explicit SSL config from connection takes priority
    if (connSSL) {
      if (connSSL.mode === "disable") return false;

      const ssl: Record<string, unknown> = {
        // Every mode except `require` verifies (D26): `verify-system` checks the chain against
        // the trust store the runtime already has - no `ca` is set below, so Node's bundled
        // roots decide - while `verify-ca`/`verify-full` check it against the PEM pasted into
        // the form. `require` is the one mode that encrypts without checking anything.
        rejectUnauthorized: connSSL.mode !== "require",
      };

      if (connSSL.caCert) ssl.ca = connSSL.caCert;
      if (connSSL.clientCert) ssl.cert = connSSL.clientCert;
      if (connSSL.clientKey) ssl.key = connSSL.clientKey;

      return ssl as PgPoolConfig["ssl"];
    }

    // Auto-detect for cloud providers
    if (this.shouldEnableSSL()) {
      return { rejectUnauthorized: false };
    }

    // Provider options fallback
    if (this.options.ssl === false) return false;

    return undefined;
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  // Track running query PIDs for cancellation
  private runningQueryPids = new Map<string, number>();

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const client = await this.pool!.connect();
          try {
            // Track PID for cancellation support
            if (queryId) {
              const pidRes = await client.query("SELECT pg_backend_pid() as pid");
              this.runningQueryPids.set(queryId, pidRes.rows[0].pid);
            }
            const res = await client.query(sql, params);
            return res;
          } finally {
            if (queryId) this.runningQueryPids.delete(queryId);
            client.release();
          }
        } catch (error) {
          if (queryId) this.runningQueryPids.delete(queryId);
          throw mapDatabaseError(error, "postgres", sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
        ...postgresColumnTypes(result.fields),
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const pid = this.runningQueryPids.get(queryId);
    if (!pid) return false;

    try {
      const client = await this.pool!.connect();
      try {
        const res = await client.query("SELECT pg_cancel_backend($1) as cancelled", [pid]);
        return res.rows[0]?.cancelled === true;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("[Postgres] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Agent Read-Only Execution Profile (#328)
  // ============================================================================

  /**
   * Runs exactly one statement inside `BEGIN READ ONLY` with a
   * transaction-local timeout, then rolls back and releases the client. The
   * DATABASE is the boundary, twice over:
   *
   * - The read-only transaction makes the server itself reject any write that
   *   reaches it (SQLSTATE 25006) — no SQL classification happens here.
   * - The statement travels on the extended query protocol (`queryMode:
   *   "extended"`, pg >= 8.11), whose Parse message the server refuses for
   *   multi-command strings (SQLSTATE 42601) BEFORE executing anything. That
   *   is what stops `SELECT 1; COMMIT; INSERT ...` from committing its way out
   *   of the read-only transaction — on the simple protocol the server would
   *   execute each command in turn, honoring the smuggled COMMIT.
   *
   * A single hostile statement cannot escape either: `SET TRANSACTION READ
   * WRITE` would be the transaction's only statement before ROLLBACK, a lone
   * COMMIT merely ends an empty read-only transaction, and a session-level
   * `SET` reverts with the rollback (GUC changes are transactional).
   *
   * The row/byte caps are enforced result-side after the statement returns;
   * the timeout is `SET LOCAL`, so it dies with the transaction.
   */
  public async queryReadOnly(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> {
    this.ensureConnected();
    assertReadOnlyBudget(budget, "postgres");
    if (!this.readOnlyProfile) {
      // A provider opened outside the profile has had no role verification, so
      // its session may be able to write server files or run programs from
      // inside a read-only transaction. Refuse rather than serve agent
      // semantics without the boundary that makes them true.
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "postgres",
        sql,
      );
    }

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        const client = await this.pool!.connect();
        try {
          await client.query("BEGIN READ ONLY");
          // SET cannot take bind parameters; the value is proven a positive
          // integer by assertReadOnlyBudget above, so no text can pass through.
          await client.query(`SET LOCAL statement_timeout = ${budget.statementTimeoutMs}`);
          // @types/pg does not model queryMode yet; the runtime supports it
          // since pg 8.11 (node_modules/pg/lib/query.js requiresPreparation).
          const extendedQuery = { text: sql, queryMode: "extended" } as QueryConfig & { queryMode: "extended" };
          return await client.query(extendedQuery);
        } catch (error) {
          throw mapDatabaseError(error, "postgres", sql);
        } finally {
          // The profile never commits. A client that cannot be reset is
          // destroyed (release(error)), never returned to the pool mid-transaction.
          try {
            await client.query("ROLLBACK");
            // Session state a rollback does NOT undo: an advisory lock taken
            // inside the transaction survives it (verified on PostgreSQL 18) and
            // no statement the agent path admits could release it, so a pooled
            // client would carry it into every later execution. DISCARD ALL
            // cannot run inside a transaction block, hence after the ROLLBACK.
            await client.query("DISCARD ALL");
            client.release();
          } catch (cleanupError) {
            client.release(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
          }
        }
      });

      if (result.rows.length > budget.maxResultRows) {
        throw new QueryError(
          `Read-only execution exceeded the row budget: ${result.rows.length} rows > ${budget.maxResultRows} allowed`,
          "postgres",
          sql,
        );
      }
      const resultBytes = measureResultBytes(result.rows);
      if (resultBytes > budget.maxResultBytes) {
        throw new QueryError(
          `Read-only execution exceeded the byte budget: ${resultBytes} bytes > ${budget.maxResultBytes} allowed`,
          "postgres",
          sql,
        );
      }

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
        ...postgresColumnTypes(result.fields),
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  private clearTxTimeout(): void {
    if (this.txTimeout) {
      clearTimeout(this.txTimeout);
      this.txTimeout = null;
    }
  }

  /**
   * Force-expire an active transaction (auto-rollback).
   * Called by the timeout timer, but also available for testing.
   */
  public async expireTransaction(): Promise<void> {
    if (this.txActive && this.txClient) {
      console.warn("[Postgres] Transaction timed out, auto-rolling back");
      try {
        await this.txClient.query("ROLLBACK");
      } catch {
        /* ignore */
      } finally {
        this.txClient.release();
        this.txClient = null;
        this.txActive = false;
        this.clearTxTimeout();
      }
    }
  }

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "postgres");
    this.txClient = await this.pool!.connect();
    await this.txClient.query("BEGIN");
    this.txActive = true;

    // Auto-rollback after timeout to prevent leaked locks. Single-line callback
    // on purpose: bun lcov attributes a multi-line arrow's opening line as 0-hit.
    this.txTimeout = setTimeout(() => void this.expireTransaction(), PostgresProvider.TX_TIMEOUT_MS);
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txClient || !this.txActive) throw new QueryError("No active transaction", "postgres");
    this.clearTxTimeout();
    try {
      await this.txClient.query("COMMIT");
    } finally {
      this.txClient.release();
      this.txClient = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txClient || !this.txActive) throw new QueryError("No active transaction", "postgres");
    this.clearTxTimeout();
    try {
      await this.txClient.query("ROLLBACK");
    } finally {
      this.txClient.release();
      this.txClient = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txClient || !this.txActive) throw new QueryError("No active transaction", "postgres");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.txClient!.query(sql, params);
        } catch (error) {
          throw mapDatabaseError(error, "postgres", sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
        ...postgresColumnTypes(result.fields),
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Runs a schema-introspection query built from `AS MATERIALIZED` CTEs,
   * `pg_total_relation_size()` and `json_agg()`/`json_build_object()`. Real
   * PostgreSQL accepts all of these and this succeeds on the first try. Three
   * independent things can reject it on a wire-compatible relative, and each
   * engine can hit them in a different order or subset: Materialize/RisingWave
   * reserve MATERIALIZED as a keyword (their own CREATE MATERIALIZED VIEW
   * grammar) and reject the CTE modifier outright; CockroachDB and Materialize
   * both lack `pg_total_relation_size()`; Materialize also has no `json_agg()`/
   * `json_build_object()`, only the `jsonb_` equivalents. Every fallback is
   * matched against whichever error actually comes back, not tried in a fixed
   * order, so one engine hitting only the second or third gap still recovers.
   * Recovers real object-browser data on those engines instead of failing outright;
   * any error no fallback recognizes, or one that survives every applicable
   * fallback, is mapped and rethrown rather than left raw.
   */
  private async queryWithMaterializedFallback(client: PoolClient, sql: string, params?: unknown[]) {
    const remainingFallbacks = [
      { matches: isMaterializedKeywordSyntaxError, apply: withoutMaterializedHint },
      { matches: isMissingTotalRelationSizeError, apply: withoutTotalRelationSizeFn },
      { matches: isMissingJsonAggError, apply: withoutJsonAggFunctions },
      { matches: isMissingConstraintColumnUsageError, apply: withoutForeignKeyCatalog },
      { matches: isMissingExtensionCatalogError, apply: withoutExtensionOwnershipTest },
      { matches: isMissingToRegclassError, apply: withoutToRegclass },
    ];
    let currentSql = sql;
    for (;;) {
      try {
        return await client.query(currentSql, params);
      } catch (error) {
        const index = remainingFallbacks.findIndex((fallback) => fallback.matches(error));
        // currentSql, not sql: the chain rewrites the statement as it goes, and quoting
        // the original would point a reader at text the server never received.
        if (index === -1) throw mapDatabaseError(error, "postgres", currentSql);
        currentSql = remainingFallbacks[index].apply(currentSql);
        remainingFallbacks.splice(index, 1);
      }
    }
  }

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Single MATERIALIZED query (see SCHEMA_FULL_SQL) replacing the old
      // N+1 pattern (1 + N*4 queries) with one round-trip.
      const result = await this.queryWithMaterializedFallback(client, SCHEMA_FULL_SQL);

      return result.rows.map((row: SchemaRow) => {
        const schemaName = row.table_schema;
        const tableName = row.table_name;
        const displayName = schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
        const rowCount = estimatedRowCount(row.row_count);
        const sizeBytes = parseInt(row.total_size || "0");
        const pkColumns: string[] = row.pk_columns || [];

        // Parse columns and add isPrimary flag
        const columns = (row.columns || []).map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isPrimary: pkColumns.includes(col.name),
          defaultValue: col.defaultValue ?? undefined,
        }));

        // Parse indexes
        const indexes = (row.indexes || []).map((idx) => ({
          name: idx.name,
          columns: Array.isArray(idx.columns) ? idx.columns : [],
          unique: idx.unique,
        }));

        // Parse foreign keys
        const foreignKeys = (row.foreign_keys || []).map((fk) => ({
          columnName: fk.columnName,
          referencedTable:
            fk.referencedSchema === "public" ? fk.referencedTable : `${fk.referencedSchema}.${fk.referencedTable}`,
          referencedColumn: fk.referencedColumn,
        }));

        return {
          name: displayName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns,
          indexes,
          foreignKeys,
        };
      });
    } finally {
      client.release();
    }
  }

  /**
   * Fast structural schema: tables + columns + primary keys + row counts/sizes.
   * Deliberately EXCLUDES foreign keys and indexes (the expensive
   * information_schema joins) so the schema tree renders immediately.
   * Relationships/indexes are loaded separately via getSchemaRelations()
   * and merged in asynchronously by the client, so a slow/failing stats
   * query never blocks the table list.
   */
  public async getSchemaList(): Promise<TableSchema[]> {
    this.ensureConnected();
    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, SCHEMA_LIST_SQL);

      return result.rows.map((row: SchemaListRow) => {
        const displayName = row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`;
        const pkColumns: string[] = row.pk_columns || [];
        const columns = (row.columns || []).map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isPrimary: pkColumns.includes(col.name),
          defaultValue: col.defaultValue ?? undefined,
        }));
        return {
          name: displayName,
          rowCount: estimatedRowCount(row.row_count),
          size: formatBytes(parseInt(row.total_size || "0")),
          columns,
          indexes: [],
          foreignKeys: [],
        };
      });
    } finally {
      client.release();
    }
  }

  /**
   * Heavy relationship/index introspection (foreign keys + indexes), keyed by
   * table display name so the client can merge it into the result of
   * getSchemaList(). Kept separate so its cost never blocks the table list.
   * CTEs are MATERIALIZED (see getSchema for the rationale).
   */
  public async getSchemaRelations(): Promise<TableRelations[]> {
    this.ensureConnected();
    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, SCHEMA_RELATIONS_SQL);

      return result.rows.map((row: SchemaRelationRow) => {
        const displayName = row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`;
        return {
          name: displayName,
          foreignKeys: (row.foreign_keys || []).map((fk) => ({
            columnName: fk.columnName,
            referencedTable:
              fk.referencedSchema === "public" ? fk.referencedTable : `${fk.referencedSchema}.${fk.referencedTable}`,
            referencedColumn: fk.referencedColumn,
          })),
          indexes: (row.indexes || []).map((idx) => ({
            name: idx.name,
            columns: Array.isArray(idx.columns) ? idx.columns : [],
            unique: idx.unique,
          })),
        };
      });
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /**
   * The schemas this connection can see. One level, so `parent` can only ever name a
   * schema, and nothing nests under one here - that answers `[]` rather than raising,
   * because "this level has no children" is a true statement about PostgreSQL and not a
   * caller mistake.
   *
   * Through the fallback chain, because `schemaExclusion()` carries the `pg_depend` /
   * `pg_extension` ownership test and an engine without those catalogs would otherwise
   * lose its whole container list to a clause `withoutExtensionOwnershipTest()` already
   * knows how to drop.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, CONTAINERS_SQL);
      return result.rows.map((row: ContainerRow) => ({ path: [row.name], name: row.name, level: 0 }));
    } finally {
      client.release();
    }
  }

  /**
   * How many objects of each declared kind one schema holds.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries the server's own sentence, so
   * the object browser can say why a folder has no number instead of showing a zero
   * nobody measured.
   *
   * The `prokind` retry is the one partial outcome. That column arrived in PostgreSQL 11
   * and the wire-compatible forks do not all have it, so a server can answer for its
   * relations and its triggers while being unable to tell a function from a procedure.
   * Losing the two routine folders is the right cost there; losing the whole container to
   * one missing column is not.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const schema = containerSchema(container);
    const declared = declaredKinds(this.getCapabilities());
    const counts = seedZeroCounts(declared);

    const client = await this.pool!.connect();
    try {
      try {
        applyKindCounts(counts, (await client.query(COUNTS_SQL, [schema])).rows);
      } catch (error) {
        if (!isMissingProkindError(error)) {
          return unavailableCounts(
            declared.map((kind) => kind.id),
            error,
          );
        }
        const routines = declared.filter((kind) => kind.role === "routine");
        const rest = declared.filter((kind) => kind.role !== "routine");
        try {
          applyKindCounts(counts, (await client.query(COUNTS_SQL_WITHOUT_ROUTINES, [schema])).rows);
        } catch (retryError) {
          Object.assign(
            counts,
            unavailableCounts(
              rest.map((kind) => kind.id),
              retryError,
            ),
          );
        }
        Object.assign(
          counts,
          unavailableCounts(
            routines.map((kind) => kind.id),
            error,
          ),
        );
      }
      return counts;
    } finally {
      client.release();
    }
  }

  /** One listing read, retried without the size column when the builtin is not there. */
  private async queryListing(client: PoolClient, statement: { sql: string; params: unknown[]; withoutSize?: string }) {
    try {
      return await client.query(statement.sql, statement.params);
    } catch (error) {
      if (statement.withoutSize === undefined || !isMissingTotalRelationSizeError(error)) {
        throw mapDatabaseError(error, "postgres", statement.sql);
      }
      return await client.query(statement.withoutSize, statement.params);
    }
  }

  /**
   * The objects of one kind in one schema, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Three
   * different catalogs answer these listings, so three `ORDER BY` clauses would be three
   * chances to disagree; and a SQL sort runs under the database's own collation, which is
   * `C` on the seeded fixture and `en_US.UTF-8` on plenty of real servers, so the same
   * schema would come back in two different orders on two servers. A code-point sort here
   * is one rule and the same rule everywhere.
   *
   * The one retry drops the size column rather than the listing. CockroachDB and
   * Materialize have no `pg_total_relation_size()`, and both are reached under the
   * `postgres` type id, so refusing the whole folder there would be a dead tree; the
   * shared `withoutTotalRelationSizeFn()` is not used because its literal 0 would claim
   * every relation on those servers is empty. See `listRelationsSql()`.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const schema = containerSchema(container);
    const statement = objectListingStatement(schema, kind);
    if (statement === undefined) {
      throw new QueryError(`PostgreSQL declares no object kind "${kind}"`, "postgres");
    }

    const client = await this.pool!.connect();
    try {
      const result = await this.queryListing(client, statement);
      return result.rows
        .map((row: ObjectRow) => ({
          path: objectPath(schema, row),
          name: row.name,
          kind,
          rowCount: estimatedRowCount(row.row_count),
          sizeBytes: measuredSizeBytes(row.size_bytes),
        }))
        .sort((left, right) => {
          // By PATH, not by name: two overloads of one routine share a name, so a
          // name sort leaves their order up to whatever the catalog happened to
          // answer. Sorting by the address also groups a table's triggers together.
          const leftKey = JSON.stringify(left.path);
          const rightKey = JSON.stringify(right.path);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
    } finally {
      client.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for one object, addressed as `[schema, name]` or,
   * for a kind that declares `attachedTo`, as `[schema, parent, name]`.
   *
   * A kind that has none of the three - a sequence, a routine, a trigger - answers three
   * empty arrays rather than an error, because having no columns is a true fact about
   * those kinds and not a failed read (`tests/helpers/object-surface-conformance.ts`
   * states the same rule from the caller's side). A statement that returns no row at all
   * IS a failed read: `OBJECT_DETAIL_SQL`'s aggregate has no GROUP BY, so on any server
   * that ran it there is exactly one row, and zero means the fallback chain rewrote it
   * into something else.
   *
   * The three-segment path answers those empty arrays WITHOUT asking the server, and that
   * is a correctness fix rather than a shortcut. An attached object has no columns of its
   * own, and the query keys on the last segment against `pg_class.relname` - so a trigger
   * named `orders` on table `customers` would otherwise have been handed
   * `app.orders`'s 23 columns as if they were its own.
   */
  public async describeObject(path: readonly string[]): Promise<ObjectDetail> {
    this.ensureConnected();
    if (path.length < 2 || path.length > 3) {
      throw new QueryError(
        `A PostgreSQL object path is [schema, name] or [schema, parent, name], received ${JSON.stringify(path)}`,
        "postgres",
      );
    }
    if (path.length === 3) {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, OBJECT_DETAIL_SQL, [path[0], path[1]]);
      if (result.rows.length === 0) {
        throw new QueryError(`No detail row for ${path.join(".")}`, "postgres", OBJECT_DETAIL_SQL);
      }
      const row = result.rows[0] as ObjectDetailRow;
      const pkColumns: string[] = row.pk_columns || [];

      return {
        path: [...path],
        columns: (row.columns || []).map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isPrimary: pkColumns.includes(col.name),
          defaultValue: col.defaultValue ?? undefined,
        })),
        indexes: (row.indexes || []).map((idx) => ({
          name: idx.name,
          columns: Array.isArray(idx.columns) ? idx.columns : [],
          unique: idx.unique,
        })),
        // `referencedTable` is spelled the way `getSchema()` spells it, public-qualified
        // and joined with a dot, because `ForeignKeySchema` carries one string and both
        // surfaces are live through Phase 1. The phase that removes `getSchema` is where
        // that string becomes a path.
        foreignKeys: (row.foreign_keys || []).map((fk) => ({
          columnName: fk.columnName,
          referencedTable:
            fk.referencedSchema === "public" ? fk.referencedTable : `${fk.referencedSchema}.${fk.referencedTable}`,
          referencedColumn: fk.referencedColumn,
        })),
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Engines that answer the SQL editor but have no pg statistics catalog at
      // all (Materialize, RisingWave) reject every query below. Each is isolated
      // in its own try/catch, matching the pg_stat_statements fallback further
      // down, so a missing catalog degrades that one panel instead of failing
      // the whole health check.
      let activeConnections: number | undefined;
      try {
        const connRes = await client.query("SELECT count(*) FROM pg_stat_activity");
        activeConnections = parseInt(connRes.rows[0].count);
      } catch {
        activeConnections = undefined;
      }

      let databaseSize = "N/A";
      try {
        const sizeRes = await client.query("SELECT pg_size_pretty(pg_database_size($1))", [this.config.database]);
        databaseSize = sizeRes.rows[0].pg_size_pretty;
      } catch {
        databaseSize = "N/A";
      }

      let cacheHitRatio = CACHE_HIT_RATIO_UNAVAILABLE;
      try {
        const cacheRes = await client.query(HEALTH_CACHE_HIT_SQL);
        // A NULL ratio used to arrive here as the SQL's own invented 100; unguarded,
        // it would now arrive as the string "null%".
        const healthCacheHitRatio = measuredNumber(cacheRes.rows[0]?.ratio);
        cacheHitRatio =
          healthCacheHitRatio === undefined
            ? CACHE_HIT_RATIO_UNAVAILABLE
            : `${formatCacheHitRatio(healthCacheHitRatio)}%`;
      } catch {
        cacheHitRatio = CACHE_HIT_RATIO_UNAVAILABLE;
      }

      let slowQueries: SlowQuery[] = [];
      try {
        const slowRes = await client.query(HEALTH_SLOW_QUERIES_SQL);
        slowQueries = slowRes.rows.map((r) => ({
          query: r.query,
          calls: r.calls,
          avgTime: r.avgtime,
        }));
      } catch {
        slowQueries = [{ query: "pg_stat_statements extension not enabled", calls: 0, avgTime: "N/A" }];
      }

      let activeSessions: ActiveSession[] = [];
      try {
        const sessionsRes = await client.query(HEALTH_SESSIONS_SQL, [this.config.database]);
        activeSessions = sessionsRes.rows.map((r) => ({
          pid: r.pid,
          user: r.user || "unknown",
          database: r.database || "",
          state: r.state,
          query: r.query || "",
          duration: r.duration,
        }));
      } catch {
        activeSessions = [];
      }

      return {
        activeConnections,
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  /**
   * Resolve a maintenance target into a schema-qualified, quoted identifier.
   * Bare table names default to the public schema; "schema.table" is quoted
   * per-part. Returns an empty string when no target is given.
   */
  private qualifyMaintenanceTarget(target?: string): string {
    if (!target) return "";
    if (target.includes(".")) {
      return target
        .split(".")
        .map((p) => this.escapeIdentifier(p))
        .join(".");
    }
    return "public." + this.escapeIdentifier(target);
  }

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const client = await this.pool!.connect();
      try {
        let sql = "";
        // Resolve target into a schema-qualified, quoted identifier (defaults to
        // the public schema for bare names; "schema.table" is also supported).
        const qualifiedTarget = this.qualifyMaintenanceTarget(target);

        switch (type) {
          case "vacuum":
            sql = target ? `VACUUM ANALYZE ${qualifiedTarget}` : "VACUUM ANALYZE";
            break;
          case "analyze":
            sql = target ? `ANALYZE ${qualifiedTarget}` : "ANALYZE";
            break;
          case "reindex":
            sql = target
              ? `REINDEX TABLE ${qualifiedTarget}`
              : `REINDEX DATABASE ${this.escapeIdentifier(this.config.database || "")}`;
            break;
          case "kill":
            if (!target) {
              throw new QueryError("Target PID is required for kill operation", "postgres");
            }
            const pid = parseInt(target, 10);
            if (isNaN(pid)) {
              throw new QueryError("Invalid PID for kill operation", "postgres");
            }
            sql = `SELECT pg_terminate_backend(${pid})`;
            break;
        }

        // Unsupported types leave sql empty and are rejected here; every supported
        // case above assigns a non-empty statement or throws before reaching this.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type: ${type}`, "postgres");
        }

        await client.query(sql);
        return { success: true };
      } finally {
        client.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: `${type.toUpperCase()} completed successfully`,
    };
  }

  // ============================================================================
  // Pool Statistics
  // ============================================================================

  public getPoolStats() {
    if (!this.pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      active: this.pool.totalCount - this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  /**
   * Get database overview metrics
   */
  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Engines with no pg statistics catalog at all (Materialize, RisingWave) reject
      // every query below except version(). Each is isolated so one missing catalog
      // degrades that one field instead of failing the whole overview.
      const versionRes = await client.query(OVERVIEW_VERSION_SQL);
      const version = versionRes.rows[0].version?.split(",")[0] || "PostgreSQL";

      let uptime = "N/A";
      let startTime: Date | undefined;
      try {
        const uptimeRes = await client.query(OVERVIEW_UPTIME_SQL);
        const uptimeSeconds = parseInt(uptimeRes.rows[0].uptime_seconds || "0");
        const days = Math.floor(uptimeSeconds / 86400);
        const hours = Math.floor((uptimeSeconds % 86400) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        startTime = uptimeRes.rows[0].start_time ? new Date(uptimeRes.rows[0].start_time) : undefined;
      } catch {
        uptime = "N/A";
        startTime = undefined;
      }

      let activeConnections: number | undefined;
      let maxConnections = 0;
      try {
        const connRes = await client.query(OVERVIEW_CONNECTIONS_SQL, [this.config.database]);
        activeConnections = parseInt(connRes.rows[0].active_connections || "0");
        maxConnections = parseInt(connRes.rows[0].max_connections || "100");
      } catch {
        activeConnections = undefined;
        maxConnections = 0;
      }

      let databaseSize = "N/A";
      let databaseSizeBytes: number | undefined;
      try {
        const sizeRes = await client.query(OVERVIEW_SIZE_SQL, [this.config.database]);
        databaseSizeBytes = measuredNullableAggregate(sizeRes.rows[0], "database_size_bytes");
        if (databaseSizeBytes !== undefined) databaseSize = formatBytes(databaseSizeBytes);
      } catch {
        databaseSize = "N/A";
        databaseSizeBytes = undefined;
      }

      let tableCount = 0;
      let indexCount = 0;
      try {
        // Through the same chain the object browser uses, not a bare query: this one
        // also carries the ownership clause, and an engine that cannot evaluate
        // pg_depend must drop it and answer rather than fall into the catch below,
        // which would report 0 tables - a measurement nobody made.
        const countRes = await this.queryWithMaterializedFallback(client, OVERVIEW_COUNTS_SQL);
        tableCount = parseInt(countRes.rows[0].table_count || "0");
        indexCount = parseInt(countRes.rows[0].index_count || "0");
      } catch {
        tableCount = 0;
        indexCount = 0;
      }

      return {
        version,
        uptime,
        startTime,
        activeConnections,
        maxConnections,
        databaseSize,
        ...(databaseSizeBytes === undefined ? {} : { databaseSizeBytes }),
        tableCount,
        indexCount,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get performance metrics
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Get cache hit ratio. Absent (not 0) when pg_statio_user_tables does not exist
      // at all (Materialize, RisingWave), same as the other statistics-catalog reads.
      let cacheHitRatio: number | undefined;
      try {
        const cacheRes = await client.query(PERF_CACHE_HIT_SQL);
        cacheHitRatio = measuredNumber(cacheRes.rows[0]?.cache_hit_ratio);
      } catch {
        cacheHitRatio = undefined;
      }

      // Get transaction stats. A missing pg_stat_database leaves txRow undefined, and
      // deadlocks below is already written to stay absent rather than default to 0.
      let txRow: { deadlocks?: unknown } | undefined;
      try {
        const txRes = await client.query(PERF_TRANSACTION_STATS_SQL, [this.config.database]);
        txRow = txRes.rows[0];
      } catch {
        txRow = undefined;
      }

      // Get checkpoint stats (optional - columns may not exist in older PG versions)
      // "N/A" from the start rather than "0", so an unread counter never leaves
      // here looking like a checkpoint that took no time.
      let checkpointWriteTime = "N/A";
      try {
        const checkpointRes = await client.query(PERF_CHECKPOINT_SQL);
        const checkpointRow = checkpointRes.rows[0];
        const writeTime = measuredNumber(checkpointRow?.checkpoint_write_time);
        const syncTime = measuredNumber(checkpointRow?.checkpoint_sync_time);
        // Either half alone is a reading; neither is not. PostgreSQL 17 moved both
        // columns from pg_stat_bgwriter to pg_stat_checkpointer, so on 17+ the query
        // throws and the catch below answers - measured 2026-08-23 through this
        // provider against postgres:18, which reported checkpointWriteTime "N/A".
        if (writeTime !== undefined || syncTime !== undefined) {
          checkpointWriteTime = `${(((writeTime ?? 0) + (syncTime ?? 0)) / 1000).toFixed(1)}s`;
        }
      } catch {
        // The columns do not exist on this server (17+), or the view is not readable.
        checkpointWriteTime = "N/A";
      }

      // No `|| "0"` here: pg_stat_database answers no row at all for a database it
      // has no entry for, and a deadlock count of 0 is a claim ("this database has
      // deadlocked zero times") rather than the absence of a reading.
      const deadlocks = measuredNumber(txRow?.deadlocks);

      return {
        // `|| "100"` was two bugs in one operator: it invented a perfect cache for a
        // NULL, and it also discarded a measured 0 - a cold cache reading 0% is a
        // measurement, and the one the panel most needs to show.
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        // transactionsPerSecond / queriesPerSecond would need time-based sampling,
        // which this call does not do, so they stay absent.
        //
        // bufferPoolUsage is absent too, and that is a removal rather than a gap:
        // this method used to report `blks_hit / (blks_hit + blks_read)` from
        // pg_stat_database under that name, which is a cache hit ratio and not pool
        // occupancy - so the Performance tab showed the same quantity twice, once
        // mislabelled, and substituted 100 when both counters were 0. PostgreSQL
        // publishes no buffer pool occupancy without the pg_buffercache extension
        // (not installed by default, and scanning it locks shared_buffers), so there
        // is nothing honest to put here.
        ...(deadlocks === undefined ? {} : { deadlocks }),
        checkpointWriteTime,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get slow query statistics from pg_stat_statements
   */
  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const client = await this.pool!.connect();
    try {
      // Try pg_stat_statements first (requires extension)
      try {
        const res = await client.query(SLOW_QUERIES_SQL, [this.config.database, limit]);

        return res.rows.map((r) => ({
          queryId: r.query_id,
          query: r.query || "",
          calls: parseInt(r.calls || "0"),
          totalTime: parseFloat(r.total_time || "0"),
          avgTime: parseFloat(r.avg_time || "0"),
          minTime: parseFloat(r.min_time || "0"),
          maxTime: parseFloat(r.max_time || "0"),
          rows: parseInt(r.rows || "0"),
          sharedBlksHit: parseInt(r.shared_blks_hit || "0"),
          sharedBlksRead: parseInt(r.shared_blks_read || "0"),
        }));
      } catch {
        // Fallback: use pg_stat_activity for currently running queries
        // This doesn't provide historical stats, but shows active queries
        try {
          const fallbackRes = await client.query(SLOW_QUERIES_FALLBACK_SQL, [this.config.database, limit]);

          return fallbackRes.rows.map((r) => ({
            queryId: r.query_id,
            query: r.query || "",
            calls: parseInt(r.calls || "1"),
            totalTime: parseFloat(r.total_time || "0"),
            avgTime: parseFloat(r.avg_time || "0"),
            minTime: undefined,
            maxTime: undefined,
            rows: parseInt(r.rows || "0"),
            sharedBlksHit: undefined,
            sharedBlksRead: undefined,
          }));
        } catch {
          // No pg_stat_statements AND no pg_stat_activity (Materialize, RisingWave):
          // no statistics catalog at all, so there is nothing to show, not a failure.
          return [];
        }
      }
    } finally {
      client.release();
    }
  }

  /**
   * Get active sessions with detailed information
   */
  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const client = await this.pool!.connect();
    try {
      // No pg_stat_activity at all (Materialize, RisingWave): no sessions to show,
      // not a failure - matches getSlowQueries()'s exhausted-fallback behavior.
      try {
        const res = await client.query(ACTIVE_SESSIONS_SQL, [this.config.database, limit]);

        return res.rows.map((r) => ({
          pid: r.pid,
          user: r.user || "unknown",
          database: r.database || "",
          applicationName: r.application_name || undefined,
          clientAddr: r.client_addr || undefined,
          state: r.state,
          query: r.query || "",
          queryStart: r.query_start ? new Date(r.query_start) : undefined,
          duration: r.duration,
          durationMs: parseFloat(r.duration_ms || "0"),
          waitEventType: r.wait_event_type || undefined,
          waitEvent: r.wait_event || undefined,
          blocked: false, // Could be enhanced with pg_locks query
        }));
      } catch {
        return [];
      }
    } finally {
      client.release();
    }
  }

  /**
   * Get table statistics
   */
  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    this.ensureConnected();
    const schema = options?.schema;

    const client = await this.pool!.connect();
    try {
      // If schema is specified, filter by it; otherwise get all user schemas
      const whereClause = schema ? `WHERE schemaname = $1` : `WHERE ${schemaExclusion("schemaname")}`;
      const params = schema ? [schema] : [];

      const res = await client.query(`${TABLE_STATS_SELECT_SQL}${whereClause}${TABLE_STATS_ORDER_SQL}`, params);

      return res.rows.map((r) => ({
        schemaName: r.schema_name,
        tableName: r.table_name,
        rowCount: parseInt(r.row_count || "0"),
        liveRowCount: parseInt(r.live_row_count || "0"),
        deadRowCount: parseInt(r.dead_row_count || "0"),
        tableSize: r.table_size || "0 bytes",
        tableSizeBytes: parseInt(r.table_size_bytes || "0"),
        indexSize: r.index_size || "0 bytes",
        indexSizeBytes: parseInt(r.index_size_bytes || "0"),
        totalSize: r.total_size || "0 bytes",
        totalSizeBytes: parseInt(r.total_size_bytes || "0"),
        lastVacuum: r.last_vacuum || r.last_autovacuum ? new Date(r.last_vacuum || r.last_autovacuum) : undefined,
        lastAnalyze: r.last_analyze || r.last_autoanalyze ? new Date(r.last_analyze || r.last_autoanalyze) : undefined,
        bloatRatio: parseFloat(r.bloat_ratio || "0"),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get index statistics
   */
  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    this.ensureConnected();
    const schema = options?.schema;

    const client = await this.pool!.connect();
    try {
      // If schema is specified, filter by it; otherwise get all user schemas
      const whereClause = schema ? `WHERE s.schemaname = $1` : `WHERE ${schemaExclusion("s.schemaname")}`;
      const params = schema ? [schema] : [];

      const res = await client.query(`${INDEX_STATS_SELECT_SQL}${whereClause}${INDEX_STATS_GROUP_ORDER_SQL}`, params);

      return res.rows.map((r) => ({
        schemaName: r.schema_name,
        tableName: r.table_name,
        indexName: r.index_name,
        indexType: r.index_type,
        columns: Array.isArray(r.columns) ? r.columns : [],
        isUnique: r.is_unique || false,
        isPrimary: r.is_primary || false,
        indexSize: r.index_size || "0 bytes",
        indexSizeBytes: parseInt(r.index_size_bytes || "0"),
        scans: parseInt(r.scans || "0"),
        usageRatio: parseFloat(r.usage_ratio || "0"),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get storage statistics including tablespaces and WAL
   */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const results: StorageStats[] = [];

      // Get tablespace info
      const tsRes = await client.query(STORAGE_TABLESPACES_SQL);

      for (const row of tsRes.rows) {
        results.push({
          name: row.name,
          location: row.location || "default",
          size: row.size || "0 bytes",
          sizeBytes: parseInt(row.size_bytes || "0"),
          usagePercent: undefined, // Would need disk space info
        });
      }

      // Get WAL info (if superuser or has permissions)
      try {
        const walRes = await client.query(STORAGE_WAL_SQL);

        if (walRes.rows.length > 0) {
          results.push({
            name: "WAL",
            location: "pg_wal",
            size: walRes.rows[0].wal_size || "0 bytes",
            sizeBytes: parseInt(walRes.rows[0].wal_size_bytes || "0"),
            walSize: walRes.rows[0].wal_size || "0 bytes",
            walSizeBytes: parseInt(walRes.rows[0].wal_size_bytes || "0"),
          });
        }
      } catch {
        // WAL info requires superuser, ignore if not available
      }

      return results;
    } finally {
      client.release();
    }
  }

  public async getPgStatActivity(): Promise<PgStatActivityRow[]> {
    this.ensureConnected();
    const client = await this.pool!.connect();
    try {
      const res = await client.query("SELECT * FROM pg_stat_activity");
      return res.rows as PgStatActivityRow[];
    } finally {
      client.release();
    }
  }
}
