import { RequestRefusal } from "@/lib/db/console/dialect";
import { parseQdrantRequest, qdrantPhase0 } from "./request";

/**
 * The browser's verdict on a Qdrant console text: the grammar and every rule that needs neither the schema nor the
 * server's version, the same two functions the provider runs first, so what the editor refuses and what the server
 * refuses for those rules are one reading.
 *
 * A text it refuses is never sent to any route and never written to query history. A version gate and a rule that
 * reads the collection are the server's to apply.
 */

/** The operations that ask for a confirmation: none, because every route the console runs is a read. */
export const QDRANT_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The sentence a statement is refused with, or undefined to send it. */
export function qdrantRefusal(text: string): string | undefined {
  try {
    qdrantPhase0(parseQdrantRequest(text));
    return undefined;
  } catch (error) {
    if (error instanceof RequestRefusal) return error.message;
    throw error;
  }
}

/**
 * What a text would run, for the confirmation gate: the class of its route as a one-element list, or undefined for
 * a text the console refuses. A route that is not a read would ask by its class, with no change to the gate.
 */
export function readQdrantOperations(text: string): readonly string[] | undefined {
  try {
    return [qdrantPhase0(parseQdrantRequest(text)).route.class];
  } catch (error) {
    if (error instanceof RequestRefusal) return undefined;
    throw error;
  }
}
