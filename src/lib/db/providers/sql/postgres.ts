/**
 * PostgreSQL Database Provider
 * Full PostgreSQL support with connection pooling
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig as PgPoolConfig, type QueryConfig } from "pg";
import { SQLBaseProvider } from "./sql-base";
import {
  type DatabaseConnection,
  type OpenQueryTransactionOutcome,
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
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type ContainerLevelSpec,
  type ObjectSourceDocument,
  type ObjectEditBuild,
  type ObjectEditOutcome,
  type ObjectEditPlan,
  type ObjectEditRefusalClass,
  type ObjectEditRequest,
  type ObjectEditStep,
  type ObjectPartEdit,
  type ObjectSourceForm,
} from "../../types";
import {
  applySourceBound,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  kindAcceptsSourceEdits,
  requireEditableKind,
  requireSourceKind,
} from "../../object-kinds";
import { EDIT_CHARACTER_LIMIT, userPositionOf } from "../../object-edit";
import { connectionFingerprint } from "../../connection-fingerprint";
import { comparePaths } from "../../object-path";
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

/** One row of `CONTAINERS_SQL`. */
interface ContainerRow {
  name: string;
  is_session_default: number;
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

/** One row of a bulk detail read: the same four aggregates, plus the relation's own name. */
type BulkDetailRow = ObjectDetailRow & { name: string };

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
 * absence, and the row count is optional so the badge simply is not drawn -
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
// `current_schema()` marks the session's own, which standing ruling 5a2 requires of every
// provider with container levels and this one answered for none. It is the SERVER'S answer
// and not the literal `public`: measured on the seeded postgres:18 fixture, a fresh
// connection reports search_path `"$user", public` and current_schema `public`, and a
// connection that sets search_path moves it. Without the mark the object browser's flat
// join had no tie-breaker, so a bare `orders` answering to both `app.orders` and
// `public.orders` was refused as ambiguous rather than read as the session's own (#789).
const CONTAINERS_SQL = `
        SELECT
          n.nspname AS name,
          (n.nspname = current_schema())::int AS is_session_default
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
// The signature is the ARGUMENT TYPES and nothing else. Two overloads differ by types and
// never by parameter names, so a name in the segment adds nothing to identity while making
// the identity change when somebody renames a parameter - and a path segment that carries
// information irrelevant to identity is wrong even when it happens to round-trip through
// DROP. `pg_get_function_identity_arguments()` is the obvious candidate and is NOT used
// for exactly that reason: measured on postgres:18 it renders the parameter name and mode,
// answering `order_total(order_id integer)` and `touch_order(IN order_id integer)`.
//
// This form answers `order_total(integer)`, `touch_order(integer)` and `stamp_updated_at()`.
// It is `oid::regprocedure` without the schema qualification, which is the point:
// regprocedure prepends the schema and the path already carries it, so using it directly
// would say `app` twice. Measured over all 3402 routines in pg_catalog, the two agree on
// 3315; the 87 that differ are every case where regprocedure double-quotes a RESERVED-WORD
// routine name (`"char"(integer)`, `"position"(text,text)`), and the argument list is
// identical in all 87. Quoting is a fact about SQL text and this segment is data, so the
// bare `proname` is the right half of that disagreement. Uniqueness was checked rather
// than assumed: across every schema on that server, no two routines share a segment.
//
// COALESCE is load-bearing. `array_to_string` over an empty array answers NULL, not the
// empty string, so a zero-argument routine would otherwise have a NULL identity and no
// address at all.
//
// ONE WRITER for the expression itself (#789 Phase 2): the listing PRODUCES the segment and
// the source read CONSUMES it, so a second copy of this expression is a second chance for the
// two to disagree about what a routine's address is, and the read would then answer "no such
// routine" for an object the tree had just listed.
const ROUTINE_IDENTITY_EXPR = `p.proname || '(' || COALESCE(pg_catalog.array_to_string(ARRAY(
            SELECT pg_catalog.format_type(t, NULL) FROM unnest(p.proargtypes) AS t), ','), '') || ')'`;

const LIST_ROUTINES_SQL = `
        SELECT
          p.proname AS name,
          ${ROUTINE_IDENTITY_EXPR} AS identity
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

// ============================================================================
// Object source (#789 Phase 2)
// ============================================================================

/**
 * The `pg_get_*` call each source-bearing kind is read with, and what its text IS.
 *
 * THE OID IS PASSED AND A NAME CAST IS NEVER USED, which is the one rule nobody would have
 * written from the documentation. `pg_get_viewdef('app.order_summary'::regclass, false)`
 * resolves the NAME first, and name resolution needs `USAGE` on the schema: measured on
 * PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1), a role holding nothing at all got
 * `ERROR: 42501: permission denied for schema app` from the cast and the COMPLETE text from
 * `pg_get_viewdef(<oid>, false)` in the same session, while `SELECT app.order_total(1)` was
 * refused. So a provider that casts manufactures a refusal the engine never made, on an
 * object the tree has already listed. Every statement below joins `pg_namespace` on the
 * schema NAME, which any caller may read, and hands the catalog's own `oid` to the function.
 *
 * `false` for the pretty flag, on all three functions, and the reason is PostgreSQL's own:
 * "the default format is more likely to be interpreted the same way by future versions of
 * PostgreSQL; so avoid using pretty-printed output for dump purposes". Phase 3 may submit
 * this text back.
 *
 * Fully parameterised, every one of them, which is why they are preferred over any
 * `SHOW`-shaped alternative: no identifier escaper is needed on this engine because no
 * caller-supplied name ever reaches statement TEXT.
 */
function viewSourceSql(relkind: string): string {
  return `
        SELECT pg_catalog.pg_get_viewdef(c.oid, false) AS definition
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = ${relkind}`;
}

// The routine's last path segment is the identity the LISTING wrote, so the same expression
// is on both sides of the comparison. `prokind` is bound rather than interpolated, exactly
// as the listing binds it.
// FIVE columns beyond the definition, and every one of them is read by the EDIT rather than
// by the pane (#789 Phase 3). The read is ONE statement for both callers on purpose: the
// build re-reads the object through the same expression the LISTING wrote, so the identity
// the tree published, the identity the pane read and the identity the guard block compares
// are the same three characters of SQL and cannot drift into three answers.
//
// `md5(pg_get_functiondef(p.oid))` is the revision, computed SERVER SIDE, and the four
// candidates measured against it on PostgreSQL 18.4 were all rejected: `xmin` moves on a
// byte-identical replace and on a GRANT EXECUTE, so it produces FALSE conflicts; `ctid` moves
// on a plain VACUUM FULL while `xmin` survives; a frozen catalog row reports `xmin` of 1; and
// `proconfig` records nothing about the body at all. The md5 of the engine's own rendering did
// not move on COMMENT ON or on GRANT EXECUTE and did move on a real body change.
//
// THE SAME MEASUREMENT MAKES `xmin` THE RIGHT POST-CONDITION, and the two are not in tension:
// a revision answers "is the TEXT still the one I read", where a move that changed nothing is a
// false conflict, and the post-condition answers "was the ROW I addressed the row that got
// written", where a move that changed nothing is the whole signal. `buildObjectEdit` reads this
// md5 for the guard and the emitted unit reads `xmin` for the post-condition, and neither is
// used for the other's question.
//
// `pg_has_role(current_user, p.proowner, 'USAGE')` is ONE expression rather than a comparison
// against `current_user` plus a membership query, because a role IS a member of itself: the
// single call is true for the owner and for any member of the owning role, which is exactly
// the population `CREATE OR REPLACE` accepts. MEASURED on 18.4: `CREATE OR REPLACE` on
// somebody else's function is an OWNERSHIP check and not a privilege check, it answers
// `must be owner of function order_total` with SQLSTATE 42501, and the shipped error mapper
// turns that into HTTP 500 because the message matches none of its substrings.
//
// The two `current_setting` columns are the session facts the plan pins and asserts, read at
// BUILD so the preview can show the reader what the apply will run under.
//
// `check_function_bodies` has two readers, the build's third refusal and the pre block's LB002
// assertion. `search_path` HAS NONE TODAY, and that is recorded rather than left for the next
// reader to discover: the plan pins the object's own container schema plus `pg_catalog`, which is
// derived from the path and never from this column, so the value the connection happened to carry
// is read and then dropped. It stays selected because it is the session fact the pin REPLACES,
// which is the one thing a reader asking "what did my apply run under, and what would it have run
// under" needs, and the surface that will show it is the preview's session list rather than this
// provider. Nothing in this file reads `row.search_path`: `grep` it and the answer is this
// comment.
//
// The oid is still passed and never cast, for `viewSourceSql`'s measured reason, and
// `ROUTINE_IDENTITY_EXPR` is still the single writer of the identity expression.
const SOURCE_ROUTINE_SQL = `
        SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition,
               md5(pg_catalog.pg_get_functiondef(p.oid)) AS revision,
               pg_catalog.pg_get_userbyid(p.proowner) AS owner,
               pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE') AS may_replace,
               current_setting('search_path') AS search_path,
               current_setting('check_function_bodies') AS check_function_bodies
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind = $2 AND ${ROUTINE_IDENTITY_EXPR} = $3`;

// Three binds, because a trigger is addressed by its TABLE as well as by its name: `tgname`
// is unique per table and not per schema, which is the nesting `attachedTo: "table"` declares
// and `LIST_TRIGGERS_SQL` produces. `NOT tgisinternal` is the same exclusion the listing and
// the count apply, so a path this provider never listed cannot be read here either.
const SOURCE_TRIGGER_SQL = `
        SELECT pg_catalog.pg_get_triggerdef(t.oid, false) AS definition
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal`;

/**
 * What ONE kind's definition text is, alongside the statement that reads it.
 *
 * `form` travels WITH the statement rather than in a second record, so a kind cannot gain a
 * reader and keep somebody else's description of what that reader returns.
 */
interface SourceStatement {
  readonly sql: string;
  readonly params: unknown[];
  readonly form: ObjectSourceForm;
}

/**
 * The relation-shaped source statements, keyed by kind and built from the SAME relkind map
 * the listing uses, so a kind cannot be read under one relkind and listed under another.
 *
 * `table` and `sequence` are absent, and that is the declaration: there is no
 * `pg_get_tabledef` and no `pg_get_sequencedef`, and `pg_catalog.pg_sequences` publishes a
 * sequence's properties rather than any text.
 */
const SOURCE_VIEW_SQL: Record<string, string> = {
  view: viewSourceSql(RELKIND_BY_KIND.view),
  materialized_view: viewSourceSql(RELKIND_BY_KIND.materialized_view),
};

/** The attached kinds' source statements, keyed the way `SOURCE_VIEW_SQL` is keyed. */
const SOURCE_ATTACHED_SQL: Record<string, string> = { trigger: SOURCE_TRIGGER_SQL };

/**
 * Which statement reads one kind's definition, or nothing when this file has no reader.
 *
 * `partial` for a view and a materialized view because `pg_get_viewdef` answers the bare
 * `SELECT` and no `CREATE`, measured on 18.4; `complete` for the three the engine wraps in a
 * runnable `CREATE OR REPLACE` or `CREATE TRIGGER`. Nothing here reads the database TYPE id,
 * and the kind ids it does read are the same ones `objectListingStatement` reads, for the
 * same reason: which catalog answers is a per-kind fact.
 */
function sourceStatement(
  schema: string,
  kind: string,
  name: string,
  attachedTo: string | undefined,
): SourceStatement | undefined {
  const relation = SOURCE_VIEW_SQL[kind];
  if (relation !== undefined) return { sql: relation, params: [schema, name], form: "partial" };
  const prokind = PROKIND_BY_KIND[kind];
  if (prokind !== undefined) return { sql: SOURCE_ROUTINE_SQL, params: [schema, prokind, name], form: "complete" };
  // BOTH halves are required and neither is a position: the KIND says which catalog answers,
  // and the DECLARATION says the object hangs off a parent whose segment the path carries. A
  // second attached kind added later without a reader here falls out as undefined rather than
  // being read out of `pg_trigger`.
  const attached = SOURCE_ATTACHED_SQL[kind];
  if (attached !== undefined && attachedTo !== undefined) {
    return { sql: attached, params: [schema, attachedTo, name], form: "complete" };
  }
  return undefined;
}

/**
 * The id of the ONE part every PostgreSQL source read produces (#789 Phase 2, Phase 3).
 *
 * ONE writer for two readers: `readObjectSource` writes it onto the part and `buildObjectEdit`
 * refuses a request naming any other, so a caller cannot address a part this provider never
 * produced. Two literals would let the read and the build disagree about the same string, and
 * the disagreement would surface as an apply against a part nobody had shown.
 */
const SOURCE_PART_ID = "definition";

/**
 * The engine's own rendering of the routine's HEADER, which is what identity is compared on
 * (#789 Phase 3).
 *
 * Everything up to and including the parenthesis that CLOSES THE PARAMETER LIST, found by a scan
 * that counts nesting and skips both kinds of quoted text, and no parser beyond that. The
 * comparison itself stays a byte comparison and that is exact rather than approximate for one
 * reason: both sides are `pg_get_functiondef` output, because the reader started from it and the
 * build re-read it. So the question is never "does this parse to the same signature", it is "are
 * these the same bytes the engine wrote".
 *
 * MEASURED on PostgreSQL 18.4 why the identity has to be refused at all: a `CREATE OR REPLACE
 * FUNCTION` with a changed argument type is a SILENT SUCCESS that creates a SECOND `pg_proc` row
 * and leaves the original untouched, after which every call site fails `42725 is not unique`.
 *
 * WHY IT IS NOT `indexOf(")")`, which is what it was until the second external review of PR #831
 * found it. The first `)` is not the header's own whenever anything before the parameter list
 * closes carries one, and MEASURED on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) four ordinary
 * shapes do: a parameter DEFAULT holding a call, rendered `DEFAULT abs('-1'::integer)`; a DEFAULT
 * holding a `)` inside a string literal, rendered `DEFAULT ')'::text`; a quoted function NAME, as
 * in `app."we)ird"(a integer, b integer)`; and a quoted PARAMETER name, as in
 * `app.pn("a)b" integer, c integer)`. Everything after that early cut was uncompared, so a change
 * to a LATER parameter passed the check that exists to stop it. MEASURED through this provider on
 * 2026-09-14: the build ACCEPTED `b integer DEFAULT 2` -> `b bigint DEFAULT 2` on `app.dc` and
 * sealed a plan for it, and the apply then answered `applied-elsewhere` with `undone: true`,
 * because the post-condition found the addressed row unrewritten and rolled the unit back.
 *
 * WHY BOTH QUOTE KINDS ARE TRACKED AND WHY EACH IGNORES THE OTHER, which is two guards and not
 * one: PostgreSQL 18.4 renders `app.mix("a')b" integer, c integer)` and
 * `app.mix2(a text DEFAULT '")'::text, b integer DEFAULT 1)` back exactly as written, so a `'`
 * inside a quoted identifier and a `"` inside a string literal both reach this scan. Toggle
 * either flag while the other is set and the scan leaves the quoted run at the wrong character.
 *
 * WHAT THE PARAMETER TYPE MODIFIERS DO, which is the case a reader expects to be the dangerous one
 * and is not: `pg_get_functiondef` renders parameter types through `format_type(t, NULL)` and the
 * modifier is DROPPED. MEASURED on 18.4, a function declared
 * `(a numeric(10,2), b varchar(9), c char(5), d time(3), e timestamp(3), f decimal(8,4),
 * g interval hour to second(2), h bit(4))` renders as
 * `(a numeric, b character varying, c character, d time without time zone,
 * e timestamp without time zone, f numeric, g interval, h bit)`, with no parenthesis left in it.
 * So a typmod can only ever reach this comparison from the text the READER submitted.
 *
 * WHY THE SCAN CANNOT FALSE-ACCEPT even where it parses the submitted text wrongly, which it will
 * for a shape `pg_get_functiondef` never renders, a dollar-quoted DEFAULT being the one to expect:
 * the CURRENT text is always the engine's own rendering and is cut at the right place, so an
 * accept requires the submitted cut to produce those exact bytes, and any mis-cut of the submitted
 * text produces different ones and refuses. The error is one-directional by construction.
 *
 * WHEN THE SCAN FINDS NO CLOSING PARENTHESIS AT ALL it answers the whole text, which is the
 * behaviour the `indexOf` reading had for the same case. A submitted text with no closed parameter
 * list is SQL no engine will take, and it is refused here rather than sent.
 *
 * THE LIMIT IN THE FALSE-REFUSE DIRECTION, which the wave 5 review MEASURED and which this
 * function cannot close: `pg_get_functiondef` renders parameter DEFAULTS inside this header, and a
 * changed DEFAULT is an ordinary in-place replace. MEASURED on 18.4,
 * `CREATE OR REPLACE FUNCTION app.f_def(a integer DEFAULT 1)` re-created as `DEFAULT 2` left
 * `count(*) = 1` and `oid = 16787` with `xmin` moving 857 -> 858, and the rendering then said
 * `DEFAULT 2`. So this refusal REFUSES an edit PostgreSQL would have performed. It stays refused
 * rather than parsed apart, because telling a changed DEFAULT from a changed argument list inside
 * the rendered header needs a parser for the header and this design has none: to a byte comparison
 * they are the same bytes. A parameter RENAME and a parameter typmod the reader adds are in that
 * same class, both MEASURED on 18.4 as in-place replaces: adding `numeric(10,2)` to a parameter
 * already rendered `numeric` left `oid = 16385` with `xmin` moving 754 -> 779. What the refusal
 * must NOT do is state a fork it cannot know, which is what its sentence did until the wave 5
 * measurement, and `docs/providers/postgres.md` carries both directions of the limit.
 *
 * WHY THIS IS A SECOND SCANNER AND NOT A SHARED ONE with `trinoFunctionSegmentParts`, which counts
 * nesting and quotes for the same reason: the two scans differ in every dimension that would have
 * to agree. That one runs RIGHT TO LEFT over a bounded path segment that is known to end in `)`
 * and splits it into a name and an argument list; this one runs LEFT TO RIGHT over an unbounded
 * document to find where a prefix ends. That one toggles on `"` only, because a Trino type list
 * has no other quote; this one has to toggle on `'` as well, because PostgreSQL renders parameter
 * DEFAULTS as string literals inside the text it scans. A shared helper would take a direction, an
 * alphabet and a return shape as parameters and would be longer than both of its callers.
 */
function routineIdentityHeader(text: string): string {
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    // A doubled quote is PostgreSQL's escape for both kinds and it needs no arm of its own: it
    // toggles the flag twice, which leaves it where it started.
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (single || double) continue;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return text;
}

/**
 * SQLSTATE to an apply verdict, AS DATA (#789 Phase 3).
 *
 * A TABLE and never a chain of message substrings, and the reason is a shipped defect this
 * apply must not inherit: `errors.ts` turns a message containing `permission denied` into an
 * `AuthenticationError` answered HTTP 401, so a `42501` on an apply would send a user whose
 * credential is connected and correct back to re-enter a password that was never wrong, and a
 * `42P13` becomes HTTP 500 because its message matches none of its substrings.
 *
 * THE THREE PRIVATE CODES are this design's own, raised by the emitted unit's guard blocks, and
 * they are three codes rather than one because they mean three DIFFERENT outcomes. `LB001` is a
 * lost update detected before anything was written, `LB002` is a session fact that moved between
 * the build and the apply, and `LB003` is the post-condition finding that the addressed object
 * did not change, which on this engine is a fork the same round trip has already rolled back.
 * All three are in the range PostgreSQL documents for user-defined conditions.
 *
 * THE FIVE ENGINE CODES were measured on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1): `42501` is the
 * ownership refusal `must be owner of function order_total`, `42601` is a syntax error in the
 * submitted body, `42P13` is `cannot change return type of existing function`, `42809` is a
 * routine addressed as the wrong kind, and `42P16` is an invalid table definition reached through
 * a `BEGIN ATOMIC` body.
 *
 * D62, CARRIED AS A NAMED LIMIT rather than closed: this type id also serves CockroachDB and
 * Materialize and neither was probed, so a code not in this table is `definition` carrying THE
 * ENGINE'S OWN SENTENCE, which is a true report of a refusal this product does not recognise
 * rather than a guess at which class it belongs to.
 */
const APPLY_VERDICT_BY_SQLSTATE: Readonly<Record<string, ObjectEditRefusalClass | "conflict" | "applied-elsewhere">> =
  Object.freeze({
    LB001: "conflict",
    LB002: "guard",
    LB003: "applied-elsewhere",
    "42501": "privilege",
    "42601": "definition",
    "42P13": "definition",
    "42809": "definition",
    "42P16": "definition",
  });

/**
 * The ONE message this apply reads, and the measurement that makes it the only one.
 *
 * MEASURED through the product: two overlapping applies of one object answered
 * `tuple concurrently updated` after blocking for 2.8 seconds, at HTTP 500 `DATABASE_ERROR`,
 * with a sentence no user can act on. The engine reports it under `XX000`, the catch-all
 * internal-error class, so there is nothing else to read: the code cannot distinguish it from
 * any other internal error. It is checked AFTER the table above, so a SQLSTATE this design
 * recognises always wins and the message is only ever consulted for a code that is not data.
 *
 * THE EVIDENCE CLASS OF THAT ORDERING, named because the wave 5 review found it certified by prose
 * alone and its mutation surviving: the precedence is asserted by a test that feeds this classifier
 * an error carrying `42P13` AND this message, which is a SYNTHETIC error. No code in the table was
 * observed carrying this message on 18.4. What the test certifies is a property of this file, that
 * one error has two readers and the code reads first, and there is no other way to certify it.
 */
/**
 * The transaction-local custom GUC the apply's PRE block stashes the addressed row's `xmin` in,
 * written ALREADY QUOTED because it is a SQL literal in two places (#789 Phase 3).
 *
 * ONE writer for two readers: the `set_config` in the pre block and the `current_setting` in the
 * post block are the same name, and two literals would let the capture and the comparison drift
 * into two names, after which the post block raises `42704 unrecognized configuration parameter`
 * on every apply.
 *
 * It is a constant rather than a value derived from anything, so nothing a caller controls reaches
 * it and no quoting question arises.
 *
 * WHAT IT LEAVES BEHIND, MEASURED on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) rather than assumed,
 * because "transaction-local" is two different answers depending on who asks. `set_config(...,
 * true)` inside the apply's implicit transaction is visible to the post block in the same round
 * trip. A NEW session answers `ERROR: unrecognized configuration parameter "libredb.row_version"`.
 * THE SAME POOLED SESSION, which is the one that matters here because D73 measured session state
 * persisting across Studio users on the cached provider, keeps the placeholder and reads it back as
 * the EMPTY STRING: `current_setting('libredb.row_version', true)` answered null before the apply
 * and `""` after it on backend pid 167. The captured value does not survive, so nothing leaks and
 * no later apply can read a stale row version: the pre block writes it before the post block reads
 * it, in the same transaction, or the pre block raised and there is no post block.
 *
 * The one shape that would read the empty string is a capture subquery answering NULL, which
 * `set_config` stores as `''` rather than as NULL (MEASURED: `set_config(..., NULL, true)` returns
 * `''` and reads back `= '' -> t`). It is unreachable here rather than handled: an absent row makes
 * the md5 guard above it NULL, `IS DISTINCT FROM` the revision, and LB001 raises first.
 */
const ROW_VERSION_SETTING_LITERAL = "'libredb.row_version'";

const CONCURRENT_UPDATE_SENTENCE = "tuple concurrently updated";

/**
 * Whether a failed source read is the SERVER refusing rather than nobody answering.
 *
 * Two codes and no others, and both are a wire-compatible FORK missing a piece of PostgreSQL
 * rather than a permission: 42883 is "function ... does not exist", which a fork without
 * `pg_get_functiondef` answers, and 42703 is "column ... does not exist", which a fork
 * without `pg_proc.prokind` answers for the routine statement. This type id serves CockroachDB
 * and Materialize, so both arms are reachable. Both were measured on PostgreSQL 18.4 by asking
 * for a function and for a column that do not exist.
 *
 * Everything else RAISES, deliberately, and the narrowness is the point: a transport failure
 * is nobody answering at all, and rendering "Connection terminated unexpectedly" in the Source
 * pane as this object's own refusal would present a symptom as a fact about the object. That
 * is the same rule the Redis source read states, in this engine's vocabulary.
 *
 * There is no privilege arm here and that absence is MEASURED rather than an oversight: the
 * `pg_get_*` family applies no privilege check at all (see `viewSourceSql`), so PostgreSQL has
 * no privilege-driven refusal for object source to report.
 */
function isMissingSourceCatalogError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "42883" || code === "42703";
}

/**
 * One row of a source read, with the five columns only the ROUTINE statement answers.
 *
 * All five are optional because the view and trigger statements select `definition` alone and
 * every one of them is absent on those rows. A reader that assumed them present would read
 * `undefined` as a fact about the object rather than as a fact about which statement ran, so
 * the only consumer of the five, `routineEditAffordance` and `buildObjectEdit`, is reached only
 * for a kind that declared `acceptsSourceEdits`, which is only ever a routine kind.
 */
interface SourceRow {
  definition: string | null;
  revision?: string | null;
  owner?: string | null;
  may_replace?: boolean | null;
  search_path?: string | null;
  check_function_bodies?: string | null;
}

/**
 * The edit affordance for one routine, and the ONE place the ownership sentence is written
 * (#789 Phase 3).
 *
 * MEASURED on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1): `CREATE OR REPLACE FUNCTION` on an
 * object owned by another role answers `ERROR: must be owner of function order_total` with
 * SQLSTATE 42501, and it does so with `GRANT USAGE` and `GRANT CREATE` on the schema already
 * held, which is the control `docker/postgres-init/03-object-fixture.sql` creates: the check is
 * OWNERSHIP and not privilege, so no grant can make the apply work. That is why the answer is
 * given on the READ, before the reader types anything.
 *
 * The sentence names the OWNER, because the reader's next action is to connect as a role that
 * is a member of it and nothing else on the screen can tell them which role that is. It is the
 * provider's own sentence rather than the engine's, because the engine has not spoken yet: no
 * statement has been sent, and quoting `must be owner of function order_total` here would put
 * an error the server never answered into a pane that is only reading.
 *
 * `may_replace` is `pg_has_role(current_user, proowner, 'USAGE')`, which is true for the owner
 * and for any member of the owning role, and a NULL or absent value reads as false: an answer
 * this provider could not get is never an offer to write.
 */
function routineEditAffordance(row: SourceRow, schema: string, name: string): ObjectPartEdit {
  if (row.may_replace === true) return { offered: true };
  return {
    offered: false,
    reason:
      `this connection's database account does not own "${schema}.${name}", ` +
      `which is owned by "${row.owner ?? "another role"}", ` +
      "and PostgreSQL checks ownership rather than privilege for CREATE OR REPLACE",
  };
}

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
// unqualified base type. NULL is used because that is nearly always what
// `information_schema.columns.data_type` says, so this surface and the flat schema tree
// name a column's type identically while both are live. Verified column by column on
// `app.orders`.
//
// ONE measured exception, found while reshaping this statement into the bulk read (#789):
// an ARRAY column. `app.products.tags` is `text[]`, which is what `format_type` answers and
// what both object-model surfaces show, while `information_schema.columns.data_type` says
// the bare word `ARRAY` and hides the element type in `element_types`. The two surfaces
// disagree on exactly those columns, and the object model has the better half of the
// disagreement, so this is recorded rather than repaired.
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
 * Every relation of one kind in one schema, with its columns, primary key, foreign keys
 * and indexes, in ONE statement (#789).
 *
 * Reshaped from `OBJECT_DETAIL_SQL`, which is itself reshaped from `SCHEMA_FULL_SQL`, and
 * the lineage is the point: those bodies carry which catalog answers which fact and which
 * schemas are excluded, all of it measured, and a new statement would have thrown that
 * away. The difference from the single-object form is exactly one CTE - `described` picks
 * the target set by RELKIND instead of by name - and the joins then key on that set's
 * `relname` instead of on a bound `$2`.
 *
 * Columns come from `pg_attribute` for the reason `CTE_OBJECT_COLUMNS` records:
 * `information_schema.columns` is defined over relkinds 'r', 'v', 'f' and 'p' only, so it
 * answers nothing at all for a materialized view or a sequence. `CTE_COLUMNS_INFO`'s
 * `FILTER (WHERE c.ordinal_position <= 100)` is deliberately NOT carried over either: that
 * cap is invisible to the reader of the result, and an unreported bound is the defect
 * `ObjectDetailBatch.truncated` exists to prevent. What is bounded here is the number of
 * OBJECTS, by the caller, and it is reported.
 *
 * The `AS MATERIALIZED` hints are stripped for the same measured reason `OBJECT_DETAIL_SQL`
 * strips them: the hint forbids the planner from pushing `$1` into the shared CTEs, so it
 * computes every constraint and every index in the DATABASE to answer for one schema.
 * Measured with EXPLAIN (ANALYZE) on postgres:18, the seeded `app` schema of ten tables:
 * 6.5 ms stripped against 20.2 ms with the hints. The gap grows with the schema rather
 * than closing: on a 200-table schema built for this, 29 ms against 730 ms, a factor of 25.
 *
 * The plan COST estimate says the opposite on the small schema, 1301.35 stripped against
 * 1287.54 with the hints, which is why the decision is recorded from ANALYZE and not from
 * the estimate. The commands that rebuild that 200-table schema are in
 * `docs/providers/postgres.md`, so the number is re-runnable rather than asserted.
 *
 * `described` is referenced twice, so PostgreSQL materialises it on its own whatever the
 * hints say and the LIMIT is applied exactly once.
 *
 * `ORDER BY c.relname` inside `described` is what makes a bounded read deterministic, and
 * it is the one sort here that runs under the SERVER's collation rather than this process's
 * code-point order. That decides WHICH objects a bound keeps, and nothing else: the result
 * is re-sorted by path below, and a caller joins on path rather than on position.
 */
function bulkDetailSql(relkinds: string, bounded: boolean): string {
  const limit = bounded ? "\n          LIMIT $2" : "";
  return withoutMaterializedHint(`
        WITH described AS (
          SELECT c.oid, c.relname
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN (${relkinds})
          ORDER BY c.relname${limit}
        ),
        described_columns AS (
          SELECT
            d.relname,
            json_agg(
              json_build_object(
                'name', a.attname,
                'type', format_type(a.atttypid, NULL),
                'nullable', NOT a.attnotnull,
                'defaultValue', pg_get_expr(ad.adbin, ad.adrelid)
              ) ORDER BY a.attnum
            ) AS columns
          FROM described d
          JOIN pg_catalog.pg_attribute a ON a.attrelid = d.oid
          LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attnum > 0 AND NOT a.attisdropped
          GROUP BY d.relname
        ),${CTE_PK_INFO},${CTE_FK_INFO},${CTE_INDEX_INFO}
        SELECT
          d.relname AS name,
          COALESCE(dc.columns, '[]'::json) as columns,
          COALESCE(pk.pk_columns, ARRAY[]::text[]) as pk_columns,
          COALESCE(fk.foreign_keys, '[]'::json) as foreign_keys,
          COALESCE(ii.indexes, '[]'::json) as indexes
        FROM described d
        LEFT JOIN described_columns dc ON dc.relname = d.relname
        LEFT JOIN pk_info pk ON pk.table_schema = $1 AND pk.table_name = d.relname
        LEFT JOIN fk_info fk ON fk.table_schema = $1 AND fk.table_name = d.relname
        LEFT JOIN index_info ii ON ii.table_schema = $1 AND ii.table_name = d.relname;
      `);
}

const BULK_DETAIL_SQL: Record<string, string> = Object.fromEntries(
  Object.entries(RELKIND_BY_KIND).map(([kind, relkinds]) => [kind, bulkDetailSql(relkinds, false)]),
);

const BULK_DETAIL_SQL_BOUNDED: Record<string, string> = Object.fromEntries(
  Object.entries(RELKIND_BY_KIND).map(([kind, relkinds]) => [kind, bulkDetailSql(relkinds, true)]),
);

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` is what decides, never `containerLevels.length`.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The one schema a container path names on this engine.
 *
 * Both the expected DEPTH and the schema's POSITION are read off the declaration, and
 * neither may be written as a constant. This function used to be `container.length !== 1`
 * returning `container[0]`, which is two of the three spellings standing ruling 5g names,
 * and the bulk column read routed its container through it. Both are behaviour-identical
 * on a one-level engine, which is exactly why they survived: no fixture of PostgreSQL can
 * tell them from the derived form, and on a two-level declaration the first refuses every
 * valid path while the second binds the catalog where the schema belongs.
 *
 * A path of another depth is a caller that built it from another engine's shape, and it
 * raises rather than reading a segment and carrying on: `undefined` bound to `$1` would
 * answer an empty folder that looks exactly like a schema holding nothing.
 */
function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === "schema");
  const segment = container.length === levels.length && index >= 0 ? container[index] : undefined;
  if (segment === undefined) {
    throw new QueryError(
      `A PostgreSQL container path is [${levels.map((level) => level.id).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "postgres",
    );
  }
  return segment;
}

/**
 * The shape one kind's object path has, refused rather than read from the wrong segment.
 *
 * Derived, not counted. `2` and `3` are right for a one-level engine and wrong for the five
 * two-level ones in this epic, and a provider copying this file must not inherit a literal
 * that refuses every valid path on a catalog-plus-schema engine. The segment names come from
 * the declared level labels, so the message and the depth cannot disagree: they are the same
 * array.
 *
 * ONE writer for two readers since #789 Phase 2. `describeObject` and `readObjectSource` ask
 * the same question about the same path, and two copies of this derivation is two chances for
 * the detail pane and the Source tab to disagree about what a trigger's address is.
 *
 * The levels come from `declaredLevels()` and never from `containerLevels.length`, which is
 * what this function counted when the hoist inherited it from `describeObject`. The two agree
 * at every depth `ContainerLevels` admits, and they disagree past it: `containerDepth()`
 * saturates at two, so a third declared level made this check demand four segments while
 * `readObjectSource` sliced the container at two and handed `containerSchema` a two-segment
 * path. One reader, which is what the `declaredLevels` docblock twelve lines up already said.
 */
function assertObjectPathShape(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  kind: string,
  path: readonly string[],
): void {
  const segments = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  if (spec.attachedTo !== undefined) segments.push(spec.attachedTo);
  segments.push("name");
  if (path.length !== segments.length) {
    throw new QueryError(
      `A PostgreSQL "${kind}" path is [${segments.join(", ")}], received ${JSON.stringify(path)}`,
      "postgres",
    );
  }
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
 *
 * It takes the WHOLE CONTAINER and not the schema segment. This used to be
 * `objectPath(container, row)` opening with `[schema]`, which is behaviour-identical on this
 * one-level engine and silently wrong the moment the declaration grows a level: the listing
 * and the bulk read both build their paths here, so at depth 2 they would have agreed with
 * each other on an address that had lost its outer segment. `containerSchema()` has already
 * refused any container that is not exactly the declared depth, so what arrives here is the
 * container the declaration describes (standing ruling 5g, #789).
 */
function objectPath(container: readonly string[], row: ObjectRow): string[] {
  const segments = [...container];
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
/**
 * One catalog row turned into one `ObjectDetail`, shared by the single and the bulk read.
 *
 * One function because the two statements select the same four aggregates and a caller
 * joins their results together: two copies of this mapping would be two chances for the
 * bulk read to spell a foreign key differently from the single read of the same table.
 *
 * `referencedTable` is spelled the way `getSchema()` spells it, public-qualified and
 * joined with a dot, because `ForeignKeySchema` carries one string and both surfaces are
 * live through Phase 1. The phase that removes `getSchema` is where that string becomes a
 * path.
 */

function objectDetailFromRow(path: readonly string[], row: ObjectDetailRow): ObjectDetail {
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
    foreignKeys: (row.foreign_keys || []).map((fk) => ({
      columnName: fk.columnName,
      referencedTable:
        fk.referencedSchema === "public" ? fk.referencedTable : `${fk.referencedSchema}.${fk.referencedTable}`,
      referencedColumn: fk.referencedColumn,
    })),
  };
}

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

// getPerformanceMetrics: which view carries the checkpoint timings. PostgreSQL 17
// moved them from pg_stat_bgwriter to pg_stat_checkpointer and renamed them, so the
// server is asked whether the new view exists rather than its version number, which
// a wire-compatible fork need not report in step with its catalog.
const PERF_CHECKPOINTER_PROBE_SQL = `
          SELECT pg_catalog.to_regclass('pg_catalog.pg_stat_checkpointer') IS NOT NULL AS has_checkpointer
        `;

// getPerformanceMetrics: checkpoint timings on PostgreSQL 17 and later.
const PERF_CHECKPOINTER_SQL = `
          SELECT
            write_time,
            sync_time
          FROM pg_catalog.pg_stat_checkpointer
        `;

// getPerformanceMetrics: checkpoint timings before PostgreSQL 17.
const PERF_BGWRITER_CHECKPOINT_SQL = `
          SELECT
            checkpoint_write_time AS write_time,
            checkpoint_sync_time AS sync_time
          FROM pg_catalog.pg_stat_bgwriter
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

  /**
   * The pooled client the most recent `query()` ran a statement on, kept so that
   * `endOpenQueryTransaction()` can name it (D71).
   *
   * A reference to a RELEASED client, deliberately, and it is not a leak: `release()`
   * returns the client to the pool's idle list without ending it, so the object stays a
   * live `pg` Client and `getTransactionStatus()` on it still reports the last
   * ReadyForQuery status the server sent. Naming the client is the whole point — a
   * rollback issued through a fresh `pool.connect()` is not guaranteed to reach the
   * client the script's statements ran on, and rolling back somebody else's transaction
   * is worse than leaving this one open.
   */
  private lastQueryClient: PoolClient | null = null;

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
      // FIVE of the seven declare `hasSource`, all `pgsql` (#789 Phase 2). `table` and
      // `sequence` declare NOTHING, and that is a RESULT rather than a gap: PostgreSQL
      // publishes no `pg_get_tabledef` and no `pg_get_sequencedef`, and
      // `pg_catalog.pg_sequences` publishes a sequence's properties rather than any text. A
      // kind an engine cannot answer for is absent from the declaration and is never declared
      // and then refused, which is standing ruling 4 one level down.
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
        { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "pgsql" },
        {
          id: "materialized_view",
          role: "relation",
          label: "Materialized View",
          labelPlural: "Materialized Views",
          hasSource: true,
          sourceLanguage: "pgsql",
        },
        { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
        {
          id: "function",
          role: "routine",
          label: "Function",
          labelPlural: "Functions",
          hasSource: true,
          sourceLanguage: "pgsql",
          acceptsSourceEdits: true,
        },
        {
          id: "procedure",
          role: "routine",
          label: "Procedure",
          labelPlural: "Procedures",
          hasSource: true,
          sourceLanguage: "pgsql",
          acceptsSourceEdits: true,
        },
        {
          id: "trigger",
          role: "attached",
          label: "Trigger",
          labelPlural: "Triggers",
          attachedTo: "table",
          hasSource: true,
          sourceLanguage: "pgsql",
        },
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
      // `pool.end()` ends every client it holds. The reference kept for
      // `endOpenQueryTransaction()` would then name a dead client whose last reported
      // ReadyForQuery status never changes again, so it is dropped here rather than left
      // to answer for a session that no longer exists.
      this.lastQueryClient = null;
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
          // Recorded BEFORE the statement runs and kept after the release: a statement
          // that FAILS inside a transaction is exactly the case D71 is about, and the
          // client it failed on goes back to the pool in status "E".
          this.lastQueryClient = client;
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

  /**
   * End a transaction a statement run through `query()` left open on the pooled client
   * it borrowed (D71).
   *
   * The pool does not make an unfinished transaction benign here, it widens it. Measured
   * 2026-09-13 on PostgreSQL 17 through the product's own routes: a script that failed
   * inside its own BEGIN released the client in status "E", and every later request that
   * drew that client answered HTTP 500 "current transaction is aborted, commands ignored
   * until end of transaction block" — twelve retries over 60 seconds, 40 seconds of
   * idleness, a different user, and `POST /api/db/maintenance` eight minutes later. The
   * client is one of up to ten, so the connection does not fail, it fails INTERMITTENTLY
   * for every user on every route until the provider is evicted after 30 idle minutes.
   *
   * The status is the server's own, not an inference: `pg` records the ReadyForQuery
   * status byte of every statement ("I" idle, "T" in a transaction, "E" in a failed one)
   * and publishes it as `getTransactionStatus()` (pg 8.23). So no statement text is read
   * and no round trip is spent to find out — which matters, because the transaction can
   * be opened by a BEGIN inside a form no splitter sees through.
   *
   * ROLLBACK and not COMMIT: the argument is at `OpenQueryTransactionOutcome`. "E" leaves
   * no choice in any case — PostgreSQL ignores everything but a transaction-ending
   * command there, and COMMIT on an aborted transaction rolls back regardless.
   *
   * The interactive session `POST /api/db/transaction` drives is never touched: its
   * client is checked out for the session's whole life and handed back only by
   * `commitTransaction` / `rollbackTransaction` / `expireTransaction`, so `query()` never
   * borrows it and it can never be `lastQueryClient`.
   */
  public async endOpenQueryTransaction(): Promise<OpenQueryTransactionOutcome> {
    const client = this.lastQueryClient;
    if (client === null) return "none";

    const status = client.getTransactionStatus();
    if (status !== "T" && status !== "E") return "none";

    await client.query("ROLLBACK");
    return "rolled-back";
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
      return result.rows.map((row: ContainerRow) => ({
        path: [row.name],
        name: row.name,
        level: 0,
        isSessionDefault: Number(row.is_session_default) === 1,
      }));
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
    const schema = containerSchema(this.getCapabilities(), container);
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
      try {
        return await client.query(statement.withoutSize, statement.params);
      } catch (retryError) {
        // The retry is the last thing tried, so its failure is this method's failure and
        // leaves by the same door as the first one. It quotes the statement the server
        // actually received, which is the rewritten one.
        throw mapDatabaseError(retryError, "postgres", statement.withoutSize);
      }
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
    const schema = containerSchema(this.getCapabilities(), container);
    // Two questions, asked in order, and only the DECLARATION answers the first one.
    // Deciding "is this kind declared" from whether a listing statement exists made the two
    // methods disagree, and would have reported "declares no object kind" about a kind
    // `objectKinds` does declare but nothing here can list.
    if (findKind(this.getCapabilities(), kind) === undefined) {
      throw new QueryError(`PostgreSQL declares no object kind "${kind}"`, "postgres");
    }
    const statement = objectListingStatement(schema, kind);
    if (statement === undefined) {
      throw new QueryError(`PostgreSQL declares the kind "${kind}" but has no statement that lists it`, "postgres");
    }

    const client = await this.pool!.connect();
    try {
      const result = await this.queryListing(client, statement);
      return (
        result.rows
          .map((row: ObjectRow) => ({
            path: objectPath(container, row),
            name: row.name,
            kind,
            rowCount: estimatedRowCount(row.row_count),
            sizeBytes: measuredSizeBytes(row.size_bytes),
          }))
          // By PATH, not by name: two overloads of one routine share a name, so a name sort
          // leaves their order up to whatever the catalog happened to answer. Sorting by the
          // address also groups a table's triggers together. Segment by segment and never
          // `JSON.stringify(path)`, which standing ruling 5g refuses: the escape rewrites the
          // characters being compared, so a quoted name holding a double quote sorted by its
          // escape sequence instead of by itself.
          .sort((left, right) => comparePaths(left.path, right.path))
      );
    } finally {
      client.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the kinds this provider resolves in `pg_class` - the keys of
   * `RELKIND_BY_KIND` - have any of the three, so a routine and a trigger answer three
   * empty arrays without a round trip. That is a true fact about those kinds rather than
   * a failed read, `tests/helpers/object-surface-conformance.ts` states the same rule
   * from the caller's side, and listing a routine's parameters is Phase 2's job.
   *
   * Before the kind was passed, the same answer came out by accident. The detail statement
   * keys the LAST path segment against `pg_class.relname`, so `order_total(integer)`
   * returned no columns only because no relation is called that, and a trigger named
   * `orders` on table `customers` would have been handed `app.orders`'s 23 columns as if
   * they were its own. Correct by coincidence is what the kind removes.
   *
   * Path depth is derived from the declaration too: two segments, plus one where the kind
   * declares `attachedTo`, which is exactly the nesting `listObjects` produces.
   *
   * A statement that returns no row at all IS a failed read: `OBJECT_DETAIL_SQL`'s
   * aggregate has no GROUP BY, so on any server that ran it there is exactly one row, and
   * zero means the fallback chain rewrote it into something else.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) {
      throw new QueryError(`PostgreSQL declares no object kind "${kind}"`, "postgres");
    }

    assertObjectPathShape(this.getCapabilities(), spec, kind, path);

    if (RELKIND_BY_KIND[kind] === undefined) {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, OBJECT_DETAIL_SQL, [path[0], path[1]]);
      if (result.rows.length === 0) {
        throw new QueryError(`No detail row for ${path.join(".")}`, "postgres", OBJECT_DETAIL_SQL);
      }
      return objectDetailFromRow(path, result.rows[0] as ObjectDetailRow);
    } finally {
      client.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one schema (#789).
   *
   * ONE round trip for the whole folder, which is the entire reason this method exists:
   * the inventory route built the same answer as one `describeObject` per object, up to
   * 5000 sequential round trips, and removed it as an N+1. The statement is
   * `bulkDetailSql()`, reshaped from `OBJECT_DETAIL_SQL` so every measured catalog choice
   * and every fallback repair in `getSchema()`'s lineage still applies here.
   *
   * Only the kinds that resolve to a relation in `pg_class` - the keys of
   * `RELKIND_BY_KIND` - can have any of the three, so a routine and a trigger answer an
   * empty batch with no round trip at all, exactly as `describeObject` answers three empty
   * arrays for one of them. That is a true fact about those kinds and not a refused read,
   * so it is `{ details: [] }` rather than a throw or a truncation.
   *
   * The bound is the CALLER's and is never invented here. `limit + 1` is bound to the
   * statement, so a saturated read is distinguishable from an exact one without a second
   * count, the extra row is dropped, and `truncated` carries the caller's own limit. An
   * unbounded call runs the statement with no LIMIT clause and can never report
   * truncation - if this file ever caps a read of its own, it says so in the same field.
   *
   * The paths are built by `objectPath()`, the same rule `listObjects` builds its paths
   * with, because every caller joins the two answers on path. The sort is the same
   * code-point sort over segments for the same reason it is done there: three catalogs and
   * two collations cannot be relied on to agree.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    if (findKind(this.getCapabilities(), kind) === undefined) {
      throw new QueryError(`PostgreSQL declares no object kind "${kind}"`, "postgres");
    }
    const schema = containerSchema(this.getCapabilities(), container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a
      // truncation the caller never asked for, and a fraction reaches the server as a
      // bind it cannot use; both are caller mistakes and neither has a right answer to
      // guess at.
      throw new QueryError(
        `A PostgreSQL bulk column read limit must be a positive whole number, received ${limit}`,
        "postgres",
      );
    }
    if (RELKIND_BY_KIND[kind] === undefined) return { details: [] };

    const bounded = limit !== undefined;
    const sql = bounded ? BULK_DETAIL_SQL_BOUNDED[kind] : BULK_DETAIL_SQL[kind];
    // One row more than the bound, so the read itself says whether it stopped short.
    const params = bounded ? [schema, limit + 1] : [schema];

    const client = await this.pool!.connect();
    try {
      const result = await this.queryWithMaterializedFallback(client, sql, params);
      const rows = result.rows as BulkDetailRow[];
      const truncated = bounded && rows.length > limit;
      const details = (truncated ? rows.slice(0, limit) : rows)
        .map((row) => objectDetailFromRow(objectPath(container, row), row))
        .sort((left, right) => comparePaths(left.path, right.path));
      return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
    } finally {
      client.release();
    }
  }

  /**
   * One object's definition text, as PostgreSQL reconstructs it (#789 Phase 2).
   *
   * FIVE kinds can answer and the DECLARATION says which: `view`, `materialized_view`,
   * `function`, `procedure` and `trigger` declare `hasSource`, and `table` and `sequence`
   * declare nothing because PostgreSQL publishes no `pg_get_tabledef` and no
   * `pg_get_sequencedef`. A kind that declares nothing is refused here by name rather than
   * answered with a document holding nothing, and the refusal is read off the declaration and
   * never off a list of kind ids kept beside it.
   *
   * THE TEXT IS A RECONSTRUCTION AND THE DOCUMENT SAYS SO. PostgreSQL calls this output "a
   * decompiled reconstruction, not the original text of the command", so every part is
   * `origin: "regenerated"`; a view and a materialized view are `form: "partial"` because
   * `pg_get_viewdef` answers the bare `SELECT` with no `CREATE` around it, measured on 18.4.
   *
   * PASS THE OID, NEVER A CAST. The statements are in `viewSourceSql`, and the measurement
   * behind that rule is there too: the `pg_get_*` family applies NO privilege check, so a
   * caller who can SEE an object in the catalog can always read its definition, and the only
   * thing that can refuse is the NAME RESOLUTION a `regclass` or `regprocedure` cast performs.
   * A provider that casts manufactures a 42501 the engine never made.
   *
   * ABSENCE RAISES AND IS NEVER A REFUSAL PART. No row, a NULL definition and a
   * whitespace-only definition are one fact on this engine: the catalog holds no such object
   * at that address, measured (`pg_get_viewdef` answers NULL for an oid that is not a view).
   * PostgreSQL utters no sentence for it, so a refusal part here would carry OUR silence
   * dressed as the server's answer, and an empty part would put an empty editor over a
   * definition nobody read. The two refusal arms this method does report are a wire-compatible
   * FORK missing a catalog surface, and they carry the server's own sentence unprefixed.
   *
   * The schema is the container segment the DECLARATION names `schema` and the object name is
   * `path[path.length - 1]`, never a literal index: standing ruling 5g, pinned in this
   * provider's suite by a two-level declaration driven all the way to the binds.
   */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = requireSourceKind(capabilities, kind, { displayName: "PostgreSQL", type: "postgres" });
    assertObjectPathShape(capabilities, spec, kind, path);

    const depth = containerDepth(capabilities);
    const schema = containerSchema(capabilities, path.slice(0, depth));
    const name = path[path.length - 1];
    // What sits BETWEEN the container and the name, which is one segment per declared
    // attachment and empty for every other kind. `assertObjectPathShape` has already refused
    // any other length, so the last of these is the parent the declaration named.
    const nesting = path.slice(depth, path.length - 1);
    const statement = sourceStatement(schema, kind, name, nesting[nesting.length - 1]);
    if (statement === undefined) {
      throw new QueryError(
        `PostgreSQL declares readable source for the kind "${kind}" but has no statement that reads it`,
        "postgres",
      );
    }

    // THE EDIT AFFORDANCE IS A ROUTINE FACT, so a kind that declares an edit with no routine
    // statement behind it is refused here rather than drawn (D81). `routineEditAffordance` below
    // reads `may_replace` and `owner`, which only `SOURCE_ROUTINE_SQL` selects, so such a kind
    // would answer `offered: false` carrying "owned by another role": a DECLARATION DRIFT reported
    // in the words of an ownership problem, which is a sentence the reader cannot act on.
    // `routineAddress` is the BUILD's own guard over the same two lists and it raises the build's
    // own sentence, so the read and the build refuse this with ONE spelling. Its return is
    // discarded, because this method has already derived the schema and the name it uses, and it
    // runs BEFORE the round trip, so the refusal costs no query.
    const editable = kindAcceptsSourceEdits(capabilities, kind);
    if (editable) this.routineAddress(capabilities, kind, path);

    const client = await this.pool!.connect();
    let rows: SourceRow[];
    try {
      rows = (await client.query(statement.sql, statement.params)).rows as SourceRow[];
    } catch (error) {
      if (!isMissingSourceCatalogError(error)) throw mapDatabaseError(error, "postgres", statement.sql);
      return {
        path: [...path],
        kind,
        parts: [
          {
            id: SOURCE_PART_ID,
            label: "Definition",
            // The server's own sentence, unprefixed and never through `mapDatabaseError`,
            // which would put this product's words in front of the server's.
            unavailable: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    } finally {
      client.release();
    }

    const definition = rows[0]?.definition;
    if (definition === undefined || definition === null || definition.trim() === "") {
      throw new QueryError(
        `PostgreSQL holds no ${spec.label.toLowerCase()} called "${name}" in schema "${schema}"`,
        "postgres",
        statement.sql,
      );
    }
    const bounded = applySourceBound(definition, limit);
    return {
      path: [...path],
      kind,
      parts: [
        {
          id: SOURCE_PART_ID,
          label: "Definition",
          text: bounded.text,
          language: spec.sourceLanguage,
          form: statement.form,
          origin: "regenerated",
          ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
          // The affordance travels with the READ, and it is resolved on the CONNECTED provider, which
          // is the whole reason it is here rather than on the client's copy of the declaration (D57).
          ...(editable ? { edit: routineEditAffordance(rows[0], schema, name) } : {}),
        },
      ],
    };
  }

  /**
   * A value wrapped in a dollar-quoted string with a tag that is not in it (#789 Phase 3).
   *
   * NO LITERAL ESCAPING ANYWHERE IN THE APPLY, by construction. Dollar-quoted strings ignore every
   * escape, so this is immune to `standard_conforming_strings`, which is another GUC a borrower of
   * the pooled connection can change and which single-quote doubling would depend on. There is no
   * `literal()` on `SQLBaseProvider` to reuse: MEASURED, the class is 159 lines and adds
   * `escapeIdentifier`, `buildLimitClause`, `shouldEnableSSL`, `getInformationSchemaName`,
   * `getDefaultSchema`, `isReadOnlyQuery`, `isSchemaModifyingQuery` and `prepareQuery`.
   *
   * The random source is an ARGUMENT so the collision arm can be executed by a test rather than
   * being an unreachable line under the coverage gate. It is the same reason `drive-token.ts`
   * takes its clock as one.
   */
  private dollarQuote(value: string, tagSource: () => string = () => randomBytes(6).toString("hex")): string {
    const tag = `$lb${tagSource()}$`;
    if (value.includes(tag)) {
      throw new QueryError(
        "could not build this apply safely: the generated quote tag occurs inside the definition",
        "postgres",
      );
    }
    return `${tag}${value}${tag}`;
  }

  /**
   * The three coordinates every statement this apply sends is addressed by, derived and never
   * indexed (#789 Phase 3, standing ruling 5g).
   *
   * ONE writer for the build's read, the build's guard blocks and the apply's re-read, because
   * those three ask the same question about the same object and a second derivation is a second
   * chance for the guard to compare a different routine from the one being replaced.
   *
   * The schema comes through `containerSchema`, which reads the POSITION off the declaration, and
   * the name is `path[path.length - 1]`. Both are behaviour-identical on this engine's own
   * one-level declaration and neither is written as a literal index, which is what a two-level
   * `containerLevels` swapped in by this provider's suite proves.
   */
  private routineAddress(
    capabilities: ProviderCapabilities,
    kind: string,
    path: readonly string[],
  ): { readonly schema: string; readonly prokind: string; readonly name: string } {
    const schema = containerSchema(capabilities, path.slice(0, containerDepth(capabilities)));
    const name = path[path.length - 1];
    const prokind = PROKIND_BY_KIND[kind];
    if (prokind === undefined) {
      // The declaration and the statement map are two lists, exactly as they are for the source
      // read one method up, and a kind can be added to one and not the other. It fails by name
      // rather than binding `undefined` to `$2`, which would answer "no such routine" for an
      // object the tree has just listed.
      throw new QueryError(
        `PostgreSQL declares an editable kind "${kind}" but has no statement that reads it`,
        "postgres",
      );
    }
    return { schema, prokind, name };
  }

  /**
   * Build the guarded atomic batch that replaces one routine's definition (#789 Phase 3).
   *
   * THE STRATEGY IS `guarded-atomic-batch` AND IT IS THE ONLY DAY-ONE STRATEGY THAT CLOSES THE
   * LOST-UPDATE WINDOW RATHER THAN NARROWING IT, because the precondition and the write travel in
   * ONE round trip and PostgreSQL wraps a multi-statement simple query in its own implicit
   * transaction. MEASURED on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1): a `DO` block raising
   * `42P13` in front of the CREATE left `pg_proc` untouched, and a failing CREATE after a DROP
   * left the same `oid` and the same `xmin`.
   *
   * THE `SET LOCAL` AND THE STATEMENT TRAVEL IN ONE ROUND TRIP AND SPLITTING THEM IS SILENT.
   * MEASURED on 18.4 through `pg`: `SET LOCAL search_path = app, pg_catalog` sent as its OWN round
   * trip answers `WARNING: SET LOCAL can only be used in transaction blocks` and the value DOES
   * NOT TAKE EFFECT, `SHOW search_path` still reading `"$user", public`; the same `SET LOCAL` in
   * ONE round trip with the CREATE answers `SET` then `CREATE FUNCTION` with no warning; and THE
   * CONTROL, the identical CREATE without the pin, answers `ERROR: relation "t" does not exist`.
   * `pg` does not surface that warning as a rejection, so a split pin fails by doing nothing and
   * the apply then runs under whatever the previous borrower of the pooled connection left. That
   * is why the unit is ONE step and why `applyObjectEdit` sends `plan.unit.steps[0].text` in a
   * single parameterless `client.query()`.
   *
   * WHY `search_path` IS PINNED AT ALL, and the cost, which `docs/providers/postgres.md` carries
   * in full. MEASURED on 18.4 with `check_function_bodies` at its default `on`: a `LANGUAGE
   * plpgsql` body creates under ANY path, while a `LANGUAGE sql` body and a `BEGIN ATOMIC` body
   * are name-resolved at CREATE time and fail under the wrong one. `pg_proc.proconfig` is NULL for
   * a function that does not declare its own `SET search_path`, so the value the object was
   * created under cannot be recovered from the catalog. The pin is therefore the object's own
   * container schema plus `pg_catalog`, and the cost is accepted and stated: a previously-working
   * body that reads ANOTHER schema unqualified is refused rather than silently succeeding on
   * whichever path the last borrower happened to leave.
   *
   * FIVE REFUSALS, IN THIS ORDER, and each one answers before anything is sent.
   *
   * THE READ HERE IS NOT THE PANE'S READ, and it cannot be taken from the document the pane is
   * showing: it produces the revision, it is the pre-image the preview's left side needs, it
   * answers the ownership pre-flight, it reads the two session facts, and it is what refuses a
   * definition the read bound would have truncated.
   */
  public async buildObjectEdit(request: ObjectEditRequest): Promise<ObjectEditBuild> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = requireEditableKind(capabilities, request.kind, { displayName: "PostgreSQL", type: "postgres" });
    assertObjectPathShape(capabilities, spec, request.kind, request.path);
    const { schema, prokind, name } = this.routineAddress(capabilities, request.kind, request.path);
    if (request.partId !== SOURCE_PART_ID) {
      // A part this provider never produced. It raises rather than refusing, because a refusal is
      // an engine fact the reader can act on and this is a caller that addressed something that
      // does not exist: `readObjectSource` writes exactly one part and writes this id on it.
      throw new QueryError(
        `A PostgreSQL ${spec.label.toLowerCase()} has one source part, "${SOURCE_PART_ID}", received "${request.partId}"`,
        "postgres",
      );
    }

    const client = await this.pool!.connect();
    let rows: SourceRow[];
    try {
      rows = (await client.query(SOURCE_ROUTINE_SQL, [schema, prokind, name])).rows as SourceRow[];
    } finally {
      client.release();
    }

    const definition = rows[0]?.definition;
    if (definition === undefined || definition === null || definition.trim() === "") {
      // The same fact and the same sentence the source read answers for an absent object: the
      // catalog holds nothing at that address. PostgreSQL utters no sentence for it, so a refusal
      // would carry our silence dressed as the server's answer.
      throw new QueryError(
        `PostgreSQL holds no ${spec.label.toLowerCase()} called "${name}" in schema "${schema}"`,
        "postgres",
        SOURCE_ROUTINE_SQL,
      );
    }
    const row = rows[0];

    const refuse = (refusal: ObjectEditRefusalClass, sentence: string): ObjectEditBuild => ({
      built: false,
      // `at: { within: "none" }` on every one of them, and it is a fact rather than a default:
      // nothing has been sent, so no engine has reported a position and there is no coordinate to
      // convert. An `outside` here would claim a position was reported and could not be placed.
      refusal: { refusal, sentence, at: { within: "none" } },
    });

    // 1. The read bound. A part the pane could only show TRUNCATED is never editable: submitting
    //    the bounded text back is a truncation dressed as an edit, and it would delete everything
    //    past the bound. The number is core's `EDIT_CHARACTER_LIMIT`, which is
    //    `SOURCE_CHARACTER_LIMIT` by construction, so this refusal and the pane's bound can never
    //    drift apart. `docker/postgres-init/03-object-fixture.sql` builds the population: a
    //    routine whose definition measured 1,215,122 characters on 18.4 and its 945,116-character
    //    control, so the bound is measured biting rather than assumed to.
    if (definition.length > EDIT_CHARACTER_LIMIT) {
      return refuse(
        "guard",
        `this definition is ${definition.length.toLocaleString("en-US")} characters and the Source pane is ` +
          `bounded at ${EDIT_CHARACTER_LIMIT.toLocaleString("en-US")} characters, so the text you edited is a ` +
          "truncation of it and submitting it back would delete everything past the bound",
      );
    }

    // 2. Ownership, answered BEFORE the reader types anywhere it can be, and the sentence is the
    //    one the read's affordance already wrote, so the pane and the build cannot disagree.
    const affordance = routineEditAffordance(row, schema, name);
    if (!affordance.offered) return refuse("privilege", affordance.reason);

    // 3. The GUC. MEASURED on 18.4: with `check_function_bodies = off` a `CREATE OR REPLACE
    //    FUNCTION` over a body naming a table that does not exist answers `CREATE FUNCTION` and A
    //    BROKEN FUNCTION IS CREATED AND SUCCESS IS REPORTED. It is session-scoped, and D73
    //    measured session state persisting across Studio users on the cached provider, so the
    //    population this refuses is reachable by a previous borrower rather than hypothetical.
    //    THE COMPARISON IS AGAINST "on" AND NEVER AGAINST "off", and the `?? "an unreadable
    //    value"` arm is what that buys: a row that answered NO value at all is refused with a
    //    sentence that says so rather than being read as `on`. Its evidence class is named
    //    because the two differ: `= off` is MEASURED on 18.4, while the no-value row is D62's and
    //    is built by a test at this provider's boundary rather than by any server this task
    //    probed, since `current_setting` on 18.4 always answers a string and a server with no such
    //    GUC raises 42704 out of the read above.
    if (row.check_function_bodies !== "on") {
      return refuse(
        "guard",
        `this connection's session has check_function_bodies = ${row.check_function_bodies ?? "an unreadable value"}, ` +
          "and PostgreSQL then accepts a body it would otherwise reject, so an apply would report success and " +
          "store a definition that cannot run",
      );
    }

    // 4. Byte-identical text. A refusal and never a no-op apply, because sending an apply that
    //    cannot change anything spends a write path, an audit row and a lock on nothing.
    //
    //    WHAT THIS REFUSAL DOES NOT BUY, corrected after the wave 5 review measured it: it does
    //    NOT empty the post-condition's false-positive population, which is what this comment and
    //    `docs/providers/postgres.md` both claimed. `pg_get_functiondef` is a CANONICAL rendering,
    //    so an edit that differs from the server's bytes and re-renders to the same bytes passes
    //    here. MEASURED on 18.4: a re-indented header with `sql` upper-cased built, applied, and
    //    was reported `applied-elsewhere` and rolled back. The post-condition below now asks
    //    whether the addressed ROW was rewritten instead, which that edit answers yes to.
    if (request.text === definition)
      return refuse("definition", "this text is identical to the definition on the server");

    // 5. The identity. Both headers are shown, because the reader's next action is to put the
    //    original name back or to create the new routine deliberately, and neither is possible
    //    from a sentence that only says no.
    const submitted = routineIdentityHeader(request.text);
    const current = routineIdentityHeader(definition);
    if (submitted !== current) {
      return refuse(
        "identity",
        `this text declares "${submitted}" and the object being edited is "${current}", and LibreDB refuses an ` +
          "edited header rather than sending it. CREATE OR REPLACE with a different name or a different " +
          "argument list creates a SECOND routine and leaves this one untouched, after which every call site " +
          "fails 42725 is not unique. A changed parameter DEFAULT is rendered inside this same header and " +
          "PostgreSQL replaces that one in place, so it is refused here as well: make it with a CREATE OR " +
          "REPLACE of your own in the SQL editor",
      );
    }

    const revision = row.revision;
    if (typeof revision !== "string" || revision === "") {
      // A guarded batch with no token to guard on is not this strategy, so it is refused rather
      // than downgraded in silence to an unguarded write. The population is D62's: this type id
      // also serves CockroachDB and Materialize, neither of which was probed, and a fork that
      // answers no `md5(pg_get_functiondef(oid))` lands here.
      return refuse(
        "unsupported",
        "this server answered no md5 of pg_get_functiondef for this routine, so the lost-update guard this " +
          "apply is built around cannot be constructed and the edit is refused rather than applied unguarded",
      );
    }

    const pinnedSearchPath = `${this.escapeIdentifier(schema)}, pg_catalog`;
    const guardSubject =
      `FROM pg_catalog.pg_proc p\n` +
      `        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n` +
      `       WHERE n.nspname = ${this.dollarQuote(schema)} AND p.prokind = ${this.dollarQuote(prokind)} ` +
      `AND ${ROUTINE_IDENTITY_EXPR} = ${this.dollarQuote(name)}`;
    // THREE PRIVATE SQLSTATEs AND NOT ONE, which is a deviation from the design's single `55006`
    // with the design's own rule behind it: the design also requires the classifier to map
    // SQLSTATE to a refusal class AS DATA and never by message substring, and the three raises
    // mean three DIFFERENT outcomes, a `conflict`, a `refused` and an `applied-elsewhere`. One
    // shared code would force the classifier back onto the message. `LB001`, `LB002` and `LB003`
    // are in the range PostgreSQL documents for user-defined conditions.
    const preBlock =
      `BEGIN\n` +
      `  IF (SELECT md5(pg_catalog.pg_get_functiondef(p.oid))\n` +
      `        ${guardSubject})\n` +
      `     IS DISTINCT FROM ${this.dollarQuote(revision)}\n` +
      `  THEN RAISE EXCEPTION 'libredb: this definition changed since it was read' USING ERRCODE = 'LB001';\n` +
      `  END IF;\n` +
      `  IF current_setting('check_function_bodies') IS DISTINCT FROM ${this.dollarQuote(row.check_function_bodies)}\n` +
      `  THEN RAISE EXCEPTION 'libredb: a session setting this preview depends on changed' USING ERRCODE = 'LB002';\n` +
      `  END IF;\n` +
      `  PERFORM set_config(${ROW_VERSION_SETTING_LITERAL},\n` +
      `    (SELECT p.xmin::text\n` +
      `        ${guardSubject}), true);\n` +
      `END`;
    // The post-condition catches what a byte comparison cannot see. MEASURED on 18.4: a raise
    // anywhere in this round trip rolls the WHOLE thing back, so a fork is detected AND undone in
    // the same round trip, which is what makes `applied-elsewhere` carry `undone: true` here and
    // false on an engine with no transaction.
    //
    // IT ASKS WHETHER THE ADDRESSED ROW WAS REWRITTEN, NOT WHETHER ITS RENDERING MOVED, and the
    // difference is a SEVERITY 1 defect this file shipped and the wave 5 review caught end to end.
    // A revision comparison here reads a CANONICAL rendering: an edit that differs from the
    // server's bytes and re-renders to the same bytes passes the byte-identical refusal above and
    // then trips this guard. MEASURED on 18.4 through this provider: `app.order_total(integer)`
    // re-indented and with `sql` upper-cased answered `applied-elsewhere` and was rolled back,
    // while the server's md5 was `d9a63a78c5f93adf2aa325d3e0139be3` before and after and
    // `pg_proc.xmin` moved 776 -> 778. So the guard compares `xmin`, which moves on EVERY rewrite
    // of the row including a byte-identical one. That is the same property that makes `xmin` a
    // bad revision TOKEN, where a move that changes nothing is a false conflict, and the right
    // POST-CONDITION, where it is the only thing that answers "was the row I addressed the row
    // that got written".
    //
    // The value is captured in the PRE block rather than carried from the build, because a value
    // read at build time is stale by any GRANT EXECUTE in between and that would make the fork
    // INVISIBLE. It travels in a transaction-local custom GUC, which is gone when the round trip
    // ends: MEASURED, a new session answers `ERROR: unrecognized configuration parameter
    // "libredb.row_version"`. MEASURED after the repair, same engine, same emitted shape: the
    // canonicalized edit answers `SET | DO | CREATE FUNCTION | DO` with no raise, and a unit whose
    // text creates a DIFFERENT routine answers `ERROR: libredb: this apply did not change the
    // object it was addressed to` with `count(*) = 0` for the forked name afterwards.
    const postBlock =
      `BEGIN\n` +
      `  IF (SELECT p.xmin::text\n` +
      `        ${guardSubject})\n` +
      `     IS NOT DISTINCT FROM current_setting(${ROW_VERSION_SETTING_LITERAL})\n` +
      `  THEN RAISE EXCEPTION 'libredb: this apply did not change the object it was addressed to' USING ERRCODE = 'LB003';\n` +
      `  END IF;\n` +
      `END`;
    const prefix = `SET LOCAL search_path = ${pinnedSearchPath};\nDO ${this.dollarQuote(preBlock)};\n`;
    // THE TERMINATOR ENDS THE READER'S LINE BEFORE IT ENDS THE STATEMENT, and the leading newline
    // is the whole repair (#789, task 22). It used to read `;\nDO ...`, so the semicolon that
    // terminates the reader's CREATE was the first character after their last one, ON THE SAME
    // LINE. PostgreSQL discards a `--` comment to the end of the line, so a reader whose edit ends
    // in a line comment, which is how a person ends one, had that terminator swallowed and the
    // post-condition `DO` became part of the CREATE.
    //
    // MEASURED live through this provider against PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) on
    // 2026-09-14, appending ` -- edited by task 22` to the definition of `app.order_total(integer)`:
    // before the repair the apply answered `syntax error at or near "DO"`, SQLSTATE 42601, with the
    // reported position inside the text this provider added, so `userPositionOf` answered `outside`
    // and the pane placed no marker at all. After the repair the same edit answers
    // `SET | DO | CREATE FUNCTION | DO` and the outcome is `applied`.
    //
    // The newline costs the reader's coordinates NOTHING: the prefix is untouched and the user
    // segment still spans `[0, request.text.length)`, so the marker arithmetic reads the same line
    // and column it did before.
    //
    // The doubled semicolon a reader who terminates their own text produces is not a risk this has
    // to avoid: MEASURED on 18.4 through `pg`, `SELECT 1;;SELECT 2;` in one parameterless query is
    // ACCEPTED and answers both rows, so the terminator is appended unconditionally rather than
    // conditionally on the reader's last character. That is what keeps this one composition correct
    // for a text ending in a line comment, in a newline, in `$$` and in a semicolon of their own.
    const suffix = `\n;\nDO ${this.dollarQuote(postBlock)};`;
    const step: ObjectEditStep = {
      text: `${prefix}${request.text}${suffix}`,
      language: spec.sourceLanguage,
      segments: [
        { from: "provider", text: prefix },
        { from: "user", start: 0, end: request.text.length },
        { from: "provider", text: suffix },
      ],
    };

    return {
      built: true,
      plan: {
        planVersion: 1,
        planId: randomUUID(),
        issuedAt: new Date().toISOString(),
        connectionFingerprint: await connectionFingerprint(this.config),
        type: "postgres",
        path: [...request.path],
        kind: request.kind,
        partId: request.partId,
        strategy: "guarded-atomic-batch",
        unit: { medium: "statement", steps: [step] },
        session: [
          { mode: "pinned", setting: "search_path", value: pinnedSearchPath },
          { mode: "asserted", setting: "check_function_bodies", value: row.check_function_bodies },
        ],
        revision: { check: "guarded", token: revision, basis: "md5(pg_get_functiondef(oid))", scope: "server" },
        // Nothing. A `CREATE OR REPLACE FUNCTION` that keeps the identity replaces the addressed
        // routine and nothing else: MEASURED on 18.4, the `oid` survives, so every dependency,
        // every GRANT and every comment on it survives with it. The two ways to lose something
        // here are a changed identity and a changed return type, and both are refused above and
        // by the engine's own 42P13 rather than warned about.
        consequences: [],
      },
      preimage: { text: definition, language: spec.sourceLanguage },
    };
  }

  /**
   * The routine's current definition and revision, re-read for the outcome that needs it.
   *
   * Two callers and two different questions: a SUCCESS needs the NEW revision, because the token
   * the plan carried is by definition the OLD one and a client that re-applied with it would get a
   * false conflict; and an `object-changed` conflict needs the server's CURRENT text, because H3
   * requires the reader to be shown a diff rather than asked to trust a detector.
   *
   * It is addressed from the PLAN and never from a fresh derivation of the request, because the
   * plan is the only thing an apply holds (ruling 1a).
   */
  private async readRoutineAfterApply(plan: ObjectEditPlan): Promise<SourceRow | undefined> {
    const { schema, prokind, name } = this.routineAddress(this.getCapabilities(), plan.kind, plan.path);
    const client = await this.pool!.connect();
    try {
      return (await client.query(SOURCE_ROUTINE_SQL, [schema, prokind, name])).rows[0] as SourceRow | undefined;
    } finally {
      client.release();
    }
  }

  /**
   * Send the plan, in ONE round trip, and NEVER the text again (#789 Phase 3, ruling 1a).
   *
   * `plan.unit.steps[0].text` is sent verbatim in a single parameterless `client.query()`. Nothing
   * here re-reads the object to re-assemble a statement, nothing consults `getCapabilities()` for
   * anything the plan already carries, and this provider's own suite proves that by MOVING both
   * the server's definition and the capability answer between the build and the apply and then
   * asserting the sent bytes byte for byte.
   *
   * ONE ROUND TRIP IS LOAD-BEARING AND SPLITTING IT FAILS IN SILENCE. MEASURED on PostgreSQL 18.4:
   * a `SET LOCAL` in its own round trip answers `WARNING: SET LOCAL can only be used in
   * transaction blocks`, the pin does nothing, and `pg` does not surface that warning as a
   * rejection, so the apply would run under whatever the previous borrower of the pooled
   * connection left and nothing downstream could see it.
   *
   * NO PARAMETERS, ever. Binding one does not degrade the atomicity, it REFUSES it: MEASURED,
   * `42601 cannot insert multiple commands into a prepared statement`.
   *
   * THIS METHOD OPENS NO TRANSACTION OF ITS OWN, and that is a prohibition rather than an
   * omission: `txActive` is one flag per `connection.id` (D72), a dangling `BEGIN` poisons one
   * pooled client for the whole process (D71), and PostgreSQL's own implicit transaction around a
   * multi-statement simple query already gives this strategy every atomicity guarantee it claims.
   *
   * A VERDICT THE ENGINE REACHED IS RETURNED AND NEVER THROWN, which is what keeps a deliberate
   * refusal off the 500 path the shipped error mapper would otherwise put it on.
   */
  public async applyObjectEdit(plan: ObjectEditPlan): Promise<ObjectEditOutcome> {
    this.ensureConnected();
    if (plan.unit.medium !== "statement") {
      // A command unit is not a shape this provider ever issues. It raises rather than refusing,
      // because a refusal reports an engine fact and this is a plan from somewhere else.
      throw new QueryError("A PostgreSQL object edit plan carries a statement unit, received a command", "postgres");
    }
    const [step] = plan.unit.steps;
    // THE SAME ENTRY GUARD THE OTHER TWO DAY-ONE APPLIES OPEN WITH (D83), and the return is
    // DISCARDED here exactly as Redis discards it: this method sends `plan.unit.steps[0].text`
    // verbatim and needs nothing off the spec, so the call is a guard and nothing else. Neither
    // shipped path can reach it, because `edit-apply/route.ts` re-resolves editability on the
    // CONNECTED provider and the statement was minted by a `buildObjectEdit` that asked the same
    // question; the population is a `@libredb/studio` consumer calling this method directly. It is
    // here rather than absent because three applies that answer the same question differently is
    // how one of them later answers it wrongly, and because without it a foreign kind reaches the
    // round trip and is refused only by the re-read's address derivation, AFTER the DDL was sent.
    requireEditableKind(this.getCapabilities(), plan.kind, { displayName: "PostgreSQL", type: "postgres" });
    const started = Date.now();
    const client = await this.pool!.connect();
    // A CLIENT THAT IS NOT IDLE BELONGS TO SOMEBODY ELSE'S TRANSACTION, and this apply refuses
    // rather than writing into it (#789 Phase 3, D78). The status is the server's own last
    // ReadyForQuery byte, read locally, so the check costs no round trip and cannot be defeated by
    // a BEGIN no splitter sees through, which is the same argument `endOpenQueryTransaction()`
    // makes for reading it.
    //
    // MEASURED on PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) through `pg` 8.23 on 2026-09-14,
    // driving this provider against a throwaway container: a lone `BEGIN` through `query()`
    // releases its pooled client in status `T`, `pg`'s idle list is LIFO so the next
    // `pool.connect()` hands back THE SAME client, and without this guard the apply ran inside
    // that foreign transaction and answered `applied` with a `guarded` revision token. Then
    // `endOpenQueryTransaction()`, which names that very client, rolled the apply away: `xmin`
    // 856 back to 825, the definition byte-identical to the pre-image. Ruling 1a is that the bytes
    // the user approved are the bytes the database ends up with, and they were not. Two more
    // consequences in the same run: the revision handed back is whichever image the re-read's own
    // borrowed client happened to see, the post-image on the same client and the PRE-image on a
    // different one; and the `SET LOCAL search_path` pin SURVIVED into the rest of the foreign
    // transaction, `SHOW search_path` reading `app, pg_catalog` afterwards.
    //
    // NEITHER A ROLLBACK NOR A RETRY. A rollback here destroys work this user was never shown,
    // which is the axis ruling 1b measures; and `POSTGRES_POOL_MAX=1`, which a single-slot
    // PgBouncer also produces, has no other client to retry on. So the refusal is the honest
    // answer, and it is `guard` because the precondition is this design's own: this method opens
    // no transaction and depends on PostgreSQL's implicit one around its single round trip.
    const borrowed = client.getTransactionStatus();
    if (borrowed !== "I") {
      client.release();
      return {
        outcome: "refused",
        refusal: {
          refusal: "guard",
          sentence:
            "this connection's pooled session is inside a transaction somebody else opened, so an apply " +
            "sent on it would not be committed by this request and could be rolled back with theirs",
          // No engine spoke, so there is no SQLSTATE to carry and no reported position to convert.
          at: { within: "none" },
        },
        duration: Date.now() - started,
      };
    }
    // THE FAILURE IS CAUGHT HERE AND CLASSIFIED AFTER THE RELEASE, and the order is load-bearing
    // rather than tidy. `classifyApplyFailure` takes a SECOND pooled client for the conflict arm's
    // re-read, and classifying inside the `catch` runs it BEFORE this `finally`, so the failed
    // client is still checked out while the re-read asks for another one. At the default pool size
    // that is invisible; on a pool of one, which `POSTGRES_POOL_MAX=1` and a single-slot PgBouncer
    // both produce, the re-read waits for a client that is waiting for it.
    let failure: { error: unknown } | undefined;
    try {
      await client.query(step.text);
    } catch (error) {
      failure = { error };
    } finally {
      client.release();
    }
    if (failure !== undefined) {
      return await this.classifyApplyFailure(plan, step, failure.error, Date.now() - started);
    }

    const after = await this.readRoutineAfterApply(plan);
    return {
      outcome: "applied",
      revision:
        typeof after?.revision === "string"
          ? { check: "guarded", token: after.revision, basis: "md5(pg_get_functiondef(oid))", scope: "server" }
          : // The apply succeeded and the re-read did not answer. The write is not in doubt, so the
            // outcome is still `applied`, and the revision says out loud that this provider could
            // not produce one rather than carrying the OLD token, which a client would compare on
            // its next apply and be told the object had not moved.
            {
              check: "unavailable",
              reason:
                "the apply succeeded and the re-read that produces the new revision answered no row for this routine",
            },
      duration: Date.now() - started,
    };
  }

  /**
   * One engine failure, turned into the outcome arm it IS (#789 Phase 3).
   *
   * The SQLSTATE decides, from `APPLY_VERDICT_BY_SQLSTATE`, and a code that is not in the table is
   * `definition` with the engine's own sentence rather than a guess (D62). An error carrying NO
   * SQLSTATE at all is not a verdict the engine reached: the statement was sent and its answer
   * never arrived, so it is `interrupted` with `committed: "unknown"`, and a client that retried
   * on it would apply twice.
   */
  private async classifyApplyFailure(
    plan: ObjectEditPlan,
    step: ObjectEditStep,
    error: unknown,
    duration: number,
  ): Promise<ObjectEditOutcome> {
    const sentence = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") return { outcome: "interrupted", committed: "unknown", sentence, duration };

    const verdict = APPLY_VERDICT_BY_SQLSTATE[code];
    if (verdict === "conflict") {
      const current = await this.readRoutineAfterApply(plan);
      return {
        outcome: "conflict",
        conflict: "object-changed",
        // The server's own text, re-read after the guard refused, so H3's diff is against what is
        // actually there rather than against what the plan remembered. The language is the plan's
        // own, because the apply holds the plan and nothing else.
        current: { text: current?.definition ?? "", language: step.language },
        duration,
      };
    }
    if (verdict === "applied-elsewhere") {
      return { outcome: "applied-elsewhere", undone: true, duration };
    }
    if (verdict === undefined && sentence.includes(CONCURRENT_UPDATE_SENTENCE)) {
      return { outcome: "conflict", conflict: "engine-refused-concurrent", sentence, code, duration };
    }

    const hint = (error as { hint?: unknown }).hint;
    const position = (error as { position?: unknown }).position;
    return {
      outcome: "refused",
      refusal: {
        refusal: verdict ?? "definition",
        sentence,
        code,
        ...(typeof hint === "string" ? { hint } : {}),
        // PostgreSQL's `position` is a 1-BASED CHARACTER offset into the text that was sent and it
        // arrives as a STRING although `QueryError.position` is typed `number`, so both halves of
        // the conversion happen here: the string becomes a number and the 1-based offset becomes
        // the 0-based one `userPositionOf` takes. MEASURED: the same body error is `position 23`
        // bare and `position 63` assembled, prefix 40, and an uncorrected coordinate is silently
        // CLAMPED by Monaco rather than rejected, so nothing downstream catches it being wrong.
        at:
          typeof position === "string" || typeof position === "number"
            ? userPositionOf(step, Number(position) - 1)
            : { within: "none" },
      },
      duration,
    };
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

      // Get checkpoint stats. "N/A" from the start rather than "0", so an unread
      // counter never leaves here looking like a checkpoint that took no time.
      let checkpointWriteTime = "N/A";
      try {
        // Reading the old columns and catching the failure answered "N/A" on every
        // PostgreSQL 17+ server, and wrote an ERROR into its log on every monitoring
        // refresh (#825). The probe picks the view that has them instead.
        const probeRes = await client.query(PERF_CHECKPOINTER_PROBE_SQL);
        const checkpointRes = await client.query(
          probeRes.rows[0]?.has_checkpointer ? PERF_CHECKPOINTER_SQL : PERF_BGWRITER_CHECKPOINT_SQL,
        );
        const checkpointRow = checkpointRes.rows[0];
        const writeTime = measuredNumber(checkpointRow?.write_time);
        const syncTime = measuredNumber(checkpointRow?.sync_time);
        // Either half alone is a reading; neither is not.
        if (writeTime !== undefined || syncTime !== undefined) {
          checkpointWriteTime = `${(((writeTime ?? 0) + (syncTime ?? 0)) / 1000).toFixed(1)}s`;
        }
      } catch {
        // No to_regclass() (Materialize), or the view is not readable by this role.
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
