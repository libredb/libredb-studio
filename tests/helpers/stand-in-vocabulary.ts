import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * A confirmation-gate vocabulary row of a test's own, under a key no `DatabaseType` spells.
 *
 * The gate's `typedConfirmation` and `safetyAnalysis` fields have no engine that declares them until etcd's row
 * lands with its registration (#1089), and a row of `NON_SQL_DESTRUCTIVE_VOCABULARY` is the only input their readers
 * and `QuerySafetyDialog` take. So a test installs one here and removes it when it ends; every test file runs in a
 * bun process of its own, so no other file ever reads the table while the row is in it.
 */
export const STAND_IN_TYPE = "stand-in-typed-engine" as string as DatabaseType;

/** The two fields a stand-in row declares; the rest of the row asks about nothing and decides alone. */
export interface StandInFields {
  readonly typedConfirmation?: (text: string) => TypedConfirmationAsk | undefined;
  readonly safetyAnalysis?: false;
}

/** Installs the stand-in row with `fields` and returns the function that removes it. */
export function installStandInVocabulary(fields: StandInFields): () => void {
  const table = NON_SQL_DESTRUCTIVE_VOCABULARY as unknown as Record<string, unknown>;
  if (STAND_IN_TYPE in table) {
    throw new Error(`A stand-in vocabulary row is already installed under "${STAND_IN_TYPE}": remove it first`);
  }
  table[STAND_IN_TYPE] = { operations: new Set<string>(), read: () => [], decidesAlone: true, ...fields };
  return () => {
    delete table[STAND_IN_TYPE];
  };
}
