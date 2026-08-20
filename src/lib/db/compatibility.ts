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
  oracle: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  // Two ids served by ONE provider module (`providers/sql/search/`), which is the
  // first time "shipped" here does not mean one provider file per id. They are still
  // two entries because the tri-sync invariant is per type-id - each has its own doc
  // page and its own integration test - and because `verifiedEngineCount()` counts
  // what a user can pick, not how the code is laid out.
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
 * new type-id omitted here made `verifiedEngineCount()` undercount, nothing failed,
 * and the unit test that checked the count read the same constant on both sides.
 * With the Record the compiler refuses the omission, which is the same technique
 * `src/lib/sql/fence-tags.ts` already uses over this union.
 */
export const SHIPPED_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(Object.keys(SHIPPED) as DatabaseType[]);

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
 * 2026-08-20, and Apache Cloudberry and Vitess from a third run the same day.
 * Names still awaiting an instance are tracked in issue #424, never here: there
 * is no "pending" state on purpose, because a reader cannot tell a pending entry
 * from a probed one.
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
    name: "MariaDB",
    via: "mysql",
    tier: "full",
    probedVersion: "12.3.2-MariaDB-ubu2404",
    caveats: [
      "The version shown is MariaDB's full build string, including its OS suffix, not a MySQL-style number.",
      "Verified on MariaDB 12.3 only; the 10.x information_schema surface was not probed.",
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
      "Active sessions show a numeric id instead of a username: Dragonfly's CLIENT LIST omits the user field.",
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
];

/** The verified relatives served by one shipped driver, in registry order. */
export function compatibleEnginesFor(type: DatabaseType): readonly WireCompatibleEngine[] {
  return WIRE_COMPATIBLE_ENGINES.filter((engine) => engine.via === type);
}

/**
 * The counting rule for #424's claim discipline: a published count is the shipped
 * drivers plus the relatives an actual probe verified, and nothing else.
 *
 * No runtime consumer today - the README and the docs table are markdown and quote
 * the number as prose. This exists so the arithmetic has one definition instead of
 * being redone by hand in each place, and the unit test pins it. If a UI surface
 * ever prints the count, it reads it here rather than hardcoding it.
 */
export function verifiedEngineCount(): number {
  return SHIPPED_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length;
}
