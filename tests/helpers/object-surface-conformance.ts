/**
 * The assertions every provider's object surface must satisfy, in one place.
 *
 * Six invariants, each of which a provider has a real way to get wrong:
 *   1. every declared kind appears in countObjects, so a folder never silently vanishes;
 *   2. countObjects never answers for a kind the provider did not declare;
 *   3. every kind counted non-empty LISTS something, so no folder opens onto nothing;
 *   4. every object's path starts with its container's path, so the tree can address it;
 *   5. no two objects of ONE kind share a path, so that kind's folder can address each;
 *   6. describeObject accepts a path listObjects ACTUALLY PRODUCED, with its kind.
 *
 * **Invariant 5 stops at the kind boundary, and that is a decision rather than an
 * oversight.** A tree row is identified by path PLUS kind id, not by path alone, which is
 * also why `describeObject` takes the kind: `DatabaseObject.path` promises a segment
 * unique within its PARENT, and it never promised uniqueness against a different kind's
 * namespace. Asserting across kinds is stricter than the type's contract and stricter than
 * anything downstream needs, and it would fail an engine whose namespaces really are
 * separate: MySQL keeps stored routines apart from tables, so a table and a procedure may
 * share a name in one schema and a cross-kind assertion would report that correct engine
 * as a broken provider. Do not tighten this back.
 *
 * Invariant 6 is exactly that and nothing more: a routine, a trigger and a sequence
 * legitimately have no columns, so an assertion that `columns` is non-empty would fail
 * correct providers for every kind that is not a relation.
 *
 * **Four vacuity guards, because this helper twice certified a provider that answered
 * nothing.** Measured the first time: a provider declaring `view`, reporting
 * `{view: {count: 4}}` and returning `[]` from `listObjects` passed every check, because
 * the path loop iterated zero times and `describeObject` was handed
 * `expected.sampleObject.path` - a path the TEST AUTHOR typed, which no provider had to
 * produce. Measured the second time, one kind narrower: `listObjects` was called once, for
 * the sample's kind, so a provider declaring seven kinds, counting seven and returning `[]`
 * from six was still certified. Every counted kind is listed now. Fifteen provider tasks would have been certified by a check a provider listing
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
import type { DatabaseObject, DatabaseProvider, KindCount } from "@/lib/db/types";
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

  // EVERY kind the expectation says is non-empty is listed, not just the sample's. Listing
  // one kind left the other six unchecked, which is how a provider that counted seven and
  // listed one was certified.
  //
  // A kind expected to hold zero is skipped, because listing nothing is the correct answer
  // there. And `objects.length === want` is deliberately NOT asserted: a count and a
  // listing are two reads at two instants and a live engine may legitimately disagree
  // between them, so pinning the magnitude would make this helper flaky rather than
  // strict. Non-emptiness is the part that cannot be a timing artefact.
  let sampleListing: DatabaseObject[] | undefined;

  for (const [id, want] of Object.entries(expected.kinds)) {
    if (want === 0) continue;
    const listed = await provider.listObjects!(container, id);
    if (listed.length === 0) {
      throw new Error(`countObjects reported ${want} of kind "${id}" and listObjects returned none`);
    }
    // Fresh per kind, deliberately. See the note above on why uniqueness stops at the
    // kind boundary.
    const seen = new Set<string>();
    for (const object of listed) {
      if (object.kind !== id) {
        throw new Error(`listObjects("${id}") returned an object of kind "${object.kind}": ${pathKey(object.path)}`);
      }
      if (!startsWith(object.path, container)) {
        throw new Error(`path ${JSON.stringify(object.path)} is not inside container ${JSON.stringify(container)}`);
      }
      const key = pathKey(object.path);
      if (seen.has(key)) {
        throw new Error(`two objects of kind "${id}" both answer the path ${key}, so neither can be addressed`);
      }
      seen.add(key);
    }
    if (id === expected.sampleObject.kind) sampleListing = listed;
  }

  // The sample's kind need not be one the expectation counts, so list it on its own when
  // the loop above did not already reach it.
  const objects = sampleListing ?? (await provider.listObjects!(container, expected.sampleObject.kind));

  // The sample must be a path the PROVIDER produced, not one the expectation typed.
  const sample = objects.find((object) => pathKey(object.path) === pathKey(expected.sampleObject.path));
  if (sample === undefined) {
    throw new Error(
      `listObjects for kind "${expected.sampleObject.kind}" did not return the expected sample ` +
        `${pathKey(expected.sampleObject.path)}; it returned ${JSON.stringify(objects.map((o) => o.path))}`,
    );
  }

  // The kind travels with the path. A caller always has it, because an object is only
  // ever reached through its kind's folder, and without it a provider has to infer what
  // it is holding from what the name happens to match.
  const detail = await provider.describeObject!(sample.path, sample.kind);
  expect(detail.path).toEqual([...sample.path]);
}
