/**
 * The SNMP dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/** The object a tree click landed on: the last segment, which is the numbered name itself. */
function snmpObjectName(path: readonly string[]): string {
  return path[path.length - 1] ?? "";
}

/**
 * A tree click writes the statement this provider's own grammar reads, and nothing else: four words and a numbered
 * name. `walk` rather than `get`, because a click lands on a subtree and a Get of a subtree answers one object or
 * nothing at all.
 */
export const SNMP_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path: readonly string[]) => `walk ${snmpObjectName(path)}`,
  select: (path: readonly string[]) => `walk ${snmpObjectName(path)}`,
});
