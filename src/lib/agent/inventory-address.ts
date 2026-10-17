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
 * The container an entry SITS IN, which is what an unqualified spelling written by that
 * entry is resolved from.
 *
 * A foreign key is declared BY an object, and the engine resolves an unqualified target in
 * the declaring object's own container; nothing else in the inventory says which of two
 * same-named tables the key means. So the declaring entry's container travels to the rule
 * as its tie-breaker, and this is how it is derived, off the same segments the address is.
 */
export function addressContainer(object: AgentInventoryObject): readonly string[] {
  const segments = addressSegments(object);
  return segments.slice(0, segments.length - 1);
}

/** What a spelling addressed inside this run's inventory. */
export type InventoryAddressResolution = ObjectAddressResolution<AgentInventoryObject>;

/**
 * The one entry a spelling addresses, or why there is not exactly one.
 *
 * `preferredContainer` is passed straight through and is documented on the rule itself: it
 * breaks a TIE between entries that already rank equally, and it never promotes a
 * worse-ranked match. A caller with no such context passes nothing and keeps the refusal.
 */
export function resolveInventoryAddress(
  objects: readonly AgentInventoryObject[],
  spelling: string,
  preferredContainer?: readonly string[],
): InventoryAddressResolution {
  return resolveObjectAddress(objects, addressSegments, spelling, preferredContainer);
}

/**
 * A table the run inventoried, and the schema/table pair the RESOLUTION produced.
 *
 * The pair matters as much as the entry. An earlier version composed from the
 * model's own spelling, so an unqualified `orders` that resolved to `sales.orders`
 * composed `FROM "orders"`, leaving PostgreSQL's `search_path` to decide which
 * relation was actually read while the ledger said `sales.orders` had been
 * profiled. Found by review on #345; the profile now targets what it resolved.
 */
export interface ResolvedProfileTarget {
  readonly entry: AgentInventoryObject;
  /**
   * The resolved ADDRESS, which is what the statement is composed from.
   *
   * Segments rather than one string, because the composition quotes each of them: an
   * address joined before it is quoted becomes an identifier no engine holds.
   */
  readonly segments: readonly string[];
  /** The leading segments as one label, for the audit target and a report's citation. */
  readonly schema?: string;
  readonly table: string;
}

/**
 * The table the run inventoried, found by the spelling the model gave.
 *
 * Resolved by `resolveInventoryAddress`, which is the same rule the ER diagram and the
 * inventory join use, and the reason this stopped being an `=== name` test is measured: on
 * an engine whose containers are two deep the inventory entry is `shop.sales.orders`, while
 * `sales.orders` is the form that engine's own documentation writes and the only other one a
 * model can reasonably produce. An exact comparison refused it - safely, and with nothing in
 * the refusal saying what to change (#789 fix round 2).
 *
 * Everything #345 bought is unchanged, because the address rule already makes those refusals
 * for its own reasons. A NAMED qualifier is still part of the answer and is still never
 * matched against a bare entry: `sales.orders` is not a suffix of `["orders"]`, so SQLite's
 * unqualified `orders` cannot be targeted as `other.orders`. And a spelling two entries
 * answer to at the same length is still refused rather than guessed between, which is the
 * case where a guess profiles the table the caller did not name.
 */
export type ProfileTargetResolution =
  | { readonly kind: "resolved"; readonly target: ResolvedProfileTarget }
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly AgentInventoryObject[] };

/**
 * The table the run inventoried, or WHICH of the two failures the spelling met. Shared by every language's
 * `profile_table` arm, so a table and a collection are resolved by one rule and composed from the entry's own address.
 *
 * The third outcome used to be dropped here, and dropping it is what made a run that read
 * two objects tell the model it had read neither: `resolveInventoryAddress` answers
 * `ambiguous` with its candidates, `inventoriedTable` (`tools.ts`) folded that into `null`, and
 * `null` was answered as `TABLE_NOT_INVENTORIED`. The two failures are different facts and
 * only one of them is repairable by the model, so they travel separately from here (#789).
 *
 * `preferredContainer` is the session default the capture read, and it is passed for the
 * reason every other consumer of the rule passes one: `er-diagram.ts` passes the declaring
 * object's container, `detailed-object.ts` and the inventory join pass the session default,
 * and this was the ONE that passed nothing. A run holding `app.orders` and `public.orders`
 * with `public` as its default had the flat `orders` tagged `public.orders` by the object
 * browser and answered `TABLE_AMBIGUOUS` here, in the same run, so a table the run had
 * inventoried and the browser could address could not be profiled. It breaks a tie between
 * equally ranked entries and never promotes a worse-ranked one, which is documented on the
 * rule itself; where the capture read no default it is absent and the refusal stands.
 */
export function resolveProfileTarget(
  objects: readonly AgentInventoryObject[],
  schema: string | undefined,
  table: string,
  preferredContainer: readonly string[] | undefined,
): ProfileTargetResolution {
  const resolution = resolveInventoryAddress(
    objects,
    schema === undefined ? table : `${schema}.${table}`,
    preferredContainer,
  );
  if (resolution.kind === "absent") return { kind: "absent" };
  if (resolution.kind === "ambiguous") return { kind: "ambiguous", candidates: resolution.candidates };
  const entry = resolution.object;
  // The entry's OWN address, never the spelling that reached it: an unqualified `orders`
  // that resolved to `sales.orders` composed `FROM "orders"` and let the search path decide
  // which relation was read while the ledger said `sales.orders`. Found by review on #345.
  const segments = addressSegments(entry);
  const leading = segments.slice(0, -1);
  return {
    kind: "resolved",
    target: {
      entry,
      segments,
      ...(leading.length === 0 ? {} : { schema: leading.join(".") }),
      table: segments[segments.length - 1],
    },
  };
}
