import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * A confirmation-gate vocabulary row of a test's own, under a key no `DatabaseType` spells.
 *
 * A row of `NON_SQL_DESTRUCTIVE_VOCABULARY` is the only input the readers of the gate's `typedConfirmation` and
 * `safetyAnalysis` fields, `QuerySafetyDialog`, and the editor's `refuse` and `maxTextBytes` readers take (#1089;
 * Qdrant's row is the one shipped row that declares the last two). So a test installs one here, which pins each rule
 * apart from any engine's grammar, and removes it when it ends; every test file runs in a bun process of its own,
 * so no other file ever reads the table while the row is in it. etcd's row, the one shipped row that declares both
 * of the first two fields, is pinned with its own commands in describe("the etcd row") of
 * `tests/unit/db/destructive-commands.test.ts` and describe("etcd's row") of `tests/components/QuerySafetyDialog.test.tsx`;
 * Qdrant's, in describe("the qdrant row") of the same unit file and describe("the real qdrant row") of
 * `tests/hooks/use-query-execution.test.ts`.
 */
export const STAND_IN_TYPE = "stand-in-typed-engine" as string as DatabaseType;

/** The fields a stand-in row declares; the rest of the row asks about nothing and decides alone. */
export interface StandInFields {
  readonly typedConfirmation?: (text: string) => TypedConfirmationAsk | undefined;
  readonly safetyAnalysis?: false;
  readonly refuse?: (text: string) => string | undefined;
  readonly maxTextBytes?: number;
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
