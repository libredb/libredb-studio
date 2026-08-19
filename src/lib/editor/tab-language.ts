import type { ProviderCapabilities } from "@/lib/db/types";
import type { QueryTab } from "@/lib/types";

/**
 * The tab type a connection's tabs take.
 *
 * Order matters: `queryDialect` is checked BEFORE `queryLanguage`, because
 * Redis and LibreDB both declare `queryLanguage: "json"` while speaking neither
 * MongoDB JSON nor SQL. Getting that order wrong is exactly why the
 * `connection.type === "redis"` arm in Studio.tsx was unreachable dead code
 * before #427 — the json rung above it always matched first.
 *
 * Lives here rather than inline because the same ladder had been copied to four
 * call sites and had already drifted between them.
 */
export function resolveTabType(capabilities?: ProviderCapabilities | null): QueryTab["type"] {
  if (capabilities?.queryDialect === "libredb") return "libredb";
  if (capabilities?.queryDialect === "redis") return "redis";
  if (capabilities?.queryLanguage === "json") return "mongodb";
  return "sql";
}

/** The Monaco language id a tab type renders in (#427). */
export function editorLanguageForTabType(type: QueryTab["type"]): "sql" | "json" | "libredb" | "redis" {
  if (type === "libredb") return "libredb";
  if (type === "redis") return "redis";
  if (type === "mongodb") return "json";
  return "sql";
}
