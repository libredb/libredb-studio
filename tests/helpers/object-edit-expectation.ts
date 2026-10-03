import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/**
 * The Phase 3 census expectation, COMMITTED BEFORE ANY PROVIDER DECLARES ANYTHING (#789).
 *
 * This is the acceptance criterion written first, and it is written HERE rather than inside the
 * census so that a task which cannot make the census pass has to change a file that has its own
 * guard rather than quietly widening a literal next to the assertion it is failing.
 *
 * Transcribed from the Phase 3 design's day-one table, one row per (type-id, kind id), and NEVER
 * derived from a build: a census that derived its expectation from the build would agree with any
 * declaration whatsoever. When the two disagree, exactly one of them is wrong, and the repair is
 * to the DECLARATION or to the design, never to this file.
 *
 * The engine and version each pair was measured on: PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1),
 * Trino 476, Redis 8.10.0, etcd 3.7.2.
 */
export const EXPECTED_EDITABLE_KINDS: readonly (readonly [DatabaseType, string])[] = Object.freeze([
  ["postgres", "function"],
  ["postgres", "procedure"],
  ["redis", "function"],
  ["trino", "function"],
  // A key's value, edited through one guarded Txn (#1089 4.5), measured on etcd v3.7.2.
  ["etcd", "key"],
] as const);

/**
 * Every type-id that declares NO editable kind on day one, committed as a population rather than
 * left as "the rest", because a biconditional is satisfied by a population holding only one side
 * of it. Each one owes a section in its own provider doc naming which absence it is.
 */
export const EXPECTED_EDIT_ABSTAINERS: readonly DatabaseType[] = Object.freeze([
  "cassandra",
  "clickhouse",
  "couchbase",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: db2-node 1.0.22 decodes non-ASCII
  // text as EBCDIC 037, so a read-then-write-back would store corrupted text (#786), which
  // docs/providers/db2.md names.
  "db2",
  "druid",
  "duckdb",
  "elasticsearch",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: Kafka has writes, and this product
  // declines them in v1 by decision (#1088 sections 2 and 4.6), which docs/providers/kafka.md names.
  "kafka",
  "libredb",
  "libsql",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: v1 writes no data (vector-family spec 5.7), which docs/providers/milvus.md names.
  "milvus",
  "mongodb",
  "mssql",
  "mysql",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: the provider is read-only in its first
  // version and refuses every write before sending it (Neo4j spec 4.1, 5.5), which docs/providers/neo4j.md names.
  "neo4j",
  "opensearch",
  "oracle",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: the product offers no write
  // path to Prometheus at all (#1085 sections 2 and 4.5), which docs/providers/prometheus.md names.
  "prometheus",
  // No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: v1 runs reads only (vector-family spec 4.4), which docs/providers/qdrant.md names.
  "qdrant",
  "sqlite",
] as const);

/**
 * The fleet, driven from the shipped registry plus the embedded store, so a new engine is
 * censused the day it lands rather than being silently omitted.
 */
export const EDIT_CENSUS_TYPES: readonly DatabaseType[] = Object.freeze([
  ...EXTERNAL_DATABASE_TYPES,
  // NO `as DatabaseType` here. `libredb` is already a member of the union, so the assertion bought
  // nothing and would have SUPPRESSED the compile error if the id were ever renamed or dropped,
  // leaving the census counting seventeen against a sixteen-id fleet. MEASURED by renaming the id
  // to `libredbX` in both places: bare, `bun run typecheck` reports
  // `tests/helpers/object-edit-expectation.ts(52,14): error TS2322: Type
  // 'readonly (DatabaseType | "libredbX")[]' is not assignable to type 'readonly DatabaseType[]'`;
  // with `as DatabaseType` in front of it, the same rename compiles CLEAN (#789 Phase 3).
  "libredb",
]);
