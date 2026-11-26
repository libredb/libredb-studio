/**
 * Studio's review of a policy, MCP or connection claim for each engine it ships, as tests read it: one member of every
 * legacy row of the grant register, `@libredb/grant-register`, as a table keyed by engine. The rows are read through
 * the grant reader's own `legacyGrantRows`, over the same served set, so a test reads exactly the review rows the grant
 * reader composes its records from, and never a granted table. The agent credential member is read narrowed, through
 * the grant reader's own `legacyAgentCredentials`, as the grant reader hands it to `grantClaims`.
 */
import { type RegisterGrants, readGrantRegister } from "@libredb/grant-register";
import { legacyAgentCredentials, legacyGrantRows } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS, type SeedAgentCredential } from "@/lib/db/connection-fields";
import type { DatabaseType } from "@/lib/types";

/** Every shipped engine's legacy row's grants, keyed by engine. */
const LEGACY_ROWS = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), SHIPPED_DATABASE_TYPES);

/** Member `M` of every shipped engine's legacy row, keyed by engine. */
export type LegacyRegisterTable<M extends keyof RegisterGrants> = Readonly<Record<DatabaseType, RegisterGrants[M]>>;

/** `table`, keyed by the shipped engines, read as keyed by `DatabaseType`: the helper's one key cast. */
function byEngine<T>(table: Readonly<Record<string, T>>): Readonly<Record<DatabaseType, T>> {
  return table as Readonly<Record<DatabaseType, T>>;
}

/** Member `member` of every shipped engine's legacy row, keyed by engine in the shipped order, frozen. */
export function legacyRegisterTable<M extends keyof RegisterGrants>(member: M): LegacyRegisterTable<M> {
  return byEngine(
    Object.freeze(Object.fromEntries(Object.entries(LEGACY_ROWS).map(([engine, grants]) => [engine, grants[member]]))),
  );
}

/**
 * Every shipped engine's legacy agent credential, each superseding field narrowed to the engine's connection fields,
 * keyed by engine in the shipped order, frozen: the table the grant reader composes for `grantClaims`.
 */
export function legacyAgentCredentialTable(): Readonly<Record<DatabaseType, SeedAgentCredential | null>> {
  return byEngine(legacyAgentCredentials(LEGACY_ROWS, CONNECTION_FIELDS));
}
