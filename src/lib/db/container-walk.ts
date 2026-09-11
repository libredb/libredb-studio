/**
 * One walk of a provider's container tree, and the session default it answers (#789).
 *
 * It lives under `src/lib/db` rather than beside the route that reads it, and the reason is
 * measured rather than aesthetic: `tests/helpers/object-surface-conformance.ts` performs the
 * app's own join and so needs the app's own source of the session default, and importing
 * `@/lib/api/object-route` into that shared helper pulls `getOrCreateProvider` and the whole
 * `@/lib/db` barrel into every unit file that touches the helper. Measured on this branch:
 * 55 tests in `tests/unit/db` that `mock.module()` the same barrel fail from that import
 * alone, in files that have nothing to do with objects. One definition, reachable from both
 * sides, with no route in the path.
 *
 * The method is passed IN rather than read off the provider, which is what keeps the API layer
 * out: the route resolves it through `requireMethod`, so a provider that has not implemented it
 * still answers the 501 that names both the method and the engine, and nothing here has to know
 * what an HTTP status is.
 */
import { containerDepth } from "@/lib/db/object-kinds";
import type { Container, DatabaseProvider } from "@/lib/db/types";

/**
 * What one walk of the container tree answered.
 *
 * The default travels WITH the containers because it is read off the same walk: the engine
 * answers `isSessionDefault` on `listContainers`, and asking for it separately would be a second
 * full enumeration for one boolean.
 */
export interface ContainerEnumeration {
  readonly containers: readonly (readonly string[])[];
  /**
   * The container the SESSION is in, where exactly one deepest-level container says so.
   *
   * Absent is a fact and not a default: several engines cannot say, and a caller handed `[]`
   * instead would be told the root container, which on a two-level engine no object sits in. Its
   * reader, the object browser's flat join, keeps its refusal when it is absent rather than
   * guessing.
   */
  readonly defaultContainer?: readonly string[];
}

/**
 * Every container that can hold an object, walked one level at a time down to the declared depth.
 *
 * An engine with no container level answers a single empty path rather than an empty list: SQLite
 * and friends address every object by a bare name, so there IS one container to scan and it is the
 * connection itself. An empty list there would inventory nothing at all. That single container is
 * also the session's, trivially, being the only one there is.
 *
 * The default is taken at the DEEPEST level only, and standing ruling 5a2 is why: a provider with
 * container levels marks `isSessionDefault` at EVERY level, so a two-level engine flags its
 * catalog as well as its schema, while an object's container is the full `[catalog, schema]`. A
 * catalog path would name a container no object sits in and break no tie. More than one flagged
 * container at the deepest level is a provider defect, and it is answered as no default rather
 * than by picking one.
 */
export async function enumerateContainers(
  provider: DatabaseProvider,
  requireListContainers: () => NonNullable<DatabaseProvider["listContainers"]>,
): Promise<ContainerEnumeration> {
  const depth = containerDepth(provider.getCapabilities());
  if (depth === 0) return { containers: [[]], defaultContainer: [] };

  // Resolved only once the depth says there is a level to walk, and it is a THUNK for exactly
  // that reason: a zero-level engine never calls `listContainers`, so demanding it up front
  // would refuse SQLite and every engine like it for a method its inventory does not need.
  const listContainers = requireListContainers();
  let level = await listContainers();
  for (let below = 1; below < depth; below++) {
    const next: Container[] = [];
    for (const parent of level) {
      next.push(...(await listContainers(parent.path)));
    }
    level = next;
  }

  const defaults = level.filter((container) => container.isSessionDefault === true);
  const containers = level.map((container) => container.path);
  return defaults.length === 1 ? { containers, defaultContainer: defaults[0].path } : { containers };
}
