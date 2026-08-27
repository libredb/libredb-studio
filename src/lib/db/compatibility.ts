/**
 * Wire-compatibility registry (issue #424, Phase 0).
 *
 * Some engines speak the wire protocol of a driver we already ship, so they work
 * through an existing provider with no code of their own. This module is the one
 * place that records which ones, and it deliberately records only what a live
 * probe measured:
 *
 * - `probedVersion` is the version string the engine itself reported during a
 *   gate-4 probe. It is not a supported range and not a guess. An entry without
 *   one fails the unit tests, which is how #424's claim discipline ("connects is
 *   not supported") is enforced rather than merely written down.
 * - `tier` exists because the probes refuted the assumption behind a boolean.
 *   Citus answers all fifteen introspection surfaces; Materialize answers none of
 *   them while still running SQL fine. Both "work", and publishing them under one
 *   word would be the overclaim the issue warns about.
 * - `caveats` are what the probe found broken or misleading, in the user's terms.
 *
 * Two consumers read this: the connection dialog (so a MariaDB user knows to pick
 * MySQL) and the compatibility table in `docs/providers/README.md`. Neither may
 * hold its own copy of the data.
 */
import type { DatabaseType } from "@/lib/types";

/**
 * The drivers we ship, i.e. the engines that have a provider, a doc page and an
 * integration test of their own. Kept here beside the registry because the
 * published count is "shipped drivers + verified relatives" and both halves must
 * come from the same module or they drift.
 */
const SHIPPED: Readonly<Record<DatabaseType, true>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  // libSQL (#424 Phase 5): its own provider, doc and integration test. A separate
  // driver from `sqlite` rather than a relative of it - the two share a dialect and
  // nothing else, since one holds a file handle and the other speaks HTTP.
  libsql: true,
  // DuckDB (#424): its own provider, doc and integration test. It is a driver rather
  // than a relative of anything - it speaks no PostgreSQL or MySQL wire protocol, and
  // there is no wire at all, so no engine can be compatible with it by pretending to
  // be it. Nothing is recorded as a relative below for that reason.
  duckdb: true,
  oracle: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  // Apache Cassandra (#424 Phase 4). ScyllaDB speaks the same CQL wire and is
  // recorded as a relative below: the gate-4 probe ran on 2026-08-21/22 and measured
  // eight of this provider's thirteen surfaces answering, with the five that read
  // Cassandra's `system_views` virtual tables failing because ScyllaDB has no such
  // keyspace. All thirteen answer since 2026-08-24 - re-probed then - but the five
  // answer EMPTY, which is why the tier below is still `partial`.
  cassandra: true,
  // Two ids served by ONE provider module (`providers/sql/search/`), which is the
  // first time "shipped" here does not mean one provider file per id. They are still
  // two entries because the tri-sync invariant is per type-id - each has its own doc
  // page and its own integration test - and because the published count counts what
  // a user can pick, not how the code is laid out.
  elasticsearch: true,
  opensearch: true,
  mongodb: true,
  couchbase: true,
  redis: true,
  libredb: true,
});

/**
 * Derived from an exhaustive Record on purpose. As a hand-written array this was
 * the one mandatory registration surface in the codebase with no guard at all: a
 * new type-id omitted here made the published count undercount, nothing failed,
 * and the unit test that checked the count read the same constant on both sides.
 * With the Record the compiler refuses the omission, which is the same technique
 * `src/lib/sql/fence-tags.ts` already uses over this union.
 */
export const SHIPPED_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(Object.keys(SHIPPED) as DatabaseType[]);

/**
 * Which shipped ids are databases a user already runs, and which one is not.
 *
 * `libredb` is the embedded store this app carries with it; the other sixteen are
 * external engines you point the product at. Everything published as a database
 * count means the external sixteen - README.md's "sixteen drivers reach
 * forty-two named engines", the login hero's engine claim - so the split needs a
 * definition somewhere, and it belongs beside `SHIPPED` rather than in the UI that
 * prints it. That is the same reason `SHIPPED` itself lives here.
 *
 * An exhaustive Record again, so a new type-id cannot join without someone
 * answering the question. The alternative - filtering `libredb` out by name at each
 * call site - is how the two halves of a published count drift apart.
 */
const EXTERNAL: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  libsql: true,
  // The user's own file, opened from a path they give us - the same reading as
  // `sqlite` below, and external for the same reason.
  duckdb: true,
  oracle: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  cassandra: true,
  elasticsearch: true,
  opensearch: true,
  mongodb: true,
  couchbase: true,
  redis: true,
  // The one false entry. SQLite is a file rather than a server and is still
  // external: it is the user's file, opened from a path they give us. libredb is
  // ours, created by this app, so it is the only id that answers no here.
  libredb: false,
});

/** The shipped ids that are databases a user already runs, in registry order. */
export const EXTERNAL_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(
  SHIPPED_DATABASE_TYPES.filter((type) => EXTERNAL[type]),
);

/** True for every shipped id except the embedded store. */
export function isExternalDatabaseType(type: DatabaseType): boolean {
  return EXTERNAL[type] === true;
}

/**
 * How much of the product works against a wire-compatible engine.
 *
 * - `full` - every introspection surface answered. Caveats may still record data
 *   that is present but inaccurate, which is why a `full` engine can have them.
 * - `partial` - some surfaces answered, some did not. The editor works; parts of
 *   the browser or the monitoring dashboard are blank.
 * - `query-only` - the SQL editor works and nothing else does. Usable, but not as
 *   a managed database.
 */
export type CompatibilityTier = "full" | "partial" | "query-only";

export interface WireCompatibleEngine {
  /** The engine's name as a user would say it, e.g. "MariaDB". */
  name: string;
  /** The shipped type-id whose driver serves it unchanged. */
  via: DatabaseType;
  /** How much of the product worked during the probe. */
  tier: CompatibilityTier;
  /** The exact server version a live gate-4 probe reported. Never a range. */
  probedVersion: string;
  /** One-line, user-facing notes on what does not work or misleads. */
  caveats: readonly string[];
}

/**
 * Verified relatives, each measured by a live gate-4 probe on 2026-08-18, with
 * TimescaleDB, YugabyteDB, TiDB and StarRocks added from a second probe run on
 * 2026-08-20, Apache Cloudberry and Vitess from a third run the same day,
 * AlloyDB Omni from a fourth run the same day, OceanBase Community Edition
 * and SingleStore from a fifth run the same day, ScyllaDB from a sixth run on
 * 2026-08-21/22, Apache Doris, Garnet and both Percona distributions from a seventh run
 * on 2026-08-26, and ParadeDB, OrioleDB and Databend from an eighth on 2026-08-27.
 * Names still awaiting an instance are tracked in issue #424, never here: there
 * is no "pending" state on purpose, because a reader cannot tell a pending entry
 * from a probed one. A name that WAS probed and did not earn an entry has no
 * representation here either - Cloud Spanner's PostgreSQL dialect answered 1 of 15
 * surfaces, and QuestDB 10.0.1 failed the one surface a query-only row exists to claim -
 * so those results are recorded in `docs/providers/README.md` beside this table, with the
 * number that refused each of them.
 *
 * QuestDB is the entry NOT to add back without re-reading that section. It looks like a
 * query-only relative from the provider's side and is not one from the product's: the
 * editor always attaches a `queryId`, the provider then issues `SELECT pg_backend_pid()`
 * first, and QuestDB has no such function - so `provider.query(sql)` answers three rows
 * while pressing Run answers a 500. Same shape as Cloud Spanner, found the same way,
 * and only in a browser.
 */
export const WIRE_COMPATIBLE_ENGINES: readonly WireCompatibleEngine[] = [
  {
    name: "Citus",
    via: "postgres",
    tier: "full",
    probedVersion: "citus 14.1-1 on PostgreSQL 18.4",
    caveats: [
      "Row counts and sizes for a distributed table are wrong rather than missing: PostgreSQL statistics describe only the empty coordinator parent, not the shards.",
      "The citus_tables and citus_schemas views appear in the object browser alongside your own tables.",
    ],
  },
  {
    name: "CockroachDB",
    via: "postgres",
    tier: "partial",
    probedVersion: "CockroachDB CCL v26.2.5",
    caveats: [
      "The object browser is empty: CockroachDB has no pg_total_relation_size() builtin, which our schema query calls.",
      "Health, overview, monitoring, table, index and storage panels are unavailable: pg_size_pretty(), pg_postmaster_start_time() and pg_tablespace_location() do not exist there.",
      "Performance metrics, slow queries and active sessions do work: the pg_stat_* views CockroachDB provides are enough for them.",
    ],
  },
  {
    name: "Materialize",
    via: "postgres",
    tier: "query-only",
    probedVersion: "Materialize 26.37.0 (advertises PostgreSQL 9.5)",
    caveats: [
      "Only the SQL editor works. The object browser, the monitoring dashboard and every statistics panel are unavailable.",
      "Materialize has no pg statistics catalog and no size functions, and it reserves the MATERIALIZED keyword our schema query uses.",
    ],
  },
  {
    name: "RisingWave",
    via: "postgres",
    tier: "query-only",
    probedVersion: "RisingWave 3.0.3 (advertises PostgreSQL 13.14.0)",
    caveats: [
      "Only the SQL editor works. The object browser, the monitoring dashboard and every statistics panel are unavailable.",
      "RisingWave rejects a parameterised LIMIT, so the slow-query and active-session panels cannot run at all.",
    ],
  },
  {
    name: "OrioleDB",
    via: "postgres",
    tier: "full",
    probedVersion: "OrioleDB beta 16 on PostgreSQL 18.4 (nightly of 2026-08-24)",
    caveats: [
      "All fifteen surfaces answer, the object browser is clean (2 objects for 2 user tables) and row counts are exact - 2000 read as 2000 - with a foreign key and its indexes read back.",
      "Every index reads 0 bytes in the object browser and the table statistics: an OrioleDB table keeps its indexes in its own storage and pg_indexes_size() returns 0 for it, the same shape as YugabyteDB's DocDB.",
      "The cache hit ratio is absent rather than wrong: OrioleDB has its own buffer manager, so pg_statio_user_tables stays at 0 hits and 0 reads and the panel reads N/A.",
      "version() DOES name OrioleDB, and the string carries the build hash and date, because the project publishes nightly images only - there is no released tag to pin.",
    ],
  },
  {
    name: "TimescaleDB",
    via: "postgres",
    tier: "full",
    probedVersion: "TimescaleDB 2.29.2 on PostgreSQL 17.11",
    caveats: [
      "Row counts and sizes for a hypertable are wrong rather than missing: PostgreSQL statistics describe the empty parent table, not the chunks the rows live in.",
      "Every chunk of a hypertable appears as its own table and index, so the object browser fills with _timescaledb_internal chunks and the _timescaledb_catalog and _timescaledb_cache schemas.",
      "The overview shows the PostgreSQL version, not the TimescaleDB extension version.",
      "The agent cannot ground a run on a stock install: its schema capture is one row per column against a 200-row budget, and the extension's own catalogs answer 473 of 478 rows before the user has created anything.",
    ],
  },
  {
    name: "YugabyteDB",
    via: "postgres",
    tier: "full",
    probedVersion: "YugabyteDB 2.25.2.0-b0 (advertises PostgreSQL 15.12)",
    caveats: [
      "Row counts and sizes read 0 until someone runs ANALYZE on the table, so a full database can look empty in the object browser.",
      "Index sizes always read 0 bytes, before and after ANALYZE: index storage lives in DocDB, where pg_relation_size() cannot see it.",
      "The overview's database size reads 0 bytes even with populated tables.",
      "Index types read lsm rather than btree - that is YugabyteDB's real storage, not a misreading.",
    ],
  },
  {
    name: "Apache Cloudberry (incubating)",
    via: "postgres",
    tier: "partial",
    probedVersion: "PostgreSQL 14.4 (Apache Cloudberry 2.1.0-incubating)",
    caveats: [
      'The monitoring dashboard, table statistics and index statistics are unavailable: all three fail with the same engine error, "query plan with multiple segworker groups is not supported", which is Cloudberry\'s MPP planner restriction rather than a missing catalog.',
      "Row counts and sizes read after ANALYZE are correct - 2000 rows for 2000 rows and 576 KB for 589824 bytes - so the object browser here is not the kind that misleads; what they read before ANALYZE was not probed.",
      "Two internal tables appear in the object browser, pg_ext_aux.pg_pax_fastsequence and pg_ext_aux.pg_pax_tables, so it lists 4 objects for 2 user tables.",
      "A foreign key is read back as if it were enforced but is not: Cloudberry accepts ALTER TABLE ... ADD CONSTRAINT with a warning that referential integrity constraints are not supported, and an orphan insert then succeeds.",
      "The overview's database size reads 62 MB against roughly 900 KB of user tables, which is catalog and segment overhead rather than your data.",
      "The agent cannot ground a run: connecting as the cluster's own gpadmin is refused because the execution profile reads that role as too broad, and a least-privilege agent role is refused at 289 rows against a 200-row budget, 282 of those rows belonging to Cloudberry's own gp_toolkit schema.",
      "Apache publishes build images only, so the probe ran on a third-party image (woblerr/cloudberry:2.1.0-incubating); no image from the project itself was measured.",
    ],
  },
  {
    name: "AlloyDB Omni",
    via: "postgres",
    tier: "full",
    probedVersion: "PostgreSQL 17.9 (AlloyDB Omni 17.9.0)",
    caveats: [
      'The version panel cannot be told apart from a stock PostgreSQL 17: version() reports only "PostgreSQL 17.9 on x86_64-pc-linux-gnu" and names AlloyDB nowhere, so the product identity is visible only in the alloydb.* settings and in the image tag.',
      "Row counts and sizes are exact, checked against the engine: 2000 rows read as 2000, and 270336 total bytes as 270336 (180224 table plus 90112 index). Foreign keys are both read back and enforced.",
      "Eight of AlloyDB's own google_ml tables appear in the object browser, so it lists 10 objects for 2 user tables: auth_info, embed_gen_progress, embed_gen_settings, model_family_info, models, native_models, proxy_models_query_mapping and supported_vertex_models.",
      "The browser understates what the image installed: outside the system schemas there are 70 objects for 2 user tables, because 49 extension VIEWS are installed into public itself (g_columnar_* x27, google_db_advisor_* x18, g_agg_stat_statements, g_lap_timer, hypopg_list_indexes and a columnar vectorized-join view), plus 4 views in ai and 11 more in google_ml. They are hidden only because the schema query filters table_type = 'BASE TABLE'.",
      "Those eight google_ml tables are readable by a role with no grants at all: a LOGIN role given only CONNECT, with ALL revoked on schema public, still lists them and answered SELECT count(*) FROM google_ml.supported_vertex_models with 15 rows.",
      'The slow-query panel is always empty and health says why: pg_stat_statements ships with the image but is not installed in it, reported as "pg_stat_statements extension not enabled".',
      "The columnar engine is off by default and turning it on needs ALTER SYSTEM plus a restart, not a reload. With it on, the on-disk sizes stay exact but do not count the columnar copy.",
      "The agent cannot ground a run: the image's own postgres superuser is refused as too broad, and a least-privilege role acquires both profiles but has its schema capture refused at 536 rows against a 200-row budget, of which only 7 are the user's - 341 of the rest are the 49 extension views installed into public itself, so narrowing the capture to public alone still refuses at 348 rows (B52).",
      "Probed on the 17.9.0 image only; the 15.x and 16.x lines were not probed.",
    ],
  },
  {
    // Read this entry beside OrioleDB below: both are `full`, and what each costs the user
    // is the opposite of the other. ParadeDB's cost is WIDTH - nine extensions in the
    // object browser - and OrioleDB's is DEPTH, its own storage being invisible to
    // PostgreSQL's size functions. Neither caveat belongs on the other row.
    name: "ParadeDB",
    via: "postgres",
    tier: "full",
    probedVersion: "ParadeDB 0.25.4 on PostgreSQL 18.6",
    caveats: [
      "All fifteen surfaces answer and the numbers are correct, but the object browser lists 41 objects for 2 user tables and 74 indexes: ParadeDB ships nine extensions, and PostGIS, its tiger geocoder, pg_ivm and paradedb's own tables are all in there.",
      "Agent plan mode WORKS here, and the reason is worth knowing because the opposite was expected: the grounding capture reads what the ROLE can see, and an unprivileged role sees 168 columns where a superuser sees 539 - the tiger geocoder's 425 are not readable - so the capture stays under its 200-row ceiling and a plan run grounded on 21 tables. Connect as a least-privilege role, not as a superuser: the execution profile refuses a superuser outright, on any PostgreSQL.",
      "version() names PostgreSQL only, so the version panel cannot tell a ParadeDB apart from a stock PostgreSQL 18.6. The release is in the image tag, nowhere the provider reads.",
    ],
  },
  {
    // The drop-in pair, and they are two entries rather than one because they are served by
    // two different drivers - the invariant here is one row per (engine, driver) claim.
    // Read them together anyway: the measurements are identical except for which of the two
    // publishes its own name where the provider looks.
    name: "Percona Distribution for PostgreSQL",
    via: "postgres",
    tier: "full",
    probedVersion: "Percona Server for PostgreSQL 18.6.1 on PostgreSQL 18.6",
    caveats: [
      "Behaves as PostgreSQL throughout: all fifteen surfaces answer, row counts and sizes are correct (2000 rows read as 2000, 131072 bytes as 131072), and a foreign key is read back with its indexes.",
      "The version panel names Percona, unlike the MySQL distribution below: version() answers PostgreSQL 18.6 - Percona Server for PostgreSQL 18.6.1, so there is nothing to mistake for stock PostgreSQL.",
      "Slow queries are empty until pg_stat_statements is enabled, which is stock PostgreSQL behaviour and not a Percona property.",
    ],
  },
  {
    name: "MariaDB",
    via: "mysql",
    tier: "full",
    probedVersion: "12.3.2-MariaDB-ubu2404",
    caveats: [
      "The version shown is MariaDB's full build string, including its OS suffix, not a MySQL-style number.",
      "performance_schema ships OFF (@@performance_schema = 0), so the cache-hit, queries-per-second and buffer-pool figures are absent and the slow-query list is empty until the server is started with performance_schema=ON. Everything the schema tree, sizes, sessions and EXPLAIN need comes from information_schema and is unaffected.",
      "Verified on MariaDB 12.3 only; the 10.x information_schema surface was not probed.",
    ],
  },
  {
    name: "Percona Server for MySQL",
    via: "mysql",
    tier: "full",
    probedVersion: "Percona Server for MySQL 8.4.11-11 (version() reports 8.4.11-11)",
    caveats: [
      "Behaves as MySQL throughout: all fifteen surfaces answer, row counts and sizes are correct (2000 rows read as 2000, 114688 bytes as 114688), indexes and a foreign key are read back, and Analyze, Optimize and Check all succeed.",
      "Nothing on screen says Percona: version() answers a bare 8.4.11-11 and the product name lives in @@version_comment (Percona Server (GPL), Release 11), which the provider does not read - so the overview is indistinguishable from a stock MySQL 8.4.",
    ],
  },
  {
    name: "TiDB",
    via: "mysql",
    tier: "full",
    probedVersion: "8.0.11-TiDB-v8.5.1",
    caveats: [
      "A freshly loaded table reads 0 rows and 0 B until TiDB's own background statistics collection catches up; the numbers correct themselves with no ANALYZE.",
      "Max connections reads 0, because TiDB's max_connections defaults to 0 meaning unlimited.",
      "The slow-query panel is always empty: TiDB keeps its slow log in information_schema.SLOW_QUERY, not in the performance_schema view the provider reads.",
      "Storage stats list a phantom InnoDB entry at ibdata1:12M:autoextend, which is a MySQL default echoed back by a server that has no InnoDB.",
      "The Explain panel does not work: TiDB rejects EXPLAIN FORMAT='json' outright, so the editor's plan request fails while the query itself runs normally.",
      "Probed on a standalone --store=unistore server only; a PD + TiKV deployment was not probed.",
    ],
  },
  {
    name: "StarRocks",
    via: "mysql",
    tier: "partial",
    probedVersion: "StarRocks 3.3.22-753696f (version() reports 5.1.0)",
    caveats: [
      "The version shown is MySQL 5.1: version() returns a fictitious compatibility number, and the real build is only in current_version(), which the provider does not call.",
      "The overview and health panels are unavailable: StarRocks refuses their statements through the prepared-statement protocol the provider uses.",
      "Active sessions and the monitoring dashboard are unavailable: StarRocks has no information_schema.PROCESSLIST.",
      "Row counts and sizes are always 0: information_schema.TABLES reports 0 rows and 0 bytes for a populated table.",
      "No index information at all: StarRocks exposes no secondary-index catalog, so the object browser and the index panel show none.",
      "The Explain panel does not work: StarRocks does not parse EXPLAIN FORMAT='json', so the editor's plan request fails while the query itself runs normally.",
    ],
  },
  {
    // Placed next to StarRocks because StarRocks is a FORK of Doris, and this registry
    // had been carrying the fork while missing the original. The neighbouring rows are
    // the reason to read both: they share the fictitious version() and the empty index
    // catalog, and they differ on the numbers, which is the half a reader acts on.
    // Doris reported 2000 rows and 10187 bytes for a table holding exactly that, where
    // StarRocks reports hard zeros - so a fork's row is a prior for the next probe and
    // never an inheritance.
    name: "Apache Doris",
    via: "mysql",
    tier: "partial",
    probedVersion: "Apache Doris 4.1.3-rc02-7126cf65d96 (version() reports 5.7.99)",
    caveats: [
      "The overview and health panels are unavailable, and one statement form is the whole reason: Doris parses SHOW STATUS but rejects the LIKE filter both panels use, so they fail with a syntax error instead of reading an empty result.",
      "The version shown is MySQL 5.7.99: version() returns a fictitious compatibility number, the real build is only in @@version_comment, and Doris has no current_version() function to read it from.",
      "No index information at all: information_schema.statistics is empty on Doris, so the index panel and the object browser report none however many keys a table declares.",
      "A declared foreign key is invisible and unenforced: Doris accepts ADD CONSTRAINT ... FOREIGN KEY and lists it in SHOW CONSTRAINTS, but information_schema.KEY_COLUMN_USAGE is empty, so the ER diagram draws no relationship - and an orphan row inserts successfully, because the constraint is a planner hint there.",
      "Optimize and Check are unavailable: neither statement exists in the Doris grammar. Analyze works.",
      "The Explain panel does not work: Doris rejects EXPLAIN FORMAT='json', while a plain EXPLAIN runs in the editor.",
      "Row counts and sizes are correct but late: a table read 0 rows and 0 B immediately after a 2000-row insert and the true 2000 rows / 10187 bytes about a minute later, with an ANALYZE in between changing nothing. The lag is self-correcting, so a freshly loaded table looks empty for a while.",
      "A UNIQUE KEY table declares no primary key to the product: information_schema reports COLUMN_KEY as UNI rather than PRI, so the object browser marks no column primary.",
    ],
  },
  {
    name: "Databend",
    via: "mysql",
    tier: "query-only",
    probedVersion: "Databend v1.2.925-patch-11 (advertises MySQL 8.0.90)",
    caveats: [
      "The SQL editor works and a plain EXPLAIN shows Databend's own plan. Nothing else does: the object browser, every statistics panel and the monitoring dashboard are unavailable.",
      "The cause is ours rather than Databend's, which is why the catalogs are worth naming: asked with literal SQL, information_schema.tables answers the true 3 and 2000 rows with sizes. Every parameterised read fails instead with Prepare is not support in Databend, because those still go through mysql2's prepared protocol.",
      "Databend has no SHOW STATUS statement at all and no information_schema.processlist, so the overview, health and session panels have no source even once the protocol question is settled.",
      "Strings must be single-quoted: Databend follows the SQL standard and reads a double-quoted value as an identifier, so a double-quoted literal is an unknown-column error.",
      "EXPLAIN FORMAT='json' does not parse, and neither Optimize nor Check exists. Analyze runs but the provider mis-reads its reply.",
    ],
  },
  {
    name: "Vitess",
    via: "mysql",
    tier: "full",
    probedVersion: "8.0.43-Vitess (Vitess 24.0.2)",
    caveats: [
      "Cancelling a running query does nothing: vtgate refuses KILL QUERY with VT07001 and the statement runs to completion, so a 5 second SLEEP still took its full 5003 ms after the cancel.",
      "Table and index statistics name the physical shard database (vt_probe_0), not the keyspace the connection points at.",
      "Per-index sizes always read 0 bytes: the size query matches information_schema.INNODB_TABLES.NAME against '<database>/%', and Vitess names the InnoDB table after the shard database, so on a keyspace called probe nothing matches.",
      "Setting a session variable can fail where reading it works: SET @@cte_max_recursion_depth is rejected with VT05006 unknown system variable, while SELECT @@cte_max_recursion_depth answers 1000.",
      "Probed on an unsharded single-shard keyspace only (show vitess_shards returns probe/0); nothing here is measured about a sharded keyspace.",
      "No permission-error class could be measured, and the reason is the test image rather than Vitess: vttestserver accepts any username with any password and grants it full rights, and CREATE USER is a vtgate parse error, so no restricted role could be created to test with.",
    ],
  },
  {
    name: "OceanBase",
    via: "mysql",
    tier: "partial",
    probedVersion: "5.7.25-OceanBase_CE-v4.4.2.1",
    caveats: [
      "Fourteen of the fifteen surfaces return without throwing, but only twelve of them do their job, which is what makes this partial rather than full.",
      "Health is the one hard failure: the tenant has no performance_schema database at all (ERROR 1049 Unknown database 'performance_schema'). Health passes on the MySQL 26.7.0 baseline probed in the same pass, so this is the engine's.",
      "Performance metrics and storage stats are answered but useless, and the overview, table statistics and index statistics carry useless zeros in their size fields while their row and structure data is real.",
      "Every size reads 0 B - table, index, database and storage - because OceanBase reports DATA_LENGTH 0 and INDEX_LENGTH 0 in information_schema.TABLES.",
      "Storage stats list a phantom InnoDB row at ibdata1:12M:autoextend whose size reads N/A: OceanBase fakes innodb_data_file_path for compatibility and there is no such file.",
      "The slow-query panel reads 0 rows, which is an honest empty rather than a fabricated number.",
      "The header badge reads Slow rather than Online, and it does not mean latency: the badge is set from whether the health request succeeded, and health is the one surface this engine refuses.",
      "Row counts are correct once ANALYZE TABLE has run - 2000 reported for 2000 real - and it must be the MySQL-mode statement: the Oracle-mode ANALYZE TABLE t COMPUTE STATISTICS is rejected with ERROR 1235.",
      "The object browser is clean, 2 objects for 2 user tables: the schema query scopes to TABLE_SCHEMA and to TABLE_TYPE = 'BASE TABLE', and OceanBase's own 860 + 70 + 18 catalog objects are all SYSTEM TABLE or SYSTEM VIEW, so neither filter admits them.",
      "A foreign key is both read back and enforced (an orphan insert is refused with ERROR 1452), but OceanBase creates no backing index for one, so index counts will not match an equivalent MySQL schema.",
      "Cancelling a running query genuinely cancels it, and the Explain panel genuinely describes without executing: an 11-row ASCII plan with an EST.ROWS column.",
      "Sign in to the BUSINESS tenant rather than sys: MODE=mini creates a user tenant named test, so the login is root@test, and the sys tenant exposes nine databases including Oracle-mode artifacts (LBACSYS, ORAAUDITOR, SYS, ocs, sys_external_tbs) that the user tenant does not have.",
      "Probed on the oceanbase/oceanbase-ce:4.4.2-lts image with MODE=mini only.",
    ],
  },
  {
    name: "SingleStore",
    via: "mysql",
    tier: "partial",
    probedVersion: "SingleStoreDB 9.1.1 (advertises MySQL 5.7.32)",
    caveats: [
      'Ten of the fifteen surfaces answer. Test Connection, health, the overview and the monitoring dashboard all fail with one engine message, "This command is not supported in the prepared statement protocol yet", and the Explain panel fails with a syntax error on EXPLAIN FORMAT=JSON.',
      "No version is displayed anywhere, because the panel that carries it is one of the unavailable ones. Were it fixed it would read MySQL 5.7.32, the wire version SingleStore advertises, not SingleStoreDB 9.1.1.",
      "Row counts and sizes are missing rather than wrong: a 2000-row table reads rowCount 0 and 0 B in the object browser, the table statistics and the storage panel, against a ground truth of 2000 rows and 77046 bytes measured four independent ways.",
      "SingleStore leaves information_schema.TABLES zeroed and keeps the real numbers elsewhere - SHOW TABLE STATUS, information_schema.OPTIMIZER_STATISTICS.ROW_COUNT and the EXPLAIN plan's est_table_rows - and running ANALYZE does not change what the panels read.",
      "The index panel lists 4 rows for 2 tables against the MySQL baseline's 2: SingleStore auto-creates a shard key on every table and reports it as an index named __SHARDKEY with indexType SHARD, beside PRIMARY.",
      "Foreign keys do not exist: ALTER TABLE ... ADD FOREIGN KEY fails with ERROR 2752, and with SET GLOBAL ignore_foreign_keys = ON a CREATE TABLE carrying an inline foreign key is accepted and the constraint silently stripped, which is the one shape where a user could believe they have a key they do not.",
      "Of the maintenance actions, Analyze works; Optimize and Check fail with the same prepared-statement error.",
      "The header badge reads Slow rather than Online, and it does not mean latency: the badge is set from whether the health request succeeded, and health is one of the surfaces refused over the prepared-statement protocol.",
      "Permission errors are identical to MySQL and surface with the server's own text intact, and under a SELECT-only role the table list correctly showed only the granted table.",
      "The dev image needs no licence key: it self-licenses with ROOT_PASSWORD as the only variable set, its log recording an unlimited expiration and the Developer Image edition.",
      "Probed on the ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82 image only.",
    ],
  },
  {
    name: "Valkey",
    via: "redis",
    tier: "full",
    probedVersion: "Valkey 9.1.1",
    caveats: ["The overview shows Valkey's Redis emulation level (7.2.4), not the Valkey version."],
  },
  {
    name: "DragonflyDB",
    via: "redis",
    tier: "full",
    probedVersion: "DragonflyDB df-v1.40.1",
    caveats: [
      "The overview shows DragonflyDB's Redis emulation level (7.4.0), not the Dragonfly version.",
      "Max connections reads 0, because Dragonfly's INFO reports no usable maxclients.",
      "Active sessions show a numeric id instead of a username: Dragonfly's CLIENT LIST sets name= to the connection id.",
      "Every active session reads idle with state N: Dragonfly's CLIENT LIST carries no cmd= or flags= field.",
    ],
  },
  {
    name: "KeyDB",
    via: "redis",
    tier: "full",
    probedVersion: "KeyDB 6.3.4",
    caveats: [
      "KeyDB publishes no version field of its own, so the overview cannot be told apart from a Redis 6 server.",
      'An active session\'s command can appear without its subcommand ("client" rather than "client|list").',
    ],
  },
  {
    // The fourth Redis relative and the only one that publishes its own version while the
    // product shows the emulation level anyway: `garnet_version` and `server_name` are both
    // in its INFO output. Valkey and DragonflyDB publish only an emulation level, and KeyDB
    // publishes nothing of its own, so on those three the displayed version is the best
    // available reading. Here it is not.
    name: "Garnet",
    via: "redis",
    tier: "full",
    probedVersion: "Garnet 2.1.5 (advertises Redis 7.4.3)",
    caveats: [
      "The overview shows the Redis emulation level (7.4.3), not Garnet's version. Unlike the other Redis relatives, Garnet does publish its own - garnet_version:2.1.5 and server_name:garnet in INFO - and the provider reads redis_version instead.",
      "Every size reads 0 B: Garnet's INFO publishes no used_memory field at all, so the database size and the memory storage panel are a derived zero rather than a measurement.",
      "The cache hit ratio reads 100%: Garnet publishes neither keyspace_hits nor keyspace_misses, and 100 is the fallback both counters being absent produces (D14).",
      "Max connections reads 0, as on DragonflyDB: Garnet publishes no maxclients.",
      "Connected clients reads 0 even with a client attached, because Garnet's connected_clients stays 0; the session list itself is correct and shows the connection.",
      "Key prefixes group as expected: 71 keys across user:*, session:* and queue:* were read back as three patterns.",
    ],
  },
  {
    name: "FerretDB",
    via: "mongodb",
    tier: "full",
    probedVersion: "FerretDB 2.7.0 (MongoDB 7.0.77 wire)",
    caveats: [
      "Sign in with the credentials of FerretDB's PostgreSQL backend; authMechanism=PLAIN is rejected.",
      "The version shown is the MongoDB wire version FerretDB advertises, not its own build number.",
      "FerretDB needs its own PostgreSQL backend, so it is a two-container deployment rather than one image.",
    ],
  },
  {
    name: "ScyllaDB",
    via: "cassandra",
    tier: "partial",
    probedVersion: "ScyllaDB 2026.2.4-0.20260810.e54224b8cebb (advertises Cassandra 3.0.8)",
    caveats: [
      "Every surface answers since 2026-08-24, but five answer EMPTY: the connection count, the cache hit ratio and the active-session list all read Cassandra's system_views virtual tables, which ScyllaDB does not have, so they degrade the way a denied grant does instead of failing the connection.",
      'Connections reads 0 rather than N/A on the monitoring dashboard, and that zero is the one number here the server did not measure: there is no field on the overview to say "not published", so a build with no system_views keyspace reports the same 0 a permission-denied role does.',
      "The overview, health, performance-metrics, active-session and monitoring surfaces used to throw, and Test Connection with them; the connection dialog gates its save on that request, so before 2026-08-24 a ScyllaDB connection could not be created in the dialog at all and had to arrive as a seeded or admin-managed one.",
      "The SQL editor and the object browser work in full: statements run, and every one of 18 CQL types read back byte-identically to Apache Cassandra 5.0.9 probed in the same pass.",
      "The version reads Apache Cassandra 3.0.8 - the compatibility number system.local publishes - not ScyllaDB 2026.2.4, which lives in system.versions where the provider does not look. Uptime is real: gossip_generation exists here and answers.",
      "The object browser lists one extra object per secondary index, and the tree and the overview disagree about it: ScyllaDB backs an index with a MATERIALIZED VIEW, so customers_country_idx_index appears in system_schema.views and the tree lists it, while the Tables count comes from system_schema.tables and does not (measured: 4 objects in the tree against tableCount 3). Cassandra lists neither.",
      'Error classes are identical to Cassandra even though the server\'s wording is not - a missing table is "unconfigured table" rather than "table ... does not exist" - because the provider classifies on the driver\'s error code rather than on the message text.',
      "Row counts and sizes are blank for the same reason as on Cassandra, and the panels read N/A rather than a fabricated zero.",
      'Creating a keyspace needs NetworkTopologyStrategy on the 2026.2 line: SimpleStrategy is refused outright with "SimpleStrategy doesn\'t support tablet replication", so the setup recipe in the Cassandra provider doc does not run unchanged.',
      "ScyllaDB 2025.1.14-0.20260612.103b84070f3b was probed in the 2026-08-21/22 pass and behaved identically on every surface, including the same verbatim refusal the fix keys on, so this entry describes both the 2025.1 and the 2026.2 line - but only these two builds, only a single-node container, and only 2026.2.4 was re-probed after the fix.",
    ],
  },
];

/** The verified relatives served by one shipped driver, in registry order. */
export function compatibleEnginesFor(type: DatabaseType): readonly WireCompatibleEngine[] {
  return WIRE_COMPATIBLE_ENGINES.filter((engine) => engine.via === type);
}

/**
 * The counting rule for #424's claim discipline: a published count is the external
 * engines plus the relatives an actual probe verified, and nothing else.
 *
 * Renamed from `verifiedEngineCount`, and the rename is the fix rather than a
 * tidy-up. That function counted `SHIPPED_DATABASE_TYPES`, which includes the
 * embedded store, so it answered 33 while README.md published 32 for the same
 * claim. Both numbers were defensible and neither said which set it was counting,
 * which is precisely the failure a single definition exists to prevent: a count is
 * wrong when its denominator is unstated, not when its digit is stale.
 *
 * The name now says the set. A product is countable here when a user can point the
 * app at it, so the embedded store is out of both halves of the sum.
 *
 * Still no runtime consumer: README.md and the docs table are markdown and quote the
 * number as prose, and the login hero prints the two halves separately - sixteen in
 * the proof row, twenty-six in the relatives line - rather than their sum. This exists
 * so the arithmetic has one definition, and the unit test pins it.
 */
export function connectableProductCount(): number {
  return EXTERNAL_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length;
}
