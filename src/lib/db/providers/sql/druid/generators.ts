/**
 * Druid's identifier quoting, collected as its row of `SQL_ENGINE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`, read under its type id.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/**
 * Druid (Calcite SQL): quote unconditionally, as Couchbase does. A bare reserved word is a SYNTAX error, not a
 * column-not-found: `SELECT count FROM libredb_demo` fails with "Received an unexpected token [count FROM]", while
 * `SELECT "count" FROM libredb_demo` parses (issue #265). `count` is Druid's conventional rollup metric name, so the
 * standard rollup ingestion produces a datasource that has one. Calcite's reserved list is large and
 * version-dependent, so no safe unquoted subset is worth detecting.
 */
export const DRUID_SQL_GENERATORS = Object.freeze({
  quote: (name) => `"${name.replaceAll('"', '""')}"`,
} satisfies SqlEngineGenerators);
