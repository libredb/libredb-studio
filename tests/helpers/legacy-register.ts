/**
 * Studio's review of a claim the grant register holds, or of a host fact no declaration requests, for each engine it
 * ships, as tests read it: one member of every legacy row of the grant register, `@libredb/grant-register`, as a table
 * keyed by engine, or a boolean member as the list of engines it holds true for. The rows are read through the grant reader's own `legacyGrantRows`, over the same served set, so a
 * test reads exactly the review rows the grant reader grants each legacy engine from, and never a granted table. The
 * agent credential member is read narrowed, through the grant reader's own `legacyAgentCredentials`, as
 * `grantEngineClaims` narrows it.
 */
import { type RegisterGrants, readGrantRegister } from "@libredb/grant-register";
import { legacyAgentCredentials, legacyGrantRows } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BODY_CONNECTION_FIELDS, type SeedAgentCredential } from "@/lib/db/connection-fields";
import type { DatabaseType } from "@/lib/types";

/** Every shipped engine's legacy row, keyed by engine. */
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
    Object.freeze(Object.fromEntries(Object.entries(LEGACY_ROWS).map(([engine, row]) => [engine, row.grants[member]]))),
  );
}

/** The members of a legacy row's grants that hold a boolean. */
type BooleanMember = {
  readonly [M in keyof RegisterGrants]: RegisterGrants[M] extends boolean ? M : never;
}[keyof RegisterGrants];

/** The shipped engines whose legacy row grants boolean member `member` true, in the shipped order, frozen. */
export function legacyRegisterEngines(member: BooleanMember): readonly DatabaseType[] {
  return Object.freeze(SHIPPED_DATABASE_TYPES.filter((engine) => LEGACY_ROWS[engine].grants[member]));
}

/**
 * Every shipped engine's legacy agent credential, each superseding field narrowed to the text fields a connection form
 * draws, keyed by engine in the shipped order, frozen: each the credential `grantEngineClaims` reads from the row.
 */
export function legacyAgentCredentialTable(): Readonly<Record<DatabaseType, SeedAgentCredential | null>> {
  const grants = Object.fromEntries(Object.entries(LEGACY_ROWS).map(([engine, row]) => [engine, row.grants]));
  return byEngine(legacyAgentCredentials(grants, BODY_CONNECTION_FIELDS));
}
