/**
 * The assertions every provider's object surface must satisfy, in one place.
 *
 * Four invariants, each of which a provider has a real way to get wrong:
 *   1. every declared kind appears in countObjects, so a folder never silently vanishes;
 *   2. countObjects never answers for a kind the provider did not declare;
 *   3. every object's path starts with its container's path, so the tree can address it;
 *   4. describeObject accepts a path listObjects produced.
 *
 * Invariant 4 is exactly that and nothing more: a routine, a trigger and a sequence
 * legitimately have no columns, so an assertion that `columns` is non-empty would fail
 * correct providers for every kind that is not a relation.
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

export async function assertObjectSurface(
  provider: DatabaseProvider,
  expected: ObjectSurfaceExpectation,
): Promise<void> {
  const capabilities = provider.getCapabilities();
  const declared = declaredKinds(capabilities).map((kind) => kind.id);

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
  for (const object of objects) {
    if (!startsWith(object.path, container)) {
      throw new Error(`path ${JSON.stringify(object.path)} is not inside container ${JSON.stringify(container)}`);
    }
    expect(object.name).toBe(object.path[object.path.length - 1]);
    expect(object.kind).toBe(expected.sampleObject.kind);
  }

  const detail = await provider.describeObject!(expected.sampleObject.path);
  expect(detail.path).toEqual([...expected.sampleObject.path]);
}
