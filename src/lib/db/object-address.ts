/**
 * How one SPELLING of an object's address resolves against a reading that holds many (#789).
 *
 * ONE rule, in one file, because four readers need it and two of them disagreeing about what
 * a name means is how this epic took two Criticals one layer apart. Since the object surface
 * landed, an object's ADDRESS is its segments, qualified as far as the provider supplied
 * them, while every other spelling a consumer meets is written by something that qualifies
 * LESS, and each of them qualifies less by a different amount:
 *
 *  - the flat schema reading drops the DEFAULT container and keeps the rest, so `mssql.ts`
 *    strips `dbo.`, `duckdb/introspect.ts` strips `main.`, `couchbase/keyspace.ts` strips
 *    `_default.` and `postgres.ts` strips `public.`;
 *  - `trino/introspect.ts` spells every flat name `schema.table` against a
 *    `[catalog, schema, table]` path, with no default case at all;
 *  - a foreign key's `referencedTable`, which each provider spells in its own dialect;
 *  - a model naming a table for a tool call, which has been shown the address and may still
 *    answer with the two-part form the engine's own documentation writes.
 *
 * The rule that covers all of them: a spelling resolves when it is a SUFFIX of an address,
 * segment by segment. It was first written as two comparisons, the whole address and its
 * last segment, and those are the same thing as this rule on a one-level engine and nothing
 * like it above that: a two-level engine's flat name sits BETWEEN them and matched neither,
 * so no object on Trino ever joined and every other engine joined only inside its default
 * container.
 *
 * **The MOST QUALIFIED match wins outright.** An address that equals the spelling is taken
 * over one that merely ends with it, so a `sales.orders` is not made ambiguous by a
 * `warehouse.sales.orders` sitting beside it.
 *
 * **Ambiguity is answered by refusing, never by choosing.** Two objects in different
 * containers can both answer one spelling at the same length, and nothing in the shorter
 * reading says which was meant. Choosing would file a `sales` view under `public` as a
 * table, or draw a relation the database does not have; refusing costs a row its kind or a
 * diagram a note, and every consumer here keeps what it cannot classify.
 *
 * It is generic over the ITEM and takes the segments it should use, because the two readings
 * that resolve a spelling carry them differently: a `DatabaseObject` always has `path`, and
 * an agent inventory entry has it only where the object surface answered. Each caller says
 * what its segments are; the rule is theirs in common.
 */

/**
 * Every spelling an address may be addressed by, MOST QUALIFIED FIRST.
 *
 * The index of a spelling in this list is its rank, and the rank is what decides between two
 * candidates: it is the number of leading segments the spelling left off. Exported because
 * `context-snapshot.ts`'s join keys on exactly this set rather than calling the resolver per
 * entry, and the two must not come to disagree about what a name means.
 */
export function addressKeys(segments: readonly string[]): readonly string[] {
  return segments.map((_segment, index) => segments.slice(index).join("."));
}

/**
 * What a spelling addressed: one item, nothing, or more than one thing.
 *
 * THREE outcomes rather than an item or `undefined`, because the two failures are different
 * facts and at least one caller has to say which it met. "Nothing in this reading is spelled
 * that way" is the edge of what was read; "two objects answer to that spelling" is a reading
 * that holds BOTH and cannot tell which the other reading meant. Reporting the second as the
 * first would tell a model that a table it was shown a moment ago is missing.
 */
export type ObjectAddressResolution<T> =
  | { readonly kind: "resolved"; readonly object: T }
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous" };

/**
 * The one item a spelling addresses, or why there is not exactly one.
 *
 * An item with NO segments answers nothing: there is no address to end with the spelling,
 * and an empty joined name would otherwise collect every one of them under `""`.
 */
export function resolveObjectAddress<T>(
  items: readonly T[],
  segmentsOf: (item: T) => readonly string[],
  spelling: string,
): ObjectAddressResolution<T> {
  let best: T | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  let ambiguous = false;

  for (const item of items) {
    const rank = addressKeys(segmentsOf(item)).indexOf(spelling);
    if (rank === -1) continue;
    if (rank < bestRank) {
      best = item;
      bestRank = rank;
      ambiguous = false;
    } else if (rank === bestRank) {
      ambiguous = true;
    }
  }

  if (ambiguous) return { kind: "ambiguous" };
  return best === undefined ? { kind: "absent" } : { kind: "resolved", object: best };
}
