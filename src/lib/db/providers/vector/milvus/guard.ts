/**
 * The browser's verdict on a Milvus console text (vector-family spec 3.4, 3.9, E10, VF9). Pure, and shipped to the
 * browser: the `milvus` row of the confirmation gate's vocabulary reads it.
 *
 * `milvusRefusal` is the row's `refuse`: the shared grammar over the Milvus table, then every phase 0 rule of
 * request.ts except the version gates, which only the server can apply. A text it refuses is never sent and never
 * stored. `readMilvusOperations` is the row's `read`: the route class from `classifyConsole`, for a text that
 * `milvusRefusal` accepts. No v1 route asks for a confirmation, because every one reads, so a later write route asks
 * by classifying as a write with no change to the gate.
 */
import { RequestRefusal } from "@/lib/db/console/dialect";
import { classifyConsole } from "@/lib/db/console/guard";
import { milvusPhase0, parseMilvusRequest } from "./request";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "./routes";

/** The operations the gate asks about: none in v1 (5.4, E10). */
export const MILVUS_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The browser does not know the connection's database, and no phase 0 rule depends on it. */
const ANY_DATABASE = { database: "default" };

/** The refusal sentence for `text`, or undefined to send it. */
export function milvusRefusal(text: string): string | undefined {
  try {
    milvusPhase0(parseMilvusRequest(text), ANY_DATABASE);
    return undefined;
  } catch (error) {
    // parseConsole and the phase 0 rules throw only refusals; anything else is a defect and propagates.
    if (!(error instanceof RequestRefusal)) throw error;
    return error.message;
  }
}

/** The route class of a text the guard accepts, as a one-element list; undefined for a refused text. */
export function readMilvusOperations(text: string): readonly string[] | undefined {
  if (milvusRefusal(text) !== undefined) return undefined;
  const verdict = classifyConsole(MILVUS_CONSOLE, MILVUS_ROUTES, text);
  return verdict === "refused" ? undefined : [verdict];
}
