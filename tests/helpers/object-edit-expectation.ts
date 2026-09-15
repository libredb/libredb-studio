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
 * Trino 476, Redis 8.10.0.
 */
export const EXPECTED_EDITABLE_KINDS: readonly (readonly [DatabaseType, string])[] = Object.freeze([
  ["postgres", "function"],
  ["postgres", "procedure"],
  ["redis", "function"],
  ["trino", "function"],
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
  "druid",
  "duckdb",
  "elasticsearch",
  "libredb",
  "libsql",
  "mongodb",
  "mssql",
  "mysql",
  "opensearch",
  "oracle",
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
