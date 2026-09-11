/**
 * Pure derivations over a provider's object declarations.
 *
 * Exists so no consumer inlines a default. Every question a consumer asks about a kind
 * is answered here, in one place, so the defaults cannot drift: an absent
 * `acceptsRowWrites` reads as false in every caller because there is only one caller.
 */
import type { KindCount, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";

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
