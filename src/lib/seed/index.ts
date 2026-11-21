import * as fs from "fs";
import { governanceEnabled } from "@/lib/governance/config";
import { accessReviewEnabled } from "@/lib/kubernetes-access/config";
import { filterByRoles, filterUnavailableByRoles, projectSeedConnection, rolesMatch } from "./connection-filter";
import { getDiscoveredConnections } from "./discovery-loader";
import { getKubernetesDiscoveredConnections } from "./kubernetes-discovery-loader";
import { loadOperatorSources } from "./operator-loader";
import { KUBERNETES_REVIEWED_ROLE } from "./roles";
import {
  getSampleSeedState,
  type SampleAdmission,
  sampleConnection,
  sampleConsidered,
  seededSampleAdmissions,
} from "./samples";
import type { OperatorEntry, OperatorUnavailableEntry } from "./sources/types";
import { LITERAL_SEED_FILE } from "@/lib/types";
import type { ManagedConnection, UnavailableSample } from "./types";

export type { ManagedConnection, UnavailableSample } from "./types";
export { resetCache } from "./operator-loader";
export { KUBERNETES_REVIEWED_ROLE, seedRolesOf } from "./roles";

/**
 * The operator entries these roles may see, in source order.
 *
 * The operator loader (operator-loader.ts) has resolved every `${NAME}` of a non-literal entry in its cache fill, and
 * a `${vault:...}` is left for `resolveConnection` to read when the connection is opened. An entry that fill read as
 * literal (every file-like entry while SEED_LITERAL_VALUES is on) carries the literal marker, which
 * `resolveConnection` honours by skipping Vault, so no value of it is resolved anywhere. The marker is set after
 * filterByRoles, because filterByRoles copies a fixed field list and SeedConnectionSchema strips an undeclared key,
 * so a marker set any earlier would not survive; filterByRoles builds a new object for every connection, so setting
 * it never reaches the loader's cache.
 *
 * The same entry also carries LITERAL_SEED_FILE (src/lib/types.ts): a seed file read in literal mode is written by a
 * platform from data its users control, so its rows are not server-written and never sign in with the server's own
 * cloud identity. This is the one place it is set; a discovered or governed row carries `literal` but never this
 * marker, and a built-in sample carries neither.
 */
function projectOperatorEntries(entries: readonly OperatorEntry[], roles: string[]): ManagedConnection[] {
  return entries.flatMap((entry) =>
    filterByRoles([entry.connection], roles).map((conn) =>
      entry.literal ? Object.assign(conn, { literal: true as const, [LITERAL_SEED_FILE]: true as const }) : conn,
    ),
  );
}

/**
 * The operator's entries whose type names no provider this Studio has (FND-1) that these roles may see, in source
 * order, each as `projectUnavailableSeed` lists it: the fields Studio reads, managed, and no marker, since no route
 * opens it.
 */
function projectUnavailableEntries(entries: readonly OperatorUnavailableEntry[], roles: string[]): ManagedConnection[] {
  return filterUnavailableByRoles(
    entries.map(({ entry }) => entry),
    roles,
  );
}

/**
 * What getManagedConnections lists, in its order, with the rows only the Kubernetes access review may list set apart in
 * their place.
 */
export interface SeedListing {
  /**
   * The operator entries, then the operator entries whose type names no provider (FND-1), then the CapRover-discovered
   * rows, then, with the review off, the Kubernetes-discovered rows the roles may see.
   */
  readonly before: ManagedConnection[];
  /**
   * With the review on, every Kubernetes-discovered row, carrying KUBERNETES_REVIEWED_ROLE; empty with it off. Only the
   * gate lists one.
   */
  readonly pendingReview: ManagedConnection[];
  /** The built-in samples, in the order of SAMPLES (src/lib/seed/samples.ts). */
  readonly after: ManagedConnection[];
}

/**
 * The seed connections these roles may see, in getManagedConnections' order, with the rows only the Kubernetes access
 * review may list set apart in `pendingReview`, their place in that order: the operator entries, then the operator
 * entries whose type names no provider this Studio has (FND-1), listed so they can be shown as unavailable and opened by
 * no route, then the discovered connections of CapRover and of Kubernetes, then the samples. Outside this module only src/lib/governance/visible.ts
 * reads it, and it hands `pendingReview` to the review and nowhere else; getManagedConnections, below, reads only
 * `before` and `after`.
 *
 * Governance mode (`GOVERNANCE_SOURCE`, docs/GOVERNANCE.md) replaces all three with the governance source, so under it
 * this reads no source at all and answers three empty sections, whatever the environment says: not the seed file at
 * its default path, which Studio reads while SEED_CONFIG_PATH is unset, not the discovery exports and not a sample. The
 * boot preflight refuses an environment that turns any of them on, and this holds on a server where it was bypassed.
 */
export async function getSeedListing(roles: string[]): Promise<SeedListing> {
  if (governanceEnabled()) return { before: [], pendingReview: [], after: [] };
  const operator = await loadOperatorSources();
  const fromOperators = projectOperatorEntries(operator.entries, roles);
  const unavailable = projectUnavailableEntries(operator.unavailable, roles);

  /*
    Discovered connections (CapRover auto-connect spec 9.5 and 9.7) come after the operator entries and before the
    built-in samples. They never pass through the operator loader's resolution: their values are the literal text
    another app on the platform network carries, so a `${NAME}` in them is not Studio's to resolve, and a plaintext
    password in them is not the operator's to be warned about. The literal marker is set here, after filterByRoles,
    for the reason projectOperatorEntries gives. getSeedConnectionByIdUnfiltered below does not include them, so the
    unfiltered lookup never confirms to a caller that a discovered id exists.

    A discovered connection whose id an operator source declares is dropped, whichever role the operator entry is
    for, and also when the fill dropped that entry for an undefined variable: declaredIds holds every id a source
    declared. The discovery loader applies the same rule when it recomputes, but its cache and the operator cache
    expire independently, so for up to one SEED_CACHE_TTL_MS it can still list an id an operator source has just
    gained, and the list would carry that id twice.
  */
  const discovered = filterByRoles(await getDiscoveredConnections(), roles)
    .filter((conn) => !operator.declaredIds.has(conn.seedId))
    .map((conn) => Object.assign(conn, { literal: true as const }));

  /*
    Kubernetes-discovered connections (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)") come after the
    CapRover ones. Each names the Secret its credentials came from. With the Kubernetes access review on, a review of
    `get` on that Secret is its only gate (src/lib/kubernetes-access/gate.ts), so every one is set apart in
    `pendingReview`, never passed through the role filter, carrying KUBERNETES_REVIEWED_ROLE, which rolesMatch refuses
    whatever the caller holds: no caller of getManagedConnections ever receives one, and the server-side record still
    reads as shared, so every requester gets one posture and one provider pool. With the review off no review can run,
    so its roles are `admin`, the rule CapRover's discovered connections follow, and it is listed in `before` through
    the role filter. The literal marker and the Secret marker are set with the roles, after the projection for the
    reason projectOperatorEntries gives, so no connection leaves without the marker its gate reads. The switch is read
    on every call, never cached with the export. An id an operator source declares is dropped, as above.
  */
  const reviewed = accessReviewEnabled();
  const kubernetes = (await getKubernetesDiscoveredConnections())
    .flatMap(({ connection, secret }) =>
      reviewed
        ? [
            {
              ...projectSeedConnection({ ...connection, roles: [KUBERNETES_REVIEWED_ROLE] }, []),
              roles: [KUBERNETES_REVIEWED_ROLE],
              literal: true as const,
              kubernetesSecret: secret,
            },
          ]
        : filterByRoles([{ ...connection, roles: ["admin"] }], roles).map((conn) =>
            Object.assign(conn, { literal: true as const, kubernetesSecret: secret }),
          ),
    )
    .filter((conn) => !operator.declaredIds.has(conn.seedId));

  const before = reviewed
    ? [...fromOperators, ...unavailable, ...discovered]
    : [...fromOperators, ...unavailable, ...discovered, ...kubernetes];
  // The built-in samples, in the order of SAMPLES (src/lib/seed/samples.ts, whose docblock says why SQLite leads).
  const after = offeredSamples(roles)
    .filter(({ refusal, target }) => refusal === null && fs.existsSync(target))
    .map(({ type, spec, target }) => sampleConnection(type, spec, target));

  return { before, pendingReview: reviewed ? kubernetes : [], after };
}

/**
 * The seed connections these roles may see: getSeedListing's `before`, then its `after`. While the Kubernetes access
 * review is on it never holds a Kubernetes-discovered connection, whatever the roles, because those are only ever in
 * `pendingReview`. Under governance it is empty and reads no source.
 */
export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const { before, after } = await getSeedListing(roles);
  return [...before, ...after];
}

/**
 * The enabled samples a listing for these roles considers, in table order, each with its target and admission, as boot
 * computed them (`seededSampleAdmissions`, none in a process that never seeded): in a test run only a sample whose path
 * override is set (`sampleConsidered`), and only one these roles are offered.
 */
function offeredSamples(roles: string[]): SampleAdmission[] {
  return seededSampleAdmissions().filter(({ spec }) => sampleConsidered(spec) && rolesMatch([...spec.roles], roles));
}

/**
 * Seed ids of the samples boot enabled whose copy is still in flight, in table order, so clients poll until each
 * appears or its copy ends. Empty when nothing is seeding, and in a process that never seeded, where clients never
 * poll. Empty under governance too, where boot enables no sample.
 */
export function getPendingSeeds(): string[] {
  return seededSampleAdmissions()
    .filter(({ spec }) => getSampleSeedState(spec.seedId)?.phase === "seeding")
    .map(({ spec }) => spec.seedId);
}

/**
 * The samples boot enabled, offered to these roles, that have no file and whose copy failed or whose target was
 * refused, in table order, each with its reason and the sentence a client shows. Never a connection, so no picker,
 * route or MCP tool can reach one. Empty under governance, where boot enables no sample.
 */
export function getUnavailableSamples(roles: string[]): UnavailableSample[] {
  return offeredSamples(roles).flatMap(({ spec, target, refusal }): UnavailableSample[] => {
    const state = getSampleSeedState(spec.seedId);
    if (state?.phase !== "failed") return [];
    if (refusal === null && fs.existsSync(target)) return [];
    return [{ seedId: spec.seedId, name: spec.name, reason: state.reason, sentence: state.sentence }];
  });
}

/**
 * The operator entries only, those whose type names no provider included, so a caller whose roles such an entry
 * excludes gets the 403 any seed gets: no discovered connection and no sample, so a 403 never confirms a discovered id.
 * Under governance none at all, because no source is read (see getManagedConnections).
 */
export async function getSeedConnectionByIdUnfiltered(seedId: string): Promise<ManagedConnection | null> {
  if (governanceEnabled()) return null;
  const operator = await loadOperatorSources();
  const roles = ["*", "admin", "user"];
  const all = [
    ...projectOperatorEntries(operator.entries, roles),
    ...projectUnavailableEntries(operator.unavailable, roles),
  ];
  return all.find((c) => c.seedId === seedId) ?? null;
}
