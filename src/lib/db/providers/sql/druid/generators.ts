/**
 * Druid's identifier quoting, collected as its row by `SQL_PORT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`, keyed by the Router port its declaration names.
 */
import type { SqlPortGenerators } from "@/lib/db/query-generators/types";

/** Apache Druid Router port, the capability signal for the Druid SQL dialect. */
const DRUID_PORT = 8888;

/**
 * Druid (Calcite SQL): quote unconditionally, as Couchbase does. A bare reserved word is a SYNTAX error, not a
 * column-not-found: `SELECT count FROM libredb_demo` fails with "Received an unexpected token [count FROM]", while
 * `SELECT "count" FROM libredb_demo` parses (issue #265). `count` is Druid's conventional rollup metric name, so the
 * standard rollup ingestion produces a datasource that has one. Calcite's reserved list is large and
 * version-dependent, so no safe unquoted subset is worth detecting.
 */
export const DRUID_SQL_GENERATORS = Object.freeze({
  port: DRUID_PORT,
  quote: (name) => `"${name.replaceAll('"', '""')}"`,
} satisfies SqlPortGenerators);
