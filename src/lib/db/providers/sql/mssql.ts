/**
 * Microsoft SQL Server Database Provider
 * Full MSSQL support with connection pooling (SQL Authentication)
 */

import mssql from "mssql";
import { SQLBaseProvider } from "./sql-base";
import { mssqlColumnTypes } from "./column-types";
import {
  type DatabaseConnection,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type PreparedQuery,
  type QueryPrepareOptions,
  type Container,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type ColumnSchema,
  type IndexSchema,
  type ForeignKeySchema,
  type ContainerLevelSpec,
} from "../../types";
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "../../object-kinds";
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { measuredNullableAggregate } from "../../utils/measured-aggregate";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

/**
 * `SELECT ... ` with `TOP n` spliced in where T-SQL wants it, or `null` when this
 * statement has no leading `SELECT` to splice after.
 *
 * The insertion point comes from `readLeadingKeyword` rather than from a
 * `^\s*SELECT\s+` rewrite, because that pattern silently matched nothing behind a
 * leading comment while the caller had already committed to `wasLimited: true`
 * (#275). `DISTINCT` is found the same way, so `SELECT /* c *\/ DISTINCT a` places
 * `TOP` after the `DISTINCT` and not between the two - `SELECT TOP n DISTINCT ...`
 * is a syntax error in T-SQL.
 *
 * Every one of those three reads takes T-SQL's grammar, because this is a HEAD
 * rewrite and the index comes from the reading: T-SQL nests block comments, so a
 * flat reading of `SELECT /* a /* b *\/ DISTINCT *\/ name FROM t` found a
 * `DISTINCT` that is inside the comment and spliced the `TOP` in after it - inside
 * the comment too. SQL Server then ran the statement unbounded while this provider
 * reported a limit, which is #280's shape rather than a missed bound (#300).
 *
 * The two SUFFIX slices are safe under this dialect's grammar specifically: only
 * the alternate-quote tag reads the character before its index (see `readSqlSpan`),
 * and T-SQL does not have that form.
 */
function injectTop(sql: string, limit: number, grammar: SqlGrammar): string | null {
  const select = readLeadingKeyword(sql, grammar);
  if (select === null || select.keyword !== "SELECT") return null;

  const next = readLeadingKeyword(sql.slice(select.end), grammar);
  const insertAt = next?.keyword === "DISTINCT" ? select.end + next.end : select.end;

  // A `TOP` already sitting where this one would go means the statement carries its
  // own bound and `analyzeQuery`'s probe missed it - that probe wants literal
  // whitespace between the two words, so a comment between them defeats it, as does
  // a `DISTINCT`. Splicing anyway yields `SELECT TOP 50 TOP 10` and a syntax error,
  // so decline and let the caller report that nothing was limited.
  if (readLeadingKeyword(sql.slice(insertAt), grammar)?.keyword === "TOP") return null;

  return `${sql.slice(0, insertAt)} TOP ${limit}${sql.slice(insertAt)}`;
}

/**
 * A T-SQL page written as `OFFSET n ROW[S]`, at the end of the statement.
 *
 * That is a complete page here - "skip n rows and return the rest" - and it is
 * the one bound form the shared probes in `query-limiter.ts` cannot see: they
 * want a `FETCH … ROWS ONLY` tail or a bare `OFFSET n`, and `OFFSET 10 ROWS` is
 * neither. Unseen, the statement looked unbounded and collected a clause beside
 * its own page, which SQL Server rejects outright (Msg 10741) - so the statement
 * FAILED rather than returning too many rows, and this method reported a limit
 * for it. The form belongs to this dialect, so it is read here rather than in the
 * shared limiter, where it would move every other dialect's probes (#293).
 *
 * Anchored at the end of the statement for the same reason the shared probes
 * are: an `OFFSET` inside a subquery (`… FROM (SELECT … OFFSET 10 ROWS) x`) is a
 * different query expression, which a `TOP` on the outer one may legally join,
 * and one written in a trailing comment is not a page at all. A digit count only,
 * as the shared probes read: `OFFSET @skip ROWS` is not recognised, which is the
 * limitation `docs/providers/mssql.md` records.
 */
const TSQL_PAGE_TAIL = /\bOFFSET\s+\d+\s+ROWS?\s*$/i;

/**
 * Whether text mentions a clause a row-count clause may not sit beside.
 *
 * Consulted ONLY where the statement's end may not be cut. Every already-bounded
 * probe - the shared ones and `TSQL_PAGE_TAIL` above - is anchored at the end of
 * the statement's own text, and where the cut is refused that text still carries
 * the trailing trivia: a real page written before a trailing comment then sits
 * away from the anchor and reads as absent. An anchor that may be reading trivia
 * is not an answer a decision that ADDS a clause may rest on, so this asks the
 * weaker question the situation allows - is there anything here that could be a
 * page? - and the branch declines when there is.
 *
 * Unanchored and deliberately blunt: it also fires on a column named `offset`
 * and on a subquery's own page, so such a statement loses its bound. That is the
 * trade the whole of `src/lib/sql/` makes for text it cannot resolve - an
 * over-large read reported honestly as unbounded, never a statement the server
 * refuses - and both halves are pinned in this provider's suite.
 */
const TSQL_ROW_BOUND_MENTION = /\b(?:OFFSET|FETCH)\b/i;

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in postgres.ts).

const DATABASE_SIZE_MB_SQL = `
          SELECT
            CAST(SUM(size) * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb
          FROM sys.database_files
        `;

// Shared by getHealth() and getPerformanceMetrics().
const BUFFER_CACHE_HIT_RATIO_SQL = `
          SELECT
            CAST(
              (a.cntr_value * 1.0 / NULLIF(b.cntr_value, 0)) * 100
              AS DECIMAL(5,2)
            ) AS hit_ratio
          FROM sys.dm_os_performance_counters a
          CROSS JOIN sys.dm_os_performance_counters b
          WHERE a.counter_name = 'Buffer cache hit ratio'
            AND a.object_name LIKE '%Buffer Manager%'
            AND b.counter_name = 'Buffer cache hit ratio base'
            AND b.object_name LIKE '%Buffer Manager%'
        `;

const HEALTH_SLOW_QUERIES_SQL = `
          SELECT TOP 5
            SUBSTRING(qt.text, 1, 100) AS query,
            qs.execution_count AS calls,
            CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS DECIMAL(10,2)) AS avg_time_ms
          FROM sys.dm_exec_query_stats qs
          CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
          WHERE qs.execution_count > 0
          ORDER BY qs.total_elapsed_time DESC
        `;

const HEALTH_ACTIVE_SESSIONS_SQL = `
          SELECT TOP 10
            s.session_id AS pid,
            s.login_name AS [user],
            DB_NAME(s.database_id) AS [database],
            s.status AS state,
            ISNULL(SUBSTRING(t.text, 1, 100), '') AS query,
            ISNULL(CAST(DATEDIFF(SECOND, s.last_request_start_time, GETDATE()) AS VARCHAR) + 's', 'N/A') AS duration
          FROM sys.dm_exec_sessions s
          LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
          OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
          WHERE s.is_user_process = 1
          ORDER BY s.last_request_start_time DESC
        `;

// Rebuild all indexes on all tables.
const REBUILD_ALL_INDEXES_SQL = `
                DECLARE @sql NVARCHAR(MAX) = '';
                SELECT @sql = @sql + 'ALTER INDEX ALL ON [' + s.name + '].[' + t.name + '] REBUILD;'
                FROM sys.tables t
                JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE t.type = 'U';
                EXEC sp_executesql @sql;
              `;

const OVERVIEW_UPTIME_SQL = `
          SELECT sqlserver_start_time,
                 DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) AS uptime_seconds
          FROM sys.dm_os_sys_info
        `;

const OVERVIEW_CONNECTIONS_SQL = `
          SELECT
            COUNT(*) AS active_connections,
            (SELECT CAST(value_in_use AS INT) FROM sys.configurations WHERE name = 'user connections') AS max_connections
          FROM sys.dm_exec_sessions
          WHERE is_user_process = 1
        `;

const OVERVIEW_DATABASE_SIZE_SQL = `
          SELECT SUM(CAST(size AS BIGINT)) * 8 * 1024 AS size_bytes FROM sys.database_files
        `;

const OVERVIEW_OBJECT_COUNTS_SQL = `
          SELECT
            (SELECT COUNT(*) FROM sys.tables WHERE type = 'U') AS table_count,
            (SELECT COUNT(*) FROM sys.indexes WHERE object_id IN (SELECT object_id FROM sys.tables WHERE type = 'U') AND name IS NOT NULL) AS index_count
        `;

// Interpolated after "SELECT TOP <limit>" in getSlowQueries().
const SLOW_QUERIES_BODY_SQL = `
          CAST(qs.query_hash AS VARCHAR(50)) AS query_id,
          SUBSTRING(qt.text, 1, 500) AS query,
          qs.execution_count AS calls,
          CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS total_time,
          CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS DECIMAL(18,2)) AS avg_time,
          CAST(qs.min_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS min_time,
          CAST(qs.max_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS max_time,
          qs.total_rows AS row_cnt,
          qs.total_logical_reads AS logical_reads,
          qs.total_physical_reads AS physical_reads
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
        WHERE qs.execution_count > 0
        ORDER BY qs.total_elapsed_time DESC
      `;

// Interpolated after "SELECT TOP <limit>" in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `
          s.session_id AS pid,
          s.login_name AS [user],
          DB_NAME(s.database_id) AS [database],
          s.program_name AS application_name,
          s.host_name AS client_addr,
          s.status AS state,
          ISNULL(SUBSTRING(t.text, 1, 500), '') AS query,
          s.last_request_start_time AS query_start,
          ISNULL(CAST(DATEDIFF(SECOND, s.last_request_start_time, GETDATE()) AS VARCHAR) + 's', 'N/A') AS duration,
          ISNULL(DATEDIFF(MILLISECOND, s.last_request_start_time, GETDATE()), 0) AS duration_ms,
          r.wait_type,
          r.last_wait_type,
          CASE WHEN r.blocking_session_id > 0 THEN 1 ELSE 0 END AS is_blocked
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE s.is_user_process = 1
        ORDER BY
          CASE s.status WHEN 'running' THEN 0 WHEN 'sleeping' THEN 1 ELSE 2 END,
          s.last_request_start_time DESC
      `;

const TABLE_STATS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          SUM(p.rows) AS row_count,
          SUM(a.total_pages) * 8 * 1024 AS total_size_bytes,
          SUM(a.used_pages) * 8 * 1024 AS used_size_bytes,
          SUM(CASE WHEN i.type IN (0, 1) THEN a.total_pages ELSE 0 END) * 8 * 1024 AS table_size_bytes,
          SUM(CASE WHEN i.type > 1 THEN a.total_pages ELSE 0 END) * 8 * 1024 AS index_size_bytes,
          STATS_DATE(t.object_id, 1) AS last_stats_update
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.indexes i ON t.object_id = i.object_id
        JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
        JOIN sys.allocation_units a ON p.partition_id = a.container_id
        WHERE t.type = 'U'
        GROUP BY s.name, t.name, t.object_id
        ORDER BY SUM(a.total_pages) DESC
      `;

const INDEX_STATS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          i.name AS index_name,
          i.type_desc AS index_type,
          i.is_unique,
          i.is_primary_key,
          SUM(a.total_pages) * 8 * 1024 AS index_size_bytes,
          ISNULL(u.user_seeks + u.user_scans + u.user_lookups, 0) AS scans
        FROM sys.indexes i
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        LEFT JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
        LEFT JOIN sys.allocation_units a ON p.partition_id = a.container_id
        LEFT JOIN sys.dm_db_index_usage_stats u ON i.object_id = u.object_id AND i.index_id = u.index_id AND u.database_id = DB_ID()
        WHERE i.name IS NOT NULL AND t.type = 'U'
        GROUP BY s.name, t.name, i.name, i.type_desc, i.is_unique, i.is_primary_key,
                 i.object_id, i.index_id, u.user_seeks, u.user_scans, u.user_lookups
        ORDER BY SUM(a.total_pages) DESC
      `;

const INDEX_COLUMNS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          i.name AS index_name,
          c.name AS column_name,
          ic.key_ordinal
        FROM sys.index_columns ic
        JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE i.name IS NOT NULL AND t.type = 'U'
        ORDER BY s.name, t.name, i.name, ic.key_ordinal
      `;

const STORAGE_STATS_SQL = `
        SELECT
          name,
          physical_name AS location,
          CAST(size AS BIGINT) * 8 * 1024 AS size_bytes,
          type_desc
        FROM sys.database_files
        ORDER BY size DESC
      `;

// ============================================================================
// Object surface SQL (#789)
// ----------------------------------------------------------------------------
// These are FUNCTIONS rather than the consts above, and the reason is the engine: SQL
// Server reaches another database only through a three-part name, and a database name
// cannot be bound as a parameter. So the catalog segment is interpolated - escaped
// through `escapeIdentifier`, the same `]` doubling `runMaintenance` uses - while the
// schema and the object name, which can be bound, always are.
//
// The `@schema` filter is absent from a statement rather than bound as NULL. Binding one
// would mean `request.input("schema", null)`, which leaves `mssql` inferring a type for a
// value that has none, and it would hide an unfiltered read behind a parameter nobody can
// see in the statement text.
// ============================================================================

/**
 * `SERVERPROPERTY('EngineEdition')` for Azure SQL Database.
 *
 * 5 is Azure SQL Database, 3 is Enterprise (and Developer, which is what the container
 * fixture reports), 8 is Azure SQL Managed Instance. Only 5 cannot run a cross-database
 * query, and Managed Instance can, so this is one edition and not "anything Azure".
 */
const AZURE_SQL_DATABASE_EDITION = 5;

/**
 * The `sys.objects.type` spellings behind each declared kind.
 *
 * One entry per kind, and both the counting statement's CASE and every listing's IN list
 * are built from it, so a kind added to `objectKinds` without an entry here fails loudly
 * instead of drawing a folder nothing can fill.
 *
 * **Derived from the ENGINE's documented type set, not from a fixture** (standing ruling
 * 5a, #789). A `SELECT DISTINCT type FROM sys.objects` over this repo's fixture server
 * answers eighteen spellings and none of the CLR ones, because no assembly is registered
 * there: taking the vocabulary from what happened to be present would have dropped a CLR
 * stored procedure out of the count AND the listing, invisible in the tree while ruling 5f
 * still held. Every documented spelling is decided below, and the ones this table does not
 * carry are listed with the reason.
 *
 * | Spelling | Decision |
 * |---|---|
 * | `U` | `table`. Covers a graph node or edge table, a memory-optimized table, an external table and both halves of a system-versioned temporal pair: all of those are `U` with a flag beside it, so none can fall out. |
 * | `V` | `view`. An indexed view is a `V` with a clustered index, so it is here and its index is in the detail row. |
 * | `P`, `PC`, `X` | `procedure`. SQL, CLR (assembly) and extended: all three are things a person EXECs. |
 * | `FN`, `IF`, `TF`, `FS`, `FT`, `AF` | `function`. SQL scalar, inline table-valued, multi-statement table-valued, then the CLR scalar, CLR table-valued and CLR aggregate. A person wrote a function in every case. |
 * | `SN` | `synonym`. |
 * | `SO` | `sequence`. |
 * | `TR`, `TA` | NOT here: a trigger is counted and listed from `sys.triggers`, which holds the CLR ones too. See below. |
 * | `C`, `D`, `F`, `PK`, `UQ`, `EC` | not an object kind: a constraint belongs to the table it constrains and reaches the tree through `describeObject`. |
 * | `S`, `IT`, `SQ` | Microsoft's own: a system base table, an internal table and a Service Broker queue. All carry `is_ms_shipped = 1`, so the predicate already drops them. |
 * | `TT` | a table TYPE, not a table. Measured: `CREATE TYPE ... AS TABLE` writes a `sys.objects` row named `TT_<type>_<hex>` with `is_ms_shipped = 1`, so the predicate already drops it, and the object a person wrote lives in `sys.types`. A Types folder is out of Phase 1's scope and is recorded in `docs/providers/mssql.md` as a known gap. |
 * | `R`, `PG`, `RF` | a rule, a plan guide and a replication filter procedure. Each is a real user object with no declared kind, and each is recorded as a known gap rather than folded into a kind it is not. |
 *
 * `trigger` is deliberately ABSENT from this table, and that absence is the whole reason it
 * exists rather than a `CASE` written inline. Measured on SQL Server 2022 CU26 against
 * `docker/mssql-init/01-object-fixture.sql`: `sys.objects` holds 2 triggers there and
 * `sys.triggers` holds 4, because a DATABASE-scoped DDL trigger is absent from
 * `sys.objects` entirely. A trigger count taken from `sys.objects` is short by exactly the
 * DDL triggers, and no assertion on `sys.objects` can see it.
 */
const MSSQL_OBJECT_TYPES: Record<string, readonly string[]> = {
  table: ["U"],
  view: ["V"],
  procedure: ["P", "PC", "X"],
  function: ["FN", "IF", "TF", "FS", "FT", "AF"],
  synonym: ["SN"],
  sequence: ["SO"],
};

/** The one kind `sys.objects` cannot answer for. */
const TRIGGER_KIND = "trigger";

/** `'U','V'` and so on: one kind's spellings as a SQL literal list. */
function typeList(types: readonly string[]): string {
  return types.map((type) => `'${type}'`).join(",");
}

/** Every counted spelling, derived from the table so it cannot drift from the CASE. */
const COUNTED_TYPE_LIST = typeList(Object.values(MSSQL_OBJECT_TYPES).flat());

/**
 * The CASE that names each counted spelling's kind, derived from the same table.
 *
 * Nothing can answer a kind the CASE has no arm for, because the `WHERE` restricts the read
 * to the spellings the table lists - and both come from the table. A spelling counted but
 * unnamed would answer NULL and land in the result under no kind at all.
 */
const KIND_CASE = Object.entries(MSSQL_OBJECT_TYPES)
  .flatMap(([kind, types]) => types.map((type) => `WHEN '${type}' THEN '${kind}'`))
  .join(" ");

/**
 * The databases this login can open, which on SQL Server is the outer container level.
 *
 * `HAS_DBACCESS(d.name) = 1` is the engine's own answer to "can this login use this
 * database", and it covers more than permissions: measured on SQL Server 2022 CU26, a
 * database taken OFFLINE keeps its `sys.databases` row and answers 0 here. Listing it
 * would draw a container whose schemas can never be read.
 *
 * The Azure arm is in the STATEMENT rather than in TypeScript, so one read serves both
 * editions and neither can be forgotten. Azure SQL Database cannot run a cross-database
 * query at all, so every catalog other than the connected one would draw a container that
 * opens onto an error - and answering an empty list there would be a lie about the
 * database the caller is connected to, which is why the level lists exactly one row
 * instead. UNVERIFIED against a live Azure SQL Database: `docs/providers/mssql.md` records
 * that, and records that the arm was probed here by inverting the edition it tests.
 *
 * `DB_ID()` rather than the configured database name: it is the server's own answer for
 * which database this session is in, so it stays right for a connection string that named
 * none and for a name whose case differs from the catalog's.
 */
const CONTAINERS_SQL = `
        SELECT d.name AS name,
               CASE WHEN d.database_id = DB_ID() THEN 1 ELSE 0 END AS is_session_default
        FROM sys.databases d
        WHERE HAS_DBACCESS(d.name) = 1
          AND (SERVERPROPERTY('EngineEdition') <> ${AZURE_SQL_DATABASE_EDITION} OR d.database_id = DB_ID())
        ORDER BY d.name
      `;

/**
 * One database's schemas, which is the inner container level.
 *
 * Two exclusions, and both are measured rather than tidied. `sys` and `INFORMATION_SCHEMA`
 * can hold NOTHING a person wrote: `CREATE TABLE sys.probe` and
 * `CREATE TABLE INFORMATION_SCHEMA.probe` both answer Msg 2760 on SQL Server 2022 CU26,
 * and across every accessible database on the fixture server not one object in either
 * schema has `is_ms_shipped = 0`. The nine fixed-role schemas (`db_owner`,
 * `db_datareader`, ...) exist to own permissions, and `is_fixed_role` on the owning
 * principal is the engine's own answer for which those are - no name list and no
 * `schema_id >= 16384` magic number.
 *
 * The `EXISTS` arm is what keeps that second exclusion from hiding anything: a fixed-role
 * schema CAN hold a user object (`CREATE TABLE db_owner.t` succeeds, measured), and one
 * that does is listed. So the count for a whole database always equals the sum over the
 * schemas this statement lists, because a schema it drops holds nothing to count.
 *
 * `isSessionDefault` is answered for the CONNECTED database only, and that restriction is
 * the whole of it: SQL Server publishes the session's default schema as `SCHEMA_NAME()`,
 * which is evaluated in the database the session is in, so marking a row under any other
 * catalog would name a schema the session has nothing to do with. `DB_NAME()` travels back
 * with the rows so the caller can apply that restriction against the catalog it asked for,
 * rather than this statement interpolating a database NAME as a literal to compare.
 *
 * The tree needs it at this level: first paint walks the container chain down to the
 * session default at the DEEPEST declared level and reads the counts there, so an engine
 * that marks only its outer level opens a catalog and stops, with no folder and no count
 * (#789). `SCHEMA_NAME()` is the connection's own default schema, which is `dbo` for a
 * login that has not been given another.
 */
function schemasSql(database: string): string {
  return `
        SELECT s.name AS name,
               CASE WHEN s.name = SCHEMA_NAME() THEN 1 ELSE 0 END AS is_session_schema,
               DB_NAME() AS connected_database
        FROM ${database}.sys.schemas s
        JOIN ${database}.sys.database_principals p ON p.principal_id = s.principal_id
        WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
          AND (p.is_fixed_role = 0
               OR EXISTS (SELECT 1 FROM ${database}.sys.objects o
                          WHERE o.schema_id = s.schema_id AND o.is_ms_shipped = 0))
        ORDER BY s.name
      `;
}

/**
 * How many objects of each kind one container holds, in one statement and one round trip.
 *
 * `is_ms_shipped = 0` is load-bearing and not hygiene. Measured on SQL Server 2022 CU26,
 * `msdb` holds 476 stored procedures, 145 tables, 78 views, 38 triggers, 58 functions and
 * 10 synonyms, every one of them shipped by Microsoft: without the predicate, a database
 * nobody has written a line in reports hundreds of objects, and a fresh user database
 * reports 72 system tables and 36 internal ones as tables.
 *
 * The trigger arm reads `sys.triggers` because `sys.objects` has no DDL trigger at all,
 * and it joins the base object's schema so the same arm can be filtered by schema: a DML
 * trigger belongs to its base object's schema, and a DATABASE-scoped DDL trigger belongs
 * to no schema, so a schema-filtered count drops it. That is the honest answer at that
 * depth, and the database-level count is where it appears.
 */
function countsSql(database: string, bySchema: boolean): string {
  return `
        SELECT kind, COUNT(*) AS n FROM (
          SELECT CASE o.type ${KIND_CASE} END AS kind
          FROM ${database}.sys.objects o
          JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.is_ms_shipped = 0 AND o.type IN (${COUNTED_TYPE_LIST})${bySchema ? " AND s.name = @schema" : ""}
          UNION ALL
          SELECT '${TRIGGER_KIND}'
          FROM ${database}.sys.triggers t
          LEFT JOIN ${database}.sys.objects po ON po.object_id = t.parent_id
          LEFT JOIN ${database}.sys.schemas ps ON ps.schema_id = po.schema_id
          WHERE t.is_ms_shipped = 0${bySchema ? " AND ps.name = @schema" : ""}
        ) counted
        GROUP BY kind
      `;
}

/**
 * One kind's objects, names only, with the row count SQL Server maintains for a table.
 *
 * `sys.partitions` with `index_id IN (0, 1)` is the heap or the clustered index, which is
 * the same expression `SCHEMA_TABLES_SQL` uses for the flat schema tree - so a table's
 * count reads the same in both surfaces while both are live. It is an approximation the
 * engine maintains rather than a `COUNT(*)`, which is what `DatabaseObject.rowCount`
 * promises and all this tree needs.
 *
 * `withRowCount` is false for every other kind rather than answering 0, because a view, a
 * routine, a synonym and a sequence have no rows of their own: the column is not selected,
 * so the object carries no `rowCount` key at all.
 */
function listObjectsSql(database: string, types: readonly string[], bySchema: boolean, withRowCount: boolean): string {
  const schemaFilter = bySchema ? " AND s.name = @schema" : "";
  if (!withRowCount) {
    return `
        SELECT s.name AS schema_name, o.name AS name
        FROM ${database}.sys.objects o
        JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.is_ms_shipped = 0 AND o.type IN (${typeList(types)})${schemaFilter}
      `;
  }
  return `
        SELECT s.name AS schema_name, o.name AS name, SUM(p.rows) AS row_count
        FROM ${database}.sys.objects o
        JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
        LEFT JOIN ${database}.sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
        WHERE o.is_ms_shipped = 0 AND o.type IN (${typeList(types)})${schemaFilter}
        GROUP BY s.name, o.name
      `;
}

/**
 * One container's triggers, each with the object it fires on.
 *
 * `sys.triggers` is the spine and `sys.objects` is OUTER joined, which is the shape of this
 * statement rather than a style choice. `countObjects` counts triggers from `sys.triggers`,
 * and standing ruling 5f (#789) requires this listing to hold exactly what that count
 * counted: a DATABASE-scoped DDL trigger has `parent_id = 0` and no row to join, so an
 * inner join would drop the two the badge already counted.
 *
 * Both parent columns arrive NULL together for that reason, and the object then hangs off
 * the database itself, which ruling 5f allows. `is_disabled` is the one state SQL Server
 * publishes about an object of any declared kind - there is no VALID / INVALID here, so
 * there is no second vocabulary for this field to collide with, which is why Oracle keeps
 * ENABLED / DISABLED out of the same field and this provider carries it.
 *
 * The join cannot multiply rows: a trigger is one `sys.triggers` row and `object_id` is
 * unique in `sys.objects`.
 */
function listTriggersSql(database: string, bySchema: boolean): string {
  return `
        SELECT t.name AS name, ps.name AS parent_schema, po.name AS parent_name, t.is_disabled
        FROM ${database}.sys.triggers t
        LEFT JOIN ${database}.sys.objects po ON po.object_id = t.parent_id
        LEFT JOIN ${database}.sys.schemas ps ON ps.schema_id = po.schema_id
        WHERE t.is_ms_shipped = 0${bySchema ? " AND ps.name = @schema" : ""}
      `;
}

// ----------------------------------------------------------------------------
// One object's detail. Four narrow reads, each bound to ONE schema and ONE object.
//
// Four statements rather than one wide one, on Oracle's precedent in this epic: each
// failure names its own statement through `mapDatabaseError`, and a single connection
// serialises them anyway. Every one of them keys the object explicitly rather than through
// `OBJECT_NAME()` or `COL_NAME()`, which the flat schema query above uses: those resolve
// in the CURRENT database and would answer for the connected one while this read is
// three-part named at another.
// ----------------------------------------------------------------------------

/**
 * Columns, from `sys.columns` rather than `INFORMATION_SCHEMA.COLUMNS`.
 *
 * `sys.types.name` is the same spelling `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` gives, so
 * this surface and the flat schema tree name a column's type identically while both are
 * live: verified column by column on the fixture's `app.orders` - int, int, decimal,
 * nvarchar from both. `sys.default_constraints.definition` likewise matches
 * `COLUMN_DEFAULT`, parentheses included (`((0))`).
 */
function objectColumnsSql(database: string): string {
  return `
        SELECT c.name AS name, ty.name AS data_type, c.is_nullable, dc.definition AS default_definition
        FROM ${database}.sys.columns c
        JOIN ${database}.sys.objects o ON o.object_id = c.object_id
        JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
        JOIN ${database}.sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN ${database}.sys.default_constraints dc ON dc.object_id = c.default_object_id
        WHERE s.name = @schema AND o.name = @name
        ORDER BY c.column_id
      `;
}

function objectPrimaryKeySql(database: string): string {
  return `
        SELECT c.name AS name
        FROM ${database}.sys.indexes i
        JOIN ${database}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${database}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        JOIN ${database}.sys.objects o ON o.object_id = i.object_id
        JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE i.is_primary_key = 1 AND s.name = @schema AND o.name = @name
      `;
}

/**
 * Foreign keys, paired column by column.
 *
 * `sys.foreign_key_columns` already carries both sides of each pair in one row, so there
 * is no position join to get wrong here. The referenced schema comes back as its own
 * column because a foreign key may cross schemas, and `referencedTable` below qualifies
 * the name when it does.
 */
function objectForeignKeysSql(database: string): string {
  return `
        SELECT pc.name AS column_name, rs.name AS ref_schema, ro.name AS ref_table, rc.name AS ref_column
        FROM ${database}.sys.foreign_keys fk
        JOIN ${database}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN ${database}.sys.objects po ON po.object_id = fk.parent_object_id
        JOIN ${database}.sys.schemas ps ON ps.schema_id = po.schema_id
        JOIN ${database}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN ${database}.sys.objects ro ON ro.object_id = fk.referenced_object_id
        JOIN ${database}.sys.schemas rs ON rs.schema_id = ro.schema_id
        JOIN ${database}.sys.columns rc ON rc.object_id = fkc.referenced_object_id
               AND rc.column_id = fkc.referenced_column_id
        WHERE ps.name = @schema AND po.name = @name
        ORDER BY fk.name, fkc.constraint_column_id
      `;
}

/**
 * Indexes, filtered the same way `SCHEMA_INDEXES_SQL` filters them.
 *
 * `i.name IS NOT NULL` drops the heap, and `is_primary_key = 0` drops the index behind the
 * primary key, which the columns' own `isPrimary` already carries. Keeping the two
 * surfaces' rule identical is what stops one screen showing an index the other hides.
 */
function objectIndexesSql(database: string): string {
  return `
        SELECT i.name AS index_name, i.is_unique, c.name AS column_name
        FROM ${database}.sys.indexes i
        JOIN ${database}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${database}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        JOIN ${database}.sys.objects o ON o.object_id = i.object_id
        JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name AND i.name IS NOT NULL AND i.is_primary_key = 0
        ORDER BY i.name, ic.key_ordinal
      `;
}

// ----------------------------------------------------------------------------
// Every object of one kind, described together (#789)
//
// FIVE statements for a whole folder rather than four per object. They share one
// `described` CTE, which is the target set, and each detail read joins it on `object_id`
// rather than on a name: an object id is the engine's own key for the object, so nothing
// here has to compare two strings under a collation to decide which rows belong together.
//
// The five are separate statements rather than one batch of result sets, on the precedent
// the four single-object reads set in this file: each failure names its own statement
// through `mapDatabaseError`, and one connection serialises them anyway. The COUNT is what
// matters and it is constant - five, whether the folder holds one object or five thousand.
// ----------------------------------------------------------------------------

/**
 * The objects one bulk read describes, ordered and cut only when the caller bounded it.
 *
 * `TOP (@limit)` is SQL Server's spelling of a row bound and the value is BOUND rather than
 * interpolated. It comes with `ORDER BY s.name, o.name`, and the two travel together in
 * both directions: SQL Server refuses an `ORDER BY` inside a CTE that has no row bound
 * (Msg 1033), and a bound with no order would cut an arbitrary set. So the unbounded
 * statement carries neither, which is correct rather than a compromise - an unbounded read
 * cuts nothing, and the answer is re-sorted by path in code either way.
 *
 * The order runs under the DATABASE's collation, which is SQL_Latin1_General_CP1_CI_AS on
 * the fixture server (measured) and is case-insensitive there. `(schema, name)` is unique
 * within a database, so the order is TOTAL and all five statements cut the same set.
 */
function describedSql(database: string, types: readonly string[], bySchema: boolean, bounded: boolean): string {
  return `
        WITH described AS (
          SELECT ${bounded ? "TOP (@limit) " : ""}o.object_id, s.name AS schema_name, o.name AS name
          FROM ${database}.sys.objects o
          JOIN ${database}.sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.is_ms_shipped = 0 AND o.type IN (${typeList(types)})${bySchema ? " AND s.name = @schema" : ""}${
            bounded ? "\n          ORDER BY s.name, o.name" : ""
          }
        )`;
}

/** The target set itself, which is what says WHICH objects the answer is about. */
function bulkTargetSql(database: string, types: readonly string[], bySchema: boolean, bounded: boolean): string {
  return `${describedSql(database, types, bySchema, bounded)}
        SELECT d.object_id, d.schema_name, d.name FROM described d`;
}

/**
 * The four detail reads, each re-pointed from ONE object to the whole target set.
 *
 * They are the `object*Sql()` bodies above with `WHERE s.name = @schema AND o.name = @name`
 * replaced by a join to `described`, so every measured decision those statements carry
 * still applies: columns come from `sys.columns` and `sys.types` rather than from
 * `INFORMATION_SCHEMA.COLUMNS`, `i.name IS NOT NULL` drops the heap, `is_primary_key = 0`
 * drops the index behind the primary key, and the foreign-key pairs come from
 * `sys.foreign_key_columns`, which carries both sides of each pair in one row.
 *
 * Nothing here caps a column list. An unreported bound is the defect
 * `ObjectDetailBatch.truncated` exists to prevent; what is bounded here is the number of
 * OBJECTS, by the caller, and it is reported.
 */
function bulkDetailSql(
  database: string,
  types: readonly string[],
  bySchema: boolean,
  bounded: boolean,
): { columns: string; primaryKey: string; foreignKeys: string; indexes: string } {
  const described = describedSql(database, types, bySchema, bounded);
  return {
    columns: `${described}
        SELECT d.object_id, c.name AS name, ty.name AS data_type, c.is_nullable, dc.definition AS default_definition
        FROM described d
        JOIN ${database}.sys.columns c ON c.object_id = d.object_id
        JOIN ${database}.sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN ${database}.sys.default_constraints dc ON dc.object_id = c.default_object_id
        ORDER BY d.object_id, c.column_id`,
    primaryKey: `${described}
        SELECT d.object_id, c.name AS name
        FROM described d
        JOIN ${database}.sys.indexes i ON i.object_id = d.object_id AND i.is_primary_key = 1
        JOIN ${database}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${database}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id`,
    foreignKeys: `${described}
        SELECT d.object_id, pc.name AS column_name, rs.name AS ref_schema, ro.name AS ref_table, rc.name AS ref_column
        FROM described d
        JOIN ${database}.sys.foreign_keys fk ON fk.parent_object_id = d.object_id
        JOIN ${database}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN ${database}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN ${database}.sys.objects ro ON ro.object_id = fk.referenced_object_id
        JOIN ${database}.sys.schemas rs ON rs.schema_id = ro.schema_id
        JOIN ${database}.sys.columns rc ON rc.object_id = fkc.referenced_object_id
               AND rc.column_id = fkc.referenced_column_id
        ORDER BY d.object_id, fk.name, fkc.constraint_column_id`,
    indexes: `${described}
        SELECT d.object_id, i.name AS index_name, i.is_unique, c.name AS column_name
        FROM described d
        JOIN ${database}.sys.indexes i ON i.object_id = d.object_id AND i.name IS NOT NULL AND i.is_primary_key = 0
        JOIN ${database}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${database}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        ORDER BY d.object_id, i.name, ic.key_ordinal`,
  };
}

// ============================================================================
// Object surface shapes and derivations (#789)
// ============================================================================

/** One row of `CONTAINERS_SQL`. */
interface ContainerRow {
  name: string;
  is_session_default: number;
}

/** One row of `schemasSql`. */
interface SchemaNameRow {
  name: string;
  /** `SCHEMA_NAME()`, which is the session's default schema IN THE CONNECTED DATABASE. */
  is_session_schema: number;
  /** `DB_NAME()`, so the caller can tell whether the column above is about this catalog. */
  connected_database: string;
}

/** One row of `countsSql`: a kind id and how many of it the container holds. */
interface KindCountRow {
  kind: string;
  n: number;
}

/**
 * One row of a `sys.objects` listing: the object's own schema, and a row count where the
 * statement selected one.
 */
interface SchemaObjectRow {
  name: string;
  schema_name: string;
  row_count?: number | string | null;
}

/**
 * One row of the trigger listing: its BASE OBJECT rather than its own schema, both columns
 * NULL for a DATABASE-scoped DDL trigger, and the state SQL Server publishes for it.
 */
interface TriggerRow {
  name: string;
  parent_schema: string | null;
  parent_name: string | null;
  is_disabled: boolean;
}

interface ColumnRow {
  name: string;
  data_type: string;
  is_nullable: boolean;
  default_definition: string | null;
}

interface ForeignKeyRow {
  column_name: string;
  ref_schema: string;
  ref_table: string;
  ref_column: string;
}

interface IndexRow {
  index_name: string;
  is_unique: boolean;
  column_name: string;
}

/**
 * The container levels this engine declares, cut to the depth `containerDepth()` answers.
 *
 * Every derivation below starts here rather than from a length or an index. Standing
 * ruling 5g (#789) is about the three spellings of one defect, and all three are wrong on
 * this engine specifically: a hardcoded `container.length !== 1`, a positional
 * `path[1]` for the object name, and a positional `path[0]` for the schema. SQL Server is
 * the first engine in the epic where the schema is not at index 0 and the name is not at
 * index 1, so the derivations are written once here and every caller reads them.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The container segments of a path, keyed by the LEVEL each one belongs to.
 *
 * This is what replaces `container[0]` and `path[1]`: the caller asks for `catalog` or
 * `schema` by name, so a level added, removed or reordered moves every read with it and a
 * one-level engine copying this file gets `schema: undefined` rather than a segment that
 * happens to sit at the index it expected.
 *
 * `Object.fromEntries` loses the key union, so the result is asserted back to it. The
 * assertion is sound by construction: the entries are exactly the declared level ids, and
 * `Partial` is what carries "a database-level container names no schema".
 */
function containerSegments(
  capabilities: ProviderCapabilities,
  path: readonly string[],
): Partial<Record<ContainerLevelSpec["id"], string>> {
  const levels = declaredLevels(capabilities);
  return Object.fromEntries(
    path.slice(0, levels.length).map((segment, index) => [levels[index].id, segment]),
  ) as Partial<Record<ContainerLevelSpec["id"], string>>;
}

/**
 * The segment one declared level carries, or a refusal naming the level.
 *
 * Every caller that interpolates a segment into a three-part name goes through this rather
 * than through a non-null assertion, because `undefined` reaching the statement builds
 * `[undefined].sys.objects` and asks the server a question about a database nobody has.
 * The case is reachable without a bug in this file: a provider that copied it and declared
 * only a `schema` level would pass the length check below and then have no catalog
 * segment at all.
 */
function requiredSegment(
  segments: Partial<Record<ContainerLevelSpec["id"], string>>,
  level: ContainerLevelSpec["id"],
): string {
  const segment = segments[level];
  if (segment === undefined) {
    throw new QueryError(`SQL Server declares no ${level} level to read this path's segment from`, "mssql");
  }
  return segment;
}

/**
 * The container paths this engine accepts, outermost first, as segment NAMES.
 *
 * Every prefix of the declared levels, which on a two-level engine means a database alone
 * or a database and a schema. Both are real containers here: the tree only ever draws
 * folders at the deepest level (`src/components/object-tree/flatten.ts`), but
 * `assertContainerDepth` in `src/lib/api/object-route.ts` admits any path down to the
 * declared depth and `assertObjectSurface` reads counts at the OUTER one, so a database
 * holding twelve tables across three schemas is a question with a true answer rather than
 * a caller mistake.
 *
 * The names in the message are the declared LABELS, which is the engine's own word for a
 * person reading a refusal; the code addresses the same segments by `ContainerLevelSpec.id`
 * through `containerSegments()`. The depth behind both is `containerDepth()`, so the check
 * and the sentence it raises cannot disagree.
 */
function containerShapes(capabilities: ProviderCapabilities): readonly string[][] {
  const names = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  return names.map((_, index) => names.slice(0, index + 1));
}

/** The shapes above, spelled for a message: `[database] or [database, schema]`. */
function shapeList(shapes: readonly string[][]): string {
  return shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ");
}

/**
 * The segments a container path addresses, keyed by level, or a refusal naming the shapes.
 *
 * It raises rather than reading a segment and carrying on, because `undefined`
 * interpolated into a three-part name would either fail with a syntax error nobody can
 * read or, worse, answer an empty folder that looks exactly like a schema holding nothing.
 */
function containerTarget(
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Partial<Record<ContainerLevelSpec["id"], string>> {
  const shapes = containerShapes(capabilities);
  if (!shapes.some((shape) => shape.length === container.length)) {
    throw new QueryError(
      `A SQL Server container path is ${shapeList(shapes)}, received ${JSON.stringify(container)}`,
      "mssql",
    );
  }
  return containerSegments(capabilities, container);
}

/**
 * The path shapes one KIND's objects are addressed by, derived from the declaration.
 *
 * A kind with no `attachedTo` sits in a schema: every object in `sys.objects` does, and
 * `CREATE TABLE` with no schema resolves to the login's default one rather than to no
 * schema. A kind that declares `attachedTo` takes the extra segment for its base object,
 * and it also takes the catalog-scoped shape, because a DDL trigger has no schema at all -
 * measured: `parent_class = 0` and `parent_id = 0`, so `[database, name]` is its whole
 * address.
 *
 * That second shape is the levels FILTERED TO `catalog`, not the first level by position:
 * it states where a DDL trigger lives, and naming the level is what keeps it true on an
 * engine whose levels are declared in another order.
 */
function objectShapes(capabilities: ProviderCapabilities, spec: ObjectKindSpec): readonly string[][] {
  const levels = declaredLevels(capabilities);
  const names = (specs: readonly ContainerLevelSpec[]) => specs.map((level) => level.label.toLowerCase());
  if (spec.attachedTo === undefined) return [[...names(levels), "name"]];

  const shapes = [[...names(levels), spec.attachedTo, "name"]];
  // Only when the engine HAS a catalog level. An empty filter would spread to nothing and
  // leave `["name"]`, a container-less single segment - unreachable on SQL Server, and
  // reachable in any one-level provider that copies this helper, where it would accept a
  // bare object name for an attached kind and answer a detail for it.
  const catalogLevels = levels.filter((level) => level.id === "catalog");
  if (catalogLevels.length > 0) shapes.push([...names(catalogLevels), "name"]);
  return shapes;
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this engine has this kind and this container holds none" render
 * as a 0 badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has
 * no such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through `mapDatabaseError`. That mapper gives a THROWN error a type and
 * this product's prefix, and nothing here throws: the sentence is rendered to a person as
 * the reason a folder has no number, so prefixing it would put our words in front of SQL
 * Server's. A refused read is never 0 - "The SELECT permission was denied" and "this
 * schema holds no tables" are different facts, and `KindCount` is the type that keeps them
 * apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/** Overwrites the seeded zeros with what the GROUP BY actually answered. */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    counts[row.kind] = { count: Number(row.n) };
  }
}

/**
 * Which statement answers for one kind, the row shape it returns, or nothing when no
 * statement here lists it.
 *
 * The type spellings are interpolated from `MSSQL_OBJECT_TYPES` and never from anything a
 * caller supplied. The lookup is `Object.hasOwn` and not a bare index: a kind id is an OPEN
 * string, and `MSSQL_OBJECT_TYPES["toString"]` answers a function off the prototype chain
 * rather than `undefined`, which would reach `typeList()` as a kind this engine has.
 *
 * `rows` travels with the statement because the two are one fact: the trigger listing
 * selects its BASE OBJECT and every other listing selects the object's own schema. Sniffing
 * a property off the row instead would have to widen a union that `Object.hasOwn` does not
 * narrow (measured against this repo's TypeScript), and a cast there is exactly the kind of
 * unchecked claim the shape is meant to remove.
 */
function objectListingStatement(
  catalog: string,
  kind: string,
  bySchema: boolean,
): { sql: string; rows: "schema" | "trigger" } | undefined {
  if (kind === TRIGGER_KIND) return { sql: listTriggersSql(catalog, bySchema), rows: "trigger" };
  if (!Object.hasOwn(MSSQL_OBJECT_TYPES, kind)) return undefined;
  const types = MSSQL_OBJECT_TYPES[kind];
  // Only a table has rows of its own. A view's rows belong to the tables under its query.
  const withRowCount = kind === "table";
  return { sql: listObjectsSql(catalog, types, bySchema, withRowCount), rows: "schema" };
}

/**
 * `SUM(p.rows)` as a number, or nothing - and absence is a different fact from 0.
 *
 * Three arms, each on its own LINE so the 100 percent line gate can see them: standing
 * ruling 5b's warning is that an arm folded onto a shared line is invisible to a line
 * counter, and the fixture varies all three rather than trusting the number.
 *
 * `undefined` is the statement not selecting the column at all, which is every kind but
 * `table`. NULL is engine-reachable through the LEFT JOIN: `SUM()` over no matching
 * partition row answers NULL, and reporting that as 0 would claim a measurement nobody
 * made. The unparseable arm is a DRIVER-shape guard rather than an engine value - tedious
 * returns this column as a number on the fixture server - and it is here because
 * `DatabaseObject.rowCount` is typed `number` and NaN would cross the wire as `null`
 * anyway, one key later and with no way to tell it from the absence above.
 */
function measuredRowCount(raw: number | string | null | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

/**
 * One `sys.objects` row as the object it addresses.
 *
 * The schema comes from the ROW rather than from the container, and that is load-bearing at
 * the database level, where one listing spans every schema. Each object carries exactly the
 * keys its statement selected: a table's row count is present because it was read, and a
 * view's is absent rather than 0.
 *
 * `name` is the last path segment for every kind on this engine, which is measured rather
 * than assumed: SQL Server has no routine overloading at all (`CREATE FUNCTION` with a
 * second signature answers Msg 2714), so no kind needs the disambiguated segment a
 * PostgreSQL routine needs.
 */
function listedSchemaObject(catalog: string, kind: string, row: SchemaObjectRow): DatabaseObject {
  const rowCount = measuredRowCount(row.row_count);
  return {
    path: schemaObjectPath(catalog, row),
    name: row.name,
    kind,
    ...(rowCount === undefined ? {} : { rowCount }),
  };
}

/**
 * One `sys.triggers` row as the object it addresses, at whichever of the two depths it has.
 *
 * Both parent columns arrive NULL together for a DATABASE-scoped DDL trigger, which has no
 * schema and no base object, so it hangs off the catalog itself. Standing ruling 5f (#789)
 * is what makes that right rather than a filter: the count counted it, so the listing shows
 * it, and the path shape gives way instead of the badge.
 */
function listedTrigger(catalog: string, kind: string, row: TriggerRow): DatabaseObject {
  const path =
    row.parent_schema === null || row.parent_name === null
      ? [catalog, row.name]
      : [catalog, row.parent_schema, row.parent_name, row.name];
  return { path, name: row.name, kind, status: row.is_disabled ? "DISABLED" : "ENABLED" };
}

/** One bulk row, whichever of the four detail reads produced it, with the object it is about. */
interface BulkRow {
  object_id: number;
}

/** One row of the bulk target read: an object, its schema and the key the four reads group on. */
interface BulkTargetRow extends BulkRow {
  schema_name: string;
  name: string;
}

/** The four row sets one object's detail is built from, whichever read produced them. */
interface DetailRows {
  readonly columns: readonly ColumnRow[];
  readonly primaryKey: readonly SchemaNameRow[];
  readonly foreignKeys: readonly ForeignKeyRow[];
  readonly indexes: readonly IndexRow[];
}

/**
 * Four catalog row sets turned into one `ObjectDetail`, shared by the single and the bulk
 * read.
 *
 * ONE function because the two reads select the same columns from the same views and a
 * caller joins their results together: two copies of this mapping would be two chances for
 * the bulk read to spell a foreign key differently from the single read of the SAME table.
 *
 * `schema` is the object's OWN schema and not the container's, which is what makes the
 * qualification rule right at the database level, where one bulk read spans every schema:
 * `referencedTable` is spelled the way `getSchema()` spells it, bare within the object's
 * schema and qualified outside it, because `ForeignKeySchema` carries one string and both
 * surfaces are live through Phase 1. SQL Server has no cross-DATABASE foreign key, so the
 * catalog never needs naming.
 */
function objectDetailFromRows(path: readonly string[], schema: string, rows: DetailRows): ObjectDetail {
  const primaryKey = new Set(rows.primaryKey.map((row) => row.name));
  const columns: ColumnSchema[] = rows.columns.map((row) => ({
    name: row.name,
    type: row.data_type,
    nullable: row.is_nullable,
    isPrimary: primaryKey.has(row.name),
    defaultValue: row.default_definition ?? undefined,
  }));

  // One entry per index, its columns in key_ordinal order, which is the order both
  // statements return them in.
  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const index = byIndex.get(row.index_name) ?? { name: row.index_name, columns: [], unique: row.is_unique };
    index.columns.push(row.column_name);
    byIndex.set(row.index_name, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: row.column_name,
    referencedTable: row.ref_schema === schema ? row.ref_table : `${row.ref_schema}.${row.ref_table}`,
    referencedColumn: row.ref_column,
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

/**
 * Where one object of a schema-scoped kind is addressed.
 *
 * The schema comes from the ROW rather than from the container, which is load-bearing at
 * the database level, where one listing and one bulk read each span every schema. It is one
 * function because `listObjects` and `describeObjects` are joined on path by every caller.
 */
function schemaObjectPath(catalog: string, row: { schema_name: string; name: string }): string[] {
  return [catalog, row.schema_name, row.name];
}

/** The rows of one bulk read grouped by the object each belongs to, keyed by the engine's own id. */
function byObjectId<T extends BulkRow>(rows: readonly T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const held = grouped.get(row.object_id);
    if (held === undefined) grouped.set(row.object_id, [row]);
    else held.push(row);
  }
  return grouped;
}

/**
 * Two paths ordered SEGMENT BY SEGMENT, shorter first where one is a prefix of the other.
 *
 * Never `JSON.stringify`, which standing ruling 5g (#789) rules out as a path key for two
 * reasons this engine actually meets: at mixed depth the serialised deeper path can sort
 * before its own prefix, and JSON escaping reorders exotic names by rewriting the very
 * characters being compared. A trigger folder here holds `[db, name]` and
 * `[db, schema, table, name]` rows together, so mixed depth is the normal case and not a
 * corner.
 */
function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

// ============================================================================
// MSSQL Provider
// ============================================================================

export class MSSQLProvider extends SQLBaseProvider {
  private pool: mssql.ConnectionPool | null = null;

  // Transaction support
  private txTransaction: mssql.Transaction | null = null;
  private txActive = false;

  // Track running requests for cancellation
  private runningRequests = new Map<string, mssql.Request>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 1433,
      // Disabled until a SQL Server dialect wrapper exists (#126): a real plan flow needs
      // session-level SET SHOWPLAN_*, which the single-statement explain path cannot express.
      supportsExplain: false,
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // The mssql package's Transaction object over one held pool connection.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "check", "optimize", "kill"],
      // `optimize` is `ALTER INDEX ALL ON [<t>] REBUILD`, so its target is a TABLE
      // even though the wording says indexes - the same words Oracle uses for an
      // operation that needed a different kind of name (#496). `check` is
      // `DBCC CHECKDB`, which takes no object: `runMaintenance` ignores the target,
      // so only a global control can honestly offer it.
      maintenanceOperationSpecs: {
        analyze: { label: "Update Statistics", perEntity: true, global: true },
        check: { label: "Check Database", perEntity: false, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      },
      // TWO levels, which no engine in #789 before this one declared. A SQL Server
      // instance holds databases, each holding schemas, and both are addressable from one
      // connection: a three-part name reaches another database's catalog views, so the
      // outer level is a real container here rather than a second connection. Azure SQL
      // Database is the exception and it is answered in `CONTAINERS_SQL` rather than here,
      // because the level still exists there - it just holds exactly one row.
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
      // Seven kinds. Six are `sys.objects.type` spellings (`MSSQL_OBJECT_TYPES`) and the
      // seventh, the trigger, is read from `sys.triggers` because `sys.objects` holds no
      // DDL trigger at all (#789).
      //
      // No `index` kind, deliberately. SQL Server models an index as an attribute of the
      // object it is on - `sys.indexes` is keyed by `object_id` and an index cannot exist
      // without one - so it belongs in `describeObject`'s output, where it is, rather than
      // in a folder of its own.
      //
      // No `materialized view` either: SQL Server has no such object. An indexed view is a
      // VIEW with a clustered index on it, so it is already in the `view` folder with its
      // index in the detail row, and declaring a kind for it would draw a folder for a
      // concept the engine does not have.
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        // No `acceptsRowWrites` on a view. SQL Server takes an UPDATE against a view over
        // exactly one base table and refuses one over a join without an INSTEAD OF trigger,
        // which is a per-OBJECT fact this per-kind declaration cannot state.
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        { id: "procedure", role: "routine", label: "Stored Procedure", labelPlural: "Stored Procedures" },
        // One kind for three spellings: a scalar function, an inline table-valued function
        // and a multi-statement table-valued one are all things a person wrote as a
        // function.
        { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
        { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
        { id: "synonym", role: "config", label: "Synonym", labelPlural: "Synonyms" },
        { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
      ],
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Update Statistics",
      vacuumAction: "Rebuild Indexes",
      // The vacuum slot has said "Rebuild Indexes" since this provider shipped, and
      // that is `optimize`, not `vacuum` - so the global card gated on the literal
      // `vacuum` never rendered these words at all (#496).
      vacuumActionOperation: "optimize",
      analyzeGlobalLabel: "Update Stats",
      analyzeGlobalTitle: "Update Statistics",
      analyzeGlobalDesc: "Updates query optimizer statistics for all tables to improve query performance.",
      vacuumGlobalLabel: "Rebuild Indexes",
      vacuumGlobalTitle: "Rebuild All Indexes",
      vacuumGlobalDesc: "Rebuilds all indexes to reclaim space and reduce fragmentation.",
      // `getSlowQueries()` reads sys.dm_exec_query_stats, and a login without VIEW
      // SERVER STATE gets `[]` from the swallowed failure. The panel used to name a
      // PostgreSQL extension there (#463); the permission is what a DBA can act on.
      slowQueriesEmptyState:
        "Query stats come from sys.dm_exec_query_stats, which needs the VIEW SERVER STATE permission.",
    };
  }

  // ============================================================================
  // SQL Dialect Overrides
  // ============================================================================

  protected override escapeIdentifier(identifier: string): string {
    const escaped = identifier.replace(/\]/g, "]]");
    return `[${escaped}]`;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for SQL Server", "mssql");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for SQL Server", "mssql");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private buildConfig(): mssql.config {
    const host = this.config.host || "localhost";
    const port = this.config.port || 1433;
    const isAzure = host.endsWith(".database.windows.net");

    const sslConfig = this.config.ssl;
    // SQL Server 2022+ enforces encryption by default; always encrypt and trust self-signed certs for non-Azure
    let encrypt = true;
    let trustServerCertificate = !isAzure;

    if (sslConfig) {
      if (sslConfig.mode === "disable") {
        encrypt = false;
      } else {
        encrypt = true;
        trustServerCertificate = sslConfig.mode === "require";
      }
    }

    const config: mssql.config = {
      user: this.config.user,
      password: this.config.password,
      server: host,
      port,
      database: this.config.database,
      pool: {
        min: this.poolConfig.min,
        max: this.poolConfig.max,
        idleTimeoutMillis: this.poolConfig.idleTimeout,
      },
      options: {
        encrypt,
        trustServerCertificate,
        connectTimeout: this.poolConfig.acquireTimeout,
        requestTimeout: this.queryTimeout,
      },
    };

    // Named instance support
    if (this.config.instanceName) {
      config.options = {
        ...config.options,
        instanceName: this.config.instanceName,
      };
      // When using instance name, port is auto-negotiated via SQL Server Browser
      delete (config as Record<string, unknown>).port;
    }

    return config;
  }

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      const config = this.buildConfig();
      this.pool = new mssql.ConnectionPool(config);

      // `mssql`'s ConnectionPool is an EventEmitter that emits `error` for a background
      // connection failure (a non-ESOCKET tedious error) and for a failed acquire. An
      // `error` event with no listener is an uncaught exception, so without this handler
      // one of those takes the server process down (#298). A failed acquire ALSO rejects
      // the caller's promise, so this handler must only log — swallowing nothing.
      this.pool.on("error", (error: unknown) => {
        console.error("[MSSQL] Pool error:", error);
      });

      await this.pool.connect();

      // Test the connection
      await this.pool.request().query("SELECT 1 AS test");

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to SQL Server: ${error instanceof Error ? error.message : error}`,
        "mssql",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close();
      } catch {
        // Force close on error
      }
      this.pool = null;
      this.setConnected(false);
    }
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const request = this.pool!.request();

          if (queryId) {
            this.runningRequests.set(queryId, request);
          }

          // Add parameters
          if (params && params.length > 0) {
            params.forEach((p, i) => {
              request.input(`p${i + 1}`, p);
            });
          }

          const res = await request.query(sql);
          return res;
        } catch (error) {
          throw mapDatabaseError(error, "mssql", sql);
        } finally {
          if (queryId) this.runningRequests.delete(queryId);
        }
      });

      const recordset = result.recordset || [];
      const fields = recordset.columns
        ? Object.keys(recordset.columns)
        : recordset.length > 0
          ? Object.keys(recordset[0])
          : [];

      return {
        rows: recordset as Record<string, unknown>[],
        fields,
        rowCount: result.rowsAffected?.[0] ?? recordset.length,
        executionTime,
        ...mssqlColumnTypes(recordset.columns),
      };
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const request = this.runningRequests.get(queryId);
    if (!request) return false;

    try {
      request.cancel();
      return true;
    } catch (error) {
      console.error("[MSSQL] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (MSSQL TOP / OFFSET FETCH)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      // The `TOP` branch writes into the HEAD and was never reachable by a
      // trailing comment, but the pagination branch below appends at the tail
      // exactly as PostgreSQL's and Oracle's do, so it shared #280: the clause
      // landed inside the comment while this method reported a limit. Both
      // branches now build on the statement's own text and re-attach whatever
      // trailed it, which leaves the `TOP` output unchanged except that
      // whitespace before a terminating `;` is preserved instead of dropped.
      //
      // Splitting and rejoining is lossless and the splice does not depend on
      // where the statement ends, so the `TOP` branch stays correct even where
      // the tail may not be CUT. Only the appending branch has to decline there.
      //
      // The end is read under T-SQL's grammar (#292), where `#` opens no comment
      // at all - `#name` and `##name` are temp tables. That is what makes a temp
      // table an ordinary statement here rather than the special case it used to
      // be: `SELECT * FROM #tmp` is cuttable, so BOTH branches are reachable for
      // it, and the already-bounded probe sees a `FETCH NEXT` written after the
      // `#` even when trailing trivia follows it.
      const source = query.trim();
      // Resolved once and handed to both readers below, so the head splice and the
      // end reader cannot disagree about where a comment ends (#300).
      const grammar = resolveSqlGrammar(this.type);
      const { end, rewritable } = readStatementEnd(source, grammar);
      let modifiedSql = source.slice(0, end);
      const trailing = source.slice(end);

      // Two pages the shared probes cannot see, and a clause beside either is a
      // statement SQL Server refuses (Msg 10741) rather than one that returns too
      // many rows - so both decline here, before either branch commits to a
      // `wasLimited: true` (#293). The first is this dialect's own `OFFSET n ROWS`
      // form; the second is every statement whose end may not be cut, where no
      // end anchor is reading the statement's real tail and the honest answer is
      // that a page cannot be ruled out. Neither is the hash the paragraph above
      // describes: that half is closed at the root by naming the dialect.
      if (TSQL_PAGE_TAIL.test(modifiedSql) || (!rewritable && TSQL_ROW_BOUND_MENTION.test(modifiedSql))) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }

      if (offset > 0) {
        if (!rewritable) {
          return { query, wasLimited: false, limit: effectiveLimit, offset };
        }

        // OFFSET FETCH requires ORDER BY
        const hasOrderBy = /\bORDER\s+BY\b/i.test(modifiedSql);
        if (!hasOrderBy) {
          modifiedSql = `${modifiedSql} ORDER BY (SELECT NULL)`;
        }
        modifiedSql = `${modifiedSql} OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`;
      } else {
        // Inject TOP N after SELECT
        const injected = injectTop(modifiedSql, effectiveLimit, grammar);

        // Nothing to inject into: report the truth rather than a limit that is not
        // there. `analyzeQuery` also calls a CTE a SELECT, and `TOP` belongs to the
        // SELECT at its tail, which finding needs a parser this provider does not
        // have. The old head-rewrite silently produced this same non-edit behind a
        // leading comment while still claiming `wasLimited: true` (#275).
        if (injected === null) {
          return { query, wasLimited: false, limit: effectiveLimit, offset };
        }
        modifiedSql = injected;
      }

      return {
        query: `${modifiedSql}${trailing}`,
        wasLimited: true,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "mssql");
    this.txTransaction = new mssql.Transaction(this.pool!);
    await this.txTransaction.begin();
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");
    try {
      await this.txTransaction.commit();
    } finally {
      this.txTransaction = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");
    try {
      await this.txTransaction.rollback();
    } finally {
      this.txTransaction = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const request = new mssql.Request(this.txTransaction!);
          if (params && params.length > 0) {
            params.forEach((p, i) => {
              request.input(`p${i + 1}`, p);
            });
          }
          return await request.query(sql);
        } catch (error) {
          throw mapDatabaseError(error, "mssql", sql);
        }
      });

      const recordset = result.recordset || [];
      const fields = recordset.length > 0 ? Object.keys(recordset[0]) : [];

      return {
        rows: recordset as Record<string, unknown>[],
        fields,
        rowCount: result.rowsAffected?.[0] ?? recordset.length,
        executionTime,
        ...mssqlColumnTypes(recordset.columns),
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /** The catalog segment of a three-part name, escaped the way `runMaintenance` escapes one. */
  private objectCatalog(database: string): string {
    return this.escapeIdentifier(database);
  }

  /** One request with the schema and name parameters this read binds, and nothing else. */
  private objectRequest(params: Record<string, unknown>): mssql.Request {
    const request = this.pool!.request();
    for (const [name, value] of Object.entries(params)) {
      request.input(name, value);
    }
    return request;
  }

  /** One catalog read, with SQL Server's refusal mapped and quoting the statement it sent. */
  private async runObjectRows<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    try {
      const result = await this.objectRequest(params).query(sql);
      return (result.recordset || []) as T[];
    } catch (error) {
      throw mapDatabaseError(error, "mssql", sql);
    }
  }

  /**
   * The containers at `parent`: the databases this login can open, or one database's
   * schemas.
   *
   * This is the first two-level engine in #789, so it is the first `listContainers` that
   * does anything with `parent` at all. The nested read is three-part named at the
   * CALLER's database rather than at the connected one, which is not a detail: a database
   * name cannot be bound, so a provider that dropped the segment would answer the
   * connected database's schemas under every catalog in the tree and look healthy doing it.
   *
   * Below the last declared level the answer is `[]` rather than a refusal, because
   * "nothing nests under a schema" is a true statement about SQL Server and not a caller
   * mistake. The depth is read through `containerDepth()` for the reason standing ruling
   * 5g gives.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const parentPath = parent ?? [];
    // `Container.level` is the index into `containerLevels`, so a container listed under a
    // parent of depth d sits at level d. Derived from the parent rather than written twice
    // as a literal 0 and 1.
    const level = parentPath.length;

    if (level === 0) {
      const rows = await this.runObjectRows<ContainerRow>(CONTAINERS_SQL);
      return rows.map((row) => ({
        path: [row.name],
        name: row.name,
        level,
        isSessionDefault: Number(row.is_session_default) === 1,
      }));
    }
    if (level >= containerDepth(capabilities)) return [];

    // The catalog is named by its LEVEL, never taken from an index: `containerSegments`
    // is the one place a path becomes named segments (standing ruling 5g, #789).
    const catalog = requiredSegment(containerSegments(capabilities, parentPath), "catalog");
    const rows = await this.runObjectRows<SchemaNameRow>(schemasSql(this.objectCatalog(catalog)));
    return rows.map((row) => ({
      path: [...parentPath, row.name],
      name: row.name,
      level,
      // `SCHEMA_NAME()` answered for the connected database, so it says nothing about any
      // other catalog in the tree. Both segments come from this server's own catalog
      // (`d.name` above and `DB_NAME()` here), so they are compared as the strings SQL
      // Server itself produced.
      isSessionDefault: Number(row.is_session_schema) === 1 && row.connected_database === catalog,
    }));
  }

  /**
   * How many objects of each declared kind one container holds, in one round trip.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries SQL Server's own sentence, so
   * the object browser can say why a folder has no number instead of showing a zero nobody
   * measured. One statement answers for every kind, so there is no partial outcome to
   * report and no retry that could produce one.
   *
   * A database-level count is the whole database and a schema-level one is that schema.
   * For every kind except `trigger` the first is the sum of the second over the schemas
   * `listContainers` lists; a DATABASE-scoped DDL trigger belongs to no schema, so it is
   * counted at the database level only, which is the depth its address has.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const target = containerTarget(capabilities, container);
    const catalog = requiredSegment(target, "catalog");
    const schema = target.schema;
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);
    const sql = countsSql(this.objectCatalog(catalog), schema !== undefined);

    // The catch covers the READ and nothing else. Mapping the rows inside it would render a
    // fault of ours as SQL Server's own refusal sentence against every kind, which is our bug
    // wearing the engine's words - and `{ unavailable }` is rendered to a person verbatim.
    let rows: KindCountRow[];
    try {
      const result = await this.objectRequest(schema === undefined ? {} : { schema }).query(sql);
      rows = (result.recordset || []) as KindCountRow[];
    } catch (error) {
      return unavailableCounts(
        declared.map((kind) => kind.id),
        error,
      );
    }
    applyKindCounts(counts, rows);
    return counts;
  }

  /**
   * The objects of one kind in one container, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Three
   * statements answer these listings and one of them addresses its rows at two different
   * depths, so three `ORDER BY` clauses would be three chances to disagree; and a SQL sort
   * runs under the database's own collation, which is case-insensitive by default on SQL
   * Server and case-sensitive on plenty of real servers, so the same schema would come
   * back in two different orders on two of them. A code-point sort here is one rule and
   * the same rule everywhere.
   *
   * By PATH and not by name, because it is the address that has to be stable: sorting by
   * the address groups a table's triggers together, and a database-scoped DDL trigger
   * sorts among the schemas rather than inside one.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would make the two
    // methods disagree, and would report "declares no object kind" about a kind
    // `objectKinds` does declare.
    //
    // Before the container is resolved, which is the order `describeObjects` uses and the
    // order the pattern requires. Resolving first made the two methods refuse ONE bad call
    // with two different sentences: `listObjects(["bad","path"], "package")` named the path
    // while `describeObjects` of the same named the kind.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`SQL Server declares no object kind "${kind}"`, "mssql");
    }
    const target = containerTarget(capabilities, container);
    const catalog = requiredSegment(target, "catalog");
    const schema = target.schema;
    const statement = objectListingStatement(this.objectCatalog(catalog), kind, schema !== undefined);
    if (statement === undefined) {
      throw new QueryError(`SQL Server declares the kind "${kind}" but has no statement that lists it`, "mssql");
    }

    const binds = schema === undefined ? {} : { schema };
    const objects =
      statement.rows === "trigger"
        ? (await this.runObjectRows<TriggerRow>(statement.sql, binds)).map((row) => listedTrigger(catalog, kind, row))
        : (await this.runObjectRows<SchemaObjectRow>(statement.sql, binds)).map((row) =>
            listedSchemaObject(catalog, kind, row),
          );
    return objects.sort((left, right) => comparePaths(left.path, right.path));
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the two kinds SQL Server resolves as relations have any of the three, so
   * a routine, a synonym, a sequence and a trigger answer three empty arrays without a
   * round trip. That is a true fact about those kinds rather than a failed read,
   * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
   * side, and a routine's parameters are Phase 2's job.
   *
   * Without the kind the same answer would come out by accident here, and on this engine
   * that accident is reachable: measured on SQL Server 2022 CU26,
   * `CREATE TRIGGER orders ON DATABASE` succeeds while the table `app.orders` exists,
   * because a DDL trigger is not in the schema namespace - while
   * `CREATE PROCEDURE app.orders` answers Msg 2714. A read keyed on the name alone would
   * hand that trigger the table's four columns as if they were its own.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`SQL Server declares no object kind "${kind}"`, "mssql");
    }

    const shapes = objectShapes(capabilities, spec);
    if (!shapes.some((shape) => shape.length === path.length)) {
      throw new QueryError(
        `A SQL Server "${kind}" path is ${shapeList(shapes)}, received ${JSON.stringify(path)}`,
        "mssql",
      );
    }

    if (spec.role !== "relation") {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    // Three derivations, and all three are the ones standing ruling 5g (#789) asks this
    // task to pin for the fleet, because SQL Server is the first engine where each is
    // visibly wrong when written positionally:
    //
    //   - the object's own name is the LAST segment. On a one-level engine `path[1]` IS
    //     the name, so neither reference provider's suite can tell the two apart; here
    //     `path[1]` is the SCHEMA, and binding it as the name reads a table called `app`
    //     and reports an object that exists as missing.
    //   - the CONTAINER segments are `path` cut to `containerDepth()` and named by their
    //     declared level, never `path[0]` and `path[1]`. A relation path is
    //     `[...levels, name]` by construction - the shape check above is what makes that
    //     true - so the cut is exactly this object's container.
    //   - the catalog is `catalog`, the schema is `schema`, and neither is an index.
    const segments = containerSegments(capabilities, path);
    const quotedCatalog = this.objectCatalog(requiredSegment(segments, "catalog"));
    const binds = { schema: requiredSegment(segments, "schema"), name: path[path.length - 1] };

    const columnRows = await this.runObjectRows<ColumnRow>(objectColumnsSql(quotedCatalog), binds);
    if (columnRows.length === 0) {
      // A table and a view each hold at least one column on SQL Server - `CREATE TABLE t ()`
      // is a syntax error - so zero rows means the object is not there. Answering
      // `{ columns: [] }` would render a table that was dropped as a table with no columns.
      throw new QueryError(`No column row for ${path.join(".")}`, "mssql", objectColumnsSql(quotedCatalog));
    }
    const pkRows = await this.runObjectRows<SchemaNameRow>(objectPrimaryKeySql(quotedCatalog), binds);
    const fkRows = await this.runObjectRows<ForeignKeyRow>(objectForeignKeysSql(quotedCatalog), binds);
    const indexRows = await this.runObjectRows<IndexRow>(objectIndexesSql(quotedCatalog), binds);

    return objectDetailFromRows(path, binds.schema, {
      columns: columnRows,
      primaryKey: pkRows,
      foreignKeys: fkRows,
      indexes: indexRows,
    });
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one container (#789).
   *
   * FIVE round trips for the whole folder, which is the entire reason this method exists:
   * the inventory route built the same answer as one `describeObject` per object - four
   * statements each, up to 5000 objects - and removed it as an N+1. The five are the target
   * read plus the four `bulkDetailSql()` reads, and the count does not grow with the folder.
   *
   * Only the two kinds SQL Server resolves as relations can have any of the three, so a
   * routine, a synonym, a sequence and a trigger answer an empty batch with NO round trip at
   * all, exactly as `describeObject` answers three empty arrays for one of them. That is a
   * true fact about those kinds and not a refused read, so it is `{ details: [] }` rather
   * than a throw or a truncation. Measured on SQL Server 2022 CU26 against the fixture: of
   * the types a person writes, only `U` and `V` have `sys.columns` rows, and a SEQUENCE has
   * none - which is the contrast with PostgreSQL, where a sequence has three columns. The
   * one thing this engine has that the rule does not carry is a TABLE-VALUED function: `IF`
   * and `TF` do have `sys.columns` rows (2 each on the fixture), and reporting a routine's
   * result shape belongs to the phase that renders a routine, the same place
   * `describeObject` leaves it.
   *
   * An empty container costs ONE round trip rather than five: there is nothing for the four
   * detail reads to be about.
   *
   * The bound is the CALLER's and is never invented here. `TOP (@limit)` is bound at
   * `limit + 1`, so a saturated read is distinguishable from an exact one without a second
   * count, the extra object is dropped, and `truncated` carries the caller's own limit. An
   * unbounded call runs a statement with no `TOP` and can never report truncation.
   *
   * The paths are built by `schemaObjectPath()`, the same rule `listObjects` builds its
   * paths with, and sorted by the same `comparePaths`, because every caller joins the two
   * answers on path. A database-level container spans every schema and the schema comes from
   * the row, which is why the two reads share that function rather than agreeing by accident.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`SQL Server declares no object kind "${kind}"`, "mssql");
    }
    const target = containerTarget(capabilities, container);
    const catalog = requiredSegment(target, "catalog");
    const schema = target.schema;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction reaches the server as a bind it cannot
      // use; both are caller mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A SQL Server bulk column read limit must be a positive whole number, received ${limit}`,
        "mssql",
      );
    }
    if (spec.role !== "relation") return { details: [] };

    const quotedCatalog = this.objectCatalog(catalog);
    const types = MSSQL_OBJECT_TYPES[kind];
    const bySchema = schema !== undefined;
    const bounded = limit !== undefined;
    // One row more than the bound, so the read itself says whether it stopped short.
    const binds = {
      ...(schema === undefined ? {} : { schema }),
      ...(limit === undefined ? {} : { limit: limit + 1 }),
    };

    const targetRows = await this.runObjectRows<BulkTargetRow>(
      bulkTargetSql(quotedCatalog, types, bySchema, bounded),
      binds,
    );
    const truncated = bounded && targetRows.length > limit;
    const described = truncated ? targetRows.slice(0, limit) : targetRows;
    if (described.length === 0) return { details: [] };

    const statements = bulkDetailSql(quotedCatalog, types, bySchema, bounded);
    const columns = byObjectId(await this.runObjectRows<ColumnRow & BulkRow>(statements.columns, binds));
    const primaryKey = byObjectId(await this.runObjectRows<SchemaNameRow & BulkRow>(statements.primaryKey, binds));
    const foreignKeys = byObjectId(await this.runObjectRows<ForeignKeyRow & BulkRow>(statements.foreignKeys, binds));
    const indexes = byObjectId(await this.runObjectRows<IndexRow & BulkRow>(statements.indexes, binds));

    const details = described
      .map((row) =>
        objectDetailFromRows(schemaObjectPath(catalog, row), row.schema_name, {
          columns: columns.get(row.object_id) ?? [],
          primaryKey: primaryKey.get(row.object_id) ?? [],
          foreignKeys: foreignKeys.get(row.object_id) ?? [],
          indexes: indexes.get(row.object_id) ?? [],
        }),
      )
      .sort((left, right) => comparePaths(left.path, right.path));
    return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      // Left UNDEFINED, and spread conditionally into the return below.
      // `HealthInfo.activeConnections` is optional precisely so a server whose session
      // DMV was denied omits the figure instead of sending a fabricated 0, and this is
      // the reading the agent forwards to the model (`src/lib/agent/tools.ts` projects
      // it with `?? null`), so an initial 0 made a denial indistinguishable from an
      // idle instance. Reading every session from sys.dm_exec_sessions needs
      // VIEW SERVER STATE on SQL Server 2019 and earlier and VIEW SERVER PERFORMANCE
      // STATE on 2022 and later (Microsoft's reference for the view; VIEW SERVER STATE
      // implies the newer grant, so it still covers this) - on the 2022 CU26 instance
      // whose refusal was measured 2026-08-23 that is the SAME permission the
      // performance-counter DMV wanted, not a sibling grant (`Msg 300 ... VIEW SERVER
      // PERFORMANCE STATE permission was denied on object 'server', database
      // 'master'`). Azure SQL Database wants VIEW DATABASE STATE and restricts the
      // same server-scoped DMVs. See docs/providers/mssql.md section 7.2.
      let activeConnections: number | undefined;
      let databaseSize = "N/A";
      let cacheHitRatio: string = CACHE_HIT_RATIO_UNAVAILABLE;
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await this.pool!.request().query(
          `SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1`,
        );
        // measuredNumber, not `|| 0`: a genuinely idle instance answers 0 and that 0 is
        // a reading, so the falsy test would have thrown away the very figure it was
        // meant to publish. Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(connRes.recordset[0]?.cnt);
      } catch {
        /* The figure stays absent, never 0. Which grant this DMV wants is in the note
           above; that an ungranted login is documented as row-filtered rather than
           refused - so this guard may never run for one - is in section 7.2. */
      }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(DATABASE_SIZE_MB_SQL);
        const mb = Number(sizeRes.recordset[0]?.size_mb || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch {
        /* ignore */
      }

      // Cache hit ratio. `|| 0` used to publish "0%" for a reading SQL Server never
      // gave, and the Overview card rates 0 as "Needs tuning". Both absences are
      // ordinary and both were measured 2026-08-23 on SQL Server 2022 CU26: a login
      // with only CONNECT gets `Msg 300 ... VIEW SERVER PERFORMANCE STATE permission
      // was denied on object 'server', database 'master'` (the catch below), and a
      // zero counter base gives one `NULL` row through NULLIF (measuredNumber).
      try {
        const cacheRes = await this.pool!.request().query(BUFFER_CACHE_HIT_RATIO_SQL);
        const ratio = measuredNumber(cacheRes.recordset[0]?.hit_ratio);
        if (ratio !== undefined) cacheHitRatio = `${formatCacheHitRatio(ratio)}%`;
      } catch {
        /* The DMV needs VIEW SERVER PERFORMANCE STATE; the initial "N/A" stands. */
      }

      // Slow queries
      try {
        const slowRes = await this.pool!.request().query(HEALTH_SLOW_QUERIES_SQL);
        for (const row of slowRes.recordset || []) {
          slowQueries.push({
            query: String(row.query || ""),
            calls: Number(row.calls || 0),
            avgTime: `${row.avg_time_ms}ms`,
          });
        }
      } catch {
        /* DMV permissions */
      }

      // Active sessions
      try {
        const sessRes = await this.pool!.request().query(HEALTH_ACTIVE_SESSIONS_SQL);
        for (const row of sessRes.recordset || []) {
          activeSessions.push({
            pid: Number(row.pid || 0),
            user: String(row.user || "unknown"),
            database: String(row.database || ""),
            state: String(row.state || "unknown"),
            query: String(row.query || ""),
            duration: String(row.duration || "N/A"),
          });
        }
      } catch {
        /* ignore */
      }

      return {
        ...(activeConnections === undefined ? {} : { activeConnections }),
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      try {
        let sql = "";

        switch (type) {
          case "analyze":
            if (target) {
              sql = `UPDATE STATISTICS [${target.replace(/\]/g, "]]")}]`;
            } else {
              sql = `EXEC sp_updatestats`;
            }
            break;
          case "check":
            sql = `DBCC CHECKDB WITH NO_INFOMSGS`;
            break;
          case "optimize":
            if (target) {
              sql = `ALTER INDEX ALL ON [${target.replace(/\]/g, "]]")}] REBUILD`;
            } else {
              sql = REBUILD_ALL_INDEXES_SQL;
            }
            break;
          case "kill":
            if (!target) {
              throw new QueryError("Target SPID is required for kill operation", "mssql");
            }
            const spid = parseInt(target, 10);
            if (isNaN(spid)) {
              throw new QueryError("Invalid SPID for kill operation", "mssql");
            }
            sql = `KILL ${spid}`;
            break;
        }

        // Unsupported types leave sql empty and are rejected here; every supported
        // case above assigns a non-empty statement or throws before reaching this.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type: ${type}`, "mssql");
        }

        await this.pool!.request().query(sql);
        return { success: true };
      } catch (error) {
        throw mapDatabaseError(error, "mssql");
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
      total: this.pool.size,
      idle: this.pool.available,
      active: this.pool.size - this.pool.available,
      waiting: this.pool.pending,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    try {
      let version = "SQL Server";
      let uptime = "N/A";
      let startTime: Date | undefined;
      // Left UNDEFINED and spread conditionally into the return below, mirroring
      // getHealth() above: `DatabaseOverview.activeConnections` is optional for the
      // same reason, so a server whose session DMV was denied omits the figure
      // instead of publishing a fabricated 0. getHealth() does NOT compose from this
      // reading - it runs its own COUNT over the same DMV - and the agent's curated
      // `health` reading is getHealth() too (`method: "getHealth"` in
      // src/lib/agent/tools.ts; nothing under src/lib/agent reads getOverview()). This
      // count's readers are the monitoring Connections card, its trend chart and the
      // connection-threshold rating over them, so an initial 0 made a denial
      // indistinguishable from an idle instance for all three.
      // OverviewTab.tsx renders "N/A" over "not published" for the absence and drops
      // the sample from the connection trend; the 0 printed as the figure 0 on that
      // card and each refresh added a real 0 point to the trend. No percentage was
      // involved: the ceiling comes from the SAME statement, so a refused read left
      // maxConnections at its 0 initialiser and the card said "no limit published",
      // with no "/32767" and no bar. See docs/providers/mssql.md section 7.2.
      let activeConnections: number | undefined;
      // maxConnections stays a required number: 0 MEANS "no limit published" here,
      // so unlike the count above, 0 and absence are the SAME fact for the ceiling.
      let maxConnections = 0;
      // Left UNDEFINED and spread conditionally too, for the reason the count above is:
      // `DatabaseOverview.databaseSizeBytes` is optional because absence and zero are
      // different facts, and a `sys.database_files` read that does not answer says
      // nothing about the database's size. Unlike the count above this is NOT a
      // permission story - that view is database-scoped, so §7.2's server-level
      // refusal does not gate it, and no failure of this statement has been measured
      // on a live instance; whatever reaches the catch, the catch cannot name it.
      // StorageTab.tsx keys its whole breakdown off `databaseSizeBytes !== undefined`,
      // so the old `0` initialiser drew that breakdown over a database it never
      // measured, instead of "No storage size information available." - and drew it
      // against per-table bytes from getTableStats(), a separate read that does not
      // share this statement's failure, so the rows contradicted the total they were
      // shares of. `databaseSize` moves with the figure for the same reason: both
      // monitoring tabs render that string as the headline size, so a leftover
      // "0 bytes" printed a confident zero beside that message. "N/A" while the bytes
      // are unknown is the shape merged for libSQL (#569) and the search provider
      // (#517). See docs/providers/mssql.md section 7.3.
      let databaseSize = "N/A";
      let databaseSizeBytes: number | undefined;
      let tableCount = 0;
      let indexCount = 0;

      // Version
      try {
        const vRes = await this.pool!.request().query(`SELECT @@VERSION AS version`);
        version = String(vRes.recordset[0]?.version || "").split("\n")[0];
      } catch {
        /* ignore */
      }

      // Uptime
      try {
        const upRes = await this.pool!.request().query(OVERVIEW_UPTIME_SQL);
        if (upRes.recordset[0]) {
          const secs = Number(upRes.recordset[0].uptime_seconds || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          startTime = new Date(upRes.recordset[0].sqlserver_start_time);
        }
      } catch {
        /* ignore */
      }

      // Connections
      try {
        const connRes = await this.pool!.request().query(OVERVIEW_CONNECTIONS_SQL);
        // measuredNumber, not `|| 0`: an idle instance answers COUNT(*) = 0 and that
        // 0 is a reading, so the falsy test threw away the very figure it published.
        // Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(connRes.recordset[0]?.active_connections);
        maxConnections = Number(connRes.recordset[0]?.max_connections || 32767);
        if (maxConnections === 0) maxConnections = 32767; // 0 means unlimited
      } catch {
        /* The count stays absent, never 0, and the ceiling stays 0, which already
           reads as "no limit published". Which half of this statement refuses is
           version-dependent, and Microsoft documents only one of them plainly:
           sys.configurations requires membership in `public` on SQL Server 2019 and
           earlier but VIEW SERVER PERFORMANCE STATE on 2022 and later, so on 2022+ an
           ungranted login lands here on the ceiling lookup alone. sys.dm_exec_sessions
           is documented as row-filtered rather than refused - "Everyone can see their
           own session information", the server-state grant only widening that to ALL
           sessions - so on 2019 and earlier the same login may instead SUCCEED with a
           COUNT of its own session, an under-reading no guard here can see because
           nothing failed. That case is unmeasured and unfixed; see
           docs/providers/mssql.md section 7.2. */
      }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(OVERVIEW_DATABASE_SIZE_SQL);
        databaseSizeBytes = measuredNullableAggregate(sizeRes.recordset[0], "size_bytes");
        if (databaseSizeBytes !== undefined) databaseSize = formatBytes(databaseSizeBytes);
      } catch {
        /* The size stays absent, never 0, and `databaseSize` keeps the "N/A" it was
           initialised with. */
      }

      // Table/index counts
      try {
        const cntRes = await this.pool!.request().query(OVERVIEW_OBJECT_COUNTS_SQL);
        tableCount = Number(cntRes.recordset[0]?.table_count || 0);
        indexCount = Number(cntRes.recordset[0]?.index_count || 0);
      } catch {
        /* ignore */
      }

      return {
        version,
        uptime,
        startTime,
        ...(activeConnections === undefined ? {} : { activeConnections }),
        maxConnections,
        databaseSize,
        ...(databaseSizeBytes === undefined ? {} : { databaseSizeBytes }),
        tableCount,
        indexCount,
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      let cacheHitRatio: number | undefined;

      try {
        const cacheRes = await this.pool!.request().query(BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = measuredNumber(cacheRes.recordset[0]?.hit_ratio);
      } catch {
        /* DMV permissions; nothing was measured, so nothing is reported. */
      }

      return {
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        // bufferPoolUsage is gone rather than merely absent. It used to be assigned
        // `cacheHitRatio` itself - the same number under a second name, drawn and
        // rated as a separate gauge. SQL Server does publish pool occupancy, through
        // sys.dm_os_buffer_descriptors against max server memory, but this method
        // does not query it and that scan is not free; until it does there is nothing
        // here to report.
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      const res = await this.pool!.request().query(
        `SELECT TOP ${Math.max(1, Math.trunc(Number(limit)) || 1)} ${SLOW_QUERIES_BODY_SQL}`,
      );

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        queryId: String(r.query_id || ""),
        query: String(r.query || ""),
        calls: Number(r.calls || 0),
        totalTime: Number(r.total_time || 0),
        avgTime: Number(r.avg_time || 0),
        minTime: Number(r.min_time || 0),
        maxTime: Number(r.max_time || 0),
        rows: Number(r.row_cnt || 0),
        sharedBlksHit: Number(r.logical_reads || 0),
        sharedBlksRead: Number(r.physical_reads || 0),
      }));
    } catch {
      return [];
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    try {
      const res = await this.pool!.request().query(
        `SELECT TOP ${Math.max(1, Math.trunc(Number(limit)) || 1)} ${ACTIVE_SESSIONS_BODY_SQL}`,
      );

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        pid: Number(r.pid || 0),
        user: String(r.user || "unknown"),
        database: String(r.database || ""),
        applicationName: r.application_name ? String(r.application_name) : undefined,
        clientAddr: r.client_addr ? String(r.client_addr) : undefined,
        state: String(r.state || "unknown"),
        query: String(r.query || ""),
        queryStart: r.query_start ? new Date(String(r.query_start)) : undefined,
        duration: String(r.duration || "N/A"),
        durationMs: Number(r.duration_ms || 0),
        waitEventType: r.wait_type ? String(r.wait_type) : undefined,
        waitEvent: r.last_wait_type ? String(r.last_wait_type) : undefined,
        blocked: Boolean(r.is_blocked),
      }));
    } catch {
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(TABLE_STATS_SQL);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const tableSizeBytes = Number(r.table_size_bytes || 0);
        const indexSizeBytes = Number(r.index_size_bytes || 0);
        const totalSizeBytes = Number(r.total_size_bytes || 0);
        return {
          schemaName: String(r.schema_name || "dbo"),
          tableName: String(r.table_name || ""),
          rowCount: Number(r.row_count || 0),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          totalSize: formatBytes(totalSizeBytes),
          totalSizeBytes,
          lastAnalyze: r.last_stats_update ? new Date(String(r.last_stats_update)) : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(INDEX_STATS_SQL);

      // Get columns for each index
      const colRes = await this.pool!.request().query(INDEX_COLUMNS_SQL);

      const colMap = new Map<string, string[]>();
      for (const c of colRes.recordset || []) {
        const key = `${c.schema_name}.${c.table_name}.${c.index_name}`;
        if (!colMap.has(key)) colMap.set(key, []);
        colMap.get(key)!.push(String(c.column_name));
      }

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const key = `${r.schema_name}.${r.table_name}.${r.index_name}`;
        const idxSizeBytes = Number(r.index_size_bytes || 0);
        return {
          schemaName: String(r.schema_name || "dbo"),
          tableName: String(r.table_name || ""),
          indexName: String(r.index_name || ""),
          indexType: String(r.index_type || ""),
          columns: colMap.get(key) || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary_key),
          indexSize: formatBytes(idxSizeBytes),
          indexSizeBytes: idxSizeBytes,
          scans: Number(r.scans || 0),
        };
      });
    } catch {
      return [];
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(STORAGE_STATS_SQL);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const sizeBytes = Number(r.size_bytes || 0);
        return {
          name: String(r.name || ""),
          location: String(r.location || ""),
          size: formatBytes(sizeBytes),
          sizeBytes,
        };
      });
    } catch {
      return [];
    }
  }
}
