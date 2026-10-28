/**
 * The OPC UA dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * What the OPC UA generators answer if they are ever reached, which would be a defect elsewhere.
 *
 * A sentence rather than empty text: empty text in the editor reads as "this engine generated
 * nothing useful", where this says what happened and where the value actually is.
 */
const UNREACHABLE_OPCUA_GENERATOR =
  "// An OPC UA node's value is read from the node itself, not from a generated statement: click the key " +
  "to open its value, or name the node id in a read request.";

/**
 * OPC UA generates nothing, and the two members below are unreachable rather than useful.
 *
 * Its dialect declares `offersCodeGeneration: false`, which is what `row-actions.ts` and
 * `TableItem.tsx` read: the button is never drawn, so neither function is called. They exist
 * because the record is exhaustive over dialects and `DialectGenerators` requires both.
 *
 * WHY NOTHING CAN BE GENERATED. A generator is handed the object's PATH, and a path's last segment
 * is a BrowseName. A read request names a NODE ID, which a BrowseName is not: measured on the
 * pinned fixture, 1,299 of its 6,769 node ids cannot be built from their own browse name, and 41
 * nodes have more than one path. So a statement built from a path would name a node the reader did not
 * choose, or none. A click on a key opens the node's own value in a Source tab instead, which is
 * `readObjectSource`, and that reaches the node id by browsing down the path.
 */
export const OPCUA_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: () => UNREACHABLE_OPCUA_GENERATOR,
  select: () => UNREACHABLE_OPCUA_GENERATOR,
});
