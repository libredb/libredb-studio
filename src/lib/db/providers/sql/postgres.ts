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
} from "../../types";
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
  row_count: string;
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

// Reusable CTE fragments (no trailing comma). Composed into the queries below;
// kept single-sourced so the shared CTEs aren't duplicated across queries.
const CTE_TABLES_INFO = `
        tables_info AS MATERIALIZED (
          SELECT
            t.table_schema,
            t.table_name,
            COALESCE(c.reltuples::bigint, 0) as row_count,
            COALESCE(pg_total_relation_size(c.oid), 0) as total_size
          FROM information_schema.tables t
          LEFT JOIN pg_class c ON c.oid = (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass
          WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND t.table_type = 'BASE TABLE'
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
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
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
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
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

// getOverview: server version, start time, and uptime.
const OVERVIEW_INFO_SQL = `
        SELECT
          version() as version,
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
          pg_size_pretty(pg_database_size($1)) as database_size,
          pg_database_size($1) as database_size_bytes
      `;

// getOverview: user table and index counts across all user schemas.
const OVERVIEW_COUNTS_SQL = `
        SELECT
          (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) as table_count,
          (SELECT count(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) as index_count
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
      supportsExplain: true,
      explainFormat: "postgres-json",
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // BEGIN / COMMIT / ROLLBACK over one held pool client (`beginTransaction()` below).
      supportsTransactions: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
      // Every statement below has both forms - `VACUUM ANALYZE <table>` and bare
      // `VACUUM ANALYZE`, `REINDEX TABLE <table>` and `REINDEX DATABASE` - so
      // PostgreSQL is the engine whose per-row and global controls were both already
      // right, and declaring them changes nothing here (#U9). `kill` takes a backend
      // PID, which only the Sessions panel can supply.
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Table", perEntity: true, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
    };
  }

  /**
   * Only the global reindex triad; every other label is the SQL default and right.
   *
   * The Operations tab's reindex card was hardcoded to this wording for every engine
   * (#U6), so declaring it here changes nothing on PostgreSQL and lets the two other
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

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Single MATERIALIZED query (see SCHEMA_FULL_SQL) replacing the old
      // N+1 pattern (1 + N*4 queries) with one round-trip.
      const result = await client.query(SCHEMA_FULL_SQL);

      return result.rows.map((row: SchemaRow) => {
        const schemaName = row.table_schema;
        const tableName = row.table_name;
        const displayName = schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
        const rowCount = Math.max(0, parseInt(row.row_count || "0"));
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
      const result = await client.query(SCHEMA_LIST_SQL);

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
          rowCount: Math.max(0, parseInt(row.row_count || "0")),
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
      const result = await client.query(SCHEMA_RELATIONS_SQL);

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
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const connRes = await client.query("SELECT count(*) FROM pg_stat_activity");

      const sizeRes = await client.query("SELECT pg_size_pretty(pg_database_size($1))", [this.config.database]);

      const cacheRes = await client.query(HEALTH_CACHE_HIT_SQL);
      // A NULL ratio used to arrive here as the SQL's own invented 100; unguarded,
      // it would now arrive as the string "null%".
      const healthCacheHitRatio = measuredNumber(cacheRes.rows[0]?.ratio);

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

      const sessionsRes = await client.query(HEALTH_SESSIONS_SQL, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionsRes.rows.map((r) => ({
        pid: r.pid,
        user: r.user || "unknown",
        database: r.database || "",
        state: r.state,
        query: r.query || "",
        duration: r.duration,
      }));

      return {
        activeConnections: parseInt(connRes.rows[0].count),
        databaseSize: sizeRes.rows[0].pg_size_pretty,
        cacheHitRatio:
          healthCacheHitRatio === undefined
            ? CACHE_HIT_RATIO_UNAVAILABLE
            : `${formatCacheHitRatio(healthCacheHitRatio)}%`,
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
      // Get version and uptime
      const infoRes = await client.query(OVERVIEW_INFO_SQL);

      // Get connection counts
      const connRes = await client.query(OVERVIEW_CONNECTIONS_SQL, [this.config.database]);

      // Get database size
      const sizeRes = await client.query(OVERVIEW_SIZE_SQL, [this.config.database]);

      // Get table and index counts (all user schemas)
      const countRes = await client.query(OVERVIEW_COUNTS_SQL);

      const uptimeSeconds = parseInt(infoRes.rows[0].uptime_seconds || "0");
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      return {
        version: infoRes.rows[0].version?.split(",")[0] || "PostgreSQL",
        uptime,
        startTime: infoRes.rows[0].start_time ? new Date(infoRes.rows[0].start_time) : undefined,
        activeConnections: parseInt(connRes.rows[0].active_connections || "0"),
        maxConnections: parseInt(connRes.rows[0].max_connections || "100"),
        databaseSize: sizeRes.rows[0].database_size || "0 bytes",
        databaseSizeBytes: parseInt(sizeRes.rows[0].database_size_bytes || "0"),
        tableCount: parseInt(countRes.rows[0].table_count || "0"),
        indexCount: parseInt(countRes.rows[0].index_count || "0"),
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
      // Get cache hit ratio
      const cacheRes = await client.query(PERF_CACHE_HIT_SQL);
      const cacheHitRatio = measuredNumber(cacheRes.rows[0]?.cache_hit_ratio);

      // Get transaction stats
      const txRes = await client.query(PERF_TRANSACTION_STATS_SQL, [this.config.database]);

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
      const txRow = txRes.rows[0];
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
      const whereClause = schema
        ? `WHERE schemaname = $1`
        : `WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
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
      const whereClause = schema
        ? `WHERE s.schemaname = $1`
        : `WHERE s.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
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
