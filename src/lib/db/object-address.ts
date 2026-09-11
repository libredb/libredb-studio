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
 * **A tie is not always an ambiguity, and the CALLER is what tells them apart.** Every
 * consumer of this rule resolves a spelling FROM somewhere: a foreign key from the
 * container its referencing object sits in, the object browser's flat join from the
 * session default container. The rule read none of that at first, so it refused the
 * ordinary case rather than an exotic one, a same-container name on a server that also
 * holds a second database with the same table in it. `preferredContainer` is that context.
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

/** Whether two container paths are the same container, segment by segment. */
function sameContainer(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * The one item a spelling addresses, or why there is not exactly one.
 *
 * An item with NO segments answers nothing: there is no address to end with the spelling,
 * and an empty joined name would otherwise collect every one of them under `""`.
 *
 * `preferredContainer` is the container the caller is RESOLVING FROM, and it breaks a tie
 * and does nothing else. Every consumer holds it and the first version of this rule threw
 * it away, which is what made the tie the ordinary case rather than the exotic one: the
 * object side of every join walks EVERY container the engine publishes, while the side
 * being resolved is pinned to ONE, so two objects of one name in two databases tie at the
 * same rank on any server holding `app` beside `app_test`. For a foreign key the preferred
 * container is the REFERENCING object's own, which is how the engine itself resolves an
 * unqualified target; for the flat join it is the session default container, which is what
 * the flat reading is a reading OF.
 *
 * Three properties, and each is a direction this must not move in:
 *
 *  - it never PROMOTES. The preference is applied only among candidates that already share
 *    the best rank, so a more qualified match still wins outright over a less qualified one
 *    sitting in the preferred container.
 *  - it breaks a TIE and never a genuine ambiguity. Two candidates in different containers
 *    where NEITHER is the preferred one still refuse, because nothing said which was meant.
 *  - it resolves only when the preferred container holds EXACTLY ONE tied candidate. Taking
 *    the first would file a row under an object nobody named.
 *
 * A caller with no such context passes nothing and keeps the refusal. An empty array is a
 * real container path, the one a zero-level engine's objects sit in, and is accepted as
 * one; it can never in fact break a tie, because a tie needs a rank above zero and only a
 * one-segment address has an empty container.
 */
export function resolveObjectAddress<T>(
  items: readonly T[],
  segmentsOf: (item: T) => readonly string[],
  spelling: string,
  preferredContainer?: readonly string[],
): ObjectAddressResolution<T> {
  // The tied set rather than a flag, because the tie-breaker has to look at the candidates
  // themselves: an `ambiguous` boolean records THAT there was a tie and throws away WHO
  // tied, which is exactly the information the preferred container is compared against.
  let best: T[] = [];
  let bestRank = Number.POSITIVE_INFINITY;

  for (const item of items) {
    const rank = addressKeys(segmentsOf(item)).indexOf(spelling);
    if (rank === -1) continue;
    if (rank < bestRank) {
      best = [item];
      bestRank = rank;
    } else if (rank === bestRank) {
      best.push(item);
    }
  }

  if (best.length === 1) return { kind: "resolved", object: best[0] };
  if (best.length === 0) return { kind: "absent" };
  if (preferredContainer === undefined) return { kind: "ambiguous" };

  const preferred = best.filter((item) => {
    const segments = segmentsOf(item);
    return sameContainer(segments.slice(0, segments.length - 1), preferredContainer);
  });
  return preferred.length === 1 ? { kind: "resolved", object: preferred[0] } : { kind: "ambiguous" };
}
