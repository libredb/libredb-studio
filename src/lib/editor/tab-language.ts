import type { ProviderCapabilities } from "@/lib/db/types";
import type { QueryTab } from "@/lib/types";

/**
 * The tab type a connection's tabs take.
 *
 * Order matters: `queryDialect` is checked BEFORE `queryLanguage`, because
 * Redis, LibreDB, Kafka and etcd declare `queryLanguage: "json"` while speaking neither
 * MongoDB JSON nor SQL. Getting that order wrong is exactly why the
 * `connection.type === "redis"` arm in Studio.tsx was unreachable dead code
 * before #427 — the json rung above it always matched first.
 *
 * Lives here rather than inline because the same ladder had been copied to four
 * call sites and had already drifted between them.
 *
 * `"promql"` (#1085) has a rung of its own because the fallback at the bottom is SQL: PromQL
 * declares no dialect and is not JSON, so without the rung a Prometheus tab would be typed
 * `sql` and its expression highlighted and completed as SQL.
 *
 * `"kafka"` (#1088) has a rung of its own above the json rung: a Kafka read request is JSON of this
 * product's own schema, never a MongoDB document, so without the rung a Kafka tab would be typed
 * `mongodb`. It still renders in Monaco's built-in `json` mode, and no language is registered for it
 * (#1088, section 3.3).
 *
 * `"etcd"` (#1089) has a rung of its own above the json rung for the same reason: an etcdctl command
 * line is no MongoDB document. It renders in the `etcd` language `etcd-language.ts` registers over the
 * provider's own lexer (#1089, section 3.3).
 *
 * `"cypher"` (Neo4j spec 6.5) has a rung of its own for PromQL's reason: Cypher declares no dialect
 * and is not JSON, so without the rung a Neo4j tab would be typed `sql`. It renders in the
 * `graph-cypher` language `cypher-language.ts` registers over the graph layer's own lexer; the id is not
 * `cypher`, which Monaco's own bundle registers.
 */
export function resolveTabType(capabilities?: ProviderCapabilities | null): QueryTab["type"] {
  if (capabilities?.queryDialect === "libredb") return "libredb";
  if (capabilities?.queryDialect === "redis") return "redis";
  if (capabilities?.queryDialect === "kafka") return "kafka";
  if (capabilities?.queryDialect === "etcd") return "etcd";
  if (capabilities?.queryLanguage === "json") return "mongodb";
  if (capabilities?.queryLanguage === "promql") return "promql";
  if (capabilities?.queryLanguage === "cypher") return "cypher";
  return "sql";
}

/** The Monaco language id a tab type renders in (#427, #1085, #1088, #1089, Neo4j spec 6.5). */
export function editorLanguageForTabType(
  type: QueryTab["type"],
): "sql" | "json" | "libredb" | "redis" | "promql" | "etcd" | "graph-cypher" {
  if (type === "libredb") return "libredb";
  if (type === "redis") return "redis";
  if (type === "kafka") return "json";
  if (type === "etcd") return "etcd";
  if (type === "mongodb") return "json";
  if (type === "promql") return "promql";
  if (type === "cypher") return "graph-cypher";
  return "sql";
}
