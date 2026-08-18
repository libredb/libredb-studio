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
export const SHIPPED_DATABASE_TYPES: readonly DatabaseType[] = [
  "postgres",
  "mysql",
  "sqlite",
  "oracle",
  "mssql",
  "clickhouse",
  "druid",
  "mongodb",
  "couchbase",
  "redis",
  "libredb",
];

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
 * Verified relatives, each measured by a live gate-4 probe on 2026-08-18.
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
