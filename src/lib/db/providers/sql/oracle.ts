/**
 * Oracle Database Provider
 * Full Oracle support with connection pooling (Thin mode - no Instant Client needed)
 */

import oracledb from "oracledb";
import { SQLBaseProvider } from "./sql-base";
import { oracleColumnTypes } from "./column-types";
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
  type ContainerLevelSpec,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type ObjectSourceDocument,
  type ObjectSourcePart,
  type ColumnSchema,
  type IndexSchema,
  type ForeignKeySchema,
} from "../../types";
import {
  applySourceBound,
  assertObjectPathShape,
  type ObjectPathShapeEngine,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
} from "../../object-kinds";
import { comparePaths } from "../../object-path";
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
  describeOracleClientLoadFailure,
} from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { measuredNullableAggregate } from "../../utils/measured-aggregate";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in mssql.ts).

// Shared by getHealth() and getPerformanceMetrics().
const CACHE_HIT_RATIO_SQL = `SELECT ROUND(
            (1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
                  NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0)
            )) * 100, 2) AS HIT_RATIO
           FROM V$SYSSTAT
           WHERE NAME IN ('db block gets', 'consistent gets', 'physical reads')`;

const HEALTH_SLOW_QUERIES_SQL = `SELECT * FROM (
            SELECT SUBSTR(SQL_TEXT, 1, 100) AS QUERY,
                   EXECUTIONS AS CALLS,
                   ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) || 'ms' AS AVGTIME
            FROM V$SQL
            WHERE EXECUTIONS > 0
            ORDER BY ELAPSED_TIME DESC
          ) WHERE ROWNUM <= 5`;

const HEALTH_ACTIVE_SESSIONS_SQL = `SELECT * FROM (
            SELECT SID, USERNAME, STATUS, SUBSTR(NVL(SQL_ID, ''), 1, 100) AS QUERY,
                   SCHEMANAME AS "DATABASE",
                   NVL(TO_CHAR(LOGON_TIME, 'HH24:MI:SS'), 'N/A') AS DURATION
            FROM V$SESSION
            WHERE TYPE = 'USER' AND STATUS = 'ACTIVE'
            ORDER BY LOGON_TIME DESC
          ) WHERE ROWNUM <= 10`;

const OVERVIEW_OBJECT_COUNTS_SQL = `SELECT
            (SELECT COUNT(*) FROM USER_TABLES) AS TABLE_COUNT,
            (SELECT COUNT(*) FROM USER_INDEXES) AS INDEX_COUNT
           FROM DUAL`;

// Interpolated before " WHERE ROWNUM <= <limit>" in getSlowQueries().
const SLOW_QUERIES_BODY_SQL = `SELECT * FROM (
          SELECT SQL_ID AS QUERY_ID,
                 SUBSTR(SQL_TEXT, 1, 500) AS QUERY,
                 EXECUTIONS AS CALLS,
                 ROUND(ELAPSED_TIME / 1000, 2) AS TOTAL_TIME,
                 ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) AS AVG_TIME,
                 ROWS_PROCESSED AS ROW_CNT,
                 BUFFER_GETS AS BUF_GETS,
                 DISK_READS
          FROM V$SQL
          WHERE EXECUTIONS > 0
          ORDER BY ELAPSED_TIME DESC
        )`;

// Interpolated before " WHERE ROWNUM <= <limit>" in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `SELECT * FROM (
          SELECT s.SID, s.SERIAL#, s.USERNAME, s.SCHEMANAME, s.PROGRAM,
                 s.MACHINE, s.STATUS, s.SQL_ID,
                 SUBSTR(sq.SQL_TEXT, 1, 500) AS QUERY,
                 s.LOGON_TIME,
                 ROUND((SYSDATE - s.LOGON_TIME) * 86400) AS DURATION_SECS,
                 s.WAIT_CLASS, s.EVENT
          FROM V$SESSION s
          LEFT JOIN V$SQL sq ON s.SQL_ID = sq.SQL_ID AND s.SQL_CHILD_NUMBER = sq.CHILD_NUMBER
          WHERE s.TYPE = 'USER'
          ORDER BY CASE s.STATUS WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.LOGON_TIME DESC
        )`;

const TABLE_STATS_SQL = `SELECT t.TABLE_NAME,
                NVL(t.NUM_ROWS, 0) AS ROW_COUNT,
                NVL(s.BYTES, 0) AS TABLE_SIZE_BYTES,
                NVL(idx_size.BYTES, 0) AS INDEX_SIZE_BYTES,
                t.LAST_ANALYZED
         FROM ALL_TABLES t
         LEFT JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = t.TABLE_NAME AND s.SEGMENT_TYPE = 'TABLE'
         LEFT JOIN (
           SELECT TABLE_NAME, SUM(BYTES) AS BYTES
           FROM USER_SEGMENTS
           WHERE SEGMENT_TYPE = 'INDEX'
           GROUP BY TABLE_NAME
         ) idx_size ON idx_size.TABLE_NAME = t.TABLE_NAME
         WHERE t.OWNER = :1
         ORDER BY NVL(s.BYTES, 0) DESC`;

const INDEX_STATS_SQL = `SELECT ai.TABLE_NAME, ai.INDEX_NAME, ai.INDEX_TYPE, ai.UNIQUENESS,
                NVL(us.BYTES, 0) AS INDEX_SIZE_BYTES,
                ai.LEAF_BLOCKS, ai.DISTINCT_KEYS
         FROM ALL_INDEXES ai
         LEFT JOIN USER_SEGMENTS us ON us.SEGMENT_NAME = ai.INDEX_NAME AND us.SEGMENT_TYPE = 'INDEX'
         WHERE ai.OWNER = :1
         ORDER BY NVL(us.BYTES, 0) DESC`;

const INDEX_COLUMNS_SQL = `SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION
         FROM ALL_IND_COLUMNS WHERE INDEX_OWNER = :1
         ORDER BY INDEX_NAME, COLUMN_POSITION`;

const STORAGE_DBA_FILES_SQL = `SELECT TABLESPACE_NAME AS NAME,
                  SUM(BYTES) AS SIZE_BYTES
           FROM DBA_DATA_FILES
           GROUP BY TABLESPACE_NAME
           ORDER BY SUM(BYTES) DESC`;

const STORAGE_USER_SEGMENTS_SQL = `SELECT TABLESPACE_NAME AS NAME,
                    SUM(BYTES) AS SIZE_BYTES
             FROM USER_SEGMENTS
             GROUP BY TABLESPACE_NAME
             ORDER BY SUM(BYTES) DESC`;

/**
 * The indexes ONE table owns, for the `optimize` operation.
 *
 * `INDEX_TYPE = 'NORMAL'` is the filter the whole-schema form has always used, and it
 * is the one `ALTER INDEX ... REBUILD` can take: it excludes LOB and domain indexes,
 * which answer ORA-22864 / ORA-29868 to a rebuild, while keeping the B-tree indexes
 * that back UNIQUE and PRIMARY KEY constraints, which rebuild normally.
 */
const TABLE_INDEXES_SQL = `SELECT INDEX_NAME
           FROM USER_INDEXES
           WHERE TABLE_NAME = :tableName AND INDEX_TYPE = 'NORMAL'`;

const SCHEMA_NORMAL_INDEXES_SQL = `SELECT INDEX_NAME FROM USER_INDEXES WHERE INDEX_TYPE = 'NORMAL'`;

/**
 * Whether the schema owns a table by exactly this name - asked only to tell the two
 * causes of an empty `TABLE_INDEXES_SQL` answer apart.
 *
 * `USER_TABLES` is the right catalog and not a narrower one: measured on
 * ldb-oracle-r5 on 2026-08-25, a MATERIALIZED VIEW's container appears here under the
 * view's own name (and its indexes appear in `USER_INDEXES` keyed to that name), so
 * everything `USER_INDEXES` can be keyed to is visible. A plain VIEW is NOT here, and
 * that is the honest answer for it: a view owns no index, so there is nothing for
 * "Rebuild Indexes" to have done.
 */
const TABLE_IS_KNOWN_SQL = `SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME = :tableName`;

// ============================================================================
// Owner-aware twins (#772)
// ----------------------------------------------------------------------------
// The `USER_*` views above answer for the CONNECTED user only, which is why a table
// owned by anyone else read as "this schema owns no TABLE named ...". `ALL_*` carries
// an OWNER column, so the same questions are asked with the owner bound. Kept as
// separate statements rather than adding an `OR :owner IS NULL` to the originals: a
// predicate that switches off is a predicate the optimizer cannot plan around, and the
// two call shapes want different proofs.
// ============================================================================
const OWNED_TABLE_INDEXES_SQL = `SELECT INDEX_NAME
           FROM ALL_INDEXES
           WHERE OWNER = :owner AND TABLE_NAME = :tableName AND INDEX_TYPE = 'NORMAL'`;

const OWNED_SCHEMA_NORMAL_INDEXES_SQL = `SELECT INDEX_NAME
           FROM ALL_INDEXES
           WHERE OWNER = :owner AND INDEX_TYPE = 'NORMAL'`;

const OWNED_TABLE_IS_KNOWN_SQL = `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :owner AND TABLE_NAME = :tableName`;

// ============================================================================
// Object surface SQL (#789)
// ----------------------------------------------------------------------------
// Hoisted to module scope for the same coverage reason as the schema SQL above.
// ============================================================================

/**
 * Oracle's dictionary speaks two vocabularies for the same object kinds, and they are not
 * interchangeable. `ALL_OBJECTS.OBJECT_TYPE` writes them with spaces; the `object_type`
 * argument `DBMS_METADATA.GET_DDL` takes writes them with underscores and sometimes with
 * a different word. Phase 2 reads the second column; Phase 1 reads the first, and the
 * table is written once here so the two never drift.
 *
 * One entry per declared kind, and the count statement's IN list and every listing's
 * bound type are both built from it, so a kind added to `objectKinds` without an entry
 * here fails loudly instead of drawing a folder nothing can fill.
 *
 * ONE value here is read by nothing, and it is written down so a maintainer does not edit
 * it expecting an effect: `package.metadata`. A package's source is read as TWO parts
 * through `PACKAGE_SPEC` and `PACKAGE_BODY`, which `ORACLE_SOURCE_PART_PLANS` owns, so the
 * bare `PACKAGE` metadata spelling is never bound anywhere. MEASURED: changing it to a
 * nonsense value fails no test in `tests/integration/db/oracle-provider.test.ts`, while
 * changing either spelling in the plans fails three or four (#789). It stays in the table
 * because the record is per kind and a hole in it would read as an oversight.
 */
const ORACLE_OBJECT_TYPES: Record<string, { dictionary: string; metadata: string }> = {
  table: { dictionary: "TABLE", metadata: "TABLE" },
  view: { dictionary: "VIEW", metadata: "VIEW" },
  materialized_view: { dictionary: "MATERIALIZED VIEW", metadata: "MATERIALIZED_VIEW" },
  synonym: { dictionary: "SYNONYM", metadata: "SYNONYM" },
  sequence: { dictionary: "SEQUENCE", metadata: "SEQUENCE" },
  package: { dictionary: "PACKAGE", metadata: "PACKAGE" },
  procedure: { dictionary: "PROCEDURE", metadata: "PROCEDURE" },
  function: { dictionary: "FUNCTION", metadata: "FUNCTION" },
  trigger: { dictionary: "TRIGGER", metadata: "TRIGGER" },
};

/**
 * The body's own two spellings, kept beside the table above rather than in it.
 *
 * A package body is NOT a kind: it is the second dictionary row of the one `package`
 * node, so putting it in `ORACLE_OBJECT_TYPES` would add it to the count statement's IN
 * list and report every package twice. It is also the sharpest example of the two
 * vocabularies disagreeing, which is why it is written down at all.
 */
const PACKAGE_BODY_OBJECT_TYPE = { dictionary: "PACKAGE BODY", metadata: "PACKAGE_BODY" };

/**
 * The source declaration every Oracle kind carries, written once (#789 Phase 2).
 *
 * ALL NINE declared kinds have a definition text, and that is a fact about Oracle rather
 * than a convenience: `DBMS_METADATA.GET_DDL` answers a runnable CREATE statement for every
 * metadata type in `ORACLE_OBJECT_TYPES` above, including the three kinds no other engine in
 * this fleet publishes text for (a synonym, a sequence and a materialized view). So there is
 * no "declares nothing" list for this provider, and the integration suite asserts that
 * emptiness in both directions so a tenth kind cannot quietly gain a Source tab.
 *
 * `sql` and NOT `plsql`. MEASURED on the installed monaco-editor 0.56.0: `plsql` is not
 * among the 89 language ids the bundle registers, and an unregistered id degrades to plain
 * text SILENTLY, with no throw and nothing observable. A PL/SQL body therefore renders under
 * the SQL grammar, which highlights the DML and misses `IS`/`BEGIN`/`EXCEPTION`. That is a
 * limitation this provider states rather than hides; `docs/providers/oracle.md` carries it.
 *
 * One constant rather than nine copies, so a kind cannot be added with a different language
 * id by accident. It is spread into each declaration, so every kind still states it.
 */
const ORACLE_SOURCE_DECLARATION = { hasSource: true, sourceLanguage: "sql" } as const;

/**
 * The one dictionary spelling a statement needs inside its TEXT rather than as a bind.
 *
 * Two predicates name a type that is not the type being asked for: the materialized-view
 * container rule in `COUNTS_SQL` and in `LIST_TABLES_SQL`. Derived from the table above so
 * it cannot drift from the spelling every other read binds.
 */
const MATERIALIZED_VIEW_TYPE = ORACLE_OBJECT_TYPES.materialized_view.dictionary;

/** The kind id each dictionary spelling answers for. Built from the table, never typed twice. */
const KIND_BY_DICTIONARY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ORACLE_OBJECT_TYPES).map(([kind, type]) => [type.dictionary, kind]),
);

/** Every counted dictionary spelling as a SQL literal list. Derived, so it cannot drift. */
const COUNTED_OBJECT_TYPES = Object.values(ORACLE_OBJECT_TYPES)
  .map((type) => `'${type.dictionary}'`)
  .join(", ");

/**
 * The owners this connection can see, which on Oracle is the whole container list.
 *
 * This is the read that ends Oracle's single-schema confinement (#765). Every other
 * dictionary read in this file is scoped to `OWNER = <connecting user>`, which is why the
 * app showed exactly one schema with no way to reach another; this one is bound to
 * nothing at all.
 *
 * `ORACLE_MAINTAINED` is the dictionary's own answer to "is this schema Oracle's", so no
 * name denylist is needed and none is kept: measured on Oracle Database 21c XE, 29 of the
 * 33 rows in `ALL_USERS` are Oracle's own, and a hand-written exclusion list would be
 * wrong on the next release. `SYS_CONTEXT('USERENV','SESSION_USER')` is asked twice for
 * two different reasons: it marks the session's own owner, and it keeps that owner in the
 * list even when Oracle maintains it, so connecting as SYSTEM does not hide SYSTEM.
 *
 * It is also Oracle's own answer for who is connected rather than `connection.user`,
 * which is right under external authentication and right for an owner created with a
 * quoted lower-case name.
 */
const CONTAINERS_SQL = `SELECT USERNAME AS NAME,
                CASE WHEN USERNAME = SYS_CONTEXT('USERENV','SESSION_USER') THEN 1 ELSE 0 END AS IS_SESSION_DEFAULT
         FROM ALL_USERS
         WHERE ORACLE_MAINTAINED = 'N' OR USERNAME = SYS_CONTEXT('USERENV','SESSION_USER')
         ORDER BY USERNAME`;

/**
 * The same read with the filter dropped, for a server that has no `ORACLE_MAINTAINED`.
 *
 * That column arrived in Oracle Database 12.1. Thin mode refuses anything older with
 * NJS-138, but Thick mode is an explicit opt-in for exactly those servers
 * (`ORACLE_CLIENT_LIB_DIR`), so an 11.2 instance answering ORA-00904 here is a supported
 * configuration. Losing the filter costs a long container list; losing the container list
 * costs the whole tree.
 */
const CONTAINERS_SQL_WITHOUT_ORACLE_MAINTAINED = `SELECT USERNAME AS NAME,
                CASE WHEN USERNAME = SYS_CONTEXT('USERENV','SESSION_USER') THEN 1 ELSE 0 END AS IS_SESSION_DEFAULT
         FROM ALL_USERS
         ORDER BY USERNAME`;

/**
 * One statement, one pass over `ALL_OBJECTS`, one round trip for the whole folder row.
 *
 * This is what #765 is: the five bulk `ALL_*` reads `getSchema()` issues on connect
 * materialise every column, index and constraint of the owner before the UI can paint,
 * and the reporter's PeopleSoft instance holds 43,512 tables, 910,000 columns, 49,800
 * indexes and 633,000 constraints. This statement reads no column of any table.
 *
 * `PACKAGE BODY` is deliberately absent from `COUNTED_OBJECT_TYPES`: a body is not a
 * separate tree node, so counting it would double the Packages badge.
 *
 * The `MV_TWIN` window is the other half of the same honesty. Measured on 21c XE,
 * `CREATE MATERIALIZED VIEW app_revenue_mv` writes TWO rows into `ALL_OBJECTS`: the
 * materialized view and a `TABLE` of the same name for its container, with
 * `GENERATED = 'N'` on both, so nothing about the table row says it is not a table an
 * owner created. Left in, an owner with 100 materialized views reports 100 tables nobody
 * wrote, and each one opens onto the materialized view's own columns.
 *
 * The rule needs no second dictionary view, and that is measured rather than assumed: a
 * table and a materialized view cannot share a name in one owner, because they share
 * Oracle's schema-object namespace (`CREATE TABLE app.app_revenue_mv` answered ORA-00955),
 * so a same-named pair is always the container. Reading `ALL_MVIEWS` instead would answer
 * the same and cost more: measured against the 15,636-object `SYS` owner on 21c XE, this
 * window form takes 10,385 consistent gets and a correlated `NOT EXISTS` over
 * `ALL_OBJECTS` takes 18,285 for the identical answer.
 */
const COUNTS_SQL = `SELECT KIND, COUNT(*) AS N
         FROM (
           SELECT o.OBJECT_TYPE AS KIND,
                  COUNT(CASE WHEN o.OBJECT_TYPE = '${MATERIALIZED_VIEW_TYPE}' THEN 1 END)
                    OVER (PARTITION BY o.OBJECT_NAME) AS MV_TWIN
           FROM ALL_OBJECTS o
           WHERE o.OWNER = :1 AND o.OBJECT_TYPE IN (${COUNTED_OBJECT_TYPES})
         )
         WHERE NOT (KIND = 'TABLE' AND MV_TWIN > 0)
         GROUP BY KIND`;

/**
 * One kind's objects, addressed by the dictionary spelling the caller's kind maps to.
 *
 * The type is BOUND rather than interpolated, so nothing a caller supplied ever reaches
 * the statement text: an unknown kind has no entry in `ORACLE_OBJECT_TYPES` and never
 * gets this far.
 *
 * `STATUS` is `ALL_OBJECTS`'s VALID / INVALID, and every kind carries it for that reason.
 * `ALL_TRIGGERS.STATUS` says ENABLED / DISABLED instead, which is a different fact about
 * a different thing, so the trigger listing below joins back to `ALL_OBJECTS` rather than
 * putting two vocabularies in one field.
 */
const LIST_BY_TYPE_SQL = `SELECT OBJECT_NAME AS NAME, STATUS
         FROM ALL_OBJECTS
         WHERE OWNER = :1 AND OBJECT_TYPE = :2`;

/** The same read, minus the container tables `COUNTS_SQL`'s `MV_TWIN` window drops. */
const LIST_TABLES_SQL = `SELECT o.OBJECT_NAME AS NAME, o.STATUS
         FROM ALL_OBJECTS o
         WHERE o.OWNER = :1 AND o.OBJECT_TYPE = :2
           AND NOT EXISTS (
             SELECT 1 FROM ALL_OBJECTS m
             WHERE m.OWNER = o.OWNER AND m.OBJECT_NAME = o.OBJECT_NAME
               AND m.OBJECT_TYPE = '${MATERIALIZED_VIEW_TYPE}'
           )`;

/**
 * A package's two dictionary rows, read together so they can be collapsed into one node.
 *
 * Oracle stores a specification and a body as separate objects with separate statuses,
 * and a user wrote one package. Both rows come back and `collapsePackages()` merges them.
 */
const LIST_PACKAGES_SQL = `SELECT OBJECT_NAME AS NAME, OBJECT_TYPE, STATUS
         FROM ALL_OBJECTS
         WHERE OWNER = :1 AND OBJECT_TYPE IN (:2, :3)`;

/**
 * The owner's triggers, each with the object it fires on.
 *
 * `ALL_OBJECTS` is the SPINE and `ALL_TRIGGERS` is OUTER joined, which is the whole point
 * of this statement's shape rather than a stylistic choice. `countObjects` counts triggers
 * from `ALL_OBJECTS`, and standing ruling 5f (#789) requires this listing to contain
 * exactly what that count counted. The two views do not expose the same population:
 * `ALL_OBJECTS` answers by privilege on the OBJECT, while `ALL_TRIGGERS` also answers by
 * accessibility of the BASE TABLE. Driving the listing from `ALL_TRIGGERS` with an inner
 * join therefore drops triggers the badge has already counted, and on somebody else's
 * owner - exactly the case this task unlocks - the badge says 3 and the folder opens with
 * fewer.
 *
 * So `ALL_TRIGGERS` supplies one thing, the parent segment, and a missing row there costs
 * that segment rather than the object. `TABLE_NAME` is the parent and not decoration,
 * which is what the `attachedTo: "table"` declaration states, and it arrives NULL for two
 * different reasons that are deliberately indistinguishable here: a SCHEMA or DATABASE
 * trigger has no base object at all (measured on 21c XE, `AFTER LOGON ON SCHEMA` leaves
 * `TABLE_NAME` NULL), and a trigger whose base table this user cannot see has no row to
 * read one from. Both hang off the container, which ruling 5f allows.
 *
 * `TABLE_OWNER` can differ from `OWNER`: a trigger APP owns on REPORTING's table is real
 * and is listed here, in APP's container, because APP is what owns it.
 *
 * `STATUS` stays `ALL_OBJECTS`'s VALID / INVALID, the same fact every other kind carries.
 * `ALL_TRIGGERS.STATUS` says ENABLED / DISABLED, which is a different fact about a
 * different thing. The outer join cannot multiply rows: a trigger name is unique within
 * its owner, so `ALL_TRIGGERS` holds at most one row per (OWNER, TRIGGER_NAME).
 */
const LIST_TRIGGERS_SQL = `SELECT o.OBJECT_NAME AS NAME, t.TABLE_NAME AS PARENT, o.STATUS
         FROM ALL_OBJECTS o
         LEFT JOIN ALL_TRIGGERS t
           ON t.OWNER = o.OWNER AND t.TRIGGER_NAME = o.OBJECT_NAME
         WHERE o.OWNER = :1 AND o.OBJECT_TYPE = :2`;

// ----------------------------------------------------------------------------
// One object's detail. Four narrow reads, each bound to ONE owner and ONE object.
//
// The four `SCHEMA_*_SQL` statements above are the same dictionary views scoped to the
// owner alone, which is the read #765 is about: on the reporter's instance the columns
// query alone answers 910,000 rows. These four answer for one object, and their `:2` is
// what makes that true.
// ----------------------------------------------------------------------------

/** Columns. Answers for a table, a view and a materialized view's container alike. */
const OBJECT_COLUMNS_SQL = `SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT
         FROM ALL_TAB_COLUMNS
         WHERE OWNER = :1 AND TABLE_NAME = :2
         ORDER BY COLUMN_ID`;

const OBJECT_PRIMARY_KEY_SQL = `SELECT acc.COLUMN_NAME
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         WHERE ac.OWNER = :1 AND ac.TABLE_NAME = :2 AND ac.CONSTRAINT_TYPE = 'P'`;

/**
 * Foreign keys, paired column by column.
 *
 * `rcc.POSITION = acc.POSITION` is load-bearing and is what `SCHEMA_FOREIGN_KEYS_SQL`
 * lacks: without it a two-column foreign key joins every referencing column to every
 * referenced one and reports four pairs for two.
 */
const OBJECT_FOREIGN_KEYS_SQL = `SELECT acc.COLUMN_NAME,
                rc.OWNER AS REF_OWNER,
                rc.TABLE_NAME AS REF_TABLE,
                rcc.COLUMN_NAME AS REF_COLUMN
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         JOIN ALL_CONSTRAINTS rc ON ac.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND ac.R_OWNER = rc.OWNER
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
                AND rcc.POSITION = acc.POSITION
         WHERE ac.OWNER = :1 AND ac.TABLE_NAME = :2 AND ac.CONSTRAINT_TYPE = 'R'`;

/**
 * Indexes, keyed by the TABLE's owner rather than the index's.
 *
 * `SCHEMA_INDEXES_SQL` keys `ai.OWNER`, which answers a different question: an index one
 * user owns on another user's table belongs to the table when a person is looking at the
 * table, and an index this owner holds on somebody else's table does not.
 */
const OBJECT_INDEXES_SQL = `SELECT ai.INDEX_NAME, ai.UNIQUENESS, aic.COLUMN_NAME
         FROM ALL_INDEXES ai
         JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.OWNER = aic.INDEX_OWNER
         WHERE ai.TABLE_OWNER = :1 AND ai.TABLE_NAME = :2
         ORDER BY ai.INDEX_NAME, aic.COLUMN_POSITION`;

// ----------------------------------------------------------------------------
// Every object of one kind, described together (#789)
//
// FIVE statements for a whole folder rather than four per object. They share one
// `described` CTE, which is the target set, and each detail read joins it by NAME - the
// only key Oracle's ALL_TAB_* views carry, since none of them publishes an OBJECT_ID. That
// join is safe here for a measured reason: tables, views, materialized views, synonyms,
// sequences, packages, procedures and functions share ONE namespace inside an owner (a
// second CREATE answers ORA-00955), so a name identifies at most one of them.
// ----------------------------------------------------------------------------

/**
 * The objects one bulk read describes, ordered and cut only when the caller bounded it.
 *
 * The predicate is the LISTING's, per kind, which is what keeps the two answers over the
 * same objects: `table` carries the materialized-view container rule `LIST_TABLES_SQL`
 * carries, because `CREATE MATERIALIZED VIEW` writes a TABLE row of the same name for its
 * container and describing that row as a table would describe an object no folder shows.
 *
 * `FETCH FIRST :3 ROWS ONLY` is the bound, and `ROWNUM` is deliberately NOT used: ROWNUM is
 * assigned BEFORE the sort, so `WHERE ROWNUM <= n ORDER BY OBJECT_NAME` keeps an arbitrary
 * set and then orders it, while `ORDER BY ... FETCH FIRST` cuts the ordered set. The order
 * runs under the database's own `NLS_SORT`, so it is the SERVER's and not ours; it decides
 * WHICH objects a bound keeps and nothing else, because the answer is re-sorted by path
 * below and callers join on path rather than on position.
 *
 * The bind is positional, so `:1` is the owner, `:2` the dictionary spelling and, when the
 * read is bounded, `:3` the bound.
 *
 * A repeated `:1` would NOT work, and that is measured rather than reasoned: oracledb maps a
 * bind ARRAY by the order the placeholders appear, not by the number they carry, so the
 * detail reads below - which name the owner a second time for their own join - answer
 * `NJS-098: 3 bind placeholders were used in the SQL statement but 2 bind values were
 * provided` if that second reference reuses `:1`. Each detail statement therefore closes with
 * the next free number and its bind array repeats the owner. The unit suite could not see
 * this: its fake dispatches on statement text and never counted the binds (standing ruling
 * 5b), so it was found against a live 21c XE and is pinned by an argument assertion now.
 */
/**
 * ONE object's definition text, as Oracle's own metadata API writes it (#789 Phase 2).
 *
 * `DBMS_METADATA.GET_DDL` takes the metadata-vocabulary type, the object name and the owner,
 * all three as BINDS, so nothing on this path is interpolated into statement text and no
 * identifier escaper is involved. That is worth stating because the source route is the first
 * place in the object surface where a caller-supplied name reaches a read on some engines; on
 * Oracle it does not reach statement text at all.
 *
 * `FROM DUAL` rather than a PL/SQL block, because the value has to come back as a column the
 * driver can apply `lobFetchTypeHandler` to. GET_DDL answers a CLOB and the object surface's
 * ordinary reader passes no fetch handler, so this read has its own execute.
 */
const OBJECT_DDL_SQL = `SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) AS DDL FROM DUAL`;

/**
 * The SECOND question ORA-31603 forces, and `ALL_OBJECTS` by name (#789, ruling C).
 *
 * ORA-31603's documented cause is "The specified object was not found in the database", and
 * Oracle raises it for an object the caller merely LACKS PRIVILEGE on. #765 made the tree list
 * every owner, so reading another schema's object is the ORDINARY path here rather than an
 * edge case, and shipping that sentence unqualified would tell a user their objects are gone.
 *
 * `ALL_OBJECTS` and never `DBA_OBJECTS`. `ALL_OBJECTS` is privilege-filtered, so it answers
 * "can THIS caller see it", which is the question being asked. `DBA_OBJECTS` would answer
 * "does it exist anywhere", turning this disambiguation into a cross-schema existence oracle
 * over objects the caller has no grant on at all, and it needs a catalog role most callers do
 * not hold, so it would also fail for the very sessions this path exists to serve.
 *
 * The type is bound in the DICTIONARY vocabulary (`MATERIALIZED VIEW`, `PACKAGE BODY`), which
 * is the column `ALL_OBJECTS` publishes, and not the metadata vocabulary GET_DDL takes. The
 * two spellings are the reason `ORACLE_OBJECT_TYPES` carries both.
 */
const OBJECT_IS_VISIBLE_SQL = `SELECT 1 AS SEEN FROM ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE = :3`;

/**
 * The wrap format marker a wrapped unit's second physical line carries.
 *
 * MEASURED on Oracle XE 21.3.0.0.0 (probe 7, #789): `a000000`. The pattern is deliberately
 * wider than that one literal, because the marker names the ENCODER's format version and a
 * later Oracle writes a different letter or number there; pinning the literal would report
 * every future release's wrapped unit as plain text.
 */
const WRAP_FORMAT_MARKER = /^[a-z][0-9]{6}$/;

/**
 * One object's name as `DBMS_METADATA` writes it into a `GET_DDL` header.
 *
 * Both parts are always quoted and an embedded quote is doubled, which is Oracle's own
 * identifier quoting. This string is NEVER sent to the server: it is built only to find the
 * closing quote of the name inside text the server already returned, which is why the
 * doubling here is a READ rule rather than an escaper.
 */
function quotedMetadataName(owner: string, name: string): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return `${quote(owner)}.${quote(name)}`;
}

/**
 * The wrap format marker this `GET_DDL` text carries, or `undefined` when it is not wrapped.
 *
 * THE RULE, established by probe 7 on Oracle XE 21.3.0.0.0 (#789) and documented nowhere
 * Oracle publishes: a unit is wrapped if and only if the token immediately following the
 * CLOSING DOUBLE QUOTE of its quoted name is the bare keyword `wrapped`, case-insensitive,
 * AND the next physical line is the wrap format marker.
 *
 * The rule is a POSITION and not a text search, and that distinction is the whole of it. The
 * fixture commits three plain, COMPILING functions built to defeat the naive textual rule:
 * `APP_FIRST_LINE_WRAPPED` ends its first source line with the word `wrapped`,
 * `APP_SECOND_LINE_MARKER` has exactly `a000000` on its second line, and `APP_CONJ_DEFEATER`
 * does both at once. All three fail here, because `GET_DDL` writes the object name inside
 * double quotes and what follows it is decided by the PARSER: a plain unit admits only `(`, a
 * RETURN clause, IS or AS in that position, and `APP_ZERO_ARG` is the fixture's control for
 * the closest plain shape there is, a zero-argument function whose token there is `return`.
 *
 * The name is located by the exact quoted spelling rather than by `lastIndexOf('"')`, because
 * a plain unit's header can carry a later double quote of its own (a quoted default, a quoted
 * type name) and the last quote in the line is then not the name's.
 *
 * A SECOND independent signal exists and is deliberately NOT used: `ALL_SOURCE` holds a whole
 * wrapped unit in ONE row with embedded newlines where a plain unit is one row per line, and
 * that shape is not forgeable from source text at all. It is not used because it costs a
 * second round trip on every PL/SQL read, it answers nothing for the five kinds that are not
 * PL/SQL, and the header predicate survived the three units built to break it. It is written
 * down in `docs/providers/oracle.md` so a future defect in this predicate has a measured
 * alternative rather than a research problem.
 *
 * The MARKER is returned rather than a bare boolean, so the refusal sentence can quote
 * ORACLE'S OWN TOKEN back to the reader instead of this file's idea of what it should be. A
 * refusal that names `a000000` when the server wrote something else would be this product
 * describing the engine rather than reporting it.
 */
function wrapFormatMarker(ddl: string, owner: string, name: string): string | undefined {
  const quoted = quotedMetadataName(owner, name);
  const at = ddl.indexOf(quoted);
  if (at < 0) return undefined;
  const rest = ddl.slice(at + quoted.length);
  const firstBreak = rest.indexOf("\n");
  if (firstBreak < 0) return undefined;
  // The whole REMAINDER of the header line, trimmed, and not a `startsWith` or an `endsWith`:
  // `wrapped` has to be the ONLY thing left on that line, which is what "the token
  // immediately following" means and what every one of the three defeaters fails.
  if (rest.slice(0, firstBreak).trim().toLowerCase() !== "wrapped") return undefined;
  const after = rest.slice(firstBreak + 1);
  const secondBreak = after.indexOf("\n");
  const marker = (secondBreak < 0 ? after : after.slice(0, secondBreak)).trim();
  return WRAP_FORMAT_MARKER.test(marker) ? marker : undefined;
}

/**
 * Whether this driver error is Oracle reporting the object as not found (#789, ruling C).
 *
 * ORA-31603 is the ONE code this path treats specially. Every other failure, including
 * ORA-31600 for a metadata type this provider spelled wrongly, goes through
 * `mapDatabaseError` and raises, because only this one code is ambiguous between an absence
 * and a refusal.
 *
 * THE NUMBER DECIDES, NOT THE SENTENCE. node-oracledb carries the Oracle error number as a
 * NUMERIC `errorNum` on the error it rejects with, in both modes: thin assigns it in
 * `lib/thin/protocol/protocol.js` (`err.errorNum = message.errorInfo.num`) and every prebuilt
 * thick addon in `build/Release` exports the same property name (checked with
 * `strings oracledb-6.10.0-linux-x64.node | grep -x errorNum`), both against oracledb 6.10.0.
 * Scanning the MESSAGE for "ORA-31603" is the defect class this repository keeps finding
 * under other names: a backtrace frame, an object name or a wrapped error quoting that text
 * makes a read that failed for an unrelated reason look like a missing object, and the answer
 * is then a refusal part or a raise about the wrong fact. An error carrying a DIFFERENT
 * number is refused here even when its text quotes this code.
 *
 * The text scan survives as the arm for an error carrying NO numeric `errorNum` at all, which
 * is what a rejection composed outside the driver looks like, and it is asked second.
 */
function isObjectNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errorNum = (error as Error & { errorNum?: unknown }).errorNum;
  if (typeof errorNum === "number") return errorNum === 31603;
  return error.message.includes("ORA-31603");
}

/**
 * The engine's own sentence for a refusal, with `DBMS_METADATA`'s internal backtrace dropped.
 *
 * MEASURED verbatim on Oracle XE 21.3.0.0.0 (#789). `GET_DDL('TABLE','REPORT_DAILY','REPORTING')`
 * as a caller holding only `SELECT` on that table raises a TEN-LINE message: one
 * `ORA-31603: object "REPORT_DAILY" of type TABLE not found in schema "REPORTING"` followed by
 * nine `ORA-06512: at "SYS.DBMS_METADATA", line 6781` frames. The first line is the error the
 * server raised ABOUT THIS OBJECT; the nine are a PL/SQL backtrace of line numbers inside
 * Oracle's own package, and they say nothing about the object at all.
 *
 * This is a SELECTION and never a rewrite, and the distinction is the whole point: not one word
 * of Oracle's is changed, reordered, paraphrased or prefixed, and what is dropped is a stack
 * trace of Oracle's internals. It matters because the refusal pane renders the engine's sentence
 * in full, and burying the disambiguation this provider appends under nine frames of
 * `SYS.DBMS_METADATA` line numbers would hide the one fact ruling C exists to put in front of a
 * reader: that their object is THERE and the read was refused.
 *
 * Only the ORA-31603 path is filtered. Every other failure is raised through `mapDatabaseError`
 * with its message untouched, because only this one code is ambiguous between an absence and a
 * refusal and only this one is composed for a reader rather than for a log.
 */
function oracleErrorSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const kept = message
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("ORA-06512:"))
    .join("\n")
    .trim();
  // An error that is NOTHING BUT a backtrace keeps its whole message rather than becoming an
  // empty refusal, because a refusal with no sentence a person can read is the one shape
  // `assertObjectSurface` refuses by name.
  return kept === "" ? message : kept;
}

/**
 * What one `GET_DDL` call answered: a text, the engine's refusal, or nothing at all.
 *
 * THREE outcomes and not two, because the caller does different things with the third. A
 * missing package BODY is an ABSENCE and emits no part at all, while a missing object at the
 * head of the document RAISES. Collapsing absence into a refusal would put "not found" in a
 * Source pane as this object's own reason, and collapsing it into a raise would take a
 * readable package specification away from a reader because nobody ever wrote its body.
 */
type OracleDefinitionRead =
  | { readonly outcome: "text"; readonly text: string }
  | { readonly outcome: "refused"; readonly unavailable: string }
  | { readonly outcome: "absent" };

/**
 * One part of one object's source document, and the PLAN that produced it.
 *
 * `optional` is the package body and nothing else today: a part whose absence is a legal
 * state of the object rather than a failure to read it.
 */
interface OracleSourcePartPlan {
  readonly id: string;
  readonly label: string;
  readonly type: { readonly dictionary: string; readonly metadata: string };
  readonly optional?: boolean;
}

/**
 * The kinds that read as MORE THAN ONE part, and what the extra part is.
 *
 * A package is ONE tree node over TWO dictionary rows, and this design reads it through
 * `PACKAGE_SPEC` and `PACKAGE_BODY` rather than through the bare `PACKAGE` type even though
 * the bare type retrieves both in one CLOB. Three measured reasons, none of which one CLOB can
 * express: a body may be ABSENT and a concatenation cannot say so; a body may be WRAPPED while
 * the specification is not, which `APP_WRAPPED_PKG` in the fixture exists to exhibit; and the
 * two halves carry independent `STATUS` values, which `APP_BROKEN_PKG` exhibits. The cost is
 * two round trips for a package instead of one, on the slowest engine in the fleet, and it is
 * paid deliberately (#789).
 *
 * Every other kind reads as exactly one part, so this table has one entry and the derivation
 * below builds the rest from `ORACLE_OBJECT_TYPES`. Nothing here is a branch on a kind id in
 * the sense `CLAUDE.md` forbids: that rule is about the DATABASE TYPE id, and a kind id is
 * this provider's own declaration, which only this provider can interpret.
 */
const ORACLE_SOURCE_PART_PLANS: Record<string, readonly [OracleSourcePartPlan, ...OracleSourcePartPlan[]]> = {
  package: [
    { id: "spec", label: "Package specification", type: { dictionary: "PACKAGE", metadata: "PACKAGE_SPEC" } },
    { id: "body", label: "Package body", type: PACKAGE_BODY_OBJECT_TYPE, optional: true },
  ],
};

/**
 * The parts one kind's source document is built from, head first.
 *
 * Derived from the translation table every other read already derives from, so a kind cannot
 * gain a source read here without also having a metadata type there. `Object.hasOwn` and never
 * `in`, per standing ruling 5g: `in` walks the prototype chain, so a kind id spelled
 * `constructor` would otherwise pick up a function.
 */
function sourcePartPlans(kind: string): readonly [OracleSourcePartPlan, ...OracleSourcePartPlan[]] {
  if (Object.hasOwn(ORACLE_SOURCE_PART_PLANS, kind)) return ORACLE_SOURCE_PART_PLANS[kind];
  return [{ id: "definition", label: "Definition", type: ORACLE_OBJECT_TYPES[kind] }];
}

/**
 * One plan and one read, as the part a document carries.
 *
 * The two arms are built as WHOLE LITERALS and neither is spread from the other, which is the
 * point. A part carrying both `text` and `unavailable` COMPILES as an `ObjectSourcePart`,
 * because TypeScript's excess-property check on a union admits any property declared on ANY
 * member, and `isSourcePartUnavailable` then narrows such a part to the refusal arm and drops
 * a definition the engine really returned. A provider that spread a conditional
 * `{ unavailable }` onto a bounded text would build exactly that part; this one cannot.
 *
 * `form: "complete"` on every kind: GET_DDL answers a statement that runs as given, never a
 * body or a bare SELECT. `origin: "regenerated"` on every kind, and it is a measurement rather
 * than a default: DBMS_METADATA rebuilds the statement from the dictionary, so the fixture's
 * `CREATE OR REPLACE FUNCTION app.app_order_total(p_id NUMBER)` comes back as
 * `CREATE OR REPLACE EDITIONABLE FUNCTION "APP"."APP_ORDER_TOTAL" (p_id NUMBER)`, with a
 * keyword the author never typed and a qualification the author never wrote. It is not the
 * author's bytes, and a reader must never be shown a reconstruction as an original.
 */
function sourcePart(
  plan: OracleSourcePartPlan,
  read: OracleDefinitionRead & { outcome: "text" | "refused" },
  language: string,
  limit: number | undefined,
): ObjectSourcePart {
  if (read.outcome === "refused") {
    return { id: plan.id, label: plan.label, unavailable: read.unavailable };
  }
  const bounded = applySourceBound(read.text, limit);
  return {
    id: plan.id,
    label: plan.label,
    text: bounded.text,
    language,
    form: "complete",
    origin: "regenerated",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

function describedSql(kind: string, bounded: boolean): string {
  const containerRule =
    kind === "table"
      ? `
             AND NOT EXISTS (
               SELECT 1 FROM ALL_OBJECTS m
               WHERE m.OWNER = o.OWNER AND m.OBJECT_NAME = o.OBJECT_NAME
                 AND m.OBJECT_TYPE = '${MATERIALIZED_VIEW_TYPE}'
             )`
      : "";
  return `WITH described AS (
           SELECT o.OBJECT_NAME AS NAME
           FROM ALL_OBJECTS o
           WHERE o.OWNER = :1 AND o.OBJECT_TYPE = :2${containerRule}
           ORDER BY o.OBJECT_NAME${bounded ? "\n           FETCH FIRST :3 ROWS ONLY" : ""}
         )`;
}

/** The target set itself, which is what says WHICH objects the answer is about. */
function bulkTargetSql(kind: string, bounded: boolean): string {
  return `${describedSql(kind, bounded)}
         SELECT d.NAME FROM described d`;
}

/**
 * The four detail reads, each re-pointed from ONE object to the whole target set.
 *
 * They are the `OBJECT_*_SQL` bodies above with `TABLE_NAME = :2` replaced by a join to
 * `described`, so every measured decision those statements carry still applies:
 * `rcc.POSITION = acc.POSITION` keeps a two-column foreign key from reporting four pairs for
 * two, and the index read keys `ai.TABLE_OWNER` rather than the index's own owner, because
 * an index another user owns on this table belongs to the table when a person is looking at
 * the table.
 *
 * Nothing here caps a column list. An unreported bound is the defect
 * `ObjectDetailBatch.truncated` exists to prevent; what is bounded here is the number of
 * OBJECTS, by the caller, and it is reported.
 */
function bulkDetailSql(
  kind: string,
  bounded: boolean,
): { columns: string; primaryKey: string; foreignKeys: string; indexes: string } {
  const described = describedSql(kind, bounded);
  // The next free placeholder after the target's own, which is what the owner's second
  // appearance has to use: see the note on `describedSql()` above.
  const owner = bounded ? ":4" : ":3";
  return {
    columns: `${described}
         SELECT d.NAME AS OBJECT_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT
         FROM described d
         JOIN ALL_TAB_COLUMNS c ON c.OWNER = ${owner} AND c.TABLE_NAME = d.NAME
         ORDER BY d.NAME, c.COLUMN_ID`,
    primaryKey: `${described}
         SELECT d.NAME AS OBJECT_NAME, acc.COLUMN_NAME
         FROM described d
         JOIN ALL_CONSTRAINTS ac ON ac.OWNER = ${owner} AND ac.TABLE_NAME = d.NAME AND ac.CONSTRAINT_TYPE = 'P'
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER`,
    foreignKeys: `${described}
         SELECT d.NAME AS OBJECT_NAME,
                acc.COLUMN_NAME,
                rc.OWNER AS REF_OWNER,
                rc.TABLE_NAME AS REF_TABLE,
                rcc.COLUMN_NAME AS REF_COLUMN
         FROM described d
         JOIN ALL_CONSTRAINTS ac ON ac.OWNER = ${owner} AND ac.TABLE_NAME = d.NAME AND ac.CONSTRAINT_TYPE = 'R'
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         JOIN ALL_CONSTRAINTS rc ON ac.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND ac.R_OWNER = rc.OWNER
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
                AND rcc.POSITION = acc.POSITION
         ORDER BY d.NAME, ac.CONSTRAINT_NAME, acc.POSITION`,
    indexes: `${described}
         SELECT d.NAME AS OBJECT_NAME, ai.INDEX_NAME, ai.UNIQUENESS, aic.COLUMN_NAME
         FROM described d
         JOIN ALL_INDEXES ai ON ai.TABLE_OWNER = ${owner} AND ai.TABLE_NAME = d.NAME
         JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.OWNER = aic.INDEX_OWNER
         ORDER BY d.NAME, ai.INDEX_NAME, aic.COLUMN_POSITION`,
  };
}

// ============================================================================
// Object surface shapes and derivations (#789)
// ============================================================================

/** One row of `CONTAINERS_SQL`. */
interface ContainerRow {
  NAME: string;
  IS_SESSION_DEFAULT: number;
}

/** One row of `COUNTS_SQL`: a dictionary spelling and how many of it the owner holds. */
interface KindCountRow {
  KIND: string;
  N: number;
}

/**
 * One listed object, from whichever of the four listing statements answered.
 *
 * `PARENT` is present only in the trigger listing, and is NULL there both for a trigger
 * with no base object and for one whose base table this user cannot see. `OBJECT_TYPE` is
 * present only in the package listing, the one that reads two dictionary rows per node.
 */
interface ObjectRow {
  NAME: string;
  STATUS: string;
  PARENT?: string | null;
  OBJECT_TYPE?: string;
}

/** The one `ALL_OBJECTS.STATUS` value a reader has anything to do about. */
const INVALID_STATUS = "INVALID";

/**
 * `DatabaseObject.status`, published only where Oracle's answer is worth a reader's attention (#789).
 *
 * `ALL_OBJECTS.STATUS` is `VALID` for nearly every row in a real schema, so publishing it
 * put a `VALID` badge beside every table in the tree and taught a reader to ignore the
 * field entirely. The field's contract is that its PRESENCE is the signal and the engine's
 * own word is the content, which keeps the decision here: this provider is the only thing
 * that knows which of Oracle's words is ordinary, and a renderer that knew the string
 * `VALID` would be a branch on the engine moved up a layer.
 */
function notableStatus(status: string): { status?: string } {
  return status === INVALID_STATUS ? { status } : {};
}

/**
 * The one owner a container path names on this engine.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come from
 * the declared level labels, so the check and its message are the same array and a
 * provider copying this file cannot inherit a hardcoded `1`. A path of any other length is
 * a caller that built it from another engine's shape, and it raises rather than reading
 * `path[0]` and carrying on, because `undefined` bound to `:1` would answer an empty
 * folder that looks exactly like an owner holding nothing.
 *
 * The segment is passed through verbatim and is never upper-cased. `getSchema()` upper-
 * cases `connection.user` because it is reading a value a person typed into a form; this
 * one came out of `ALL_USERS`, so it is already the dictionary's own spelling - and
 * `CREATE USER "app"` is legal, so upper-casing here would make that owner unreachable.
 */
function containerOwner(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `An Oracle container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "oracle",
    );
  }
  return ownerSegment(capabilities, container);
}

/**
 * The container levels this engine declares, cut to the depth `containerDepth()` answers.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` is what decides, never `containerLevels.length`.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared `schema` level, which on Oracle is the
 * OWNER.
 *
 * NEVER `path[0]`, which standing ruling 5g (#789) names as the third and most persistent
 * spelling of one defect: a container level's POSITION is a property of the declaration, not
 * a constant. Oracle declares `[schema]`, so the owner is the first segment here, and on a
 * two-level engine copying this file `path[0]` is the CATALOG - binding it as the owner
 * narrows every read to a schema that does not exist. Both spellings are behaviour-identical
 * at depth 1, which is exactly why the positional one survived this file's first review.
 *
 * A declaration with no `schema` level, or a path too short to carry it, raises rather than
 * falling through to `undefined`: bound to `:1` that would answer an owner holding nothing,
 * which looks exactly like a real empty owner.
 */
function ownerSegment(capabilities: ProviderCapabilities, path: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === "schema");
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `An Oracle path needs a "schema" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "oracle",
    );
  }
  return segment;
}

/**
 * Oracle: an attached kind takes either depth, so the error names both shapes, and the
 * subject the message opens with is "An Oracle".
 */
const PATH_SHAPE_ENGINE: ObjectPathShapeEngine = {
  code: "oracle",
  label: "An Oracle",
  attachedSegment: "optional",
};

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this engine has this kind and this owner holds none" render as a
 * 0 badge. Building the record from the GROUP BY rows alone would leave the kind out
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
 * the reason a folder has no number, so prefixing it would put our words in front of
 * Oracle's. A refused read is never 0 - "ORA-01031: insufficient privileges" and "this
 * owner holds no tables" are different facts and `KindCount` is the type that keeps them
 * apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/** Overwrites the seeded zeros with what the GROUP BY actually answered. */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    counts[KIND_BY_DICTIONARY_TYPE[row.KIND]] = { count: Number(row.N) };
  }
}

/**
 * Which statement answers for one kind, or nothing when this engine has no such kind.
 *
 * Every one of the four statements reads `ALL_OBJECTS` and binds its dictionary spelling,
 * so nothing a caller supplied reaches the statement text and every kind is counted and
 * listed from one catalog. They differ only in what they add: a package reads its second
 * dictionary row, a trigger outer-joins `ALL_TRIGGERS` for the object it hangs off, and
 * `table` drops the materialized-view containers, each for the reason its own statement
 * gives.
 */
function objectListingStatement(owner: string, kind: string): { sql: string; params: unknown[] } | undefined {
  const type = ORACLE_OBJECT_TYPES[kind];
  if (type === undefined) return undefined;
  if (kind === "package") {
    return { sql: LIST_PACKAGES_SQL, params: [owner, type.dictionary, PACKAGE_BODY_OBJECT_TYPE.dictionary] };
  }
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [owner, type.dictionary] };
  if (kind === "table") return { sql: LIST_TABLES_SQL, params: [owner, type.dictionary] };
  return { sql: LIST_BY_TYPE_SQL, params: [owner, type.dictionary] };
}

/**
 * A package's specification row and its body row, merged into the one object a user wrote.
 *
 * The status is INVALID when EITHER half is, because "the package works" is false if
 * either half does not compile - and a successful `CREATE OR REPLACE PACKAGE BODY` leaves
 * an INVALID body behind rather than failing, which is the state Oracle is in most often.
 * A package whose halves both compiled carries NO status at all: only the state a reader
 * would act on is published (#789).
 * Neither row is privileged: a body can exist with no specification (a specification
 * dropped out from under it), and a specification usually exists with no body while it is
 * being written.
 */
function collapsePackages(container: readonly string[], rows: readonly ObjectRow[]): DatabaseObject[] {
  const byName = new Map<string, DatabaseObject>();
  for (const row of rows) {
    const seen = byName.get(row.NAME);
    const invalid = seen?.status === INVALID_STATUS || row.STATUS === INVALID_STATUS;
    const status = invalid ? { status: INVALID_STATUS } : {};
    byName.set(row.NAME, { path: [...container, row.NAME], name: row.NAME, kind: "package", ...status });
  }
  return [...byName.values()];
}

/**
 * Where one listed object is addressed.
 *
 * Built from the ROW rather than from the kind id, so the four listing statements share
 * one rule: a `PARENT` column adds a nesting segment and nothing else does. That is what
 * the `attachedTo: "table"` declaration states, and Oracle needs no disambiguator on the
 * last segment for any kind - measured on 21c XE, a schema holds at most one object of a
 * given name across tables, views, materialized views, synonyms, sequences, packages,
 * procedures and functions (they share one namespace, and a second `CREATE` answers
 * ORA-00955), and `CREATE OR REPLACE FUNCTION` with a different argument list REPLACES the
 * function rather than overloading it.
 *
 * A NULL parent is a real trigger and not a missing value: a SCHEMA or DATABASE trigger
 * has no base object, so it hangs off the container itself.
 *
 * It takes the WHOLE CONTAINER and not the owner segment. This used to be
 * `objectPath(container, row)` building `[owner, name]`, which is behaviour-identical on this
 * one-level engine and silently wrong the moment the declaration grows a level: the listing
 * and the bulk read would then have agreed with each other on an address that had lost its
 * outer segment, which is the shape standing ruling 5g warns about. The caller has already
 * had the container refused by `containerOwner()` unless it is exactly the declared depth,
 * so what arrives here is the container the declaration describes (#789).
 */
function objectPath(container: readonly string[], row: ObjectRow): string[] {
  const parent = row.PARENT;
  if (parent === null || parent === undefined) return [...container, row.NAME];
  return [...container, parent, row.NAME];
}

/** One row of a bulk read, with the object it is about. The single read's rows carry no name. */
interface BulkRow {
  OBJECT_NAME?: string;
}

/** The four row sets one object's detail is built from, whichever read produced them. */
interface DetailRows {
  readonly columns: readonly Record<string, unknown>[];
  readonly primaryKey: readonly Record<string, unknown>[];
  readonly foreignKeys: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
}

/**
 * Four dictionary row sets turned into one `ObjectDetail`, shared by the single and the bulk
 * read.
 *
 * ONE function because the two reads select the same columns from the same four views and a
 * caller joins their results together: two copies of this mapping would be two chances for
 * the bulk read to spell a foreign key, a trimmed default or a composite index differently
 * from the single read of the SAME table.
 *
 * `owner` is the object's own, which is the container on this engine, and it decides only
 * how a reference is spelled: `referencedTable` is bare within the owner and QUALIFIED
 * outside it, because `ForeignKeySchema` carries one string and both surfaces are live
 * through Phase 1. A bare name for the crossing case addresses a table in the wrong schema.
 */
function objectDetailFromRows(path: readonly string[], owner: string, rows: DetailRows): ObjectDetail {
  const primaryKey = new Set(rows.primaryKey.map((row) => String(row.COLUMN_NAME)));
  const columns: ColumnSchema[] = rows.columns.map((row) => ({
    name: String(row.COLUMN_NAME),
    type: String(row.DATA_TYPE),
    nullable: String(row.NULLABLE) === "Y",
    isPrimary: primaryKey.has(String(row.COLUMN_NAME)),
    defaultValue: measuredDefault(row.DATA_DEFAULT),
  }));

  // One entry per index, its columns in COLUMN_POSITION order, which is the order both
  // statements return them in.
  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const name = String(row.INDEX_NAME);
    const index = byIndex.get(name) ?? { name, columns: [], unique: String(row.UNIQUENESS) === "UNIQUE" };
    index.columns.push(String(row.COLUMN_NAME));
    byIndex.set(name, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: String(row.COLUMN_NAME),
    referencedTable:
      String(row.REF_OWNER) === owner ? String(row.REF_TABLE) : `${String(row.REF_OWNER)}.${String(row.REF_TABLE)}`,
    referencedColumn: String(row.REF_COLUMN),
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

/** The rows of one bulk read grouped by the object each belongs to. */
function byObjectName<T extends BulkRow>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const name = String(row.OBJECT_NAME);
    const held = grouped.get(name);
    if (held === undefined) grouped.set(name, [row]);
    else held.push(row);
  }
  return grouped;
}

/**
 * Whether `ALL_USERS` has no `ORACLE_MAINTAINED` column on this server.
 *
 * Keyed on the column name as well as on ORA-00904, because 00904 is "invalid identifier"
 * generally: re-running without the filter repairs nothing if the missing column was
 * `USERNAME`, and reporting an empty container list there would be a guess.
 */
function isMissingOracleMaintainedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("ORA-00904") && error.message.includes("ORACLE_MAINTAINED");
}

/** `ALL_TAB_COLUMNS.DATA_DEFAULT` is a LONG holding source text, trailing spaces included. */
function measuredDefault(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  return String(raw).trim();
}

// ============================================================================
// Value shapes
// ============================================================================

/**
 * Fetch a LOB as its value instead of as a stream.
 *
 * By default oracledb answers a CLOB, an NCLOB and a BLOB with a `Lob` object -
 * a readable stream - and nothing downstream of the provider can read one.
 * Measured on 2026-08-24 against Oracle AI Database 26ai Free (oracledb 6.10.0, Thin) through
 * `createDatabaseProvider({type:"oracle"})`: all four LOB columns of a probe table
 * arrived as `Lob`, and serialising the row threw rather than producing a value -
 * `TypeError: Converting circular structure to JSON ... starting at object with
 * constructor 'NVPair'` under Node 24.14.0, `TypeError: JSON.stringify cannot
 * serialize cyclic structures` under Bun 1.3.14. `POST /api/db/query` builds its
 * answer with `NextResponse.json`, so a SELECT touching a LOB failed whole: the
 * grid, the CSV, the SQL export, the row detail sheet and the agent's summary all
 * had no row to read, not merely an unreadable cell.
 *
 * A BLOB becomes a `Buffer`, which is the shape the product's shared binary
 * contract already accepts (`asBytes` in src/lib/export/binary.ts takes both a
 * live `Uint8Array` and the `{type:"Buffer",data:[...]}` JSON it serialises to), so
 * a BLOB cell renders, previews and exports exactly like a Postgres `bytea` and a
 * MySQL `BLOB` with no further work.
 *
 * This is a per-call option rather than the process-wide `oracledb.fetchAsString` /
 * `fetchAsBuffer` globals on purpose: those would also change every schema and
 * monitoring read, and they outlive this provider - the embeddable library surface
 * runs inside a host application that may have its own oracledb consumers.
 *
 * The value is fetched whole, with no length cap, which is the same contract every
 * other provider here already has for a large value: Postgres `text`/`bytea` and
 * MySQL `BLOB` arrive whole too, and `DEFAULT_QUERY_LIMIT` bounds the row count,
 * not the cell. A cap was considered and rejected because a truncated CLOB looks
 * like a complete one in the grid and would be written into the target by the SQL
 * export - a silent corruption in place of a readable value. The cost is linear and
 * measured: a 16,384,000-character CLOB fetched as a string took 66 ms and
 * serialised to 16.4 MB of JSON in 18 ms. The ceiling is the runtime's own and it
 * fails loudly: a string longer than V8's 536,870,888-character maximum throws
 * `RangeError: Invalid string length`, which reaches the user as a failed query
 * rather than as a value that has quietly lost its tail.
 */
const lobFetchTypeHandler: oracledb.FetchTypeHandler = (metaData) => {
  if (metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB) {
    return { type: oracledb.STRING };
  }
  if (metaData.dbType === oracledb.DB_TYPE_BLOB) {
    return { type: oracledb.BUFFER };
  }
  // Every other column keeps the driver's default: RAW already arrives as a
  // Buffer and VARCHAR2 as a string, and restating them here would put this
  // module in charge of types it has no reason to touch.
  return undefined;
};

/** Two digits minimum, which is the width Oracle's own default precision prints. */
const pad2 = (value: number): string => String(Math.abs(value)).padStart(2, "0");

/** One leading sign for the whole interval: every field of a negative one is negative. */
const intervalSign = (fields: readonly number[]): string => (fields.some((field) => field < 0) ? "-" : "+");

/**
 * `INTERVAL YEAR TO MONTH` as the literal Oracle accepts back: `+03-07`.
 *
 * Years are NOT capped at two digits - `INTERVAL '123456789-11' YEAR(9) TO MONTH`
 * round-trips as `+123456789-11` - so the padding is a minimum, not a width.
 */
const formatIntervalYM = (value: oracledb.IntervalYM): string =>
  `${intervalSign([value.years, value.months])}${pad2(value.years)}-${pad2(value.months)}`;

/**
 * `INTERVAL DAY TO SECOND` as the literal Oracle accepts back: `+05 06:07:08.9`.
 *
 * `fseconds` is NANOseconds, so the fraction is nine digits with the trailing zeros
 * trimmed - lossless for a `SECOND(9)` column, and no fraction at all for a
 * whole-second interval (`+09 08:07:06`).
 */
const formatIntervalDS = (value: oracledb.IntervalDS): string => {
  const sign = intervalSign([value.days, value.hours, value.minutes, value.seconds, value.fseconds]);
  const fraction = String(Math.abs(value.fseconds)).padStart(9, "0").replace(/0+$/, "");
  const clock = `${pad2(value.hours)}:${pad2(value.minutes)}:${pad2(value.seconds)}`;
  return `${sign}${pad2(value.days)} ${clock}${fraction === "" ? "" : `.${fraction}`}`;
};

/** How one column's interval values are spelled, paired with the column's name. */
type IntervalColumn = readonly [name: string, format: (value: unknown) => string];

/**
 * Oracle's two interval types, normalised to their own literals at the driver
 * boundary - the decision `docs/providers/cassandra.md` 3.8 already took for a CQL
 * `duration`, for the same reason and with the same shape.
 *
 * Measured 2026-08-24 against Oracle AI Database 26ai Free (oracledb 6.10.0, Thin): the driver
 * answers `INTERVAL '3-7' YEAR TO MONTH` with `{"months":7,"years":3}` and
 * `INTERVAL '5 6:7:8.9' DAY TO SECOND` with
 * `{"fseconds":900000000,"seconds":8,"minutes":7,"hours":6,"days":5}`. Both are
 * lossless and both are unreadable: nothing in the product reconstructs either
 * object, the grid shows a JSON blob where a duration belongs, and the SQL export
 * writes that blob into an INTERVAL column - which Oracle refuses
 * (`ORA-01867: the interval is invalid`), so the row is lost rather than wrong.
 *
 * A fetch type handler cannot do this instead: asking the driver for either type as a
 * string is refused outright - `NJS-119: conversion from type DB_TYPE_INTERVAL_YM to
 * type DB_TYPE_VARCHAR is not supported`, and `oracledb.fetchAsString` answers
 * `NJS-021: invalid type for conversion specified` for both. The literal has to be
 * composed here.
 *
 * Driven by `metaData[].dbType` rather than by the value's class: the columns are
 * known once per result, so a query with no interval column does no per-cell work at
 * all and keeps the driver's own rows array.
 */
const intervalColumns = (metaData: readonly oracledb.Metadata[] | undefined): IntervalColumn[] => {
  const columns: IntervalColumn[] = [];
  for (const column of metaData ?? []) {
    if (column.dbType === oracledb.DB_TYPE_INTERVAL_YM) {
      columns.push([column.name, (value) => formatIntervalYM(value as oracledb.IntervalYM)]);
    }
    if (column.dbType === oracledb.DB_TYPE_INTERVAL_DS) {
      columns.push([column.name, (value) => formatIntervalDS(value as oracledb.IntervalDS)]);
    }
  }
  return columns;
};

const normalizeIntervals = (
  rows: Record<string, unknown>[],
  metaData: readonly oracledb.Metadata[] | undefined,
): Record<string, unknown>[] => {
  const columns = intervalColumns(metaData);
  if (columns.length === 0) return rows;

  return rows.map((row) => {
    const normalized = { ...row };
    for (const [name, format] of columns) {
      const value = normalized[name];
      // A NULL interval stays null: the column is absent from the row, not zero.
      if (value !== null && value !== undefined) normalized[name] = format(value);
    }
    return normalized;
  });
};

// ============================================================================
// Oracle Provider
// ============================================================================

// node-oracledb's Thin/Thick client mode is a process-wide singleton:
// oracledb.initOracleClient() throws if called more than once, or after any
// connection/pool already exists. Track it at module scope so it runs at most
// once across every OracleProvider instance in this process, not once per
// constructor call.
let thickClientInitialized = false;

export class OracleProvider extends SQLBaseProvider {
  private pool: oracledb.Pool | null = null;

  // Transaction support: dedicated connection held outside pool
  private txConn: oracledb.Connection | null = null;
  private txActive = false;

  // Track running connections for cancellation
  private runningConns = new Map<string, oracledb.Connection>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    // Thin mode (pure JS, no Oracle Instant Client) is the unconditional default.
    // Thick mode is an explicit opt-in for servers older than Oracle Database 12.1,
    // which Thin mode cannot connect to (node-oracledb NJS-138).
    const libDir = process.env.ORACLE_CLIENT_LIB_DIR;
    if (libDir && !thickClientInitialized) {
      try {
        oracledb.initOracleClient({ libDir });
      } catch (error) {
        // node-oracledb throws a raw driver error here, and the two that
        // actually happen mean opposite things: NJS-045 is a missing Thick-mode
        // addon in THIS build (nothing the operator configured), DPI-1047 is the
        // client libraries failing to load from a directory that is very likely
        // correct but not on the loader path. Surface either as a non-retryable
        // configuration error carrying the diagnosis, not one generic sentence.
        throw new DatabaseConfigError(describeOracleClientLoadFailure(libDir, String(error)), "oracle");
      }
      thickClientInitialized = true;
    }
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.autoCommit = true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 1521,
      // node-oracledb sends ONE statement and the terminator is not part of it: it is a
      // SQL*Plus convention, not Oracle SQL. Measured on Oracle AI Database 26ai Free
      // through this provider on 2026-09-12, reproduced by clicking a table in the object
      // browser: `SELECT * FROM app_customers FETCH FIRST 50 ROWS ONLY;` answers
      // ORA-00933 "SQL command not properly ended", and the identical statement without
      // the `;` returns the rows. `query-generators.ts` emitted that `;` from the day the
      // Oracle branch was written, so "Select Top 50" on Oracle had never worked (#789).
      statementTerminator: "none",
      // Disabled until an Oracle dialect wrapper exists (#126): a real plan flow needs
      // EXPLAIN PLAN FOR + DBMS_XPLAN, which the single-statement explain path cannot express.
      supportsExplain: false,
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, built by this provider's own
      // `prepareQuery` override; page one is `FETCH FIRST n ROWS ONLY`.
      supportsResultPagination: true,
      // Oracle is always in a transaction; the held connection commits or rolls back.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "optimize", "kill"],
      // `optimize` now takes a TABLE and rebuilds that table's own indexes, which is
      // what SQL Server's identically worded control has always done. It used to take
      // an INDEX name, so the per-table button that #427 wired up sent a table and
      // every click answered ORA-01418 (reproduced against Oracle AI Database 26ai Free on
      // 2026-08-25, then fixed and re-run - see runMaintenance below).
      maintenanceOperationSpecs: {
        analyze: { label: "Gather Statistics", perEntity: true, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      },
      // One level, and on Oracle the level IS a user: a schema is not a thing you create
      // beside a user, it is what a user owns. `catalog` is not a second level here - a
      // pool is opened against one service and nothing in the product can switch the
      // pluggable database on a live connection.
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      // Nine kinds, all nine answered by `ALL_OBJECTS.OBJECT_TYPE` (#789).
      //
      // No `index` kind, deliberately. Oracle's own dictionary models an index as an
      // attribute of the table it is on - `ALL_INDEXES` is keyed by TABLE_OWNER and
      // TABLE_NAME and an index cannot exist without them - so it belongs in
      // `describeObject`'s output, where it is, rather than in a folder of its own.
      objectKinds: [
        // `hasColumns` on the three kinds and no more, and it is written out rather than
        // derived from `role === "relation"` even though the two agree here (#789).
        // `describeObject` gates on the role at `oracle.ts:2015`, so a sequence answers no
        // columns at all - the opposite of PostgreSQL's sequence, which answers last_value,
        // log_cnt and is_called. Same kind id, opposite answer, so the fact is the
        // provider's to state and the tree draws a twisty on nothing else.
        {
          id: "table",
          role: "relation",
          label: "Table",
          labelPlural: "Tables",
          acceptsRowWrites: true,
          hasColumns: true,
          ...ORACLE_SOURCE_DECLARATION,
        },
        // No `acceptsRowWrites` on either view kind. Oracle takes an UPDATE against a
        // key-preserved view and refuses it against the rest, which is a per-OBJECT fact
        // this per-kind declaration cannot state; a materialized view takes no row write
        // at all, since its rows come from its query.
        {
          id: "view",
          role: "relation",
          label: "View",
          labelPlural: "Views",
          hasColumns: true,
          ...ORACLE_SOURCE_DECLARATION,
        },
        {
          id: "materialized_view",
          role: "relation",
          label: "Materialized View",
          labelPlural: "Materialized Views",
          hasColumns: true,
          ...ORACLE_SOURCE_DECLARATION,
        },
        { id: "synonym", role: "config", label: "Synonym", labelPlural: "Synonyms", ...ORACLE_SOURCE_DECLARATION },
        { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences", ...ORACLE_SOURCE_DECLARATION },
        // A package is ONE node holding routines, not two and not a routine itself: the
        // dictionary carries a PACKAGE row and a PACKAGE BODY row, and a user wrote one
        // package. `listObjects` collapses them; `countObjects` counts only the first.
        {
          id: "package",
          role: "group",
          label: "Package",
          labelPlural: "Packages",
          childKinds: ["procedure", "function"],
          ...ORACLE_SOURCE_DECLARATION,
        },
        {
          id: "procedure",
          role: "routine",
          label: "Procedure",
          labelPlural: "Procedures",
          ...ORACLE_SOURCE_DECLARATION,
        },
        { id: "function", role: "routine", label: "Function", labelPlural: "Functions", ...ORACLE_SOURCE_DECLARATION },
        {
          id: "trigger",
          role: "attached",
          label: "Trigger",
          labelPlural: "Triggers",
          attachedTo: "table",
          ...ORACLE_SOURCE_DECLARATION,
        },
      ],
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Gather Statistics",
      vacuumAction: "Rebuild Indexes",
      // Oracle has no VACUUM; this slot has always said "Rebuild Indexes", which is
      // `optimize`. Saying so is what lets the two surfaces send that operation
      // instead of a `vacuum` this provider rejects (#496).
      vacuumActionOperation: "optimize",
      analyzeGlobalLabel: "Gather Stats",
      analyzeGlobalTitle: "Gather Statistics",
      analyzeGlobalDesc: "Collects optimizer statistics for all tables to improve query performance.",
      vacuumGlobalLabel: "Rebuild Indexes",
      vacuumGlobalTitle: "Rebuild All Indexes",
      vacuumGlobalDesc: "Rebuilds all indexes to reclaim space and improve performance.",
      // `getSlowQueries()` reads V$SQL, and a user without SELECT on the V$ views gets
      // `[]` from the swallowed failure. The panel used to name a PostgreSQL extension
      // there (#463); the grant is the thing an Oracle DBA can act on.
      slowQueriesEmptyState: "Query stats come from V$SQL, which this user needs SELECT on to read.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for Oracle", "oracle");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private getConnectString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const host = this.config.host || "localhost";
    const port = this.config.port || 1521;
    const serviceName = this.config.serviceName || this.config.database || "ORCL";

    // TCPS is how the Thin driver is told to negotiate TLS at all: it calls
    // `tls.connect` only when the resolved address protocol is TCPS (audited in the
    // installed package, `oracledb/lib/thin/sqlnet/ntTcp.js`). A pasted connect string
    // returns above unchanged, so its own protocol — or its full TNS descriptor —
    // decides for it; rewriting it would drop what only the user knows.
    const scheme = this.config.ssl && this.config.ssl.mode !== "disable" ? "tcps://" : "";

    return `${scheme}${host}:${port}/${serviceName}`;
  }

  /**
   * Oracle has no `rejectUnauthorized` equivalent: Thin mode calls `tls.connect` with
   * `rejectUnauthorized: true` unconditionally, so the chain is checked in every TCPS
   * connection and a self-signed server is reachable only by supplying its CA here.
   * What IS optional is the DN/hostname check, which `verify-full` asks for and
   * `require`/`verify-ca` do not — so those two map to `sslServerDNMatch: false`
   * rather than to a weaker chain check, which no knob offers.
   *
   * `walletContent` is the driver's single-PEM channel: it hands the same string to
   * `tls.createSecureContext()` as `cert`, `key` AND `ca`, so the form's three fields
   * are concatenated into one blob instead of mapped to three options.
   *
   * NOT exercised against a TLS listener (the probe instance speaks TCP), so this is
   * the audited shape of the driver's own attributes and no claim about a verified path.
   */
  private buildTLSAttributes(): Record<string, unknown> {
    const ssl = this.config.ssl;
    if (!ssl || ssl.mode === "disable") return {};

    const wallet = [ssl.caCert, ssl.clientCert, ssl.clientKey].filter(Boolean).join("\n");

    return {
      // `verify-system` asks for the same server-name match as `verify-full`; what it does
      // NOT ask for is a wallet, so with no PEM pasted `tls.connect` falls back to Node's
      // bundled roots for the chain - which is exactly what the mode means (D26).
      sslServerDNMatch: ssl.mode === "verify-full" || ssl.mode === "verify-system",
      ...(wallet ? { walletContent: wallet } : {}),
    };
  }

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      // No pool `error` listener here, unlike the PostgreSQL and SQL Server providers
      // (#298): oracledb's pool has no pool-level `error` event to listen for. Audited in
      // the installed package — `oracledb/lib/pool.js` extends EventEmitter but emits only
      // the internal `_afterPoolClose` and `_allCheckedIn`, and nothing under `oracledb/lib`
      // emits `error` at all. Connection failures surface through the awaiting call.
      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.getConnectString(),
        poolMin: this.poolConfig.min,
        poolMax: this.poolConfig.max,
        poolTimeout: Math.floor(this.poolConfig.idleTimeout / 1000),
        ...this.buildTLSAttributes(),
      });

      // Test the connection
      const conn = await this.pool.getConnection();
      await conn.close();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      // A failed connect orphans its pool, and oracledb's background creator keeps
      // reaching for `poolMin` connections with no delay between attempts (#1102):
      // measured at ~14,000 TCP connects and one full CPU core per second, forever.
      // `factory.getOrCreateProvider()` never caches a provider whose `connect()`
      // threw, so no later `disconnect()` can reach it - the provider has to clean
      // up after itself, the contract PostgreSQL and SQL Server already follow.
      // `close(0)` is oracledb's equivalent of `end()`: force close, do not wait.
      // The clearing matters as much as the close. Left set, `this.pool` makes the
      // guard at the top of connect() return on a retry without dialling and
      // without an error, so the caller reads a silent success.
      const failedPool = this.pool;
      this.pool = null;
      // A close failure is cleanup noise. Awaiting it with `.catch(() => {})` keeps
      // it from becoming the reason a connect was refused.
      await failedPool?.close(0).catch(() => {});
      // NJS-138 (server predates Oracle 12.1, incompatible with Thin mode) is a permanent
      // configuration problem, not a transient connection failure — map it through
      // mapDatabaseError() so it surfaces as a non-retryable DatabaseConfigError instead of
      // the generic ConnectionError every other connect() failure falls back to below.
      const mapped = mapDatabaseError(error, "oracle");
      if (mapped instanceof DatabaseConfigError) {
        throw mapped;
      }
      throw new ConnectionError(
        `Failed to connect to Oracle: ${error instanceof Error ? error.message : error}`,
        "oracle",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close(0);
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

  /**
   * Build the result envelope from one oracledb `Result`.
   *
   * oracledb answers a SELECT with a `rows` array and a non-SELECT with no `rows` at
   * all plus its own `rowsAffected` - so the row count of a DML statement is only
   * readable there. Measured 2026-08-24 against Oracle AI Database 26ai Free through
   * `createDatabaseProvider({type:"oracle"})`: `INSERT` of one row -> rowsAffected 1,
   * `INSERT ... SELECT` of three -> 3, `UPDATE` touching four -> 4, a `DELETE` that
   * matched nothing -> 0, `CREATE TABLE` and `TRUNCATE` -> 0, a PL/SQL block ->
   * undefined. Building the count from `rows.length` instead reported 0 for every one
   * of them while the statement had in fact been applied, which is the answer
   * that makes a user retry and double-apply it.
   *
   * Same shape as `buildQueryResult` in mysql.ts (#469): the non-rows branch answers
   * with an empty grid and the engine's own count, and states no column types because
   * there is no metadata to state them from.
   */
  private buildQueryResult(result: oracledb.Result, executionTime: number): QueryResult {
    if (!result.rows) {
      return {
        rows: [],
        fields: [],
        rowCount: result.rowsAffected ?? 0,
        executionTime,
      };
    }

    const rows = normalizeIntervals(result.rows as Record<string, unknown>[], result.metaData);

    return {
      rows,
      fields: result.metaData?.map((m) => m.name) ?? [],
      rowCount: rows.length,
      executionTime,
      ...oracleColumnTypes(result.metaData),
    };
  }

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        let conn: oracledb.Connection | undefined;
        try {
          conn = await this.pool!.getConnection();

          if (queryId) {
            this.runningConns.set(queryId, conn);
          }

          const bindParams = params || [];
          const res = await conn.execute(sql, bindParams, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: true,
            fetchTypeHandler: lobFetchTypeHandler,
          });

          return res;
        } catch (error) {
          throw mapDatabaseError(error, "oracle", sql);
        } finally {
          if (queryId) this.runningConns.delete(queryId);
          if (conn) {
            try {
              await conn.close();
            } catch {
              /* ignore */
            }
          }
        }
      });

      return this.buildQueryResult(result, executionTime);
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const conn = this.runningConns.get(queryId);
    if (!conn) return false;

    try {
      await conn.break();
      return true;
    } catch (error) {
      console.error("[Oracle] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (Oracle FETCH FIRST instead of LIMIT)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      // Both branches append at the tail, so both used to have their clause
      // swallowed by a trailing line comment while this method still reported
      // `wasLimited: true` - the statement reached Oracle unbounded and the UI
      // said it was capped (#280). The clause goes between the statement and its
      // trailing trivia instead, which also keeps the `;` out of the comment.
      // A statement whose end may not be cut has nowhere honest to take the
      // clause, so it is returned untouched rather than bounded on a guess. On
      // Oracle that is a literal Oracle and MySQL would close in different
      // places. `#` in an identifier (`ID#`) used to reach the same refusal and
      // no longer does: the end is read under Oracle's own grammar (#292), where
      // `#` is an identifier character and opens no comment.
      const source = query.trim();
      const { end, rewritable } = readStatementEnd(source, resolveSqlGrammar(this.type));
      if (!rewritable) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }

      const statement = source.slice(0, end);
      const trailing = source.slice(end);

      const clause =
        offset > 0
          ? `OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`
          : `FETCH FIRST ${effectiveLimit} ROWS ONLY`;

      return {
        query: `${statement} ${clause}${trailing}`,
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
    if (this.txActive) throw new QueryError("Transaction already active", "oracle");
    this.txConn = await this.pool!.getConnection();
    // Oracle auto-starts a transaction; we just hold the connection
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");
    try {
      await this.txConn.commit();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");
    try {
      await this.txConn.rollback();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.txConn!.execute(sql, params || [], {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: false,
            fetchTypeHandler: lobFetchTypeHandler,
          });
        } catch (error) {
          throw mapDatabaseError(error, "oracle", sql);
        }
      });

      return this.buildQueryResult(result, executionTime);
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /** One dictionary read on a caller-held connection, with Oracle's refusal mapped. */
  private async runObjectQuery(conn: oracledb.Connection, sql: string, params: unknown[]) {
    try {
      return await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    } catch (error) {
      throw mapDatabaseError(error, "oracle", sql);
    }
  }

  /**
   * The owners this connection can see. One level, so `parent` can only ever name an
   * owner, and nothing nests under one here - that answers `[]` rather than raising,
   * because "this level has no children" is a true statement about Oracle and not a
   * caller mistake.
   *
   * This method is half of #765. Every other dictionary read in this provider is scoped
   * to `OWNER = <connecting user>`, which is why the app has shown exactly one schema on
   * Oracle with no way to reach another; the container list is scoped to nothing.
   *
   * The one retry drops the `ORACLE_MAINTAINED` filter rather than the list. See
   * `CONTAINERS_SQL_WITHOUT_ORACLE_MAINTAINED`.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    const conn = await this.pool!.getConnection();
    try {
      let result: oracledb.Result;
      try {
        result = await conn.execute(CONTAINERS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      } catch (error) {
        if (!isMissingOracleMaintainedError(error)) throw mapDatabaseError(error, "oracle", CONTAINERS_SQL);
        result = await this.runObjectQuery(conn, CONTAINERS_SQL_WITHOUT_ORACLE_MAINTAINED, []);
      }
      return ((result.rows ?? []) as ContainerRow[]).map((row) => ({
        path: [row.NAME],
        name: row.NAME,
        level: 0,
        isSessionDefault: Number(row.IS_SESSION_DEFAULT) === 1,
      }));
    } finally {
      await conn.close();
    }
  }

  /**
   * How many objects of each declared kind one owner holds, in one statement.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries Oracle's own sentence, so the
   * object browser can say why a folder has no number instead of showing a zero nobody
   * measured. Oracle refuses this read as a whole or not at all - `ALL_OBJECTS` is the
   * single source for every one of the nine kinds - so there is no partial outcome to
   * report and no retry that could produce one.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const owner = containerOwner(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    const conn = await this.pool!.getConnection();
    try {
      const result = await conn.execute(COUNTS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      applyKindCounts(counts, (result.rows ?? []) as KindCountRow[]);
      return counts;
    } catch (error) {
      return unavailableCounts(
        declared.map((kind) => kind.id),
        error,
      );
    } finally {
      await conn.close();
    }
  }

  /**
   * The objects of one kind in one owner, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Four
   * statements answer these listings and one of them collapses two rows into one node, so
   * four `ORDER BY` clauses would be four chances to disagree; and a SQL sort runs under
   * the database's own `NLS_SORT`, so the same owner would come back in two different
   * orders on two servers. A code-point sort here is one rule and the same rule
   * everywhere.
   *
   * By PATH and not by name, because it is the address that has to be stable: sorting by
   * the address groups a table's triggers together, and a schema-level trigger sorts among
   * the tables rather than inside one.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const owner = containerOwner(capabilities, container);
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would make the two
    // methods disagree, and would report "declares no object kind" about a kind
    // `objectKinds` does declare.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`Oracle declares no object kind "${kind}"`, "oracle");
    }
    const statement = objectListingStatement(owner, kind);
    if (statement === undefined) {
      throw new QueryError(`Oracle declares the kind "${kind}" but has no statement that lists it`, "oracle");
    }

    const conn = await this.pool!.getConnection();
    try {
      const result = await this.runObjectQuery(conn, statement.sql, statement.params);
      const rows = (result.rows ?? []) as ObjectRow[];
      const objects =
        kind === "package"
          ? collapsePackages(container, rows)
          : rows.map((row) => ({
              path: objectPath(container, row),
              name: row.NAME,
              kind,
              ...notableStatus(row.STATUS),
            }));
      // Sorted by ADDRESS, segment by segment. This used to key on `JSON.stringify(path)`,
      // which standing ruling 5g refuses for two reasons that both bite on this engine: at the
      // MIXED DEPTH ruling 5f gives Oracle's triggers the serialised deeper path sorts above
      // its own prefix, and JSON escaping reorders a quoted name by its escape sequence.
      return objects.sort((left, right) => comparePaths(left.path, right.path));
    } finally {
      await conn.close();
    }
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the three kinds Oracle resolves as relations have any of the three, so a
   * package, a routine, a synonym, a sequence and a trigger answer three empty arrays
   * without a round trip. That is a true fact about those kinds rather than a failed read,
   * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
   * side, and listing a package's members is Phase 2's job.
   *
   * Without the kind the same answer would come out by accident: the four reads key the
   * LAST path segment against `TABLE_NAME`, so a routine returned nothing only because no
   * table is called that - and a trigger named `APP_ORDERS` on table `APP_CUSTOMERS` would
   * have been handed `APP_ORDERS`'s columns as if they were its own. Measured on 21c XE, a
   * trigger really can share a name with a table: they are in different namespaces, so
   * `CREATE TRIGGER app.app_orders ... ON app.app_orders` succeeds.
   *
   * Four narrow statements rather than one wide one. Each is bound to ONE owner and ONE
   * object, which is the half of #765 that survives past first paint: the same four
   * dictionary views scoped to the owner alone answer 910,000 column rows on the
   * reporter's instance. They run in sequence on one connection because a single oracledb
   * connection serialises its statements anyway.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`Oracle declares no object kind "${kind}"`, "oracle");
    }

    assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);

    if (spec.role !== "relation") {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    // Neither bind is positional. The owner is the segment the DECLARATION assigns to the
    // `schema` level, and the object's own name is the LAST segment. On Oracle those are
    // `path[0]` and `path[1]`; on a two-level engine copying this file `path[0]` is the
    // catalog and `path[1]` is a container segment, so both literals would narrow these four
    // reads to an object that does not exist.
    const owner = ownerSegment(capabilities, path);
    const binds = [owner, path[path.length - 1]];
    const conn = await this.pool!.getConnection();
    try {
      const columns = ((await this.runObjectQuery(conn, OBJECT_COLUMNS_SQL, binds)).rows ?? []) as Record<
        string,
        unknown
      >[];
      const primaryKey = ((await this.runObjectQuery(conn, OBJECT_PRIMARY_KEY_SQL, binds)).rows ?? []) as Record<
        string,
        unknown
      >[];
      const foreignKeys = ((await this.runObjectQuery(conn, OBJECT_FOREIGN_KEYS_SQL, binds)).rows ?? []) as Record<
        string,
        unknown
      >[];
      const indexes = ((await this.runObjectQuery(conn, OBJECT_INDEXES_SQL, binds)).rows ?? []) as Record<
        string,
        unknown
      >[];

      return objectDetailFromRows(path, owner, { columns, primaryKey, foreignKeys, indexes });
    } finally {
      await conn.close();
    }
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one owner (#789).
   *
   * FIVE round trips for the whole folder, which is the entire reason this method exists:
   * the inventory route built the same answer as one `describeObject` per object - four
   * statements each, up to 5000 objects - and removed it as an N+1. On this engine that is
   * also the other half of #765: the same four dictionary views scoped to an owner alone
   * answered 910,000 column rows on the reporter's instance, and these five are scoped to
   * one owner, one kind and the caller's own bound.
   *
   * Only the three kinds Oracle resolves as relations have any of the three, so a package, a
   * routine, a synonym, a sequence and a trigger answer an empty batch with NO round trip at
   * all, exactly as `describeObject` answers three empty arrays for one of them. That is a
   * true fact about those kinds and not a refused read. A MATERIALIZED VIEW is one of the
   * three and does describe: measured on 21c XE, `ALL_TAB_COLUMNS` answers for it, because it
   * has a container table underneath - which is also why the `table` target has to drop that
   * container.
   *
   * An empty owner costs ONE round trip rather than five.
   *
   * The bound is the CALLER's and is never invented here. `FETCH FIRST :3 ROWS ONLY` is bound
   * at `limit + 1`, so a saturated read is distinguishable from an exact one without a second
   * count, the extra object is dropped, and `truncated` carries the caller's own limit. An
   * unbounded call runs a statement with no row bound and can never report truncation.
   *
   * The paths are built by `objectPath()`, the same rule `listObjects` builds its paths with,
   * and sorted by `comparePaths`, because every caller joins the two answers on path.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`Oracle declares no object kind "${kind}"`, "oracle");
    }
    const owner = containerOwner(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction reaches oracledb as a bind the server
      // cannot use; both are caller mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `An Oracle bulk column read limit must be a positive whole number, received ${limit}`,
        "oracle",
      );
    }
    if (spec.role !== "relation") return { details: [] };

    const bounded = limit !== undefined;
    const type = ORACLE_OBJECT_TYPES[kind].dictionary;
    // One row more than the bound, so the read itself says whether it stopped short. The
    // binds are positional and the same array serves all five statements.
    const binds = bounded ? [owner, type, limit + 1] : [owner, type];

    const conn = await this.pool!.getConnection();
    try {
      const targetRows = ((await this.runObjectQuery(conn, bulkTargetSql(kind, bounded), binds)).rows ??
        []) as ObjectRow[];
      const truncated = bounded && targetRows.length > limit;
      const described = truncated ? targetRows.slice(0, limit) : targetRows;
      if (described.length === 0) return { details: [] };

      const statements = bulkDetailSql(kind, bounded);
      // The owner again, as the LAST value: oracledb binds an array by the order the
      // placeholders appear, so the second reference to the owner needs its own value.
      const detailBinds = [...binds, owner];
      const read = async (sql: string) =>
        byObjectName(
          ((await this.runObjectQuery(conn, sql, detailBinds)).rows ?? []) as (BulkRow & Record<string, unknown>)[],
        );
      const columns = await read(statements.columns);
      const primaryKey = await read(statements.primaryKey);
      const foreignKeys = await read(statements.foreignKeys);
      const indexes = await read(statements.indexes);

      const details = described
        .map((row) =>
          objectDetailFromRows(objectPath(container, row), owner, {
            columns: columns.get(row.NAME) ?? [],
            primaryKey: primaryKey.get(row.NAME) ?? [],
            foreignKeys: foreignKeys.get(row.NAME) ?? [],
            indexes: indexes.get(row.NAME) ?? [],
          }),
        )
        .sort((left, right) => comparePaths(left.path, right.path));
      return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
    } finally {
      await conn.close();
    }
  }

  /**
   * ONE object's definition text, through `DBMS_METADATA.GET_DDL` (#789 Phase 2).
   *
   * ALL NINE declared kinds answer here, which is why there is no "declares nothing" arm:
   * Oracle publishes a runnable CREATE statement for a synonym, a sequence and a materialized
   * view as readily as for a package body. The metadata type comes from the translation table
   * this file already ships, never from a second table, so a kind cannot gain a Source tab
   * without also having the type every other read binds.
   *
   * FOUR THINGS THIS METHOD DOES THAT NO OTHER OBJECT READ HERE DOES.
   *
   * 1. IT PASSES `lobFetchTypeHandler`. GET_DDL answers a CLOB, oracledb answers a CLOB with a
   *    `Lob` stream by default, and serialising one throws `TypeError: Converting circular
   *    structure to JSON`. The handler is a PER-CALL option and `runObjectQuery` passes none,
   *    so this read has its own execute rather than reusing that one. A value that still comes
   *    back as something other than a string RAISES by name instead of being coerced: a
   *    stringified `Lob` in an editor is worse than a failed read.
   * 2. IT ASKS ORA-31603 A SECOND QUESTION. See `OBJECT_IS_VISIBLE_SQL`: Oracle words a
   *    privilege refusal as "not found in schema", #765 made reading another owner's object
   *    the ordinary path, and shipping that sentence unqualified tells a user their objects
   *    are gone. The refusal keeps ORACLE'S OWN SENTENCE whole and appends the fact that
   *    settles which of the two it is; nothing is prefixed and nothing is rewritten.
   * 3. IT DETECTS WRAPPED PL/SQL, which raises nothing at all. See `wrapFormatMarker`. A
   *    wrapped unit's part is a REFUSAL beside a readable sibling, which is the whole reason
   *    unreadability is a per-part field rather than a raise: `APP_WRAPPED_PKG` in the fixture
   *    has a readable specification and a wrapped body, and raising would take the readable
   *    half away with the unreadable one.
   * 4. IT EMITS TWO PARTS FOR A PACKAGE, and ONE for a package with no body. The missing body
   *    is an ABSENCE and not a refusal: nobody ever wrote it, so there is nothing to refuse,
   *    and the ALL_OBJECTS question above is what tells that absence apart from a body Oracle
   *    declined to hand over. `APP_SPEC_ONLY_PKG` in the fixture is that state.
   *
   * An object the read cannot find RAISES a `QueryError` naming the object's last segment. It
   * never answers a document and never answers a refusal part, because a dropped object is
   * the engine's silence and a refusal is the engine's answer.
   *
   * NOTHING IS INTERPOLATED. The metadata type, the object name and the owner are all three
   * BINDS, so a caller-supplied name never reaches statement text here and no identifier
   * escaper is involved. The security review asks; `docs/providers/oracle.md` records it.
   *
   * Neither the owner nor the name is positional (standing ruling 5g). The owner is the
   * segment the DECLARATION assigns to the `schema` level and the name is the LAST segment,
   * so a two-level engine copying this file does not silently bind a catalog as an owner. The
   * integration suite pins both by swapping a two-level declaration in.
   */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec?.hasSource !== true) {
      throw new QueryError(`Oracle declares no readable source for the kind "${kind}"`, "oracle");
    }
    const language = spec.sourceLanguage;
    if (language === undefined) {
      // No fallback to a literal "sql". An unregistered or absent Monaco id degrades to plain
      // text with no throw and nothing observable, so a kind that declared source and lost its
      // language would ship a Source tab that had quietly stopped highlighting. The isolated
      // census pins all nine declared languages, so this arm is only ever reached by a
      // declaration somebody deleted (#789).
      throw new QueryError(
        `Oracle declares readable source for the kind "${kind}" and no sourceLanguage to render it with`,
        "oracle",
      );
    }
    assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);
    const owner = ownerSegment(capabilities, path);
    const name = path[path.length - 1];
    const [head, ...rest] = sourcePartPlans(kind);

    const conn = await this.pool!.getConnection();
    try {
      const first = await this.readDefinition(conn, head.type, owner, name);
      if (first.outcome === "absent") {
        throw new QueryError(
          `Oracle holds no ${spec.label.toLowerCase()} called "${name}" in ${owner}: GET_DDL reported it missing ` +
            "and ALL_OBJECTS shows no such object for this session either",
          "oracle",
        );
      }
      // The tuple's HEAD is an array literal and every later part is a conditional push,
      // which is the one spelling besides a whole literal that satisfies the non-empty tuple.
      // `rest.map(...)` does not compile against it and the cast that rescues it is forbidden,
      // because the cast is exactly what would let a zero-part document reach a renderer.
      const parts: [ObjectSourcePart, ...ObjectSourcePart[]] = [sourcePart(head, first, language, limit)];
      for (const plan of rest) {
        const read = await this.readDefinition(conn, plan.type, owner, name);
        // An optional part that is not there emits NOTHING. A package specification with no
        // body is a complete and legal object, so a refusal here would report a state nobody
        // is in as a failure to read.
        if (read.outcome === "absent") continue;
        parts.push(sourcePart(plan, read, language, limit));
      }
      return { path: [...path], kind, parts };
    } finally {
      await conn.close();
    }
  }

  /**
   * One `GET_DDL` call, with the CLOB handler, the ORA-31603 disambiguation and the wrapped
   * check, answering which of the three outcomes the engine gave (#789 Phase 2).
   *
   * A method rather than an inline block so the refusal and absence arms can be driven
   * without reaching into oracledb, and so the fetch handler has ONE caller to lose.
   */
  private async readDefinition(
    conn: oracledb.Connection,
    type: { readonly dictionary: string; readonly metadata: string },
    owner: string,
    name: string,
  ): Promise<OracleDefinitionRead> {
    let value: unknown;
    try {
      const result = await conn.execute(OBJECT_DDL_SQL, [type.metadata, name, owner], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchTypeHandler: lobFetchTypeHandler,
      });
      value = ((result.rows ?? []) as Record<string, unknown>[])[0]?.DDL;
    } catch (error) {
      if (!isObjectNotFoundError(error)) throw mapDatabaseError(error, "oracle", OBJECT_DDL_SQL);
      // RULING C. ORA-31603 alone cannot tell an absence from a privilege refusal, and this
      // is the question that can. The answer decides between a part a reader can act on and a
      // raise, so it is asked on every ORA-31603 and never guessed from the message.
      const seen = await this.runObjectQuery(conn, OBJECT_IS_VISIBLE_SQL, [owner, name, type.dictionary]);
      if ((seen.rows ?? []).length === 0) return { outcome: "absent" };
      return {
        outcome: "refused",
        // Oracle's own sentence FIRST and whole, then the fact that settles which of the two
        // it is. Appended and never prefixed: the engine's words are what the reader needs to
        // search for, and rewriting them would put this product's account in front of the
        // server's.
        unavailable:
          `${oracleErrorSentence(error)}\n` +
          `ALL_OBJECTS shows ${owner}.${name} is there and visible to this session, so ORA-31603 above reports ` +
          "a privilege this session does not hold for reading the definition, not a missing object.",
      };
    }
    if (typeof value !== "string") {
      // NOT a refusal and not an empty text. A non-string here means the CLOB fetch handler
      // did not reach the driver, which is a defect in this file rather than a fact about the
      // object, and reporting a defect of ours as the engine's answer is how a reader comes
      // to believe their database is broken.
      throw new QueryError(
        `Oracle answered the definition of ${owner}.${name} as ${typeof value} rather than a string, so the CLOB ` +
          "fetch handler did not reach the driver",
        "oracle",
      );
    }
    const marker = wrapFormatMarker(value, owner, name);
    if (marker !== undefined) {
      return {
        outcome: "refused",
        unavailable:
          `Oracle returned this definition WRAPPED: DBMS_METADATA wrote the keyword "wrapped" where a plain unit ` +
          `carries its parameter list, RETURN, IS or AS, and the wrap format marker "${marker}" on the next line. ` +
          "The original PL/SQL text is not in the database; only the DBMS_DDL encoder's output is.",
      };
    }
    if (value.trim() === "") {
      // An empty definition is not a definition, and an empty editor over one is the hazard
      // the whole source surface exists to remove.
      return {
        outcome: "refused",
        unavailable: `DBMS_METADATA.GET_DDL('${type.metadata}', ...) answered an empty definition for ${owner}.${name}.`,
      };
    }
    return { outcome: "text", text: value };
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      // Left UNDEFINED, and spread conditionally into the return below.
      // `HealthInfo.activeConnections` is optional precisely so a user who cannot read
      // V$SESSION omits the figure instead of sending a fabricated 0, and this is the
      // reading the agent forwards to the model (`src/lib/agent/tools.ts` projects it
      // with `?? null`), so an initial 0 made a refused view indistinguishable from an
      // idle instance. V$SESSION needs the same `V_$` grant as everything else here,
      // and that refusal was measured 2026-08-23 on Oracle AI Database 26ai Free
      // against a user granted only CREATE SESSION: `ORA-00942: table or view
      // "SYS"."V_$SYSSTAT" does not exist`. V_$SESSION answers ORA-00942 in the same
      // shape when the grant is missing.
      let activeConnections: number | undefined;
      let databaseSize = "N/A";
      let cacheHitRatio: string = CACHE_HIT_RATIO_UNAVAILABLE;
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await conn.execute(`SELECT COUNT(*) AS CNT FROM V$SESSION WHERE STATUS = 'ACTIVE'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const rows = (connRes.rows || []) as Record<string, unknown>[];
        // measuredNumber, not `Number(... || 0)`: an instance with no ACTIVE session
        // answers 0 and that 0 is a reading, so the falsy test would have thrown away
        // the very figure it was meant to publish. Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(rows[0]?.CNT);
      } catch {
        /* V$SESSION requires privileges; the figure stays absent, never 0. */
      }

      // Database size
      try {
        const sizeRes = await conn.execute(
          `SELECT ROUND(SUM(BYTES) / 1024 / 1024, 2) AS SIZE_MB FROM USER_SEGMENTS`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const sizeRows = (sizeRes.rows || []) as Record<string, unknown>[];
        const mb = Number(sizeRows[0]?.SIZE_MB || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch {
        /* ignore */
      }

      // Cache hit ratio. `|| 0` used to publish "0%" for a reading Oracle never
      // took, and the Overview card rates 0 as "Needs tuning" - so a user who
      // simply cannot read V$SYSSTAT saw a cache fault. The two ways the reading
      // goes absent, both measured 2026-08-23 on Oracle AI Database 26ai Free: a user granted
      // only CREATE SESSION gets `ORA-00942: table or view "SYS"."V_$SYSSTAT" does
      // not exist` (the catch below), and a zero counter denominator gives one row
      // of `<NULL>` through NULLIF (measuredNumber).
      try {
        const cacheRes = await conn.execute(CACHE_HIT_RATIO_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const cacheRows = (cacheRes.rows || []) as Record<string, unknown>[];
        const ratio = measuredNumber(cacheRows[0]?.HIT_RATIO);
        if (ratio !== undefined) cacheHitRatio = `${formatCacheHitRatio(ratio)}%`;
      } catch {
        /* V$SYSSTAT requires privileges; the initial "N/A" stands. */
      }

      // Slow queries
      try {
        const slowRes = await conn.execute(HEALTH_SLOW_QUERIES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        for (const row of (slowRes.rows || []) as Record<string, unknown>[]) {
          slowQueries.push({
            query: String(row.QUERY || ""),
            calls: Number(row.CALLS || 0),
            avgTime: String(row.AVGTIME || "N/A"),
          });
        }
      } catch {
        /* V$SQL requires privileges */
      }

      // Active sessions
      try {
        const sessRes = await conn.execute(HEALTH_ACTIVE_SESSIONS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        for (const row of (sessRes.rows || []) as Record<string, unknown>[]) {
          activeSessions.push({
            pid: String(row.SID || ""),
            user: String(row.USERNAME || "unknown"),
            database: String(row.DATABASE || ""),
            state: String(row.STATUS || "unknown"),
            query: String(row.QUERY || ""),
            duration: String(row.DURATION || "N/A"),
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
    } finally {
      if (conn) await conn.close();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string, container?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let conn: oracledb.Connection | undefined;
      try {
        conn = await this.pool!.getConnection();
        let sql = "";

        // What stands in the owner position of the DBMS_STATS calls: the connected user
        // when the caller named no container, else the container as a quoted literal.
        // `USER` is a keyword rather than a string, so it is NOT quoted.
        const ownerArg = container ? `'${container.replace(/'/g, "''")}'` : "USER";

        switch (type) {
          case "analyze":
            // `USER` is the connected user, so an owner named by the caller is passed
            // through instead. Both arguments are inline-escaped literals because
            // DBMS_STATS takes no binds for them, and an owner is upper-cased the way the
            // data dictionary stores it unless the caller quoted the identifier.
            sql = target
              ? `BEGIN DBMS_STATS.GATHER_TABLE_STATS(${ownerArg}, '${target.replace(/'/g, "''")}'); END;`
              : `BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(${ownerArg}); END;`;
            break;
          case "optimize":
            return await this.rebuildIndexes(conn, target, container);
          case "kill":
            if (!target) {
              throw new QueryError("Target SID,SERIAL# is required for kill operation", "oracle");
            }
            sql = `ALTER SYSTEM KILL SESSION '${target.replace(/'/g, "''")}'`;
            break;
        }

        // Unsupported types fall through the switch with sql left empty. A
        // `default:` label is deliberately avoided here: bun's coverage emits
        // a 0-hit line record for `default:` that no runtime execution ever
        // credits, which permanently poisons the merged lcov report.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type: ${type}`, "oracle");
        }

        await conn.execute(sql);
        return { success: true, message: `${type.toUpperCase()} completed successfully` };
      } finally {
        if (conn) await conn.close();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  /**
   * `optimize`: rebuild the indexes ONE table owns, or every normal index in the
   * schema when the caller named nothing.
   *
   * The target is a TABLE NAME, because a table name is the only thing the two
   * maintenance surfaces have to send - both take it from the object browser's rows.
   * This used to build `ALTER INDEX "<target>" REBUILD` straight from that argument,
   * so every per-table click answered *ORA-01418: specified index does not exist*
   * (reproduced against Oracle AI Database 26ai Free on 2026-08-25). SQL Server's identically
   * worded control is `ALTER INDEX ALL ON [<t>] REBUILD`, and this is that shape:
   * Oracle has no `ALTER INDEX ALL`, so the index names come from `USER_INDEXES`
   * first.
   *
   * A table with no rebuildable index succeeds having rebuilt nothing - "nothing to
   * do" is not a failure, and a heap table with no index is an ordinary state. One
   * index failing does not fail the run either (an offline tablespace or an unusable
   * partition stops that index alone), which is the choice the whole-schema form
   * already made and the reason each rebuild carries its own try/catch; the message
   * says how many of the table's indexes were rebuilt, because "success" alone cannot
   * distinguish 2 of 2 from 1 of 2.
   *
   * An EMPTY index list has a second cause, and it is not "nothing to do": a target the
   * catalog does not know. A name that is not a table of this schema - including a real
   * table spelled in the wrong case, since Oracle stores unquoted names folded to upper
   * case - answered `{"success": true}` in ~1 ms having done nothing at all (measured
   * against ldb-oracle-r5, Oracle AI Database 26ai Free Release 23.26.2.0.0, on
   * 2026-08-25). A target the catalog cannot resolve is a failed operation, so the two
   * are told apart with `TABLE_IS_KNOWN_SQL` - asked ONLY when the index list came back
   * empty, so the ordinary path stays at one catalog read.
   */
  private async rebuildIndexes(
    conn: oracledb.Connection,
    target?: string,
    owner?: string,
  ): Promise<{ success: boolean; message: string }> {
    // The table name is a bind here, unlike the inline-escaped literals elsewhere in
    // runMaintenance: this one sits in a WHERE clause, which does take a bind. An owner
    // switches the question to the `ALL_*` catalogs, which answer for any schema rather
    // than the connected one.
    const indexes = owner
      ? target
        ? await conn.execute(OWNED_TABLE_INDEXES_SQL, [owner, target], { outFormat: oracledb.OUT_FORMAT_OBJECT })
        : await conn.execute(OWNED_SCHEMA_NORMAL_INDEXES_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT })
      : target
        ? await conn.execute(TABLE_INDEXES_SQL, [target], { outFormat: oracledb.OUT_FORMAT_OBJECT })
        : await conn.execute(SCHEMA_NORMAL_INDEXES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    const rows = (indexes.rows || []) as Record<string, unknown>[];

    if (target && rows.length === 0) {
      const known = owner
        ? await conn.execute(OWNED_TABLE_IS_KNOWN_SQL, [owner, target], { outFormat: oracledb.OUT_FORMAT_OBJECT })
        : await conn.execute(TABLE_IS_KNOWN_SQL, [target], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (((known.rows || []) as unknown[]).length === 0) {
        return {
          success: false,
          // Two causes and one sentence, because the catalog cannot tell them apart from
          // here: a name that is nothing in this schema, and a name that is a VIEW or a
          // synonym - `USER_TABLES` holds neither, and rebuilding an index is not a thing
          // either can be asked to do. Measured on ldb-oracle-r5: a real view answers this
          // too, and blaming only the spelling would misdirect a caller who spelled it
          // right. `USER_TABLES` does hold a materialized view's container table, so that
          // case reaches the rebuild rather than this branch.
          message: `OPTIMIZE failed: ${owner ? `the schema "${owner}"` : "this schema"} owns no TABLE named ${target}. A view or a synonym has no index to rebuild, and an unquoted name is folded to upper case, so a lower-case spelling will not match the catalog.`,
        };
      }
    }

    let rebuilt = 0;
    // The engine's first refusal, kept rather than discarded: with every rebuild failing,
    // "rebuilt 0 of 2" states the count and withholds the only part an operator can act
    // on. Measured on a table whose tablespace is READ ONLY (ldb-oracle-r5, Oracle AI
    // Database 26ai Free Release 23.26.2.0.0, 2026-08-25): every rebuild answers ORA-01647
    // and this reported success in 14 ms.
    let firstFailure: string | undefined;
    for (const row of rows) {
      try {
        await conn.execute(`ALTER INDEX "${String(row.INDEX_NAME).replace(/"/g, '""')}" REBUILD`);
        rebuilt++;
      } catch (error) {
        // One index failing is still a completed run (an offline tablespace or an unusable
        // partition stops that index alone), which is the choice the whole-schema form
        // already made - so the reason is recorded and the loop goes on.
        firstFailure ??= error instanceof Error ? error.message : String(error);
      }
    }

    // None of them rebuilding is a different fact from some of them rebuilding: nothing
    // the operation was asked to do happened, so it did not succeed. A table with no index
    // at all keeps its success above - `rows.length === 0` never enters this branch.
    if (rebuilt === 0 && rows.length > 0) {
      return {
        success: false,
        message: `OPTIMIZE failed: rebuilt 0 of ${rows.length} indexes. ${firstFailure ?? ""}`.trim(),
      };
    }

    return { success: true, message: `OPTIMIZE: rebuilt ${rebuilt} of ${rows.length} indexes.` };
  }

  // ============================================================================
  // Pool Statistics
  // ============================================================================

  public getPoolStats() {
    if (!this.pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: this.pool.connectionsOpen,
      idle: this.pool.connectionsOpen - this.pool.connectionsInUse,
      active: this.pool.connectionsInUse,
      waiting: 0,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let version = "Oracle";
      let uptime = "N/A";
      let startTime: Date | undefined;
      // Left UNDEFINED, and spread conditionally into the return below - the same
      // shape `getHealth()` above uses, for the same reason. `DatabaseOverview.activeConnections`
      // is optional precisely so a user who cannot read V$SESSION omits the figure
      // instead of publishing a fabricated 0, and the monitoring Overview card reads
      // the absence as "N/A / not published" while a 0 is drawn as a real count and
      // added as a real sample to the connections trend
      // (`src/components/monitoring/tabs/OverviewTab.tsx`). The card's threshold rating
      // is the same either way: the V$PARAMETER ceiling is read inside the same try
      // below, so a refusal leaves maxConnections 0 as well and the card's percentage
      // is null on both paths. Oracle's Database Reference
      // states that after installation only SYS or a SYSDBA can read the dynamic
      // performance tables, so a plain schema user hitting ORA-00942 here is the
      // ordinary case rather than an exotic one.
      let activeConnections: number | undefined;
      // NOT made optional alongside it: `maxConnections` is a published ceiling where
      // 0 MEANS "no limit published", so 0 and absence are the SAME fact there.
      let maxConnections = 0;
      // Left UNDEFINED and spread conditionally too, for the reason the count above is:
      // `DatabaseOverview.databaseSizeBytes` is optional because absence and zero are
      // different facts, and a USER_SEGMENTS read that does not answer says nothing
      // about how much the schema holds. Unlike the count above this is NOT a
      // privilege story - USER_* views describe the caller's own objects, so §7.2's
      // V_$ refusal does not gate it, and no failure of this statement has been
      // measured on a live instance; whatever reaches the catch, the catch cannot
      // name it. StorageTab.tsx keys its whole breakdown off
      // `databaseSizeBytes !== undefined`, so the old `0` initialiser drew that
      // breakdown over a schema it never measured, instead of "No storage size
      // information available." - and drew it against per-table bytes from
      // getTableStats(), a separate read that does not share this statement's failure,
      // so the rows contradicted the total they were shares of. `databaseSize` moves
      // with the figure for the same reason: both monitoring tabs render that string
      // as the headline size, so a leftover "0 bytes" printed a confident zero beside
      // that message. "N/A" while the bytes are unknown is the shape merged for libSQL
      // (#569) and the search provider (#517). See docs/providers/oracle.md section 7.3.
      let databaseSize = "N/A";
      let databaseSizeBytes: number | undefined;
      let tableCount = 0;
      let indexCount = 0;

      // Version and uptime
      try {
        const vRes = await conn.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const vRows = (vRes.rows || []) as Record<string, unknown>[];
        if (vRows[0]?.BANNER) version = String(vRows[0].BANNER);
      } catch {
        /* ignore */
      }

      try {
        const upRes = await conn.execute(
          `SELECT STARTUP_TIME, (SYSDATE - STARTUP_TIME) * 86400 AS UPTIME_SECS FROM V$INSTANCE`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const upRows = (upRes.rows || []) as Record<string, unknown>[];
        if (upRows[0]) {
          const secs = Number(upRows[0].UPTIME_SECS || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          if (upRows[0].STARTUP_TIME) startTime = new Date(String(upRows[0].STARTUP_TIME));
        }
      } catch {
        /* ignore */
      }

      // Connections
      try {
        const sessRes = await conn.execute(`SELECT COUNT(*) AS CNT FROM V$SESSION WHERE TYPE = 'USER'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        // measuredNumber, not `Number(... || 0)`: a COUNT of 0 is a reading, so the
        // falsy test would have thrown away the very figure it was meant to publish.
        // Only an unanswered COUNT stays absent. The assignment deliberately precedes
        // the ceiling read below, so a refused V$PARAMETER cannot carry this count away.
        activeConnections = measuredNumber(((sessRes.rows || []) as Record<string, unknown>[])[0]?.CNT);

        const maxRes = await conn.execute(`SELECT VALUE FROM V$PARAMETER WHERE NAME = 'sessions'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        maxConnections = Number(((maxRes.rows || []) as Record<string, unknown>[])[0]?.VALUE || 0);
      } catch {
        /* Both V$ views need privileges: a refused count stays absent, never 0, while a
           refused ceiling leaves the 0 that already means "no limit published". */
      }

      // Database size
      try {
        const sizeRes = await conn.execute(`SELECT SUM(BYTES) AS TOTAL FROM USER_SEGMENTS`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const sizeRows = (sizeRes.rows || []) as Record<string, unknown>[];
        databaseSizeBytes = measuredNullableAggregate(sizeRows[0], "TOTAL");
        if (databaseSizeBytes !== undefined) databaseSize = formatBytes(databaseSizeBytes);
      } catch {
        /* The size stays absent, never 0, and `databaseSize` keeps the "N/A" it was
           initialised with. */
      }

      // Table and index counts
      try {
        const cntRes = await conn.execute(OVERVIEW_OBJECT_COUNTS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const cntRows = (cntRes.rows || []) as Record<string, unknown>[];
        tableCount = Number(cntRows[0]?.TABLE_COUNT || 0);
        indexCount = Number(cntRows[0]?.INDEX_COUNT || 0);
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
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let cacheHitRatio: number | undefined;

      try {
        const cacheRes = await conn.execute(CACHE_HIT_RATIO_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const rows = (cacheRes.rows || []) as Record<string, unknown>[];
        cacheHitRatio = measuredNumber(rows[0]?.HIT_RATIO);
      } catch {
        /* V$SYSSTAT requires privileges; nothing was measured, so nothing is reported. */
      }

      return {
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        // bufferPoolUsage is gone rather than merely absent. It used to be assigned
        // `cacheHitRatio` itself - the same number under a second name, which the
        // Performance tab then drew as a separate gauge and rated separately. Oracle
        // does publish buffer pool occupancy, but in V$BUFFER_POOL_STATISTICS /
        // V$SGASTAT, which this method does not query; until it does there is
        // nothing here to report.
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `${SLOW_QUERIES_BODY_SQL} WHERE ROWNUM <= ${Math.max(1, Math.trunc(Number(limit)) || 1)}`,
        [],
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        },
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => ({
        queryId: String(r.QUERY_ID || ""),
        query: String(r.QUERY || ""),
        calls: Number(r.CALLS || 0),
        totalTime: Number(r.TOTAL_TIME || 0),
        avgTime: Number(r.AVG_TIME || 0),
        rows: Number(r.ROW_CNT || 0),
        sharedBlksHit: Number(r.BUF_GETS || 0),
        sharedBlksRead: Number(r.DISK_READS || 0),
      }));
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `${ACTIVE_SESSIONS_BODY_SQL} WHERE ROWNUM <= ${Math.max(1, Math.trunc(Number(limit)) || 1)}`,
        [],
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        },
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const secs = Number(r.DURATION_SECS || 0);
        const durationStr =
          secs > 3600
            ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
            : secs > 60
              ? `${Math.floor(secs / 60)}m ${secs % 60}s`
              : `${secs}s`;

        return {
          pid: `${r.SID},${r["SERIAL#"]}`,
          user: String(r.USERNAME || "unknown"),
          database: String(r.SCHEMANAME || ""),
          applicationName: String(r.PROGRAM || ""),
          clientAddr: String(r.MACHINE || ""),
          state: String(r.STATUS || "unknown"),
          query: String(r.QUERY || r.SQL_ID || ""),
          queryStart: r.LOGON_TIME ? new Date(String(r.LOGON_TIME)) : undefined,
          duration: durationStr,
          durationMs: secs * 1000,
          waitEventType: r.WAIT_CLASS ? String(r.WAIT_CLASS) : undefined,
          waitEvent: r.EVENT ? String(r.EVENT) : undefined,
          blocked: false,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || "";

      const res = await conn.execute(TABLE_STATS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const tableSizeBytes = Number(r.TABLE_SIZE_BYTES || 0);
        const indexSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ""),
          rowCount: Number(r.ROW_COUNT || 0),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          totalSize: formatBytes(tableSizeBytes + indexSizeBytes),
          totalSizeBytes: tableSizeBytes + indexSizeBytes,
          lastAnalyze: r.LAST_ANALYZED ? new Date(String(r.LAST_ANALYZED)) : undefined,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || "";

      const res = await conn.execute(INDEX_STATS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      // Get columns for each index
      const colRes = await conn.execute(INDEX_COLUMNS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      const colMap = new Map<string, string[]>();
      for (const c of (colRes.rows || []) as Record<string, unknown>[]) {
        const idxName = String(c.INDEX_NAME || "");
        if (!colMap.has(idxName)) colMap.set(idxName, []);
        colMap.get(idxName)!.push(String(c.COLUMN_NAME || ""));
      }

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const idxName = String(r.INDEX_NAME || "");
        const idxSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ""),
          indexName: idxName,
          indexType: String(r.INDEX_TYPE || ""),
          columns: colMap.get(idxName) || [],
          isUnique: String(r.UNIQUENESS || "") === "UNIQUE",
          isPrimary: false,
          indexSize: formatBytes(idxSizeBytes),
          indexSizeBytes: idxSizeBytes,
          scans: 0,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const results: StorageStats[] = [];

      // Try DBA tablespaces first, fallback to USER
      try {
        const tsRes = await conn.execute(STORAGE_DBA_FILES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

        for (const row of (tsRes.rows || []) as Record<string, unknown>[]) {
          const sizeBytes = Number(row.SIZE_BYTES || 0);
          results.push({
            name: String(row.NAME || ""),
            size: formatBytes(sizeBytes),
            sizeBytes,
          });
        }
      } catch {
        // Fallback: user segments
        try {
          const segRes = await conn.execute(STORAGE_USER_SEGMENTS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

          for (const row of (segRes.rows || []) as Record<string, unknown>[]) {
            const sizeBytes = Number(row.SIZE_BYTES || 0);
            results.push({
              name: String(row.NAME || ""),
              size: formatBytes(sizeBytes),
              sizeBytes,
            });
          }
        } catch {
          /* ignore */
        }
      }

      return results;
    } finally {
      if (conn) await conn.close();
    }
  }
}
