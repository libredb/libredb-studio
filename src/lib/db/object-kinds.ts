/**
 * Pure derivations over a provider's object declarations.
 *
 * Exists so no consumer inlines a default. Every question a consumer asks about a kind
 * is answered here, in one place, so the defaults cannot drift: an absent
 * `acceptsRowWrites` reads as false in every caller because there is only one caller.
 */
import type { KindCount, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";

/**
 * How many container levels this engine declares, as the tree models them.
 *
 * `>= 2` rather than `=== 2` is the CEILING, and it is stated in the type as well: since #789
 * `ContainerLevels` is a tuple union of nought, one or two levels, so a third one is a compile
 * error where a provider would write it rather than a level that exists in the declaration and
 * is read by nothing. This arm is what a cast past that type still meets, and what every
 * two-level provider's own path validation already refuses independently.
 */
export function containerDepth(capabilities: ProviderCapabilities): 0 | 1 | 2 {
  const levels = capabilities.containerLevels?.length ?? 0;
  if (levels >= 2) return 2;
  if (levels === 1) return 1;
  return 0;
}

export function declaredKinds(capabilities: ProviderCapabilities): readonly ObjectKindSpec[] {
  return capabilities.objectKinds ?? [];
}

export function findKind(capabilities: ProviderCapabilities, id: string): ObjectKindSpec | undefined {
  return declaredKinds(capabilities).find((kind) => kind.id === id);
}

/**
 * Whether THIS KIND accepts a row write. Absent and undeclared both read as false.
 *
 * Deliberately NOT conjoined with the engine-wide `supportsInlineRowEdit`, and the name
 * says `kind` so a caller cannot mistake the scope. That flag has exactly one reader in
 * this repo, `src/components/Studio.tsx:144`, where it gates the results grid's inline
 * row editor and nothing else. Folding it in here would answer false for three engines
 * that do take row writes: MongoDB (`src/lib/db/providers/document/mongodb.ts:170`),
 * Couchbase (`src/lib/db/providers/document/couchbase/index.ts:316`) and Cassandra
 * (`src/lib/db/providers/sql/cassandra/index.ts:242`) all declare
 * `supportsInlineRowEdit: false`, and #789 declares a kind that accepts a row write on
 * each of the three, so a conjunction would silently drop all three out of the import
 * target list.
 *
 * A caller that needs both facts writes both, which is now visible at the call site.
 */
export function kindAcceptsRowWrites(capabilities: ProviderCapabilities, id: string): boolean {
  return findKind(capabilities, id)?.acceptsRowWrites === true;
}

/**
 * The ids of the kinds the provider declared `role: "relation"`.
 *
 * The ROLE and never a list of ids written here, for the reason every other derivation in
 * this file exists: `role` is the provider's own word about its own engine, and a hardcoded
 * set would be wrong for every engine this repository has not heard of.
 *
 * Two readers, and they want it for two different reasons. `use-connection-manager.ts` names
 * these kinds when it asks the inventory route for objects, which is both a correctness fact
 * and a cost one: the flat readings hold relations and nothing else, so every routine,
 * trigger and event in a full answer is an object the join can never match and can only
 * CONTEST - measured on MySQL 26.7.0, where a table, a procedure and an event called `foo`
 * carry the identical address and the table therefore came back with no kind at all - and
 * asking for three kinds instead of seven is three listings per container instead of seven.
 * `tests/helpers/object-surface-conformance.ts` reads it to perform that same join, so the
 * guard and the app narrow their population by one rule rather than two.
 */
export function relationKindIds(capabilities: ProviderCapabilities): readonly string[] {
  return declaredKinds(capabilities)
    .filter((kind) => kind.role === "relation")
    .map((kind) => kind.id);
}

/**
 * The `readonly` in the predicate is load-bearing, not decoration. A predicate written
 * `count is { unavailable: string }` narrows the true branch and NOTHING on the false
 * branch: subtracting a constituent uses the subtype relation, which does check readonly
 * modifiers, so `{ readonly unavailable: string }` survives the subtraction and every
 * caller is left holding the whole union with no `.count` on it. Measured against
 * TypeScript 6.0.3.
 */
export function isCountUnavailable(count: KindCount): count is { readonly unavailable: string } {
  return "unavailable" in count;
}

/**
 * Whether a number is a FLOOR rather than a total, because the provider counted what a
 * bounded read saw.
 *
 * The `readonly` is load-bearing for the reason `isCountUnavailable` records, and the
 * predicate asks for the FIELD rather than for a flag: `sampledFrom` is the only thing
 * that separates this member from the plain `{ count }` beside it in the union, and an
 * implementer that omits it is saying the number is a population.
 *
 * Callers that only need the number do not need this at all, which is the point of the
 * variant being additive: `count.count` narrows on both members. It is the RENDERER that
 * needs it, because "1,204 tables" and "at least 1,204 key groupings" are different facts
 * and the badge is the only place a person meets either (#789).
 */
export function isCountSampled(count: KindCount): count is { readonly count: number; readonly sampledFrom: string } {
  return "sampledFrom" in count;
}

/**
 * The one sentence every provider reports a CALLER's bulk-read bound with (#789).
 *
 * `ObjectDetailBatch.truncated.reason` is a sentence a person reads beside a partial
 * answer, and once the flat surface is gone it is the ONLY sentence explaining why an
 * answer is short. Eleven implementers wrote three unrelated phrasings for one event
 * ("column read limit reached", "the caller's limit on one <Engine> bulk column read",
 * and this one), so the same bound read three ways depending on which engine was open.
 * This is the shape that won, for two reasons that are not taste: it carries the NUMBER
 * that bit, which the terse spelling drops and a reader cannot recover, and it names no
 * engine, so there is nothing per-provider left to spell differently.
 *
 * It is a function rather than a constant because the number is the caller's and changes
 * per call, and it is here rather than in each provider because fourteen copies of a
 * sentence is how the three phrasings happened.
 *
 * A provider that applies a SECOND bound of its own - redis and libredb walk a bounded
 * keyspace - names that one in its own words and joins the two, because they are two
 * different bounds rather than two phrasings of one. The shared conformance guard asks
 * only that a caller-bounded batch's reason CONTAIN this sentence, never that it equal
 * it, so a composed sentence satisfies it.
 */
export function callerBoundTruncationReason(limit: number): string {
  return `the bulk column read was bounded at ${limit} object${limit === 1 ? "" : "s"} by its caller`;
}
