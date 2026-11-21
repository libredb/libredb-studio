import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * A confirmation-gate vocabulary row of a test's own, under the type id `STAND_IN_TYPE`.
 *
 * A row of `NON_SQL_DESTRUCTIVE_VOCABULARY` is the only input the readers of the gate's `typedConfirmation` and
 * `safetyAnalysis` fields, `QuerySafetyDialog`, and the editor's `refuse` and `maxTextBytes` readers take (#1089;
 * Milvus's and Qdrant's rows are the shipped rows that declare the last two). So a test installs one here, which pins each rule
 * apart from any engine's grammar, and removes it when it ends; every test file runs in a bun process of its own,
 * so no other file ever reads the table while the row is in it. etcd's row, the one shipped row that declares both
 * of the first two fields, is pinned with its own commands in describe("the etcd row") of
 * `tests/unit/db/destructive-commands.test.ts` and describe("etcd's row") of `tests/components/QuerySafetyDialog.test.tsx`;
 * Milvus's and Qdrant's, in describe("the milvus row") and describe("the qdrant row") of the same unit file and
 * describe("the real milvus row") and describe("the real qdrant row") of `tests/hooks/use-query-execution.test.ts`.
 */
export const STAND_IN_TYPE: DatabaseType = "trino";

/**
 * Whether the shipped table already holds a row under `STAND_IN_TYPE`, read once when this module loads.
 *
 * `trino` is a type id whose text is SQL and which ships no vocabulary row, so every check that refuses a value outside
 * the `DatabaseType` union (FND-1) passes it and installing the stand-in replaces no shipped row; the texts the
 * stand-in tests use hold no run a SQL grammar could not resolve. If a `trino` row ever ships, the install refuses by
 * name instead of replacing it.
 */
const SHIPS_A_STAND_IN_ROW = Object.hasOwn(NON_SQL_DESTRUCTIVE_VOCABULARY, STAND_IN_TYPE);

/** The fields a stand-in row declares; the rest of the row asks about nothing and decides alone. */
export interface StandInFields {
  readonly typedConfirmation?: (text: string) => TypedConfirmationAsk | undefined;
  readonly safetyAnalysis?: false;
  readonly refuse?: (text: string) => string | undefined;
  readonly maxTextBytes?: number;
}

/** Installs the stand-in row with `fields` and returns the function that removes it. */
export function installStandInVocabulary(fields: StandInFields): () => void {
  if (SHIPS_A_STAND_IN_ROW) {
    throw new Error(
      `NON_SQL_DESTRUCTIVE_VOCABULARY ships a row under "${STAND_IN_TYPE}", so the stand-in would replace it: pick another stand-in type id`,
    );
  }
  const table = NON_SQL_DESTRUCTIVE_VOCABULARY as unknown as Record<string, unknown>;
  if (STAND_IN_TYPE in table) {
    throw new Error(`A stand-in vocabulary row is already installed under "${STAND_IN_TYPE}": remove it first`);
  }
  table[STAND_IN_TYPE] = { operations: new Set<string>(), read: () => [], decidesAlone: true, ...fields };
  return () => {
    delete table[STAND_IN_TYPE];
  };
}
