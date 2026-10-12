/**
 * A Firestore statement as the editor's vocabulary row judges it (spec 3.1): the sentence the provider would refuse
 * it with, or null to send it. Pure and browser-safe. It runs the lexer, parser and compiler the server runs, against
 * a fixed target, because no refusal depends on the project; a statement it refuses is never sent.
 */
import { DEFAULT_DATABASE_ID } from "../constants";
import type { FirestoreTarget } from "../names";
import { compileStatement } from "./compile";
import { parseStatement } from "./parser";

export const GUARD_TARGET: FirestoreTarget = { projectId: "studio-guard", databaseId: DEFAULT_DATABASE_ID };

/** The refusal sentence, or null; never throws. */
export function firestoreRefusal(text: string): string | null {
  try {
    compileStatement(parseStatement(text), text, { target: GUARD_TARGET, explainButton: false });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
