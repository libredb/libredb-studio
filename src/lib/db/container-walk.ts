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
 * It reads `listContainers` straight off the provider. It used to take the method as an argument,
 * because the object surface was optional through the phase that landed it one provider at a time
 * and the route had to turn an absent method into a 501 naming the engine. The method is required
 * now, so there is no absence to report and no reason for this to know what an HTTP status is.
 */
import { containerDepth } from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type { Container, DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";

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
  /**
   * Each container's `Container.kinds`, aligned by index with `containers`, where at least one
   * container answered some. Absent on every engine whose containers name no kinds, so its
   * enumeration is exactly what it was before the field existed. Read it through `kindsByContainer`.
   */
  readonly containerKinds?: readonly (readonly string[] | undefined)[];
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
export async function enumerateContainers(provider: DatabaseProvider): Promise<ContainerEnumeration> {
  const depth = containerDepth(provider.getCapabilities());
  if (depth === 0) return { containers: [[]], defaultContainer: [] };

  const listContainers = provider.listContainers.bind(provider);
  let level = await listContainers();
  for (let below = 1; below < depth; below++) {
    const next: Container[] = [];
    for (const parent of level) {
      next.push(...(await listContainers(parent.path)));
    }
    level = next;
  }

  return enumerationOf(level);
}

/**
 * What one walk answered, read off its DEEPEST level: the paths, the kinds each container named, and
 * the session default.
 *
 * Exported for the agent's grounding walk, which walks the levels itself from the capabilities its run
 * context holds (see `sessionDefaultContainer`), so the two walks build one answer by one rule.
 */
export function enumerationOf(level: readonly Container[]): ContainerEnumeration {
  const containers = level.map((container) => container.path);
  const containerKinds = level.map((container) => container.kinds);
  const defaultContainer = sessionDefaultContainer(level);
  return {
    containers,
    ...(containerKinds.some((kinds) => kinds !== undefined) ? { containerKinds } : {}),
    ...(defaultContainer === undefined ? {} : { defaultContainer }),
  };
}

/**
 * The kinds each container of an enumeration named, keyed the way `dedupePaths` keys a path, so a
 * reader that removed repeated paths still finds each one's kinds. The first answer for a path wins,
 * as it does there; a container that named none has no entry, which `kindsForContainer` reads as
 * every enumerable kind.
 */
export function kindsByContainer(enumeration: ContainerEnumeration): ReadonlyMap<string, readonly string[]> {
  const byPath = new Map<string, readonly string[]>();
  enumeration.containers.forEach((path, index) => {
    const key = JSON.stringify(path);
    const kinds = enumeration.containerKinds?.[index];
    if (kinds !== undefined && !byPath.has(key)) byPath.set(key, kinds);
  });
  return byPath;
}

/** The containers a caller NAMED, as `describeNamedContainers` answers them. */
export interface NamedContainers {
  /** The named paths, in the caller's order, with `containerKinds` where the provider answered some. */
  readonly enumeration: ContainerEnumeration;
  /**
   * The named paths the provider's listing does not hold. Only an engine that declares
   * `containersNameKinds` can have any, and the kinds such a container holds are unknown.
   */
  readonly unlisted: readonly (readonly string[])[];
}

/**
 * The distinct parents `describeNamedContainers` lists for a set of named paths, in first-seen order,
 * or none on an engine it does not ask.
 */
function namedParents(
  provider: DatabaseProvider,
  named: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const capabilities = provider.getCapabilities();
  if (capabilities.containersNameKinds !== true || containerDepth(capabilities) === 0) return [];
  const parents = new Map<string, readonly string[]>();
  for (const path of named) {
    const parent = path.slice(0, -1);
    const key = JSON.stringify(parent);
    if (!parents.has(key)) parents.set(key, parent);
  }
  return [...parents.values()];
}

/**
 * How many `listContainers` calls `describeNamedContainers` would issue for these named paths, counted
 * without issuing any, so a caller can refuse a body before its first round trip. One on an engine with
 * one container level, one per distinct parent below that, and none on an engine that is not asked.
 */
export function namedContainerListings(provider: DatabaseProvider, named: readonly (readonly string[])[]): number {
  return namedParents(provider, named).length;
}

/**
 * The containers a caller NAMED, with the kinds the provider answers for each.
 *
 * Only on an engine that declares `ProviderCapabilities.containersNameKinds`: one `listContainers`
 * call per distinct parent of the named paths, which is one call on an engine with one container
 * level, because the kinds of a container are the provider's answer and never the caller's. Every
 * other engine is not asked, and its named containers are read for every enumerable kind exactly as
 * before the field existed; neither is an engine with no container level, which has nothing to list.
 * The number of calls is not bounded here: a caller that takes the paths from a request counts them
 * first with `namedContainerListings` and refuses a body that would issue too many.
 */
export async function describeNamedContainers(
  provider: DatabaseProvider,
  named: readonly (readonly string[])[],
): Promise<NamedContainers> {
  const parents = namedParents(provider, named);
  if (parents.length === 0) return { enumeration: { containers: named }, unlisted: [] };
  const answered = new Map<string, Container>();
  // Sequential on purpose, and the `no-await-in-loop` warning is accepted here, as in
  // `enumerateContainers`: one parent at a time, so a body naming many parents never opens as many
  // concurrent listings.
  for (const parent of parents) {
    const listed = await (parent.length === 0 ? provider.listContainers() : provider.listContainers(parent));
    for (const container of listed) {
      const listedKey = JSON.stringify(container.path);
      if (!answered.has(listedKey)) answered.set(listedKey, container);
    }
  }
  const containerKinds = named.map((path) => answered.get(JSON.stringify(path))?.kinds);
  return {
    enumeration: containerKinds.some((kinds) => kinds !== undefined)
      ? { containers: named, containerKinds }
      : { containers: named },
    unlisted: named.filter((path) => !answered.has(JSON.stringify(path))),
  };
}

/**
 * Which of a DEEPEST LEVEL's containers is the session's, where exactly one says so.
 *
 * Exported because other readers take the same fact off a level of their own: the object
 * browser's scoped read in `src/hooks/use-connection-manager.ts`, and the agent's grounding
 * inventory (`src/lib/agent/tools.ts`), which enumerates containers from the capabilities its
 * run context already holds rather than from `provider.getCapabilities()` and reads the default
 * through `enumerationOf`, so the rule for reading a default off a level is written once.
 *
 * More than one flagged container is a provider defect and is answered as NO default
 * rather than by picking one, the same as none: a tie-breaker that guesses is worse than
 * one that declines, because the consumer's refusal is correct and its guess is not.
 */
export function sessionDefaultContainer(level: readonly Container[]): readonly string[] | undefined {
  const defaults = level.filter((container) => container.isSessionDefault === true);
  return defaults.length === 1 ? defaults[0].path : undefined;
}

/**
 * The containers an agent walk reads under a provider's `agentWalkScope`, and how many it leaves out.
 *
 * No scope keeps the enumeration whole. A scope keeps the session-default container and every container
 * `alsoWalk` names, in the enumeration's own order, with each kept container's kinds beside it; a path `alsoWalk`
 * names that the enumeration does not hold is not invented. The default is carried unchanged, since it is a fact
 * about the session and not about what was read.
 *
 * `parentDefault` is the session default the level above the deepest marks, read by `sessionDefaultContainer` off
 * that level. It counts only where the scope declares `whenNoDefault` and the deepest level has no default: then
 * the parent's children are kept as well, minus each one whose name the scope skips.
 */
export function scopeGroundingContainers(
  enumeration: ContainerEnumeration,
  scope: ProviderCapabilities["agentWalkScope"],
  parentDefault?: readonly string[],
): { readonly enumeration: ContainerEnumeration; readonly unread: number } {
  if (scope === undefined) return { enumeration, unread: 0 };
  const wanted = new Set(
    [
      ...(enumeration.defaultContainer === undefined ? [] : [enumeration.defaultContainer]),
      ...(scope.alsoWalk ?? []),
    ].map(pathKey),
  );
  const fallback = enumeration.defaultContainer === undefined ? scope.whenNoDefault : undefined;
  const parentKey = parentDefault === undefined ? undefined : pathKey(parentDefault);
  const skipped = new Set(fallback?.skip ?? []);
  const isParentChild = (path: readonly string[]): boolean =>
    fallback !== undefined &&
    parentKey !== undefined &&
    pathKey(path.slice(0, -1)) === parentKey &&
    !skipped.has(path[path.length - 1]);
  const kept = enumeration.containers.flatMap((path, index) =>
    wanted.has(pathKey(path)) || isParentChild(path) ? [index] : [],
  );
  const { containerKinds, ...rest } = enumeration;
  return {
    enumeration: {
      ...rest,
      containers: kept.map((index) => enumeration.containers[index]),
      ...(containerKinds === undefined ? {} : { containerKinds: kept.map((index) => containerKinds[index]) }),
    },
    unread: enumeration.containers.length - kept.length,
  };
}
