/**
 * Druid's identifier quoting, bound by Studio's SQL generator function table (`SQL_GENERATOR_FUNCTIONS` in
 * `src/lib/db/query-generators/index.ts`) at the slot its name gives.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/**
 * Druid (Calcite SQL): quote unconditionally, as Couchbase does. A bare reserved word is a SYNTAX error, not a
 * column-not-found: `SELECT count FROM libredb_demo` fails with "Received an unexpected token [count FROM]", while
 * `SELECT "count" FROM libredb_demo` parses (issue #265). `count` is Druid's conventional rollup metric name, so the
 * standard rollup ingestion produces a datasource that has one. Calcite's reserved list is large and
 * version-dependent, so no safe unquoted subset is worth detecting.
 */
export const DRUID_GENERATOR_QUOTE: SqlEngineGenerators["quote"] = (name) => `"${name.replaceAll('"', '""')}"`;
