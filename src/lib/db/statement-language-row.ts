import type { EngineGrants } from "@/lib/db/claim-grants";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import type { TypedConfirmationAsk } from "@/lib/db/types";

/**
 * The confirmation gate's readers of one engine's statement language row, the row the gate is handed with the
 * statement and never looks up: what the row's reader names, whether the row is the gate's whole answer, and what the
 * row asks the person to type.
 *
 * A row has the shape `DestructiveVocabulary` in `./destructive-vocabulary.ts` states. Null is no row: the engine's
 * statements are SQL, or it states no SQL text, and the gate reads them under its grammar or asks about every one. This
 * module imports nothing but types and names no engine and no language, so the gate reads every engine's row through
 * the same steps, in the browser and on the server.
 */

/**
 * The grants of an engine's record the confirmation gate reads (`EngineGrants` in `./claim-grants.ts`): whether its
 * register row reviewed the grammar it declares, and the grant of each claim that loosens the gate for that grammar.
 */
export type GateGrants = Pick<EngineGrants, "reviewedGrammar" | "readsSqlText" | "confirmExemptForms" | "decidesAlone">;

/**
 * Whether `row`'s reader names an operation the row asks about in `statement`, handed as it was written: true where
 * the reader cannot tell what would run (`undefined`), false where it names none of the row's operations, and false
 * for no row.
 */
export function rowNamesAsked(row: DestructiveVocabulary | null, statement: string): boolean {
  if (row === null) return false;
  const named = row.read(statement);
  if (named === undefined) return true;
  return named.some((name) => row.operations.has(name));
}

/**
 * Whether `row` is the gate's whole answer: the row claims it (`decidesAlone`) and `grants`, the engine's record's
 * grants, grant that claim. A claim the grants leave out is read as if the row had not made it, so the gate reads the
 * text as SQL and reads the row beside it. False for no row.
 */
export function rowDecidesAlone(row: DestructiveVocabulary | null, grants: GateGrants): boolean {
  return row !== null && row.decidesAlone && grants.decidesAlone;
}

/**
 * What `row` asks the person to type before `statement` runs, or undefined where the row asks nothing typed, or for
 * no row (#1089, section 5.5). The text reaches the row as it was written.
 */
export function rowTypedAsk(row: DestructiveVocabulary | null, statement: string): TypedConfirmationAsk | undefined {
  return row?.typedConfirmation?.(statement);
}
