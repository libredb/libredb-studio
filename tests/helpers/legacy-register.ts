/**
 * Studio's review of a policy or MCP claim for each engine it ships, as tests read it: one member of every legacy row
 * of the grant register, `@libredb/grant-register`, as a table keyed by engine. The rows are read through the grant
 * reader's own `legacyGrantRows`, over the same served set, so a test reads exactly the review rows the grant reader
 * composes its records from, and never a granted table.
 */
import { type RegisterGrants, readGrantRegister } from "@libredb/grant-register";
import { legacyGrantRows } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/** Every shipped engine's legacy row's grants, keyed by engine. */
const LEGACY_ROWS = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), SHIPPED_DATABASE_TYPES);

/** Member `M` of every shipped engine's legacy row, keyed by engine. */
export type LegacyRegisterTable<M extends keyof RegisterGrants> = Readonly<Record<DatabaseType, RegisterGrants[M]>>;

/** Member `member` of every shipped engine's legacy row, keyed by engine in the shipped order, frozen. */
export function legacyRegisterTable<M extends keyof RegisterGrants>(member: M): LegacyRegisterTable<M> {
  return Object.freeze(
    Object.fromEntries(Object.entries(LEGACY_ROWS).map(([engine, grants]) => [engine, grants[member]])),
  ) as LegacyRegisterTable<M>;
}
