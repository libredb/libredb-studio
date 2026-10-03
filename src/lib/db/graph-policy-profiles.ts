/**
 * The graph engines' policy profiles, by type-id, for the browser (Neo4j spec 6.5, SR6).
 *
 * Cypher completion offers after `CALL` and `SHOW` exactly what the engine's read policy allows, so the
 * editor needs the profile of the connection it edits. It cannot import it: `src/lib/editor` stays free
 * of provider imports, and `src/lib/db/graph/` is the shared layer no provider is imported into. So the
 * lookup lives here, beside the other per-engine records of this directory that read a provider's pure
 * module (`destructive-commands.ts`), and `QueryEditor` hands what it answers to the completion provider
 * as it hands the SQL completion its `databaseType`.
 *
 * Keyed by type-id rather than branched on, and partial because only a graph engine has a profile; an
 * engine with none answers undefined.
 */
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import type { DatabaseType } from "@/lib/types";

const GRAPH_POLICY_PROFILES: Readonly<Partial<Record<DatabaseType, GraphPolicyProfile>>> = Object.freeze({
  neo4j: NEO4J_POLICY_PROFILE,
});

/** The policy profile of a graph engine; undefined for any other engine, or when the type is unknown. */
export function graphPolicyProfileOf(type: DatabaseType | undefined): GraphPolicyProfile | undefined {
  return type === undefined ? undefined : GRAPH_POLICY_PROFILES[type];
}
