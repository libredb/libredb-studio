import { dialectSpec } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";
import { DIALECT_EDITORS } from "@/lib/editor/dialect-editors";
import type { QueryTab } from "@/lib/types";

/** The Monaco language ids a query tab renders in, `QueryEditor`'s `language` prop. */
export type EditorLanguage =
  | "sql"
  | "json"
  | "libredb"
  | "redis"
  | "promql"
  | "etcd"
  | "graph-cypher"
  | "milvus"
  | "qdrant"
  | "influxql";

/**
 * The tab type a connection's tabs take.
 *
 * Order matters: the declared dialect is read BEFORE `queryLanguage`, because
 * Redis, LibreDB, Kafka and etcd declare `queryLanguage: "json"` while speaking neither
 * MongoDB JSON nor SQL. Getting that order wrong is exactly why the
 * `connection.type === "redis"` arm in Studio.tsx was unreachable dead code
 * before #427 — the json rung above it always matched first.
 *
 * Lives here rather than inline because the same ladder had been copied to four
 * call sites and had already drifted between them.
 *
 * A dialect's tab type is its record's `tabType` in `QUERY_DIALECTS` (`src/lib/db/query-dialects.ts`), so a
 * Kafka read request (#1088) and an etcdctl command line (#1089) are never typed `mongodb`. A dialect with no
 * record there, which only a host's own declaration can name, falls to the language rungs below, as it did
 * before the registry.
 *
 * `"promql"` (#1085) has a rung of its own because the fallback at the bottom is SQL: PromQL
 * declares no dialect and is not JSON, so without the rung a Prometheus tab would be typed
 * `sql` and its expression highlighted and completed as SQL.
 *
 * `"cypher"` (Neo4j spec 6.5) has a rung of its own for PromQL's reason: Cypher declares no dialect
 * and is not JSON, so without the rung a Neo4j tab would be typed `sql`. It renders in the
 * `graph-cypher` language `cypher-language.ts` registers over the graph layer's own lexer; the id is not
 * `cypher`, which Monaco's own bundle registers.
 *
 * `"influxql"` (InfluxDB spec 6.7) has a rung of its own for PromQL's reason: InfluxQL declares no dialect
 * and is not JSON, so without the rung an InfluxDB (InfluxQL) tab would be typed `sql`, and its `/.../`
 * regexes and backslash escapes highlighted and completed as SQL. It renders in the `influxql` language
 * `influxql-language.ts` registers over the provider's own lexer.
 */
export function resolveTabType(capabilities?: ProviderCapabilities | null): QueryTab["type"] {
  const dialect = dialectSpec(capabilities ?? undefined);
  if (dialect !== undefined) return dialect.tabType;
  if (capabilities?.queryLanguage === "json") return "mongodb";
  if (capabilities?.queryLanguage === "promql") return "promql";
  if (capabilities?.queryLanguage === "cypher") return "cypher";
  if (capabilities?.queryLanguage === "influxql") return "influxql";
  return "sql";
}

/**
 * The Monaco language id a tab type renders in (#427, #1085, #1088, #1089): its `DIALECT_EDITORS` record's
 * `monacoId` (`src/lib/editor/dialect-editors.ts`).
 *
 * A tab type this release has no record for, which a tab saved by a later release and restored here carries,
 * renders in `sql`, the answer this function always gave a type it did not name. So does a stored type that is
 * not a string: the restore path copies it from localStorage unchecked, and an own-key lookup would coerce
 * `["etcd"]` to `etcd`, or throw inside a render on an object whose `toString` is not callable.
 */
export function editorLanguageForTabType(type: QueryTab["type"]): EditorLanguage {
  const stored: unknown = type;
  return typeof stored === "string" && Object.hasOwn(DIALECT_EDITORS, stored)
    ? DIALECT_EDITORS[stored as QueryTab["type"]].monacoId
    : "sql";
}
