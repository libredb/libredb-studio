/**
 * A spelling resolved against the RUN'S inventory: the shared address rule, plus the one
 * thing about it that is genuinely the agent's (#789).
 *
 * The rule itself, every suffix with the most qualified winning outright and a tie refusing
 * rather than choosing, is `src/lib/db/object-address.ts`. It is there and not here because
 * the same class of spelling is resolved one layer down, where `tagObjectKinds` joins the
 * flat reading to the object reading for the object browser, and two copies of one rule is
 * how this task took its second Critical. `src/lib/agent` already imports from
 * `src/lib/db` and `src/lib/db` never imports from `src/lib/agent`, so the rule moves down
 * and the direction holds.
 *
 * What stays here is what the ITEM is: an `AgentInventoryObject` carries its segments only
 * where the object surface answered for it, and the readings this module's consumers meet
 * are spelled by things that qualify less than the address. A foreign key's
 * `referencedTable` is one, written by each provider in its own flat dialect, and a model
 * naming a table for `profile_table` is another.
 */

import { addressKeys as keysOfSegments, resolveObjectAddress } from "@/lib/db/object-address";
import type { ObjectAddressResolution } from "@/lib/db/object-address";
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
 *
 * This is the whole of what is agent-specific, and it is why the shared rule takes the
 * segments rather than the item: a `DatabaseObject` always has a `path` and never needs
 * this fallback.
 */
function addressSegments(object: AgentInventoryObject): readonly string[] {
  return object.path ?? object.name.split(".");
}

/**
 * Every spelling an entry may be addressed by, most qualified first.
 *
 * Exported for `context-snapshot.ts`'s join, which keys on exactly this set rather than
 * calling the resolver per entry: the two must not come to disagree about what a name means.
 */
export function addressKeys(object: AgentInventoryObject): readonly string[] {
  return keysOfSegments(addressSegments(object));
}

/** What a spelling addressed inside this run's inventory. */
export type InventoryAddressResolution = ObjectAddressResolution<AgentInventoryObject>;

/** The one entry a spelling addresses, or why there is not exactly one. */
export function resolveInventoryAddress(
  objects: readonly AgentInventoryObject[],
  spelling: string,
): InventoryAddressResolution {
  return resolveObjectAddress(objects, addressSegments, spelling);
}
