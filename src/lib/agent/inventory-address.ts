/**
 * How a spelling of an object's address is resolved against the run's inventory (#789).
 *
 * ONE rule, in one file, because three readers need it and two of them disagreeing about
 * what a name means is how this task took its second Critical. Since the object surface
 * landed, an inventory entry's `name` is the ADDRESS, qualified as far as the object read
 * supplied segments, while every other spelling a run meets is written by something that
 * qualifies less:
 *
 *  - a foreign key's `referencedTable`, which each provider spells in its own flat dialect:
 *    `postgres.ts` strips `public.`, `mssql.ts` strips the object's own schema, and
 *    `mysql.ts` is always bare, against a `database.table` address;
 *  - a model naming a table for `profile_table`, which has been shown the address and may
 *    still answer with the two-part form it knows from the engine's own documentation.
 *
 * So a spelling resolves when it is a SUFFIX of an object's address, segment by segment,
 * most qualified first — the same key set `context-snapshot.ts` joins the two readings on.
 *
 * **Ambiguity is answered by refusing, never by choosing.** Two objects in different
 * containers can both answer one bare spelling, and there is nothing in either reading that
 * says which was meant. Handing a caller one of them would draw a relation the database does
 * not have or profile a table the model did not ask for; answering `ambiguous` costs a note on
 * a diagram or a refusal the model can repair by qualifying its spelling. The same decision
 * `joinFlatEntries` already makes about columns.
 *
 * The MOST QUALIFIED match wins outright: an address that equals the spelling is taken over
 * one that merely ends with it, so a two-level engine's `sales.orders` is not made ambiguous
 * by a `warehouse.sales.orders` that exists beside it.
 */

import type { AgentInventoryObject } from "./types";

/**
 * The segments of an entry's address.
 *
 * `path` is the object surface's own answer and is used wherever it exists. An entry that
 * never reached that read has only the one string the flat readings compose, and they
 * compose it with dots; splitting it is the last resort rather than the rule, and it is
 * wrong for an identifier that itself contains a dot. That is the same known limit the join
 * carries, recorded against #789 rather than papered over here: it costs a resolution and
 * never invents one.
 */
function addressSegments(object: AgentInventoryObject): readonly string[] {
  return object.path ?? object.name.split(".");
}

/**
 * Every spelling an entry may be addressed by, most qualified first.
 *
 * Exported for `context-snapshot.ts`'s join, which keys on exactly this set: the two must
 * not come to disagree about what a name means, which is why there is one definition.
 */
export function addressKeys(object: AgentInventoryObject): readonly string[] {
  const segments = addressSegments(object);
  return segments.map((_segment, index) => segments.slice(index).join("."));
}

/**
 * What a spelling addressed: one entry, nothing, or more than one thing.
 *
 * THREE outcomes rather than an entry or `null`, because the two failures are different
 * facts and at least one reader has to say which it met. "Nothing in this inventory is
 * spelled that way" is the edge of what the run read; "two objects answer to that spelling"
 * is a run that read BOTH of them and cannot tell which the other reading meant. A diagram
 * that reported the second as the first would tell a model a table it was shown is missing.
 */
export type InventoryAddressResolution =
  | { readonly kind: "resolved"; readonly object: AgentInventoryObject }
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous" };

/** The one entry a spelling addresses, or why there is not exactly one. */
export function resolveInventoryAddress(
  objects: readonly AgentInventoryObject[],
  spelling: string,
): InventoryAddressResolution {
  let best: AgentInventoryObject | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  let ambiguous = false;

  for (const object of objects) {
    const rank = addressKeys(object).indexOf(spelling);
    if (rank === -1) continue;
    if (rank < bestRank) {
      best = object;
      bestRank = rank;
      ambiguous = false;
    } else if (rank === bestRank) {
      ambiguous = true;
    }
  }

  if (ambiguous) return { kind: "ambiguous" };
  return best === undefined ? { kind: "absent" } : { kind: "resolved", object: best };
}
