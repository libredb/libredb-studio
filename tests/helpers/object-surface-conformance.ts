/**
 * The assertions every provider's object surface must satisfy, in one place.
 *
 * Five invariants, each of which a provider has a real way to get wrong:
 *   1. every declared kind appears in countObjects, so a folder never silently vanishes;
 *   2. countObjects never answers for a kind the provider did not declare;
 *   3. every object's path starts with its container's path, so the tree can address it;
 *   4. no two objects in one listing share a path, so the tree can tell them apart;
 *   5. describeObject accepts a path listObjects ACTUALLY PRODUCED.
 *
 * Invariant 5 is exactly that and nothing more: a routine, a trigger and a sequence
 * legitimately have no columns, so an assertion that `columns` is non-empty would fail
 * correct providers for every kind that is not a relation.
 *
 * **Three vacuity guards, because the first version of this helper certified a provider
 * that answered nothing.** Measured: a provider declaring `view`, reporting
 * `{view: {count: 4}}` and returning `[]` from `listObjects` passed every check, because
 * the path loop iterated zero times and `describeObject` was handed
 * `expected.sampleObject.path` - a path the TEST AUTHOR typed, which no provider had to
 * produce. Fifteen provider tasks would have been certified by a check a provider listing
 * nothing passes. So the sample object is now looked up in the returned array and the
 * FOUND object's path is what `describeObject` is given; a listing that does not contain
 * it fails by name. The same hole one level up is closed by requiring the provider to
 * declare at least one kind and the expectation to name at least one, since with neither
 * the two kind loops also iterate zero times. Both guards are derived from emptiness
 * rather than pinned to a number: a helper that asserted "seven kinds" would have to be
 * edited for every engine and would then be asserting the engine's inventory rather than
 * this contract.
 *
 * Invariant 4 replaced an assertion that `name` equals the last path segment. That is no
 * longer true and must not be: `DatabaseObject.path` addresses, `DatabaseObject.name`
 * labels, and an overloaded PostgreSQL routine is `["app", "order_total(integer)"]`
 * displayed as `order_total`. Uniqueness is what the old assertion was reaching for and
 * is the thing a tree actually needs.
 *
 * One further check guards the caller rather than the provider: an expectation naming a
 * kind countObjects never answered for is reported by name. That is a caller-side
 * mistake, a kind id written into the expectation that this engine never declares, and
 * without the explicit throw it surfaces as `Cannot use 'in' operator ... in undefined`,
 * which names neither the kind nor the expectation.
 */
import { expect } from "bun:test";
import type { DatabaseProvider, KindCount } from "@/lib/db/types";
import { declaredKinds, isCountUnavailable } from "@/lib/db/object-kinds";

export interface ObjectSurfaceExpectation {
  readonly containers: readonly (readonly string[])[];
  readonly kinds: Readonly<Record<string, number>>;
  readonly sampleObject: { readonly path: readonly string[]; readonly kind: string };
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

/** One comparable spelling of a path. Only ever compared against another of these. */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export async function assertObjectSurface(
  provider: DatabaseProvider,
  expected: ObjectSurfaceExpectation,
): Promise<void> {
  const capabilities = provider.getCapabilities();
  const declared = declaredKinds(capabilities).map((kind) => kind.id);
  if (declared.length === 0) {
    throw new Error("the provider declares no object kinds, so every kind assertion below is vacuous");
  }
  if (Object.keys(expected.kinds).length === 0) {
    throw new Error("the expectation names no kinds, so no count is being checked");
  }

  const containers = await provider.listContainers!();
  expect(containers.map((container) => container.path)).toEqual(expected.containers.map((path) => [...path]));

  // An engine with no container level addresses every object at the root container.
  const container = expected.containers[0] ?? [];
  const counts: Record<string, KindCount> = await provider.countObjects!(container);

  for (const id of Object.keys(counts)) {
    if (!declared.includes(id)) throw new Error(`countObjects answered for undeclared kind "${id}"`);
  }
  for (const id of declared) {
    if (!(id in counts)) throw new Error(`declared kind "${id}" is missing from countObjects`);
  }
  for (const [id, want] of Object.entries(expected.kinds)) {
    if (!(id in counts)) throw new Error(`countObjects returned nothing for expected kind "${id}"`);
    const got = counts[id];
    if (isCountUnavailable(got)) throw new Error(`kind "${id}" was unavailable: ${got.unavailable}`);
    expect(got.count).toBe(want);
  }

  const objects = await provider.listObjects!(container, expected.sampleObject.kind);
  const seen = new Set<string>();
  for (const object of objects) {
    if (!startsWith(object.path, container)) {
      throw new Error(`path ${JSON.stringify(object.path)} is not inside container ${JSON.stringify(container)}`);
    }
    const key = pathKey(object.path);
    if (seen.has(key)) {
      throw new Error(`two objects of kind "${object.kind}" share the path ${key}, so neither can be addressed`);
    }
    seen.add(key);
    expect(object.kind).toBe(expected.sampleObject.kind);
  }

  // The sample must be a path the PROVIDER produced, not one the expectation typed.
  const sample = objects.find((object) => pathKey(object.path) === pathKey(expected.sampleObject.path));
  if (sample === undefined) {
    throw new Error(
      `listObjects for kind "${expected.sampleObject.kind}" did not return the expected sample ` +
        `${pathKey(expected.sampleObject.path)}; it returned ${JSON.stringify(objects.map((o) => o.path))}`,
    );
  }

  const detail = await provider.describeObject!(sample.path);
  expect(detail.path).toEqual([...sample.path]);
}
