/**
 * The tree surface: the containers (`Cluster`, then the namespaces) with the kinds each holds, the capped listings,
 * and the counts read from the same capped walk.
 *
 * A listing reads the Table with `includeObject=None` in pages of 500, following `continue`, up to 1,000 objects
 * per kind and container, and takes each name from the Name cell, so a page of large objects (a CRD's managedFields
 * and last-applied annotation run to hundreds of KiB) never weighs on the response cap. A kind whose printer decorates
 * that cell (StorageClass writes `local-path (default)`, the kind table's `decoratedName`) is read with
 * `includeObject=Metadata` instead, and named by each row's metadata. A count reads `includeObject=None` the same way
 * one row further, so up to 1,000 it is exact and past it the count is the 1,000 the tree lists, marked as a floor.
 * `remainingItemCount` is never a count: the API omits it with selectors and on the last page, and says not to rely
 * on it.
 *
 * A kind the identity may not list keeps its folder: its count answers `{ unavailable }` with Studio's sentence, so
 * one forbidden kind loses nothing else. A built-in kind this server does not serve answers the same way, and so does a
 * kind whose list times out, is too large or cannot be read: only a rejected credential or a closed session fails the
 * whole container.
 *
 * Every walk has one deadline, the query timeout, shared by its pages and its restarts, so a server that keeps
 * answering pages cannot hold a walk past it.
 */
import { QueryError, TimeoutError } from "@/lib/db/errors";
import { assertContainerPathShape, type ContainerPathShapeEngine } from "@/lib/db/object-kinds";
import type {
  Container,
  ContainerLevels,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ProviderCapabilities,
} from "@/lib/db/types";
import { ACCEPT_TABLE, type KubernetesCall, type KubernetesClient } from "./client";
import type { ClusterEndpoint } from "./connection-options";
import { DNS1123_LABEL } from "./connection-options";
import {
  type DiscoveryCache,
  findResource,
  type IndexedResource,
  type ResourceIndex,
  withTypeRefresh,
} from "./discovery";
import { KubernetesRequestError, notServedSentence, requestWords } from "./errors";
import {
  BUILT_IN_API_GROUPS,
  type BuiltInKind,
  builtInKind,
  CLUSTER_CONTAINER,
  CUSTOM_RESOURCES_KIND,
  kindsForContainerName,
  objectNameOf,
  objectSegment,
} from "./kinds";
import { KUBERNETES_MAX_IN_FLIGHT, KUBERNETES_PAGE_SIZE, KUBERNETES_TREE_OBJECT_CAP, KUBERNETES_TYPE } from "./limits";
import { redactResponse } from "./redaction";
import { isRequestableName, type KubernetesRequest, planRequest } from "./request-policy";
import { cellOf, type KubeTable, parseTable, scanTable, type TableRow } from "./table";

/** What every tree read goes through: the client, the discovery cache, the connection's namespaces and a fresh call. */
export interface KubernetesSurface {
  readonly client: KubernetesClient;
  readonly discovery: DiscoveryCache;
  readonly endpoint: Pick<ClusterEndpoint, "namespaces" | "defaultNamespace">;
  readonly call: () => KubernetesCall;
}

/** What a count past the cap was counted from, completing "counted from". */
export const KUBERNETES_SAMPLED_FROM = "the first 1,000 objects the tree lists; the console reads the rest";

/**
 * The words that mean an object needs nothing done, which the tree draws no status for. The Job printer writes
 * `Complete` for a finished Job and `SuccessCriteriaMet` while a successful one completes.
 */
const ORDINARY_STATUS: ReadonlySet<string> = new Set([
  "Running",
  "Completed",
  "Complete",
  "SuccessCriteriaMet",
  "Succeeded",
  "Ready",
  "Active",
  "Bound",
  "Available",
]);
const READY_COUNTS = /^([0-9]+)\/([0-9]+)$/;

function refuse(message: string): never {
  throw new QueryError(message, KUBERNETES_TYPE);
}

/** The container declaration the provider's capabilities carry: one Namespace level, exact paths only. */
export const KUBERNETES_CONTAINER_LEVELS: ContainerLevels = [
  { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
];

const KUBERNETES_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: KUBERNETES_TYPE,
  label: "A Kubernetes",
  shapeNames: "label",
};

/** The one segment of a container path: `Cluster` or a namespace name. */
export function containerName(container: readonly string[]): string {
  // The shared check reads the two container fields alone, which is all this declaration carries.
  const declaration: Pick<ProviderCapabilities, "containerLevels" | "containerPathShapes"> = {
    containerLevels: KUBERNETES_CONTAINER_LEVELS,
    containerPathShapes: "exact",
  };
  assertContainerPathShape(declaration as ProviderCapabilities, container, KUBERNETES_CONTAINER_PATH_ENGINE);
  const [name] = container;
  if (name !== CLUSTER_CONTAINER && !DNS1123_LABEL.test(name))
    refuse(
      `A Kubernetes container is Cluster or a namespace name (a DNS-1123 label), received ${JSON.stringify(name)}`,
    );
  return name;
}

/** The kind a container holds, or the sentence for a pair that does not exist. */
function requireApplicable(container: string, kind: string): void {
  if (kindsForContainerName(container).includes(kind)) return;
  const entry = builtInKind(kind);
  if (entry === undefined) refuse(`Kubernetes declares no object kind "${kind}"`);
  refuse(
    entry.scope === "Namespaced"
      ? `${entry.labelPlural} live in a namespace, not under ${CLUSTER_CONTAINER}.`
      : `${entry.labelPlural} are cluster-scoped: they are listed under ${CLUSTER_CONTAINER}, not in a namespace.`,
  );
}

/** The served resource of a built-in kind, or the not-served sentence. */
function servedResource(index: ResourceIndex, entry: BuiltInKind): IndexedResource | string {
  const served = findResource(index, entry.group, entry.id);
  if (served === undefined || !served.verbs.includes("list"))
    return notServedSentence(entry.labelPlural, { resource: entry.id, group: entry.group });
  return served;
}

/**
 * The page reader of one Table walk: requested with `includeObject`, redacted, parsed. Made once per walk, so its
 * deadline, the query timeout taken when the walk starts, is shared by every page and by the walk's restarts.
 */
function tableReader(
  surface: KubernetesSurface,
  target: IndexedResource,
  namespace: string | undefined,
  includeObject: "None" | "Metadata",
) {
  const walk = surface.call();
  const deadline = AbortSignal.any([walk.signal, AbortSignal.timeout(walk.timeoutMs)]);
  return async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const request: KubernetesRequest = {
      op: "list",
      target,
      ...(namespace === undefined ? {} : { namespace }),
      query: {
        limit: page.limit,
        includeObject,
        ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
      },
    };
    let body: unknown;
    try {
      body = await surface.client.json(request, { ...walk, signal: deadline, accept: ACCEPT_TABLE });
    } catch (error) {
      // The walk's deadline, not one request's: the sentence names the list the walk was reading.
      if (error instanceof TimeoutError && deadline.aborted && !walk.signal.aborted)
        throw new TimeoutError(
          `The API server did not answer every page needed to ${requestWords(planRequest(request).context)} within ${walk.timeoutMs / 1000} s, the connection's query timeout.`,
          KUBERNETES_TYPE,
          walk.timeoutMs,
        );
      throw error;
    }
    return parseTable(redactResponse(target, body));
  };
}

/**
 * The rows of a capped walk, up to the cap plus `extra`. A walk that reads each row's metadata reads a page past the
 * byte cap again at half the page size; one that reads the cells alone does not need to.
 */
async function cappedWalk(
  surface: KubernetesSurface,
  target: IndexedResource,
  namespace: string | undefined,
  extra: number,
  includeObject: "None" | "Metadata",
): Promise<{ readonly table: Pick<KubeTable, "columns">; readonly rows: readonly TableRow[] }> {
  const scan = await scanTable(tableReader(surface, target, namespace, includeObject), {
    offset: 0,
    limit: KUBERNETES_TREE_OBJECT_CAP + extra,
    pageSize: KUBERNETES_PAGE_SIZE,
    halveOnTooLarge: includeObject === "Metadata",
  });
  return { table: scan, rows: scan.rows };
}

/** The count of a capped walk read one row past the cap: exact up to 1,000, the sampled floor past it. */
export async function cappedCount(
  surface: KubernetesSurface,
  target: IndexedResource,
  namespace: string | undefined,
): Promise<{ readonly count: number } | { readonly count: number; readonly sampledFrom: string }> {
  const { rows } = await cappedWalk(surface, target, namespace, 1, "None");
  return rows.length > KUBERNETES_TREE_OBJECT_CAP
    ? { count: KUBERNETES_TREE_OBJECT_CAP, sampledFrom: KUBERNETES_SAMPLED_FROM }
    : { count: rows.length };
}

/** The row's name: its object's `metadata.name` when the row carries one, the Name cell otherwise. */
function rowName(table: Pick<KubeTable, "columns">, row: TableRow, labelPlural: string): string {
  const metadata = row.object?.metadata;
  const fromObject =
    typeof metadata === "object" && metadata !== null ? (metadata as { readonly name?: unknown }).name : undefined;
  const name = fromObject ?? cellOf(table, row, "Name");
  if (typeof name !== "string" || name === "")
    refuse(`The API server listed one of the ${labelPlural} without a name.`);
  return name;
}

/** The engine's own word for a state a reader should act on, from the Status and Ready cells; absent when ordinary. */
export function notableStatus(table: Pick<KubeTable, "columns">, row: TableRow): string | undefined {
  const status = cellOf(table, row, "Status");
  if (typeof status === "string" && status !== "" && !ORDINARY_STATUS.has(status)) return status;
  const ready = cellOf(table, row, "Ready");
  const counts = typeof ready === "string" ? READY_COUNTS.exec(ready) : null;
  if (counts === null || counts[1] === counts[2]) return undefined;
  if (status === "Running") return `Running, ${ready} ready`;
  // A finished pod (Completed, Succeeded) has no ready container, and that is ordinary.
  return status === undefined || status === "" ? `${ready} ready` : undefined;
}

/** The namespaces the tree lists: `forbidden` when the API refused the list. */
export interface NamespaceList {
  readonly names: readonly string[];
  readonly forbidden: boolean;
  /** Present only when the API listed more namespaces than the tree's cap; `names` then holds the first 1,000. */
  readonly capped?: true;
}

const NAMESPACE_NAME_SENTENCE =
  "The API server listed a namespace whose name is not a DNS-1123 label, which no namespace can have, so Studio does not list the namespaces; list the ones to show in the connection's Namespaces field.";

/** Whether the API shows the namespace `name`: a 404 or a 403 on its read says no, any other failure is thrown. */
async function namespaceExists(surface: KubernetesSurface, target: IndexedResource, name: string): Promise<boolean> {
  if (!target.verbs.includes("get")) return false;
  try {
    await surface.client.json({ op: "get", target, name }, surface.call());
    return true;
  } catch (error) {
    if (error instanceof KubernetesRequestError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
}

/**
 * The namespaces from the API, the first 1,000 read one past the cap (the last of them the Default namespace when it
 * sorts past them and exists), or `forbidden` when the list is refused.
 */
async function namespacesFromApi(surface: KubernetesSurface, index: ResourceIndex): Promise<NamespaceList> {
  const sources: readonly (readonly [group: string, resource: string])[] = [
    ["", "namespaces"],
    // OpenShift project users may list projects where they may not list namespaces.
    ["project.openshift.io", "projects"],
  ];
  for (const [group, resource] of sources) {
    const target = findResource(index, group, resource);
    if (target === undefined || !target.verbs.includes("list")) continue;
    try {
      const scan = await scanTable(tableReader(surface, target, undefined, "None"), {
        offset: 0,
        // One row past the cap, as a count reads, so a cluster with more namespaces than the tree lists is told so.
        limit: KUBERNETES_TREE_OBJECT_CAP + 1,
        pageSize: KUBERNETES_PAGE_SIZE,
      });
      const names = scan.rows.map((row) => rowName(scan, row, "namespaces"));
      // Every name becomes a container path, so one no namespace can have (Cluster, a/b) is refused, not drawn.
      if (names.some((name) => !DNS1123_LABEL.test(name))) refuse(NAMESPACE_NAME_SENTENCE);
      if (names.length > KUBERNETES_TREE_OBJECT_CAP) {
        const kept = names.slice(0, KUBERNETES_TREE_OBJECT_CAP);
        const own = surface.endpoint.defaultNamespace;
        // The API lists namespaces in name order, so a Default namespace that sorts after the last one kept may be one
        // the cap dropped: when the list or one read of it shows it exists, it takes the 1,000th place, so the tree
        // opens it and plan mode's walk reads it. One the API does not show is not drawn, as below the cap.
        if (own > (kept.at(-1) as string) && (names.includes(own) || (await namespaceExists(surface, target, own)))) {
          kept.splice(KUBERNETES_TREE_OBJECT_CAP - 1, 1, own);
        }
        return { names: kept, forbidden: false, capped: true };
      }
      return { names, forbidden: false };
    } catch (error) {
      if (!(error instanceof KubernetesRequestError) || error.status !== 403) throw error;
    }
  }
  return { names: [surface.endpoint.defaultNamespace], forbidden: true };
}

/** The namespaces the tree lists, whether the API refused the namespace list, and whether it held more than 1,000. */
export async function listNamespaces(surface: KubernetesSurface): Promise<NamespaceList> {
  if (surface.endpoint.namespaces !== undefined) return { names: surface.endpoint.namespaces, forbidden: false };
  return namespacesFromApi(surface, await surface.discovery.get());
}

/** `Cluster` first, then the namespaces, each with the kinds it holds; the default namespace is the session's. */
export async function listKubernetesContainers(
  surface: KubernetesSurface,
  parent?: readonly string[],
): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];
  const { names } = await listNamespaces(surface);
  return [
    { path: [CLUSTER_CONTAINER], name: CLUSTER_CONTAINER, level: 0, kinds: kindsForContainerName(CLUSTER_CONTAINER) },
    ...names.map(
      (name): Container => ({
        path: [name],
        name,
        level: 0,
        ...(name === surface.endpoint.defaultNamespace ? { isSessionDefault: true } : {}),
        kinds: kindsForContainerName(name),
      }),
    ),
  ];
}

/** The custom resource types discovery lists for a container's scope, each `<plural>.<group>`. */
function customResourceTypes(index: ResourceIndex, container: string): readonly IndexedResource[] {
  const namespaced = container !== CLUSTER_CONTAINER;
  return index.resources.filter(
    (entry) => !BUILT_IN_API_GROUPS.has(entry.group) && entry.namespaced === namespaced && entry.verbs.includes("list"),
  );
}

async function countKind(
  surface: KubernetesSurface,
  index: ResourceIndex,
  container: string,
  kind: string,
): Promise<KindCount> {
  if (kind === CUSTOM_RESOURCES_KIND) return { count: customResourceTypes(index, container).length };
  const entry = builtInKind(kind) as BuiltInKind;
  const served = servedResource(index, entry);
  if (typeof served === "string") return { unavailable: served };
  try {
    return await cappedCount(surface, served, container === CLUSTER_CONTAINER ? undefined : container);
  } catch (error) {
    // Refused, not served, timed out, too large or unreadable: that kind alone. A rejected credential (an
    // AuthenticationError) and a closed or failing connection (a ConnectionError) fail every kind alike, so they rise.
    if (error instanceof QueryError || error instanceof TimeoutError) return { unavailable: error.message };
    throw error;
  }
}

/**
 * Runs `work` on every item, at most `lanes` at a time, keeping the items' order in the answer. A count's deadline
 * starts when its request is made, so the kinds are not all made at once to wait for the connection's four sockets.
 */
async function mapBounded<T, R>(items: readonly T[], lanes: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const position = next;
      next += 1;
      // oxlint-disable-next-line no-await-in-loop -- a lane runs its items in turn; the lanes run side by side.
      results[position] = await work(items[position]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return results;
}

/** Every kind the container holds, counted from the capped walk; a refused or unserved kind answers `unavailable`. */
export async function countKubernetesObjects(
  surface: KubernetesSurface,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const name = containerName(container);
  const index = await surface.discovery.get();
  const kinds = kindsForContainerName(name);
  const counts = await mapBounded(kinds, KUBERNETES_MAX_IN_FLIGHT, (kind) => countKind(surface, index, name, kind));
  return Object.fromEntries(kinds.map((kind, position) => [kind, counts[position]]));
}

/**
 * The first 1,000 objects of a kind in a container; a custom resource type per row for Custom Resources. A type the
 * server stopped serving since discovery was read (a `text/plain` 404) reads discovery again once.
 */
export async function listKubernetesObjects(
  surface: KubernetesSurface,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  const name = containerName(container);
  requireApplicable(name, kind);
  return withTypeRefresh(surface.discovery, async (index) => {
    if (kind === CUSTOM_RESOURCES_KIND)
      return customResourceTypes(index, name).map((entry) => ({
        path: [name, `${entry.resource}.${entry.group}`],
        name: `${entry.resource}.${entry.group}`,
        kind,
      }));
    const entry = builtInKind(kind) as BuiltInKind;
    const served = servedResource(index, entry);
    if (typeof served === "string") refuse(served);
    const { table, rows } = await cappedWalk(
      surface,
      served,
      name === CLUSTER_CONTAINER ? undefined : name,
      0,
      entry.decoratedName === true ? "Metadata" : "None",
    );
    const pod = entry.group === "" && entry.id === "pods";
    return rows.map((row) => {
      const objectName = rowName(table, row, entry.labelPlural);
      // A name the request policy refuses could be listed but never read, and a generated statement would split on it.
      if (!isRequestableName(objectName, pod))
        refuse(
          `The API server listed ${entry.labelPlural} whose name holds a character Studio never puts in a request path (it takes letters, digits and . _ : @ ~ -), so this folder cannot list them; list them in the console with kubectl get ${entry.id}.`,
        );
      const status = notableStatus(table, row);
      return {
        path: [name, objectSegment(entry, objectName)],
        name: objectName,
        kind,
        ...(status === undefined ? {} : { status }),
      };
    });
  });
}

/** The object a path names: its container, its kind's entry and its name; refused before any request. */
export function objectAddress(
  path: readonly string[],
  kind: string,
): { readonly container: string; readonly entry: BuiltInKind; readonly name: string } {
  if (path.length !== 2)
    refuse(`A Kubernetes "${kind}" path is [container, <kind>/<name>], received ${JSON.stringify(path)}`);
  const container = containerName([path[0]]);
  requireApplicable(container, kind);
  const entry = builtInKind(kind);
  if (entry === undefined) refuse("A custom resource type has no source: list its objects with the List action.");
  return { container, entry, name: objectNameOf(entry, path[1]) };
}

/** No kind declares columns, so a described object answers none; the path is checked all the same. */
export function describeKubernetesObject(path: readonly string[], kind: string): ObjectDetail {
  if (kind !== CUSTOM_RESOURCES_KIND) objectAddress(path, kind);
  else if (path.length !== 2)
    refuse(`A Kubernetes "${kind}" path is [container, <plural>.<group>], received ${JSON.stringify(path)}`);
  return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
}

export function describeKubernetesObjects(container: readonly string[], kind: string): ObjectDetailBatch {
  requireApplicable(containerName(container), kind);
  return { details: [] };
}
